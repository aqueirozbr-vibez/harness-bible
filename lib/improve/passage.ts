import { NUM_SOURCE } from "@/pipeline/parse/patterns";

/*
 * A quoted passage of a section, as the schema sensor reads it (feature-specs/31 § 5): how many times it occurs in
 * the section's source text, the figure whose number it holds, and its digits. The sensor refuses on these at
 * submit; the suggest form shows the same while the passage is written (34 § 5), from the same functions.
 *
 * Pure, and light enough for a client island: the number pattern is the pipeline's own (pipeline/parse/patterns.ts).
 */

const NUM = new RegExp(NUM_SOURCE, "g");

/** How many times `passage` occurs in `text`, non-overlapping. */
export function occurrences(text: string, passage: string): number {
  if (passage.length === 0) return 0;
  let count = 0;
  let at = text.indexOf(passage);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(passage, at + passage.length);
  }
  return count;
}

/** The section's figure whose value is a number of the passage, if one is: a number in prose is changed by anchoring the figure (31 D2). */
export function figureIn(passage: string, figures: ReadonlyArray<{ readonly id: string; readonly valueText: string }>): string | null {
  const numbers = passage.match(NUM)?.map((number) => number.trim()) ?? [];
  if (numbers.length === 0) return null;
  const found = figures.find((figure) => numbers.includes(figure.valueText.trim()));
  return found?.id ?? null;
}

/** A text's digits alone: a text edit that changes them changes a number, which is its figure's to change. */
export const digitsOf = (text: string): string => text.replace(/\D/g, "");
