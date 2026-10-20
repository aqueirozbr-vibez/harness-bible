import { cohenKappa, KAPPA_FLOOR, KAPPA_MIN_PAIRS, KAPPA_RETIRE } from "@/lib/gate/kappa";
import { CRITERIA, type Criterion, type CuratorAction, type Decision, type SuggestionOrigin } from "@/lib/schemas/improve";

/*
 * Calibration (feature-specs/36 § 6.1; unit 53d): three measures of the adjudicator against the curators, over the
 * calibration events the curators' decisions write (33 § 6.3) and the adjudicator's accepts. Pure.
 *
 * - The override rate per criterion: of the decisions a curator reviewed that had an adjudication, the share
 *   overridden on that criterion. Target 10 %; past 20 % a rubric review is due (§ 6.3).
 * - The adjudicator's κ against the curators, by the gate's own function (lib/gate/kappa.ts), over whether each
 *   accepted: an override is exactly a disagreement there (§ 5.2). Retire under 0.6, the gate at 0.7.
 * - Adjudication precision: of the suggestions the adjudicator accepted, the share a curator later reverted. Under 3 %.
 *
 * A seed's decision is in none of them (§ 7.1); a researcher's proposal is in all three, and in the same three
 * apart (spec 44). The quarter is the calendar's, UTC, so the rail's quarter, the API's and a review's are one span.
 */

/** The override rate's lines (36 § 6.1): the target, and the rate past which a rubric review is due (§ 6.3). */
export const OVERRIDE_TARGET = 0.1;
export const OVERRIDE_REVIEW = 0.2;
/** Adjudication precision's target: under 3 % reverted. */
export const PRECISION_TARGET = 0.03;
/** κ's lines are the gate's own (architecture § 6.2): retired under 0.6, the gate at 0.7. */
export const KAPPA_GATE = KAPPA_FLOOR;
export { KAPPA_RETIRE };
/**
 * Under this many decisions a measure says nothing: the rail shows its counts and a dash (36 § 6.1). It is the gate's
 * own minimum for κ, kept for the two rates as well, so that the three begin to read together.
 */
export const MEASURE_MIN = KAPPA_MIN_PAIRS;

/** A calibration event as the measures read it: what the adjudicator decided beside what the curator did, and on which criterion. */
export interface CalibrationRow {
  readonly criterion: string | null;
  /** Null where no adjudicator decided: a curator-always change, a rule's decision, the adjudicator's failure. */
  readonly adjudicatorDecision: Decision | null;
  readonly curatorAction: CuratorAction;
  readonly seeded: boolean;
  readonly origin: SuggestionOrigin;
}

/** An accept of the adjudicator's, and whether a curator has since reverted it (spec 37 § 8). */
export interface AcceptedRow {
  readonly origin: SuggestionOrigin;
  readonly reverted: boolean;
}

/** A calendar quarter, UTC: `2026-Q4` runs from 1 October inclusive to 1 January exclusive. */
export interface Quarter {
  readonly label: string;
  readonly year: number;
  readonly number: 1 | 2 | 3 | 4;
  readonly from: Date;
  readonly to: Date;
}

const quarterAt = (year: number, index: number): Quarter => ({
  label: `${String(year)}-Q${String(index + 1)}`,
  year,
  number: (index + 1) as Quarter["number"],
  from: new Date(Date.UTC(year, index * 3, 1)),
  to: new Date(Date.UTC(year, index * 3 + 3, 1)),
});

/** The quarter an instant is in. */
export function quarterOf(at: Date): Quarter {
  return quarterAt(at.getUTCFullYear(), Math.floor(at.getUTCMonth() / 3));
}

/** The quarter `back` quarters before `quarter`: 0 is itself, 1 the one before. */
export function quarterBefore(quarter: Quarter, back: number): Quarter {
  const index = quarter.year * 4 + (quarter.number - 1) - back;
  return quarterAt(Math.floor(index / 4), ((index % 4) + 4) % 4);
}

