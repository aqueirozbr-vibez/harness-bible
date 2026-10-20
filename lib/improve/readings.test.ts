import { describe, expect, it } from "vitest";

import { buildChapter, type BookFiles } from "@/pipeline/build";
import { CH21_FILE, CH21_LAB_DIR, fixture } from "@/pipeline/parse/fixtures";
import { parseLab } from "@/pipeline/parse/lab";

import { chipChapters, readingsOf, referenceReadings, rowReadings, sharedFigureReadings, type ReleaseFigure } from "./readings";

/* The cross-chapter sensor's three rules (feature-specs/33 § 4.2, § 15), on chapter 21 and on rows made to the shape of the release's. */

const book: BookFiles = {
  chapters: [{ fileName: CH21_FILE, text: fixture(CH21_FILE), part: "part2" }],
  registry: new Map([[21, { verify: fixture("ch21-verify.md"), redteam: fixture("ch21-redteam.md") }]]),
  labs: new Map([[21, parseLab(CH21_LAB_DIR)]]),
  carries: new Map([[21, "LAB"]]),
  chapterMap: true,
  allFiles: [],
};
const ch21 = buildChapter(book.chapters[0], book, { locale: "en", previous: new Map() });
const figures: ReadonlyArray<ReleaseFigure> = ch21.sections.flatMap((s) => {
  const names = chipChapters(s.htmlEn);
  return s.figures.map((f) => ({ id: f.id, chapter: 21, section: s.id, part: ch21.part, valueText: f.valueText, tier: f.tier, sourceRow: f.sourceRowId, names: names.get(f.id) ?? [] }));
});

function figure(id: string, chapter: number, valueText: string, names: ReadonlyArray<number>, tier: ReleaseFigure["tier"] = "ILLUSTRATIVE"): ReleaseFigure {
  return { id, chapter, section: `${String(chapter)}.2`, part: chapter >= 30 ? "P3" : "P2", valueText, tier, sourceRow: null, names };
}

describe("chipChapters", () => {
  it("reads the chapters a figure's own chip names, the parenthetical that gave it its tier", () => {
    /* 21.1: "at 17:42 and asks for the supervisor's approval (scenario, ch16)" */
    expect(figures.filter((f) => f.section === "21.1").map((f) => [f.id, f.names])).toEqual([["F-21-01", [16]], ["F-21-02", [16]], ["F-21-03", []], ["F-21-04", []]]);
  });
});

describe("the three rules", () => {
  it("rule 1: a row is read by the sections of the figures bound to it, once each", () => {
    expect(rowReadings("21.9 r9", figures)).toEqual([{ anchor: "F-21-01", section: "21.1", part: "P2", rule: "row", settable: true }]);
    expect(rowReadings("21.9 r1", figures)).toEqual([]);
  });

  it("rule 2: the same figure in another chapter, when one names the other's chapter, both print the value and the chapter named prints it once", () => {
    const here = figure("F-10-35", 10, "8×", [37]);
    const there = figure("F-37-05", 37, "8×", []);
    expect(sharedFigureReadings(here, [here, there, figure("F-37-20", 37, "9×", [10])])).toEqual([{ anchor: "F-37-05", section: "37.2", part: "P3", rule: "figure", settable: true }]);
    /* the other way round: F-37-05 names no chapter, but F-10-35 names 37 */
    expect(sharedFigureReadings(there, [here, there]).map((r) => r.anchor)).toEqual(["F-10-35"]);
    /* a derived reading cannot be set to a value */
    const derived = figure("F-37-05", 37, "8×", [], "DERIVED");
    expect(sharedFigureReadings(here, [here, derived])).toEqual([{ anchor: "F-37-05", section: "37.2", part: "P3", rule: "figure", settable: false }]);
    /* chapter 37 printing 8× twice: which is meant cannot be read, and neither is counted */
    expect(sharedFigureReadings(here, [here, there, figure("F-37-09", 37, "8×", [])])).toEqual([]);
    /* the same value with no chapter named is chance */
    expect(sharedFigureReadings(figure("F-15-23", 15, "2%", []), [figure("F-23-20", 23, "2%", [])])).toEqual([]);
  });

  it("rule 3: the other sections that refer to a section or a row, once each, not the anchor's own", () => {
    const references = [{ from: "23.4", part: "P2" as const, target: "21.3" }, { from: "23.4", part: "P2" as const, target: "21.3" }, { from: "21.3", part: "P2" as const, target: "21.3" }, { from: "37.2", part: "P3" as const, target: "21.5" }];
    expect(referenceReadings("21.3", "21.3", references)).toEqual([{ anchor: "23.4", section: "23.4", part: "P2", rule: "reference", settable: true }]);
  });

  it("readingsOf: a row by its figures and references, a section by its references, a figure by its other chapter", () => {
    expect(readingsOf({ kind: "SOURCE_ROW", id: "21.9 r9" }, figures, []).map((r) => r.section)).toEqual(["21.1"]);
    expect(readingsOf({ kind: "SECTION", id: "21.3" }, figures, [{ from: "22.4", part: "P2", target: "21.3" }]).map((r) => r.section)).toEqual(["22.4"]);
    expect(readingsOf({ kind: "FIGURE", id: "F-21-15" }, figures, [])).toEqual([]);
    expect(readingsOf({ kind: "FIGURE", id: "F-21-99" }, figures, [])).toEqual([]);
  });
});
