import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPrisma } from "@/lib/db/client";
import { addEvidenceItem, adjudicatorAcceptsBetween, calibrationEventsBetween, moveAlong, requestWithdrawal, takeBackWithdrawal, withdrawalStands, contributorIdOf, createDraft, curatorDecidedSince, curatorQueue, curatorQueueCount, queueCountByPart, currentParts, deleteDraft, latestCuratorDecision, latestOwnOpenSuggestion, listOwnSuggestions, openRubricReview, ownUnverifiableDeclines, queueDecisionOf, readSuggestion, mergedInParts, readSuggestionAsService, rubricReviewIdOf, rubricReviewsIn, seedOf, seedsOffered, setRosterEntry, transition, withdrawCuratorAction, writeCuratorAction, writeSeedDecision, writeSensorVerdicts, writeSuggestionScore, type DraftInput, type ImproveClient, type ServiceCaller, type UserCaller } from "@/lib/db/improve";
import { env } from "@/lib/env";

/*
 * The one door against the database (feature-specs/29 § 4, § 10.2 to § 10.4; tracker unit 46b): who reads what,
 * the move that happens once, and the ids.
 *
 * A suggestion past draft can never be deleted, by the database itself (unit 46a), so a suite that submitted one
 * and committed would leave it in the development database for good. Every case but the last therefore runs the
 * door on a transaction that is rolled back: the door's functions take the client they run on. The last case is
 * about transactions meeting, so it commits, and what it commits are drafts, which it deletes.
 *
 * The suite keeps off the book: its chapter is 98, which no book has, so no real chapter's counter moves; its
 * people and its rubric version (`v0.1`, which nothing publishes) are its own, made before and removed after.
 */

const hasDatabase = env.DATABASE_URL !== undefined;

const CHAPTER = 98;
const RUBRIC = "v0.1";
const SHA = "b".repeat(64);
const CONTRIBUTOR_A = "00000000-0000-4000-8000-0000000046b1";
const CONTRIBUTOR_B = "00000000-0000-4000-8000-0000000046b2";
const CURATOR = "00000000-0000-4000-8000-0000000046b3";
const PEOPLE = [CONTRIBUTOR_A, CONTRIBUTOR_B, CURATOR];

const contributorA: UserCaller = { kind: "user", userId: CONTRIBUTOR_A, role: "CONTRIBUTOR", parts: [] };
const contributorB: UserCaller = { kind: "user", userId: CONTRIBUTOR_B, role: "CONTRIBUTOR", parts: [] };
const curatorOfPartThree: UserCaller = { kind: "user", userId: CURATOR, role: "CURATOR", parts: ["P3"] };
const intake: ServiceCaller = { kind: "service", id: "service:intake" };
const grader: ServiceCaller = { kind: "service", id: "service:grader" };

const draft = (over: Partial<DraftInput> = {}): DraftInput => ({
  chapterNumber: CHAPTER,
  chapterVersionId: "chapter-version-of-the-suite",
  releaseId: "2026.09",
  parts: ["P1"],
  changeKind: "EDIT_TEXT",
  changeClass: "WORDING",
  curatorReason: null,
  locale: "EN",
  rubricVersionId: RUBRIC,
  anchor: { kind: "SECTION", sectionAnchor: "98.3", figureAnchor: null, sourceRowAnchor: null, currentText: "the text as it read", contentSha256: SHA, existsAtVersion: true },
  ...over,
});

const serialOf = (id: string): number => Number(id.slice(id.lastIndexOf("-") + 1));

class Rollback extends Error {}

/** Run `body` on a transaction that is rolled back whatever happens, and hand back what it returned. */
async function rolledBack<T>(body: (tx: ImproveClient) => Promise<T>): Promise<T> {
  const held: { value?: T } = {};
  try {
    await getPrisma().$transaction(async (tx) => {
      held.value = await body(tx);
      throw new Rollback();
    });
  } catch (error: unknown) {
    if (!(error instanceof Rollback)) throw error;
  }
  return held.value as T;
}

/** The suite's own rows, in SQL because no function of the door makes a person or a rubric version (lib/db/RAW_SQL.md). */
async function clear(): Promise<void> {
  const prisma = getPrisma();
  await prisma.$executeRawUnsafe(`DELETE FROM "Suggestion" WHERE "chapterNumber" = ${String(CHAPTER)} AND "state" = 'DRAFT'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "SuggestionCounter" WHERE "chapterNumber" = ${String(CHAPTER)}`);
  await prisma.$executeRawUnsafe(`DELETE FROM "RubricVersion" WHERE "id" = '${RUBRIC}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" IN (${PEOPLE.map((id) => `'${id}'`).join(", ")})`);
}

