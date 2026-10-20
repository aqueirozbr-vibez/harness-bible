import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { env } from "@/lib/env";

import { buildChapter, loadBook, type BookFiles, type BuiltChapter } from "./build";
import { CH21_FILE, CH21_LAB_DIR, fixture } from "./parse/fixtures";
import { parseLab } from "./parse/lab";

/*
 * The build's positions (feature-specs/33 § 4.1): where each section, source row and figure sits in its file. Each
 * position is proved by an edit at it: the rebuilt chapter reads the edit in that row — the figure's new value, the
 * row's claim, the section's text — and no other figure's id or value, row's claim or section's text changes. (A
 * neighbouring figure's label, the words around a number, may change with it.)
 */

function ch21Book(): BookFiles {
  return {
    chapters: [{ fileName: CH21_FILE, text: fixture(CH21_FILE), part: "part2" }],
    registry: new Map([[21, { verify: fixture("ch21-verify.md"), redteam: fixture("ch21-redteam.md") }]]),
    labs: new Map([[21, parseLab(CH21_LAB_DIR)]]),
    carries: new Map([[21, "LAB"]]),
    chapterMap: true,
    allFiles: [],
  };
}

function build(file: BookFiles["chapters"][number], book: BookFiles, positions: boolean): BuiltChapter {
  return buildChapter(file, book, { locale: "en", previous: new Map(), positions });
}
function figuresOf(chapter: BuiltChapter): BuiltChapter["sections"][number]["figures"] {
  return chapter.sections.flatMap((s) => s.figures);
}
/**
 * 1→2 … 9→1 with zeros kept, so a value keeps the shape the figure grammar reads (11.0 is a figure, 22.1 a section
 * reference); a value of zeros alone gets a 7 for its first, so every value is really changed.
 */
function rotate(value: string): string {
  const rotated = value.replace(/[1-9]/g, (d) => String((Number(d) % 9) + 1));
  return rotated === value ? value.replace("0", "7") : rotated;
}

/** Every span of a chapter checked against its file; the figures not located, with why. */
function census(file: BookFiles["chapters"][number], chapter: BuiltChapter): { readonly problems: string[]; readonly unlocated: string[] } {
  const problems: string[] = [];
  const unlocated: string[] = [];
  const positions = chapter.positions;
  if (positions === null) return { problems: [`${file.fileName}: no positions`], unlocated };
  chapter.sections.forEach((section, i) => {
    const { id, body } = positions.sections[i];
    if (id !== section.id) problems.push(`${section.id}: positioned as ${id}`);
    if (body === null ? section.markdownEn !== "" : file.text.slice(body.from, body.to) !== section.markdownEn) problems.push(`${section.id}: the body is not the section's markdown`);
  });
  if (positions.sourceRows.length !== chapter.sourceRows.length) problems.push(`${file.fileName}: ${String(positions.sourceRows.length)} rows positioned of ${String(chapter.sourceRows.length)}`);
  chapter.sourceRows.forEach((row, i) => {
    const cells = positions.sourceRows[i]?.cells.map((c) => file.text.slice(c.from, c.to)) ?? [];
    if (cells[0] !== String(row.ordinal) || cells[3] !== row.tierText || cells[4] !== row.verifiedText) problems.push(`r${String(row.ordinal)}: cells ${JSON.stringify(cells)}`);
  });
  const figures = figuresOf(chapter);
  if (positions.figures.length !== figures.length) problems.push(`${file.fileName}: ${String(positions.figures.length)} figures positioned of ${String(figures.length)}`);
  figures.forEach((figure, i) => {
    const { id, at, unlocated: why } = positions.figures[i] ?? { id: "?", at: null, unlocated: "missing" };
    if (id !== figure.id) problems.push(`${figure.id}: positioned as ${id}`);
    else if (at === null) unlocated.push(`${id} ${figure.valueText}: ${String(why)}`);
    else if (file.text.slice(at.from, at.to) !== figure.valueText) problems.push(`${id}: the span holds ${JSON.stringify(file.text.slice(at.from, at.to))}`);
  });
  return { problems, unlocated };
}

describe("positions, chapter 21", () => {
  const book = ch21Book();
  const file = book.chapters[0];
  const chapter = build(file, book, true);

  it("are only made when asked for, and change no row: the content hash is the same", () => {
    const plain = build(file, book, false);
    expect(plain.positions).toBeNull();
    expect(chapter.contentHash).toBe(plain.contentHash);
    expect(chapter.sections).toEqual(plain.sections);
  });

  it("place every section, row and figure where the file holds it", () => {
    expect(census(file, chapter)).toEqual({ problems: [], unlocated: [] });
    expect(chapter.positions?.figures).toHaveLength(24);
    expect(chapter.positions?.sourceRows.map((r) => r.id)).toEqual(chapter.sourceRows.map((r) => `21.9 r${String(r.ordinal)}`));
  });

  it("are each proved by an edit: a figure's value changed at its span is that figure's, and no other figure's id or value changes", () => {
    const figures = figuresOf(chapter);
    chapter.positions?.figures.forEach(({ id, at }, i) => {
      if (at === null) throw new Error(`${id} is not located`);
      const edited = build({ ...file, text: file.text.slice(0, at.from) + rotate(figures[i].valueText) + file.text.slice(at.to) }, book, false);
      expect(figuresOf(edited).map((f) => `${f.id} ${f.valueText}`), id).toEqual(figures.map((f, k) => `${f.id} ${k === i ? rotate(f.valueText) : f.valueText}`));
    });
  });

  it("are each proved by an edit: a word added to a row's claim cell, or to a section's end, is that row's, and no other row's claim or section's text changes", () => {
    chapter.positions?.sourceRows.forEach(({ id, cells }, i) => {
      const edited = build({ ...file, text: file.text.slice(0, cells[1].to) + " zq" + file.text.slice(cells[1].to) }, book, false);
      expect(edited.sourceRows.map((r) => r.claim), id).toEqual(chapter.sourceRows.map((r, k) => (k === i ? `${r.claim} zq` : r.claim)));
    });
    chapter.positions?.sections.forEach(({ id, body }, i) => {
      if (body === null) throw new Error(`${id} has no body`);
      const edited = build({ ...file, text: file.text.slice(0, body.to) + " zq" + file.text.slice(body.to) }, book, false);
      expect(edited.sections.map((s) => s.markdownEn), id).toEqual(chapter.sections.map((s, k) => (k === i ? `${s.markdownEn} zq` : s.markdownEn)));
    });
  });
});

/* The census of feature-specs/33 § 4.1 over the book itself, when it is checked out: every figure located, or listed. */
const bookDir = resolve(env.BOOK_DIR);
describe.skipIf(!existsSync(join(bookDir, "book")))("positions, the whole book", () => {
  it("change no chapter's rows and place every section, row and figure; none is left unlocated", () => {
    const book = loadBook(bookDir);
    const problems: string[] = [];
    const unlocated: string[] = [];
    for (const file of book.chapters) {
      const chapter = build(file, book, true);
      if (chapter.contentHash !== build(file, book, false).contentHash) problems.push(`${file.fileName}: positions change the content hash`);
      const found = census(file, chapter);
      problems.push(...found.problems);
      unlocated.push(...found.unlocated);
    }
    expect(problems).toEqual([]);
    expect(unlocated).toEqual([]);
  });
});
