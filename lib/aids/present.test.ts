import { describe, expect, it } from "vitest";

import { checkAid } from "./apply";
import { findAid, listAidsFor, aidChapters } from "./index";
import { presentStep } from "./present";

/*
 * The walk's arithmetic, all of it (feature-specs/18 § 3, § 12.1): the ratio, the percentage scale and the bar widths,
 * computed from a results object shaped like lab 37's and lab 21's real derived.json. The figures are the ones CI
 * recorded for release 2026.09 — 810 against 237.6 is the chapter's 3.4×, not the screen's illustrative 13× (D5).
 */

const CH37_RESULTS = {
  queries_per_month: 60000,
  A: { total: 810 },
  C: { total: 237.59999999999997 },
  saving_A_to_C_pct: 70.7,
  sensitivity_B: { esc: { "0.0": 420, "0.1": 540, "0.3": 780 } },
  C_total_route70: 305,
  saving_A_to_C_route70_pct: 62.4,
  breakeven_vs_C_queries: 1433086,
  breakeven_vs_C_x: 23.9,
};

const CH21_RESULTS = {
  "p_no_failure_13calls_f0.01": 0.878,
  "p_no_failure_13calls_f0.02": 0.769,
  "p_no_failure_13calls_f0.05": 0.513,
  "task_success_f0.02_retries1": 0.9948,
  "task_success_f0.02_retries3": 1,
  "task_success_f0.05_retries1": 0.968,
  "task_success_f0.05_retries3": 0.9999,
  expected_redo_fraction_no_checkpoint: 0.455,
  extra_tokens_per_1000_tasks_no_checkpoint: 75075,
};

const ch37 = findAid("37.8-which-configuration");
const ch21 = findAid("21.8-task-survival");
if (ch37 === null || ch21 === null) throw new Error("the two aids ship with the application");

describe("presentStep", () => {
  it("computes the ratio headline and the bar widths of the cost step in code: 810 against 237.6 is 3.4×", () => {
    const step = presentStep(ch37.steps[1], CH37_RESULTS);
    expect(step.headline).toEqual({ kind: "ratio", times: 3.4 });
    expect(step.bars.map((bar) => [bar.labelKey, bar.shown, bar.width, bar.tone])).toEqual([
      ["a", 810, 100, "ink"],
      ["c", 237.6, 29.3, "ver"],
    ]);
    expect(step.missing).toEqual([]);
    expect(step.numbers).toEqual([810, 237.6, 3.4]);
  });

  it("reads a percentage the script already wrote as it is, and a fraction through its declared scale", () => {
    expect(presentStep(ch37.steps[2], CH37_RESULTS).headline).toEqual({ kind: "pct", percent: 62.4 });
    const survival = presentStep(ch21.steps[1], CH21_RESULTS);
    /* 0.769 is the book's 77%: the scale is the data's, not a guess from the size of the number. */
    expect(survival.headline).toEqual({ kind: "pct", percent: 76.9 });
    expect(survival.bars.map((bar) => bar.shown)).toEqual([87.8, 76.9, 51.3]);
    expect(survival.bars.map((bar) => bar.width)).toEqual([100, 87.6, 58.4]);
  });

  it("shows a plain value with its unit, and says which paths the results do not hold", () => {
    expect(presentStep(ch37.steps[3], CH37_RESULTS).headline).toEqual({ kind: "value", value: 1433086, unit: "queries per month" });
    const partial = presentStep(ch37.steps[1], { A: { total: 810 } });
    expect(partial.headline).toBeNull();
    expect(partial.missing).toEqual(expect.arrayContaining(["C/total"]));
    expect(partial.bars[1]).toMatchObject({ shown: null, width: 0 });
  });
});

describe("the aids' presentation", () => {
  it("both aids validate with their bars and headlines, and every presented path is read", () => {
    for (const aid of [ch37, ch21]) {
      for (const step of aid.steps) {
        const reads = new Set(step.reads);
        for (const bar of step.bars) expect(reads.has(bar.path), `${aid.id} step ${step.ordinal} ${bar.path}`).toBe(true);
      }
    }
  });

  it("checkAid refuses a bar or a headline over a path the step does not read", () => {
    const bad = { ...ch21, steps: ch21.steps.map((step, index) => (index === 1 ? { ...step, bars: [{ labelKey: "x", path: "not/read", tone: "ink" as const, scale: 1 as const, unit: null }] } : step)) };
    const problems = checkAid(bad, "x\n".repeat(30));
    expect(problems.map((problem) => problem.message)).toContain("path not/read is not among the step's reads");
  });

  it("lists the aids of a chapter and the chapters that have one", () => {
    expect(listAidsFor(37).map((aid) => aid.id)).toEqual(["37.8-which-configuration"]);
    expect(listAidsFor(5)).toEqual([]);
    expect(aidChapters()).toEqual([21, 37]);
  });
});
