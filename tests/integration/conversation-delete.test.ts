import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { appendAssistantMessage, appendFailedTurn, appendUserMessage, ASK_PATH, closeAbandonedTurn, createConversation, deleteConversation, getConversation, recordFlag } from "@/lib/db/assistant";
import { getPrisma } from "@/lib/db/client";
import { askerOfProposal, createResearchRun, DETACHED_RUN_KEPT_MS, readEndorsement, readResearchRun, removeEndorsement, runsStartedSince, sweepDetachedRuns, writeEndorsement, writeFinding, writeResearchFound, writeResearchState } from "@/lib/db/research";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";
import { ANSWER_DEADLINE_MS } from "@/lib/workers/client";

/*
 * A reader's delete of a conversation against the database (feature-specs/45 § 3.3, § 3.4, § 8; unit 62e): refused for
 * another reader's id and while the last turn may still write, with nothing changed; otherwise every row of it gone in
 * one transaction — the question, the answer, the citations, the verdicts, the flags — and the stored finals of its
 * turns forgotten; a research run with a workflow detached, without its text and in the state it was, and one without a
 * workflow gone with its message; the day's count of runs unchanged. A question racing the delete is the
 * delete's `NOT_FOUND`, and the purge skips a turn whose conversation went under it.
 */

const ready = env.DATABASE_URL !== undefined;
const ONE: SessionUser = { id: "00000000-0000-4000-8000-0000000e0001", organisationId: null, role: "READER", displayName: "Deleter", locale: "en", identityVerified: false, parts: [], sessionId: null };
const TWO: SessionUser = { id: "00000000-0000-4000-8000-0000000e0002", organisationId: null, role: "READER", displayName: "Other", locale: "en", identityVerified: false, parts: [], sessionId: null };
/** A reader whose last conversation goes: the sweep must still reach them (45 § 3.5). */
const THREE: SessionUser = { id: "00000000-0000-4000-8000-0000000e0003", organisationId: null, role: "READER", displayName: "Leaver", locale: "en", identityVerified: false, parts: [], sessionId: null };
const TRACE = "e".repeat(32);
const STAMP = Date.now().toString(16);
const QUESTION = `q${STAMP}`.padEnd(64, "0");
const SECTION = `21.3-${STAMP}`;

function answered(): AnswerResult {
  return {
    kind: "answer",
    refusal: null,
    claims: [{ text: "A retried write without a key is a second write.", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false }],
    citations: [{ sectionId: parseSectionId("21.3"), figureId: null, version: "v1.0.0", editionLang: "EN" }],
    verdicts: [{ sensor: "citation", verdict: "PASS", detail: "1 / 1 figures found at cited location", data: {} }],
    grounded: 1,
    repaired: false,
    guide: { version: "v1.13", sha256: "a".repeat(64) },
    modelId: "claude-opus-5",
    timings: { scopeMs: 1, retrieveMs: 200, firstTokenMs: 900, draftMs: 3000, sensorsMs: 5, graderMs: 800, totalMs: 4100 },
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 },
    modeResult: null,
    uncovered: [{ sectionId: "21.3", text: "Idempotency keys are also what makes a retried refund safe." }],
    retrievedSections: ["21.3"],
  } as AnswerResult;
}

/** A question and its answer, the answer with a citation and a verdict; `old` moves both past the answer's deadline. */
async function turn(user: SessionUser, conversationId: string, old = true): Promise<{ readonly question: string; readonly answer: string }> {
  const asked = await appendUserMessage(user, conversationId, { text: "Why do idempotency keys matter?", mode: "explain", traceId: TRACE });
  const answer = await appendAssistantMessage(user, conversationId, answered(), { ordinal: asked.ordinal + 1, mode: "EXPLAIN", traceId: TRACE, promptSha256: "b".repeat(64), overBudget: false, ledger: null });
  if (old) await aged(user, conversationId);
  return { question: asked.id, answer: answer.id };
}

