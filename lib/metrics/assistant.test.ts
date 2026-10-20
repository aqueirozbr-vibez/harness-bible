import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { MetricSeries } from "@/lib/schemas/metrics";

import { assistantMetrics, formatValue, monthWindow, runSeries, SERIES, seriesSql, SQL_DIR, tableOf, type MetricQuery } from "./assistant";

/*
 * The assistant's series in code (feature-specs/21 § 5.3). The statements themselves are checked against the
 * database in tests/integration/metrics.test.ts; here is everything that needs no database: that the files are what
 * the module says they are, that a statement can only read, and the window, the mapping and the table.
 */

const WINDOW = monthWindow("2026-09");

describe("the statements of lib/metrics/sql", () => {
  it("has one file per series and no file without one", () => {
    const files = readdirSync(SQL_DIR).filter((file) => file.endsWith(".sql")).sort();
    expect(files).toEqual(SERIES.map((series) => `${series.name}.sql`).sort());
  });

  it.each(SERIES.map((series) => series.name))("%s only reads, and takes the window and the bucket as its three parameters", (name) => {
    const sql = seriesSql(name);
    const code = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(code.trimStart()).toMatch(/^(SELECT|WITH)\b/);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|COPY|CALL|DO)\b/i);
    expect(code).not.toContain(";");
    /* Every placeholder is one of the three, each with its cast: the dashboard substitutes exactly these texts. */
    const placeholders = code.match(/\$\d+(::\w+)?/g) ?? [];
    expect(new Set(placeholders)).toEqual(new Set(["$1::timestamp", "$2::timestamp", "$3::text"]));
    /* The comments name no placeholder, so a textual substitution cannot touch them. */
    expect(sql.split("\n").filter((line) => line.trimStart().startsWith("--")).join("\n")).not.toContain("$");
    for (const column of ["bucket", "key", "n", "d", "value"]) expect(code).toMatch(new RegExp(`\\b${column}\\b`));
  });

  it.each(SERIES.map((series) => series.name))("%s returns no reader and groups by none", (name) => {
    const code = seriesSql(name).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    /* A reader appears only inside a distinct count, and a conversation only as the join that fetches the answer's
       language; a message's text and an e-mail not at all. */
    expect(code.replace(/count\(DISTINCT m\."userId"\)/g, "").replace('JOIN "Conversation" c ON c.id = m."conversationId"', "")).not.toMatch(/"userId"|"conversationId"|"email"|\.email\b|"text"|\.text\b|"claimText"/);
  });
});

describe("monthWindow", () => {
  it("is the calendar month in UTC, the end exclusive", () => {
    expect(monthWindow("2026-09")).toEqual({ from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") });
    expect(monthWindow("2026-12").to).toEqual(new Date("2027-01-01T00:00:00Z"));
  });

  it("refuses anything that is not a month", () => {
    for (const bad of ["2026-13", "2026-9", "26-09", "2026-09-01", ""]) expect(() => monthWindow(bad)).toThrow(/YYYY-MM/);
  });
});

describe("runSeries", () => {
  it("runs the file's own text twice, by day and by month, with the window as ISO instants", async () => {
    const calls: Array<{ sql: string; from: string; to: string; bucket: string }> = [];
    const query: MetricQuery = (sql, from, to, bucket) => {
      calls.push({ sql, from, to, bucket });
      const rows =
        bucket === "day"
          ? [
              { bucket: new Date("2026-09-20T00:00:00Z"), key: "", n: 3, d: 4, value: 0.75 },
              { bucket: new Date("2026-09-21T00:00:00Z"), key: "", n: 9, d: 10, value: 0.9 },
            ]
          : [{ bucket: new Date("2026-09-01T00:00:00Z"), key: "", n: 12, d: 14, value: 12 / 14 }];
      return Promise.resolve(rows);
    };

    const series = await runSeries("citation-rate", WINDOW, query);
    expect(calls.map((call) => call.bucket).sort()).toEqual(["day", "month"]);
    expect(calls.every((call) => call.sql === seriesSql("citation-rate") && call.from === "2026-09-01T00:00:00.000Z" && call.to === "2026-10-01T00:00:00.000Z")).toBe(true);
    expect(series).toEqual({
      series: "citation-rate",
      unit: "share",
      window: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
      points: [
        { bucket: "2026-09-20", key: "", n: 3, d: 4, value: 0.75 },
        { bucket: "2026-09-21", key: "", n: 9, d: 10, value: 0.9 },
      ],
      months: [{ bucket: "2026-09", key: "", n: 12, d: 14, value: 12 / 14 }],
    });
  });

  it("refuses a row that is not the five columns", async () => {
    const bigint: MetricQuery = () => Promise.resolve([{ bucket: new Date("2026-09-20T00:00:00Z"), key: "", n: BigInt(3), d: 4, value: 0.75 }]);
    await expect(runSeries("citation-rate", WINDOW, bigint)).rejects.toThrow();
    const text: MetricQuery = () => Promise.resolve([{ bucket: "2026-09-20", key: "", n: 3, d: 4, value: 0.75 }]);
    await expect(runSeries("citation-rate", WINDOW, text)).rejects.toThrow();
  });

  it("runs every series in the dashboard's order", async () => {
    const empty: MetricQuery = () => Promise.resolve([]);
    const all = await assistantMetrics(WINDOW, empty);
    expect(all.map((series) => series.series)).toEqual(SERIES.map((series) => series.name));
    expect(all.every((series) => series.points.length === 0 && series.months.length === 0)).toBe(true);
  });
});

describe("the table", () => {
  it("prints a value in its unit", () => {
    expect(formatValue("share", 0.9)).toBe("90.0 %");
    expect(formatValue("ms", 1894.6)).toBe("1895 ms");
    expect(formatValue("usd", 5.90636)).toBe("$5.9064");
    expect(formatValue("score", 0.875)).toBe("0.88");
    expect(formatValue("count", 4)).toBe("4");
    expect(formatValue("share", null)).toBe("-");
  });

  it("puts the month to date first, then the days, each with what it was computed from", () => {
    const series: MetricSeries = {
      series: "refusal-rate",
      unit: "share",
      window: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
      points: [{ bucket: "2026-09-21", key: "R-SCOPE-OT", n: 1, d: 10, value: 0.1 }],
      months: [{ bucket: "2026-09", key: "any", n: 2, d: 40, value: 0.05 }],
    };
    expect(tableOf(series)).toEqual([
      "refusal rate by cause",
      "  2026-09     any                  5.0 %   2 / 40",
      "  2026-09-21  R-SCOPE-OT          10.0 %   1 / 10",
    ]);
  });

  it("names the samples behind a percentile, the dollars behind a cost, and says when a window is empty", () => {
    const base = { window: { from: "", to: "" }, points: [] };
    expect(tableOf({ ...base, series: "first-token-p95", unit: "ms", months: [{ bucket: "2026-09", key: "", n: null, d: 12, value: 1894.6 }] })[1]).toBe("  2026-09                        1895 ms   n = 12");
    expect(tableOf({ ...base, series: "cost-per-active-account", unit: "usd", months: [{ bucket: "2026-09", key: "", n: 5.5, d: 2, value: 2.75 }] })[1]).toBe("  2026-09                        $2.7500   $5.5000 / 2");
    expect(tableOf({ ...base, series: "purge", unit: "count", months: [{ bucket: "2026-09", key: "", n: 4, d: null, value: 4 }] })[1]).toBe("  2026-09                              4");
    expect(tableOf({ ...base, series: "purge", unit: "count", months: [] })).toEqual(["purge", "  no rows in the window"]);
  });
});
