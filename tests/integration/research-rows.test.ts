import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { appendAssistantMessage, appendUserMessage, createConversation, getConversation, purgeAssistantText } from "@/lib/db/assistant";
import { getPrisma } from "@/lib/db/client";
import { createResearchRun, readResearchCitations, readResearchFound, readResearchRun, readResearchTurn, readResearchView, readResearchViews, researchTraceOf, researchTraceOfFinding, runsStartedSince, writeBudgetMark, writeResearchCounts, writeResearchFound, writeResearchState } from "@/lib/db/research";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseFigureId, parseSectionId } from "@/lib/schemas/ids";
import { BUDGET_MARK } from "@/lib/schemas/research";

/*
 * The research rows against the database (feature-specs/40 § 3, § 4, § 8; unit 57a, 57b, 57e): a run and what it found
 * are the asker's own, refused by the tenant filter for another reader; what a turn hands over is on the message and
 * read back only inside the asker's context; the budget mark a legacy run sets at the platform's cap; and the purge,
 * which takes the brief and the uncovered sentences and what the reader found with the message's text, stamps the run,
 * and ends one still waiting as SKIPPED · TEXT_PURGED. The reader's switch and the section's and question's marks went
 * with the hand-over in unit 75 (feature-specs/48 § 4.3, § 9.2, § 9.4), and their case with them.
 */

const ready = env.DATABASE_URL !== undefined;
const ONE: SessionUser = { id: "00000000-0000-4000-8000-0000000d0001", organisationId: null, role: "READER", displayName: "Asker", locale: "en", identityVerified: false, parts: [], sessionId: null };
const TWO: SessionUser = { id: "00000000-0000-4000-8000-0000000d0002", organisationId: null, role: "READER", displayName: "Other", locale: "en", identityVerified: false, parts: [], sessionId: null };

function result(): AnswerResult {
  return {
    kind: "answer",
    refusal: null,
    claims: [
      { text: "A retried write without a key is a second write.", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false },
      { text: "the book does not cover this", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: false, substituted: true },
    ],
    citations: [{ sectionId: parseSectionId("21.3"), figureId: parseFigureId("F-21-07"), version: "v1.0.0", editionLang: "EN" }],
    verdicts: [],
    grounded: 0.75,
    repaired: false,
    guide: { version: "v1.13", sha256: "a".repeat(64) },
    modelId: "claude-opus-5",
    timings: { scopeMs: 1, retrieveMs: 200, firstTokenMs: 900, draftMs: 3000, sensorsMs: 5, graderMs: 800, totalMs: 4100 },
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 },
    modeResult: null,
    uncovered: [{ sectionId: "21.3", text: "Idempotency keys are also what makes a retried refund safe." }],
    retrievedSections: ["21.3", "21.4"],
  } as AnswerResult;
}

