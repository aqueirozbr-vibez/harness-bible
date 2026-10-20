import { AppError } from "@/lib/errors";
import type { Alias } from "@/lib/schemas/gateway";

/*
 * Prices at the pins (feature-specs/11 § 3.2): USD per million tokens, the first-party rates as cached on
 * PRICES_AS_OF from the Claude API reference, cache reads at the provider's cached-input rate and cache writes
 * at 1.25× input. They price the ledger's cost column and the D3 budget conversion only: enforcement never uses
 * them, the gateway's own cost map tracks spend (invariant 7). The stub gateway reads this same table, so one
 * table remains (25b's decision). Importable by the web tier (spec § 5.5).
 */

export const PRICES_AS_OF = "2026-06-24";

export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** The pinned ids of `hb-frontier` and `hb-small`, the two aliases `/v1/messages` serves. */
export const FRONTIER_MODEL_ID = "claude-opus-5";
export const SMALL_MODEL_ID = "claude-haiku-4-5";
/**
 * `hb-embed`'s pin (feature-specs/12 § 3) in the two forms the product uses: the id the gateway reports, as every
 * entry of `ALIAS_PINS` writes it (the provider prefix dropped), and the target of `infra/gateway/litellm.yaml`,
 * which is the string `Section.embeddingModel` stores so the embedding job can tell a stale vector from a current
 * one (12 § 4.2). Self-hosted since 2026-09-25 (Andre, 2026-09-24): `BAAI/bge-m3`, MIT, pinned by revision in
 * docker-compose.yml, 1,024 dimensions — the size `Section.embedding` already is, which is what makes a later move
 * to a provider a configuration edit and a re-index rather than a migration.
 */
export const EMBED_MODEL_ID = "BAAI/bge-m3";
export const EMBED_TARGET = "infinity/BAAI/bge-m3";
/**
 * `hb-rerank`'s pin (feature-specs/12 § 3, § 7.1) as the gateway reports it. Self-hosted since 2026-09-25:
 * `BAAI/bge-reranker-base`, MIT, pinned by revision in docker-compose.yml. A re-ranker returns a score, so unlike
 * the embedder it carries no dimension constraint and the smallest usable model wins. Nothing stores this pin in a
 * column, so it has no target form: a section carries the embedding's pin, never the re-ranker's.
 */
export const RERANK_MODEL_ID = "BAAI/bge-reranker-base";

/**
 * The pinned ids that cost nothing per token because we run them ourselves, which is not the same as a price
 * nobody has recorded: their ledger rows are written at cost 0 and are **not** marked `hb.price_unknown`, so the
 * budget meter's "unpriced" row stays a defect signal rather than the normal state of two aliases (12 § 3).
 */
export const SELF_HOSTED_MODEL_IDS: ReadonlySet<string> = new Set([EMBED_MODEL_ID, RERANK_MODEL_ID]);

/**
 * Whether the alias's **pin** is a model we host, which is the question `pricedUsage` must answer and cannot ask of
 * the id the gateway reports: LiteLLM echoes the alias itself (`hb-embed`) for the self-hosted provider, where for
 * Anthropic it echoes the pinned id. Reading `ALIAS_PINS` instead means a later swap to a paid service changes one
 * constant and this answers false again by itself.
 */
