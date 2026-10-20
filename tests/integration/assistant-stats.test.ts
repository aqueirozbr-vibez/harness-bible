import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { appendAssistantMessage, appendFailedTurn, appendUserMessage, createConversation, recordFlag } from "@/lib/db/assistant";
import { readerStats } from "@/lib/db/assistantStats";
import { tenantOfPrincipal } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { cacheReadShare, citationRate, editionMismatchShare, firstTokenP95, flagRate, groundedDistribution, monthWindow, purged, refusalRate } from "@/lib/metrics/assistant";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";
import type { MetricPoint, MetricSeries } from "@/lib/schemas/metrics";

/*
 * The reader's statistics against the database (feature-specs/25 § 4, § 10.2–10.3).
 *
 * Parity. `lib/metrics/reader.ts` restates each statement of `lib/metrics/sql/` for one reader's rows. The two are
 * held together here: a reader who is alone in a month of their own, July 2031, is given turns through the product's
 * own functions, and for that month every statement's value must equal what `readerStats` computes for that reader.
 * A definition changed in one place and not the other fails this file.
 *
 * Isolation. Two readers share August 2031: each one's statistics count their own turns and nothing of the other's,
 * while the statements, which read every reader's rows, count both.
 *
 * The message rows are removed afterwards. The BudgetLedger rows stay, as every such row does, so the cache share is
 * compared as the same sums on both sides, which a second run's identical rows leave equal. Skipped without DATABASE_URL.
 */

const hasDatabase = env.DATABASE_URL !== undefined;

const reader = (suffix: string, name: string): SessionUser => ({ id: `00000000-0000-4000-8000-0000000d2${suffix}`, organisationId: null, role: "READER", displayName: name, locale: "en", identityVerified: false, parts: [], sessionId: null });
const ALONE = reader("001", "Stats Alone");
const ONE = reader("002", "Stats One");
const OTHER = reader("003", "Stats Other");
const READERS = [ALONE, ONE, OTHER];

const JULY = "2031-07";
const AUGUST = "2031-08";
const DAY_ONE = new Date("2031-07-10T10:00:00Z");
const DAY_TWO = new Date("2031-07-11T10:00:00Z");
const IN_AUGUST = new Date("2031-08-05T10:00:00Z");
const TRACE = "b".repeat(32);

const CLAIM = { text: "A retried write without a key is a second write.", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false };
const REPLACED = { ...CLAIM, text: "the book does not cover this", found: false, substituted: true };
const CITES_EN = [{ sectionId: parseSectionId("21.3"), figureId: null, version: "v1.0.0", editionLang: "EN" as const }];

function answer(overrides: Partial<AnswerResult> & { readonly firstTokenMs?: number | null; readonly citation?: "PASS" | "WARN" | "NA" } = {}): AnswerResult {
  const { firstTokenMs = 900, citation = "PASS", ...rest } = overrides;
  return {
    kind: "answer",
    refusal: null,
    claims: [CLAIM],
    citations: [],
    verdicts: [
      { sensor: "scope", verdict: "PASS", detail: "in corpus", data: {} },
      { sensor: "citation", verdict: citation, detail: "fixture", data: {} },
    ],
    grounded: 0.9,
    repaired: false,
    guide: { version: "v1.13", sha256: "a".repeat(64) },
    modelId: "claude-opus-5",
    timings: { scopeMs: 1, retrieveMs: 200, firstTokenMs, draftMs: 3000, sensorsMs: 5, graderMs: 800, totalMs: 4100 },
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 },
    modeResult: null,
    ...rest,
  };
}

const refusal = (cause: "R-SCOPE-OT" | "R-UNVERIFIED") => answer({ kind: "refusal", refusal: { cause, code: cause, pointers: [], beforeRetrieval: true }, claims: [], citation: "NA", grounded: null, firstTokenMs: null });

/** One turn: the question, its assistant row, and both dated to `at`. */
async function turn(user: SessionUser, conversationId: string, at: Date, write: (ordinal: number) => Promise<{ readonly id: string }>): Promise<string> {
  const asked = await appendUserMessage(user, conversationId, { text: "A question.", mode: "explain", traceId: TRACE });
  const written = await write(asked.ordinal + 1);
  await withTenant(tenantOf(user), () => getPrisma().message.updateMany({ where: { conversationId, ordinal: { in: [asked.ordinal, asked.ordinal + 1] } }, data: { createdAt: at } }));
  return written.id;
}

const row = (ordinal: number, mode: "EXPLAIN" | "WALK" = "EXPLAIN") => ({ ordinal, mode, traceId: TRACE, promptSha256: null, overBudget: false, ledger: null });

