import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveDevUser } from "@/lib/auth/link";
import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { runGolden } from "@/lib/gate/goldenRun";
import { citationRate, prefixCriterion } from "@/lib/gate/phase2";
import { loadGuide } from "@/lib/guides/load";
import { ASSISTANT_GUIDE_VERSION } from "@/lib/schemas/assistant";
import { GoldenItemSchema, type GoldenItem } from "@/lib/schemas/golden";
import type { GoldenRunItem } from "@/lib/schemas/goldenRun";
import { ROUTE_TIMEOUT_MS } from "@/lib/workers/client";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { clearConversations, goldenDeps, sessionOf } from "@/workers/gate/goldenDeps";
import { startStubStack, type StubStack } from "@/workers/gate/stubStack";

/*
 * The golden run through the workers and the stub gateway (feature-specs/22 § 4, § 10.2): the wiring
 * `npm run gate:golden -- --stub` uses, over one item of each kind instead of the whole set. The turns are real
 * turns: the workers' route, retrieval against the ingested release, the flow, the sensors, the rows. Only the
 * provider is the stub.
 *
 * The items are chosen by what they are, not by id, so a curator's relabelling does not break the suite: each from
 * a verified chapter, because an unverified one refuses for its own cause first, and the figure question one that
 * names its figure in quotation marks, which is the form the stub can answer (infra/gateway/stub/answer.ts).
 *
 * Every turn appends an `ANSWER` record, so the suite holds `LEDGER_LOCK` while it runs (tests/fixtures/exclusive.ts):
 * the ledger suite asserts that its own record is the chain's head.
 */

const ready = env.DATABASE_URL !== undefined;
const EMAIL = "gate-run-test@harness-bible.local";
const RELEASE = "2026.09";

const ITEMS: ReadonlyArray<GoldenItem> = readFileSync(join(import.meta.dirname, "..", "..", "golden", "assistant", `${RELEASE}.jsonl`), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => GoldenItemSchema.parse(JSON.parse(line)));

