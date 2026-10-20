import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import type { SuggestionForUser } from "@/lib/db/improve";
import { AppError } from "@/lib/errors";
import type { AppendInput } from "@/lib/ledger/append";
import type { PolicyResource } from "@/lib/policy/input";
import type { ExportTrailer } from "@/lib/schemas/ledger";

import { recordEndpoints, type RecordEndpointDeps } from "./record";

/*
 * A suggestion's record export (feature-specs/35 § 5; unit 52c, part 2), with the pipeline's own steps and the rows
 * doubled: its audience is the suggestion's read's; the file is the signed JSONL as an attachment; the export appends
 * its `EXPORT` record to the suggestion's own view, with the file's hash; a draft has nothing to export, nor a
 * suggestion with no record yet, and no key means no export, as a conversation's (17 § 6). A read that writes: never
 * from another site, never to a HEAD (the 52c review).
 */

const OWNER: SessionUser = { id: "11111111-1111-4111-8111-111111111111", organisationId: null, role: "CONTRIBUTOR", displayName: "A contributor", locale: "en", identityVerified: true, parts: [], sessionId: "s1" };
const STRANGER: SessionUser = { ...OWNER, id: "22222222-2222-4222-8222-222222222222" };
const ID = "S-21-1254";
const DRAFT = "S-21-1255";
/* A merged suggestion, which is anyone's to read (35 D2; unit 54d). */
const MERGED_ID = "S-21-1256";
const CLOSED_ID = "S-21-0201";
const ASKED_ID = "S-21-0202";
const FILE = Buffer.from('{"seq":1}\n{"trailer":{}}\n');
const TRAILER: ExportTrailer = { headHash: "d".repeat(64), fromSeq: 14647, toSeq: 15394, records: 8, scope: { kind: "suggestion", id: ID, from: null, to: null }, exportedAt: "2026-10-08T22:00:00.000Z", signature: "e".repeat(128) };

function harness(exportFile: RecordEndpointDeps["exportFile"] = async () => ({ file: FILE, trailer: TRAILER }), records = 8) {
  const appended: AppendInput[] = [];
  const deps: RecordEndpointDeps = {
    read: async (user, id) => (id === ID && user.id === OWNER.id ? ({ id: ID, userId: OWNER.id, state: "INTAKE_DECLINED", parts: ["P2"], changeClass: "WORDING", origin: "HUMAN" } as unknown as SuggestionForUser) : id === DRAFT && user.id === OWNER.id ? ({ id: DRAFT, userId: OWNER.id, state: "DRAFT", parts: ["P2"], changeClass: "WORDING", origin: "HUMAN" } as unknown as SuggestionForUser) : null),
    readMerged: async (id) => (id === MERGED_ID ? ({ id: MERGED_ID, userId: STRANGER.id, state: "MERGED", parts: ["P2"], changeClass: "WORDING", origin: "HUMAN" } as unknown as SuggestionForUser) : null),
    /* a researcher's closed proposal, any curator's to read (43 D6); one the stranger asked for, theirs as its asker (43 D7) */
    readClosed: async (user, id) => (id === CLOSED_ID && user.role === "CURATOR" ? ({ id: CLOSED_ID, userId: null, state: "CLOSED", parts: ["P2"], changeClass: "NEW_CLAIM", origin: "RESEARCHER" } as unknown as SuggestionForUser) : null),
    readAsker: async (user, id) => (id === ASKED_ID && user.id === STRANGER.id ? ({ id: ASKED_ID, userId: null, state: "CURATOR_QUEUE", parts: ["P2"], changeClass: "NEW_CLAIM", origin: "RESEARCHER" } as unknown as SuggestionForUser) : null),
    record: async () => ({ rows: [], chain: { ok: true, records: 0, from: 0, to: 0, firstBreak: null, headHash: null } }),
    records: async () => records,
    exportFile,
    appendExport: async (input) => {
      appended.push(input);
    },
  };
  const pipeline = (session: SessionUser | null): HandlerDeps => ({
    sessionFromRequest: async () => session,
    authorize: async () => ({ allow: true }),
    consume: async () => ({ allowed: true, limit: 10, remaining: 9, resetS: 6, retryAfterS: 0 }),
    idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
    audit: async () => undefined,
    log: () => undefined,
  });
  const { suggestionRecord, suggestionRecordExport } = recordEndpoints(deps);
  const resources: PolicyResource[] = [];
  const reading = (session: SessionUser | null): HandlerDeps => ({
    ...pipeline(session),
    authorize: async (_subject, _action, resource) => {
      resources.push(resource);
      return { allow: true };
    },
  });
  const read = (session: SessionUser | null, id = ID): Promise<Response> => handler(suggestionRecord, reading(session))(new Request(`http://localhost:3000/api/v1/suggestions/${id}/record`), { params: { id } });
  /* As the record page's own link asks: the browser says the request is the site's own. */
  const send = (session: SessionUser | null, id: string, init: RequestInit): Promise<Response> => handler(suggestionRecordExport, pipeline(session))(new Request(`http://localhost:3000/api/v1/suggestions/${id}/record/export`, init), { params: Promise.resolve({ id }) });
  const get = (session: SessionUser | null, id = ID): Promise<Response> => send(session, id, { headers: { "sec-fetch-site": "same-origin" } });
  return { get, send, read, appended, resources };
}

