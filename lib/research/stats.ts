import { AppError } from "@/lib/errors";
import { runWordOf } from "@/lib/research/runBlock";
import { runLineOf, type RunViewRow } from "@/lib/research/runView";
import type { FindingOutcome } from "@/lib/schemas/research";

/*
 * A person's research statistics (feature-specs/48 § 11.6, A9; unit 73), pure: what the Research page's third region
 * counts of the person's own runs in their researches, started in the window. Every cell but the flags counts the runs
 * with a workflow — so never a question a rule refused at its start, which reached nothing; the flags count every run,
 * since a rule's refusal can be flagged too (§ 11.7; review of unit 73). The door (`lib/db/researchStats.ts`) reads the
 * rows inside the person's context and hands them here; nothing here reads a row, and nothing here is a sentence: the
 * panel words the numbers.
 *
 * - **runs**, and how they ended, by the word each run's own line reads (§ 18): `done`, `refused`, `stopped` — the cap
 *   during the run, the engine's silence, a delete or the 30 days mid-run — and `failed`. A run still under way, one not
 *   started at the cap and one not run (the engine or the gateway refused it before anything was spent) are runs and
 *   none of the four, as their lines say none of the four. Runs, not researches: a research of three questions is
 *   three runs here and one row in the list (review of unit 73).
 * - **cost**: the `BudgetLedger` rows that name the runs, summed, and per run, the sum over the runs that were charged
 *   anything, so a run that spent nothing does not halve the price of one that did. The rows' costs are Decimals, read
 *   back as numbers here at a range check (code-standards § TypeScript), as the budget meter reads them.
 * - **sources read**: the searches, the pages opened, and the pages seen — every page the run listed (`found.read`),
 *   which the 30 days remove, so the runs whose text is gone add nothing to it, and with none held it is not known.
 * - **findings**: the ones that passed the checks (every outcome but `INVALID`, as a run's line counts them), the ones
 *   turned into improvements (drafted, or sent whatever became of them, as the list's `used`), and of those the ones
 *   accepted: whose suggestion is merged. A duplicate is sent and doubles another suggestion, which is not the one the
 *   finding made, so its merge is never this finding's acceptance.
 * - **flagged reports**: every run with a flag, a refusal's among them, a rule's included (§ 11.7).
 */

/** The outcomes of a finding turned into an improvement: drafted, or sent whatever became of it (§ 8.1, § 11.4). */
export const USED_OUTCOMES: ReadonlySet<FindingOutcome> = new Set(["DRAFTED", "SUBMITTED", "DUPLICATE", "PROPOSED", "REFUTED"]);

/** A draft's suggestion is the person's own, read by the owner's read; a sent one's is a researcher's proposal, read by the door's read for the asker (§ 11.6). */
export const DRAFT_OUTCOMES: ReadonlySet<FindingOutcome> = new Set(["DRAFTED"]);
export const SENT_OUTCOMES: ReadonlySet<FindingOutcome> = new Set(["SUBMITTED", "PROPOSED", "REFUTED"]);

/** A run as the statistics read it: its line's facts, its counts, its cost and flag, and its findings. */
export interface StatsRun extends Pick<RunViewRow, "state" | "skip" | "failure" | "createdAt" | "textPurgedAt" | "searches" | "pageReads"> {
  /** Started with a workflow. A run a rule refused at its start never had one: it counts toward the flags alone. */
  readonly workflow: boolean;
  /** The pages the run listed (`found.read`); null once its text is gone, or where it never listed any. */
  readonly pagesSeen: number | null;
  /** Its `BudgetLedger` rows' cost summed, a Decimal as the database prints it; null where no row names it. */
  readonly costUsd: string | null;
  readonly flagged: boolean;
  readonly findings: ReadonlyArray<{ readonly outcome: FindingOutcome; readonly suggestionId: string | null }>;
}

export interface ResearchStats {
  /** The runs with a workflow. */
  readonly runs: number;
  readonly ends: { readonly done: number; readonly refused: number; readonly stopped: number; readonly failed: number };
  /** In US dollars; null where no run was charged anything. */
  readonly cost: { readonly total: number | null; readonly perRun: number | null };
  readonly sources: { readonly searches: number; readonly opened: number; readonly seen: number | null };
  readonly findings: { readonly passed: number; readonly used: number; readonly accepted: number };
  /** Every run with a flag, a rule's refusal included. */
  readonly flagged: number;
}

type End = keyof ResearchStats["ends"];

/** The four ends the statistics name, by the word a run's line reads (§ 18); every other word is none of them. */
const END_OF: Readonly<Partial<Record<ReturnType<typeof runWordOf>, End>>> = { done: "done", refused: "refused", stopped: "stopped", failed: "failed" };

/** A run's cost as a number: the boundary where a Decimal becomes one, refused out of range rather than summed wrong. */
function usdOf(text: string): number {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new AppError("RESEARCH_STATS_COST", `a run's cost must be a finite amount of at least 0 US$, not ${text}`);
  return value;
}

/**
 * The statistics of some runs. `merged` holds the ids of the suggestions, among those the runs' findings name, that are
 * merged; `now` decides which runs under way are stale, as their lines do.
 */
export function researchStatsOf(runs: ReadonlyArray<StatsRun>, merged: ReadonlySet<string>, now: Date): ResearchStats {
  const ends = { done: 0, refused: 0, stopped: 0, failed: 0 };
  let counted = 0;
  let total = 0;
  let charged = 0;
  let searches = 0;
  let opened = 0;
  let seen: number | null = null;
  let passed = 0;
  let used = 0;
  let accepted = 0;
  let flagged = 0;
  for (const run of runs) {
    if (run.flagged) flagged += 1;
    /* a question a rule refused at its start reached nothing: its flag is counted, and nothing else of it */
    if (!run.workflow) continue;
    counted += 1;
    const end = END_OF[runWordOf(runLineOf(run, now).line.key)];
    if (end !== undefined) ends[end] += 1;
    if (run.costUsd !== null) {
      total += usdOf(run.costUsd);
      charged += 1;
    }
    searches += run.searches;
    opened += run.pageReads;
    if (run.pagesSeen !== null) seen = (seen ?? 0) + run.pagesSeen;
    for (const finding of run.findings) {
      if (finding.outcome === "INVALID") continue;
      passed += 1;
      if (!USED_OUTCOMES.has(finding.outcome)) continue;
      used += 1;
      const own = DRAFT_OUTCOMES.has(finding.outcome) || SENT_OUTCOMES.has(finding.outcome);
      if (own && finding.suggestionId !== null && merged.has(finding.suggestionId)) accepted += 1;
    }
  }
  return {
    runs: counted,
    ends,
    cost: charged === 0 ? { total: null, perRun: null } : { total, perRun: total / charged },
    sources: { searches, opened, seen },
    findings: { passed, used, accepted },
    flagged,
  };
}

/** An amount in US dollars as the page prints a run's cost: to the hundredth of a cent at most, no trailing zero (`0.61`, `1.8369`, `0`). */
export function usdText(value: number): string {
  return String(Number(value.toFixed(4)));
}
