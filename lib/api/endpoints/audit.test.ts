import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import type { AuditExportRow } from "@/lib/db/auditExport";
import type { AuditExportRequest } from "@/lib/schemas/audit";

import { auditEndpoints, auditResourceOf, type AuditEndpointDeps } from "./audit";

/*
 * The audit export's endpoints (feature-specs/38 § 3; unit 55b), the rows, the estimate and the engine doubled: a pack
 * is asked for with an idempotency key, four a day, refused when its scope selects nothing; it is read by its requester
 * with a signed URL once ready; the estimate is a count. The policy's resource names the owner, the organisation or
 * the chapter, and nothing a rule allows for an account that is neither the caller's nor their organisation's.
 */

const ME: SessionUser = { id: "11111111-1111-4111-8111-111111111111", organisationId: null, role: "READER", displayName: "Me", locale: "en", identityVerified: false, parts: [], sessionId: "s1" };
const MEMBER: SessionUser = { ...ME, id: "22222222-2222-4222-8222-222222222222", organisationId: "33333333-3333-4333-8333-333333333333", role: "CONTRIBUTOR" };
const NOW = new Date("2026-10-10T12:00:00.000Z");
const REQUEST: AuditExportRequest = { scope: { kind: "account", id: ME.id }, from: "2026-09-01T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z", kinds: ["adjudications", "merges"] };
const KEY = "44444444-4444-4444-8444-444444444444";

function row(over: Partial<AuditExportRow> = {}): AuditExportRow {
  return { id: "55555555-5555-4555-8555-555555555555", requestedById: ME.id, request: { scope: REQUEST.scope, from: REQUEST.from, to: REQUEST.to, kinds: REQUEST.kinds }, fromSeq: null, toSeq: null, records: 12, headHash: null, storageKey: null, state: "PREPARING", createdAt: NOW, readyAt: null, ...over };
}

function harness(over: Partial<AuditEndpointDeps> = {}) {
  const started: string[] = [];
  const removed: string[] = [];
  const created: Array<{ userId: string; request: AuditExportRequest; estimate: number; limit: number }> = [];
  let today = 0;
  const deps: AuditEndpointDeps = {
    estimate: async (request) => (request.scope.kind === "chapter" && request.scope.id === "99" ? 0 : 12),
    create: async (userId, request, estimate, _now, limit) => {
      if (today >= limit) return { created: false, spent: today };
      created.push({ userId, request, estimate, limit });
      return { created: true, row: row() };
    },
    start: async (exportId) => {
      started.push(exportId);
    },
    remove: async (exportId) => {
      removed.push(exportId);
    },
    readOwn: async (userId, id) => (userId === ME.id && id === row().id ? row({ state: "READY", fromSeq: 3, toSeq: 40, headHash: "a".repeat(64), storageKey: `audit/${row().id}.jsonl`, readyAt: NOW }) : null),
    url: async (storageKey) => ({ url: `http://localhost:3000/api/v1/storage/token-for-${storageKey.replace(/\W/g, "")}`, expiresAt: new Date(NOW.getTime() + 86_400_000) }),
    now: () => NOW,
    ...over,
  };
  const pipeline = (session: SessionUser | null): HandlerDeps => ({
    sessionFromRequest: async () => session,
    authorize: async () => ({ allow: true }),
    consume: async () => ({ allowed: true, limit: 60, remaining: 59, resetS: 6, retryAfterS: 0 }),
    idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
    audit: async () => undefined,
    log: () => undefined,
  });
  const { auditExportCreate, auditExportRead, auditExportEstimate } = auditEndpoints(deps);
  const create = (session: SessionUser | null, body: unknown = REQUEST): Promise<Response> =>
    handler(auditExportCreate, pipeline(session))(new Request("http://localhost:3000/api/v1/org/audit-exports", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": KEY, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) }), { params: {} });
  const read = (session: SessionUser | null, id: string = row().id): Promise<Response> => handler(auditExportRead, pipeline(session))(new Request(`http://localhost:3000/api/v1/org/audit-exports/${id}`), { params: { id } });
  const estimate = (session: SessionUser | null, query: string): Promise<Response> => handler(auditExportEstimate, pipeline(session))(new Request(`http://localhost:3000/api/v1/org/audit-exports/estimate?${query}`), { params: {} });
  return { create, read, estimate, started, created, removed, spend: (n: number) => (today = n) };
}

describe("the policy's resource for a scope (policies/hb/audit.rego)", () => {
  it("names the owner for the caller's own account, the organisation for the caller's organisation, the chapter for a chapter, and nothing for another account", () => {
    expect(auditResourceOf(ME, { kind: "account", id: ME.id })).toEqual({ kind: "audit-export", id: ME.id, scope: "account", ownerId: ME.id, organisationId: null });
    expect(auditResourceOf(MEMBER, { kind: "account", id: MEMBER.organisationId ?? "" })).toEqual({ kind: "audit-export", id: MEMBER.organisationId, scope: "account", ownerId: null, organisationId: MEMBER.organisationId });
    expect(auditResourceOf(MEMBER, { kind: "chapter", id: "21" })).toEqual({ kind: "audit-export", id: "21", scope: "chapter", ownerId: null, organisationId: MEMBER.organisationId });
    expect(auditResourceOf(MEMBER, { kind: "account", id: ME.id })).toEqual({ kind: "audit-export", id: ME.id, scope: "account", ownerId: null, organisationId: null });
    expect(auditResourceOf(null, { kind: "account", id: ME.id })).toEqual({ kind: "audit-export", id: ME.id, scope: "account", ownerId: null, organisationId: null });
  });
});

describe("POST /api/v1/org/audit-exports (38 § 3)", () => {
  it("is declared with a session, an idempotency key and the export action", () => {
    const { auditExportCreate } = auditEndpoints();
    expect(auditExportCreate).toMatchObject({ path: "/api/v1/org/audit-exports", method: "POST", auth: "session", idempotent: true, rateLimit: { key: "user", limit: 60, windowS: 60 }, policy: { action: "export" } });
  });

  it("makes the row with the estimate and starts its workflow, answering the id and PREPARING", async () => {
    const { create, started, created } = harness();
    const response = await create(ME);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: row().id, state: "PREPARING" });
    expect(created).toEqual([{ userId: ME.id, request: REQUEST, estimate: 12, limit: 4 }]);
    expect(started).toEqual([row().id]);
  });

  it("leaves no row when the engine does not take the workflow: the row is removed, the refusal says no pack was asked for, and the day's four are not spent (unit 55's review)", async () => {
    const { create, created, removed } = harness({
      start: async () => {
        throw new ApiError("WORKFLOWS_UNAVAILABLE", "the engine did not answer");
      },
    });
    const response = await create(ME);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "WORKFLOWS_UNAVAILABLE" });
    expect(created).toHaveLength(1);
    expect(removed).toEqual([row().id]);
  });

  it("refuses a scope that selects nothing before any row is made, and the fifth of a day with the day's end", async () => {
    const { create, started, created, spend } = harness();
    const empty = await create(ME, { ...REQUEST, scope: { kind: "chapter", id: "99" } });
    expect(empty.status).toBe(404);
    expect(await empty.json()).toMatchObject({ code: "NOTHING_TO_EXPORT" });
    spend(4);
    const fifth = await create(ME);
    expect(fifth.status).toBe(429);
    expect(await fifth.json()).toMatchObject({ code: "RATE_LIMITED", detail: { resetsAt: "2026-10-11T00:00:00.000Z", limit: 4 } });
    expect(created).toEqual([]);
    expect(started).toEqual([]);
  });

  it("refuses a body with no kind, a window turned round, or a kind twice, and the signed-out", async () => {
    const { create } = harness();
    expect((await create(ME, { ...REQUEST, kinds: [] })).status).toBe(400);
    expect((await create(ME, { ...REQUEST, from: REQUEST.to, to: REQUEST.from })).status).toBe(400);
    expect((await create(ME, { ...REQUEST, kinds: ["merges", "merges"] })).status).toBe(400);
    expect((await create(null)).status).toBe(401);
  });
});

