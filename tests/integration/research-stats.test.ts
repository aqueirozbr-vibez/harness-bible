import { generateKeyPairSync } from "node:crypto";
import { Writable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultResearchEndpointDeps, researchEndpoints } from "@/lib/api/endpoints/research";
import { defaultDeps, handler, type HandlerDeps } from "@/lib/api/handler";
import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { monthOf, tenantOfPrincipal } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import { researchRecordSeqs } from "@/lib/db/research";
import { loadResearchPage } from "@/lib/db/researchPage";
import { researchStats } from "@/lib/db/researchStats";
import { currentRelease } from "@/lib/db/shared";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { append } from "@/lib/ledger/append";
import { exportJsonl, verifyExport } from "@/lib/ledger/export";
import { stepKeyOf } from "@/lib/ledger/hash";
import { monthWindow } from "@/lib/metrics/assistant";
import { researchPageStateOf } from "@/lib/research/links";
import { RESEARCHER_GUIDE_VERSION } from "@/lib/schemas/researcher";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { clearResearchPage, seedResearchPage, type ResearchPageSeed } from "@/tests/fixtures/research/page";

/*
 * The Research page's statistics and a research's export against the database (feature-specs/48 § 11.6, § 11.10, § 26;
 * unit 73), on the rows the research seed writes (tests/fixtures/research/page.ts) and two `BudgetLedger` rows naming
 * the seed's runs, which stay, as every such row does; and, since the unit's review, a flag on the rule's refusal, as
 * the person could put there, and two findings of the done research's follow-up whose suggestions are merged: a draft
 * of the person's own (`DRAFTED`) and a researcher's proposal sent for them (`SUBMITTED`), suggestions of a chapter no
 * book has (93) under a rubric version of the suite's own that applies in the past, so it is never the one in force.
 * Past draft a suggestion is never deleted (feature-specs/29 § 3), so the suite moves its two back to draft before it
 * deletes them, as the improve harness clears its own — a move nothing of the product makes.
 *
 * - each cell against a count in SQL for the seed's person, in the month and over all time — the statements below,
 *   registered in lib/db/RAW_SQL.md, read the tables themselves and share nothing with the door's reads: the flags
 *   over every run, a rule's refusal's included, and the accepted findings by their suggestions' state, the owner's
 *   for a draft and a researcher's for a sent one;
 * - another person's statistics read nothing of the asker's;
 * - the export of a research with a `RESEARCH` record answers a signed file that verifies, its trailer naming the
 *   research, and appends one `EXPORT` record by the person of scope `research`; one with none is `NOTHING_TO_EXPORT`,
 *   another person's research `NOT_FOUND`; the page offers the export only where there is a record.
 *
 * The export signs with a key made here, its public half verifying the file, since the suite cannot read the
 * deployment's. It appends to the development ledger, so it holds `LEDGER_LOCK` while it does.
 */

const ready = env.DATABASE_URL !== undefined;
const ASKER: SessionUser = { id: "00000000-0000-4000-8000-0000000a7301", organisationId: null, role: "READER", displayName: "Stats Asker", locale: "en", identityVerified: false, parts: [], sessionId: null };
const OTHER: SessionUser = { id: "00000000-0000-4000-8000-0000000a7302", organisationId: null, role: "READER", displayName: "Stats Other", locale: "en", identityVerified: false, parts: [], sessionId: null };
const USERS = [ASKER, OTHER];
const TRACE = "a73a".repeat(8);
/* the suite's rubric version and its two merged suggestions: a draft of the asker's own, and a researcher's proposal */
const RUBRIC = "v0.73";
const OWN = "S-93-7301";
const PROPOSAL = "S-93-7302";

interface Counted {
  readonly runs: number;
  readonly done: number;
  readonly refused: number;
  readonly stopped: number;
  readonly failed: number;
  readonly searches: number;
  readonly opened: number;
  readonly seen: number;
  readonly held: number;
  readonly flagged: number;
  readonly passed: number;
  readonly used: number;
  readonly accepted: number;
  readonly total: string;
  readonly charged: number;
}

