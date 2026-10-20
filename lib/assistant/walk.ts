import type { Aid } from "@/lib/aids/schema";
import type { SseStep } from "@/lib/hooks/useSse";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { WalkModeResult } from "@/lib/schemas/assistant";

/*
 * The walk turn's arithmetic-free helpers (feature-specs/18 § 5.2). Every number here arrives computed — the
 * script's values, the headline and the bar widths from `lib/aids/present.ts` — and this file only decides how it is
 * printed and where the strip stands. Pure, so the dock, the log row and the status bar agree.
 */

/** The run line's blocks (D3): ten blocks that step on the status events and fill on `final`, never on a timer. */
export const RUN_BLOCKS = 10;

const STEP_BLOCKS: Readonly<Record<SseStep, number>> = { running: 1, retrieving: 3, drafting: 5, checking: 7, grading: 8, repairing: 9 };

/** How many of the ten blocks are filled: the last status event's step, or all of them once the turn has ended. */
export function runProgress(step: SseStep | null, ended: boolean): { readonly done: number; readonly total: number } {
  if (ended) return { done: RUN_BLOCKS, total: RUN_BLOCKS };
  return { done: step === null ? 0 : STEP_BLOCKS[step], total: RUN_BLOCKS };
}

/** `0.8` for 812 ms, one decimal as the status bar prints seconds (ui-context § 13.5). */
export function runSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

export type WalkStep = WalkModeResult["steps"][number];
export type WalkHeadline = NonNullable<WalkStep["headline"]>;

/** A headline as the book prints one: `3.4×`, `76.9%`, `1,433,086 queries per month`. */
export function formatHeadline(headline: WalkHeadline, locale: Locale): string {
  if (headline.kind === "ratio") return `${formatNumber(headline.times, locale)}×`;
  if (headline.kind === "pct") return `${formatNumber(headline.percent, locale)}%`;
  return headline.unit === null ? formatNumber(headline.value, locale) : `${formatNumber(headline.value, locale)} ${headline.unit}`;
}

/** A bar's value beside its meter: the number and its unit, `%` attached and any other unit spaced. */
export function formatShown(shown: number, unit: string | null, locale: Locale): string {
  const number = formatNumber(shown, locale);
  if (unit === null) return number;
  return unit === "%" ? `${number}%` : `${number} ${unit}`;
}

/** Where a finished walk opens: the first step that shows a result, which is the step after the inputs. */
export function firstResultStep(walk: Pick<WalkModeResult, "steps">): number {
  return Math.min(2, walk.steps.length);
}

/** The headline the collapsed walk names (`walked · 4 steps · 3.4×`): the first step that has one. */
export function summaryHeadline(walk: Pick<WalkModeResult, "steps">, locale: Locale): string | null {
  const step = walk.steps.find((candidate) => candidate.headline !== null);
  return step?.headline === null || step?.headline === undefined ? null : formatHeadline(step.headline, locale);
}

/** The step's explanation after the sensor, by ordinal; null when the model gave none for it. */
export function explanationOf(walk: Pick<WalkModeResult, "explanations">, ordinal: number): WalkModeResult["explanations"][number] | null {
  return walk.explanations.find((explanation) => explanation.ordinal === ordinal) ?? null;
}

/** The catalogue label of an input, a step or a bar: `aids.<messageKey>.<group>.<key>`. */
export function aidKey(aid: Pick<Aid, "messageKey">, group: "title" | "inputs" | "steps" | "bars", key?: string): string {
  return key === undefined ? `${aid.messageKey}.${group}` : `${aid.messageKey}.${group}.${key}`;
}

/** An input's value as the form shows it back: integers whole, fractions as typed, both in the reader's digits. */
export function formatInput(value: number, locale: Locale): string {
  return formatNumber(value, locale);
}

/** The strip's state for step `n` while the walk stands at `at`. */
export function stepState(n: number, at: number): "done" | "now" | "later" {
  return n < at ? "done" : n === at ? "now" : "later";
}
