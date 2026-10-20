import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { logJob } from "@/lib/api/log";

/*
 * The nightly schedule as code (feature-specs/21 § 3.1, § 13.1): the crontab's two entries parse and name scripts
 * that exist, the Windows registration names the same two at the same times, and a job's line is the JSON the
 * collector reads.
 */

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const SCRIPTS = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;

const EXPECTED = [
  { time: "10 3 * * *", script: "assistant:purge", at: "03:10" },
  { time: "20 3 * * *", script: "auth:sweep", at: "03:20" },
];

describe("the nightly schedule", () => {
  it("has two crontab entries, in the product's time zone, each running an npm script that exists", () => {
    const lines = read("infra/schedules/crontab")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(lines[0]).toBe("CRON_TZ=America/Sao_Paulo");
    const entries = lines.slice(1).map((line) => {
      const fields = line.split(/\s+/);
      return { time: fields.slice(0, 5).join(" "), command: fields.slice(5).join(" ") };
    });
    expect(entries).toHaveLength(2);
    for (const [index, expected] of EXPECTED.entries()) {
      const entry = entries[index];
      expect(entry?.time).toBe(expected.time);
      /* minute, hour, day of month, month, day of week: each a number or `*` */
      expect(entry?.time.split(" ").every((field) => /^(\*|\d{1,2})$/.test(field))).toBe(true);
      expect(entry?.command).toContain(`npm run ${expected.script} >>`);
      expect(entry?.command.endsWith("2>&1")).toBe(true);
      expect(SCRIPTS[expected.script], expected.script).toBeDefined();
    }
  });

  it("registers the same two jobs at the same times on the development machine, with a dry run and a way back", () => {
    const ps1 = read("infra/schedules/schedules.ps1");
    for (const expected of EXPECTED) {
      expect(ps1).toContain(`Script = "${expected.script}"`);
      expect(ps1).toContain(`At = "${expected.at}"`);
    }
    expect(ps1).toContain("Register-ScheduledTask");
    expect(ps1).toContain("Unregister-ScheduledTask");
    expect(ps1).toContain("[switch]$DryRun");
    const readme = read("infra/schedules/README.md");
    for (const expected of EXPECTED) expect(readme).toContain(`npm run ${expected.script}`);
  });

  it("prints a job's one line as JSON the collector reads: its name, its counts, its time, and its error when it threw", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      logJob({ traceId: "a".repeat(32), job: "assistant:purge", counts: { messages: 2, conversations: 1 }, ms: 184 });
      logJob({ traceId: "b".repeat(32), job: "auth:sweep", counts: {}, ms: 12, error: "Error: database unreachable" });
      const [ok, failed] = spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
      expect(ok).toEqual({ kind: "job", traceId: "a".repeat(32), job: "assistant:purge", counts: { messages: 2, conversations: 1 }, ms: 184 });
      expect(failed).toMatchObject({ kind: "job", job: "auth:sweep", error: "Error: database unreachable" });
    } finally {
      spy.mockRestore();
    }
  });
});
