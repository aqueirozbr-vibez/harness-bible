import { describe, expect, it } from "vitest";

import { evidenceEndpoints, type EvidenceEndpointDeps } from "@/lib/api/endpoints/evidence";
import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import type { EvidenceRow, SuggestionForUser } from "@/lib/db/improve";
import { EvidenceAddedSchema, EvidenceDeletedSchema, ITEMS_PER_SUGGESTION_MAX } from "@/lib/schemas/evidence";
import { UPLOAD_SIZE_MAX, UploadTicketSchema, type StoredObject } from "@/lib/schemas/storage";
import { WorkflowNotFoundError, WorkflowsUnavailableError } from "@/lib/workflows/client";

/*
 * The evidence endpoints through the pipeline, with the rows, the store, the signer and the engine doubled
 * (feature-specs/32 § 5, § 8). The ticket (unit 49b): the owner of a draft gets a signed PUT for one of the five
 * types, 100 MB, ten minutes, under the item's key. The add (49e): a link, a DOI in any written form, an upload
 * whose key is this suggestion's and whose file arrived; the item created pending with its ordinal and the workflow
 * started under `evidence:<itemId>`, answered 202; a lab run refused by name; the eleventh item refused; a bad DOI,
 * a stranger's upload key and a key nothing arrived under refused by name; the engine down leaving no item behind.
 * The delete: the item removed and a pending one's workflow cancelled, a graded one's not. The rows themselves and
 * the real engine are tests/integration/evidence.test.ts.
 */

const CONTRIBUTOR: SessionUser = { id: "11111111-1111-4111-8111-111111111111", organisationId: null, role: "CONTRIBUTOR", displayName: "A contributor", locale: "en", identityVerified: true, parts: [], sessionId: "s1" };
const READER: SessionUser = { ...CONTRIBUTOR, id: "22222222-2222-4222-8222-222222222222", role: "READER" };
const OTHER: SessionUser = { ...CONTRIBUTOR, id: "33333333-3333-4333-8333-333333333333" };
const CURATOR_OF_P2: SessionUser = { ...CONTRIBUTOR, id: "44444444-4444-4444-8444-444444444444", role: "CURATOR", parts: ["P2"] };
const ITEM_ID = "4f1c9a2e-0000-4000-8000-000000000000";
const GRADED_ID = "4f1c9a2e-0000-4000-8000-000000000001";
const PENDING_ID = "4f1c9a2e-0000-4000-8000-000000000002";
const KEY = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

function itemOf(id: string, state: EvidenceRow["state"], ordinal: number): EvidenceRow {
  return { id, ordinal, kind: "LINK", state, url: "https://provider-two.example/pricing", doi: null, storageKey: null, fileName: null, labRunId: null, title: null, host: "provider-two.example", publishedOn: null, ageDays: null, fetchStatus: null, contentSha256: null, textKey: null, tier: null, baseScore: null, relevance: null, recency: null, independence: null, adjustedScore: null, reason: null, gradedBy: null, gradedAt: null } as unknown as EvidenceRow;
}

function rowOf(id: string, state: SuggestionForUser["state"], outcome: SuggestionForUser["outcome"] = null, evidence: ReadonlyArray<EvidenceRow> = []): SuggestionForUser {
  return { id, userId: CONTRIBUTOR.id, state, outcome, parts: ["P2"], changeClass: "TEXT_EDIT", origin: "PERSON", evidence } as unknown as SuggestionForUser;
}

const fake = {
  rows: [] as SuggestionForUser[],
  stored: new Map<string, StoredObject>(),
  added: [] as Array<{ suggestionId: string; input: unknown }>,
  removed: [] as string[],
  started: [] as string[],
  cancelled: [] as string[],
  objectsRemoved: [] as string[],
  startFails: null as Error | null,
  cancelFails: null as Error | null,
  signed: [] as Array<{ key: string; contentType: string; maxBytes: number }>,
};

