import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FIXTURE_PAGES } from "@/infra/gateway/stub/research";
import { defaultProposalDeps, proposalEndpoints } from "@/lib/api/endpoints/proposals";
import { defaultResearchEndpointDeps, researchEndpoints, type ResearchEndpointDeps } from "@/lib/api/endpoints/research";
import { defaultResearchFindingEndpointDeps, researchFindingEndpoints, type ResearchFindingEndpointDeps } from "@/lib/api/endpoints/researchFindings";
import { defaultDeps, handler, type HandlerDeps } from "@/lib/api/handler";
import { answerOfFinal, seedsResearch, type SseFinal } from "@/lib/assistant/turns";
import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { createConversation } from "@/lib/db/assistant";
import { getPrisma } from "@/lib/db/client";
import { callerOf, readSuggestion, writeCuratorAction } from "@/lib/db/improve";
import { getImproveRecord } from "@/lib/db/improveRecord";
import { recordAt } from "@/lib/db/ledger";
import { getQueuePage } from "@/lib/db/queuePage";
import { askerOfProposal, readResearchRunView } from "@/lib/db/research";
import { getResearchLog } from "@/lib/db/researchLog";
import { loadResearchPage } from "@/lib/db/researchPage";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { decisionOf } from "@/lib/improve/curation";
import { stepKeyOf } from "@/lib/ledger/hash";
import { researchPageHref, researchPageStateOf } from "@/lib/research/links";
import { CuratorPayloadSchema, EndorsedPayloadSchema } from "@/lib/schemas/ledger";
import { evidenceSourceKey } from "@/lib/schemas/storage";
import { RESEARCH_RUN_WORKFLOW, ResearchRunWorkflowResultSchema, researchRunWorkflowId, SEND_FINDING_WORKFLOW, SendFindingWorkflowResultSchema, findingWorkflowId, SUGGESTION_CURATOR_SIGNAL, SUGGESTION_ENDORSED_SIGNAL, suggestionWorkflowId } from "@/lib/schemas/workflows";
import { sendFindingActivities } from "@/workers/activities/sendFinding";
import { chaptersVerifiedFor } from "@/workers/answer/run";
import { runTurn, type TurnEvent } from "@/workers/answer/turn";
import { OUTCOMES_EVERY } from "@/workers/research/pace";
import { defaultOutcomeStepDeps, defaultSendStepDeps } from "@/workers/research/send";

import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { clearResearchOf, RESEARCH_PRINCIPAL_DOUBLE, researchRunActivities, researchRunOnStub, startResearchStub, type ResearchStub } from "@/tests/fixtures/research/harness";

import { workflowEnvironment } from "../workflows/environment";

/*
 * The whole road of research on request, once, on the stub (feature-specs/48 § 3, § 26 unit 75; `npm run test:research`):
 * the Assistant answers, and hands nothing to research; the answer's `Start a research` leads to the Research page's
 * `?from=`, which prefills and writes nothing; the page's own endpoints open the research seeded from the answer and
 * start its run; the run, on the person's own principal, ends with a report and a finding that passed the checks; the
 * finding, sent to Improve, is opened by the product's fetcher, graded and adjudicated on the research principal and
 * proposed into the curator queue, where nobody who asked is named; the asker puts their name to it; a curator
 * accepts it. The answer is the same at the end as when it was given (invariant 31).
 *
 * The real door, the real endpoints' code with the policy allowing, the real activities on the database, the stub
 * gateway in this process (tests/fixtures/research/harness.ts) and the engine's test server: no model is asked, no
 * workflow reaches the development engine, whose workers read the web on the real provider. The engine the endpoints
 * start is noted, and the suite runs each workflow itself under the id the endpoint gave it. What follows the
 * accept — the check, the merge, a release, the history's mark and credit — is tests/integration/merge.test.ts's and
 * lib/improve/history.test.ts's (R8, spec 44 § 10): a merge publishes a release, which this database's must not.
 *
 * Until unit 75, `tests/research/` was decided (spec 43 D17) as a browser flow from an answer's hand-over to a curator's
 * accept, and never built: the stub path refuted every finding without a fixture fetcher. It is a suite of the
 * database and the engine's test server here, since a browser road would start real workflows on this machine's
 * workers; the browser half — the button, the page it opens prefilled, nothing spent — is tests/e2e/research.spec.ts's.
 */

