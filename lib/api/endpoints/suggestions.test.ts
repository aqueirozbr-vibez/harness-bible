import { beforeEach, describe, expect, it } from "vitest";

import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import type { ResolvedAnchor } from "@/lib/db/anchors";
import type { DraftInput, DraftPatch, SuggestionForUser, WithdrawalRequested } from "@/lib/db/improve";
import { stepKeyOf } from "@/lib/ledger/hash";
import type { LoadedRubric } from "@/lib/rubrics/load";
import type { SuggestionId } from "@/lib/schemas/ids";
import { RubricSchema } from "@/lib/schemas/rubric";
import { WorkflowNotFoundError, WorkflowsUnavailableError, type StartedWorkflow } from "@/lib/workflows/client";
import { RUBRIC_V1_2 } from "@/tests/fixtures/rubric";

import { proposalKeyOf } from "@/lib/improve/proposal";

import { suggestionEndpoints, type SuggestionEndpointDeps } from "./suggestions";

/*
 * The suggestion endpoints through the pipeline, with the rows doubled (feature-specs/31 § 3, § 4, § 7). POST: what
 * it is told, in the API's error form, when it is given no anchor, an anchor the release has not, a change kind the
 * anchor's kind does not take, or by a throttled contributor; the class, the thresholds and the parts it computes
 * from an anchor; and what the pipeline refuses before it runs. PATCH, GET and DELETE: the proposal written with
 * its key and the class recomputed from it, the rationale, what a curator and a stranger read, and what a
 * suggestion past draft refuses. SUBMIT: the order of 31 § 6.1 with the engine doubled: the throttle, the consent,
 * the four sensors, the start, the transition; the running workflow for a suggestion already submitted; the signal
 * for a revision. The rows themselves are tests/integration/suggestions.test.ts, and the engine is real there.
 */

const CONTRIBUTOR: SessionUser = { id: "11111111-1111-4111-8111-111111111111", organisationId: null, role: "CONTRIBUTOR", displayName: "A contributor", locale: "en", identityVerified: true, parts: [], sessionId: "s1" };
const READER: SessionUser = { ...CONTRIBUTOR, id: "22222222-2222-4222-8222-222222222222", role: "READER" };
const OTHER: SessionUser = { ...CONTRIBUTOR, id: "33333333-3333-4333-8333-333333333333" };
const CURATOR_OF_P2: SessionUser = { ...CONTRIBUTOR, id: "44444444-4444-4444-8444-444444444444", role: "CURATOR", parts: ["P2"] };

const RUBRIC = RubricSchema.parse({
  ...RUBRIC_V1_2,
  version: "v1.2",
  publishedAt: "2026-07-01",
  appliesAt: "2026-07-01",
  chips: { PRIMARY: "B", VENDOR: "C", ANALYST: "D", PRACTITIONER: "E", ILLUSTRATIVE: null, DERIVED: "A", OPEN: "U" },
  examples: [{ id: "S-36-0198", section: "36.3", changeKind: "EDIT_ROW", changeClass: "CITED_FIGURE", fastMoving: true, items: [{ tier: "B", relevance: "direct", stake: "none", ageDays: 9, base: 85, factors: { relevance: 1, recency: 1, independence: 1 }, adjusted: 85 }], score: 85, strongestItem: 0, corroboratedBy: null, acceptAt: 70, floorAt: 25, route: "ADJUDICATE", decision: "ACCEPT" }],
  changelog: [{ version: "v1.2", on: "2026-07-01" }],
});
const SHA = "a".repeat(64);
const LOADED: LoadedRubric = { rubric: RUBRIC, sha256: SHA, text: "" };

const SECTION: ResolvedAnchor = {
  kind: "SECTION",
  chapterNumber: 21,
  chapterVersionId: "cv-21",
  chapterVersion: "1.4.1",
  releaseId: "2026.09",
  part: "P2",
  sectionAnchor: "21.3",
  figureAnchor: null,
  sourceRowAnchor: null,
  currentText: "The agent retries the call three times before it gives up.",
  contentSha256: "b".repeat(64),
  figures: [{ id: "F-21-01", valueText: "three" }],
  value: null,
  row: null,
  tier: null,
  verifiedOn: new Date("2026-09-12T00:00:00Z"),
  fastMoving: false,
  scenarioParam: false,
  readBy: [],
};
const DERIVED_FIGURE: ResolvedAnchor = { ...SECTION, kind: "FIGURE", figureAnchor: "F-21-03", currentText: "repair cap · 3", tier: "DERIVED", fastMoving: false, figures: [] };
const SCENARIO_FIGURE: ResolvedAnchor = { ...DERIVED_FIGURE, figureAnchor: "F-21-04", tier: "ILLUSTRATIVE", scenarioParam: true };
const ROW: ResolvedAnchor = {
  ...SECTION,
  kind: "SOURCE_ROW",
  chapterNumber: 15,
  sectionAnchor: "15.9",
  sourceRowAnchor: "15.9 r12",
  currentText: "cached-input price $0.30 per M tokens — provider tier 2 pricing page",
  tier: "VENDOR",
  fastMoving: true,
  part: "P1",
  figures: [],
  readBy: [
    { section: "15.3", title: "Worked numbers", chapterNumber: 15, part: "P1" },
    { section: "37.3", title: "Configuration C", chapterNumber: 37, part: "P3" },
  ],
};
const OT_SECTION: ResolvedAnchor = { ...SECTION, sectionAnchor: "35.2", chapterNumber: 35, part: "P3", currentText: "Never write the setpoint to the PLC from the agent; the operator does." };
const OT_ROW: ResolvedAnchor = { ...ROW, sourceRowAnchor: "35.9 r2", chapterNumber: 35, sectionAnchor: "35.9", part: "P3", readBy: [], currentText: "The agent may write the setpoint to the PLC under supervision — vendor note" };

const fake = {
  anchors: {} as Record<string, ResolvedAnchor | undefined>,
  throttledUntil: null as Date | null,
  rubricRow: { id: "v1.2", publishedAt: new Date("2026-07-01T00:00:00Z"), appliesAt: new Date("2026-07-01T00:00:00Z"), sha256: SHA } as { id: string; publishedAt: Date; appliesAt: Date; sha256: string } | null,
  loaded: LOADED as LoadedRubric,
  drafts: [] as DraftInput[],
  serial: 0,
  rows: [] as SuggestionForUser[],
  patches: [] as Array<{ id: string; patch: DraftPatch }>,
  started: [] as string[],
  signalled: [] as string[],
  submits: [] as Array<{ id: string; workflowId: string }>,
  /** What the submission did, in order: the consent, the start, the move. */
  order: [] as string[],
  consentAt: null as Date | null,
  engine: "up" as "up" | "down" | "gone",
  /** What a draft's delete cleaned up (45 § 4): the gradings cancelled and the suggestions whose stored evidence was removed. */
  cancelled: [] as string[],
  evidenceRemoved: [] as string[],
  cleanupFails: false,
  /** A withdrawal (45 § 5.2): the requests written, the take-backs, the signals, and the door's or the record's answers when a case sets them. */
  withdrawals: [] as Array<{ id: string; at: Date }>,
  takenBack: [] as string[],
  /** The instants the take-backs named. */
  takenBackAt: [] as string[],
  withdrawnSignals: [] as Array<{ workflowId: string; withdrawn: unknown }>,
  requestAnswer: null as WithdrawalRequested | null,
  takeBackFinds: true,
  /** How many looks at the ledger find no record before one is there; never, when Infinity. */
  recordAfter: 0,
  looks: [] as string[],
  /** A look at the ledger that fails, after the signal was delivered. */
  recordFails: false,
  /** Live suggestions by their proposal key (48 § 8.5), and the ids the caller may be told. */
  live: [] as Array<{ key: string; id: string }>,
  visible: [] as string[],
};

