import { SERIES, seriesSql, type SeriesName } from "@/lib/metrics/assistant";
import type { MetricUnit } from "@/lib/schemas/metrics";

/*
 * The Grafana dashboard "Assistant citation and flag rate" and its alert rules, built from the statements of
 * `lib/metrics/sql` (feature-specs/21 § 5.3, § 5.4, D4). Pure: the statements in, two JSON documents out.
 * `npm run observe:generate` writes them under `infra/observability/grafana/`, and a test fails when the files in
 * the repository are not what this produces, so a panel's or a rule's query cannot drift from the file the code runs.
 *
 * A statement's three parameters become Grafana's own: the window's start and end are its time macros, and the
 * bucket is a literal. The statement's text is otherwise untouched and sits whole inside the query, wrapped only to
 * name the columns a panel wants (`time`, `metric`, a value).
 *
 * Thresholds are the spec's and are written once, here (§ 5.4; architecture § 8 for the two seconds): this file
 * invents none.
 */

export const DASHBOARD_UID = "hb-assistant";
export const DASHBOARD_TITLE = "Assistant citation and flag rate";

export const POSTGRES = { type: "grafana-postgresql-datasource", uid: "hb-postgres" } as const;
export const LOKI = { type: "loki", uid: "hb-loki" } as const;
const EXPRESSION = { type: "__expr__", uid: "__expr__" } as const;

/** The purge's job lines in Loki (infra/observability/otel-collector.yaml): the runs that ended without an error. */
export const PURGE_LINES = '{service_name="hb-lines"} | kind="job" | job="assistant:purge"';
const PURGE_RUNS = `${PURGE_LINES} | error=""`;
/**
 * Any line the guard found a secret in (`lib/telemetry/print.ts` marks it `hb.secret.detected`; Loki files the field
 * as `hb_secret_detected`). The guard has already replaced the value: what the line reports is that something
 * upstream put a secret where no text belongs.
 */
export const SECRET_LINES = '{service_name="hb-lines"} | hb_secret_detected="true"';

/** What a bucket is on the dashboard, and what an alert passes to get its whole window back as one row. */
export type GrafanaBucket = "day" | "month" | "millennium";

/** A statement with Grafana's parameters in place of the three it takes; everything else is the file, verbatim. */
export function grafanaSql(sql: string, bucket: GrafanaBucket): string {
  return sql.trimEnd().replaceAll("$1::timestamp", "$__timeFrom()::timestamp").replaceAll("$2::timestamp", "$__timeTo()::timestamp").replaceAll("$3::text", `'${bucket}'::text`);
}

/** The inverse, for the test that a query is its file: what was wrapped, with the three parameters put back. */
export function fileSqlOf(rawSql: string): string {
  const inner = rawSql.slice(rawSql.indexOf("FROM (\n") + "FROM (\n".length, rawSql.lastIndexOf("\n) s"));
  return `${inner.replaceAll("$__timeFrom()::timestamp", "$1::timestamp").replaceAll("$__timeTo()::timestamp", "$2::timestamp").replace(/'(day|month|millennium)'::text/g, "$3::text")}\n`;
}

export interface Wrap {
  /** One line of a keyed series (`any`), or every line but one. */
  readonly only?: string;
  readonly except?: string;
  /** The value's column name, for a series with one line: it is what the legend prints. */
  readonly as?: string;
}

function whereOf(wrap: Wrap): string {
  if (wrap.only !== undefined) return `\nWHERE s.key = '${wrap.only}'`;
  if (wrap.except !== undefined) return `\nWHERE s.key <> '${wrap.except}'`;
  return "";
}

/** A panel's query: the statement by `bucket`, as the time series Grafana draws. */
export function panelSql(name: SeriesName, bucket: GrafanaBucket, wrap: Wrap = {}, sqlOf: (name: SeriesName) => string = seriesSql): string {
  return panelSqlOf(sqlOf(name), bucket, wrap);
}

