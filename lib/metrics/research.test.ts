import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { monthWindow, type MetricQuery } from "./assistant";
import { RESEARCH_SERIES, RESEARCH_SQL_DIR, researchMetrics, researchSql, researchTitleOf, runResearchSeries } from "./research";

/*
 * The researcher's series in code (feature-specs/44 § 4; unit 61a). The statements run against the database as the
 * dashboard's role in tests/integration/observability.test.ts; here, what needs none: one file a series, a statement
 * that can only read, takes the window and the bucket, returns the five columns, and reads the three research views and
 * nothing else — so no reader's row, no ledger payload and no run's id beyond the spend's.
 */

const code = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

describe("the statements of lib/metrics/sql/research", () => {
  it("has one file per series and no file without one", () => {
    const files = readdirSync(RESEARCH_SQL_DIR).filter((file) => file.endsWith(".sql")).sort();
    expect(files).toEqual(RESEARCH_SERIES.map((series) => `${series.name}.sql`).sort());
  });

  it.each(RESEARCH_SERIES.map((series) => series.name))("%s only reads, and takes the window and the bucket as its three parameters", (name) => {
    const sql = researchSql(name);
    const body = code(sql);
    expect(body.trimStart()).toMatch(/^(SELECT|WITH)\b/);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|COPY|CALL|DO)\b/i);
    expect(body).not.toContain(";");
    expect(new Set(body.match(/\$\d+(::\w+)?/g) ?? [])).toEqual(new Set(["$1::timestamp", "$2::timestamp", "$3::text"]));
    expect(sql.split("\n").filter((line) => line.trimStart().startsWith("--")).join("\n")).not.toContain("$");
    for (const column of ["bucket", "key", "n", "d", "value"]) expect(body).toMatch(new RegExp(`\\b${column}\\b`));
  });

  it.each(RESEARCH_SERIES.map((series) => series.name))("%s reads the three research views and no table, and no reader", (name) => {
    const body = code(researchSql(name));
    const read = [...body.matchAll(/(?:FROM|JOIN) "(\w+)"/g)].map((match) => match[1] ?? "");
    expect(read.length).toBeGreaterThan(0);
    for (const relation of read) expect(["ResearchFact", "ResearchSpend", "ResearchFlag"]).toContain(relation);
    expect(body).not.toMatch(/"ResearchRun"|"ResearchFinding"|"LedgerRecord"|"Message"|"userId"|"email"|"payload"|"traceId"/);
  });
});

describe("runResearchSeries", () => {
  it("runs the file's own text by day and by month, in its unit", async () => {
    const calls: Array<{ sql: string; bucket: string }> = [];
    const query: MetricQuery = (sql, _from, _to, bucket) => {
      calls.push({ sql, bucket });
      return Promise.resolve(bucket === "day" ? [{ bucket: new Date("2026-10-10T00:00:00Z"), key: "DONE", n: 2, d: null, value: 2 }] : [{ bucket: new Date("2026-10-01T00:00:00Z"), key: "all", n: 3, d: null, value: 3 }]);
    };
    const series = await runResearchSeries("runs", monthWindow("2026-10"), query);
    expect(calls.map((call) => call.bucket).sort()).toEqual(["day", "month"]);
    expect(calls.every((call) => call.sql === researchSql("runs"))).toBe(true);
    expect(series).toMatchObject({ series: "runs", unit: "count", points: [{ bucket: "2026-10-10", key: "DONE", n: 2, value: 2 }], months: [{ bucket: "2026-10", key: "all", value: 3 }] });
    expect((await runResearchSeries("cost-per-run", monthWindow("2026-10"), () => Promise.resolve([]))).unit).toBe("usd");
    expect((await runResearchSeries("proposals", monthWindow("2026-10"), () => Promise.resolve([]))).unit).toBe("share");
  });

  it("runs every series in the dashboard's order, and names each for the table", async () => {
    const all = await researchMetrics(monthWindow("2026-10"), () => Promise.resolve([]));
    expect(all.map((series) => series.series)).toEqual(["runs", "findings", "cost-per-run", "proposals", "cap", "flags"]);
    expect(researchTitleOf("cap")).toBe("research calls refused at the cap");
    expect(researchTitleOf("flags")).toBe("research flags by reason");
    expect(researchTitleOf("nothing")).toBe("nothing");
  });
});
