import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import { guard } from "@/lib/security/guard";
import { langfuseAttributesOf, type TraceAttributes } from "@/lib/telemetry/langfuse";

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

export type SpanName =
  | "http.request"
  | "gen_ai.chat"
  | "gen_ai.embeddings"
  | "gen_ai.rerank"
  | "assistant.retrieve"
  | "assistant.answer"
  | "aid.run"
  | "job"
  | "research.run"
  | "research.plan"
  | "research.read"
  | "research.write"
  | "search.query"
  /* one span a sensor's run (feature-specs/49 § 8) */
  | `sensor.${string}`
  /* one span a workflow's activity execution (feature-specs/49 § 7.1) */
  | `activity.${string}`;

/** A list is for tags, enumerations without whitespace (feature-specs/49 § 6.4). */
export type SpanAttribute = string | number | boolean | null | undefined | ReadonlyArray<string>;

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
  /** The subject's trace attributes (feature-specs/49 § 6.4), set on every span recorded inside the scope. */
  readonly trace?: TraceAttributes;
  /**
   * A scope `inSpan` opened: the span it is the body of, and that span's own parent, so the line the work prints at
   * its end becomes the span with this scope's id (§ 6.3). Mutable only in `recorded`, which `inSpan` reads after.
   */
  readonly own?: { readonly name: SpanName; readonly parentId: string | null; readonly parentRequest: boolean; recorded: boolean };
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

/**
 * Runs `fn` as the body of a span of its own (feature-specs/49 § 6.3): a new span id whose parent is the span this
 * code runs inside, so everything recorded inside nests under it and carries the subject's `trace` (a nested scope
 * keeps its outer scope's). The span itself is the line the work prints at its end, named `name`: printed inside
 * `fn`, wherever, it is recorded with this id. If `fn` throws before printing it, it is recorded here, failed, with
 * the error's name and `failed`'s attributes (the outcome a filter looks for); if `fn` ends without printing it, it is
 * recorded here plain, so its children still have their parent. Either way once. `root` opens it as a root whatever
 * scope the code runs inside, with none of that scope's trace attributes: a workflow's activity (§ 7.1).
 */
export async function inSpan<T>(
  open: { readonly name: SpanName; readonly traceId: string; readonly trace?: TraceAttributes; readonly failed?: Readonly<Record<string, SpanAttribute>>; readonly root?: true },
  fn: () => Promise<T>,
): Promise<T> {
  const outer = open.root === true ? undefined : shared().scope.getStore();
  const sameTrace = outer !== undefined && outer.traceId === open.traceId;
  const own = { name: open.name, parentId: sameTrace ? outer.spanId : null, parentRequest: sameTrace && outer.request === true, recorded: false };
  const trace = open.trace ?? (sameTrace ? outer.trace : undefined);
  const span: Scope = { traceId: open.traceId, spanId: randomBytes(8).toString("hex"), ...(trace === undefined ? {} : { trace }), own };
  const started = performance.now();
  const recordHere = (attributes: Readonly<Record<string, SpanAttribute>>, error?: string): void => {
    withSpanScope(span, () => {
      recordSpan({ name: open.name, traceId: open.traceId, endedAt: Date.now(), ms: Math.round(performance.now() - started), attributes, ...(error === undefined ? {} : { error }) });
    });
  };
  let value: T;
  try {
    value = await withSpanScope(span, fn);
  } catch (error: unknown) {
    if (!own.recorded) recordHere(open.failed ?? {}, error instanceof Error ? error.name : "Error");
    throw error;
  }
  if (!own.recorded) recordHere({});
  return value;
}

/** Hands a finished span to the tracer; nothing happens, and nothing can throw, when none is started. */
export function recordSpan(record: SpanRecord): void {
  const { sink, scope } = shared();
  const current = scope.getStore();
  const sameTrace = current !== undefined && current.traceId === record.traceId;
  /* The scope's own span: the line its work prints at the end, named as the scope was opened (inSpan). Marked before the
     tracer is asked, so a line printed while none ran still counts as the one, and inSpan never records a second. */
  const isOwn = sameTrace && current.own !== undefined && current.own.name === record.name && record.spanId === undefined && !current.own.recorded;
  if (isOwn && current.own !== undefined) current.own.recorded = true;
  if (sink === null) return;
  const inherited = sameTrace && !isOwn && current.spanId !== record.spanId ? current : null;
  const spanId = isOwn ? current.spanId : record.spanId;
  const parentId = record.parentId !== undefined ? record.parentId : isOwn ? (current.own?.parentId ?? null) : (inherited?.spanId ?? null);
  /* Only a parent inherited from a request's scope is marked: one the line names is its caller's, kept everywhere. */
  const fromRequest = record.parentId === undefined && (isOwn ? current.own?.parentRequest === true : inherited?.request === true);
  const marked = fromRequest ? { ...record.attributes, "hb.parent": "request" } : record.attributes;
  /* The observation's type and level, and the subject's trace attributes, as Langfuse reads them (49 § 6.3, § 6.4). */
  const own = { ...marked, ...langfuseAttributesOf(record.name, marked, sameTrace ? current.trace : undefined) };
  /* The guard of § 6.2, as on the line: a secret in an attribute is replaced, and the span says it found one. */
  const attributes = guard(own);
  const error = record.error === undefined ? undefined : guard(record.error);
  const detected = attributes.detected + (error?.detected ?? 0);
  try {
    sink({
      ...record,
      ...(spanId === undefined ? {} : { spanId }),
      parentId,
      attributes: detected === 0 ? own : { ...attributes.value, "hb.secret.detected": true },
      ...(error === undefined ? {} : { error: error.value }),
    });
  } catch (error: unknown) {
    /* Telemetry never fails the work it describes (§ 8: requests are never slowed or failed by telemetry). */
    console.warn("telemetry: a span was not recorded", error instanceof Error ? error.name : "error");
  }
}
