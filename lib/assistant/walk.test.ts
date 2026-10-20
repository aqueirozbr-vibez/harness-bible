import { describe, expect, it } from "vitest";

import type { WalkModeResult } from "@/lib/schemas/assistant";

import { explanationOf, firstResultStep, formatHeadline, formatInput, formatShown, runProgress, runSeconds, stepState, summaryHeadline } from "./walk";

/*
 * The walk turn's helpers (feature-specs/18 § 5.2): how the computed numbers are printed in each language, where
 * the strip opens, and how the run line's blocks step. No arithmetic beyond what arrives (invariant 12).
 */

const WALK: WalkModeResult = {
  aidId: "37.8-which-configuration",
  inputs: { qpd: 2000 },
  run: { exitCode: 0, timedOut: false, ms: 812 },
  pricesVerifiedAt: "2026-09-02T00:00:00.000Z",
  sameAsBook: true,
  steps: [
    { ordinal: 1, titleKey: "inputs", line: null, pricesFrom: null, values: {}, bars: [], headline: null, missing: [] },
    { ordinal: 2, titleKey: "costPerTask", line: 24, pricesFrom: "37.9", values: {}, bars: [], headline: { kind: "ratio", times: 3.4 }, missing: [] },
    { ordinal: 4, titleKey: "choose", line: 33, pricesFrom: null, values: {}, bars: [], headline: { kind: "value", value: 1433086, unit: "queries per month" }, missing: [] },
  ],
  explanations: [{ ordinal: 2, text: "C is 3.4× cheaper.", withheld: false }],
};

describe("the walk's formatting", () => {
  it("prints a headline as the book does, in the reader's digits", () => {
    expect(formatHeadline({ kind: "ratio", times: 3.4 }, "en")).toBe("3.4×");
    expect(formatHeadline({ kind: "pct", percent: 76.9 }, "pt")).toBe("76,9%");
    expect(formatHeadline({ kind: "value", value: 1433086, unit: "queries per month" }, "en")).toBe("1,433,086 queries per month");
    expect(formatHeadline({ kind: "value", value: 1433086, unit: "queries per month" }, "pt")).toBe("1.433.086 queries per month");
  });

  it("prints a bar's value with its unit, a percent attached and anything else spaced", () => {
    expect(formatShown(237.6, "USD/month", "en")).toBe("237.6 USD/month");
    expect(formatShown(76.9, "%", "en")).toBe("76.9%");
    expect(formatShown(810, null, "en")).toBe("810");
    expect(formatInput(2000, "en")).toBe("2,000");
    expect(formatInput(36.5, "pt")).toBe("36,5");
  });

  it("opens a finished walk on the first result step and names the first headline in the summary", () => {
    expect(firstResultStep(WALK)).toBe(2);
    expect(firstResultStep({ steps: [WALK.steps[0]!] })).toBe(1);
    expect(summaryHeadline(WALK, "en")).toBe("3.4×");
    expect(summaryHeadline({ steps: [WALK.steps[0]!] }, "en")).toBeNull();
    expect(explanationOf(WALK, 2)?.text).toBe("C is 3.4× cheaper.");
    expect(explanationOf(WALK, 3)).toBeNull();
  });

  it("steps the run line's blocks on status events and fills them on final, never on a timer (D3)", () => {
    expect(runProgress(null, false)).toEqual({ done: 0, total: 10 });
    expect(runProgress("running", false)).toEqual({ done: 1, total: 10 });
    expect(runProgress("drafting", false)).toEqual({ done: 5, total: 10 });
    expect(runProgress("grading", true)).toEqual({ done: 10, total: 10 });
    expect(runSeconds(812)).toBe("0.8");
    expect(runSeconds(12_040)).toBe("12.0");
  });

  it("names a strip step done, now or later against where the walk stands", () => {
    expect([1, 2, 3].map((n) => stepState(n, 2))).toEqual(["done", "now", "later"]);
  });
});
