import { describe, expect, it } from "vitest";

import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import type { ProposalPlace } from "@/lib/db/improve";
import type { EndorsedSignal } from "@/lib/schemas/workflows";
import { WorkflowNotFoundError, WorkflowsUnavailableError } from "@/lib/workflows/client";

import { ENDORSEMENTS_MAX, proposalEndpoints, type ProposalEndpointDeps } from "./proposals";

/*
 * A reader's name on a research proposal (feature-specs/42 § 6; unit 59d), the rows, the engine and the pipeline
 * doubled: declared as § 6 says; the asker is the proposal's owner and nobody else is; consent or 422; in the queue or
 * merging, else 409 (merged: the credit is written; the curator's merge taken: it is being written); the consent on
 * file, the row, then the workflow told the reader's id, the instant and the direction, and a workflow that could not be
 * told takes back the row this request wrote — the engine down the pipeline's 503, an ended workflow a 409; a second
 * press tells the workflow again with the row's own instant and takes back nothing; a new name past the proposal's
 * records of names is refused, its withdrawal never; the withdrawal the same in reverse, 404 where no name is there.
 */

const ASKER: SessionUser = { id: "11111111-1111-4111-8111-111111111111", organisationId: null, role: "READER", displayName: "A. Reader", locale: "en", identityVerified: false, parts: [], sessionId: "s1" };
const OTHER: SessionUser = { ...ASKER, id: "22222222-2222-4222-8222-222222222222", sessionId: "s2" };
const ID = "S-21-0044";
const WORKFLOW = `suggestion:${ID}`;
const NOW = new Date("2026-10-10T12:00:00.000Z");
const ROW: ProposalPlace = { id: ID, state: "CURATOR_QUEUE", outcome: "ACCEPT", workflowId: WORKFLOW };

interface Fake {
  row: ProposalPlace | null;
  records: Array<{ readonly kind: string; readonly actor: string; readonly payload: unknown }>;
  asker: boolean;
  endorsement: Date | null;
  consents: Date[];
  written: Array<readonly [string, Date]>;
  removed: string[];
  signalled: Array<readonly [string, EndorsedSignal]>;
  signal: "ok" | "ended" | "down";
  allowed: boolean;
  resources: Array<{ readonly id: unknown; readonly ownerId: unknown }>;
}

function harness(fields: Partial<Fake> = {}) {
  const fake: Fake = { row: ROW, records: [], asker: true, endorsement: null, consents: [], written: [], removed: [], signalled: [], signal: "ok", allowed: true, resources: [], ...fields };
  const deps: ProposalEndpointDeps = {
    asker: async () => fake.asker,
    proposal: async () => fake.row,
    records: async () => fake.records,
    endorsement: async () => (fake.endorsement === null ? null : { createdAt: fake.endorsement }),
    consent: async (_user, at) => {
      fake.consents.push(at);
    },
    write: async (_user, suggestionId, now) => {
      if (fake.endorsement !== null) return { written: true, createdAt: fake.endorsement, existed: true };
      fake.written.push([suggestionId, now]);
      fake.endorsement = now;
      return { written: true, createdAt: now, existed: false };
    },
    /* the row of that instant, and no other */
    remove: async (_user, suggestionId, createdAt) => {
      fake.removed.push(suggestionId);
      const had = fake.endorsement !== null && fake.endorsement.getTime() === createdAt.getTime();
      if (had) fake.endorsement = null;
      return had;
    },
    signal: async (workflowId, endorsed) => {
      if (fake.signal === "ended") throw new WorkflowNotFoundError(workflowId);
      if (fake.signal === "down") throw new WorkflowsUnavailableError("connection", "the engine did not answer");
      fake.signalled.push([workflowId, endorsed]);
    },
    now: () => NOW,
  };
  const pipeline = (session: SessionUser | null): HandlerDeps => ({
    sessionFromRequest: async () => session,
    authorize: async (_subject, _action, resource) => {
      fake.resources.push({ id: resource.id, ownerId: resource.ownerId });
      return fake.allowed ? { allow: true } : { allow: false, reason: "not the asker" };
    },
    consume: async () => ({ allowed: true, limit: 10, remaining: 9, resetS: 60, retryAfterS: 0 }),
    idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
    audit: async () => undefined,
    log: () => undefined,
  });
  const { proposalEndorse, proposalWithdraw } = proposalEndpoints(deps);
  const post = (session: SessionUser | null, body: unknown, id: string = ID): Promise<Response> =>
    handler(proposalEndorse, pipeline(session))(new Request(`http://localhost:3000/api/v1/proposals/${id}/endorse`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify(body) }), { params: Promise.resolve({ suggestionId: id }) });
  const del = (session: SessionUser | null, id: string = ID): Promise<Response> =>
    handler(proposalWithdraw, pipeline(session))(new Request(`http://localhost:3000/api/v1/proposals/${id}/endorse`, { method: "DELETE", headers: { origin: "http://localhost:3000" } }), { params: Promise.resolve({ suggestionId: id }) });
  return { fake, post, del };
}