describe("GET /api/v1/org/audit-exports/{id} (38 § 3)", () => {
  it("answers the requester's own pack with its signed URL once ready, and not found for anyone else's", async () => {
    const { read } = harness();
    const response = await read(ME);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: row().id,
      state: "READY",
      scope: REQUEST.scope,
      from: REQUEST.from,
      to: REQUEST.to,
      kinds: REQUEST.kinds,
      records: 12,
      headHash: "a".repeat(64),
      requestedAt: NOW.toISOString(),
      readyAt: NOW.toISOString(),
      url: `http://localhost:3000/api/v1/storage/token-for-audit${row().id.replace(/-/g, "")}jsonl`,
      urlExpiresAt: "2026-10-11T12:00:00.000Z",
    });
    expect((await read(MEMBER)).status).toBe(404);
    expect((await read(ME, "66666666-6666-4666-8666-666666666666")).status).toBe(404);
    expect((await read(null)).status).toBe(401);
  });

  it("has no URL while preparing, or where nothing can be signed", async () => {
    const preparing = harness({ readOwn: async () => row() });
    expect(await (await preparing.read(ME)).json()).toMatchObject({ state: "PREPARING", url: null, urlExpiresAt: null, headHash: null, records: 12 });
    const unsigned = harness({ url: async () => null });
    expect(await (await unsigned.read(ME)).json()).toMatchObject({ state: "READY", url: null, urlExpiresAt: null });
  });
});

describe("GET /api/v1/org/audit-exports/estimate (38 § 3)", () => {
  it("counts the request's records from its query, and refuses a malformed one", async () => {
    const { estimate } = harness();
    const response = await estimate(ME, `scope=account&id=${ME.id}&from=2026-09-01T00:00:00.000Z&to=2026-10-10T00:00:00.000Z&kinds=adjudications,merges`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ records: 12 });
    expect((await estimate(ME, `scope=chapter&id=99&from=2026-09-01T00:00:00.000Z&to=2026-10-10T00:00:00.000Z&kinds=answers`)).status).toBe(200);
    expect((await estimate(ME, `scope=chapter&id=7&from=2026-09-01T00:00:00.000Z&to=2026-10-10T00:00:00.000Z&kinds=answers`)).status).toBe(400);
    expect((await estimate(ME, `scope=account&id=${ME.id}&from=2026-09-01T00:00:00.000Z&to=2026-10-10T00:00:00.000Z&kinds=everything`)).status).toBe(400);
    expect((await estimate(null, `scope=chapter&id=21&from=2026-09-01T00:00:00.000Z&to=2026-10-10T00:00:00.000Z&kinds=answers`)).status).toBe(401);
  });
});