/** The door's reading rule (29 § 4.1): one's own in any state; a curator's parts past draft. */
function readable(user: SessionUser, row: SuggestionForUser): boolean {
  if (row.userId === user.id) return true;
  return user.role === "CURATOR" && row.state !== "DRAFT" && row.parts.some((part) => user.parts.includes(part));
}

const deps: SuggestionEndpointDeps = {
  standing: async () => ({ throttledUntil: fake.throttledUntil, provenanceConsentAt: fake.consentAt }),
  readMerged: async (id) => fake.rows.find((entry) => entry.id === id && entry.state === "MERGED") ?? null,
  release: async () => ({ id: "2026.09" }),
  anchor: async (kind, id) => {
    const anchor = fake.anchors[`${kind}:${id}`];
    return anchor === undefined ? null : anchor;
  },
  rubric: async () => fake.rubricRow,
  loadRubric: () => fake.loaded,
  rubricById: async (id) => (fake.rubricRow !== null && fake.rubricRow.id === id ? fake.rubricRow : null),
  read: async (user, id) => {
    const row = fake.rows.find((entry) => entry.id === id);
    return row !== undefined && readable(user, row) ? row : null;
  },
  update: async (user, id, patch) => {
    fake.patches.push({ id, patch });
    const row = fake.rows.find((entry) => entry.id === id && entry.userId === user.id);
    if (row === undefined) return null;
    const revisable = row.state === "INTAKE_DECLINED" || ((row.state === "DECIDED" || row.state === "CURATOR_QUEUE") && row.outcome === "REQUEST_MORE");
    if (!(row.state === "DRAFT" || (patch.proposal === undefined && revisable))) return null;
    const rescored = new Map((patch.rescored ?? []).map((item) => [item.itemId, item]));
    const next = {
      ...row,
      ...(patch.rationale === undefined ? {} : { rationale: patch.rationale }),
      ...(patch.proposal === undefined ? {} : { proposal: patch.proposal.proposal, proposalKey: patch.proposal.proposalKey, changeClass: patch.proposal.changeClass, curatorReason: patch.proposal.curatorReason }),
      evidence: row.evidence.map((item) => {
        const again = rescored.get(item.id);
        return again === undefined ? item : { ...item, recency: again.recency, adjustedScore: again.adjustedScore };
      }),
    } as SuggestionForUser;
    fake.rows = fake.rows.map((entry) => (entry.id === id ? next : entry));
    return next;
  },
  remove: async (user, id) => {
    const row = fake.rows.find((entry) => entry.id === id && entry.userId === user.id && entry.state === "DRAFT");
    if (row === undefined) return { deleted: false };
    fake.rows = fake.rows.filter((entry) => entry !== row);
    return { deleted: true, items: row.evidence.map((item) => ({ id: item.id, state: item.state })) };
  },
  cancelGrading: async (itemId) => {
    if (fake.cleanupFails) throw new WorkflowsUnavailableError("connection", "the engine did not answer");
    fake.cancelled.push(itemId);
    return true;
  },
  removeEvidence: async (suggestionId) => {
    if (fake.cleanupFails) throw new Error("the store did not answer");
    fake.evidenceRemoved.push(suggestionId);
    return true;
  },
  requestWithdrawal: async (user, id, at) => {
    if (fake.requestAnswer !== null) return fake.requestAnswer;
    const row = fake.rows.find((entry) => entry.id === id && entry.userId === user.id);
    if (row === undefined) return { requested: false, state: null };
    fake.order.push(`request:${id}`);
    fake.withdrawals.push({ id, at });
    return { requested: true, at, decidedAt: row.decidedAt };
  },
  takeBackWithdrawal: async (user, id, at) => {
    fake.takenBack.push(id);
    fake.takenBackAt.push(at.toISOString());
    return fake.takeBackFinds;
  },
  signalWithdrawn: async (workflowId, withdrawn) => {
    if (fake.engine === "down") throw new WorkflowsUnavailableError("connection", "the engine did not answer");
    if (fake.engine === "gone") throw new WorkflowNotFoundError(workflowId);
    fake.order.push(`signal:${workflowId}`);
    fake.withdrawnSignals.push({ workflowId, withdrawn });
  },
  retracted: async (suggestionId, stepKey) => {
    fake.looks.push(stepKey);
    if (fake.recordFails) throw new Error("the ledger did not answer");
    return fake.looks.length > fake.recordAfter ? 4242 : null;
  },
  pause: async () => undefined,
  chapterVersion: async (chapterNumber) => ({ id: `cv-${String(chapterNumber)}`, version: "1.4.1" }),
  start: async (suggestionId) => {
    if (fake.engine === "down") throw new WorkflowsUnavailableError("connection", "the engine did not answer");
    fake.started.push(suggestionId);
    fake.order.push(`start:${suggestionId}`);
    const workflow: StartedWorkflow = { workflowId: `suggestion:${suggestionId}`, runId: "run-1" };
    return workflow;
  },
  signalRevised: async (workflowId, decidedAt) => {
    if (fake.engine === "gone") throw new WorkflowNotFoundError(workflowId);
    fake.signalled.push(`${workflowId} ${decidedAt.toISOString()}`);
  },
  consent: async () => {
    fake.order.push("consent");
    fake.consentAt = new Date("2026-10-07T12:00:00Z");
  },
  submit: async (user, id, workflowId) => {
    fake.submits.push({ id, workflowId });
    fake.order.push(`submit:${id}`);
    const row = fake.rows.find((entry) => entry.id === id && entry.userId === user.id);
    if (row === undefined) return { moved: false, state: null };
    if (row.state !== "DRAFT") return { moved: false, state: row.state };
    fake.rows = fake.rows.map((entry) => (entry.id === id ? ({ ...entry, state: "SUBMITTED", workflowId, submittedAt: new Date() } as SuggestionForUser) : entry));
    return { moved: true, state: "SUBMITTED" };
  },
  live: async (_user, key) => fake.live.find((entry) => entry.key === key)?.id ?? null,
  visible: async (_user, id) => fake.visible.includes(id),
  createDraft: async (user, draft) => {
    fake.drafts.push(draft);
    fake.serial += 1;
    const row = {
      id: `S-${String(draft.chapterNumber).padStart(2, "0")}-${String(fake.serial).padStart(4, "0")}`,
      origin: "HUMAN",
      userId: user.id,
      fromResearch: false,
      chapterNumber: draft.chapterNumber,
      chapterVersionId: draft.chapterVersionId,
      releaseId: draft.releaseId,
      parts: [...draft.parts],
      changeKind: draft.changeKind,
      changeClass: draft.changeClass,
      curatorReason: draft.curatorReason,
      proposal: null,
      proposalKey: null,
      rationale: null,
      locale: draft.locale,
      state: "DRAFT",
      outcome: null,
      score: null,
      rubricVersionId: draft.rubricVersionId,
      workflowId: null,
      createdAt: new Date(),
      submittedAt: null,
      decidedAt: null,
      closedAt: null,
      withdrawnAt: null,
      budgetResetsAt: null,
      anchor: { ...draft.anchor },
      merge: null,
      evidence: [],
      sensorVerdicts: [],
      adjudication: null,
      criteria: [],
    };
    fake.rows.push(row as unknown as SuggestionForUser);
    return row as unknown as SuggestionForUser;
  },
  now: () => new Date("2026-10-06T12:00:00Z"),
};

