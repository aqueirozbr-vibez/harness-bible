import { readPath } from "@/lib/aids/apply";
import type { Aid, AidStep } from "@/lib/aids/schema";
import type { Unmeasured, WalkCheck } from "@/lib/gate/phase2";
import type { WalkModeResult } from "@/lib/schemas/assistant";

/*
 * P2.4's facts (project-overview § Success criteria · Phase 2 (4); feature-specs/22 § 3): a decision-aid walk at the
 * book's inputs returns the chapter's own figure, with the derive line and the verification date of its prices.
 * Pure: what a walk turn's stored result amounts to against the release's own run of the same lab, and what the
 * criterion reads when the walk did not run.
 *
 * "The chapter's own figure" is checked against the release, not against the product. The expected headline is
 * computed here from `Lab.derived`, the run the pipeline ingested with the release, and every value the walk shows
 * is compared with that run. The product's own presenter is not asked, because a gate that asked it would be
 * comparing the product with itself.
 */

/** One decimal, the book's rounding of a headline (`3.4×`, `76.9%`), computed here and not taken from the presenter. */
const oneDecimal = (value: number) => Math.round(value * 10) / 10;

type Headline = NonNullable<WalkModeResult["steps"][number]["headline"]>;

/** A headline as the screen prints it. */
export function headlineText(headline: Headline | null): string | null {
  if (headline === null) return null;
  if (headline.kind === "ratio") return `${String(headline.times)}×`;
  if (headline.kind === "pct") return `${String(headline.percent)}%`;
  return `${String(headline.value)}${headline.unit === null ? "" : ` ${headline.unit}`}`;
}

/** The headline a step declares, from a results object; null when a value it needs is not a number there. */
export function expectedHeadline(step: AidStep, results: unknown): string | null {
  const numberAt = (path: string) => {
    const value = readPath(results, path);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const headline = step.headline;
  if (headline === null) return null;
  if (headline.kind === "ratio") {
    const [a, b] = [numberAt(headline.of[0]), numberAt(headline.of[1])];
    return a === null || b === null || b === 0 ? null : `${String(oneDecimal(a / b))}×`;
  }
  const value = numberAt(headline.path);
  if (value === null) return null;
  return headline.kind === "pct" ? `${String(oneDecimal(value * headline.scale))}%` : `${String(value)}${headline.unit === null ? "" : ` ${headline.unit}`}`;
}

/** Two values of a script's results are the same: numbers within floating-point noise, anything else by structure. */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const [left, right] = [a as Record<string, unknown>, b as Record<string, unknown>];
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameValue(left[key], right[key]));
  }
  return a === b;
}

/** The step the criterion reads: the aid's first with a headline (step 2 of 37.8, where the `×` between two configurations is). */
export function headlineStep(aid: Aid): AidStep | null {
  return aid.steps.find((step) => step.headline !== null) ?? null;
}

/** What the gate reads of a walk turn: the result `final` carried, and the derive sensor's verdict on the explanations. */
export interface WalkTurn {
  readonly result: WalkModeResult;
  readonly derive: string | null;
}

/** The headline and the line the aid declares, against the release's own run: what a walk is held to. */
function declared(aid: Aid, releaseResults: unknown): Pick<WalkCheck, "expectedHeadline" | "expectedLine"> {
  const step = headlineStep(aid);
  return { expectedHeadline: (step === null ? null : expectedHeadline(step, releaseResults)) ?? "no headline in the release's run", expectedLine: step?.line ?? 0 };
}

/** P2.4's facts from a walk that ran. */
export function walkCheckOf(aid: Aid, turn: WalkTurn, releaseResults: unknown): WalkCheck {
  const step = headlineStep(aid);
  const shown = step === null ? undefined : turn.result.steps.find((candidate) => candidate.ordinal === step.ordinal);
  /* Every path every step reads: the walk's value is the release's, and the release has one. */
  const valuesEqualRelease = aid.steps.every((wanted) => {
    const walked = turn.result.steps.find((candidate) => candidate.ordinal === wanted.ordinal);
    return (
      walked !== undefined &&
      wanted.reads.every((path) => {
        const expected = readPath(releaseResults, path);
        return expected !== undefined && sameValue(walked.values[path], expected);
      })
    );
  });
  return {
    exitCode: turn.result.run.exitCode,
    headline: headlineText(shown?.headline ?? null),
    ...declared(aid, releaseResults),
    line: shown?.line ?? null,
    /* The day is what the screen prints and what a reviewer checks against 37.9's rows. */
    pricesVerifiedAt: turn.result.pricesVerifiedAt === null ? null : turn.result.pricesVerifiedAt.slice(0, 10),
    derive: turn.derive,
    valuesEqualRelease,
  };
}

