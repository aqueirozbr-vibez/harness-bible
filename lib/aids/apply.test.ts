import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { env } from "@/lib/env";
import { CH21_LAB_DIR } from "@/pipeline/parse/fixtures";

import { applyAid, checkAid, checkInputs, pythonLiteral, readPath, stepValues } from "./apply";
import { findAid, loadAids } from "./index";
import { dockerArgs, runAid } from "./run";

const ch21 = findAid("21.8-task-survival");
const ch37 = findAid("37.8-which-configuration");
if (ch21 === null || ch37 === null) throw new Error("the shipped aids did not load");
const ch21Script = readFileSync(join(CH21_LAB_DIR, "derive.py"), "utf8");
const ch37Dir = join(process.cwd(), env.BOOK_DIR, "labs", "ch37-economics");
const python = process.env.PYTHON_BIN ?? "python";

async function pythonAvailable(): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(python, ["--version"], { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
const hasPython = await pythonAvailable();
const docker = process.env.DOCKER_BIN ?? "docker";
async function dockerAvailable(): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(docker, ["version", "--format", "{{.Server.Version}}"], { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
const hasDocker = await dockerAvailable();

describe("aids", () => {
  it("ships aids that validate against the schema and their scripts", () => {
    expect(loadAids().map((a) => a.id)).toEqual(["21.8-task-survival", "37.8-which-configuration"]);
    expect(checkAid(ch21, ch21Script)).toEqual([]);
    if (existsSync(join(ch37Dir, "derive.py"))) expect(checkAid(ch37, readFileSync(join(ch37Dir, "derive.py"), "utf8"))).toEqual([]);
  });

  it("checkAid names a missing line, a find that is not unique, an unknown placeholder and an unused input", () => {
    const bad = { ...ch21, edits: [{ line: 999, find: "x", with: "{steps}" }, { line: 5, find: "1", with: "{nope}" }] };
    const problems = checkAid(bad, ch21Script);
    expect(problems.map((p) => p.message)).toEqual(expect.arrayContaining([expect.stringMatching(/the script has \d+ lines/), expect.stringMatching(/occurs \d+ times/), "placeholder {nope} is not a declared input", "no edit uses this input"]));
  });

  it("checkInputs validates against the declared ranges and names them", () => {
    const ok = checkInputs(ch37, { qpd: 5000, tout: "800", tcache: 3000, esc: 20, route: "70,5" });
    expect(ok.errors).toEqual([]);
    expect(ok.values).toEqual({ qpd: 5000, tout: 800, tcache: 3000, esc: 20, route: 70.5 });
    const bad = checkInputs(ch37, { qpd: 5, tout: "many", tcache: 9000, esc: 20.5 });
    expect(bad.errors.map((e) => `${e.key}:${e.reason}`)).toEqual(["qpd:below_min", "tout:not_a_number", "tcache:above_max", "route:missing"]);
    expect(bad.errors[0]).toMatchObject({ min: 100, max: 100000 });
    expect(checkInputs(ch21, { steps: 10.5, calls: 13, tokens_per_step: 7500 }).errors[0]).toMatchObject({ key: "steps", reason: "not_integer" });
  });

  it("applyAid rewrites only the declared literals, scaled into Python form", () => {
    expect(pythonLiteral(20, 0.01, false)).toBe("0.2");
    expect(pythonLiteral(10, 0.01, false)).toBe("0.1");
    expect(pythonLiteral(2000, 1, true)).toBe("2000");
    expect(pythonLiteral(70.5, 0.01, false)).toBe("0.705");
    const patched = applyAid(ch21, ch21Script, { steps: 20, calls: 25, tokens_per_step: 9000 });
    const lines = patched.split("\n");
    expect(lines[4]).toContain("steps, calls_per_task = 20, 25");
    expect(lines[15]).toContain("tokens_per_step = 9000");
    expect(patched.split("\n").length).toBe(ch21Script.replace(/\r\n/g, "\n").split("\n").length);
    expect(() => applyAid(ch21, ch21Script, { steps: 20 })).toThrow(/no value for \{calls\}/);
  });

  it("stepValues reads dotted paths and reports what the script did not produce", () => {
    const results = { A: { total: 810 }, C: { total: 237.6 }, sensitivity_B: { esc: { "0.1": 540 } } };
    expect(readPath(results, "sensitivity_B/esc/0.1")).toBe(540);
    expect(readPath(results, "A/missing")).toBeUndefined();
    const step = stepValues(ch37, 2, results);
    expect(step.values).toEqual({ "A/total": 810, "C/total": 237.6 });
    expect(step.missing).toEqual(["queries_per_month", "saving_A_to_C_pct"]);
    expect(() => stepValues(ch37, 9, results)).toThrow(/no step 9/);
  });

  it("dockerArgs isolates the container: no network, read-only root, the scratch folder as the only mount, the lab tier's caps", () => {
    const args = dockerArgs("C:/scratch/hb-aid-1", "derive.py");
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    for (const flag of ["--network", "none", "--read-only", "--cap-drop", "ALL", "--pids-limit"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--cpus") + 1]).toBe("2");
    expect(args[args.indexOf("--memory") + 1]).toBe("4g");
    expect(args[args.indexOf("-v") + 1]).toBe("C:/scratch/hb-aid-1:/lab");
    expect(args.slice(-3)).toEqual(["python:3.12-slim", "python", "derive.py"]);
    expect(dockerArgs("/x", "derive.py", "custom:1")).toContain("custom:1");
  });

  it("dockerArgs runs as the scratch folder's owner where the host has users, and names no user where it has none", () => {
    const linux = dockerArgs("/tmp/hb-aid-1", "derive.py", undefined, "1001:118");
    expect(linux[linux.indexOf("--user") + 1]).toBe("1001:118");
    expect(linux.indexOf("--user")).toBeLessThan(linux.indexOf("python:3.12-slim"));
    expect(dockerArgs("C:/scratch/hb-aid-1", "derive.py", undefined, null)).not.toContain("--user");
  });

  describe.skipIf(!hasDocker)("runAid with docker", () => {
    it("runs the patched chapter 21 script in the lab tier's container", async () => {
      const run = await runAid(ch21, { steps: 22, calls: 26, tokens_per_step: 7500 }, { labDir: CH21_LAB_DIR, runner: "docker", docker });
      expect(run.stderr).toBe("");
      expect(run.exitCode).toBe(0);
      expect(readPath(run.results, "p_no_failure_13calls_f0.02")).toBeCloseTo(0.98 ** 26, 3);
    }, 120_000);
  });

  describe.skipIf(!hasPython)("runAid with python", () => {
    it("runs the patched chapter 21 script and the results follow the inputs", async () => {
      const base = await runAid(ch21, { steps: 11, calls: 13, tokens_per_step: 7500 }, { labDir: CH21_LAB_DIR, python });
      expect(base.exitCode).toBe(0);
      expect(readPath(base.results, "p_no_failure_13calls_f0.02")).toBe(0.769);
      const longer = await runAid(ch21, { steps: 22, calls: 26, tokens_per_step: 7500 }, { labDir: CH21_LAB_DIR, python });
      expect(longer.exitCode).toBe(0);
      expect(readPath(longer.results, "p_no_failure_13calls_f0.02")).toBeCloseTo(0.98 ** 26, 3);
      expect(readPath(longer.results, "expected_redo_fraction_no_checkpoint")).toBeCloseTo(21 / 44, 3);
      expect(base.ms).toBeLessThan(30_000);
    }, 60_000);

    it.skipIf(!existsSync(join(ch37Dir, "derive.py")))("runs chapter 37 at the book's P-101 inputs and at a higher volume", async () => {
      const book = await runAid(ch37, { qpd: 2000, tout: 400, tcache: 4000, esc: 10, route: 90 }, { labDir: ch37Dir, python });
      expect(book.exitCode).toBe(0);
      expect(readPath(book.results, "A/total")).toBe(810);
      expect(readPath(book.results, "C/total")).toBeCloseTo(237.6, 3);
      expect(readPath(book.results, "saving_A_to_C_pct")).toBe(70.7);
      const busy = await runAid(ch37, { qpd: 20000, tout: 400, tcache: 4000, esc: 10, route: 90 }, { labDir: ch37Dir, python });
      expect(readPath(busy.results, "A/total")).toBe(8100);
      expect(stepValues(ch37, 2, busy.results).missing).toEqual([]);
    }, 60_000);
  });
});
