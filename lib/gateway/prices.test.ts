import { describe, expect, it } from "vitest";

import { ALIAS_PINS, costOf, EMBED_MODEL_ID, EMBED_TARGET, FRONTIER_MODEL_ID, maxBudgetUsd, MODEL_PRICES, NO_USAGE, priceFor, priceOf, PRICES_AS_OF, RERANK_MODEL_ID, SMALL_MODEL_ID, tokensOfUsd, usageOf } from "./prices";

describe("prices at the pins (feature-specs/11 § 3.2, D3)", () => {
  it("carries the spec's figures with their date", () => {
    expect(PRICES_AS_OF).toBe("2026-06-24");
    expect(MODEL_PRICES[FRONTIER_MODEL_ID]).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(MODEL_PRICES[SMALL_MODEL_ID]).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
    expect(MODEL_PRICES[FRONTIER_MODEL_ID].cacheWrite).toBe(MODEL_PRICES[FRONTIER_MODEL_ID].input * 1.25);
    expect(MODEL_PRICES[SMALL_MODEL_ID].cacheWrite).toBe(MODEL_PRICES[SMALL_MODEL_ID].input * 1.25);
  });

  it("costs a usage block at each alias, each rate on its own count", () => {
    const frontier = priceOf(FRONTIER_MODEL_ID);
    expect(costOf(frontier, { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toBe(5);
    expect(costOf(frontier, { input_tokens: 0, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toBe(25);
    expect(costOf(frontier, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 0 })).toBe(6.25);
    expect(costOf(frontier, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBe(0.5);
    const small = priceOf(SMALL_MODEL_ID);
    expect(costOf(small, { input_tokens: 4, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toBeCloseTo(0.000079, 9);
    expect(costOf(small, NO_USAGE)).toBe(0);
  });

  it("refuses a model id the table does not price", () => {
    expect(() => priceOf("claude-sonnet-5")).toThrow(/GATEWAY_PRICE_UNKNOWN|no price for model claude-sonnet-5/);
  });

  it("pins each alias to the id the gateway reports, and prices the two messages aliases", () => {
    expect(ALIAS_PINS).toEqual({ "hb-frontier": FRONTIER_MODEL_ID, "hb-small": SMALL_MODEL_ID, "hb-embed": EMBED_MODEL_ID, "hb-rerank": RERANK_MODEL_ID });
    expect(MODEL_PRICES[FRONTIER_MODEL_ID]).toBeDefined();
    expect(MODEL_PRICES[SMALL_MODEL_ID]).toBeDefined();
    // Voyage's published rate is owed (feature-specs/12 § 3, BLOCKED): the pin exists, the price does not.
    expect(MODEL_PRICES[EMBED_MODEL_ID]).toBeUndefined();
    expect(MODEL_PRICES[EMBED_TARGET]).toBeUndefined();
    /* The re-rank pin is in the same state: pinned, unpriced, so a RERANK row is cost 0 and repriceable (12 § 3). */
    expect(MODEL_PRICES[RERANK_MODEL_ID]).toBeUndefined();
    expect(priceFor("hb-rerank", RERANK_MODEL_ID)).toEqual({ price: null, exact: false });
  });

  it("resolves a reported id tolerantly: the table, a dated snapshot of the alias's pin, nothing else", () => {
    expect(priceFor("hb-small", SMALL_MODEL_ID)).toEqual({ price: MODEL_PRICES[SMALL_MODEL_ID], exact: true });
    expect(priceFor("hb-small", FRONTIER_MODEL_ID)).toEqual({ price: MODEL_PRICES[FRONTIER_MODEL_ID], exact: true });
    expect(priceFor("hb-small", "claude-haiku-4-5-20260101")).toEqual({ price: MODEL_PRICES[SMALL_MODEL_ID], exact: false });
    expect(priceFor("hb-frontier", "claude-opus-5-20260101")).toEqual({ price: MODEL_PRICES[FRONTIER_MODEL_ID], exact: false });
    // A longer model name is another model at another rate, never the pin's price by prefix.
    expect(priceFor("hb-frontier", "claude-opus-5-1")).toEqual({ price: null, exact: false });
    expect(priceFor("hb-frontier", "claude-opus-5-1-20260101")).toEqual({ price: null, exact: false });
    // A dated snapshot only counts for the alias it is pinned to, and only aliases with a pin resolve at all.
    expect(priceFor("hb-small", "claude-opus-5-20260101")).toEqual({ price: null, exact: false });
    expect(priceFor("hb-embed", EMBED_MODEL_ID)).toEqual({ price: null, exact: false });

    /* The gateway answers with the alias it routed, not the id it reached (measured 2026-09-25): the alias's own
       pin is then the price, or every real call is recorded at cost 0 as if nobody had priced it. */
    expect(priceFor("hb-frontier", "hb-frontier")).toEqual({ price: MODEL_PRICES[FRONTIER_MODEL_ID], exact: false });
    expect(priceFor("hb-small", "hb-small")).toEqual({ price: MODEL_PRICES[SMALL_MODEL_ID], exact: false });
    // The embedding pin has no price, so neither it nor a dated snapshot of it resolves to one.
    expect(priceFor("hb-embed", EMBED_MODEL_ID)).toEqual({ price: null, exact: false });
    expect(priceFor("hb-embed", `${EMBED_MODEL_ID}-20260101`)).toEqual({ price: null, exact: false });
    expect(priceFor("hb-small", "claude-haiku-4-5-2026010")).toEqual({ price: null, exact: false });
  });

  it("reads the API's nullable cache counts as zero", () => {
    expect(usageOf({ input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: null, cache_read_input_tokens: null })).toEqual({ input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    expect(usageOf({ input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 30, cache_read_input_tokens: 7 })).toEqual({ input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 30, cache_read_input_tokens: 7 });
  });

  it("converts a token cap to max_budget at the frontier input price (D3) with the range checked", () => {
    expect(maxBudgetUsd(BigInt(1_000_000))).toBe(5);
    expect(maxBudgetUsd(BigInt(0))).toBe(0);
    expect(maxBudgetUsd(BigInt(200_000))).toBe(1);
    expect(() => maxBudgetUsd(BigInt(-1))).toThrow(/GATEWAY_CAP_RANGE|outside/);
    expect(() => maxBudgetUsd(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1))).toThrow(/outside/);
  });

  it("reads a spend back as tokens of the cap, the inverse of D3 (feature-specs/21 D7)", () => {
    expect(tokensOfUsd(5)).toBe(1_000_000);
    expect(tokensOfUsd(0)).toBe(0);
    expect(tokensOfUsd(maxBudgetUsd(BigInt(2_500_000)))).toBe(2_500_000);
    /* One answer's draft at the frontier: 14,437 in and 749 out cost what 18,182 input tokens would. */
    expect(tokensOfUsd(costOf(priceOf("claude-opus-5"), { input_tokens: 14_437, output_tokens: 749, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }))).toBe(18_182);
  });
});
