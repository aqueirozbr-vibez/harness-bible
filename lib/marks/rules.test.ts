import { describe, expect, it } from "vitest";

import { excerpt, NOTE_MAX, noteLength, normaliseNote, orderBookmarks, orderNotes } from "./rules";

describe("normaliseNote", () => {
  it("turns CRLF into LF, trims, and keeps at most two blank lines", () => {
    expect(normaliseNote("  a\r\nb  \r\n")).toBe("a\nb");
    expect(normaliseNote("a\n\n\n\n\n\nb")).toBe("a\n\n\nb");
    expect(normaliseNote("a\n\nb")).toBe("a\n\nb");
    expect(normaliseNote("   \n\t ")).toBe("");
  });
});

describe("noteLength", () => {
  it("counts code points of the normalised body", () => {
    expect(noteLength("abc")).toBe(3);
    expect(noteLength(" abc ")).toBe(3);
    expect(noteLength("a\r\nb")).toBe(3);
    expect(noteLength("é😀")).toBe(2);
    expect(noteLength("x".repeat(NOTE_MAX + 1))).toBe(NOTE_MAX + 1);
  });
});

describe("excerpt", () => {
  it("collapses whitespace and cuts at a word boundary with an ellipsis", () => {
    expect(excerpt("Check  key\nscope.")).toBe("Check key scope.");
    const long = "word ".repeat(40).trim();
    const short = excerpt(long);
    expect(short.length).toBeLessThanOrEqual(91);
    expect(short.endsWith("…")).toBe(true);
    expect(short.slice(0, -1).endsWith("word")).toBe(true);
    expect(excerpt("")).toBe("");
    expect(excerpt("x".repeat(120), 10)).toBe(`${"x".repeat(10)}…`);
  });
});

describe("orders", () => {
  const rows = [
    { chapterNumber: 21, sectionId: "21.3", updatedAt: new Date("2026-09-20T10:00:00Z") },
    { chapterNumber: 7, sectionId: "07.2", updatedAt: new Date("2026-09-22T10:00:00Z") },
    { chapterNumber: 21, sectionId: "21.1", updatedAt: new Date("2026-09-21T10:00:00Z") },
    { chapterNumber: 16, sectionId: "16.9", updatedAt: new Date("2026-09-21T10:00:00Z") },
  ];

  it("puts bookmarks in book order", () => {
    expect(orderBookmarks(rows).map((r) => r.sectionId)).toEqual(["07.2", "16.9", "21.1", "21.3"]);
  });

  it("puts notes newest first, ties in book order", () => {
    expect(orderNotes(rows).map((r) => r.sectionId)).toEqual(["07.2", "16.9", "21.1", "21.3"]);
    expect(orderNotes(rows.slice(0, 1))).toEqual(rows.slice(0, 1));
  });
});
