/*
 * Pure rules for bookmarks and notes (feature-specs/07-bookmarks-notes.md § 4.1).
 * The editor and the server share them, so the counter and the limit agree.
 */

/** Characters a note may hold after normalisation (07 D2). */
export const NOTE_MAX = 2000;
/** The counter turns to the warn colour from here. */
export const NOTE_NEAR = 1900;
/** Length of the latest-note excerpt on the paths page (05 § 6.2). */
export const EXCERPT_LENGTH = 90;

/** CRLF to LF, trimmed, at most two consecutive blank lines: what is stored and counted. */
export function normaliseNote(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** Code points of the normalised body. */
export function noteLength(body: string): number {
  return [...normaliseNote(body)].length;
}

/** Whitespace collapsed, cut at a word boundary with an ellipsis; empty when the body is blank. */
export function excerpt(body: string, max = EXCERPT_LENGTH): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max).replace(/\s+\S*$/, "");
  return `${cut.length > 0 ? cut : text.slice(0, max)}…`;
}

interface Placed {
  readonly chapterNumber: number;
  readonly sectionId: string;
}

const ordinalOf = (sectionId: string): number => Number(sectionId.slice(sectionId.indexOf(".") + 1)) || 0;

/** Book order: chapter, then section ordinal (07 D3). */
export function orderBookmarks<T extends Placed>(rows: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...rows].sort((a, b) => a.chapterNumber - b.chapterNumber || ordinalOf(a.sectionId) - ordinalOf(b.sectionId) || a.sectionId.localeCompare(b.sectionId));
}

/** Newest first by `updatedAt`; ties fall back to book order (07 D3). */
export function orderNotes<T extends Placed & { readonly updatedAt: Date }>(rows: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.chapterNumber - b.chapterNumber || ordinalOf(a.sectionId) - ordinalOf(b.sectionId));
}
