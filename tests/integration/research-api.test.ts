import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { researchEndpoints, START_IN_FLIGHT_MS, type ResearchEndpointDeps } from "@/lib/api/endpoints/research";
import { defaultDeps, handler, type HandlerDeps } from "@/lib/api/handler";
import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { appendAssistantMessage, appendUserMessage, createConversation } from "@/lib/db/assistant";
import { getPrisma } from "@/lib/db/client";
import { chaptersPassed } from "@/lib/db/content";
import { Prisma } from "@/lib/db/generated/client";
import { researchErasedStepKeyOf } from "@/lib/db/ledger";
import {
  abandonConversationRun,
  createConversationRun,
  createResearchConversation,
  dailyLimitUntil,
  deleteResearchConversation,
  flagResearchRun,
  latestBudgetReset,
  newestConversationRun,
  readResearchConversation,
  readResearchConversationView,
  readResearchRunView,
  readRunSeed,
  readSeedFacts,
  researchRecordSeqs,
  researchStartGates,
  runsStartedSince,
  writeResearchState,
} from "@/lib/db/research";
import { currentRelease } from "@/lib/db/shared";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { questionSha256Of } from "@/lib/research/question";
import { ResearchConversationViewSchema, ResearchRunViewSchema } from "@/lib/schemas/api";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";
import { RESEARCH_RUNS_PER_DAY } from "@/lib/schemas/research";
import { processSecrets } from "@/lib/security/processSecrets";
import { WorkflowsUnavailableError } from "@/lib/workflows/client";

/*
 * A person's research through its endpoints against the database (feature-specs/48 § 5.2, § 13, § 16, § 17.2; unit 71),
 * the policy allowing and the engine doubled — no workflow is started on the real engine, whose workers would run it on
 * the stub — and the `ERASED` append doubled, which tests/contract/api.test.ts appends for real through the policy. The
 * start's checks in order with the rows they leave: a question a rule refuses is a `REFUSED` run with no workflow and is
 * not counted; the thirty-first is 429; a run that met the cap is 402; a run under way is 409, and one whose workflow is
 * gone is ended `FAILED · ABANDONED` and the start goes on — but a `QUEUED` row young enough to be another start in
 * flight is a 409 and left alone, and a row that moved since it was read is left as it stands (review of unit 71); a
 * deletion request is 403; an engine that refuses the start leaves the row `SKIPPED · UNAVAILABLE`, uncounted. Two
 * starts at once are one run. A seeded research's runs are seeded until one plans: the question asked after one a rule
 * refused still reads the seed, and the one after a run that planned is a follow-up. The delete detaches a run under way without its text and takes the rest; a start
 * that loses the lock to it answers 404. The views hold no invalid finding and number the rest; a second flag is the
 * first read back, before and after the 30 days take the report.
 */

const ready = env.DATABASE_URL !== undefined;
const ORGANISATION = "00000000-0000-4000-8000-0000000a7100";
const ASKER: SessionUser = { id: "00000000-0000-4000-8000-0000000a7101", organisationId: null, role: "READER", displayName: "API Asker", locale: "en", identityVerified: false, parts: [], sessionId: null };
const OTHER: SessionUser = { id: "00000000-0000-4000-8000-0000000a7102", organisationId: null, role: "READER", displayName: "API Other", locale: "en", identityVerified: false, parts: [], sessionId: null };
const MEMBER: SessionUser = { id: "00000000-0000-4000-8000-0000000a7103", organisationId: ORGANISATION, role: "READER", displayName: "API Member", locale: "en", identityVerified: false, parts: [], sessionId: null };
const USERS = [ASKER, OTHER, MEMBER];
const TRACE = "a7".repeat(16);
const DAY = 86_400_000;
const QUESTION = "What changed in how long idempotency keys are kept since the book was verified?";

/** The engine as the endpoints see it: the workflows started, which run until the case says otherwise. */
const engine = { running: new Set<string>(), started: [] as string[], refuses: false };
const erased: Array<{ readonly stepKey: string; readonly seq: number }> = [];

