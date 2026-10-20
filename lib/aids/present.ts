import { readPath } from "./apply";
import type { AidStep } from "./schema";

/*
 * What a step shows, computed from the script's results (feature-specs/18 § 3). This is the whole of the arithmetic
 * the walk is allowed (invariant 12): a bar's width over the step's largest bar, a ratio headline as `of[0] / of[1]`
 * rounded to one decimal, and a declared scale that turns a fraction into the percentage the book prints. Everything
 * else on screen is a value the script wrote, shown as it is.
 *
 * Pure, so the workers and the dock compute the same numbers from the same results, and so the derive sensor can
 * hold the model's explanation to exactly this set.
 */

export interface PresentedBar {
  readonly labelKey: string;
  readonly tone: "ink" | "ver";
  readonly unit: string | null;
  /** The value as shown, after the declared scale; null when the script did not write it. */
  readonly shown: number | null;
  /** 0–100, the bar's share of the step's largest bar; 0 when absent. */
  readonly width: number;
}

export type PresentedHeadline =
  | { readonly kind: "value"; readonly value: number; readonly unit: string | null }
  | { readonly kind: "ratio"; readonly times: number }
  | { readonly kind: "pct"; readonly percent: number };

export interface PresentedStep {
  readonly ordinal: number;
  readonly bars: ReadonlyArray<PresentedBar>;
  readonly headline: PresentedHeadline | null;
  /** Paths the step reads or presents that the results do not hold. */
  readonly missing: ReadonlyArray<string>;
  /** Every number the step shows — bar values and the headline — for the derive sensor to match against. */
  readonly numbers: ReadonlyArray<number>;
}

function numberAt(results: unknown, path: string): number | null {
  const value = readPath(results, path);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One decimal, as the book prints `3.4×` and `76.9%`; a whole number stays whole. */
export function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export function presentStep(step: AidStep, results: unknown): PresentedStep {
  const missing: string[] = [];
  const numbers: number[] = [];

  const raw = step.bars.map((bar) => {
    const value = numberAt(results, bar.path);
    if (value === null) missing.push(bar.path);
    return { bar, value };
  });
  const largest = Math.max(0, ...raw.map(({ value }) => (value === null ? 0 : Math.abs(value))));
  const bars: PresentedBar[] = raw.map(({ bar, value }) => {
    const shown = value === null ? null : oneDecimal(value * bar.scale);
    if (shown !== null) numbers.push(shown);
    return { labelKey: bar.labelKey, tone: bar.tone, unit: bar.unit, shown, width: value === null || largest === 0 ? 0 : Math.round((Math.abs(value) / largest) * 1000) / 10 };
  });

  let headline: PresentedHeadline | null = null;
  if (step.headline !== null) {
    if (step.headline.kind === "ratio") {
      const [a, b] = step.headline.of.map((path) => numberAt(results, path));
      if (a === null) missing.push(step.headline.of[0]);
      if (b === null) missing.push(step.headline.of[1]);
      if (a !== null && b !== null && b !== 0) {
        headline = { kind: "ratio", times: oneDecimal(a / b) };
        numbers.push(headline.times);
      }
    } else {
      const value = numberAt(results, step.headline.path);
      if (value === null) missing.push(step.headline.path);
      else if (step.headline.kind === "pct") {
        headline = { kind: "pct", percent: oneDecimal(value * step.headline.scale) };
        numbers.push(headline.percent);
      } else {
        headline = { kind: "value", value, unit: step.headline.unit };
        numbers.push(value);
      }
    }
  }

  for (const path of step.reads) if (numberAt(results, path) === null && readPath(results, path) === undefined && !missing.includes(path)) missing.push(path);
  return { ordinal: step.ordinal, bars, headline, missing, numbers };
}
