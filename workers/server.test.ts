import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { EMBED_MODEL_ID } from "@/lib/gateway/prices";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stubEmbedding } from "@/infra/gateway/stub/embed";
import { aliasesFromConfig, startStub, type RunningStub } from "@/infra/gateway/stub/server";
import type { SpanLine } from "@/lib/api/log";
import { parseTraceparent, traceparent } from "@/lib/api/trace";
import type { BudgetRowInput } from "@/lib/db/budget";
import type { GatewayKeyData, GatewayKeyRow, OrganisationCaps } from "@/lib/db/gateway";
import { AppError } from "@/lib/errors";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { encryptKey } from "@/lib/gateway/keys";
import type { GatewaySpan } from "@/lib/gateway/span";
import type { Principal } from "@/lib/schemas/gateway";
import { ROUTE_TIMEOUT_MS, workersFetch, WorkersRefusedError, WorkersUnavailableError, type WorkersClientDeps } from "@/lib/workers/client";
import { gatewayProbe, probeGateway, PROBE_DEADLINE_MS, PROBE_REFRESH_MS } from "@/workers/health";
import type { KeyDb } from "@/workers/keys";
import { bearerMatches, refusalOf, startWorkers, type RunningWorkers, type WorkersOptions } from "@/workers/server";

/*
 * The workers' surface in-process against the stub gateway (feature-specs/11 § 7.2, § 7.3, § 12.3, § 12.5), with
 * the GatewayKey rows, the ledger append and the span logger as in-memory doubles, and the web tier's client
 * driven against it end to end. The database-backed key path is tests/integration/gateway.test.ts.
 */

const MASTER_KEY = "test-master-key-for-the-workers-surface";
const SECRET = "0123456789abcdef".repeat(4);
const TOKEN = "test-workers-token-0123456789";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const TRACE = "d".repeat(32);
const ALIASES = aliasesFromConfig(readFileSync(join(import.meta.dirname, "..", "infra", "gateway", "litellm.yaml"), "utf8"));
const ORG: Principal = { organisationId: "org-1" };
const TINY: Principal = { organisationId: "org-tiny" };
const USER: Principal = { userId: "u-1" };
const CAPS: Readonly<Record<string, OrganisationCaps>> = { "org-1": { tokenCap: BigInt(1_000_000), tokensPerMinute: 1000 }, "org-tiny": { tokenCap: BigInt(1), tokensPerMinute: 1000 } };

function memoryDb(): KeyDb & { readonly rows: Map<string, GatewayKeyRow> } {
  const rows = new Map<string, GatewayKeyRow>();
  const keyOf = (principal: Principal): string => JSON.stringify(principal);
  return {
    rows,
    findKey: async (principal) => rows.get(keyOf(principal)) ?? null,
    insertKey: async (principal, data: GatewayKeyData) => {
      if (rows.has(keyOf(principal))) throw Object.assign(new Error("Unique constraint failed on the fields: (`organisationId`)"), { code: "P2002" });
      const row: GatewayKeyRow = { id: `row-${rows.size + 1}`, ...data, maxBudgetUsd: String(data.maxBudgetUsd), createdAt: NOW, rotatedAt: null };
      rows.set(keyOf(principal), row);
      return row;
    },
    replaceKey: async (principal, data, rotatedAt, replacing) => {
      const existing = rows.get(keyOf(principal));
      if (existing === undefined || existing.litellmKeyId !== replacing) return null;
      const row: GatewayKeyRow = { ...existing, ...data, maxBudgetUsd: String(data.maxBudgetUsd), rotatedAt };
      rows.set(keyOf(principal), row);
      return row;
    },
    organisationCaps: async (id) => CAPS[id] ?? null,
    isIndividualUser: async (id) => id === "u-1",
  };
}

interface Surface {
  readonly workers: RunningWorkers;
  readonly db: ReturnType<typeof memoryDb>;
  readonly rows: BudgetRowInput[];
  readonly spans: GatewaySpan[];
  readonly lines: SpanLine[];
  readonly failKeyCount: { value: boolean };
}