const DEPS: ResearchEndpointDeps = {
  seed: readSeedFacts,
  open: createResearchConversation,
  conversation: readResearchConversation,
  conversationView: readResearchConversationView,
  runView: readResearchRunView,
  newestRun: newestConversationRun,
  running: async (workflowId) => engine.running.has(workflowId),
  abandon: abandonConversationRun,
  writeState: writeResearchState,
  gates: researchStartGates,
  budgetReset: latestBudgetReset,
  dailyLimit: dailyLimitUntil,
  configured: () => true,
  release: async () => (await currentRelease()).id,
  chaptersPassed,
  secrets: processSecrets,
  createRun: createConversationRun,
  start: async (workflowId) => {
    if (engine.refuses) throw new WorkflowsUnavailableError("connection", "the workflow engine could not be reached");
    engine.started.push(workflowId);
    engine.running.add(workflowId);
  },
  flag: flagResearchRun,
  remove: deleteResearchConversation,
  recorded: async (stepKey) => erased.find((record) => record.stepKey === stepKey) ?? null,
  append: async (input) => {
    const payload = input.payload as { readonly stepKey: string };
    const record = { stepKey: payload.stepKey, seq: erased.length + 1 };
    erased.push(record);
    return record;
  },
  /* the export is tests/integration/research-stats.test.ts's, which signs a file and verifies it */
  records: researchRecordSeqs,
  exportFile: async () => {
    throw new Error("this suite exports nothing");
  },
  now: () => new Date(),
};

/** The pipeline with its session and its policy given, its rate open; idempotency is the real table's. */
function pipeline(user: SessionUser): HandlerDeps {
  return { ...defaultDeps, sessionFromRequest: async () => user, authorize: async () => ({ allow: true }), consume: async () => ({ allowed: true, limit: 20, remaining: 19, resetS: 60, retryAfterS: 0 }), audit: async () => undefined, log: () => undefined };
}

const BASE = "http://localhost:3000";
const HEADERS = { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.72" };

function api(deps: ResearchEndpointDeps = DEPS) {
  const endpoints = researchEndpoints(deps);
  return {
    open: (user: SessionUser, body: unknown) => handler(endpoints.researchConversationCreate, pipeline(user))(new Request(`${BASE}/api/v1/research/conversations`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) })),
    start: (user: SessionUser, id: string, question = QUESTION, key: string = randomUUID()) =>
      handler(endpoints.researchRunStart, pipeline(user))(new Request(`${BASE}/api/v1/research/conversations/${id}/runs`, { method: "POST", headers: { ...HEADERS, "idempotency-key": key }, body: JSON.stringify({ question, language: "en" }) }), { params: { id } }),
    read: (user: SessionUser, id: string) => handler(endpoints.researchConversationRead, pipeline(user))(new Request(`${BASE}/api/v1/research/conversations/${id}`, { headers: HEADERS }), { params: { id } }),
    run: (user: SessionUser, id: string) => handler(endpoints.researchRunRead, pipeline(user))(new Request(`${BASE}/api/v1/research/runs/${id}`, { headers: HEADERS }), { params: { id } }),
    flag: (user: SessionUser, id: string, body: unknown) => handler(endpoints.researchRunFlag, pipeline(user))(new Request(`${BASE}/api/v1/research/runs/${id}/flag`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) }), { params: { id } }),
    remove: (user: SessionUser, id: string) => handler(endpoints.researchConversationDelete, pipeline(user))(new Request(`${BASE}/api/v1/research/conversations/${id}`, { method: "DELETE", headers: HEADERS }), { params: { id } }),
  };
}

const API = api();

