import { describe, expect, it } from "vitest";

import type { SuggestionForService } from "@/lib/db/improve";
import { RUBRIC_V1_2 } from "@/tests/fixtures/rubric";

import { gradedItemsOf, rescoredOf } from "./scoring";

type EvidenceRow = SuggestionForService["evidence"][number];

function rowOf(id: string, fields: Partial<Record<keyof EvidenceRow, unknown>>): EvidenceRow {
  return { id, ordinal: 1, kind: "LINK", state: "GRADED", url: null, doi: null, storageKey: null, fileName: null, labRunId: null, title: null, host: null, publishedOn: null, ageDays: null, fetchStatus: "opened:200", contentSha256: null, textKey: null, tier: "C", baseScore: 70, relevance: 1, recency: 1, independence: 0.8, adjustedScore: 56, reason: "r", gradedBy: "m", gradedAt: null, ...fields } as unknown as EvidenceRow;
}

describe("gradedItemsOf", () => {
  it("keeps the graded rows in order and maps each as the score reads it: the factors as numbers, opened from the fetch status, the publisher from the host", () => {
    const rows = [
      rowOf("a", { host: "www.provider-two.co.uk", relevance: "0.5" }),
      rowOf("b", { state: "PENDING", tier: null, adjustedScore: null }),
      rowOf("c", { kind: "UPLOAD", host: null, fetchStatus: "opened:200", relevance: null, recency: null, independence: null }),
      rowOf("d", { tier: "U", fetchStatus: "unreachable:403", relevance: null, recency: null, independence: null, adjustedScore: 0 }),
    ];
    const { graded, items } = gradedItemsOf(rows);
    expect(graded.map((row) => row.id)).toEqual(["a", "c", "d"]);
    expect(items).toEqual([
      { id: "a", tier: "C", opened: true, relevance: 0.5, recency: 1, independence: 0.8, publisher: "provider-two.co.uk" },
      { id: "c", tier: "C", opened: true, relevance: null, recency: null, independence: null, publisher: null },
      { id: "d", tier: "U", opened: false, relevance: null, recency: null, independence: null, publisher: null },
    ]);
  });

  it("leaves out a row graded without a tier or an adjusted score, and answers nothing for no rows", () => {
    expect(gradedItemsOf([rowOf("a", { tier: null }), rowOf("b", { adjustedScore: null })]).graded).toEqual([]);
    expect(gradedItemsOf([])).toEqual({ graded: [], items: [] });
  });
});

describe("rescoredOf: the graded items a changed fast-moving declaration scores again (30 § 3.4)", () => {
  /* Graded while the claim was stable: recency 1.0 whatever the age. */
  const stable = [
    rowOf("old", { tier: "B", baseScore: 85, relevance: 1, recency: 1, independence: 1, adjustedScore: 85, ageDays: 1100 }),
    rowOf("year", { tier: "C", baseScore: 70, relevance: "1.00", recency: "1.00", independence: "0.80", adjustedScore: 56, ageDays: 200 }),
    rowOf("fresh", { tier: "D", baseScore: 60, relevance: 0.6, recency: 1, independence: 1, adjustedScore: 36, ageDays: 12 }),
    rowOf("undated", { tier: "D", baseScore: 60, relevance: 1, recency: 1, independence: 1, adjustedScore: 60, ageDays: null }),
    rowOf("unopened", { tier: "U", fetchStatus: "unreachable:403", relevance: null, recency: null, independence: null, baseScore: 0, adjustedScore: 0 }),
    rowOf("grading", { state: "PENDING", tier: null, relevance: null, recency: null, independence: null, adjustedScore: null }),
  ];

  it("ticked: each graded item takes its window's factor, or the older one for no date, and its score again; one inside the first window is left as it is", () => {
    expect(rescoredOf(stable, RUBRIC_V1_2, true)).toEqual([
      { itemId: "old", recency: 0.3, adjustedScore: 25 },
      { itemId: "year", recency: 0.7, adjustedScore: 39 },
      { itemId: "undated", recency: 0.3, adjustedScore: 18 },
    ]);
  });

  it("unticked: the items scored as fast-moving go back to the stable factor; nothing changes where the declaration agrees", () => {
    const fast = [rowOf("old", { tier: "B", relevance: 1, recency: 0.3, independence: 1, adjustedScore: 25, ageDays: 1100 }), rowOf("fresh", { tier: "D", relevance: 1, recency: 1, independence: 1, adjustedScore: 60, ageDays: 12 })];
    expect(rescoredOf(fast, RUBRIC_V1_2, false)).toEqual([{ itemId: "old", recency: 1, adjustedScore: 85 }]);
    expect(rescoredOf(fast, RUBRIC_V1_2, true)).toEqual([]);
    expect(rescoredOf(stable, RUBRIC_V1_2, false)).toEqual([]);
    expect(rescoredOf([], RUBRIC_V1_2, true)).toEqual([]);
  });
});
