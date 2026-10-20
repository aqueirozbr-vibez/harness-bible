import { afterEach, describe, expect, it } from "vitest";

import type { GatewaySpan } from "@/lib/gateway/span";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";

import { PRODUCT_LANGFUSE_EXCLUDED, PRODUCT_LANGFUSE_KEYS } from "./langfuse";
import { aidRunSpanOf, answerLineOf, answerSpanOf, failedAnswerLine, genAiSpanOf, httpSpanOf, jobSpanOf, researchLineOf, researchSpanOf, retrieveSpanOf } from "./lines";
import { recordSpan, setSpanSink, withSpanScope, type SpanRecord } from "./spans";

/*
 * The product's half of the Langfuse road's allow-list (feature-specs/49 § 5.5, § 9.5): every key today's span
 * builders emit is either on PRODUCT_LANGFUSE_KEYS or among its deliberate exclusions, and the list names nothing no
 * builder emits. A builder that gains a key fails here until the key is placed, one way or the other.
 */

const TRACE = "0af7651916cd43dd8448eb211c80319c";

const MODEL_CALL: GatewaySpan = {
  "gen_ai.system": "anthropic",
  "gen_ai.request.model": "claude-opus-5",
  "hb.alias": "hb-frontier",
  "hb.guide.version": "v1.13",
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
  "x-litellm-call-id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  latency_ms: 3100,
  first_token_ms: 900,
};

const RESULT: AnswerResult = {
  kind: "answer",
  refusal: null,
  claims: [{ text: "one", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false }],
  citations: [{ sectionId: parseSectionId("21.3"), figureId: null, version: "v1.0.0", editionLang: "EN" }],
  verdicts: [],
  grounded: 0.9,
  repaired: false,
  guide: { version: "v1.13", sha256: "a".repeat(64) },
  modelId: "claude-opus-5",
  timings: { scopeMs: 1, retrieveMs: 200, firstTokenMs: 900, draftMs: 3000, sensorsMs: 5, graderMs: 800, totalMs: 4100 },
  usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 },
  modeResult: null,
};

const TURN = { traceId: TRACE, messageId: "m-1", mode: "explain", locale: "en", secretsRedacted: 0, ms: 4200 } as const;
const RUN = { traceId: TRACE, runId: "33333333-3333-4333-8333-333333333333" };

const RETRIEVE = retrieveSpanOf({ traceId: TRACE, mode: "explain", candidates: 22, embedMs: 40, sqlMs: 35, rerankMs: 120, ms: 200, overBudget: false, vectorReady: true }, 1_000);

/** One span of every builder of lib/telemetry/lines.ts, each with every optional key it can carry. */
const BUILT: ReadonlyArray<SpanRecord> = [
  httpSpanOf({ traceId: TRACE, spanId: "a".repeat(16), parentId: "b".repeat(16), method: "GET", path: "/api/v1/me", status: 500, ms: 3, subject: "user:u-1", policy: "allow", code: "INTERNAL" }, 1_000),
  genAiSpanOf(MODEL_CALL, 1_000),
  jobSpanOf({ traceId: TRACE, job: "assistant:purge", counts: { messages: 12, conversations: 3 }, ms: 180, error: "Error: x" }, 1_000),
  RETRIEVE,
  aidRunSpanOf({ traceId: TRACE, aidId: "21.8-task-survival", runner: "docker", exitCode: 0, timedOut: false, ms: 640 }, 1_000),
  answerSpanOf(answerLineOf(TURN, RESULT), 1_000),
  answerSpanOf(failedAnswerLine(TURN, "BUDGET_EXCEEDED"), 1_000),
  researchSpanOf(researchLineOf("write", RUN, "report", 4_000, { findings: 1, paragraphs: 3, dropped: 1 }), 1_000),
  researchSpanOf(researchLineOf("run", RUN, "DONE", 90_000, { searches: 4, pageReads: 2, findings: 2, proposed: 1, refuted: 1 }), 1_000),
];

function excluded(key: string): boolean {
  return PRODUCT_LANGFUSE_EXCLUDED.some((entry) => (entry.endsWith(".") ? key.startsWith(entry) : key === entry));
}

/** What `recordSpan` hands the tracer for each built span, recorded inside a request's scope, as the workers record them. */
function recorded(): ReadonlyArray<SpanRecord> {
  const seen: SpanRecord[] = [];
  setSpanSink((record) => seen.push(record));
  const secret = ["sk", "ant", `api03-${"Kd4".repeat(30)}`].join("-");
  withSpanScope({ traceId: TRACE, spanId: "c".repeat(16), request: true }, () => {
    for (const span of BUILT) recordSpan(span);
    /* the guard's mark, which recordSpan adds to a span a secret reached */
    recordSpan({ ...RETRIEVE, attributes: { ...RETRIEVE.attributes, "hb.mode": secret } });
  });
  return seen;
}

afterEach(() => setSpanSink(null));

describe("PRODUCT_LANGFUSE_KEYS (49 § 5.5)", () => {
  it("holds every key a span builder emits, but the deliberate exclusions", () => {
    const keys = new Set(recorded().flatMap((span) => Object.keys(span.attributes)));
    expect(keys).toContain("hb.parent");
    expect(keys).toContain("hb.secret.detected");
    const placed = new Set<string>(PRODUCT_LANGFUSE_KEYS);
    expect([...keys].filter((key) => !placed.has(key) && !excluded(key)).sort()).toEqual([]);
  });

  it("names nothing no builder emits, nothing it excludes, and each key once", () => {
    const keys = new Set(recorded().flatMap((span) => Object.keys(span.attributes)));
    expect(PRODUCT_LANGFUSE_KEYS.filter((key) => !keys.has(key))).toEqual([]);
    expect(PRODUCT_LANGFUSE_KEYS.filter(excluded)).toEqual([]);
    expect(new Set(PRODUCT_LANGFUSE_KEYS).size).toBe(PRODUCT_LANGFUSE_KEYS.length);
    expect([...PRODUCT_LANGFUSE_KEYS]).toEqual([...PRODUCT_LANGFUSE_KEYS].sort());
  });

  it("names no person, account, session or address, whatever a builder emits (§ 6.5, D1)", () => {
    for (const key of PRODUCT_LANGFUSE_KEYS) expect(key).not.toMatch(/principal|subject|user|session|conversation|organisation|email|address|path|url|http|\.ip$|key_alias|team/);
    for (const key of ["hb.principal", "hb.subject", "url.path", "http.request.method", "http.response.status_code", "gen_ai.usage.input_tokens", "gen_ai.request.model", "gen_ai.system", "hb.parent", "hb.count.messages"]) {
      expect(excluded(key), key).toBe(true);
    }
  });
});
