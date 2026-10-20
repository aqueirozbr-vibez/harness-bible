import { canonicalize, type JsonValue } from "@/lib/ledger/canonical";
import { sha256Hex } from "@/lib/ledger/hash";

import { stepValues } from "./apply";
import { presentStep, type PresentedBar, type PresentedHeadline } from "./present";
import type { AidRun } from "./run";
import type { Aid } from "./schema";

/*
 * A run, shaped for the turn (feature-specs/18 § 4 step 6): per step, the values the script wrote at the paths the
 * step reads, the bars and the headline `presentStep` computed from them, the derive line, and the section whose
 * source rows price it. `aidResultForPrompt` is what the assembler fences as `<aid>` for the model; the whole shape,
 * with the explanations added, is what the `final` event carries and the row stores (`WalkModeResultSchema`). Pure:
 * the workers run the script and read the prices; this only shapes what came out.
 */

export interface AidStepResult {
  readonly ordinal: number;
  readonly titleKey: string;
  readonly line: number | null;
  readonly pricesFrom: string | null;
  readonly values: Readonly<Record<string, unknown>>;
  readonly bars: ReadonlyArray<PresentedBar>;
  readonly headline: PresentedHeadline | null;
  readonly missing: ReadonlyArray<string>;
}

export interface AidRunResult {
  readonly aidId: string;
  readonly inputs: Readonly<Record<string, number>>;
  readonly run: { readonly exitCode: number | null; readonly timedOut: boolean; readonly ms: number };
  /** The latest `verifiedAt` of the source rows that price the aid's steps, ISO-8601; null when none. */
  readonly pricesVerifiedAt: string | null;
  /** The inputs equal the aid's defaults: the result is the book's own figure (18 § 5.2). */
  readonly sameAsBook: boolean;
  readonly steps: ReadonlyArray<AidStepResult>;
  /** The inputs and the shown values as hashes, for the ledger record: the numbers are the reader's. */
  readonly inputsSha256: string;
  readonly valuesSha256: string;
}

/** A run that did not produce results: the turn ends here, and the record says why (18 § 7). */
export function runFailed(run: Pick<AidRun, "exitCode" | "timedOut" | "results">): boolean {
  return run.exitCode !== 0 || run.timedOut || run.results === null;
}

export function aidResultFor(aid: Aid, inputs: Readonly<Record<string, number>>, run: AidRun, pricesVerifiedAt: Date | null): AidRunResult {
  const steps: AidStepResult[] = aid.steps.map((step) => {
    const read = stepValues(aid, step.ordinal, run.results);
    const shown = presentStep(step, run.results);
    return {
      ordinal: step.ordinal,
      titleKey: step.titleKey,
      line: step.line,
      pricesFrom: step.pricesFrom,
      values: read.values,
      bars: shown.bars,
      headline: shown.headline,
      missing: [...new Set([...read.missing, ...shown.missing])],
    };
  });
  const sameAsBook = aid.inputs.every((input) => inputs[input.key] === input.default);
  return {
    aidId: aid.id,
    inputs,
    run: { exitCode: run.exitCode, timedOut: run.timedOut, ms: run.ms },
    pricesVerifiedAt: pricesVerifiedAt === null ? null : pricesVerifiedAt.toISOString(),
    sameAsBook,
    steps,
    inputsSha256: sha256Hex(canonicalize(inputs as JsonValue)),
    valuesSha256: sha256Hex(canonicalize(steps.map((step) => step.values) as unknown as JsonValue)),
  };
}

/**
 * The aid result as the model reads it inside the `<aid>` fence: every value labelled by its key and the line that
 * produced it, the inputs, and nothing about the screen. The derive sensor holds the explanation to the numbers in
 * exactly this object (18 § 4).
 */
export function aidResultForPrompt(result: AidRunResult): Readonly<Record<string, unknown>> {
  return {
    aid: result.aidId,
    inputs: result.inputs,
    steps: result.steps.map((step) => ({
      step: step.ordinal,
      line: step.line,
      values: step.values,
      bars: step.bars.map((bar) => ({ label: bar.labelKey, value: bar.shown, unit: bar.unit })),
      headline: step.headline,
      missing: step.missing,
    })),
  };
}
