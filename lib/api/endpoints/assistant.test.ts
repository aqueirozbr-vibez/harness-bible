import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import type { ConversationDeleted } from "@/lib/db/assistant";
import { erasedStepKeyOf } from "@/lib/db/ledger";
import { ConversationDeletedSchema } from "@/lib/schemas/api";

import { conversationDeleteEndpoint, type ConversationDeleteDeps } from "./assistant";

/*
 * A reader's delete of a conversation through the pipeline, its door and its ledger doubled (feature-specs/45 § 3.2,
 * § 3.7; unit 62h): declared as § 3.2 says; the door's answer as the endpoint's; the ERASED record appended after the
 * door's commit, once, looked for by its step key first; and a deletion that stands without its record when the append
 * fails. The route against the database and the policy is tests/contract/api.test.ts.
 */

const READER: SessionUser = { id: "11111111-1111-4111-8111-111111111111", organisationId: null, role: "READER", displayName: "A reader", locale: "en", identityVerified: false, parts: [], sessionId: "s1" };
const ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-11T15:00:00.000Z");

const fake = {
  answer: { deleted: true, messages: 4, detached: 1, forgotten: 1 } as ConversationDeleted,
  removed: [] as Array<{ user: string; id: string; at: Date }>,
  recorded: null as { readonly seq: number } | null,
  appended: [] as unknown[],
  appendFails: false,
};

const deps: ConversationDeleteDeps = {
  remove: async (user, id, at) => {
    fake.removed.push({ user: user.id, id, at: at ?? NOW });
    return fake.answer;
  },
  recorded: async () => fake.recorded,
  append: async (input) => {
    if (fake.appendFails) throw new Error("the chain's head did not answer");
    fake.appended.push(input);
    return { seq: 9001 };
  },
  now: () => NOW,
};

/** The rate buckets the pipeline drew from, by key. */
const buckets: string[] = [];

const pipeline = (session: SessionUser | null, allow = true): HandlerDeps => ({
  sessionFromRequest: async () => session,
  authorize: async () => (allow ? { allow: true } : { allow: false, reason: "policy" }),
  consume: async (key) => {
    buckets.push(key);
    return { allowed: true, limit: 30, remaining: 29, resetS: 60, retryAfterS: 0 };
  },
  idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
  audit: async () => undefined,
  log: () => undefined,
});

const conversationDelete = conversationDeleteEndpoint(deps);
const remove = (session: SessionUser | null = READER, allow = true) =>
  handler(conversationDelete, pipeline(session, allow))(new Request(`http://localhost:3000/api/v1/assistant/conversations/${ID}`, { method: "DELETE", headers: { "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.48" } }), { params: { id: ID } });

beforeEach(() => {
  fake.answer = { deleted: true, messages: 4, detached: 1, forgotten: 1 };
  fake.removed = [];
  fake.recorded = null;
  fake.appended = [];
  fake.appendFails = false;
  buckets.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DELETE /api/v1/assistant/conversations/{id} (45 § 3.2)", () => {
  it("is declared as § 3.2 says: a session, 30 a minute for the reader, the policy's delete, no Idempotency-Key", () => {
    expect(conversationDelete).toMatchObject({ path: "/api/v1/assistant/conversations/{id}", method: "DELETE", auth: "session", rateLimit: { key: "user", limit: 30, windowS: 60 } });
    expect(conversationDelete.policy.action).toBe("delete");
    expect(conversationDelete.idempotent).toBeUndefined();
  });

  it("draws on a bucket of its own, not the read's of the same path, which takes another rate (review of unit 62)", async () => {
    await remove();
    expect(buckets).toEqual([`user:${READER.id}:DELETE /api/v1/assistant/conversations/{id}`]);
  });

  it("deletes through the door, then appends one ERASED record by the reader about nothing, and answers its place in the chain", async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(ConversationDeletedSchema.parse(await response.json())).toEqual({ id: ID, deleted: true, ledgerSeq: 9001 });
    expect(fake.removed).toEqual([{ user: READER.id, id: ID, at: NOW }]);
    expect(fake.appended).toEqual([{ kind: "ERASED", actor: `user:${READER.id}`, suggestionId: null, chapterVersionId: null, payload: { stepKey: erasedStepKeyOf(ID), scope: { kind: "conversation", id: ID } } }]);
  });

  it("answers the record already under the step key and appends no second one", async () => {
    fake.recorded = { seq: 4242 };
    expect(await (await remove()).json()).toEqual({ id: ID, deleted: true, ledgerSeq: 4242 });
    expect(fake.appended).toEqual([]);
  });

  it("lets the deletion stand when the append fails: ledgerSeq null, and a line with the trace (45 § 3.7)", async () => {
    fake.appendFails = true;
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: ID, deleted: true, ledgerSeq: null });
    expect(said).toHaveBeenCalledWith("conversation deleted: its ERASED record was not appended", expect.stringMatching(/^[0-9a-f]{32}$/), ID, "the chain's head did not answer");
  });

  it("is 404 for none of the reader's, 409 TURN_IN_PROGRESS while the last turn may still write, and appends nothing for either", async () => {
    fake.answer = { deleted: false, reason: "NOT_FOUND" };
    const gone = await remove();
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: "NOT_FOUND" });
    fake.answer = { deleted: false, reason: "TURN_IN_PROGRESS" };
    const settling = await remove();
    expect(settling.status).toBe(409);
    expect(await settling.json()).toMatchObject({ code: "TURN_IN_PROGRESS" });
    expect(fake.appended).toEqual([]);
  });

  it("is 401 signed out and 403 for whoever the policy refuses, and asks the door nothing", async () => {
    expect((await remove(null)).status).toBe(401);
    expect((await remove(READER, false)).status).toBe(403);
    expect(fake.removed).toEqual([]);
  });
});
