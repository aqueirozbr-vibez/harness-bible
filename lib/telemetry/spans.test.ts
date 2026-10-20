import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnswerResult } from "@/lib/schemas/assistant";
import { PURPOSES } from "@/lib/schemas/gateway";
import { parseSectionId } from "@/lib/schemas/ids";

import { aidRunSpanOf, answerLineOf, answerSpanOf, failedAnswerLine, genAiSpanOf, httpSpanOf, jobSpanOf, researchLineOf, researchSpanOf } from "./lines";
import { currentSpanId, currentTraceId, recordSpan, setSpanSink, telemetryOn, withSpanScope, type SpanRecord } from "./spans";

/*
 * The seam and the lines' spans, without a tracer (feature-specs/21 § 5.1): who a span's parent is, that recording
 * costs nothing and fails nothing, and the cases of each line that the tracer's own suite does not walk.
 */

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const OTHER = "1".repeat(32);
const SPAN: SpanRecord = { name: "assistant.retrieve", traceId: TRACE, endedAt: 1_000, ms: 10, attributes: {} };

afterEach(() => {
  setSpanSink(null);
  vi.restoreAllMocks();
});

describe("recordSpan", () => {
  it("does nothing, and says so, when no tracer is started", () => {
    expect(telemetryOn()).toBe(false);
    expect(() => recordSpan(SPAN)).not.toThrow();
  });

  it("gives a span the request it ran inside as its parent, when that request is of the same trace", () => {
    const seen: Array<string | null> = [];
    setSpanSink((record) => seen.push(record.parentId));

    recordSpan(SPAN);
    withSpanScope({ traceId: TRACE, spanId: "a".repeat(16) }, () => recordSpan(SPAN));
    withSpanScope({ traceId: OTHER, spanId: "b".repeat(16) }, () => recordSpan(SPAN));
    /* A span is not its own parent: the request's line is written from inside the request. */
    withSpanScope({ traceId: TRACE, spanId: "c".repeat(16) }, () => recordSpan({ ...SPAN, spanId: "c".repeat(16) }));
    /* What the line names wins over where the code runs, null included. */
    withSpanScope({ traceId: TRACE, spanId: "a".repeat(16) }, () => recordSpan({ ...SPAN, parentId: "d".repeat(16) }));
    withSpanScope({ traceId: TRACE, spanId: "a".repeat(16) }, () => recordSpan({ ...SPAN, parentId: null }));

    expect(seen).toEqual([null, "a".repeat(16), null, null, "d".repeat(16), null]);
  });

  it("marks a span whose parent it takes from a request's scope, and no other (49 § 5.6)", () => {
    const seen: Array<{ parent: string | null; mark: unknown }> = [];
    setSpanSink((record) => seen.push({ parent: record.parentId, mark: record.attributes["hb.parent"] }));

    withSpanScope({ traceId: TRACE, spanId: "a".repeat(16), request: true }, () => recordSpan(SPAN));
    /* a parent the line names is its caller's, kept everywhere; null names none */
    withSpanScope({ traceId: TRACE, spanId: "a".repeat(16), request: true }, () => recordSpan({ ...SPAN, parentId: "d".repeat(16) }));
    withSpanScope({ traceId: TRACE, spanId: "a".repeat(16), request: true }, () => recordSpan({ ...SPAN, parentId: null }));
    /* outside a scope, in a scope that is not a request's, in a request of another trace, and the request's own span */
    recordSpan(SPAN);
    withSpanScope({ traceId: TRACE, spanId: "a".repeat(16) }, () => recordSpan(SPAN));
    withSpanScope({ traceId: OTHER, spanId: "b".repeat(16), request: true }, () => recordSpan(SPAN));
    withSpanScope({ traceId: TRACE, spanId: "c".repeat(16), request: true }, () => recordSpan({ ...SPAN, spanId: "c".repeat(16) }));

    expect(seen).toEqual([
      { parent: "a".repeat(16), mark: "request" },
      { parent: "d".repeat(16), mark: undefined },
      { parent: null, mark: undefined },
      { parent: null, mark: undefined },
      { parent: "a".repeat(16), mark: undefined },
      { parent: null, mark: undefined },
      { parent: null, mark: undefined },
    ]);
  });

  it("keeps the scope across awaits, and ends it with the call", async () => {
    const inside = await withSpanScope({ traceId: TRACE, spanId: "a".repeat(16) }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentSpanId(TRACE);
    });
    expect(inside).toBe("a".repeat(16));
    expect(currentSpanId(TRACE)).toBeNull();
    /* A caller that was handed no trace id takes the request's, and has none outside a request. */
    expect(withSpanScope({ traceId: TRACE, spanId: "a".repeat(16) }, () => currentTraceId())).toBe(TRACE);
    expect(currentTraceId()).toBeNull();
  });

  it("never fails the work it describes: a tracer that throws costs one warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setSpanSink(() => {
      throw new TypeError("the exporter is gone");
    });
    expect(() => recordSpan(SPAN)).not.toThrow();
    expect(warn).toHaveBeenCalledWith("telemetry: a span was not recorded", "TypeError");
  });
});