/** A walk that did not run, as facts the criterion fails on: nothing was shown, and `what` says what happened instead. */
export function walkNotRun(aid: Aid, releaseResults: unknown, what: string): WalkCheck {
  return { exitCode: null, headline: null, ...declared(aid, releaseResults), line: null, pricesVerifiedAt: null, derive: what, valuesEqualRelease: false };
}

/** How a walk turn ended. */
export type WalkOutcome = { readonly kind: "walked"; readonly check: WalkCheck } | { readonly kind: "refused"; readonly cause: string } | { readonly kind: "failed"; readonly code: string };

/** The code a walk turn ends with when its script did not finish (feature-specs/18 § 7). */
export const AID_RUN_FAILED = "AID_RUN_FAILED";

/**
 * A walk of another aid, beside a criterion that could not be measured, as shape only. It is not held to a price
 * date, because an aid need not have priced steps; everything else is what P2.4 would read.
 */
export function walkShape(aid: Aid, outcome: WalkOutcome, containerDown: boolean): string {
  const on = `${aid.id} (chapter ${String(aid.chapter)}, verified)`;
  if (outcome.kind === "refused") return `Shape only: the walk of ${on} refused as ${outcome.cause}.`;
  if (outcome.kind === "failed") return `Shape only: the walk of ${on} failed with ${outcome.code}${outcome.code === AID_RUN_FAILED && containerDown ? ", because Docker is not running and the script runs in a container" : ""}.`;
  const { check } = outcome;
  const headline = check.headline === check.expectedHeadline ? `${check.headline ?? "no headline"}, which is what the release's run gives` : `${check.headline ?? "no headline"} where the release's run gives ${check.expectedHeadline}`;
  const line = check.line === check.expectedLine ? `ƒ L${String(check.line)}` : `ƒ L${check.line === null ? "?" : String(check.line)} where the step declares L${String(check.expectedLine)}`;
  return `Shape only, the same check on ${on}: exit ${check.exitCode === null ? "none" : String(check.exitCode)} · ${headline} · ${line} · ${check.derive ?? "no derive verdict"} · values ${check.valuesEqualRelease ? "equal" : "differ from"} the release's run.`;
}

export interface WalkFactInput {
  readonly aid: Aid;
  readonly release: string;
  /** Whether the release has verified the aid's chapter. */
  readonly chapterVerified: boolean;
  readonly outcome: WalkOutcome;
  /** The walk's script runs in a container and the container runtime does not answer. */
  readonly containerDown: boolean;
  readonly releaseResults: unknown;
  /** The shape sentence of another aid's walk; asked for only when this one refused for an unverified chapter. */
  readonly shape: string | null;
}

/** Whether a refusal is the release's own, for a chapter it has not verified: the one refusal that blocks rather than fails. */
export function refusedUnverified(input: Pick<WalkFactInput, "outcome" | "chapterVerified">): boolean {
  return input.outcome.kind === "refused" && input.outcome.cause === "R-UNVERIFIED" && !input.chapterVerified;
}

/**
 * What P2.4 is given. A walk that ran is measured. Two things are outside this repository and block it: a chapter
 * the release has not verified, which is the book's to verify, and a container runtime that is not running. Any
 * other refusal or failure is the product's, and fails.
 */
export function walkFactOf(input: WalkFactInput): WalkCheck | Unmeasured {
  const { aid, outcome } = input;
  if (outcome.kind === "walked") return outcome.check;
  if (refusedUnverified(input)) {
    return {
      blocked:
        `Chapter ${String(aid.chapter)} is not verified in release ${input.release}, so the ${aid.section} walk refuses as R-UNVERIFIED before its script runs, as any question about that chapter does. Verifying the chapter is the book's side.` +
        (input.shape === null ? "" : ` ${input.shape}`),
    };
  }
  if (outcome.kind === "failed" && outcome.code === AID_RUN_FAILED && input.containerDown) {
    return { blocked: "Docker is not running: the walk's script runs in the lab tier's container (AID_RUNNER=docker). Start Docker and run the gate again." };
  }
  return walkNotRun(aid, input.releaseResults, outcome.kind === "refused" ? `the turn refused as ${outcome.cause}` : `the turn failed with ${outcome.code}`);
}
