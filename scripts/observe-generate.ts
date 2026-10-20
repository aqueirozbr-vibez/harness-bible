import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { generated } from "@/lib/metrics/dashboard";
import { generatedResearch } from "@/lib/metrics/researchDashboard";

/*
 * npm run observe:generate (feature-specs/21 § 5.3, § 5.4): writes Grafana's assistant dashboard and its alert rules
 * from the statements of lib/metrics/sql, so a panel and the code run the same text; and the researcher's dashboard and
 * its rule from lib/metrics/sql/research (feature-specs/44 § 4). `--check` writes nothing and
 * exits 1 when a file in the repository is not what the statements produce: the same comparison the test makes, for
 * a hook or a pipeline step. No database and no Grafana are needed to run it.
 */

const ROOT = join(process.cwd(), "infra", "observability", "grafana");
const FILES = {
  dashboard: join(ROOT, "dashboards", "assistant.json"),
  alerts: join(ROOT, "provisioning", "alerting", "alerts.json"),
  researchDashboard: join(ROOT, "dashboards", "research.json"),
  researchAlerts: join(ROOT, "provisioning", "alerting", "research.json"),
} as const;

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } }, strict: true });
const assistant = generated();
const research = generatedResearch();
const output = { dashboard: assistant.dashboard, alerts: assistant.alerts, researchDashboard: research.dashboard, researchAlerts: research.alerts } as const;
let stale = 0;

for (const key of ["dashboard", "alerts", "researchDashboard", "researchAlerts"] as const) {
  const path = FILES[key];
  let current: string | null = null;
  try {
    /* A Windows checkout may have rewritten the line endings; the content is what is compared. */
    current = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  } catch {
    current = null;
  }
  if (current === output[key]) {
    console.log(`${key}: up to date`);
  } else if (values.check) {
    stale += 1;
    console.error(`${key}: ${path} is not what lib/metrics/sql produces; run npm run observe:generate`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, output[key]);
    console.log(`${key}: wrote ${path}`);
  }
}
if (stale > 0) process.exitCode = 1;