/** The cells as SQL counts them: the person's runs in their researches, with a workflow, started in the window — every run for the flags. */
async function countedInSql(userId: string, from: Date, to: Date): Promise<Counted> {
  const [runs] = await withSystem(() =>
    getPrisma().$queryRaw<Array<Omit<Counted, "flagged" | "passed" | "used" | "accepted" | "total" | "charged">>>`
      SELECT count(*)::int AS runs,
             count(*) FILTER (WHERE r."state" = 'DONE')::int AS done,
             count(*) FILTER (WHERE r."state" = 'REFUSED')::int AS refused,
             count(*) FILTER (WHERE (r."state" = 'FAILED' AND r."failure" IN ('BUDGET', 'ABANDONED'))
                                 OR (r."state" = 'SKIPPED' AND r."skip" = 'TEXT_PURGED')
                                 OR (r."state" NOT IN ('DONE', 'SKIPPED', 'FAILED', 'REFUSED') AND r."createdAt" < now() - interval '90 minutes'))::int AS stopped,
             count(*) FILTER (WHERE r."state" = 'FAILED' AND r."failure" NOT IN ('BUDGET', 'ABANDONED'))::int AS failed,
             coalesce(sum(r."searches"), 0)::int AS searches,
             coalesce(sum(r."pageReads"), 0)::int AS opened,
             coalesce(sum(jsonb_array_length(r."found" -> 'read')) FILTER (WHERE r."textPurgedAt" IS NULL AND jsonb_typeof(r."found" -> 'read') = 'array'), 0)::int AS seen,
             count(*) FILTER (WHERE r."textPurgedAt" IS NULL AND jsonb_typeof(r."found" -> 'read') = 'array')::int AS held
        FROM "ResearchRun" r
       WHERE r."userId" = ${userId} AND r."conversationId" IS NOT NULL AND r."workflowId" IS NOT NULL
         AND r."createdAt" >= ${from} AND r."createdAt" < ${to}`,
  );
  /* a flag on any run of theirs, a rule's refusal, which has no workflow, included (§ 11.7) */
  const [flags] = await withSystem(() =>
    getPrisma().$queryRaw<Array<{ flagged: number }>>`
      SELECT count(*)::int AS flagged
        FROM "ResearchRun" r
       WHERE r."userId" = ${userId} AND r."conversationId" IS NOT NULL AND r."flaggedAt" IS NOT NULL
         AND r."createdAt" >= ${from} AND r."createdAt" < ${to}`,
  );
  /* accepted: a draft whose suggestion is the person's own and merged, a sent finding whose researcher proposal is */
  const [findings] = await withSystem(() =>
    getPrisma().$queryRaw<Array<{ passed: number; used: number; accepted: number }>>`
      SELECT count(*) FILTER (WHERE f."outcome" <> 'INVALID')::int AS passed,
             count(*) FILTER (WHERE f."outcome" IN ('DRAFTED', 'SUBMITTED', 'DUPLICATE', 'PROPOSED', 'REFUTED'))::int AS used,
             count(*) FILTER (WHERE s."state" = 'MERGED'
                                AND ((f."outcome" = 'DRAFTED' AND s."origin" = 'HUMAN' AND s."userId" = ${userId})
                                  OR (f."outcome" IN ('SUBMITTED', 'PROPOSED', 'REFUTED') AND s."origin" = 'RESEARCHER')))::int AS accepted
        FROM "ResearchFinding" f JOIN "ResearchRun" r ON r."id" = f."runId" LEFT JOIN "Suggestion" s ON s."id" = f."suggestionId"
       WHERE r."userId" = ${userId} AND r."conversationId" IS NOT NULL AND r."workflowId" IS NOT NULL
         AND r."createdAt" >= ${from} AND r."createdAt" < ${to}`,
  );
  const [cost] = await withSystem(() =>
    getPrisma().$queryRaw<Array<{ total: string; charged: number }>>`
      SELECT coalesce(sum(b."costUsd"), 0)::text AS total, count(DISTINCT b."ref")::int AS charged
        FROM "BudgetLedger" b JOIN "ResearchRun" r ON r."id" = b."ref"
       WHERE b."userId" = ${userId} AND b."kind" IN ('RESEARCH', 'EMBED', 'RERANK')
         AND r."userId" = ${userId} AND r."conversationId" IS NOT NULL AND r."workflowId" IS NOT NULL
         AND r."createdAt" >= ${from} AND r."createdAt" < ${to}`,
  );
  if (runs === undefined || flags === undefined || findings === undefined || cost === undefined) throw new Error("a count returned no row");
  return { ...runs, ...flags, ...findings, ...cost };
}

