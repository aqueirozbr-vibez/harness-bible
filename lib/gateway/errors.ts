import { AppError } from "@/lib/errors";

/*
 * The client's typed errors (feature-specs/11 § 5.2). Importable by the web tier, which renders the 402 of
 * architecture § 5.5 from `BudgetExceededError.resetsAt` and a 503 from `GatewayUnavailableError`.
 */

export type UnavailableCause = "unconfigured" | "no_key" | "connection" | "timeout" | "server" | "rate_limit" | "key_management";

/** The gateway's budget refusal: the call never reached a provider (invariant 7). */
export class BudgetExceededError extends AppError {
  readonly resetsAt: Date;

  constructor(resetsAt: Date, message: string) {
    super("GATEWAY_BUDGET", message);
    this.name = "BudgetExceededError";
    this.resetsAt = resetsAt;
  }
}

/** No gateway, no key, a connection failure, a timeout or a 5xx after the SDK's retries: the model call is refused (architecture § 9). */
export class GatewayUnavailableError extends AppError {
  override readonly cause: UnavailableCause;

  constructor(cause: UnavailableCause, message: string) {
    super("GATEWAY_UNAVAILABLE", message);
    this.name = "GatewayUnavailableError";
    this.cause = cause;
  }
}

/** A 400 that is not a budget message, 401, 403, 404, 413: a defect in the request or the key, never retried. */
export class GatewayRefusedError extends AppError {
  readonly status: number;

  constructor(status: number, message: string) {
    super("GATEWAY_REFUSED", message);
    this.name = "GatewayRefusedError";
    this.status = status;
  }
}

/** HTTP 200 with `stop_reason: "refusal"`: the provider's safety stop, the agent's one failure (spec 13). */
export class ProviderRefusalError extends AppError {
  readonly category: string | null;

  constructor(category: string | null) {
    super("PROVIDER_REFUSAL", `the provider stopped the answer (category ${category ?? "none"})`);
    this.name = "ProviderRefusalError";
    this.category = category;
  }
}

/**
 * LiteLLM's two budget shapes (spec § 5.2): HTTP 400 with `ExceededBudget` in the body, or HTTP 429 whose message
 * is the proxy's "Budget has been exceeded! Key=… Current cost: …, Max budget: …" (auth_checks.py at the pinned
 * image; the stub repeats it). `body` is the response text or its parsed JSON.
 */
export function isBudgetError(status: number, body: unknown): boolean {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  if (status === 400) return text.includes("ExceededBudget");
  if (status === 429) return text.includes("Budget has been exceeded") || text.includes("ExceededBudget");
  return false;
}

/** When a `1mo` key budget resets: the first of the month after `now`, 00:00 UTC (the proxy's `budget_reset_at`). */
export function budgetResetAt(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