const log: Array<{ kind: string; detail?: unknown }> = [];
const pipeline = (session: SessionUser | null, allow = true, consume = true): HandlerDeps => ({
  sessionFromRequest: async () => session,
  authorize: async () => (allow ? { allow: true } : { allow: false, reason: "policy" }),
  consume: async () => ({ allowed: consume, limit: 20, remaining: consume ? 19 : 0, resetS: 86_400, retryAfterS: consume ? 0 : 3_600 }),
  idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
  audit: async (event) => {
    log.push(event as { kind: string; detail?: unknown });
  },
  log: () => undefined,
});

const { suggestionCreate, suggestionRead, suggestionPatch, suggestionDelete, suggestionSubmit, suggestionWithdraw } = suggestionEndpoints(deps);
const KEY = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const HEADERS = { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.48" };
const get = (id: string, session: SessionUser | null = CONTRIBUTOR, allow = true) => handler(suggestionRead, pipeline(session, allow))(new Request(`http://localhost:3000/api/v1/suggestions/${id}`, { headers: HEADERS }), { params: { id } });
const patch = (id: string, body: unknown, session: SessionUser | null = CONTRIBUTOR, allow = true) =>
  handler(suggestionPatch, pipeline(session, allow))(new Request(`http://localhost:3000/api/v1/suggestions/${id}`, { method: "PATCH", headers: HEADERS, body: JSON.stringify(body) }), { params: { id } });
const remove = (id: string, session: SessionUser | null = CONTRIBUTOR, allow = true) => handler(suggestionDelete, pipeline(session, allow))(new Request(`http://localhost:3000/api/v1/suggestions/${id}`, { method: "DELETE", headers: HEADERS }), { params: { id } });
const submit = (id: string, body: unknown = { consent: true }, session: SessionUser | null = CONTRIBUTOR, allow = true, key: string | null = KEY) =>
  handler(suggestionSubmit, pipeline(session, allow))(new Request(`http://localhost:3000/api/v1/suggestions/${id}/submit`, { method: "POST", headers: { ...HEADERS, ...(key === null ? {} : { "idempotency-key": key }) }, body: JSON.stringify(body) }), { params: { id } });
const withdraw = (id: string, session: SessionUser | null = CONTRIBUTOR, allow = true, key: string | null = KEY) =>
  handler(suggestionWithdraw, pipeline(session, allow))(new Request(`http://localhost:3000/api/v1/suggestions/${id}/withdraw`, { method: "POST", headers: { ...HEADERS, ...(key === null ? {} : { "idempotency-key": key }) } }), { params: { id } });
const post = (body: unknown, session: SessionUser | null = CONTRIBUTOR, allow = true, consume = true, key: string | null = KEY) =>
  handler(suggestionCreate, pipeline(session, allow, consume))(
    new Request("http://localhost:3000/api/v1/suggestions", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.48", ...(key === null ? {} : { "idempotency-key": key }) },
      body: JSON.stringify(body),
    }),
    { params: {} },
  );

beforeEach(() => {
  fake.anchors = { "SECTION:21.3": SECTION, "FIGURE:F-21-03": DERIVED_FIGURE, "FIGURE:F-21-04": SCENARIO_FIGURE, "SOURCE_ROW:15.9 r12": ROW, "SECTION:35.2": OT_SECTION, "SOURCE_ROW:35.9 r2": OT_ROW };
  fake.throttledUntil = null;
  fake.rubricRow = { id: "v1.2", publishedAt: new Date("2026-07-01T00:00:00Z"), appliesAt: new Date("2026-07-01T00:00:00Z"), sha256: SHA };
  fake.loaded = LOADED;
  fake.drafts = [];
  fake.serial = 0;
  fake.rows = [];
  fake.patches = [];
  fake.started = [];
  fake.signalled = [];
  fake.submits = [];
  fake.live = [];
  fake.visible = [];
  fake.order = [];
  fake.consentAt = null;
  fake.engine = "up";
  fake.cancelled = [];
  fake.evidenceRemoved = [];
  fake.cleanupFails = false;
  fake.withdrawals = [];
  fake.takenBack = [];
  fake.takenBackAt = [];
  fake.withdrawnSignals = [];
  fake.requestAnswer = null;
  fake.takeBackFinds = true;
  fake.recordAfter = 0;
  fake.looks = [];
  fake.recordFails = false;
  log.length = 0;
});

/** A draft of the contributor's with a proposal, one graded item and a rationale: what the sensors pass. */
async function readyDraft(): Promise<string> {
  const id = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
  fake.rows = fake.rows.map((row) =>
    row.id === id
      ? ({
          ...row,
          proposal: { kind: "EDIT_TEXT", before: "retries the call", after: "tries the call again" },
          rationale: "The 2026.09 release raised the cap.",
          evidence: [{ id: "55555555-5555-4555-8555-555555555555", ordinal: 1, kind: "LINK", state: "GRADED", url: "https://x.example/", doi: null, storageKey: null, fileName: null, labRunId: null, title: null, host: "x.example", publishedOn: null, ageDays: null, fetchStatus: "opened:200", contentSha256: null, textKey: null, tier: "D", baseScore: 60, relevance: null, recency: null, independence: null, adjustedScore: 60, reason: null, gradedBy: "intake-rules", gradedAt: null }],
        } as unknown as SuggestionForUser)
      : row,
  );
  return id;
}

