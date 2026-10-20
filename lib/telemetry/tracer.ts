import { randomBytes } from "node:crypto";

import type { SpanExporter } from "@opentelemetry/sdk-trace";

import { env } from "@/lib/env";
import { setSpanSink, type SpanAttribute, type SpanName, type SpanSink } from "@/lib/telemetry/spans";

/*
 * The tracer (feature-specs/21 § 5.1, D3): started by a process that wants its spans exported — the web tier in
 * `instrumentation.ts`, the workers at boot, a scheduled job — and only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 * Unset, this file loads no OpenTelemetry code and exports nothing; the JSON lines are unchanged either way.
 *
 * Two deliberate limits:
 * - The provider is not registered as the process's global one. Only the spans the product builds from its own
 *   lines are exported, so a framework's automatic spans — which carry request URLs, and a search URL carries what
 *   the reader typed — cannot reach the collector through it (§ 5.1: no question in any span).
 * - A span is built after the fact, from a finished line: its trace id and span id are the line's own, so the ids in
 *   the logs, in a response's `traceparent` and in the trace are the same ids.
 */

export type TelemetryService = "hb-web" | "hb-workers" | "hb-jobs";

interface Running {
  readonly flush: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/* On `globalThis` for the reason `spans.ts` gives: one tracer per process, whichever module graph asks. */
const globalForTracer = globalThis as unknown as { hbTracer?: Running | null };

const KIND_SERVER: ReadonlySet<SpanName> = new Set<SpanName>(["http.request"]);
const KIND_CLIENT: ReadonlySet<SpanName> = new Set<SpanName>(["gen_ai.chat", "gen_ai.embeddings", "gen_ai.rerank"]);

function attributesOf(input: Readonly<Record<string, SpanAttribute>>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(input)) if (value !== null && value !== undefined) out[name] = value;
  return out;
}

/**
 * Starts exporting when an endpoint is configured; returns whether it did. Safe to call twice: the second call
 * keeps the first tracer.
 */
export async function startTelemetry(service: TelemetryService, endpoint: string | undefined = env.OTEL_EXPORTER_OTLP_ENDPOINT): Promise<boolean> {
  if (endpoint === undefined) return false;
  if (globalForTracer.hbTracer != null) return true;

  const [api, sdk, resources, otlp] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/sdk-trace"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/exporter-trace-otlp-http"),
  ]);

  /* The line's own ids: the SDK asks for an id, and is given the one waiting for it, or a random one. */
  const ids = {
    traceId: null as string | null,
    spanId: null as string | null,
    generateTraceId(): string {
      const id = this.traceId ?? randomBytes(16).toString("hex");
      this.traceId = null;
      return id;
    },
    generateSpanId(): string {
      const id = this.spanId ?? randomBytes(8).toString("hex");
      this.spanId = null;
      return id;
    },
  };

  /* A collector that does not answer costs one warning line, not one per batch, and never a request (§ 8). */
  const exporter = new otlp.OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, "")}/v1/traces` });
  let down = false;
  const reporting: SpanExporter = {
    export: (spans, done) => {
      exporter.export(spans, (result) => {
        if (result.code !== 0 && !down) {
          down = true;
          console.warn(`telemetry: the collector at ${new URL(endpoint).origin} did not accept spans; they are dropped until it does`);
        } else if (result.code === 0 && down) {
          down = false;
          console.info("telemetry: the collector accepts spans again");
        }
        done(result);
      });
    },
    shutdown: () => exporter.shutdown(),
    forceFlush: () => exporter.forceFlush(),
  };

  const provider = new sdk.TracerProvider({
    resource: resources.resourceFromAttributes({ "service.name": service, "service.namespace": "harness-bible" }),
    idGenerator: ids,
    spanProcessors: [new sdk.BatchSpanProcessor({ exporter: reporting })],
  });
  const tracer = provider.getTracer("harness-bible");

  const sink: SpanSink = (record) => {
    const parent =
      record.parentId === null
        ? api.ROOT_CONTEXT
        : api.trace.setSpanContext(api.ROOT_CONTEXT, { traceId: record.traceId, spanId: record.parentId, traceFlags: api.TraceFlags.SAMPLED, isRemote: true });
    ids.traceId = record.parentId === null ? record.traceId : null;
    ids.spanId = record.spanId ?? null;
    const span = tracer.startSpan(
      record.name,
      {
        kind: KIND_SERVER.has(record.name) ? api.SpanKind.SERVER : KIND_CLIENT.has(record.name) ? api.SpanKind.CLIENT : api.SpanKind.INTERNAL,
        startTime: record.endedAt - record.ms,
        attributes: attributesOf(record.attributes),
      },
      parent,
    );
    ids.traceId = null;
    ids.spanId = null;
    if (record.error !== undefined) span.setStatus({ code: api.SpanStatusCode.ERROR, message: record.error });
    span.end(record.endedAt);
  };

  setSpanSink(sink);
  globalForTracer.hbTracer = {
    flush: () => provider.forceFlush(),
    stop: async () => {
      setSpanSink(null);
      await provider.shutdown();
    },
  };
  return true;
}

/** Sends what is waiting; a test and a job call it, a server lets the batch timer do it. */
export async function flushTelemetry(): Promise<void> {
  await globalForTracer.hbTracer?.flush().catch(() => undefined);
}

/** Flushes and stops; a job calls it before it exits, a test between cases. */
export async function stopTelemetry(): Promise<void> {
  const current = globalForTracer.hbTracer;
  globalForTracer.hbTracer = null;
  await current?.stop().catch(() => undefined);
}
