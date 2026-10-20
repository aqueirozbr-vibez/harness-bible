import { describe, expect, it } from "vitest";

import { cohenKappa } from "@/lib/gate/kappa";

import { adjudicatorKappa, KAPPA_GATE, KAPPA_RETIRE, measuresOf, MEASURE_MIN, OVERRIDE_REVIEW, OVERRIDE_TARGET, overrideRates, overrides, PRECISION_TARGET, precisionOf, quarterBefore, quarterOf, reviewsDue, type AcceptedRow, type CalibrationRow } from "./calibration";

/*
 * Calibration's three measures (feature-specs/36 § 6.1, § 11.6; unit 53d), to the digit: the override rate per
 * criterion, the adjudicator's κ by the gate's own function, adjudication precision; each null under the minimum;
 * a rubric review due strictly past 20 %; seeds and decisions without an adjudication in none; the quarter.
 */

const row = (adjudicatorDecision: CalibrationRow["adjudicatorDecision"], curatorAction: CalibrationRow["curatorAction"], criterion: string | null = null, fields: Partial<CalibrationRow> = {}): CalibrationRow => ({ criterion, adjudicatorDecision, curatorAction, seeded: false, origin: "HUMAN", ...fields });
const times = (n: number, make: () => CalibrationRow): CalibrationRow[] => Array.from({ length: n }, make);

/** Forty decisions on what the adjudicator left at request more: five overrides on independence, two on recency, one on relevance, the rest kept. */
const QUARTER: ReadonlyArray<CalibrationRow> = [
  ...times(5, () => row("REQUEST_MORE", "ACCEPT", "independence")),
  ...times(2, () => row("REQUEST_MORE", "ACCEPT", "recency")),
  ...times(1, () => row("REQUEST_MORE", "ACCEPT", "relevance")),
  ...times(30, () => row("REQUEST_MORE", "KEEP_REQUEST_MORE")),
  /* declining a request for more is no override (36 § 5.2), and counts in the denominator */
  ...times(2, () => row("REQUEST_MORE", "DECLINE", "relevance")),
  /* none of these is counted: a seed, a curator-always change, the adjudicator's failure, a merge */
  row("REQUEST_MORE", "ACCEPT", "independence", { seeded: true }),
  row(null, "ACCEPT"),
  row("CURATOR_REVIEW", "ACCEPT", "tier"),
  row("ACCEPT", "MERGE"),
];

describe("the lines (36 § 6.1)", () => {
  it("are the screen's: 10 % and 20 %, κ 0.6 and 0.7, under 3 %, and a measure from twenty decisions", () => {
    expect([OVERRIDE_TARGET, OVERRIDE_REVIEW, KAPPA_RETIRE, KAPPA_GATE, PRECISION_TARGET, MEASURE_MIN]).toEqual([0.1, 0.2, 0.6, 0.7, 0.03, 20]);
  });
});

describe("overrides (36 § 5.2)", () => {
  it("is accepting what the adjudicator left at request more or declined, and declining what it accepted", () => {
    expect([overrides(row("REQUEST_MORE", "ACCEPT")), overrides(row("DECLINE", "ACCEPT")), overrides(row("ACCEPT", "DECLINE"))]).toEqual([true, true, true]);
    expect([overrides(row("ACCEPT", "ACCEPT")), overrides(row("REQUEST_MORE", "KEEP_REQUEST_MORE")), overrides(row("REQUEST_MORE", "DECLINE")), overrides(row(null, "ACCEPT"))]).toEqual([false, false, false, false]);
  });
});

describe("overrideRates", () => {
  it("gives each criterion its overrides over every decision reviewed with an adjudication, to the digit", () => {
    const rates = overrideRates(QUARTER);
    expect(rates.reviewed).toBe(40);
    expect(rates.criteria).toEqual([
      { criterion: "tier", overridden: 0, rate: 0 },
      { criterion: "relevance", overridden: 1, rate: 0.025 },
      { criterion: "recency", overridden: 2, rate: 0.05 },
      { criterion: "independence", overridden: 5, rate: 0.125 },
      { criterion: "corroboration", overridden: 0, rate: 0 },
      { criterion: "threshold", overridden: 0, rate: 0 },
    ]);
  });

  it("says nothing under twenty decisions, but keeps the counts", () => {
    const few = overrideRates(QUARTER.slice(0, 19));
    expect(few.reviewed).toBe(19);
    expect(few.criteria.find((entry) => entry.criterion === "independence")).toEqual({ criterion: "independence", overridden: 5, rate: null });
    expect(reviewsDue(few)).toEqual([]);
  });
});