/** The same from a statement's text: what another dashboard's series use (the researcher's, feature-specs/44 § 4). */
export function panelSqlOf(sql: string, bucket: GrafanaBucket, wrap: Wrap = {}): string {
  const columns = wrap.as === undefined ? 's.bucket AS "time", s.key AS metric, s.value' : `s.bucket AS "time", s.value AS "${wrap.as}"`;
  return `SELECT ${columns}\nFROM (\n${grafanaSql(sql, bucket)}\n) s${whereOf(wrap)}\nORDER BY 1`;
}

/** A rule's query: the statement over the rule's whole window, one row per line of the series. */
export function alertSql(name: SeriesName, wrap: Wrap = {}, sqlOf: (name: SeriesName) => string = seriesSql): string {
  return alertSqlOf(sqlOf(name), wrap);
}

export function alertSqlOf(sql: string, wrap: Wrap = {}): string {
  return `SELECT s.key AS metric, s.value\nFROM (\n${grafanaSql(sql, "millennium")}\n) s${whereOf(wrap)}`;
}

/** The statement's own header, without the parameters line: what the panel says of itself on hover. */
export function descriptionOf(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => line.startsWith("-- ") && !line.startsWith("-- Parameters:"))
    .map((line) => line.slice(3))
    .join(" ");
}

export const GRAFANA_UNIT: Readonly<Record<MetricUnit, string>> = { share: "percentunit", ms: "ms", usd: "currencyUSD", score: "none", count: "none" };

/** Which series have one line (the value is named after the series) and which have a line per key. */
const KEYED: ReadonlySet<SeriesName> = new Set<SeriesName>(["flag-rate", "refusal-rate", "grounded", "edition-mismatch"]);

export type Json = string | number | boolean | null | ReadonlyArray<Json> | { readonly [key: string]: Json };

export function sqlTarget(rawSql: string): Json {
  return { refId: "A", datasource: POSTGRES, format: "time_series", rawQuery: true, editorMode: "code", rawSql };
}

/** A panel's cell on Grafana's 24-column grid. A type, not an interface: it is written into a JSON value as it is. */
export type Place = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

function statPanel(id: number, place: Place, title: string, name: SeriesName, unit: MetricUnit, wrap: Wrap, steps: ReadonlyArray<Json>, sqlOf: (name: SeriesName) => string): Json {
  return {
    id,
    type: "stat",
    title,
    description: `${descriptionOf(sqlOf(name))} Over the dashboard's range, by month: with the default range, the month to date.`,
    datasource: POSTGRES,
    gridPos: place,
    targets: [sqlTarget(panelSql(name, "month", wrap, sqlOf))],
    fieldConfig: { defaults: { unit: GRAFANA_UNIT[unit], decimals: unit === "share" ? 1 : unit === "ms" ? 2 : 0, thresholds: { mode: "absolute", steps } }, overrides: [] },
    options: { reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false }, colorMode: "value", graphMode: "none", textMode: "value" },
  };
}

function seriesPanel(id: number, place: Place, name: SeriesName, title: string, unit: MetricUnit, sqlOf: (name: SeriesName) => string): Json {
  const share = unit === "share" || unit === "score";
  return {
    id,
    type: "timeseries",
    title,
    description: descriptionOf(sqlOf(name)),
    datasource: POSTGRES,
    gridPos: place,
    targets: [sqlTarget(panelSql(name, "day", KEYED.has(name) ? {} : { as: title }, sqlOf))],
    fieldConfig: {
      defaults: { unit: GRAFANA_UNIT[unit], ...(share ? { min: 0, max: 1 } : { min: 0 }), custom: { drawStyle: "line", showPoints: "always", spanNulls: true, lineWidth: 1, fillOpacity: 0 } },
      overrides: [],
    },
    options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "none" } },
  };
}

const BASE: Json = { color: "text", value: null };

