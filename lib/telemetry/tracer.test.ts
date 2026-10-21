import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logJob, logSpan } from "@/lib/api/log";
import { logGatewaySpan, type GatewaySpan } from "@/lib/gateway/span";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";
import { startOtlpReceiver, type OtlpReceiver, type ReceivedSpan } from "@/tests/fixtures/otlp";

import { answerLineOf, failedAnswerLine, logAidRun, logAnswer, logRetrieve } from "./lines";
import { telemetryOn, withSpanScope } from "./spans";
import { flushTelemetry, startTelemetry, stopTelemetry } from "./tracer";

/*
 * The tracer against a stand-in collector (feature-specs/21 § 5.1, § 13.4): the product's own logging functions are
 * called as the product calls them, and what arrives over OTLP/HTTP is read back. Nothing of the exporter is doubled.
 */

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const WEB_SPAN = "b7ad6b7169203331";
const WORKERS_SPAN = "00f067aa0ba902b7";
const QUESTION = "Why does a retried write without an idempotency key become a second write?";
const CLAIM = "A retried write without a key is a second write.";

const MODEL_CALL: GatewaySpan = {
  "gen_ai.system": "anthropic",
  "gen_ai.request.model": "claude-opus-5",
  "hb.alias": "hb-frontier",
  "hb.agent": "assistant.draft",
  "hb.guide.version": "v1.12",
  "hb.guide.sha256": "a".repeat(64),
  "hb.prompt.sha256": "b".repeat(64),
  "gen_ai.usage.input_tokens": 1200,
  "gen_ai.usage.output_tokens": 300,
  "gen_ai.usage.cache_read_input_tokens": 1000,
  "gen_ai.usage.cache_creation_input_tokens": 0,
  "hb.cost_usd": 0.014,
  "hb.price_unknown": false,
  "hb.web_search_requests": 0,
  "hb.purpose": "assistant",
  "hb.principal": "org:00000000-0000-4000-8000-00000000de01",
  "hb.outcome": "ok",
  trace_id: TRACE,
  span_id: "c".repeat(16),
  "x-litellm-call-id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  latency_ms: 3100,
  first_token_ms: 900,
};

const RESULT: AnswerResult = {
  kind: "answer",
  refusal: null,
  claims: [{ text: CLAIM, sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false }],
  citations: [{ sectionId: parseSectionId("21.3"), figureId: null, version: "v1.0.0", editionLang: "EN" }],
  verdicts: [{ sensor: "edition", verdict: "PASS", detail: "1 / 1 citations resolve in EN v1.0.0", data: { citations: 1, edition: "EN", version: "v1.0.0", mismatch: true } }],
  grounded: 0.9,
  repaired: false,
  guide: { version: "v1.12", sha256: "a".repeat(64) },
  modelId: "claude-opus-5",
  timings: { scopeMs: 1, retrieveMs: 200, firstTokenMs: 900, draftMs: 3000, sensorsMs: 5, graderMs: 800, totalMs: 4100 },
  usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 },
  modeResult: null,
};

/** One turn's worth of lines, written as the web tier and the workers write them. */
function emitTurn(): void {
  logSpan({ traceId: TRACE, spanId: WEB_SPAN, method: "POST", path: "/api/v1/assistant/conversations/c1/messages", status: 200, ms: 4300, subject: "user:u-1", policy: "allow" });
  withSpanScope({ traceId: TRACE, spanId: WORKERS_SPAN, request: true }, () => {
    logRetrieve({ traceId: TRACE, mode: "explain", candidates: 22, embedMs: 40, sqlMs: 35, rerankMs: 120, ms: 200, overBudget: false, vectorReady: true });
    logGatewaySpan(MODEL_CALL);
    logGatewaySpan({ ...MODEL_CALL, "hb.purpose": "grading", span_id: "e".repeat(16), latency_ms: 800, first_token_ms: null });
    logGatewaySpan({ ...MODEL_CALL, "hb.purpose": "embed", span_id: "f".repeat(16), "hb.alias": "hb-embed", "gen_ai.request.model": "hb-embed", "hb.guide.version": null, "hb.guide.sha256": null, latency_ms: 40, first_token_ms: null });
    logAidRun({ traceId: TRACE, aidId: "21.8-task-survival", runner: "docker", exitCode: 0, timedOut: false, ms: 640 });
    logAnswer(answerLineOf({ traceId: TRACE, messageId: "m-1", mode: "explain", locale: "pt", secretsRedacted: 1, ms: 4200 }, RESULT));
  });
  logSpan({ traceId: TRACE, spanId: WORKERS_SPAN, parentId: WEB_SPAN, method: "POST", path: "/answer", status: 200, ms: 4250, subject: null });
}