function reset(): void {
  fake.rows = [rowOf("S-21-0001", "DRAFT"), rowOf("S-21-0002", "SUBMITTED"), rowOf("S-21-0003", "INTAKE_DECLINED"), rowOf("S-21-0004", "DECIDED", "REQUEST_MORE"), rowOf("S-21-0005", "DECIDED", "ACCEPT"), rowOf("S-21-0006", "DRAFT", null, [itemOf(GRADED_ID, "GRADED", 1), itemOf(PENDING_ID, "PENDING", 2)]), rowOf("S-21-0010", "DRAFT", null, Array.from({ length: ITEMS_PER_SUGGESTION_MAX }, (_, index) => itemOf(`4f1c9a2e-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`, "GRADED", index + 1)))];
  fake.stored = new Map([[`evidence/S-21-0001/${ITEM_ID}/source`, { key: `evidence/S-21-0001/${ITEM_ID}/source`, contentType: "application/pdf", bytes: 12, sha256: "a".repeat(64), storedAt: "2026-10-06T12:00:00.000Z" }], [`evidence/S-21-0001/${GRADED_ID}/source`, { key: `evidence/S-21-0001/${GRADED_ID}/source`, contentType: "text/html", bytes: 12, sha256: "b".repeat(64), storedAt: "2026-10-06T12:00:00.000Z" }]]);
  fake.added = [];
  fake.removed = [];
  fake.started = [];
  fake.cancelled = [];
  fake.objectsRemoved = [];
  fake.startFails = null;
  fake.cancelFails = null;
  fake.signed = [];
}

const deps: EvidenceEndpointDeps = {
  read: async (user, id) => {
    const row = fake.rows.find((entry) => entry.id === id);
    if (row === undefined) return null;
    if (row.userId === user.id) return row;
    return user.role === "CURATOR" && row.state !== "DRAFT" ? row : null;
  },
  signPut: async (key, grant) => {
    fake.signed.push({ key, ...grant });
    return { url: `http://localhost:3000/api/v1/storage/token-for-${key.split("/")[2] ?? ""}`, expiresAt: new Date("2026-10-06T12:10:00Z") };
  },
  newItemId: () => ITEM_ID,
  stored: async (key) => fake.stored.get(key) ?? null,
  add: async (_user, suggestionId, input) => {
    fake.added.push({ suggestionId, input });
    const row = fake.rows.find((entry) => entry.id === suggestionId);
    if (row === undefined) return { added: false, reason: "not_open" };
    if (row.evidence.length >= ITEMS_PER_SUGGESTION_MAX) return { added: false, reason: "limit" };
    const existing = row.evidence.find((item) => item.id === input.id);
    if (existing !== undefined) return { added: true, item: existing, existed: true };
    const item = { ...itemOf(input.id, "PENDING", row.evidence.length + 1), kind: input.kind, url: input.url, doi: input.doi, storageKey: input.storageKey, host: input.host, fileName: input.fileName ?? null } as EvidenceRow;
    return { added: true, item, existed: false };
  },
  remove: async (_user, _suggestionId, itemId) => {
    fake.removed.push(itemId);
    const row = fake.rows.find((entry) => entry.evidence.some((item) => item.id === itemId));
    const item = row?.evidence.find((entry) => entry.id === itemId);
    return item === undefined ? { removed: false } : { removed: true, state: item.state };
  },
  startGrading: async (itemId) => {
    if (fake.startFails !== null) throw fake.startFails;
    fake.started.push(itemId);
    return { workflowId: `evidence:${itemId}`, runId: "run-1" };
  },
  cancelGrading: async (itemId) => {
    if (fake.cancelFails instanceof WorkflowNotFoundError) return false;
    if (fake.cancelFails !== null) throw fake.cancelFails;
    fake.cancelled.push(itemId);
    return true;
  },
  removeObjects: async (prefix) => {
    fake.objectsRemoved.push(prefix);
    return true;
  },
};

const pipeline = (session: SessionUser | null, allow = true): HandlerDeps => ({
  sessionFromRequest: async () => session,
  authorize: async () => (allow ? { allow: true } : { allow: false, reason: "policy" }),
  consume: async () => ({ allowed: true, limit: 120, remaining: 119, resetS: 60, retryAfterS: 0 }),
  idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
  audit: async () => undefined,
  log: () => undefined,
});

const { evidenceUploadCreate, evidenceAdd, evidenceDelete } = evidenceEndpoints(deps);
const HEADERS = { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.48" };
const ticket = (id: string, body: unknown, session: SessionUser | null = CONTRIBUTOR, allow = true) =>
  handler(evidenceUploadCreate, pipeline(session, allow))(new Request(`http://localhost:3000/api/v1/suggestions/${id}/evidence/uploads`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) }), { params: { id } });