const ready = env.DATABASE_URL !== undefined;
const ASKER: SessionUser = { id: "00000000-0000-4000-8000-0000000d7501", organisationId: null, role: "READER", displayName: "Road Asker", locale: "en", identityVerified: false, parts: [], sessionId: null };
const CURATOR_ID = "00000000-0000-4000-8000-0000000d7502";
const TRACE = "75".repeat(16);
const MARKER = "wagtailheron-7520";
/** The Assistant's question: the stream suite's, which the stub answers from 21. */
const ANSWERED = "Why does a retried write without an idempotency key become a second write?";
/** The research's question, carrying the canary word (41 § 11.3): no curator's page may hold it. */
const RESEARCHED = `How long must a server keep an idempotency key after its first response (${MARKER})?`;

/** Every run of five words of a question (43 § 13.6): none may be on a curator's page. */
function fiveWordsOf(question: string): ReadonlyArray<string> {
  const words = question.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  return words.length < 5 ? [] : words.slice(0, words.length - 4).map((_, index) => words.slice(index, index + 5).join(" "));
}

/** The pipeline with its session and its policy given, its rate open; idempotency is the real table's. */
function pipeline(user: SessionUser): HandlerDeps {
  return { ...defaultDeps, sessionFromRequest: async () => user, authorize: async () => ({ allow: true }), consume: async () => ({ allowed: true, limit: 20, remaining: 19, resetS: 60, retryAfterS: 0 }), audit: async () => undefined, log: () => undefined };
}

