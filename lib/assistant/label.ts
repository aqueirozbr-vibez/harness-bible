/*
 * A conversation's label (feature-specs/23 § 7.2, D8): the chapters its answers cite, in order of first citation.
 * Never the reader's words, so it survives the 30-day purge and is short by construction: `ch21 · ch20 · ch09`.
 */

/** `[21, 20, 9]` → `"ch21 · ch20 · ch09"`; null for a conversation that has cited nothing yet. */
export function citedChaptersLabel(chapters: ReadonlyArray<number>): string | null {
  if (chapters.length === 0) return null;
  return chapters.map((chapter) => `ch${String(chapter).padStart(2, "0")}`).join(" · ");
}