const add = (id: string, body: unknown, session: SessionUser | null = CONTRIBUTOR, allow = true, key: string | null = KEY) =>
  handler(evidenceAdd, pipeline(session, allow))(new Request(`http://localhost:3000/api/v1/suggestions/${id}/evidence`, { method: "POST", headers: { ...HEADERS, ...(key === null ? {} : { "idempotency-key": key }) }, body: JSON.stringify(body) }), { params: { id } });
const remove = (id: string, itemId: string, session: SessionUser | null = CONTRIBUTOR, allow = true) =>
  handler(evidenceDelete, pipeline(session, allow))(new Request(`http://localhost:3000/api/v1/suggestions/${id}/evidence/${itemId}`, { method: "DELETE", headers: HEADERS }), { params: { id, itemId } });

describe("POST /api/v1/suggestions/{id}/evidence/uploads (unit 49b)", () => {
  it("is declared as 32 § 5 has it, and answers the owner of a draft a signed PUT under the item's key", async () => {
    reset();
    expect(evidenceUploadCreate).toMatchObject({ path: "/api/v1/suggestions/{id}/evidence/uploads", method: "POST", auth: "session", role: "CONTRIBUTOR", rateLimit: { key: "user", limit: 120, windowS: 60 }, policy: { action: "write" } });
    const response = await ticket("S-21-0001", { contentType: "application/pdf" });
    expect(response.status).toBe(200);
    /* A PDF's ticket is the provider's limit, under D2 (unit 49f): its base64 alone must fit a 32 MB request. */
    expect(UploadTicketSchema.parse(await response.json())).toEqual({ uploadKey: `evidence/S-21-0001/${ITEM_ID}/source`, url: `http://localhost:3000/api/v1/storage/token-for-${ITEM_ID}`, method: "PUT", headers: { "content-type": "application/pdf" }, maxBytes: 24_000_000, expiresAt: "2026-10-06T12:10:00.000Z" });
    expect(fake.signed).toEqual([{ key: `evidence/S-21-0001/${ITEM_ID}/source`, contentType: "application/pdf", maxBytes: 24_000_000 }]);
  });

  it("grants each type its own limit: D2 for text, the provider's for a PDF and an image (unit 49f, § 9)", async () => {
    reset();
    const granted = async (contentType: string): Promise<number> => UploadTicketSchema.parse(await (await ticket("S-21-0001", { contentType })).json()).maxBytes;
    expect(await granted("text/plain")).toBe(UPLOAD_SIZE_MAX);
    expect(await granted("text/markdown")).toBe(UPLOAD_SIZE_MAX);
    expect(await granted("application/pdf")).toBe(24_000_000);
    expect(await granted("image/png")).toBe(7_500_000);
    expect(await granted("image/jpeg")).toBe(7_500_000);
    expect(fake.signed.map((grant) => grant.maxBytes)).toEqual([UPLOAD_SIZE_MAX, UPLOAD_SIZE_MAX, 24_000_000, 7_500_000, 7_500_000]);
  });

  it("takes the five types and no other; a revisable suggestion yes, one past draft 409; a stranger 404, a reader 403, a curator the policy's 403", async () => {
    reset();
    for (const contentType of ["text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg"]) expect((await ticket("S-21-0001", { contentType })).status, contentType).toBe(200);
    for (const contentType of ["text/html", "application/zip", ""]) expect((await ticket("S-21-0001", { contentType })).status, contentType).toBe(400);
    expect((await ticket("S-21-0003", { contentType: "image/png" })).status).toBe(200);
    expect((await ticket("S-21-0004", { contentType: "image/png" })).status).toBe(200);
    expect((await ticket("S-21-0002", { contentType: "image/png" })).status).toBe(409);
    expect((await ticket("S-21-0005", { contentType: "image/png" })).status).toBe(409);
    expect((await ticket("S-21-0001", { contentType: "image/png" }, OTHER)).status).toBe(404);
    expect((await ticket("S-21-0001", { contentType: "image/png" }, READER)).status).toBe(403);
    expect((await ticket("S-21-0002", { contentType: "image/png" }, CURATOR_OF_P2, false)).status).toBe(403);
    expect((await ticket("S-21-0001", { contentType: "image/png" }, null)).status).toBe(401);
  });
});