const BASE = "http://localhost:3000";
const HEADERS = { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.75" };

/** The workflows the endpoints started, by id: the suite runs each on the test server itself. */
const started: Array<{ readonly workflowId: string; readonly input: unknown }> = [];

const RESEARCH: ResearchEndpointDeps = {
  ...defaultResearchEndpointDeps,
  configured: () => true,
  running: async () => false,
  start: async (workflowId, input) => {
    started.push({ workflowId, input });
  },
};
const FINDINGS: ResearchFindingEndpointDeps = {
  ...defaultResearchFindingEndpointDeps,
  configured: () => true,
  send: async (findingId, userId) => {
    started.push({ workflowId: findingWorkflowId(findingId), input: { findingId, userId } });
  },
};

describe.skipIf(!ready)("the road of research on request, on the stub: an answer, its Start a research, the run, its report, the finding sent, proposed, named, and a curator's accept (48 § 26)", () => {
  const environment = workflowEnvironment();
  let stub: ResearchStub | undefined;
  let unlock: () => void = () => undefined;
  /** What each case leaves for the next: the road is one. */
  const road = { answerId: "", answerConversation: "", researchId: "", runId: "", findingId: "", suggestionId: "" };

  beforeAll(async () => {
    unlock = await acquire(LEDGER_LOCK);
    stub = await startResearchStub();
    await withSystem(async () => {
      const prisma = getPrisma();
      await prisma.user.upsert({ where: { id: ASKER.id }, update: { provenanceConsentAt: null }, create: { id: ASKER.id, email: `${ASKER.id}@research-road.test`, displayName: ASKER.displayName, role: "READER" } });
      await prisma.user.upsert({ where: { id: CURATOR_ID }, update: {}, create: { id: CURATOR_ID, email: `${CURATOR_ID}@research-road.test`, displayName: "Road Curator", role: "CURATOR", identityVerified: true } });
    });
    /* whatever an earlier run of the suite that stopped short left */
    await clearOf();
  }, 360_000);

  afterAll(async () => {
    try {
      await clearOf();
      await withSystem(() => getPrisma().user.deleteMany({ where: { id: { in: [ASKER.id, CURATOR_ID] } } }));
      await stub?.close();
    } finally {
      unlock();
    }
  });

  /** Everything of the asker's: the suggestion their finding made (back to draft and gone), their runs, researches, messages and keys. */
  async function clearOf(): Promise<void> {
    await clearResearchOf(ASKER);
    await withTenant(tenantOf(ASKER), async () => {
      const prisma = getPrisma();
      await prisma.researchFinding.deleteMany({});
      await prisma.researchRun.deleteMany({});
      await prisma.researchConversation.deleteMany({});
      await prisma.idempotencyKey.deleteMany({});
    });
  }

  function stubOf(): ResearchStub {
    if (stub === undefined) throw new Error("the stub is started in beforeAll");
    return stub;
  }

  /** The answer as the Assistant keeps it, every column and every row hanging from it. */
  const answerAsStored = () =>
    withTenant(tenantOf(ASKER), () =>
      getPrisma().message.findUniqueOrThrow({ where: { id: road.answerId }, select: { text: true, uncovered: true, retrievedSections: true, substituted: true, grounded: true, refusalCause: true, ledgerSeq: true, ledgerHash: true, modeResult: true, citations: { orderBy: { ordinal: "asc" } }, verdicts: true } }),
    );
  let answerAtFirst: Awaited<ReturnType<typeof answerAsStored>> | null = null;

  it("answers on the stub and hands nothing to research: no run row, no research call, no research in its final event; its Start a research leads to the Research page's `?from=`, which prefills and writes nothing (48 § 9.1, § 9.2, A6)", async () => {
    const conversation = await createConversation(ASKER, { locale: "en" });
    const events: TurnEvent[] = [];
    const traceId = randomUUID().replace(/-/g, "");
    await runTurn({ conversationId: conversation.id, user: ASKER, principal: { userId: ASKER.id }, text: ANSWERED, mode: "explain", context: null, aid: null, traceId }, (event) => events.push(event), { gateway: stubOf().gateway({}), chaptersVerified: chaptersVerifiedFor });
    const final = events.find((event) => event.event === "final")?.data ?? null;
    expect(final).toMatchObject({ kind: "answer", refusal: null });
    expect(final).not.toHaveProperty("research");
    const messageId = String(final?.messageId);
    road.answerId = messageId;
    road.answerConversation = conversation.id;
    expect(await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.count({}))).toBe(0);
    expect(stubOf().rows.filter((row) => row.traceId === traceId && row.kind === "RESEARCH")).toEqual([]);
    answerAtFirst = await answerAsStored();

    /* the button: offered on this turn, a link to the Research page seeded from it, as TurnActions builds it */
    const answer = answerOfFinal(final as unknown as SseFinal, "explain");
    expect(seedsResearch({ key: "1", mode: "explain", question: { text: ANSWERED, at: null }, answer })).toBe(true);
    const href = researchPageHref("en", { from: messageId });
    expect(href).toBe(`/en/research?from=${messageId}`);
    /* the page it opens: the seed's card and the question prefilled, and nothing written — no research, no run */
    const url = new URL(href, BASE);
    const page = await loadResearchPage(ASKER, researchPageStateOf(Object.fromEntries(url.searchParams)), new Date());
    expect(page.open).toBeNull();
    expect(page.from).toMatchObject({ kind: "seed", messageId, view: { answered: true, question: ANSWERED } });
    expect(await withTenant(tenantOf(ASKER), () => getPrisma().researchConversation.count({}))).toBe(0);
    expect(started).toEqual([]);
  }, 180_000);

  it("starts the research the page opens from that answer, and runs it on the person's own principal to a report with a finding that passed the checks; the answer as it was (48 § 5, § 7.1, invariant 31)", async () => {
    expect(road.answerId).not.toBe("");
    const endpoints = researchEndpoints(RESEARCH);
    const opened = await handler(endpoints.researchConversationCreate, pipeline(ASKER))(new Request(`${BASE}/api/v1/research/conversations`, { method: "POST", headers: HEADERS, body: JSON.stringify({ locale: "en", seedMessageId: road.answerId }) }));
    expect(opened.status, await opened.clone().text()).toBe(201);
    road.researchId = ((await opened.json()) as { id: string }).id;
    const start = await handler(endpoints.researchRunStart, pipeline(ASKER))(new Request(`${BASE}/api/v1/research/conversations/${road.researchId}/runs`, { method: "POST", headers: { ...HEADERS, "idempotency-key": randomUUID() }, body: JSON.stringify({ question: RESEARCHED, language: "en" }) }), { params: { id: road.researchId } });
    expect(start.status, await start.clone().text()).toBe(202);
    const { runId, state } = (await start.json()) as { runId: string; state: string };
    expect(state).toBe("QUEUED");
    road.runId = runId;
    expect(started).toEqual([{ workflowId: researchRunWorkflowId(runId), input: { runId, userId: ASKER.id } }]);

    /* the run the endpoint started, on the test server, its activities the real ones on the stub */
    stubOf().rows.length = 0;
    const result = await environment().withWorker(researchRunOnStub(stubOf(), {}), async (taskQueue) => {
      const handle = await environment().client.workflow.start(RESEARCH_RUN_WORKFLOW, { taskQueue, workflowId: researchRunWorkflowId(runId), args: [{ runId, userId: ASKER.id }] });
      return ResearchRunWorkflowResultSchema.parse(await handle.result());
    });
    expect(result.state).toBe("DONE");
    /* every call of the run on the person's own principal, none on a research principal's (A3) */
    const runRows = stubOf().rows.filter((row) => row.ref === runId);
    expect(runRows.length).toBeGreaterThan(0);
    expect(runRows.every((row) => "userId" in row.principal && row.principal.userId === ASKER.id)).toBe(true);

    /* the run as the page shows it: seeded, done, a report, the pages read, one finding that passed the checks, unused */
    const view = await readResearchRunView(ASKER, runId);
    expect(view).toMatchObject({ state: "DONE", seeded: true, line: { key: "done" } });
    expect(view?.report?.paragraphs.length ?? 0).toBeGreaterThan(0);
    expect(view?.pages.map((page) => page.url)).toContain(FIXTURE_PAGES.standard.url);
    expect(view?.findings).toHaveLength(1);
    expect(view?.findings[0]).toMatchObject({ n: 1, use: { state: "VALID" }, sources: [{ url: FIXTURE_PAGES.standard.url }] });
    road.findingId = view?.findings[0]?.id ?? "";
    /* the answer the research was seeded from is as it was given */
    expect(await answerAsStored()).toEqual(answerAtFirst);
  }, 300_000);

  it("sends the finding to Improve: its source opened by the product's fetcher, graded and adjudicated under the research principal, proposed into the curator queue as the asker's proposal, its curator's pages naming nobody who asked; the asker's name added and a curator's accept recorded (48 § 8.3, § 8.4)", async () => {
    expect(road.findingId).not.toBe("");
    const propose = await handler(researchFindingEndpoints(FINDINGS).researchFindingPropose, pipeline(ASKER))(new Request(`${BASE}/api/v1/research/findings/${road.findingId}/propose`, { method: "POST", headers: { ...HEADERS, "idempotency-key": randomUUID() }, body: "{}" }), { params: { id: road.findingId } });
    expect(propose.status, await propose.clone().text()).toBe(202);
    expect(started.at(-1)).toEqual({ workflowId: findingWorkflowId(road.findingId), input: { findingId: road.findingId, userId: ASKER.id } });

    stubOf().rows.length = 0;
    const activities = { ...researchRunActivities(stubOf(), {}, "B:direct:none"), ...sendFindingActivities({ send: { ...defaultSendStepDeps(), principal: () => true }, outcome: defaultOutcomeStepDeps() }) };
    await environment().withWorker(activities, async (taskQueue) => {
      const client = environment().client;
      const handle = await client.workflow.start(SEND_FINDING_WORKFLOW, { taskQueue, workflowId: findingWorkflowId(road.findingId), args: [{ findingId: road.findingId, userId: ASKER.id }] });
      /* awaited a poll at a time: the suggestion's workflow, its abandoned child, outlives it (tests/workflows/environment.ts) */
      const sent = SendFindingWorkflowResultSchema.parse(await environment().resultOf(handle, OUTCOMES_EVERY));
      expect(sent).toMatchObject({ findingId: road.findingId, end: "PROPOSED", failure: null });
      const suggestionId = sent.suggestionId ?? "";
      road.suggestionId = suggestionId;

      /* the researcher's proposal: no owner, recommended into the queue; the asker's, shown under their finding */
      const suggestion = await getPrisma().suggestion.findUniqueOrThrow({ where: { id: suggestionId }, select: { origin: true, userId: true, state: true, outcome: true, parts: true, evidence: { select: { id: true, kind: true, state: true, tier: true, fetchStatus: true, textKey: true, contentSha256: true } } } });
      expect(suggestion).toMatchObject({ origin: "RESEARCHER", userId: null, state: "CURATOR_QUEUE", outcome: "ACCEPT" });
      /* its evidence is what the product's fetcher opened (44 R5): its status, the source it received as its row's hash says, the text it stored */
      expect(suggestion.evidence).toMatchObject([{ kind: "LINK", state: "GRADED", tier: "B" }]);
      for (const item of suggestion.evidence) {
        expect(item.fetchStatus).toMatch(/^opened:2\d\d$/);
        const source = await readFile(join(env.OBJECT_STORE_DIR, ...evidenceSourceKey(suggestionId, item.id).split("/")));
        expect(createHash("sha256").update(source).digest("hex")).toBe(item.contentSha256);
        expect((await readFile(join(env.OBJECT_STORE_DIR, ...(item.textKey ?? "missing").split("/")))).length).toBeGreaterThan(0);
      }
      /* Improve's vetting is the platform's research principal's, never the asker's (48 § 7.3) */
      const vetting = stubOf().rows.filter((row) => row.ref === suggestionId);
      expect(vetting.map((row) => row.kind).sort()).toEqual(["ADJUDICATION", "GRADING"]);
      expect(vetting.every((row) => "organisationId" in row.principal && row.principal.organisationId === RESEARCH_PRINCIPAL_DOUBLE.organisationId)).toBe(true);
      expect(await askerOfProposal(ASKER, suggestionId)).toBe(true);
      const shown = (await readResearchRunView(ASKER, road.runId))?.findings[0];
      expect(shown).toMatchObject({ use: { state: "PROPOSED", suggestionId }, proposal: { suggestionId } });

      /* the canary carried to a curator's pages (43 § 13.6): the queue with the proposal selected, its record, and the research log */
      const curator: SessionUser = { id: CURATOR_ID, organisationId: null, role: "CURATOR", displayName: "Road Curator", locale: "en", identityVerified: true, parts: suggestion.parts, sessionId: null };
      const queue = await getQueuePage({ locale: "en", user: curator, selectedId: suggestionId });
      const record = await getImproveRecord({ locale: "en", user: curator, id: suggestionId });
      expect(record).toMatchObject({ kind: "page", audience: "curator" });
      /* the research log's entry of a sent finding is its month's `sent`, from the `submitted` record the researcher signs (48 § 10.3): a proposal in the queue is on no refuted line */
      const submitted = await recordAt(suggestionId, "SUBMITTED", stepKeyOf(suggestionWorkflowId(suggestionId), "submitted:1"));
      expect(submitted?.actor).toBe("service:researcher");
      const log = await getResearchLog({ user: curator });
      if (log.kind !== "page") throw new Error("the research log is a curator's page");
      expect(log.months.find((month) => month.month === submitted?.createdAt.toISOString().slice(0, 7))?.sent ?? 0).toBeGreaterThan(0);
      const pages = [JSON.stringify(queue).toLowerCase(), JSON.stringify(record).toLowerCase(), JSON.stringify(log).toLowerCase()];
      for (const page of pages.slice(0, 2)) expect(page).toContain(suggestionId.toLowerCase());
      for (const page of pages) {
        for (const forbidden of [ASKER.id, ASKER.displayName.toLowerCase(), `${ASKER.id}@research-road.test`, MARKER, ...fiveWordsOf(RESEARCHED)]) expect(page).not.toContain(forbidden);
      }

      /* named: the asker's name on the proposal, through the endpoint, the workflow told and the record written (42 § 6) */
      const { proposalEndorse } = proposalEndpoints({ ...defaultProposalDeps(), signal: (workflowId, endorsed) => client.workflow.getHandle(workflowId).signal(SUGGESTION_ENDORSED_SIGNAL, endorsed) });
      const endorsed = await proposalEndorse.run({ params: { suggestionId }, query: undefined, body: { consent: true }, session: ASKER, traceId: TRACE, locale: "en", request: new Request(`${BASE}/api/v1/proposals`), idempotency: null });
      expect(endorsed).toMatchObject({ suggestionId, endorsed: { byMe: true } });
      const at = (endorsed as { endorsed: { at: string } }).endorsed.at;
      const recorded = async (kind: "ENDORSED" | "CURATOR", step: string) => {
        for (let tries = 0; tries < 300; tries += 1) {
          const found = await recordAt(suggestionId, kind, stepKeyOf(suggestionWorkflowId(suggestionId), step));
          if (found !== null) return found;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return null;
      };
      const named = await recorded("ENDORSED", `endorse:${at}`);
      expect(named?.actor).toBe(`user:${ASKER.id}`);
      expect(EndorsedPayloadSchema.parse(named?.payload)).toMatchObject({ consentAt: at, withdrawn: false });

      /* a curator's accept, as the decision endpoint makes it (36 § 5.1): the rule's agreement, the action, the workflow told, its record */
      const row = await readSuggestion(callerOf(curator), suggestionId);
      expect(row).toMatchObject({ state: "CURATOR_QUEUE", origin: "RESEARCHER", outcome: "ACCEPT" });
      const decided = decisionOf({ action: "ACCEPT", origin: "RESEARCHER", changeClass: row?.changeClass ?? "NEW_CLAIM", standing: row?.outcome ?? null, overrideCode: null, criterion: null, note: null });
      expect(decided.refusal).toBeNull();
      const written = await writeCuratorAction(callerOf(curator), { suggestionId, action: "ACCEPT", overrideCode: null, criterion: decided.criterion, note: null });
      if (!written.written) throw new Error("the curator's action was not written");
      expect(written.workflowId).toBe(suggestionWorkflowId(suggestionId));
      await client.workflow.getHandle(suggestionWorkflowId(suggestionId)).signal(SUGGESTION_CURATOR_SIGNAL, { actionId: written.actionId });
      const accepted = await recorded("CURATOR", `curator:${written.actionId}`);
      expect(accepted?.actor).toBe(`user:${CURATOR_ID}`);
      expect(CuratorPayloadSchema.parse(accepted?.payload)).toMatchObject({ action: "ACCEPT", origin: "RESEARCHER" });
      /* what follows the accept is the merge suite's: the run here is ended before its merge reaches a repository (44 § 10) */
      await client.workflow.getHandle(suggestionWorkflowId(suggestionId)).terminate("the road's suite ends at the curator's accept");
    });
    /* the answer the road began with, still as it was given */
    expect(await answerAsStored()).toEqual(answerAtFirst);
  }, 600_000);
});
