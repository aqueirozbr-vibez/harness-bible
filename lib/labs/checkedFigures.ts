import type { FigureId, SectionId } from "@/lib/schemas/ids";

/*
 * The figures a lab checks, matched to its last run (feature-specs/19 § 4). A chapter's derived figure carries a
 * `DeriveLink` naming the lab and the key its script prints; the run's `derived` JSON holds the value under that key.
 * Whether the two agree is decided here, in code, at the figure's own printed precision: `77%` is the script's
 * `0.769` and `45%` its `0.455` because the chapter prints no decimals, while `99.5%` against `0.9948` is held to a
 * tenth. A key the run did not write is `missing`, shown as `—`, never guessed (invariant 12).
 */

export interface LabFigureInput {
  readonly figureId: FigureId;
  readonly sectionId: SectionId;
  readonly label: string;
  /** The value as the release prints it. */
  readonly valueText: string;
  readonly tier: string;
  /** The key the script prints (`DeriveLink.key`): a plain key, `name[3]` for a list element, or a slash path. */
  readonly key: string;
  readonly line: number;
  readonly filePath: string;
}

export type CheckVerdict = "match" | "diverge" | "missing";

export interface CheckedFigure extends LabFigureInput {
  readonly chapterValue: string;
  readonly runValue: number | string | null;
  readonly verdict: CheckVerdict;
}

/** The value under a derive key: a property, a list element (`backoff_schedule_s[2]`) or a slash path (`A/total`). */
export function derivedValue(derived: unknown, key: string): unknown {
  if (typeof derived !== "object" || derived === null) return undefined;
  const root = derived as Record<string, unknown>;
  if (root[key] !== undefined) return root[key];
  const indexed = /^(.+)\[(\d+)\]$/.exec(key);
  if (indexed !== null) {
    const list = root[indexed[1] ?? ""];
    return Array.isArray(list) ? (list[Number(indexed[2])] as unknown) : undefined;
  }
  if (key.includes("/")) {
    let node: unknown = derived;
    for (const part of key.split("/")) {
      if (typeof node !== "object" || node === null) return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  }
  return undefined;
}

export interface PrintedNumber {
  readonly value: number;
  readonly percent: boolean;
  /** The decimals the chapter printed, which is the precision it is held to. */
  readonly decimals: number;
  /** A power of ten the printed form carries (`5.04e+23`), so the tolerance scales with it. */
  readonly exponent: number;
}

/** The number a figure's text prints, with the precision it prints it at; null when the text holds no number. */
export function parsePrinted(text: string): PrintedNumber | null {
  const cleaned = text.replace(/[  ]/g, "");
  const match = /-?\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(cleaned);
  if (match === null) return null;
  const raw = match[0].replace(/,/g, "");
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const exp = raw.search(/e/i);
  const mantissa = exp < 0 ? raw : raw.slice(0, exp);
  const dot = mantissa.indexOf(".");
  return { value, percent: cleaned.includes("%"), decimals: dot < 0 ? 0 : mantissa.length - dot - 1, exponent: exp < 0 ? 0 : Number(raw.slice(exp + 1)) };
}

/** The run's value as a number: a JSON number, or a numeric string such as `"5.04e+23"`. */
export function runNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Equal at the printed precision: half a unit of the last printed digit, inclusive, in the units the chapter prints. */
export function matchesPrinted(printed: PrintedNumber, run: number): boolean {
  const scaled = printed.percent ? run * 100 : run;
  const tolerance = 0.5 * Math.pow(10, printed.exponent - printed.decimals) + Math.abs(printed.value) * 1e-12;
  return Math.abs(scaled - printed.value) <= tolerance;
}

function normalise(text: string): string {
  return text.replace(/[\s  ]/g, "").toLowerCase();
}

export function checkFigure(figure: LabFigureInput, derived: unknown): CheckedFigure {
  const value = derivedValue(derived, figure.key);
  if (value === undefined || value === null) return { ...figure, chapterValue: figure.valueText, runValue: null, verdict: "missing" };
  const run = runNumber(value);
  const printed = parsePrinted(figure.valueText);
  const runValue: number | string = run ?? (typeof value === "string" ? value : JSON.stringify(value));
  if (run === null || printed === null) {
    return { ...figure, chapterValue: figure.valueText, runValue, verdict: normalise(String(runValue)) === normalise(figure.valueText) ? "match" : "diverge" };
  }
  return { ...figure, chapterValue: figure.valueText, runValue: run, verdict: matchesPrinted(printed, run) ? "match" : "diverge" };
}

/** Every figure the lab checks against the run, in the chapter's figure order. */
export function checkedFigures(figures: ReadonlyArray<LabFigureInput>, derived: unknown): ReadonlyArray<CheckedFigure> {
  return [...figures].sort((a, b) => a.figureId.localeCompare(b.figureId)).map((figure) => checkFigure(figure, derived));
}
