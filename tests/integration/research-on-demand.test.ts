import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FIXTURE_PAGES, PAGE_NOTES } from "@/infra/gateway/stub/research";
import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { appendAssistantMessage, appendUserMessage, createConversation } from "@/lib/db/assistant";
import { researchCallsOf } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { researchRecordAt } from "@/lib/db/ledger";
import { appendRunStep, readConversationRun, readFindings, readResearchFound, readRunReport, readRunSteps } from "@/lib/db/research";
import { currentRelease } from "@/lib/db/shared";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { stepKeyOf } from "@/lib/ledger/hash";
import { questionSha256Of } from "@/lib/research/question";
import { frontierCallsOf } from "@/lib/research/record";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";
import { ResearchPayloadSchema } from "@/lib/schemas/ledger";
import { RESEARCH_RUN_WORKFLOW, ResearchRunWorkflowResultSchema, researchRunWorkflowId } from "@/lib/schemas/workflows";
import { setSpanSink, type SpanRecord } from "@/lib/telemetry/spans";

import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { researchRunOnStub, startResearchStub, type ResearchStub } from "@/tests/fixtures/research/harness";

import { workflowEnvironment } from "../workflows/environment";

/*
 * A person's research run end to end (feature-specs/48 § 5, § 6, § 15, § 26 unit 70; unit 70b): the real activities on
 * the database, the stub gateway in this process and the engine's test server. The run's rows are written here, as the
 * start endpoint of unit 71 will write them; nothing else starts one in this unit.
 *
 *   from scratch   retrieval's calls carry the run's id as their ref; the steps are handed to the door while the
 *                  reader streams, every one there and in order; a VALID row; a report; one RESEARCH record signed
 *                  `user:<id>` naming the conversation, its reader the reader's call and its writer the writer's, told
 *                  apart by `writingAt`; every call on the person's own ledger and none on a research principal's;
 *                  a canary word in the planner's and the writer's requests and in no byte of the reader's or of any
 *                  search, line or span; a history of ids;
 *   seeded         the planner reads the seed's claims and its uncovered sentence, and the run's sections hold the
 *                  seed's cited section first, then retrieval's;
 *   a follow-up    its planner reads the earlier brief and never the report; its writer reads the earlier report.
 */

const ready = env.DATABASE_URL !== undefined && env.TEMPORAL_ADDRESS !== undefined;
const ASKER: SessionUser = { id: "00000000-0000-4000-8000-0000000d7011", organisationId: null, role: "READER", displayName: "Researcher", locale: "en", identityVerified: false, parts: [], sessionId: null };
const MARKER = "kestrelfinch-4419";
const TRACE = "a1".repeat(16);
const QUESTION = `Why does a retried write without an idempotency key become a second write (${MARKER})?`;

/** The strings a run's history may hold (invariant 35): an id, an enumeration's value, an instant — never a word of the person's. */
const ALLOWED = [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, /^[A-Z][A-Z0-9_]*$/, /^R-[A-Z]+$/, /^(brief|refused|budget|unavailable|found|report|rate_limit)$/, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/];
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
      for (const payload of record.payloads as ReadonlyArray<{ readonly metadata?: Record<string, Uint8Array> | null; readonly data?: Uint8Array | null }>) {
        const encoding = payload.metadata?.encoding === undefined ? "" : Buffer.from(payload.metadata.encoding).toString("utf8");
        out.push(encoding === "json/plain" ? JSON.parse(Buffer.from(payload.data ?? new Uint8Array()).toString("utf8")) : encoding === "binary/null" ? null : `encoding ${encoding}`);
      }
    } else for (const item of Object.values(record)) payloadsOf(item, out);
  }
  return out;
}