async function opened(user: SessionUser, body: unknown = { locale: "en" }): Promise<string> {
  const response = await API.open(user, body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function started(user: SessionUser, id: string, question = QUESTION): Promise<{ readonly runId: string; readonly state: string }> {
  const response = await API.start(user, id, question);
  expect(response.status, await response.clone().text()).toBe(202);
  return (await response.json()) as { runId: string; state: string };
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

async function wipe(user: SessionUser): Promise<void> {
  await withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    await prisma.researchFinding.deleteMany({});
    await prisma.researchRun.deleteMany({});
    await prisma.researchConversation.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    const ids = (await prisma.message.findMany({ select: { id: true } })).map((message) => message.id);
    await prisma.citation.deleteMany({ where: { messageId: { in: ids } } });
    await prisma.sensorVerdict.deleteMany({ where: { messageId: { in: ids } } });
    await prisma.message.deleteMany({ where: { id: { in: ids } } });
    await prisma.conversation.deleteMany({});
  });
}

/** An answer of the reader's that replaced one claim, citing 21.3 and 21.4; or a refusal. */
function answerResult(refused: boolean): AnswerResult {
  return {
    kind: refused ? "refusal" : "answer",
    refusal: refused ? { cause: "R-SCOPE", code: "R-SCOPE", pointers: [], beforeRetrieval: true } : null,
    claims: refused
      ? []
      : [
          { text: "A retried write without a key is a second write.", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false },
          { text: "The book does not say how long a key is kept.", sectionId: parseSectionId("21.4"), figureId: null, valueText: null, found: false, substituted: true },
        ],
    citations: refused ? [] : [{ sectionId: parseSectionId("21.3"), figureId: null, version: "v1.0.0", editionLang: "EN" }, { sectionId: parseSectionId("21.4"), figureId: null, version: "v1.0.0", editionLang: "EN" }],
    verdicts: [],
    grounded: refused ? null : 1,
    repaired: false,
    guide: { version: "v1.13", sha256: "a".repeat(64) },
    modelId: "claude-opus-5",
    timings: { scopeMs: 1, retrieveMs: 200, firstTokenMs: 900, draftMs: 3000, sensorsMs: 5, graderMs: 800, totalMs: 4100 },
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 },
    modeResult: null,
    uncovered: [],
    retrievedSections: ["21.3", "21.4"],
  } as AnswerResult;
}

async function answerOf(user: SessionUser, refused = false): Promise<string> {
  const conversation = await createConversation(user, { locale: "en" });
  const asked = await appendUserMessage(user, conversation.id, { text: "How long is an idempotency key kept?", mode: "explain", traceId: TRACE });
  return (await appendAssistantMessage(user, conversation.id, answerResult(refused), { ordinal: asked.ordinal + 1, mode: "EXPLAIN", traceId: TRACE, promptSha256: "b".repeat(64), overBudget: false, ledger: null })).id;
}

const runRow = (user: SessionUser, id: string) => withTenant(tenantOf(user), () => getPrisma().researchRun.findUniqueOrThrow({ where: { id }, select: { conversationId: true, ordinal: true, state: true, skip: true, failure: true, refusal: true, workflowId: true, question: true, questionSha256: true, gap: true, sectionAnchors: true, textPurgedAt: true, flaggedAt: true } }));

/** A run's start dated past the minute a start in flight is given (`START_IN_FLIGHT_MS`): a row its web tier left. */
const aged = (user: SessionUser, id: string) => withTenant(tenantOf(user), () => getPrisma().researchRun.update({ where: { id }, data: { createdAt: new Date(Date.now() - START_IN_FLIGHT_MS - 5_000) } }));