describe("the tracer", () => {
  let receiver: OtlpReceiver;
  const named = (name: string): ReadonlyArray<ReceivedSpan> => receiver.spans().filter((span) => span.name === name);

  beforeEach(async () => {
    receiver = await startOtlpReceiver();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await stopTelemetry();
    await receiver.close();
    vi.restoreAllMocks();
  });

  it("exports nothing without an endpoint, and the lines are written all the same", async () => {
    expect(await startTelemetry("hb-web")).toBe(false);
    expect(telemetryOn()).toBe(false);
    emitTurn();
    await flushTelemetry();
    expect(receiver.requests()).toBe(0);
    const kinds = vi.mocked(console.info).mock.calls.map((call) => (JSON.parse(String(call[0])) as { kind: string }).kind);
    expect(kinds).toEqual(["span", "retrieve", "model_call", "model_call", "model_call", "aid_run", "answer", "span"]);
  });

  it("exports each line as a span of one trace, with the lines' own ids and the caller as parent", async () => {
    expect(await startTelemetry("hb-workers", receiver.url)).toBe(true);
    emitTurn();
    await flushTelemetry();

    const spans = receiver.spans();
    expect(spans.map((span) => span.name).sort()).toEqual(["aid.run", "assistant.answer", "assistant.retrieve", "gen_ai.chat", "gen_ai.chat", "gen_ai.embeddings", "http.request", "http.request"]);
    expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([TRACE]));
    expect(new Set(spans.map((span) => span.service))).toEqual(new Set(["hb-workers"]));

    const [web, workers] = [named("http.request").find((span) => span.spanId === WEB_SPAN), named("http.request").find((span) => span.spanId === WORKERS_SPAN)];
    expect(web).toMatchObject({ parentSpanId: "", kind: 2, ms: 4300, attributes: { "http.request.method": "POST", "http.response.status_code": 200, "hb.subject": "user:u-1", "hb.policy": "allow" } });
    expect(workers).toMatchObject({ parentSpanId: WEB_SPAN, kind: 2, ms: 4250 });
    /* Everything the workers did for the request hangs under the workers' request span, marked so for the Langfuse
       road, which drops that span (feature-specs/49 § 5.6); a request's own span names its caller and is not marked. */
    for (const span of spans.filter((candidate) => candidate.name !== "http.request")) expect(span).toMatchObject({ parentSpanId: WORKERS_SPAN, attributes: { "hb.parent": "request" } });
    for (const span of named("http.request")) expect(span.attributes).not.toHaveProperty("hb.parent");

    const draft = named("gen_ai.chat").find((span) => span.attributes["hb.purpose"] === "assistant");
    /* exported under the id its call's traceparent sent, the gateway's generation's parent (49 § 5.3) */
    expect(draft?.spanId).toBe(MODEL_CALL.span_id);
    expect(draft).toMatchObject({
      kind: 3,
      ms: 3100,
      attributes: {
        "gen_ai.system": "anthropic",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "claude-opus-5",
        "gen_ai.usage.input_tokens": 1200,
        "gen_ai.usage.output_tokens": 300,
        "gen_ai.usage.cache_read_input_tokens": 1000,
        "gen_ai.usage.cache_creation_input_tokens": 0,
        "hb.guide.version": "v1.12",
        "hb.prompt.sha256": "b".repeat(64),
        "hb.cost_usd": 0.014,
        "hb.purpose": "assistant",
        "hb.principal": "org:00000000-0000-4000-8000-00000000de01",
        "hb.gateway.call_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        "hb.first_token_ms": 900,
      },
    });
    expect(named("gen_ai.chat").map((span) => span.attributes["hb.purpose"]).sort()).toEqual(["assistant", "grading"]);
    /* A null on the line is an absent attribute on the span, not a string. */
    expect(named("gen_ai.embeddings")[0]?.attributes).not.toHaveProperty("hb.guide.version");
    expect(named("assistant.retrieve")[0]).toMatchObject({ ms: 200, attributes: { "hb.mode": "explain", "hb.candidates": 22, "hb.embed_ms": 40, "hb.sql_ms": 35, "hb.rerank_ms": 120, "hb.over_budget": false, "hb.vector_ready": true } });
    expect(named("aid.run")[0]).toMatchObject({ ms: 640, attributes: { "hb.aid.id": "21.8-task-survival", "hb.aid.runner": "docker", "hb.aid.exit_code": 0, "hb.aid.timed_out": false } });
    expect(named("assistant.answer")[0]).toMatchObject({
      ms: 4200,
      status: { code: 0 },
      attributes: {
        "hb.message_id": "m-1",
        "hb.mode": "explain",
        "hb.outcome": "answer",
        "hb.citations.total": 1,
        "hb.citations.resolved": 1,
        "hb.substituted": 0,
        "hb.repaired": false,
        "hb.grounded": 0.9,
        "hb.first_token_ms": 900,
        "hb.total_ms": 4100,
        "hb.edition.locale": "pt",
        "hb.edition.cited": "EN",
        "hb.edition.mismatch": true,
        "hb.secret.redacted": 1,
      },
    });
  });

  it("marks what failed with its code, and a job with its counts", async () => {
    await startTelemetry("hb-jobs", receiver.url);
    logAnswer(failedAnswerLine({ traceId: TRACE, messageId: "m-2", mode: "walk", locale: "en", secretsRedacted: 0, ms: 900 }, "AID_RUN_FAILED"));
    logAidRun({ traceId: TRACE, aidId: "21.8-task-survival", runner: "docker", exitCode: null, timedOut: true, ms: 600_000 });
    logGatewaySpan({ ...MODEL_CALL, "hb.outcome": "unavailable" });
    logSpan({ traceId: TRACE, spanId: WEB_SPAN, method: "GET", path: "/api/v1/me", status: 503, ms: 12, subject: null, code: "ASSISTANT_UNAVAILABLE" });
    logJob({ traceId: "c".repeat(32), job: "assistant:purge", counts: { messages: 12, conversations: 3 }, ms: 180 });
    logJob({ traceId: "d".repeat(32), job: "auth:sweep", counts: {}, ms: 9, error: "PrismaClientKnownRequestError: Key (email)=(reader@example.test) already exists" });
    await flushTelemetry();

    expect(named("assistant.answer")[0]).toMatchObject({ status: { code: 2, message: "AID_RUN_FAILED" }, attributes: { "hb.outcome": "failed", "hb.code": "AID_RUN_FAILED" } });
    expect(named("aid.run")[0]).toMatchObject({ status: { code: 2, message: "AID_TIMED_OUT" }, attributes: { "hb.aid.timed_out": true } });
    expect(named("gen_ai.chat")[0]?.status).toEqual({ code: 2, message: "unavailable" });
    expect(named("http.request")[0]).toMatchObject({ status: { code: 2, message: "ASSISTANT_UNAVAILABLE" }, attributes: { "hb.code": "ASSISTANT_UNAVAILABLE" } });
    const [purge, sweep] = [named("job").find((span) => span.attributes["hb.job"] === "assistant:purge"), named("job").find((span) => span.attributes["hb.job"] === "auth:sweep")];
    expect(purge).toMatchObject({ traceId: "c".repeat(32), parentSpanId: "", ms: 180, service: "hb-jobs", attributes: { "hb.count.messages": 12, "hb.count.conversations": 3 } });
    /* The span keeps the error's name; the message, which quotes a row, stays in the line. */
    expect(sweep?.status).toEqual({ code: 2, message: "PrismaClientKnownRequestError" });
  });

  it("carries no words: not the question, a claim, an e-mail or a key, in any attribute or status of any span", async () => {
    await startTelemetry("hb-workers", receiver.url);
    emitTurn();
    logJob({ traceId: "d".repeat(32), job: "auth:sweep", counts: {}, ms: 9, error: `Error: could not sweep reader@example.test asking "${QUESTION}"` });
    await flushTelemetry();

    const strings = receiver.spans().flatMap((span) => [span.status.message, ...Object.values(span.attributes).filter((value): value is string => typeof value === "string")]);
    expect(strings.length).toBeGreaterThan(20);
    for (const value of strings) {
      expect(value).not.toContain(QUESTION);
      expect(value).not.toContain(CLAIM);
      expect(value).not.toMatch(/@/);
      expect(value).not.toMatch(/sk-[A-Za-z0-9_-]{16,}|Bearer /);
      /* An id, a code, a hash, a path or a name: nothing in a span reads as a sentence. */
      expect(value).not.toMatch(/\s/);
    }
  });

  it("replaces a secret that reached a span's attribute or status, and marks the span and the line", async () => {
    await startTelemetry("hb-web", receiver.url);
    const key = ["sk", "ant", `api03-${"Kd4".repeat(30)}`].join("-");
    logSpan({ traceId: TRACE, spanId: WEB_SPAN, method: "GET", path: `/api/v1/keys/${key}`, status: 500, ms: 3, subject: null, code: `Bearer ${"t".repeat(32)}` });
    logSpan({ traceId: TRACE, spanId: WORKERS_SPAN, method: "GET", path: "/api/v1/me", status: 200, ms: 3, subject: null });
    await flushTelemetry();

    const [leaky, clean] = [named("http.request").find((span) => span.spanId === WEB_SPAN), named("http.request").find((span) => span.spanId === WORKERS_SPAN)];
    expect(leaky?.attributes).toMatchObject({ "url.path": "/api/v1/keys/[redacted:anthropic-key]", "hb.code": "[redacted:bearer-token]", "hb.secret.detected": true });
    expect(leaky?.status).toEqual({ code: 2, message: "[redacted:bearer-token]" });
    expect(clean?.attributes).not.toHaveProperty("hb.secret.detected");
    expect(JSON.stringify(receiver.spans())).not.toContain(key.slice(7, 27));
    /* The line is guarded on its own, by the same rule. */
    const lines = vi.mocked(console.info).mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ kind: "span", path: "/api/v1/keys/[redacted:anthropic-key]", "hb.secret.detected": true });
    expect(lines[1]).not.toHaveProperty("hb.secret.detected");
  });

  it("warns once when the collector does not take the spans, and the work they describe goes on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    /* A collector that answers 500: the exporter fails at once, where an unreachable one is retried for ten seconds first. */
    const broken = await startOtlpReceiver({ refuse: true });
    const dead = broken.url;
    await startTelemetry("hb-web", dead);
    expect(() => emitTurn()).not.toThrow();
    await flushTelemetry();
    emitTurn();
    await flushTelemetry();
    const warnings = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("telemetry: the collector"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(new URL(dead).origin);
    expect(broken.requests()).toBe(2);
    await stopTelemetry();
    await broken.close();
  });
});
