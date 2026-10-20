import { describe, expect, it } from "vitest";

import { QUEUE_GROUPS } from "@/lib/schemas/curation";

import { deadlineOf, groupOf, GROUP_DEADLINE_HOURS, marksOf, spanOf, strongestTierOf } from "./queue";

describe("spanOf: an age or the time left as the screen prints it", () => {
  it("whole hours under a day, whole days from one, past when negative", () => {
    expect(spanOf(6 * 3_600_000)).toEqual({ past: false, unit: "h", n: 6 });
    expect(spanOf(23.9 * 3_600_000)).toEqual({ past: false, unit: "h", n: 23 });
    expect(spanOf(49 * 3_600_000)).toEqual({ past: false, unit: "d", n: 2 });
    expect(spanOf(-2.5 * 3_600_000)).toEqual({ past: true, unit: "h", n: 2 });
  });
});

describe("groupOf: 36 § 3.1's groups", () => {
  it("files a curator-always change by its reason, and anything else a curator inspects under inspection", () => {
    const always = (curatorReason: Parameters<typeof groupOf>[0]["curatorReason"]) => groupOf({ changeClass: "CURATOR_ALWAYS", curatorReason, outcome: "CURATOR_REVIEW", origin: "HUMAN" });
    expect([always("SAFETY_OT"), always("SCENARIO_PARAMETER"), always("STRUCTURE"), always("NEW_SOURCE_TIER")]).toEqual(["safety", "scenario", "structure", "newTier"]);
    expect(groupOf({ changeClass: "CITED_FIGURE", curatorReason: null, outcome: "REQUEST_MORE", origin: "HUMAN" })).toBe("inspection");
    /* An adjudicator's failure: CURATOR_REVIEW on a class the adjudicator decides. */
    expect(groupOf({ changeClass: "WORDING", curatorReason: null, outcome: "CURATOR_REVIEW", origin: "HUMAN" })).toBe("inspection");
  });

  it("files a researcher's proposal under Researcher proposals — the adjudicator's recommendation or its failure — and a curator-always one by its reason (43 § 7.1)", () => {
    expect(groupOf({ changeClass: "NEW_CLAIM", curatorReason: null, outcome: "ACCEPT", origin: "RESEARCHER" })).toBe("researcher");
    expect(groupOf({ changeClass: "WORDING", curatorReason: null, outcome: "CURATOR_REVIEW", origin: "RESEARCHER" })).toBe("researcher");
    expect(groupOf({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT", outcome: "CURATOR_REVIEW", origin: "RESEARCHER" })).toBe("safety");
    expect(deadlineOf("researcher", new Date("2026-10-08T12:00:00.000Z"))?.toISOString()).toBe("2026-10-15T12:00:00.000Z");
  });

  it("has no group for a rubric change, which this build does not route (30 § 8)", () => {
    expect(groupOf({ changeClass: "CURATOR_ALWAYS", curatorReason: "RUBRIC", outcome: "CURATOR_REVIEW", origin: "HUMAN" })).toBeNull();
  });
});

describe("deadlineOf and marksOf: 36 § 3.3 at a fixed clock", () => {
  const queued = new Date("2026-10-08T12:00:00.000Z");

  it("gives each group its deadline from the moment the item entered the queue (A15)", () => {
    /* the monthly sample is due by the month's end, not in hours (36 § 3.1; unit 53e) */
    /* ready to merge and merging take inspection's seven days (36 D3; unit 54b), and so do researcher proposals (43 § 7.1; unit 60d) */
    expect(QUEUE_GROUPS.map((group) => deadlineOf(group, queued)?.toISOString() ?? null)).toEqual(["2026-10-09T12:00:00.000Z", "2026-10-13T12:00:00.000Z", "2026-10-13T12:00:00.000Z", "2026-10-14T12:00:00.000Z", "2026-10-15T12:00:00.000Z", "2026-10-15T12:00:00.000Z", "2026-10-15T12:00:00.000Z", "2026-10-15T12:00:00.000Z", null]);
    expect([GROUP_DEADLINE_HOURS.safety, GROUP_DEADLINE_HOURS.sampled]).toEqual([24, null]);
    expect(deadlineOf("safety", null)).toBeNull();
  });

  it("counts overdue, due in under a day, and in its time; an item with no deadline in none", () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const deadlines = [deadlineOf("safety", queued), deadlineOf("structure", queued), deadlineOf("inspection", queued), new Date("2026-10-11T11:00:00.000Z"), null];
    expect(marksOf(deadlines, now)).toEqual({ overdue: 1, dueSoon: 1, inSla: 2 });
  });
});

describe("strongestTierOf: the item an entry names (36 § 3.2)", () => {
  it("takes the highest adjusted score, the better tier on a tie, and nothing ungraded", () => {
    expect(strongestTierOf([{ tier: "D", adjustedScore: 42 }, { tier: "C", adjustedScore: 56 }])).toBe("C");
    expect(strongestTierOf([{ tier: "D", adjustedScore: 60 }, { tier: "B", adjustedScore: 60 }])).toBe("B");
    expect(strongestTierOf([{ tier: null, adjustedScore: null }])).toBeNull();
    expect(strongestTierOf([])).toBeNull();
  });
});
