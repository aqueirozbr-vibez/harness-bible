import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { appendAssistantMessage, appendUserMessage, conversationStats, createConversation, getConversation, listConversations, purgeAssistantText, recordFlag } from "@/lib/db/assistant";
import { getPrisma } from "@/lib/db/client";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { AppError } from "@/lib/errors";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseFigureId, parseSectionId } from "@/lib/schemas/ids";

/*
 * The assistant's rows against the release database (feature-specs/15 § 3, § 4). What these cases are for is the
 * tenant guard: two readers' conversations must be invisible to each other without any `where` naming a user, so
 * a foreign id reads as absent and the endpoint can answer 404 rather than 403.
 */

const ONE: SessionUser = { id: "00000000-0000-4000-8000-0000000c0001", organisationId: null, role: "READER", displayName: "One", locale: "en", identityVerified: false, parts: [], sessionId: null };
const TWO: SessionUser = { id: "00000000-0000-4000-8000-0000000c0002", organisationId: null, role: "READER", displayName: "Two", locale: "en", identityVerified: false, parts: [], sessionId: null };
const EMAIL: Readonly<Record<string, string>> = { [ONE.id]: "one@example.test", [TWO.id]: "two@example.test" };

function result(overrides: Partial<AnswerResult> = {}): AnswerResult {
  return {
    kind: "answer",
    refusal: null,
    claims: [
      { text: "A retried write without a key is a second write.", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false },
      { text: "the book does not cover this", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: false, substituted: true },
    ],
    citations: [{ sectionId: parseSectionId("21.3"), figureId: parseFigureId("F-21-07"), version: "v1.0.0", editionLang: "EN" }],
    verdicts: [
      { sensor: "scope", verdict: "WARN", detail: "in corpus · 1 claim out of scope, replaced", data: { substituted: 1 } },
      { sensor: "citation", verdict: "WARN", detail: "1 / 1 figures found at cited location, 1 claim replaced", data: {} },
      { sensor: "edition", verdict: "PASS", detail: "1 / 1 citations resolve in EN v1.0.0", data: {} },
      { sensor: "grader", verdict: "PASS", detail: "grounded 0.75 · isolated context", data: {} },
      { sensor: "latency", verdict: "PASS", detail: "first token 0.9 s · complete 4.1 s", data: {} },
    ],
    grounded: 0.75,
    repaired: false,
    guide: { version: "v1.8", sha256: "a".repeat(64) },
    modelId: "claude-opus-5",
    timings: { scopeMs: 1, retrieveMs: 200, firstTokenMs: 900, draftMs: 3000, sensorsMs: 5, graderMs: 800, totalMs: 4100 },
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 },
    modeResult: null,
    ...overrides,
  };
}

