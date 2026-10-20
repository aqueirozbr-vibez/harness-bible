import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import type { ResolvedAnchor } from "@/lib/db/anchors";
import type { CuratorActionInput, MergeActionInput, RevertInput, SeedForCurator, SuggestionForUser } from "@/lib/db/improve";
import { stepKeyOf } from "@/lib/ledger/hash";
import { WorkflowNotFoundError, WorkflowsUnavailableError } from "@/lib/workflows/client";

import { curationEndpoints, type CurationEndpointDeps } from "./curation";

/*
 * A curator's decision (feature-specs/36 § 5, § 11.1; unit 53c), the rows, the engine and the pipeline doubled:
 * declared as § 5 says; the order of § 5.1 — in the queue (409), the override rule (422), the action, the signal with
 * the id only, then the record by its step key (200) or, while the workflow records, 202; the handler writes nothing to
 * the ledger; an action the workflow was never told of is taken back, and the engine down is the pipeline's 503. A
 * curator's merge (37 § 5; unit 54c) is the same endpoint's fourth action, told to the suggestion's merge.
 */

const CURATOR: SessionUser = { id: "33333333-3333-4333-8333-333333333333", organisationId: null, role: "CURATOR", displayName: "M. Tavares", locale: "en", identityVerified: true, parts: ["P1"], sessionId: "s1" };
const CONTRIBUTOR: SessionUser = { ...CURATOR, id: "11111111-1111-4111-8111-111111111111", role: "CONTRIBUTOR", parts: [] };
const ID = "S-15-0377";
const WORKFLOW = "suggestion:S-15-0377";
const ACTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW = { id: ID, userId: CONTRIBUTOR.id, state: "CURATOR_QUEUE", outcome: "REQUEST_MORE", changeClass: "CITED_FIGURE", parts: ["P1"], origin: "HUMAN" } as unknown as SuggestionForUser;
const NOTE = "Vendor page is the sole authoritative source for its own price.";
/* A merged suggestion and what reverting it makes (unit 54e). */
const REVERT_ID = "S-15-0401";
const MERGED_ROW = { ...ROW, state: "MERGED", outcome: "ACCEPT", changeKind: "EDIT_TEXT", locale: "EN", proposal: { kind: "EDIT_TEXT", before: "retries the call", after: "tries the call again" }, anchor: { kind: "SECTION", sectionAnchor: "15.3", figureAnchor: null, sourceRowAnchor: null, currentText: "It retries the call.", contentSha256: "a".repeat(64), existsAtVersion: true }, merge: { branch: "improve/S-15-0377-wording-15-3", commitSha: "c".repeat(40), versionFrom: "v1.0.0", versionTo: "v1.0.1", bump: "patch", releaseFrom: "2026.09", releaseTo: "2026.10", mergedAt: new Date("2026-10-09T22:10:00.000Z"), revertedBy: null, check: null } } as unknown as SuggestionForUser;
const ANCHOR_NOW = { kind: "SECTION", chapterNumber: 15, chapterVersionId: "cv-15-2", chapterVersion: "v1.0.1", releaseId: "2026.10", part: "P1", sectionAnchor: "15.3", figureAnchor: null, sourceRowAnchor: null, currentText: "It tries the call again.", contentSha256: "b".repeat(64), figures: [], value: null, row: null, readBy: [], tier: null, scenarioParam: false, fastMoving: false } as unknown as ResolvedAnchor;

