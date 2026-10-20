import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { appendAssistantMessage, appendUserMessage, createConversation } from "@/lib/db/assistant";
import { getPrisma } from "@/lib/db/client";
import { Prisma } from "@/lib/db/generated/client";
import {
  appendRunStep,
  completeRunStep,
  createConversationRun,
  DETACHED_RUN_KEPT_MS,
  ENDED_STATES,
  purgeResearchRuns,
  readConversationRun,
  readEarlierRuns,
  readRunQuestion,
  readRunReport,
  readRunSeed,
  readRunSteps,
  runsStartedSince,
  sweepDetachedRuns,
  writeBudgetResetsAt,
  writeResearchState,
  writeRunQuestion,
  writeRunReport,
  writeWritingAt,
} from "@/lib/db/research";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { questionSha256Of } from "@/lib/research/question";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";
import type { FindingOutcome, ResearchSkip, ResearchState } from "@/lib/schemas/research";
import { findingWorkflowId, researchRunWorkflowId } from "@/lib/schemas/workflows";

/*
 * The door of a person's research run against the database (feature-specs/48 § 5, § 6, § 17; unit 70a): the live steps
 * appended and completed in one statement each, in order, once where asked, and never onto a run whose text is gone;
 * the guarded writes of the question, the report and `writingAt`; `REFUSED` an end; the day's count without the runs
 * that spent nothing; the seed and the earlier runs as a run's planner reads them. The sweep of detached runs reads
 * "detached" as neither a message nor a conversation (§ 17.2), so a person's live research is never swept, and it keeps
 * a sent finding while its workflow runs and takes what is no proposal of the asker's. The door's insert of a run takes
 * the next ordinal and clears its research's stamp in the same transaction (review of unit 70). The retention case is
 * named for the purge, which a database suite never runs unasked (tests/integration/research-door.test.ts names it so);
 * it wipes the asker's rows first, so it counts the same alone and after the other cases.
 */

const ready = env.DATABASE_URL !== undefined;
const ASKER: SessionUser = { id: "00000000-0000-4000-8000-0000000d7001", organisationId: null, role: "READER", displayName: "Door Asker", locale: "en", identityVerified: false, parts: [], sessionId: null };
const OTHER: SessionUser = { id: "00000000-0000-4000-8000-0000000d7002", organisationId: null, role: "READER", displayName: "Door Other", locale: "en", identityVerified: false, parts: [], sessionId: null };
const TRACE = "c".repeat(32);
const DAY = 86_400_000;
const S213 = parseSectionId("21.3");

async function conversationOf(user: SessionUser, seedMessageId: string | null = null): Promise<string> {
  const row = await withTenant(tenantOf(user), () => getPrisma().researchConversation.create({ data: { userId: user.id, locale: "EN", seedMessageId }, select: { id: true } }));
  return row.id;
}

/** A run as the start endpoint (unit 71) would leave it, written here: no endpoint starts one in this unit. */
async function runOf(
  user: SessionUser,
  over: { readonly conversationId: string | null; readonly ordinal?: number | null; readonly state?: ResearchState; readonly skip?: ResearchSkip | null; readonly question?: string | null; readonly createdAt?: Date; readonly withWorkflow?: boolean; readonly textPurgedAt?: Date | null },
): Promise<{ readonly id: string; readonly userId: string }> {
  return withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const created = await prisma.researchRun.create({
      data: {
        userId: user.id,
        organisationId: null,
        conversationId: over.conversationId,
        ordinal: over.ordinal === undefined ? 1 : over.ordinal,
        releaseId: "2026.09",
        locale: "EN",
        state: over.state ?? "QUEUED",
        skip: over.skip ?? null,
        gap: false,
        sectionAnchors: ["21.3"],
        questionSha256: "a".repeat(64),
        question: over.question === undefined ? "Why does a retried write without a key become a second write?" : over.question,
        traceId: TRACE,
        textPurgedAt: over.textPurgedAt ?? null,
        createdAt: over.createdAt ?? new Date(),
      },
      select: { id: true },
    });
    if (over.withWorkflow !== false) await prisma.researchRun.update({ where: { id: created.id }, data: { workflowId: researchRunWorkflowId(created.id) } });
    return { id: created.id, userId: user.id };
  });
}

