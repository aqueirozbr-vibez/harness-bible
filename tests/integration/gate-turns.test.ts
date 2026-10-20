import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPrisma } from "@/lib/db/client";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { startGateApi, type GateApi } from "@/lib/gate/api";
import { calibrationSet } from "@/lib/db/calibration";
import { getConversation } from "@/lib/db/assistant";
import { findAid } from "@/lib/aids/index";
import { measureFlag, measureRefusals, measureRetention, measureSubstitution, measureWalk, type GateAnswer } from "@/lib/gate/measure";
import { flagCriterion, pickRefusalItems, REFUSAL_CAUSES_GATED, refusalCriterion, retentionCriterion, substitutionCriterion, type FlagCheck, type RefusalCheck, type RetentionCheck, type SubstitutionCheck } from "@/lib/gate/phase2";
import { walkCriterion } from "@/lib/gate/phase2";
import { walkFactOf, walkShape, type WalkOutcome } from "@/lib/gate/walk";
import { GoldenItemSchema, type GoldenItem } from "@/lib/schemas/golden";
import { ROUTE_TIMEOUT_MS } from "@/lib/workers/client";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { clearConversations } from "@/workers/gate/goldenDeps";
import { startStubStack, type StubStack } from "@/workers/gate/stubStack";

/*
 * The gate's own turns, measured (feature-specs/22 § 3, § 10.3): P2.2, P2.3, P2.4, P2.6a and P2.6b as
 * `npm run gate:phase2` measures them — through the API's endpoints with a signed-in reader, to workers over the
 * stub gateway, against the ingested release. It needs the database and the policy sidecar, as the stream suite
 * does.
 *
 * The purge here runs with its clock 31 days ahead and is kept to the suite's own first reader; a second reader
 * of the suite's is what shows that nobody else's words go with it.
 *
 * Every turn appends an `ANSWER` record, so the suite holds `LEDGER_LOCK` while it runs (tests/fixtures/exclusive.ts).
 *
 * The walk's script runs under the local interpreter here, as in the stream suite: what is measured is the turn
 * around the run and the check against the release, not the container, which `npm run gate:phase2` uses.
 */

const ready = env.DATABASE_URL !== undefined && env.OPA_URL !== undefined;
const EMAIL = "gate-turns-test@harness-bible.local";
const EMAIL_OTHER = "gate-turns-other@harness-bible.local";
const RELEASE = "2026.09";

const ITEMS: ReadonlyArray<GoldenItem> = readFileSync(join(import.meta.dirname, "..", "..", "golden", "assistant", `${RELEASE}.jsonl`), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => GoldenItemSchema.parse(JSON.parse(line)));

function aidOf(id: string) {
  const aid = findAid(id);
  if (aid === null) throw new Error(`aids/ holds no ${id}`);
  return aid;
}
/* Chapter 21 is verified in release 2026.09 and chapter 37 is not: one walk runs, the other refuses. */
const CH21 = aidOf("21.8-task-survival");
const CH37 = aidOf("37.8-which-configuration");

/** The release's own run of a lab, as the gate reads it. */
async function derivedOf(labId: string): Promise<unknown> {
  return (await getPrisma().lab.findFirst({ where: { anchor: labId, chapterVersion: { releaseId: RELEASE } }, select: { derived: true } }))?.derived ?? null;
}

