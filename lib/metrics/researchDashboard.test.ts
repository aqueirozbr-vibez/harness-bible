import { describe, expect, it } from "vitest";

import { fileSqlOf } from "./dashboard";
import { RESEARCH_SERIES, researchSql } from "./research";
import { generatedResearch, RESEARCH_CAP_RULE_UID, RESEARCH_RUN_LINES, researchAlerts, researchDashboard } from "./researchDashboard";

/*
 * The dashboard "Research" and its rule, generated from the statements (feature-specs/44 § 4; unit 61a): that every
 * PostgreSQL query is its file's text with Grafana's parameters, that the runs' lines come from Loki, and that the one
 * rule reads the cap's line before the twentieth as information.
 */

interface Panel {
  readonly id: number;
  readonly type: string;
  readonly title: string;
  readonly datasource: { readonly uid: string };
  readonly targets: ReadonlyArray<{ readonly rawSql?: string; readonly expr?: string }>;
}
interface Rule {
  readonly uid: string;
  readonly labels: { readonly severity: string };
  readonly data: ReadonlyArray<{ readonly relativeTimeRange: { readonly from: number }; readonly model: { readonly rawSql?: string; readonly expression?: string } }>;
}

const dashboard = researchDashboard() as unknown as { readonly uid: string; readonly panels: ReadonlyArray<Panel> };
const alerts = researchAlerts() as unknown as { readonly groups: ReadonlyArray<{ readonly name: string; readonly rules: ReadonlyArray<Rule> }> };

describe("the dashboard Research", () => {
  it("draws every series by day, and three numbers of the range by month, each query its file's text", () => {
    const postgres = dashboard.panels.filter((panel) => panel.datasource.uid === "hb-postgres");
    expect(postgres.filter((panel) => panel.type === "timeseries").map((panel) => panel.title)).toEqual(RESEARCH_SERIES.map((series) => series.title));
    expect(postgres.filter((panel) => panel.type === "stat").map((panel) => panel.title)).toEqual(["runs that reached the planner", "cost per run", "proposals accepted by curators"]);
    const files = new Set(RESEARCH_SERIES.map((series) => researchSql(series.name)));
    for (const panel of postgres) expect(files.has(fileSqlOf(panel.targets[0]?.rawSql ?? "")), panel.title).toBe(true);
    expect(postgres.find((panel) => panel.title === "proposals accepted by curators")?.targets[0]?.rawSql).toMatch(/WHERE s\.key = 'ACCEPT'\nORDER BY 1$/);
    expect(postgres.find((panel) => panel.title === "runs that reached the planner")?.targets[0]?.rawSql).toContain("'month'::text");
  });

  it("counts every run's end from its research.run line in Loki, the hand-over's skips included", () => {
    const lines = dashboard.panels.find((panel) => panel.datasource.uid === "hb-loki");
    expect(lines?.targets[0]?.expr).toBe(`sum by (outcome, code) (count_over_time(${RESEARCH_RUN_LINES} [$__auto]))`);
    expect(RESEARCH_RUN_LINES).toContain('kind="research"');
  });

  it("has one rule: the cap's line before the twentieth, over the last two days of day-dated rows, as information", () => {
    expect(alerts.groups.map((group) => group.name)).toEqual(["research"]);
    const rules = alerts.groups[0]?.rules ?? [];
    expect(rules.map((rule) => rule.uid)).toEqual([RESEARCH_CAP_RULE_UID]);
    expect(rules[0]?.labels.severity).toBe("info");
    expect(rules[0]?.data[0]?.relativeTimeRange.from).toBe(2 * 86_400);
    expect(fileSqlOf(rules[0]?.data[0]?.model.rawSql ?? "")).toBe(researchSql("cap"));
    expect(rules[0]?.data[0]?.model.rawSql).toMatch(/WHERE s\.key = 'before-20th'$/);
    expect(rules[0]?.data[1]?.model.expression).toBe("$A > 0");
  });

  it("is generated the same way twice, and changes with a statement", () => {
    expect(generatedResearch()).toEqual(generatedResearch());
    expect(JSON.parse(generatedResearch().dashboard)).toEqual(researchDashboard());
    expect(generatedResearch((name) => `${researchSql(name).trimEnd()}\n-- changed\n`).dashboard).not.toBe(generatedResearch().dashboard);
  });
});
