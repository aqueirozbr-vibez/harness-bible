import { describe, expect, it } from "vitest";

import { findAid } from "@/lib/aids/index";
import type { Aid } from "@/lib/aids/schema";
import { WalkModeResultSchema, type WalkModeResult } from "@/lib/schemas/assistant";

import { walkCriterion } from "./phase2";
import { AID_RUN_FAILED, expectedHeadline, headlineStep, headlineText, refusedUnverified, walkCheckOf, walkFactOf, walkNotRun, walkShape, type WalkOutcome } from "./walk";

/*
 * P2.4's facts (feature-specs/22 § 3): a walk's result against the release's own run of its lab. The aids are the
 * repository's own two; the results are a small object shaped like the lab's `results/derived.json`, with the
 * numbers the book prints for 37.8 (A 810, C 237.6: 3.4×).
 */

const CH37: Aid = (() => {
  const aid = findAid("37.8-which-configuration");
  if (aid === null) throw new Error("aids/ holds no 37.8-which-configuration");
  return aid;
})();
const CH21: Aid = (() => {
  const aid = findAid("21.8-task-survival");
  if (aid === null) throw new Error("aids/ holds no 21.8-task-survival");
  return aid;
})();

/* Every path the 37.8 aid reads, as the release's run has it. */
const RELEASE_37 = {
  queries_per_month: 60000,
  A: { total: 810 },
  C: { total: 237.59999999999997 },
  saving_A_to_C_pct: 70.7,
  sensitivity_B: { esc: { "0.0": 420, "0.1": 540, "0.3": 780 } },
  C_total_route70: 351.6,
  saving_A_to_C_route70_pct: 56.6,
  breakeven_vs_C_queries: 1432000,
  breakeven_vs_C_x: 23.9,
};

const read = (results: unknown, path: string): unknown => path.split("/").reduce<unknown>((current, part) => (current !== null && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined), results);

/** The walk's stored result for an aid, built from a results object the way the turn builds it: every step's reads, the declared lines, one headline. */
function walked(aid: Aid, results: unknown, overrides: { readonly headline?: WalkModeResult["steps"][number]["headline"]; readonly line?: number | null; readonly exitCode?: number | null; readonly pricesVerifiedAt?: string | null } = {}): WalkModeResult {
  const first = headlineStep(aid);
  return WalkModeResultSchema.parse({
    aidId: aid.id,
    inputs: Object.fromEntries(aid.inputs.map((input) => [input.key, input.default])),
    run: { exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode, timedOut: false, ms: 310 },
    pricesVerifiedAt: overrides.pricesVerifiedAt === undefined ? "2026-09-01T00:00:00.000Z" : overrides.pricesVerifiedAt,
    sameAsBook: true,
    steps: aid.steps.map((step) => ({
      ordinal: step.ordinal,
      titleKey: step.titleKey,
      line: step.ordinal === first?.ordinal && overrides.line !== undefined ? overrides.line : step.line,
      pricesFrom: step.pricesFrom,
      values: Object.fromEntries(step.reads.map((path) => [path, read(results, path)])),
      bars: [],
      headline: step.ordinal === first?.ordinal ? (overrides.headline === undefined ? { kind: "ratio", times: 3.4 } : overrides.headline) : null,
      missing: [],
    })),
    explanations: [],
  });
}

const DERIVE = "derive output matched · 3 of 3";

describe("a headline, as printed and as the release's run gives it", () => {
  it("prints a ratio, a percentage and a value with its unit", () => {
    expect(headlineText({ kind: "ratio", times: 3.4 })).toBe("3.4×");
    expect(headlineText({ kind: "pct", percent: 76.9 })).toBe("76.9%");
    expect(headlineText({ kind: "value", value: 1432000, unit: "queries per month" })).toBe("1432000 queries per month");
    expect(headlineText({ kind: "value", value: 12, unit: null })).toBe("12");
    expect(headlineText(null)).toBeNull();
  });

  it("computes each kind from the results, to one decimal, and nothing from a value that is not there", () => {
    const [, costs, load, choose] = CH37.steps;
    if (costs === undefined || load === undefined || choose === undefined) throw new Error("the 37.8 aid has four steps");
    /* 810 / 237.6 = 3.409…: the book's 3.4×, by the release's own run and not by the model. */
    expect(expectedHeadline(costs, RELEASE_37)).toBe("3.4×");
    expect(expectedHeadline(load, RELEASE_37)).toBe("56.6%");
    expect(expectedHeadline(choose, RELEASE_37)).toBe("1432000 queries per month");
    expect(expectedHeadline(costs, { A: { total: 810 } })).toBeNull();
    expect(expectedHeadline(costs, { A: { total: 810 }, C: { total: 0 } })).toBeNull();
    expect(expectedHeadline(costs, { A: { total: "810" }, C: { total: 237.6 } })).toBeNull();
    expect(expectedHeadline(CH37.steps[0] ?? costs, RELEASE_37)).toBeNull();
    /* A fraction shown as a percentage: the aid says the scale, the gate applies it. */
    expect(expectedHeadline(CH21.steps[1] ?? costs, { "p_no_failure_13calls_f0.02": 0.769 })).toBe("76.9%");
  });

  it("reads the criterion's figure from the aid's first step with a headline", () => {
    expect(headlineStep(CH37)).toMatchObject({ ordinal: 2, line: 24, pricesFrom: "37.9" });
    expect(headlineStep(CH21)).toMatchObject({ ordinal: 2, line: 8, pricesFrom: null });
  });
});