interface Fake {
  row: SuggestionForUser | null;
  written: CuratorActionInput[];
  withdrawn: string[];
  signalled: Array<readonly [string, string]>;
  signal: "ok" | "ended" | "down";
  /** After how many looks the record is there; null for never. */
  recordAfter: number | null;
  looks: number;
  /** A seed of the caller's under the id asked for (36 § 7.1), and what its decision wrote. */
  seed: SeedForCurator | null;
  seedWritten: Array<Omit<CuratorActionInput, "suggestionId">>;
  resources: Array<{ readonly id: string }>;
  /** The merges told to check again (unit 54b), and whether none ran, so that one was started. */
  rechecked: string[];
  noMergeRuns: boolean;
  /** The merges written (unit 54c), whether one could be, and the merges told. */
  merges: MergeActionInput[];
  mergeWritten: boolean;
  mergeSignalled: Array<readonly [string, string]>;
  /** The workflow whose record the answer waits for: the suggestion's, or its merge's. */
  recordedBy: string;
  /** The reverts written (unit 54e), whether one could be, and the merges started for them. */
  reverts: RevertInput[];
  revertWritten: boolean;
  revertsStarted: Array<readonly [string, string]>;
  anchorNow: ResolvedAnchor | null;
  /** The month's verdicts that a change stands (36 § 7.2; unit 54e). */
  stands: Array<readonly [string, string | null]>;
  standsWritten: boolean;
}