async function findingOf(user: SessionUser, runId: string | null, ordinal: number, outcome: FindingOutcome, suggestionId: string | null = null): Promise<string> {
  const row = await withTenant(tenantOf(user), () => getPrisma().researchFinding.create({ data: { runId, userId: user.id, ordinal, outcome, invalidReason: outcome === "INVALID" ? "SOURCE_NOT_SEEN" : null, suggestionId }, select: { id: true } }));
  return row.id;
}

async function wipe(user: SessionUser): Promise<void> {
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

describe.skipIf(!ready)("a person's research run's door against the database (48 § 5, § 6, § 17)", () => {
  beforeAll(async () => {
    await withSystem(async () => {
      for (const user of [ASKER, OTHER]) await getPrisma().user.upsert({ where: { id: user.id }, update: {}, create: { id: user.id, email: `${user.id}@door.test`, displayName: user.displayName, role: "READER" } });
    });
    for (const user of [ASKER, OTHER]) await wipe(user);
  });

  afterAll(async () => {
    for (const user of [ASKER, OTHER]) await wipe(user);
    await withSystem(() => getPrisma().user.deleteMany({ where: { id: { in: [ASKER.id, OTHER.id] } } }));
  });

  it("appends each live step in order with its place as its seq, completes it in place, writes a `once` step once, and writes no step onto a run whose text is gone (48 § 6)", async () => {
    const conversationId = await conversationOf(ASKER);
    const run = await runOf(ASKER, { conversationId });
    const at = new Date().toISOString();
    expect(await appendRunStep(run, { kind: "PLANNING", at }, { once: true })).toBe(0);
    /* a retried load writes its step once */
    expect(await appendRunStep(run, { kind: "PLANNING", at }, { once: true })).toBeNull();
    expect(await appendRunStep(run, { kind: "SECTIONS", at, sections: [S213] })).toBe(1);
    const search = await appendRunStep(run, { kind: "SEARCH", at, query: "idempotency key retention 2026", results: null });
    const page = await appendRunStep(run, { kind: "PAGE", at, url: "https://standards.example/keys", title: null, opened: null });
    expect([search, page]).toEqual([2, 3]);
    expect(await completeRunStep(run, 2, { results: 6 })).toBe(true);
    expect(await completeRunStep(run, 3, { url: "https://standards.example/keys/2026", title: "Idempotency keys, 2026", opened: true })).toBe(true);
    /* a completion aimed at no step of that seq changes nothing */
    expect(await completeRunStep(run, 9, { results: 1 })).toBe(false);
    /* another's run is not reached: the asker's id is a condition of each statement */
    expect(await appendRunStep({ id: run.id, userId: OTHER.id }, { kind: "CHECKING", at })).toBeNull();
    expect(await completeRunStep({ id: run.id, userId: OTHER.id }, 2, { results: 0 })).toBe(false);
    expect(await readRunSteps(run)).toEqual([
      { seq: 0, kind: "PLANNING", at },
      { seq: 1, kind: "SECTIONS", at, sections: ["21.3"] },
      { seq: 2, kind: "SEARCH", at, query: "idempotency key retention 2026", results: 6 },
      { seq: 3, kind: "PAGE", at, url: "https://standards.example/keys/2026", title: "Idempotency keys, 2026", opened: true },
    ]);
    /* a page that could not be reached keeps the address asked */
    const unreachable = await appendRunStep(run, { kind: "PAGE", at, url: "https://down.example/", title: null, opened: null });
    expect(await completeRunStep(run, unreachable ?? -1, { opened: false })).toBe(true);
    expect((await readRunSteps(run)).at(-1)).toEqual({ seq: 4, kind: "PAGE", at, url: "https://down.example/", title: null, opened: false });
    /* a step of another shape is refused before it is stored */
    await expect(appendRunStep(run, { kind: "SEARCH", at, query: "", results: null })).rejects.toThrow();
    /* the text gone (a delete detached the run): neither statement writes */
    await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.update({ where: { id: run.id }, data: { textPurgedAt: new Date() } }));
    expect(await appendRunStep(run, { kind: "CHECKING", at })).toBeNull();
    expect(await completeRunStep(run, 2, { results: 7 })).toBe(false);
    expect(await readRunSteps(run)).toHaveLength(5);
  });

  it("writes the question redacted again, the report and `writingAt` as guarded writes: the question and the report never onto a run whose text is gone, `writingAt` once (48 § 5.1, § 5.7, § 15)", async () => {
    const conversationId = await conversationOf(ASKER);
    const run = await runOf(ASKER, { conversationId });
    expect(await readRunQuestion(run)).toBe("Why does a retried write without a key become a second write?");
    expect(await writeRunQuestion(run, "Is [redacted:api-key] safe to retry?", "b".repeat(64))).toEqual({ written: true });
    expect(await readRunQuestion(run)).toBe("Is [redacted:api-key] safe to retry?");
    expect(await readConversationRun(run.id, ASKER.id)).toMatchObject({ questionSha256: "b".repeat(64), conversationId, ordinal: 1, refusal: null, writingAt: null });
    expect(await readConversationRun(run.id, OTHER.id)).toBeNull();
    const first = new Date("2026-10-12T10:00:00.000Z");
    await writeWritingAt(run, first);
    await writeWritingAt(run, new Date("2026-10-12T10:01:05.000Z"));
    expect((await readConversationRun(run.id, ASKER.id))?.writingAt).toEqual(first);
    const report = { paragraphs: [{ text: "The pages read describe current practice [1].", sections: [S213], pages: [1] }], dropped: { OT: 1 } };
    expect(await writeRunReport(run, report)).toEqual({ written: true });
    expect(await readRunReport(run)).toEqual(report);
    const resetsAt = new Date("2026-11-01T00:00:00.000Z");
    await writeBudgetResetsAt(run, resetsAt);
    expect((await readConversationRun(run.id, ASKER.id))?.budgetResetsAt).toEqual(resetsAt);
    await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.update({ where: { id: run.id }, data: { textPurgedAt: new Date(), question: null, report: Prisma.DbNull } }));
    expect(await writeRunQuestion(run, "again?", "c".repeat(64))).toEqual({ written: false });
    expect(await writeRunReport(run, report)).toEqual({ written: false });
    expect(await readRunReport(run)).toBeNull();
  });

  it("ends a run REFUSED with its cause and never moves it again; counts toward the day every run with a workflow but those that spent nothing, SKIPPED · BUDGET and SKIPPED · UNAVAILABLE (48 § 5.2, § 7.2)", async () => {
    expect(ENDED_STATES).toContain("REFUSED");
    const conversationId = await conversationOf(ASKER);
    const since = new Date(Date.now() - DAY);
    const before = await runsStartedSince(ASKER, since);
    const refused = await runOf(ASKER, { conversationId, ordinal: 1 });
    expect(await writeResearchState(refused, "REFUSED", { refusal: "R-PERSONAL" })).toEqual({ written: true });
    expect(await readConversationRun(refused.id, ASKER.id)).toMatchObject({ state: "REFUSED", refusal: "R-PERSONAL" });
    expect(await writeResearchState(refused, "PLANNING")).toEqual({ written: false });
    const budget = await runOf(ASKER, { conversationId, ordinal: 2, state: "SKIPPED", skip: "BUDGET" });
    const unavailable = await runOf(ASKER, { conversationId, ordinal: 3, state: "SKIPPED", skip: "UNAVAILABLE" });
    await runOf(ASKER, { conversationId, ordinal: 4, state: "SKIPPED", skip: "TEXT_PURGED" });
    await runOf(ASKER, { conversationId, ordinal: 5, state: "FAILED" });
    /* refused by rule at its start: no workflow, never counted */
    await runOf(ASKER, { conversationId, ordinal: 6, state: "REFUSED", withWorkflow: false });
    expect(await runsStartedSince(ASKER, since)).toBe(before + 3);
    expect(budget.id).not.toBe(unavailable.id);
    /* the sections and the targets are written with the brief, the text guarded */
    const planned = await runOf(ASKER, { conversationId, ordinal: 7, state: "PLANNING" });
    expect(await writeResearchState(planned, "READING", { brief: "Look for the current practice.", briefSha256: "d".repeat(64), sectionAnchors: ["21.3", "21.4"], targetAnchors: ["21.4"] })).toEqual({ written: true });
    expect(await readConversationRun(planned.id, ASKER.id)).toMatchObject({ state: "READING", sectionAnchors: ["21.3", "21.4"], targetAnchors: ["21.4"], briefSha256: "d".repeat(64) });
  });

  it("reads a seeded run's seed — the answer's claims, its uncovered sentences, its cited sections — until a run of the research planned, and a follow-up's earlier runs, oldest first, never another's (48 § 5.3)", async () => {
    const chat = await createConversation(ASKER, { locale: "en" });
    const asked = await appendUserMessage(ASKER, chat.id, { text: "Why do idempotency keys matter?", mode: "explain", traceId: TRACE });
    const answer = await appendAssistantMessage(
      ASKER,
      chat.id,
      {
        kind: "answer",
        refusal: null,
        claims: [{ text: "A retried write without a key is a second write.", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false }],
        citations: [{ sectionId: parseSectionId("21.3"), figureId: null, version: "v1.0.0", editionLang: "EN" }],
        verdicts: [],
        grounded: 1,
        repaired: false,
        guide: { version: "v1.13", sha256: "a".repeat(64) },
        modelId: "claude-opus-5",
        timings: { scopeMs: 1, retrieveMs: 1, firstTokenMs: 1, draftMs: 1, sensorsMs: 1, graderMs: 1, totalMs: 6 },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        modeResult: null,
        uncovered: [{ sectionId: "21.3", text: "Idempotency keys are also what makes a retried refund safe." }],
        retrievedSections: ["21.3"],
      } as AnswerResult,
      { ordinal: asked.ordinal + 1, mode: "EXPLAIN", traceId: TRACE, promptSha256: "b".repeat(64), overBudget: false, ledger: null },
    );
    const seeded = await conversationOf(ASKER, answer.id);
    const first = await readConversationRun((await runOf(ASKER, { conversationId: seeded, ordinal: 1 })).id, ASKER.id);
    expect(await readRunSeed(first ?? { userId: ASKER.id, conversationId: null, ordinal: null })).toEqual({
      claims: [{ text: "A retried write without a key is a second write.", sectionId: "21.3", figureId: null }],
      uncovered: [{ sectionId: "21.3", text: "Idempotency keys are also what makes a retried refund safe." }],
      cited: ["21.3"],
    });
    /* a research from scratch has none */
    expect(await readRunSeed({ userId: ASKER.id, conversationId: await conversationOf(ASKER), ordinal: 1 })).toBeNull();
    /* another's context does not find the seed: it reads as gone */
    const foreign = await conversationOf(OTHER, answer.id);
    expect(await readRunSeed({ userId: OTHER.id, conversationId: foreign, ordinal: 1 })).toBe("gone");

    /* the seeded run is the first that planned, not ordinal 1 (review of unit 71): a run after one with no brief — the
       first never planned — still reads the seed, and a run after one that stored its brief is a follow-up */
    const earlier = await runOf(ASKER, { conversationId: seeded, ordinal: 2, question: "And how long is a key kept?" });
    expect(await readRunSeed({ userId: ASKER.id, conversationId: seeded, ordinal: 2 })).toMatchObject({ cited: ["21.3"] });
    await writeResearchState(earlier, "READING", { brief: "Look for the retention window.", briefSha256: "d".repeat(64), targetAnchors: ["21.3"] });
    expect(await readRunSeed({ userId: ASKER.id, conversationId: seeded, ordinal: 2 })).toMatchObject({ cited: ["21.3"] });
    expect(await readRunSeed({ userId: ASKER.id, conversationId: seeded, ordinal: 3 })).toBeNull();
    await writeRunReport(earlier, { paragraphs: [{ text: "The pages read give 24 hours [1].", sections: [], pages: [1] }], dropped: {} });
    const now = await runOf(ASKER, { conversationId: seeded, ordinal: 3, question: "Does the window differ for refunds?" });
    const read = await readEarlierRuns({ userId: ASKER.id, conversationId: seeded, ordinal: 3 });
    expect(read.map((run) => [run.ordinal, run.question, run.brief, run.report?.paragraphs.length ?? null, run.targetAnchors])).toEqual([
      [1, "Why does a retried write without a key become a second write?", null, null, []],
      [2, "And how long is a key kept?", "Look for the retention window.", 1, ["21.3"]],
    ]);
    expect(await readEarlierRuns({ userId: OTHER.id, conversationId: seeded, ordinal: 3 })).toEqual([]);
    expect(await readEarlierRuns({ userId: ASKER.id, conversationId: seeded, ordinal: 1 })).toEqual([]);
    expect(now.id).not.toBe(earlier.id);
  });

  it("sweeps a detached run of a research once the cap's day has passed and its workflow has ended, and never a person's live research older than 24 hours (48 § 17.2)", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - DETACHED_RUN_KEPT_MS - 3_600_000);
    const live = await conversationOf(ASKER);
    const kept = await runOf(ASKER, { conversationId: live, ordinal: 1, state: "DONE", createdAt: old });
    const keptFinding = await findingOf(ASKER, kept.id, 1, "VALID");
    /* detached by its conversation's delete: neither a message nor a conversation, its text gone */
    const detached = await runOf(ASKER, { conversationId: null, ordinal: null, state: "DONE", createdAt: old, question: null, textPurgedAt: now });
    const running = async () => false;
    const swept = await sweepDetachedRuns({ now, reader: ASKER.id, running });
    expect(swept).toMatchObject({ readers: 1, deleted: 1, running: 0, engineAnswered: true });
    expect(await readConversationRun(detached.id, ASKER.id)).toBeNull();
    expect(await readConversationRun(kept.id, ASKER.id)).toMatchObject({ conversationId: live, state: "DONE" });
    expect(await withTenant(tenantOf(ASKER), () => getPrisma().researchFinding.count({ where: { id: keptFinding } }))).toBe(1);
  });

  it("keeps a detached run's sent finding while its `finding:<id>` workflow runs and deletes it once it ended; deletes the detached findings that are no proposal of the asker's, REFUTED, DUPLICATE and a SUBMITTED one whose workflow ended; keeps every PROPOSED one; stops for the night when the engine is away (48 § 17.2)", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - DETACHED_RUN_KEPT_MS - 3_600_000);
    const run = await runOf(OTHER, { conversationId: null, ordinal: null, state: "DONE", createdAt: old, question: null, textPurgedAt: now });
    const proposed = await findingOf(OTHER, run.id, 1, "PROPOSED", "S-98-7001");
    const sending = await findingOf(OTHER, run.id, 2, "SUBMITTED", "S-98-7002");
    const sent = await findingOf(OTHER, run.id, 3, "SUBMITTED", "S-98-7003");
    const invalid = await findingOf(OTHER, run.id, 4, "INVALID");
    /* left detached by an earlier night or by a workflow (48 § 8.4) */
    const refuted = await findingOf(OTHER, null, 5, "REFUTED", "S-98-7005");
    const duplicate = await findingOf(OTHER, null, 6, "DUPLICATE", "S-98-7006");
    const submitted = await findingOf(OTHER, null, 7, "SUBMITTED", "S-98-7007");
    const older = await findingOf(OTHER, null, 8, "PROPOSED", "S-98-7008");
    const findings = async () => new Set((await withTenant(tenantOf(OTHER), () => getPrisma().researchFinding.findMany({ select: { id: true } }))).map((row) => row.id));

    /* the engine away while a sent finding is asked about: nothing of it goes, and the counts say the step stopped */
    const away = await sweepDetachedRuns({ now, reader: OTHER.id, running: async (workflowId) => (workflowId.startsWith("finding:") ? null : false) });
    expect(away).toMatchObject({ deleted: 0, engineAnswered: false });
    expect(await readConversationRun(run.id, OTHER.id)).not.toBeNull();

    const asked: string[] = [];
    const swept = await sweepDetachedRuns({
      now,
      reader: OTHER.id,
      running: async (workflowId) => {
        asked.push(workflowId);
        return workflowId === findingWorkflowId(sending);
      },
    });
    expect(swept).toEqual({ readers: 1, deleted: 1, running: 0, proposalsKept: 1, findingsKept: 1, findingsDeleted: 3, engineAnswered: true });
    expect(asked).toEqual(expect.arrayContaining([researchRunWorkflowId(run.id), findingWorkflowId(sending), findingWorkflowId(sent), findingWorkflowId(submitted)]));
    expect(await findings()).toEqual(new Set([proposed, sending, older]));
    expect(await withTenant(tenantOf(OTHER), () => getPrisma().researchFinding.findUniqueOrThrow({ where: { id: sending }, select: { runId: true, outcome: true } }))).toEqual({ runId: null, outcome: "SUBMITTED" });
    expect([invalid, refuted, duplicate].every((id) => id.length > 0)).toBe(true);

    /* the next night its workflow has ended: the sent finding that was never proposed goes too */
    const next = await sweepDetachedRuns({ now, reader: OTHER.id, running: async () => false });
    expect(next).toMatchObject({ deleted: 0, findingsKept: 0, findingsDeleted: 1, engineAnswered: true });
    expect(await findings()).toEqual(new Set([proposed, older]));
  });

  it("inserts a run of a research as the start does — the next ordinal, QUEUED with its workflow's id and the question's hash — and clears the research's stamp in the same transaction, so a follow-up asked after every earlier run's text went holds text again; finds no research of another's (48 § 5.2, § 17.1; review of unit 70)", async () => {
    const conversationId = await conversationOf(ASKER);
    await runOf(ASKER, { conversationId, ordinal: 1, state: "DONE", question: null, textPurgedAt: new Date(Date.now() - DAY) });
    const stampedAt = new Date(Date.now() - DAY);
    await withTenant(tenantOf(ASKER), () => getPrisma().researchConversation.update({ where: { id: conversationId }, data: { textPurgedAt: stampedAt, lastRunAt: stampedAt } }));
    const now = new Date();
    const question = "And does the window differ for refunds?";
    const input = { conversationId, releaseId: "2026.09", locale: "EN" as const, question, traceId: TRACE, seed: null, refusal: null };
    const inserted = await createConversationRun(ASKER, input, now);
    if (!inserted.created) throw new Error(`not inserted: ${inserted.reason}`);
    expect(inserted).toMatchObject({ ordinal: 2, state: "QUEUED" });
    expect(inserted.workflowId).toBe(researchRunWorkflowId(inserted.id));
    expect(await readConversationRun(inserted.id, ASKER.id)).toMatchObject({ conversationId, ordinal: 2, state: "QUEUED", questionSha256: questionSha256Of(question), workflowId: inserted.workflowId, textPurgedAt: null });
    expect(await readRunQuestion({ id: inserted.id, userId: ASKER.id })).toBe(question);
    expect(await withTenant(tenantOf(ASKER), () => getPrisma().researchConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { textPurgedAt: true, lastRunAt: true } }))).toEqual({ textPurgedAt: null, lastRunAt: now });
    /* while it is under way, no other; once it ended, the next one takes the next ordinal; another's research is not found, and nothing of it moves */
    expect(await createConversationRun(ASKER, input, now)).toEqual({ created: false, reason: "IN_PROGRESS" });
    await writeResearchState({ id: inserted.id, userId: ASKER.id }, "FAILED", { failure: "ABANDONED" }, now);
    expect(await createConversationRun(ASKER, input, now)).toMatchObject({ created: true, ordinal: 3 });
    const foreign = await conversationOf(OTHER);
    expect(await createConversationRun(ASKER, { ...input, conversationId: foreign }, now)).toEqual({ created: false, reason: "NOT_FOUND" });
    expect(await withTenant(tenantOf(OTHER), () => getPrisma().researchRun.count({ where: { conversationId: foreign } }))).toBe(0);
  });

  it("the research purge empties the five columns of a run whose own age passed 30 days and keeps a follow-up's of yesterday in the same research; stamps a research once every run of it is purged, and clears a stamp a later run made stale (48 § 17.1)", async () => {
    /* the asker's rows of the other cases would be counted too: the case starts from none, alone or after them */
    await wipe(ASKER);
    const now = new Date();
    const conversationId = await conversationOf(ASKER);
    const old = await runOf(ASKER, { conversationId, ordinal: 1, state: "DONE", createdAt: new Date(now.getTime() - 31 * DAY) });
    const recent = await runOf(ASKER, { conversationId, ordinal: 2, state: "DONE", createdAt: new Date(now.getTime() - DAY) });
    for (const run of [old, recent]) {
      await withTenant(tenantOf(ASKER), () =>
        getPrisma().researchRun.update({
          where: { id: run.id },
          data: { brief: "Look for the current practice.", briefSha256: "d".repeat(64), found: { findings: [], pages: [] }, steps: [{ seq: 0, kind: "PLANNING", at: now.toISOString() }], report: { paragraphs: [{ text: "A paragraph [1].", sections: [], pages: [1] }], dropped: {} } },
        }),
      );
    }
    const alone = await conversationOf(ASKER);
    const only = await runOf(ASKER, { conversationId: alone, ordinal: 1, state: "FAILED", createdAt: new Date(now.getTime() - 31 * DAY) });
    /* stamped once, and a follow-up written since by a hand that did not clear the stamp */
    const stale = await conversationOf(ASKER);
    await runOf(ASKER, { conversationId: stale, ordinal: 1, state: "DONE", createdAt: new Date(now.getTime() - DAY) });
    await withTenant(tenantOf(ASKER), () => getPrisma().researchConversation.update({ where: { id: stale }, data: { textPurgedAt: new Date(now.getTime() - 2 * DAY) } }));
    const counts = await purgeResearchRuns({ now, reader: ASKER.id });
    expect(counts).toMatchObject({ readers: 1, runs: 2, conversations: 1 });
    const columns = (id: string) => withTenant(tenantOf(ASKER), () => getPrisma().researchRun.findUniqueOrThrow({ where: { id }, select: { question: true, brief: true, found: true, steps: true, report: true, textPurgedAt: true, briefSha256: true, state: true } }));
    expect(await columns(old.id)).toEqual({ question: null, brief: null, found: null, steps: null, report: null, textPurgedAt: now, briefSha256: "d".repeat(64), state: "DONE" });
    expect(await columns(recent.id)).toMatchObject({ question: expect.any(String), brief: "Look for the current practice.", textPurgedAt: null });
    expect(await columns(only.id)).toMatchObject({ question: null, textPurgedAt: now, state: "FAILED" });
    const stamped = await withTenant(tenantOf(ASKER), () => getPrisma().researchConversation.findMany({ where: { id: { in: [conversationId, alone, stale] } }, select: { id: true, textPurgedAt: true } }));
    expect(new Map(stamped.map((row) => [row.id, row.textPurgedAt]))).toEqual(new Map([[conversationId, null], [alone, now], [stale, null]]));
    /* run again, nothing more to do */
    expect(await purgeResearchRuns({ now, reader: ASKER.id })).toMatchObject({ runs: 0, conversations: 0 });
  });
});
