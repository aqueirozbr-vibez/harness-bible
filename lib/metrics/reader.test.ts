import { describe, expect, it } from "vitest";

import { percentileCont, ratio, statsOf, type StatRow } from "./reader";

/*
 * The reader's series (feature-specs/25 § 3, § 10.1): each definition on rows whose answer is known by hand. The
 * same definitions are held to the SQL statements, against the database, by tests/integration/assistant-stats.test.ts.
 */

const ANSWER: StatRow = { refusalCause: null, modelId: "claude-opus-5", substituted: 0, firstTokenMs: 900, grounded: 0.9, citesEdition: "EN", citationVerdict: "PASS", flagReasons: [], locale: "en" };
const answer = (overrides: Partial<StatRow> = {}): StatRow => ({ ...ANSWER, ...overrides });
const refusal = (cause: string, overrides: Partial<StatRow> = {}): StatRow => answer({ refusalCause: cause, substituted: 0, firstTokenMs: null, grounded: null, citesEdition: null, citationVerdict: "NA", ...overrides });
/** A turn that failed after the question was recorded: no model, no verdict but the NA that names the error. */
const failed = (): StatRow => answer({ modelId: null, firstTokenMs: null, grounded: null, citesEdition: null, citationVerdict: null });
/** A walk: its numbers are the script's, so the citation sensor had nothing to check. */
const walk = (): StatRow => answer({ citationVerdict: "NA", firstTokenMs: null, grounded: null, citesEdition: null });

describe("percentileCont, as PostgreSQL's percentile_cont interpolates", () => {
  it("is null for no values and the value itself for one", () => {
    expect(percentileCont([], 0.95)).toBeNull();
    expect(percentileCont([800], 0.95)).toBe(800);
    expect(percentileCont([800], 0.1)).toBe(800);
  });

  it("interpolates between the two rows the position falls between", () => {
    /* SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY x) FROM (VALUES (800), (2500)) t(x) → 2415 */
    expect(percentileCont([2500, 800], 0.95)).toBeCloseTo(2415, 9);
    /* … FROM (VALUES (800), (900), (2500)) → 2340; the median of the three → 900 */
    expect(percentileCont([800, 900, 2500], 0.95)).toBeCloseTo(2340, 9);
    expect(percentileCont([800, 900, 2500], 0.5)).toBe(900);
    /* … of 0.5, 0.75, 0.9: p50 → 0.75, p10 → 0.55 */
    expect(percentileCont([0.9, 0.75, 0.5], 0.5)).toBe(0.75);
    expect(percentileCont([0.9, 0.75, 0.5], 0.1)).toBeCloseTo(0.55, 9);
  });

  it("matches the rank formula on twenty values, in any order", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => (index + 1) * 100);
    /* row 1 + 0.95 × 19 = 19.05: between 1900 and 2000, 5 % of the way */
    expect(percentileCont([...twenty].reverse(), 0.95)).toBeCloseTo(1905, 9);
    expect(percentileCont(twenty, 0.5)).toBeCloseTo(1050, 9);
    expect(percentileCont(twenty, 0)).toBe(100);
    expect(percentileCont(twenty, 1)).toBe(2000);
  });
});