async function startSurface(gatewayUrl: string | undefined, clock: () => Date = () => NOW): Promise<Surface> {
  const db = memoryDb();
  const rows: BudgetRowInput[] = [];
  const spans: GatewaySpan[] = [];
  const lines: SpanLine[] = [];
  const failKeyCount = { value: false };
  const options: WorkersOptions = {
    token: TOKEN,
    keys: { gatewayUrl, masterKey: MASTER_KEY, keySecret: SECRET, individual: null, fetch: globalThis.fetch, now: clock, db },
    gateway: { baseUrl: gatewayUrl, keySecret: SECRET, findKey: db.findKey, append: async (row) => rows.push(row), log: (span) => spans.push(span), fetch: globalThis.fetch, now: clock },
    probe: gatewayProbe({ gatewayUrl, fetch: globalThis.fetch, now: clock }),
    keyCount: async () => {
      if (failKeyCount.value) throw new Error("count failed");
      return db.rows.size;
    },
    /* The turn itself is spec 15's; this surface only has to carry its lines. */
    answer: async (_body, emit) => {
      emit({ event: "meta", data: { ordinal: 1 } });
      emit({ event: "final", data: { kind: "answer" } });
    },
    host: "127.0.0.1",
    port: 0,
    log: (line) => lines.push(line),
  };
  return { workers: await startWorkers(options), db, rows, spans, lines, failKeyCount };
}