/** A curator's decision that differs from the adjudicator's (36 § 5.2): accepting what it left at request more or declined; declining what it accepted. */
export function overrides(row: Pick<CalibrationRow, "adjudicatorDecision" | "curatorAction">): boolean {
  if (row.curatorAction === "ACCEPT") return row.adjudicatorDecision === "REQUEST_MORE" || row.adjudicatorDecision === "DECLINE";
  return row.curatorAction === "DECLINE" && row.adjudicatorDecision === "ACCEPT";
}

/** What the measures are taken over: a queue decision (accept, keep, decline) on what the adjudicator decided, never a seed's. A merge and a revert are spec 37's. */
function reviewed(rows: ReadonlyArray<CalibrationRow>): ReadonlyArray<CalibrationRow> {
  return rows.filter((row) => !row.seeded && row.adjudicatorDecision !== null && row.adjudicatorDecision !== "CURATOR_REVIEW" && (row.curatorAction === "ACCEPT" || row.curatorAction === "KEEP_REQUEST_MORE" || row.curatorAction === "DECLINE"));
}

export interface OverrideRates {
  /** The decisions reviewed that had an adjudication: each rate's denominator. */
  readonly reviewed: number;
  /** Every criterion of the rubric, in its order, with the overrides attributed to it; `rate` null under the minimum. */
  readonly criteria: ReadonlyArray<{ readonly criterion: Criterion; readonly overridden: number; readonly rate: number | null }>;
}

export function overrideRates(rows: ReadonlyArray<CalibrationRow>): OverrideRates {
  const counted = reviewed(rows);
  return {
    reviewed: counted.length,
    criteria: CRITERIA.map((criterion) => {
      const overridden = counted.filter((row) => row.criterion === criterion && overrides(row)).length;
      return { criterion, overridden, rate: counted.length < MEASURE_MIN ? null : overridden / counted.length };
    }),
  };
}

/** The criteria whose rate has passed the review line (36 § 6.3): strictly over 20 %. */
export function reviewsDue(rates: OverrideRates): ReadonlyArray<Criterion> {
  return rates.criteria.filter((entry) => entry.rate !== null && entry.rate > OVERRIDE_REVIEW).map((entry) => entry.criterion);
}

export interface Kappa {
  /** The items both decided. */
  readonly pairs: number;
  /** Of them, those on which the adjudicator and the curator agreed, accepting or not. */
  readonly agreed: number;
  /** Null under the minimum. */
  readonly value: number | null;
}

/** Cohen's κ between the adjudicator and the curators on the items both decided, as the gate takes it: whether each accepted. */
export function adjudicatorKappa(rows: ReadonlyArray<CalibrationRow>): Kappa {
  const pairs = reviewed(rows).map((row) => [row.adjudicatorDecision === "ACCEPT", row.curatorAction === "ACCEPT"] as const);
  return { pairs: pairs.length, agreed: pairs.filter(([adjudicator, curator]) => adjudicator === curator).length, value: cohenKappa(pairs) ?? null };
}

export interface Precision {
  readonly accepted: number;
  readonly reverted: number;
  /** The share reverted; null under the minimum. */
  readonly rate: number | null;
}

/** Of the adjudicator's accepts, the share a curator later reverted. */
export function precisionOf(accepted: ReadonlyArray<AcceptedRow>): Precision {
  const reverted = accepted.filter((row) => row.reverted).length;
  return { accepted: accepted.length, reverted, rate: accepted.length < MEASURE_MIN ? null : reverted / accepted.length };
}

export interface Measures {
  readonly overrideRate: OverrideRates;
  readonly kappa: Kappa;
  readonly precision: Precision;
}

const measured = (rows: ReadonlyArray<CalibrationRow>, accepted: ReadonlyArray<AcceptedRow>): Measures => ({ overrideRate: overrideRates(rows), kappa: adjudicatorKappa(rows), precision: precisionOf(accepted) });

/** The three over everything, and over the researcher's proposals alone (36 § 6.1; spec 44). */
export function measuresOf(rows: ReadonlyArray<CalibrationRow>, accepted: ReadonlyArray<AcceptedRow>): { readonly all: Measures; readonly researcher: Measures } {
  const researcher = (row: { readonly origin: SuggestionOrigin }): boolean => row.origin === "RESEARCHER";
  return { all: measured(rows, accepted), researcher: measured(rows.filter(researcher), accepted.filter(researcher)) };
}