describe.skipIf(!ready)("the golden run through the workers and the stub gateway", () => {
  let stack: StubStack;
  let release: () => void = () => undefined;
  let user: SessionUser;
  let chosen: ReadonlyArray<GoldenItem> = [];
  let records: ReadonlyArray<GoldenRunItem> = [];
  let partial = true;
  const of = (kind: GoldenItem["kind"], cause?: string) => {
    const index = chosen.findIndex((item) => item.kind === kind && (cause === undefined || item.expected.refusal?.cause === cause));
    const record = records[index];
    if (record === undefined) throw new Error(`no ${kind} ${cause ?? ""} item was run`);
    return record;
  };

  async function removeAccount(): Promise<void> {
    const row = await withSystem(() => getPrisma().user.findUnique({ where: { email: EMAIL }, select: { id: true, organisationId: true } }));
    if (row === null) return;
    await clearConversations(sessionOf(row.id, row.organisationId));
    await withSystem(async () => {
      const prisma = getPrisma();
      await prisma.authEvent.deleteMany({ where: { userId: row.id } });
      await prisma.identity.deleteMany({ where: { userId: row.id } });
      await prisma.user.deleteMany({ where: { id: row.id } });
    });
  }

  beforeAll(async () => {
    release = await acquire(LEDGER_LOCK);
    await removeAccount();
    const verified = new Set((await getPrisma().chapterVersion.findMany({ where: { releaseId: RELEASE, verifyStatus: "PASSED" }, select: { chapterNumber: true } })).map((row) => row.chapterNumber));
    const pick = (kind: GoldenItem["kind"], cause?: string): GoldenItem => {
      const found = ITEMS.find((item) => item.kind === kind && verified.has(item.context.chapter) && (cause === undefined || item.expected.refusal?.cause === cause) && (kind !== "figure" || item.question.includes('"')));
      if (found === undefined) throw new Error(`the golden set has no ${kind} ${cause ?? ""} item in a verified chapter`);
      return found;
    };
    chosen = [pick("figure"), pick("claim"), pick("compare"), pick("lab"), pick("refusal", "R-RECOMPUTE"), pick("refusal", "R-SCOPE")];

    const account = await resolveDevUser(EMAIL, "en");
    user = sessionOf(account.userId, account.organisationId);
    stack = await startStubStack();
    /* The turns print their own lines, as the workers do; the suite's output is the suite's. */
    const { info, warn } = console;
    console.info = () => undefined;
    console.warn = () => undefined;
    try {
      const result = await runGolden(chosen, { concurrency: 3 }, goldenDeps({ user, stack, workers: { baseUrl: stack.url, token: stack.token, fetch: globalThis.fetch, timeouts: ROUTE_TIMEOUT_MS } }));
      records = result.records;
      partial = result.partial;
    } finally {
      console.info = info;
      console.warn = warn;
    }
  }, 300_000);

  afterAll(async () => {
    /* The lock is released whatever the teardown hits: one left behind would stall the next run. */
    try {
      await stack?.close();
      await removeAccount();
    } finally {
      release();
    }
  });

  it("answers every item, in the golden set's order, each in a conversation of its own", async () => {
    expect(partial).toBe(false);
    expect(records.map((record) => record.id)).toEqual(chosen.map((item) => item.id));
    expect(records.map((record) => record.outcome)).toEqual(["answer", "answer", "answer", "answer", "refusal", "refusal"]);
    expect(records.every((record) => record.code === null)).toBe(true);
    const conversations = await withTenant(tenantOf(user), () => getPrisma().conversation.findMany({ select: { chapter: true, locale: true } }));
    expect(conversations).toHaveLength(chosen.length);
    /* No conversation is opened on a chapter (feature-specs/23 § 8): the item's context is where the question came from, and is not sent. */
    expect(conversations.every((row) => row.chapter === null)).toBe(true);
  });

  it("cites what the golden label expects: the named figure, the section, both chapters of a pair, the lab's section", () => {
    const figure = of("figure");
    const expected = chosen[0]?.expected.citations[0];
    expect(figure.expectedHit).toBe(true);
    expect(figure.citedSections).toContain(expected?.sectionId);
    expect(figure.citedFigures).toContain(expected?.figureId);
    expect(figure.claims.total).toBeGreaterThan(0);
    expect(figure.claims.notFound).toBe(0);
    for (const kind of ["claim", "compare", "lab"] as const) expect(of(kind).expectedHit, kind).toBe(true);
  });

  it("makes two frontier calls for an answer, the draft then the grader, and one classifier call before them", () => {
    for (const kind of ["figure", "claim", "compare", "lab"] as const) {
      const record = of(kind);
      expect(record.frontier.map((call) => call.kind), kind).toEqual(["assistant", "grading"]);
      expect(record.smallCalls, kind).toBe(1);
      expect(record.costUsd, kind).toBeGreaterThan(0);
      expect(record.messageId, kind).not.toBeNull();
      expect(record.firstTokenMs, kind).not.toBeNull();
    }
  });

  it("refuses by rule without a model call, and by the classifier with one small call and no frontier call", () => {
    expect(of("refusal", "R-RECOMPUTE")).toMatchObject({ refusalCause: "R-RECOMPUTE", expectedHit: true, frontier: [], smallCalls: 0, costUsd: 0 });
    const scope = of("refusal", "R-SCOPE");
    expect(scope).toMatchObject({ refusalCause: "R-SCOPE", expectedHit: true, frontier: [], smallCalls: 1 });
    expect(citationRate(records).refusals).toEqual({ items: 2, correct: 2 });
  });

  it("drafts every answer under one cached prefix, the guide's, whatever the mode", () => {
    const guide = loadGuide("assistant", ASSISTANT_GUIDE_VERSION);
    const answers = records.filter((record) => record.outcome === "answer");
    expect(new Set(answers.map((record) => record.mode)).size).toBeGreaterThan(1);
    expect(new Set(answers.map((record) => record.prefixSha256))).toEqual(new Set([guide.sha256]));
    /* On the stub the criterion stays blocked, and its note carries what the stub can show. */
    const criterion = prefixCriterion(null, { grade: "stub", file: "golden-run-test.jsonl", items: records, partial: false });
    expect(criterion.status).toBe("blocked");
    expect(criterion.note).toContain(`one prefix (${guide.sha256.slice(0, 12)}…) over ${String(answers.length)} answers`);
  });
});
