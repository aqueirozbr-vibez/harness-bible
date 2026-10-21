import { afterEach, describe, expect, it } from "vitest";

import type { GatewaySpan } from "@/lib/gateway/span";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";

import { langfuseAttributesOf, PRODUCT_LANGFUSE_EXCLUDED, PRODUCT_LANGFUSE_KEYS } from "./langfuse";
import { activitySpanOf, aidRunSpanOf, answerLineOf, answerSpanOf, failedAnswerLine, genAiSpanOf, httpSpanOf, jobSpanOf, researchLineOf, researchSpanOf, retrieveSpanOf, searchSpanOf, sensorSpanOf } from "./lines";
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
  "hb.agent": "assistant.draft",
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
  span_id: "d".repeat(16),
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
  answerSpanOf({ ...answerLineOf(TURN, RESULT), outcome: "refusal", refusalCause: "R-SCOPE" }, 1_000),
  sensorSpanOf({ traceId: TRACE, sensor: "scope", result: "FAIL", rule: "unverified", code: "R-UNVERIFIED", claims: null, substituted: null, ms: 1 }, 1_000),
  sensorSpanOf({ traceId: TRACE, sensor: "citation", result: "WARN", rule: null, code: null, claims: 4, substituted: 1, ms: 2 }, 1_000),
  searchSpanOf({ traceId: TRACE, outcome: "failed", code: "GATEWAY_BUDGET", ms: 40 }, 1_000),
  researchSpanOf(researchLineOf("write", RUN, "report", 4_000, { findings: 1, paragraphs: 3, dropped: 1 }), 1_000),
  researchSpanOf(researchLineOf("run", RUN, "DONE", 90_000, { searches: 4, pageReads: 2, findings: 2, proposed: 1, refuted: 1 }), 1_000),
];

const ACTIVITY = { traceId: TRACE, activity: "planRun", workflowType: "ResearchRunWorkflow", workflowId: `research:${RUN.runId}`, attempt: 1, outcome: "ok", code: null, ms: 900 } as const;

/** A workflow's activities (49 § 7.1; unit 84): one that went, one that failed, a legacy run's with its mark, and the run's own line. */
const ACTIVITIES: ReadonlyArray<SpanRecord> = [
  activitySpanOf(ACTIVITY, 1_000),
  activitySpanOf({ ...ACTIVITY, attempt: 2, outcome: "failed", code: "TIMEOUT" }, 1_000),
  activitySpanOf({ ...ACTIVITY, workflowType: "ResearchWorkflow", legacy: true, runId: RUN.runId }, 1_000),
  researchSpanOf(researchLineOf("run", RUN, "SKIPPED", 2_000, { code: "NOT_RUN" }), 1_000),
];

/** The subjects' trace attributes the activities' scopes carry, each with its record id (§ 6.4). */
const WORKFLOW_TRACES = [
  { name: "research.run", tags: ["research"], metadata: { run_id: RUN.runId } },
  { name: "suggestion", tags: ["suggestion"], metadata: { suggestion_id: "S-21-0016" } },
  { name: "export", tags: ["export"], metadata: { workflow_id: "export:44444444-4444-4444-8444-444444444444" } },
] as const;

function excluded(key: string): boolean {
  return PRODUCT_LANGFUSE_EXCLUDED.some((entry) => (entry.endsWith(".") ? key.startsWith(entry) : key === entry));
}