describe.skipIf(!hasDatabase)("the one door to the improvement rows, against the database", () => {
  beforeAll(async () => {
    await clear();
    const prisma = getPrisma();
    /* Applies in the past, so that it is never the version in force while it exists: the suggestion endpoints read the latest one that applies (unit 48b found it current for the length of this suite). */
    await prisma.$executeRawUnsafe(`INSERT INTO "RubricVersion" ("id", "publishedAt", "appliesAt", "sha256", "tiers", "adjustments", "examples") VALUES ('${RUBRIC}', '2000-01-01', '2000-01-01', '${SHA}', '{}', '{}', '{}')`);
    await prisma.$executeRawUnsafe(
      /* A is verified and has consented, so a workflow may move A's draft out (invariant 25, unit 50a); B has done neither. */
      `INSERT INTO "User" ("id", "email", "displayName", "role", "identityVerified", "provenanceConsentAt") VALUES ('${CONTRIBUTOR_A}', 'improve-door-a@harness-bible.local', 'Contributor A of the door suite', 'CONTRIBUTOR', true, '2026-10-05T12:00:00Z'), ('${CONTRIBUTOR_B}', 'improve-door-b@harness-bible.local', 'Contributor B of the door suite', 'CONTRIBUTOR', false, NULL), ('${CURATOR}', 'improve-door-c@harness-bible.local', 'Curator of the door suite', 'CURATOR', false, NULL)`,
    );
  });

  /* What Node was warned of while the suite ran: read by the last case. */
  const warnings: string[] = [];
  const onWarning = (warning: Error): void => {
    warnings.push(warning.message);
  };

  beforeAll(() => {
    process.on("warning", onWarning);
  });

  afterAll(async () => {
    process.off("warning", onWarning);
    await clear();
  });

  it("creates a person's draft with its id, its anchor and no proposal yet", async () => {
    const created = await rolledBack((tx) => createDraft(contributorA, draft({ parts: ["P1", "P3"] }), tx));
    expect(created.id).toMatch(/^S-98-\d{4,}$/);
    expect(created).toMatchObject({ origin: "HUMAN", userId: CONTRIBUTOR_A, chapterNumber: CHAPTER, state: "DRAFT", parts: ["P1", "P3"], changeKind: "EDIT_TEXT", changeClass: "WORDING", curatorReason: null, proposal: null, proposalKey: null, rationale: null, outcome: null, score: null, workflowId: null, submittedAt: null, rubricVersionId: RUBRIC });
    expect(created.anchor).toEqual({ kind: "SECTION", sectionAnchor: "98.3", figureAnchor: null, sourceRowAnchor: null, currentText: "the text as it read", contentSha256: SHA, existsAtVersion: true });
    expect(created.evidence).toEqual([]);
    expect(created.sensorVerdicts).toEqual([]);
    expect(created.adjudication).toBeNull();
  });

  it("gives the drafts of one chapter consecutive serials whoever writes them, and another chapter its own", async () => {
    const ids = await rolledBack(async (tx) => {
      const first = await createDraft(contributorA, draft(), tx);
      const second = await createDraft(contributorB, draft(), tx);
      const third = await createDraft(contributorA, draft(), tx);
      const elsewhere = await createDraft(contributorA, draft({ chapterNumber: 97 }), tx);
      return { here: [first.id, second.id, third.id], elsewhere: elsewhere.id };
    });
    expect(ids.here.map(serialOf)).toEqual([1, 2, 3]);
    expect(ids.here).toEqual(["S-98-0001", "S-98-0002", "S-98-0003"]);
    expect(ids.elsewhere).toBe("S-97-0001");
  });

  it("lets a contributor read their own draft and not another's", async () => {
    const seen = await rolledBack(async (tx) => {
      const mine = await createDraft(contributorA, draft(), tx);
      return { id: mine.id, byOwner: await readSuggestion(contributorA, mine.id, tx), byOther: await readSuggestion(contributorB, mine.id, tx), absent: await readSuggestion(contributorA, "S-98-9999", tx) };
    });
    expect(seen.byOwner?.id).toBe(seen.id);
    expect(seen.byOwner?.userId).toBe(CONTRIBUTOR_A);
    expect(seen.byOther).toBeNull();
    expect(seen.absent).toBeNull();
  });

  it("lets a curator read what is past draft in one of their parts, and nobody's draft but their own", async () => {
    const seen = await rolledBack(async (tx) => {
      const inPartThree = await createDraft(contributorA, draft({ parts: ["P1", "P3"] }), tx);
      const inPartOne = await createDraft(contributorA, draft({ parts: ["P1"] }), tx);
      const stillADraft = await createDraft(contributorA, draft({ parts: ["P3"] }), tx);
      const theCuratorsOwn = await createDraft(curatorOfPartThree, draft({ parts: ["P0"] }), tx);
      for (const each of [inPartThree, inPartOne]) await transition(contributorA, each.id, "DRAFT", "SUBMITTED", { submittedAt: new Date("2026-10-05T12:00:00.000Z") }, tx);
      const read = async (caller: UserCaller, id: string): Promise<boolean> => (await readSuggestion(caller, id, tx)) !== null;
      return {
        submittedInTheirPart: await read(curatorOfPartThree, inPartThree.id),
        submittedInAnotherPart: await read(curatorOfPartThree, inPartOne.id),
        aDraftInTheirPart: await read(curatorOfPartThree, stillADraft.id),
        theirOwnDraft: await read(curatorOfPartThree, theCuratorsOwn.id),
        aContributorWithParts: await read({ ...contributorB, parts: ["P3"] }, inPartThree.id),
        aCuratorOfNoPart: await read({ ...curatorOfPartThree, parts: [] }, inPartThree.id),
        aCuratorOfTwoParts: await read({ ...curatorOfPartThree, parts: ["P2", "P1"] }, inPartOne.id),
        theOwnerStill: await read(contributorA, inPartThree.id),
      };
    });
    expect(seen).toEqual({ submittedInTheirPart: true, submittedInAnotherPart: false, aDraftInTheirPart: false, theirOwnDraft: true, aContributorWithParts: false, aCuratorOfNoPart: false, aCuratorOfTwoParts: true, theOwnerStill: true });
  });

  it("lists a person's own suggestions, drafts first and then newest, and nobody else's; counts the queue of a curator's parts, and nothing for anyone else (35 § 3)", async () => {
    const seen = await rolledBack(async (tx) => {
      const queued = { partThree: await curatorQueueCount(curatorOfPartThree, tx), partOne: await curatorQueueCount({ ...curatorOfPartThree, parts: ["P1"] }, tx) };
      const older = await createDraft(contributorA, draft({ parts: ["P3"] }), tx);
      const sent = await createDraft(contributorA, draft({ parts: ["P3"] }), tx);
      await transition(contributorA, sent.id, "DRAFT", "SUBMITTED", { submittedAt: new Date("2026-10-05T12:00:00.000Z") }, tx);
      /* Into the curators' queue by hand, as no function of a person makes that move; the transaction is rolled back. */
      await tx.suggestion.update({ where: { id: sent.id }, data: { state: "CURATOR_QUEUE" } });
      const newer = await createDraft(contributorA, draft({ parts: ["P1"] }), tx);
      const anothers = await createDraft(contributorB, draft({ parts: ["P3"] }), tx);
      return {
        ids: { older: older.id, sent: sent.id, newer: newer.id, anothers: anothers.id },
        own: (await listOwnSuggestions(contributorA, tx)).filter((row) => row.id.startsWith(`S-${String(CHAPTER)}-`)).map((row) => [row.id, row.state, row.anchor?.sectionAnchor ?? null]),
        theirs: (await listOwnSuggestions(contributorB, tx)).map((row) => row.id),
        addedToPartThree: (await curatorQueueCount(curatorOfPartThree, tx)) - queued.partThree,
        addedToPartOne: (await curatorQueueCount({ ...curatorOfPartThree, parts: ["P1"] }, tx)) - queued.partOne,
        aContributor: await curatorQueueCount({ ...contributorB, parts: ["P3"] }, tx),
        aCuratorOfNoPart: await curatorQueueCount({ ...curatorOfPartThree, parts: [] }, tx),
      };
    });
    const { ids } = seen;
    expect(seen.own).toEqual([
      [ids.newer, "DRAFT", "98.3"],
      [ids.older, "DRAFT", "98.3"],
      [ids.sent, "CURATOR_QUEUE", "98.3"],
    ]);
    expect(seen.theirs).toContain(ids.anothers);
    expect(seen.theirs).not.toContain(ids.older);
    expect({ addedToPartThree: seen.addedToPartThree, addedToPartOne: seen.addedToPartOne, aContributor: seen.aContributor, aCuratorOfNoPart: seen.aCuratorOfNoPart }).toEqual({ addedToPartThree: 1, addedToPartOne: 0, aContributor: 0, aCuratorOfNoPart: 0 });
  });

  it("gives a suggestion's own page the owner's latest other open suggestion, their own throttle count, and a curator's coded reason without the note (35 § 4)", async () => {
    const since = new Date("2026-09-01T00:00:00.000Z");
    const seen = await rolledBack(async (tx) => {
      const before = { a: await ownUnverifiableDeclines(contributorA, since, tx), b: await ownUnverifiableDeclines(contributorB, since, tx) };
      const page = await createDraft(contributorA, draft(), tx);
      const older = await createDraft(contributorA, draft(), tx);
      const newer = await createDraft(contributorA, draft(), tx);
      const closed = await createDraft(contributorA, draft(), tx);
      await createDraft(contributorA, draft(), tx);
      const anothers = await createDraft(contributorB, draft(), tx);
      const sent: ReadonlyArray<readonly [UserCaller, string, string]> = [
        [contributorA, page.id, "2026-10-06T10:00:00.000Z"],
        [contributorA, older.id, "2026-10-06T11:00:00.000Z"],
        [contributorA, newer.id, "2026-10-06T12:00:00.000Z"],
        [contributorA, closed.id, "2026-10-06T13:00:00.000Z"],
        [contributorB, anothers.id, "2026-10-06T14:00:00.000Z"],
      ];
      for (const [owner, id, at] of sent) await transition(owner, id, "DRAFT", "SUBMITTED", { submittedAt: new Date(at) }, tx);
      /* Declined with its one item U, and closed by a curator with a note, by hand: no function of a person makes either; the transaction is rolled back. */
      await tx.suggestion.update({ where: { id: closed.id }, data: { state: "CLOSED", outcome: "DECLINE", decidedAt: new Date("2026-10-06T15:00:00.000Z") } });
      await tx.evidenceItem.create({ data: { suggestionId: closed.id, ordinal: 1, kind: "LINK", state: "GRADED", tier: "U", url: "https://door-suite.invalid/a" } });
      await tx.curatorAction.create({ data: { suggestionId: closed.id, curatorId: CURATOR, action: "DECLINE", overrideCode: "OV-IND-02", criterion: "independence", note: "the curator's own words", queueWaitMs: 1_000 } });
      return {
        ids: { older: older.id, newer: newer.id },
        fromThePage: await latestOwnOpenSuggestion(contributorA, page.id, tx),
        fromTheNewer: await latestOwnOpenSuggestion(contributorA, newer.id, tx),
        forAnother: await latestOwnOpenSuggestion(contributorB, anothers.id, tx),
        declines: { a: (await ownUnverifiableDeclines(contributorA, since, tx)) - before.a, b: (await ownUnverifiableDeclines(contributorB, since, tx)) - before.b },
        reason: await latestCuratorDecision(contributorA, closed.id, tx),
        reasonForAnother: await latestCuratorDecision(contributorB, closed.id, tx),
        reasonOfNone: await latestCuratorDecision(contributorA, page.id, tx),
      };
    });
    /* The newest submitted, past draft and not ended, never the page's own, never another's; a draft and a closed one are not open. */
    expect(seen.fromThePage).toBe(seen.ids.newer);
    expect(seen.fromTheNewer).toBe(seen.ids.older);
    expect(seen.forAnother).toBeNull();
    expect(seen.declines).toEqual({ a: 1, b: 0 });
    expect(seen.reason).toEqual({ action: "DECLINE", overrideCode: "OV-IND-02", criterion: "independence" });
    expect(seen.reasonForAnother).toBeNull();
    expect(seen.reasonOfNone).toBeNull();
  });

  it("queues for a curator what is open in their parts, a shared item in each part's and none once it leaves, never their own (36 § 3, § 11.5)", async () => {
    const seen = await rolledBack(async (tx) => {
      const shared = await createDraft(contributorA, draft({ parts: ["P1", "P3"] }), tx);
      const partOne = await createDraft(contributorA, draft({ parts: ["P1"] }), tx);
      const theirOwn = await createDraft(curatorOfPartThree, draft({ parts: ["P3"] }), tx);
      const decided = await createDraft(contributorA, draft({ parts: ["P3"] }), tx);
      const ours = [shared.id, partOne.id, theirOwn.id, decided.id];
      /* Into the queue by hand, as no function of a person makes that move; the transaction is rolled back. */
      const queued: ReadonlyArray<readonly [UserCaller, string, string, Partial<{ changeClass: "CURATOR_ALWAYS"; curatorReason: "STRUCTURE"; state: "DECIDED" }>]> = [
        [contributorA, shared.id, "2026-10-06T10:00:00.000Z", {}],
        [contributorA, partOne.id, "2026-10-06T11:00:00.000Z", { changeClass: "CURATOR_ALWAYS", curatorReason: "STRUCTURE" }],
        [curatorOfPartThree, theirOwn.id, "2026-10-06T12:00:00.000Z", {}],
        [contributorA, decided.id, "2026-10-06T13:00:00.000Z", { state: "DECIDED" }],
      ];
      for (const [owner, id, at, fields] of queued) {
        await transition(owner, id, "DRAFT", "SUBMITTED", { submittedAt: new Date(at) }, tx);
        await tx.suggestion.update({ where: { id }, data: { state: "CURATOR_QUEUE", outcome: "REQUEST_MORE", decidedAt: new Date(at), ...fields } });
      }
      await tx.evidenceItem.create({ data: { suggestionId: shared.id, ordinal: 1, kind: "LINK", state: "GRADED", tier: "C", adjustedScore: 56, url: "https://door-suite.invalid/c" } });
      await tx.curatorAction.create({ data: { suggestionId: partOne.id, curatorId: CURATOR, action: "KEEP_REQUEST_MORE", queueWaitMs: 1_000 } });
      await tx.curatorAction.create({ data: { suggestionId: partOne.id, curatorId: CONTRIBUTOR_B, action: "DECLINE", queueWaitMs: 1_000 } });
      const ids = (rows: ReadonlyArray<{ readonly id: string }>): string[] => rows.map((row) => row.id).filter((id) => ours.includes(id));
      const all = { part: null, changeClass: null } as const;
      const partOneCurator: UserCaller = { ...curatorOfPartThree, parts: ["P1"] };
      const before = {
        partThree: await curatorQueue(curatorOfPartThree, all, tx),
        partOne: ids(await curatorQueue(partOneCurator, all, tx)),
        notTheirPart: ids(await curatorQueue(curatorOfPartThree, { part: "P1", changeClass: null }, tx)),
        byClass: ids(await curatorQueue({ ...curatorOfPartThree, parts: ["P1", "P3"] }, { part: null, changeClass: "CURATOR_ALWAYS" }, tx)),
        aContributor: ids(await curatorQueue({ ...contributorB, parts: ["P1", "P3"] }, all, tx)),
        decidedToday: (await curatorDecidedSince(curatorOfPartThree, new Date("2000-01-01T00:00:00.000Z"), tx)).filter((action) => ours.includes(action.suggestionId)).map((action) => [action.suggestionId, action.action]),
      };
      /* Decided by one curator: out of the queue, so in no part's (36 § 11.5). */
      await tx.suggestion.update({ where: { id: shared.id }, data: { state: "MERGING" } });
      const after = { partThree: ids(await curatorQueue(curatorOfPartThree, all, tx)), partOne: ids(await curatorQueue(partOneCurator, all, tx)) };
      return { ids: { shared: shared.id, partOne: partOne.id }, before, after };
    });
    const { ids, before, after } = seen;
    expect(before.partThree.map((row) => row.id).filter((id) => id === ids.shared || id === ids.partOne)).toEqual([ids.shared]);
    expect(before.partThree.find((row) => row.id === ids.shared)).toMatchObject({ parts: ["P1", "P3"], anchor: { sectionAnchor: "98.3" }, graded: [{ tier: "C", adjustedScore: 56 }] });
    expect(before.partOne).toEqual([ids.shared, ids.partOne]);
    expect(before.notTheirPart).toEqual([]);
    expect(before.byClass).toEqual([ids.partOne]);
    expect(before.aContributor).toEqual([]);
    expect(before.decidedToday).toEqual([[ids.partOne, "KEEP_REQUEST_MORE"]]);
    expect(after).toEqual({ partThree: [], partOne: [ids.partOne] });
  });

  it("writes a curator's action only in the queue, in their part, never on their own; and takes it back only while no event names it (36 § 5.1)", async () => {
    const seen = await rolledBack(async (tx) => {
      const queued = await createDraft(contributorA, draft({ parts: ["P3"] }), tx);
      const theirOwn = await createDraft(curatorOfPartThree, draft({ parts: ["P3"] }), tx);
      const submitted = await createDraft(contributorA, draft({ parts: ["P3"] }), tx);
      for (const [owner, id] of [[contributorA, queued.id], [curatorOfPartThree, theirOwn.id], [contributorA, submitted.id]] as const) {
        await transition(owner, id, "DRAFT", "SUBMITTED", { submittedAt: new Date("2026-10-06T10:00:00.000Z") }, tx);
      }
      for (const id of [queued.id, theirOwn.id]) {
        await tx.suggestion.update({ where: { id }, data: { state: "CURATOR_QUEUE", outcome: "REQUEST_MORE", decidedAt: new Date("2026-10-06T12:00:00.000Z"), workflowId: `suggestion:${id}` } });
      }
      const input = (suggestionId: string) => ({ suggestionId, action: "ACCEPT" as const, overrideCode: "OV-IND-02", criterion: "independence", note: "the curator's own words" });
      const at = new Date("2026-10-06T13:00:00.000Z");
      const written = await writeCuratorAction(curatorOfPartThree, input(queued.id), at, tx);
      const row = written.written ? await tx.curatorAction.findUnique({ where: { id: written.actionId }, select: { curatorId: true, action: true, overrideCode: true, criterion: true, note: true, queueWaitMs: true, seeded: true } }) : null;
      const refused = {
        notTheirPart: (await writeCuratorAction({ ...curatorOfPartThree, parts: ["P1"] }, input(queued.id), at, tx)).written,
        theirOwn: (await writeCuratorAction(curatorOfPartThree, input(theirOwn.id), at, tx)).written,
        notQueued: (await writeCuratorAction(curatorOfPartThree, input(submitted.id), at, tx)).written,
        aContributor: (await writeCuratorAction({ ...contributorB, parts: ["P3"] }, input(queued.id), at, tx)).written,
        /* Decided meanwhile (36 § 8): an action of this visit stands, so a second is not written. */
        decidedMeanwhile: (await writeCuratorAction(curatorOfPartThree, input(queued.id), at, tx)).written,
      };
      if (!written.written) throw new Error("the action was not written");
      /* Taken back: by another, never; the caller's own once, which frees the item; while an event names it, never. */
      const byAnother = await withdrawCuratorAction({ ...curatorOfPartThree, userId: CONTRIBUTOR_B }, written.actionId, tx);
      const own = await withdrawCuratorAction(curatorOfPartThree, written.actionId, tx);
      const again = await withdrawCuratorAction(curatorOfPartThree, written.actionId, tx);
      const second = await writeCuratorAction(curatorOfPartThree, input(queued.id), at, tx);
      if (!second.written) throw new Error("the second action was not written");
      /* The queue's detail: the open visit's action while it records, then recorded; nothing for a contributor. */
      const recording = await queueDecisionOf(curatorOfPartThree, queued.id, tx);
      await tx.calibrationEvent.create({ data: { suggestionId: queued.id, curatorActionId: second.actionId, curatorAction: "ACCEPT", seeded: false, rubricVersionId: RUBRIC } });
      const recorded = await queueDecisionOf(curatorOfPartThree, queued.id, tx);
      const withdrawn = { byAnother, own, again, named: await withdrawCuratorAction(curatorOfPartThree, second.actionId, tx) };
      /* Past its visit, an action no event names is passed over (33 § 20): the queue's next visit starts after it. */
      await tx.suggestion.update({ where: { id: queued.id }, data: { decidedAt: new Date("2026-10-06T14:00:00.000Z") } });
      const third = await writeCuratorAction(curatorOfPartThree, input(queued.id), new Date("2026-10-06T15:00:00.000Z"), tx);
      await tx.suggestion.update({ where: { id: queued.id }, data: { state: "MERGING", decidedAt: new Date("2026-10-06T16:00:00.000Z") } });
      const dropped = await queueDecisionOf(curatorOfPartThree, queued.id, tx);
      const decision = { recording, recorded, dropped, forAContributor: await queueDecisionOf(contributorA, queued.id, tx), third: third.written };
      return { written, row, refused, withdrawn, decision, second: second.actionId, workflowId: `suggestion:${queued.id}` };
    });
    expect(seen.written).toMatchObject({ written: true, workflowId: seen.workflowId });
    expect(seen.row).toEqual({ curatorId: CURATOR, action: "ACCEPT", overrideCode: "OV-IND-02", criterion: "independence", note: "the curator's own words", queueWaitMs: BigInt(3_600_000), seeded: false });
    expect(seen.refused).toEqual({ notTheirPart: false, theirOwn: false, notQueued: false, aContributor: false, decidedMeanwhile: false });
    expect(seen.withdrawn).toEqual({ byAnother: false, own: true, again: false, named: false });
    const shown = { actionId: seen.second, curatorId: CURATOR, action: "ACCEPT", overrideCode: "OV-IND-02", criterion: "independence", createdAt: new Date("2026-10-06T13:00:00.000Z") };
    expect(seen.decision).toEqual({ recording: { ...shown, recorded: false, open: true }, recorded: { ...shown, recorded: true, open: true }, dropped: { ...shown, recorded: true, open: false }, forAContributor: null, third: true });
  });

  it("reads calibration for a curator and the workflow alone, and opens a rubric review once per criterion and quarter (36 § 6)", async () => {
    /* The suite's quarter is 2099-Q1, which nothing real reaches, so its reviews never meet one of the product's. */
    const seen = await rolledBack(async (tx) => {
      const submitted = async (): Promise<string> => {
        const made = await createDraft(contributorA, draft({ parts: ["P3"] }), tx);
        await transition(contributorA, made.id, "DRAFT", "SUBMITTED", { submittedAt: new Date("2099-01-05T10:00:00.000Z") }, tx);
        return made.id;
      };
      const [first, accepted, reverted, routed] = [await submitted(), await submitted(), await submitted(), await submitted()];
      const event = (criterion: string | null, curatorAction: "ACCEPT" | "KEEP_REQUEST_MORE", seeded: boolean, createdAt: string) => ({ suggestionId: first, criterion, adjudicatorDecision: "REQUEST_MORE" as const, adjudicatorScore: 40, curatorAction, overrideCode: null, seeded, rubricVersionId: RUBRIC, createdAt: new Date(createdAt) });
      await tx.calibrationEvent.createMany({ data: [event("independence", "ACCEPT", false, "2099-02-01T00:00:00.000Z"), event(null, "KEEP_REQUEST_MORE", true, "2099-03-31T23:59:59.999Z"), event("recency", "ACCEPT", false, "2098-12-31T23:59:59.999Z")] });
      /* Two of the adjudicator's accepts in the quarter, one reverted since; and one the router made, which is no adjudication. */
      const adjudication = (suggestionId: string, decidedBy: string) => ({ suggestionId, decision: "ACCEPT" as const, decidedBy, score: 80, rubricVersionId: RUBRIC, decidedAt: new Date("2099-01-10T00:00:00.000Z"), traceId: "0".repeat(32) });
      await tx.adjudication.createMany({ data: [adjudication(accepted, "adjudicator"), adjudication(reverted, "adjudicator"), adjudication(routed, "router")] });
      await tx.curatorAction.create({ data: { suggestionId: reverted, curatorId: CURATOR, action: "REVERT", queueWaitMs: 0 } });

      const from = new Date("2099-01-01T00:00:00.000Z");
      const to = new Date("2099-04-01T00:00:00.000Z");
      const events = await calibrationEventsBetween(curatorOfPartThree, from, to, tx);
      const accepts = await adjudicatorAcceptsBetween(curatorOfPartThree, from, to, tx);
      const before = await tx.rubricReview.count({ where: { rubricVersionId: RUBRIC } });
      const review = { quarter: "2099-Q1", rubricVersionId: RUBRIC, rate: 0.24, overridden: 6, reviewed: 25 };
      const opened = await openRubricReview(intake, { ...review, criterion: "independence" }, tx);
      const again = await openRubricReview(intake, { ...review, criterion: "independence", rate: 0.3 }, tx);
      const other = await openRubricReview(intake, { ...review, criterion: "recency" }, tx);
      return {
        events: events.map((row) => [row.criterion, row.curatorAction, row.seeded, row.origin, row.createdAt.toISOString()]),
        accepts: accepts.map((row) => row.reverted).sort(),
        expected: [rubricReviewIdOf(RUBRIC, before + 1), rubricReviewIdOf(RUBRIC, before + 2)],
        opened,
        again,
        other,
        reviews: (await rubricReviewsIn(curatorOfPartThree, ["2099-Q1"], tx)).map((row) => [row.id, row.criterion, row.rate]),
        forAContributor: [await calibrationEventsBetween(contributorA, from, to, tx), await adjudicatorAcceptsBetween(contributorA, from, to, tx), await rubricReviewsIn(contributorA, ["2099-Q1"], tx)],
      };
    });
    /* the quarter's own, the seed's with them, which the measures leave out themselves; not the one a millisecond before */
    expect(seen.events).toEqual([
      ["independence", "ACCEPT", false, "HUMAN", "2099-02-01T00:00:00.000Z"],
      [null, "KEEP_REQUEST_MORE", true, "HUMAN", "2099-03-31T23:59:59.999Z"],
    ]);
    expect(seen.accepts).toEqual([false, true]);
    expect(seen.opened).toEqual({ id: seen.expected[0], opened: true });
    expect(seen.again).toEqual({ id: seen.expected[0], opened: false });
    expect(seen.other).toEqual({ id: seen.expected[1], opened: true });
    expect(seen.reviews).toEqual([
      [seen.expected[0], "independence", 0.24],
      [seen.expected[1], "recency", 0.24],
    ]);
    expect(seen.forAContributor).toEqual([[], [], []]);
    expect(rubricReviewIdOf("v1.2", 7)).toBe("R-1.2-0007");
    await expect(calibrationEventsBetween(grader, new Date(0), new Date(), getPrisma())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(openRubricReview(grader, { criterion: "tier", quarter: "2099-Q1", rubricVersionId: RUBRIC, rate: 0.3, overridden: 6, reviewed: 20 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("offers a curator seeds of what another curator decided, under fresh ids, once each; decides one seeded and reveals it; and the other reads pass it over (36 § 7.1)", async () => {
    const now = new Date("2026-10-09T08:00:00.000Z");
    const seen = await rolledBack(async (tx) => {
      const made = async (owner: UserCaller, state: "CURATOR_QUEUE" | "DECIDED" | "MERGED" | "CLOSED"): Promise<string> => {
        const draftRow = await createDraft(owner, draft({ parts: ["P3"] }), tx);
        await transition(owner, draftRow.id, "DRAFT", "SUBMITTED", { submittedAt: new Date("2026-10-06T10:00:00.000Z") }, tx);
        await tx.suggestion.update({ where: { id: draftRow.id }, data: { state, outcome: "REQUEST_MORE", decidedAt: new Date("2026-10-07T12:00:00.000Z") } });
        await tx.adjudication.create({ data: { suggestionId: draftRow.id, decision: "REQUEST_MORE", decidedBy: "adjudicator", score: 40, rubricVersionId: RUBRIC, decidedAt: new Date("2026-10-07T12:00:00.000Z"), traceId: "0".repeat(32) } });
        return draftRow.id;
      };
      /* The caller curates part three since 14:00 on the 7th: what was decided there before, they never saw in their queue. */
      await setRosterEntry({ userId: CURATOR, part: "P3", until: null }, new Date("2026-10-07T14:00:00.000Z"), tx);
      const answer = async (suggestionId: string, action: "KEEP_REQUEST_MORE" | "ACCEPT" | "DECLINE", at: string, recorded = true): Promise<string> => {
        const row = await tx.curatorAction.create({ data: { suggestionId, curatorId: CONTRIBUTOR_B, action, queueWaitMs: 1, createdAt: new Date(at) } });
        if (recorded) await tx.calibrationEvent.create({ data: { suggestionId, curatorActionId: row.id, curatorAction: action, adjudicatorDecision: "REQUEST_MORE", seeded: false, rubricVersionId: RUBRIC } });
        return row.id;
      };
      /* decided by another curator, recorded, settled, before the caller curated the part: the ones to offer */
      const decided = await made(contributorA, "CLOSED");
      const answeredId = await answer(decided, "KEEP_REQUEST_MORE", "2026-10-07T13:00:00.000Z");
      const answered = { id: answeredId };
      const another = await made(contributorA, "CLOSED");
      await answer(another, "DECLINE", "2026-10-07T13:30:00.000Z");
      /* none of these: decided but never recorded; the caller's own; in the queue; still open to revision; decided again after the answer; answered once the caller curated the part (unit 53's review) */
      const unrecorded = await made(contributorA, "CLOSED");
      await answer(unrecorded, "ACCEPT", "2026-10-07T13:00:00.000Z", false);
      const theirs = await made(curatorOfPartThree, "CLOSED");
      await answer(theirs, "DECLINE", "2026-10-07T13:00:00.000Z");
      const queued = await made(contributorA, "CURATOR_QUEUE");
      const revisable = await made(contributorA, "DECIDED");
      await answer(revisable, "KEEP_REQUEST_MORE", "2026-10-07T13:00:00.000Z");
      const revised = await made(contributorA, "CLOSED");
      await answer(revised, "KEEP_REQUEST_MORE", "2026-10-07T13:00:00.000Z");
      await tx.adjudication.update({ where: { suggestionId: revised }, data: { decidedAt: new Date("2026-10-08T09:00:00.000Z") } });
      const seenThere = await made(contributorA, "CLOSED");
      await answer(seenThere, "DECLINE", "2026-10-07T15:00:00.000Z");

      const none = await seedsOffered(curatorOfPartThree, 0, { part: null, changeClass: null }, now, tx);
      const first = await seedsOffered(curatorOfPartThree, 5, { part: null, changeClass: null }, now, tx);
      const again = await seedsOffered(curatorOfPartThree, 5, { part: null, changeClass: null }, now, tx);
      const seedId = first[0]?.id ?? "none";
      const otherSeed = first[1]?.id ?? "none";
      const offered = { none, first: first.map((row) => [row.state, row.outcome, row.submittedAt?.toISOString(), row.anchor?.suggestionId === row.id]), again: again.map((row) => row.id), seeds: await tx.curationSeed.count({ where: { curatorId: CURATOR } }), aSuggestion: await tx.suggestion.count({ where: { id: seedId } }), of: (await tx.curationSeed.findMany({ where: { curatorId: CURATOR }, select: { suggestionId: true }, orderBy: { id: "asc" } })).map((seed) => seed.suggestionId) };
      /* Room for one: the other offer waits, its time starting again when it is shown (D11); decided again since the offer, it is never shown again. */
      const later = new Date("2026-10-09T08:10:00.000Z");
      const roomForOne = (await seedsOffered(curatorOfPartThree, 1, { part: null, changeClass: null }, later, tx)).map((row) => row.id);
      const waited = (await tx.curationSeed.findUnique({ where: { id: otherSeed }, select: { offeredAt: true } }))?.offeredAt.toISOString();
      await tx.suggestion.update({ where: { id: another }, data: { decidedAt: new Date("2026-10-09T08:20:00.000Z") } });
      const stale = (await seedsOffered(curatorOfPartThree, 5, { part: null, changeClass: null }, new Date("2026-10-09T08:30:00.000Z"), tx)).map((row) => row.id);
      const window = { roomForOne, waited, stale };
      const read = { before: await seedOf(curatorOfPartThree, seedId, tx), forAContributor: await seedOf(contributorA, seedId, tx) };

      /* decided: seeded, compared with the answer, once; nothing told, so nothing recorded */
      const input = { action: "KEEP_REQUEST_MORE" as const, overrideCode: null, criterion: null, note: "kept: the vendor page alone" };
      const written = await writeSeedDecision(curatorOfPartThree, seedId, input, new Date("2026-10-09T08:30:00.000Z"), tx);
      const twice = await writeSeedDecision(curatorOfPartThree, seedId, input, new Date("2026-10-09T08:31:00.000Z"), tx);
      const action = written.written ? await tx.curatorAction.findUnique({ where: { id: written.actionId }, select: { suggestionId: true, seeded: true, seedMatched: true, queueWaitMs: true } }) : null;
      const after = {
        seed: await seedOf(curatorOfPartThree, seedId, tx),
        today: (await curatorDecidedSince(curatorOfPartThree, new Date("2026-10-09T00:00:00.000Z"), tx)).map((entry) => [entry.suggestionId, entry.action, entry.seed]),
        shown: (await seedsOffered(curatorOfPartThree, 5, { part: null, changeClass: null }, now, tx)).map((row) => row.id),
        /* the other reads pass a seed's decision over */
        reason: await latestCuratorDecision(contributorA, decided, tx),
        decision: (await queueDecisionOf(curatorOfPartThree, decided, tx))?.actionId === answered.id,
      };
      /* a seeded action made since a suggestion entered the queue is no decision of it: the curator still may decide */
      await tx.curatorAction.create({ data: { suggestionId: queued, curatorId: CONTRIBUTOR_B, action: "ACCEPT", queueWaitMs: 1, seeded: true, seedMatched: false } });
      const stillDecidable = (await writeCuratorAction(curatorOfPartThree, { suggestionId: queued, action: "KEEP_REQUEST_MORE", overrideCode: null, criterion: null, note: "kept" }, now, tx)).written;
      /* the month's sample is drawn from what merged in the caller's parts, never their own */
      const merged = await made(contributorA, "MERGED");
      await made(curatorOfPartThree, "MERGED");
      const sample = { forTheCurator: (await mergedInParts(curatorOfPartThree, { part: null, changeClass: null }, tx)).map((row) => row.id), forAContributor: await mergedInParts(contributorA, { part: null, changeClass: null }, tx) };
      return { decided, another, seedId, otherSeed, offered, window, read, written: written.written, twice: twice.written, action, after, stillDecidable, merged, sample, answered: answered.id };
    });
    expect(seen.offered.none).toEqual([]);
    expect(seen.offered.first).toEqual([
      ["CURATOR_QUEUE", "REQUEST_MORE", "2026-10-09T08:00:00.000Z", true],
      ["CURATOR_QUEUE", "REQUEST_MORE", "2026-10-09T08:00:00.000Z", true],
    ]);
    expect(seen.seedId).toMatch(/^S-98-\d{4}$/);
    expect(seen.seedId).not.toBe(seen.decided);
    expect(seen.offered).toMatchObject({ again: [seen.seedId, seen.otherSeed], seeds: 2, aSuggestion: 0, of: [seen.decided, seen.another] });
    expect(seen.window).toEqual({ roomForOne: [seen.seedId], waited: "2026-10-09T08:10:00.000Z", stale: [seen.seedId] });
    expect(seen.read.before).toMatchObject({ id: seen.seedId, suggestionId: seen.decided, answer: "KEEP_REQUEST_MORE", standing: "REQUEST_MORE", decided: null });
    expect(seen.read.forAContributor).toBeNull();
    expect([seen.written, seen.twice]).toEqual([true, false]);
    expect(seen.action).toEqual({ suggestionId: seen.decided, seeded: true, seedMatched: true, queueWaitMs: BigInt(1_800_000) });
    expect(seen.after.seed?.decided).toMatchObject({ action: "KEEP_REQUEST_MORE", matched: true });
    expect(seen.after.today).toEqual([[seen.seedId, "KEEP_REQUEST_MORE", { answer: "KEEP_REQUEST_MORE", matched: true }]]);
    expect(seen.after.shown).toEqual([]);
    expect(seen.after.reason).toEqual({ action: "KEEP_REQUEST_MORE", overrideCode: null, criterion: null });
    expect(seen.after.decision).toBe(true);
    expect(seen.stillDecidable).toBe(true);
    expect(seen.sample).toEqual({ forTheCurator: [seen.merged], forAContributor: [] });
  });

  it("reads as a service every state and nobody's id, and refuses a caller that is not one of the five", async () => {
    const seen = await rolledBack(async (tx) => {
      const made = await createDraft(contributorA, draft(), tx);
      const asDraft = await readSuggestionAsService(grader, made.id, tx);
      await transition(intake, made.id, "DRAFT", "SUBMITTED", {}, tx);
      return { asDraft, asSubmitted: await readSuggestionAsService(grader, made.id, tx), absent: await readSuggestionAsService(grader, "S-98-9999", tx) };
    });
    expect(seen.asDraft?.state).toBe("DRAFT");
    expect(seen.asSubmitted?.state).toBe("SUBMITTED");
    expect(seen.asSubmitted?.anchor?.sectionAnchor).toBe("98.3");
    expect(seen.asSubmitted).not.toHaveProperty("userId");
    expect(seen.asSubmitted).not.toHaveProperty("user");
    expect(JSON.stringify(seen.asSubmitted)).not.toContain(CONTRIBUTOR_A);
    expect(seen.absent).toBeNull();
    await expect(readSuggestionAsService({ kind: "service", id: "service:export" } as unknown as ServiceCaller, "S-98-0001")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(readSuggestionAsService(contributorA as unknown as ServiceCaller, "S-98-0001")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("moves a draft to submitted for its owner once: the second time it changes nothing and says where the row is", async () => {
    const at = new Date("2026-10-05T12:00:00.000Z");
    const seen = await rolledBack(async (tx) => {
      const made = await createDraft(contributorA, draft(), tx);
      const first = await transition(contributorA, made.id, "DRAFT", "SUBMITTED", { submittedAt: at, workflowId: `suggestion:${made.id}` }, tx);
      const second = await transition(contributorA, made.id, "DRAFT", "SUBMITTED", { submittedAt: new Date("2026-10-06T12:00:00.000Z"), workflowId: "suggestion:another" }, tx);
      const byTheWorkflow = await transition(intake, made.id, "DRAFT", "SUBMITTED", {}, tx);
      return { id: made.id, first, second, byTheWorkflow, row: await readSuggestion(contributorA, made.id, tx) };
    });
    expect(seen.first).toEqual({ moved: true, state: "SUBMITTED" });
    expect(seen.second).toEqual({ moved: false, state: "SUBMITTED" });
    expect(seen.byTheWorkflow).toEqual({ moved: false, state: "SUBMITTED" });
    expect(seen.row).toMatchObject({ state: "SUBMITTED", submittedAt: at, workflowId: `suggestion:${seen.id}` });
  });

  it("moves nothing for a person who is not the owner, and refuses a person any move but the submission", async () => {
    const seen = await rolledBack(async (tx) => {
      const made = await createDraft(contributorA, draft({ parts: ["P3"] }), tx);
      const byAnother = await transition(contributorB, made.id, "DRAFT", "SUBMITTED", {}, tx);
      const byACurator = await transition(curatorOfPartThree, made.id, "DRAFT", "SUBMITTED", {}, tx);
      return { byAnother, byACurator, state: (await readSuggestion(contributorA, made.id, tx))?.state, id: made.id };
    });
    expect(seen.byAnother).toEqual({ moved: false, state: null });
    expect(seen.byACurator).toEqual({ moved: false, state: null });
    expect(seen.state).toBe("DRAFT");
    await expect(transition(contributorA, seen.id, "SUBMITTED", "GRADED")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(transition(contributorA, seen.id, "DRAFT", "CLOSED")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(transition(curatorOfPartThree, seen.id, "CURATOR_QUEUE", "MERGING")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("moves a suggestion for a service only from the state it names, with what the move carries", async () => {
    const decidedAt = new Date("2026-10-05T12:30:00.000Z");
    const seen = await rolledBack(async (tx) => {
      const made = await createDraft(contributorA, draft(), tx);
      const tooEarly = await transition(grader, made.id, "SUBMITTED", "GRADED", { score: 85 }, tx);
      const submitted = await transition(intake, made.id, "DRAFT", "SUBMITTED", {}, tx);
      const graded = await transition(grader, made.id, "SUBMITTED", "GRADED", { score: 85 }, tx);
      const again = await transition(grader, made.id, "SUBMITTED", "GRADED", { score: 0 }, tx);
      const sensed = await transition(intake, made.id, "GRADED", "SENSED", {}, tx);
      const decided = await transition({ kind: "service", id: "service:adjudicator" }, made.id, "SENSED", "DECIDED", { outcome: "ACCEPT", decidedAt }, tx);
      const nobody = await transition(grader, "S-98-9999", "SUBMITTED", "GRADED", {}, tx);
      return { tooEarly, submitted, graded, again, sensed, decided, nobody, row: await readSuggestionAsService(grader, made.id, tx) };
    });
    expect(seen.tooEarly).toEqual({ moved: false, state: "DRAFT" });
    expect(seen.submitted).toEqual({ moved: true, state: "SUBMITTED" });
    expect(seen.graded).toEqual({ moved: true, state: "GRADED" });
    expect(seen.again).toEqual({ moved: false, state: "GRADED" });
    expect(seen.sensed).toEqual({ moved: true, state: "SENSED" });
    expect(seen.decided).toEqual({ moved: true, state: "DECIDED" });
    expect(seen.nobody).toEqual({ moved: false, state: null });
    expect(seen.row).toMatchObject({ state: "DECIDED", score: 85, outcome: "ACCEPT", decidedAt });
    await expect(transition({ kind: "service", id: "service:export" } as unknown as ServiceCaller, "S-98-0001", "DRAFT", "SUBMITTED")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a service a move the table does not have, before the database is asked (unit 50a)", async () => {
    await expect(transition(grader, "S-98-9999", "SUBMITTED", "SENSED")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(transition(intake, "S-98-9999", "DRAFT", "GRADED")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(transition(grader, "S-98-9999", "GRADED", "SUBMITTED")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("moves a draft out for a workflow only when its contributor is verified and has consented, which the owner's own move does not need (invariant 25)", async () => {
    const seen = await rolledBack(async (tx) => {
      const unconsented = await createDraft(contributorB, draft(), tx);
      const byTheWorkflow = await transition(intake, unconsented.id, "DRAFT", "SUBMITTED", {}, tx);
      const byTheOwner = await transition(contributorB, unconsented.id, "DRAFT", "SUBMITTED", {}, tx);
      const consented = await createDraft(contributorA, draft(), tx);
      return { byTheWorkflow, byTheOwner, ofTheConsenting: await transition(intake, consented.id, "DRAFT", "SUBMITTED", {}, tx) };
    });
    expect(seen.byTheWorkflow).toEqual({ moved: false, state: "DRAFT" });
    expect(seen.byTheOwner).toEqual({ moved: true, state: "SUBMITTED" });
    expect(seen.ofTheConsenting).toEqual({ moved: true, state: "SUBMITTED" });
  });

  it("tells the intake activity whose suggestion it is, as it tells the grader and, for its call's principal, the adjudicator (unit 50d), and no other service", async () => {
    const seen = await rolledBack(async (tx) => {
      const made = await createDraft(contributorA, draft(), tx);
      return { id: made.id, byIntake: await contributorIdOf(intake, made.id, tx), byGrader: await contributorIdOf(grader, made.id, tx), byAdjudicator: await contributorIdOf({ kind: "service", id: "service:adjudicator" }, made.id, tx), absent: await contributorIdOf(intake, "S-98-9999", tx) };
    });
    expect(seen).toMatchObject({ byIntake: CONTRIBUTOR_A, byGrader: CONTRIBUTOR_A, byAdjudicator: CONTRIBUTOR_A, absent: null });
    for (const id of ["service:merge", "service:researcher"] as const) await expect(contributorIdOf({ kind: "service", id }, seen.id), id).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("writes a submitted suggestion's sensor verdicts, one row a sensor, over the last attempt's, and none on a draft (unit 50a)", async () => {
    const first = new Date("2026-10-06T12:00:00.000Z");
    const again = new Date("2026-10-06T13:00:00.000Z");
    const verdicts = (anchor: "PASS" | "FAIL") =>
      (["SCHEMA", "ANCHOR_EXISTS", "EVIDENCE_PARSES", "RATIONALE_LENGTH"] as const).map((sensor) => ({ sensor, result: sensor === "ANCHOR_EXISTS" ? anchor : ("PASS" as const), detail: `${sensor} said so`, data: { sensor } }));
    const seen = await rolledBack(async (tx) => {
      const made = await createDraft(contributorA, draft(), tx);
      const onADraft = await writeSensorVerdicts(intake, made.id, verdicts("PASS"), first, tx);
      await transition(intake, made.id, "DRAFT", "SUBMITTED", {}, tx);
      const written = await writeSensorVerdicts(intake, made.id, verdicts("PASS"), first, tx);
      const rewritten = await writeSensorVerdicts(intake, made.id, verdicts("FAIL"), again, tx);
      return { onADraft, written, rewritten, rows: (await readSuggestionAsService(intake, made.id, tx))?.sensorVerdicts ?? [] };
    });
    expect(seen).toMatchObject({ onADraft: false, written: true, rewritten: true });
    expect(seen.rows).toHaveLength(4);
    expect(seen.rows.find((row) => row.sensor === "ANCHOR_EXISTS")).toMatchObject({ result: "FAIL", detail: "ANCHOR_EXISTS said so", data: { sensor: "ANCHOR_EXISTS" }, createdAt: again });
    expect(seen.rows.filter((row) => row.result === "PASS")).toHaveLength(3);
  });

  it("writes a submitted suggestion's score with no move, and nothing on another state (unit 50a)", async () => {
    const seen = await rolledBack(async (tx) => {
      const made = await createDraft(contributorA, draft(), tx);
      const onADraft = await writeSuggestionScore(grader, made.id, 56, tx);
      await transition(intake, made.id, "DRAFT", "SUBMITTED", {}, tx);
      const written = await writeSuggestionScore(grader, made.id, 56, tx);
      return { onADraft, written, row: await readSuggestionAsService(grader, made.id, tx) };
    });
    expect(seen).toMatchObject({ onADraft: false, written: true, row: { state: "SUBMITTED", score: 56 } });
  });

  it("takes a contributor's request to withdraw only where its workflow waits for a person, guarded on the decision it read; a curator decides nothing past it; it is taken back only unrecorded (45 § 5.2, § 5.3)", async () => {
    const DECIDED_AT = new Date("2026-10-06T12:00:00.000Z");
    const at = new Date("2026-10-06T13:00:00.000Z");
    const later = new Date("2026-10-06T13:05:00.000Z");
    const action = (suggestionId: string) => ({ suggestionId, action: "ACCEPT" as const, overrideCode: "OV-IND-02", criterion: "independence", note: "the curator's own words" });
    const seen = await rolledBack(async (tx) => {
      const made = async (state: "SUBMITTED" | "INTAKE_DECLINED" | "DECIDED" | "CURATOR_QUEUE" | "MERGING", outcome: "DECLINE" | "REQUEST_MORE" | "ACCEPT" | "CURATOR_REVIEW" | null): Promise<string> => {
        const row = await createDraft(contributorA, draft({ parts: ["P3"] }), tx);
        await transition(contributorA, row.id, "DRAFT", "SUBMITTED", {}, tx);
        if (state !== "SUBMITTED") await tx.suggestion.update({ where: { id: row.id }, data: { state, outcome, decidedAt: DECIDED_AT } });
        return row.id;
      };
      const queued = await made("CURATOR_QUEUE", "CURATOR_REVIEW");
      const declined = await made("INTAKE_DECLINED", "DECLINE");
      const askedForMore = await made("DECIDED", "REQUEST_MORE");
      const accepted = await made("DECIDED", "ACCEPT");
      const merging = await made("MERGING", "ACCEPT");
      const submitted = await made("SUBMITTED", null);
      /* the queue's list and counts, which a withdrawal standing leaves (review of unit 63) */
      const queueOf = async () => ({ listed: (await curatorQueue(curatorOfPartThree, { part: null, changeClass: null }, tx)).some((row) => row.id === queued), count: await curatorQueueCount(curatorOfPartThree, tx), byPart: (await queueCountByPart(["P3"], tx))[0]?.count ?? 0 });
      const queueBefore = await queueOf();
      const requested = {
        queued: await requestWithdrawal(contributorA, queued, at, tx),
        declined: await requestWithdrawal(contributorA, declined, at, tx),
        askedForMore: await requestWithdrawal(contributorA, askedForMore, at, tx),
        accepted: await requestWithdrawal(contributorA, accepted, at, tx),
        merging: await requestWithdrawal(contributorA, merging, at, tx),
        submitted: await requestWithdrawal(contributorA, submitted, at, tx),
        byAnother: await requestWithdrawal(contributorB, accepted, at, tx),
        /* the caller's own request standing is answered as it stands, with its instant, to be sent again (review of unit 63) */
        twice: await requestWithdrawal(contributorA, queued, later, tx),
      };
      const queueAfter = await queueOf();
      /* a curator decides nothing past a withdrawal that stands: the suggestion is no longer in the queue to decide */
      const curatorPast = (await writeCuratorAction(curatorOfPartThree, action(queued), later, tx)).written;
      /* what the run reads before it records */
      const stands = {
        asWritten: await withdrawalStands(intake, queued, { userId: CONTRIBUTOR_A, at, decidedAt: DECIDED_AT }, tx),
        anotherInstant: await withdrawalStands(intake, queued, { userId: CONTRIBUTOR_A, at: later, decidedAt: DECIDED_AT }, tx),
        anotherDecision: await withdrawalStands(intake, queued, { userId: CONTRIBUTOR_A, at, decidedAt: new Date("2026-10-06T11:00:00.000Z") }, tx),
        anotherPerson: await withdrawalStands(intake, queued, { userId: CONTRIBUTOR_B, at, decidedAt: DECIDED_AT }, tx),
      };
      /* a curator's action of this visit that came first: the request is refused, and a request already standing is no longer one the run records */
      const raced = await made("CURATOR_QUEUE", "CURATOR_REVIEW");
      const first = await writeCuratorAction(curatorOfPartThree, action(raced), later, tx);
      const afterAction = await requestWithdrawal(contributorA, raced, at, tx);
      await tx.suggestion.update({ where: { id: raced }, data: { withdrawnAt: at } });
      const standsAfterAction = await withdrawalStands(intake, raced, { userId: CONTRIBUTOR_A, at, decidedAt: DECIDED_AT }, tx);
      /* taken back: never another person's, never another instant's, the caller's own once, never a recorded one */
      const takenBack = {
        byAnother: await takeBackWithdrawal(contributorB, declined, at, tx),
        otherInstant: await takeBackWithdrawal(contributorA, declined, later, tx),
        own: await takeBackWithdrawal(contributorA, declined, at, tx),
        again: await takeBackWithdrawal(contributorA, declined, at, tx),
      };
      await moveAlong(intake, askedForMore, ["DECIDED", "CLOSED"], { closedAt: at }, tx);
      const recorded = await takeBackWithdrawal(intake, askedForMore, at, tx);
      const rows = await tx.suggestion.findMany({ where: { id: { in: [queued, declined, askedForMore] } }, orderBy: { id: "asc" }, select: { id: true, state: true, withdrawnAt: true } });
      return { ids: { queued, declined, askedForMore }, requested, queueBefore, queueAfter, curatorPast, stands, first: first.written, afterAction, standsAfterAction, takenBack, recorded, rows };
    });
    const asked = { requested: true, at, decidedAt: DECIDED_AT };
    expect(seen.requested).toEqual({
      queued: asked,
      declined: asked,
      askedForMore: asked,
      accepted: { requested: false, state: "DECIDED" },
      merging: { requested: false, state: "MERGING" },
      submitted: { requested: false, state: "SUBMITTED" },
      byAnother: { requested: false, state: null },
      twice: asked,
    });
    expect(seen.queueBefore.listed).toBe(true);
    expect(seen.queueAfter).toEqual({ listed: false, count: seen.queueBefore.count - 1, byPart: seen.queueBefore.byPart - 1 });
    expect(seen.curatorPast).toBe(false);
    expect(seen.stands).toEqual({ asWritten: true, anotherInstant: false, anotherDecision: false, anotherPerson: false });
    expect(seen.first).toBe(true);
    expect(seen.afterAction).toEqual({ requested: false, state: "CURATOR_QUEUE" });
    expect(seen.standsAfterAction).toBe(false);
    expect(seen.takenBack).toEqual({ byAnother: false, otherInstant: false, own: true, again: false });
    expect(seen.recorded).toBe(false);
    const byId = new Map(seen.rows.map((row) => [row.id, row]));
    expect(byId.get(seen.ids.queued)).toMatchObject({ state: "CURATOR_QUEUE", withdrawnAt: at });
    expect(byId.get(seen.ids.declined)).toMatchObject({ state: "INTAKE_DECLINED", withdrawnAt: null });
    expect(byId.get(seen.ids.askedForMore)).toMatchObject({ state: "CLOSED", withdrawnAt: at });
  });

  it("deletes a draft for its owner alone, with its anchor, saying which items it had, and never a suggestion past draft", async () => {
    const ITEM = "4f1c9a2e-0000-4000-8000-0000000000a1";
    const seen = await rolledBack(async (tx) => {
      const mine = await createDraft(contributorA, draft(), tx);
      await addEvidenceItem(contributorA, mine.id, { id: ITEM, kind: "LINK", url: "https://pages.example/pricing", doi: null, storageKey: null, host: "pages.example" }, 10, tx);
      const submitted = await createDraft(contributorA, draft(), tx);
      await transition(contributorA, submitted.id, "DRAFT", "SUBMITTED", {}, tx);
      const byAnother = await deleteDraft(contributorB, mine.id, tx);
      const stillThere = (await readSuggestion(contributorA, mine.id, tx)) !== null;
      const byOwner = await deleteDraft(contributorA, mine.id, tx);
      const gone = (await readSuggestion(contributorA, mine.id, tx)) === null;
      const twice = await deleteDraft(contributorA, mine.id, tx);
      const pastDraft = await deleteDraft(contributorA, submitted.id, tx);
      return { byAnother, stillThere, byOwner, gone, twice, pastDraft, kept: (await readSuggestion(contributorA, submitted.id, tx))?.state };
    });
    expect(seen).toEqual({ byAnother: { deleted: false }, stillThere: true, byOwner: { deleted: true, items: [{ id: ITEM, state: "PENDING" }] }, gone: true, twice: { deleted: false }, pastDraft: { deleted: false }, kept: "SUBMITTED" });
  });

  /* feature-specs/29 § 6.1, § 6.3 (unit 46d): the roster is rows, and which are in force is a matter of dates. */
  it("puts a curator on the roster for a part, and reads the parts in force at a moment", async () => {
    const day = (n: number): Date => new Date(Date.UTC(2026, 9, n, 12));
    const seen = await rolledBack(async (tx) => {
      const first = await setRosterEntry({ userId: CURATOR, part: "P3", until: null }, day(5), tx);
      const second = await setRosterEntry({ userId: CURATOR, part: "P1", until: day(20) }, day(6), tx);
      return {
        first,
        second,
        before: await currentParts(CURATOR, day(4), tx),
        onTheDay: await currentParts(CURATOR, day(5), tx),
        both: await currentParts(CURATOR, day(10), tx),
        atTheEnd: await currentParts(CURATOR, day(20), tx),
        after: await currentParts(CURATOR, day(21), tx),
        another: await currentParts(CONTRIBUTOR_A, day(10), tx),
      };
    });
    expect(seen.first).toEqual({ userId: CURATOR, part: "P3", since: day(5), until: null });
    expect(seen.second).toEqual({ userId: CURATOR, part: "P1", since: day(6), until: day(20) });
    expect(seen.before).toEqual([]);
    expect(seen.onTheDay).toEqual(["P3"]);
    expect(seen.both).toEqual(["P1", "P3"]);
    expect(seen.atTheEnd).toEqual(["P3"]);
    expect(seen.after).toEqual(["P3"]);
    expect(seen.another).toEqual([]);
  });

  it("keeps the day a row in force began, begins again one that had ended, and refuses an end that is not after the beginning", async () => {
    const day = (n: number): Date => new Date(Date.UTC(2026, 9, n, 12));
    const seen = await rolledBack(async (tx) => {
      await setRosterEntry({ userId: CURATOR, part: "P3", until: null }, day(5), tx);
      const ended = await setRosterEntry({ userId: CURATOR, part: "P3", until: day(15) }, day(10), tx);
      const cleared = await setRosterEntry({ userId: CURATOR, part: "P3", until: null }, day(12), tx);
      await setRosterEntry({ userId: CURATOR, part: "P3", until: day(15) }, day(13), tx);
      const again = await setRosterEntry({ userId: CURATOR, part: "P3", until: null }, day(18), tx);
      const refused = await setRosterEntry({ userId: CURATOR, part: "P3", until: day(18) }, day(19), tx).then(
        () => null,
        (error: unknown) => error,
      );
      const refusedNew = await setRosterEntry({ userId: CURATOR, part: "P0", until: day(18) }, day(19), tx).then(
        () => null,
        (error: unknown) => error,
      );
      return { ended, cleared, again, refused, refusedNew, parts: await currentParts(CURATOR, day(19), tx) };
    });
    expect(seen.ended).toMatchObject({ since: day(5), until: day(15) });
    expect(seen.cleared).toMatchObject({ since: day(5), until: null });
    expect(seen.again).toMatchObject({ since: day(18), until: null });
    expect(seen.refused).toMatchObject({ code: "INVALID_INPUT" });
    expect(seen.refusedNew).toMatchObject({ code: "INVALID_INPUT" });
    expect(seen.parts).toEqual(["P3"]);
  });

  /* § 10.4. This one commits: the serial is taken under the counter's row, and that is only seen when transactions meet. */
  it("gives consecutive serials to drafts created at the same moment, and never one serial twice", async () => {
    const DRAFTS = 12;
    const created = await Promise.all(Array.from({ length: DRAFTS }, (_, index) => createDraft(index % 2 === 0 ? contributorA : contributorB, draft())));
    const ids = created.map((each) => each.id);
    try {
      for (const id of ids) expect(id).toMatch(/^S-98-\d{4,}$/);
      expect(new Set(ids).size).toBe(DRAFTS);
      expect(ids.map(serialOf).sort((a, b) => a - b)).toEqual(Array.from({ length: DRAFTS }, (_, index) => index + 1));
      /* A serial is never given again: the next draft continues after a deleted one. */
      expect(await deleteDraft(contributorA, ids[0] ?? "")).toEqual({ deleted: true, items: [] });
      const next = await createDraft(contributorA, draft());
      ids.push(next.id);
      expect(serialOf(next.id)).toBe(DRAFTS + 1);
    } finally {
      for (const each of created) await deleteDraft(each.userId === CONTRIBUTOR_A ? contributorA : contributorB, each.id);
      await deleteDraft(contributorA, ids[ids.length - 1] ?? "");
    }
    const left = await getPrisma().$queryRawUnsafe<ReadonlyArray<{ n: bigint }>>(`SELECT count(*) AS n FROM "Suggestion" WHERE "chapterNumber" = ${String(CHAPTER)}`);
    expect(Number(left[0]?.n)).toBe(0);
  });

  /*
   * Every case above ran the door on one transaction's one connection. A query that asks for several relations of
   * a row is run by the client as several statements at once, which the driver warns it will stop queueing: the
   * door reads one statement at a time so that it never does. The warning is raised once in a process, so it is
   * looked for once, at the end.
   */
  it("never asked a transaction's connection two things at once", async () => {
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings.filter((message) => message.includes("already executing a query"))).toEqual([]);
  });
});