async function wipe(): Promise<void> {
  for (const user of READERS) {
    await withTenant(tenantOf(user), async () => {
      const prisma = getPrisma();
      const ids = (await prisma.message.findMany({ select: { id: true } })).map((message) => message.id);
      await prisma.flag.deleteMany({ where: { messageId: { in: ids } } });
      await prisma.citation.deleteMany({ where: { messageId: { in: ids } } });
      await prisma.sensorVerdict.deleteMany({ where: { messageId: { in: ids } } });
      await prisma.message.deleteMany({ where: { id: { in: ids } } });
      await prisma.conversation.deleteMany({});
    });
  }
}

/** The month's line of a series, by key. */
const month = (series: MetricSeries, bucket: string, key = ""): MetricPoint | undefined => series.months.find((point) => point.bucket === bucket && point.key === key);

describe.skipIf(!hasDatabase)("the reader's statistics against the database (feature-specs/25 § 4)", () => {
  beforeAll(async () => {
    await withSystem(async () => {
      for (const user of READERS) {
        await getPrisma().user.upsert({ where: { id: user.id }, update: {}, create: { id: user.id, email: `${user.displayName.toLowerCase().replace(" ", "-")}@example.test`, displayName: user.displayName, role: "READER" } });
      }
    });
    await wipe();

    /* July, one reader alone. Day one: an answer cited on every claim, one with a claim replaced, a refusal that is flagged. */
    const one = await createConversation(ALONE, { locale: "en" });
    await turn(ALONE, one.id, DAY_ONE, (ordinal) => appendAssistantMessage(ALONE, one.id, answer({ firstTokenMs: 800, grounded: 0.9, citations: CITES_EN }), row(ordinal)));
    await turn(ALONE, one.id, DAY_ONE, (ordinal) => appendAssistantMessage(ALONE, one.id, answer({ firstTokenMs: 900, grounded: 0.75, citation: "WARN", claims: [CLAIM, REPLACED] }), row(ordinal)));
    const refused = await turn(ALONE, one.id, DAY_ONE, (ordinal) => appendAssistantMessage(ALONE, one.id, refusal("R-SCOPE-OT"), row(ordinal)));
    await recordFlag(ALONE, refused, "REFUSAL", "should_not_refuse");
    /* Day two: a slow answer the reader flags, a second refusal of another cause, a walk with no claims, a failed turn. */
    const flagged = await turn(ALONE, one.id, DAY_TWO, (ordinal) => appendAssistantMessage(ALONE, one.id, answer({ firstTokenMs: 2500, grounded: 0.5 }), row(ordinal)));
    await recordFlag(ALONE, flagged, "ANSWER", "wrong_number");
    await turn(ALONE, one.id, DAY_TWO, (ordinal) => appendAssistantMessage(ALONE, one.id, refusal("R-UNVERIFIED"), row(ordinal)));
    await turn(ALONE, one.id, DAY_TWO, (ordinal) => appendAssistantMessage(ALONE, one.id, answer({ claims: [], citation: "NA", grounded: null, firstTokenMs: null }), row(ordinal, "WALK")));
    await turn(ALONE, one.id, DAY_TWO, (ordinal) => appendFailedTurn(ALONE, one.id, { ordinal, mode: "EXPLAIN", traceId: TRACE, code: "ASSISTANT_UNAVAILABLE" }));
    /* The same reader in Portuguese: two answers that cite the English edition, in a conversation since purged. */
    const two = await createConversation(ALONE, { locale: "pt" });
    await turn(ALONE, two.id, DAY_TWO, (ordinal) => appendAssistantMessage(ALONE, two.id, answer({ firstTokenMs: 1000, grounded: 1, citations: CITES_EN }), row(ordinal)));
    await turn(ALONE, two.id, DAY_TWO, (ordinal) => appendAssistantMessage(ALONE, two.id, answer({ firstTokenMs: 1100, grounded: 0.8, citations: CITES_EN }), row(ordinal)));
    await withTenant(tenantOf(ALONE), () => getPrisma().conversation.update({ where: { id: two.id }, data: { textPurgedAt: new Date("2031-07-12T03:10:00Z") } }));

    const ledger = (createdAt: Date, alias: string, outcome: string, tokens: { input: number; read: number; write: number }) =>
      withTenant(tenantOfPrincipal({ userId: ALONE.id }), () =>
        getPrisma().budgetLedger.create({
          data: { month: JULY, kind: "ASSISTANT", alias, modelId: alias, inputTokens: tokens.input, outputTokens: 10, cacheReadTokens: tokens.read, cacheWriteTokens: tokens.write, costUsd: 0.5, outcome, traceId: TRACE, createdAt },
        }),
      );
    await ledger(DAY_ONE, "hb-frontier", "ok", { input: 600, read: 300, write: 100 });
    await ledger(DAY_TWO, "hb-frontier", "ok", { input: 200, read: 700, write: 100 });
    /* Neither of these is a frontier call that was answered: neither side may count them. */
    await ledger(DAY_TWO, "hb-small", "ok", { input: 1, read: 999, write: 0 });
    await ledger(DAY_TWO, "hb-frontier", "unavailable", { input: 500, read: 500, write: 0 });

    /* August, two readers: two turns of one, three of the other, a refusal among them. */
    const mine = await createConversation(ONE, { locale: "en" });
    await turn(ONE, mine.id, IN_AUGUST, (ordinal) => appendAssistantMessage(ONE, mine.id, answer({ firstTokenMs: 700, citations: CITES_EN }), row(ordinal)));
    await turn(ONE, mine.id, IN_AUGUST, (ordinal) => appendAssistantMessage(ONE, mine.id, answer({ firstTokenMs: 750, citations: CITES_EN }), row(ordinal)));
    const theirs = await createConversation(OTHER, { locale: "en" });
    await turn(OTHER, theirs.id, IN_AUGUST, (ordinal) => appendAssistantMessage(OTHER, theirs.id, answer({ firstTokenMs: 3000, grounded: 0.2, citation: "WARN", claims: [CLAIM, REPLACED] }), row(ordinal)));
    await turn(OTHER, theirs.id, IN_AUGUST, (ordinal) => appendAssistantMessage(OTHER, theirs.id, refusal("R-SCOPE-OT"), row(ordinal)));
    await turn(OTHER, theirs.id, IN_AUGUST, (ordinal) => appendAssistantMessage(OTHER, theirs.id, refusal("R-SCOPE-OT"), row(ordinal)));
  });

  afterAll(async () => {
    await wipe();
    await withSystem(async () => {
      await getPrisma().user.deleteMany({ where: { id: { in: READERS.map((user) => user.id) } } });
    });
    await getPrisma().$disconnect();
  });

  describe("parity with the statements, for a reader alone in a month", () => {
    const window = monthWindow(JULY);
    const stats = () => readerStats(ALONE, { kind: "month", month: JULY });

    it("has the fixture's shape, so the cases below compare something", async () => {
      const mine = await stats();
      expect(mine.turns).toBe(9);
      expect(mine.window).toEqual({ kind: "month", month: JULY });
      expect(mine.payer).toBe("account");
    });

    it("citation rate", async () => {
      const [mine, sql] = [await stats(), month(await citationRate(window), JULY)];
      /* Five answers made claims; the replaced one is not fully cited. The refusals, the walk and the failed turn are outside. */
      expect(mine.citationRate).toEqual({ n: 4, d: 5, value: 0.8 });
      expect(sql).toMatchObject({ n: mine.citationRate.n, d: mine.citationRate.d, value: mine.citationRate.value });
    });

    it("refusal rate, any and by cause", async () => {
      const [mine, series] = [await stats(), await refusalRate(window)];
      expect(mine.refusalRate.n).toBe(2);
      expect(month(series, JULY, "any")).toMatchObject({ n: mine.refusalRate.n, d: mine.refusalRate.d });
      expect(month(series, JULY, "any")?.value).toBeCloseTo(mine.refusalRate.value ?? -1, 12);
      expect(mine.refusalsByCause.map((line) => line.cause)).toEqual(series.months.filter((point) => point.key !== "any").map((point) => point.key));
      for (const line of mine.refusalsByCause) {
        expect(month(series, JULY, line.cause)?.n, line.cause).toBe(line.n);
        expect(month(series, JULY, line.cause)?.value, line.cause).toBeCloseTo(line.value, 12);
      }
    });

    it("first-token p95", async () => {
      const [mine, sql] = [await stats(), month(await firstTokenP95(window), JULY)];
      expect(mine.firstTokenP95.samples).toBe(5);
      expect(sql?.d).toBe(mine.firstTokenP95.samples);
      expect(sql?.value).toBeCloseTo(mine.firstTokenP95.value ?? -1, 6);
    });

    it("grounded p50 and p10", async () => {
      const [mine, series] = [await stats(), await groundedDistribution(window)];
      expect(month(series, JULY, "p50")?.d).toBe(mine.grounded.samples);
      expect(month(series, JULY, "p50")?.value).toBeCloseTo(mine.grounded.p50 ?? -1, 9);
      expect(month(series, JULY, "p10")?.value).toBeCloseTo(mine.grounded.p10 ?? -1, 9);
    });

    it("flag rate, any and by reason", async () => {
      const [mine, series] = [await stats(), await flagRate(window)];
      expect(mine.flagRate).toMatchObject({ n: 2, d: 9 });
      expect(month(series, JULY, "any")).toMatchObject({ n: mine.flagRate.n, d: mine.flagRate.d });
      expect(mine.flagsByReason.map((line) => line.reason)).toEqual(series.months.filter((point) => point.key !== "any").map((point) => point.key));
      for (const line of mine.flagsByReason) expect(month(series, JULY, line.reason)?.n, line.reason).toBe(line.n);
    });

    it("edition mismatch, per reader language", async () => {
      const [mine, series] = [await stats(), await editionMismatchShare(window)];
      expect(mine.editionMismatch.map((line) => line.locale)).toEqual(series.months.map((point) => point.key));
      for (const line of mine.editionMismatch) expect(month(series, JULY, line.locale), line.locale).toMatchObject({ n: line.n, d: line.d, value: line.value });
      expect(mine.editionMismatch.find((line) => line.locale === "pt")).toMatchObject({ n: 2, d: 2, value: 1 });
    });

    it("text purged", async () => {
      const [mine, sql] = [await stats(), month(await purged(window), JULY)];
      expect(mine.purged).toBe(1);
      expect(sql?.n).toBe(mine.purged);
    });

    it("cache-read share, of the frontier alias's answered calls alone", async () => {
      const [mine, sql] = [await stats(), month(await cacheReadShare(window), JULY)];
      expect(sql).toMatchObject({ n: mine.cacheReadShare.n, d: mine.cacheReadShare.d });
      expect(sql?.value).toBeCloseTo(mine.cacheReadShare.value ?? -1, 12);
      /* 300 + 700 read of 600 + 300 + 100 + 200 + 700 + 100 sent, however many runs have written the same rows. */
      expect(mine.cacheReadShare.value).toBeCloseTo(0.5, 12);
    });

    it("covers every turn when the window is everything", async () => {
      const all = await readerStats(ALONE, { kind: "all" });
      expect(all.turns).toBe(9);
      expect(all.purged).toBe(1);
      /* Another month holds none of this reader's turns. */
      expect((await readerStats(ALONE, { kind: "month", month: AUGUST })).turns).toBe(0);
    });
  });

  describe("isolation: a reader's statistics are that reader's (invariant 24)", () => {
    it("counts one reader's turns and none of another's, where the statements count both", async () => {
      const [one, other] = [await readerStats(ONE, { kind: "month", month: AUGUST }), await readerStats(OTHER, { kind: "month", month: AUGUST })];
      expect(one.turns).toBe(2);
      expect(one.refusalRate).toEqual({ n: 0, d: 2, value: 0 });
      expect(one.citationRate).toEqual({ n: 2, d: 2, value: 1 });
      expect(one.firstTokenP95.value).toBeLessThan(1000);

      expect(other.turns).toBe(3);
      expect(other.refusalRate.n).toBe(2);
      expect(other.citationRate).toEqual({ n: 0, d: 1, value: 0 });

      /* The statement reads every reader's rows: the month has both readers' five turns. */
      expect(month(await refusalRate(monthWindow(AUGUST)), AUGUST, "any")).toMatchObject({ n: 2, d: 5 });
    });

    it("leaves a person's research out of their cache share: its reader's and writer's frontier calls are of kind RESEARCH on the same principal (feature-specs/48 § 7.1)", async () => {
      /* a research run's answered frontier call in a month this reader has no Assistant call in; the row stays, as every BudgetLedger row does */
      await withTenant(tenantOfPrincipal({ userId: ONE.id }), () =>
        getPrisma().budgetLedger.create({
          data: { month: AUGUST, kind: "RESEARCH", alias: "hb-frontier", modelId: "hb-frontier", inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0, costUsd: 0.5, outcome: "ok", traceId: TRACE, createdAt: IN_AUGUST },
        }),
      );
      expect((await readerStats(ONE, { kind: "month", month: AUGUST })).cacheReadShare).toEqual({ n: 0, d: 0, value: null });
    });

    it("gives a reader with no turns zeroes, not another reader's numbers", async () => {
      const empty = await readerStats(ONE, { kind: "month", month: JULY });
      expect(empty.turns).toBe(0);
      expect(empty.citationRate.value).toBeNull();
      expect(empty.purged).toBe(0);
      expect(empty.cacheReadShare).toEqual({ n: 0, d: 0, value: null });
    });
  });
});