/** The suite's suggestions back to draft and gone, then its rubric version: a suggestion past draft is never deleted (29 § 3). */
async function clearSuggestions(): Promise<void> {
  await withSystem(async () => {
    const prisma = getPrisma();
    await prisma.suggestion.updateMany({ where: { id: { in: [OWN, PROPOSAL] } }, data: { state: "DRAFT" } });
    await prisma.suggestion.deleteMany({ where: { id: { in: [OWN, PROPOSAL] }, state: "DRAFT" } });
    await prisma.rubricVersion.deleteMany({ where: { id: RUBRIC } });
  });
}

/** A pipeline with the session and the policy given and its rate open, as the other research suites run it. */
function pipeline(user: SessionUser): HandlerDeps {
  return { ...defaultDeps, sessionFromRequest: async () => user, authorize: async () => ({ allow: true }), consume: async () => ({ allowed: true, limit: 10, remaining: 9, resetS: 60, retryAfterS: 0 }), audit: async () => undefined, log: () => undefined };
}

describe.skipIf(!ready)("the Research page's statistics and a research's export, against the database (48 § 11.6, § 11.10)", () => {
  let seed: ResearchPageSeed;

  beforeAll(async () => {
    await withSystem(async () => {
      for (const user of USERS) await getPrisma().user.upsert({ where: { id: user.id }, update: {}, create: { id: user.id, email: `${user.id}@research-stats.test`, displayName: user.displayName, role: "READER" } });
    });
    seed = await seedResearchPage(ASKER);
    /* what the done research's two runs cost: the first a reader's call and an embedding, the second a reader's call */
    const done = await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.findMany({ where: { conversationId: seed.done }, orderBy: { ordinal: "asc" }, select: { id: true } }));
    const now = new Date();
    const row = (ref: string, kind: "RESEARCH" | "EMBED", costUsd: string) =>
      withTenant(tenantOfPrincipal({ userId: ASKER.id }), () =>
        getPrisma().budgetLedger.create({ data: { month: monthOf(now), kind, alias: kind === "EMBED" ? "hb-embed" : "hb-frontier", modelId: kind === "EMBED" ? "hb-embed" : "hb-frontier", inputTokens: 100, outputTokens: 10, costUsd, outcome: "ok", ref, traceId: TRACE, createdAt: now } }),
      );
    const [first, second] = done;
    if (first === undefined || second === undefined) throw new Error("the seed's done research has two runs");
    await row(first.id, "RESEARCH", "0.5712");
    await row(first.id, "EMBED", "0.0004");
    await row(second.id, "RESEARCH", "0.3125");

    /* the rule's refusal flagged, as its quiet Flag would: no workflow, and still a flag the cell counts (§ 11.7) */
    const flagged = await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.updateMany({ where: { conversationId: seed.refused, workflowId: null }, data: { flagReason: "should_not_refuse", flaggedAt: now } }));
    if (flagged.count !== 1) throw new Error("the seed's refused research has one run a rule refused");

    /* two merged suggestions, and the follow-up's findings that made them: a draft of the asker's own, a researcher's proposal */
    await clearSuggestions();
    await withSystem(async () => {
      const prisma = getPrisma();
      await prisma.rubricVersion.create({ data: { id: RUBRIC, publishedAt: new Date("2000-01-01T00:00:00.000Z"), appliesAt: new Date("2000-01-01T00:00:00.000Z"), sha256: "b".repeat(64), tiers: {}, adjustments: {}, examples: {} } });
      for (const [id, origin] of [[OWN, "HUMAN"], [PROPOSAL, "RESEARCHER"]] as const) {
        await prisma.suggestion.create({ data: { id, origin, userId: origin === "HUMAN" ? ASKER.id : null, chapterNumber: 93, chapterVersionId: "chapter-version-of-the-suite", releaseId: "2026.09", parts: ["P1"], changeKind: "EDIT_TEXT", changeClass: "WORDING", locale: "EN", state: "MERGED", rubricVersionId: RUBRIC } });
      }
    });
    await withTenant(tenantOf(ASKER), async () => {
      await getPrisma().researchFinding.create({ data: { runId: second.id, userId: ASKER.id, ordinal: 2, outcome: "DRAFTED", suggestionId: OWN } });
      await getPrisma().researchFinding.create({ data: { runId: second.id, userId: ASKER.id, ordinal: 3, outcome: "SUBMITTED", suggestionId: PROPOSAL } });
    });
  });

  afterAll(async () => {
    await clearSuggestions();
    for (const user of USERS) await clearResearchPage(user);
    for (const user of USERS) await withTenant(tenantOf(user), () => getPrisma().researchConversation.deleteMany({}));
    await withSystem(() => getPrisma().user.deleteMany({ where: { id: { in: USERS.map((user) => user.id) } } }));
  });

  it("counts each cell as SQL counts it, in the month and over all time", async () => {
    const now = new Date();
    const month = monthOf(now);
    for (const [window, from, to] of [
      [{ kind: "month", month } as const, monthWindow(month).from, monthWindow(month).to],
      [{ kind: "all" } as const, new Date(0), new Date(now.getTime() + 60_000)],
    ] as const) {
      const stats = await researchStats(ASKER, window, now);
      const sql = await countedInSql(ASKER.id, from, to);
      expect(stats.runs, window.kind).toBe(sql.runs);
      expect(stats.ends, window.kind).toEqual({ done: sql.done, refused: sql.refused, stopped: sql.stopped, failed: sql.failed });
      expect(stats.sources, window.kind).toEqual({ searches: sql.searches, opened: sql.opened, seen: sql.held === 0 ? null : sql.seen });
      expect(stats.findings, window.kind).toEqual({ passed: sql.passed, used: sql.used, accepted: sql.accepted });
      expect(stats.flagged, window.kind).toBe(sql.flagged);
      expect(stats.cost.total, window.kind).toBeCloseTo(Number(sql.total), 10);
      expect(stats.cost.perRun, window.kind).toBeCloseTo(Number(sql.total) / sql.charged, 10);
    }
    /* the rows' own shape over all time, so the comparison above compared something: twelve runs with a workflow — the
       rule's refusal has none — four done, two refused by the planner, the cap mid-read and the stale run stopped, a
       reader that failed; the seeded report and the rule's refusal flagged; the seed's six findings that passed and
       three used, and the suite's two, both accepted; three runs whose pages are listed, 4 + 3 + 1 of them, read in
       SQL by the door; two runs charged US$ 0.8841 between them */
    const all = await researchStats(ASKER, { kind: "all" }, new Date());
    expect(all).toMatchObject({ runs: 12, ends: { done: 4, refused: 2, stopped: 2, failed: 1 }, flagged: 2, findings: { passed: 8, used: 5, accepted: 2 }, sources: { seen: 8 } });
    expect(all.cost.total).toBeCloseTo(0.8841, 10);
    expect(all.cost.perRun).toBeCloseTo(0.44205, 10);
  });

  it("reads nothing of another person's researches", async () => {
    expect(await researchStats(OTHER, { kind: "all" }, new Date())).toEqual({ runs: 0, ends: { done: 0, refused: 0, stopped: 0, failed: 0 }, cost: { total: null, perRun: null }, sources: { searches: 0, opened: 0, seen: null }, findings: { passed: 0, used: 0, accepted: 0 }, flagged: 0 });
  });

  it("exports a research's RESEARCH records signed, the file verifying, with one EXPORT record of scope research; none is NOTHING_TO_EXPORT, another's NOT_FOUND", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const endpoints = researchEndpoints({
      ...defaultResearchEndpointDeps,
      exportFile: async (researchId, seqs) => {
        const chunks: Buffer[] = [];
        const sink = new Writable({
          write(chunk: Buffer | string, _encoding, callback) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            callback();
          },
        });
        const trailer = await exportJsonl({ kind: "research", id: researchId, seqs }, sink, { key: privateKey, now: () => new Date() });
        return { file: Buffer.concat(chunks), trailer };
      },
    });
    const exported = (user: SessionUser, id: string) =>
      handler(endpoints.researchConversationExport, pipeline(user))(new Request(`http://localhost:3000/api/v1/research/conversations/${id}/export`, { headers: { "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.73" } }), { params: { id } });

    /* nothing reached a model in the seed: no record, nothing to export, and the page offers none */
    expect(await researchRecordSeqs(ASKER, seed.done)).toEqual([]);
    const none = await exported(ASKER, seed.done);
    expect(none.status).toBe(404);
    expect(((await none.json()) as { code: string }).code).toBe("NOTHING_TO_EXPORT");
    expect((await loadResearchPage(ASKER, researchPageStateOf({ research: seed.done }), new Date())).open?.exportable).toBe(false);

    const unlock = await acquire(LEDGER_LOCK);
    try {
      /* the first run's record, as recordPersonRun writes one, under its step key */
      const run = await withTenant(tenantOf(ASKER), () => getPrisma().researchRun.findFirstOrThrow({ where: { conversationId: seed.done, ordinal: 1 }, select: { id: true, workflowId: true, questionSha256: true } }));
      if (run.workflowId === null) throw new Error("the seed's done run has a workflow");
      const releaseId = (await currentRelease()).id;
      const record = await append({
        kind: "RESEARCH",
        actor: `user:${ASKER.id}`,
        suggestionId: null,
        chapterVersionId: null,
        payload: {
          stepKey: stepKeyOf(run.workflowId, "research:1"),
          runId: run.id,
          releaseId,
          sections: ["21.3", "21.4"],
          gap: false,
          planned: "brief",
          briefSha256: "b".repeat(64),
          searches: 2,
          pageReads: 3,
          findings: [
            { ordinal: 1, outcome: "VALID" },
            { ordinal: 2, outcome: "VALID" },
            { ordinal: 3, outcome: "INVALID" },
          ],
          guide: { version: RESEARCHER_GUIDE_VERSION, sha256: "c".repeat(64) },
          models: { planner: "hb-small", reader: "hb-frontier", writer: "hb-frontier" },
          usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0 },
          traceId: TRACE,
          end: { state: "DONE", code: null },
          conversationId: seed.done,
          questionSha256: run.questionSha256,
          reportSha256: "d".repeat(64),
          refusal: null,
        },
      });
      expect(await researchRecordSeqs(ASKER, seed.done)).toEqual([record.seq]);
      expect((await loadResearchPage(ASKER, researchPageStateOf({ research: seed.done }), new Date())).open?.exportable).toBe(true);

      const response = await exported(ASKER, seed.done);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="hb-research-${seed.done}.jsonl"`);
      const lines = (await response.text()).split("\n");
      const check = verifyExport(lines, publicKey.export({ type: "spki", format: "pem" }).toString());
      expect(check).toMatchObject({ ok: true, lines: 1, signature: "valid", matchesTrailer: true, trailer: { fromSeq: record.seq, toSeq: record.seq, records: 1, scope: { kind: "research", id: seed.done, from: null, to: null } } });

      /* the export is a record: one EXPORT by the person, scope research, after the record it signed */
      const exports = await getPrisma().ledgerRecord.findMany({ where: { kind: "EXPORT", actor: `user:${ASKER.id}`, payload: { path: ["scope", "id"], equals: seed.done } }, select: { seq: true, payload: true } });
      expect(exports).toHaveLength(1);
      expect(exports[0]?.payload).toMatchObject({ scope: { kind: "research", id: seed.done }, fromSeq: record.seq, toSeq: record.seq, records: 1 });

      /* another person's research is no research of theirs, whether it has records or not */
      const foreign = await exported(OTHER, seed.done);
      expect(foreign.status).toBe(404);
      expect(((await foreign.json()) as { code: string }).code).toBe("NOT_FOUND");
    } finally {
      unlock();
    }
  });
});
