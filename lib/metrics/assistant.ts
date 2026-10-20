import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getPrisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";
import { MetricRowSchema, type MetricBucket, type MetricPoint, type MetricSeries, type MetricUnit } from "@/lib/schemas/metrics";

/*
 * The assistant's headline series, computed from the rows the product already keeps (feature-specs/21 § 5.3, D4):
 * no Prometheus and no second set of numbers. Each series is one statement in `lib/metrics/sql/`, and the Grafana
 * dashboard runs the same text, so the gate (spec 22) and an auditor read from code what an operator reads from a
 * panel.
 *
 * A statement takes three parameters — the window's start and end, and `day` or `month` — and returns the five
 * columns of `MetricRowSchema`. It is run twice: by day for the points, by month for the month to date, which a
 * percentile or a count of distinct accounts cannot be summed into from the days.
 *
 * These are raw statements across every reader's rows (lib/db/RAW_SQL.md): aggregates only. No row, id or text of
 * any reader leaves a statement, and none groups by a reader or a conversation, which is also why the things the
 * architecture does not collect (§ 7: time on page, messages per session, rankings) have no statement here.
 */

export const SERIES = [
  { name: "citation-rate", title: "citation rate", unit: "share" },
  { name: "flag-rate", title: "flag rate", unit: "share" },
  { name: "refusal-rate", title: "refusal rate by cause", unit: "share" },
  { name: "first-token-p95", title: "first-token p95", unit: "ms" },
  { name: "grounded", title: "grounded distribution", unit: "score" },
  { name: "cost-per-active-account", title: "cost per active account", unit: "usd" },
  { name: "cache-read-share", title: "cache read share", unit: "share" },
  { name: "edition-mismatch", title: "edition mismatch share", unit: "share" },
  { name: "purge", title: "purge", unit: "count" },
] as const satisfies ReadonlyArray<{ readonly name: string; readonly title: string; readonly unit: MetricUnit }>;

export type SeriesName = (typeof SERIES)[number]["name"];

export const SQL_DIR = join(process.cwd(), "lib", "metrics", "sql");

/**
 * The statement of a series as the file holds it: the text the dashboard inlines. Line endings are read as `\n`
 * whatever the checkout wrote, so a Windows working copy generates the same dashboard as any other (the guides are
 * normalised for the same reason before they are hashed).
 */
export function seriesSql(name: SeriesName, dir = SQL_DIR): string {
  return readFileSync(join(dir, `${name}.sql`), "utf8").replace(/\r\n/g, "\n");
}

export interface MetricWindow {
  /** Inclusive. */
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
}

/** `2026-09` as the window of that calendar month in UTC, the unit the rows are stored in. */
export function monthWindow(month: string): MetricWindow {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (match === null) throw new AppError("METRICS_MONTH", `a month is written YYYY-MM, not ${month}`);
  const [year, index] = [Number(match[1]), Number(match[2]) - 1];
  return { from: new Date(Date.UTC(year, index, 1)), to: new Date(Date.UTC(year, index + 1, 1)) };
}

/** Runs one statement with its three parameters; the default is the database, a test passes its own. */
export type MetricQuery = (sql: string, from: string, to: string, bucket: MetricBucket) => Promise<unknown>;

const databaseQuery: MetricQuery = (sql, from, to, bucket) => getPrisma().$queryRawUnsafe(sql, from, to, bucket);

function pointsOf(rows: unknown, bucket: MetricBucket): ReadonlyArray<MetricPoint> {
  return MetricRowSchema.array()
    .parse(rows)
    .map((row) => ({ bucket: row.bucket.toISOString().slice(0, bucket === "day" ? 10 : 7), key: row.key, n: row.n, d: row.d, value: row.value }));
}

export async function runSeries(name: SeriesName, window: MetricWindow, query: MetricQuery = databaseQuery): Promise<MetricSeries> {
  return runStatement(name, seriesSql(name), SERIES.find((series) => series.name === name)?.unit ?? "count", window, query);
}

/** One statement's text as a series: run by day and by month with the window, its rows read back. The researcher's series run here too (feature-specs/44 § 4). */
export async function runStatement(series: string, sql: string, unit: MetricUnit, window: MetricWindow, query: MetricQuery = databaseQuery): Promise<MetricSeries> {
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  const [days, months] = await Promise.all([query(sql, from, to, "day"), query(sql, from, to, "month")]);
  return { series, unit, window: { from, to }, points: pointsOf(days, "day"), months: pointsOf(months, "month") };
}

/* One function per series, for a caller that wants one (the gate reads the citation rate and the first-token p95). */
export const citationRate = (window: MetricWindow, query?: MetricQuery) => runSeries("citation-rate", window, query);
export const flagRate = (window: MetricWindow, query?: MetricQuery) => runSeries("flag-rate", window, query);
export const refusalRate = (window: MetricWindow, query?: MetricQuery) => runSeries("refusal-rate", window, query);
export const firstTokenP95 = (window: MetricWindow, query?: MetricQuery) => runSeries("first-token-p95", window, query);
export const groundedDistribution = (window: MetricWindow, query?: MetricQuery) => runSeries("grounded", window, query);
export const costPerActiveAccount = (window: MetricWindow, query?: MetricQuery) => runSeries("cost-per-active-account", window, query);
export const cacheReadShare = (window: MetricWindow, query?: MetricQuery) => runSeries("cache-read-share", window, query);
export const editionMismatchShare = (window: MetricWindow, query?: MetricQuery) => runSeries("edition-mismatch", window, query);
export const purged = (window: MetricWindow, query?: MetricQuery) => runSeries("purge", window, query);

/** Every series over the window, in the dashboard's order. */
export async function assistantMetrics(window: MetricWindow, query?: MetricQuery): Promise<ReadonlyArray<MetricSeries>> {
  const all: MetricSeries[] = [];
  for (const series of SERIES) all.push(await runSeries(series.name, window, query));
  return all;
}

/** A value in its unit, as the table prints it; `-` when the statement had nothing to divide by. */
export function formatValue(unit: MetricUnit, value: number | null): string {
  if (value === null) return "-";
  if (unit === "share") return `${(value * 100).toFixed(1)} %`;
  if (unit === "ms") return `${String(Math.round(value))} ms`;
  if (unit === "usd") return `$${value.toFixed(4)}`;
  if (unit === "score") return value.toFixed(2);
  return String(Math.round(value));
}

/** `12 / 15` for a ratio, `n = 12` for a percentile's samples, nothing for a plain count. */
function basisOf(point: MetricPoint, unit: MetricUnit): string {
  if (point.d === null) return "";
  if (point.n === null) return `n = ${String(point.d)}`;
  return unit === "usd" ? `$${point.n.toFixed(4)} / ${String(point.d)}` : `${String(point.n)} / ${String(point.d)}`;
}

/** The series as the lines of a table: the month to date first, then the days. Pure. */
export function tableOf(series: MetricSeries, title: string = SERIES.find((entry) => entry.name === series.series)?.title ?? series.series): ReadonlyArray<string> {
  const rows = [...series.months, ...series.points];
  if (rows.length === 0) return [title, "  no rows in the window"];
  const line = (point: MetricPoint) =>
    `  ${point.bucket.padEnd(12)}${point.key.padEnd(14)}${formatValue(series.unit, point.value).padStart(12)}   ${basisOf(point, series.unit)}`.trimEnd();
  return [title, ...rows.map(line)];
}