/** The dashboard: four headline numbers for the range, one panel per series by day, and the purge's own lines. */
export function assistantDashboard(sqlOf: (name: SeriesName) => string = seriesSql): Json {
  const stats = [
    statPanel(1, { x: 0, y: 0, w: 6, h: 4 }, "citation rate", "citation-rate", "share", { as: "citation rate" }, [{ color: "red", value: null }, { color: "green", value: CITATION_RATE_FLOOR }], sqlOf),
    statPanel(2, { x: 6, y: 0, w: 6, h: 4 }, "flag rate", "flag-rate", "share", { only: "any" }, [BASE], sqlOf),
    statPanel(3, { x: 12, y: 0, w: 6, h: 4 }, "refusal rate", "refusal-rate", "share", { only: "any" }, [BASE], sqlOf),
    statPanel(4, { x: 18, y: 0, w: 6, h: 4 }, "first-token p95", "first-token-p95", "ms", { as: "first-token p95" }, [{ color: "green", value: null }, { color: "red", value: FIRST_TOKEN_P95_MS }], sqlOf),
  ];
  const series = SERIES.map((entry, index) => seriesPanel(10 + index, { x: (index % 2) * 12, y: 4 + Math.floor(index / 2) * 8, w: 12, h: 8 }, entry.name, entry.title, entry.unit, sqlOf));
  const below = 4 + Math.ceil(SERIES.length / 2) * 8;
  const purge: Json = {
    id: 30,
    type: "logs",
    title: "purge · the job's own lines",
    description: "Each run of the retention job writes one line with what it cleared: messages, citations, mode results, conversations, abandoned turns closed. The series above counts conversations from the rows; the count of messages a run nulled exists only here.",
    datasource: LOKI,
    gridPos: { x: 0, y: below, w: 24, h: 8 },
    targets: [{ refId: "A", datasource: LOKI, editorMode: "code", queryType: "range", expr: PURGE_LINES }],
    options: { showTime: true, wrapLogMessage: true, enableLogDetails: true, sortOrder: "Descending", dedupStrategy: "none" },
  };
  return {
    uid: DASHBOARD_UID,
    title: DASHBOARD_TITLE,
    description: "The assistant's headline series, computed from the rows the product keeps (feature-specs/21 § 5.3). Every query is a statement of lib/metrics/sql; npm run assistant:metrics prints the same numbers. Generated: change lib/metrics/dashboard.ts and run npm run observe:generate.",
    tags: ["harness-bible", "assistant"],
    timezone: "utc",
    editable: false,
    graphTooltip: 1,
    schemaVersion: 39,
    version: 1,
    refresh: "",
    time: { from: "now/M", to: "now" },
    panels: [...stats, ...series, purge],
  };
}

/* The thresholds of § 5.4, and where each comes from. */
/** First token under 2 s at p95 (architecture § 8; project-overview § Success criteria · Phase 2). */
export const FIRST_TOKEN_P95_MS = 2000;
/** A refusal cause above 20 % of a day's turns. */
export const REFUSAL_RATE_CEILING = 0.2;
/** At least 90 % of answers with a citation on every claim. */
export const CITATION_RATE_FLOOR = 0.9;
/** The windows: an hour for the latency, a day for the two rates, two days without a purge. */
const HOUR_S = 3600;
export const DAY_S = 86_400;
export const PURGE_ABSENT_S = 2 * DAY_S;

export function sqlRule(uid: string, title: string, summary: string, rawSql: string, windowS: number, comparison: string, severity: "warn" | "info" = "warn"): Json {
  return {
    uid,
    title,
    condition: "B",
    data: [
      { refId: "A", relativeTimeRange: { from: windowS, to: 0 }, datasourceUid: POSTGRES.uid, model: { refId: "A", datasource: POSTGRES, format: "table", rawQuery: true, editorMode: "code", rawSql } },
      { refId: "B", relativeTimeRange: { from: 0, to: 0 }, datasourceUid: EXPRESSION.uid, model: { refId: "B", datasource: EXPRESSION, type: "math", expression: `$A ${comparison}` } },
    ],
    /* Nothing asked in the window is nothing to warn about; a query that fails is. */
    noDataState: "OK",
    execErrState: "Error",
    for: "0s",
    labels: { severity },
    annotations: { summary },
    isPaused: false,
  };
}

