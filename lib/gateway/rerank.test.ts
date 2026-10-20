import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { overlapScore } from "@/infra/gateway/stub/rerank";
import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import type { BudgetRowInput } from "@/lib/db/budget";
import { AppError } from "@/lib/errors";
import type { GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { encryptKey } from "@/lib/gateway/keys";
import { RERANK_MODEL_ID } from "@/lib/gateway/prices";
import { documentsFor, hitsOf, rerank, usageOfRerank, type RerankCall, type RerankDocument } from "@/lib/gateway/rerank";
import type { GatewaySpan } from "@/lib/gateway/span";

/*
 * The re-rank call against the stub gateway (feature-specs/12 § 7.1, § 9): the same HTTP path LiteLLM answers,
 * with the key row, the ledger append and the span logger as in-memory doubles. Every call writes one RERANK row
 * and one span, whatever happened, at cost 0 with `hb.price_unknown` until Voyage's rate is recorded (§ 3).
 */

const MASTER_KEY = "test-master-key-for-the-reranker";
const SECRET = "0123456789abcdef".repeat(4);
const NOW = new Date("2026-09-23T12:00:00.000Z");
const ALIASES = aliasesFromConfig(readFileSync(join(import.meta.dirname, "..", "..", "infra", "gateway", "litellm.yaml"), "utf8"));
const QUERY = "how does an idempotency key make a retry safe";
const DOCUMENTS: ReadonlyArray<RerankDocument> = [
  { id: "28.4", text: "The ledger head lock serialises appends so two writers cannot claim one seq." },
  { id: "21.3", text: "An idempotency key makes a retry safe: the second call returns the first response." },
  { id: "25.2", text: "Sandbox egress is default-deny at the host, which is how a run stays safe." },
];

function call(overrides: Partial<RerankCall> = {}): RerankCall {
  return { guide: null, principal: { userId: "u-1" }, traceId: "d".repeat(32), ref: "msg-1", ...overrides };
}

describe("rerank against the stub gateway", () => {
  let stub: RunningStub;
  const rows: BudgetRowInput[] = [];
  const spans: GatewaySpan[] = [];

  beforeAll(async () => {
    stub = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: () => undefined, now: () => NOW });
  });
  afterAll(async () => {
    await stub.close();
  });

  async function mint(body: Record<string, unknown> = {}): Promise<string> {
    const res = await fetch(`${stub.url}/key/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ models: [...ALIASES.keys()], ...body }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { key: string }).key;
  }

  function deps(key: string | null, overrides: Partial<GatewayDeps> = {}): GatewayDeps {
    return {
      baseUrl: stub.url,
      keySecret: SECRET,
      findKey: async () => (key === null ? null : { keyCiphertext: encryptKey(SECRET, key) }),
      append: async (row) => {
        rows.push(row);
      },
      log: (span) => spans.push(span),
      fetch: globalThis.fetch,
      now: () => NOW,
      ...overrides,
    };
  }

  it("scores the documents, keeps the top n by score and records one RERANK row and one span", async () => {
    const key = await mint();
    let sent: Record<string, unknown> | null = null;
    const watching = deps(key, {
      fetch: async (input, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return globalThis.fetch(input, init);
      },
    });

    const result = await rerank(call(), { query: QUERY, documents: DOCUMENTS, topN: 2 }, watching);

    expect(result.hits.map((hit) => hit.id)).toEqual(["21.3", "25.2"]);
    expect(result.hits[0].score).toBeCloseTo(overlapScore(QUERY, DOCUMENTS[1].text), 10);
    expect(result.hits[0].score).toBeGreaterThan(result.hits[1].score);
    expect(result.hits.every((hit) => !hit.truncated)).toBe(true);
    expect(result.modelId).toBe(RERANK_MODEL_ID);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(result.usage.output_tokens).toBe(0);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    /* The alias, never a provider id, the whole batch, and the principal for the proxy's spend attribution. */
    expect(sent).toMatchObject({ model: "hb-rerank", query: QUERY, top_n: 2, metadata: { user_id: "user:u-1" } });
    expect((sent as unknown as { documents: string[] }).documents).toEqual(DOCUMENTS.map((document) => document.text));

    const row = rows.at(-1);
    expect(row).toMatchObject({ kind: "RERANK", alias: "hb-rerank", outcome: "ok", month: "2026-09", ref: "msg-1", costUsd: 0, outputTokens: 0, principal: { userId: "u-1" } });
    expect(row?.modelId).toBe(RERANK_MODEL_ID);
    expect(row?.inputTokens).toBe(result.usage.input_tokens);
    expect(row?.gatewayCallId).not.toBeNull();

    const span = spans.at(-1);
    expect(span).toMatchObject({ "hb.purpose": "rerank", "hb.alias": "hb-rerank", "hb.outcome": "ok", "hb.cost_usd": 0, "hb.price_unknown": false, "hb.principal": "user:u-1", first_token_ms: null });
    expect(span?.["hb.prompt.sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an empty batch and a top n that is not a count, before the gateway", async () => {
    const key = await mint();
    const before = rows.length;
    await expect(rerank(call(), { query: QUERY, documents: [], topN: 8 }, deps(key))).rejects.toMatchObject({ code: "GATEWAY_RERANK_EMPTY" });
    await expect(rerank(call(), { query: QUERY, documents: DOCUMENTS, topN: 0 }, deps(key))).rejects.toMatchObject({ code: "GATEWAY_RERANK_TOP_N" });
    await expect(rerank(call(), { query: QUERY, documents: DOCUMENTS, topN: 1.5 }, deps(key))).rejects.toBeInstanceOf(AppError);
    expect(rows).toHaveLength(before);
  });

  it("records the budget refusal and raises BudgetExceededError", async () => {
    const key = await mint({ max_budget: 0, budget_duration: "1mo" });
    await expect(rerank(call(), { query: QUERY, documents: DOCUMENTS, topN: 2 }, deps(key))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(rows.at(-1)).toMatchObject({ kind: "RERANK", outcome: "budget", inputTokens: 0, costUsd: 0 });
  });

  it("records an unreachable gateway, a missing key and the stub's 500 as unavailable", async () => {
    const key = await mint();
    await expect(rerank(call(), { query: QUERY, documents: DOCUMENTS, topN: 2 }, deps(key, { baseUrl: "http://127.0.0.1:1" }))).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(rows.at(-1)).toMatchObject({ outcome: "unavailable", kind: "RERANK" });

    await expect(rerank(call(), { query: QUERY, documents: DOCUMENTS, topN: 2 }, deps(null))).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(rows.at(-1)).toMatchObject({ outcome: "unavailable", modelId: "hb-rerank" });

    const failing = deps(key, {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("x-hb-stub-fail", "500");
        return globalThis.fetch(input, { ...init, headers });
      },
    });
    await expect(rerank(call(), { query: QUERY, documents: DOCUMENTS, topN: 2 }, failing)).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(rows.at(-1)).toMatchObject({ outcome: "unavailable", kind: "RERANK" });
  });

  it("refuses an answer that is not a rerank response, or one scoring a document it was not given, and records each one", async () => {
    const key = await mint();
    const body = (payload: unknown): GatewayDeps =>
      deps(key, {
        fetch: async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "x-litellm-call-id": "call-malformed" } }),
      });
    const before = rows.length;
    const spansBefore = spans.length;

    await expect(rerank(call(), { query: QUERY, documents: DOCUMENTS, topN: 2 }, body({ id: "r-1" }))).rejects.toMatchObject({ code: "GATEWAY_RERANK_ANSWER" });
    await expect(rerank(call(), { query: QUERY, documents: DOCUMENTS, topN: 2 }, body({ results: [{ index: 9, relevance_score: 1 }] }))).rejects.toMatchObject({ code: "GATEWAY_RERANK_INDEX" });

    /* The gateway answered 200, so both are completed calls: one row and one span each, with the gateway's own
       call id, under `unavailable` (spec 11 § 5.4). */
    expect(rows).toHaveLength(before + 2);
    expect(spans).toHaveLength(spansBefore + 2);
    for (const row of rows.slice(before)) {
      expect(row).toMatchObject({ kind: "RERANK", alias: "hb-rerank", outcome: "unavailable", modelId: "hb-rerank", inputTokens: 0, costUsd: 0, gatewayCallId: "call-malformed" });
    }
    expect(spans.slice(spansBefore).every((span) => span["hb.outcome"] === "unavailable" && span["x-litellm-call-id"] === "call-malformed")).toBe(true);
  });

  it("records the alias as the model id when the answer names none", async () => {
    const key = await mint();
    const anonymous = deps(key, {
      fetch: async () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.5 }] }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const result = await rerank(call(), { query: QUERY, documents: DOCUMENTS, topN: 2 }, anonymous);
    expect(result.modelId).toBe("hb-rerank");
    expect(result.usage.input_tokens).toBe(0);
    expect(rows.at(-1)).toMatchObject({ kind: "RERANK", outcome: "ok", modelId: "hb-rerank", inputTokens: 0 });
  });
});

/*
 * The pure parts: the document cut of § 7.1 (whose limit is the provider's and still owed, so the constant is
 * null and the cut is tested with a limit given), the token count of an answer, and the ordering of the hits.
 */
describe("rerank documents and answers", () => {
  it("sends a document whole without a limit and cuts it to the limit with one", () => {
    const documents: ReadonlyArray<RerankDocument> = [{ id: "21.3", text: "abcdefghij" }, { id: "21.4", text: "abc" }];
    expect(documentsFor(documents, null)).toEqual([
      { id: "21.3", text: "abcdefghij", truncated: false },
      { id: "21.4", text: "abc", truncated: false },
    ]);
    expect(documentsFor(documents, 4)).toEqual([
      { id: "21.3", text: "abcd", truncated: true },
      { id: "21.4", text: "abc", truncated: false },
    ]);
    /* A document exactly at the limit is whole, not truncated. */
    expect(documentsFor([{ id: "21.4", text: "abc" }], 3)).toEqual([{ id: "21.4", text: "abc", truncated: false }]);
  });

  it("reads the input tokens from the proxy's meta, the billed units or the provider's usage, else zero", () => {
    expect(usageOfRerank({ results: [], meta: { tokens: { input_tokens: 12 } } }).input_tokens).toBe(12);
    expect(usageOfRerank({ results: [], meta: { billed_units: { total_tokens: 7 } } }).input_tokens).toBe(7);
    expect(usageOfRerank({ results: [], usage: { total_tokens: 4 } }).input_tokens).toBe(4);
    expect(usageOfRerank({ results: [] }).input_tokens).toBe(0);
    expect(usageOfRerank({ results: [] }).output_tokens).toBe(0);
  });

  it("orders the hits by score and keeps the truncation flag of the document it scored", () => {
    const sent = [
      { id: "21.3", truncated: true },
      { id: "28.4", truncated: false },
    ];
    const hits = hitsOf([{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.9 }], sent, 8);
    expect(hits).toEqual([
      { id: "28.4", score: 0.9, truncated: false },
      { id: "21.3", score: 0.2, truncated: true },
    ]);
    expect(hitsOf([{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.9 }], sent, 1)).toEqual([{ id: "28.4", score: 0.9, truncated: false }]);
  });
});
