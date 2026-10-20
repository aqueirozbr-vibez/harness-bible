import type { ResearchCallRow, TimedResearchCallRow } from "@/lib/db/budget";
import type { ConversationRunRow, ResearchRunRow } from "@/lib/db/research";
import type { ResearchPayloadInput } from "@/lib/schemas/ledger";
import { CODE_PATTERN, refusalCodeOf, type FindingOutcome, type PlannerRefusal, type ResearchRefusal } from "@/lib/schemas/research";

/*
 * The `RESEARCH` record's payload (feature-specs/40 § 6.3; unit 58e), pure: that a run happened and what came of it,
 * built from the run's row, its findings' rows, its model calls' ledger rows and the planner guide's pin. It names no
 * suggestion and no message; who asked is in the asker's rows and nowhere else. One per run that reached the planner:
 * a run that planned nothing has no brief and no reader; a run that never planned — the planner failed, or the text
 * was purged first — has no record, and `null` says so; one whose planner was called and failed, or whose brief the
 * sensor refused, planned `failed`. The planner's model is its last `hb-small` call's reported id, preferring a call
 * the gateway answered over one it refused at the cap — a refused call's row names the alias (lib/gateway/budget.ts) —
 * and the reader's likewise from its `hb-frontier` calls; the usage is every research call of the run summed.
 */

/** How a run ended, as its record and its line say it (feature-specs/44 § 4; unit 61a). */
export interface RunEnd {
  readonly state: "DONE" | "SKIPPED" | "FAILED" | "REFUSED";
  readonly code: string | null;
}

/**
 * The workflow's end as the record's: the skip or the failure's code where it is one, else `INTERNAL` — a type the
 * engine took from an error's name is not a code of ours. A person's run the planner refused (feature-specs/48 § 15)
 * ends `REFUSED` with its cause as a code, the hyphens as underscores, which `CODE_PATTERN` admits.
 */
export function runEndOf(end: { readonly state: "DONE" } | { readonly state: "SKIPPED"; readonly skip: string } | { readonly state: "FAILED"; readonly failure: string } | { readonly state: "REFUSED"; readonly refusal: ResearchRefusal }): RunEnd {
  if (end.state === "DONE") return { state: "DONE", code: null };
  if (end.state === "REFUSED") return { state: "REFUSED", code: refusalCodeOf(end.refusal) };
  const code = end.state === "SKIPPED" ? end.skip : end.failure;
  return { state: end.state, code: CODE_PATTERN.test(code) ? code : "INTERNAL" };
}

export interface RecordFacts {
  readonly run: Pick<ResearchRunRow, "id" | "releaseId" | "sectionAnchors" | "gap" | "briefSha256" | "searches" | "pageReads" | "traceId">;
  readonly planned: "brief" | "nothing" | "failed" | null;
  readonly end: RunEnd;
  readonly findings: ReadonlyArray<{ readonly ordinal: number; readonly outcome: FindingOutcome }>;
  readonly calls: ReadonlyArray<ResearchCallRow>;
  readonly guide: { readonly version: string; readonly sha256: string };
  readonly stepKey: string;
}

/** The call that stands for an alias: the last the gateway answered, else the last of any outcome; undefined with none. */
export function modelCallOf(calls: ReadonlyArray<ResearchCallRow>, alias: string): ResearchCallRow | undefined {
  const of = calls.filter((call) => call.alias === alias);
  return of.filter((call) => call.outcome === "ok" || call.outcome === "provider_refusal").at(-1) ?? of.at(-1);
}