function harness(fields: Partial<Fake> = {}) {
  const fake: Fake = { row: ROW, written: [], withdrawn: [], signalled: [], signal: "ok", recordAfter: 2, looks: 0, seed: null, seedWritten: [], resources: [], rechecked: [], noMergeRuns: false, merges: [], mergeWritten: true, mergeSignalled: [], recordedBy: WORKFLOW, reverts: [], revertWritten: true, revertsStarted: [], anchorNow: ANCHOR_NOW, stands: [], standsWritten: true, ...fields };
  const deps: CurationEndpointDeps = {
    queue: async () => [],
    decidedSince: async () => [],
    now: () => new Date("2026-10-10T12:00:00.000Z"),
    read: async () => fake.row,
    write: async (_user, input) => {
      fake.written.push(input);
      return { written: true, actionId: ACTION, workflowId: WORKFLOW };
    },
    withdraw: async (_user, actionId) => {
      fake.withdrawn.push(actionId);
      return true;
    },
    signal: async (workflowId, actionId) => {
      if (fake.signal === "ended") throw new WorkflowNotFoundError(workflowId);
      if (fake.signal === "down") throw new WorkflowsUnavailableError("connection", "the engine did not answer");
      fake.signalled.push([workflowId, actionId]);
    },
    recorded: async (_suggestionId, stepKey) => {
      expect(stepKey).toBe(stepKeyOf(fake.recordedBy, `curator:${ACTION}`));
      fake.looks += 1;
      return fake.recordAfter !== null && fake.looks >= fake.recordAfter ? 15500 : null;
    },
    pause: async () => undefined,
    calibration: async () => [],
    accepts: async () => [],
    reviews: async () => [],
    seedShare: 0,
    samplePerMonth: null,
    seeds: async () => [],
    merged: async () => [],
    seed: async (_user, id) => (fake.seed !== null && id === fake.seed.id ? fake.seed : null),
    writeSeed: async (_user, _seedId, input) => {
      fake.seedWritten.push(input);
      return { written: true, actionId: ACTION };
    },
    merging: async () => [],
    recheck: async (_user, suggestionId) => {
      fake.rechecked.push(suggestionId);
      return { started: fake.noMergeRuns };
    },
    writeMerge: async (_user, input) => {
      fake.merges.push(input);
      return fake.mergeWritten ? { written: true, actionId: ACTION } : { written: false };
    },
    signalMerge: async (suggestionId, actionId) => {
      if (fake.signal === "ended") throw new WorkflowNotFoundError(`merge:${suggestionId}`);
      if (fake.signal === "down") throw new WorkflowsUnavailableError("connection", "the engine did not answer");
      fake.mergeSignalled.push([suggestionId, actionId]);
    },
    anchor: async () => fake.anchorNow,
    writeRevert: async (_user, input) => {
      fake.reverts.push(input);
      return fake.revertWritten ? { written: true, revertId: REVERT_ID, actionId: ACTION } : { written: false };
    },
    startRevert: async (revertId, actionId) => {
      fake.revertsStarted.push([revertId, actionId]);
    },
    writeStands: async (_user, suggestionId, note) => {
      fake.stands.push([suggestionId, note]);
      return fake.standsWritten ? { written: true, actionId: ACTION } : { written: false };
    },
  };
  const pipeline = (session: SessionUser | null): HandlerDeps => ({
    sessionFromRequest: async () => session,
    authorize: async (_subject, _action, resource) => {
      fake.resources.push({ id: String(resource.id) });
      return { allow: true };
    },
    consume: async () => ({ allowed: true, limit: 60, remaining: 59, resetS: 60, retryAfterS: 0 }),
    idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
    audit: async () => undefined,
    log: () => undefined,
  });
  const { curationDecision, curationRecheck } = curationEndpoints(deps);
  const post = (session: SessionUser | null, body: unknown, id: string = ID): Promise<Response> =>
    handler(curationDecision, pipeline(session))(new Request(`http://localhost:3000/api/v1/curation/${id}/decision`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", "idempotency-key": randomUUID() }, body: JSON.stringify(body) }), { params: Promise.resolve({ suggestionId: id }) });
  const recheck = (session: SessionUser | null, id: string = ID): Promise<Response> =>
    handler(curationRecheck, pipeline(session))(new Request(`http://localhost:3000/api/v1/curation/${id}/recheck`, { method: "POST", headers: { origin: "http://localhost:3000", "idempotency-key": randomUUID() } }), { params: Promise.resolve({ suggestionId: id }) });
  return { fake, post, recheck };
}

describe("POST /api/v1/curation/{suggestionId}/decision (36 § 5)", () => {
  it("is declared as § 5 says: a session, the curator's role, an Idempotency-Key, 60 an hour, the policy's decide", () => {
    const { curationDecision } = curationEndpoints();
    expect(curationDecision).toMatchObject({ path: "/api/v1/curation/{suggestionId}/decision", method: "POST", auth: "session", role: "CURATOR", idempotent: true, rateLimit: { key: "user", limit: 60, windowS: 3600 }, policy: { action: "decide" } });
  });

  it("records the PRD's fourth example: an accept against the adjudicator with OV-IND-02 and a note, the workflow told the action's id, the record's seq answered", async () => {
    const { fake, post } = harness();
    const response = await post(CURATOR, { action: "ACCEPT", overrideCode: "OV-IND-02", note: NOTE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actionId: ACTION, ledgerSeq: 15500 });
    expect(fake.written).toEqual([{ suggestionId: ID, action: "ACCEPT", overrideCode: "OV-IND-02", criterion: "independence", note: NOTE }]);
    expect(fake.signalled).toEqual([[WORKFLOW, ACTION]]);
    expect(fake.withdrawn).toEqual([]);
  });

  it("answers 202 while the workflow has not recorded it, the action kept", async () => {
    const { fake, post } = harness({ recordAfter: null });
    const response = await post(CURATOR, { action: "KEEP_REQUEST_MORE" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ actionId: ACTION, ledgerSeq: null });
    expect(fake.withdrawn).toEqual([]);
  });

  it("refuses a request for more kept on a researcher's proposal, 422 NOT_FOR_RESEARCH, before anything is written; its accept and decline go through (42 § 7; unit 59e)", async () => {
    const researched = { ...ROW, userId: null, origin: "RESEARCHER", outcome: "ACCEPT" } as unknown as SuggestionForUser;
    const kept = harness({ row: researched });
    const refused = await kept.post(CURATOR, { action: "KEEP_REQUEST_MORE", note: NOTE });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "NOT_FOR_RESEARCH" });
    expect(kept.fake.written).toEqual([]);
    expect(kept.fake.signalled).toEqual([]);
    const accepted = harness({ row: researched });
    expect((await accepted.post(CURATOR, { action: "ACCEPT" })).status).toBe(200);
    expect(accepted.fake.written.map((action) => action.action)).toEqual(["ACCEPT"]);
    const declined = harness({ row: researched });
    expect((await declined.post(CURATOR, { action: "DECLINE", criterion: "relevance", note: NOTE })).status).toBe(200);
    expect(declined.fake.written.map((action) => action.action)).toEqual(["DECLINE"]);
  });

  it("refuses an override without its code or its note, 422, before anything is written", async () => {
    const { fake, post } = harness();
    const noCode = await post(CURATOR, { action: "ACCEPT", note: NOTE });
    expect(noCode.status).toBe(422);
    expect(await noCode.json()).toMatchObject({ code: "OVERRIDE_CODE_REQUIRED" });
    const noNote = await post(CURATOR, { action: "ACCEPT", overrideCode: "OV-IND-02" });
    expect(await noNote.json()).toMatchObject({ code: "OVERRIDE_NOTE_REQUIRED" });
    const wrongCriterion = await post(CURATOR, { action: "ACCEPT", overrideCode: "OV-REC-01", criterion: "independence", note: NOTE });
    expect(await wrongCriterion.json()).toMatchObject({ code: "OVERRIDE_CODE_INVALID" });
    /* a criterion is an override's alone: on an agreement it is refused, not recorded as one (unit 53's review) */
    const agreedWithCriterion = await post(CURATOR, { action: "KEEP_REQUEST_MORE", criterion: "independence" });
    expect(agreedWithCriterion.status).toBe(422);
    expect(await agreedWithCriterion.json()).toMatchObject({ code: "OVERRIDE_CRITERION_NOT_TAKEN" });
    expect(fake.written).toEqual([]);
  });

  it("is 409 for a suggestion not in the queue — decided by another curator meanwhile — and nothing is written", async () => {
    const { fake, post } = harness({ row: { ...ROW, state: "MERGING" } as unknown as SuggestionForUser });
    const response = await post(CURATOR, { action: "ACCEPT", overrideCode: "OV-IND-02", note: NOTE });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CONFLICT", detail: { state: "MERGING" } });
    expect(fake.written).toEqual([]);
  });

  it("takes the action back when the workflow cannot be told: an ended one is 409, the engine down 503", async () => {
    const ended = harness({ signal: "ended" });
    expect((await ended.post(CURATOR, { action: "KEEP_REQUEST_MORE" })).status).toBe(409);
    expect(ended.fake.withdrawn).toEqual([ACTION]);
    const down = harness({ signal: "down" });
    const response = await down.post(CURATOR, { action: "KEEP_REQUEST_MORE" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "WORKFLOWS_UNAVAILABLE" });
    expect(down.fake.withdrawn).toEqual([ACTION]);
  });

  it("is refused to a contributor, and is the not-found answer for a suggestion the curator may not read", async () => {
    expect((await harness().post(CONTRIBUTOR, { action: "DECLINE" })).status).toBe(403);
    expect((await harness({ row: null }).post(CURATOR, { action: "DECLINE" })).status).toBe(404);
  });

  /** A seed of the caller's (36 § 7.1): S-15-0377 offered again as S-15-0412, its known answer a decline. */
  const SEED: SeedForCurator = { id: "S-15-0412", suggestionId: ID, answer: "DECLINE", standing: "REQUEST_MORE", offeredAt: new Date("2026-10-10T08:00:00.000Z"), decided: null };

  it("decides a seed as one: decided on as the suggestion it is of, the override rule against what stood, the action written seeded, no workflow told, 200 with no seq (36 § 7.1)", async () => {
    const { fake, post } = harness({ seed: SEED, row: { ...ROW, state: "CLOSED" } as unknown as SuggestionForUser });
    const response = await post(CURATOR, { action: "ACCEPT", overrideCode: "OV-IND-02", note: NOTE }, SEED.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actionId: ACTION, ledgerSeq: null });
    expect(fake.resources).toEqual([{ id: ID }]);
    expect(fake.seedWritten).toEqual([{ action: "ACCEPT", overrideCode: "OV-IND-02", criterion: "independence", note: NOTE }]);
    expect([fake.written, fake.signalled, fake.looks]).toEqual([[], [], 0]);
  });

  it("holds a seed to the override rule, and refuses it decided twice", async () => {
    const { fake, post } = harness({ seed: SEED });
    const uncoded = await post(CURATOR, { action: "ACCEPT", note: NOTE }, SEED.id);
    expect(uncoded.status).toBe(422);
    expect(await uncoded.json()).toMatchObject({ code: "OVERRIDE_CODE_REQUIRED" });
    expect(fake.seedWritten).toEqual([]);
    const decided = harness({ seed: { ...SEED, decided: { action: "DECLINE", matched: true, at: new Date("2026-10-10T09:00:00.000Z") } } });
    expect((await decided.post(CURATOR, { action: "DECLINE", note: NOTE }, SEED.id)).status).toBe(409);
  });

  it("refuses a body the decision does not take: an action it has not, a code of no form, a note past 400", async () => {
    const { post } = harness();
    expect((await post(CURATOR, { action: "UNDO" })).status).toBe(400);
    expect((await post(CURATOR, { action: "ACCEPT", overrideCode: "independence", note: NOTE })).status).toBe(400);
    expect((await post(CURATOR, { action: "DECLINE", note: "x".repeat(401) })).status).toBe(400);
  });
});

