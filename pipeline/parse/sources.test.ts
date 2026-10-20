import { describe, expect, it } from "vitest";

import { parseChapterFile } from "./chapterFile";
import { CH21_FILE, fixture } from "./fixtures";
import { extractLink, parseSourceRows, sourceRowSpans, tierFromCell, verifiedDate } from "./sources";

describe("sources", () => {
  const layer9 = parseChapterFile(CH21_FILE, fixture(CH21_FILE)).layers[8].markdown;

  it("reads the ten rows of 21.9 with their tiers", () => {
    const rows = parseSourceRows(layer9, null);
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows.map((r) => r.tier)).toEqual(["VENDOR", "VENDOR", "VENDOR", "PRIMARY", "PRACTITIONER", "PRACTITIONER", "VENDOR", "DERIVED", "ILLUSTRATIVE", "OPEN"]);
    expect(rows[3].citation).toBe('Garcia-Molina & Salem, "Sagas," SIGMOD 1987');
    expect(rows[0].claim).toBe("Workflows, activities, event history, replay, signals, timers, retry policies");
    expect(rows[0].verifiedAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("takes the registry's date when given", () => {
    const rows = parseSourceRows(layer9, new Date(Date.UTC(2026, 8, 21)));
    expect(rows[0].verifiedAt.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("maps tier cells and dates", () => {
    expect(tierFromCell("vendor")).toBe("VENDOR");
    expect(tierFromCell("primary (peer reviewed)")).toBe("PRIMARY");
    expect(tierFromCell("derived from derive.py")).toBe("DERIVED");
    expect(tierFromCell("scenario")).toBe("ILLUSTRATIVE");
    expect(tierFromCell("none found")).toBe("OPEN");
    expect(verifiedDate("Sep 2026", null).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(verifiedDate("Nov 2025", null).toISOString()).toBe("2025-11-01T00:00:00.000Z");
  });

  it("flags fast-moving claims and honours overrides (D6)", () => {
    const md = "| # | Claim or figure | Source | Tier | Verified |\n|---|---|---|---|---|\n| 1 | Price per M tokens | Vendor price page | vendor | Sep 2026 |\n| 2 | Sagas | Paper 1987 | primary | Sep 2026 |\n";
    const rows = parseSourceRows(md, null);
    expect(rows.map((r) => r.fastMoving)).toEqual([true, false]);
    const forced = parseSourceRows(md, null, new Map([[2, true]]));
    expect(forced[1].fastMoving).toBe(true);
  });

  it("extracts a link and a DOI from the source cell (the fallback forms)", () => {
    const md = "| # | Claim | Source | Tier | Verified |\n|---|---|---|---|---|\n| 1 | x | [Temporal docs](https://docs.temporal.io/) | vendor | Sep 2026 |\n| 2 | y | Paper, doi 10.1145/38713.38742 | primary | Sep 2026 |\n| 3 | z | See (https://example.org/a). | vendor | Sep 2026 |\n";
    const rows = parseSourceRows(md, null);
    expect(rows[0].url).toBe("https://docs.temporal.io/");
    expect(rows[0].citation).toBe("Temporal docs");
    expect(rows[1].url).toBeNull();
    expect(rows[1].doi).toBe("10.1145/38713.38742");
    expect(rows[2].url).toBe("https://example.org/a");
  });

  it("reads the book's sixth Link column: URL, doi.org, dash, repository path (feature-specs/10 § 4)", () => {
    const md = [
      "| # | Claim or figure | Source | Tier | Verified | Link |",
      "|---|---|---|---|---|---|",
      "| 1 | a | Temporal documentation | vendor | Sep 2026 | https://docs.temporal.io/ |",
      "| 4 | b | Garcia-Molina & Salem, \"Sagas,\" SIGMOD 1987 | primary | Sep 2026 | https://doi.org/10.1145/38713.38742 |",
      "| 8 | c | `labs/ch21-control-plane/derive.py` | derived | Sep 2026 | labs/ch21-control-plane/derive.py |",
      "| 9 | d | Scenario and assumptions | illustrative / scenario | Sep 2026 | — |",
      "| 10 | e | None found | open | Sep 2026 |  |",
      "| 11 | f | [Docs](https://fallback.example/) | vendor | Sep 2026 | — |",
      "| 12 | g | Paper | primary | Sep 2026 | doi:10.5555/1.2 |",
      "| 13 | h | Page | vendor | Sep 2026 | [x](https://md.example/page) |",
    ].join("\n");
    const rows = parseSourceRows(md, null, new Map(), 21);
    expect(rows.map((r) => r.url)).toEqual(["https://docs.temporal.io/", "https://doi.org/10.1145/38713.38742", null, null, null, "https://fallback.example/", null, "https://md.example/page"]);
    expect(rows.map((r) => r.doi)).toEqual([null, "10.1145/38713.38742", null, null, null, null, "10.5555/1.2", null]);
    expect(rows[0].citation).toBe("Temporal documentation");
  });

  it("refuses a non-http(s) or malformed target, naming the row", () => {
    const row = (link: string) => `| # | Claim | Source | Tier | Verified | Link |\n|---|---|---|---|---|---|\n| 3 | x | Stripe | vendor | Sep 2026 | ${link} |\n`;
    expect(() => parseSourceRows(row("javascript:alert(1)"), null, new Map(), 21)).toThrow(/chapter 21: 21\.9 r3: source link must be http\(s\), got "javascript:"/);
    expect(() => parseSourceRows(row("data:text/html,hi"), null, new Map(), 21)).toThrow(/got "data:"/);
    expect(() => parseSourceRows(row("ftp://files.example/x"), null, new Map(), 21)).toThrow(/got "ftp:"/);
    expect(() => parseSourceRows(row("https://exa mple"), null, new Map(), 21)).toThrow(/not a valid URL/);
    const inSource = "| # | Claim | Source | Tier | Verified |\n|---|---|---|---|---|\n| 2 | x | [Docs](javascript:alert(1)) | vendor | Sep 2026 |\n";
    expect(() => parseSourceRows(inSource, null)).toThrow(/r2: source link must be http\(s\)/);
  });

  it("knows where each row it reads sits, line and cells, in the order it reads them (feature-specs/33 § 4.1)", () => {
    const spans = sourceRowSpans(layer9);
    expect(spans.map((r) => r.ordinal)).toEqual(parseSourceRows(layer9, null).map((r) => r.ordinal));
    for (const row of spans) {
      const line = layer9.slice(row.line.from, row.line.to);
      expect(line.trim().startsWith(`| ${String(row.ordinal)} |`)).toBe(true);
      expect(row.cells.map((c) => layer9.slice(c.from, c.to))).toEqual(line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
    }
    const md = ["| # | Claim | Source | Tier | Verified | Link |", "|---|---|---|---|---|---|", "  | 3 |  x y | Paper |primary| Sep 2026 |  |", "| x | not a row | | | | |", "| 4 | z | Page | vendor | Sep 2026 | — |"].join("\r\n");
    const [three, four] = sourceRowSpans(md);
    expect(three.cells.map((c) => md.slice(c.from, c.to))).toEqual(["3", "x y", "Paper", "primary", "Sep 2026", ""]);
    expect(md.slice(three.line.from, three.line.to)).toBe("  | 3 |  x y | Paper |primary| Sep 2026 |  |");
    expect(md.slice(four.cells[5].from, four.cells[5].to)).toBe("—");
    expect(sourceRowSpans("No table here.")).toEqual([]);
  });

  it("extractLink: the link cell wins over the source cell; a doi.org link is also a DOI", () => {
    expect(extractLink("https://a.example/", "[Docs](https://b.example/)", "r1")).toEqual({ url: "https://a.example/", doi: null });
    expect(extractLink(null, "Paper https://doi.org/10.1000/xyz123.", "r1")).toEqual({ url: "https://doi.org/10.1000/xyz123", doi: "10.1000/xyz123" });
    expect(extractLink("—", "Nothing here", "r1")).toEqual({ url: null, doi: null });
    expect(extractLink("labs/ch21-control-plane/derive.py", "derive.py", "r1")).toEqual({ url: null, doi: null });
  });
});
