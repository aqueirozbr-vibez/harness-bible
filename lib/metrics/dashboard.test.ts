import { describe, expect, it } from "vitest";

import { SERIES, seriesSql, type SeriesName } from "./assistant";
import {
  alertSql,
  assistantAlerts,
  assistantDashboard,
  CITATION_RATE_FLOOR,
  DASHBOARD_TITLE,
  DASHBOARD_UID,
  descriptionOf,
  fileSqlOf,
  FIRST_TOKEN_P95_MS,
  generated,
  grafanaSql,
  panelSql,
  PURGE_ABSENT_S,
  PURGE_LINES,
  REFUSAL_RATE_CEILING,
  SECRET_LINES,
} from "./dashboard";

/*
 * The dashboard and its alert rules, generated from the statements (feature-specs/21 § 5.3, § 5.4, § 13.5): that a
 * panel's and a rule's query is its file, that the thresholds are the spec's, and what the documents hold. That the
 * files in the repository are what this produces is tests/observability.test.ts's; that Grafana takes them is
 * checked by running it.
 */

interface Target {
  readonly datasource: { readonly uid: string };
  readonly rawSql?: string;
  readonly expr?: string;
  readonly format?: string;
}
interface Panel {
  readonly id: number;
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly datasource: { readonly uid: string };
  readonly targets: ReadonlyArray<Target>;
  readonly fieldConfig?: { readonly defaults: { readonly unit: string } };
}
interface Dashboard {
  readonly uid: string;
  readonly title: string;
  readonly timezone: string;
  readonly editable: boolean;
  readonly time: { readonly from: string; readonly to: string };
  readonly panels: ReadonlyArray<Panel>;
}
interface Rule {
  readonly uid: string;
  readonly title: string;
  readonly condition: string;
  readonly noDataState: string;
  readonly execErrState: string;
  readonly labels: { readonly severity: string };
  readonly data: ReadonlyArray<{ readonly refId: string; readonly relativeTimeRange: { readonly from: number; readonly to: number }; readonly datasourceUid: string; readonly model: { readonly rawSql?: string; readonly expr?: string; readonly expression?: string } }>;
}
interface Alerts {
  readonly apiVersion: number;
  readonly groups: ReadonlyArray<{ readonly name: string; readonly folder: string; readonly interval: string; readonly rules: ReadonlyArray<Rule> }>;
}

const dashboard = assistantDashboard() as unknown as Dashboard;
const alerts = assistantAlerts() as unknown as Alerts;
const rules = alerts.groups[0]?.rules ?? [];
const NAMES = SERIES.map((series) => series.name);
/** Which statement a query holds: the one whose text it wraps. */
const seriesOf = (rawSql: string): SeriesName | undefined => NAMES.find((name) => fileSqlOf(rawSql) === seriesSql(name));

describe("a statement as Grafana runs it", () => {
  it("swaps the three parameters for Grafana's own and touches nothing else", () => {
    const sql = "-- a note\nSELECT date_trunc($3::text, t) AS bucket FROM x WHERE t >= $1::timestamp AND t < $2::timestamp\n";
    expect(grafanaSql(sql, "day")).toBe("-- a note\nSELECT date_trunc('day'::text, t) AS bucket FROM x WHERE t >= $__timeFrom()::timestamp AND t < $__timeTo()::timestamp");
    expect(grafanaSql(sql, "millennium")).toContain("date_trunc('millennium'::text, t)");
  });

  it.each(NAMES)("%s: the panel's and the rule's query hold the file's text, whole", (name) => {
    for (const bucket of ["day", "month"] as const) expect(fileSqlOf(panelSql(name, bucket))).toBe(seriesSql(name));
    expect(fileSqlOf(panelSql(name, "day", { only: "any" }))).toBe(seriesSql(name));
    expect(fileSqlOf(alertSql(name, { except: "any" }))).toBe(seriesSql(name));
    expect(grafanaSql(seriesSql(name), "day")).not.toMatch(/\$[123]\b/);
  });

  it("names the columns a panel wants around the statement, and filters a keyed series outside it", () => {
    expect(panelSql("grounded", "day")).toMatch(/^SELECT s\.bucket AS "time", s\.key AS metric, s\.value\nFROM \(\n/);
    expect(panelSql("grounded", "day")).toMatch(/\n\) s\nORDER BY 1$/);
    expect(panelSql("purge", "day", { as: "purge" })).toMatch(/^SELECT s\.bucket AS "time", s\.value AS "purge"\nFROM \(\n/);
    expect(panelSql("flag-rate", "month", { only: "any" })).toMatch(/\n\) s\nWHERE s\.key = 'any'\nORDER BY 1$/);
    expect(alertSql("refusal-rate", { except: "any" })).toMatch(/^SELECT s\.key AS metric, s\.value\nFROM \(\n[\s\S]+\n\) s\nWHERE s\.key <> 'any'$/);
  });

  it("describes a panel with the statement's own header, without the parameters line", () => {
    const description = descriptionOf(seriesSql("citation-rate"));
    expect(description).toMatch(/^citation rate: of the answers that made claims/);
    expect(description).toContain("is outside the rate.");
    expect(description).not.toContain("Parameters:");
    expect(description).not.toContain("--");
  });
});

