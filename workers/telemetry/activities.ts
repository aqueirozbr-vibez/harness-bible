import { ApplicationFailure, CancelledFailure, type Context, type Info } from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";

import { suggestionOfEvidenceItem, type ServiceCaller } from "@/lib/db/improve";
import { researchTraceOf, researchTraceOfFinding } from "@/lib/db/research";
import { AppError } from "@/lib/errors";
import { CODE_PATTERN } from "@/lib/schemas/research";
import { logActivity, type ActivityLine } from "@/lib/telemetry/lines";
import { inSpan } from "@/lib/telemetry/spans";

import { traceOf, type TraceLookups } from "./traceOf";

/*
 * The workflows' activities as spans (feature-specs/49 § 7.1): one activity inbound interceptor, registered on the
 * engine's workers (workers/temporal.ts). For each execution it reads the activity's type, its workflow's type and id
 * and the attempt from the activity's context, resolves the subject's trace (./traceOf.ts), runs the activity inside a
 * scope of its own with no parent, so the activity's model calls, sensors and lines nest under it, and prints an
 * `activity` line at its end, which is that scope's span (spec 21 § 5.1: a span is a finished line).
 *
 * It runs in the worker's Node context, outside the workflow sandbox: it changes no workflow code, no activity
 * argument and no history (invariant 35). It rethrows whatever the activity threw, unchanged; its own failure, a
 * lookup, a line or the warning itself, is caught, and named in a warning where it can be, so a span may be lost and an
 * activity never is (spec 21 § 8).
 */

export interface ActivitySpanDeps {
  readonly lookups: TraceLookups;
  readonly warn: (line: string) => void;
  readonly log: (line: ActivityLine) => void;
}

/* The grader's caller, the one service told whose suggestion an item is by the item alone (lib/db/improve.ts). */
const GRADER: ServiceCaller = { kind: "service", id: "service:grader" };

export const ACTIVITY_SPAN_DEPS: ActivitySpanDeps = {
  lookups: { suggestionOfEvidenceItem: (itemId) => suggestionOfEvidenceItem(GRADER, itemId), researchTraceOf, researchTraceOfFinding },
  warn: (line) => console.warn(line),
  log: logActivity,
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "Error");

/* The reasons a cancellation is one (the workflow's, the server's for an execution it no longer knows, the worker's
   shutdown); the SDK reports a time-out, a pause, a reset and a heartbeat it could not read as failures, and so does this. */
const CANCELLED_REASONS: ReadonlySet<string> = new Set(["CANCELLED", "NOT_FOUND", "WORKER_SHUTDOWN"]);

function cancellationEnd(reason: string): { readonly outcome: "failed" | "cancelled"; readonly code: string } {
  if (reason === "TIMED_OUT") return { outcome: "failed", code: "TIMEOUT" };
  if (CANCELLED_REASONS.has(reason)) return { outcome: "cancelled", code: "CANCELLED" };
  return { outcome: "failed", code: CODE_PATTERN.test(reason) ? reason : "CANCELLED_FAILURE" };
}

/**
 * How an execution that threw ended, as an enumeration (§ 7.1). Where the activity's context was cancelled, its reason
 * decides, whatever the activity threw on it (an abort-aware call rejects with its own error): `cancelled` · `CANCELLED`
 * for a cancellation, `failed` · `TIMEOUT` for a time-out, `failed` with the reason for the rest. Otherwise a throw is
 * `failed`, with the `ApplicationFailure`'s type where that is a code, or the product's own error's code, or else the
 * error's name. Never its message, which can quote what it failed on.
 */
export function endOf(error: unknown, cancelReason?: string): { readonly outcome: "failed" | "cancelled"; readonly code: string } {
  if (cancelReason !== undefined) return cancellationEnd(cancelReason);
  if (error instanceof CancelledFailure) return cancellationEnd(error.message);
  if (error instanceof ApplicationFailure && typeof error.type === "string" && CODE_PATTERN.test(error.type)) return { outcome: "failed", code: error.type };
  if (error instanceof AppError && CODE_PATTERN.test(error.code)) return { outcome: "failed", code: error.code };
  return { outcome: "failed", code: errorName(error) };
}

/** What the interceptor reads of the activity's context; `cancelReason` is the reason its context was cancelled, if it was. */
export interface ExecutionInfo extends Pick<Info, "activityType" | "attempt" | "workflowType" | "workflowExecution"> {
  readonly cancelReason?: () => string | undefined;
}

/** One execution inside its span; `run` is the activity itself. */
export async function inActivitySpan<T>(info: ExecutionInfo, run: () => Promise<T>, deps: ActivitySpanDeps): Promise<T> {
  const workflowId = info.workflowExecution?.workflowId;
  const workflowType = info.workflowType;
  /* an activity no workflow started has no subject; none does here */
  if (workflowId === undefined || workflowType === undefined) return run();
  const started = performance.now();
  /* a warning that cannot be written is let go: nothing of the interceptor's own reaches the activity */
  const warn = (line: string): void => {
    try {
      deps.warn(line);
    } catch {
      /* the span may be lost, the activity never is (spec 21 § 8) */
    }
  };
  let resolved: Awaited<ReturnType<typeof traceOf>>;
  try {
    resolved = await traceOf(workflowType, workflowId, deps.lookups, warn);
  } catch {
    /* traceOf catches its reads' failures; anything else it meets costs the span, and the activity runs */
    return run();
  }
  const print = (outcome: ActivityLine["outcome"], code: string | null): void => {
    try {
      deps.log({
        traceId: resolved.traceId,
        activity: info.activityType,
        workflowType,
        workflowId,
        attempt: info.attempt,
        outcome,
        code,
        ...(resolved.legacy ? { legacy: true, runId: resolved.runId } : {}),
        ms: Math.round(performance.now() - started),
      });
    } catch (error: unknown) {
      warn(`telemetry: an activity's line was not printed (${errorName(error)})`);
    }
  };
  /* a root whatever scope the worker's code runs inside: an activity's subject is its own (§ 6.3) */
  return inSpan({ name: `activity.${info.activityType}`, traceId: resolved.traceId, root: true, ...(resolved.trace === undefined ? {} : { trace: resolved.trace }) }, async () => {
    let value: T;
    try {
      value = await run();
    } catch (error: unknown) {
      let reason: string | undefined;
      try {
        reason = info.cancelReason?.();
      } catch {
        reason = undefined;
      }
      const end = endOf(error, reason);
      print(end.outcome, end.code);
      throw error;
    }
    print("ok", null);
    return value;
  });
}

/** The reason the SDK cancelled an activity's context with, read from its signal (it aborts with a `CancelledFailure`). */
function cancelReasonOf(context: Context): string | undefined {
  const signal = context.cancellationSignal;
  return signal.aborted && signal.reason instanceof CancelledFailure ? signal.reason.message : undefined;
}

/** The interceptor the engine's workers register (workers/temporal.ts). */
export function activitySpans(deps: ActivitySpanDeps = ACTIVITY_SPAN_DEPS): ActivityInterceptorsFactory {
  return (context) => ({ inbound: { execute: (input, next) => inActivitySpan({ ...context.info, cancelReason: () => cancelReasonOf(context) }, () => next(input), deps) } });
}
