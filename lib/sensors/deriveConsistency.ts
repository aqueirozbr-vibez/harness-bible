import type { Locale } from "@/lib/i18n/routing";
import { WITHHELD, type SensorVerdict } from "@/lib/schemas/assistant";
import { normaliseNumber, quantitiesIn, type Quantity } from "@/lib/sensors/numbers";

/*
 * The derive sensor (feature-specs/18 § 4), pure. The model explains a result the script produced; it never computes
 * one. So every number in an explanation must be a number the fenced aid result carries — a step's value, its
 * headline, a bar, an input, or a number inside one of the script's own keys (`p_no_failure_13calls_f0.02` names the
 * 13 calls and the 2 % rate it was computed at; `extra_tokens_per_1000_tasks` names the 1000) — once the separators
 * and the `×` / `%` suffixes are set aside. A number that matches nothing is a number the model made, and the
 * explanation that carries it is withheld: the step's values stand, because they are the script's, and the sentence
 * about them is replaced by a fixed line in the reader's language (D2), as the citation sensor substitutes an
 * uncited claim (invariant 14).
 *
 * Two normalisations, neither of them arithmetic the model is credited with: a quoted percent is the same quantity
 * as its fraction (`2%` is the script's `0.02`, `76.9%` its `0.769`), and a match tolerates the printing — a tenth
 * for a value of one or more, half a thousandth for a fraction — so `237.6` is the script's `237.59999999999997` and
 * `0.995` its `0.9948`, while `238` and `0.98` are not.
 *
 * The grammar is the pipeline's own (`NUM_SOURCE`), with the same things set aside before matching: a `Figure 3` /
 * `Lab 37` label, a section reference (`37.8`), a step ordinal (`step 2`) and a script line (`L24`) are names, not
 * quantities. (Measured on the first real walk, 2026-10-03: three explanations in four were withheld for `0.02`,
 * `0.05` and `1000`, every one of them a number the script's keys carried.)
 */

export interface DeriveExplanation {
  readonly ordinal: number;
  readonly text: string;
}

export interface CheckedExplanation extends DeriveExplanation {
  readonly withheld: boolean;
  /** The numbers the explanation quoted that the script did not write, as written. */
  readonly unmatched: ReadonlyArray<string>;
}

export interface DeriveResult {
  readonly explanations: ReadonlyArray<CheckedExplanation>;
  readonly verdict: SensorVerdict;
}

export type QuotedNumber = Quantity;

const KEY_NUMBER = /\d+(?:\.\d+)?/g;

/** Every finite number the fenced aid result carries — as a value, or inside one of the script's keys. */
export function numbersOf(value: unknown): ReadonlyArray<number> {
  const out = new Set<number>();
  const walk = (node: unknown): void => {
    if (typeof node === "number" && Number.isFinite(node)) out.add(node);
    else if (Array.isArray(node)) for (const item of node) walk(item);
    else if (typeof node === "object" && node !== null) {
      for (const [key, item] of Object.entries(node)) {
        for (const piece of key.match(KEY_NUMBER) ?? []) {
          const n = Number(piece);
          if (Number.isFinite(n)) out.add(n);
        }
        walk(item);
      }
    }
  };
  walk(value);
  return [...out];
}

/** The numbers an explanation quotes: the sensors' shared grammar (`lib/sensors/numbers.ts`), names set aside. */
export const quotedNumbers = quantitiesIn;
export { normaliseNumber };

/** Equal up to the printing: a tenth for a value of one or more, half a thousandth for a fraction. */
function close(quoted: number, known: number): boolean {
  return Math.abs(quoted - known) <= (Math.abs(known) >= 1 ? 0.05 : 0.0005);
}

function matches(quoted: QuotedNumber, known: ReadonlyArray<number>): boolean {
  const candidates = quoted.percent ? [quoted.value, quoted.value / 100] : [quoted.value];
  return candidates.some((candidate) => known.some((value) => close(candidate, value)));
}

export function deriveSensor(explanations: ReadonlyArray<DeriveExplanation>, scriptNumbers: ReadonlyArray<number>, locale: Locale): DeriveResult {
  const checked: CheckedExplanation[] = explanations.map((explanation) => {
    const unmatched = quotedNumbers(explanation.text)
      .filter((quoted) => !matches(quoted, scriptNumbers))
      .map(({ raw }) => raw);
    return unmatched.length === 0 ? { ...explanation, withheld: false, unmatched } : { ordinal: explanation.ordinal, text: WITHHELD[locale], withheld: true, unmatched };
  });
  const withheld = checked.filter((explanation) => explanation.withheld).length;
  const total = checked.length;
  return {
    explanations: checked,
    verdict: {
      sensor: "derive",
      verdict: total === 0 ? "NA" : withheld === 0 ? "PASS" : "WARN",
      detail: total === 0 ? "no explanations to check" : `derive output matched · ${String(total - withheld)} of ${String(total)}`,
      data: { total, withheld, unmatched: checked.flatMap((explanation) => explanation.unmatched).join(", ") },
    },
  };
}
