import { readFileSync } from "node:fs";
import { join } from "node:path";

import { APIConnectionError, APIConnectionTimeoutError, BadRequestError, InternalServerError, NotFoundError, RateLimitError } from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import type { BudgetRowInput } from "@/lib/db/budget";
import { AppError } from "@/lib/errors";
import { budgetAwareFetch, callModel, gatewayClient, mapGatewayError, type GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError, GatewayRefusedError, GatewayUnavailableError, ProviderRefusalError } from "@/lib/gateway/errors";
import { encryptKey } from "@/lib/gateway/keys";
import { requestFor } from "@/lib/gateway/policy";
import type { GatewaySpan } from "@/lib/gateway/span";
import type { GatewayCall } from "@/lib/schemas/gateway";
import { CHECK_PROMPT, gatewayCheck } from "@/workers/check";

/*
 * The client against the stub gateway (feature-specs/11 § 12.2): the same HTTP path LiteLLM answers, with the key
 * row, the ledger append and the span logger as in-memory doubles, so every branch of client.ts is exercised
 * without the database. The database-backed round trip is tests/integration/gateway.test.ts.
 */

const MASTER_KEY = "test-master-key-for-the-client";
const SECRET = "0123456789abcdef".repeat(4);
const NOW = new Date("2026-09-23T12:00:00.000Z");
const ALIASES = aliasesFromConfig(readFileSync(join(import.meta.dirname, "..", "..", "infra", "gateway", "litellm.yaml"), "utf8"));
const GUIDE = "You are the assistant of the book. Cite a section for every claim.".repeat(8);
const SECTION = `<section id="21.3" chapter="21" version="v1.0.0" edition="EN" verify="PASSED">
A loop that restarts from step 1 repeats every side effect before the failure.
figures: F-21-05 "expected work redone" 45% (derived, L14)
</section>`;

type Fetch = typeof fetch;

function call(overrides: Partial<GatewayCall> = {}): GatewayCall {
  return { purpose: "assistant", alias: "hb-small", agent: "assistant.classify", guide: null, principal: { userId: "u-1" }, traceId: "b".repeat(32), ref: "msg-1", ...overrides };
}

const CHECK = { ...requestFor("scopeClassifier"), messages: [{ role: "user" as const, content: CHECK_PROMPT }] };

function assistantRequest<S extends boolean>(stream: S) {
  return {
    ...requestFor("assistantDraft"),
    stream,
    system: [
      { type: "text" as const, text: GUIDE, cache_control: { type: "ephemeral" as const } },
      { type: "text" as const, text: "release 2026.09 · mode explain" },
    ],
    messages: [{ role: "user" as const, content: `${SECTION}\n<question>How is the loop retried?</question>` }],
  };
}

/** A fetch that adds the stub's switch header to every request. */
function withHeader(name: string, value: string): Fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(name, value);
    return globalThis.fetch(input, { ...init, headers });
  };
}

/** A gateway that answers exactly as the stub did but reports another model id (a pin change, a dated snapshot). */
function reportingModel(model: string): Fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const text = await response.text();
    const streamed = response.headers.get("content-type")?.startsWith("text/event-stream") === true;
    const body = streamed ? text.replaceAll(/"model":"[^"]*"/g, `"model":"${model}"`) : JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), model });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** Consumes a stream as spec 15's answer flow will, and counts what it saw. */
