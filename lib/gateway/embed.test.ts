import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stubEmbedding } from "@/infra/gateway/stub/embed";
import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import type { BudgetRowInput } from "@/lib/db/budget";
import { AppError } from "@/lib/errors";
import type { GatewayDeps } from "@/lib/gateway/client";
import { embedTexts, type EmbedCall } from "@/lib/gateway/embed";
import { BudgetExceededError, GatewayUnavailableError } from "@/lib/gateway/errors";
import { encryptKey } from "@/lib/gateway/keys";
import { EMBED_MODEL_ID, EMBED_TARGET } from "@/lib/gateway/prices";
import type { GatewaySpan } from "@/lib/gateway/span";
import { EMBEDDING_DIMENSIONS } from "@/lib/schemas/gateway";

/*
 * The embedding call against the stub gateway (feature-specs/12 § 4.3, § 9): the same HTTP path LiteLLM answers,
 * with the key row, the ledger append and the span logger as in-memory doubles. Every call writes one row and one
 * span, whatever happened, and the row is at cost 0 with `hb.price_unknown` until Voyage's rate is recorded (§ 3).
 */

const MASTER_KEY = "test-master-key-for-the-embedder";
const SECRET = "0123456789abcdef".repeat(4);
const NOW = new Date("2026-09-23T12:00:00.000Z");
const ALIASES = aliasesFromConfig(readFileSync(join(import.meta.dirname, "..", "..", "infra", "gateway", "litellm.yaml"), "utf8"));
const TEXTS = ["21.3 Worked numbers · retries and idempotency keys", "28.4 Measurement · the ledger head lock"];

function call(overrides: Partial<EmbedCall> = {}): EmbedCall {
  return { agent: "embed.release", guide: null, principal: { userId: "u-1" }, traceId: "c".repeat(32), ref: "release:2026.09", ...overrides };
}

