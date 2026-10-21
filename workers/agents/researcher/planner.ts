import type { ResearchSection } from "@/lib/db/research";
import { callModel, defaultGatewayDeps, type GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError, GatewayRefusedError, GatewayUnavailableError, ProviderRefusalError } from "@/lib/gateway/errors";
import { requestFor } from "@/lib/gateway/policy";
import type { Guide } from "@/lib/guides/load";
import { sha256Hex } from "@/lib/ledger/hash";
import type { GatewayCall, Principal } from "@/lib/schemas/gateway";
import { PlannerOutputSchema, type PlannerOutput } from "@/lib/schemas/researcher";
import type { Rubric } from "@/lib/schemas/rubric";
import type { TextBlock } from "@/workers/agents/assistant/assemble";
import { jsonBody, unfenced } from "@/workers/agents/unfenced";

import { fenced, renderSection, tierOfChips } from "./render";

/*
 * The planner (feature-specs/41 § 5; unit 58c): one call on `hb-small`, no tools, that decides whether an answer the
 * assistant gave points at something to look for outside the book and, if so, writes the brief the reader works
 * from. The prompt in its fixed order: 1 the planner part of the researcher's guide, byte-stable and cached; then
 * per call 2 the cited sections with their figures (tier, verification date, fast-moving), 3 the answer's claims
 * with their citations, 4 the sentences the book did not cover, 5 the question. The parameter type lists exactly
 * what the planner may read (41 § 5.1): there is no field for who asked — no id, no name, no organisation, no locale
 * beyond the language — for an earlier turn or for anything from the web, so none can be passed. Text a stranger
 * wrote is fenced as data, and a fence's closing tag inside it is broken. One attempt (invariant 15): a gateway
 * failure, a provider's refusal or an output the strict parse refuses is the planner's one failure, named, and the
 * run ends FAILED; a budget refusal is thrown, since waiting for the reset is the workflow's (40 § 7.2).
 */

export const PLANNER_REQUEST = requestFor("researchPlanner");

/** Everything the planner may read, and nothing else. */
export interface PlannerInput {
  readonly guide: Guide;
  /** The published rubric's chip map, so a figure's tier is shown as the letter the guides explain; null before a rubric is published. */
  readonly rubric: Pick<Rubric, "chips"> | null;
  readonly sections: ReadonlyArray<ResearchSection>;
  /** The answer's claims as the citations recorded them: the sentence where the purge has not taken it, the section and figure it cited. */
  readonly claims: ReadonlyArray<{ readonly text: string | null; readonly sectionId: string; readonly figureId: string | null }>;
  readonly uncovered: ReadonlyArray<{ readonly sectionId: string | null; readonly text: string }>;
  /** The question as the assistant saw it: redacted, at most 800 characters. */
  readonly question: string;
  /** The language the question was asked in, and nothing else of the asker. */
  readonly language: "EN" | "PT";
}

export interface PlannerPrompt {
  readonly system: ReadonlyArray<TextBlock>;
  readonly messages: ReadonlyArray<{ readonly role: "user"; readonly content: string }>;
  readonly sha256: string;
}

export function assemblePlanner(input: PlannerInput): PlannerPrompt {
  const system: ReadonlyArray<TextBlock> = [{ type: "text", text: input.guide.prefix, cache_control: { type: "ephemeral" } }];
  const claims = input.claims.map((claim) => `[${claim.sectionId}${claim.figureId === null ? "" : ` ${claim.figureId}`}] ${claim.text ?? "(the sentence is no longer held)"}`).join("\n");
  const uncovered = input.uncovered.map((sentence) => `[${sentence.sectionId ?? "no section"}] ${sentence.text}`).join("\n");
  const parts = [
    `language: ${input.language.toLowerCase()}`,
    input.sections.map((section) => renderSection(section, tierOfChips(input.rubric))).join("\n\n"),
    fenced("claims", claims.length === 0 ? "(none)" : claims),
    fenced("uncovered", uncovered.length === 0 ? "(none)" : uncovered),
    fenced("question", input.question),
  ];
  const messages = [{ role: "user" as const, content: parts.join("\n\n") }];
  return { system, messages, sha256: sha256Hex(JSON.stringify({ system, messages })) };
}