export function researchPayloadOf(facts: RecordFacts): ResearchPayloadInput | null {
  if (facts.planned === null) return null;
  const planner = modelCallOf(facts.calls, "hb-small");
  if (planner === undefined) return null;
  const reader = facts.planned === "brief" ? modelCallOf(facts.calls, "hb-frontier") : undefined;
  if (facts.planned === "brief" && (reader === undefined || facts.run.briefSha256 === null)) return null;
  const usage = facts.calls.reduce((sum, call) => ({ inputTokens: sum.inputTokens + call.inputTokens, outputTokens: sum.outputTokens + call.outputTokens, cacheReadTokens: sum.cacheReadTokens + call.cacheReadTokens }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  return {
    stepKey: facts.stepKey,
    runId: facts.run.id,
    releaseId: facts.run.releaseId,
    sections: [...facts.run.sectionAnchors],
    gap: facts.run.gap,
    planned: facts.planned,
    briefSha256: facts.planned === "brief" ? facts.run.briefSha256 : null,
    searches: facts.run.searches,
    pageReads: facts.run.pageReads,
    findings: facts.findings.map((finding) => ({ ordinal: finding.ordinal, outcome: finding.outcome })),
    guide: facts.guide,
    models: { planner: planner.modelId, reader: reader?.modelId ?? null },
    usage,
    traceId: facts.run.traceId,
    end: { state: facts.end.state, code: facts.end.code },
  };
}

/* ---------------------------------------------------------------- a person's run (feature-specs/48 § 15; unit 70b) */

/** How a person's run ended, as its workflow concludes it: done, refused by its planner, skipped, or failed with a code. */
export type PersonRunEnd = { readonly state: "DONE" } | { readonly state: "REFUSED"; readonly refusal: PlannerRefusal } | { readonly state: "SKIPPED"; readonly skip: string } | { readonly state: "FAILED"; readonly failure: string };

/**
 * A person's run's frontier calls told apart (48 § 15): the reader's and the writer's are both kind `RESEARCH` on
 * `hb-frontier`, and the ledger has no column for the request's row, so the run's `writingAt` — written before the
 * writer is first called, by the clock that stamps the rows — splits them: the writer's from that instant on, the
 * reader's before it. Every frontier call is the reader's while the writer was never called.
 */
export function frontierCallsOf(calls: ReadonlyArray<TimedResearchCallRow>, writingAt: Date | null): { readonly reader: ReadonlyArray<TimedResearchCallRow>; readonly writer: ReadonlyArray<TimedResearchCallRow> } {
  const frontier = calls.filter((call) => call.alias === "hb-frontier");
  if (writingAt === null) return { reader: frontier, writer: [] };
  return { reader: frontier.filter((call) => call.createdAt.getTime() < writingAt.getTime()), writer: frontier.filter((call) => call.createdAt.getTime() >= writingAt.getTime()) };
}

/**
 * What a person's run planned, as its row says (48 § 15): a brief where its hash stands; `refused` where the planner
 * refused it; `failed` where a planner answered — the gateway let the call through, its output did not parse, or the
 * brief failed its sensor, or the run stopped before its brief was stored — and the run has no brief; null where no
 * planner answered: the person's cap or the gateway refused the call before the provider saw it (`SKIPPED · BUDGET`,
 * `SKIPPED · UNAVAILABLE`), or the text went first. A run with null spent nothing on a model and has no record, as a
 * legacy run that never planned has none. A brief no reader was called on is the record's `failed` (`personPayloadOf`).
 */
export function personPlannedOf(run: Pick<ConversationRunRow, "briefSha256">, end: PersonRunEnd, calls: ReadonlyArray<ResearchCallRow>): "brief" | "refused" | "failed" | null {
  if (run.briefSha256 !== null) return "brief";
  if (end.state === "REFUSED") return "refused";
  return calls.some((call) => call.alias === "hb-small" && (call.outcome === "ok" || call.outcome === "provider_refusal")) ? "failed" : null;
}

export interface PersonRecordFacts {
  readonly run: Pick<ConversationRunRow, "id" | "releaseId" | "sectionAnchors" | "gap" | "briefSha256" | "searches" | "pageReads" | "traceId" | "conversationId" | "questionSha256" | "writingAt">;
  readonly end: PersonRunEnd;
  /** The run's findings as their rows stand: `INVALID` or passed the checks. */
  readonly findings: ReadonlyArray<{ readonly ordinal: number; readonly outcome: FindingOutcome }>;
  /** The run's `RESEARCH` rows, read under the person's own principal (48 § 7.1, § 15). */
  readonly calls: ReadonlyArray<TimedResearchCallRow>;
  readonly guide: { readonly version: string; readonly sha256: string };
  readonly stepKey: string;
  /** The sha256 of the report the run stored, null with none. */
  readonly reportSha256: string | null;
}

/**
 * The `RESEARCH` record of a person's run (48 § 15), pure: one a run that reached the planner, null for one that did
 * not or whose calls' rows do not say by what. Its planner is the last `hb-small` call the gateway answered, its reader
 * the last frontier call before `writingAt` and its writer the last from it, each preferring an answered call to a
 * refused one, which names the alias. The usage is every call of the run summed; the findings are what the checks made
 * of them, `INVALID` or `VALID`, since what the person later does with one is that draft's or that proposal's own
 * record; the conversation, the question's hash as the run's row holds it, the report's hash and the planner's refusal
 * are the person's run's members of the payload. The end is `runEndOf`'s, a refusal's code its cause with underscores.
 *
 * A run whose brief was stored and whose reader was never called — its research deleted or its account erased, or the
 * run cancelled, between the plan and the read — still paid for its planner, and § 15 gives it its record: it says
 * `planned: failed`, with no brief's hash and no reader or writer, since the brief served no read (review of unit 70).
 * The ledger's refine holds a brief and a reader together, so a record that named the brief without a reader would be
 * refused; returning none would have left the planner's spend with no record.
 */
export function personPayloadOf(facts: PersonRecordFacts): ResearchPayloadInput | null {
  const stored = personPlannedOf(facts.run, facts.end, facts.calls);
  if (stored === null) return null;
  const planner = modelCallOf(facts.calls, "hb-small");
  if (planner === undefined) return null;
  const frontier = frontierCallsOf(facts.calls, facts.run.writingAt);
  const reader = stored === "brief" ? modelCallOf(frontier.reader, "hb-frontier") : undefined;
  /* a brief no reader was called on: the run stopped between the two, after its planner was paid */
  const planned = stored === "brief" && reader === undefined ? "failed" : stored;
  const writer = planned === "brief" ? modelCallOf(frontier.writer, "hb-frontier") : undefined;
  const usage = facts.calls.reduce((sum, call) => ({ inputTokens: sum.inputTokens + call.inputTokens, outputTokens: sum.outputTokens + call.outputTokens, cacheReadTokens: sum.cacheReadTokens + call.cacheReadTokens }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  const end = runEndOf(facts.end);
  return {
    stepKey: facts.stepKey,
    runId: facts.run.id,
    releaseId: facts.run.releaseId,
    sections: [...facts.run.sectionAnchors],
    gap: facts.run.gap,
    planned,
    briefSha256: planned === "brief" ? facts.run.briefSha256 : null,
    searches: facts.run.searches,
    pageReads: facts.run.pageReads,
    findings: facts.findings.map((finding) => ({ ordinal: finding.ordinal, outcome: finding.outcome === "INVALID" ? "INVALID" : "VALID" })),
    guide: facts.guide,
    models: { planner: planner.modelId, reader: reader?.modelId ?? null, writer: writer?.modelId ?? null },
    usage,
    traceId: facts.run.traceId,
    end: { state: end.state, code: end.code },
    conversationId: facts.run.conversationId,
    questionSha256: facts.run.questionSha256,
    reportSha256: facts.reportSha256,
    refusal: facts.end.state === "REFUSED" ? facts.end.refusal : null,
  };
}