describe.skipIf(!ready)("the research rows against the database (40 § 3, § 4, § 8)", () => {
  beforeAll(async () => {
    await withSystem(async () => {
      for (const user of [ONE, TWO]) await getPrisma().user.upsert({ where: { id: user.id }, update: {}, create: { id: user.id, email: `${user.id}@research.test`, displayName: user.displayName, role: "READER" } });
    });
  });

  /* the budget mark is the platform's, read by every turn: the suite's own is written over it, and it is put back after */
  let budgetBefore: { readonly key: string; readonly at: Date; readonly until: Date | null } | null = null;
  /* the instant the suite writes its own budget mark at */
  const suiteAt = new Date();
  beforeAll(async () => {
    budgetBefore = await getPrisma().researchMark.findUnique({ where: { key: BUDGET_MARK }, select: { key: true, at: true, until: true } });
  });

  afterAll(async () => {
    for (const user of [ONE, TWO]) {
      await withTenant(tenantOf(user), async () => {
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
    }
    /* the platform's own budget mark as it stood — on a machine where research is live it is the cap's — and only while the suite's own stands: a planner at the cap since keeps its own (review of unit 61) */
    const ours = await getPrisma().researchMark.deleteMany({ where: { key: BUDGET_MARK, at: suiteAt } });
    if (ours.count > 0 && budgetBefore !== null) await getPrisma().researchMark.create({ data: budgetBefore });
    await withSystem(() => getPrisma().user.deleteMany({ where: { id: { in: [ONE.id, TWO.id] } } }));
  });

  it("keeps a run and what the turn handed over as the asker's own: another reader's context sees nothing, the uncovered sentences are read back inside the asker's", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    await appendUserMessage(ONE, conversation.id, { text: "Why do idempotency keys matter?", mode: "explain", traceId: "f".repeat(32) });
    const answer = await appendAssistantMessage(ONE, conversation.id, result(), { ordinal: 2, mode: "EXPLAIN", traceId: "f".repeat(32), promptSha256: "b".repeat(64), overBudget: false, ledger: { seq: 1, hash: "c".repeat(64) } });
    const now = new Date();
    const run = await createResearchRun(ONE, { messageId: answer.id, releaseId: "2026.09", locale: "EN", gap: true, sectionAnchors: ["21.3"], questionSha256: "e".repeat(64), traceId: "f".repeat(32), state: "QUEUED", skip: null, workflowId: `research:${answer.id}` }, now);
    await writeResearchState({ id: run.id, userId: ONE.id }, "PLANNING", { brief: "What the book lacks on refunds.", briefSha256: "d".repeat(64) }, now);
    /* the reader step writes its counts first, then what it found (45 § 3.5) */
    await writeResearchCounts({ id: run.id, userId: ONE.id }, { searches: 2, pageReads: 1 });
    await writeResearchFound({ id: run.id, userId: ONE.id }, { findings: [], pages: ["https://standards.example/keys"] });

    /* the asker's context reads it; the other reader's finds nothing; the platform's read for the workflow knows whose it is */
    expect(await withTenant(tenantOf(ONE), () => getPrisma().researchRun.count({ where: { id: run.id } }))).toBe(1);
    expect(await withTenant(tenantOf(TWO), () => getPrisma().researchRun.count({ where: { id: run.id } }))).toBe(0);
    expect(await withTenant(tenantOf(TWO), () => getPrisma().message.count({ where: { id: answer.id } }))).toBe(0);
    expect(await readResearchRun(run.id, TWO.id)).toBeNull();
    const row = await readResearchRun(run.id, ONE.id);
    expect(row).toMatchObject({ userId: ONE.id, messageId: answer.id, state: "PLANNING", gap: true, sectionAnchors: ["21.3"], briefSha256: "d".repeat(64), searches: 2, pageReads: 1, textPurgedAt: null });
    expect(await readResearchFound({ id: run.id, userId: ONE.id })).toEqual({ findings: [], pages: ["https://standards.example/keys"] });
    expect(await readResearchFound({ id: run.id, userId: TWO.id })).toBeNull();
    const turn = await readResearchTurn({ userId: ONE.id, messageId: answer.id });
    expect(turn).toEqual({ question: "Why do idempotency keys matter?", answer: expect.stringContaining("A retried write") as string, uncovered: [{ sectionId: "21.3", text: "Idempotency keys are also what makes a retried refund safe." }], retrievedSections: ["21.3", "21.4"] });
    /* a run detached from its message by a conversation's delete reads no turn and no citation: a filter on a null id is never sent (45 § 3.5) */
    expect(await readResearchTurn({ userId: ONE.id, messageId: null })).toBeNull();
    expect(await readResearchCitations({ userId: ONE.id, messageId: null })).toEqual([]);
    expect(await runsStartedSince(ONE, new Date(now.getTime() - 86_400_000))).toBe(1);
    expect(await runsStartedSince(TWO, new Date(now.getTime() - 86_400_000))).toBe(0);

    /* the line's view (43 § 4.3; unit 60a): the asker's, whole; another reader's context finds nothing; the conversation's read carries it */
    expect(await readResearchView(ONE, answer.id, now)).toEqual({ state: "PLANNING", skip: null, days: null, resetsAt: null, proposals: [] });
    expect(await readResearchView(TWO, answer.id, now)).toBeNull();
    expect(await readResearchViews(ONE, [answer.id, "00000000-0000-4000-8000-00000000dead"], now)).toEqual(new Map([[answer.id, { state: "PLANNING", skip: null, days: null, resetsAt: null, proposals: [] }]]));
    const read = await getConversation(ONE, conversation.id);
    expect(read?.messages.find((message) => message.id === answer.id)?.research).toEqual({ state: "PLANNING", skip: null, days: null, resetsAt: null, proposals: [] });
    expect(read?.messages.find((message) => message.role === "USER")?.research).toBeNull();
  });

  it("keeps a person's research conversation as their own, and a run follows an answer or belongs to a conversation, never both (48 § 4.2; unit 68a)", async () => {
    const prisma = getPrisma();
    const research = await withTenant(tenantOf(ONE), () => prisma.researchConversation.create({ data: { userId: ONE.id, organisationId: null, locale: "EN" } }));
    /* the asker's own row: another person's context finds nothing, and no context is refused */
    expect(await withTenant(tenantOf(ONE), () => prisma.researchConversation.count({ where: { id: research.id } }))).toBe(1);
    expect(await withTenant(tenantOf(TWO), () => prisma.researchConversation.count({ where: { id: research.id } }))).toBe(0);
    await expect(prisma.researchConversation.count({ where: { id: research.id } })).rejects.toThrow(/tenant/i);

    /* a run of the conversation: no message, its ordinal unique within it */
    const base = { userId: ONE.id, organisationId: null, releaseId: "2026.09", locale: "EN" as const, state: "REFUSED" as const, gap: false, sectionAnchors: [], questionSha256: "e".repeat(64), traceId: "f".repeat(32), refusal: "R-SCOPE-OT" };
    const run = await withTenant(tenantOf(ONE), () => prisma.researchRun.create({ data: { ...base, conversationId: research.id, ordinal: 1, question: "How do I bypass the interlock on the line?" } }));
    expect(run).toMatchObject({ messageId: null, conversationId: research.id, ordinal: 1, targetAnchors: [], steps: null, report: null, workflowId: null });
    await expect(withTenant(tenantOf(ONE), () => prisma.researchRun.create({ data: { ...base, conversationId: research.id, ordinal: 1 } }))).rejects.toThrow();

    /* never an answer's and a conversation's at once: the CHECK refuses it */
    const conversation = await createConversation(ONE, { locale: "en" });
    await appendUserMessage(ONE, conversation.id, { text: "Why do idempotency keys matter?", mode: "explain", traceId: "f".repeat(32) });
    const answer = await appendAssistantMessage(ONE, conversation.id, result(), { ordinal: 2, mode: "EXPLAIN", traceId: "f".repeat(32), promptSha256: "b".repeat(64), overBudget: false, ledger: { seq: 1, hash: "c".repeat(64) } });
    await expect(withTenant(tenantOf(ONE), () => prisma.researchRun.create({ data: { ...base, messageId: answer.id, conversationId: research.id, ordinal: 2 } }))).rejects.toThrow(/message_or_conversation/);

    /* a finding of a person's run: VALID, with the send's two columns empty until a send */
    const finding = await withTenant(tenantOf(ONE), () => prisma.researchFinding.create({ data: { runId: run.id, userId: ONE.id, ordinal: 1, outcome: "VALID" } }));
    expect(finding).toMatchObject({ outcome: "VALID", failure: null, sentAt: null, suggestionId: null });

    /* the conversation's delete takes a run with no workflow, and its finding, by the cascade (48 § 17.2) */
    await withTenant(tenantOf(ONE), () => prisma.researchConversation.delete({ where: { id: research.id } }));
    expect(await withTenant(tenantOf(ONE), () => prisma.researchRun.count({ where: { id: run.id } }))).toBe(0);
    expect(await withTenant(tenantOf(ONE), () => prisma.researchFinding.count({ where: { id: finding.id } }))).toBe(0);
  });

  it("purges the brief and the uncovered sentences with the message's text, stamps the run, and ends one still waiting as SKIPPED · TEXT_PURGED; hashes and anchors stay", async () => {
    /* the answer this suite's run names: on a database used twice, an earlier run's answers may still be the reader's */
    const own = await withTenant(tenantOf(ONE), () => getPrisma().researchRun.findFirstOrThrow({ where: { messageId: { not: null } }, orderBy: { createdAt: "desc" }, select: { id: true, messageId: true } }));
    const answerId = own.messageId ?? "";
    const before = await readResearchRun(own.id, ONE.id);
    expect(before?.state).toBe("PLANNING");
    const later = new Date(Date.now() + 31 * 86_400_000);
    const counts = await purgeAssistantText({ now: later, abandonedAfterMs: 3_600_000, reader: ONE.id });
    expect(counts.researchRuns).toBeGreaterThanOrEqual(1);
    const after = await readResearchRun(before?.id ?? "", ONE.id);
    expect(after).toMatchObject({ state: "SKIPPED", skip: "TEXT_PURGED", briefSha256: "d".repeat(64), sectionAnchors: ["21.3"], questionSha256: "e".repeat(64) });
    expect(after?.textPurgedAt).not.toBeNull();
    const row = await withTenant(tenantOf(ONE), () => getPrisma().researchRun.findUniqueOrThrow({ where: { id: before?.id ?? "" }, select: { brief: true, found: true, searches: true } }));
    expect(row).toEqual({ brief: null, found: null, searches: 2 });
    const message = await withTenant(tenantOf(ONE), () => getPrisma().message.findUniqueOrThrow({ where: { id: answerId }, select: { text: true, uncovered: true, retrievedSections: true } }));
    expect(message).toEqual({ text: null, uncovered: null, retrievedSections: ["21.3", "21.4"] });
    /* a run the purge ended is not moved again, and no text lands on it (review of units 57–58) */
    const runRef = { id: before?.id ?? "", userId: ONE.id };
    expect(await writeResearchState(runRef, "READING", { brief: "late", briefSha256: "a".repeat(64) }, later)).toEqual({ written: false });
    expect(await writeResearchState(runRef, "DONE", {}, later)).toEqual({ written: false });
    expect(await writeResearchFound(runRef, { findings: [], pages: [] })).toEqual({ written: false });
    expect(await readResearchRun(runRef.id, ONE.id)).toMatchObject({ state: "SKIPPED", skip: "TEXT_PURGED", briefSha256: "d".repeat(64) });
    /* the day's count takes every run that had a workflow, however it ended: this one, skipped by the purge, still counts */
    expect(await runsStartedSince(ONE, new Date(Date.now() - 86_400_000))).toBe(1);
  });

  it("writes the budget mark a legacy run sets at the platform's cap, which its line reads back with its reset (40 § 7.2)", async () => {
    /* since unit 75 nothing writes a section's or a question's mark, and the reader's switch is read by nothing (48 § 4.3, § 9.4) */
    const at = suiteAt;
    await writeBudgetMark(at, new Date(at.getTime() + 3_600_000));
    const mark = await getPrisma().researchMark.findUniqueOrThrow({ where: { key: BUDGET_MARK }, select: { at: true, until: true } });
    expect(mark).toEqual({ at, until: new Date(at.getTime() + 3_600_000) });
    /* the first case's legacy run, as it would stand asleep at the cap */
    const run = await withTenant(tenantOf(ONE), () => getPrisma().researchRun.findFirstOrThrow({ where: { messageId: { not: null } }, select: { id: true, messageId: true } }));
    await withTenant(tenantOf(ONE), () => getPrisma().researchRun.update({ where: { id: run.id }, data: { state: "WAITING_BUDGET", skip: null } }));
    expect(await readResearchView(ONE, run.messageId ?? "")).toMatchObject({ state: "WAITING_BUDGET", resetsAt: new Date(at.getTime() + 3_600_000).toISOString() });
  });

  it("reads a run's trace by its id or its message's, and a finding's by its run, with no reader's context, and nothing for one gone or detached (49 § 7.2; unit 84)", async () => {
    const prisma = getPrisma();
    /* the other reader's rows, so the first case's legacy run stays the one the budget case reads */
    const turnTrace = "a1".repeat(16);
    const conversation = await createConversation(TWO, { locale: "en" });
    await appendUserMessage(TWO, conversation.id, { text: "Why do idempotency keys matter?", mode: "explain", traceId: turnTrace });
    const answer = await appendAssistantMessage(TWO, conversation.id, result(), { ordinal: 2, mode: "EXPLAIN", traceId: turnTrace, promptSha256: "b".repeat(64), overBudget: false, ledger: { seq: 1, hash: "c".repeat(64) } });
    const legacy = await createResearchRun(TWO, { messageId: answer.id, releaseId: "2026.09", locale: "EN", gap: true, sectionAnchors: ["21.3"], questionSha256: "e".repeat(64), traceId: turnTrace, state: "QUEUED", skip: null, workflowId: `research:${answer.id}` }, new Date());
    const research = await withTenant(tenantOf(TWO), () => prisma.researchConversation.create({ data: { userId: TWO.id, organisationId: null, locale: "EN" } }));
    const run = await withTenant(tenantOf(TWO), () => prisma.researchRun.create({ data: { userId: TWO.id, organisationId: null, releaseId: "2026.09", locale: "EN", state: "QUEUED", gap: false, sectionAnchors: [], questionSha256: "e".repeat(64), traceId: "b2".repeat(16), conversationId: research.id, ordinal: 1 } }));
    const finding = await withTenant(tenantOf(TWO), () => prisma.researchFinding.create({ data: { runId: run.id, userId: TWO.id, ordinal: 1, outcome: "VALID" } }));
    const detached = await withTenant(tenantOf(TWO), () => prisma.researchFinding.create({ data: { runId: null, userId: TWO.id, ordinal: 1, outcome: "PROPOSED" } }));

    /* outside any tenant context, as the activity interceptor reads: the guard would refuse a model read here */
    expect(await researchTraceOf(run.id)).toEqual({ runId: run.id, traceId: "b2".repeat(16) });
    expect(await researchTraceOf(answer.id)).toEqual({ runId: legacy.id, traceId: turnTrace });
    expect(await researchTraceOf(legacy.id)).toEqual({ runId: legacy.id, traceId: turnTrace });
    expect(await researchTraceOfFinding(finding.id)).toEqual({ runId: run.id, traceId: "b2".repeat(16) });
    expect(await researchTraceOfFinding(detached.id)).toBeNull();
    const gone = "77777777-7777-4777-8777-777777777777";
    expect(await researchTraceOf(gone)).toBeNull();
    expect(await researchTraceOfFinding(gone)).toBeNull();
    /* a run deleted takes its trace with it */
    await withTenant(tenantOf(TWO), () => prisma.researchConversation.delete({ where: { id: research.id } }));
    expect(await researchTraceOf(run.id)).toBeNull();
    expect(await researchTraceOfFinding(finding.id)).toBeNull();
  });
});
