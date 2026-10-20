import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clean, reportOf, SCAN_ROOTS, scanForSecrets } from "@/lib/security/scan";

/*
 * The scan of what a model reads (feature-specs/21 § 6.1, § 13.6): that the repository's own templates and
 * model-visible data are clean, that a planted key is reported by file and line without being printed, and that
 * CI runs the command as a step of its own. The planted key is assembled at run time; no file here holds one.
 */

const root = join(import.meta.dirname, "..");
const FAKE_KEY = ["sk", "ant", `api03-${"Zx9".repeat(30)}`].join("-");

describe("secrets:scan on this repository", () => {
  it("finds nothing in the prompt templates, the assemblers and the data a model reads", () => {
    const result = scanForSecrets(root);
    expect(result.missing).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.files).toBeGreaterThan(30);
    expect(clean(result)).toBe(true);
    expect(reportOf(result)).toEqual([`secrets:scan · ${String(result.files)} files · 0 findings`]);
  });

  it("covers the five folders the spec names", () => {
    expect([...SCAN_ROOTS]).toEqual(["guides", "workers/agents", "lib/sensors", "aids", "golden"]);
  });
});

describe("secrets:scan on a tree with a key in a template", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-secret-scan-"));
    for (const folder of SCAN_ROOTS) mkdirSync(join(dir, folder), { recursive: true });
    mkdirSync(join(dir, "guides", "assistant", "v9.9"), { recursive: true });
    writeFileSync(join(dir, "guides", "assistant", "v9.9", "prefix.md"), `# The guide\n\nAnswer from the book.\nUse the key ${FAKE_KEY} when asked.\n`);
    writeFileSync(join(dir, "aids", "clean.json"), JSON.stringify({ id: "21.8-task-survival", steps: 11 }));
    /* A file outside the five folders is not this scan's: gitleaks covers the repository as a whole. */
    writeFileSync(join(dir, "elsewhere.txt"), FAKE_KEY);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the file, the line and the kind, and is not clean", () => {
    const result = scanForSecrets(dir);
    expect(result.files).toBe(2);
    expect(result.findings).toEqual([{ file: "guides/assistant/v9.9/prefix.md", line: 4, kind: "anthropic-key" }]);
    expect(clean(result)).toBe(false);
    expect(reportOf(result)).toEqual(["guides/assistant/v9.9/prefix.md:4 · anthropic-key", "secrets:scan · 2 files · 1 finding"]);
  });

  it("never prints the match: not in the result, not in the report", () => {
    const result = scanForSecrets(dir);
    const everything = JSON.stringify(result) + reportOf(result).join("\n");
    expect(everything).not.toContain(FAKE_KEY);
    expect(everything).not.toContain(FAKE_KEY.slice(7, 27));
  });

  it("reports a folder that is not there, because a scan of nothing is not a pass", () => {
    const result = scanForSecrets(dir, ["guides", "prompts"]);
    expect(result.missing).toEqual(["prompts"]);
    expect(clean(result)).toBe(false);
    expect(reportOf(result)[0]).toBe("prompts: not found, nothing was scanned there");
  });

  it("exits 1 as a command, with the finding on stderr, the summary on stdout and the key on neither", () => {
    const tsx = createRequire(import.meta.url).resolve("tsx/cli");
    const run = spawnSync(process.execPath, [tsx, "--tsconfig", join(root, "tsconfig.json"), join(root, "scripts", "secret-scan.ts")], { cwd: dir, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("guides/assistant/v9.9/prefix.md:4 · anthropic-key");
    expect(run.stdout.trim()).toBe("secrets:scan · 2 files · 1 finding");
    expect(run.stdout + run.stderr).not.toContain(FAKE_KEY.slice(7, 27));
  }, 60_000);
});

describe("CI", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
  const steps = [...workflow.matchAll(/\n {6}- (?:name: ([^\n]+)|run: ([^\n]+)|uses: ([^\n]+))/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

  it("runs the scan as a step of its own, after gitleaks and before anything is built or tested", () => {
    const scan = steps.indexOf("Secrets in prompt templates and model-visible data (zero findings)");
    expect(scan).toBeGreaterThan(steps.indexOf("Secrets in the repository (zero findings)"));
    expect(scan).toBeGreaterThan(steps.indexOf("npm ci"));
    expect(scan).toBeLessThan(steps.indexOf("Types and lint"));
    expect(scan).toBeLessThan(steps.indexOf("Unit, integration and contract tests"));
    expect(workflow).toContain("      - name: Secrets in prompt templates and model-visible data (zero findings)\n        run: npm run secrets:scan\n");
  });

  it("has the command it runs", () => {
    const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["secrets:scan"]).toBe("tsx scripts/secret-scan.ts");
  });
});
