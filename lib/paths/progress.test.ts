import { describe, expect, it } from "vitest";

import { definitionOf, PATH_DEFINITIONS, stopsOf } from "./definitions";
import { activeRow, applyRead, doneCount, firstSection, latestRow, minutesFor, stopContaining, stopState, type ChapterSections, type ProgressRow } from "./progress";

const nine = (n: number): ReadonlyArray<string> => Array.from({ length: 9 }, (_, i) => `${String(n).padStart(2, "0")}.${i + 1}`);
const chapters: ChapterSections = new Map([
  [0, ["00.1", "00.9"]],
  ...[16, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 29, 31, 34, 36, 37, 38, 39, 40].map((n): [number, ReadonlyArray<string>] => [n, nine(n)]),
]);
const builder = definitionOf("builder");
const executive = definitionOf("executive");
const row = (over: Partial<ProgressRow>): ProgressRow => ({ path: "builder", pathVersion: "v1.2", lastSectionId: "16.1", completedStops: [], updatedAt: new Date(Date.UTC(2026, 8, 22)), ...over });

describe("minutes", () => {
  it("rounds up at 230 words per minute and never says zero", () => {
    expect(minutesFor(7114)).toBe(31);
    expect(minutesFor(230)).toBe(1);
    expect(minutesFor(0)).toBe(1);
  });
});

describe("stop states", () => {
  const ch16 = stopsOf(builder)[0];
  const ch17 = stopsOf(builder)[1];

  it("is unread without a row, in progress at the last section, read when completed", () => {
    expect(stopState(ch16, chapters, null)).toEqual({ state: "unread", at: null });
    expect(stopState(ch16, chapters, row({ lastSectionId: "16.3" }))).toEqual({ state: "in_progress", at: "16.3" });
    expect(stopState(ch17, chapters, row({ lastSectionId: "16.3" }))).toEqual({ state: "unread", at: null });
    expect(stopState(ch16, chapters, row({ lastSectionId: "17.1", completedStops: ["ch16"] }))).toEqual({ state: "read", at: null });
  });

  it("marks a chapter stop read at its layer 9 and keeps the count to stops the definition has", () => {
    const start = row({ lastSectionId: "16.1" });
    const mid = applyRead(builder, start, "16.4", chapters);
    expect(mid).toEqual({ lastSectionId: "16.4", completedStops: [], completed: 0 });
    const end = applyRead(builder, { ...start, ...mid }, "16.9", chapters);
    expect(end).toEqual({ lastSectionId: "16.9", completedStops: ["ch16"], completed: 1 });
    expect(doneCount(builder, row({ completedStops: ["ch16", "ch99", "ch22"] }))).toBe(2);
  });

  it("reads a sections stop only when every listed section was read", () => {
    const start: ProgressRow = { path: "executive", pathVersion: "v1.1", lastSectionId: "00.1", completedStops: [], updatedAt: new Date() };
    const one = applyRead(executive, start, "21.8", chapters);
    expect(one.completedStops).toEqual(["decision-aids-8/21.8"]);
    expect(one.completed).toBe(0);
    const stop = stopsOf(executive)[7];
    expect(stopState(stop, chapters, { ...start, ...one, lastSectionId: "34.2" })).toEqual({ state: "in_progress", at: null });
    let current = { ...start, ...one };
    for (const s of ["23.8", "28.8", "31.8"]) current = { ...current, ...applyRead(executive, current, s, chapters) };
    expect(current.completedStops).toContain("decision-aids-8");
    expect(doneCount(executive, current)).toBe(1);
  });

  it("ignores a section outside the path and reports the containing stop", () => {
    expect(stopContaining(builder, "03.2", chapters)).toBeNull();
    expect(stopContaining(executive, "28.8", chapters)?.kind).toBe("sections");
    const out = applyRead(builder, row({ lastSectionId: "16.2" }), "03.2", chapters);
    expect(out.lastSectionId).toBe("03.2");
    expect(out.completed).toBe(0);
  });
});

describe("active and latest rows", () => {
  const older = row({ path: "foundations", pathVersion: "v1.0", lastSectionId: "01.2", updatedAt: new Date(Date.UTC(2026, 8, 20)) });
  const newer = row({ path: "builder", lastSectionId: "21.3", updatedAt: new Date(Date.UTC(2026, 8, 22)) });

  it("picks the most recently updated started path that contains the section", () => {
    expect(activeRow(PATH_DEFINITIONS, [older, newer], "21.3", chapters)?.path).toBe("builder");
    expect(activeRow(PATH_DEFINITIONS, [older, newer], "28.8", chapters)?.path).toBe("builder");
    expect(activeRow(PATH_DEFINITIONS, [older, newer], "03.1", chapters)).toBeNull();
    expect(latestRow([older, newer])?.path).toBe("builder");
    expect(latestRow([])).toBeNull();
  });

  it("starts a path at its first section", () => {
    expect(firstSection(builder, chapters)).toBe("16.1");
    expect(firstSection(executive, chapters)).toBe("00.1");
  });
});