describe("the dashboard", () => {
  it("is the architecture's dashboard, in UTC, over the month to date, and not editable in place", () => {
    expect(dashboard).toMatchObject({ uid: DASHBOARD_UID, title: DASHBOARD_TITLE, timezone: "utc", editable: false, time: { from: "now/M", to: "now" } });
    expect(DASHBOARD_TITLE).toBe("Assistant citation and flag rate");
    expect(new Set(dashboard.panels.map((panel) => panel.id)).size).toBe(dashboard.panels.length);
  });

  it("has one panel by day per series, in the series' order, each running its own file", () => {
    const series = dashboard.panels.filter((panel) => panel.type === "timeseries");
    expect(series.map((panel) => panel.title)).toEqual(SERIES.map((entry) => entry.title));
    expect(series.map((panel) => seriesOf(panel.targets[0]?.rawSql ?? ""))).toEqual(NAMES);
    for (const panel of series) {
      expect(panel.targets[0]?.rawSql).toContain("date_trunc('day'::text,");
      expect(panel.targets[0]).toMatchObject({ format: "time_series", datasource: { uid: "hb-postgres" } });
      expect(panel.description.length).toBeGreaterThan(40);
    }
    expect(series.map((panel) => panel.fieldConfig?.defaults.unit)).toEqual(["percentunit", "percentunit", "percentunit", "ms", "none", "currencyUSD", "percentunit", "percentunit", "none"]);
  });

  it("heads with the four numbers of the architecture's row, by month, the keyed two as their `any` line", () => {
    const stats = dashboard.panels.filter((panel) => panel.type === "stat");
    expect(stats.map((panel) => `${panel.title} = ${seriesOf(panel.targets[0]?.rawSql ?? "") ?? "?"}`)).toEqual(["citation rate = citation-rate", "flag rate = flag-rate", "refusal rate = refusal-rate", "first-token p95 = first-token-p95"]);
    for (const panel of stats) expect(panel.targets[0]?.rawSql).toContain("date_trunc('month'::text,");
    expect(stats.filter((panel) => panel.targets[0]?.rawSql?.includes("WHERE s.key = 'any'")).map((panel) => panel.title)).toEqual(["flag rate", "refusal rate"]);
  });

  it("shows the purge's own job lines from Loki, where the count of messages a run cleared lives", () => {
    const logs = dashboard.panels.filter((panel) => panel.type === "logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.targets[0]).toMatchObject({ datasource: { uid: "hb-loki" }, expr: PURGE_LINES });
    expect(PURGE_LINES).toBe('{service_name="hb-lines"} | kind="job" | job="assistant:purge"');
  });

  it("runs nothing but the statements: every SQL query of every panel is one of the files", () => {
    const queries = dashboard.panels.flatMap((panel) => panel.targets).flatMap((target) => (target.rawSql === undefined ? [] : [target.rawSql]));
    /* Four headline numbers and the nine series. */
    expect(queries).toHaveLength(13);
    for (const rawSql of queries) expect(seriesOf(rawSql), rawSql.slice(0, 80)).toBeDefined();
  });
});

describe("the alert rules", () => {
  it("are the five of the spec, in one group evaluated at Grafana's default interval", () => {
    expect(alerts.apiVersion).toBe(1);
    expect(alerts.groups).toHaveLength(1);
    expect(alerts.groups[0]).toMatchObject({ name: "assistant", folder: "Harness Bible", interval: "1m" });
    expect(rules.map((rule) => rule.uid)).toEqual(["hb-first-token-p95", "hb-refusal-rate", "hb-citation-rate", "hb-purge-absent", "hb-secret-detected"]);
    /* Four warn; the detected secret is the one that pages (§ 5.4). */
    expect(rules.map((rule) => rule.labels.severity)).toEqual(["warn", "warn", "warn", "warn", "page"]);
    expect(rules.every((rule) => rule.condition === "B" && rule.execErrState === "Error")).toBe(true);
  });

  it("carries the spec's thresholds and windows, and no others", () => {
    expect([FIRST_TOKEN_P95_MS, REFUSAL_RATE_CEILING, CITATION_RATE_FLOOR, PURGE_ABSENT_S]).toEqual([2000, 0.2, 0.9, 172_800]);
    expect(rules.map((rule) => `${String(rule.data[0]?.relativeTimeRange.from)} s · ${rule.data[1]?.model.expression ?? ""}`)).toEqual([
      "3600 s · $A > 2000",
      "86400 s · $A > 0.2",
      "86400 s · $A < 0.9",
      "172800 s · $A < 1",
      "86400 s · $A > 0",
    ]);
  });

  it("asks each statement for its whole window as one row, the refusal rule per cause", () => {
    const sql = rules.slice(0, 3).map((rule) => rule.data[0]?.model.rawSql ?? "");
    expect(sql.map(seriesOf)).toEqual(["first-token-p95", "refusal-rate", "citation-rate"]);
    for (const rawSql of sql) expect(rawSql).toContain("date_trunc('millennium'::text,");
    expect(sql.map((rawSql) => rawSql.endsWith("WHERE s.key <> 'any'"))).toEqual([false, true, false]);
    expect(rules.slice(0, 3).every((rule) => rule.data[0]?.datasourceUid === "hb-postgres" && rule.noDataState === "OK")).toBe(true);
  });

  it("treats two days without a successful purge line as the alert, and a failed run as no run", () => {
    const purge = rules[3];
    expect(purge?.data[0]).toMatchObject({ datasourceUid: "hb-loki", model: { expr: `sum(count_over_time(${PURGE_LINES} | error="" [2d]))` } });
    expect(purge?.noDataState).toBe("Alerting");
  });

  it("pages on any line the guard found a secret in, and is quiet when there is none", () => {
    const secret = rules[4];
    expect(SECRET_LINES).toBe('{service_name="hb-lines"} | hb_secret_detected="true"');
    expect(secret?.data[0]).toMatchObject({ datasourceUid: "hb-loki", model: { expr: `sum(count_over_time(${SECRET_LINES} [1d]))` } });
    expect(secret?.noDataState).toBe("OK");
  });
});

describe("the two files", () => {
  it("are the documents as two-space JSON with a trailing newline, the same on every run", () => {
    const first = generated();
    expect(first).toEqual(generated());
    expect(JSON.parse(first.dashboard)).toEqual(assistantDashboard());
    expect(JSON.parse(first.alerts)).toEqual(assistantAlerts());
    expect(first.dashboard.endsWith("}\n") && first.alerts.endsWith("}\n")).toBe(true);
  });

  it("follow the statement a caller hands in, so a changed file is a changed query", () => {
    const changed = generated((name) => `${seriesSql(name).trimEnd()}\n-- changed\n`);
    expect(changed.dashboard).not.toBe(generated().dashboard);
    expect(changed.dashboard).toContain("-- changed");
    expect(changed.alerts).toContain("-- changed");
  });
});
