/*
 * CHAPTER-MAP.md → what each chapter carries (feature-specs/04 § 6.8):
 * a lab, an instrument in place of one, or prose only (Part 0).
 *
 * Only the scope tables under `## Part …` headings count. Since 2026-09-23 the
 * map ends with a generated status section (`<!-- STATUS (generated; …) -->`,
 * `## Status — <date>`) whose rows have a word count where the scope rows have
 * the lab cell; reading those rows as scope would make every drafted chapter a
 * lab chapter and every stub an instrument.
 */

export type Carries = "PROSE" | "INSTRUMENT" | "LAB";

const STATUS_MARK = /^<!--\s*STATUS\b/;

export function parseChapterMap(text: string): ReadonlyMap<number, Carries> {
  const map = new Map<number, Carries>();
  let part: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (STATUS_MARK.test(line)) break;
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading !== null) {
      /* a `## Part N …` heading opens a scope table; any other heading closes it */
      part = /^Part\s+(\S+)/.exec(heading[1])?.[1] ?? null;
      continue;
    }
    if (part === null) continue;
    const row = /^\|\s*(\d{2})\s*\|/.exec(line);
    if (row === null) continue;
    const n = Number(row[1]);
    const cells = line.split("|").map((c) => c.trim());
    if (part === "0") {
      map.set(n, "PROSE");
      continue;
    }
    const labCell = cells[4] ?? "";
    map.set(n, /^—|^-|^\s*$/.test(labCell) ? "INSTRUMENT" : "LAB");
  }
  return map;
}