describe("POST and DELETE /api/v1/proposals/{suggestionId}/endorse (42 § 6)", () => {
  it("are declared as § 6 says: a session, any role, 10 a minute, the policy's endorse on the proposal", () => {
    const { proposalEndorse, proposalWithdraw } = proposalEndpoints();
    expect(proposalEndorse).toMatchObject({ path: "/api/v1/proposals/{suggestionId}/endorse", method: "POST", auth: "session", rateLimit: { key: "user", limit: 10, windowS: 60 }, policy: { action: "endorse" } });
    expect(proposalEndorse.role).toBeUndefined();
    expect(proposalWithdraw).toMatchObject({ path: "/api/v1/proposals/{suggestionId}/endorse", method: "DELETE", auth: "session", rateLimit: { key: "user", limit: 10, windowS: 60 }, policy: { action: "endorse" } });
  });

  it("names the asker the proposal's owner for the policy, and nobody else", async () => {
    const asker = harness();
    await asker.post(ASKER, { consent: true });
    expect(asker.fake.resources).toEqual([{ id: ID, ownerId: ASKER.id }]);
    const other = harness({ asker: false, allowed: false });
    const refused = await other.post(OTHER, { consent: true });
    expect(refused.status).toBe(403);
    expect(other.fake.resources).toEqual([{ id: ID, ownerId: null }]);
    expect(other.fake.written).toEqual([]);
  });

  it("puts the name on with consent: the consent on file first, the row, the workflow told the reader, the instant and the direction, the name answered", async () => {
    const { fake, post } = harness();
    const response = await post(ASKER, { consent: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestionId: ID, endorsed: { byMe: true, at: NOW.toISOString() } });
    expect(fake.consents).toEqual([NOW]);
    expect(fake.written).toEqual([[ID, NOW]]);
    expect(fake.signalled).toEqual([[WORKFLOW, { userId: ASKER.id, at: NOW.toISOString(), withdrawn: false }]]);
  });

  it("refuses without consent (422 CONSENT_REQUIRED), writing nothing and telling nobody", async () => {
    const { fake, post } = harness();
    const response = await post(ASKER, { consent: false });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(fake.consents).toEqual([]);
    expect(fake.written).toEqual([]);
    expect(fake.signalled).toEqual([]);
  });

  it("takes a name while the proposal is with a curator or being merged, and answers 409 once merged or closed, and 404 for no proposal", async () => {
    expect((await harness({ row: { ...ROW, state: "MERGING" } }).post(ASKER, { consent: true })).status).toBe(200);
    const merged = await harness({ row: { ...ROW, state: "MERGED" } }).post(ASKER, { consent: true });
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({ code: "CONFLICT", detail: { state: "MERGED" } });
    expect((await harness({ row: { ...ROW, state: "CLOSED", outcome: "DECLINE" } }).post(ASKER, { consent: true })).status).toBe(409);
    expect((await harness({ row: { ...ROW, state: "GRADED", outcome: null } }).post(ASKER, { consent: true })).status).toBe(409);
    expect((await harness({ row: null, asker: false, allowed: false }).post(ASKER, { consent: true })).status).toBe(403);
    expect((await harness({ row: null }).post(ASKER, { consent: true })).status).toBe(404);
  });

  it("answers a name already there as it stands and tells the workflow again with the row's own instant, whose record is then written once; a failed signal takes back no row this request did not write (unit 59's review)", async () => {
    const at = new Date("2026-10-09T09:00:00.000Z");
    const { fake, post } = harness({ endorsement: at });
    const response = await post(ASKER, { consent: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestionId: ID, endorsed: { byMe: true, at: at.toISOString() } });
    expect(fake.written).toEqual([]);
    expect(fake.signalled).toEqual([[WORKFLOW, { userId: ASKER.id, at: at.toISOString(), withdrawn: false }]]);
    const down = harness({ endorsement: at, signal: "down" });
    expect((await down.post(ASKER, { consent: true })).status).toBe(503);
    expect(down.fake.removed).toEqual([]);
    expect(down.fake.endorsement).toEqual(at);
  });

  it("stops taking names once the curator's merge is taken — its record written, or the merged one — and refuses a new name past the proposal's records of names, never a withdrawal (unit 59's review)", async () => {
    const merging = { ...ROW, state: "MERGING" as const };
    const mergeRecord = { kind: "CURATOR", actor: "user:33333333-3333-4333-8333-333333333333", payload: { action: "MERGE" } };
    const taken = harness({ row: merging, records: [mergeRecord] });
    const refused = await taken.post(ASKER, { consent: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "CONFLICT", detail: { merge: true } });
    expect(taken.fake.written).toEqual([]);
    expect((await harness({ row: merging, records: [mergeRecord], endorsement: NOW }).del(ASKER)).status).toBe(409);
    /* a curator's accept is not the merge: names are still taken */
    expect((await harness({ row: merging, records: [{ ...mergeRecord, payload: { action: "ACCEPT" } }] }).post(ASKER, { consent: true })).status).toBe(200);
    const names = Array.from({ length: ENDORSEMENTS_MAX }, (_, index) => ({ kind: "ENDORSED", actor: `user:${ASKER.id}`, payload: { withdrawn: index % 2 === 1 } }));
    const full = harness({ records: names });
    expect((await full.post(ASKER, { consent: true })).status).toBe(409);
    expect(full.fake.written).toEqual([]);
    /* a name already there is told again, and taken back, whatever the count */
    expect((await harness({ records: names, endorsement: NOW }).post(ASKER, { consent: true })).status).toBe(200);
    expect((await harness({ records: names, endorsement: NOW }).del(ASKER)).status).toBe(200);
  });

  it("takes the row back when the workflow cannot be told: the engine down is 503, an ended workflow 409; the consent stays on file", async () => {
    const down = harness({ signal: "down" });
    expect((await down.post(ASKER, { consent: true })).status).toBe(503);
    expect(down.fake.removed).toEqual([ID]);
    expect(down.fake.endorsement).toBeNull();
    expect(down.fake.consents).toEqual([NOW]);
    const ended = harness({ signal: "ended" });
    expect((await ended.post(ASKER, { consent: true })).status).toBe(409);
    expect(ended.fake.removed).toEqual([ID]);
  });

  it("takes the name off: the row gone, the workflow told the withdrawal with the consent's instant, no name answered; 404 where no name was there; the row put back when the workflow cannot be told", async () => {
    const at = new Date("2026-10-09T09:00:00.000Z");
    const { fake, del } = harness({ endorsement: at });
    const response = await del(ASKER);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestionId: ID, endorsed: null });
    expect(fake.removed).toEqual([ID]);
    expect(fake.signalled).toEqual([[WORKFLOW, { userId: ASKER.id, at: at.toISOString(), withdrawn: true }]]);
    expect(fake.endorsement).toBeNull();
    expect((await harness().del(ASKER)).status).toBe(404);
    expect((await harness({ endorsement: at, row: { ...ROW, state: "MERGED" } }).del(ASKER)).status).toBe(409);
    const down = harness({ endorsement: at, signal: "down" });
    expect((await down.del(ASKER)).status).toBe(503);
    expect(down.fake.written).toEqual([[ID, at]]);
    expect(down.fake.endorsement).toEqual(at);
  });
});