async function drain(stream: AsyncIterable<unknown>): Promise<number> {
  let events = 0;
  for await (const event of stream) events += event === undefined ? 0 : 1;
  return events;
}

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the client against the stub gateway", () => {
  let stub: RunningStub;
  const lines: string[] = [];
  const rows: BudgetRowInput[] = [];
  const spans: GatewaySpan[] = [];

  beforeAll(async () => {
    stub = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: (line) => lines.push(line), now: () => NOW });
  });
  afterAll(async () => {
    await stub.close();
  });

  async function mint(body: Record<string, unknown> = {}): Promise<string> {
    const res = await fetch(`${stub.url}/key/generate`, { method: "POST", headers: { authorization: `Bearer ${MASTER_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ models: [...ALIASES.keys()], ...body }) });
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

  function messageLines(): number {
    return lines.filter((line) => line.startsWith("POST /v1/messages ")).length;
  }

  it("names its agent and its guide's version in headers, never the body, so the prompt's hash does not move (49 § 6.2)", async () => {
    const key = await mint();
    const seen: Array<{ readonly body: string; readonly headers: Headers }> = [];
    const capturing: Fetch = (input, init) => {
      seen.push({ body: String(init?.body), headers: new Headers(init?.headers) });
      return globalThis.fetch(input, init);
    };
    const guide = { agent: "assistant" as const, version: "v1.8", sha256: "a".repeat(64) };
    await callModel(call({ agent: "assistant.draft", guide }), CHECK, deps(key, { fetch: capturing }));
    await callModel(call({ agent: "assistant.repair", guide }), CHECK, deps(key, { fetch: capturing }));
    const [draft, repair] = seen;
    expect(draft?.headers.get("langfuse_generation_name")).toBe("assistant.draft");
    expect(repair?.headers.get("langfuse_generation_name")).toBe("assistant.repair");
    expect([draft?.headers.get("langfuse_version"), repair?.headers.get("langfuse_version")]).toEqual(["v1.8", "v1.8"]);
    expect(repair?.body).toBe(draft?.body);
    expect(draft?.body).not.toContain("assistant.draft");
    const [first, second] = spans.slice(-2);
    expect([first?.["hb.agent"], second?.["hb.agent"]]).toEqual(["assistant.draft", "assistant.repair"]);
    expect(second?.["hb.prompt.sha256"]).toBe(first?.["hb.prompt.sha256"]);
    /* a call with no guide sends no version */
    await callModel(call(), CHECK, deps(key, { fetch: capturing }));
    expect(seen.at(-1)?.headers.get("langfuse_generation_name")).toBe("assistant.classify");
    expect(seen.at(-1)?.headers.has("langfuse_version")).toBe(false);
    /* the development switch's opt-out goes exactly where messageTextHeaders puts it (49 § 9.2, lock 1) */
    expect(seen.every((request) => !request.headers.has("litellm-disable-message-redaction"))).toBe(true);
    const open = { on: true, why: null } as const;
    await callModel(call({ agent: "assistant.draft" }), CHECK, deps(key, { fetch: capturing, messageText: open }));
    expect(seen.at(-1)?.headers.get("litellm-disable-message-redaction")).toBe("true");
    expect(seen.at(-1)?.body).toBe(draft?.body);
    await callModel(call({ agent: "evidence.grade.bytes" }), CHECK, deps(key, { fetch: capturing, messageText: open }));
    expect(seen.at(-1)?.headers.has("litellm-disable-message-redaction")).toBe(false);
  });

  it("calls hb-small, stamps the principal and the alias, and writes the row and the span", async () => {
    const key = await mint();
    let sent: Record<string, unknown> | null = null;
    let traceparent: string | null = null;
    const capturing: Fetch = (input, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      traceparent = new Headers(init?.headers).get("traceparent");
      return globalThis.fetch(input, init);
    };
    const before = rows.length;
    const message = await callModel(call(), CHECK, deps(key, { fetch: capturing }));
    expect(message.model).toBe("claude-haiku-4-5");
    expect(message.usage.input_tokens).toBe(4);
    expect(sent).toMatchObject({ model: "hb-small", max_tokens: 256, metadata: { user_id: "user:u-1" } });
    expect(traceparent).toMatch(new RegExp(`^00-${"b".repeat(32)}-[0-9a-f]{16}-01$`));
    expect(rows).toHaveLength(before + 1);
    const row = rows[before];
    expect(row).toMatchObject({ principal: { userId: "u-1" }, month: "2026-09", kind: "ASSISTANT", alias: "hb-small", modelId: "claude-haiku-4-5", inputTokens: 4, outcome: "ok", ref: "msg-1", traceId: "b".repeat(32) });
    expect(row.outputTokens).toBeGreaterThan(0);
    expect(row.costUsd).toBeGreaterThan(0);
    expect(row.gatewayCallId).toMatch(/^[0-9a-f-]{36}$/);
    const span = spans[spans.length - 1];
    expect(span).toMatchObject({ "gen_ai.system": "anthropic", "gen_ai.request.model": "claude-haiku-4-5", "hb.alias": "hb-small", "hb.outcome": "ok", "hb.principal": "user:u-1", "x-litellm-call-id": row.gatewayCallId });
    expect(span["hb.prompt.sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(span.latency_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(span)).not.toContain(CHECK_PROMPT);
    /* the parent the gateway's generation will name is this span, the one sent (49 § 5.3) */
    expect(traceparent).toBe(`00-${"b".repeat(32)}-${span.span_id}-01`);
    expect(JSON.stringify(span)).not.toContain(key);
  });

  it("reads the cache on the second request with the same prefix, at a lower cost, and reaches finalMessage() on a stream", async () => {
    const key = await mint();
    const before = rows.length;
    const first = await callModel(call({ alias: "hb-frontier", guide: { agent: "assistant", version: "v1.8", sha256: "c".repeat(64) } }), assistantRequest(false), deps(key));
    expect(first.usage.cache_creation_input_tokens).toBeGreaterThan(0);
    expect(first.usage.cache_read_input_tokens).toBe(0);

    const stream = await callModel(call({ alias: "hb-frontier", guide: { agent: "assistant", version: "v1.8", sha256: "c".repeat(64) } }), assistantRequest(true), deps(key));
    let text = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") text += event.delta.text;
    }
    const final = await stream.finalMessage();
    expect(JSON.parse(text)).toEqual({ claims: [{ text: "expected work redone: 45% (21.3).", sectionId: "21.3", figureId: "F-21-05" }], refusal: null, mode_result: null });
    expect(final.usage.cache_read_input_tokens).toBeGreaterThan(0);
    expect(final.usage.cache_creation_input_tokens).toBe(0);

    await until(() => rows.length === before + 2);
    const [firstRow, secondRow] = rows.slice(before);
    expect(firstRow).toMatchObject({ kind: "ASSISTANT", alias: "hb-frontier", modelId: "claude-opus-5", outcome: "ok", cacheReadTokens: 0 });
    expect(firstRow.cacheWriteTokens).toBeGreaterThan(0);
    expect(secondRow).toMatchObject({ outcome: "ok", cacheWriteTokens: 0 });
    expect(secondRow.cacheReadTokens).toBeGreaterThan(0);
    expect(secondRow.costUsd).toBeLessThan(firstRow.costUsd);
    expect(secondRow.gatewayCallId).toMatch(/^[0-9a-f-]{36}$/);
    const span = spans[spans.length - 1];
    expect(span["hb.guide.version"]).toBe("v1.8");
    expect(span.first_token_ms).not.toBeNull();
    expect(span["hb.prompt.sha256"]).toBe(spans[spans.length - 2]["hb.prompt.sha256"]);
  });

  it("writes the row of an answered call whose reported id prices.ts cannot price, at cost 0, keeping the counts and the id", async () => {
    const key = await mint();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = rows.length;
    const message = await callModel(call(), CHECK, deps(key, { fetch: reportingModel("claude-sonnet-5") }));
    expect(message.model).toBe("claude-sonnet-5");
    expect(rows).toHaveLength(before + 1);
    expect(rows[before]).toMatchObject({ outcome: "ok", modelId: "claude-sonnet-5", inputTokens: 4, costUsd: 0 });
    expect(rows[before].outputTokens).toBeGreaterThan(0);
    expect(spans[spans.length - 1]["hb.price_unknown"]).toBe(true);
    expect(errors.mock.calls.flat().join(" ")).toContain("claude-sonnet-5");
    errors.mockRestore();
  });

  it("prices a dated snapshot of the alias's pin at the pin's rate", async () => {
    const key = await mint();
    const before = rows.length;
    const message = await callModel(call(), CHECK, deps(key, { fetch: reportingModel("claude-haiku-4-5-20260101") }));
    expect(message.model).toBe("claude-haiku-4-5-20260101");
    expect(rows[before]).toMatchObject({ outcome: "ok", modelId: "claude-haiku-4-5-20260101" });
    expect(rows[before].costUsd).toBeCloseTo(0.000079, 9);
    expect(spans[spans.length - 1]["hb.price_unknown"]).toBe(false);
  });

  it("writes the row of a streamed call whose reported id is unknown, and the stream still ends", async () => {
    const key = await mint();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = rows.length;
    const stream = await callModel(call({ alias: "hb-frontier" }), assistantRequest(true), deps(key, { fetch: reportingModel("claude-opus-5-1") }));
    expect(await drain(stream)).toBeGreaterThan(0);
    expect((await stream.finalMessage()).model).toBe("claude-opus-5-1");
    await until(() => rows.length === before + 1);
    expect(rows[before]).toMatchObject({ outcome: "ok", alias: "hb-frontier", modelId: "claude-opus-5-1", costUsd: 0 });
    expect(spans[spans.length - 1]["hb.price_unknown"]).toBe(true);
    errors.mockRestore();
  });

  it("raises ProviderRefusalError on both paths after the provider_refusal row (x-hb-stub-refusal)", async () => {
    const key = await mint();
    const refusing = withHeader("x-hb-stub-refusal", "general_harms");
    const before = rows.length;
    const error = await callModel(call(), CHECK, deps(key, { fetch: refusing })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRefusalError);
    expect((error as ProviderRefusalError).category).toBe("general_harms");
    expect(rows[before]).toMatchObject({ outcome: "provider_refusal", alias: "hb-small" });

    const stream = await callModel(call({ alias: "hb-frontier" }), assistantRequest(true), deps(key, { fetch: refusing }));
    await drain(stream);
    const streamed = await stream.finalMessage().catch((e: unknown) => e);
    expect(streamed).toBeInstanceOf(ProviderRefusalError);
    expect((streamed as ProviderRefusalError).category).toBe("general_harms");
    await until(() => rows.length === before + 2);
    expect(rows[before + 1]).toMatchObject({ outcome: "provider_refusal", alias: "hb-frontier" });
    expect(spans[spans.length - 1]["hb.outcome"]).toBe("provider_refusal");
  });

  it("fails a streamed call's finalMessage() when its ledger row could not be written", async () => {
    const key = await mint();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spansBefore = spans.length;
    const stream = await callModel(
      call({ alias: "hb-frontier" }),
      assistantRequest(true),
      deps(key, {
        append: async () => {
          throw new Error("database down");
        },
      }),
    );
    await drain(stream);
    await expect(stream.finalMessage()).rejects.toThrow("database down");
    expect(spans).toHaveLength(spansBefore);
    expect(errors.mock.calls.flat().join(" ")).toContain("the ledger row of a streamed call was not written");
    errors.mockRestore();
  });

  it("raises BudgetExceededError at the cap with the reset date, writes a budget row, and never retries the refusal", async () => {
    const key = await mint({ max_budget: 0.000001, budget_duration: "1mo", key_alias: "tiny" });
    await callModel(call(), CHECK, deps(key));
    const before = rows.length;
    const requests = messageLines();
    const error = await callModel(call(), CHECK, deps(key)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).resetsAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect((error as BudgetExceededError).message).toContain("Budget has been exceeded");
    expect(messageLines()).toBe(requests + 1);
    expect(rows[before]).toMatchObject({ outcome: "budget", modelId: "hb-small", inputTokens: 0, outputTokens: 0, costUsd: 0, gatewayCallId: null });
    expect(spans[spans.length - 1]["hb.outcome"]).toBe("budget");

    const streamed = await callModel(call({ alias: "hb-frontier" }), assistantRequest(true), deps(key)).catch((e: unknown) => e);
    expect(streamed).toBeInstanceOf(BudgetExceededError);
    expect(rows[rows.length - 1]).toMatchObject({ outcome: "budget", alias: "hb-frontier" });
  });

  /* Two attempts, not three: the classifier's row allows one retry, and it bounds a 5xx as it bounds a timeout. */
  it("raises GatewayUnavailableError after the row's retries on a 500 and writes an unavailable row", async () => {
    const key = await mint();
    const before = rows.length;
    const requests = messageLines();
    const error = await callModel(call(), CHECK, deps(key, { fetch: withHeader("x-hb-stub-fail", "500") })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect((error as GatewayUnavailableError).cause).toBe("server");
    expect(messageLines()).toBe(requests + 2);
    expect(rows[before]).toMatchObject({ outcome: "unavailable" });
  });

  /* The row's own retry count reaches the SDK: the classifier allows one retry (feature-specs/11 § 5.3, unit 37b),
   * so a gateway that never answers costs two attempts of its 5 s deadline, not the SDK's default three. */
  it("raises GatewayUnavailableError with cause timeout after the row's attempts when the gateway never answers", { timeout: 60_000 }, async () => {
    const key = await mint();
    const before = rows.length;
    let attempts = 0;
    const counting: Fetch = (input, init) => {
      attempts += 1;
      return withHeader("x-hb-stub-fail", "timeout")(input, init);
    };
    const started = Date.now();
    const error = await callModel(call(), CHECK, deps(key, { fetch: counting })).catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect((error as GatewayUnavailableError).cause).toBe("timeout");
    expect(attempts).toBe(2);
    expect(elapsed).toBeLessThan(15_000);
    expect(rows[before]).toMatchObject({ outcome: "unavailable" });
  });

  it("raises GatewayRefusedError on a key that may not use the alias, and records it as refused", async () => {
    const key = await mint({ models: ["hb-frontier"] });
    const before = rows.length;
    const error = await callModel(call(), CHECK, deps(key)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayRefusedError);
    expect((error as GatewayRefusedError).status).toBe(401);
    expect(rows[before]).toMatchObject({ outcome: "refused" });
  });

  it("refuses without a gateway, without a key, and against a closed port, recording each", async () => {
    const before = rows.length;
    const unconfigured = await callModel(call(), CHECK, deps("sk-any", { baseUrl: undefined })).catch((e: unknown) => e);
    expect(unconfigured).toBeInstanceOf(GatewayUnavailableError);
    expect((unconfigured as GatewayUnavailableError).cause).toBe("unconfigured");
    const noKey = await callModel(call(), CHECK, deps(null)).catch((e: unknown) => e);
    expect((noKey as GatewayUnavailableError).cause).toBe("no_key");
    const closed = await callModel(call(), CHECK, deps("sk-any", { baseUrl: "http://127.0.0.1:1" })).catch((e: unknown) => e);
    expect((closed as GatewayUnavailableError).cause).toBe("connection");
    expect(rows.slice(before).map((row) => row.outcome)).toEqual(["unavailable", "unavailable", "unavailable"]);
  });

  it("throws GATEWAY_KEYS_UNAVAILABLE without the secret, before any key is read or row written", async () => {
    const before = rows.length;
    let keyRead = false;
    const error = await gatewayClient({ userId: "u-1" }, deps("sk-any", { keySecret: undefined, findKey: async () => ((keyRead = true), null) })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("GATEWAY_KEYS_UNAVAILABLE");
    expect(keyRead).toBe(false);
    await expect(callModel(call(), CHECK, deps("sk-any", { keySecret: undefined }))).rejects.toMatchObject({ code: "GATEWAY_KEYS_UNAVAILABLE" });
    expect(rows).toHaveLength(before);
  });

  /* Unit 49f: a call that names its row gets that row's limits — the PDF row's one try, not the text row's three. */
  it("applies a row the call names: no retry on the PDF row, and a row of another alias refused before anything is sent", async () => {
    const key = await mint();
    const before = rows.length;
    const requests = messageLines();
    const error = await callModel(call({ purpose: "grading", row: "evidenceGraderBytes" }), CHECK, deps(key, { fetch: withHeader("x-hb-stub-fail", "500") })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(messageLines()).toBe(requests + 1);
    expect(rows[before]).toMatchObject({ outcome: "unavailable" });
    await expect(callModel(call({ purpose: "grading", row: "assistantDraft" }), CHECK, deps(key))).rejects.toMatchObject({ code: "GATEWAY_POLICY_UNKNOWN" });
    expect(messageLines()).toBe(requests + 1);
  });

  it("refuses a purpose without a policy row before calling anything", async () => {
    const before = rows.length;
    await expect(callModel(call({ purpose: "adjudication" }), CHECK, deps(await mint()))).rejects.toMatchObject({ code: "GATEWAY_POLICY_UNKNOWN" });
    expect(rows).toHaveLength(before);
  });

  it("runs the smoke check of a fresh environment and returns the usage block", async () => {
    const check = await gatewayCheck({ userId: "u-1" }, deps(await mint()));
    expect(check.model).toBe("claude-haiku-4-5");
    expect(check.usage.input_tokens).toBe(4);
    expect(check.usage.output_tokens).toBeGreaterThan(0);
  });
});

describe("budgetAwareFetch", () => {
  const budget = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Budget has been exceeded! Key=tiny (sk-...0001) Current cost: 0.000076, Max budget: 0.000001" } });
  const rate = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limit exceeded" } });

  function base(status: number, body: string): Fetch {
    return async () => new Response(body, { status, headers: { "content-type": "application/json", "x-litellm-call-id": "c-1" } });
  }

  it("marks a budget 429 as not retryable and leaves the body and other headers intact", async () => {
    const response = await budgetAwareFetch(base(429, budget))("http://gateway/v1/messages");
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("x-litellm-call-id")).toBe("c-1");
    expect(await response.text()).toBe(budget);
  });

  it("passes a plain 429 and every other status through untouched", async () => {
    expect((await budgetAwareFetch(base(429, rate))("http://gateway/v1/messages")).headers.has("x-should-retry")).toBe(false);
    expect((await budgetAwareFetch(base(200, "{}"))("http://gateway/v1/messages")).headers.has("x-should-retry")).toBe(false);
    expect((await budgetAwareFetch(base(500, budget))("http://gateway/v1/messages")).headers.has("x-should-retry")).toBe(false);
  });
});

describe("mapGatewayError", () => {
  const headers = new Headers();
  const budget429 = { type: "error", error: { type: "rate_limit_error", message: "Budget has been exceeded! Key=k (sk-...0001) Current cost: 1, Max budget: 1" } };
  const budget400 = { error: { message: "ExceededBudget: Crossed spend threshold", type: "budget_exceeded" } };

  it("maps the SDK's errors to the client's (feature-specs/11 § 5.2)", () => {
    expect(mapGatewayError(new APIConnectionTimeoutError(), NOW)).toMatchObject({ code: "GATEWAY_UNAVAILABLE", cause: "timeout" });
    expect(mapGatewayError(new APIConnectionError({ message: "refused" }), NOW)).toMatchObject({ code: "GATEWAY_UNAVAILABLE", cause: "connection" });
    expect(mapGatewayError(new RateLimitError(429, budget429, undefined, headers), NOW)).toMatchObject({ code: "GATEWAY_BUDGET", resetsAt: new Date("2026-10-01T00:00:00.000Z") });
    expect(mapGatewayError(new BadRequestError(400, budget400, undefined, headers), NOW)).toMatchObject({ code: "GATEWAY_BUDGET" });
    expect(mapGatewayError(new RateLimitError(429, { error: { message: "Rate limit exceeded" } }, undefined, headers), NOW)).toMatchObject({ cause: "rate_limit" });
    expect(mapGatewayError(new InternalServerError(503, { error: { message: "down" } }, undefined, headers), NOW)).toMatchObject({ cause: "server" });
    expect(mapGatewayError(new BadRequestError(400, { error: { message: "messages: roles must alternate" } }, undefined, headers), NOW)).toMatchObject({ code: "GATEWAY_REFUSED", status: 400 });
    expect(mapGatewayError(new NotFoundError(404, { error: { message: "no route" } }, undefined, headers), NOW)).toMatchObject({ code: "GATEWAY_REFUSED", status: 404 });
  });

  it("leaves an error that is not the gateway's alone", () => {
    expect(mapGatewayError(new Error("database down"), NOW)).toBeNull();
    expect(mapGatewayError("text", NOW)).toBeNull();
  });
});
