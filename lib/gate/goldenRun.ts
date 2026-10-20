import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { FRONTIER_ALIAS, SMALL_ALIAS, type GoldenRun } from "@/lib/gate/phase2";
import type { GoldenItem } from "@/lib/schemas/golden";
import { GoldenRunHeaderSchema, GoldenRunItemSchema, GRADER_CRITERIA, type GoldenRunHeader, type GoldenRunItem, type GraderCriterion, type RunGrade } from "@/lib/schemas/goldenRun";
import type { AnswerBody, TurnEventLine } from "@/lib/schemas/workers";

/*
 * The golden set, answered (feature-specs/22 § 4): every item through the workers' `/answer` route, the path the API
 * uses minus the web tier, one conversation per item, and one line per item of what came back. The run is a
 * measure, not a test: nothing here asserts, and what the gate makes of the lines is lib/gate/phase2.ts's.
 *
 * The runner does not know how a turn travels. It is given four functions (open a conversation, ask, read the
 * turn's gateway calls, read the hash of the prefix the answer was drafted under), built in workers/gate/goldenDeps.ts,
 * so the same code drives the stub grade (workers and stub gateway in the caller's own process) and the real one
 * (the running workers, the provider behind them).
 */

export const REPORTS_DIR = join(process.cwd(), "pipeline", "reports");

/**
 * What the item's mode picks (feature-specs/23 § 8): a compare's pair, a lab's lab, and nothing else. The item's own
 * `context` stays in the set as where the generator took the question from; since Assistant 2.0 it is not sent,
 * because the assistant reads no position and the question names what it is about.
 */
export function contextOf(item: GoldenItem): NonNullable<AnswerBody["context"]> {
  return {
    ...(item.mode === "compare" && item.expected.chapters.length === 2 ? { chapters: [item.expected.chapters[0] ?? 0, item.expected.chapters[1] ?? 0] as [number, number] } : {}),
    ...(item.mode === "lab" ? { labId: `lab-${String(item.context.chapter).padStart(2, "0")}` } : {}),
  };
}

/* What the runner reads of a `final` event. Loose: the event carries more, and the stream's own schema is 15's. */
const FinalSchema = z.looseObject({
  messageId: z.string(),
  kind: z.enum(["answer", "refusal"]),
  refusal: z.looseObject({ cause: z.string() }).nullable(),
  claims: z.array(z.looseObject({ found: z.boolean(), substituted: z.boolean() })),
  citations: z.array(z.looseObject({ sectionId: z.string(), figureId: z.string().nullable() })),
  verdicts: z.array(z.looseObject({ sensor: z.string(), verdict: z.string(), data: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional() })),
  grounded: z.number().nullable(),
  timings: z.looseObject({ firstTokenMs: z.number().nullable(), totalMs: z.number() }),
  ledger: z.looseObject({ seq: z.number() }).nullable().optional(),
});
type Final = z.infer<typeof FinalSchema>;

/** One call the turn made at the gateway, as its BudgetLedger row has it. */
export interface LedgerCall {
  readonly alias: string;
  /** The row's kind: `ASSISTANT` for the classifier and the draft, `GRADING` for the grader. */
  readonly kind: string;
  readonly cacheRead: number;
  readonly costUsd: number;
}

/**
 * The grader's verdict on each criterion, from its verdict's data: the names that failed are listed there
 * (`failedCriteria`), and the rest of the four passed. Null when the answer was not graded.
 */
export function graderCriteriaOf(verdicts: Final["verdicts"]): Readonly<Record<GraderCriterion, boolean>> | null {
  const grader = verdicts.find((verdict) => verdict.sensor === "grader");
  if (grader === undefined || grader.verdict === "NA" || grader.data?.criteria !== GRADER_CRITERIA.length) return null;
  const failed = grader.data.failedCriteria;
  if (typeof failed !== "string") return null;
  const names = new Set(failed.split(",").filter((name) => name.length > 0));
  return { supported: !names.has("supported"), precise: !names.has("precise"), complete: !names.has("complete"), in_scope: !names.has("in_scope") };
}

/**
 * Whether the turn did what the item's label says a correct one does: every expected citation cited (a figure
 * when the label names one), for a compare every expected chapter cited from, for a refusal the expected cause.
 */
export function expectedHit(item: GoldenItem, outcome: GoldenRunItem["outcome"], refusalCause: string | null, citations: ReadonlyArray<{ readonly sectionId: string; readonly figureId: string | null }>): boolean {
  if (item.expected.refusal !== null) return outcome === "refusal" && refusalCause === item.expected.refusal.cause;
  if (outcome !== "answer") return false;
  if (item.kind === "compare") {
    const chapters = new Set(citations.map((citation) => Number(citation.sectionId.split(".")[0])));
    return item.expected.chapters.every((chapter) => chapters.has(chapter));
  }
  return item.expected.citations.every((expected) => citations.some((citation) => citation.sectionId === expected.sectionId && (expected.figureId === null || citation.figureId === expected.figureId)));
}