describe("a walk that ran, against the release's own run", () => {
  it("is the chapter's own figure when the headline, the line, the date, the derive verdict and every value agree", () => {
    const check = walkCheckOf(CH37, { result: walked(CH37, RELEASE_37), derive: DERIVE }, RELEASE_37);
    expect(check).toEqual({ exitCode: 0, headline: "3.4×", expectedHeadline: "3.4×", line: 24, expectedLine: 24, pricesVerifiedAt: "2026-09-01", derive: DERIVE, valuesEqualRelease: true });
    expect(walkCriterion(check)).toMatchObject({ id: "P2.4", status: "pass", measured: "3.4× · ƒ L24 · prices verified 2026-09-01" });
  });

  it("takes floating-point noise for the same value and a different number for a different one", () => {
    const noisy = { ...RELEASE_37, C: { total: 237.6 } };
    expect(walkCheckOf(CH37, { result: walked(CH37, noisy), derive: DERIVE }, RELEASE_37).valuesEqualRelease).toBe(true);
    const moved = { ...RELEASE_37, C: { total: 240 } };
    expect(walkCheckOf(CH37, { result: walked(CH37, moved), derive: DERIVE }, RELEASE_37).valuesEqualRelease).toBe(false);
    /* A value the release's run does not have cannot be the release's. */
    expect(walkCheckOf(CH37, { result: walked(CH37, RELEASE_37), derive: DERIVE }, { A: { total: 810 }, C: { total: 237.6 } }).valuesEqualRelease).toBe(false);
  });

  it("fails on another headline, another line, a missing date, an explanation withheld, a script that did not exit 0", () => {
    const of = (overrides: Parameters<typeof walked>[2], derive: string | null = DERIVE) => walkCriterion(walkCheckOf(CH37, { result: walked(CH37, RELEASE_37, overrides), derive }, RELEASE_37));
    expect(of({ headline: { kind: "ratio", times: 13 } }).note).toBe("headline 13×, the script gives 3.4×.");
    expect(of({ headline: null }).note).toBe("headline absent, the script gives 3.4×.");
    expect(of({ line: 142 }).note).toBe("derive line 142, the step declares 24.");
    expect(of({ pricesVerifiedAt: null }).note).toBe("no verification date for the prices.");
    expect(of({}, "derive output matched · 2 of 3").note).toBe("derive sensor: derive output matched · 2 of 3.");
    expect(of({}, null).note).toBe("derive sensor: absent.");
    expect(of({ exitCode: 1 }).note).toBe("the script exited 1.");
  });
});

