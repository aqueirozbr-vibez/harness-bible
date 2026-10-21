import type { JobLine, SpanLine } from "@/lib/api/log";
import type { GatewaySpan } from "@/lib/gateway/span";
import type { AnswerResult } from "@/lib/schemas/assistant";
import type { Purpose } from "@/lib/schemas/gateway";
import { editionMismatch } from "@/lib/sensors/edition";
import { printLine } from "@/lib/telemetry/print";
import { recordSpan, type SpanRecord } from "@/lib/telemetry/spans";

/*
 * The product's lines as spans (feature-specs/21 § 5.1's table; architecture § 7). Each function here is pure: a
 * line in, the span it describes out, named and attributed as the table says. The three lines this unit adds —
 * retrieval, the aid's run, the answer — are printed and recorded here; the request's, the model call's and the
 * job's are printed where they always were (`lib/api/log.ts`, `lib/gateway/span.ts`) and recorded through these.
 *
 * What a span may hold: ids, counts, codes, hashes, timings. A line never held a prompt, an answer, a question, an
 * e-mail or a key, and a span holds only what its line does (§ 5.1; the tests assert it over every attribute).
 */

export function httpSpanOf(line: SpanLine, endedAt: number): SpanRecord {
  return {
    name: "http.request",
    traceId: line.traceId,
    spanId: line.spanId,
    /* A request's parent is whoever called it, named in its `traceparent`; never the code it happens to run in. */
    parentId: line.parentId ?? null,
    endedAt,
    ms: line.ms,
    attributes: {
      "http.request.method": line.method,
      "url.path": line.path,
      "http.response.status_code": line.status,
      "hb.subject": line.subject,
      "hb.policy": line.policy,
      "hb.code": line.code,
    },
    ...(line.status >= 500 ? { error: line.code ?? "INTERNAL" } : {}),
  };
}

const OPERATION: Readonly<Record<Purpose, "chat" | "embeddings" | "rerank">> = { assistant: "chat", grading: "chat", adjudication: "chat", lab: "chat", embed: "embeddings", rerank: "rerank", research: "chat" };

/** A model call, under the GenAI conventions' names (architecture § 7): `gen_ai.chat`, or the embedder's and the re-ranker's own. */
export function genAiSpanOf(span: GatewaySpan, endedAt: number): SpanRecord {
  const operation = OPERATION[span["hb.purpose"]];
  const failed = span["hb.outcome"] !== "ok" && span["hb.outcome"] !== "provider_refusal";
  return {
    name: `gen_ai.${operation}`,
    traceId: span.trace_id,
    /* the id the call's `traceparent` sent, so the gateway's generation hangs from this span (49 § 5.3) */
    spanId: span.span_id,
    endedAt,
    ms: span.latency_ms,
    attributes: {
      "gen_ai.system": span["gen_ai.system"],
      "gen_ai.operation.name": operation,
      "gen_ai.request.model": span["gen_ai.request.model"],
      "gen_ai.usage.input_tokens": span["gen_ai.usage.input_tokens"],
      "gen_ai.usage.output_tokens": span["gen_ai.usage.output_tokens"],
      "gen_ai.usage.cache_read_input_tokens": span["gen_ai.usage.cache_read_input_tokens"],
      "gen_ai.usage.cache_creation_input_tokens": span["gen_ai.usage.cache_creation_input_tokens"],
      "hb.alias": span["hb.alias"],
      "hb.agent": span["hb.agent"],
      "hb.guide.version": span["hb.guide.version"],
      "hb.guide.sha256": span["hb.guide.sha256"],
      "hb.prompt.sha256": span["hb.prompt.sha256"],
      "hb.cost_usd": span["hb.cost_usd"],
      "hb.price_unknown": span["hb.price_unknown"],
      "hb.purpose": span["hb.purpose"],
      "hb.principal": span["hb.principal"],
      "hb.outcome": span["hb.outcome"],
      "hb.gateway.call_id": span["x-litellm-call-id"],
      "hb.first_token_ms": span.first_token_ms,
    },
    ...(failed ? { error: span["hb.outcome"] } : {}),
  };
}

export function jobSpanOf(line: JobLine, endedAt: number): SpanRecord {
  return {
    name: "job",
    traceId: line.traceId,
    parentId: null,
    endedAt,
    ms: line.ms,
    attributes: { "hb.job": line.job, ...Object.fromEntries(Object.entries(line.counts).map(([name, count]) => [`hb.count.${name}`, count])) },
    /* The line keeps the error's message for the operator; the span keeps its name, which cannot quote a row. */
    ...(line.error === undefined ? {} : { error: line.error.split(":")[0] ?? "Error" }),
  };
}

