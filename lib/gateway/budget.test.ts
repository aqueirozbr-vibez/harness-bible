import { describe, expect, it, vi } from "vitest";

import type { BudgetRowInput } from "@/lib/db/budget";
import type { GatewayCall } from "@/lib/schemas/gateway";

import { budgetKindOf, outcomeOfMessage, recordCall, toBudgetRow, toSpan, type CallRecord } from "./budget";
import type { GatewaySpan } from "./span";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const CALL: GatewayCall = {
  purpose: "assistant",
  alias: "hb-small",
  agent: "assistant.classify",
  guide: { agent: "assistant", version: "v1.8", sha256: "c".repeat(64) },
  principal: { organisationId: "org-1" },
  traceId: "b".repeat(32),
  ref: "msg-1",
};
const RECORD: CallRecord = {
  call: CALL,
  outcome: "ok",
  modelId: "claude-haiku-4-5",
  usage: { input_tokens: 4, output_tokens: 15, cache_creation_input_tokens: 30, cache_read_input_tokens: 7 },
  costUsd: 0.0001,
  priceUnknown: false,
  searches: 0,
  promptSha256: "a".repeat(64),
  spanId: "c".repeat(16),
  gatewayCallId: "call-1",
  latencyMs: 12,
  firstTokenMs: 5,
};

