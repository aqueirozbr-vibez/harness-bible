import { describe, expect, it } from "vitest";

import { findAid } from "./index";
import type { AidRun } from "./run";
import { aidResultFor, aidResultForPrompt, runFailed } from "./turn";

/*
 * A run shaped for the turn (feature-specs/18 § 4 step 6): the values per step, the presentation computed in code,
 * the hashes the ledger keeps instead of the reader's numbers. The results are CI's for release 2026.09, with the
 * timestamp the real script writes, which must not move the values' hash.
 */

const RESULTS = {
  queries_per_month: 60000,
  A: { total: 810 },
  C: { total: 237.59999999999997 },
  saving_A_to_C_pct: 70.7,
  sensitivity_B: { esc: { "0.0": 420, "0.1": 540, "0.3": 780 } },
  C_total_route70: 305,
  saving_A_to_C_route70_pct: 62.4,
  breakeven_vs_C_queries: 1433086,
  breakeven_vs_C_x: 23.9,
  timestamp: "2026-10-03T12:00:00+00:00",
};

const DEFAULTS = { qpd: 2000, tout: 400, tcache: 4000, esc: 10, route: 90 };

function run(results: unknown, extra: Partial<AidRun> = {}): AidRun {
  return { exitCode: 0, timedOut: false, ms: 812, stdout: "", stderr: "", results, ...extra };
}

const aid = findAid("37.8-which-configuration");
if (aid === null) throw new Error("the chapter 37 aid ships with the application");

describe("aidResultFor", () => {
  it("shapes the run per step: the values read, the bars and headline computed in code, the derive line, the prices section", () => {
    const result = aidResultFor(aid, DEFAULTS, run(RESULTS), new Date("2026-09-02T00:00:00.000Z"));
    expect(result.aidId).toBe("37.8-which-configuration");
    expect(result.run).toEqual({ exitCode: 0, timedOut: false, ms: 812 });
    expect(result.pricesVerifiedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(result.sameAsBook).toBe(true);
    const cost = result.steps[1];
    expect(cost).toMatchObject({ ordinal: 2, titleKey: "costPerTask", line: 24, pricesFrom: "37.9", missing: [] });
    expect(cost?.values).toEqual({ queries_per_month: 60000, "A/total": 810, "C/total": 237.59999999999997, saving_A_to_C_pct: 70.7 });
    expect(cost?.headline).toEqual({ kind: "ratio", times: 3.4 });
    expect(cost?.bars.map((bar) => [bar.labelKey, bar.shown])).toEqual([
      ["a", 810],
      ["c", 237.6],
    ]);
    expect(result.steps[3]?.headline).toEqual({ kind: "value", value: 1433086, unit: "queries per month" });
  });

  it("says when the inputs are not the book's, and reports the paths a partial result does not hold", () => {
    const result = aidResultFor(aid, { ...DEFAULTS, qpd: 20000 }, run({ A: { total: 8100 } }), null);
    expect(result.sameAsBook).toBe(false);
    expect(result.pricesVerifiedAt).toBeNull();
    expect(result.steps[1]?.missing).toEqual(expect.arrayContaining(["C/total", "queries_per_month"]));
    expect(result.steps[1]?.headline).toBeNull();
  });

  it("hashes the inputs and the shown values, so a different timestamp is the same run and different inputs are not", () => {
    const first = aidResultFor(aid, DEFAULTS, run(RESULTS), null);
    const again = aidResultFor(aid, DEFAULTS, run({ ...RESULTS, timestamp: "2026-10-03T12:00:01+00:00" }), null);
    const other = aidResultFor(aid, { ...DEFAULTS, qpd: 20000 }, run(RESULTS), null);
    expect(first.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.valuesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(again.valuesSha256).toBe(first.valuesSha256);
    expect(again.inputsSha256).toBe(first.inputsSha256);
    expect(other.inputsSha256).not.toBe(first.inputsSha256);
  });

  it("fences for the model only what the script wrote, labelled by key and line, with no hash and no screen word", () => {
    const fenced = aidResultForPrompt(aidResultFor(aid, DEFAULTS, run(RESULTS), null));
    expect(Object.keys(fenced).sort()).toEqual(["aid", "inputs", "steps"]);
    const steps = fenced.steps as ReadonlyArray<Record<string, unknown>>;
    expect(steps[1]).toMatchObject({ step: 2, line: 24, headline: { kind: "ratio", times: 3.4 } });
    expect(steps[1]).not.toHaveProperty("titleKey");
    expect(JSON.stringify(fenced)).not.toContain("Sha256");
  });
});

describe("runFailed", () => {
  it("is a non-zero exit, a timeout, or no results", () => {
    expect(runFailed(run(RESULTS))).toBe(false);
    expect(runFailed(run(RESULTS, { exitCode: 1 }))).toBe(true);
    expect(runFailed(run(RESULTS, { exitCode: null }))).toBe(true);
    expect(runFailed(run(RESULTS, { timedOut: true }))).toBe(true);
    expect(runFailed(run(null))).toBe(true);
  });
});
