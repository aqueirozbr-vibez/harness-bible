import type { ResearchSection } from "@/lib/db/research";
import { defaultGatewayDeps, type GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError, GatewayRefusedError, GatewayUnavailableError, ProviderRefusalError } from "@/lib/gateway/errors";
import { requestFor } from "@/lib/gateway/policy";
import { callModelTurn } from "@/lib/gateway/turn";
import type { Guide } from "@/lib/guides/load";
import { sha256Hex } from "@/lib/ledger/hash";
import { researchTools, type GatewayCall, type Principal, type ServerTools } from "@/lib/schemas/gateway";
import { ReaderOutputSchema, type ReaderOutput } from "@/lib/schemas/researcher";
import type { Rubric } from "@/lib/schemas/rubric";
import type { TextBlock } from "@/workers/agents/assistant/assemble";
import { jsonBody, unfenced } from "@/workers/agents/unfenced";

import { fenced, renderSection, tierOfChips } from "./render";

/*
 * The reader (feature-specs/41 § 6; unit 58d): one turn on `hb-frontier` with the provider's web search and web fetch,
 * ten uses each, that looks outside the book for what the brief asks and answers findings. The prompt in its fixed
 * order: 1 the reader part of the researcher's guide, 2 the rubric's tiers with their base scores — both byte-stable
 * per version and cached together — then per call 3 today's date, 4 the target sections with their figures and source
 * rows, 5 the brief. The parameter type lists exactly what the reader may read (41 § 6.1): there is no field for the
 * question, the answer, the uncovered sentences or who asked, so none can be passed — the reader holds nothing a page
 * could profit from stealing. The turn may be paused by the provider and is continued as the same attempt
 * (lib/gateway/turn.ts); what comes back is the findings, parsed strictly, with the `https` addresses the tools saw,
 * against which validation decides `SOURCE_NOT_SEEN` (41 § 7). One attempt (invariant 15): a gateway failure, a
 * provider's refusal, a turn left unfinished or an output the parse refuses is the reader's one failure, named, and
 * the run ends FAILED; a budget refusal is thrown, since waiting for the reset is the workflow's (40 § 7.2).
 */

export const READER_REQUEST = requestFor("researchReader");

/** Everything the reader may read, and nothing else. */
export interface ReaderInput {
  readonly guide: Guide;
  /** The published rubric: its tiers' base scores and its chip map; null before one is published (the guide's own tier list then stands alone). */
  readonly rubric: Pick<Rubric, "version" | "appliesAt" | "tiers" | "chips"> | null;
  /** Today, as a day (`2026-10-10`): what "recent" is measured from. */
  readonly today: string;
  readonly sections: ReadonlyArray<ResearchSection>;
  /** The planner's brief, already passed by the brief sensor. */
  readonly brief: string;
}

export interface ReaderPrompt {
  readonly system: ReadonlyArray<TextBlock>;
  readonly messages: ReadonlyArray<{ readonly role: "user"; readonly content: string }>;
  readonly sha256: string;
}

/** Slot 2: the rubric's tiers with their base scores, deterministic from the rubric, so a version renders to the same bytes every call. */
export function renderTiers(rubric: NonNullable<ReaderInput["rubric"]>): string {
  const tiers = Object.entries(rubric.tiers).map(([tier, rule]) => `${tier}: base ${String(rule.base)}${rule.stakeAtBest === "vendor" ? " (the vendor's own page at best)" : ""}`);
  return [`rubric ${rubric.version} (applies from ${rubric.appliesAt})`, "tiers by base score, strongest first:", ...tiers, "A (reproducible) is a fact the product establishes by running something; U is a page that did not open. Neither is a page's to earn."].join("\n");
}

export function assembleReader(input: ReaderInput): ReaderPrompt {
  const system: ReadonlyArray<TextBlock> =
    input.rubric === null
      ? [{ type: "text", text: input.guide.prefix, cache_control: { type: "ephemeral" } }]
      : [
          /* slot 1 and slot 2, byte-stable per version: one breakpoint after the tiers caches both */
          { type: "text", text: input.guide.prefix },
          { type: "text", text: renderTiers(input.rubric), cache_control: { type: "ephemeral" } },
        ];
  const tierOf = tierOfChips(input.rubric);
  const parts = [`today: ${input.today}`, input.sections.map((section) => renderSection(section, tierOf)).join("\n\n"), fenced("brief", input.brief)];
  const messages = [{ role: "user" as const, content: parts.join("\n\n") }];
  return { system, messages, sha256: sha256Hex(JSON.stringify({ system, messages })) };
}