describe("MERGE through the decision endpoint (37 § 5; unit 54c)", () => {
  const READY = { ...ROW, state: "MERGING", outcome: "ACCEPT" } as unknown as SuggestionForUser;
  const MERGE_WORKFLOW_ID = `merge:${ID}`;
  const MERGE_NOTE = "Checked against the vendor page today.";

  it("merges a suggestion whose check passed: the action written with its note, the merge told its id, the record's seq answered", async () => {
    const { fake, post } = harness({ row: READY, recordedBy: MERGE_WORKFLOW_ID });
    const response = await post(CURATOR, { action: "MERGE", note: MERGE_NOTE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actionId: ACTION, ledgerSeq: 15500 });
    expect(fake.merges).toEqual([{ suggestionId: ID, note: MERGE_NOTE }]);
    expect(fake.mergeSignalled).toEqual([[ID, ACTION]]);
    /* not a decision in the queue: no decision's action, and the suggestion's own run untold */
    expect(fake.written).toEqual([]);
    expect(fake.signalled).toEqual([]);
    expect(fake.resources).toEqual([{ id: ID }]);
  });

  it("answers 202 while the merge has not recorded it", async () => {
    const { post } = harness({ row: READY, recordedBy: MERGE_WORKFLOW_ID, recordAfter: null });
    const response = await post(CURATOR, { action: "MERGE" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ actionId: ACTION, ledgerSeq: null });
  });

  it("refuses an override's code or criterion (400), a suggestion not merging (409) and one not ready (409), writing nothing told", async () => {
    const coded = harness({ row: READY });
    expect((await coded.post(CURATOR, { action: "MERGE", overrideCode: "OV-IND-02" })).status).toBe(400);
    expect((await coded.post(CURATOR, { action: "MERGE", criterion: "independence" })).status).toBe(400);
    expect(coded.fake.merges).toEqual([]);
    const queued = harness();
    const notMerging = await queued.post(CURATOR, { action: "MERGE" });
    expect(notMerging.status).toBe(409);
    expect(await notMerging.json()).toMatchObject({ code: "CONFLICT", detail: { state: "CURATOR_QUEUE" } });
    const notReady = harness({ row: READY, mergeWritten: false });
    expect((await notReady.post(CURATOR, { action: "MERGE" })).status).toBe(409);
    expect(notReady.fake.mergeSignalled).toEqual([]);
  });

  it("takes the action back when the merge cannot be told: one that has ended is 409, the engine down 503", async () => {
    const ended = harness({ row: READY, signal: "ended" });
    const conflict = await ended.post(CURATOR, { action: "MERGE" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ detail: { workflowId: MERGE_WORKFLOW_ID } });
    expect(ended.fake.withdrawn).toEqual([ACTION]);
    const down = harness({ row: READY, signal: "down" });
    expect((await down.post(CURATOR, { action: "MERGE" })).status).toBe(503);
    expect(down.fake.withdrawn).toEqual([ACTION]);
  });

  it("never merges a seed, and is refused to a contributor", async () => {
    const seed: SeedForCurator = { id: "S-15-0412", suggestionId: ID, answer: "ACCEPT", standing: "REQUEST_MORE", offeredAt: new Date("2026-10-10T08:00:00.000Z"), decided: null };
    const seeded = harness({ seed });
    expect((await seeded.post(CURATOR, { action: "MERGE" }, seed.id)).status).toBe(409);
    expect(seeded.fake.seedWritten).toEqual([]);
    expect((await harness({ row: READY }).post(CONTRIBUTOR, { action: "MERGE" })).status).toBe(403);
  });
});