export function selfHosted(alias: Alias): boolean {
  const pin = ALIAS_PINS[alias];
  return pin !== undefined && SELF_HOSTED_MODEL_IDS.has(pin);
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  [FRONTIER_MODEL_ID]: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  [SMALL_MODEL_ID]: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/**
 * Alias → the pinned id of `infra/gateway/litellm.yaml` (spec § 3.2), the one table that says which price a
 * call's alias means. `tests/gateway-config.test.ts` compares it with the YAML, so a pin change that forgets
 * `MODEL_PRICES` fails there rather than at runtime. A pinned id this table does not price is priced as unknown,
 * never as free.
 */
export const ALIAS_PINS: Readonly<Partial<Record<Alias, string>>> = {
  "hb-frontier": FRONTIER_MODEL_ID,
  "hb-small": SMALL_MODEL_ID,
  "hb-embed": EMBED_MODEL_ID,
  "hb-rerank": RERANK_MODEL_ID,
};

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * The provider's fee for its web search tool (feature-specs/40 § 7.3; unit 58a): USD per thousand searches, from
 * the provider's list as cached on PRICES_AS_OF, on top of the tokens the search results add. Web fetch carries no
 * fee of its own: a fetched page is billed as the input tokens it becomes. The fee prices the ledger row of a call
 * that searched, from the count the provider reports in `usage.server_tool_use`; whether the gateway's `max_budget`
 * counts it too is what `npm run research:check` measures (Andre's), and the tracker records the answer.
 */
export const WEB_SEARCH_USD_PER_THOUSAND = 10;
const SEARCHES_PER_PRICE_UNIT = 1_000;

export function webSearchFeeUsd(searches: number): number {
  return (searches * WEB_SEARCH_USD_PER_THOUSAND) / SEARCHES_PER_PRICE_UNIT;
}

/** The four counts of a usage block, nulls already read as zero. */
export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
}

export const NO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** The price of a pinned model id; a pin this table does not know is a defect, not a free call. */
export function priceOf(modelId: string): ModelPrice {
  const price = MODEL_PRICES[modelId];
  if (price === undefined) {
    throw new AppError("GATEWAY_PRICE_UNKNOWN", `no price for model ${modelId}: a pin change updates lib/gateway/prices.ts with it (feature-specs/11 § 3.2)`);
  }
  return price;
}

/** A dated snapshot of a pinned id: `claude-haiku-4-5-20260101`, the same model at the same price, not a new one. */
function isSnapshotOf(pin: string, modelId: string): boolean {
  return modelId.startsWith(`${pin}-`) && /^\d{8}$/.test(modelId.slice(pin.length + 1));
}

/**
 * The price of the id the gateway reported for a call on `alias`, tolerantly: the table's own entry, or the
 * alias's pin when the gateway reported a dated snapshot of it (`claude-opus-5-20260101`). Anything else is
 * `null` — never the pin's price by prefix, since `claude-opus-5-1` is another model at another rate. The
 * caller records the row with `costUsd` 0 rather than losing it (spec § 5.4: every call writes one row);
 * `priceOf` stays strict, because `maxBudgetUsd` and the stub's configuration guard need the exact table.
 */
export function priceFor(alias: Alias, modelId: string): { readonly price: ModelPrice | null; readonly exact: boolean } {
  const known = MODEL_PRICES[modelId];
  if (known !== undefined) return { price: known, exact: true };
  const pin = ALIAS_PINS[alias];
  if (pin === undefined) return { price: null, exact: false };
  const pinned = MODEL_PRICES[pin];
  if (pinned === undefined) return { price: null, exact: false };
  /* The gateway may answer with the alias it routed rather than the id it reached — LiteLLM does exactly that for
   * both providers we use (measured against a real `hb-small` call, 2026-09-25, which was being recorded at cost 0
   * with `hb.price_unknown`). The alias is not less information than a model id: it is what the configuration says
   * the call was routed to, so its pin's price is the call's price. Inexact, because no real id was read. */
  if (modelId === alias) return { price: pinned, exact: false };
  if (isSnapshotOf(pin, modelId)) return { price: pinned, exact: false };
  return { price: null, exact: false };
}

export function costOf(price: ModelPrice, usage: Usage): number {
  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_read_input_tokens * price.cacheRead +
      usage.cache_creation_input_tokens * price.cacheWrite) /
    TOKENS_PER_PRICE_UNIT
  );
}

/** The API's usage block, whose cache counts are nullable, as the ledger's four integers. */
export function usageOf(usage: {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number | null;
  readonly cache_read_input_tokens: number | null;
}): Usage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * D3: an organisation's `tokenCap` as the key's `max_budget`, every capped token priced as frontier input. The
 * cap is a bigint in the database and becomes a number here, at the one boundary, with its range checked.
 */
export function maxBudgetUsd(tokenCap: bigint): number {
  if (tokenCap < BigInt(0) || tokenCap > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError("GATEWAY_CAP_RANGE", `tokenCap ${tokenCap} is outside 0..${Number.MAX_SAFE_INTEGER}`);
  }
  return (Number(tokenCap) * MODEL_PRICES[FRONTIER_MODEL_ID].input) / TOKENS_PER_PRICE_UNIT;
}

/**
 * D3 read the other way, for the budget meter (feature-specs/21 § 4.1, D7): a spend in USD as tokens of the cap,
 * every dollar counted at the frontier input price. The gateway caps dollars, so this is the one unit in which
 * "used of cap" says what the gateway enforces: a raw token count would put output (five times the input price),
 * cache reads (a tenth) and self-hosted retrieval (nothing) on one scale and reach 100% at some other moment than
 * the refusal does.
 */
export function tokensOfUsd(usd: number): number {
  return Math.round((usd * TOKENS_PER_PRICE_UNIT) / MODEL_PRICES[FRONTIER_MODEL_ID].input);
}