/** The line of one item: what the turn's last event, its gateway calls and its row say. Pure. */
export function recordOf(item: GoldenItem, turn: { readonly traceId: string; readonly events: ReadonlyArray<TurnEventLine> }, calls: ReadonlyArray<LedgerCall>, prefixSha256: string | null): GoldenRunItem {
  const last = turn.events.at(-1);
  const final = last?.event === "final" ? FinalSchema.safeParse(last.data) : null;
  const ended: Final | null = final !== null && final.success ? final.data : null;
  const code = ended !== null ? null : last?.event === "error" && typeof last.data.code === "string" ? last.data.code : "NO_FINAL";
  const outcome: GoldenRunItem["outcome"] = ended === null ? "failed" : ended.kind;
  const refusalCause = ended?.refusal?.cause ?? null;
  const citations = ended?.citations ?? [];
  const claims = ended?.claims ?? [];

  return GoldenRunItemSchema.parse({
    id: item.id,
    kind: item.kind,
    mode: item.mode,
    language: item.language,
    outcome,
    refusalCause,
    code,
    messageId: ended?.messageId ?? null,
    traceId: turn.traceId,
    citedSections: [...new Set(citations.map((citation) => citation.sectionId))],
    citedFigures: [...new Set(citations.flatMap((citation) => (citation.figureId === null ? [] : [citation.figureId])))],
    expectedHit: expectedHit(item, outcome, refusalCause, citations),
    claims: { total: claims.length, notFound: claims.filter((claim) => !claim.found && !claim.substituted).length, substituted: claims.filter((claim) => claim.substituted).length },
    verdicts: (ended?.verdicts ?? []).map((verdict) => ({ sensor: verdict.sensor, verdict: verdict.verdict })),
    grounded: ended?.grounded ?? null,
    graderCriteria: ended === null ? null : graderCriteriaOf(ended.verdicts),
    prefixSha256,
    firstTokenMs: ended?.timings.firstTokenMs ?? null,
    totalMs: ended?.timings.totalMs ?? null,
    frontier: calls.filter((call) => call.alias === FRONTIER_ALIAS).map((call) => ({ kind: call.kind === "GRADING" ? "grading" : "assistant", cacheRead: call.cacheRead })),
    smallCalls: calls.filter((call) => call.alias === SMALL_ALIAS).length,
    costUsd: calls.reduce((sum, call) => sum + call.costUsd, 0),
    ledgerSeq: ended?.ledger?.seq ?? null,
  });
}

export interface GoldenRunDeps {
  /** Opens the item's conversation, in its language; returns its id. */
  readonly open: (item: GoldenItem) => Promise<string>;
  /** Asks the item's question in that conversation and reads the stream to its end. */
  readonly ask: (item: GoldenItem, conversationId: string, traceId: string) => Promise<ReadonlyArray<TurnEventLine>>;
  /** The gateway calls the turn made, in the order they were made. */
  readonly calls: (traceId: string) => Promise<ReadonlyArray<LedgerCall>>;
  /** The hash of the cached prefix the answer was drafted under: the row's `guideSha256`. */
  readonly prefixOf: (messageId: string) => Promise<string | null>;
  readonly traceId: () => string;
}

export interface GoldenRunOptions {
  /** How many items are in flight at once: 2 against a provider, 8 against the stub (§ 4). */
  readonly concurrency: number;
  /** Called as each item finishes, in the order they finish. */
  readonly onRecord?: (record: GoldenRunItem, done: number) => void;
}

/** The code a turn fails with when the gateway refuses on budget: the run stops there (§ 7). */
const BUDGET = "BUDGET_EXCEEDED";

/**
 * Runs the items and returns their lines in the golden set's order. A budget refusal stops the run where it is:
 * the items already in flight finish, no new one starts, and the result says `partial`.
 */
export async function runGolden(items: ReadonlyArray<GoldenItem>, options: GoldenRunOptions, deps: GoldenRunDeps): Promise<{ readonly records: ReadonlyArray<GoldenRunItem>; readonly partial: boolean }> {
  const records = new Map<number, GoldenRunItem>();
  let next = 0;
  let stopped = false;

  async function lane(): Promise<void> {
    while (!stopped && next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      const traceId = deps.traceId();
      const conversationId = await deps.open(item);
      const events = await deps.ask(item, conversationId, traceId);
      const last = events.at(-1);
      const messageId = last?.event === "final" && typeof last.data.messageId === "string" ? last.data.messageId : null;
      const record = recordOf(item, { traceId, events }, await deps.calls(traceId), messageId === null ? null : await deps.prefixOf(messageId));
      records.set(index, record);
      if (record.code === BUDGET) stopped = true;
      options.onRecord?.(record, records.size);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, items.length)) }, () => lane()));
  return { records: [...records.entries()].sort(([a], [b]) => a - b).map(([, record]) => record), partial: records.size < items.length };
}