describe("embedTexts against the stub gateway", () => {
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

  it("embeds a batch in the order of the texts and records one EMBED row and one span", async () => {
    const key = await mint();
    let sent: Record<string, unknown> | null = null;
    let traceparent: string | null = null;
    let generation: string | null = null;
    let optOut: string | null = null;
    const watching = deps(key, {
      fetch: async (input, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        traceparent = new Headers(init?.headers).get("traceparent");
        generation = new Headers(init?.headers).get("langfuse_generation_name");
        optOut = new Headers(init?.headers).get("litellm-disable-message-redaction");
        return globalThis.fetch(input, init);
      },
    });

    const result = await embedTexts(call(), TEXTS, watching);

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(result.vectors[1]).toEqual(stubEmbedding(TEXTS[1]));
    expect(result.modelId).toBe(ALIASES.get("hb-embed"));
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(result.usage.output_tokens).toBe(0);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    /* The alias, never a provider id, and the principal for the proxy's spend attribution. */
    expect(sent).toMatchObject({ model: "hb-embed", input: TEXTS, metadata: { user_id: "user:u-1" } });

    const row = rows.at(-1);
    expect(row).toMatchObject({ kind: "EMBED", alias: "hb-embed", outcome: "ok", month: "2026-09", ref: "release:2026.09", costUsd: 0, outputTokens: 0, principal: { userId: "u-1" } });
    expect(row?.modelId).toBe(ALIASES.get("hb-embed"));
    expect(row?.inputTokens).toBe(result.usage.input_tokens);
    expect(row?.gatewayCallId).not.toBeNull();

    const span = spans.at(-1);
    expect(span).toMatchObject({ "hb.purpose": "embed", "hb.alias": "hb-embed", "hb.outcome": "ok", "hb.cost_usd": 0, "hb.price_unknown": false, "hb.principal": "user:u-1", first_token_ms: null });
    expect(span?.["hb.prompt.sha256"]).toMatch(/^[0-9a-f]{64}$/);
    /* the parent the gateway's generation will name is this span, the one sent (49 § 5.3) */
    expect(span?.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(traceparent).toBe(`00-${span?.trace_id ?? ""}-${span?.span_id ?? ""}-01`);
    /* no opt-out without the development gate; with it, the header (49 § 9.2, lock 1) */
    expect(optOut).toBeNull();
    const opened = deps(key, { messageText: { on: true, why: null }, fetch: async (input, init) => { optOut = new Headers(init?.headers).get("litellm-disable-message-redaction"); return globalThis.fetch(input, init); } });
    await embedTexts(call(), TEXTS, opened);
    expect(optOut).toBe("true");
    /* named for its agent, in a header (49 § 6.2) */
    expect(generation).toBe("embed.release");
    expect(span?.["hb.agent"]).toBe("embed.release");
  });

  it("prices the self-hosted embedder as free, and says so rather than calling it unpriced", () => {
    /* Self-hosted since 2026-09-25: no per-token rate exists, so the row is free *and known to be*, which keeps
     * `hb.price_unknown` meaning that someone must update prices.ts (feature-specs/12 § 3). */
    expect(EMBED_TARGET).toBe("infinity/BAAI/bge-m3");
    expect(spans.at(-1)?.["hb.price_unknown"]).toBe(false);
    expect(spans.at(-1)?.["hb.cost_usd"]).toBe(0);
  });

  it("refuses an empty batch before it reaches the gateway", async () => {
    const key = await mint();
    const before = rows.length;
    await expect(embedTexts(call(), [], deps(key))).rejects.toBeInstanceOf(AppError);
    expect(rows).toHaveLength(before);
  });

  it("records the budget refusal and raises BudgetExceededError", async () => {
    const key = await mint({ max_budget: 0, budget_duration: "1mo" });
    await expect(embedTexts(call(), TEXTS, deps(key))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(rows.at(-1)).toMatchObject({ kind: "EMBED", outcome: "budget", inputTokens: 0, costUsd: 0 });
  });

  it("records an unreachable gateway, a missing key and an unset GATEWAY_URL as unavailable", async () => {
    const key = await mint();
    await expect(embedTexts(call(), TEXTS, deps(key, { baseUrl: "http://127.0.0.1:1" }))).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(rows.at(-1)).toMatchObject({ outcome: "unavailable", kind: "EMBED" });

    await expect(embedTexts(call(), TEXTS, deps(null))).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(rows.at(-1)).toMatchObject({ outcome: "unavailable", modelId: "hb-embed" });

    await expect(embedTexts(call(), TEXTS, deps(key, { baseUrl: undefined }))).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(rows.at(-1)).toMatchObject({ outcome: "unavailable" });
  });

  it("records the stub's 500 as unavailable after the SDK's retries", async () => {
    const key = await mint();
    const failing = deps(key, {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("x-hb-stub-fail", "500");
        return globalThis.fetch(input, { ...init, headers });
      },
    });
    await expect(embedTexts(call(), TEXTS, failing)).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(rows.at(-1)).toMatchObject({ outcome: "unavailable", kind: "EMBED" });
  });

  it("refuses an answer that is not an embeddings response, or one of the wrong shape, and records each one", async () => {
    const key = await mint();
    const body = (payload: unknown): GatewayDeps =>
      deps(key, {
        fetch: async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "x-litellm-call-id": "call-malformed" } }),
      });
    const before = rows.length;
    const spansBefore = spans.length;

    await expect(embedTexts(call(), TEXTS, body({ object: "list" }))).rejects.toMatchObject({ code: "GATEWAY_EMBED_ANSWER" });
    const one = { object: "embedding", index: 0, embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0) };
    await expect(embedTexts(call(), TEXTS, body({ data: [one], model: EMBED_MODEL_ID }))).rejects.toMatchObject({ code: "GATEWAY_EMBED_COUNT" });
    await expect(embedTexts(call(), [TEXTS[0]], body({ data: [{ object: "embedding", index: 0, embedding: [0, 1] }], model: EMBED_MODEL_ID }))).rejects.toMatchObject({ code: "GATEWAY_EMBED_DIMENSIONS" });

    /* The gateway answered 200, so each of the three is a completed call: one row and one span each, with the
       gateway's own call id, under `unavailable` (feature-specs/11 § 5.4). */
    expect(rows).toHaveLength(before + 3);
    expect(spans).toHaveLength(spansBefore + 3);
    for (const row of rows.slice(before)) {
      expect(row).toMatchObject({ kind: "EMBED", alias: "hb-embed", outcome: "unavailable", modelId: "hb-embed", inputTokens: 0, costUsd: 0, gatewayCallId: "call-malformed" });
    }
    expect(spans.slice(spansBefore).every((span) => span["hb.outcome"] === "unavailable" && span["x-litellm-call-id"] === "call-malformed")).toBe(true);
  });

  it("returns the vectors in index order however the gateway ordered them", async () => {
    const key = await mint();
    const reversed = deps(key, {
      fetch: async (input, init) => {
        const response = await globalThis.fetch(input, init);
        const payload = (await response.json()) as { data: ReadonlyArray<{ index: number }> };
        return new Response(JSON.stringify({ ...payload, data: [...payload.data].reverse() }), { status: response.status, headers: response.headers });
      },
    });
    const result = await embedTexts(call(), TEXTS, reversed);
    expect(result.vectors[0]).toEqual(stubEmbedding(TEXTS[0]));
    expect(result.vectors[1]).toEqual(stubEmbedding(TEXTS[1]));
  });

  it("reads total_tokens when the proxy reports no prompt_tokens", async () => {
    const key = await mint();
    const totals = deps(key, {
      fetch: async (input, init) => {
        const response = await globalThis.fetch(input, init);
        const payload = (await response.json()) as { usage: { total_tokens: number } };
        return new Response(JSON.stringify({ ...payload, usage: { total_tokens: payload.usage.total_tokens } }), { status: response.status, headers: response.headers });
      },
    });
    const result = await embedTexts(call(), TEXTS, totals);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
  });
});