describe("GET /api/v1/suggestions/{id}/record (35 § 5, D2)", () => {
  it("is public in its declaration, and the policy decides: the suggestion's own facts, and `merged` only where its own read did not give it", async () => {
    const { suggestionRecord } = recordEndpoints();
    expect(suggestionRecord).toMatchObject({ path: "/api/v1/suggestions/{id}/record", method: "GET", auth: "public", policy: { action: "read" } });
    const { read, resources } = harness();
    expect((await read(OWNER)).status).toBe(200);
    expect(resources.at(-1)).toEqual({ kind: "suggestion", id: ID, ownerId: OWNER.id, parts: ["P2"], changeClass: "WORDING", origin: "HUMAN" });
    expect((await read(OWNER, MERGED_ID)).status).toBe(200);
    expect(resources.at(-1)).toMatchObject({ id: MERGED_ID, merged: true });
  });

  it("reads a researcher's proposal as its asker's — the policy's resource the proposal, its owner the asker (43 D7) — and a closed one as any curator's, `closed` (43 D6; unit 60e)", async () => {
    const { read, resources } = harness();
    expect((await read(STRANGER, ASKED_ID)).status).toBe(200);
    expect(resources.at(-1)).toEqual({ kind: "proposal", id: ASKED_ID, ownerId: STRANGER.id });
    expect((await read({ ...STRANGER, role: "CURATOR" }, CLOSED_ID)).status).toBe(200);
    expect(resources.at(-1)).toMatchObject({ kind: "suggestion", id: CLOSED_ID, origin: "RESEARCHER", closed: true });
    expect((await read(OWNER, ASKED_ID)).status).toBe(404);
  });

  it("answers a merged suggestion's record to anyone, signed out included (unit 54d), and nothing else to a stranger", async () => {
    const { read } = harness();
    expect((await read(null, MERGED_ID)).status).toBe(200);
    expect(await (await read(STRANGER, MERGED_ID)).json()).toMatchObject({ id: MERGED_ID, chain: { ok: true } });
    expect((await read(null)).status).toBe(404);
    expect((await read(STRANGER)).status).toBe(404);
    expect((await read(null, "S-21-9999")).status).toBe(404);
  });
});

describe("GET /api/v1/suggestions/{id}/record/export (35 § 5)", () => {
  it("is declared as the conversation's export: a session, a read of the suggestion, ten a minute", () => {
    const { suggestionRecordExport } = recordEndpoints();
    expect(suggestionRecordExport).toMatchObject({ path: "/api/v1/suggestions/{id}/record/export", method: "GET", auth: "session", rateLimit: { key: "user", limit: 10, windowS: 60 }, writes: true, policy: { action: "read" } });
  });

  it("is refused to another site's page and to a HEAD, and nothing is recorded (the 52c review)", async () => {
    const { send, appended } = harness();
    const crossSite = await send(OWNER, ID, { headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ code: "BAD_ORIGIN" });
    expect((await send(OWNER, ID, {})).status).toBe(403);
    expect((await send(OWNER, ID, { method: "HEAD", headers: { "sec-fetch-site": "same-origin" } })).status).toBe(405);
    expect(appended).toEqual([]);
  });

  it("answers the signed JSONL as an attachment, and records the export in the suggestion's own view with the file's hash", async () => {
    const { get, appended } = harness();
    const response = await get(OWNER);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="hb-suggestion-${ID}.jsonl"`);
    expect(Buffer.from(await response.arrayBuffer()).equals(FILE)).toBe(true);
    expect(appended).toEqual([
      {
        kind: "EXPORT",
        actor: `user:${OWNER.id}`,
        suggestionId: ID,
        chapterVersionId: null,
        payload: { scope: TRAILER.scope, fromSeq: 14647, toSeq: 15394, records: 8, headHash: TRAILER.headHash, fileSha256: createHash("sha256").update(FILE).digest("hex") },
      },
    ]);
  });

  it("is the not-found answer for anyone the suggestion's read refuses, and nothing is recorded", async () => {
    const { get, appended } = harness();
    expect((await get(STRANGER)).status).toBe(404);
    expect(appended).toEqual([]);
  });

  it("has nothing to export for a draft, before any key is asked for, nor for a suggestion with no record; and no export without the platform key", async () => {
    const keyless = harness(async () => {
      throw new AppError("LEDGER_KEY_MISSING", "LEDGER_EXPORT_KEY is not set");
    });
    const draft = await keyless.get(OWNER, DRAFT);
    expect(draft.status).toBe(404);
    expect(await draft.json()).toMatchObject({ code: "NOTHING_TO_EXPORT" });
    const empty = harness(async () => {
      throw new AppError("LEDGER_EXPORT_EMPTY", "the scope matches no record; nothing to sign.");
    });
    const recordless = await empty.get(OWNER);
    expect(recordless.status).toBe(404);
    expect(await recordless.json()).toMatchObject({ code: "NOTHING_TO_EXPORT" });
    /* Submitted, its first record not yet written: nothing to export, before the key is asked for (the 52c review). */
    const unrecorded = await harness(async () => {
      throw new AppError("LEDGER_KEY_MISSING", "LEDGER_EXPORT_KEY is not set");
    }, 0).get(OWNER);
    expect(unrecorded.status).toBe(404);
    expect(await unrecorded.json()).toMatchObject({ code: "NOTHING_TO_EXPORT" });
    const refused = await keyless.get(OWNER);
    expect(refused.status).toBe(500);
    expect(await refused.json()).toMatchObject({ code: "INTERNAL" });
    expect([...empty.appended, ...keyless.appended]).toEqual([]);
  });
});
