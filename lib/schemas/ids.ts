import { z } from "zod";

/*
 * Branded identifiers (architecture decisions, code-standards § TypeScript).
 * A branded value exists only after one of the parsers below accepted the
 * format, so a raw string cannot be passed where an id is expected.
 * Formats are the book's own: TRD § 4.2 ids and the UI package.
 */

/** Chapter number 0..40. */
export const ChapterNumberSchema = z.number().int().min(0).max(40).brand<"ChapterNumber">();
export type ChapterNumber = z.infer<typeof ChapterNumberSchema>;

/** Section id: zero-padded chapter, a dot, layer 1..9 — `"21.3"`, `"02.1"`. */
export const SectionIdSchema = z
  .string()
  .regex(/^\d{2}\.[1-9]$/, "section id like 21.3")
  .brand<"SectionId">();
export type SectionId = z.infer<typeof SectionIdSchema>;

/** Figure id — `"F-21-03"`; three digits when a chapter has a hundred or more figures. */
export const FigureIdSchema = z
  .string()
  .regex(/^F-\d{2}-\d{2,3}$/, "figure id like F-21-03")
  .brand<"FigureId">();
export type FigureId = z.infer<typeof FigureIdSchema>;

/** Source row id: the chapter's layer 9 and a row ordinal — `"21.9 r4"`. */
export const SourceRowIdSchema = z
  .string()
  .regex(/^\d{2}\.9 r\d+$/, "source row id like 21.9 r4")
  .brand<"SourceRowId">();
export type SourceRowId = z.infer<typeof SourceRowIdSchema>;

/**
 * Suggestion id — `"S-15-0377"`: S, the chapter in two digits, a serial per chapter in four digits. A fifth digit
 * appears when a chapter passes 9,999 suggestions, and nothing parses the width (feature-specs/29 § 4.2). The
 * database holds the same form by a check (migration 20261005120000_improvement).
 */
export const SuggestionIdSchema = z
  .string()
  .regex(/^S-\d{2}-\d{4,}$/, "suggestion id like S-15-0377")
  .brand<"SuggestionId">();
export type SuggestionId = z.infer<typeof SuggestionIdSchema>;

/**
 * Release id: year and month — `"2026.09"` — and from a month's second release on, its serial: `"2026.10.2"`
 * (feature-specs/37 D1, Andre's answer of 2026-10-09; a merge is a release, unit 54c).
 */
export const ReleaseIdSchema = z
  .string()
  .regex(/^\d{4}\.(0[1-9]|1[0-2])(\.([2-9]|[1-9]\d+))?$/, "release id like 2026.09, or 2026.10.2 from a month's second")
  .brand<"ReleaseId">();
export type ReleaseId = z.infer<typeof ReleaseIdSchema>;

export function parseChapterNumber(value: number): ChapterNumber {
  return ChapterNumberSchema.parse(value);
}

export function parseSectionId(value: string): SectionId {
  return SectionIdSchema.parse(value);
}

export function parseFigureId(value: string): FigureId {
  return FigureIdSchema.parse(value);
}

export function parseSourceRowId(value: string): SourceRowId {
  return SourceRowIdSchema.parse(value);
}

export function parseSuggestionId(value: string): SuggestionId {
  return SuggestionIdSchema.parse(value);
}

/**
 * The id of a chapter's `serial`-th suggestion: `(15, 377)` → `"S-15-0377"`, `(15, 10000)` → `"S-15-10000"`. The
 * chapter is any two digits, because the id's form is, and the serial starts at one.
 */
export function suggestionIdOf(chapterNumber: number, serial: number): SuggestionId {
  if (!Number.isInteger(chapterNumber) || chapterNumber < 0 || chapterNumber > 99) throw new RangeError(`a suggestion id's chapter is a whole number from 0 to 99, not ${String(chapterNumber)}`);
  if (!Number.isInteger(serial) || serial < 1) throw new RangeError(`a suggestion id's serial is a whole number from 1, not ${String(serial)}`);
  return SuggestionIdSchema.parse(`S-${String(chapterNumber).padStart(2, "0")}-${String(serial).padStart(4, "0")}`);
}

export function parseReleaseId(value: string): ReleaseId {
  return ReleaseIdSchema.parse(value);
}

/** `21` → `"21"`, `0` → `"00"`: the two-digit form every screen prints. */
export function padChapter(n: ChapterNumber): string {
  return String(n).padStart(2, "0");
}

/**
 * Where a chapter opens: its first layer, Intuition (feature-specs/03 § 11 D4): `21` in `en` → `/en/ch/21/21.1`.
 *
 * The chapter's own address, `/en/ch/21`, redirects there, and it is what a link from outside the reader uses. A
 * link or a key inside the reader uses this one: a redirect followed from one reader page to another made the
 * browser load the page afresh on a repeat visit, and a key pressed while it loaded was lost (found by the keyboard
 * walk of tests/e2e).
 */
export function chapterStartHref(locale: string, n: ChapterNumber): string {
  const id = padChapter(n);
  return `/${locale}/ch/${id}/${id}.1`;
}

/** The chapter a section belongs to: `"21.3"` → `21`. */
export function chapterOfSection(id: SectionId): ChapterNumber {
  return parseChapterNumber(Number(id.slice(0, 2)));
}

/** The layer ordinal of a section: `"21.3"` → `3`. */
export function layerOfSection(id: SectionId): number {
  return Number(id.slice(3));
}