async function call(url: string, path: string, body: unknown = undefined, headers: Readonly<Record<string, string>> = { authorization: `Bearer ${TOKEN}` }): Promise<{ readonly status: number; readonly json: Record<string, unknown>; readonly headers: Headers }> {
  const method = body === undefined ? "GET" : "POST";
  const response = await fetch(`${url}${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }), traceparent: traceparent(TRACE, "1".repeat(16)) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, unknown>, headers: response.headers };
}

describe("the workers' surface against the stub gateway", () => {
  let stub: RunningStub;
  let surface: Surface;
  const url = (): string => surface.workers.url;

  beforeAll(async () => {
    stub = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: () => undefined, now: () => NOW });
    surface = await startSurface(stub.url);
  });
  afterAll(async () => {
    await surface.workers.close();
    await stub.close();
  });

  it("refuses every request without the bearer, with a wrong one, or with a key in another header (401)", async () => {
    const attempts: ReadonlyArray<Readonly<Record<string, string>>> = [{}, { authorization: "Bearer not-the-token" }, { authorization: `Bearer ${TOKEN}x` }, { "x-api-key": TOKEN }];
    for (const headers of attempts) {
      const res = await call(url(), "/health", undefined, headers);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ code: "WORKERS_UNAUTHORISED", message: expect.stringContaining("bearer"), traceId: TRACE });
      expect(parseTraceparent(res.headers.get("traceparent"))?.traceId).toBe(TRACE);
    }
    expect(await call(url(), "/keys/ensure", { principal: ORG }, {})).toMatchObject({ status: 401 });
    expect(surface.db.rows.size).toBe(0);
  });

  it("answers /health with the gateway up and the key count, on the incoming trace id", async () => {
    const res = await call(url(), "/health");
    expect(res.status).toBe(200);
    /* No engine probe was given to this surface, so the workflow engine reads `off` (feature-specs/28 § 4.5). */
    expect(res.json).toEqual({ ok: true, gateway: "up", keys: 0, temporal: "off" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(surface.lines[surface.lines.length - 1]).toMatchObject({ traceId: TRACE, method: "GET", path: "/health", status: 200, subject: null });
  });

  it("mints on /keys/ensure and returns the same id the second time; /health then counts the key", async () => {
    const first = await call(url(), "/keys/ensure", { principal: ORG });
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ litellmKeyId: expect.stringMatching(/^[0-9a-f]{64}$/), createdAt: NOW.toISOString() });
    const second = await call(url(), "/keys/ensure", { principal: ORG });
    expect(second.json).toEqual(first.json);
    expect((await call(url(), "/health")).json).toMatchObject({ keys: 1 });
  });

  it("rotates on /keys/rotate: a new id and rotatedAt; a principal without a key is minted with rotatedAt null", async () => {
    const before = surface.db.rows.get(JSON.stringify(ORG))?.litellmKeyId;
    const rotated = await call(url(), "/keys/rotate", { principal: ORG });
    expect(rotated.status).toBe(200);
    expect(rotated.json).toEqual({ litellmKeyId: expect.stringMatching(/^[0-9a-f]{64}$/), rotatedAt: NOW.toISOString() });
    expect(rotated.json.litellmKeyId).not.toBe(before);
    const minted = await call(url(), "/keys/rotate", { principal: TINY });
    expect(minted.json).toMatchObject({ rotatedAt: null });
    expect(surface.db.rows.size).toBe(2);
  });

  it("runs the smoke test on /gateway/check: the pinned id, the usage block, one ledger row and one span", async () => {
    const rows = surface.rows.length;
    const res = await call(url(), "/gateway/check", { principal: ORG });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ model: "claude-haiku-4-5", usage: { input_tokens: 4, output_tokens: expect.any(Number), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    expect(surface.rows).toHaveLength(rows + 1);
    expect(surface.rows[rows]).toMatchObject({ principal: ORG, kind: "ASSISTANT", alias: "hb-small", modelId: "claude-haiku-4-5", outcome: "ok" });
    expect(surface.spans[surface.spans.length - 1]["hb.principal"]).toBe("org:org-1");
  });

  it("embeds one query on /embed/query: a vector of the column's width, the reported id, one EMBED row on the principal (spec 12 § 4.3)", async () => {
    const rows = surface.rows.length;
    const res = await call(url(), "/embed/query", { principal: ORG, text: "idempotency keys" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ modelId: EMBED_MODEL_ID, ms: expect.any(Number) });
    expect(res.json.embedding).toEqual(stubEmbedding("idempotency keys"));
    expect(surface.rows).toHaveLength(rows + 1);
    expect(surface.rows[rows]).toMatchObject({ principal: ORG, kind: "EMBED", alias: "hb-embed", outcome: "ok", ref: null });
    expect(surface.spans[surface.spans.length - 1]).toMatchObject({ "hb.purpose": "embed", "hb.principal": "org:org-1", trace_id: TRACE });
    expect(await call(url(), "/embed/query", { principal: ORG, text: "" })).toMatchObject({ status: 400, json: { code: "INVALID_INPUT" } });
    expect(await call(url(), "/embed/query", { principal: ORG, text: "x".repeat(801) })).toMatchObject({ status: 400, json: { code: "INVALID_INPUT" } });
    expect(await call(url(), "/embed/query", { principal: USER, text: "idempotency" })).toMatchObject({ status: 503, json: { code: "GATEWAY_UNAVAILABLE" } });
  });

  it("answers the gateway's budget refusal as 402 GATEWAY_BUDGET, with a row of outcome budget", async () => {
    expect((await call(url(), "/gateway/check", { principal: TINY })).status).toBe(200);
    const res = await call(url(), "/gateway/check", { principal: TINY });
    expect(res.status).toBe(402);
    expect(res.json).toMatchObject({ code: "GATEWAY_BUDGET", message: expect.stringContaining("Budget has been exceeded"), traceId: TRACE });
    expect(surface.rows[surface.rows.length - 1]).toMatchObject({ principal: TINY, outcome: "budget" });
  });

  it("refuses an unknown principal (404), an individual account while D5 is unset (503), a malformed body and a foreign field (400)", async () => {
    expect(await call(url(), "/keys/ensure", { principal: { organisationId: "org-9" } })).toMatchObject({ status: 404, json: { code: "PRINCIPAL_UNKNOWN" } });
    expect(await call(url(), "/keys/ensure", { principal: USER })).toMatchObject({ status: 503, json: { code: "GATEWAY_INDIVIDUAL_CAP_UNSET" } });
    expect(await call(url(), "/gateway/check", { principal: USER })).toMatchObject({ status: 503, json: { code: "GATEWAY_UNAVAILABLE", message: expect.stringContaining("no gateway key") } });
    expect(await call(url(), "/keys/ensure", { principal: { organisationId: "org-1", userId: "u-1" } })).toMatchObject({ status: 400, json: { code: "INVALID_INPUT" } });
    expect(await call(url(), "/keys/ensure", { principal: ORG, token: "x" })).toMatchObject({ status: 400, json: { code: "INVALID_INPUT", message: expect.stringContaining("token") } });
    expect(await call(url(), "/keys/ensure", "{not json")).toMatchObject({ status: 400, json: { code: "INVALID_INPUT", message: "body: not JSON" } });
    expect(await call(url(), "/keys/ensure", {})).toMatchObject({ status: 400, json: { code: "INVALID_INPUT", message: expect.stringContaining("principal") } });
  });

  it("knows no other route or method (404) and answers a failure of its own as a 500 that names nothing", async () => {
    /* `/answer` is a route now (unit 29c); a body it cannot read is still a 400, not a stream. */
    expect(await call(url(), "/answer", { principal: ORG })).toMatchObject({ status: 400, json: { code: "INVALID_INPUT" } });
    expect(await call(url(), "/nothing", { principal: ORG })).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
    expect(await call(url(), "/health", { principal: ORG })).toMatchObject({ status: 404, json: { code: "NOT_FOUND", message: "POST /health is not a route of the workers" } });
    expect(await call(url(), "/keys/ensure")).toMatchObject({ status: 404 });
    surface.failKeyCount.value = true;
    try {
      expect(await call(url(), "/health")).toMatchObject({ status: 500, json: { code: "INTERNAL", message: "the request did not complete", traceId: TRACE } });
    } finally {
      surface.failKeyCount.value = false;
    }
    expect(surface.lines[surface.lines.length - 1]).toMatchObject({ status: 500, code: "INTERNAL" });
  });

  it("logs method, path, status and code, never a key", () => {
    const keys = [...surface.db.rows.values()].map((row) => row.keyCiphertext);
    const text = JSON.stringify(surface.lines);
    expect(text).not.toContain("sk-");
    for (const ciphertext of keys) expect(text).not.toContain(ciphertext);
    expect(surface.lines.every((line) => typeof line.ms === "number" && line.spanId.length === 16)).toBe(true);
  });

  describe("the web tier's client against it (§ 12.5)", () => {
    const deps = (overrides: Partial<WorkersClientDeps> = {}): WorkersClientDeps => ({ baseUrl: url(), token: TOKEN, fetch: globalThis.fetch, timeouts: ROUTE_TIMEOUT_MS, ...overrides });

    it("reads health and ensures a key through workersFetch, typed", async () => {
      expect(await workersFetch("/health", null, { traceId: TRACE }, deps())).toEqual({ ok: true, gateway: "up", keys: 2, temporal: "off" });
      const ensured = await workersFetch("/keys/ensure", { principal: ORG }, { traceId: TRACE }, deps());
      expect(ensured.litellmKeyId).toBe(surface.db.rows.get(JSON.stringify(ORG))?.litellmKeyId);
      const check = await workersFetch("/gateway/check", { principal: ORG }, { traceId: TRACE }, deps());
      expect(check.model).toBe("claude-haiku-4-5");
      const embedded = await workersFetch("/embed/query", { principal: ORG, text: "idempotency keys" }, { traceId: TRACE }, deps());
      expect(embedded.embedding).toHaveLength(1024);
      expect(embedded.modelId).toBe(EMBED_MODEL_ID);
      expect(ROUTE_TIMEOUT_MS["/embed/query"]).toBe(150);
    });

    it("raises the workers' refusals typed: the bearer, the budget, the unknown principal", async () => {
      await expect(workersFetch("/health", null, { traceId: TRACE }, deps({ token: "wrong" }))).rejects.toMatchObject({ status: 401, code: "WORKERS_UNAUTHORISED" });
      const budget = await workersFetch("/gateway/check", { principal: TINY }, { traceId: TRACE }, deps()).catch((e: unknown) => e);
      expect(budget).toBeInstanceOf(WorkersRefusedError);
      expect(budget).toMatchObject({ status: 402, code: "GATEWAY_BUDGET" });
      await expect(workersFetch("/keys/ensure", { principal: { organisationId: "org-9" } }, { traceId: TRACE }, deps())).rejects.toMatchObject({ status: 404, code: "PRINCIPAL_UNKNOWN" });
    });

    it("raises WorkersUnavailableError when the workers are stopped", async () => {
      const other = await startSurface(stub.url);
      const otherUrl = other.workers.url;
      await other.workers.close();
      const error = await workersFetch("/health", null, { traceId: TRACE }, deps({ baseUrl: otherUrl })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WorkersUnavailableError);
      expect((error as WorkersUnavailableError).cause).toBe("connection");
    });

    /*
     * A hung workers process, not a stopped one: the connection is accepted and no answer ever comes. Without a
     * deadline on the row the web request would wait for undici's 300 s header timeout; with Andre's 5 s for
     * `/health` the error arrives inside the row's own deadline, which is what § 12.5 asks for.
     */
    it("raises WorkersUnavailableError with a timeout cause inside the route's deadline when the workers never answer (§ 12.5)", async () => {
      const sockets: Array<{ destroy: () => void }> = [];
      const hung: Server = createServer((request) => {
        sockets.push(request.socket);
      });
      await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
      const address = hung.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const deadline = ROUTE_TIMEOUT_MS["/health"];
      expect(deadline).toBe(5_000);
      const started = Date.now();
      try {
        const error = await workersFetch("/health", null, { traceId: TRACE }, deps({ baseUrl: `http://127.0.0.1:${port}` })).catch((e: unknown) => e);
        const elapsed = Date.now() - started;
        expect(error).toBeInstanceOf(WorkersUnavailableError);
        expect((error as WorkersUnavailableError).cause).toBe("timeout");
        expect(elapsed).toBeLessThan((deadline ?? 0) + 2_000);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => hung.close((error) => (error === undefined ? resolve() : reject(error))));
      }
    }, 20_000);

    /*
     * The other half of the same deadline: a healthy workers process behind a hung *gateway*. `gateway: "down"`
     * is the one thing `/health` exists to report, so it must arrive inside the route's own row — which it does
     * only while the probe's deadline is strictly shorter than the row's (`workers/health.ts`). With both at 5 s
     * this timed out instead (review of unit 37, 2026-09-24).
     */
    it("answers gateway: down through the client inside /health's deadline when the gateway hangs (§ 12.5)", async () => {
      const sockets: Array<{ destroy: () => void }> = [];
      const hungGateway: Server = createServer((request) => {
        sockets.push(request.socket);
      });
      await new Promise<void>((resolve) => hungGateway.listen(0, "127.0.0.1", resolve));
      const address = hungGateway.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const behind = await startSurface(`http://127.0.0.1:${port}`);
      const deadline = ROUTE_TIMEOUT_MS["/health"] ?? 0;
      const started = Date.now();
      try {
        const answer = await workersFetch("/health", null, { traceId: TRACE }, deps({ baseUrl: behind.workers.url }));
        const elapsed = Date.now() - started;
        expect(answer).toEqual({ ok: true, gateway: "down", keys: 0, temporal: "off" });
        expect(elapsed).toBeLessThan(deadline);
      } finally {
        await behind.workers.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => hungGateway.close((error) => (error === undefined ? resolve() : reject(error))));
      }
    }, 20_000);
  });
});

