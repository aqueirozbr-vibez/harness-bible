import type { ResearchSection } from "@/lib/db/research";
import { callModel, defaultGatewayDeps, type GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { requestFor } from "@/lib/gateway/policy";
import type { Guide } from "@/lib/guides/load";
import { sha256Hex } from "@/lib/ledger/hash";
import type { GatewayCall, Principal } from "@/lib/schemas/gateway";
import { PlannerOutputV2Schema, type PlannerOutputV2 } from "@/lib/schemas/researcher";
import type { Rubric } from "@/lib/schemas/rubric";
import { CONVERSATION_TURNS, type TextBlock } from "@/workers/agents/assistant/assemble";

import { fenced, renderSection, tierOfChips } from "../render";
import { failureOf, parseOutput, usageOf, type CallUsage, type ParsedOutput } from "./output";

/*
 * The planner of a person's research (feature-specs/48 § 5.3; unit 69b): one call on `hb-small`, no tools, that
 * decides whether a question a person asked for research on may be researched and, if so, writes the brief the reader
 * works from and names one to three of the run's sections as its targets. The prompt in its fixed order: 1 the
 * planner part of the researcher's guide version 2, byte-stable and cached; then per call 2 the language and nothing
 * else of the asker, 3 the run's sections (at most ten, the seed's and retrieval's) with their figures and rows,
 * 4 for a seeded first run only the seed answer's claims with their citations and its uncovered sentences, 5 for a
 * follow-up only the conversation's earlier questions and briefs, the last six, oldest first, 6 the question. The
 * parameter type lists exactly what the planner may read: there is no field for who asked — no id, no name, no e-mail,
 * no organisation — for an earlier run's report, or for anything from the web, so none can be passed; a report is
 * written from what the reader wrote of pages, and a planner that read one would read the web at one remove
 * (invariant 33). Slots 4 and 5 are one field whose kind says which applies, so a run cannot be given both.
 *
 * Text a person or a model wrote is fenced as data, and a fence's closing tag inside it is broken (render.ts). One
 * attempt (invariant 15): a provider's refusal, a 4xx the gateway gave, or an output the strict parse refuses is the
 * planner's one failure, named, and the run ends FAILED · PLANNER_FAILED. Two refusals are thrown for the workflow
 * to end the run as it says (48 § 5.3, § 7.2): the gateway's budget refusal (`SKIPPED · BUDGET`, with its reset) and
 * the gateway's unavailability (`SKIPPED · UNAVAILABLE`: no key for the person's principal, the gateway unreachable,
 * the key's rate limit).
 */

export const PLANNER_REQUEST = requestFor("researchPlanner");

/** What a seeded first run reads of the answer it began from (48 § 5.3 slot 4): its claims as the citations recorded them, and the sentences the book did not cover. */
export interface PlannerSeed {
  readonly kind: "seeded";
  /** The sentence where the purge has not taken it, the section and figure it cited. */
  readonly claims: ReadonlyArray<{ readonly text: string | null; readonly sectionId: string; readonly figureId: string | null }>;
  readonly uncovered: ReadonlyArray<{ readonly sectionId: string | null; readonly text: string }>;
}

/** What a follow-up reads of the runs before it (48 § 5.3 slot 5): each one's question and its brief, null where it was refused or failed before one; never a report. */
export interface PlannerFollowUp {
  readonly kind: "followUp";
  /** Oldest first; the assembler keeps the last `CONVERSATION_TURNS`. */
  readonly earlier: ReadonlyArray<{ readonly question: string; readonly brief: string | null }>;
}

/** Slots 4 and 5: a first run from scratch reads neither. */
export type PlannerContext = { readonly kind: "scratch" } | PlannerSeed | PlannerFollowUp;

/** Everything the planner may read, and nothing else. */
export interface PlannerInput {
  readonly guide: Guide;
  /** The published rubric's chip map, so a figure's tier is shown as the letter the guides explain; null before a rubric is published. */
  readonly rubric: Pick<Rubric, "chips"> | null;
  /** The language the question was asked in, and nothing else of the asker. */
  readonly language: "EN" | "PT";
  /** The run's sections (48 § 5.3), at most ten: the only ones a target may name. */
  readonly sections: ReadonlyArray<ResearchSection>;
  readonly context: PlannerContext;
  /** The question as stored and redacted again by the workers: at most 800 characters. */
  readonly question: string;
}

export interface PlannerPrompt {
  readonly system: ReadonlyArray<TextBlock>;
  readonly messages: ReadonlyArray<{ readonly role: "user"; readonly content: string }>;
  readonly sha256: string;
}

/** The earlier runs the planner is shown: the last six, oldest first, as the Assistant bounds a conversation. */
function earlierShown(context: PlannerContext): PlannerFollowUp["earlier"] {
  return context.kind === "followUp" ? context.earlier.slice(-CONVERSATION_TURNS) : [];
}

/** The earlier questions the planner read, which the brief sensor's `QUESTION` holds the brief to as well (48 § 5.3): exactly those slot 5 showed. */
export function earlierQuestionsRead(input: Pick<PlannerInput, "context">): ReadonlyArray<string> {
  return earlierShown(input.context).map((run) => run.question);
}

function contextParts(context: PlannerContext): ReadonlyArray<string> {
  switch (context.kind) {
    case "scratch":
      return [];
    case "seeded": {
      const claims = context.claims.map((claim) => `[${claim.sectionId}${claim.figureId === null ? "" : ` ${claim.figureId}`}] ${claim.text ?? "(the sentence is no longer held)"}`).join("\n");
      const uncovered = context.uncovered.map((sentence) => `[${sentence.sectionId ?? "no section"}] ${sentence.text}`).join("\n");
      return [fenced("claims", claims.length === 0 ? "(none)" : claims), fenced("uncovered", uncovered.length === 0 ? "(none)" : uncovered)];
    }
    case "followUp":
      return earlierShown(context).flatMap((run, index) => {
        const n = ` n="${String(index + 1)}"`;
        return [fenced("earlier-question", run.question, n), fenced("earlier-brief", run.brief ?? "(none)", n)];
      });
  }
}

export function assemblePlanner(input: PlannerInput): PlannerPrompt {
  const system: ReadonlyArray<TextBlock> = [{ type: "text", text: input.guide.prefix, cache_control: { type: "ephemeral" } }];
  const parts = [
    `language: ${input.language.toLowerCase()}`,
    input.sections.map((section) => renderSection(section, tierOfChips(input.rubric))).join("\n\n"),
    ...contextParts(input.context),
    fenced("question", input.question),
  ].filter((part) => part.length > 0);
  const messages = [{ role: "user" as const, content: parts.join("\n\n") }];
  return { system, messages, sha256: sha256Hex(JSON.stringify({ system, messages })) };
}

/** The output held to the guide's version 2 object: a refusal with one of its two reasons, or a brief with one to three targets. */
export function parsePlan(text: string): ParsedOutput<PlannerOutputV2> {
  return parseOutput(text, PlannerOutputV2Schema, "planner");
}

export interface PlanInput {
  readonly prompt: PlannerInput;
  /** The person's principal (48 § 7.1), the run's trace and its id as the calls' `ref`. */
  readonly call: { readonly principal: Principal; readonly traceId: string; readonly ref: string };
}

export interface PlannerDeps {
  readonly gateway: GatewayDeps;
}

export const defaultPlannerDeps = (): PlannerDeps => ({ gateway: defaultGatewayDeps() });

interface Answered {
  readonly model: string | null;
  readonly usage: CallUsage | null;
  readonly promptSha256: string;
}

export type Planned = (Answered & { readonly ok: true; readonly output: PlannerOutputV2 }) | (Answered & { readonly ok: false; readonly failure: string });

/** The call and the request the planner makes: one place, so what is recorded is what is sent. No tool (invariant 33). */
export function plannerRequestOf(input: PlanInput) {
  const prompt = assemblePlanner(input.prompt);
  const call: GatewayCall = {
    purpose: "research",
    alias: "hb-small",
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
  let usage: CallUsage;
  try {
    const message = await callModel(call, request, deps.gateway);
    model = message.model;
    text = message.content.map((block) => ("text" in block ? block.text : "")).join("");
    usage = usageOf(message.usage);
  } catch (error: unknown) {
    /* the gateway's refusals before the provider saw the call are the workflow's to end the run on (48 § 5.3): the
       budget, and an unavailability that is not the provider's own — a timeout or a server error the provider may have
       seen, and billed, is the planner's one failure, FAILED · PLANNER_FAILED, as the legacy planner's is (the review of unit 69) */
    if (error instanceof BudgetExceededError || (error instanceof GatewayUnavailableError && error.cause !== "timeout" && error.cause !== "server")) throw error;
    return { ok: false, failure: failureOf(error), model: null, usage: null, promptSha256 };
  }
  const parsed = parsePlan(text);
  if (!parsed.ok) return { ok: false, failure: parsed.reason, model, usage, promptSha256 };
  return { ok: true, output: parsed.output, model, usage, promptSha256 };
}