describe("reviewsDue (36 § 6.3)", () => {
  it("opens a review at 21 % on one criterion, and none at 20 % exactly", () => {
    /* 21 of 100 on independence */
    const past = [...times(21, () => row("REQUEST_MORE", "ACCEPT", "independence")), ...times(79, () => row("REQUEST_MORE", "KEEP_REQUEST_MORE"))];
    expect(reviewsDue(overrideRates(past))).toEqual(["independence"]);
    const at = [...times(20, () => row("REQUEST_MORE", "ACCEPT", "independence")), ...times(80, () => row("REQUEST_MORE", "KEEP_REQUEST_MORE"))];
    expect(reviewsDue(overrideRates(at))).toEqual([]);
  });
});

describe("adjudicatorKappa", () => {
  it("is the gate's κ over whether each accepted, to the digit", () => {
    /* 20 items: both accept 6; the curator declines 2 the adjudicator accepted; accepts 3 it asked more for; both keep 9. */
    const rows = [...times(6, () => row("ACCEPT", "ACCEPT")), ...times(2, () => row("ACCEPT", "DECLINE", "relevance")), ...times(3, () => row("REQUEST_MORE", "ACCEPT", "independence")), ...times(9, () => row("REQUEST_MORE", "KEEP_REQUEST_MORE"))];
    const kappa = adjudicatorKappa(rows);
    expect(kappa).toMatchObject({ pairs: 20, agreed: 15 });
    /* observed 0.75; by chance 0.4 × 0.45 + 0.6 × 0.55 = 0.51 */
    expect(kappa.value).toBeCloseTo((0.75 - 0.51) / (1 - 0.51), 12);
    expect(kappa.value?.toFixed(4)).toBe("0.4898");
    expect(kappa.value).toBe(cohenKappa(rows.map((entry) => [entry.adjudicatorDecision === "ACCEPT", entry.curatorAction === "ACCEPT"] as const)));
  });

  it("says nothing under twenty items, and leaves out what no adjudicator decided", () => {
    expect(adjudicatorKappa(times(19, () => row("ACCEPT", "ACCEPT")))).toEqual({ pairs: 19, agreed: 19, value: null });
    expect(adjudicatorKappa(QUARTER)).toMatchObject({ pairs: 40, agreed: 32 });
  });
});

describe("precisionOf", () => {
  it("is the share of the adjudicator's accepts later reverted, to the digit, and nothing under twenty", () => {
    const accepted = (n: number, reverted: number): AcceptedRow[] => Array.from({ length: n }, (_, index) => ({ origin: "HUMAN", reverted: index < reverted }));
    expect(precisionOf(accepted(40, 1))).toEqual({ accepted: 40, reverted: 1, rate: 0.025 });
    expect(precisionOf(accepted(111, 2)).rate?.toFixed(3)).toBe("0.018");
    expect(precisionOf(accepted(19, 1))).toEqual({ accepted: 19, reverted: 1, rate: null });
    expect(precisionOf([])).toEqual({ accepted: 0, reverted: 0, rate: null });
  });
});

describe("measuresOf (spec 44)", () => {
  it("measures everything, and the researcher's proposals apart", () => {
    const mixed = [...QUARTER, ...times(3, () => row("ACCEPT", "ACCEPT", null, { origin: "RESEARCHER" }))];
    const { all, researcher } = measuresOf(mixed, [{ origin: "RESEARCHER", reverted: true }, { origin: "HUMAN", reverted: false }]);
    expect(all.overrideRate.reviewed).toBe(43);
    expect(researcher.overrideRate.reviewed).toBe(3);
    expect(researcher.kappa).toEqual({ pairs: 3, agreed: 3, value: null });
    expect([all.precision.accepted, researcher.precision.accepted, researcher.precision.reverted]).toEqual([2, 1, 1]);
  });
});

describe("the quarter", () => {
  it("is the calendar's, UTC, from its first instant to the next quarter's", () => {
    expect(quarterOf(new Date("2026-10-08T23:03:19.000Z"))).toEqual({ label: "2026-Q4", year: 2026, number: 4, from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2027-01-01T00:00:00.000Z") });
    expect(quarterOf(new Date("2026-03-31T23:59:59.999Z")).label).toBe("2026-Q1");
    expect(quarterOf(new Date("2026-04-01T00:00:00.000Z")).label).toBe("2026-Q2");
  });

  it("counts back across a year", () => {
    const q = quarterOf(new Date("2027-01-15T00:00:00.000Z"));
    expect([0, 1, 4, 5].map((back) => quarterBefore(q, back).label)).toEqual(["2027-Q1", "2026-Q4", "2026-Q1", "2025-Q4"]);
    expect(quarterBefore(q, 1).to).toEqual(q.from);
  });
});