describe("REVERT through the decision endpoint (37 § 8; unit 54e)", () => {
  it("reverts a merged suggestion: the undoing proposal on the anchor as it reads now, the action with its note, the revert's merge started with it; 202 with the revert's id", async () => {
    const { fake, post } = harness({ row: MERGED_ROW });
    const response = await post(CURATOR, { action: "REVERT", note: "The vendor page was misread." });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ actionId: ACTION, ledgerSeq: null, revertId: REVERT_ID });
    expect(fake.reverts).toHaveLength(1);
    expect(fake.reverts[0]).toMatchObject({ originalId: ID, note: "The vendor page was misread.", releaseId: "2026.10", chapterVersionId: "cv-15-2", changeKind: "EDIT_TEXT", proposal: { kind: "EDIT_TEXT", before: "tries the call again", after: "retries the call" }, anchor: { kind: "SECTION", sectionAnchor: "15.3", currentText: "It tries the call again.", contentSha256: "b".repeat(64), existsAtVersion: true } });
    expect(fake.reverts[0]?.proposalKey).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.revertsStarted).toEqual([[REVERT_ID, ACTION]]);
    /* no decision's action, no merge's, and the suggestion's run untold */
    expect(fake.written).toEqual([]);
    expect(fake.merges).toEqual([]);
    expect(fake.signalled).toEqual([]);
  });

  it("makes a claim's revert the curator's hand: a restructure of the product's words", async () => {
    const claim = { ...MERGED_ROW, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "A claim.", placeAfter: "end", fastMoving: false } } as unknown as SuggestionForUser;
    const { fake, post } = harness({ row: claim });
    expect((await post(CURATOR, { action: "REVERT", note: NOTE })).status).toBe(202);
    expect(fake.reverts[0]).toMatchObject({ changeKind: "RESTRUCTURE", proposal: { kind: "RESTRUCTURE", description: `Revert of ${ID}: the claim added is taken out by hand` } });
  });

  it("refuses a revert without a note (422), with a code (400), of a suggestion not merged or reverted already (409), of an anchor gone (409), and one the door refuses (409); nothing started", async () => {
    const { fake, post } = harness({ row: MERGED_ROW });
    const unsaid = await post(CURATOR, { action: "REVERT" });
    expect(unsaid.status).toBe(422);
    expect(await unsaid.json()).toMatchObject({ code: "REVERT_NOTE_REQUIRED" });
    expect((await post(CURATOR, { action: "REVERT", note: NOTE, overrideCode: "OV-IND-02" })).status).toBe(400);
    expect(fake.reverts).toEqual([]);
    expect((await harness().post(CURATOR, { action: "REVERT", note: NOTE })).status).toBe(409);
    const reverted = { ...MERGED_ROW, merge: { ...(MERGED_ROW.merge as object), revertedBy: "S-15-0400" } } as unknown as SuggestionForUser;
    const twice = await harness({ row: reverted }).post(CURATOR, { action: "REVERT", note: NOTE });
    expect(twice.status).toBe(409);
    expect(await twice.json()).toMatchObject({ detail: { revertedBy: "S-15-0400" } });
    expect((await harness({ row: MERGED_ROW, anchorNow: null }).post(CURATOR, { action: "REVERT", note: NOTE })).status).toBe(409);
    const refused = harness({ row: MERGED_ROW, revertWritten: false });
    expect((await refused.post(CURATOR, { action: "REVERT", note: NOTE })).status).toBe(409);
    expect(refused.fake.revertsStarted).toEqual([]);
  });

  it("takes an accept of a merged change as the month's verdict that it stands: the action alone, 200 with no seq; refused once judged (36 § 7.2)", async () => {
    const { fake, post } = harness({ row: MERGED_ROW });
    const response = await post(CURATOR, { action: "ACCEPT", note: "Checked against the vendor page." });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actionId: ACTION, ledgerSeq: null });
    expect(fake.stands).toEqual([[ID, "Checked against the vendor page."]]);
    expect(fake.written).toEqual([]);
    expect(fake.signalled).toEqual([]);
    expect((await post(CURATOR, { action: "ACCEPT", overrideCode: "OV-IND-02", note: NOTE })).status).toBe(400);
    expect((await harness({ row: MERGED_ROW, standsWritten: false }).post(CURATOR, { action: "ACCEPT" })).status).toBe(409);
  });

  it("never reverts a seed, and is refused to a contributor", async () => {
    const seed: SeedForCurator = { id: "S-15-0412", suggestionId: ID, answer: "ACCEPT", standing: "REQUEST_MORE", offeredAt: new Date("2026-10-10T08:00:00.000Z"), decided: null };
    const seeded = harness({ seed });
    expect((await seeded.post(CURATOR, { action: "REVERT", note: NOTE }, seed.id)).status).toBe(409);
    expect((await harness({ row: MERGED_ROW }).post(CONTRIBUTOR, { action: "REVERT", note: NOTE })).status).toBe(403);
  });
});

