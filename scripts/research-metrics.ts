import "dotenv/config";

import { parseArgs } from "node:util";

import { monthOf } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { monthWindow, tableOf } from "@/lib/metrics/assistant";
import { researchMetrics, researchTitleOf } from "@/lib/metrics/research";

/*
 * npm run research:metrics -- --month 2026-10 (feature-specs/44 § 4; unit 61a): the researcher's series for a calendar
 * month, printed as a table — the statements of `lib/metrics/sql/research/` that the Grafana dashboard "Research" runs
 * too. Read-only: every statement is a SELECT over the two research views. Without `--month` it is the current month,
 * in UTC as the rows are stored. A turn the hand-over skipped is not here: it has no record, and its line is in Loki.
 */

function usage(message: string): never {
  console.error(`${message}\nusage: npm run research:metrics [-- --month YYYY-MM]`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { month: { type: "string" } }, strict: true });
  const month = values.month ?? monthOf(new Date());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) usage(`--month must be YYYY-MM, not ${month}`);
  const window = monthWindow(month);
  const all = await researchMetrics(window);
  console.log(`research:metrics ${month} · ${window.from.toISOString().slice(0, 10)} to ${window.to.toISOString().slice(0, 10)} (exclusive), UTC`);
  for (const series of all) console.log(`\n${tableOf(series, researchTitleOf(series.series)).join("\n")}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
