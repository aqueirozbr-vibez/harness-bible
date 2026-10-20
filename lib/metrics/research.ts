import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runStatement, type MetricQuery, type MetricWindow } from "@/lib/metrics/assistant";
import type { MetricSeries, MetricUnit } from "@/lib/schemas/metrics";

/*
 * The researcher's series (feature-specs/44 § 4; unit 61a), one statement each in `lib/metrics/sql/research/`, run as
 * the assistant's are: the window and the bucket as the three parameters, the five columns back, by day and by month.
 * `npm run research:metrics` prints them, the Grafana dashboard "Research" runs the same text, and the gate (unit 61b)
 * reads its measures from them.
 *
 * They read three views and nothing else (migrations 20261011090000_research_metrics and, since unit 70,
 * 20261012180000_research_views): `ResearchFact`, what the RESEARCH records say of each run and the curators' accepts
 * and declines of researchers' proposals; `ResearchSpend`, what research spends by the run it served and by who paid —
 * the platform's research principal, or the person whose research it was (feature-specs/48 § 7); and `ResearchFlag`,
 * the flags people put on their research, by day, kind and reason (48 § 11.7). None is `ResearchRun` or
 * `LedgerRecord` itself, so the dashboard's role reads no reader's row and cannot see who asked; and a run skipped at
 * the hand-over, which has no record, is its `research.run` line's to count, in Loki.
 */

export const RESEARCH_SERIES = [
  { name: "runs", title: "research runs by how they ended", unit: "count" },
  { name: "findings", title: "findings by outcome", unit: "count" },
  { name: "cost-per-run", title: "research cost per run", unit: "usd" },
  { name: "proposals", title: "researcher proposals by curator decision", unit: "share" },
  { name: "cap", title: "research calls refused at the cap", unit: "count" },
  { name: "flags", title: "research flags by reason", unit: "count" },
] as const satisfies ReadonlyArray<{ readonly name: string; readonly title: string; readonly unit: MetricUnit }>;

export type ResearchSeriesName = (typeof RESEARCH_SERIES)[number]["name"];

export const RESEARCH_SQL_DIR = join(process.cwd(), "lib", "metrics", "sql", "research");

/** A statement as its file holds it, line endings as `\n` (as `seriesSql`). */
export function researchSql(name: ResearchSeriesName, dir = RESEARCH_SQL_DIR): string {
  return readFileSync(join(dir, `${name}.sql`), "utf8").replace(/\r\n/g, "\n");
}

export function researchTitleOf(name: string): string {
  return RESEARCH_SERIES.find((series) => series.name === name)?.title ?? name;
}

export function runResearchSeries(name: ResearchSeriesName, window: MetricWindow, query?: MetricQuery): Promise<MetricSeries> {
  const unit: MetricUnit = RESEARCH_SERIES.find((series) => series.name === name)?.unit ?? "count";
  return runStatement(name, researchSql(name), unit, window, query);
}

/** Every series over the window, in the dashboard's order. */
export async function researchMetrics(window: MetricWindow, query?: MetricQuery): Promise<ReadonlyArray<MetricSeries>> {
  const all: MetricSeries[] = [];
  for (const series of RESEARCH_SERIES) all.push(await runResearchSeries(series.name, window, query));
  return all;
}