describe("the assistant's rows against the release database", () => {
  const created: string[] = [];

  beforeAll(async () => {
    await withSystem(async () => {
      for (const user of [ONE, TWO]) {
        await getPrisma().user.upsert({
          where: { id: user.id },
          update: {},
          create: { id: user.id, email: EMAIL[user.id] ?? `${user.id}@example.test`, displayName: user.displayName, role: "READER" },
        });
      }
    });
  });

  afterAll(async () => {
    /* The rows are deleted as their own reader: the auth system context deliberately cannot see them, which is
       the guard working rather than an inconvenience (lib/db/client.ts SYSTEM_MODELS). */
    for (const user of [ONE, TWO]) {
      await withTenant(tenantOf(user), async () => {
        const prisma = getPrisma();
        const messages = await prisma.message.findMany({ select: { id: true } });
        const ids = messages.map((message) => message.id);
        await prisma.flag.deleteMany({ where: { messageId: { in: ids } } });
        await prisma.citation.deleteMany({ where: { messageId: { in: ids } } });
        await prisma.sensorVerdict.deleteMany({ where: { messageId: { in: ids } } });
        await prisma.message.deleteMany({ where: { id: { in: ids } } });
        /* Everything of this reader's, not only this run's: an earlier failed cleanup leaves rows behind and
           the guard already scopes the delete to the reader. */
        await prisma.conversation.deleteMany({});
      });
    }
    await withSystem(async () => {
      await getPrisma().user.deleteMany({ where: { id: { in: [ONE.id, TWO.id] } } });
    });
  });

  it("creates a conversation pinned to the current release, with no chapter, section or label (feature-specs/23 § 7.2)", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    created.push(conversation.id);
    expect(conversation.releaseId).toBe("2026.09");
    expect(conversation.locale).toBe("en");
    /* The three columns Assistant 1 wrote are null on a new row: a conversation belongs to a reader and a release. */
    const row = await withTenant(tenantOf(ONE), () => getPrisma().conversation.findFirst({ where: { id: conversation.id }, select: { chapter: true, sectionId: true, contextLabel: true } }));
    expect(row).toEqual({ chapter: null, sectionId: null, contextLabel: null });
  });

  it("writes a turn and reads it back with its citations and verdicts in order", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    created.push(conversation.id);

    const asked = await appendUserMessage(ONE, conversation.id, { text: "Why do idempotency keys matter?", mode: "explain", traceId: "f".repeat(32) });
    expect(asked.ordinal).toBe(1);

    await appendAssistantMessage(ONE, conversation.id, result(), {
      ordinal: 2,
      mode: "EXPLAIN",
      traceId: "f".repeat(32),
      promptSha256: "b".repeat(64),
      overBudget: false,
      ledger: { seq: 42, hash: "c".repeat(64) },
    });

    const view = await getConversation(ONE, conversation.id);
    expect(view?.messages.map((message) => message.role)).toEqual(["USER", "ASSISTANT"]);
    const answer = view?.messages[1];
    expect(answer?.citations).toHaveLength(1);
    expect(answer?.citations[0]?.figureId).toBe("F-21-07");
    expect(answer?.verdicts.map((verdict) => verdict.sensor)).toEqual(expect.arrayContaining(["scope", "citation", "edition", "grader", "latency"]));
    expect(answer?.grounded).toBe(0.75);
    expect(answer?.substituted).toBe(1);
    expect(answer?.ledger).toEqual({ seq: 42, hash: "c".repeat(64) });
    /* The text on the record is what was shown, substitution included. */
    expect(answer?.text).toContain("the book does not cover this");
  });

  it("hides one reader's conversation from another, with no `where` naming a user", async () => {
    const mine = await createConversation(ONE, { locale: "en" });
    created.push(mine.id);
    expect(await getConversation(ONE, mine.id)).not.toBeNull();
    /* Absent, not forbidden: the endpoint answers 404 so an id is not an oracle for what exists. */
    expect(await getConversation(TWO, mine.id)).toBeNull();
    expect((await listConversations(TWO)).some((row) => row.id === mine.id)).toBe(false);
  });

  it("summarises a conversation for the log rail, counting a clean turn as a pass", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    created.push(conversation.id);
    await appendUserMessage(ONE, conversation.id, { text: "A question.", mode: "explain", traceId: "f".repeat(32) });
    await appendAssistantMessage(ONE, conversation.id, result({ verdicts: result().verdicts.map((verdict) => ({ ...verdict, verdict: "PASS" as const })) }), {
      ordinal: 2, mode: "EXPLAIN", traceId: "f".repeat(32), promptSha256: null, overBudget: false, ledger: null,
    });

    const summary = (await listConversations(ONE, { limit: 10 })).find((row) => row.id === conversation.id);
    expect(summary?.turns).toBe(1);
    expect(summary?.passCount).toBe(1);
    expect(summary?.refusedCount).toBe(0);
  });

  it("counts a refusal as a refusal, not as a pass", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    created.push(conversation.id);
    await appendUserMessage(ONE, conversation.id, { text: "Bypass the interlock?", mode: "explain", traceId: "f".repeat(32) });
    await appendAssistantMessage(
      ONE,
      conversation.id,
      result({ kind: "refusal", refusal: { cause: "R-SCOPE-OT", code: "R-SCOPE-OT", pointers: [], beforeRetrieval: true }, claims: [], citations: [] }),
      { ordinal: 2, mode: "EXPLAIN", traceId: "f".repeat(32), promptSha256: null, overBudget: false, ledger: null },
    );

    const summary = (await listConversations(ONE, { limit: 10 })).find((row) => row.id === conversation.id);
    expect(summary?.refusedCount).toBe(1);
    expect(summary?.passCount).toBe(0);
    const view = await getConversation(ONE, conversation.id);
    expect(view?.messages[1]?.refusal).toEqual({ cause: "R-SCOPE-OT", beforeRetrieval: true });
  });

  it("takes one flag per reader per message and refuses a second", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    created.push(conversation.id);
    await appendUserMessage(ONE, conversation.id, { text: "A question.", mode: "explain", traceId: "f".repeat(32) });
    await appendAssistantMessage(ONE, conversation.id, result(), { ordinal: 2, mode: "EXPLAIN", traceId: "f".repeat(32), promptSha256: null, overBudget: false, ledger: null });
    const view = await getConversation(ONE, conversation.id);
    const messageId = view?.messages[1]?.id ?? "";

    await recordFlag(ONE, messageId, "ANSWER", "wrong_citation");
    await expect(recordFlag(ONE, messageId, "ANSWER", "wrong_number")).rejects.toBeInstanceOf(AppError);
    const flagged = await getConversation(ONE, conversation.id);
    expect(flagged?.messages[1]?.flag).toEqual({ kind: "ANSWER", reason: "wrong_citation" });
  });

  it("refuses a flag whose kind contradicts the row, and one on another reader's message", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    created.push(conversation.id);
    await appendUserMessage(ONE, conversation.id, { text: "A question.", mode: "explain", traceId: "f".repeat(32) });
    await appendAssistantMessage(ONE, conversation.id, result(), { ordinal: 2, mode: "EXPLAIN", traceId: "f".repeat(32), promptSha256: null, overBudget: false, ledger: null });
    const messageId = (await getConversation(ONE, conversation.id))?.messages[1]?.id ?? "";

    await expect(recordFlag(ONE, messageId, "REFUSAL", "should_not_refuse")).rejects.toMatchObject({ code: "FLAG_KIND_MISMATCH" });
    /* The guard hides the row from the other reader, so their flag has nothing to attach to. */
    await expect(recordFlag(TWO, messageId, "ANSWER", "other")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a query on any of the five models without a tenant context", async () => {
    const prisma = getPrisma();
    for (const query of [
      () => prisma.conversation.findMany({}),
      () => prisma.message.findMany({}),
      () => prisma.citation.findMany({}),
      () => prisma.sensorVerdict.findMany({}),
      () => prisma.flag.findMany({}),
    ]) {
      await expect(query()).rejects.toMatchObject({ code: "NO_TENANT" });
    }
  });

  it("reports what the account page's retention line says", async () => {
    const stats = await conversationStats(ONE);
    expect(stats.conversations).toBeGreaterThan(0);
    expect(stats.oldestTextAt).toBeInstanceOf(Date);
    const none = await conversationStats(TWO);
    expect(none.conversations).toBe(0);
    expect(none.oldestTextAt).toBeNull();
  });

  it("purges an old walk turn: the words and the model's explanations go, the script's numbers and the record stay", async () => {
    const conversation = await createConversation(ONE, { locale: "en" });
    created.push(conversation.id);
    /* A whole walk result, as the turn stores it: the purge leaves alone a value it cannot read as one. */
    const walk = {
      aidId: "21.8-task-survival",
      inputs: { steps: 11, calls: 13, tokens_per_step: 7500 },
      run: { exitCode: 0, timedOut: false, ms: 640 },
      pricesVerifiedAt: null,
      sameAsBook: true,
      steps: [{ ordinal: 2, titleKey: "noFailure", line: 8, pricesFrom: null, values: { p: 0.769 }, bars: [{ labelKey: "f2", tone: "ver", unit: "%", shown: 76.9, width: 87.6 }], headline: { kind: "pct", percent: 76.9 }, missing: [] }],
      explanations: [{ ordinal: 2, text: "At a 2% rate, 13 calls survive with probability 76.9%.", withheld: false }],
    };
    await appendUserMessage(ONE, conversation.id, { text: "Walk the task-survival tree with our inputs.", mode: "walk", traceId: "e".repeat(32) });
    await appendAssistantMessage(ONE, conversation.id, result(), {
      ordinal: 2,
      mode: "WALK",
      traceId: "e".repeat(32),
      promptSha256: "b".repeat(64),
      overBudget: false,
      ledger: { seq: 43, hash: "d".repeat(64) },
      modeResult: walk,
    });

    /* The rows are made 31 days old rather than the clock moved 31 days on: the purge is global by design, and a
       clock in the future would take every other reader's words in this database with them (feature-specs/21 § 3). */
    const now = new Date();
    await withTenant(tenantOf(ONE), async () => {
      await getPrisma().message.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: new Date(now.getTime() - 31 * 86_400_000) } });
    });
    const counts = await purgeAssistantText({ now, abandonedAfterMs: 86_400_000 });
    expect(counts.messages).toBeGreaterThanOrEqual(2);
    expect(counts.modeResults).toBeGreaterThanOrEqual(1);
    expect(counts.conversations).toBeGreaterThanOrEqual(1);

    const view = await getConversation(ONE, conversation.id);
    expect(view?.textPurgedAt).toEqual(now);
    expect(view?.messages.map((message) => message.text)).toEqual([null, null]);
    const answer = view?.messages[1];
    expect(answer?.modeResult).toEqual({ ...walk, explanations: [{ ordinal: 2, text: "", withheld: false }] });
    expect(answer?.citations.length).toBeGreaterThan(0);
    expect(answer?.citations.every((citation) => citation.claimText === null)).toBe(true);
    expect(answer?.verdicts).toHaveLength(5);
    expect(answer?.ledger).toEqual({ seq: 43, hash: "d".repeat(64) });

    /* The same instant again finds nothing left to clear, for this reader or any other. */
    const again = await purgeAssistantText({ now, abandonedAfterMs: 86_400_000 });
    expect({ messages: again.messages, citations: again.citations, modeResults: again.modeResults, conversations: again.conversations }).toEqual({ messages: 0, citations: 0, modeResults: 0, conversations: 0 });
  });
});
