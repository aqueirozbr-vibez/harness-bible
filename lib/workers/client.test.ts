import { describe, expect, it } from "vitest";

import { parseTraceparent } from "@/lib/api/trace";

import { ROUTE_TIMEOUT_MS, workersFetch, WorkersRefusedError, WorkersUnavailableError, type WorkersClientDeps } from "./client";

/*
 * The web tier's client with fetch doubles (feature-specs/11 § 7.2, § 7.3, § 12.5): what it sends, what it
 * makes of every kind of answer, and that it fails closed before any request. The client against the running
 * surface is tests/workers.test.ts.
 */

const TRACE = "c".repeat(32);
const TOKEN = "test-workers-token";

type Fetch = typeof fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deps(fetch: Fetch, overrides: Partial<WorkersClientDeps> = {}): WorkersClientDeps {
  return { baseUrl: "http://workers.test", token: TOKEN, fetch, timeouts: ROUTE_TIMEOUT_MS, ...overrides };
}

function capture(response: () => Response): { readonly fetch: Fetch; readonly calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return response();
    },
  };
}

describe("workersFetch", () => {
  it("sends a GET for /health and a POST with the typed body otherwise, with the bearer and the traceparent", async () => {
    const health = capture(() => json(200, { ok: true, gateway: "up", keys: 1, temporal: "off" }));
    expect(await workersFetch("/health", null, { traceId: TRACE }, deps(health.fetch))).toEqual({ ok: true, gateway: "up", keys: 1, temporal: "off" });
    expect(health.calls[0].url).toBe("http://workers.test/health");
    expect(health.calls[0].init?.method).toBe("GET");
    expect(health.calls[0].init?.body).toBeUndefined();
    const headers = new Headers(health.calls[0].init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(parseTraceparent(headers.get("traceparent"))?.traceId).toBe(TRACE);
    expect(headers.get("content-type")).toBeNull();

    const ensure = capture(() => json(200, { litellmKeyId: "abc", createdAt: "2026-09-23T12:00:00.000Z" }));
    expect(await workersFetch("/keys/ensure", { principal: { userId: "u-1" } }, { traceId: TRACE }, deps(ensure.fetch))).toEqual({ litellmKeyId: "abc", createdAt: "2026-09-23T12:00:00.000Z" });
    expect(ensure.calls[0].init?.method).toBe("POST");
    expect(ensure.calls[0].init?.body).toBe(JSON.stringify({ principal: { userId: "u-1" } }));
    expect(new Headers(ensure.calls[0].init?.headers).get("content-type")).toBe("application/json");
  });

  it("fails closed before any request without WORKERS_URL or WORKERS_TOKEN", async () => {
    const never = capture(() => {
      throw new Error("must not be called");
    });
    await expect(workersFetch("/health", null, { traceId: TRACE }, deps(never.fetch, { baseUrl: undefined }))).rejects.toMatchObject({ code: "WORKERS_UNAVAILABLE", cause: "unconfigured" });
    await expect(workersFetch("/health", null, { traceId: TRACE }, deps(never.fetch, { token: undefined }))).rejects.toMatchObject({ code: "WORKERS_UNAVAILABLE", cause: "unconfigured" });
    expect(never.calls).toHaveLength(0);
  });

  it("maps a connection failure to WorkersUnavailableError with the cause's message", async () => {
    const refused: Fetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:4002") });
    };
    const error = await workersFetch("/health", null, { traceId: TRACE }, deps(refused)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkersUnavailableError);
    expect((error as WorkersUnavailableError).cause).toBe("connection");
    expect((error as WorkersUnavailableError).message).toContain("ECONNREFUSED");
  });

  it("carries every route's deadline: Andre's four values of 2026-09-24, spec 12's 150 ms, and the turn's derived 450 s", () => {
    expect(ROUTE_TIMEOUT_MS).toEqual({ "/health": 5_000, "/keys/ensure": 10_000, "/keys/rotate": 10_000, "/gateway/check": 20_000, "/answer": 450_000, "/embed/query": 150 });
  });

  it("times out a route that has a deadline and passes the signal to fetch; a route with none sends no signal", async () => {
    const slow: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const error = await workersFetch("/health", null, { traceId: TRACE }, deps(slow, { timeouts: { ...ROUTE_TIMEOUT_MS, "/health": 20 } })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkersUnavailableError);
    expect((error as WorkersUnavailableError).cause).toBe("timeout");
    const untimed = capture(() => json(200, { ok: true, gateway: "up", keys: 0, temporal: "off" }));
    await workersFetch("/health", null, { traceId: TRACE }, deps(untimed.fetch, { timeouts: { ...ROUTE_TIMEOUT_MS, "/health": null } }));
    expect(untimed.calls[0].init?.signal).toBeUndefined();
  });

  it("raises the workers' error body as WorkersRefusedError with its status and code", async () => {
    const budget = capture(() => json(402, { code: "GATEWAY_BUDGET", message: "Budget has been exceeded", traceId: TRACE }));
    const error = await workersFetch("/gateway/check", { principal: { organisationId: "org-1" } }, { traceId: TRACE }, deps(budget.fetch)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkersRefusedError);
    expect(error).toMatchObject({ status: 402, code: "GATEWAY_BUDGET", message: "Budget has been exceeded" });
  });

  it("treats an answer outside the protocol as unavailability: no JSON, an error without a body, an answer off its shape", async () => {
    const html = capture(() => new Response("<html>", { status: 502 }));
    await expect(workersFetch("/health", null, { traceId: TRACE }, deps(html.fetch))).rejects.toMatchObject({ code: "WORKERS_UNAVAILABLE", cause: "malformed" });
    const bare = capture(() => json(500, { error: "boom" }));
    await expect(workersFetch("/health", null, { traceId: TRACE }, deps(bare.fetch))).rejects.toMatchObject({ code: "WORKERS_UNAVAILABLE", cause: "malformed" });
    const leaky = capture(() => json(200, { litellmKeyId: "abc", createdAt: "2026-09-23T12:00:00.000Z", key: "sk-1" }));
    const error = await workersFetch("/keys/ensure", { principal: { userId: "u-1" } }, { traceId: TRACE }, deps(leaky.fetch)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "WORKERS_UNAVAILABLE", cause: "malformed" });
    expect((error as WorkersUnavailableError).message).not.toContain("sk-1");
  });
});
