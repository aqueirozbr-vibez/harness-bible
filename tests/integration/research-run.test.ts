import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FIXTURE_PAGES, INJECTED_SENTENCE, INJECTION_MARKER } from "@/infra/gateway/stub/research";
import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { createConversation, deleteConversation } from "@/lib/db/assistant";
import type { BudgetRowInput } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { recordAt, researchRecordAt, view } from "@/lib/db/ledger";
import { askerOfProposal, readEndorsement, readFindings, readProposalsOfAsker, readResearchFound, readResearchRun } from "@/lib/db/research";
import { currentRelease } from "@/lib/db/shared";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { stepKeyOf } from "@/lib/ledger/hash";
import { ResearchPayloadSchema } from "@/lib/schemas/ledger";
import { evidenceSourceKey } from "@/lib/schemas/storage";
import { RESEARCH_WORKFLOW, ResearchWorkflowResultSchema, researchWorkflowId, SUGGESTION_ENDORSED_SIGNAL, suggestionWorkflowId } from "@/lib/schemas/workflows";
import { defaultProposalDeps, proposalEndpoints } from "@/lib/api/endpoints/proposals";
import { EndorsedPayloadSchema } from "@/lib/schemas/ledger";
import { OUTCOMES_EVERY } from "@/workers/research/pace";

import { readResearchView } from "@/lib/db/research";
import { getImproveOutcome } from "@/lib/db/improveOutcome";
import { getImproveRecord } from "@/lib/db/improveRecord";
import { getQueuePage } from "@/lib/db/queuePage";
import { getResearchLog } from "@/lib/db/researchLog";
import { setSpanSink, type SpanRecord } from "@/lib/telemetry/spans";
import { ANSWER_DEADLINE_MS } from "@/lib/workers/client";

import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { clearResearchOf, handOverTurn, RESEARCH_PRINCIPAL_DOUBLE, researchRunActivities, settleSuggestions, startResearchStub, type ResearchStub } from "@/tests/fixtures/research/harness";

import { workflowEnvironment } from "../workflows/environment";

/*
 * A research run end to end (feature-specs/41 § 11.3, § 11.5, § 11.7; unit 58): the real activities on the database,
 * the stub gateway in this process and the engine's test server. A question carrying a canary word is answered and
 * handed over; the planner's request holds the word and the reader's holds no byte of it, nor does any search the
 * stub ran; a plan of nothing ends the run SKIPPED · NOTHING_TO_RESEARCH with no reader call; a malformed plan ends it
 * FAILED after one planner row and no second; a brief that copies the question ends it FAILED · BRIEF_QUESTION; the
 * injection page's finding is refused SOURCE_NOT_SEEN and its sentence reaches no content table; and the RESEARCH
 * record says what came of each run that planned. The run's model calls are charged to the research principal and
 * the asker's ledger gains nothing. Since unit 59 the suggestion's own activities run beside the research ones, on the
 * same stub, with a fetcher that serves the stub's fixture page and the stub grader's tier chosen by the case: a
 * finding whose source grades B becomes a suggestion of origin RESEARCHER, is graded under the research principal,
 * recommended by the adjudicator, placed in the curator queue — PROPOSED, and the line counts it; one whose source
 * grades G is declined at the floor — REFUTED, CLOSED, nothing proposed (42 § 10.1, § 10.2, § 10.9).
 */

const ready = env.DATABASE_URL !== undefined && env.TEMPORAL_ADDRESS !== undefined;
const ASKER: SessionUser = { id: "00000000-0000-4000-8000-0000000d0011", organisationId: null, role: "READER", displayName: "Asker", locale: "en", identityVerified: false, parts: [], sessionId: null };
const ORG = RESEARCH_PRINCIPAL_DOUBLE;
const MARKER = "zebrafinch-7731";
const TRACE = "e".repeat(32);

/** Every run of five words of a question (43 § 13.6, the canary carried to the pages): none may be on a curator's page. */
function fiveWordsOf(question: string): ReadonlyArray<string> {
  const words = question.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  return words.length < 5 ? [] : words.slice(0, words.length - 4).map((_, index) => words.slice(index, index + 5).join(" "));
}

