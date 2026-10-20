/*
 * The italic line under a chapter title (feature-specs/04 § 6.1):
 *   *Part II · Word budget 5,000–8,000 · Lab 21 · Verified as of September 2026 · Derived figures from `labs/ch21-control-plane/derive.py`*
 * Stubs carry placeholders (`Verified as of Month Year`), which parse to null.
 */

export interface Frontmatter {
  readonly partText: string | null;
  readonly part: "P0" | "P1" | "P2" | "P3" | null;
  readonly lab: number | null;
  readonly noLab: boolean;
  readonly verifiedAsOf: { readonly year: number; readonly month: number } | null;
  readonly derivePath: string | null;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function partFrom(text: string): Frontmatter["part"] {
  const roman = /part\s*(0|I{1,3}|1|2|3)\b/i.exec(text);
  if (roman === null) return null;
  const v = roman[1].toUpperCase();
  if (v === "0") return "P0";
  if (v === "I" || v === "1") return "P1";
  if (v === "II" || v === "2") return "P2";
  return "P3";
}

export function parseFrontmatter(line: string): Frontmatter {
  const text = line.trim().replace(/^\*|\*$/g, "");
  const parts = text.split("·").map((p) => p.trim());
  const partText = parts.find((p) => /^part\b/i.test(p)) ?? null;
  const labMatch = /\bLab\s+(\d{1,2})\b/i.exec(text);
  const verified = /Verified as of\s+([A-Za-z]+)\s+(\d{4})/i.exec(text);
  const month = verified === null ? undefined : MONTHS[verified[1].toLowerCase()];
  const derive = /`([^`]*derive\.py)`/i.exec(text);
  return {
    partText,
    part: partFrom(partText ?? text),
    lab: labMatch === null ? null : Number(labMatch[1]),
    noLab: /\bNo lab\b/i.test(text),
    verifiedAsOf: verified !== null && month !== undefined ? { year: Number(verified[2]), month } : null,
    derivePath: derive?.[1] ?? null,
  };
}