describe("the workers with the gateway down (§ 7.3)", () => {
  it("says down on /health and refuses a mint and a check as 503, never a silent unbudgeted call", async () => {
    const gone = await startStub({ masterKey: MASTER_KEY, aliases: ALIASES, port: 0, log: () => undefined });
    const goneUrl = gone.url;
    await gone.close();
    const surface = await startSurface(goneUrl);
    try {
      expect(await call(surface.workers.url, "/health")).toMatchObject({ status: 200, json: { ok: true, gateway: "down", keys: 0 } });
      expect(await call(surface.workers.url, "/keys/ensure", { principal: ORG })).toMatchObject({ status: 503, json: { code: "GATEWAY_UNAVAILABLE" } });
      expect(surface.db.rows.size).toBe(0);
      surface.db.rows.set(JSON.stringify(ORG), { id: "row-1", litellmKeyId: "f".repeat(64), keyCiphertext: encryptKey(SECRET, "sk-0123456789abcdef0123456789abcdef"), maxBudgetUsd: "5", tokensPerMinute: 1000, createdAt: NOW, rotatedAt: null }); // gitleaks:allow: a made-up virtual key
      expect(await call(surface.workers.url, "/gateway/check", { principal: ORG })).toMatchObject({ status: 503, json: { code: "GATEWAY_UNAVAILABLE" } });
    } finally {
      await surface.workers.close();
    }
  });

  it("says down without GATEWAY_URL", async () => {
    const surface = await startSurface(undefined);
    try {
      expect(await call(surface.workers.url, "/health")).toMatchObject({ status: 200, json: { gateway: "down" } });
      expect(await call(surface.workers.url, "/keys/ensure", { principal: ORG })).toMatchObject({ status: 503, json: { code: "GATEWAY_UNAVAILABLE", message: expect.stringContaining("GATEWAY_URL") } });
    } finally {
      await surface.workers.close();
    }
  });
});