/** An item the product's fetcher opened (44 R5): its status, the source it received as its row's hash says, and the text the grader read, in the store. */
async function expectOpenedByTheFetcher(suggestionId: string, items: ReadonlyArray<{ readonly id: string; readonly fetchStatus: string | null; readonly textKey: string | null; readonly contentSha256: string | null }>): Promise<void> {
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect(item.fetchStatus).toMatch(/^opened:2\d\d$/);
    const source = await readFile(join(env.OBJECT_STORE_DIR, ...evidenceSourceKey(suggestionId, item.id).split("/")));
    expect(createHash("sha256").update(source).digest("hex")).toBe(item.contentSha256);
    expect((await readFile(join(env.OBJECT_STORE_DIR, ...(item.textKey ?? "missing").split("/")))).length).toBeGreaterThan(0);
  }
}

/** What a page of a curator's carries, as one lowercase text: the loader's whole data, as the page is drawn from it. */
const pageText = (data: unknown): string => JSON.stringify(data).toLowerCase();

/**
 * The strings a run's history may hold (40 § 12.7): an id, an enumeration's value, a hash, a trace, an instant — never
 * a word of the reader's. Every payload of every event is walked; what does not fit is returned, for the test to name.
 */
const ALLOWED = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^S-\d{2}-\d{4,}$/,
  /^(research|suggestion|merge|grade):[0-9A-Za-z:-]+$/,
  /^[0-9a-f]{32}$/,
  /^[0-9a-f]{64}$/,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
  /^[A-Z][A-Z0-9_]*$/,
  /^(brief|nothing|budget|found)$/,
];
function strangersIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (!ALLOWED.some((pattern) => pattern.test(value))) out.push(value);
  } else if (Array.isArray(value)) for (const item of value) strangersIn(item, out);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) strangersIn(item, out);
  return out;
}
function payloadsOf(event: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(event)) for (const item of event) payloadsOf(item, out);
  else if (typeof event === "object" && event !== null) {
    const record = event as Record<string, unknown>;
    if ("payloads" in record && Array.isArray(record.payloads)) {
      /* a payload as its encoding says: JSON, or nothing (`binary/null`, a step that returns nothing); any other is named */
      for (const payload of record.payloads as ReadonlyArray<{ readonly metadata?: Record<string, Uint8Array> | null; readonly data?: Uint8Array | null }>) {
        const encoding = payload.metadata?.encoding === undefined ? "" : Buffer.from(payload.metadata.encoding).toString("utf8");
        out.push(encoding === "json/plain" ? JSON.parse(Buffer.from(payload.data ?? new Uint8Array()).toString("utf8")) : encoding === "binary/null" ? null : `encoding ${encoding}`);
      }
    } else for (const item of Object.values(record)) payloadsOf(item, out);
  }
  return out;
}