const RESULT: AnswerResult = {
  kind: "answer",
  refusal: null,
  claims: [
    { text: "one", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false },
    { text: "the book does not cover this", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: false, substituted: true },
  ],
  citations: [
    { sectionId: parseSectionId("21.3"), figureId: null, version: "v1.0.0", editionLang: "EN" },
    { sectionId: parseSectionId("21.4"), figureId: null, version: "v0.9.0", editionLang: "EN" },
  ],
  verdicts: [{ sensor: "edition", verdict: "FAIL", detail: "21.4 is not at the release's version", data: { citations: 2, editions: 1, wrongVersion: 1 } }],
  grounded: 0.75,
  repaired: true,
  guide: { version: "v1.12", sha256: "a".repeat(64) },
  modelId: "claude-opus-5",
  timings: { scopeMs: 1, retrieveMs: 200, firstTokenMs: 900, draftMs: 3000, sensorsMs: 5, graderMs: 800, totalMs: 4100 },
  usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 },
  modeResult: null,
};
const TURN = { traceId: TRACE, messageId: "m-1", mode: "explain", locale: "en", secretsRedacted: 0, ms: 4200 } as const;

describe("the lines as spans", () => {
  it("counts a citation as resolved when it is at the release's version, and a replaced claim as substituted", () => {
    expect(answerLineOf(TURN, RESULT)).toMatchObject({ outcome: "answer", citationsTotal: 2, citationsResolved: 1, substituted: 1, repaired: true, grounded: 0.75, citesEdition: "EN", editionMismatch: false });
    expect(answerLineOf({ ...TURN, locale: "pt" }, RESULT).editionMismatch).toBe(true);
  });

  it("names a refusal's cause, and has no edition to mismatch when nothing was cited", () => {
    const refusal: AnswerResult = { ...RESULT, kind: "refusal", refusal: { cause: "R-SCOPE-OT", code: "R-SCOPE-OT", pointers: [], beforeRetrieval: true }, claims: [], citations: [], verdicts: [], grounded: null };
    const line = answerLineOf({ ...TURN, locale: "pt" }, refusal);
    expect(line).toMatchObject({ outcome: "refusal", refusalCause: "R-SCOPE-OT", citationsTotal: 0, citationsResolved: 0, citesEdition: null, editionMismatch: false });
    expect(answerSpanOf(line, 5_000)).toMatchObject({ name: "assistant.answer", attributes: { "hb.outcome": "refusal", "hb.refusal.cause": "R-SCOPE-OT" } });
    expect(answerSpanOf(line, 5_000)).not.toHaveProperty("error");
  });

  it("measures nothing for a turn that failed, and marks it with its code", () => {
    const span = answerSpanOf(failedAnswerLine(TURN, "BUDGET_EXCEEDED"), 5_000);
    expect(span).toMatchObject({ error: "BUDGET_EXCEEDED", ms: 4200, attributes: { "hb.outcome": "failed", "hb.code": "BUDGET_EXCEEDED", "hb.total_ms": null, "hb.grounded": null } });
  });

  it("names a model call by what it did: chat for the assistant and the grader, the embedder's and the re-ranker's own", () => {
    const base = {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "m",
      "hb.alias": "hb-frontier",
      "hb.guide.version": null,
      "hb.guide.sha256": null,
      "hb.prompt.sha256": "b".repeat(64),
      "gen_ai.usage.input_tokens": 1,
      "gen_ai.usage.output_tokens": 1,
      "gen_ai.usage.cache_read_input_tokens": 0,
      "gen_ai.usage.cache_creation_input_tokens": 0,
      "hb.cost_usd": 0,
      "hb.price_unknown": false,
      "hb.web_search_requests": 0,
      "hb.principal": "user:u-1",
      "hb.outcome": "ok",
      trace_id: TRACE,
      "x-litellm-call-id": null,
      latency_ms: 5,
      first_token_ms: null,
    } as const;
    expect(PURPOSES.map((purpose) => genAiSpanOf({ ...base, "hb.purpose": purpose }, 1_000).name)).toEqual(["gen_ai.chat", "gen_ai.chat", "gen_ai.chat", "gen_ai.chat", "gen_ai.embeddings", "gen_ai.rerank", "gen_ai.chat"]);
    /* A provider's refusal is an answer of a kind, not a failed call; a budget refusal is a failed one. */
    expect(genAiSpanOf({ ...base, "hb.purpose": "assistant", "hb.outcome": "provider_refusal" }, 1_000)).not.toHaveProperty("error");
    expect(genAiSpanOf({ ...base, "hb.purpose": "assistant", "hb.outcome": "budget" }, 1_000).error).toBe("budget");
  });

  it("makes a request a root unless its caller named itself, and an error only of a 5xx", () => {
    const line = { traceId: TRACE, spanId: "a".repeat(16), method: "GET", path: "/api/v1/me", status: 401, ms: 3, subject: null, code: "UNAUTHENTICATED" } as const;
    expect(httpSpanOf(line, 1_000)).toMatchObject({ parentId: null, spanId: "a".repeat(16), attributes: { "hb.code": "UNAUTHENTICATED", "url.path": "/api/v1/me" } });
    expect(httpSpanOf(line, 1_000)).not.toHaveProperty("error");
    expect(httpSpanOf({ ...line, parentId: "b".repeat(16), status: 500, code: undefined }, 1_000)).toMatchObject({ parentId: "b".repeat(16), error: "INTERNAL" });
  });

  it("names a research step by its stage, carries the run, the outcome and the counts, and marks a failure alone as an error (44 § 4)", () => {
    const run = { traceId: TRACE, runId: "33333333-3333-4333-8333-333333333333" };
    const ended = researchSpanOf(researchLineOf("run", run, "DONE", 90_000, { searches: 4, pageReads: 2, findings: 2, proposed: 1, refuted: 1 }), 1_000);
    expect(ended).toEqual({
      name: "research.run",
      traceId: TRACE,
      endedAt: 1_000,
      ms: 90_000,
      attributes: { "hb.research.run_id": run.runId, "hb.outcome": "DONE", "hb.code": null, "hb.research.searches": 4, "hb.research.page_reads": 2, "hb.research.findings": 2, "hb.research.proposed": 1, "hb.research.refuted": 1 },
    });
    expect(researchSpanOf(researchLineOf("plan", run, "nothing", 800), 1_000)).toMatchObject({ name: "research.plan", attributes: { "hb.outcome": "nothing", "hb.research.searches": null } });
    expect(researchSpanOf(researchLineOf("read", run, "budget", 30), 1_000)).not.toHaveProperty("error");
    /* a turn the hand-over skipped before its row: no run, the skip as the code, no error */
    expect(researchSpanOf(researchLineOf("run", { traceId: TRACE, runId: null }, "SKIPPED", 4, { code: "UNAVAILABLE" }), 1_000)).toMatchObject({ attributes: { "hb.research.run_id": null, "hb.code": "UNAVAILABLE" } });
    expect(researchSpanOf(researchLineOf("run", run, "SKIPPED", 4, { code: "DEDUPED" }), 1_000)).not.toHaveProperty("error");
    expect(researchSpanOf(researchLineOf("read", run, "failed", 30, { code: "READER_FAILED" }), 1_000).error).toBe("READER_FAILED");
    expect(researchSpanOf(researchLineOf("run", run, "FAILED", 30, { code: "PLANNER_FAILED" }), 1_000).error).toBe("PLANNER_FAILED");
    /* a person's run's writer (48 § 5.8): the paragraphs kept and dropped, on its line alone */
    expect(researchSpanOf(researchLineOf("write", run, "report", 4_000, { findings: 1, paragraphs: 3, dropped: 1 }), 1_000)).toMatchObject({ name: "research.write", attributes: { "hb.outcome": "report", "hb.research.findings": 1, "hb.research.paragraphs": 3, "hb.research.dropped": 1 } });
    expect(researchSpanOf(researchLineOf("write", run, "failed", 30, { code: "WRITER_FAILED" }), 1_000).error).toBe("WRITER_FAILED");
    expect(researchSpanOf(researchLineOf("read", run, "found", 30), 1_000).attributes).not.toHaveProperty("hb.research.paragraphs");
  });

  it("marks an aid run that exited non-zero, and gives a job no parent", () => {
    expect(aidRunSpanOf({ traceId: TRACE, aidId: "21.8-task-survival", runner: "python", exitCode: 1, timedOut: false, ms: 80 }, 1_000).error).toBe("AID_RUN_FAILED");
    expect(aidRunSpanOf({ traceId: TRACE, aidId: "21.8-task-survival", runner: "python", exitCode: 0, timedOut: false, ms: 80 }, 1_000)).not.toHaveProperty("error");
    expect(jobSpanOf({ traceId: TRACE, job: "auth:sweep", counts: { keys: 9 }, ms: 4 }, 1_000)).toMatchObject({ name: "job", parentId: null, attributes: { "hb.job": "auth:sweep", "hb.count.keys": 9 } });
  });
});
