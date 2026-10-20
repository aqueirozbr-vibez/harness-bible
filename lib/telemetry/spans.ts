import { AsyncLocalStorage } from "node:async_hooks";

import { guard } from "@/lib/security/guard";

/*
 * The seam between the product's log lines and a tracer (feature-specs/21 § 5.1, D3). Every span the product emits
 * already exists as one JSON line; the function that prints the line also hands the same facts here, so one code
 * path feeds both. With no tracer started — development, CI, any process without `OTEL_EXPORTER_OTLP_ENDPOINT` —
 * `recordSpan` does nothing and the lines are all there is.
 *
 * This module imports no OpenTelemetry package: it is on the path of every request, and the SDK loads only in a
 * process that starts it (`lib/telemetry/tracer.ts`).
 *
 * Its state lives on `globalThis`, as the database client does, and for a stronger reason: Next.js loads
 * `instrumentation.ts` and each route as separate module graphs in one process, so a tracer started from the first
 * would install its sink into a copy of this module that no request ever calls. One process, one sink.
 */

export type SpanName = "http.request" | "gen_ai.chat" | "gen_ai.embeddings" | "gen_ai.rerank" | "assistant.retrieve" | "assistant.answer" | "aid.run" | "job" | "research.run" | "research.plan" | "research.read" | "research.write";

export type SpanAttribute = string | number | boolean | null | undefined;

export interface SpanRecord {
  readonly name: SpanName;
  /** 32 hex characters: the request's trace, the one its `traceparent` carries (lib/api/trace.ts). */
  readonly traceId: string;
  /** 16 hex characters, when the line has an id of its own (a request's); otherwise the tracer makes one. */
  readonly spanId?: string;
  /**
   * The caller's span. `undefined` asks for the span this code is running inside (`withSpanScope`), when that span
   * is of the same trace; `null` says there is none.
   */
  readonly parentId?: string | null;
  /** When the work ended, epoch milliseconds, and how long it took: a line is written at the end. */
  readonly endedAt: number;
  readonly ms: number;
  /** Ids, counts, codes, hashes and timings. Never a prompt, an answer, a question, an e-mail or a key (§ 5.1). */
  readonly attributes: Readonly<Record<string, SpanAttribute>>;
  /** The failure's code or the error's name, never its message: a message can quote what it failed on. */
  readonly error?: string;
}

export type SpanSink = (record: SpanRecord & { readonly parentId: string | null }) => void;

interface Scope {
  readonly traceId: string;
  readonly spanId: string;
  /**
   * The scope is a request's own span: the web tier's handler and the workers' server open it. A span that takes
   * its parent from such a scope is marked `hb.parent: request`, because the Langfuse road drops every request's span
   * and Langfuse files a trace only when its root arrives: there the collector makes the marked span a root, and
   * Tempo keeps its parent (feature-specs/49 § 5.6).
   */
  readonly request?: true;
}

interface Shared {
  sink: SpanSink | null;
  readonly scope: AsyncLocalStorage<Scope>;
}

const globalForTelemetry = globalThis as unknown as { hbTelemetry?: Shared };

function shared(): Shared {
  return (globalForTelemetry.hbTelemetry ??= { sink: null, scope: new AsyncLocalStorage<Scope>() });
}

/** Installed by the tracer when it starts, removed when it stops. */
export function setSpanSink(next: SpanSink | null): void {
  shared().sink = next;
}

export function telemetryOn(): boolean {
  return shared().sink !== null;
}

/** Runs `fn` inside a request's span: what it records becomes that span's children, and what it calls is told so. */
export function withSpanScope<T>(span: Scope, fn: () => T): T {
  return shared().scope.run(span, fn);
}

/** The trace of the request this code runs inside, for a caller that was not handed one; null outside a request. */
export function currentTraceId(): string | null {
  return shared().scope.getStore()?.traceId ?? null;
}

/** The span this code runs inside, when it belongs to `traceId`. */
export function currentSpanId(traceId: string): string | null {
  const current = shared().scope.getStore();
  return current !== undefined && current.traceId === traceId ? current.spanId : null;
}

/** Hands a finished span to the tracer; nothing happens, and nothing can throw, when none is started. */
export function recordSpan(record: SpanRecord): void {
  const { sink, scope } = shared();
  if (sink === null) return;
  const current = scope.getStore();
  const inherited = current !== undefined && current.traceId === record.traceId && current.spanId !== record.spanId ? current : null;
  const parentId = record.parentId !== undefined ? record.parentId : (inherited?.spanId ?? null);
  /* Only a parent inherited from a request's scope is marked: one the line names is its caller's, kept everywhere. */
  const own = record.parentId === undefined && inherited?.request === true ? { ...record.attributes, "hb.parent": "request" } : record.attributes;
  /* The guard of § 6.2, as on the line: a secret in an attribute is replaced, and the span says it found one. */
  const attributes = guard(own);
  const error = record.error === undefined ? undefined : guard(record.error);
  const detected = attributes.detected + (error?.detected ?? 0);
  try {
    sink({
      ...record,
      parentId,
      attributes: detected === 0 ? own : { ...attributes.value, "hb.secret.detected": true },
      ...(error === undefined ? {} : { error: error.value }),
    });
  } catch (error: unknown) {
    /* Telemetry never fails the work it describes (§ 8: requests are never slowed or failed by telemetry). */
    console.warn("telemetry: a span was not recorded", error instanceof Error ? error.name : "error");
  }
}
