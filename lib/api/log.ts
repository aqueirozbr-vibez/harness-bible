import { httpSpanOf, jobSpanOf } from "@/lib/telemetry/lines";
import { printLine } from "@/lib/telemetry/print";
import { recordSpan } from "@/lib/telemetry/spans";

/*
 * Spans as structured log lines (feature-specs/09 § 7 step 10): one JSON line per request with the trace id, the
 * subject id, the policy decision, status and time. Never the e-mail. Since unit 35c the same call also hands the
 * line to the tracer, which exports it as a span when a collector is configured and does nothing otherwise
 * (feature-specs/21 § 5.1, D3): one code path, the line always, the span when someone listens.
 */

export interface SpanLine {
  readonly traceId: string;
  readonly spanId: string;
  /** The caller's span, when the request arrived with a `traceparent`. */
  readonly parentId?: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
  readonly subject: string | null;
  readonly policy?: "allow" | "deny" | "skipped";
  readonly code?: string;
}

export type SpanLogger = (line: SpanLine) => void;

export const logSpan: SpanLogger = (line) => {
  printLine("span", line);
  recordSpan(httpSpanOf(line, Date.now()));
};

/**
 * A scheduled job's one line (feature-specs/21 § 3.1): its name, what it counted, how long it took, and `error` when
 * it threw. The collector reads it like a span line; the alert on a missing or failing job reads these.
 */
export interface JobLine {
  readonly traceId: string;
  readonly job: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly ms: number;
  readonly error?: string;
}

export function logJob(line: JobLine): void {
  printLine("job", line);
  recordSpan(jobSpanOf(line, Date.now()));
}