/** Retrieval for one question (feature-specs/12 § 7.2): how many candidates, where the time went, and whether the vector half ran. */
export interface RetrieveLine {
  readonly traceId: string;
  readonly mode: string;
  readonly candidates: number;
  readonly embedMs: number;
  readonly sqlMs: number;
  readonly rerankMs: number;
  readonly ms: number;
  readonly overBudget: boolean;
  readonly vectorReady: boolean;
}

export function retrieveSpanOf(line: RetrieveLine, endedAt: number): SpanRecord {
  return {
    name: "assistant.retrieve",
    traceId: line.traceId,
    endedAt,
    ms: line.ms,
    attributes: {
      "hb.mode": line.mode,
      "hb.candidates": line.candidates,
      "hb.embed_ms": line.embedMs,
      "hb.sql_ms": line.sqlMs,
      "hb.rerank_ms": line.rerankMs,
      "hb.over_budget": line.overBudget,
      "hb.vector_ready": line.vectorReady,
    },
  };
}

export function logRetrieve(line: RetrieveLine): void {
  printLine("retrieve", line);
  recordSpan(retrieveSpanOf(line, Date.now()));
}

/** A decision aid's script, run for a walk (feature-specs/18 § 4): which aid, how it ended, how long it took. */
export interface AidRunLine {
  readonly traceId: string;
  readonly aidId: string;
  readonly runner: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly ms: number;
}

export function aidRunSpanOf(line: AidRunLine, endedAt: number): SpanRecord {
  return {
    name: "aid.run",
    traceId: line.traceId,
    endedAt,
    ms: line.ms,
    attributes: { "hb.aid.id": line.aidId, "hb.aid.runner": line.runner, "hb.aid.exit_code": line.exitCode, "hb.aid.timed_out": line.timedOut },
    ...(line.timedOut ? { error: "AID_TIMED_OUT" } : line.exitCode !== 0 ? { error: "AID_RUN_FAILED" } : {}),
  };
}

export function logAidRun(line: AidRunLine): void {
  printLine("aid_run", line);
  recordSpan(aidRunSpanOf(line, Date.now()));
}

/** One turn as it ended (architecture § 7's Assistant answer row): answered, refused, or failed, with what was measured. */
export interface AnswerLine {
  readonly traceId: string;
  /** The assistant row the turn wrote; a failed turn's row too. */
  readonly messageId: string;
  readonly mode: string;
  readonly outcome: "answer" | "refusal" | "failed";
  readonly refusalCause: string | null;
  /** A failed turn's code: `ASSISTANT_UNAVAILABLE`, `BUDGET_EXCEEDED`, `AID_RUN_FAILED`, `INTERNAL`. */
  readonly code: string | null;
  readonly citationsTotal: number;
  readonly citationsResolved: number;
  readonly substituted: number;
  readonly repaired: boolean;
  readonly grounded: number | null;
  readonly firstTokenMs: number | null;
  /** The flow's own total, as the row keeps it; null when the turn failed before the flow finished. */
  readonly totalMs: number | null;
  readonly locale: string;
  readonly citesEdition: string | null;
  readonly editionMismatch: boolean;
  /** How many secrets were removed from the reader's question before it was stored or shown to a model (§ 6.2): a count, never a value. */
  readonly secretsRedacted: number;
  /** The whole turn, the aid's run and the writes included. */
  readonly ms: number;
}

interface TurnFacts {
  readonly traceId: string;
  readonly messageId: string;
  readonly mode: string;
  readonly locale: "en" | "pt";
  readonly secretsRedacted: number;
  readonly ms: number;
}

/** The line of a turn that produced a result. Citations resolve when they are at the release's version (13 § 7.2). */
export function answerLineOf(turn: TurnFacts, result: AnswerResult): AnswerLine {
  const edition = result.verdicts.find((verdict) => verdict.sensor === "edition");
  const wrongVersion = typeof edition?.data.wrongVersion === "number" ? edition.data.wrongVersion : 0;
  const cited = result.citations[0]?.editionLang ?? null;
  return {
    ...turn,
    outcome: result.kind,
    refusalCause: result.refusal?.cause ?? null,
    code: null,
    citationsTotal: result.citations.length,
    citationsResolved: Math.max(0, result.citations.length - wrongVersion),
    substituted: result.claims.filter((claim) => claim.substituted).length,
    repaired: result.repaired,
    grounded: result.grounded,
    firstTokenMs: result.timings.firstTokenMs,
    totalMs: result.timings.totalMs,
    citesEdition: cited,
    editionMismatch: cited !== null && editionMismatch(turn.locale, cited),
  };
}

