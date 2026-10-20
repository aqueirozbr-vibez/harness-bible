import "dotenv/config";

import { parseArgs } from "node:util";

import { monthOf } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { assistantMetrics, monthWindow, tableOf } from "@/lib/metrics/assistant";

/*
 * npm run assistant:metrics -- --month 2026-09 (feature-specs/21 § 5.3): the assistant's series for a calendar month,
 * printed as a table. The numbers come from the rows the product keeps, through the statements of `lib/metrics/sql/`
 * that the Grafana dashboard runs too, so they exist without Grafana and the Phase 2 gate reads them from code.
 * Read-only: every statement is a SELECT. Without `--month` it is the current month, in UTC as the rows are stored.
 */

function usage(message: string): never {
  console.error(`${message}\nusage: npm run assistant:metrics [-- --month YYYY-MM]`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { month: { type: "string" } }, strict: true });
  const month = values.month ?? monthOf(new Date());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) usage(`--month must be YYYY-MM, not ${month}`);
  const window = monthWindow(month);
  const all = await assistantMetrics(window);
  console.log(`assistant:metrics ${month} · ${window.from.toISOString().slice(0, 10)} to ${window.to.toISOString().slice(0, 10)} (exclusive), UTC`);
  for (const series of all) console.log(`\n${tableOf(series).join("\n")}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