describe("the liveliness probe", () => {
  it("is up on a 200, down on any other status, a connection failure or no gateway", async () => {
    const answer = (status: number): typeof fetch => async () => new Response('"I\'m alive!"', { status });
    expect(await probeGateway({ gatewayUrl: "http://gateway.test", fetch: answer(200), now: () => NOW })).toBe("up");
    expect(await probeGateway({ gatewayUrl: "http://gateway.test", fetch: answer(503), now: () => NOW })).toBe("down");
    const refused: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await probeGateway({ gatewayUrl: "http://gateway.test", fetch: refused, now: () => NOW })).toBe("down");
    expect(await probeGateway({ gatewayUrl: undefined, fetch: answer(200), now: () => NOW })).toBe("down");
  });

  it("caches the state for 30 s, shares one probe in flight, and re-probes afterwards", async () => {
    let clock = NOW.getTime();
    let status = 200;
    const urls: string[] = [];
    const probe = gatewayProbe({
      gatewayUrl: "http://gateway.test",
      fetch: async (input) => {
        urls.push(String(input));
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response("", { status });
      },
      now: () => new Date(clock),
    });
    expect(await Promise.all([probe(), probe()])).toEqual(["up", "up"]);
    expect(urls).toEqual(["http://gateway.test/health/liveliness"]);
    status = 500;
    clock += PROBE_REFRESH_MS - 1;
    expect(await probe()).toBe("up");
    expect(urls).toHaveLength(1);
    clock += 1;
    expect(await probe()).toBe("down");
    expect(urls).toHaveLength(2);
  });

  it("carries a deadline, so a gateway that accepts the connection and never answers reads as down and the cache keeps refreshing", async () => {
    let clock = NOW.getTime();
    let hang = true;
    let attempts = 0;
    /** A gateway that holds the connection open: it answers only when the probe's own signal aborts. */
    const hanging: typeof fetch = async (_input, init) => {
      attempts += 1;
      if (!hang) return new Response("", { status: 200 });
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
      });
    };
    const probe = gatewayProbe({ gatewayUrl: "http://gateway.test", fetch: hanging, now: () => new Date(clock), deadlineMs: 20 });
    expect(await probe()).toBe("down");
    expect(attempts).toBe(1);
    hang = false;
    clock += PROBE_REFRESH_MS;
    expect(await probe()).toBe("up");
    expect(attempts).toBe(2);
  });

  /*
   * The probe's deadline is not a number of its own: it must stay strictly inside the `/health` row's deadline,
   * because the handler awaits the probe and the client aborts at the row. `workers/health.ts` cannot import the
   * row (the workers do not depend on the web tier's side of the channel), so the relation lives here.
   */
  it("keeps the probe's deadline strictly inside /health's own row, with a margin for the hop back", () => {
    const route = ROUTE_TIMEOUT_MS["/health"];
    expect(route).toBe(5_000);
    expect(PROBE_DEADLINE_MS).toBeLessThan(route ?? 0);
    expect((route ?? 0) - PROBE_DEADLINE_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("sends a deadline with every probe when the caller names none", async () => {
    let signal: AbortSignal | null = null;
    const watching: typeof fetch = async (_input, init) => {
      signal = init?.signal ?? null;
      return new Response("", { status: 200 });
    };
    expect(await probeGateway({ gatewayUrl: "http://gateway.test", fetch: watching, now: () => NOW })).toBe("up");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as unknown as AbortSignal).aborted).toBe(false);
  });
});

