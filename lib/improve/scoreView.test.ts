import { describe, expect, it } from "vitest";

import type { EvidenceItemView, SuggestionScoring } from "@/lib/schemas/suggestions";

import { bandOf, computedRowsOf, gradingOrdinalsOf, predictionKeyOf } from "./scoreView";

const item = (id: string, ordinal: number, fields: Partial<EvidenceItemView>): EvidenceItemView =>
  ({ id, ordinal, kind: "LINK", state: "GRADED", url: null, doi: null, fileName: null, labRunId: null, title: null, host: null, publishedOn: null, ageDays: null, fetchStatus: "opened:200", tier: "C", baseScore: 70, relevance: 1, recency: 1, independence: 0.8, adjustedScore: 56, reason: null, gradedBy: "m", gradedAt: null, stage: null, ...fields }) as EvidenceItemView;
const prediction = (fields: Partial<SuggestionScoring["prediction"]>): SuggestionScoring["prediction"] => ({ route: "ADJUDICATE", decision: "REQUEST_MORE", namedTier: null, acceptAt: 70, floorAt: 25, shortBy: 4, ...fields });

describe("bandOf: where the score stands", () => {
  it("under the floor, between, at or past the acceptance; nowhere where no score decides", () => {
    const thresholds = { acceptAt: 70, floorAt: 25 };
    expect([24, 25, 69, 70, 100].map((score) => bandOf(score, thresholds))).toEqual(["under", "between", "between", "accepted", "accepted"]);
    expect(bandOf(66, { acceptAt: null, floorAt: null })).toBeNull();
  });
});

describe("computedRowsOf: how it is computed (30 § 3.3)", () => {
  it("names the strongest, what the corroboration added, every other item alone or grading, as the screen does", () => {
    const items = [item("a", 1, { tier: "C", adjustedScore: 56 }), item("b", 2, { tier: "D", adjustedScore: 42 }), item("c", 3, { state: "PENDING", tier: null, adjustedScore: null }), item("d", 4, { tier: "U", adjustedScore: 0 })];
    const scoring = { score: 66, strongestItemId: "a", corroboratedById: "b", gradedItems: 3, pendingItems: 1, prediction: prediction({}), wouldSuffice: [] } as SuggestionScoring;
    expect(computedRowsOf(scoring, items)).toEqual([
      { kind: "strongest", ordinal: 1, tier: "C", score: 56 },
      { kind: "corroboration", ordinal: 2, tier: "D", bonus: 10 },
      { kind: "alone", ordinal: 2, score: 42 },
      { kind: "grading", ordinal: 3 },
      { kind: "alone", ordinal: 4, score: 0 },
    ]);
  });

  it("has no corroboration row where none applies", () => {
    const items = [item("a", 1, { adjustedScore: 56 })];
    expect(computedRowsOf({ score: 56, strongestItemId: "a", corroboratedById: null, gradedItems: 1, pendingItems: 0, prediction: prediction({}), wouldSuffice: [] }, items)).toEqual([{ kind: "strongest", ordinal: 1, tier: "C", score: 56 }]);
  });
});

describe("predictionKeyOf and gradingOrdinalsOf", () => {
  it("takes the route first, then the decision on the adjudicator's", () => {
    expect(predictionKeyOf(prediction({ route: "CURATOR", decision: "CURATOR_REVIEW" }))).toBe("CURATOR");
    expect(predictionKeyOf(prediction({ route: "DECLINE_AT_INTAKE", decision: "DECLINE" }))).toBe("DECLINE");
    expect(predictionKeyOf(prediction({ route: "REQUEST_MORE_BY_RULE", namedTier: "A" }))).toBe("REQUEST_MORE_BY_RULE");
    expect(predictionKeyOf(prediction({ decision: "ACCEPT" }))).toBe("ACCEPT");
    expect(predictionKeyOf(prediction({}))).toBe("REQUEST_MORE");
  });

  it("lists the items still grading as the list prints their ordinals", () => {
    expect(gradingOrdinalsOf([item("a", 1, {}), item("b", 3, { state: "PENDING" }), item("c", 12, { state: "PENDING" })])).toEqual(["03", "12"]);
  });
});
