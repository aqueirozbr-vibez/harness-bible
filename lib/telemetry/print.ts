import { guard } from "@/lib/security/guard";

/*
 * The one place a JSON line is written (feature-specs/21 § 5.1, § 6.2). Every line the product prints — a request,
 * a model call, a job, a policy decision, a retrieval, an aid's run, an answer, a research run's step, a sensor's
 * run, a search, a workflow's activity — goes through `printLine`, which passes it through the guard first: a secret
 * found in a line is replaced, and the line says so with `hb.secret.detected`, which is what the alert reads.
 *
 * The kinds are the collector's allow-list (infra/observability/otel-collector.yaml): a line of another kind does
 * not reach the log store, and a test compares the two lists.
 */

export const LINE_KINDS = ["span", "model_call", "job", "policy", "retrieve", "aid_run", "answer", "research", "sensor", "search", "activity"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export const SECRET_DETECTED = "hb.secret.detected";

/** Prints the line; returns how many secrets the guard replaced in it, which is zero unless something upstream is wrong. */
export function printLine(kind: LineKind, line: object): number {
  const guarded = guard(line);
  console.info(JSON.stringify({ kind, ...guarded.value, ...(guarded.detected > 0 ? { [SECRET_DETECTED]: true } : {}) }));
  return guarded.detected;
}