/** The line of a turn that failed after the question was recorded: nothing was answered, so nothing was measured. */
export function failedAnswerLine(turn: TurnFacts, code: string): AnswerLine {
  return {
    ...turn,
    outcome: "failed",
    refusalCause: null,
    code,
    citationsTotal: 0,
    citationsResolved: 0,
    substituted: 0,
    repaired: false,
    grounded: null,
    firstTokenMs: null,
    totalMs: null,
    citesEdition: null,
    editionMismatch: false,
  };
}

export function answerSpanOf(line: AnswerLine, endedAt: number): SpanRecord {
  return {
    name: "assistant.answer",
    traceId: line.traceId,
    endedAt,
    ms: line.ms,
    attributes: {
      "hb.message_id": line.messageId,
      "hb.mode": line.mode,
      "hb.outcome": line.outcome,
      "hb.refusal.cause": line.refusalCause,
      "hb.code": line.code,
      "hb.citations.total": line.citationsTotal,
      "hb.citations.resolved": line.citationsResolved,
      "hb.substituted": line.substituted,
      "hb.repaired": line.repaired,
      "hb.grounded": line.grounded,
      "hb.first_token_ms": line.firstTokenMs,
      "hb.total_ms": line.totalMs,
      "hb.edition.locale": line.locale,
      "hb.edition.cited": line.citesEdition,
      "hb.edition.mismatch": line.editionMismatch,
      "hb.secret.redacted": line.secretsRedacted,
    },
    ...(line.outcome === "failed" ? { error: line.code ?? "INTERNAL" } : {}),
  };
}

export function logAnswer(line: AnswerLine): void {
  printLine("answer", line);
  recordSpan(answerSpanOf(line, Date.now()));
}

/**
 * A research run's step, or its end (feature-specs/44 § 4; unit 61a): `research.plan` and `research.read` as each agent's
 * step ends, `research.run` as the run ends — in the workflow, or at the hand-over for a turn it skipped. The run's id,
 * how it went, its counts and its time; never a word of a question, a brief or a page, and the trace is the turn's.
 * Since unit 70 (feature-specs/48 § 5.8) a person's run also prints `research.write` as its writer's step ends, with
 * the paragraphs the report sensor kept and how many it dropped, and the trace is the run's own.
 */
export interface ResearchLine {
  readonly traceId: string;
  readonly stage: "run" | "plan" | "read" | "write";
  /** Null for a turn the legacy hand-over skipped before its row was written (until unit 75; feature-specs/48 § 9.2). */
  readonly runId: string | null;
  /** run: `DONE`, `SKIPPED`, `FAILED`, `REFUSED`; plan: `brief`, `nothing`, `refused`, `budget`, `unavailable`, `purged`, `failed`; read: `found`, `budget`, `purged`, `failed`; write: `report`, `budget`, `rate_limit`, `purged`, `failed`. */
  readonly outcome: string;
  /** The skip's or the failure's code; null where there is none. */
  readonly code: string | null;
  readonly searches: number | null;
  readonly pageReads: number | null;
  /** read: what the reader returned; run: what the run's findings came to, with how many were proposed and refuted. */
  readonly findings: number | null;
  readonly proposed: number | null;
  readonly refuted: number | null;
  /** write only: the report's paragraphs the sensor kept, and the ones it dropped (48 § 5.7); absent from the other stages' lines. */
  readonly paragraphs?: number | null;
  readonly dropped?: number | null;
  readonly ms: number;
}

/** A line with the counts it has, the others null. */
export function researchLineOf(stage: ResearchLine["stage"], run: { readonly traceId: string; readonly runId: string | null }, outcome: string, ms: number, counts: Partial<Pick<ResearchLine, "code" | "searches" | "pageReads" | "findings" | "proposed" | "refuted" | "paragraphs" | "dropped">> = {}): ResearchLine {
  return { traceId: run.traceId, stage, runId: run.runId, outcome, code: null, searches: null, pageReads: null, findings: null, proposed: null, refuted: null, ms, ...counts };
}

export function researchSpanOf(line: ResearchLine, endedAt: number): SpanRecord {
  return {
    name: `research.${line.stage}`,
    traceId: line.traceId,
    endedAt,
    ms: line.ms,
    attributes: {
      "hb.research.run_id": line.runId,
      "hb.outcome": line.outcome,
      "hb.code": line.code,
      "hb.research.searches": line.searches,
      "hb.research.page_reads": line.pageReads,
      "hb.research.findings": line.findings,
      "hb.research.proposed": line.proposed,
      "hb.research.refuted": line.refuted,
      ...(line.paragraphs === undefined ? {} : { "hb.research.paragraphs": line.paragraphs }),
      ...(line.dropped === undefined ? {} : { "hb.research.dropped": line.dropped }),
    },
    /* a skip, a plan of nothing and a wait at the cap are outcomes; a failure is the one error */
    ...(line.outcome === "failed" || line.outcome === "FAILED" ? { error: line.code ?? "INTERNAL" } : {}),
  };
}

