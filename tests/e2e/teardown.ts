import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { request } from "@playwright/test";

import { env } from "@/lib/env";
import { E2ePartSchema, e2eReportName, type E2eReport } from "@/lib/schemas/e2e";

import { PARTS_DIR } from "./support";

/*
 * After the run (unit 23d): the parts the tests left are gathered into one report under pipeline/reports/, where the
 * Phase 1 gate reads it. It runs whatever the tests' outcome, which is the point — a failed flow is in the report as
 * a failed flow. A run that left no part (the layout suite alone) writes nothing.
 *
 * A run of some of the specs writes a report of those specs: the gate then finds the rest missing and says so.
 */
export default async function gather(): Promise<void> {
  if (!existsSync(PARTS_DIR)) return;
  const parts = readdirSync(PARTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => E2ePartSchema.parse(JSON.parse(readFileSync(join(PARTS_DIR, name), "utf8"))));
  if (parts.length === 0) return;

  const baseUrl = env.APP_URL.replace(/\/$/, "");
  let release = "unknown";
  const api = await request.newContext({ baseURL: baseUrl });
  try {
    release = ((await (await api.get("/api/v1/releases/current")).json()) as { id?: string }).id ?? "unknown";
  } catch {
    /* The server went away during the run: the report still says what was measured, of an unknown release. */
  } finally {
    await api.dispose();
  }

  const report: E2eReport = {
    release,
    ranAt: new Date().toISOString(),
    baseUrl,
    flows: parts.flatMap((part) => (part.kind === "flow" ? [part] : [])),
    keyboard: parts.flatMap((part) => (part.kind === "keyboard" ? [part] : [])),
    peek: parts.flatMap((part) => (part.kind === "peek" ? [part] : [])),
    resume: parts.flatMap((part) => (part.kind === "resume" ? [part] : [])),
  };
  mkdirSync(join("pipeline", "reports"), { recursive: true });
  const file = join("pipeline", "reports", e2eReportName(release));
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\ne2e report written to ${file}: ${String(report.flows.length)} flows, ${String(report.keyboard.length)} keyboard walks, ${String(report.peek.length)} peek passes, ${String(report.resume.length)} resumes`);
}
