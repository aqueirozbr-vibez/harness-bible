import { describe, expect, it } from "vitest";

import { CH21_LAB_DIR } from "./fixtures";
import { deriveSource, parseLab } from "./lab";

describe("parseLab", () => {
  const lab = parseLab(CH21_LAB_DIR);

  it("reads the folder, its files and its results", () => {
    expect(lab.id).toBe("lab-21");
    expect(lab.chapter).toBe(21);
    expect(lab.folder).toBe("ch21-control-plane");
    expect(lab.files.map((f) => f.path)).toEqual(["README.md", "derive.py", "executor.py", "run.py"]);
    expect(lab.files[1].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lab.ciVerdict).toBe("REPRODUCED");
    expect(lab.ciCheckedAt?.toISOString()).toBe("2026-09-22T00:17:36.896Z");
    expect(lab.derived.backoff_total_worst_s).toBe(61);
    expect(lab.declaresModelCalls).toBe(false);
    expect(lab.expectedRuntimeS).toBeNull();
  });

  it("exposes derived values, list elements included, with their derive.py lines", () => {
    const source = deriveSource(lab);
    expect(source).not.toBeNull();
    const keys = source!.values.map((v) => v.key);
    expect(keys).toContain("expected_redo_fraction_no_checkpoint");
    expect(keys).toContain("backoff_schedule_s[5]");
    expect(keys).not.toContain("timestamp");
    expect(source!.values.find((v) => v.key === "backoff_schedule_s[5]")?.value).toBe(30);
    expect(source!.lineOf("expected_redo_fraction_no_checkpoint")).toBe(14);
    expect(source!.lineOf("p_no_failure_13calls_f0.02")).toBe(8);
    expect(source!.lineOf("task_success_f0.05_retries3")).toBe(12);
    expect(source!.lineOf("backoff_schedule_s[3]")).toBe(27);
    expect(source!.lineOf("no_such_key")).toBeNull();
    expect(source!.expressionOf("approval_wait_hours")).toBe('out["approval_wait_hours"] = 14.33');
  });
});
