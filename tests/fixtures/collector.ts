import type { GatewaySpan } from "@/lib/gateway/span";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";
import { answerLineOf, answerSpanOf, genAiSpanOf, httpSpanOf, jobSpanOf, retrieveSpanOf } from "@/lib/telemetry/lines";
import { recordSpan, setSpanSink, withSpanScope, type SpanName, type SpanRecord } from "@/lib/telemetry/spans";

/*
 * Recorded spans for tests/observability-collector.test.ts (feature-specs/49 § 9.5; unit 79): one turn's worth of the
 * product's spans and the gateway's, as OTLP/JSON, the form the collector's `otlp_json_file` receiver reads.
 *
 * The product's spans are the product's own: its span builders, recorded through `recordSpan` inside a request's scope
 * as the workers record them, so the `hb.parent: request` mark is the real one. Beside them, one span carries keys no
 * builder emits today (a principal, a subject, a path, a question), as a later builder might.
 *
 * The gateway's spans are written from the attribute names of the pinned image (LiteLLM 1.102.1,
 * ghcr.io/berriai/litellm:main-stable@sha256:87f34979…; read in the image, `litellm/` below), with file and line beside
 * each. They are not recorded from a live gateway: unit 80 is the first to see one (49 § 18).
 */

export const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
/** The web tier's request, the workers' request under it, and the product's spans under that. */
export const WEB_REQUEST = "00f067aa0ba902b7";
export const WORKERS_REQUEST = "b7ad6b7169203331";
export const CLASSIFY_SPAN = "1a1a1a1a1a1a1a1a";
export const DRAFT_SPAN = "2b2b2b2b2b2b2b2b";
export const RETRIEVE_SPAN = "3c3c3c3c3c3c3c3c";
export const ANSWER_SPAN = "4d4d4d4d4d4d4d4d";
export const EMBED_SPAN = "5e5e5e5e5e5e5e5e";
export const RELEASE_EMBED_SPAN = "6f6f6f6f6f6f6f6f";
export const JOB_SPAN = "7e7e7e7e7e7e7e7e";

export const QUESTION = "Why does a retried write without an idempotency key become a second write?";
export const ANSWER = "Because the server cannot tell the retry from a new request, it performs the write twice.";
export const PRINCIPAL = "org:00000000-0000-4000-8000-00000000de01";
export const USER = "00000000-0000-4000-8000-0000000000a1";
export const EMAIL = "reader@example.test";
/** Base64 of a PDF's first bytes, as the evidence grader's bytes row carries a document (49 § 9.3). */
export const DOCUMENT = "JVBERi0xLjcKJcfsj6IKNSAwIG9iago8PC9MZW5ndGggNiAwIFIvRmlsdGVyIC9GbGF0ZURlY29kZT4+";

const ENDED = Date.UTC(2026, 9, 14, 12, 0, 0);

type Value = string | number | boolean;

interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string } | { readonly intValue: string } | { readonly doubleValue: number } | { readonly boolValue: boolean };
}

/** A null is an absent attribute, as the product's tracer makes it. */
function attributes(input: Readonly<Record<string, Value | null | undefined>>): ReadonlyArray<OtlpAttribute> {
  const out: OtlpAttribute[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") out.push({ key, value: { stringValue: value } });
    else if (typeof value === "boolean") out.push({ key, value: { boolValue: value } });
    else out.push({ key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } });
  }
  return out;
}

function nanos(ms: number): string {
  return `${String(ms)}000000`;
}

const SERVER: ReadonlySet<SpanName> = new Set<SpanName>(["http.request"]);
const CLIENT: ReadonlySet<SpanName> = new Set<SpanName>(["gen_ai.chat", "gen_ai.embeddings", "gen_ai.rerank"]);

