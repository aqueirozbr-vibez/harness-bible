import { describe, expect, it } from "vitest";

import { median, quarterStart, rosterPanelOf, type RosterInput } from "./roster";

/* The curator roster panel (feature-specs/38 § 4, § 8.5): the screen's four parts, built from a fixture. */

const NOW = new Date("2026-10-10T12:00:00Z");

const FIXTURE: RosterInput = {
  chapters: [
    { number: 0, part: "P0" },
    ...Array.from({ length: 15 }, (_, i) => ({ number: i + 1, part: "P1" as const })),
    ...Array.from({ length: 18 }, (_, i) => ({ number: i + 16, part: "P2" as const })),
    ...Array.from({ length: 7 }, (_, i) => ({ number: i + 34, part: "P3" as const })),
  ],
  roster: [
    { part: "P0", userId: "u-lindqvist" },
    { part: "P0", userId: "u-queiroz" },
    { part: "P1", userId: "u-okafor" },
    { part: "P2", userId: "u-iyer" },
    { part: "P2", userId: "u-gone" },
    { part: "P2", userId: "u-iyer-twice" },
    { part: "P4", userId: "u-okafor" },
  ],
  people: new Map([
    ["u-lindqvist", { displayName: "R. Lindqvist", deleted: false }],
    ["u-queiroz", { displayName: "A. Queiroz", deleted: false }],
    ["u-okafor", { displayName: "H. Okafor", deleted: false }],
    ["u-iyer", { displayName: "S. Iyer", deleted: false }],
    ["u-iyer-twice", { displayName: "S. Iyer", deleted: false }],
    ["u-gone", { displayName: "Gone Person", deleted: true }],
  ]),
  queue: [
    { part: "P0", count: 2 },
    { part: "P1", count: 9 },
    { part: "P2", count: 17 },
    { part: "P3", count: 0 },
    { part: "P4", count: 3 },
  ],
  decisions: [
    { parts: ["P0"], waitMs: 1.4 * 86_400_000 },
    { parts: ["P1"], waitMs: 1 * 86_400_000 },
    { parts: ["P1"], waitMs: 3 * 86_400_000 },
    { parts: ["P1", "P2"], waitMs: 2.1 * 86_400_000 },
    { parts: ["P2"], waitMs: 0.5 * 86_400_000 },
    { parts: ["P2"], waitMs: 9 * 86_400_000 },
    { parts: ["P4"], waitMs: 5 * 86_400_000 },
  ],
};

describe("median", () => {
  it("is the middle value, the mean of the two middle values, or null of nothing", () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("rosterPanelOf", () => {
  const panel = rosterPanelOf(FIXTURE, NOW);

  it("has one row per part with chapters in the release, in the book's order, with each part's chapter span", () => {
    expect(panel.rows.map((row) => row.part)).toEqual(["P0", "P1", "P2", "P3"]);
    expect(panel.rows.map((row) => row.chapters)).toEqual([
      { first: 0, last: 0 },
      { first: 1, last: 15 },
      { first: 16, last: 33 },
      { first: 34, last: 40 },
    ]);
  });

  it("names the curators by display name in roster order, once each, and never a deleted account", () => {
    expect(panel.rows.map((row) => row.curators)).toEqual([["R. Lindqvist", "A. Queiroz"], ["H. Okafor"], ["S. Iyer"], []]);
  });

  it("reads the queue's count by part and the quarter's median wait, null where the part had no decision", () => {
    expect(panel.rows.map((row) => row.queue)).toEqual([2, 9, 17, 0]);
    /* A decision of a suggestion in two parts counts in both parts' medians. */
    expect(panel.rows.map((row) => (row.medianWaitMs === null ? null : row.medianWaitMs / 86_400_000))).toEqual([1.4, 2.1, 2.1, null]);
  });

  it("counts the median from a quarter of 91 days before now", () => {
    expect(panel.since).toBe("2026-07-11T12:00:00.000Z");
    expect(quarterStart(NOW).toISOString()).toBe(panel.since);
  });

  it("is empty for a release with no chapters", () => {
    expect(rosterPanelOf({ ...FIXTURE, chapters: [] }, NOW).rows).toEqual([]);
  });
});
