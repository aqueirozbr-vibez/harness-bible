import { z } from "zod";

/*
 * The research run's vocabulary (feature-specs/40 § 3, § 5, § 9): the states a run passes through, the reasons a turn is
 * skipped, the outcomes of a finding, and what the assistant's `final` event says of the run. The enums are the
 * database's, written here so that the web tier and the workers share them without the generated client. Every schema
 * here passes `freeTextIn` (./freeText.ts): none can hold a sentence.
 */

/** `WRITING` and `REFUSED` are a person's run's alone (feature-specs/48 § 5): the writer's step, and a refusal, an end state. A run of an answered turn never reaches either. */
export const RESEARCH_STATES = ["QUEUED", "PLANNING", "READING", "VALIDATING", "SUBMITTING", "DONE", "SKIPPED", "WAITING_BUDGET", "FAILED", "WRITING", "REFUSED"] as const;
export const ResearchStateSchema = z.enum(RESEARCH_STATES);
export type ResearchState = z.infer<typeof ResearchStateSchema>;

/**
 * Why a turn was not researched, in the order the legacy hand-over's eligibility checked (40 § 5), with the three a run
 * itself can end in. The hand-over and its eligibility went in unit 75 (feature-specs/48 § 9.2): the first seven, and
 * `NOTHING_TO_RESEARCH`, the legacy planner's, are legacy rows' alone, read as they stand; a person's run ends in
 * `BUDGET` (the eligibility's eighth, and a person's at their cap), `TEXT_PURGED` or `UNAVAILABLE`.
 */
export const RESEARCH_SKIPS = ["OFF_USER", "OFF_ORGANISATION", "NOT_AN_ANSWER", "NO_CITATION", "DEDUPED", "SAME_QUESTION", "DAILY_LIMIT", "BUDGET", "NOTHING_TO_RESEARCH", "TEXT_PURGED", "UNAVAILABLE"] as const;
export const ResearchSkipSchema = z.enum(RESEARCH_SKIPS);
export type ResearchSkip = z.infer<typeof ResearchSkipSchema>;

/**
 * What became of a finding (40 § 3): refused by the validation, the same proposal already made, become a suggestion and
 * waiting (42 § 4; unit 59b), refuted or proposed by Improve (42 § 5). A person's run's finding (feature-specs/48 § 5.5,
 * § 8) is also `VALID` — it passed the checks and waits for the person's press — or `DRAFTED`, made their own draft.
 */
export const FINDING_OUTCOMES = ["INVALID", "DUPLICATE", "SUBMITTED", "REFUTED", "PROPOSED", "VALID", "DRAFTED"] as const;
export const FindingOutcomeSchema = z.enum(FINDING_OUTCOMES);
export type FindingOutcome = z.infer<typeof FindingOutcomeSchema>;

/**
 * What the `final` event said of the run that followed an answer (40 § 6.1 step 4): its state, why it was skipped, its
 * id; and, since unit 60a (43 § 4.2), the two numbers a skip's line needs — the whole days since the sections or the
 * question were researched (`DEDUPED`, `SAME_QUESTION`), and the budget's reset (`BUDGET`, `WAITING_BUDGET`) — so the
 * line under the answer is whole from the event and asks nothing for a turn that is over. Since unit 75 no `final`
 * carries it (feature-specs/48 § 9.2); a stored `final` of an earlier turn still does, and its replay reads it.
 */
export const ResearchStartedSchema = z
  .strictObject({
    state: ResearchStateSchema,
    skip: ResearchSkipSchema.nullable(),
    runId: z.uuid().nullable(),
    days: z.number().int().nonnegative().nullable(),
    resetsAt: z.iso.datetime().nullable(),
  })
  .readonly();
export type ResearchStarted = z.infer<typeof ResearchStartedSchema>;

/**
 * Why a person's run was refused (feature-specs/48 § 5.2, § 5.3): by a rule at its start, at no cost and with no
 * workflow (`R-SCOPE-OT`, the plant-equipment rule; `R-UNVERIFIED`, a chapter that has not passed verification), or by
 * the planner (`R-SCOPE`, not about the book; `R-PERSONAL`, about the person's own system, which the web must not be
 * asked about). The first three are the Assistant's causes; the fourth is research's own.
 */
export const RESEARCH_REFUSALS = ["R-SCOPE", "R-SCOPE-OT", "R-UNVERIFIED", "R-PERSONAL"] as const;
export const ResearchRefusalSchema = z.enum(RESEARCH_REFUSALS);
export type ResearchRefusal = z.infer<typeof ResearchRefusalSchema>;

/** The causes the planner gives, the only refusals a run's `RESEARCH` record carries: a run refused at its start has no record (48 § 15). */
export const PLANNER_REFUSALS = ["R-SCOPE", "R-PERSONAL"] as const satisfies ReadonlyArray<ResearchRefusal>;
export type PlannerRefusal = (typeof PLANNER_REFUSALS)[number];

/** The code a refused run ends with in its record and its line: the cause with underscores, since a code has no hyphen (`CODE_PATTERN`; 48 § 15). */
export function refusalCodeOf(cause: ResearchRefusal): string {
  return cause.replace(/-/g, "_");
}

/**
 * Why a send to Improve did not make a suggestion (feature-specs/48 § 8.4), written on the finding, which stays `VALID`:
 * research proposals not configured in the workers, no rubric in force, a finding that no longer parses, its anchor gone
 * from the release, its run's text gone, or — since unit 74's review — the month's thirty taken by the time the send's
 * transaction ran (`SENDS_LIMIT`, D5). A code each, never text; each names the person's next step (§ 8.1).
 */
export const FINDING_FAILURES = ["RESEARCH_UNCONFIGURED", "NO_RUBRIC", "PARSE", "ANCHOR_UNKNOWN", "TEXT_PURGED", "SENDS_LIMIT"] as const;
export const FindingFailureSchema = z.enum(FINDING_FAILURES);
export type FindingFailure = z.infer<typeof FindingFailureSchema>;

/**
 * How many findings one person may send to Improve as researcher proposals in a calendar month in UTC (48 D5, Andre,
 * 2026-10-12): the findings that became a suggestion, counted in the month's own row (`ResearchSendMonth`), which no
 * delete of a finding reaches (review of unit 74).
 */
export const RESEARCH_SENDS_PER_MONTH = 30;

/**
 * The calendar month in UTC a person's sends are counted in (48 § 8.3 step 5, D5): its key in `ResearchSendMonth`
 * (`2026-10`), its first instant, and the first instant of the next, when a send refused at the thirtieth can be made
 * again. Pure, so the page computes the reset it shows as the endpoint and the send's transaction compute the month.
 */
export function sendsMonthOf(now: Date): { readonly month: string; readonly since: Date; readonly resetsAt: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return { month: `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`, since: new Date(Date.UTC(year, month, 1)), resetsAt: new Date(Date.UTC(year, month + 1, 1)) };
}

/** Thirty runs a reader a day (A13). */
export const RESEARCH_RUNS_PER_DAY = 30;

/** The marks' keys (40 § 3): the platform's, no user, no text; since unit 75 only the legacy run's budget mark is written (48 § 4.3). */
export const markOfSection = (anchor: string): string => `section:${anchor}`;
export const markOfQuestion = (sha256: string): string => `question:${sha256}`;
export const BUDGET_MARK = "budget";

/** A code as the research rows, records and lines carry one: capitals, digits and underscores, never a message (feature-specs/44 § 4; unit 61a). */
export const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