/** A recorded span as the product's exporter sends it: lib/telemetry/tracer.ts's kinds, times and status. */
function productSpan(record: SpanRecord & { readonly parentId: string | null }): object {
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    ...(record.parentId === null ? {} : { parentSpanId: record.parentId }),
    name: record.name,
    kind: SERVER.has(record.name) ? 2 : CLIENT.has(record.name) ? 3 : 1,
    startTimeUnixNano: nanos(record.endedAt - record.ms),
    endTimeUnixNano: nanos(record.endedAt),
    attributes: attributes(record.attributes),
    status: record.error === undefined ? {} : { code: 2, message: record.error },
  };
}

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
  "hb.principal": PRINCIPAL,
  "hb.outcome": "ok",
  trace_id: TRACE,
  "x-litellm-call-id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  latency_ms: 3100,
  first_token_ms: 900,
};

const RESULT: AnswerResult = {
  kind: "answer",
  refusal: null,
  claims: [{ text: ANSWER, sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false }],
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

/** The product's spans of one turn, recorded as the web tier and the workers record them. */
function productSpans(): ReadonlyArray<object> {
  const recorded: Array<SpanRecord & { readonly parentId: string | null }> = [];
  setSpanSink((record) => recorded.push(record));
  try {
    recordSpan(httpSpanOf({ traceId: TRACE, spanId: WEB_REQUEST, method: "POST", path: "/api/v1/assistant/conversations/c-1/messages", status: 200, ms: 4300, subject: `user:${USER}`, policy: "allow" }, ENDED));
    withSpanScope({ traceId: TRACE, spanId: WORKERS_REQUEST, request: true }, () => {
      recordSpan({ ...retrieveSpanOf({ traceId: TRACE, mode: "explain", candidates: 22, embedMs: 40, sqlMs: 35, rerankMs: 120, ms: 200, overBudget: false, vectorReady: true }, ENDED - 3900), spanId: RETRIEVE_SPAN });
      /* the embedder's call for the question (`embed.query` from unit 81) */
      recordSpan({ ...genAiSpanOf({ ...MODEL_CALL, "hb.purpose": "embed", "hb.alias": "hb-embed", "gen_ai.request.model": "hb-embed", "hb.guide.version": null, "hb.guide.sha256": null, latency_ms: 40, first_token_ms: null }, ENDED - 4000), spanId: EMBED_SPAN });
      /* the classifier's call, named for its agent as unit 81 names it */
      const classify = genAiSpanOf({ ...MODEL_CALL, "hb.alias": "hb-small", "gen_ai.request.model": "claude-haiku-4-5", latency_ms: 400, first_token_ms: null }, ENDED - 3500);
      recordSpan({ ...classify, spanId: CLASSIFY_SPAN, attributes: { ...classify.attributes, "hb.agent": "assistant.classify" } });
      recordSpan({ ...genAiSpanOf(MODEL_CALL, ENDED - 300), spanId: DRAFT_SPAN });
      /* the turn's span, carrying keys no builder emits today: what a later builder adds stays on the machine */
      const answer = answerSpanOf(answerLineOf({ traceId: TRACE, messageId: "m-1", mode: "explain", locale: "en", secretsRedacted: 0, ms: 4200 }, RESULT), ENDED);
      recordSpan({
        ...answer,
        spanId: ANSWER_SPAN,
        attributes: { ...answer.attributes, "hb.principal": PRINCIPAL, "hb.subject": `user:${USER}`, "url.path": "/api/v1/assistant/conversations/c-1/messages", "http.route": "/api/v1/assistant", "hb.question": QUESTION, "session.id": "c-1", "user.id": USER, "hb.email": EMAIL },
      });
    });
    recordSpan(httpSpanOf({ traceId: TRACE, spanId: WORKERS_REQUEST, parentId: WEB_REQUEST, method: "POST", path: "/answer", status: 200, ms: 4250, subject: null }, ENDED));
    /* a scheduled job, and the release's embedding job's call (`embed.release`, D3), each a trace of its own */
    recordSpan({ ...jobSpanOf({ traceId: "c".repeat(32), job: "assistant:purge", counts: { messages: 12 }, ms: 180 }, ENDED), spanId: JOB_SPAN });
    const release = genAiSpanOf({ ...MODEL_CALL, trace_id: "d".repeat(32), "hb.purpose": "embed", "hb.alias": "hb-embed", "gen_ai.request.model": "hb-embed", "hb.guide.version": null, "hb.guide.sha256": null, latency_ms: 5200, first_token_ms: null }, ENDED);
    recordSpan({ ...release, spanId: RELEASE_EMBED_SPAN, attributes: { ...release.attributes, "hb.agent": "embed.release" } });
  } finally {
    setSpanSink(null);
  }
  return recorded.map(productSpan);
}

/*
 * What every `langfuse_otel` span of the pinned image carries besides its generation (49 § 5.2), and what the
 * collector's keep-list must hold back:
 *   metadata                       litellm/integrations/arize/_utils.py:495-497 (StandardLoggingMetadata, as JSON)
 *   llm.request.type, llm.provider, llm.is_streaming, llm.response.id, llm.response.model
 *                                  litellm/integrations/arize/_utils.py:525-550
 *   llm.invocation_parameters      litellm/integrations/arize/_utils.py:557 (with `system` and `metadata.user_id`)
 *   user.id                        litellm/integrations/arize/_utils.py:561, :873
 *   session.id, litellm.trace_id   litellm/integrations/arize/_utils.py:858, :862
 *   litellm.team_id, litellm.team_alias, litellm.key_alias
 *                                  litellm/integrations/arize/_utils.py:877, :880, :883
 *   llm.response.cost              litellm/integrations/arize/_utils.py:905
 *   openinference.span.kind        litellm/integrations/arize/_utils.py:580-587
 *   input.value, llm.input_messages.*, output.value, llm.output_messages.*
 *                                  litellm/integrations/arize/_utils.py:95-131, :969-1048 (the duplicates of the text)
 */
function carried(text: { readonly input: string; readonly output: string }): Readonly<Record<string, Value>> {
  return {
    metadata: JSON.stringify({
      user_api_key_hash: "88dc28d0f030c55ed4ab77ed8faf098196cb1c05df778539800c9f1243fe6b4b",
      user_api_key_alias: PRINCIPAL,
      user_api_key_user_id: USER,
      user_api_key_org_id: "00000000-0000-4000-8000-00000000de01",
      user_api_key_metadata: { organisationId: "00000000-0000-4000-8000-00000000de01" },
      requester_ip_address: "172.18.0.5",
      requester_metadata: { user_id: PRINCIPAL },
    }),
    "llm.request.type": "anthropic_messages",
    "llm.provider": "anthropic",
    "llm.is_streaming": "False",
    "llm.response.id": "msg_01XFDUDYJgAACzvnptvVoYEL",
    "llm.response.model": "claude-opus-5",
    "llm.invocation_parameters": JSON.stringify({ system: "You answer from the book only.", max_tokens: 1024, metadata: { user_id: PRINCIPAL } }),
    "user.id": USER,
    "session.id": "c-1",
    "litellm.trace_id": TRACE,
    "litellm.team_id": "team-1",
    "litellm.team_alias": "org",
    "litellm.key_alias": PRINCIPAL,
    "llm.response.cost": 0.014,
    "openinference.span.kind": "LLM",
    "input.value": text.input,
    "llm.input_messages.0.message.role": "user",
    "llm.input_messages.0.message.content": text.input,
    "output.value": text.output,
    "llm.output_messages.0.message.role": "assistant",
    "llm.output_messages.0.message.content": text.output,
  };
}

/** LiteLLM's placeholder for a redacted message (`turn_off_message_logging`, litellm/litellm_core_utils/redact_messages.py). */
const REDACTED = "redacted-by-litellm";

interface Generation {
  readonly spanId: string;
  readonly parentId: string;
  /** The `langfuse_generation_name` header's value (49 § 6.2), absent where the call names none. */
  readonly agent?: string;
  readonly input: string;
  readonly output: string;
  readonly failed?: boolean;
  /** Not a generation: a span the proxy writes of its own, which never leaves. */
  readonly type?: "generation" | null;
  readonly traceId?: string;
}

/*
 * The generation itself:
 *   langfuse.observation.type      litellm/integrations/langfuse/langfuse_otel.py:49 ("generation")
 *   langfuse.generation.name       litellm/integrations/langfuse/langfuse_otel.py:86-126 (the header, through
 *                                  langfuse.py's add_metadata_from_header, :57-83)
 *   langfuse.version               litellm/integrations/langfuse/langfuse_otel.py:108-112
 *   langfuse.observation.input     litellm/integrations/langfuse/langfuse_otel.py:248-254 (the raw `messages`), and
 *                                  litellm/integrations/langfuse/langfuse_otel_attributes.py:85-95
 *   langfuse.observation.output    litellm/integrations/langfuse/langfuse_otel.py:129-175
 *   llm.model_name                 litellm/integrations/arize/_utils.py:523
 *   llm.token_count.*              litellm/integrations/arize/_utils.py:247-312
 *   llm.cost.total                 litellm/integrations/arize/_utils.py:904
 *   on a failure: the `exception` event (litellm/integrations/opentelemetry.py:2181-2199, `span.record_exception`),
 *   error.message, error.type, error.code (:2205-2245), and the status ERROR with no message (:2102-2165)
 */
function gatewaySpan(generation: Generation): object {
  return {
    traceId: generation.traceId ?? TRACE,
    spanId: generation.spanId,
    parentSpanId: generation.parentId,
    name: "litellm_request",
    kind: 1,
    startTimeUnixNano: nanos(ENDED - 3000),
    endTimeUnixNano: nanos(ENDED - 200),
    attributes: attributes({
      ...(generation.type === null ? {} : { "langfuse.observation.type": "generation" }),
      ...(generation.agent === undefined ? {} : { "langfuse.generation.name": generation.agent, "langfuse.version": "v1.13" }),
      "langfuse.observation.input": generation.input,
      "langfuse.observation.output": generation.output,
      "llm.model_name": "claude-opus-5",
      "llm.token_count.prompt": 1200,
      "llm.token_count.completion": 300,
      "llm.token_count.total": 1500,
      "llm.token_count.prompt_details.cache_read": 1000,
      "llm.cost.total": 0.014,
      ...carried(generation),
      ...(generation.failed === true
        ? { "error.message": `litellm.APIConnectionError: the stream ended while answering "${QUESTION}"`, "error.type": "APIConnectionError", "error.code": "500", "error.stack_trace": "Traceback (most recent call last): ..." }
        : {}),
    }),
    ...(generation.failed === true
      ? {
          events: [
            {
              timeUnixNano: nanos(ENDED - 250),
              name: "exception",
              attributes: attributes({ "exception.type": "litellm.exceptions.APIConnectionError", "exception.message": `the stream ended while answering "${QUESTION}"`, "exception.stacktrace": "Traceback (most recent call last): ..." }),
            },
          ],
          status: { code: 2 },
        }
      : { status: { code: 1 } }),
  };
}

const MESSAGES = JSON.stringify([{ role: "user", content: QUESTION }]);
const OUTPUT = JSON.stringify({ role: "assistant", content: ANSWER });

function gatewaySpans(): ReadonlyArray<object> {
  return [
    /* a success LiteLLM redacted (the switch off, or a key without the flag; 49 § 9.2) */
    gatewaySpan({ spanId: "a1a1a1a1a1a1a1a1", parentId: CLASSIFY_SPAN, agent: "assistant.classify", input: REDACTED, output: REDACTED }),
    /* a success with its text: the request's opt-out, honoured for a flagged key (49 § 9.2, lock 2) */
    gatewaySpan({ spanId: "b2b2b2b2b2b2b2b2", parentId: DRAFT_SPAN, agent: "assistant.draft", input: MESSAGES, output: OUTPUT }),
    /* a streamed call that failed after it started: logged unredacted whatever the switch says (49 § 9.2) */
    gatewaySpan({ spanId: "c3c3c3c3c3c3c3c3", parentId: "7a7a7a7a7a7a7a7a", agent: "researcher.read", input: MESSAGES, output: "", failed: true }),
    /* the evidence grader's PDF or image row, with its text (49 § 9.3) */
    gatewaySpan({ spanId: "d4d4d4d4d4d4d4d4", parentId: "8b8b8b8b8b8b8b8b", agent: "evidence.grade.bytes", input: JSON.stringify([{ role: "user", content: [{ type: "document", source: { type: "base64", data: DOCUMENT } }] }]), output: OUTPUT }),
    /* the grader's call, whose metadata names the key's alias, the requester and the principal (49 § 5.2) */
    gatewaySpan({ spanId: "e5e5e5e5e5e5e5e5", parentId: ANSWER_SPAN, agent: "assistant.grade", input: REDACTED, output: REDACTED }),
    /* the question's embedding, typed `embedding` on the road */
    gatewaySpan({ spanId: "f6f6f6f6f6f6f6f6", parentId: EMBED_SPAN, agent: "embed.query", input: REDACTED, output: "embedding-output" }),
    /* the release's embedding job's call, which stays in Tempo's world (D3) */
    gatewaySpan({ spanId: "0707070707070707", parentId: RELEASE_EMBED_SPAN, agent: "embed.release", input: REDACTED, output: "embedding-output", traceId: "d".repeat(32) }),
    /* a span of the proxy's own, not a generation */
    gatewaySpan({ spanId: "1818181818181818", parentId: DRAFT_SPAN, input: MESSAGES, output: OUTPUT, type: null }),
  ];
}

/*
 * The gateway's resource: litellm/integrations/opentelemetry.py:425-437 (`service.name`, `deployment.environment`,
 * `production` by default at :309-310, `model_id`), with the SDK's own `telemetry.sdk.*` that `Resource.create` adds.
 */
const GATEWAY_RESOURCE = attributes({
  "service.name": "hb-gateway",
  "deployment.environment": "production",
  model_id: "hb-gateway",
  "telemetry.sdk.language": "python",
  "telemetry.sdk.name": "opentelemetry",
  "telemetry.sdk.version": "1.28.0",
});

/** The product's resource: lib/telemetry/tracer.ts. */
const PRODUCT_RESOURCE = attributes({ "service.name": "hb-workers", "service.namespace": "harness-bible" });

/*
 * Two programs on this machine that are not the product's, sending to 4318 as any OpenTelemetry SDK does by default:
 * one names itself, one does not. Their resources carry the host, the user and the command line, their span names a
 * URL with a question in it, their status a message. None of it may reach Langfuse (49 § 5.5); Tempo, which stays on
 * this machine, receives them.
 */
export const FOREIGN_SERVICE = "a-local-tool";
export const FOREIGN_HOST = "someones-laptop";
export const FOREIGN_OWNER = "someone-local";
export const FOREIGN_SPANS = 2;

function foreignSpan(spanId: string): object {
  return {
    traceId: "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a",
    spanId,
    name: `GET /search?q=${encodeURIComponent(QUESTION)}`,
    kind: 2,
    startTimeUnixNano: nanos(ENDED - 40),
    endTimeUnixNano: nanos(ENDED),
    attributes: attributes({ "url.query": `q=${QUESTION}` }),
    status: { code: 2, message: `failed on: ${QUESTION}` },
  };
}

const FOREIGN_RESOURCE = attributes({
  "host.name": FOREIGN_HOST,
  "process.owner": FOREIGN_OWNER,
  "process.command_line": `${FOREIGN_SERVICE} --watch /home/${FOREIGN_OWNER}/notes`,
});

/** One OTLP/JSON `ExportTraceServiceRequest`, as one line of the receiver's file. */
export function collectorFixture(): string {
  return JSON.stringify({
    resourceSpans: [
      { resource: { attributes: PRODUCT_RESOURCE }, scopeSpans: [{ scope: { name: "harness-bible" }, spans: productSpans() }] },
      { resource: { attributes: GATEWAY_RESOURCE }, scopeSpans: [{ scope: { name: "litellm" }, spans: gatewaySpans() }] },
      {
        resource: { attributes: [...attributes({ "service.name": FOREIGN_SERVICE }), ...FOREIGN_RESOURCE] },
        scopeSpans: [{ scope: { name: FOREIGN_SERVICE }, spans: [foreignSpan("8a8a8a8a8a8a8a8a")] }],
      },
      { resource: { attributes: FOREIGN_RESOURCE }, scopeSpans: [{ scope: { name: "unnamed" }, spans: [foreignSpan("8b8b8b8b8b8b8b8b")] }] },
    ],
  });
}
