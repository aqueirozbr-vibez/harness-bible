import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { appendAssistantMessage, appendFailedTurn, appendUserMessage, createConversation, recordFlag } from "@/lib/db/assistant";
import { tenantOfPrincipal } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { assistantMetrics, cacheReadShare, citationRate, costPerActiveAccount, editionMismatchShare, firstTokenP95, flagRate, groundedDistribution, monthWindow, purged, refusalRate, SERIES } from "@/lib/metrics/assistant";
import type { AnswerResult } from "@/lib/schemas/assistant";
import { parseSectionId } from "@/lib/schemas/ids";
import type { MetricPoint, MetricSeries } from "@/lib/schemas/metrics";

/*
 * The assistant's series against the database (feature-specs/21 § 5.3, § 13.5): each statement of lib/metrics/sql
 * run through `lib/metrics/assistant.ts` over rows whose answer is known by hand.
 *
 * The statements read every reader's rows, so the fixture lives in a month of its own, May 2031: two readers, seven
 * turns over two days, written through the product's own functions and then dated. The message rows are removed
 * afterwards; the BudgetLedger rows stay, as every such row does, so the spend is asserted as a difference and the
 * cache share as a ratio that a second run's identical rows leave unchanged.
 */

const hasDatabase = env.DATABASE_URL !== undefined;

const A: SessionUser = { id: "00000000-0000-4000-8000-0000000d1001", organisationId: null, role: "READER", displayName: "Metrics A", locale: "en", identityVerified: false, parts: [], sessionId: null };
const B: SessionUser = { id: "00000000-0000-4000-8000-0000000d1002", organisationId: null, role: "READER", displayName: "Metrics B", locale: "en", identityVerified: false, parts: [], sessionId: null };
const WINDOW = monthWindow("2031-05");
const DAY_ONE = new Date("2031-05-10T10:00:00Z");
const DAY_TWO = new Date("2031-05-11T10:00:00Z");
const TRACE = "a".repeat(32);

const CLAIM = { text: "A retried write without a key is a second write.", sectionId: parseSectionId("21.3"), figureId: null, valueText: null, found: true, substituted: false };
const REPLACED = { ...CLAIM, text: "the book does not cover this", found: false, substituted: true };
/** A citation of the English edition, the only one the release has while the Portuguese editions are pending. */
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
    guide: { version: "v1.12", sha256: "a".repeat(64) },
    modelId: "claude-opus-5",
    timings: { scopeMs: 1, retrieveMs: 200, firstTokenMs, draftMs: 3000, sensorsMs: 5, graderMs: 800, totalMs: 4100 },
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000 },
    modeResult: null,
    ...rest,
  };
}

/** One turn: the question, its assistant row, and both dated to `at`. */
async function turn(user: SessionUser, conversationId: string, at: Date, write: (ordinal: number) => Promise<{ readonly id: string }>): Promise<string> {
  const asked = await appendUserMessage(user, conversationId, { text: "A question.", mode: "explain", traceId: TRACE });
  const written = await write(asked.ordinal + 1);
  await withTenant(tenantOf(user), () => getPrisma().message.updateMany({ where: { conversationId, ordinal: { in: [asked.ordinal, asked.ordinal + 1] } }, data: { createdAt: at } }));
  return written.id;
}

const row = (ordinal: number, mode: "EXPLAIN" | "WALK" = "EXPLAIN") => ({ ordinal, mode, traceId: TRACE, promptSha256: null, overBudget: false, ledger: null });

