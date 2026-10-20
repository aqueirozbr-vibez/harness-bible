import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { PolicyInputSchema, type PolicyAction, type PolicyContext, type PolicyResource, type PolicySubject } from "@/lib/policy/input";
import { printLine } from "@/lib/telemetry/print";

/*
 * The OPA client (feature-specs/09 § 5.1): one POST per decision to the
 * sidecar, 200 ms timeout, one retry, fail closed. Allows are never cached.
 * Every decision is one structured log line; the e-mail never appears.
 */

export type Decision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

export interface OpaOptions {
  /** Override of `OPA_URL`; `null` means "not configured" (tests). */
  readonly url?: string | null;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly log?: (line: Record<string, unknown>) => void;
}

const DEFAULT_TIMEOUT_MS = 200;
const DECISION_PATH = "/v1/data/hb/authz/allow";

function defaultContext(partial: Partial<PolicyContext>): PolicyContext {
  return { releaseId: partial.releaseId ?? env.RELEASE_ID, traceId: partial.traceId ?? "-", method: partial.method ?? "-", path: partial.path ?? "-", now: partial.now ?? new Date().toISOString() };
}

async function ask(url: string, body: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Decision> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${url}${DECISION_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: controller.signal });
    if (response.status !== 200) return { allow: false, reason: `opa_status_${response.status}` };
    const json: unknown = await response.json();
    const result = typeof json === "object" && json !== null ? (json as { result?: unknown }).result : undefined;
    if (result === true) return { allow: true };
    if (result === false || result === undefined) return { allow: false, reason: "policy_deny" };
    return { allow: false, reason: "opa_non_boolean" };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask OPA; unreachable, slow, or malformed answers deny (invariant 23). */
export async function authorize(subject: PolicySubject, action: PolicyAction, resource: PolicyResource, context: Partial<PolicyContext> = {}, options: OpaOptions = {}): Promise<Decision> {
  const url = options.url === undefined ? env.OPA_URL : (options.url ?? undefined);
  const log = options.log ?? ((line) => void printLine("policy", line));
  const ctx = defaultContext(context);
  const input = PolicyInputSchema.parse({ subject, action, resource, context: ctx });
  const started = performance.now();
  let decision: Decision;
  if (url === undefined) {
    decision = { allow: false, reason: "opa_unconfigured" };
  } else {
    const body = JSON.stringify({ input });
    const fetchImpl = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      decision = await ask(url, body, fetchImpl, timeoutMs);
    } catch {
      try {
        decision = await ask(url, body, fetchImpl, timeoutMs);
      } catch {
        decision = { allow: false, reason: "opa_unreachable" };
      }
    }
  }
  log({ traceId: ctx.traceId, subject: subject.id, role: subject.role, action, resource: resource.kind, resourceId: resource.id, allow: decision.allow, reason: decision.allow ? undefined : decision.reason, ms: Math.round(performance.now() - started) });
  return decision;
}

/** Throws `FORBIDDEN` on a deny; the reason stays in the log. */
export async function requireAllowed(subject: PolicySubject, action: PolicyAction, resource: PolicyResource, context: Partial<PolicyContext> = {}): Promise<void> {
  const decision = await authorize(subject, action, resource, context);
  if (!decision.allow) throw new AppError("FORBIDDEN", "you cannot do this to that resource");
}