/* ------------------------------------------------------------------ the run file */

/**
 * The stub grade keeps one file per release, replaced by each run; a real run costs money and is evidence a label
 * points at, so each keeps its own file, named by when it started. A pilot (`--limit`) is a few items and not the
 * golden set: its file is named `pilot` before the grade, so `newestRun`, which the gate reads by, never takes it
 * for a run, and a stub pilot never replaces the stub run.
 */
export function runFileName(release: string, grade: RunGrade, startedAt: Date, pilot = false): string {
  const kind = pilot ? `pilot-${grade}` : grade;
  if (grade === "stub") return `golden-run-${release}-${kind}.jsonl`;
  return `golden-run-${release}-${kind}-${startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.jsonl`;
}

export function writeRunFile(dir: string, name: string, header: GoldenRunHeader, records: ReadonlyArray<GoldenRunItem>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${[header, ...records].map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

export function readRunFile(dir: string, name: string): GoldenRun & { readonly header: GoldenRunHeader } {
  const lines = readFileSync(join(dir, name), "utf8").split("\n").filter((line) => line.trim().length > 0);
  const header = GoldenRunHeaderSchema.parse(JSON.parse(lines[0] ?? "null"));
  return { header, grade: header.grade, file: name, partial: header.partial, items: lines.slice(1).map((line) => GoldenRunItemSchema.parse(JSON.parse(line))) };
}

/** The newest run of a grade for a release, or null when there is none: the one the gate reads. Pilots are not runs (`runFileName`). */
export function newestRun(dir: string, release: string, grade: RunGrade): (GoldenRun & { readonly header: GoldenRunHeader }) | null {
  if (!existsSync(dir)) return null;
  const prefix = `golden-run-${release}-${grade}`;
  const names = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl")).sort();
  const name = names.at(-1);
  return name === undefined ? null : readRunFile(dir, name);
}

/* ------------------------------------------------------------------ what a real run would cost */

export interface CostEstimate {
  /** Null when nothing is known to estimate from. */
  readonly usd: number | null;
  readonly text: string;
}

const meanCost = (run: GoldenRun) => run.items.reduce((sum, item) => sum + item.costUsd, 0) / run.items.length;

/**
 * What a real run of `items` items would cost, from what is known (feature-specs/22 D2). The newest real run's mean
 * per item, when there is one. Else the larger of two figures, because an estimate that turns out low is the one
 * that stops a run half-way: the newest whole stub run's prompts priced by prices.ts (the golden set's own size at
 * list price, with the stub's short answers), and the principal's paid turns of the last thirty days (a provider's
 * answers, on other questions). No basis, no number: the text says so instead of guessing.
 */
export function estimateOf(items: number, known: { readonly real: GoldenRun | null; readonly stub: GoldenRun | null; readonly paidTurns: ReadonlyArray<number> }): CostEstimate {
  const { real, stub } = known;
  if (real !== null && real.items.length > 0) {
    const mean = meanCost(real);
    return { usd: mean * items, text: `about $${(mean * items).toFixed(2)} for ${String(items)} items, at the $${mean.toFixed(4)} an item of ${real.file}` };
  }
  const bases: Array<{ readonly usd: number; readonly from: string }> = [];
  if (stub !== null && stub.items.length > 0 && !stub.partial) {
    const mean = meanCost(stub);
    bases.push({ usd: mean * items, from: `the stub run's own prompts priced by prices.ts, $${mean.toFixed(4)} an item (${stub.file})` });
  }
  const paid = known.paidTurns.filter((cost) => cost > 0);
  if (paid.length > 0) {
    const mean = paid.reduce((sum, cost) => sum + cost, 0) / paid.length;
    bases.push({ usd: mean * items, from: `this principal's last ${String(paid.length)} paid turns, $${mean.toFixed(4)} a turn` });
  }
  const [first, second] = bases.sort((a, b) => b.usd - a.usd);
  if (first === undefined) return { usd: null, text: "no basis for an estimate: there is no earlier run and this principal has no paid turn in the last thirty days. Run the stub grade first (--stub), then ask again." };
  return { usd: first.usd, text: `about $${first.usd.toFixed(2)} for ${String(items)} items, from ${first.from}${second === undefined ? "" : `; the lower figure, $${second.usd.toFixed(2)}, is from ${second.from}`}` };
}