async function wipe(): Promise<void> {
  for (const user of [A, B]) {
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

const at = (series: MetricSeries, bucket: string, key = ""): MetricPoint | undefined => [...series.points, ...series.months].find((point) => point.bucket === bucket && point.key === key);

describe.skipIf(!hasDatabase)("the assistant's series against the database", () => {
  let spendBefore: MetricSeries;

  beforeAll(async () => {
    await withSystem(async () => {
      for (const user of [A, B]) {
        await getPrisma().user.upsert({ where: { id: user.id }, update: {}, create: { id: user.id, email: `${user.displayName.toLowerCase().replace(" ", "-")}@example.test`, displayName: user.displayName, role: "READER" } });
      }
    });
    await wipe();

    const one = await createConversation(A, { locale: "en" });
    /* Day one: an answer cited on every claim, one with a claim replaced, and a refusal. */
    await turn(A, one.id, DAY_ONE, (ordinal) => appendAssistantMessage(A, one.id, answer({ firstTokenMs: 800, grounded: 0.9, citations: CITES_EN }), row(ordinal)));
    await turn(A, one.id, DAY_ONE, (ordinal) => appendAssistantMessage(A, one.id, answer({ firstTokenMs: 900, grounded: 0.75, citation: "WARN", claims: [CLAIM, REPLACED] }), row(ordinal)));
    await turn(A, one.id, DAY_ONE, (ordinal) =>
      appendAssistantMessage(
        A,
        one.id,
        answer({ kind: "refusal", refusal: { cause: "R-SCOPE-OT", code: "R-SCOPE-OT", pointers: [], beforeRetrieval: true }, claims: [], citation: "NA", grounded: null, firstTokenMs: null }),
        row(ordinal),
      ),
    );
    /* Day two: a slow answer that the reader flags, a walk with no claims of its own, and a turn that failed. */
    const flagged = await turn(A, one.id, DAY_TWO, (ordinal) => appendAssistantMessage(A, one.id, answer({ firstTokenMs: 2500, grounded: 0.5 }), row(ordinal)));
    await recordFlag(A, flagged, "ANSWER", "wrong_number");
    await turn(A, one.id, DAY_TWO, (ordinal) => appendAssistantMessage(A, one.id, answer({ claims: [], citation: "NA", grounded: null, firstTokenMs: null }), row(ordinal, "WALK")));
    await turn(A, one.id, DAY_TWO, (ordinal) => appendFailedTurn(A, one.id, { ordinal, mode: "EXPLAIN", traceId: TRACE, code: "ASSISTANT_UNAVAILABLE" }));
    /* A second reader, day two, reading in Portuguese: one clean answer that cites the English edition, in a
       conversation the retention run has since cleared. */
    const two = await createConversation(B, { locale: "pt" });
    await turn(B, two.id, DAY_TWO, (ordinal) => appendAssistantMessage(B, two.id, answer({ firstTokenMs: 1000, grounded: 1, citations: CITES_EN }), row(ordinal)));
    await withTenant(tenantOf(B), () => getPrisma().conversation.update({ where: { id: two.id }, data: { textPurgedAt: new Date("2031-05-12T03:10:00Z") } }));

    /* The spend, read before this run's ledger rows exist: they cannot be removed, so the cost is a difference. */
    spendBefore = await costPerActiveAccount(WINDOW);
    const ledger = (createdAt: Date, alias: string, outcome: string, costUsd: number, tokens: { input: number; read: number; write: number }) =>
      withTenant(tenantOfPrincipal({ userId: A.id }), () =>
        getPrisma().budgetLedger.create({
          data: { month: "2031-05", kind: "ASSISTANT", alias, modelId: alias, inputTokens: tokens.input, outputTokens: 10, cacheReadTokens: tokens.read, cacheWriteTokens: tokens.write, costUsd, outcome, traceId: TRACE, createdAt },
        }),
      );
    await ledger(DAY_ONE, "hb-frontier", "ok", 0.5, { input: 600, read: 300, write: 100 });
    /* Neither of these is a frontier call that was answered: the cache share must not see them. */
    await ledger(DAY_TWO, "hb-small", "ok", 0.25, { input: 1, read: 999, write: 0 });
    await ledger(DAY_TWO, "hb-frontier", "unavailable", 0, { input: 500, read: 500, write: 0 });
  });

  afterAll(async () => {
    await wipe();
    await withSystem(async () => {
      await getPrisma().user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    });
    await getPrisma().$disconnect();
  });

  it("counts an answer as cited when every claim stands, and leaves out what made no claims", async () => {
    const series = await citationRate(WINDOW);
    expect(at(series, "2031-05-10")).toMatchObject({ n: 1, d: 2, value: 0.5 });
    expect(at(series, "2031-05-11")).toMatchObject({ n: 2, d: 2, value: 1 });
    /* Seven turns, four answers with claims: the refusal, the walk and the failed turn are outside the rate. */
    expect(at(series, "2031-05")).toMatchObject({ n: 3, d: 4, value: 0.75 });
  });

  it("puts a flag on its message's day, as any and by reason, over every assistant row", async () => {
    const series = await flagRate(WINDOW);
    expect(at(series, "2031-05-10", "any")).toMatchObject({ n: 0, d: 3, value: 0 });
    expect(at(series, "2031-05-11", "any")).toMatchObject({ n: 1, d: 4, value: 0.25 });
    expect(at(series, "2031-05-11", "wrong_number")).toMatchObject({ n: 1, d: 4, value: 0.25 });
    expect(at(series, "2031-05", "any")).toMatchObject({ n: 1, d: 7 });
    expect(series.points.filter((point) => point.bucket === "2031-05-10").map((point) => point.key)).toEqual(["any"]);
  });

  it("gives refusals over turns, as any and one line per cause", async () => {
    const series = await refusalRate(WINDOW);
    expect(at(series, "2031-05-10", "any")).toMatchObject({ n: 1, d: 3 });
    expect(at(series, "2031-05-10", "R-SCOPE-OT")?.value).toBeCloseTo(1 / 3, 12);
    expect(at(series, "2031-05-11", "any")).toMatchObject({ n: 0, d: 4, value: 0 });
    expect(at(series, "2031-05", "R-SCOPE-OT")).toMatchObject({ n: 1, d: 7 });
  });

  it("takes the first-token p95 over the turns that streamed, by day and over the month", async () => {
    const series = await firstTokenP95(WINDOW);
    /* 800 and 900; 1000 and 2500; all four: the interpolated 95th percentile of each. */
    expect(at(series, "2031-05-10")).toMatchObject({ n: null, d: 2 });
    expect(at(series, "2031-05-10")?.value).toBeCloseTo(895, 6);
    expect(at(series, "2031-05-11")?.value).toBeCloseTo(2425, 6);
    expect(at(series, "2031-05")).toMatchObject({ d: 4 });
    expect(at(series, "2031-05")?.value).toBeCloseTo(2275, 6);
  });

  it("gives the grader's median and tenth percentile over the graded answers", async () => {
    const series = await groundedDistribution(WINDOW);
    expect(at(series, "2031-05-10", "p50")?.value).toBeCloseTo(0.825, 9);
    expect(at(series, "2031-05-10", "p10")?.value).toBeCloseTo(0.765, 9);
    expect(at(series, "2031-05", "p50")?.value).toBeCloseTo(0.825, 9);
    expect(at(series, "2031-05", "p10")?.value).toBeCloseTo(0.575, 9);
    expect(at(series, "2031-05", "p50")?.d).toBe(4);
  });

  it("divides the spend by the readers with a message in the bucket", async () => {
    const series = await costPerActiveAccount(WINDOW);
    const added = (bucket: string) => (at(series, bucket)?.n ?? 0) - (at(spendBefore, bucket)?.n ?? 0);
    expect(added("2031-05-10")).toBeCloseTo(0.5, 9);
    expect(added("2031-05-11")).toBeCloseTo(0.25, 9);
    expect(added("2031-05")).toBeCloseTo(0.75, 9);
    expect(at(series, "2031-05-10")?.d).toBe(1);
    expect(at(series, "2031-05-11")?.d).toBe(2);
    /* Two readers in the month, not three: a reader active on both days is one account. */
    expect(at(series, "2031-05")?.d).toBe(2);
    const month = at(series, "2031-05");
    expect(month?.value).toBeCloseTo((month?.n ?? 0) / 2, 9);
  });

  it("reads the cache share on the frontier's answered calls only", async () => {
    const series = await cacheReadShare(WINDOW);
    expect(at(series, "2031-05-10")?.value).toBeCloseTo(0.3, 9);
    expect(at(series, "2031-05")?.value).toBeCloseTo(0.3, 9);
    expect(at(series, "2031-05-11")).toBeUndefined();
  });

  it("gives the share of answers citing an edition that is not the reader's language, per language", async () => {
    const series = await editionMismatchShare(WINDOW);
    /* The English reader's answer cites EN: no gap. The Portuguese reader's cites EN: the gap. Five other answers cite nothing and are outside. */
    expect(at(series, "2031-05-10", "en")).toMatchObject({ n: 0, d: 1, value: 0 });
    expect(at(series, "2031-05-11", "pt")).toMatchObject({ n: 1, d: 1, value: 1 });
    expect(at(series, "2031-05", "en")).toMatchObject({ n: 0, d: 1, value: 0 });
    expect(at(series, "2031-05", "pt")).toMatchObject({ n: 1, d: 1, value: 1 });
    expect(series.points.map((point) => `${point.bucket} ${point.key}`)).toEqual(["2031-05-10 en", "2031-05-11 pt"]);
  });

  it("counts a purged conversation on the day of the run that cleared it", async () => {
    const series = await purged(WINDOW);
    expect(at(series, "2031-05-12")).toMatchObject({ n: 1, d: null, value: 1 });
    expect(at(series, "2031-05")).toMatchObject({ value: 1 });
  });

  it("runs all of them in one call, and none sees a window that holds nothing", async () => {
    const all = await assistantMetrics(WINDOW);
    expect(all.map((series) => series.series)).toEqual(SERIES.map((series) => series.name));
    expect(all.every((series) => series.months.length > 0)).toBe(true);
    const empty = await assistantMetrics(monthWindow("2032-01"));
    expect(empty.every((series) => series.points.length === 0 && series.months.length === 0)).toBe(true);
  });
});