describe("the reader's series (feature-specs/25 § 3)", () => {
  it("is all zeroes and nulls for a reader with no turns", () => {
    const stats = statsOf([]);
    expect(stats.turns).toBe(0);
    expect(stats.citationRate).toEqual({ n: 0, d: 0, value: null });
    expect(stats.refusalRate).toEqual({ n: 0, d: 0, value: null });
    expect(stats.flagRate).toEqual({ n: 0, d: 0, value: null });
    expect(stats.firstTokenP95).toEqual({ value: null, samples: 0 });
    expect(stats.grounded).toEqual({ p50: null, p10: null, samples: 0 });
    expect([stats.refusalsByCause, stats.flagsByReason, stats.editionMismatch]).toEqual([[], [], []]);
  });

  it("counts an answer as fully cited only with a PASS and no claim replaced", () => {
    const stats = statsOf([answer(), answer({ citationVerdict: "WARN", substituted: 1 }), answer({ citationVerdict: "PASS", substituted: 1 }), answer({ citationVerdict: "FAIL" })]);
    expect(stats.citationRate).toEqual({ n: 1, d: 4, value: 0.25 });
  });

  it("leaves a walk, a refusal and a failed turn outside the citation rate", () => {
    const stats = statsOf([answer(), walk(), refusal("R-SCOPE-OT"), failed()]);
    expect(stats.citationRate).toEqual({ n: 1, d: 1, value: 1 });
    expect(stats.turns).toBe(4);
  });

  it("takes refusals over every turn, a failed turn in the denominator and not the numerator, and one line per cause", () => {
    const stats = statsOf([answer(), failed(), refusal("R-SCOPE-OT"), refusal("R-SCOPE-OT"), refusal("R-UNVERIFIED"), refusal("R-SCOPE"), refusal("R-RECOMPUTE"), answer()]);
    expect(stats.refusalRate).toEqual({ n: 5, d: 8, value: 0.625 });
    expect(stats.refusalsByCause).toEqual([
      { cause: "R-RECOMPUTE", n: 1, value: 0.125 },
      { cause: "R-SCOPE", n: 1, value: 0.125 },
      { cause: "R-SCOPE-OT", n: 2, value: 0.25 },
      { cause: "R-UNVERIFIED", n: 1, value: 0.125 },
    ]);
  });

  it("reads the first-token percentile over the turns that streamed one", () => {
    const stats = statsOf([answer({ firstTokenMs: 800 }), answer({ firstTokenMs: 900 }), answer({ firstTokenMs: 2500 }), refusal("R-SCOPE-OT"), failed()]);
    expect(stats.firstTokenP95.samples).toBe(3);
    expect(stats.firstTokenP95.value).toBeCloseTo(2340, 9);
  });

  it("reads the grader's median and tenth percentile over the graded answers", () => {
    const stats = statsOf([answer({ grounded: 0.9 }), answer({ grounded: 0.75 }), answer({ grounded: 0.5 }), answer({ grounded: null }), refusal("R-SCOPE")]);
    expect(stats.grounded.samples).toBe(3);
    expect(stats.grounded.p50).toBe(0.75);
    expect(stats.grounded.p10).toBeCloseTo(0.55, 9);
  });

  it("counts a flagged message once, whether an answer or a refusal, and by reason", () => {
    const stats = statsOf([answer({ flagReasons: ["wrong_number"] }), refusal("R-SCOPE", { flagReasons: ["should_have_answered"] }), answer(), answer()]);
    expect(stats.flagRate).toEqual({ n: 2, d: 4, value: 0.5 });
    expect(stats.flagsByReason).toEqual([
      { reason: "should_have_answered", n: 1, value: 0.25 },
      { reason: "wrong_number", n: 1, value: 0.25 },
    ]);
  });

  it("measures the edition gap per reader language, over the answers that cite an edition", () => {
    const stats = statsOf([
      answer({ locale: "pt", citesEdition: "EN" }),
      answer({ locale: "pt", citesEdition: "EN" }),
      answer({ locale: "pt", citesEdition: "PT" }),
      answer({ locale: "en", citesEdition: "EN" }),
      /* Cites nothing, was refused, or failed: no edition to differ from. */
      answer({ locale: "pt", citesEdition: null }),
      refusal("R-SCOPE", { locale: "pt" }),
      failed(),
    ]);
    expect(stats.editionMismatch).toEqual([
      { locale: "en", n: 0, d: 1, value: 0 },
      { locale: "pt", n: 2, d: 3, value: 2 / 3 },
    ]);
  });
});

describe("a ratio", () => {
  it("has no value when there is nothing to divide by", () => {
    expect(ratio(0, 0)).toEqual({ n: 0, d: 0, value: null });
    expect(ratio(3, 4)).toEqual({ n: 3, d: 4, value: 0.75 });
  });
});