describe("the surface's pure parts", () => {
  it("compares the bearer in constant time and by whole value", () => {
    expect(bearerMatches(TOKEN, TOKEN)).toBe(true);
    expect(bearerMatches(null, TOKEN)).toBe(false);
    expect(bearerMatches("", TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(bearerMatches(`${TOKEN}x`, TOKEN)).toBe(false);
  });

  it("maps a catalogued error to its status with its message, and anything else to a silent 500", () => {
    expect(refusalOf(new BudgetExceededError(NOW, "Budget has been exceeded"))).toEqual({ status: 402, code: "GATEWAY_BUDGET", message: "Budget has been exceeded" });
    expect(refusalOf(new AppError("GATEWAY_KEYS_UNAVAILABLE", "no secret"))).toMatchObject({ status: 503 });
    expect(refusalOf(new AppError("GATEWAY_REFUSED", "401 from the gateway"))).toMatchObject({ status: 500, code: "GATEWAY_REFUSED" });
    expect(refusalOf(new AppError("SOMETHING_ELSE", "the secret is abc"))).toEqual({ status: 500, code: "INTERNAL", message: "the request did not complete" });
    expect(refusalOf(new Error("boom"))).toEqual({ status: 500, code: "INTERNAL", message: "the request did not complete" });
    expect(refusalOf("boom")).toMatchObject({ status: 500 });
  });
});