describe.skipIf(!ready)("the gate's own turns through the API, over the stub gateway", () => {
  let stack: StubStack;
  let release: () => void = () => undefined;
  let api: GateApi;
  let other: GateApi;
  let refusals: ReadonlyArray<RefusalCheck> = [];
  let substitution: SubstitutionCheck | null = null;
  let flag: FlagCheck | null = null;
  let answer: GateAnswer | null = null;
  let retention: RetentionCheck | null = null;
  let otherConversation = "";
  let walked: WalkOutcome | null = null;
  let unverified: WalkOutcome | null = null;

  async function removeAccount(email: string): Promise<void> {
    const row = await withSystem(() => getPrisma().user.findUnique({ where: { email }, select: { id: true, organisationId: true } }));
    if (row === null) return;
    await clearConversations({ id: row.id, organisationId: row.organisationId, role: "READER", displayName: "Gate", locale: "en", identityVerified: false, parts: [], sessionId: null });
    await withSystem(async () => {
      const prisma = getPrisma();
      await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: `user:${row.id}:` } } });
      await prisma.session.deleteMany({ where: { userId: row.id } });
      await prisma.authEvent.deleteMany({ where: { userId: row.id } });
      await prisma.identity.deleteMany({ where: { userId: row.id } });
      await prisma.user.deleteMany({ where: { id: row.id } });
    });
  }

  beforeAll(async () => {
    release = await acquire(LEDGER_LOCK);
    await removeAccount(EMAIL);
    await removeAccount(EMAIL_OTHER);
    const verified = new Set((await getPrisma().chapterVersion.findMany({ where: { releaseId: RELEASE, verifyStatus: "PASSED" }, select: { chapterNumber: true } })).map((row) => row.chapterNumber));
    const claim = ITEMS.find((item) => item.kind === "claim" && verified.has(item.context.chapter));
    if (claim === undefined) throw new Error("the golden set has no claim question in a verified chapter");

    stack = await startStubStack({ aid: { runner: "python" } });
    const workers = { baseUrl: stack.url, token: stack.token, fetch: globalThis.fetch, timeouts: ROUTE_TIMEOUT_MS };
    api = await startGateApi(workers, EMAIL);
    other = await startGateApi(workers, EMAIL_OTHER);
    /* The turns print their own lines, as the workers and the API do; the suite's output is the suite's. */
    const { info, warn } = console;
    console.info = () => undefined;
    console.warn = () => undefined;
    try {
      refusals = await measureRefusals(api, stack, pickRefusalItems(ITEMS, verified));
      substitution = await measureSubstitution(api, stack, claim);
      walked = await measureWalk(api, CH21, await derivedOf(CH21.labId));
      unverified = await measureWalk(api, CH37, await derivedOf(CH37.labId));
      /* Another reader's answered turn, made before the purge: what the purge must leave alone. */
      otherConversation = await other.open({ locale: claim.language });
      await other.ask(otherConversation, { text: claim.question, mode: claim.mode }, "f".repeat(32));
      const flagged = await measureFlag(api, claim);
      flag = flagged.check;
      answer = flagged.answer;
      if (flagged.answer !== null) retention = await measureRetention(api, flagged.answer);
    } finally {
      console.info = info;
      console.warn = warn;
    }
  }, 300_000);

  afterAll(async () => {
    /* The lock is released whatever the teardown hits: one left behind would stall the next run. */
    try {
      await api?.close();
      await other?.close();
      await stack?.close();
      await removeAccount(EMAIL);
      await removeAccount(EMAIL_OTHER);
    } finally {
      release();
    }
  });

  it("refuses each of the four causes before retrieval, with a code, without a frontier call, and on the record", () => {
    expect(refusals.map((check) => check.cause)).toEqual([...REFUSAL_CAUSES_GATED]);
    for (const check of refusals) {
      expect(check, check.cause).toMatchObject({ refusedWith: check.cause, beforeRetrieval: true, frontierCalls: 0, ledger: "verified" });
      expect(check.code, check.cause).not.toBeNull();
    }
    /* The classifier's cause costs its one small call; a rule's costs none (feature-specs/13 § 4.1). */
    expect(Object.fromEntries(refusals.map((check) => [check.cause, check.smallCalls]))).toEqual({ "R-SCOPE": 1, "R-SCOPE-OT": 0, "R-RECOMPUTE": 0, "R-UNVERIFIED": 0 });
    for (const cause of ["R-SCOPE-OT", "R-RECOMPUTE"]) expect(refusals.find((check) => check.cause === cause)?.pointers, cause).toBeGreaterThanOrEqual(1);
    expect(refusalCriterion(refusals)).toMatchObject({ id: "P2.2", status: "pass", measured: "4/4 causes" });
  });

  it("replaces the claim its section does not support, and shows the substitution only in final and in the row", () => {
    expect(substitution).toMatchObject({ tokensHeldSentence: false, finalHoldsClaim: false, storedHoldsSentence: true, storedHoldsClaim: false });
    expect(substitution?.finalSubstituted).toBeGreaterThanOrEqual(1);
    /* The stream is the draft as it was written, so the claim's own words went by before they were judged. */
    expect(substitution?.tokensHeldClaim).toBe(true);
    if (substitution !== null) expect(substitutionCriterion(substitution)).toMatchObject({ id: "P2.3", status: "pass" });
  });

  it("finds the flagged answer in the calibration set, with its verdicts and the reason, and nothing that says who flagged it", async () => {
    expect(flag).toMatchObject({ flagged: true, inCalibration: true, carries: { verdicts: true, grounded: true, reason: true } });
    if (flag !== null) expect(flagCriterion(flag)).toMatchObject({ id: "P2.6a", status: "pass", measured: "in the calibration set" });

    const row = (await calibrationSet()).find((candidate) => candidate.messageId === answer?.messageId);
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {}).sort()).toEqual(["citations", "flag", "grounded", "guideVersion", "messageId", "mode", "modelId", "refusalCause", "verdicts"]);
    expect(row).toMatchObject({ mode: "EXPLAIN", refusalCause: null, flag: { kind: "ANSWER", reason: "wrong_citation" } });
    expect(row?.citations.length).toBeGreaterThan(0);
    expect(row?.verdicts.map((verdict) => verdict.sensor)).toContain("citation");
    /* No text and no reader: a row calibrates a grader, and the flag outlives the words it was about. */
    expect(JSON.stringify(row)).not.toContain(api.user.id);
  });

  it("takes the words of the gate's own reader 31 days on and keeps the citations, the verdicts, the record and the flag", async () => {
    expect(retention).toMatchObject({ textNull: true, claimTextNull: true, textPurgedAt: true, ledgerUnchanged: true });
    expect(retention?.citations.before).toBeGreaterThan(0);
    expect(retention?.citations.after).toBe(retention?.citations.before);
    expect(retention?.verdicts.after).toBe(retention?.verdicts.before);
    if (retention !== null) expect(retentionCriterion(retention)).toMatchObject({ id: "P2.6b", status: "pass" });
    /* The flag is among what stays: the answer is still in the calibration set with its words gone. */
    expect((await calibrationSet()).some((candidate) => candidate.messageId === answer?.messageId)).toBe(true);
  });

  it("leaves another reader's words where they were: the clock moved ahead for the gate's reader alone", async () => {
    const view = await getConversation(other.user, otherConversation);
    expect(view?.textPurgedAt).toBeNull();
    expect(view?.messages).toHaveLength(2);
    expect(view?.messages.every((message) => message.text !== null)).toBe(true);
    expect(view?.messages[1]?.citations.some((citation) => citation.claimText !== null)).toBe(true);
  });

  it("walks a verified chapter's aid at the book's inputs and gets the release's own figure, line and values", () => {
    expect(walked?.kind).toBe("walked");
    if (walked?.kind !== "walked") return;
    const { check } = walked;
    expect(check.exitCode).toBe(0);
    /* 21.8's second step: 13 calls at a 2 % failure rate, 76.9 % of tasks see no failure (derive.py line 8). */
    expect(check).toMatchObject({ headline: "76.9%", expectedHeadline: "76.9%", line: 8, expectedLine: 8, valuesEqualRelease: true });
    expect(check.derive).toMatch(/^derive output matched · (\d+) of \1$/);
    /* This aid has no priced step, so it has no price date: the one thing P2.4 asks of 37.8 that it cannot show. */
    expect(check.pricesVerifiedAt).toBeNull();
    expect(walkShape(CH21, walked, false)).toContain("76.9%, which is what the release's run gives · ƒ L8 · derive output matched");
  });

  it("is refused the 37.8 walk by the release itself, which blocks P2.4 on the book's side with the other walk as shape", () => {
    expect(unverified).toEqual({ kind: "refused", cause: "R-UNVERIFIED" });
    if (unverified === null || walked === null) return;
    const fact = walkFactOf({ aid: CH37, release: RELEASE, chapterVerified: false, outcome: unverified, containerDown: false, releaseResults: null, shape: walkShape(CH21, walked, false) });
    const criterion = walkCriterion(fact);
    expect(criterion).toMatchObject({ id: "P2.4", status: "blocked", measured: "not measured" });
    expect(criterion.note).toContain("Chapter 37 is not verified in release 2026.09, so the 37.8 walk refuses as R-UNVERIFIED before its script runs");
    expect(criterion.note).toContain("Shape only, the same check on 21.8-task-survival (chapter 21, verified): exit 0");
  });
});