/** What `recordSpan` hands the tracer for each built span, recorded inside a request's scope, as the workers record them. */
function recorded(): ReadonlyArray<SpanRecord> {
  const seen: SpanRecord[] = [];
  setSpanSink((record) => seen.push(record));
  const secret = ["sk", "ant", `api03-${"Kd4".repeat(30)}`].join("-");
  /* with a subject's trace attributes, as a turn's scope carries them (49 § 6.4) */
  withSpanScope({ traceId: TRACE, spanId: "c".repeat(16), request: true, trace: { name: "assistant.turn", tags: ["turn", "mode:explain"], release: "2026.09" } }, () => {
    for (const span of BUILT) recordSpan(span);
    /* the guard's mark, which recordSpan adds to a span a secret reached */
    recordSpan({ ...RETRIEVE, attributes: { ...RETRIEVE.attributes, "hb.mode": secret } });
  });
  /* an activity's scope: no request, its subject's trace attributes (49 § 7.1) */
  for (const trace of WORKFLOW_TRACES) {
    withSpanScope({ traceId: TRACE, spanId: "e".repeat(16), trace }, () => {
      for (const span of ACTIVITIES) recordSpan(span);
    });
  }
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

describe("langfuseAttributesOf (49 § 6.3, § 6.4, § 8)", () => {
  it("shows a sensor as a guardrail, at level WARNING where it did not pass, and never as an error", () => {
    for (const result of ["FAIL", "WARN"]) expect(langfuseAttributesOf("sensor.citation", { "hb.sensor.result": result })).toEqual({ "langfuse.observation.type": "guardrail", "langfuse.observation.level": "WARNING" });
    for (const result of ["PASS", "NA"]) expect(langfuseAttributesOf("sensor.scope", { "hb.sensor.result": result })).toEqual({ "langfuse.observation.type": "guardrail" });
  });

  it("types the turn as an agent and its retrieval as a retriever, and leaves every other span Langfuse's default", () => {
    expect(langfuseAttributesOf("assistant.answer", {})["langfuse.observation.type"]).toBe("agent");
    expect(langfuseAttributesOf("assistant.retrieve", {})["langfuse.observation.type"]).toBe("retriever");
    for (const name of ["gen_ai.chat", "gen_ai.embeddings", "aid.run", "search.query", "research.run"]) expect(langfuseAttributesOf(name, {}), name).toEqual({});
  });

  it("sets the subject's name, tags and release on any span its scope carries them to, and its outcome on its own span alone", () => {
    const trace = { name: "assistant.turn", tags: ["turn", "mode:compare", "locale:pt"], release: "2026.09" };
    expect(langfuseAttributesOf("gen_ai.chat", { "hb.outcome": "ok" }, trace)).toEqual({ "langfuse.trace.name": "assistant.turn", "langfuse.trace.tags": ["turn", "mode:compare", "locale:pt"], "langfuse.release": "2026.09" });
    expect(langfuseAttributesOf("assistant.answer", { "hb.outcome": "refusal", "hb.refusal.cause": "R-SCOPE", "hb.code": null, "hb.message_id": "m-1" }, trace)).toMatchObject({
      "langfuse.trace.metadata.outcome": "refusal",
      "langfuse.trace.metadata.refusal_cause": "R-SCOPE",
      "langfuse.trace.metadata.message_id": "m-1",
    });
    expect(langfuseAttributesOf("assistant.answer", { "hb.outcome": "failed", "hb.code": "BUDGET_EXCEEDED" })).not.toHaveProperty("langfuse.trace.metadata.refusal_cause");
    /* a search's trace has no release when its route is not told one */
    expect(langfuseAttributesOf("search.query", {}, { name: "search.query", tags: ["search"] })).toEqual({ "langfuse.trace.name": "search.query", "langfuse.trace.tags": ["search"] });
  });

  it("sets a workflow's record id on every span of its trace, and a run's outcome only in a research's own trace (unit 84)", () => {
    const research = { name: "research.run", tags: ["research"], metadata: { run_id: "r-1" } };
    expect(langfuseAttributesOf("activity.planRun", { "hb.outcome": "ok" }, research)).toEqual({ "langfuse.trace.name": "research.run", "langfuse.trace.tags": ["research"], "langfuse.trace.metadata.run_id": "r-1" });
    expect(langfuseAttributesOf("research.run", { "hb.outcome": "SKIPPED", "hb.code": "NOT_RUN" }, research)).toMatchObject({ "langfuse.trace.metadata.outcome": "SKIPPED", "langfuse.trace.metadata.code": "NOT_RUN" });
    /* a legacy run's line lands in its turn's trace, or in none: the turn's outcome is the turn's */
    expect(langfuseAttributesOf("research.run", { "hb.outcome": "DONE", "hb.code": null }, { name: "assistant.turn", tags: ["turn"] })).not.toHaveProperty("langfuse.trace.metadata.outcome");
    expect(langfuseAttributesOf("research.run", { "hb.outcome": "DONE" })).toEqual({});
    expect(langfuseAttributesOf("activity.gradeItem", {}, { name: "suggestion", tags: ["suggestion"], metadata: {} })).toEqual({ "langfuse.trace.name": "suggestion", "langfuse.trace.tags": ["suggestion"] });
  });
});
