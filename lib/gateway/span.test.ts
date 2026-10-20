import { describe, expect, it, vi } from "vitest";

import { logGatewaySpan, promptSha256, type GatewaySpan } from "./span";

const GUIDE = "You are the assistant of the book. Cite a section for every claim.";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "hb-frontier",
    max_tokens: 4096,
    output_config: { effort: "high" },
    system: [
      { type: "text", text: GUIDE, cache_control: { type: "ephemeral" } },
      { type: "text", text: "release 2026.09" },
    ],
    messages: [{ role: "user", content: "How is the P-101 loop retried?" }],
    metadata: { user_id: "user:u-1" },
    ...overrides,
  };
}

describe("prompt hash (feature-specs/11 § 5.4; invariant 10)", () => {
  it("is 64 hex characters and the same for the same prefix", () => {
    const hash = promptSha256(request());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(promptSha256(request())).toBe(hash);
  });

  it("ignores the conversation, the metadata and the stream flag", () => {
    const hash = promptSha256(request());
    expect(promptSha256(request({ messages: [{ role: "user", content: "a longer conversation" }, { role: "assistant", content: "…" }] }))).toBe(hash);
    expect(promptSha256(request({ metadata: { user_id: "org:org-9" } }))).toBe(hash);
    expect(promptSha256(request({ stream: true }))).toBe(hash);
    expect(promptSha256(request({ metadata: undefined, stream: undefined }))).toBe(hash);
  });

  it("changes with the prefix: the system blocks, the model or the policy fields", () => {
    const hash = promptSha256(request());
    expect(promptSha256(request({ system: [{ type: "text", text: `${GUIDE} ` }] }))).not.toBe(hash);
    expect(promptSha256(request({ model: "hb-small" }))).not.toBe(hash);
    expect(promptSha256(request({ max_tokens: 1024 }))).not.toBe(hash);
  });

  it("does not depend on key order", () => {
    const a = promptSha256({ model: "hb-small", max_tokens: 256, messages: [] });
    const b = promptSha256({ max_tokens: 256, model: "hb-small", messages: [] });
    expect(a).toBe(b);
  });
});

describe("the span line", () => {
  it("is one JSON line of the attributes, without prompt text", () => {
    const span: GatewaySpan = {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-haiku-4-5",
      "hb.alias": "hb-small",
      "hb.guide.version": null,
      "hb.guide.sha256": null,
      "hb.prompt.sha256": "a".repeat(64),
      "gen_ai.usage.input_tokens": 4,
      "gen_ai.usage.output_tokens": 15,
      "gen_ai.usage.cache_read_input_tokens": 0,
      "gen_ai.usage.cache_creation_input_tokens": 0,
      "hb.cost_usd": 0.000079,
      "hb.price_unknown": false,
      "hb.web_search_requests": 0,
      "hb.purpose": "assistant",
      "hb.principal": "user:u-1",
      "hb.outcome": "ok",
      trace_id: "b".repeat(32),
      "x-litellm-call-id": "call-1",
      latency_ms: 12,
      first_token_ms: null,
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logGatewaySpan(span);
    expect(info).toHaveBeenCalledTimes(1);
    const line = JSON.parse(info.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(line).toEqual({ kind: "model_call", ...span });
    info.mockRestore();
  });
});