/** A promise and the hand that settles it, for a step a case holds open. */
function held(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe.skipIf(!ready)("a person's research through its endpoints, against the database (48 § 5.2, § 13, § 17.2)", () => {
  beforeAll(async () => {
    await getPrisma().organisation.upsert({ where: { id: ORGANISATION }, create: { id: ORGANISATION, name: "Research API fixture", seatLimit: 1, tokenCap: BigInt(1_000_000), ideMinutesCap: 0, tokensPerMinute: 1000, researchEnabled: false }, update: { researchEnabled: false } });
    await withSystem(async () => {
      for (const user of USERS) await getPrisma().user.upsert({ where: { id: user.id }, update: { deletionRequestedAt: null, organisationId: user.organisationId }, create: { id: user.id, email: `${user.id}@research-api.test`, displayName: user.displayName, role: "READER", organisationId: user.organisationId } });
    });
    for (const user of USERS) await wipe(user);
  });

  afterAll(async () => {
    for (const user of USERS) await wipe(user);
    await withSystem(() => getPrisma().user.deleteMany({ where: { id: { in: USERS.map((user) => user.id) } } }));
    await getPrisma().organisation.deleteMany({ where: { id: ORGANISATION } });
  });

  it("opens a research, starts a run QUEUED with its workflow, follows it, and replays the same key's start without a second run", async () => {
    const id = await opened(ASKER);
    const key = randomUUID();
    const first = await API.start(ASKER, id, QUESTION, key);
    expect(first.status).toBe(202);
    const body = (await first.json()) as { runId: string; state: string };
    expect(body.state).toBe("QUEUED");
    expect(engine.started).toContain(`research:${body.runId}`);
    expect(await runRow(ASKER, body.runId)).toMatchObject({ conversationId: id, ordinal: 1, state: "QUEUED", workflowId: `research:${body.runId}`, question: QUESTION, questionSha256: questionSha256Of(QUESTION), gap: false, sectionAnchors: [] });

    /* the same key: the stored start, after the research is found; nothing new */
    const again = await API.start(ASKER, id, QUESTION, key);
    expect(again.status).toBe(202);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await again.json()).toEqual(body);

    /* another key while it runs: 409, and its view reads queued */
    const busy = await API.start(ASKER, id);
    expect(busy.status).toBe(409);
    expect(await codeOf(busy)).toBe("RESEARCH_IN_PROGRESS");
    const view = await API.run(ASKER, body.runId);
    expect(view.status).toBe(200);
    expect(ResearchRunViewSchema.parse(await view.json())).toMatchObject({ id: body.runId, conversationId: id, ordinal: 1, question: QUESTION, state: "QUEUED", line: { key: "queued", tone: "run" }, stale: false, seeded: false, findings: [], pages: [] });
    const research = await API.read(ASKER, id);
    expect(((await research.json()) as { runs: Array<{ id: string }> }).runs.map((run) => run.id)).toEqual([body.runId]);

    /* another person's research and run are absent */
    expect((await API.read(OTHER, id)).status).toBe(404);
    expect((await API.run(OTHER, body.runId)).status).toBe(404);
    expect((await API.start(OTHER, id)).status).toBe(404);
  });

  it("ends a run whose workflow no longer runs FAILED · ABANDONED, and the next start is the research's next run", async () => {
    const id = await opened(ASKER);
    const { runId } = await started(ASKER, id);
    engine.running.delete(`research:${runId}`);
    /* younger than a start's request, a QUEUED row the engine does not know may be a start in flight: left alone */
    const young = await API.start(ASKER, id, "And for refunds?");
    expect(young.status).toBe(409);
    expect(await runRow(ASKER, runId)).toMatchObject({ state: "QUEUED", failure: null });
    /* past it, its web tier is gone: ended, and the start goes on */
    await aged(ASKER, runId);
    const next = await started(ASKER, id, "And for refunds?");
    expect(await runRow(ASKER, runId)).toMatchObject({ state: "FAILED", failure: "ABANDONED" });
    expect(await runRow(ASKER, next.runId)).toMatchObject({ ordinal: 2, state: "QUEUED" });
  });

  it("answers a second start 409 while the first's engine call is in flight, leaving the first's row alone, and the first 202 (review of unit 71)", async () => {
    const id = await opened(ASKER);
    const committed = held();
    const engineCall = held();
    const first = api({
      ...DEPS,
      createRun: async (user, input, now) => {
        const created = await createConversationRun(user, input, now);
        committed.release();
        return created;
      },
      /* the engine has not had the first's start yet: it says nothing runs under the id */
      start: async (workflowId) => {
        await engineCall.promise;
        engine.started.push(workflowId);
        engine.running.add(workflowId);
      },
    }).start(ASKER, id);
    await committed.promise;
    const [row] = await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.findMany({ where: { conversationId: id }, select: { id: true } }));
    expect(engine.running.has(`research:${row?.id ?? ""}`)).toBe(false);
    const second = await API.start(ASKER, id, "And for refunds?");
    expect(second.status).toBe(409);
    expect(await codeOf(second)).toBe("RESEARCH_IN_PROGRESS");
    expect(await runRow(ASKER, row?.id ?? "")).toMatchObject({ state: "QUEUED", failure: null });
    engineCall.release();
    const answered = await first;
    expect(answered.status).toBe(202);
    expect(await answered.json()).toEqual({ runId: row?.id, state: "QUEUED" });
    expect(await runRow(ASKER, row?.id ?? "")).toMatchObject({ state: "QUEUED", failure: null });
    expect(await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.count({ where: { conversationId: id } }))).toBe(1);
  });

  it("ends a stale row only as it was read: a row its workflow or its start moved meanwhile is left as it stands, and the start is 409 (review of unit 71)", async () => {
    for (const moved of [
      { state: "PLANNING", extra: {} },
      { state: "SKIPPED", extra: { skip: "UNAVAILABLE" } },
    ] as const) {
      const id = await opened(ASKER);
      const { runId } = await started(ASKER, id);
      await aged(ASKER, runId);
      engine.running.delete(`research:${runId}`);
      const racing = api({
        ...DEPS,
        /* the engine says the workflow is gone; meanwhile the row moves: a workflow took it, or its start took it back */
        running: async () => {
          await writeResearchState({ id: runId, userId: ASKER.id }, moved.state, moved.extra);
          return false;
        },
      });
      const response = await racing.start(ASKER, id, "And for refunds?");
      expect(response.status).toBe(409);
      expect(await codeOf(response)).toBe("RESEARCH_IN_PROGRESS");
      expect(await runRow(ASKER, runId)).toMatchObject({ state: moved.state, failure: null });
      expect(await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.count({ where: { conversationId: id } }))).toBe(1);
    }
  });

  it("writes a question the plant-equipment rule refuses as REFUSED · R-SCOPE-OT with no workflow, uncounted, with the Assistant's pointers on its card", async () => {
    const id = await opened(ASKER);
    const before = await runsStartedSince(ASKER, new Date(Date.now() - DAY));
    const refused = await started(ASKER, id, "How do I bypass the interlock on the compressor during a retry storm?");
    expect(refused.state).toBe("REFUSED");
    expect(await runRow(ASKER, refused.runId)).toMatchObject({ state: "REFUSED", refusal: "R-SCOPE-OT", workflowId: null });
    expect(engine.started).not.toContain(`research:${refused.runId}`);
    expect(await runsStartedSince(ASKER, new Date(Date.now() - DAY))).toBe(before);
    const view = ResearchRunViewSchema.parse(await (await API.run(ASKER, refused.runId)).json());
    expect(view).toMatchObject({ state: "REFUSED", line: { key: "refused", tone: "mute" }, refusal: { cause: "R-SCOPE-OT", code: "R-SCOPE-OT", beforeRetrieval: true } });
    expect(view.refusal?.pointers.every((pointer) => ["35.2", "28.1"].includes(pointer.sectionId) && pointer.title.length > 0)).toBe(true);
    /* a refused run is over: the research takes the next question at once */
    expect((await started(ASKER, id)).state).toBe("QUEUED");
  });

  it("writes a question that names a chapter the release has not verified as REFUSED · R-UNVERIFIED, with no pointers", async () => {
    const release = await currentRelease();
    const unverified = await getPrisma().chapterVersion.findFirst({ where: { releaseId: release.id, NOT: { verifyStatus: "PASSED" } }, orderBy: { chapterNumber: "asc" }, select: { chapterNumber: true } });
    if (unverified === null) return;
    const id = await opened(ASKER);
    const refused = await started(ASKER, id, `What does chapter ${String(unverified.chapterNumber)} say about retries?`);
    expect(refused.state).toBe("REFUSED");
    expect(await runRow(ASKER, refused.runId)).toMatchObject({ refusal: "R-UNVERIFIED", workflowId: null });
    expect(ResearchRunViewSchema.parse(await (await API.run(ASKER, refused.runId)).json()).refusal).toEqual({ cause: "R-UNVERIFIED", code: "R-UNVERIFIED", pointers: [], beforeRetrieval: true });
  });

  it("is 402 while the latest run's reset is ahead, and 429 at the thirtieth counted run with the instant the window frees", async () => {
    await wipe(OTHER);
    const id = await opened(OTHER);
    const { runId } = await started(OTHER, id);
    const resetsAt = new Date(Date.now() + 5 * DAY);
    await writeResearchState({ id: runId, userId: OTHER.id }, "SKIPPED", { skip: "BUDGET" });
    await withTenant(tenantOf(OTHER), () => getPrisma().researchRun.update({ where: { id: runId }, data: { budgetResetsAt: resetsAt } }));
    const capped = await API.start(OTHER, id);
    expect(capped.status).toBe(402);
    expect(await capped.json()).toMatchObject({ code: "BUDGET_EXCEEDED", detail: { resetsAt: resetsAt.toISOString() } });

    /* thirty counted runs in another research of the same person, the oldest an hour ago */
    await withTenant(tenantOf(OTHER), () => getPrisma().researchRun.update({ where: { id: runId }, data: { budgetResetsAt: null } }));
    const other = await opened(OTHER);
    const oldest = new Date(Date.now() - 3_600_000);
    await withTenant(tenantOf(OTHER), () =>
      getPrisma().researchRun.createMany({
        data: Array.from({ length: RESEARCH_RUNS_PER_DAY }, (_, index) => {
          const run = randomUUID();
          return { id: run, userId: OTHER.id, conversationId: other, ordinal: index + 1, releaseId: "2026.09", locale: "EN" as const, state: "DONE" as const, gap: false, sectionAnchors: [], questionSha256: "c".repeat(64), workflowId: `research:${run}`, traceId: TRACE, createdAt: new Date(oldest.getTime() + index * 1000) };
        }),
      }),
    );
    const full = await API.start(OTHER, id);
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ code: "RESEARCH_DAILY_LIMIT", detail: { resetsAt: new Date(oldest.getTime() + DAY).toISOString() } });
    await wipe(OTHER);
  });

  it("is 403 while the account's deletion request stands, and 403 for an organisation whose research is off", async () => {
    const id = await opened(ASKER);
    await withSystem(() => getPrisma().user.update({ where: { id: ASKER.id }, data: { deletionRequestedAt: new Date() } }));
    try {
      const deleting = await API.start(ASKER, id);
      expect(deleting.status).toBe(403);
      expect(await codeOf(deleting)).toBe("ACCOUNT_DELETION_REQUESTED");
    } finally {
      await withSystem(() => getPrisma().user.update({ where: { id: ASKER.id }, data: { deletionRequestedAt: null } }));
    }
    const member = await opened(MEMBER);
    const off = await API.start(MEMBER, member);
    expect(off.status).toBe(403);
    expect(await codeOf(off)).toBe("RESEARCH_OFF_ORGANISATION");
    expect(await withTenant(tenantOf(MEMBER), () => getPrisma().researchRun.count({ where: { conversationId: member } }))).toBe(0);
  });

  it("takes a run back to SKIPPED · UNAVAILABLE, uncounted, when the engine refuses its start, and answers 503", async () => {
    const id = await opened(ASKER);
    const before = await runsStartedSince(ASKER, new Date(Date.now() - DAY));
    engine.refuses = true;
    try {
      const response = await API.start(ASKER, id);
      expect(response.status).toBe(503);
      expect(await codeOf(response)).toBe("RESEARCH_UNAVAILABLE");
    } finally {
      engine.refuses = false;
    }
    const [run] = await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.findMany({ where: { conversationId: id }, select: { state: true, skip: true, workflowId: true } }));
    expect(run).toMatchObject({ state: "SKIPPED", skip: "UNAVAILABLE", workflowId: expect.stringMatching(/^research:/) });
    expect(await runsStartedSince(ASKER, new Date(Date.now() - DAY))).toBe(before);
    /* the person tries again: the research's next run */
    expect((await started(ASKER, id)).state).toBe("QUEUED");
  });

  it("makes two starts of one research with two keys at once one run: one 202, one 409, never a 500", async () => {
    const id = await opened(ASKER);
    const answers = await Promise.all([API.start(ASKER, id), API.start(ASKER, id)]);
    expect(answers.map((response) => response.status).sort()).toEqual([202, 409]);
    const conflict = answers.find((response) => response.status === 409);
    expect(await codeOf(conflict ?? new Response("{}"))).toBe("RESEARCH_IN_PROGRESS");
    const runs = await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.findMany({ where: { conversationId: id }, select: { state: true } }));
    expect(runs.filter((run) => run.state === "QUEUED")).toHaveLength(1);
  });

  it("seeds a research from an answer of the caller's: its first run carries the answer's gap and cited sections; another's answer or a refusal is 422 SEED_INVALID", async () => {
    const seed = await answerOf(ASKER);
    const id = await opened(ASKER, { locale: "en", seedMessageId: seed });
    const { runId } = await started(ASKER, id);
    expect(await runRow(ASKER, runId)).toMatchObject({ gap: true, sectionAnchors: ["21.3", "21.4"] });
    expect(ResearchRunViewSchema.parse(await (await API.run(ASKER, runId)).json()).seeded).toBe(true);
    for (const [user, refused] of [[OTHER, false], [ASKER, true]] as const) {
      const response = await API.open(user, { locale: "en", seedMessageId: refused ? await answerOf(ASKER, true) : seed });
      expect(response.status).toBe(422);
      expect(await codeOf(response)).toBe("SEED_INVALID");
    }
  });

  it("keeps the seed for the question asked after a first one a rule refused, and gives it to no run after one that planned (review of unit 71)", async () => {
    const seed = await answerOf(ASKER);
    const id = await opened(ASKER, { locale: "en", seedMessageId: seed });
    const refused = await started(ASKER, id, "How do I bypass the interlock on the compressor during a retry storm?");
    expect(refused.state).toBe("REFUSED");
    /* the rephrased question is still the one the seed is for: its gap, its cited sections, its planner reads the seed */
    const rephrased = await started(ASKER, id);
    const second = await runRow(ASKER, rephrased.runId);
    expect(second).toMatchObject({ ordinal: 2, gap: true, sectionAnchors: ["21.3", "21.4"] });
    expect(await readRunSeed({ userId: ASKER.id, conversationId: id, ordinal: 2 })).toMatchObject({ cited: ["21.3", "21.4"], uncovered: [] });
    expect(ResearchRunViewSchema.parse(await (await API.run(ASKER, rephrased.runId)).json()).seeded).toBe(true);

    /* it plans — its brief stored — and ends; the question after it is a follow-up, with no seed */
    await writeResearchState({ id: rephrased.runId, userId: ASKER.id }, "READING", { brief: "Look for the retention window of idempotency keys.", briefSha256: "d".repeat(64), targetAnchors: ["21.4"] });
    await writeResearchState({ id: rephrased.runId, userId: ASKER.id }, "DONE");
    const followUp = await started(ASKER, id, "And for refunds?");
    expect(await runRow(ASKER, followUp.runId)).toMatchObject({ ordinal: 3, gap: false, sectionAnchors: [] });
    expect(await readRunSeed({ userId: ASKER.id, conversationId: id, ordinal: 3 })).toBeNull();
    const views = ResearchConversationViewSchema.parse(await (await API.read(ASKER, id)).json()).runs;
    expect(views.map((view) => [view.ordinal, view.seeded])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
  });

  it("shows a done run's findings that passed the checks numbered 1 to n, never an invalid one, its pages and its report; flags its report once", async () => {
    const id = await opened(ASKER);
    const { runId } = await started(ASKER, id);
    const finding = (note: string) => ({ anchor: { kind: "SECTION", id: "21.3" }, changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "Keys are kept for 24 hours.", placeAfter: "end", fastMoving: true }, sources: [{ url: "https://docs.stripe.com/api/idempotent_requests" }], note });
    await withTenant(tenantOf(ASKER), async () => {
      const prisma = getPrisma();
      await prisma.researchRun.update({
        where: { id: runId },
        data: {
          state: "DONE",
          finishedAt: new Date(),
          brief: "Look for the retention window of idempotency keys.",
          found: { findings: [finding("Invalid one."), finding("The provider keeps keys for a day.")], pages: ["https://docs.stripe.com/api/idempotent_requests"], read: [{ url: "https://docs.stripe.com/api/idempotent_requests", title: "Idempotent requests", opened: true, search: 1 }], says: [{ url: "https://docs.stripe.com/api/idempotent_requests", says: "Keys are kept for 24 hours." }] },
          report: { paragraphs: [{ text: "The provider keeps keys for a day [1].", sections: ["21.3"], pages: [1] }], dropped: { ADDRESS: 1 } },
          targetAnchors: ["21.3"],
        },
      });
      await prisma.researchFinding.create({ data: { runId, userId: ASKER.id, ordinal: 1, outcome: "INVALID", invalidReason: "SOURCE_NOT_SEEN" } });
      await prisma.researchFinding.create({ data: { runId, userId: ASKER.id, ordinal: 2, outcome: "VALID" } });
    });
    const text = await (await API.run(ASKER, runId)).text();
    expect(text).not.toContain("Invalid one.");
    expect(text).not.toContain("Look for the retention window");
    expect(text).not.toContain("SOURCE_NOT_SEEN");
    const view = ResearchRunViewSchema.parse(JSON.parse(text));
    expect(view).toMatchObject({ state: "DONE", line: { key: "done", tone: "ok" }, report: { paragraphs: [{ text: "The provider keeps keys for a day [1].", pages: [1] }] }, pages: [{ n: 1, host: "docs.stripe.com", title: "Idempotent requests", opened: true, search: 1 }], usage: { pagesSeen: 1, costUsd: null } });
    expect(view.findings).toHaveLength(1);
    expect(view.findings[0]).toMatchObject({ n: 1, textPurged: false, anchor: { kind: "SECTION", id: "21.3", section: "21.3" }, changeKind: "ADD_CLAIM", changeClass: "NEW_CLAIM", note: "The provider keeps keys for a day.", use: { state: "VALID", suggestionId: null } });
    expect(view.sections).toMatchObject([{ id: "21.3", title: expect.any(String) }]);

    /* a kind the run contradicts is 422 while no flag stands; then one flag, and every later one the first read back */
    expect((await API.flag(ASKER, runId, { kind: "refusal", reason: "should_not_refuse" })).status).toBe(422);
    const flagged = await API.flag(ASKER, runId, { kind: "report", reason: "wrong_citation" });
    expect(flagged.status).toBe(200);
    for (const again of [{ kind: "report", reason: "other" }, { kind: "refusal", reason: "should_not_refuse" }]) {
      const duplicate = await API.flag(ASKER, runId, again);
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ code: "FLAG_DUPLICATE", detail: { kind: "report", reason: "wrong_citation" } });
    }
    expect((await API.flag(OTHER, runId, { kind: "report", reason: "other" })).status).toBe(404);
    expect(ResearchRunViewSchema.parse(await (await API.run(ASKER, runId)).json()).flag).toEqual({ kind: "report", reason: "wrong_citation" });

    /* the 30 days take the report and keep the flag (48 § 17.1): a second press is the same duplicate, never a 422 */
    await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.update({ where: { id: runId }, data: { question: null, brief: null, found: Prisma.DbNull, steps: Prisma.DbNull, report: Prisma.DbNull, textPurgedAt: new Date() } }));
    const afterDays = await API.flag(ASKER, runId, { kind: "report", reason: "other" });
    expect(afterDays.status).toBe(409);
    expect(await afterDays.json()).toMatchObject({ code: "FLAG_DUPLICATE", detail: { kind: "report", reason: "wrong_citation" } });
    expect(ResearchRunViewSchema.parse(await (await API.run(ASKER, runId)).json())).toMatchObject({ textPurged: true, report: null, flag: { kind: "report", reason: "wrong_citation" } });
  });

  it("deletes a research: a run under way detached without its text, its state untouched; a refused run gone with it; one ERASED record; 404 after", async () => {
    const id = await opened(ASKER);
    const refused = await started(ASKER, id, "How do I bypass the interlock on the compressor during a retry storm?");
    const working = await started(ASKER, id);
    const deleted = await API.remove(ASKER, id);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id, deleted: true, ledgerSeq: expect.any(Number) });
    expect(erased.filter((record) => record.stepKey === researchErasedStepKeyOf(id))).toHaveLength(1);
    expect(await runRow(ASKER, working.runId)).toMatchObject({ conversationId: null, question: null, state: "QUEUED", textPurgedAt: expect.any(Date), flaggedAt: null });
    expect(await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.count({ where: { id: refused.runId } }))).toBe(0);
    expect(await withTenant(tenantOf(ASKER), () => getPrisma().researchConversation.count({ where: { id } }))).toBe(0);
    /* the detached run is no longer the research's to show; a second delete and a start are 404 */
    expect((await API.run(ASKER, working.runId)).status).toBe(404);
    expect((await API.read(ASKER, id)).status).toBe(404);
    expect((await API.remove(ASKER, id)).status).toBe(404);
    expect((await API.start(ASKER, id)).status).toBe(404);
    /* another's delete reaches nothing */
    const kept = await opened(ASKER);
    expect((await API.remove(OTHER, kept)).status).toBe(404);
    expect(await withTenant(tenantOf(ASKER), () => getPrisma().researchConversation.count({ where: { id: kept } }))).toBe(1);
  });

  it("answers 404 to a start that loses the research's lock to its delete, and leaves no run behind", async () => {
    const id = await opened(ASKER);
    const runs = () => withTenant(tenantOf(ASKER), () => getPrisma().researchRun.count());
    const before = await runs();
    const racing = api({
      ...DEPS,
      /* the delete commits after the start's checks and before its transaction takes the lock */
      createRun: async (user, input, now) => {
        await deleteResearchConversation(user, input.conversationId, now);
        return createConversationRun(user, input, now);
      },
    });
    const response = await racing.start(ASKER, id);
    expect(response.status).toBe(404);
    expect(await runs()).toBe(before);
    expect(await withTenant(tenantOf(ASKER), () => getPrisma().researchConversation.count({ where: { id } }))).toBe(0);
  });
});