export type ParsedPlan = { readonly ok: true; readonly output: PlannerOutput } | { readonly ok: false; readonly reason: string };

/** The output held to the guide's object: JSON, one of the two shapes, no key the guide did not name (invariant 10). */
export function parsePlan(text: string): ParsedPlan {
  let value: unknown;
  try {
    value = JSON.parse(jsonBody(unfenced(text)));
  } catch {
    return { ok: false, reason: "the planner's output is not JSON" };
  }
  const parsed = PlannerOutputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    /* a key the guide did not name is never echoed: its name is the model's text, and the reason reaches the engine's history */
    if (issue?.code === "unrecognized_keys") return { ok: false, reason: `the planner's output has a key the guide did not name${issue.path.length === 0 ? "" : ` at ${issue.path.map(String).join(".")}`}` };
    const path = issue === undefined ? "" : issue.path.map(String).join(".");
    return { ok: false, reason: issue === undefined ? "the planner's output is not the guide's object" : path.length === 0 ? `the planner's output is not the guide's object: ${issue.message}` : `the planner's output has a fault at ${path}: ${issue.message}` };
  }
  return { ok: true, output: parsed.data };
}

export interface PlanInput {
  readonly prompt: PlannerInput;
  readonly call: { readonly principal: Principal; readonly traceId: string; readonly ref: string };
}

export interface PlannerDeps {
  readonly gateway: GatewayDeps;
}

export const defaultPlannerDeps = (): PlannerDeps => ({ gateway: defaultGatewayDeps() });

interface Answered {
  readonly model: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number } | null;
  readonly promptSha256: string;
}

export type Planned = (Answered & { readonly ok: true; readonly output: PlannerOutput }) | (Answered & { readonly ok: false; readonly failure: string });

function failureOf(error: unknown): string {
  if (error instanceof GatewayUnavailableError) return `gateway unavailable (${error.cause})`;
  if (error instanceof GatewayRefusedError) return `gateway refused (${String(error.status)})`;
  if (error instanceof ProviderRefusalError) return `provider refusal (${error.category ?? "unspecified"})`;
  return "the call failed before an answer";
}

/** The call and the request the planner makes: one place, so what is recorded is what is sent. No tool (41 § 11.2). */
export function plannerRequestOf(input: PlanInput) {
  const prompt = assemblePlanner(input.prompt);
  const call: GatewayCall = {
    purpose: "research",
    alias: "hb-small",
    agent: "researcher.plan",
    guide: { agent: "researcher", version: input.prompt.guide.version, sha256: input.prompt.guide.sha256 },
    principal: input.call.principal,
    traceId: input.call.traceId,
    ref: input.call.ref,
  };
  const request = { ...PLANNER_REQUEST, system: [...prompt.system], messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })) };
  return { call, request, promptSha256: prompt.sha256 };
}

export async function plan(input: PlanInput, deps: PlannerDeps = defaultPlannerDeps()): Promise<Planned> {
  const { call, request, promptSha256 } = plannerRequestOf(input);
  let model: string;
  let text: string;
  let usage: Answered["usage"];
  try {
    const message = await callModel(call, request, deps.gateway);
    model = message.model;
    text = message.content.map((block) => ("text" in block ? block.text : "")).join("");
    usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, cacheReadTokens: message.usage.cache_read_input_tokens ?? 0 };
  } catch (error: unknown) {
    if (error instanceof BudgetExceededError) throw error;
    return { ok: false, failure: failureOf(error), model: null, usage: null, promptSha256 };
  }
  const parsed = parsePlan(text);
  if (!parsed.ok) return { ok: false, failure: parsed.reason, model, usage, promptSha256 };
  return { ok: true, output: parsed.output, model, usage, promptSha256 };
}
