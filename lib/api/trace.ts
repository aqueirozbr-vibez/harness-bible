import { randomBytes } from "node:crypto";

/*
 * W3C trace context (feature-specs/09 § 7 step 1): the trace id comes from a
 * valid incoming `traceparent`, else it is new; every response carries one.
 */

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(header: string | null): { readonly traceId: string; readonly parentId: string } | null {
  if (header === null) return null;
  const m = TRACEPARENT.exec(header.trim());
  if (m === null || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1], parentId: m[2] };
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function traceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

/** The trace id of a request: the incoming one when valid, else new. */
export function traceIdOf(request: Request): string {
  return parseTraceparent(request.headers.get("traceparent"))?.traceId ?? newTraceId();
}
