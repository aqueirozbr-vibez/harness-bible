import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";

import type { ResearchSection } from "@/lib/db/research";
import { defaultGatewayDeps, type GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { requestFor } from "@/lib/gateway/policy";
import { pagesRead } from "@/lib/gateway/tools";
import { callModelTurn, turnCountsOf } from "@/lib/gateway/turn";
import type { Guide } from "@/lib/guides/load";
import { sha256Hex } from "@/lib/ledger/hash";
import { researchTools, type GatewayCall, type Principal, type ServerTools } from "@/lib/schemas/gateway";
import { ReaderOutputV2Schema, type ReaderOutputV2, type ReadPage } from "@/lib/schemas/researcher";
import type { Rubric } from "@/lib/schemas/rubric";
import type { TextBlock } from "@/workers/agents/assistant/assemble";

import { fenced, renderSection, tierOfChips } from "../render";
import { failureOf, parseOutput, usageOf, type CallUsage, type ParsedOutput } from "./output";

/*
 * The reader of a person's research (feature-specs/48 § 5.4; unit 69c): one turn on `hb-frontier` with the provider's
 * web search and web fetch, ten uses each, that looks outside the book for what the brief asks and answers findings
 * and a note on each page that bears on the brief. The prompt is version 1's (41 § 6.1) in its fixed order: 1 the
 * reader part of the researcher's guide version 2, 2 the rubric's tiers with their base scores — both byte-stable per
 * version and cached together — then per call 3 today's date, 4 the targets' sections, at most three, not every
 * section of the run (a frontier prompt would read retrieval's ten for nothing), 5 the brief. The parameter type lists
 * exactly what the reader may read: there is no field for the question, an earlier question, the seed answer, the
 * uncovered sentences or who asked, so none can be passed — the reader holds nothing a page could profit from stealing
 * (invariant 33).
 *
 * The turn is lib/gateway/turn.ts's, paused and continued as one attempt. `onBlock` hears each content block as the
 * stream completes it, which the run turns into its live steps (48 § 6); it is progress, and what comes back is read
 * from the whole turn: the findings and the notes, parsed strictly to `ReaderOutputV2Schema` (each item is read later,
 * in the validation), the `https` addresses the tools saw (`pages`, what `SOURCE_NOT_SEEN` and a note's address are
 * decided against) and every page the turn saw in order (`read`, the run's page list, which the report's numbers
 * point into). One attempt (invariant 15): a gateway failure, a provider's refusal, a turn left unfinished or an output
 * the parse refuses is the reader's one failure, named, with the counts of what the provider had charged by then; the
 * gateway's budget refusal is thrown, carrying the same counts (`turnCountsOf`), for the run to end FAILED · BUDGET
 * with them (48 § 5.4, § 7.2). `signal`, the activity's cancellation, aborts the turn's streams where they stand (48
 * § 5.1); the abort comes back as the reader's failure, which the run, already ended, never writes.
 */

export const READER_REQUEST = requestFor("researchReader");

/** Everything the reader may read, and nothing else. */
export interface ReaderInput {
  readonly guide: Guide;
  /** The published rubric: its tiers' base scores and its chip map; null before one is published (the guide's own tier list then stands alone). */
  readonly rubric: Pick<Rubric, "version" | "appliesAt" | "tiers" | "chips"> | null;
  /** Today, as a day (`2026-10-12`): what "recent" is measured from. */
  readonly today: string;
  /** The planner's targets' sections, at most three (48 § 5.4), and no other section of the run. */
  readonly sections: ReadonlyArray<ResearchSection>;
  /** The planner's brief, already passed by the brief sensor. */
  readonly brief: string;
}

export interface ReaderPrompt {
  readonly system: ReadonlyArray<TextBlock>;
  readonly messages: ReadonlyArray<{ readonly role: "user"; readonly content: string }>;
  readonly sha256: string;
}

/** Slot 2: the rubric's tiers with their base scores, deterministic from the rubric, so a version renders to the same bytes every call (as version 1's). */
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

/** The output held to the guide's version 2 envelope: `{ findings, notes }`, both lists, no key the guide did not name; each item is the validation's to read. */
export function parseRead(text: string): ParsedOutput<ReaderOutputV2> {
  return parseOutput(text, ReaderOutputV2Schema, "reader");
}

export interface ReadInput {
  readonly prompt: ReaderInput;
  /** The person's principal (48 § 7.1), the run's trace and its id as each request's `ref`. */
  readonly call: { readonly principal: Principal; readonly traceId: string; readonly ref: string };
  /** Each content block as the stream completes it, every request of the turn in order (48 § 6): the run's live steps. Synchronous, and never the answer. */
  readonly onBlock?: (block: ContentBlock) => void;
  /** The activity's cancellation (48 § 5.1): the turn's requests are sent with it, so a cancelled run stops reading. */
  readonly signal?: AbortSignal;
}

export interface ReaderDeps {
  readonly gateway: GatewayDeps;
}

export const defaultReaderDeps = (): ReaderDeps => ({ gateway: defaultGatewayDeps() });

interface Answered {
  readonly model: string | null;
  readonly usage: CallUsage | null;
  readonly promptSha256: string;
  /** The provider's own counts over the requests that answered, what the run stores and the ledger priced; zeros when none did. */
  readonly searches: number;
  readonly fetches: number;
  /** The `https` addresses the tools saw (41 § 7); none when no answer came. */
  readonly pages: ReadonlyArray<string>;
  /** Every page the turn saw, in order of appearance (48 § 5.4); none when no answer came. */
  readonly read: ReadonlyArray<ReadPage>;
  readonly continuations: number;
}

export type Read = (Answered & { readonly ok: true; readonly output: ReaderOutputV2 }) | (Answered & { readonly ok: false; readonly failure: string });

/** The call and the request the reader makes: one place, so what is recorded is what is sent. The two server tools, ten uses each, and no client tool. */
export function readerRequestOf(input: Pick<ReadInput, "prompt" | "call">) {
  const prompt = assembleReader(input.prompt);
  const serverTools: ServerTools = researchTools() ?? [];
  const call: GatewayCall & { readonly serverTools: ServerTools } = {
    purpose: "research",
    alias: "hb-frontier",
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
  let turn: Awaited<ReturnType<typeof callModelTurn>>;
  try {
    turn = await callModelTurn(call, request, deps.gateway, input.onBlock, input.signal);
  } catch (error: unknown) {
    if (error instanceof BudgetExceededError) throw error;
    /* a continuation that failed leaves what the requests before it were charged for (48 § 5.4) */
    const counts = turnCountsOf(error) ?? { searches: 0, fetches: 0, continuations: 0 };
    return { ok: false, failure: failureOf(error), model: null, usage: null, promptSha256, searches: counts.searches, fetches: counts.fetches, pages: [], read: [], continuations: counts.continuations };
  }
  const answered: Answered = {
    model: turn.message.model,
    usage: usageOf(turn.message.usage),
    promptSha256,
    searches: turn.searches,
    fetches: turn.fetches,
    pages: turn.pages,
    read: pagesRead(turn.content),
    continuations: turn.continuations,
  };
  if (turn.unfinished) return { ok: false, failure: `the turn was left unfinished after ${String(turn.continuations)} continuation${turn.continuations === 1 ? "" : "s"}`, ...answered };
  const parsed = parseRead(turn.seen.texts.join(""));
  if (!parsed.ok) return { ok: false, failure: parsed.reason, ...answered };
  return { ok: true, output: parsed.output, ...answered };
}
