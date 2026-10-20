import { describe, expect, it } from "vitest";

import {
  chapterOfSection,
  layerOfSection,
  chapterStartHref,
  padChapter,
  parseChapterNumber,
  parseFigureId,
  parseReleaseId,
  parseSectionId,
  parseSourceRowId,
  parseSuggestionId,
  suggestionIdOf,
} from "./ids";

describe("branded ids", () => {
  it("accepts the book's own ids", () => {
    expect(parseSectionId("21.3")).toBe("21.3");
    expect(parseSectionId("02.1")).toBe("02.1");
    expect(parseFigureId("F-21-03")).toBe("F-21-03");
    expect(parseSourceRowId("21.9 r4")).toBe("21.9 r4");
    expect(parseSuggestionId("S-15-0377")).toBe("S-15-0377");
    expect(parseReleaseId("2026.09")).toBe("2026.09");
    /* a month's second release and on (37 D1) */
    expect(parseReleaseId("2026.10.2")).toBe("2026.10.2");
    expect(parseReleaseId("2026.10.12")).toBe("2026.10.12");
    expect(parseChapterNumber(0)).toBe(0);
    expect(parseChapterNumber(40)).toBe(40);
  });

  it("rejects malformed ids", () => {
    expect(() => parseSectionId("21.0")).toThrow();
    expect(() => parseSectionId("2.3")).toThrow();
    expect(() => parseSectionId("21.10")).toThrow();
    expect(() => parseFigureId("F-21-3")).toThrow();
    expect(() => parseSourceRowId("21.3 r4")).toThrow();
    expect(() => parseSuggestionId("S-15-377")).toThrow();
    expect(() => parseReleaseId("2026.13")).toThrow();
    expect(() => parseReleaseId("2026-09")).toThrow();
    for (const id of ["2026.10.1", "2026.10.0", "2026.10.02", "2026.10.", "2026.10.2.1"]) expect(() => parseReleaseId(id), id).toThrow();
    expect(() => parseChapterNumber(41)).toThrow();
    expect(() => parseChapterNumber(-1)).toThrow();
    expect(() => parseChapterNumber(2.5)).toThrow();
  });

  /* feature-specs/29 § 4.2: a serial per chapter, four digits until a chapter passes 9,999, and nothing parses the width. */
  it("takes a suggestion id with a serial of four digits or more, and writes one from a chapter and a serial", () => {
    expect(parseSuggestionId("S-15-10000")).toBe("S-15-10000");
    expect(parseSuggestionId("S-00-0001")).toBe("S-00-0001");
    for (const id of ["S-15-377", "s-15-0377", "S-5-0377", "S-15-0377 ", "15-0377", "S-15-03x7", "S-150-0377", ""]) expect(() => parseSuggestionId(id), id).toThrow();
    expect(suggestionIdOf(15, 377)).toBe("S-15-0377");
    expect(suggestionIdOf(0, 1)).toBe("S-00-0001");
    expect(suggestionIdOf(40, 9999)).toBe("S-40-9999");
    expect(suggestionIdOf(15, 10000)).toBe("S-15-10000");
    for (const [chapter, serial] of [[15, 0], [15, -1], [15, 1.5], [-1, 1], [100, 1], [1.5, 1], [Number.NaN, 1]] as const) {
      expect(() => suggestionIdOf(chapter, serial), `${String(chapter)}, ${String(serial)}`).toThrow(RangeError);
    }
  });

  it("derives chapter, layer and padded form", () => {
    const id = parseSectionId("21.3");
    expect(chapterOfSection(id)).toBe(21);
    expect(layerOfSection(id)).toBe(3);
    expect(padChapter(parseChapterNumber(0))).toBe("00");
    expect(padChapter(parseChapterNumber(21))).toBe("21");
    expect(chapterStartHref("en", parseChapterNumber(21))).toBe("/en/ch/21/21.1");
    expect(chapterStartHref("pt", parseChapterNumber(0))).toBe("/pt/ch/00/00.1");
  });
});