/** A draft of the contributor's, made as the endpoint makes one. */
async function draftOn(anchor: { kind: "SECTION" | "FIGURE" | "SOURCE_ROW"; id: string }, changeKind: string, session: SessionUser = CONTRIBUTOR): Promise<string> {
  const response = await post({ anchor, changeKind, locale: "en" }, session, true, true, crypto.randomUUID());
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

describe("POST /api/v1/suggestions: what the pipeline refuses before it runs", () => {
  it("is declared as 31 § 3 says: a session, the contributor's role, twenty a day for the contributor, an Idempotency-Key, and the policy's create", () => {
    expect(suggestionCreate).toMatchObject({ auth: "session", role: "CONTRIBUTOR", rateLimit: { key: "user", limit: 20, windowS: 86_400 }, idempotent: true });
    expect(suggestionCreate.policy.action).toBe("create");
  });

  it("is 401 with no session, 403 ROLE_REQUIRED for a reader, 403 for whoever the policy refuses, and 400 without an Idempotency-Key", async () => {
    const body = { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" };
    expect((await post(body, null)).status).toBe(401);
    const reader = await post(body, READER);
    expect(reader.status).toBe(403);
    expect(await reader.json()).toMatchObject({ code: "ROLE_REQUIRED" });
    const refused = await post(body, CONTRIBUTOR, false);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(log.map((event) => event.kind)).toContain("policy_denied");
    const noKey = await post(body, CONTRIBUTOR, true, true, null);
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(fake.drafts).toEqual([]);
  });

  it("is 429 RATE_LIMITED past twenty in a day", async () => {
    const response = await post({ anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" }, CONTRIBUTOR, true, false);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(response.headers.get("Retry-After")).toBe("3600");
  });

  it("asks the policy to create a suggestion of the contributor's own", async () => {
    const resource = await suggestionCreate.policy.resource({ params: undefined, query: undefined, body: { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" }, session: CONTRIBUTOR });
    expect(resource).toEqual({ kind: "suggestion", id: null, ownerId: CONTRIBUTOR.id, origin: "HUMAN" });
  });
});

describe("POST /api/v1/suggestions: the refusals of 31 § 3, in the API's error form", () => {
  it("422 ANCHOR_REQUIRED for a suggestion that points at nothing", async () => {
    const response = await post({ changeKind: "EDIT_TEXT", locale: "en" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "ANCHOR_REQUIRED" });
    expect(fake.drafts).toEqual([]);
  });

  it("422 CHANGE_KIND_INVALID for a pairing 30 § 4.1 does not list, naming the anchor the kind takes", async () => {
    for (const [changeKind, kind, allowed] of [
      ["SET_VALUE", "SECTION", "FIGURE"],
      ["EDIT_ROW", "FIGURE", "SOURCE_ROW"],
      ["EDIT_TEXT", "SOURCE_ROW", "SECTION"],
      ["RESTRUCTURE", "FIGURE", "SECTION"],
    ] as const) {
      const response = await post({ anchor: { kind, id: "x" }, changeKind, locale: "en" });
      expect(response.status, changeKind).toBe(422);
      expect(await response.json(), changeKind).toMatchObject({ code: "CHANGE_KIND_INVALID", detail: { changeKind, anchorKind: kind, allowed } });
    }
    expect(fake.drafts).toEqual([]);
  });

  it("422 ANCHOR_UNKNOWN for an anchor the pinned release has not, naming the release", async () => {
    const response = await post({ anchor: { kind: "SECTION", id: "99.9" }, changeKind: "EDIT_TEXT", locale: "en" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "ANCHOR_UNKNOWN", detail: { release: "2026.09" } });
  });

  it("429 SUGGESTION_THROTTLED with the date and the reason while the throttle is in the future, and nothing once it has passed", async () => {
    fake.throttledUntil = new Date("2026-10-07T12:00:00Z");
    const body = { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" };
    const throttled = await post(body);
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toMatchObject({ code: "SUGGESTION_THROTTLED", detail: { throttledUntil: "2026-10-07T12:00:00.000Z", reason: "3 declines for unverifiable evidence in 30 days" } });
    expect(fake.drafts).toEqual([]);
    fake.throttledUntil = new Date("2026-10-05T12:00:00Z");
    expect((await post(body)).status).toBe(200);
  });

  it("is a fault, not a draft, where no rubric is published or the published rubric's file differs", async () => {
    const body = { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" };
    fake.rubricRow = null;
    expect((await post(body)).status).toBe(500);
    fake.rubricRow = { id: "v1.2", publishedAt: new Date(), appliesAt: new Date(), sha256: "c".repeat(64) };
    expect((await post(body)).status).toBe(500);
    expect(fake.drafts).toEqual([]);
  });

  it("refuses a malformed body as such: a change kind the product has not, a locale it has not, a key it does not know", async () => {
    for (const body of [
      { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "REWRITE", locale: "en" },
      { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "fr" },
      { anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en", rationale: "now" },
      { anchor: { kind: "PAGE", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "en" },
    ]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json(), JSON.stringify(body)).toMatchObject({ code: "INVALID_INPUT" });
    }
  });
});

describe("POST /api/v1/suggestions: the draft", () => {
  it("resolves a section for a text edit: WORDING with 40 and 5, the anchored text and its hash, the chapter's part, the rubric in force", async () => {
    const response = await post({ anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", locale: "pt" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "S-21-0001",
      state: "DRAFT",
      changeKind: "EDIT_TEXT",
      changeClass: "WORDING",
      curatorReason: null,
      thresholds: { acceptAt: 40, floorAt: 5 },
      fastMoving: false,
      rubricVersion: "v1.2",
      anchor: { kind: "SECTION", id: "21.3", section: "21.3", currentText: SECTION.currentText, tier: null, verifiedOn: "2026-09-12T00:00:00.000Z", readBy: [] },
    });
    expect(fake.drafts[0]).toEqual({
      chapterNumber: 21,
      chapterVersionId: "cv-21",
      releaseId: "2026.09",
      parts: ["P2"],
      changeKind: "EDIT_TEXT",
      changeClass: "WORDING",
      curatorReason: null,
      locale: "PT",
      rubricVersionId: "v1.2",
      anchor: { kind: "SECTION", sectionAnchor: "21.3", figureAnchor: null, sourceRowAnchor: null, currentText: SECTION.currentText, contentSha256: "b".repeat(64), existsAtVersion: true },
    });
  });

  it("a value set on a derived figure is DERIVED_FIGURE with 100 and 100; on a scenario parameter, the curator's", async () => {
    const derived = await (await post({ anchor: { kind: "FIGURE", id: "F-21-03" }, changeKind: "SET_VALUE", locale: "en" })).json();
    expect(derived).toMatchObject({ changeClass: "DERIVED_FIGURE", curatorReason: null, thresholds: { acceptAt: 100, floorAt: 100 }, anchor: { kind: "FIGURE", id: "F-21-03", tier: "DERIVED" } });
    const scenario = await (await post({ anchor: { kind: "FIGURE", id: "F-21-04" }, changeKind: "SET_VALUE", locale: "en" })).json();
    expect(scenario).toMatchObject({ changeClass: "CURATOR_ALWAYS", curatorReason: "SCENARIO_PARAMETER", thresholds: { acceptAt: null, floorAt: null } });
  });

  it("a row edited is CITED_FIGURE, fast-moving as the row is, read by the sections of its figures, and reaches their parts too", async () => {
    const body = await (await post({ anchor: { kind: "SOURCE_ROW", id: "15.9 r12" }, changeKind: "EDIT_ROW", locale: "en" })).json();
    expect(body).toMatchObject({
      id: "S-15-0001",
      changeClass: "CITED_FIGURE",
      thresholds: { acceptAt: 70, floorAt: 25 },
      fastMoving: true,
      anchor: { kind: "SOURCE_ROW", id: "15.9 r12", section: "15.9", tier: "VENDOR", readBy: [{ section: "15.3", title: "Worked numbers" }, { section: "37.3", title: "Configuration C" }] },
    });
    expect(fake.drafts[0]?.parts).toEqual(["P1", "P3"]);
    expect(fake.drafts[0]?.anchor).toMatchObject({ sectionAnchor: "15.9", sourceRowAnchor: "15.9 r12", figureAnchor: null });
  });

  it("a row about operating equipment is the curator's from the start, by the assistant's own vocabulary; a section is judged by the passage its proposal will quote, so not yet", async () => {
    const row = await (await post({ anchor: { kind: "SOURCE_ROW", id: "35.9 r2" }, changeKind: "EDIT_ROW", locale: "en" })).json();
    expect(row).toMatchObject({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT" });
    const section = await (await post({ anchor: { kind: "SECTION", id: "35.2" }, changeKind: "EDIT_TEXT", locale: "en" })).json();
    expect(section).toMatchObject({ changeClass: "WORDING", curatorReason: null });
  });
});

describe("GET /api/v1/suggestions/{id}", () => {
  it("is the owner's draft with its anchor, thresholds, proposal, rationale, evidence, sensors and adjudication, read against the rubric it was written with", async () => {
    const id = await draftOn({ kind: "SOURCE_ROW", id: "15.9 r12" }, "EDIT_ROW");
    const response = await get(id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      id,
      own: true,
      state: "DRAFT",
      outcome: null,
      changeKind: "EDIT_ROW",
      changeClass: "CITED_FIGURE",
      thresholds: { acceptAt: 70, floorAt: 25 },
      fastMoving: true,
      rubricVersion: "v1.2",
      locale: "en",
      chapter: 15,
      release: "2026.09",
      anchor: { kind: "SOURCE_ROW", id: "15.9 r12", section: "15.9", currentText: ROW.currentText, contentSha256: ROW.contentSha256, existsAtVersion: true, readBy: [{ section: "15.3", title: "Worked numbers" }, { section: "37.3", title: "Configuration C" }] },
      proposal: null,
      rationale: null,
      score: null,
      evidence: [],
      sensors: [],
      adjudication: null,
      submittedAt: null,
    });
  });

  it("is 404 for another contributor, for a curator of another part, and for a curator of its part while it is a draft; a curator of its part reads it once submitted, as not their own", async () => {
    const id = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    expect((await get(id, OTHER)).status).toBe(404);
    expect((await get(id, { ...CURATOR_OF_P2, parts: ["P3"] })).status).toBe(404);
    expect((await get(id, CURATOR_OF_P2)).status).toBe(404);
    fake.rows = fake.rows.map((row) => (row.id === id ? ({ ...row, state: "SUBMITTED" } as SuggestionForUser) : row));
    const curator = await get(id, CURATOR_OF_P2);
    expect(curator.status).toBe(200);
    expect(await curator.json()).toMatchObject({ id, own: false, state: "SUBMITTED" });
    expect((await get(id, OTHER)).status).toBe(404);
  });

  it("says recency applies by the anchor's flag, or for a claim or a row added by its declaration (30 § 3.4)", async () => {
    const row = await draftOn({ kind: "SOURCE_ROW", id: "15.9 r12" }, "EDIT_ROW");
    expect(await (await get(row)).json()).toMatchObject({ fastMoving: true });
    const claim = await draftOn({ kind: "SECTION", id: "21.3" }, "ADD_CLAIM");
    expect(await (await get(claim)).json()).toMatchObject({ fastMoving: false });
    expect(await (await patch(claim, { proposal: { kind: "ADD_CLAIM", text: "Provider tier 3 cut its batch price.", placeAfter: "end", fastMoving: true } })).json()).toMatchObject({ fastMoving: true });
    expect(await (await get(claim)).json()).toMatchObject({ fastMoving: true });
    /* A row added on a stable section: its own declaration, not the section's flag, both ways. */
    const added = await draftOn({ kind: "SECTION", id: "21.3" }, "ADD_ROW");
    expect(await (await patch(added, { proposal: { kind: "ADD_ROW", claim: "batch discount, provider tier 3", citation: "Provider three pricing page", tier: "VENDOR", fastMoving: true } })).json()).toMatchObject({ fastMoving: true });
    expect(await (await patch(added, { proposal: { kind: "ADD_ROW", claim: "batch discount, provider tier 3", citation: "Provider three pricing page", tier: "VENDOR", fastMoving: false } })).json()).toMatchObject({ fastMoving: false });
  });

  it("gives a merge's step error and the repository's absence in words to a curator only: the owner reads the step, its code and the state, not the server's folders (54b)", async () => {
    const id = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    const at = "2026-10-09T10:00:00.000Z";
    const set = (check: unknown) => {
      fake.rows = fake.rows.map((row) => (row.id === id ? ({ ...row, state: "MERGING", outcome: "ACCEPT", merge: { branch: `improve/${id}`, commitSha: null, versionFrom: "1.4.1", versionTo: null, bump: "patch", releaseFrom: "2026.09", releaseTo: null, mergedAt: null, revertedBy: null, check } } as unknown as SuggestionForUser) : row));
    };
    set({ stage: "ERROR", at, step: "prepare", code: "GIT_FAILED", message: "fatal: C:/srv/book is not a working tree" });
    expect((await (await get(id)).json()).merge.check).toEqual({ stage: "ERROR", at, step: "prepare", code: "GIT_FAILED", message: "" });
    expect((await (await get(id, CURATOR_OF_P2)).json()).merge.check).toMatchObject({ code: "GIT_FAILED", message: "fatal: C:/srv/book is not a working tree" });
    set({ stage: "UNAVAILABLE", at, reason: "BOOK_REPO_DIR names C:/srv/book, which does not exist (feature-specs/37 § 3)." });
    expect((await (await get(id)).json()).merge.check).toEqual({ stage: "UNAVAILABLE", at, reason: "" });
    expect((await (await get(id, CURATOR_OF_P2)).json()).merge.check.reason).toContain("C:/srv/book");
  });

  it("is 404 for an id of the right form that is nobody's, 400 for one of the wrong form, and 401 signed out", async () => {
    expect((await get("S-21-9999")).status).toBe(404);
    expect((await get("nonsense")).status).toBe(400);
    expect((await get("S-21-0001", null)).status).toBe(401);
  });

  it("asks the policy to read the suggestion with its owner, parts, class and origin", async () => {
    const id = await draftOn({ kind: "SOURCE_ROW", id: "15.9 r12" }, "EDIT_ROW");
    const resource = await suggestionRead.policy.resource({ params: { id: id as SuggestionId }, query: undefined, body: undefined, session: CONTRIBUTOR });
    expect(resource).toEqual({ kind: "suggestion", id, ownerId: CONTRIBUTOR.id, parts: ["P1", "P3"], changeClass: "CITED_FIGURE", origin: "HUMAN" });
    const refused = await get(id, CONTRIBUTOR, false);
    expect(refused.status).toBe(403);
  });
});

describe("PATCH /api/v1/suggestions/{id}", () => {
  it("writes the proposal with its key and the class recomputed from it, and the rationale; the response carries the class and thresholds again", async () => {
    const id = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    const proposal = { kind: "EDIT_TEXT", before: "three times", after: "four times" } as const;
    const response = await patch(id, { proposal, rationale: "The 2026.09 release raised the cap." });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, changeClass: "WORDING", curatorReason: null, thresholds: { acceptAt: 40, floorAt: 5 }, proposal, rationale: "The 2026.09 release raised the cap." });
    expect(fake.patches[0]?.patch).toEqual({
      rationale: "The 2026.09 release raised the cap.",
      proposal: { proposal, proposalKey: proposalKeyOf({ kind: "SECTION", sectionAnchor: "21.3", figureAnchor: null, sourceRowAnchor: null, contentSha256: SECTION.contentSha256 }, proposal), changeClass: "WORDING", curatorReason: null },
    });
  });

  it("makes a text edit the curator's when the passage it quotes or the text it proposes is about operating equipment (31 § 10.2), and a row the curator's for a tier the book has not", async () => {
    const id = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    const quoted = await (await patch(id, { proposal: { kind: "EDIT_TEXT", before: "Force the transmitter to its last good value and bypass the interlock.", after: "Keep it." } })).json();
    expect(quoted).toMatchObject({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT" });
    const proposed = await (await patch(id, { proposal: { kind: "EDIT_TEXT", before: "three times", after: "When the historian lags, write the setpoint to the PLC directly." } })).json();
    expect(proposed).toMatchObject({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT" });
    const back = await (await patch(id, { proposal: { kind: "EDIT_TEXT", before: "three times", after: "four times" } })).json();
    expect(back).toMatchObject({ changeClass: "WORDING", curatorReason: null });

    const row = await draftOn({ kind: "SECTION", id: "21.3" }, "ADD_ROW");
    const newTier = await (await patch(row, { proposal: { kind: "ADD_ROW", claim: "A regulator's guidance.", citation: "Regulator, 2026", tier: { newTier: "REGULATOR" }, fastMoving: false } })).json();
    expect(newTier).toMatchObject({ changeClass: "CURATOR_ALWAYS", curatorReason: "NEW_SOURCE_TIER" });
    const known = await (await patch(row, { proposal: { kind: "ADD_ROW", claim: "A paper.", citation: "Authors, 2026", tier: "PRIMARY", fastMoving: false } })).json();
    expect(known).toMatchObject({ changeClass: "NEW_CLAIM", curatorReason: null, thresholds: { acceptAt: 85, floorAt: 40 } });
  });

  it("scores graded items again when a claim's declaration moves their recency, in the same write, and back when it is unticked (30 § 3.4; 34 § 24)", async () => {
    const id = await draftOn({ kind: "SECTION", id: "21.3" }, "ADD_CLAIM");
    const graded = { ordinal: 1, kind: "LINK", state: "GRADED", url: "https://journal.example/paper", doi: null, storageKey: null, fileName: null, labRunId: null, title: "A paper", host: "journal.example", publishedOn: null, fetchStatus: "opened:200", contentSha256: null, textKey: null, reason: "r", gradedBy: "m", gradedAt: null };
    const old = { ...graded, id: "55555555-5555-4555-8555-555555555555", tier: "B", baseScore: 85, relevance: 1, recency: 1, independence: 1, adjustedScore: 85, ageDays: 1100 };
    const fresh = { ...graded, id: "66666666-6666-4666-8666-666666666666", ordinal: 2, tier: "D", baseScore: 60, relevance: 1, recency: 1, independence: 1, adjustedScore: 60, ageDays: 12 };
    fake.rows = fake.rows.map((row) => (row.id === id ? ({ ...row, evidence: [old, fresh] } as unknown as SuggestionForUser) : row));
    const claim = { kind: "ADD_CLAIM", text: "Provider tier 3 cut its batch price.", placeAfter: "end" } as const;

    const ticked = await (await patch(id, { proposal: { ...claim, fastMoving: true } })).json();
    expect(fake.patches.at(-1)?.patch.rescored).toEqual([{ itemId: old.id, recency: 0.3, adjustedScore: 25 }]);
    expect(ticked).toMatchObject({ fastMoving: true, evidence: [{ id: old.id, recency: 0.3, adjustedScore: 25 }, { id: fresh.id, recency: 1, adjustedScore: 60 }] });

    /* Saved again as it is: nothing to score again. */
    await patch(id, { proposal: { ...claim, fastMoving: true } });
    expect(fake.patches.at(-1)?.patch.rescored).toBeUndefined();

    const unticked = await (await patch(id, { proposal: { ...claim, fastMoving: false } })).json();
    expect(fake.patches.at(-1)?.patch.rescored).toEqual([{ itemId: old.id, recency: 1, adjustedScore: 85 }]);
    expect(unticked).toMatchObject({ fastMoving: false, evidence: [{ id: old.id, recency: 1, adjustedScore: 85 }, { id: fresh.id, recency: 1 }] });
  });

  it("keeps a derived figure's class from the draft where the release no longer has the figure", async () => {
    const id = await draftOn({ kind: "FIGURE", id: "F-21-03" }, "SET_VALUE");
    fake.anchors = {};
    const body = await (await patch(id, { proposal: { kind: "SET_VALUE", after: "4", unit: null } })).json();
    expect(body).toMatchObject({ changeClass: "DERIVED_FIGURE", thresholds: { acceptAt: 100, floorAt: 100 } });
  });

  it("is idempotent by content: the same patch twice is the same suggestion, with no key asked for", async () => {
    const id = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    const body = { proposal: { kind: "EDIT_TEXT", before: "a", after: "b" }, rationale: "r" };
    const first = await (await patch(id, body)).json();
    const second = await (await patch(id, body)).json();
    expect(second).toEqual(first);
    expect(suggestionPatch.idempotent).toBeUndefined();
  });

  it("refuses a proposal of another kind than the draft's, a malformed proposal, and an empty row edit", async () => {
    const id = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    const wrongKind = await patch(id, { proposal: { kind: "SET_VALUE", after: "4", unit: null } });
    expect(wrongKind.status).toBe(422);
    expect(await wrongKind.json()).toMatchObject({ code: "CHANGE_KIND_INVALID", detail: { changeKind: "EDIT_TEXT", proposalKind: "SET_VALUE" } });
    for (const proposal of [
      { kind: "EDIT_TEXT", before: "", after: "b" },
      { kind: "EDIT_TEXT", before: "a" },
      { kind: "SET_VALUE", after: "four", unit: null },
      { kind: "EDIT_ROW" },
      { kind: "ADD_CLAIM", text: "x", placeAfter: "end" },
      { kind: "ADD_ROW", claim: "x", citation: "y", tier: "GOSSIP", fastMoving: false },
      { kind: "ADD_ROW", claim: "x", citation: "y", tier: "PRIMARY", fastMoving: false, doi: "not-a-doi" },
    ]) {
      const response = await patch(id, { proposal });
      expect(response.status, JSON.stringify(proposal)).toBe(400);
      expect(await response.json(), JSON.stringify(proposal)).toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(fake.patches).toEqual([]);
  });

  it("writes a rationale on a suggestion open for revision and refuses a proposal there; refuses both on one that is submitted; is 404 on another's", async () => {
    const id = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    fake.rows = fake.rows.map((row) => (row.id === id ? ({ ...row, state: "INTAKE_DECLINED" } as SuggestionForUser) : row));
    expect((await patch(id, { rationale: "More evidence attached." })).status).toBe(200);
    const proposal = await patch(id, { proposal: { kind: "EDIT_TEXT", before: "a", after: "b" } });
    expect(proposal.status).toBe(409);
    expect(await proposal.json()).toMatchObject({ code: "CONFLICT", detail: { state: "INTAKE_DECLINED" } });

    fake.rows = fake.rows.map((row) => (row.id === id ? ({ ...row, state: "SUBMITTED" } as SuggestionForUser) : row));
    expect((await patch(id, { rationale: "x" })).status).toBe(409);
    expect((await patch(id, { rationale: "x" }, OTHER)).status).toBe(404);
    expect((await patch(id, { rationale: "x" }, READER)).status).toBe(403);
  });
});

describe("DELETE /api/v1/suggestions/{id}", () => {
  it("deletes the owner's draft, then it is gone; refuses a submitted suggestion and another's", async () => {
    const id = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    expect((await remove(id, OTHER)).status).toBe(404);
    const deleted = await remove(id);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id, deleted: true });
    expect((await get(id)).status).toBe(404);
    expect((await remove(id)).status).toBe(404);

    const kept = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    fake.rows = fake.rows.map((row) => (row.id === kept ? ({ ...row, state: "SUBMITTED" } as SuggestionForUser) : row));
    const refused = await remove(kept);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "CONFLICT", detail: { state: "SUBMITTED" } });
    expect((await get(kept)).status).toBe(200);
    /* a refused delete cleans up nothing */
    expect(fake.evidenceRemoved).toEqual([id]);
  });

  it("takes what the draft stored: each pending item's grading cancelled, every object under its prefix removed; a cleanup that fails still answers the delete (45 § 4)", async () => {
    const GRADED = "4f1c9a2e-0000-4000-8000-000000000001";
    const PENDING = "4f1c9a2e-0000-4000-8000-000000000002";
    const withItems = (id: string): void => {
      fake.rows = fake.rows.map((row) => (row.id === id ? ({ ...row, evidence: [{ id: GRADED, state: "GRADED" }, { id: PENDING, state: "PENDING" }] } as unknown as SuggestionForUser) : row));
    };
    const id = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    withItems(id);
    const deleted = await remove(id);
    expect(deleted.status).toBe(200);
    expect(fake.cancelled).toEqual([PENDING]);
    expect(fake.evidenceRemoved).toEqual([id]);

    const second = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    withItems(second);
    fake.cleanupFails = true;
    const answered = await remove(second);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ id: second, deleted: true });
    expect((await get(second)).status).toBe(404);
  });
});

describe("POST /api/v1/suggestions/{id}/submit", () => {
  it("is declared as 31 § 6 says: a session, the contributor's role, twenty a day, an Idempotency-Key, and the policy's submit", () => {
    expect(suggestionSubmit).toMatchObject({ auth: "session", role: "CONTRIBUTOR", rateLimit: { key: "user", limit: 20, windowS: 86_400 }, idempotent: true });
    expect(suggestionSubmit.policy.action).toBe("submit");
  });

  it("submits a ready draft: the consent given now on file, then the workflow started under the suggestion's id, then the row moved", async () => {
    const id = await readyDraft();
    const response = await submit(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, state: "SUBMITTED", workflowId: `suggestion:${id}` });
    expect(fake.started).toEqual([id]);
    expect(fake.submits).toEqual([{ id, workflowId: `suggestion:${id}` }]);
    /* The consent before the start: the workflow's own move out of draft holds invariant 25 and may be first (unit 50a). */
    expect(fake.order).toEqual(["consent", `start:${id}`, `submit:${id}`]);
    expect((await get(id)).status).toBe(200);
    expect(await (await get(id)).json()).toMatchObject({ state: "SUBMITTED" });
  });

  it("checks a draft from a research finding against the live keys again at its key now: 409 PROPOSAL_DUPLICATE, the id only where it is the caller's to see, nothing started (48 § 8.5)", async () => {
    const id = await readyDraft();
    const key = "d".repeat(64);
    fake.rows = fake.rows.map((entry) => (entry.id === id ? ({ ...entry, fromResearch: true, proposalKey: key } as SuggestionForUser) : entry));
    fake.live = [{ key, id: "S-21-0900" }];
    const hidden = await submit(id);
    expect(hidden.status).toBe(409);
    expect(await hidden.json()).toMatchObject({ code: "PROPOSAL_DUPLICATE", detail: { suggestionId: null } });
    fake.visible = ["S-21-0900"];
    expect(await (await submit(id)).json()).toMatchObject({ code: "PROPOSAL_DUPLICATE", detail: { suggestionId: "S-21-0900" } });
    expect(fake.started).toEqual([]);
    /* an edit that changed the key, or no live suggestion with it: submitted as any draft */
    fake.live = [{ key: "e".repeat(64), id: "S-21-0900" }];
    expect((await submit(id)).status).toBe(200);
  });

  it("leaves a person's ordinary draft to today's rule: a live suggestion with its key does not stop it (48 § 8.5)", async () => {
    const id = await readyDraft();
    const key = "d".repeat(64);
    fake.rows = fake.rows.map((entry) => (entry.id === id ? ({ ...entry, proposalKey: key } as SuggestionForUser) : entry));
    fake.live = [{ key, id: "S-21-0900" }];
    expect((await submit(id)).status).toBe(200);
    expect(fake.started).toEqual([id]);
  });

  it("does not ask for consent already on file, and takes `consent: false` then", async () => {
    fake.consentAt = new Date("2026-09-01T00:00:00Z");
    const id = await readyDraft();
    expect((await submit(id, { consent: false })).status).toBe(200);
    expect(fake.order).toEqual([`start:${id}`, `submit:${id}`]);
  });

  it("is 422 CONSENT_REQUIRED for a first submission without consent, and nothing is started", async () => {
    const id = await readyDraft();
    const response = await submit(id, { consent: false });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(fake.started).toEqual([]);
    expect(await (await get(id)).json()).toMatchObject({ state: "DRAFT" });
  });

  it("is 422 INTAKE_<SENSOR> for the first sensor that fails, with its detail, and nothing is started or recorded", async () => {
    const bare = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    const schema = await submit(bare);
    expect(schema.status).toBe(422);
    expect(await schema.json()).toMatchObject({ code: "INTAKE_SCHEMA", detail: { sensor: "SCHEMA", data: { field: "proposal" } } });

    const ready = await readyDraft();
    fake.rows = fake.rows.map((row) => (row.id === ready ? ({ ...row, evidence: [] } as SuggestionForUser) : row));
    const evidence = await submit(ready);
    expect(evidence.status).toBe(422);
    expect(await evidence.json()).toMatchObject({ code: "INTAKE_EVIDENCE_PARSES", detail: { sensor: "EVIDENCE_PARSES", data: { items: 0 } } });

    const long = await readyDraft();
    fake.rows = fake.rows.map((row) => (row.id === long ? ({ ...row, rationale: Array.from({ length: 201 }, (_, index) => `w${String(index)}`).join(" ") } as SuggestionForUser) : row));
    const rationale = await submit(long);
    expect(rationale.status).toBe(422);
    expect(await rationale.json()).toMatchObject({ code: "INTAKE_RATIONALE_LENGTH", detail: { sensor: "RATIONALE_LENGTH", data: { words: 201 } } });

    const moved = await readyDraft();
    fake.anchors = {};
    const anchor = await submit(moved);
    expect(anchor.status).toBe(422);
    expect(await anchor.json()).toMatchObject({ code: "INTAKE_ANCHOR_EXISTS", detail: { sensor: "ANCHOR_EXISTS", detail: "21.3 does not exist at ch21 v1.4.1", data: { exists: false } } });

    expect(fake.started).toEqual([]);
    expect(fake.submits).toEqual([]);
  });

  it("is 503 WORKFLOWS_UNAVAILABLE when the engine does not answer, and the suggestion is still a draft", async () => {
    const id = await readyDraft();
    fake.engine = "down";
    const response = await submit(id);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "WORKFLOWS_UNAVAILABLE" });
    expect(fake.submits).toEqual([]);
    expect(await (await get(id)).json()).toMatchObject({ state: "DRAFT" });
  });

  it("returns the running workflow for a suggestion already submitted, and starts no second one", async () => {
    const id = await readyDraft();
    expect((await submit(id)).status).toBe(200);
    const again = await submit(id, { consent: true }, CONTRIBUTOR, true, "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, state: "SUBMITTED", workflowId: `suggestion:${id}` });
    expect(fake.started).toEqual([id]);
  });

  it("signals a revision to the running workflow instead of starting one, after the sensors pass; 409 when that workflow has ended", async () => {
    const id = await readyDraft();
    fake.rows = fake.rows.map((row) => (row.id === id ? ({ ...row, state: "INTAKE_DECLINED", workflowId: `suggestion:${id}`, decidedAt: new Date("2026-10-07T12:00:00.000Z") } as SuggestionForUser) : row));
    const response = await submit(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, state: "INTAKE_DECLINED", workflowId: `suggestion:${id}` });
    /* the decision it answers goes with it, so the run can tell it from a revision of an earlier one (33 § 20) */
    expect(fake.signalled).toEqual([`suggestion:${id} 2026-10-07T12:00:00.000Z`]);
    expect(fake.started).toEqual([]);

    fake.engine = "gone";
    const gone = await submit(id, { consent: true }, CONTRIBUTOR, true, "2f2f2f2f-2f2f-4f2f-8f2f-2f2f2f2f2f2f");
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: "CONFLICT" });
  });

  it("is 429 while throttled, 404 for another's, 403 for a reader, 400 without a key or with a body that is not { consent }", async () => {
    const id = await readyDraft();
    fake.throttledUntil = new Date("2026-10-07T12:00:00Z");
    expect((await submit(id)).status).toBe(429);
    fake.throttledUntil = null;
    expect((await submit(id, { consent: true }, OTHER)).status).toBe(404);
    expect((await submit(id, { consent: true }, READER)).status).toBe(403);
    expect((await submit(id, { consent: true }, CONTRIBUTOR, true, null)).status).toBe(400);
    expect((await submit(id, { consent: "yes" })).status).toBe(400);
    expect((await submit(id, {})).status).toBe(400);
    expect(fake.started).toEqual([]);
  });
});

describe("POST /api/v1/suggestions/{id}/withdraw (45 § 5.2)", () => {
  const DECIDED = new Date("2026-10-07T12:00:00.000Z");
  const AT = "2026-10-06T12:00:00.000Z";
  /** The owner's suggestion where a decision left it, with its running workflow. */
  const waitingAt = async (state: SuggestionForUser["state"], outcome: SuggestionForUser["outcome"], over: Partial<{ decidedAt: Date | null; origin: string }> = {}): Promise<string> => {
    const id = await draftOn({ kind: "SECTION", id: "21.3" }, "EDIT_TEXT");
    fake.rows = fake.rows.map((row) => (row.id === id ? ({ ...row, state, outcome, decidedAt: over.decidedAt === undefined ? DECIDED : over.decidedAt, workflowId: `suggestion:${id}`, ...(over.origin === undefined ? {} : { origin: over.origin }) } as SuggestionForUser) : row));
    return id;
  };

  it("is declared as 45 § 5.2 says: a session, the contributor's role, 120 a minute, an Idempotency-Key, and the policy's write", () => {
    expect(suggestionWithdraw).toMatchObject({ path: "/api/v1/suggestions/{id}/withdraw", method: "POST", auth: "session", role: "CONTRIBUTOR", idempotent: true, rateLimit: { key: "user", limit: 120, windowS: 60 } });
    expect(suggestionWithdraw.policy.action).toBe("write");
  });

  it("withdraws where its workflow waits for a person: the request on the row first, then the workflow told, then its record by the step key the workflow writes it with", async () => {
    for (const [state, outcome] of [["INTAKE_DECLINED", "DECLINE"], ["DECIDED", "REQUEST_MORE"], ["CURATOR_QUEUE", "REQUEST_MORE"], ["CURATOR_QUEUE", "CURATOR_REVIEW"]] as const) {
      fake.order = [];
      fake.looks = [];
      const id = await waitingAt(state, outcome);
      const response = await withdraw(id);
      expect(response.status, `${state} ${outcome}`).toBe(200);
      expect(await response.json()).toEqual({ id, state, ledgerSeq: 4242 });
      expect(fake.order).toEqual([`request:${id}`, `signal:suggestion:${id}`]);
      expect(fake.withdrawnSignals.at(-1)).toEqual({ workflowId: `suggestion:${id}`, withdrawn: { userId: CONTRIBUTOR.id, at: AT, decidedAt: DECIDED.toISOString() } });
      expect(fake.looks).toEqual([stepKeyOf(`suggestion:${id}`, `retracted:${AT}`)]);
    }
    expect(fake.takenBack).toEqual([]);
  });

  it("answers 202 while the workflow records it, and takes nothing back; a queue with no decision's time signals none", async () => {
    fake.recordAfter = Infinity;
    const id = await waitingAt("CURATOR_QUEUE", "CURATOR_REVIEW");
    const recording = await withdraw(id);
    expect(recording.status).toBe(202);
    expect(await recording.json()).toEqual({ id, state: "CURATOR_QUEUE", ledgerSeq: null });
    expect(fake.takenBack).toEqual([]);

    fake.recordAfter = 0;
    const timeless = await waitingAt("CURATOR_QUEUE", "CURATOR_REVIEW", { decidedAt: null });
    expect((await withdraw(timeless)).status).toBe(200);
    expect(fake.withdrawnSignals.at(-1)?.withdrawn).toMatchObject({ decidedAt: null });
  });

  it("refuses with 409 and the state where the run does not wait for a person, a researcher's proposal, and a request the door refuses; nothing is written or told", async () => {
    for (const [state, outcome] of [["SUBMITTED", null], ["DECIDED", "ACCEPT"], ["MERGING", "ACCEPT"], ["MERGED", "ACCEPT"], ["CLOSED", "DECLINE"]] as const) {
      const response = await withdraw(await waitingAt(state, outcome));
      expect(response.status, state).toBe(409);
      expect(await response.json()).toMatchObject({ code: "CONFLICT", detail: { state, outcome } });
    }
    expect((await withdraw(await waitingAt("CURATOR_QUEUE", "ACCEPT", { origin: "RESEARCHER" }))).status).toBe(409);
    expect(fake.withdrawals).toEqual([]);

    /* a curator's action of this visit stands: the door says where it is */
    fake.requestAnswer = { requested: false, state: "CURATOR_QUEUE" };
    const decided = await withdraw(await waitingAt("CURATOR_QUEUE", "CURATOR_REVIEW"));
    expect(decided.status).toBe(409);
    expect(await decided.json()).toMatchObject({ code: "CONFLICT", detail: { state: "CURATOR_QUEUE", outcome: "CURATOR_REVIEW" } });
    expect(fake.withdrawnSignals).toEqual([]);
  });

  it("takes the request back when the workflow could not be told: 409 for one that has ended, 503 for an engine that does not answer; and goes on to the record where the run already took it", async () => {
    fake.engine = "gone";
    const ended = await waitingAt("INTAKE_DECLINED", "DECLINE");
    const gone = await withdraw(ended);
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: "CONFLICT", detail: { state: "INTAKE_DECLINED", workflowId: `suggestion:${ended}` } });
    expect(fake.takenBack).toEqual([ended]);

    fake.engine = "down";
    const down = await waitingAt("INTAKE_DECLINED", "DECLINE");
    const unavailable = await withdraw(down);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "WORKFLOWS_UNAVAILABLE" });
    expect(fake.takenBack).toEqual([ended, down]);

    /* nothing left to take back: the engine took the signal as its answer was late, and the run closed it */
    fake.takeBackFinds = false;
    const late = await waitingAt("INTAKE_DECLINED", "DECLINE");
    const recorded = await withdraw(late);
    expect(recorded.status).toBe(200);
    expect(await recorded.json()).toMatchObject({ id: late, ledgerSeq: 4242 });
  });

  it("answers 202 once the signal is delivered, whatever the wait for its record meets: the run decides, and nothing is taken back (review of unit 63)", async () => {
    fake.recordFails = true;
    const id = await waitingAt("INTAKE_DECLINED", "DECLINE");
    const recording = await withdraw(id);
    expect(recording.status).toBe(202);
    expect(await recording.json()).toEqual({ id, state: "INTAKE_DECLINED", ledgerSeq: null });
    expect(fake.withdrawnSignals).toHaveLength(1);
    expect(fake.takenBack).toEqual([]);
  });

  it("sends the caller's request already standing again, with its own instant: its record awaited under that instant's key; a re-send that fails takes it back by that instant (review of unit 63)", async () => {
    const STANDING = new Date("2026-10-06T11:00:00.000Z");
    const id = await waitingAt("CURATOR_QUEUE", "CURATOR_REVIEW");
    fake.requestAnswer = { requested: true, at: STANDING, decidedAt: DECIDED };
    const again = await withdraw(id);
    expect(again.status).toBe(200);
    expect(fake.withdrawnSignals).toEqual([{ workflowId: `suggestion:${id}`, withdrawn: { userId: CONTRIBUTOR.id, at: STANDING.toISOString(), decidedAt: DECIDED.toISOString() } }]);
    expect(fake.looks).toEqual([stepKeyOf(`suggestion:${id}`, `retracted:${STANDING.toISOString()}`)]);

    fake.engine = "down";
    expect((await withdraw(id)).status).toBe(503);
    expect(fake.takenBackAt).toEqual([STANDING.toISOString()]);
  });

  it("is 404 for another's, 403 ROLE_REQUIRED for a reader, 403 for whoever the policy refuses, and 400 without an Idempotency-Key", async () => {
    const id = await waitingAt("CURATOR_QUEUE", "CURATOR_REVIEW");
    expect((await withdraw(id, OTHER)).status).toBe(404);
    const reader = await withdraw(id, READER);
    expect(reader.status).toBe(403);
    expect(await reader.json()).toMatchObject({ code: "ROLE_REQUIRED" });
    const refused = await withdraw(id, CONTRIBUTOR, false);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "FORBIDDEN" });
    const noKey = await withdraw(id, CONTRIBUTOR, true, null);
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(fake.withdrawals).toEqual([]);
  });
});