describe.skipIf(!ready)("a person's research run end to end: the activities on the database, the stub gateway and the engine (48 § 26, unit 70)", () => {
  const environment = workflowEnvironment();
  let stub: ResearchStub | undefined;
  let releaseId = "";
  let unlock: () => void = () => undefined;
  /** The suite's first research, which the follow-up asks again in. */
  let first: { readonly conversationId: string; readonly brief: string; readonly report: string } | null = null;

  beforeAll(async () => {
    unlock = await acquire(LEDGER_LOCK);
    stub = await startResearchStub();
    await withSystem(() => getPrisma().user.upsert({ where: { id: ASKER.id }, update: {}, create: { id: ASKER.id, email: `${ASKER.id}@research.test`, displayName: ASKER.displayName, role: "READER" } }));
    releaseId = (await currentRelease()).id;
  }, 360_000);

  afterAll(async () => {
    try {
      await withTenant(tenantOf(ASKER), async () => {
        const prisma = getPrisma();
        await prisma.researchFinding.deleteMany({});
        await prisma.researchRun.deleteMany({});
        await prisma.researchConversation.deleteMany({});
        const messages = await prisma.message.findMany({ select: { id: true } });
        const ids = messages.map((message) => message.id);
        await prisma.citation.deleteMany({ where: { messageId: { in: ids } } });
        await prisma.sensorVerdict.deleteMany({ where: { messageId: { in: ids } } });
        await prisma.message.deleteMany({ where: { id: { in: ids } } });
        await prisma.conversation.deleteMany({});
      });
      /* the BudgetLedger rows and the ledger's records stay, as every such row does */
      await withSystem(() => getPrisma().user.deleteMany({ where: { id: ASKER.id } }));
      await stub?.close();
    } finally {
      unlock();
    }
  });

  function stubOf(): ResearchStub {
    if (stub === undefined) throw new Error("the stub is started in beforeAll");
    return stub;
  }

  async function conversationOf(seedMessageId: string | null = null): Promise<string> {
    return (await withTenant(tenantOf(ASKER), () => getPrisma().researchConversation.create({ data: { userId: ASKER.id, locale: "EN", seedMessageId }, select: { id: true } }))).id;
  }

  /** The run's row as the start endpoint leaves it: QUEUED, its question stored, its workflow's id written in the insert (48 § 4.2). */
  async function queued(conversationId: string, ordinal: number, question: string): Promise<string> {
    return withTenant(tenantOf(ASKER), async () => {
      const prisma = getPrisma();
      const row = await prisma.researchRun.create({ data: { userId: ASKER.id, organisationId: null, conversationId, ordinal, releaseId, locale: "EN", state: "QUEUED", gap: false, sectionAnchors: [], questionSha256: questionSha256Of(question), question, traceId: TRACE }, select: { id: true } });
      await prisma.researchRun.update({ where: { id: row.id }, data: { workflowId: researchRunWorkflowId(row.id) } });
      return row.id;
    });
  }

  async function runOf(conversationId: string, ordinal: number, question: string, options: Parameters<typeof researchRunOnStub>[2] = {}) {
    const runId = await queued(conversationId, ordinal, question);
    const { result, history } = await environment().withWorker(researchRunOnStub(stubOf(), {}, options), async (taskQueue) => {
      const handle = await environment().client.workflow.start(RESEARCH_RUN_WORKFLOW, { taskQueue, workflowId: researchRunWorkflowId(runId), args: [{ runId, userId: ASKER.id }] });
      const ended = ResearchRunWorkflowResultSchema.parse(await handle.result());
      return { result: ended, history: await handle.fetchHistory() };
    });
    return { runId, result, history, run: await readConversationRun(runId, ASKER.id) };
  }

  /** The requests of one kind, by what the stub saw of them: the planner's on `hb-small`, the reader's with the web tools, the writer's on the frontier with none. */
  const bodiesOf = (kind: "planner" | "reader" | "writer") =>
    stubOf().bodies.filter((call) => (kind === "planner" ? call.model === "hb-small" : call.model === "hb-frontier" && (kind === "reader") === call.body.includes("web_search_")));

  it("runs a question from scratch to DONE: retrieval's ref, the steps written while the reader streams, a VALID row, a report, and one record signed by the person with the reader and the writer told apart", async () => {
    const stub = stubOf();
    stub.rows.length = 0;
    stub.bodies.length = 0;
    stub.log.length = 0;
    const conversationId = await conversationOf();
    const printed: string[] = [];
    const spans: SpanRecord[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    setSpanSink((record) => spans.push(record));
    /* when each step was handed to the door, and when the reader's turn came back (48 § 6) */
    const marks: string[] = [];
    let ran: Awaited<ReturnType<typeof runOf>>;
    try {
      ran = await runOf(conversationId, 1, QUESTION, {
        over: {
          appendStep: (run, step, options) => {
            marks.push(`step:${step.kind}`);
            return appendRunStep(run, step, options);
          },
        },
        onReaderAnswered: () => marks.push("reader answered"),
      });
    } finally {
      info.mockRestore();
      setSpanSink(null);
    }
    const { runId, result, history, run } = ran;
    expect(result).toEqual({ runId, state: "DONE", findings: 1 });
    expect(run).toMatchObject({ state: "DONE", conversationId, searches: 1, pageReads: 1, refusal: null });
    expect(run?.briefSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run?.targetAnchors).toHaveLength(1);
    expect(run?.sectionAnchors.length).toBeGreaterThan(0);
    expect(run?.sectionAnchors).toContain(run?.targetAnchors[0]);

    /* retrieval's two calls on the person's principal, naming the run (48 § 5.3) */
    const retrieval = stub.rows.filter((row) => row.kind === "EMBED" || row.kind === "RERANK");
    expect(retrieval.map((row) => row.kind)).toContain("RERANK");
    expect(retrieval.every((row) => row.ref === runId)).toBe(true);
    /* every call is the person's own, and none of them a research principal's (48 § 7.1) */
    expect(stub.rows.every((row) => "userId" in row.principal && row.principal.userId === ASKER.id)).toBe(true);
    expect(stub.rows.filter((row) => row.kind === "RESEARCH").map((row) => row.alias)).toEqual(["hb-small", "hb-frontier", "hb-frontier"]);

    /* the steps: every one there, in order, the reader's handed to the door while it streamed */
    const steps = await readRunSteps({ id: runId, userId: ASKER.id });
    expect(steps.map((step) => [step.seq, step.kind])).toEqual([[0, "PLANNING"], [1, "SECTIONS"], [2, "SEARCH"], [3, "PAGE"], [4, "CHECKING"], [5, "WRITING"]]);
    expect(steps[1]).toMatchObject({ sections: run?.targetAnchors });
    expect(steps[2]).toMatchObject({ kind: "SEARCH", results: 2 });
    expect(steps[3]).toMatchObject({ kind: "PAGE", url: FIXTURE_PAGES.standard.url, title: FIXTURE_PAGES.standard.title, opened: true });
    /* the first step of the stream was handed to the door before the turn came back; the chain's writes are one at a
       time, so the later ones may land after it, and all of them before the read's step ended and the check began */
    expect(marks.indexOf("step:SEARCH")).toBeLessThan(marks.indexOf("reader answered"));
    expect(marks.indexOf("step:PAGE")).toBeGreaterThan(marks.indexOf("step:SEARCH"));
    expect(marks.indexOf("step:CHECKING")).toBeGreaterThan(Math.max(marks.indexOf("reader answered"), marks.indexOf("step:PAGE")));

    /* a VALID row, the notes kept, a report */
    expect(await readFindings({ id: runId, userId: ASKER.id })).toEqual([{ ordinal: 1, outcome: "VALID", invalidReason: null, suggestionId: null }]);
    const found = await readResearchFound({ id: runId, userId: ASKER.id });
    expect(found).toMatchObject({ valid: [1], says: [{ url: FIXTURE_PAGES.standard.url, says: PAGE_NOTES.standard }, { url: FIXTURE_PAGES.forum.url, says: PAGE_NOTES.forum }], notesDropped: 0 });
    expect(found).not.toHaveProperty("notes");
    expect(found?.read?.map((page) => page.url)).toEqual([FIXTURE_PAGES.standard.url, FIXTURE_PAGES.forum.url]);
    const report = await readRunReport({ id: runId, userId: ASKER.id });
    expect(report?.paragraphs.length).toBeGreaterThan(0);

    /* the canary: the planner and the writer hold the question; the reader and every search hold no byte of it */
    expect(bodiesOf("planner")).toHaveLength(1);
    expect(bodiesOf("reader")).toHaveLength(1);
    expect(bodiesOf("writer")).toHaveLength(1);
    expect(bodiesOf("planner")[0]?.body).toContain(MARKER);
    expect(bodiesOf("writer")[0]?.body).toContain(MARKER);
    expect(bodiesOf("reader")[0]?.body).not.toContain(MARKER);
    for (const line of stub.log.filter((entry) => entry.startsWith("stub research:"))) expect(line).not.toContain(MARKER);
    for (const call of stub.bodies) expect(call.body).not.toContain("Researcher");

    /* the lines and the spans, each step's and the run's, with the run's id and no word of the question (48 § 5.8) */
    const lines = printed.filter((line) => line.includes('"kind":"research"'));
    expect(lines.map((line) => (JSON.parse(line) as { stage: string }).stage)).toEqual(["plan", "read", "write", "run"]);
    expect(spans.filter((span) => span.name.startsWith("research.")).map((span) => span.name)).toEqual(["research.plan", "research.read", "research.write", "research.run"]);
    for (const line of printed) expect(line).not.toContain(MARKER);
    expect(JSON.stringify(spans)).not.toContain(MARKER);

    /* the history: ids, values and instants, no word of the person's (invariant 35) */
    const payloads = payloadsOf(history.events ?? []);
    expect(payloads.length).toBeGreaterThan(8);
    expect(strangersIn(payloads)).toEqual([]);

    /* one record, signed by the person, naming the conversation; the reader's call and the writer's told apart by writingAt (48 § 15) */
    const record = await researchRecordAt(stepKeyOf(researchRunWorkflowId(runId), "research:1"));
    expect(record).toMatchObject({ actor: `user:${ASKER.id}`, suggestionId: null, chapterVersionId: null });
    const payload = ResearchPayloadSchema.parse(record?.payload);
    expect(payload).toMatchObject({ runId, conversationId, questionSha256: questionSha256Of(QUESTION), planned: "brief", findings: [{ ordinal: 1, outcome: "VALID" }], refusal: null, end: { state: "DONE", code: null }, models: { planner: "claude-haiku-4-5", reader: "claude-opus-5", writer: "claude-opus-5" } });
    expect(payload.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    const calls = await researchCallsOf({ userId: ASKER.id }, runId);
    const frontier = frontierCallsOf(calls, run?.writingAt ?? null);
    expect([frontier.reader.length, frontier.writer.length]).toEqual([1, 1]);
    expect(payload.usage.inputTokens).toBe(calls.reduce((sum, call) => sum + call.inputTokens, 0));
    first = { conversationId, brief: (await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.findUniqueOrThrow({ where: { id: runId }, select: { brief: true } }))).brief ?? "", report: report?.paragraphs[0]?.text ?? "" };
  });

  it("plans a seeded first run on the seed's claims and its uncovered sentence, the seed's cited section first among the run's sections, and leaves the seed answer as it was (48 § 2 A1, § 9.2)", async () => {
    const stub = stubOf();
    stub.bodies.length = 0;
    /* an answer of the person's own in the Assistant, citing a section, as the seed (48 A6) */
    const seedSection = (await getPrisma().section.findFirstOrThrow({ where: { chapterVersion: { releaseId }, layer: "MECHANISM", anchor: { startsWith: "21." } }, orderBy: { ordinal: "desc" }, select: { anchor: true } })).anchor;
    const chat = await createConversation(ASKER, { locale: "en" });
    const asked = await appendUserMessage(ASKER, chat.id, { text: "Why do idempotency keys matter?", mode: "explain", traceId: TRACE });
    const claim = "A retried write without a key is applied twice by the server.";
    const uncovered = "The book does not say how long a key is kept.";
    const answer = await appendAssistantMessage(
      ASKER,
      chat.id,
      {
        kind: "answer",
        refusal: null,
        claims: [{ text: claim, sectionId: parseSectionId(seedSection), figureId: null, valueText: null, found: true, substituted: false }],
        citations: [{ sectionId: parseSectionId(seedSection), figureId: null, version: "v1.0.0", editionLang: "EN" }],
        verdicts: [],
        grounded: 1,
        repaired: false,
        guide: { version: "v1.13", sha256: "a".repeat(64) },
        modelId: "claude-opus-5",
        timings: { scopeMs: 1, retrieveMs: 1, firstTokenMs: 1, draftMs: 1, sensorsMs: 1, graderMs: 1, totalMs: 6 },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        modeResult: null,
        uncovered: [{ sectionId: seedSection, text: uncovered }],
        retrievedSections: [seedSection],
      } as AnswerResult,
      { ordinal: asked.ordinal + 1, mode: "EXPLAIN", traceId: TRACE, promptSha256: "b".repeat(64), overBudget: false, ledger: null },
    );
    /* the answer as the Assistant keeps it, every column and every row hanging from it (invariant 31: the researcher never changes an answer) */
    const asStored = () =>
      withTenant(tenantOf(ASKER), () =>
        getPrisma().message.findUniqueOrThrow({ where: { id: answer.id }, select: { text: true, uncovered: true, retrievedSections: true, substituted: true, grounded: true, refusalCause: true, ledgerSeq: true, modeResult: true, citations: { orderBy: { ordinal: "asc" } }, verdicts: true, flags: true } }),
      );
    const before = await asStored();
    const { result, run } = await runOf(await conversationOf(answer.id), 1, "How long should a server keep an idempotency key?");
    expect(result.state).toBe("DONE");
    expect(run?.sectionAnchors[0]).toBe(seedSection);
    expect(run?.sectionAnchors.length).toBeGreaterThan(1);
    const planner = bodiesOf("planner")[0]?.body ?? "";
    expect(planner).toContain(claim);
    expect(planner).toContain(uncovered);
    expect(await asStored()).toEqual(before);
    /* and no legacy run names it: a research seeded from an answer is a conversation of its own (48 § 4.2) */
    expect(await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.count({ where: { messageId: answer.id } }))).toBe(0);
  });

  it("plans a follow-up on the earlier question and brief and never the report, and writes it with the earlier report", async () => {
    const stub = stubOf();
    stub.bodies.length = 0;
    if (first === null) throw new Error("the first case runs first");
    expect(first.brief.length).toBeGreaterThan(0);
    expect(first.report.length).toBeGreaterThan(0);
    const { result, run } = await runOf(first.conversationId, 2, "And how long should the key be kept after the first response?");
    expect(result.state).toBe("DONE");
    expect(run?.ordinal).toBe(2);
    const planner = bodiesOf("planner")[0]?.body ?? "";
    expect(planner).toContain(JSON.stringify(first.brief).slice(1, -1));
    expect(planner).not.toContain(JSON.stringify(first.report).slice(1, -1));
    expect(planner).toContain(MARKER);
    expect(bodiesOf("writer")[0]?.body ?? "").toContain(JSON.stringify(first.report).slice(1, -1));
  });
});
