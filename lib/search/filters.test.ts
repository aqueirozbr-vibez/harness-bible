import { describe, expect, it } from "vitest";

import { activeFilterCount, DEFAULT_N, EMPTY_FILTERS, MAX_N, parseSearchParams, searchHref, toggled, toSearchParams } from "./filters";

describe("search filters (06 § 5.1)", () => {
  it("parses a typed URL, drops unknown values and dedupes", () => {
    const f = parseSearchParams(new URLSearchParams("q=+idempotency+&part=P2&part=P9&layer=2&layer=2&layer=x&tier=VENDOR&tier=nope&age=stale&type=lab&sort=book&n=23"));
    expect(f).toEqual({ q: "idempotency", part: ["P2"], layer: [2], tier: ["VENDOR"], age: ["stale"], type: ["lab"], sort: "book", n: 23 });
  });

  it("falls back to defaults and clamps", () => {
    expect(parseSearchParams({})).toEqual(EMPTY_FILTERS);
    expect(parseSearchParams({ sort: "weird", n: "0" }).sort).toBe("relevance");
    expect(parseSearchParams({ n: "0" }).n).toBe(1);
    expect(parseSearchParams({ n: "9999" }).n).toBe(MAX_N);
    expect(parseSearchParams({ n: "abc" }).n).toBe(DEFAULT_N);
    expect(parseSearchParams({ q: "x".repeat(300) }).q).toHaveLength(200);
    expect(parseSearchParams({ layer: ["3", "1"] }).layer).toEqual([3, 1]);
  });

  it("round-trips and omits defaults", () => {
    const f = parseSearchParams(new URLSearchParams("q=idempotency&layer=2&tier=VENDOR&sort=verified&n=23"));
    expect(parseSearchParams(toSearchParams(f))).toEqual(f);
    expect(toSearchParams(EMPTY_FILTERS).toString()).toBe("");
    expect(searchHref("en", { ...EMPTY_FILTERS, q: "idempotency" })).toBe("/en/search?q=idempotency");
    expect(searchHref("pt", EMPTY_FILTERS)).toBe("/pt/search");
    expect(searchHref("en", f, { n: f.n + 15 })).toContain("n=38");
  });

  it("toggles a value and resets paging; counts active filters", () => {
    const f = { ...EMPTY_FILTERS, q: "x", layer: [2] as const, n: 23 };
    expect(toggled(f, "layer", 3).layer).toEqual([2, 3]);
    expect(toggled(f, "layer", 2).layer).toEqual([]);
    expect(toggled(f, "layer", 3).n).toBe(DEFAULT_N);
    expect(activeFilterCount(toggled(f, "tier", "DERIVED"))).toBe(2);
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
  });
});
