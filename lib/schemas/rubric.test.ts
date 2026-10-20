import { describe, expect, it } from "vitest";

import { EvidenceTierSchema } from "@/lib/schemas/domain";
import { CHANGE_CLASSES } from "@/lib/schemas/improve";
import { RUBRIC_V1_2 } from "@/tests/fixtures/rubric";

import { RELEVANCES, RubricFactorSchema, RubricRulesSchema, STAKES, type RubricRules } from "./rubric";

/*
 * The rubric's rules as data (feature-specs/30 § 3, § 4.3): v1.2 as the Rubric screen prints it is a valid set of
 * rules, and the schema refuses what the score's arithmetic could not take: a factor that is not a number of
 * hundredths, a tier or a class left out, windows out of order, a floor above its acceptance.
 */

type Json = Record<string, unknown>;
/** A copy of v1.2 with one thing changed. */
function changed(change: (rules: Json & { tiers: Json; adjustments: { relevance: Json; recency: Json; independence: Json; corroboration: Json }; thresholds: Json }) => void): unknown {
  const copy = structuredClone(RUBRIC_V1_2) as unknown as Parameters<typeof change>[0];
  change(copy);
  return copy;
}

describe("RubricRulesSchema", () => {
  it("takes rubric v1.2, with a base for each of the eight tiers and a threshold for each class", () => {
    const parsed: RubricRules = RubricRulesSchema.parse(RUBRIC_V1_2);
    expect(parsed).toEqual(RUBRIC_V1_2);
    expect(Object.keys(parsed.tiers)).toEqual(EvidenceTierSchema.options);
    expect(Object.keys(parsed.thresholds)).toEqual([...CHANGE_CLASSES]);
    expect(Object.keys(parsed.adjustments.relevance)).toEqual([...RELEVANCES]);
    expect(Object.keys(parsed.adjustments.independence)).toEqual([...STAKES]);
  });

  it("holds the numbers the Rubric screen prints", () => {
    expect(Object.values(RUBRIC_V1_2.tiers).map((tier) => tier.base)).toEqual([100, 85, 70, 60, 40, 25, 5, 0]);
    expect(Object.values(RUBRIC_V1_2.adjustments.relevance)).toEqual([1.0, 0.6, 0.2]);
    expect([...RUBRIC_V1_2.adjustments.recency.windows.map((window) => window.factor), RUBRIC_V1_2.adjustments.recency.older]).toEqual([1.0, 0.7, 0.3]);
    expect(Object.values(RUBRIC_V1_2.adjustments.independence)).toEqual([1.0, 0.8, 0.7]);
    expect(RUBRIC_V1_2.adjustments.corroboration).toEqual({ bonus: 10, minTier: "D" });
    expect(Object.values(RUBRIC_V1_2.thresholds).map((threshold) => (threshold === null ? null : [threshold.acceptAt, threshold.floorAt]))).toEqual([[40, 5], [70, 25], [100, 100], [85, 40], null]);
  });

  it("gives tier C, and no other tier, the vendor concerned as the least stake it can have", () => {
    expect(Object.entries(RUBRIC_V1_2.tiers).filter(([, tier]) => tier.stakeAtBest !== "none")).toEqual([["C", { base: 70, stakeAtBest: "vendor" }]]);
  });

  const refusals: ReadonlyArray<readonly [string, unknown]> = [
    ["a tier left out", changed((rules) => delete rules.tiers.U)],
    ["a tier the product does not have", changed((rules) => (rules.tiers.H = { base: 1, stakeAtBest: "none" }))],
    ["a base above 100", changed((rules) => (rules.tiers.A = { base: 101, stakeAtBest: "none" }))],
    ["a base that is not whole", changed((rules) => (rules.tiers.A = { base: 99.5, stakeAtBest: "none" }))],
    ["a factor above one", changed((rules) => (rules.adjustments.relevance.direct = 1.1))],
    ["a factor that is not a number of hundredths", changed((rules) => (rules.adjustments.independence.vendor = 0.805))],
    ["a relevance left out", changed((rules) => delete rules.adjustments.relevance.partial)],
    ["a stake left out", changed((rules) => delete rules.adjustments.independence.employer)],
    ["no window of recency", changed((rules) => (rules.adjustments.recency.windows = []))],
    ["windows out of order", changed((rules) => (rules.adjustments.recency.windows = [{ withinDays: 365, factor: 0.7 }, { withinDays: 90, factor: 1 }]))],
    ["a window of no days", changed((rules) => (rules.adjustments.recency.windows = [{ withinDays: 0, factor: 1 }]))],
    ["a class left out", changed((rules) => delete rules.thresholds.WORDING)],
    ["a floor above its acceptance", changed((rules) => (rules.thresholds.WORDING = { acceptAt: 40, floorAt: 41, onlyTier: null }))],
    ["a threshold with no word on a single tier", changed((rules) => (rules.thresholds.WORDING = { acceptAt: 40, floorAt: 5 }))],
    ["a key it does not know", changed((rules) => (rules.note = "v1.2"))],
  ];
  for (const [name, rules] of refusals) {
    it(`refuses ${name}`, () => {
      expect(RubricRulesSchema.safeParse(rules).success).toBe(false);
    });
  }
});

describe("RubricFactorSchema", () => {
  it("takes every multiplier of v1.2 and refuses a third decimal", () => {
    for (const factor of [0, 0.2, 0.3, 0.6, 0.7, 0.8, 1]) expect(RubricFactorSchema.safeParse(factor).success, String(factor)).toBe(true);
    for (const factor of [0.555, 0.801, -0.1, 1.01]) expect(RubricFactorSchema.safeParse(factor).success, String(factor)).toBe(false);
  });
});