describe("the record of a call (feature-specs/11 § 5.4)", () => {
  it("maps every purpose to its BudgetKind", () => {
    expect(budgetKindOf("assistant")).toBe("ASSISTANT");
    expect(budgetKindOf("grading")).toBe("GRADING");
    expect(budgetKindOf("adjudication")).toBe("ADJUDICATION");
    expect(budgetKindOf("lab")).toBe("LAB");
    expect(budgetKindOf("embed")).toBe("EMBED");
    expect(budgetKindOf("rerank")).toBe("RERANK");
    expect(budgetKindOf("research")).toBe("RESEARCH");
  });

  it("reads a message's usage, cost and outcome; a refusal stop is the provider's", () => {
    const ok = outcomeOfMessage("hb-small", { model: "claude-haiku-4-5", stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 15, cache_creation_input_tokens: null, cache_read_input_tokens: null } });
    expect(ok).toEqual({ outcome: "ok", modelId: "claude-haiku-4-5", usage: { input_tokens: 4, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: expect.closeTo(0.000079, 9) as number, priceUnknown: false, searches: 0 });
    const refusal = outcomeOfMessage("hb-frontier", { model: "claude-opus-5", stop_reason: "refusal", usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    expect(refusal.outcome).toBe("provider_refusal");
    expect(refusal.costUsd).toBeCloseTo(0.00005, 9);
  });

  /* Unit 58a (feature-specs/40 § 7.3, 41 § 3): the provider's count of searches is read from the usage and its fee added to the tokens' cost. */
  it("adds the web search fee to a call that searched, from the provider's count, and keeps the count", () => {
    const searched = outcomeOfMessage("hb-frontier", { model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 1_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 3 } } });
    expect(searched.searches).toBe(3);
    expect(searched.costUsd).toBeCloseTo(0.005 + 0.03, 9);
    expect(toSpan({ ...RECORD, ...searched })["hb.web_search_requests"]).toBe(3);
    const none = outcomeOfMessage("hb-frontier", { model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 1_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null } });
    expect(none).toMatchObject({ searches: 0, costUsd: expect.closeTo(0.005, 9) as number });
  });

  it("prices a dated snapshot of the alias's pin at the pin's rate, and never fails a call the gateway answered", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const snapshot = outcomeOfMessage("hb-small", { model: "claude-haiku-4-5-20260101", stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 15, cache_creation_input_tokens: null, cache_read_input_tokens: null } });
    expect(snapshot).toEqual({ outcome: "ok", modelId: "claude-haiku-4-5-20260101", usage: { input_tokens: 4, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: expect.closeTo(0.000079, 9) as number, priceUnknown: false, searches: 0 });
    expect(error).not.toHaveBeenCalled();

    const unknown = outcomeOfMessage("hb-small", { model: "claude-sonnet-5", stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 15, cache_creation_input_tokens: null, cache_read_input_tokens: null } });
    expect(unknown).toEqual({ outcome: "ok", modelId: "claude-sonnet-5", usage: { input_tokens: 4, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, costUsd: 0, priceUnknown: true, searches: 0 });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("claude-sonnet-5");
    expect(toSpan({ ...RECORD, ...unknown })["hb.price_unknown"]).toBe(true);
    error.mockRestore();
  });

  it("builds the BudgetLedger row from the call: the principal, the month of now, the kind, the counts and the ids", () => {
    expect(toBudgetRow(RECORD, NOW)).toEqual({
      principal: { organisationId: "org-1" },
      month: "2026-09",
      kind: "ASSISTANT",
      alias: "hb-small",
      modelId: "claude-haiku-4-5",
      inputTokens: 4,
      outputTokens: 15,
      cacheReadTokens: 7,
      cacheWriteTokens: 30,
      costUsd: 0.0001,
      outcome: "ok",
      ref: "msg-1",
      traceId: "b".repeat(32),
      gatewayCallId: "call-1",
    });
    expect(toBudgetRow({ ...RECORD, call: { ...CALL, principal: { userId: "u-1" }, ref: null, purpose: "grading" } }, new Date("2026-12-31T23:59:59.000Z"))).toMatchObject({ principal: { userId: "u-1" }, month: "2026-12", kind: "GRADING", ref: null });
  });

  it("builds the span with the guide's version and hash, or nulls without a guide", () => {
    expect(toSpan(RECORD)).toEqual({
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-haiku-4-5",
      "hb.alias": "hb-small",
      "hb.agent": "assistant.classify",
      "hb.guide.version": "v1.8",
      "hb.guide.sha256": "c".repeat(64),
      "hb.prompt.sha256": "a".repeat(64),
      "gen_ai.usage.input_tokens": 4,
      "gen_ai.usage.output_tokens": 15,
      "gen_ai.usage.cache_read_input_tokens": 7,
      "gen_ai.usage.cache_creation_input_tokens": 30,
      "hb.cost_usd": 0.0001,
      "hb.price_unknown": false,
      "hb.web_search_requests": 0,
      "hb.purpose": "assistant",
      "hb.principal": "org:org-1",
      "hb.outcome": "ok",
      trace_id: "b".repeat(32),
      span_id: "c".repeat(16),
      "x-litellm-call-id": "call-1",
      latency_ms: 12,
      first_token_ms: 5,
    });
    const bare = toSpan({ ...RECORD, call: { ...CALL, guide: null }, gatewayCallId: null, firstTokenMs: null });
    expect(bare["hb.guide.version"]).toBeNull();
    expect(bare["hb.guide.sha256"]).toBeNull();
    expect(bare["x-litellm-call-id"]).toBeNull();
    expect(bare.first_token_ms).toBeNull();
  });

  it("writes the row before the span, and no span when the row fails", async () => {
    const order: string[] = [];
    const rows: BudgetRowInput[] = [];
    const spans: GatewaySpan[] = [];
    await recordCall(RECORD, {
      append: async (row) => {
        order.push("row");
        rows.push(row);
      },
      log: (span) => {
        order.push("span");
        spans.push(span);
      },
      now: () => NOW,
    });
    expect(order).toEqual(["row", "span"]);
    expect(rows[0].month).toBe("2026-09");
    expect(spans[0]["hb.outcome"]).toBe("ok");
    await expect(
      recordCall(RECORD, {
        append: async () => {
          throw new Error("database down");
        },
        log: (span) => spans.push(span),
        now: () => NOW,
      }),
    ).rejects.toThrow("database down");
    expect(spans).toHaveLength(1);
  });
});