describe.skipIf(!ready)("a research run end to end: the activities on the database, the stub gateway and the engine", () => {
  const environment = workflowEnvironment();
  let stub: ResearchStub | undefined;
  /* the stub's own, read once it is up: the rows its calls would append to the budget ledger, each request's body, its log */
  let rows: BudgetRowInput[] = [];
  let bodies: Array<{ readonly model: string; readonly body: string }> = [];
  let stubLog: string[] = [];
  let anchor = "";
  /** A second section, for the case whose proposal must not be the first case's: the same proposal at the same text is a duplicate (42 § 4.3). */
  let anchor2 = "";
  let releaseId = "";
  const messageIds: string[] = [];

  /* the run's and its suggestions' records are appended while the suite runs: the chain is held (tests/fixtures/exclusive.ts) */
  let unlock: () => void = () => undefined;

  beforeAll(async () => {
    unlock = await acquire(LEDGER_LOCK);
    stub = await startResearchStub();
    rows = stub.rows;
    bodies = stub.bodies;
    stubLog = stub.log;
    await withSystem(() => getPrisma().user.upsert({ where: { id: ASKER.id }, update: {}, create: { id: ASKER.id, email: `${ASKER.id}@research.test`, displayName: ASKER.displayName, role: "READER" } }));
    const release = await currentRelease();
    releaseId = release.id;
    const sections = await getPrisma().section.findMany({ where: { chapterVersion: { releaseId }, layer: "MECHANISM" }, orderBy: [{ chapterVersion: { chapterNumber: "asc" } }, { ordinal: "asc" }], select: { anchor: true }, take: 2 });
    anchor = sections[0]?.anchor ?? "";
    anchor2 = sections[1]?.anchor ?? anchor;
  }, 360_000);

  afterAll(async () => {
    try {
      /* everything of the suite's reader, this run's and any earlier run's that stopped short: the guard keeps it to theirs */
      await clearResearchOf(ASKER);
      await withSystem(() => getPrisma().user.deleteMany({ where: { id: ASKER.id } }));
      await stub?.close();
    } finally {
      /* the chain released whatever the cleanup met: a lock left behind stalls every appending suite for five minutes */
      unlock();
    }
  });

  /** The real activities, their model calls on the stub with the case's headers, the grader's at the case's tier, their records on the database (tests/fixtures/research/harness.ts). */
  function activities(headers: Record<string, string>, grade = "B:direct:none") {
    if (stub === undefined) throw new Error("the stub is started in beforeAll");
    return researchRunActivities(stub, headers, grade);
  }

  /** A turn answered and handed over: a conversation of its own, the question, the answer citing the section, the run QUEUED. */
  async function handOver(question: string, cited: string = anchor): Promise<{ runId: string; messageId: string }> {
    const conversation = await createConversation(ASKER, { locale: "en" });
    const handed = await handOverTurn(ASKER, conversation.id, { question, cited, releaseId, ordinal: 2, traceId: TRACE });
    messageIds.push(handed.messageId);
    return handed;
  }

  async function runWorkflow(headers: Record<string, string>, question: string, grade = "B:direct:none", cited: string = anchor, meanwhile: (runId: string) => Promise<void> = async () => undefined) {
    const { runId, messageId } = await handOver(question, cited);
    const result = await environment().withWorker(activities(headers, grade), async (taskQueue) => {
      const handle = await environment().client.workflow.start(RESEARCH_WORKFLOW, { taskQueue, workflowId: researchWorkflowId(messageId), args: [{ runId, userId: ASKER.id }] });
      /* awaited a poll at a time: the run's children outlive it (environment.ts) */
      const ended = ResearchWorkflowResultSchema.parse(await environment().resultOf(handle, OUTCOMES_EVERY));
      /* what the case does while the suggestions' workflows still run and take signals */
      await meanwhile(runId);
      await settleSuggestions(environment().client, ASKER, runId);
      return ended;
    });
    const run = await readResearchRun(runId, ASKER.id);
    return { runId, messageId, result, run };
  }

  /**
   * The asker's name on the proposal and taken back (42 § 6; unit 59d), through the endpoints' own code with the
   * engine's client the test server's: the asker is the proposal's owner and another reader is not; the row, the signal,
   * the `ENDORSED` record by the reader's pseudonym with the consent's instant; the withdrawal a second record and the
   * row gone; the consent on the asker's account.
   */
  async function endorseAndWithdraw(runId: string): Promise<void> {
    const [finding] = await readFindings({ id: runId, userId: ASKER.id });
    const suggestionId = finding?.suggestionId ?? "";
    expect(suggestionId).not.toBe("");
    expect(await askerOfProposal(ASKER, suggestionId)).toBe(true);
    expect(await askerOfProposal({ ...ASKER, id: "00000000-0000-4000-8000-0000000d0022" }, suggestionId)).toBe(false);
    const { proposalEndorse, proposalWithdraw } = proposalEndpoints({ ...defaultProposalDeps(), signal: (workflowId, endorsed) => environment().client.workflow.getHandle(workflowId).signal(SUGGESTION_ENDORSED_SIGNAL, endorsed) });
    const input = { params: { suggestionId }, query: undefined, session: ASKER, traceId: TRACE, locale: "en" as const, request: new Request("http://localhost:3000/api/v1/proposals"), idempotency: null };
    const endorsed = await proposalEndorse.run({ ...input, body: { consent: true } });
    expect(endorsed).toMatchObject({ suggestionId, endorsed: { byMe: true } });
    const at = (endorsed as { endorsed: { at: string } }).endorsed.at;
    expect((await readEndorsement(ASKER, suggestionId))?.createdAt.toISOString()).toBe(at);
    expect((await withSystem(() => getPrisma().user.findUniqueOrThrow({ where: { id: ASKER.id }, select: { provenanceConsentAt: true } }))).provenanceConsentAt).not.toBeNull();
    const recorded = async (step: string) => {
      for (let tries = 0; tries < 300; tries += 1) {
        const record = await recordAt(suggestionId, "ENDORSED", stepKeyOf(suggestionWorkflowId(suggestionId), step));
        if (record !== null) return record;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return null;
    };
    const first = await recorded(`endorse:${at}`);
    expect(first?.actor).toBe(`user:${ASKER.id}`);
    expect(EndorsedPayloadSchema.parse(first?.payload)).toMatchObject({ consentAt: at, withdrawn: false });
    /* a second press is the first's: told again with the row's instant, written once */
    expect(await proposalEndorse.run({ ...input, body: { consent: true } })).toEqual({ suggestionId, endorsed: { byMe: true, at } });
    /* signals the endpoint took back (unit 59's review): a withdrawal while the row stands, a name for an instant no row
       holds — the workflow reads the row again, and records neither; the ones after them show both were taken in turn */
    const stray = new Date(Date.parse(at) + 1).toISOString();
    const handle = environment().client.workflow.getHandle(suggestionWorkflowId(suggestionId));
    await handle.signal(SUGGESTION_ENDORSED_SIGNAL, { userId: ASKER.id, at: stray, withdrawn: true });
    await handle.signal(SUGGESTION_ENDORSED_SIGNAL, { userId: ASKER.id, at: stray, withdrawn: false });
    expect(await proposalWithdraw.run({ ...input, body: undefined })).toEqual({ suggestionId, endorsed: null });
    expect(await readEndorsement(ASKER, suggestionId)).toBeNull();
    const second = await recorded(`withdraw:${at}`);
    expect(EndorsedPayloadSchema.parse(second?.payload)).toMatchObject({ consentAt: at, withdrawn: true });
    expect(await recordAt(suggestionId, "ENDORSED", stepKeyOf(suggestionWorkflowId(suggestionId), `withdraw:${stray}`))).toBeNull();
    expect(await recordAt(suggestionId, "ENDORSED", stepKeyOf(suggestionWorkflowId(suggestionId), `endorse:${stray}`))).toBeNull();
    expect((await view({ suggestionId })).filter((record) => record.kind === "ENDORSED").map((record) => record.actor)).toEqual([`user:${ASKER.id}`, `user:${ASKER.id}`]);
  }

  it("runs a question through the planner and the reader to DONE: the canary word reaches the planner alone and no line, span, history or curator's page; the finding becomes a suggestion graded under the research principal and recommended into the curator queue — PROPOSED — and the RESEARCH record names both models; the asker puts their name to it and takes it back", async () => {
    expect(anchor).not.toBe("");
    rows.length = 0;
    bodies.length = 0;
    stubLog.length = 0;
    /* what the run prints and records as it goes (44 § 4, § 8.4) */
    const printed: string[] = [];
    const spans: SpanRecord[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    setSpanSink((record) => spans.push(record));
    const question = `Why does a retried write without an idempotency key become a second write (${MARKER})?`;
    let ran: Awaited<ReturnType<typeof runWorkflow>>;
    try {
      ran = await runWorkflow({}, question, undefined, undefined, endorseAndWithdraw);
    } finally {
      info.mockRestore();
      setSpanSink(null);
    }
    const { runId, messageId, result, run } = ran;
    /* the research lines and spans, each step's and the run's end, with the run's id and no word of the question (44 § 8.4) */
    const lines = printed.filter((line) => line.includes('"kind":"research"'));
    expect(lines.map((line) => (JSON.parse(line) as { stage: string }).stage)).toEqual(["plan", "read", "run"]);
    expect(lines.every((line) => line.includes(runId))).toBe(true);
    expect(spans.filter((span) => span.name.startsWith("research.")).map((span) => span.name)).toEqual(["research.plan", "research.read", "research.run"]);
    for (const line of printed) expect(line).not.toContain(MARKER);
    expect(JSON.stringify(spans)).not.toContain(MARKER);
    /* the run's history: ids, values, hashes and instants, no word of the reader's (40 § 12.7) */
    const history = await environment().client.workflow.getHandle(researchWorkflowId(messageId)).fetchHistory();
    const payloads = payloadsOf(history.events ?? []);
    expect(payloads.length).toBeGreaterThan(5);
    expect(strangersIn(payloads)).toEqual([]);
    expect(result).toEqual({ runId, state: "DONE", findings: 1 });
    expect(run).toMatchObject({ state: "DONE", searches: 1, pageReads: 1 });
    expect(run?.briefSha256).toMatch(/^[0-9a-f]{64}$/);
    /* the planner saw the question; the reader saw no byte of it, and no search carried it */
    /* the run's two calls first; the suggestion's grading and adjudication follow them through the same stub */
    expect(bodies.slice(0, 2).map((call) => call.model)).toEqual(["hb-small", "hb-frontier"]);
    expect(bodies.slice(2).map((call) => call.model)).toEqual(["hb-small", "hb-frontier"]);
    expect(bodies[0].body).toContain(MARKER);
    expect(bodies[1].body).not.toContain(MARKER);
    /* neither request carries the asker: no id, no e-mail (41 § 11.3) */
    for (const call of bodies) {
      expect(call.body).not.toContain(ASKER.id);
      expect(call.body).not.toContain("research.test");
      expect(call.body).not.toContain("Asker");
    }
    for (const line of stubLog.filter((line) => line.startsWith("stub research:"))) expect(line).not.toContain(MARKER);
    /* what was found stays on the asker's row, validated; the finding became a suggestion, graded and recommended into the queue: PROPOSED (42 § 4, § 5) */
    const found = await readResearchFound({ id: runId, userId: ASKER.id });
    expect(found?.findings).toHaveLength(1);
    expect(found?.valid).toEqual([1]);
    expect(found?.pages).toEqual([FIXTURE_PAGES.standard.url, FIXTURE_PAGES.forum.url]);
    const findings = await readFindings({ id: runId, userId: ASKER.id });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ordinal: 1, outcome: "PROPOSED", invalidReason: null });
    const suggestionId = findings[0].suggestionId ?? "";
    expect(suggestionId).toMatch(/^S-\d{2}-\d{4,}$/);
    const suggestion = await getPrisma().suggestion.findUniqueOrThrow({ where: { id: suggestionId }, select: { origin: true, userId: true, state: true, outcome: true, changeClass: true, rationale: true, score: true, evidence: { select: { id: true, kind: true, state: true, tier: true, host: true, fetchStatus: true, textKey: true, contentSha256: true } } } });
    expect(suggestion).toMatchObject({ origin: "RESEARCHER", userId: null, state: "CURATOR_QUEUE", outcome: "ACCEPT", changeClass: "NEW_CLAIM", score: 85 });
    expect(suggestion.evidence).toMatchObject([{ kind: "LINK", state: "GRADED", tier: "B", host: "standards.example" }]);
    /* the evidence is what the product's fetcher opened (44 R5): its status, the text it stored, the text's hash */
    await expectOpenedByTheFetcher(suggestionId, suggestion.evidence);
    expect(suggestion.rationale?.length ?? 0).toBeGreaterThan(0);
    /* the line counts it */
    expect(await readResearchView(ASKER, messageId)).toMatchObject({ state: "DONE", proposals: [{ suggestionId }] });
    /* the panel's view of it (43 § 5.3; unit 60b): the anchor and its title, the source as graded, the score against the line, where it is, no name (it was taken back) */
    const shown = (await readResearchView(ASKER, messageId))?.proposals[0];
    expect(shown).toMatchObject({ anchor: { kind: "SECTION", id: anchor, section: anchor }, changeClass: "NEW_CLAIM", score: 85, acceptAt: 85, sources: [{ host: "standards.example", tier: "B" }], where: { state: "CURATOR_QUEUE" }, endorsed: null });
    expect(shown?.anchor?.title).toEqual(expect.any(String));
    expect(shown?.where.decisionBy).toEqual(expect.any(String));
    expect(shown?.note?.length ?? 0).toBeGreaterThan(0);
    /* and in the asker's list on the landing page (43 § 6; unit 60c) */
    expect((await readProposalsOfAsker(ASKER)).map((proposal) => proposal.suggestionId)).toContain(suggestionId);
    /* its record and its page are the asker's to read (43 § 8, D7, D12; unit 60e): the asker's audience, the researcher's origin, no one else's */
    const recordPage = await getImproveRecord({ locale: "en", user: ASKER, id: suggestionId });
    expect(recordPage).toMatchObject({ kind: "page", audience: "asker", variant: "recommended", research: { endorser: null } });
    expect(await getImproveOutcome({ locale: "en", user: ASKER, id: suggestionId })).toMatchObject({ kind: "page", variant: "recommended" });
    /* a curator of its part reads its record: the name taken back is not on the timeline, only the ledger's pseudonym, and the export is theirs (review of unit 60) */
    const parts = (await getPrisma().suggestion.findUniqueOrThrow({ where: { id: suggestionId }, select: { parts: true } })).parts;
    const curator: SessionUser = { ...ASKER, id: "00000000-0000-4000-8000-0000000d0033", role: "CURATOR", displayName: "Curator", parts };
    const curatorsRecord = await getImproveRecord({ locale: "en", user: curator, id: suggestionId });
    expect(curatorsRecord).toMatchObject({ kind: "page", audience: "curator", research: { endorser: null }, mayExport: true });
    const endorsedEntries = curatorsRecord.kind === "page" ? curatorsRecord.entries.filter((entry) => entry.facts.kind === "ENDORSED") : [];
    expect(endorsedEntries).toHaveLength(2);
    for (const entry of endorsedEntries) expect(entry.actor).toMatchObject({ kind: "person", name: null, pseudonym: `user:${ASKER.id}` });
    expect(JSON.stringify(curatorsRecord)).not.toContain(ASKER.displayName);
    expect(recordPage).toMatchObject({ mayExport: false });
    /* the canary carried to a curator's pages (43 § 13.6): the queue with the proposal selected, and its record, carry neither who asked — id, name, e-mail — nor the marker, nor five words of the question */
    const queue = await getQueuePage({ locale: "en", user: curator, selectedId: suggestionId });
    expect(pageText(queue)).toContain(suggestionId.toLowerCase());
    /* the reader's own `endorsed` records keep the ledger's pseudonym (invariant 35), which the page shows cut to its first eight characters; nothing else of the record names them */
    const recordButTheirOwn = curatorsRecord.kind === "page" ? { ...curatorsRecord, entries: curatorsRecord.entries.filter((entry) => entry.facts.kind !== "ENDORSED") } : curatorsRecord;
    for (const page of [pageText(queue), pageText(recordButTheirOwn)]) {
      for (const forbidden of [ASKER.id, ASKER.displayName.toLowerCase(), `${ASKER.id}@research.test`, MARKER, ...fiveWordsOf(question)]) expect(page).not.toContain(forbidden);
    }
    const stranger = { ...ASKER, id: "00000000-0000-4000-8000-0000000d0022" };
    expect(await getImproveRecord({ locale: "en", user: stranger, id: suggestionId })).toEqual({ kind: "missing" });
    expect(await getImproveOutcome({ locale: "en", user: stranger, id: suggestionId })).toEqual({ kind: "missing" });
    /* the research calls, the grading and the adjudication are the research principal's; the asker's ledger gains nothing (42 § 10.9) */
    expect(rows.filter((row) => row.ref === runId).map((row) => [row.kind, row.alias])).toEqual([
      ["RESEARCH", "hb-small"],
      ["RESEARCH", "hb-frontier"],
    ]);
    expect(rows.filter((row) => row.ref === suggestionId).map((row) => row.kind).sort()).toEqual(["ADJUDICATION", "GRADING"]);
    expect(rows.every((row) => "organisationId" in row.principal && row.principal.organisationId === ORG.organisationId)).toBe(true);
    expect(await withTenant(tenantOf(ASKER), () => getPrisma().budgetLedger.count({ where: { ref: { in: [runId, suggestionId] } } }))).toBe(0);
    /* the ledger's line for the run, and the suggestion's own records signed by the researcher */
    const record = await researchRecordAt(stepKeyOf(researchWorkflowId(messageId), "research:1"));
    expect(record).not.toBeNull();
    const payload = ResearchPayloadSchema.parse(record?.payload);
    expect(payload).toMatchObject({ runId, planned: "brief", sections: [anchor], gap: true, searches: 1, pageReads: 1, findings: [{ ordinal: 1, outcome: "PROPOSED" }], models: { planner: "claude-haiku-4-5", reader: "claude-opus-5" } });
    const kinds = await getPrisma().ledgerRecord.findMany({ where: { suggestionId }, orderBy: { seq: "asc" }, select: { kind: true, actor: true } });
    expect(kinds.map((row) => row.kind)).toEqual(["SUBMITTED", "GRADED", "SENSORS", "DECIDED", "ENDORSED", "ENDORSED"]);
    expect(kinds[0].actor).toBe("service:researcher");
    expect(record?.actor).toBe("service:researcher");
    expect(record?.suggestionId).toBeNull();

    /* its conversation deleted, the turn long settled (45 § 3.6): the proposal stays the asker's, listed under Improve, and the ended run detached */
    const { conversationId } = await withTenant(tenantOf(ASKER), () => getPrisma().message.findUniqueOrThrow({ where: { id: messageId }, select: { conversationId: true } }));
    await withTenant(tenantOf(ASKER), () => getPrisma().message.updateMany({ where: { conversationId }, data: { createdAt: new Date(Date.now() - ANSWER_DEADLINE_MS - 60_000) } }));
    expect(await deleteConversation(ASKER, conversationId)).toMatchObject({ deleted: true, detached: 1 });
    expect((await readProposalsOfAsker(ASKER)).map((proposal) => proposal.suggestionId)).toContain(suggestionId);
    expect(await askerOfProposal(ASKER, suggestionId)).toBe(true);
    expect(await readResearchRun(runId, ASKER.id)).toMatchObject({ messageId: null, state: "DONE" });
  });

  it("ends SKIPPED · NOTHING_TO_RESEARCH on a plan of nothing, with no reader call and a record that names the planner alone", async () => {
    rows.length = 0;
    bodies.length = 0;
    const { runId, messageId, result, run } = await runWorkflow({ "x-hb-stub-plan": "covered" }, "What does the chapter say about retries?");
    expect(result).toEqual({ runId, state: "SKIPPED", findings: 0 });
    expect(run).toMatchObject({ state: "SKIPPED", skip: "NOTHING_TO_RESEARCH", briefSha256: null });
    expect(bodies.map((call) => call.model)).toEqual(["hb-small"]);
    const record = await researchRecordAt(stepKeyOf(researchWorkflowId(messageId), "research:1"));
    expect(ResearchPayloadSchema.parse(record?.payload)).toMatchObject({ planned: "nothing", briefSha256: null, models: { planner: "claude-haiku-4-5", reader: null } });
  });

  it("ends a run whose conversation the reader deleted before it loaded SKIPPED · TEXT_PURGED, asking no model and writing no record; its row stays, detached, as the day's tally (45 § 3.5, § 8)", async () => {
    rows.length = 0;
    bodies.length = 0;
    const conversation = await createConversation(ASKER, { locale: "en" });
    const { runId, messageId } = await handOverTurn(ASKER, conversation.id, { question: "Are retries without keys ever safe?", cited: anchor, releaseId, ordinal: 2, traceId: TRACE });
    /* the turn settled, its rows past the answer's deadline, as a delete minutes later finds them; the run still QUEUED */
    await withTenant(tenantOf(ASKER), () => getPrisma().message.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: new Date(Date.now() - ANSWER_DEADLINE_MS - 60_000) } }));
    expect(await deleteConversation(ASKER, conversation.id)).toMatchObject({ deleted: true, messages: 2, detached: 1 });
    const result = await environment().withWorker(activities({}), async (taskQueue) => {
      const handle = await environment().client.workflow.start(RESEARCH_WORKFLOW, { taskQueue, workflowId: researchWorkflowId(messageId), args: [{ runId, userId: ASKER.id }] });
      return ResearchWorkflowResultSchema.parse(await environment().resultOf(handle, OUTCOMES_EVERY));
    });
    expect(result).toEqual({ runId, state: "SKIPPED", findings: 0 });
    expect(await readResearchRun(runId, ASKER.id)).toMatchObject({ messageId: null, state: "SKIPPED", skip: "TEXT_PURGED", briefSha256: null, searches: 0 });
    expect(bodies).toEqual([]);
    expect(rows.filter((row) => row.ref === runId)).toEqual([]);
    expect(await researchRecordAt(stepKeyOf(researchWorkflowId(messageId), "research:1"))).toBeNull();
  });

  it("ends FAILED · PLANNER_FAILED on a malformed plan after one planner row and no second call, recorded as planned failed; and FAILED · BRIEF_QUESTION on a brief that copies the question", async () => {
    rows.length = 0;
    bodies.length = 0;
    const malformed = await runWorkflow({ "x-hb-stub-plan": "malformed" }, "How long should an idempotency key be kept?");
    expect(malformed.result).toMatchObject({ state: "FAILED", findings: 0 });
    expect(malformed.run).toMatchObject({ state: "FAILED", failure: "PLANNER_FAILED" });
    expect(rows.map((row) => row.alias)).toEqual(["hb-small"]);
    expect(bodies).toHaveLength(1);
    /* the planner was called and charged: the ledger says research ran and planned nothing it could use */
    const failedRecord = await researchRecordAt(stepKeyOf(researchWorkflowId(malformed.messageId), "research:1"));
    expect(ResearchPayloadSchema.parse(failedRecord?.payload)).toMatchObject({ planned: "failed", briefSha256: null, models: { planner: "claude-haiku-4-5", reader: null }, findings: [] });
    bodies.length = 0;
    const leak = await runWorkflow({ "x-hb-stub-plan": "leak" }, `Why does a retried write without an idempotency key become a second write (${MARKER})?`);
    expect(leak.run).toMatchObject({ state: "FAILED", failure: "BRIEF_QUESTION", briefSha256: null });
    expect(bodies.map((call) => call.model)).toEqual(["hb-small"]);
  });

  it("refutes a finding whose source grades under the floor: declined at intake, CLOSED, the finding REFUTED, the line reading nothing to propose (42 § 10.2)", async () => {
    rows.length = 0;
    const { runId, messageId, result } = await runWorkflow({}, "How is a retry storm after a deploy contained?", "G", anchor2);
    expect(result).toEqual({ runId, state: "DONE", findings: 1 });
    const findings = await readFindings({ id: runId, userId: ASKER.id });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ordinal: 1, outcome: "REFUTED" });
    const suggestion = await getPrisma().suggestion.findUniqueOrThrow({ where: { id: findings[0].suggestionId ?? "" }, select: { origin: true, state: true, outcome: true, score: true, evidence: { select: { id: true, fetchStatus: true, textKey: true, contentSha256: true } } } });
    expect(suggestion).toMatchObject({ origin: "RESEARCHER", state: "CLOSED" });
    await expectOpenedByTheFetcher(findings[0].suggestionId ?? "", suggestion.evidence);
    expect(suggestion.score).toBeLessThan(40);
    /* no frontier call: declined at the floor; no queue item; the line says nothing to propose */
    expect(rows.filter((row) => row.ref === findings[0].suggestionId).map((row) => row.kind)).toEqual(["GRADING"]);
    expect(await readResearchView(ASKER, messageId)).toMatchObject({ state: "DONE", proposals: [] });
    /* a refuted finding is no proposal of the asker's, anywhere (42 § 5; 43 § 6) */
    expect((await readProposalsOfAsker(ASKER)).map((proposal) => proposal.suggestionId)).not.toContain(findings[0].suggestionId);
    const record = await researchRecordAt(stepKeyOf(researchWorkflowId(messageId), "research:1"));
    expect(ResearchPayloadSchema.parse(record?.payload).findings).toEqual([{ ordinal: 1, outcome: "REFUTED" }]);
    /* the research log lists it with what refuted it, and names nobody who asked nor any five words of the question (43 § 13.6, § 13.7) */
    const curator: SessionUser = { ...ASKER, id: "00000000-0000-4000-8000-0000000d0044", role: "CURATOR", displayName: "Curator", parts: ["P1"] };
    const log = await getResearchLog({ user: curator });
    expect(log.kind).toBe("page");
    const logText = pageText(log);
    expect(logText).toContain((findings[0].suggestionId ?? "").toLowerCase());
    for (const forbidden of [ASKER.id, ASKER.displayName.toLowerCase(), `${ASKER.id}@research.test`, ...fiveWordsOf("How is a retry storm after a deploy contained?")]) expect(logText).not.toContain(forbidden);
  });

  it("refuses the injection page's finding as SOURCE_NOT_SEEN, searches for nothing the page asked, and writes its sentence to no content table (41 § 11.7)", async () => {
    stubLog.length = 0;
    bodies.length = 0;
    const { runId, result, run } = await runWorkflow({ "x-hb-stub-research": "injection" }, "Are retries safe without idempotency keys?");
    expect(result).toEqual({ runId, state: "DONE", findings: 1 });
    expect(run?.state).toBe("DONE");
    expect(await readFindings({ id: runId, userId: ASKER.id })).toEqual([{ ordinal: 1, outcome: "INVALID", invalidReason: "SOURCE_NOT_SEEN", suggestionId: null }]);
    expect((await readResearchFound({ id: runId, userId: ASKER.id }))?.valid).toEqual([]);
    for (const line of stubLog) expect(line).not.toContain(INJECTION_MARKER);
    for (const call of bodies) expect(call.body).not.toContain(INJECTION_MARKER);
    expect(await getPrisma().suggestion.count({ where: { rationale: { contains: INJECTED_SENTENCE } } })).toBe(0);
    expect(await getPrisma().section.count({ where: { markdownEn: { contains: INJECTED_SENTENCE } } })).toBe(0);
  });
});