/** Every row of the conversation dated past the answer's deadline, as a turn of ten minutes ago is. */
async function aged(user: SessionUser, conversationId: string): Promise<void> {
  await withTenant(tenantOf(user), () => getPrisma().message.updateMany({ where: { conversationId }, data: { createdAt: new Date(Date.now() - ANSWER_DEADLINE_MS - 60_000) } }));
}

/** The turn's `final` as the ask endpoint stores it under its key (45 § 3.4). */
async function storedFinal(user: SessionUser, messageId: string): Promise<string> {
  const key = randomUUID();
  await withTenant(tenantOf(user), () => getPrisma().idempotencyKey.create({ data: { userId: user.id, path: ASK_PATH, key, bodyHash: "c".repeat(64), status: 200, response: { messageId, ordinal: 2, kind: "answer" } } }));
  return key;
}

/** What is left of a conversation's rows, counted inside the reader's context. */
async function rowsOf(user: SessionUser, conversationId: string, messageIds: ReadonlyArray<string>) {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    return {
      conversation: await prisma.conversation.count({ where: { id: conversationId } }),
      messages: await prisma.message.count({ where: { id: { in: [...messageIds] } } }),
      citations: await prisma.citation.count({ where: { messageId: { in: [...messageIds] } } }),
      verdicts: await prisma.sensorVerdict.count({ where: { messageId: { in: [...messageIds] } } }),
      flags: await prisma.flag.count({ where: { messageId: { in: [...messageIds] } } }),
    };
  });
}