describe("POST /api/v1/curation/{suggestionId}/recheck (37 § 4.3, § 4.5; unit 54b)", () => {
  const MERGING = { ...ROW, state: "MERGING", outcome: "ACCEPT" } as unknown as SuggestionForUser;

  it("is declared as a decision is: a session, the curator's role, an Idempotency-Key, 60 an hour, the policy's decide", () => {
    const { curationRecheck } = curationEndpoints();
    expect(curationRecheck).toMatchObject({ path: "/api/v1/curation/{suggestionId}/recheck", method: "POST", auth: "session", role: "CURATOR", idempotent: true, rateLimit: { key: "user", limit: 60, windowS: 3600 }, policy: { action: "decide" } });
  });

  it("tells the merge of an accepted suggestion to check again, 202; where none runs it starts one", async () => {
    const told = harness({ row: MERGING });
    const answer = await told.recheck(CURATOR);
    expect(answer.status).toBe(202);
    expect(await answer.json()).toEqual({ suggestionId: ID, started: false });
    expect(told.fake.rechecked).toEqual([ID]);
    expect(told.fake.resources).toEqual([{ id: ID }]);

    /* a person's accept waiting in DECIDED, from before the merge existed: its merge begins */
    const waiting = harness({ row: { ...ROW, state: "DECIDED", outcome: "ACCEPT" } as unknown as SuggestionForUser, noMergeRuns: true });
    expect(await (await waiting.recheck(CURATOR)).json()).toEqual({ suggestionId: ID, started: true });
  });

  it("is 409 for a suggestion with no merge to check, and the not-found answer for one the curator may not read; a contributor is refused", async () => {
    const queued = harness();
    const conflict = await queued.recheck(CURATOR);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "CONFLICT" });
    expect(queued.fake.rechecked).toEqual([]);
    const unknown = harness({ row: null });
    expect((await unknown.recheck(CURATOR)).status).toBe(404);
    expect((await harness({ row: MERGING }).recheck(CONTRIBUTOR)).status).toBe(403);
  });
});
