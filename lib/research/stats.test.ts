import { describe, expect, it } from "vitest";

import { researchStatsOf, usdText, type StatsRun } from "./stats";

/*
 * A person's research statistics (feature-specs/48 § 11.6; unit 73), pure: the runs and their ends by the word each
 * run's line reads, the cost summed and per run charged, the sources, the findings that passed, were used and were
 * accepted, and the flags, a rule's refusal's among them. The door's reads against the database are
 * tests/integration/research-stats.test.ts.
 */

const NOW = new Date("2026-10-12T15:00:00.000Z");
const RECENT = new Date("2026-10-12T14:30:00.000Z");

function run(extra: Partial<StatsRun> = {}): StatsRun {
  return { state: "DONE", skip: null, failure: null, createdAt: RECENT, textPurgedAt: null, workflow: true, searches: 0, pageReads: 0, pagesSeen: null, costUsd: null, flagged: false, findings: [], ...extra };
}

describe("a person's research statistics (48 § 11.6)", () => {
  it("counts every run with a workflow and its end by the word its line reads: under way, not started and not run are none of the four", () => {
    const stats = researchStatsOf(
      [
        run(),
        run({ textPurgedAt: RECENT }),
        run({ state: "REFUSED" }),
        run({ state: "FAILED", failure: "BUDGET" }),
        run({ state: "FAILED", failure: "ABANDONED" }),
        run({ state: "SKIPPED", skip: "TEXT_PURGED" }),
        /* under way for longer than the workflow's 90 minutes: stale, so stopped */
        run({ state: "READING", createdAt: new Date(NOW.getTime() - 2 * 3_600_000) }),
        run({ state: "FAILED", failure: "READER_FAILED" }),
        run({ state: "READING" }),
        run({ state: "SKIPPED", skip: "BUDGET" }),
        run({ state: "SKIPPED", skip: "UNAVAILABLE" }),
      ],
      new Set(),
      NOW,
    );
    expect(stats.runs).toBe(11);
    expect(stats.ends).toEqual({ done: 2, refused: 1, stopped: 4, failed: 1 });
  });

  it("sums the cost of the runs charged anything, and divides it by them alone", () => {
    const stats = researchStatsOf([run({ costUsd: "0.61" }), run({ costUsd: "0.0123" }), run({ state: "SKIPPED", skip: "UNAVAILABLE" })], new Set(), NOW);
    expect(stats.cost.total).toBeCloseTo(0.6223, 10);
    expect(stats.cost.perRun).toBeCloseTo(0.31115, 10);
    expect(researchStatsOf([run(), run()], new Set(), NOW).cost).toEqual({ total: null, perRun: null });
    expect(researchStatsOf([], new Set(), NOW)).toEqual({ runs: 0, ends: { done: 0, refused: 0, stopped: 0, failed: 0 }, cost: { total: null, perRun: null }, sources: { searches: 0, opened: 0, seen: null }, findings: { passed: 0, used: 0, accepted: 0 }, flagged: 0 });
  });

  it("refuses a cost out of range rather than sum it", () => {
    expect(() => researchStatsOf([run({ costUsd: "-1" })], new Set(), NOW)).toThrow(/at least 0/);
    expect(() => researchStatsOf([run({ costUsd: "not a number" })], new Set(), NOW)).toThrow(/RESEARCH_STATS_COST|finite/);
  });

  it("adds the searches and the pages opened of every run, and the pages seen of the runs whose list is held", () => {
    const stats = researchStatsOf([run({ searches: 3, pageReads: 4, pagesSeen: 23 }), run({ searches: 1, pageReads: 1, pagesSeen: null, textPurgedAt: RECENT }), run({ searches: 2, pageReads: 2, pagesSeen: 5 })], new Set(), NOW);
    expect(stats.sources).toEqual({ searches: 6, opened: 7, seen: 28 });
    expect(researchStatsOf([run({ searches: 1, pageReads: 2 })], new Set(), NOW).sources.seen).toBeNull();
  });

  it("counts the findings that passed, those drafted or sent, and of those the ones whose own suggestion merged — never a duplicate's", () => {
    const stats = researchStatsOf(
      [
        run({
          findings: [
            { outcome: "INVALID", suggestionId: null },
            { outcome: "VALID", suggestionId: null },
            { outcome: "DRAFTED", suggestionId: "S-21-0001" },
            { outcome: "PROPOSED", suggestionId: "S-21-0002" },
            { outcome: "SUBMITTED", suggestionId: "S-21-0003" },
            { outcome: "REFUTED", suggestionId: "S-21-0004" },
            /* it doubles a merged suggestion that is not the one it made */
            { outcome: "DUPLICATE", suggestionId: "S-21-0002" },
          ],
        }),
        run({ findings: [{ outcome: "DRAFTED", suggestionId: "S-21-0005" }] }),
      ],
      new Set(["S-21-0001", "S-21-0002"]),
      NOW,
    );
    expect(stats.findings).toEqual({ passed: 7, used: 6, accepted: 2 });
  });

  it("counts the runs with a flag", () => {
    expect(researchStatsOf([run({ flagged: true }), run({ state: "REFUSED", flagged: true }), run()], new Set(), NOW).flagged).toBe(2);
  });

  it("counts a rule's refusal toward the flags alone: it reached nothing, and its flag is a flag (review of unit 73)", () => {
    const rule = run({ state: "REFUSED", workflow: false, flagged: true, searches: 1, pageReads: 1, pagesSeen: 1, costUsd: "0.5", findings: [{ outcome: "VALID", suggestionId: null }] });
    expect(researchStatsOf([rule, run({ flagged: true })], new Set(), NOW)).toEqual({
      runs: 1,
      ends: { done: 1, refused: 0, stopped: 0, failed: 0 },
      cost: { total: null, perRun: null },
      sources: { searches: 0, opened: 0, seen: null },
      findings: { passed: 0, used: 0, accepted: 0 },
      flagged: 2,
    });
    expect(researchStatsOf([run({ state: "REFUSED", workflow: false })], new Set(), NOW)).toMatchObject({ runs: 0, flagged: 0 });
  });
});

describe("an amount in US dollars as the page prints it", () => {
  it("keeps at most four decimals and no trailing zero", () => {
    expect(usdText(0.61)).toBe("0.61");
    expect(usdText(1.83691234)).toBe("1.8369");
    expect(usdText(0.1 + 0.2)).toBe("0.3");
    expect(usdText(0.00001)).toBe("0");
    expect(usdText(12)).toBe("12");
  });
});
