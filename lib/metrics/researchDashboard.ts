import { alertSqlOf, DAY_S, descriptionOf, GRAFANA_UNIT, LOKI, panelSqlOf, POSTGRES, sqlRule, sqlTarget, type Json, type Place, type Wrap } from "@/lib/metrics/dashboard";
import { RESEARCH_SERIES, researchSql, type ResearchSeriesName } from "@/lib/metrics/research";
import type { MetricUnit } from "@/lib/schemas/metrics";

/*
 * The Grafana dashboard "Research" and its one alert (feature-specs/44 § 4; unit 61a), built from the statements of
 * `lib/metrics/sql/research/` as the assistant's are from theirs (lib/metrics/dashboard.ts): pure, the statements in,
 * two JSON documents out, written by `npm run observe:generate` and compared by a test with what is in the repository.
 *
 * Three numbers for the range, a panel per series by day, and the runs' own lines from Loki — the one place a turn the
 * hand-over skipped is counted, since such a run has no record. The alert is information, not an incident: the
 * month's research spent before its twentieth day, which the cap then holds until the reset.
 */

export const RESEARCH_DASHBOARD_UID = "hb-research";
export const RESEARCH_DASHBOARD_TITLE = "Research";
export const RESEARCH_CAP_RULE_UID = "hb-research-cap";

/** Every research run's end as its line says it, the hand-over's skips included (lib/telemetry/lines.ts `research.run`). */
export const RESEARCH_RUN_LINES = '{service_name="hb-lines"} | kind="research" | stage="run"';

/** Which series have a line per key, and which one value (named after the series). */
const KEYED: ReadonlySet<ResearchSeriesName> = new Set<ResearchSeriesName>(["runs", "findings", "proposals", "cap", "flags"]);

function statPanel(id: number, place: Place, title: string, name: ResearchSeriesName, unit: MetricUnit, wrap: Wrap, sqlOf: (name: ResearchSeriesName) => string): Json {
  return {
    id,
    type: "stat",
    title,
    description: `${descriptionOf(sqlOf(name))} Over the dashboard's range, by month: with the default range, the month to date.`,
    datasource: POSTGRES,
    gridPos: place,
    targets: [sqlTarget(panelSqlOf(sqlOf(name), "month", wrap))],
    fieldConfig: { defaults: { unit: GRAFANA_UNIT[unit], decimals: unit === "share" ? 1 : unit === "usd" ? 2 : 0, thresholds: { mode: "absolute", steps: [{ color: "text", value: null }] } }, overrides: [] },
    options: { reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false }, colorMode: "value", graphMode: "none", textMode: "value" },
  };
}

function seriesPanel(id: number, place: Place, name: ResearchSeriesName, title: string, unit: MetricUnit, sqlOf: (name: ResearchSeriesName) => string): Json {
  return {
    id,
    type: "timeseries",
    title,
    description: descriptionOf(sqlOf(name)),
    datasource: POSTGRES,
    gridPos: place,
    targets: [sqlTarget(panelSqlOf(sqlOf(name), "day", KEYED.has(name) ? {} : { as: title }))],
    fieldConfig: {
      defaults: { unit: GRAFANA_UNIT[unit], ...(unit === "share" ? { min: 0, max: 1 } : { min: 0 }), custom: { drawStyle: "line", showPoints: "always", spanNulls: true, lineWidth: 1, fillOpacity: 0 } },
      overrides: [],
    },
    options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "none" } },
  };
}

export function researchDashboard(sqlOf: (name: ResearchSeriesName) => string = researchSql): Json {
  const stats = [
    statPanel(1, { x: 0, y: 0, w: 8, h: 4 }, "runs that reached the planner", "runs", "count", { only: "all" }, sqlOf),
    statPanel(2, { x: 8, y: 0, w: 8, h: 4 }, "cost per run", "cost-per-run", "usd", { as: "cost per run" }, sqlOf),
    statPanel(3, { x: 16, y: 0, w: 8, h: 4 }, "proposals accepted by curators", "proposals", "share", { only: "ACCEPT" }, sqlOf),
  ];
  const series = RESEARCH_SERIES.map((entry, index) => seriesPanel(10 + index, { x: (index % 2) * 12, y: 4 + Math.floor(index / 2) * 8, w: 12, h: 8 }, entry.name, entry.title, entry.unit, sqlOf));
  const below = 4 + Math.ceil(RESEARCH_SERIES.length / 2) * 8;
  const lines: Json = {
    id: 30,
    type: "timeseries",
    title: "every run's end, the hand-over's skips included",
    description: "Each research run's research.run line, by how it ended and its code: the runs above and the turns the hand-over skipped before the planner (off, deduplicated, the day's limit, the cap, unavailable), which have no RESEARCH record and are counted nowhere else. The lines carry no word of a question.",
    datasource: LOKI,
    gridPos: { x: 0, y: below, w: 24, h: 8 },
    targets: [{ refId: "A", datasource: LOKI, editorMode: "code", queryType: "range", expr: `sum by (outcome, code) (count_over_time(${RESEARCH_RUN_LINES} [$__auto]))`, legendFormat: "{{outcome}} {{code}}" }],
    fieldConfig: { defaults: { unit: "none", min: 0, custom: { drawStyle: "bars", lineWidth: 1, fillOpacity: 60 } }, overrides: [] },
    options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "none" } },
  };
  return {
    uid: RESEARCH_DASHBOARD_UID,
    title: RESEARCH_DASHBOARD_TITLE,
    description: "The researcher's series, from the RESEARCH records, the curators' decisions on researchers' proposals, what research spends by run and by payer, and the flags people put on their research, through three views that name no reader (feature-specs/44 § 4, 48 § 7, § 11.7). Every query is a statement of lib/metrics/sql/research; npm run research:metrics prints the same numbers. Generated: change lib/metrics/researchDashboard.ts and run npm run observe:generate.",
    tags: ["harness-bible", "research"],
    timezone: "utc",
    editable: false,
    graphTooltip: 1,
    schemaVersion: 39,
    version: 1,
    refresh: "",
    time: { from: "now/M", to: "now" },
    panels: [...stats, ...series, lines],
  };
}

/** The one rule (44 § 4): the research principal's calls refused at its cap on a day before the month's twentieth, over the last day. */
export function researchAlerts(sqlOf: (name: ResearchSeriesName) => string = researchSql): Json {
  return {
    apiVersion: 1,
    groups: [
      {
        orgId: 1,
        name: "research",
        folder: "Harness Bible",
        interval: "1m",
        rules: [
          sqlRule(
            RESEARCH_CAP_RULE_UID,
            "research spend at its cap before the month's twentieth day",
            "The research principal's budget reached its cap before the twentieth: Improve's vetting of the findings people send waits for the month's reset, and so do the legacy runs still in flight (feature-specs/48 § 7.3). Information, not an incident (feature-specs/44 § 4); the numbers A12 to A14 and D5 may want looking at (44 § 3).",
            alertSqlOf(sqlOf("cap"), { only: "before-20th" }),
            /* two days: the rows are dated to their day, and a window of 24 hours begins after yesterday's (review of unit 61) */
            2 * DAY_S,
            "> 0",
            "info",
          ),
        ],
      },
    ],
  };
}

/** The two files as they are written: two-space JSON with a trailing newline. */
export function generatedResearch(sqlOf: (name: ResearchSeriesName) => string = researchSql): { readonly dashboard: string; readonly alerts: string } {
  return { dashboard: `${JSON.stringify(researchDashboard(sqlOf), null, 2)}\n`, alerts: `${JSON.stringify(researchAlerts(sqlOf), null, 2)}\n` };
}
