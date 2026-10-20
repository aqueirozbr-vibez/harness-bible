import { NUM_SOURCE, SKIP_SOURCE } from "@/pipeline/parse/figures";

/*
 * What a number is, for the sensors. The grammar is the pipeline's own (`NUM_SOURCE`), and so is what it sets aside:
 * a name that contains digits is not a quantity. `Lab 21`, `Section 21.3`, `21.3`, `Figure 3`, `step 2` and `L24`
 * are how the citation rules tell the model to refer to things (rule 5), so a sensor that read them as numbers would
 * punish the model for following the guide — which is what the citation sensor did until 2026-10-03, when a real lab
 * answer lost a claim for the words "Lab 21".
 *
 * Shared by the citation sensor and the derive sensor, so the two agree on what was quoted.
 */

/** A section reference as the pipeline blanks one, narrowed to the book's chapters (00–40) so `62.4` stays a quantity. */
export const SECTION_REF = String.raw`\b(?:0\d|[1-3]\d|40)\.[1-9]\b(?!\s?(?:%|×|ms|GB|KB|MB|TB|pp|tokens?|USD)|\s?[xsKMB](?![A-Za-z]))`;

const NUMBER = new RegExp(NUM_SOURCE, "g");
const NAMES = new RegExp(`${SKIP_SOURCE}|${SECTION_REF}|\\bstep\\s+\\d+\\b|\\bpasso\\s+\\d+\\b|\\bL\\d+\\b`, "gi");

export interface Quantity {
  /** As written, with its unit. */
  readonly raw: string;
  readonly value: number;
  /** Written with a `%`: the same quantity as the fraction a script writes. */
  readonly percent: boolean;
}

/** The digits of a quoted number, separators and suffix set aside: `1,433,086 queries` and `1433086` are one number. */
export function normaliseNumber(text: string): number | null {
  const digits = text.replace(/[^\d.]/g, "");
  if (digits.length === 0) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/** The quantities a text quotes, with the names that look like numbers set aside. */
export function quantitiesIn(text: string): ReadonlyArray<Quantity> {
  const out: Quantity[] = [];
  const quantities = text.replace(NAMES, (name) => " ".repeat(name.length));
  for (const match of quantities.matchAll(NUMBER)) {
    const value = normaliseNumber(match[0]);
    if (value !== null) out.push({ raw: match[0].trim(), value, percent: match[0].includes("%") });
  }
  return out;
}