describe.skipIf(!ready)("a reader's delete of a conversation (45 § 3.3, § 3.4)", () => {
  beforeAll(async () => {
    await withSystem(async () => {
      for (const user of [ONE, TWO, THREE]) await getPrisma().user.upsert({ where: { id: user.id }, update: {}, create: { id: user.id, email: `${user.id}@delete.test`, displayName: user.displayName, role: "READER" } });
    });
  });

  afterAll(async () => {
    for (const user of [ONE, TWO, THREE]) {
      await withTenant(tenantOf(user), async () => {
        const prisma = getPrisma();
        await prisma.researchFinding.deleteMany({});
        await prisma.researchRun.deleteMany({});
        await prisma.proposalEndorsement.deleteMany({});
        const ids = (await prisma.message.findMany({ select: { id: true } })).map((message) => message.id);
        await prisma.flag.deleteMany({ where: { messageId: { in: ids } } });
        await prisma.citation.deleteMany({ where: { messageId: { in: ids } } });
        await prisma.sensorVerdict.deleteMany({ where: { messageId: { in: ids } } });
        await prisma.message.deleteMany({ where: { id: { in: ids } } });
        await prisma.conversation.deleteMany({});
        await prisma.idempotencyKey.deleteMany({ where: { path: ASK_PATH } });
      });
    }
    await withSystem(() => getPrisma().user.deleteMany({ where: { id: { in: [ONE.id, TWO.id, THREE.id] } } }));
  });

  it("refuses another reader's id and a turn that may still write, and changes nothing; deletes once the final is stored", async () => {
    /* a question still open: the flow may still be running */
    const open = await createConversation(ONE, { locale: "en" });
    const question = await appendUserMessage(ONE, open.id, { text: "Is a retry safe?", mode: "explain", traceId: TRACE });
    expect(await deleteConversation(ONE, open.id)).toEqual({ deleted: false, reason: "TURN_IN_PROGRESS" });
    expect(await deleteConversation(TWO, open.id)).toEqual({ deleted: false, reason: "NOT_FOUND" });
    expect(await deleteConversation(ONE, randomUUID())).toEqual({ deleted: false, reason: "NOT_FOUND" });
    expect(await rowsOf(ONE, open.id, [question.id])).toEqual({ conversation: 1, messages: 1, citations: 0, verdicts: 0, flags: 0 });

    /* answered moments ago, its final not stored yet: the tail may still write its record, its line, its run */
    const answering = await createConversation(ONE, { locale: "en" });
    const fresh = await turn(ONE, answering.id, false);
    expect(await deleteConversation(ONE, answering.id)).toEqual({ deleted: false, reason: "TURN_IN_PROGRESS" });
    expect(await rowsOf(ONE, answering.id, [fresh.question, fresh.answer])).toEqual({ conversation: 1, messages: 2, citations: 1, verdicts: 1, flags: 0 });
    /* the final stored is the turn's last write: settled, and its key forgotten with the rest */
    const key = await storedFinal(ONE, fresh.answer);
    expect(await deleteConversation(ONE, answering.id)).toEqual({ deleted: true, messages: 2, detached: 0, forgotten: 1 });
    expect(await withTenant(tenantOf(ONE), () => getPrisma().idempotencyKey.count({ where: { path: ASK_PATH, key } }))).toBe(0);
    expect(await rowsOf(ONE, answering.id, [fresh.question, fresh.answer])).toEqual({ conversation: 0, messages: 0, citations: 0, verdicts: 0, flags: 0 });
  });

  it("holds the delete while any answer younger than the deadline has no stored final, not only the last one (review of unit 62)", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    const earlier = await turn(ONE, conversation.id, false);
    const later = await turn(ONE, conversation.id, false);
    /* the later turn asked as soon as the earlier answer's row stood, and its final is stored; the earlier's tail still runs */
    const laterKey = await storedFinal(ONE, later.answer);
    expect(await deleteConversation(ONE, conversation.id)).toEqual({ deleted: false, reason: "TURN_IN_PROGRESS" });
    const earlierKey = await storedFinal(ONE, earlier.answer);
    expect(await deleteConversation(ONE, conversation.id)).toEqual({ deleted: true, messages: 4, detached: 0, forgotten: 2 });
    for (const key of [earlierKey, laterKey]) expect(await withTenant(tenantOf(ONE), () => getPrisma().idempotencyKey.count({ where: { path: ASK_PATH, key } }))).toBe(0);
  });

  it("deletes every row of a settled conversation — an abandoned question and a failed turn included — and forgets its finals, leaving another reader's", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    const first = await turn(ONE, conversation.id);
    await recordFlag(ONE, first.answer, "ANSWER", "wrong_citation");
    const failed = await appendFailedTurn(ONE, conversation.id, { ordinal: 3, mode: "EXPLAIN", traceId: TRACE, code: "GATEWAY_DOWN" });
    const abandoned = await appendUserMessage(ONE, conversation.id, { text: "And a refund?", mode: "explain", traceId: TRACE });
    await aged(ONE, conversation.id);
    const key = await storedFinal(ONE, first.answer);
    /* the other reader's turn and key are theirs */
    const theirs = await createConversation(TWO, { locale: "en" });
    const their = await turn(TWO, theirs.id);
    const theirKey = await storedFinal(TWO, their.answer);

    const ids = [first.question, first.answer, failed.id, abandoned.id];
    expect(await rowsOf(ONE, conversation.id, ids)).toEqual({ conversation: 1, messages: 4, citations: 1, verdicts: 2, flags: 1 });
    expect(await deleteConversation(ONE, conversation.id)).toEqual({ deleted: true, messages: 4, detached: 0, forgotten: 1 });
    expect(await rowsOf(ONE, conversation.id, ids)).toEqual({ conversation: 0, messages: 0, citations: 0, verdicts: 0, flags: 0 });
    expect(await getConversation(ONE, conversation.id)).toBeNull();
    expect(await withTenant(tenantOf(ONE), () => getPrisma().idempotencyKey.count({ where: { path: ASK_PATH, key } }))).toBe(0);
    /* a second delete is the first's 404 */
    expect(await deleteConversation(ONE, conversation.id)).toEqual({ deleted: false, reason: "NOT_FOUND" });

    expect(await rowsOf(TWO, theirs.id, [their.question, their.answer])).toEqual({ conversation: 1, messages: 2, citations: 1, verdicts: 1, flags: 0 });
    expect(await withTenant(tenantOf(TWO), () => getPrisma().idempotencyKey.count({ where: { path: ASK_PATH, key: theirKey } }))).toBe(1);
  });

  it("detaches a run with a workflow, without its text and in its state, and lets one without go with its message; the day's count stays (45 § 3.5)", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    const working = await turn(ONE, conversation.id);
    const skipped = await turn(ONE, conversation.id);
    const now = new Date();
    const base = { releaseId: "2026.09", locale: "EN" as const, gap: true, sectionAnchors: [SECTION], questionSha256: QUESTION, traceId: TRACE };
    const run = await createResearchRun(ONE, { ...base, messageId: working.answer, state: "QUEUED", skip: null, workflowId: `research:${working.answer}` }, now);
    await writeResearchState({ id: run.id, userId: ONE.id }, "PLANNING", { brief: "What the book lacks on refunds.", briefSha256: "d".repeat(64) }, now);
    await writeResearchFound({ id: run.id, userId: ONE.id }, { findings: [], pages: ["https://standards.example/keys"] });
    const unstarted = await createResearchRun(ONE, { ...base, messageId: skipped.answer, state: "SKIPPED", skip: "OFF_USER", workflowId: null }, now);
    const since = new Date(now.getTime() - 86_400_000);
    const counted = await runsStartedSince(ONE, since);

    const deletedAt = new Date();
    expect(await deleteConversation(ONE, conversation.id, deletedAt)).toEqual({ deleted: true, messages: 4, detached: 1, forgotten: 0 });
    expect(await readResearchRun(run.id, ONE.id)).toMatchObject({ messageId: null, state: "PLANNING", briefSha256: "d".repeat(64), workflowId: `research:${working.answer}`, textPurgedAt: deletedAt });
    expect(await withTenant(tenantOf(ONE), () => getPrisma().researchRun.findUniqueOrThrow({ where: { id: run.id }, select: { brief: true, found: true } }))).toEqual({ brief: null, found: null });
    expect(await readResearchRun(unstarted.id, ONE.id)).toBeNull();
    expect(await runsStartedSince(ONE, since)).toBe(counted);
  });

  it("sweeps a detached run once the cap's day has passed and its workflow has ended, keeping its proposal; keeps a young one, a running one, and every one while the engine is away; reaches a reader with no conversation left (45 § 3.5)", async () => {
    const conversation = await createConversation(THREE, { locale: "en" });
    const ended = await turn(THREE, conversation.id);
    const working = await turn(THREE, conversation.id);
    const young = await turn(THREE, conversation.id);
    const now = new Date();
    const dayBefore = new Date(now.getTime() - DETACHED_RUN_KEPT_MS - 3_600_000);
    const base = { releaseId: "2026.09", locale: "EN" as const, gap: true, sectionAnchors: ["21.3"], questionSha256: QUESTION, traceId: TRACE, state: "QUEUED" as const, skip: null };
    const endedRun = await createResearchRun(THREE, { ...base, messageId: ended.answer, workflowId: `research:${ended.answer}` }, dayBefore);
    const workingRun = await createResearchRun(THREE, { ...base, messageId: working.answer, workflowId: `research:${working.answer}` }, dayBefore);
    const youngRun = await createResearchRun(THREE, { ...base, messageId: young.answer, workflowId: `research:${young.answer}` }, now);
    const proposal = `S-98-${STAMP.slice(-4)}`;
    await writeFinding({ id: endedRun.id, userId: THREE.id }, { ordinal: 1, outcome: "PROPOSED", invalidReason: null, suggestionId: proposal });
    await writeFinding({ id: endedRun.id, userId: THREE.id }, { ordinal: 2, outcome: "INVALID", invalidReason: "SOURCE_NOT_SEEN", suggestionId: null });
    /* the asker's name on the proposal: its row's only key is to the reader, so no delete reaches it */
    const named = await writeEndorsement(THREE, proposal, now);
    expect(await deleteConversation(THREE, conversation.id)).toMatchObject({ deleted: true, detached: 3 });
    const counted = await runsStartedSince(THREE, new Date(now.getTime() - DETACHED_RUN_KEPT_MS));

    /* the engine away: nothing is deleted, and the counts say the step stopped */
    expect(await sweepDetachedRuns({ now, reader: THREE.id, running: async () => null })).toEqual({ readers: 1, deleted: 0, running: 0, proposalsKept: 0, findingsKept: 0, findingsDeleted: 0, engineAnswered: false });
    const asked: string[] = [];
    const running = async (workflowId: string) => {
      asked.push(workflowId);
      return workflowId === `research:${working.answer}`;
    };
    expect(await sweepDetachedRuns({ now, reader: THREE.id, running })).toEqual({ readers: 1, deleted: 1, running: 1, proposalsKept: 1, findingsKept: 0, findingsDeleted: 0, engineAnswered: true });
    /* the young run is not asked about: the cap still counts it */
    expect(asked.sort()).toEqual([`research:${ended.answer}`, `research:${working.answer}`].sort());
    expect(await readResearchRun(endedRun.id, THREE.id)).toBeNull();
    expect(await readResearchRun(workingRun.id, THREE.id)).toMatchObject({ messageId: null });
    expect(await readResearchRun(youngRun.id, THREE.id)).toMatchObject({ messageId: null });
    /* the proposal outlives its run, still the asker's; the run's other finding went with it */
    expect(await withTenant(tenantOf(THREE), () => getPrisma().researchFinding.findMany({ where: { suggestionId: proposal }, select: { runId: true, outcome: true } }))).toEqual([{ runId: null, outcome: "PROPOSED" }]);
    expect(await withTenant(tenantOf(THREE), () => getPrisma().researchFinding.count({ where: { outcome: "INVALID" } }))).toBe(0);
    expect(await askerOfProposal(THREE, proposal)).toBe(true);
    /* and the name on it still the reader's to take back, as Remove my name on the Improve list does (45 § 3.6) */
    expect(named).toMatchObject({ written: true });
    const standing = await readEndorsement(THREE, proposal);
    expect(standing).not.toBeNull();
    expect(await removeEndorsement(THREE, proposal, standing?.createdAt ?? now)).toBe(true);
    expect(await runsStartedSince(THREE, new Date(now.getTime() - DETACHED_RUN_KEPT_MS))).toBe(counted);
  });

  it("answers a question racing the delete with NOT_FOUND, never a 500: whichever comes first, the other is refused", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    await turn(ONE, conversation.id);
    const [deleted, asked] = await Promise.allSettled([deleteConversation(ONE, conversation.id), appendUserMessage(ONE, conversation.id, { text: "One more?", mode: "explain", traceId: TRACE })]);
    expect(deleted.status).toBe("fulfilled");
    const outcome = deleted.status === "fulfilled" ? deleted.value : null;
    if (outcome?.deleted === true) expect(asked).toMatchObject({ status: "rejected", reason: { code: "NOT_FOUND" } });
    else expect([outcome, asked.status]).toEqual([{ deleted: false, reason: "TURN_IN_PROGRESS" }, "fulfilled"]);
    /* and after it, the question's insert fails on the key: the same 404 */
    const gone = await createConversation(ONE, { locale: "en" });
    expect(await deleteConversation(ONE, gone.id)).toEqual({ deleted: true, messages: 0, detached: 0, forgotten: 0 });
    await expect(appendUserMessage(ONE, gone.id, { text: "Still there?", mode: "explain", traceId: TRACE })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets the purge skip an abandoned turn whose conversation was deleted under it, and close one whose was not", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    const question = await appendUserMessage(ONE, conversation.id, { text: "Left open?", mode: "explain", traceId: TRACE });
    const abandoned = { conversationId: conversation.id, ordinal: question.ordinal, mode: "EXPLAIN" as const, traceId: TRACE };
    expect(await withTenant(tenantOf(ONE), () => closeAbandonedTurn(ONE.id, { ...abandoned, conversationId: randomUUID() }))).toBe(false);
    expect(await withTenant(tenantOf(ONE), () => closeAbandonedTurn(ONE.id, abandoned))).toBe(true);
    expect((await getConversation(ONE, conversation.id))?.messages.map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
  });
});