export function logResearch(line: ResearchLine): void {
  printLine("research", line);
  recordSpan(researchSpanOf(line, Date.now()));
}


/**
 * A sensor's run (feature-specs/49 § 8): which sensor, how it came out, the rule or the code that decided it where it
 * has one, the counts it already reports, and the time of the pure call; never its detail, which can quote what it
 * read. Langfuse shows the span as a guardrail, at level WARNING where it did not pass: a sensor that did not pass is
 * the product working, so its span never has an error status.
 */
export interface SensorLine {
  readonly traceId: string;
  readonly sensor: string;
  readonly result: "PASS" | "FAIL" | "WARN" | "NA";
  /** The named rule that decided it, an enumeration (the scope rules' `rule`); null for a sensor without one. */
  readonly rule: string | null;
  /** The refusal cause or code it gave, an enumeration; null where there is none. */
  readonly code: string | null;
  /** The claims it read, and how many it substituted; null for a sensor that does not count claims. */
  readonly claims: number | null;
  readonly substituted: number | null;
  readonly ms: number;
}

export function sensorSpanOf(line: SensorLine, endedAt: number): SpanRecord {
  return {
    name: `sensor.${line.sensor}`,
    traceId: line.traceId,
    endedAt,
    ms: line.ms,
    attributes: {
      "hb.sensor.result": line.result,
      "hb.sensor.rule": line.rule,
      "hb.code": line.code,
      "hb.sensor.claims": line.claims,
      "hb.sensor.substituted": line.substituted,
    },
  };
}

export function logSensor(line: SensorLine): void {
  printLine("sensor", line);
  recordSpan(sensorSpanOf(line, Date.now()));
}

/**
 * The search page's query, embedded by the workers' `/embed/query` route (feature-specs/49 § 6.3): how it went and how
 * long it took; never the query. Its span is the scope the query's embedding nests under, the root of a `search.query`
 * trace on the Langfuse road.
 */
export interface SearchLine {
  readonly traceId: string;
  readonly outcome: "ok" | "failed";
  /** The failure's code; null where it went. */
  readonly code: string | null;
  readonly ms: number;
}

export function searchSpanOf(line: SearchLine, endedAt: number): SpanRecord {
  return {
    name: "search.query",
    traceId: line.traceId,
    endedAt,
    ms: line.ms,
    attributes: { "hb.outcome": line.outcome, "hb.code": line.code },
    ...(line.outcome === "failed" ? { error: line.code ?? "INTERNAL" } : {}),
  };
}

export function logSearch(line: SearchLine): void {
  printLine("search", line);
  recordSpan(searchSpanOf(line, Date.now()));
}

/**
 * A workflow's activity, one execution (feature-specs/49 § 7.1): which activity of which workflow, its attempt, how it
 * ended and the code it failed with; never the error's message. Its span is the scope the activity's work nests under,
 * a root of its subject's trace. A legacy research run's carries its run's id and the mark `hb.legacy` in place of the
 * trace attributes it leaves to its turn (§ 6.4).
 */
export interface ActivityLine {
  readonly traceId: string;
  /** The activity's type, the function's name the workflow calls it by. */
  readonly activity: string;
  readonly workflowType: string;
  readonly workflowId: string;
  readonly attempt: number;
  readonly outcome: "ok" | "failed" | "cancelled";
  /** failed: the `ApplicationFailure`'s type, `TIMEOUT`, or the error's name; cancelled: `CANCELLED`; ok: null. */
  readonly code: string | null;
  /** The legacy research workflow's runs alone: the mark, and the run's id where the read found it. */
  readonly legacy?: true;
  readonly runId?: string | null;
  readonly ms: number;
}

export function activitySpanOf(line: ActivityLine, endedAt: number): SpanRecord {
  return {
    name: `activity.${line.activity}`,
    traceId: line.traceId,
    endedAt,
    ms: line.ms,
    attributes: {
      "hb.workflow.type": line.workflowType,
      "hb.workflow.id": line.workflowId,
      "hb.activity.attempt": line.attempt,
      "hb.outcome": line.outcome,
      "hb.code": line.code,
      ...(line.legacy === true ? { "hb.legacy": true, "hb.research.run_id": line.runId ?? null } : {}),
    },
    /* a failure, a time-out among them, is the one error; a cancellation is the workflow's own decision */
    ...(line.outcome === "failed" ? { error: line.code ?? "INTERNAL" } : {}),
  };
}

export function logActivity(line: ActivityLine): void {
  printLine("activity", line);
  recordSpan(activitySpanOf(line, Date.now()));
}