/** The five rules of § 5.4: four warnings on the assistant's series and the job, and the page on a detected secret (35d). */
export function assistantAlerts(sqlOf: (name: SeriesName) => string = seriesSql): Json {
  return {
    apiVersion: 1,
    groups: [
      {
        orgId: 1,
        name: "assistant",
        folder: "Harness Bible",
        /* Grafana's own default for a rule group; the windows are in the queries. */
        interval: "1m",
        rules: [
          sqlRule("hb-first-token-p95", "first-token p95 above 2 s over the last hour", "The 95th percentile of the time to the first token passed two seconds over the last hour (architecture § 8).", alertSql("first-token-p95", {}, sqlOf), HOUR_S, `> ${String(FIRST_TOKEN_P95_MS)}`),
          sqlRule("hb-refusal-rate", "a refusal cause above 20 % of turns over the last day", "One refusal cause accounts for more than a fifth of the last day's turns.", alertSql("refusal-rate", { except: "any" }, sqlOf), DAY_S, `> ${String(REFUSAL_RATE_CEILING)}`),
          sqlRule("hb-citation-rate", "citation rate below 90 % over the last day", "Fewer than nine in ten of the last day's answers carry a citation on every claim.", alertSql("citation-rate", {}, sqlOf), DAY_S, `< ${String(CITATION_RATE_FLOOR)}`),
          {
            uid: "hb-purge-absent",
            title: "no purge run in two days",
            condition: "B",
            data: [
              {
                refId: "A",
                relativeTimeRange: { from: PURGE_ABSENT_S, to: 0 },
                datasourceUid: LOKI.uid,
                model: { refId: "A", datasource: LOKI, editorMode: "code", queryType: "instant", instant: true, expr: `sum(count_over_time(${PURGE_RUNS} [2d]))` },
              },
              { refId: "B", relativeTimeRange: { from: 0, to: 0 }, datasourceUid: EXPRESSION.uid, model: { refId: "B", datasource: EXPRESSION, type: "math", expression: "$A < 1" } },
            ],
            /* No line at all in two days is the alert itself: the job did not run, or ran and failed twice. */
            noDataState: "Alerting",
            execErrState: "Error",
            for: "0s",
            labels: { severity: "warn" },
            annotations: { summary: "The nightly retention job has written no successful line in two days: message text older than 30 days is not being cleared (architecture § 4.4)." },
            isPaused: false,
          },
          {
            uid: "hb-secret-detected",
            title: "a secret was found in a log line",
            condition: "B",
            data: [
              {
                refId: "A",
                /* A day: the longest window § 5.4 gives a rule, so a finding stays in front of someone until it is a day old. */
                relativeTimeRange: { from: DAY_S, to: 0 },
                datasourceUid: LOKI.uid,
                model: { refId: "A", datasource: LOKI, editorMode: "code", queryType: "instant", instant: true, expr: `sum(count_over_time(${SECRET_LINES} [1d]))` },
              },
              { refId: "B", relativeTimeRange: { from: 0, to: 0 }, datasourceUid: EXPRESSION.uid, model: { refId: "B", datasource: EXPRESSION, type: "math", expression: "$A > 0" } },
            ],
            /* No such line is the state the product is built to stay in. */
            noDataState: "OK",
            execErrState: "Error",
            for: "0s",
            /* The one rule that pages (§ 5.4; architecture § 9: the required count is zero, alert on any hit). */
            labels: { severity: "page" },
            annotations: { summary: "The guard replaced a secret in a log line. The value did not leave the process, but a line holds no text, so something upstream wrote a secret where none belongs: find the line by its trace id and fix its source." },
            isPaused: false,
          },
        ],
      },
    ],
  };
}

/** The two files as they are written: two-space JSON with a trailing newline. */
export function generated(sqlOf: (name: SeriesName) => string = seriesSql): { readonly dashboard: string; readonly alerts: string } {
  return { dashboard: `${JSON.stringify(assistantDashboard(sqlOf), null, 2)}\n`, alerts: `${JSON.stringify(assistantAlerts(sqlOf), null, 2)}\n` };
}