describe("POST /api/v1/suggestions/{id}/evidence (unit 49e)", () => {
  it("is declared as 32 § 8 has it: the owner's write, idempotent, the suggestion's rate", () => {
    expect(evidenceAdd).toMatchObject({ path: "/api/v1/suggestions/{id}/evidence", method: "POST", auth: "session", role: "CONTRIBUTOR", rateLimit: { key: "user", limit: 120, windowS: 60 }, idempotent: true, policy: { action: "write" } });
  });

  it("creates a link pending with its ordinal, starts the workflow under evidence:<itemId>, and answers 202 with the item", async () => {
    reset();
    const response = await add("S-21-0001", { kind: "LINK", url: "https://Provider-Two.example/pricing?plan=team" });
    expect(response.status, await response.clone().text()).toBe(202);
    const body = EvidenceAddedSchema.parse(await response.json());
    expect(body).toMatchObject({ suggestionId: "S-21-0001", stage: "1 of 3", item: { ordinal: 1, kind: "LINK", state: "PENDING", url: "https://Provider-Two.example/pricing?plan=team", host: "provider-two.example", doi: null, tier: null } });
    expect(body.workflowId).toBe(`evidence:${body.item.id}`);
    expect(fake.started).toEqual([body.item.id]);
    expect(fake.added).toHaveLength(1);
  });

  it("takes a DOI in any written form and stores its bare lowercase form; refuses what is not a DOI by name", async () => {
    reset();
    const response = await add("S-21-0001", { kind: "DOI", doi: "https://doi.org/10.1038/171737A0" });
    expect(response.status).toBe(202);
    expect(EvidenceAddedSchema.parse(await response.json()).item).toMatchObject({ kind: "DOI", doi: "10.1038/171737a0", url: null, host: null });
    const bad = await add("S-21-0001", { kind: "DOI", doi: "not-a-doi-at-all" });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: "DOI_INVALID" });
    expect(fake.started).toHaveLength(1);
  });

  it("takes an upload whose key is this suggestion's and whose file arrived, under the ticket's item id; refuses another suggestion's key, a key nothing arrived under, and a file of a type a person may not upload", async () => {
    reset();
    const response = await add("S-21-0001", { kind: "UPLOAD", uploadKey: `evidence/S-21-0001/${ITEM_ID}/source`, fileName: "  pricing-page.pdf " });
    expect(response.status, await response.clone().text()).toBe(202);
    expect(EvidenceAddedSchema.parse(await response.json()).item).toMatchObject({ id: ITEM_ID, kind: "UPLOAD", url: null, doi: null, fileName: "pricing-page.pdf" });
    expect(fake.added.at(-1)?.input).toMatchObject({ kind: "UPLOAD", fileName: "pricing-page.pdf" });
    expect(fake.started).toEqual([ITEM_ID]);

    const foreign = await add("S-21-0001", { kind: "UPLOAD", uploadKey: `evidence/S-21-0002/${ITEM_ID}/source` });
    expect(foreign.status).toBe(422);
    expect(await foreign.json()).toMatchObject({ code: "UPLOAD_KEY_INVALID" });
    const missing = await add("S-21-0001", { kind: "UPLOAD", uploadKey: `evidence/S-21-0001/${PENDING_ID}/source` });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ code: "UPLOAD_NOT_FOUND" });
    const html = await add("S-21-0001", { kind: "UPLOAD", uploadKey: `evidence/S-21-0001/${GRADED_ID}/source` });
    expect(html.status).toBe(422);
    expect(await html.json()).toMatchObject({ code: "UPLOAD_KEY_INVALID" });
    expect((await add("S-21-0001", { kind: "UPLOAD", uploadKey: "audit/x.jsonl" })).status).toBe(422);
    expect(fake.started).toHaveLength(1);
  });

  it("refuses a lab run by name, the eleventh item, a body of another shape, an http link, and a missing idempotency key", async () => {
    reset();
    const lab = await add("S-21-0001", { kind: "LAB_RUN", labRunId: "run-1" });
    expect(lab.status).toBe(422);
    expect(await lab.json()).toMatchObject({ code: "EVIDENCE_KIND_NOT_YET" });
    const full = await add("S-21-0010", { kind: "LINK", url: "https://provider-two.example/x" });
    expect(full.status).toBe(422);
    expect(await full.json()).toMatchObject({ code: "EVIDENCE_LIMIT", detail: { max: 10 } });
    expect((await add("S-21-0001", { kind: "LINK", url: "http://provider-two.example/x" })).status).toBe(400);
    expect((await add("S-21-0001", { kind: "LINK", url: "https://provider-two.example/x", doi: "10.1000/1" })).status).toBe(400);
    expect((await add("S-21-0001", { kind: "VIDEO", url: "https://provider-two.example/x" })).status).toBe(400);
    expect((await add("S-21-0001", { kind: "LINK", url: "https://provider-two.example/x" }, CONTRIBUTOR, true, null)).status).toBe(400);
    expect(fake.started).toEqual([]);
    expect(fake.added).toEqual([]);
  });

  it("answers 409 past draft, 404 to a stranger, 403 to a reader; and when the engine is down removes the item it created and answers 503", async () => {
    reset();
    expect((await add("S-21-0002", { kind: "LINK", url: "https://provider-two.example/x" })).status).toBe(409);
    expect((await add("S-21-0003", { kind: "LINK", url: "https://provider-two.example/x" })).status).toBe(202);
    expect((await add("S-21-0001", { kind: "LINK", url: "https://provider-two.example/x" }, OTHER)).status).toBe(404);
    expect((await add("S-21-0001", { kind: "LINK", url: "https://provider-two.example/x" }, READER)).status).toBe(403);
    fake.startFails = new WorkflowsUnavailableError("connection", "no engine");
    const down = await add("S-21-0001", { kind: "LINK", url: "https://provider-two.example/x" });
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ code: "WORKFLOWS_UNAVAILABLE" });
    expect(fake.removed).toHaveLength(1);
  });
});

