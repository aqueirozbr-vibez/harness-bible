/*
 * One way of counting words (feature-specs/31 § 5): runs of characters that are not whitespace. The form's counter,
 * the endpoint and the rationale sensor all count with this, so "142 / 200 words" on the screen is the number the
 * sensor will see.
 *
 * Pure.
 */

/** TRD § 6.1: a rationale is at most 200 words; the researcher's note the same. */
export const RATIONALE_WORDS_MAX = 200;

/** Runs of non-whitespace: `"a  b\nc"` is 3; `""` and `"   "` are 0. */
export function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches === null ? 0 : matches.length;
}
