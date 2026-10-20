import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";

import { BudgetExceededError, budgetResetAt, GatewayRefusedError, GatewayUnavailableError, isBudgetError, ProviderRefusalError } from "./errors";

/** The proxy's 429 (auth_checks.py at the pinned image) and its 400 (spec § 5.2). */
const BUDGET_429 = { type: "error", error: { type: "rate_limit_error", message: "Budget has been exceeded! Key=org:org-1 (sk-...70d0) Current cost: 0.000076, Max budget: 0.000001" } };
const BUDGET_400 = { error: { message: "ExceededBudget: Crossed spend threshold for key", type: "budget_exceeded", param: null, code: "400" } };

describe("isBudgetError (feature-specs/11 § 5.2)", () => {
  it("matches LiteLLM's 400 and 429 shapes as text or as JSON", () => {
    expect(isBudgetError(429, BUDGET_429)).toBe(true);
    expect(isBudgetError(429, JSON.stringify(BUDGET_429))).toBe(true);
    expect(isBudgetError(400, BUDGET_400)).toBe(true);
    expect(isBudgetError(400, JSON.stringify(BUDGET_400))).toBe(true);
    expect(isBudgetError(429, "ExceededBudget")).toBe(true);
  });

  it("leaves a plain rate limit, another 400 and every other status alone", () => {
    expect(isBudgetError(429, { type: "error", error: { type: "rate_limit_error", message: "Rate limit exceeded" } })).toBe(false);
    expect(isBudgetError(400, { type: "error", error: { type: "invalid_request_error", message: "messages: roles must alternate" } })).toBe(false);
    expect(isBudgetError(402, BUDGET_429)).toBe(false);
    expect(isBudgetError(500, BUDGET_400)).toBe(false);
    expect(isBudgetError(429, undefined)).toBe(false);
    expect(isBudgetError(429, null)).toBe(false);
  });
});

describe("the client's errors", () => {
  it("are AppErrors with stable codes and their spec fields", () => {
    const budget = new BudgetExceededError(new Date("2026-10-01T00:00:00.000Z"), "budget");
    expect(budget).toBeInstanceOf(AppError);
    expect(budget.code).toBe("GATEWAY_BUDGET");
    expect(budget.resetsAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    const down = new GatewayUnavailableError("timeout", "timed out");
    expect(down.code).toBe("GATEWAY_UNAVAILABLE");
    expect(down.cause).toBe("timeout");
    const refused = new GatewayRefusedError(401, "no");
    expect(refused.code).toBe("GATEWAY_REFUSED");
    expect(refused.status).toBe(401);
    const stop = new ProviderRefusalError("cyber");
    expect(stop.code).toBe("PROVIDER_REFUSAL");
    expect(stop.category).toBe("cyber");
    expect(new ProviderRefusalError(null).message).toContain("category none");
  });

  it("resets a 1mo budget on the first of next month, UTC", () => {
    expect(budgetResetAt(new Date("2026-09-23T12:00:00.000Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(budgetResetAt(new Date("2026-12-31T23:59:59.000Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