describe("a walk that did not run", () => {
  const refused: WalkOutcome = { kind: "refused", cause: "R-UNVERIFIED" };
  const base = { aid: CH37, release: "2026.09", containerDown: false, releaseResults: RELEASE_37, shape: null };

  it("blocks on a chapter the release has not verified, which is the book's side, and carries the shape beside it", () => {
    expect(refusedUnverified({ outcome: refused, chapterVerified: false })).toBe(true);
    const fact = walkFactOf({ ...base, chapterVerified: false, outcome: refused, shape: "Shape only, the same check on 21.8-task-survival." });
    expect(fact).toEqual({
      blocked:
        "Chapter 37 is not verified in release 2026.09, so the 37.8 walk refuses as R-UNVERIFIED before its script runs, as any question about that chapter does. Verifying the chapter is the book's side. Shape only, the same check on 21.8-task-survival.",
    });
    expect(walkCriterion(fact)).toMatchObject({ id: "P2.4", status: "blocked", measured: "not measured" });
  });

  it("fails on the same refusal for a chapter the release has verified, and on any other refusal: those are the product's", () => {
    expect(refusedUnverified({ outcome: refused, chapterVerified: true })).toBe(false);
    const verified = walkFactOf({ ...base, chapterVerified: true, outcome: refused });
    expect(verified).toEqual(walkNotRun(CH37, RELEASE_37, "the turn refused as R-UNVERIFIED"));
    expect(walkCriterion(verified)).toMatchObject({ status: "fail" });
    expect(walkCriterion(verified).note).toContain("derive sensor: the turn refused as R-UNVERIFIED");
    const scope = walkFactOf({ ...base, chapterVerified: false, outcome: { kind: "refused", cause: "R-SCOPE" } });
    expect(walkCriterion(scope)).toMatchObject({ status: "fail", measured: "no headline · ƒ L? · prices verified ?" });
  });

  it("blocks on a script that did not run because the container runtime is down, and fails on any other failure", () => {
    const failed: WalkOutcome = { kind: "failed", code: AID_RUN_FAILED };
    expect(walkFactOf({ ...base, chapterVerified: true, outcome: failed, containerDown: true })).toEqual({ blocked: "Docker is not running: the walk's script runs in the lab tier's container (AID_RUNNER=docker). Start Docker and run the gate again." });
    expect(walkCriterion(walkFactOf({ ...base, chapterVerified: true, outcome: failed })).status).toBe("fail");
    const other = walkFactOf({ ...base, chapterVerified: true, outcome: { kind: "failed", code: "ASSISTANT_UNAVAILABLE" }, containerDown: true });
    expect(walkCriterion(other)).toMatchObject({ status: "fail" });
    expect(walkCriterion(other).note).toContain("the turn failed with ASSISTANT_UNAVAILABLE");
  });

  it("is the walk's own facts when it ran, whatever else is true", () => {
    const check = walkCheckOf(CH37, { result: walked(CH37, RELEASE_37), derive: DERIVE }, RELEASE_37);
    expect(walkFactOf({ ...base, chapterVerified: false, containerDown: true, outcome: { kind: "walked", check } })).toBe(check);
  });
});

describe("another aid's walk, as shape beside a criterion that could not be measured", () => {
  const RELEASE_21 = { "p_no_failure_13calls_f0.01": 0.878, "p_no_failure_13calls_f0.02": 0.769, "p_no_failure_13calls_f0.05": 0.513, "task_success_f0.02_retries1": 0.9948, "task_success_f0.02_retries3": 1, "task_success_f0.05_retries1": 0.968, "task_success_f0.05_retries3": 0.9999, expected_redo_fraction_no_checkpoint: 0.455, extra_tokens_per_1000_tasks_no_checkpoint: 37500000 };

  it("says what the walk showed against the release's run, without holding it to a price date it need not have", () => {
    const check = walkCheckOf(CH21, { result: walked(CH21, RELEASE_21, { headline: { kind: "pct", percent: 76.9 }, pricesVerifiedAt: null }), derive: "derive output matched · 4 of 4" }, RELEASE_21);
    expect(walkShape(CH21, { kind: "walked", check }, false)).toBe(
      "Shape only, the same check on 21.8-task-survival (chapter 21, verified): exit 0 · 76.9%, which is what the release's run gives · ƒ L8 · derive output matched · 4 of 4 · values equal the release's run.",
    );
  });

  it("says where the walk differs, and when it did not run at all", () => {
    const off = walkCheckOf(CH21, { result: walked(CH21, RELEASE_21, { headline: { kind: "pct", percent: 80 }, line: 9, pricesVerifiedAt: null }), derive: null }, { ...RELEASE_21, "p_no_failure_13calls_f0.05": 0.5 });
    expect(walkShape(CH21, { kind: "walked", check: off }, false)).toBe(
      "Shape only, the same check on 21.8-task-survival (chapter 21, verified): exit 0 · 80% where the release's run gives 76.9% · ƒ L9 where the step declares L8 · no derive verdict · values differ from the release's run.",
    );
    expect(walkShape(CH21, { kind: "refused", cause: "R-SCOPE" }, false)).toBe("Shape only: the walk of 21.8-task-survival (chapter 21, verified) refused as R-SCOPE.");
    expect(walkShape(CH21, { kind: "failed", code: AID_RUN_FAILED }, true)).toBe("Shape only: the walk of 21.8-task-survival (chapter 21, verified) failed with AID_RUN_FAILED, because Docker is not running and the script runs in a container.");
    expect(walkShape(CH21, { kind: "failed", code: "NO_FINAL" }, true)).toBe("Shape only: the walk of 21.8-task-survival (chapter 21, verified) failed with NO_FINAL.");
  });
});