describe("DELETE /api/v1/suggestions/{id}/evidence/{itemId} (unit 49e)", () => {
  it("removes a pending item and cancels its grading; removes a graded one and cancels nothing", async () => {
    reset();
    const pending = await remove("S-21-0006", PENDING_ID);
    expect(pending.status, await pending.clone().text()).toBe(200);
    expect(EvidenceDeletedSchema.parse(await pending.json())).toEqual({ suggestionId: "S-21-0006", itemId: PENDING_ID, removed: true, cancelled: true });
    const graded = await remove("S-21-0006", GRADED_ID);
    expect(EvidenceDeletedSchema.parse(await graded.json())).toEqual({ suggestionId: "S-21-0006", itemId: GRADED_ID, removed: true, cancelled: false });
    expect(fake.cancelled).toEqual([PENDING_ID]);
    expect(fake.removed).toEqual([PENDING_ID, GRADED_ID]);
    /* an item that leaves a draft takes what it stored (45 § 4) */
    expect(fake.objectsRemoved).toEqual([`evidence/S-21-0006/${PENDING_ID}`, `evidence/S-21-0006/${GRADED_ID}`]);
  });

  it("keeps what an item stored when it leaves a suggestion under revision, whose earlier records name it (45 § 4)", async () => {
    reset();
    fake.rows = fake.rows.map((row) => (row.id === "S-21-0004" ? rowOf("S-21-0004", "DECIDED", "REQUEST_MORE", [itemOf(GRADED_ID, "GRADED", 1)]) : row));
    const removed = await remove("S-21-0004", GRADED_ID);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(fake.removed).toEqual([GRADED_ID]);
    expect(fake.objectsRemoved).toEqual([]);
  });

  it("says cancelled: false when the run had already ended, and answers 404 for an item that is not there, 409 past draft, 404 to a stranger", async () => {
    reset();
    fake.cancelFails = new WorkflowNotFoundError(`evidence:${PENDING_ID}`);
    expect(EvidenceDeletedSchema.parse(await (await remove("S-21-0006", PENDING_ID)).json()).cancelled).toBe(false);
    expect((await remove("S-21-0006", "4f1c9a2e-0000-4000-8000-00000000ffff")).status).toBe(404);
    expect((await remove("S-21-0006", "not-a-uuid")).status).toBe(400);
    expect((await remove("S-21-0002", GRADED_ID)).status).toBe(409);
    expect((await remove("S-21-0006", GRADED_ID, OTHER)).status).toBe(404);
  });

  it("takes what a draft's item stored even when the engine does not answer the cancel: the 503 stays, the objects go (review of unit 63)", async () => {
    reset();
    fake.cancelFails = new WorkflowsUnavailableError("connection", "no engine");
    const removed = await remove("S-21-0006", PENDING_ID);
    expect(removed.status).toBe(503);
    expect(fake.removed).toEqual([PENDING_ID]);
    expect(fake.objectsRemoved).toEqual([`evidence/S-21-0006/${PENDING_ID}`]);
  });
});
