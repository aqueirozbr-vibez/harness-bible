import type { Decision, SuggestionState } from "@/lib/schemas/improve";
import type { FindingOutcome } from "@/lib/schemas/research";

/*
 * How a finding's suggestion is waited for (feature-specs/42 § 5; feature-specs/48 § 8.4): the pacing of the asks and
 * what a suggestion's place means for its finding. Moved here unchanged in unit 74 from the legacy `ResearchWorkflow`
 * and `workers/research/outcomes.ts`, so that both workflows that wait — the legacy run and `SendFindingWorkflow` —
 * import one copy. Workflow code imports it, so it stays pure: constants and functions of their arguments, and types
 * (eslint.config.mjs names it on the workflow code's allow-list). Unit 78 removes the legacy workflow and keeps this
 * file: `SendFindingWorkflow`'s running histories replay it.
 */

/**
 * How the run asks where its suggestions stand (42 § 5; unit 59's review): every 30 s for the first ten minutes, which
 * is when a suggestion graded and adjudicated at once reaches its place, then twice as long each time up to two hours,
 * for at most forty days — a wait at the budget's cap can last a month. Forty days are then about five hundred asks and
 * five thousand events of the run's history, a tenth of what the engine holds; an ask every 30 s would pass the engine's
 * limit in under two days and have the run ended by the server.
 */
export const OUTCOMES_EVERY = "30 seconds";
export const OUTCOMES_EVERY_MS = 30_000;
export const OUTCOMES_STEADY_MS = 10 * 60_000;
export const OUTCOMES_EVERY_MAX_MS = 2 * 3_600_000;
export const OUTCOMES_FOR_MS = 40 * 86_400_000;

/** The wait before the next ask, from the last wait and how long the run has waited so far. */
export function nextOutcomesWaitMs(lastMs: number, waitedMs: number): number {
  return waitedMs < OUTCOMES_STEADY_MS ? OUTCOMES_EVERY_MS : Math.min(lastMs * 2, OUTCOMES_EVERY_MAX_MS);
}

/** What a suggestion's place means for the finding (42 § 5); null while it is still deciding. */
export function outcomeOfState(state: SuggestionState, decision: Decision | null): FindingOutcome | null {
  void decision;
  switch (state) {
    case "CLOSED":
      return "REFUTED";
    case "CURATOR_QUEUE":
    case "MERGING":
    case "MERGED":
      return "PROPOSED";
    default:
      return null;
  }
}