export type ParsedFindings = { readonly ok: true; readonly output: ReaderOutput } | { readonly ok: false; readonly reason: string };

/** The output held to the guide's object: JSON, the findings' shape, no key the guide did not name (invariant 10). */
export function parseFindings(text: string): ParsedFindings {
  let value: unknown;
  try {
    value = JSON.parse(jsonBody(unfenced(text)));
  } catch {
    return { ok: false, reason: "the reader's output is not JSON" };
  }
  const parsed = ReaderOutputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    /* a key the guide did not name is never echoed: its name is the model's text, and the reason reaches the engine's history */
    if (issue?.code === "unrecognized_keys") return { ok: false, reason: `the reader's output has a key the guide did not name${issue.path.length === 0 ? "" : ` at ${issue.path.map(String).join(".")}`}` };
    const path = issue === undefined ? "" : issue.path.map(String).join(".");
    return { ok: false, reason: issue === undefined ? "the reader's output is not the guide's object" : path.length === 0 ? `the reader's output is not the guide's object: ${issue.message}` : `the reader's output has a fault at ${path}: ${issue.message}` };
  }
  return { ok: true, output: parsed.data };
}

export interface ReadInput {
  readonly prompt: ReaderInput;
  readonly call: { readonly principal: Principal; readonly traceId: string; readonly ref: string };
}

export interface ReaderDeps {
  readonly gateway: GatewayDeps;
}

export const defaultReaderDeps = (): ReaderDeps => ({ gateway: defaultGatewayDeps() });

interface Answered {
  readonly model: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number } | null;
  readonly promptSha256: string;
  /** The provider's own counts over the turn, and the pages its tools saw; zeros and none when no answer came. */
  readonly searches: number;
  readonly fetches: number;
  readonly pages: ReadonlyArray<string>;
  readonly continuations: number;
}

export type Read = (Answered & { readonly ok: true; readonly output: ReaderOutput }) | (Answered & { readonly ok: false; readonly failure: string });

function failureOf(error: unknown): string {
  if (error instanceof GatewayUnavailableError) return `gateway unavailable (${error.cause})`;
  if (error instanceof GatewayRefusedError) return `gateway refused (${String(error.status)})`;
  if (error instanceof ProviderRefusalError) return `provider refusal (${error.category ?? "unspecified"})`;
  return "the call failed before an answer";
}

/** The call and the request the reader makes: one place, so what is recorded is what is sent. The two server tools, ten uses each, and no client tool (41 § 11.2). */
export function readerRequestOf(input: ReadInput) {
  const prompt = assembleReader(input.prompt);
  const serverTools: ServerTools = researchTools() ?? [];
  const call: GatewayCall & { readonly serverTools: ServerTools } = {
    purpose: "research",
    alias: "hb-frontier",
    agent: "researcher.read",
    guide: { agent: "researcher", version: input.prompt.guide.version, sha256: input.prompt.guide.sha256 },
    principal: input.call.principal,
    traceId: input.call.traceId,
    ref: input.call.ref,
    serverTools,
  };
  const request = { ...READER_REQUEST, system: [...prompt.system], messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })) };
  return { call, request, promptSha256: prompt.sha256 };
}

export async function read(input: ReadInput, deps: ReaderDeps = defaultReaderDeps()): Promise<Read> {
  const { call, request, promptSha256 } = readerRequestOf(input);
  const none = { model: null, usage: null, promptSha256, searches: 0, fetches: 0, pages: [], continuations: 0 };
  let turn: Awaited<ReturnType<typeof callModelTurn>>;
  try {
    turn = await callModelTurn(call, request, deps.gateway);
  } catch (error: unknown) {
    if (error instanceof BudgetExceededError) throw error;
    return { ok: false, failure: failureOf(error), ...none };
  }
  const answered: Answered = {
    model: turn.message.model,
    usage: { inputTokens: turn.message.usage.input_tokens, outputTokens: turn.message.usage.output_tokens, cacheReadTokens: turn.message.usage.cache_read_input_tokens ?? 0 },
    promptSha256,
    searches: turn.searches,
    fetches: turn.fetches,
    pages: turn.pages,
    continuations: turn.continuations,
  };
  if (turn.unfinished) return { ok: false, failure: `the turn was left unfinished after ${String(turn.continuations)} continuation${turn.continuations === 1 ? "" : "s"}`, ...answered };
  const parsed = parseFindings(turn.seen.texts.join(""));
  if (!parsed.ok) return { ok: false, failure: parsed.reason, ...answered };
  return { ok: true, output: parsed.output, ...answered };
}
