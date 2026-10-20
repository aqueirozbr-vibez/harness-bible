import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PolicyTests, TestOutcome, Unmeasured } from "@/lib/gate/phase4";

/*
 * What a gate runs (lifted from scripts/phase4-gate.ts for the researcher's gate, unit 61b): the suites its criteria
 * name, through vitest's JSON reporter, read back test by test; and the policy's own tests through opa.
 */

const SUITE_TIMEOUT_MS = 20 * 60_000;

export interface Suites {
  readonly outcomes: ReadonlyArray<TestOutcome>;
  /** Why the run gave nothing, when it did not run. */
  readonly failure: string | null;
  /** The run's own folder, for the caller to remove. */
  readonly dir: string;
}

interface VitestJson {
  readonly testResults?: ReadonlyArray<{ readonly name: string; readonly assertionResults?: ReadonlyArray<{ readonly fullName: string; readonly status: string }> }>;
}

/** Runs vitest on some files with the JSON reporter and reads every test's outcome back; the environment is the caller's, or this process's. */
export function runVitest(files: ReadonlyArray<string>, extra: ReadonlyArray<string> = [], environment: NodeJS.ProcessEnv = process.env): Suites {
  const dir = mkdtempSync(join(tmpdir(), "hb-gate-"));
  const out = join(dir, "vitest.json");
  const result = spawnSync(process.execPath, [join(process.cwd(), "node_modules", "vitest", "vitest.mjs"), "run", ...files, "--reporter=json", `--outputFile=${out}`, ...extra], { cwd: process.cwd(), env: environment, encoding: "utf8", timeout: SUITE_TIMEOUT_MS, maxBuffer: 64 << 20, windowsHide: true });
  if (!existsSync(out)) return { outcomes: [], failure: `vitest wrote no report (exit ${String(result.status)}): ${(result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ")}`, dir };
  const parsed = JSON.parse(readFileSync(out, "utf8")) as VitestJson;
  const outcomes: TestOutcome[] = [];
  for (const file of parsed.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      const status = test.status === "passed" || test.status === "failed" || test.status === "skipped" || test.status === "pending" || test.status === "todo" ? test.status : "failed";
      outcomes.push({ file: file.name, name: test.fullName, status });
    }
  }
  return { outcomes, failure: null, dir };
}

/** The policy's own tests: `opa test policies`, on the PATH or at OPA_BIN. */
export function runOpa(): PolicyTests | Unmeasured {
  const bin = process.env.OPA_BIN ?? "opa";
  const result = spawnSync(bin, ["test", "policies"], { cwd: process.cwd(), encoding: "utf8", timeout: 120_000, windowsHide: true });
  if (result.error !== undefined) return { blocked: `opa could not be run (${result.error.message}); set OPA_BIN to the binary` };
  const text = `${result.stdout}\n${result.stderr}`;
  /* opa prints each of PASS, FAIL, SKIPPED and ERROR only where its count is not zero: a pass is the PASS line's own number, everything else is not one */
  const count = (word: string): { readonly n: number; readonly total: number } | null => {
    const found = new RegExp(`${word}:\\s*(\\d+)\\/(\\d+)`).exec(text);
    return found === null ? null : { n: Number(found[1]), total: Number(found[2]) };
  };
  const pass = count("PASS");
  const fail = count("FAIL");
  const skipped = count("SKIPPED");
  const errored = count("ERROR");
  const total = pass?.total ?? fail?.total ?? skipped?.total ?? errored?.total ?? null;
  /* no count at all is a policy that did not compile, or a run that died: nothing outside the repository is missing, so it is a fail */
  if (total === null) return { passed: 0, failed: 1, total: 1 };
  const passed = pass?.n ?? 0;
  const failed = total - passed + (result.status === 0 ? 0 : passed === total ? 1 : 0);
  return { passed, failed: Math.max(failed, 0), total: failed > total ? failed : total };
}
