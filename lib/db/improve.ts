import type { SessionUser } from "@/lib/auth/session";
import { getPrisma, type ExtendedClient } from "@/lib/db/client";
import type { Prisma } from "@/lib/db/generated/client";
import type { AnchorKind, ChangeClass, ChangeKind, CuratorActionKind, CuratorReason, Decision, EvidenceKind, EvidenceState, EvidenceTier, Lang, Part, SensorResult, SuggestionOrigin, SuggestionSensor, SuggestionState } from "@/lib/db/generated/enums";
import { AuditExportScopeColumnSchema, type AuditExportRequest, type AuditExportScopeColumn, type AuditExportState } from "@/lib/schemas/audit";
import { AppError, isUniqueViolation } from "@/lib/errors";
import { sha256Hex } from "@/lib/ledger/hash";
import type { Role } from "@/lib/schemas/auth";
import { suggestionIdOf } from "@/lib/schemas/ids";
import { isLegalMove, takesWithdrawal, WITHDRAWABLE_STATES, type Criterion, type Decider } from "@/lib/schemas/improve";
import { MergeCheckSchema } from "@/lib/schemas/merge";

/*
 * The one door to the improvement rows (feature-specs/29 § 2, § 4; architecture § 5.4).
 *
 * Those rows are the platform's, outside the tenant filter: a suggestion is a contribution to the one book, and a
 * curator of another organisation must read it. So nothing injects a `WHERE` for them, and this module is what
 * stands where the tenant guard stands for a reader's rows:
 *
 *   - no other module names these tables (tests/improve-door.test.ts and CI hold that, as one holds the ledger's
 *     single writer);
 *   - every function takes its caller, and the condition that makes a row the caller's is IN THE QUERY. A handler
 *     that forgot to ask the policy still could not read another contributor's draft. The policy is asked first
 *     all the same (invariant 23);
 *   - a service is handed no row of `User` and no column that says who wrote a suggestion: there is no function
 *     here that could return a contributor's name, e-mail or organisation to an agent, so there is nothing to
 *     forget to withhold (invariant 12).
 *
 * A later unit that needs another read or write of these rows adds its function here.
 */

export const IMPROVE_SERVICES = ["service:intake", "service:grader", "service:adjudicator", "service:researcher", "service:merge"] as const;
export type ImproveService = (typeof IMPROVE_SERVICES)[number];

/** A signed-in person. `parts` is the curator roster's for them at the time of the request, and empty for anyone who is not a curator. */
export interface UserCaller {
  readonly kind: "user";
  readonly userId: string;
  readonly role: Role;
  readonly parts: ReadonlyArray<Part>;
}

/** A workflow's activity, by the identity its agent has in the policy and in the ledger. */
export interface ServiceCaller {
  readonly kind: "service";
  readonly id: ImproveService;
}

export type Caller = UserCaller | ServiceCaller;

/** Who is asking, from their session: the role as mirrored at sign-in, and the roster's parts as read for this request. */
export function callerOf(user: Pick<SessionUser, "id" | "role" | "parts">): UserCaller {
  return { kind: "user", userId: user.id, role: user.role, parts: user.parts };
}

type Rows = Pick<ExtendedClient, "suggestion" | "suggestionCounter" | "anchor" | "evidenceItem" | "suggestionSensorVerdict" | "adjudication" | "criterionVerdict" | "curatorAction" | "calibrationEvent" | "rubricReview" | "curationSeed" | "curatorRoster" | "rubricVersion" | "threshold" | "merge">;

/**
 * The client a function runs on: the shared one, or an interactive transaction's, which has the same rows and no
 * `$transaction` of its own. A caller that must do something else in the same transaction passes its `tx`.
 */
export type ImproveClient = Rows & Partial<Pick<ExtendedClient, "$transaction">>;

function inTransaction<T>(client: ImproveClient, body: (tx: Rows) => Promise<T>): Promise<T> {
  return client.$transaction === undefined ? body(client) : client.$transaction((tx) => body(tx));
}

/* ---------------------------------------------------------------- what is read */

const ANCHOR = { kind: true, sectionAnchor: true, figureAnchor: true, sourceRowAnchor: true, currentText: true, contentSha256: true, existsAtVersion: true } as const satisfies Prisma.AnchorSelect;
/** The same with its suggestion, for a read of many (unit 54d). */
const ANCHOR_WITH_ID = { suggestionId: true, ...ANCHOR } as const satisfies Prisma.AnchorSelect;

const EVIDENCE = {
  id: true,
  ordinal: true,
  kind: true,
  state: true,
  url: true,
  doi: true,
  storageKey: true,
  fileName: true,
  labRunId: true,
  title: true,
  host: true,
  publishedOn: true,
  ageDays: true,
  fetchStatus: true,
  contentSha256: true,
  textKey: true,
  tier: true,
  baseScore: true,
  relevance: true,
  recency: true,
  independence: true,
  adjustedScore: true,
  reason: true,
  gradedBy: true,
  gradedAt: true,
} as const satisfies Prisma.EvidenceItemSelect;

const SENSOR_VERDICT = { sensor: true, result: true, detail: true, data: true, createdAt: true } as const satisfies Prisma.SuggestionSensorVerdictSelect;

const ADJUDICATION = {
  decision: true,
  decidedBy: true,
  score: true,
  acceptAt: true,
  floorAt: true,
  sufficientTier: true,
  failingSensor: true,
  guideVersion: true,
  guideSha256: true,
  modelId: true,
  promptSha256: true,
  failure: true,
  rubricVersionId: true,
  decidedAt: true,
  traceId: true,
} as const satisfies Prisma.AdjudicationSelect;

const CRITERION = { criterion: true, verdict: true, reason: true } as const satisfies Prisma.CriterionVerdictSelect;

/** A merge's row as its activities read it (feature-specs/37 § 4): no `mergedBy`, which names a person. */
const MERGE = { suggestionId: true, branch: true, commitSha: true, versionFrom: true, versionTo: true, bump: true, check: true, mergedAt: true, releaseFrom: true, releaseTo: true, revertedBy: true } as const satisfies Prisma.MergeSelect;
export type MergeRow = Prisma.MergeGetPayload<{ select: typeof MERGE }>;

/** A suggestion's own columns as a service reads them: no `userId`, and no relation at all. */
const SUGGESTION = {
  id: true,
  origin: true,
  chapterNumber: true,
  chapterVersionId: true,
  releaseId: true,
  parts: true,
  changeKind: true,
  changeClass: true,
  curatorReason: true,
  proposal: true,
  proposalKey: true,
  rationale: true,
  locale: true,
  state: true,
  outcome: true,
  score: true,
  rubricVersionId: true,
  workflowId: true,
  createdAt: true,
  submittedAt: true,
  decidedAt: true,
  closedAt: true,
  withdrawnAt: true,
  budgetResetsAt: true,
} as const satisfies Prisma.SuggestionSelect;

/**
 * The same as a person reads them, with whose suggestion it is — the contributor's id, or null for a researcher's
 * proposal — and whether it was drafted from a research finding (feature-specs/48 § 8.6; unit 74), which the edit page
 * labels and the queue marks. A service is not handed that column: the adjudicator judges evidence, and is not told.
 */
const OWNED_SUGGESTION = { ...SUGGESTION, userId: true, fromResearch: true } as const satisfies Prisma.SuggestionSelect;

/**
 * Every column this module reads, by the row it is read from. A service is handed `suggestion` and the five kinds
 * of row under it; a person the same with `ownedSuggestion` in its place; the merge's service its row (unit 54b).
 * Nothing here is a row of `User`, a curator's action or a curator's note. Exported so the suite can hold it to that,
 * column by column.
 */
export const SELECTED = { suggestion: SUGGESTION, ownedSuggestion: OWNED_SUGGESTION, anchor: ANCHOR, evidence: EVIDENCE, sensorVerdict: SENSOR_VERDICT, adjudication: ADJUDICATION, criterion: CRITERION, merge: MERGE } as const;

/** What hangs from a suggestion and is read with it. */
interface Parts {
  readonly anchor: Prisma.AnchorGetPayload<{ select: typeof ANCHOR }> | null;
  /** Its merge, once one began (feature-specs/37 § 4; unit 54b). */
  readonly merge: MergeRow | null;
  /** In the order the contributor added them. */
  readonly evidence: ReadonlyArray<Prisma.EvidenceItemGetPayload<{ select: typeof EVIDENCE }>>;
  readonly sensorVerdicts: ReadonlyArray<Prisma.SuggestionSensorVerdictGetPayload<{ select: typeof SENSOR_VERDICT }>>;
  readonly adjudication: Prisma.AdjudicationGetPayload<{ select: typeof ADJUDICATION }> | null;
  readonly criteria: ReadonlyArray<Prisma.CriterionVerdictGetPayload<{ select: typeof CRITERION }>>;
}

export type SuggestionForService = Prisma.SuggestionGetPayload<{ select: typeof SUGGESTION }> & Parts;
export type SuggestionForUser = Prisma.SuggestionGetPayload<{ select: typeof OWNED_SUGGESTION }> & Parts;

/*
 * One statement at a time, and not one query with five relations. The client loads the relations of a row side by
 * side, which on an interactive transaction's single connection is several statements at once: the driver still
 * queues them but has deprecated doing so (measured in unit 46b: the first such read in a transaction is the
 * driver's warning). These functions run on a transaction as readily as outside one, so they never ask for it.
 */
async function partsOf(client: Rows, suggestionId: string): Promise<Parts> {
  const anchor = await client.anchor.findUnique({ where: { suggestionId }, select: ANCHOR });
  const evidence = await client.evidenceItem.findMany({ where: { suggestionId }, select: EVIDENCE, orderBy: { ordinal: "asc" } });
  const sensorVerdicts = await client.suggestionSensorVerdict.findMany({ where: { suggestionId }, select: SENSOR_VERDICT, orderBy: { sensor: "asc" } });
  const adjudication = await client.adjudication.findUnique({ where: { suggestionId }, select: ADJUDICATION });
  const criteria = await client.criterionVerdict.findMany({ where: { suggestionId }, select: CRITERION, orderBy: { criterion: "asc" } });
  const merge = await client.merge.findUnique({ where: { suggestionId }, select: MERGE });
  return { anchor, merge, evidence, sensorVerdicts, adjudication, criteria };
}

/**
 * What a person may read (29 § 4.1): their own, in any state; and as a curator, whatever is past draft in one of
 * their parts. A draft is its owner's alone, a curator's part or not.
 */
function readableBy(caller: UserCaller): Prisma.SuggestionWhereInput {
  const own: Prisma.SuggestionWhereInput = { userId: caller.userId };
  if (caller.role !== "CURATOR" || caller.parts.length === 0) return own;
  return { OR: [own, { state: { not: "DRAFT" }, parts: { hasSome: [...caller.parts] } }] };
}

function requireService(caller: ServiceCaller): void {
  if (caller.kind !== "service" || !IMPROVE_SERVICES.includes(caller.id)) throw new AppError("FORBIDDEN", "the improvement rows are reached as a person or as one of the five improvement services (feature-specs/29 § 4.1).");
}

/** The suggestion, if the caller may read it. Null says nothing about why: not there, and not theirs, are one answer. */
export async function readSuggestion(caller: UserCaller, id: string, client: ImproveClient = getPrisma()): Promise<SuggestionForUser | null> {
  const suggestion = await client.suggestion.findFirst({ where: { AND: [{ id }, readableBy(caller)] }, select: OWNED_SUGGESTION });
  return suggestion === null ? null : { ...suggestion, ...(await partsOf(client, suggestion.id)) };
}

/**
 * A merged suggestion, which anyone may read (35 D2; unit 54d): its record is public, the chapter's history linking to
 * it. No caller: the condition is the suggestion's own state, and nothing of the reader. Null for one that is not
 * merged, which stays its audience's.
 */
export async function readMergedSuggestion(id: string, client: ImproveClient = getPrisma()): Promise<SuggestionForUser | null> {
  const suggestion = await client.suggestion.findFirst({ where: { id, state: "MERGED" }, select: OWNED_SUGGESTION });
  return suggestion === null ? null : { ...suggestion, ...(await partsOf(client, suggestion.id)) };
}

/* ---------------------------------------------------------------- a chapter's history (feature-specs/37 § 7; unit 54d) */

const HISTORY_ROW = { id: true, origin: true, userId: true, fromResearch: true, changeKind: true, changeClass: true, curatorReason: true, proposal: true, score: true, rubricVersionId: true, decidedAt: true } as const satisfies Prisma.SuggestionSelect;

/** A merged suggestion as the chapter's history lists it: the suggestion, where it was anchored, its proposal, its merge, what the adjudicator said, and its graded items' tiers and scores. The contributor's id is for the credit list, where consent governs the name (invariant 27). */
export type HistoryRow = Prisma.SuggestionGetPayload<{ select: typeof HISTORY_ROW }> & {
  readonly anchor: Prisma.AnchorGetPayload<{ select: typeof ANCHOR }> | null;
  readonly merge: MergeRow;
  readonly adjudication: Pick<Prisma.AdjudicationGetPayload<{ select: typeof ADJUDICATION }>, "decision" | "decidedBy" | "score" | "acceptAt"> | null;
  readonly graded: ReadonlyArray<{ readonly tier: EvidenceTier | null; readonly adjustedScore: number | null }>;
};

/**
 * The chapter's merged suggestions (37 § 7), which are public (35 D2), so this read takes no caller: oldest merge
 * first, each with its parts, in four statements for any number. A suggestion merged and then reverted is still here,
 * its merge saying so (`revertedBy`; 54e).
 */
export async function mergedOfChapter(chapterNumber: number, client: ImproveClient = getPrisma()): Promise<HistoryRow[]> {
  const rows = await client.suggestion.findMany({ where: { chapterNumber, state: "MERGED" }, select: HISTORY_ROW });
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const merges = await client.merge.findMany({ where: { suggestionId: { in: ids }, mergedAt: { not: null } }, select: MERGE });
  const anchors = await client.anchor.findMany({ where: { suggestionId: { in: ids } }, select: ANCHOR_WITH_ID });
  const adjudications = await client.adjudication.findMany({ where: { suggestionId: { in: ids } }, select: { suggestionId: true, decision: true, decidedBy: true, score: true, acceptAt: true } });
  const items = await client.evidenceItem.findMany({ where: { suggestionId: { in: ids }, state: "GRADED" }, select: { suggestionId: true, tier: true, adjustedScore: true } });
  const mergeOf = new Map(merges.map((merge) => [merge.suggestionId, merge]));
  const anchorOf = new Map(anchors.map(({ suggestionId, ...anchor }) => [suggestionId, anchor]));
  const adjudicationOf = new Map(adjudications.map(({ suggestionId, ...adjudication }) => [suggestionId, adjudication]));
  return rows
    .flatMap((row) => {
      const merge = mergeOf.get(row.id);
      return merge === undefined ? [] : [{ ...row, anchor: anchorOf.get(row.id) ?? null, merge, adjudication: adjudicationOf.get(row.id) ?? null, graded: items.filter((item) => item.suggestionId === row.id).map((item) => ({ tier: item.tier, adjustedScore: item.adjustedScore })) }];
    })
    .sort((a, b) => (a.merge.mergedAt?.getTime() ?? 0) - (b.merge.mergedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
}

/* ---------------------------------------------------------------- the landing page (feature-specs/35 § 3) */

const OWN_ROW = { id: true, state: true, outcome: true, changeClass: true, score: true, rubricVersionId: true, createdAt: true, submittedAt: true, decidedAt: true, withdrawnAt: true } as const satisfies Prisma.SuggestionSelect;
const OWN_ANCHOR = { suggestionId: true, kind: true, sectionAnchor: true, figureAnchor: true, sourceRowAnchor: true } as const satisfies Prisma.AnchorSelect;

/** A row of the landing page's "Your suggestions": the suggestion as its list names it, with where it is anchored. */
export type OwnSuggestionRow = Prisma.SuggestionGetPayload<{ select: typeof OWN_ROW }> & { readonly anchor: Prisma.AnchorGetPayload<{ select: typeof OWN_ANCHOR }> | null };

/**
 * The caller's own suggestions, every state: drafts first, then newest first (35 § 3). Nobody else's: a list of
 * suggestions is only ever a person's own, and no count of them by person is made anywhere else (invariant 26).
 * Read in two statements, as `partsOf` reads, not one query with a relation.
 */
export async function listOwnSuggestions(caller: UserCaller, client: ImproveClient = getPrisma()): Promise<OwnSuggestionRow[]> {
  const rows = await client.suggestion.findMany({ where: { userId: caller.userId }, select: OWN_ROW, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const anchors = await client.anchor.findMany({ where: { suggestionId: { in: rows.map((row) => row.id) } }, select: OWN_ANCHOR });
  const anchorOf = new Map(anchors.map((anchor) => [anchor.suggestionId, anchor]));
  const drafts = rows.filter((row) => row.state === "DRAFT");
  const rest = rows.filter((row) => row.state !== "DRAFT");
  return [...drafts, ...rest].map((row) => ({ ...row, anchor: anchorOf.get(row.id) ?? null }));
}

/**
 * How many suggestions wait in the curators' queue for the caller's parts (35 § 3; 36): a count of the queue, never of
 * anyone's suggestions. Zero for anyone who curates no part. One whose contributor asked to withdraw it waits for no
 * curator (45 § 5.2; review of unit 63), as `writeCuratorAction` reads.
 */
export function curatorQueueCount(caller: UserCaller, client: ImproveClient = getPrisma()): Promise<number> {
  if (caller.role !== "CURATOR" || caller.parts.length === 0) return Promise.resolve(0);
  return client.suggestion.count({ where: { state: "CURATOR_QUEUE", withdrawnAt: null, parts: { hasSome: [...caller.parts] } } });
}

/* ---------------------------------------------------------------- a suggestion's own page (feature-specs/35 § 4) */

/** Past draft and not ended: where a person's suggestion is still under way, waits on its owner, or waits on a curator or the merge. */
const OPEN_STATES = ["SUBMITTED", "INTAKE_DECLINED", "GRADED", "SENSED", "DECIDED", "CURATOR_QUEUE", "MERGING"] as const satisfies ReadonlyArray<SuggestionState>;

/** The caller's most recently submitted open suggestion other than `exceptId`: the page's right column, `also yours · open`. Their own only; null when there is none. */
export async function latestOwnOpenSuggestion(caller: UserCaller, exceptId: string, client: ImproveClient = getPrisma()): Promise<string | null> {
  const row = await client.suggestion.findFirst({ where: { userId: caller.userId, id: { not: exceptId }, state: { in: [...OPEN_STATES] } }, select: { id: true }, orderBy: [{ submittedAt: "desc" }, { id: "desc" }] });
  return row?.id ?? null;
}

/**
 * The throttle's count for the caller themself (35 § 4's throttle box: `you have 0`), by the query the throttle runs
 * (`unverifiableDeclinesOf`), on their own suggestions only: a person's count, never anyone else's (invariant 26).
 */
export function ownUnverifiableDeclines(caller: UserCaller, since: Date, client: ImproveClient = getPrisma()): Promise<number> {
  return client.suggestion.count({ where: unverifiableDeclines(caller.userId, since) });
}

/** What the page says of a curator's decision (35 § 4, D4): the action and its coded reason, never the note, which leaves the door nowhere but as a hash. */
export interface CuratorDecisionForUser {
  readonly action: CuratorActionKind;
  readonly overrideCode: string | null;
  readonly criterion: string | null;
}

/** The last curator's action on a suggestion the caller may read, or null: the coded reason of a curator's decline, shown on its page. */
export async function latestCuratorDecision(caller: UserCaller, suggestionId: string, client: ImproveClient = getPrisma()): Promise<CuratorDecisionForUser | null> {
  const readable = await client.suggestion.findFirst({ where: { AND: [{ id: suggestionId }, readableBy(caller)] }, select: { id: true } });
  if (readable === null) return null;
  /* A seed's decision (36 § 7.1) is a curator's consistency, never the suggestion's decision. */
  return client.curatorAction.findFirst({ where: { suggestionId, seeded: false }, select: { action: true, overrideCode: true, criterion: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
}

/* ---------------------------------------------------------------- the curator queue (feature-specs/36 § 3) */

const QUEUE_ROW = { id: true, state: true, outcome: true, changeClass: true, curatorReason: true, score: true, parts: true, submittedAt: true, decidedAt: true, origin: true, fromResearch: true } as const satisfies Prisma.SuggestionSelect;

/** An open item of a curator's queue: the suggestion as the queue names it, where it is anchored, and its graded items' tiers and scores. Nobody's name. */
export type QueueRow = Prisma.SuggestionGetPayload<{ select: typeof QUEUE_ROW }> & {
  readonly anchor: Prisma.AnchorGetPayload<{ select: typeof OWN_ANCHOR }> | null;
  readonly graded: ReadonlyArray<{ readonly tier: EvidenceTier | null; readonly adjustedScore: number | null }>;
};

/**
 * What waits in the queue for the caller's parts (36 § 3): suggestions in `CURATOR_QUEUE` whose parts meet the
 * caller's roster — a shared item in every one of its parts' queues — never the caller's own, which they may not
 * decide (36 § 9), longest-waiting first, and never one whose contributor asked to withdraw it, which no curator may
 * decide (45 § 5.2; review of unit 63). `part` narrows to one of the caller's parts and `changeClass` to one class.
 * Empty for anyone who curates no part. Read in three statements, as `partsOf` reads.
 */
export async function curatorQueue(caller: UserCaller, filter: { readonly part: Part | null; readonly changeClass: ChangeClass | null }, client: ImproveClient = getPrisma()): Promise<QueueRow[]> {
  if (caller.role !== "CURATOR") return [];
  const parts = filter.part === null ? caller.parts : caller.parts.filter((part) => part === filter.part);
  if (parts.length === 0) return [];
  const rows = await client.suggestion.findMany({
    where: { state: "CURATOR_QUEUE", withdrawnAt: null, parts: { hasSome: [...parts] }, OR: [{ userId: null }, { userId: { not: caller.userId } }], ...(filter.changeClass === null ? {} : { changeClass: filter.changeClass }) },
    select: QUEUE_ROW,
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
  });
  return withAnchorsAndGrades(client, rows);
}

/** Queue rows with where each is anchored and its graded items' tiers and scores: two statements for any number. */
async function withAnchorsAndGrades(client: ImproveClient, rows: ReadonlyArray<Prisma.SuggestionGetPayload<{ select: typeof QUEUE_ROW }>>): Promise<QueueRow[]> {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const anchors = await client.anchor.findMany({ where: { suggestionId: { in: ids } }, select: OWN_ANCHOR });
  const items = await client.evidenceItem.findMany({ where: { suggestionId: { in: ids }, state: "GRADED" }, select: { suggestionId: true, tier: true, adjustedScore: true } });
  const anchorOf = new Map(anchors.map((anchor) => [anchor.suggestionId, anchor]));
  return rows.map((row) => ({ ...row, anchor: anchorOf.get(row.id) ?? null, graded: items.filter((item) => item.suggestionId === row.id).map((item) => ({ tier: item.tier, adjustedScore: item.adjustedScore })) }));
}

/** The queue's two filters: one of the caller's parts, one class, or neither. */
export interface QueueFilter {
  readonly part: Part | null;
  readonly changeClass: ChangeClass | null;
}

/* ---------------------------------------------------------------- seeds (feature-specs/36 § 7.1) */

const SEED = { id: true, suggestionId: true, answer: true, standing: true, offeredAt: true, actionId: true } as const satisfies Prisma.CurationSeedSelect;
type SeedRecord = Prisma.CurationSeedGetPayload<{ select: typeof SEED }>;

/**
 * Where a suggestion is settled: merging, merged or closed. Nothing its contributor writes changes it there, so a known
 * answer stays the answer to what a seed shows; one that may still be revised, or is in the queue again, is no seed's
 * (unit 53's review).
 */
const SETTLED = ["MERGING", "MERGED", "CLOSED"] as const satisfies ReadonlyArray<SuggestionState>;

/** What a seed may be of, for a curator: settled, in their parts and the filter's, never their own, and never one they decided. */
function seedable(caller: UserCaller, parts: ReadonlyArray<Part>, filter: QueueFilter): Prisma.SuggestionWhereInput {
  return {
    state: { in: [...SETTLED] },
    parts: { hasSome: [...parts] },
    OR: [{ userId: null }, { userId: { not: caller.userId } }],
    curatorActions: { none: { curatorId: caller.userId } },
    ...(filter.changeClass === null ? {} : { changeClass: filter.changeClass }),
  };
}

/**
 * The seeds a curator's queue shows (36 § 7.1), as queue rows: up to `wanted` of their open offers, oldest first,
 * topped up with new ones; none at all while `wanted` is 0, as it is at `CURATOR_SEED_SHARE` 0 (A16). Each row shows
 * the suggestion as the queue showed it — in the queue, with what stood then — under the seed's own id, since the
 * offer. An offer is not shown once its suggestion is no longer settled, once the caller decided the suggestion itself,
 * or once it was decided again since the offer: its answer would no longer be the decision (unit 53's review).
 */
export async function seedsOffered(caller: UserCaller, wanted: number, filter: QueueFilter, now: Date = new Date(), client: ImproveClient = getPrisma()): Promise<QueueRow[]> {
  if (caller.role !== "CURATOR" || !(wanted > 0)) return [];
  const parts = filter.part === null ? caller.parts : caller.parts.filter((part) => part === filter.part);
  if (parts.length === 0) return [];
  const showable = seedable(caller, parts, filter);
  const open = await client.curationSeed.findMany({ where: { curatorId: caller.userId, actionId: null, suggestion: showable }, select: SEED, orderBy: [{ offeredAt: "asc" }, { id: "asc" }] });
  const decidedAt = new Map((await client.suggestion.findMany({ where: { id: { in: open.map((seed) => seed.suggestionId) } }, select: { id: true, decidedAt: true } })).map((row) => [row.id, row.decidedAt]));
  const current = open.filter((seed) => (decidedAt.get(seed.suggestionId) ?? seed.offeredAt) <= seed.offeredAt);
  /* An offer the queue has no room for now is offered again when it has, its time starting then: one shown after a wait would show a deadline already past (D11). */
  const later = current.slice(wanted).map((seed) => seed.id);
  if (later.length > 0) await client.curationSeed.updateMany({ where: { id: { in: later }, actionId: null }, data: { offeredAt: now } });
  const shown = current.slice(0, wanted);
  const seeds = shown.length >= wanted ? shown : [...shown, ...(await offerSeeds(caller, wanted - shown.length, showable, now, client))];
  if (seeds.length === 0) return [];
  const rows = await withAnchorsAndGrades(client, await client.suggestion.findMany({ where: { id: { in: seeds.map((seed) => seed.suggestionId) } }, select: QUEUE_ROW }));
  const rowOf = new Map(rows.map((row) => [row.id, row]));
  return seeds.flatMap((seed) => {
    const row = rowOf.get(seed.suggestionId);
    if (row === undefined) return [];
    return [{ ...row, id: seed.id, state: "CURATOR_QUEUE" as const, outcome: seed.standing, submittedAt: seed.offeredAt, decidedAt: seed.offeredAt, anchor: row.anchor === null ? null : { ...row.anchor, suggestionId: seed.id } }];
  });
}

/**
 * New offers (36 § 7.1): settled suggestions another curator decided — the decision recorded, its calibration event
 * written — that the caller has not decided and was never offered, each with the newest such decision as the known
 * answer, the oldest decided first. Two conditions besides (unit 53's review): no decision of the adjudicator's or the
 * rules' came after the answer, so it answers the evidence the seed shows; and the caller has not seen the suggestion,
 * the answer given before they began to curate any of its parts, so it never sat in their own queue. A seed's id is the
 * chapter's next serial, taken as a draft takes one (29 § 4.2), so no suggestion is ever given it; two reads offering
 * at once give one seed, the second finding it there.
 */
async function offerSeeds(caller: UserCaller, count: number, showable: Prisma.SuggestionWhereInput, now: Date, client: ImproveClient): Promise<SeedRecord[]> {
  const decisions = await client.curatorAction.findMany({
    where: {
      seeded: false,
      action: { in: ["ACCEPT", "KEEP_REQUEST_MORE", "DECLINE"] },
      OR: [{ curatorId: null }, { curatorId: { not: caller.userId } }],
      suggestion: { ...showable, seeds: { none: { curatorId: caller.userId } } },
    },
    select: { id: true, suggestionId: true, action: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const recorded = new Set((await client.calibrationEvent.findMany({ where: { curatorActionId: { in: decisions.map((decision) => decision.id) } }, select: { curatorActionId: true } })).map((event) => event.curatorActionId));
  const answers = new Map<string, (typeof decisions)[number]>();
  for (const decision of decisions) if (recorded.has(decision.id) && !answers.has(decision.suggestionId)) answers.set(decision.suggestionId, decision);
  if (answers.size === 0) return [];
  const facts = await client.suggestion.findMany({ where: { id: { in: [...answers.keys()] } }, select: { id: true, chapterNumber: true, parts: true, adjudication: { select: { decision: true, decidedAt: true } } } });
  const factOf = new Map(facts.map((fact) => [fact.id, fact]));
  const since = new Map((await client.curatorRoster.findMany({ where: { userId: caller.userId }, select: { part: true, since: true } })).map((row) => [row.part, row.since]));
  const chosen = [...answers.values()]
    .filter((answer) => {
      const fact = factOf.get(answer.suggestionId);
      if (fact === undefined) return false;
      const current = fact.adjudication === null || fact.adjudication.decidedAt <= answer.createdAt;
      const unseen = fact.parts.every((part) => {
        const from = since.get(part);
        return from === undefined || answer.createdAt < from;
      });
      return current && unseen;
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, count);
  const offered: SeedRecord[] = [];
  for (const answer of chosen) {
    const fact = factOf.get(answer.suggestionId);
    if (fact === undefined) continue;
    try {
      offered.push(
        await inTransaction(client, async (tx) => {
          const counter = await tx.suggestionCounter.upsert({ where: { chapterNumber: fact.chapterNumber }, create: { chapterNumber: fact.chapterNumber, next: 2 }, update: { next: { increment: 1 } }, select: { next: true } });
          /* What stood in the queue: the adjudication's decision; with no adjudication row the router queued it, as `CURATOR_REVIEW` (33 § 6.1). */
          return tx.curationSeed.create({ data: { id: suggestionIdOf(fact.chapterNumber, counter.next - 1), suggestionId: fact.id, curatorId: caller.userId, answer: answer.action, standing: fact.adjudication?.decision ?? "CURATOR_REVIEW", offeredAt: now }, select: SEED });
        }),
      );
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return offered;
}

/** A seed as its curator reads it (36 § 7.1): the real suggestion it is of, never in an answer, and its decision once made. */
export interface SeedForCurator {
  readonly id: string;
  readonly suggestionId: string;
  readonly answer: CuratorActionKind;
  readonly standing: Decision | null;
  readonly offeredAt: Date;
  readonly decided: { readonly action: CuratorActionKind; readonly matched: boolean; readonly at: Date } | null;
}

/** The caller's own seed by its id, or null: another curator's seed is nobody's to read. */
export async function seedOf(caller: UserCaller, id: string, client: ImproveClient = getPrisma()): Promise<SeedForCurator | null> {
  if (caller.role !== "CURATOR") return null;
  const seed = await client.curationSeed.findFirst({ where: { id, curatorId: caller.userId }, select: SEED });
  if (seed === null) return null;
  const action = seed.actionId === null ? null : await client.curatorAction.findUnique({ where: { id: seed.actionId }, select: { action: true, seedMatched: true, createdAt: true } });
  return { id: seed.id, suggestionId: seed.suggestionId, answer: seed.answer, standing: seed.standing, offeredAt: seed.offeredAt, decided: action === null ? null : { action: action.action, matched: action.seedMatched === true, at: action.createdAt } };
}

/**
 * A curator's decision on their seed (36 § 7.1): an action on the real suggestion marked `seeded`, compared with the
 * answer, its wait counted from the offer; the seed names it. Nothing else: no workflow is told, so no record and no
 * calibration event follow, and the seed is in none of the measures. Once only.
 */
export function writeSeedDecision(caller: UserCaller, seedId: string, input: Omit<CuratorActionInput, "suggestionId">, now: Date = new Date(), client: ImproveClient = getPrisma()): Promise<{ readonly written: true; readonly actionId: string } | { readonly written: false }> {
  if (caller.role !== "CURATOR") return Promise.resolve({ written: false });
  return inTransaction(client, async (tx) => {
    const seed = await tx.curationSeed.findFirst({ where: { id: seedId, curatorId: caller.userId, actionId: null }, select: { id: true, suggestionId: true, answer: true, offeredAt: true } });
    if (seed === null) return { written: false };
    const created = await tx.curatorAction.create({
      data: { suggestionId: seed.suggestionId, curatorId: caller.userId, action: input.action, overrideCode: input.overrideCode, criterion: input.criterion, note: input.note, queueWaitMs: Math.max(0, now.getTime() - seed.offeredAt.getTime()), seeded: true, seedMatched: input.action === seed.answer, createdAt: now },
      select: { id: true },
    });
    const linked = await tx.curationSeed.updateMany({ where: { id: seed.id, actionId: null }, data: { actionId: created.id } });
    /* Decided meanwhile, by a second read of the same seed: this one is taken back with the transaction. */
    if (linked.count !== 1) throw new AppError("CONFLICT", `seed ${seed.id} was decided meanwhile`);
    return { written: true, actionId: created.id };
  });
}

/* ---------------------------------------------------------------- what merges (feature-specs/37 § 6) */

/**
 * What merges in a curator's parts (37 § 6; unit 54b), for the queue's "Ready to merge" and "Merging" groups: accepted
 * suggestions in `MERGING`, and a person's accepted by the adjudicator still in `DECIDED`, in their parts and the
 * filter's, never their own, as queue rows with their merges. Nothing for anyone but a curator.
 */
export async function mergingInParts(caller: UserCaller, filter: QueueFilter, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<QueueRow & { readonly merge: MergeRow | null }>> {
  if (caller.role !== "CURATOR") return [];
  const parts = filter.part === null ? caller.parts : caller.parts.filter((part) => part === filter.part);
  if (parts.length === 0) return [];
  const rows = await client.suggestion.findMany({
    where: { OR: [{ state: "MERGING" }, { state: "DECIDED", outcome: "ACCEPT" }], parts: { hasSome: [...parts] }, AND: [{ OR: [{ userId: null }, { userId: { not: caller.userId } }] }], ...(filter.changeClass === null ? {} : { changeClass: filter.changeClass }) },
    select: QUEUE_ROW,
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
  });
  const merges = new Map((await client.merge.findMany({ where: { suggestionId: { in: rows.map((row) => row.id) } }, select: MERGE })).map((merge) => [merge.suggestionId, merge]));
  return (await withAnchorsAndGrades(client, rows)).map((row) => ({ ...row, merge: merges.get(row.id) ?? null }));
}

/* ---------------------------------------------------------------- the monthly sample (feature-specs/36 § 7.2) */

/**
 * What the month's sample is drawn from, for a curator (36 § 7.2): merged suggestions in their parts and the filter's,
 * never their own, as queue rows, whose strongest item and draw the queue's reads take. Nothing is merged before unit
 * 54c, so nothing is drawn yet.
 */
export async function mergedInParts(caller: UserCaller, filter: QueueFilter, client: ImproveClient = getPrisma()): Promise<QueueRow[]> {
  if (caller.role !== "CURATOR") return [];
  const parts = filter.part === null ? caller.parts : caller.parts.filter((part) => part === filter.part);
  if (parts.length === 0) return [];
  const rows = await client.suggestion.findMany({
    where: { state: "MERGED", parts: { hasSome: [...parts] }, OR: [{ userId: null }, { userId: { not: caller.userId } }], ...(filter.changeClass === null ? {} : { changeClass: filter.changeClass }) },
    select: QUEUE_ROW,
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
  });
  return withAnchorsAndGrades(client, rows);
}

/** A curator's decision as the decision endpoint writes it (36 § 5.1 step 4); the note is text here and only its hash in the ledger (D4). */
export interface CuratorActionInput {
  readonly suggestionId: string;
  readonly action: "ACCEPT" | "KEEP_REQUEST_MORE" | "DECLINE";
  readonly overrideCode: string | null;
  readonly criterion: string | null;
  readonly note: string | null;
}

export type CuratorActionWritten = { readonly written: true; readonly actionId: string; readonly workflowId: string | null } | { readonly written: false };

/**
 * The action of a curator's decision (36 § 5.1 step 4): written only while the suggestion is in the queue, in one of
 * the caller's parts and not the caller's own — the condition in the query, as every read of this door has it — with
 * how long it waited there, counted from the decision that queued it. Not seeded: seeds are 53e's. The workflow, told
 * of it, records it (33 § 6.3); this writes nothing to the ledger (invariant 17). Once an action of this visit stands
 * — made since the decision that queued it, the workflow recording it — the suggestion is decided, and a second
 * curator's is not written (36 § 8): the workflow would record the first and drop it (33 § 20).
 */
export function writeCuratorAction(caller: UserCaller, input: CuratorActionInput, now: Date = new Date(), client: ImproveClient = getPrisma()): Promise<CuratorActionWritten> {
  if (caller.role !== "CURATOR" || caller.parts.length === 0) return Promise.resolve({ written: false });
  return inTransaction(client, async (tx) => {
    /* a suggestion whose contributor asked to withdraw it is no longer in the queue to decide (45 § 5.2) */
    const row = await tx.suggestion.findFirst({ where: { id: input.suggestionId, state: "CURATOR_QUEUE", withdrawnAt: null, parts: { hasSome: [...caller.parts] }, OR: [{ userId: null }, { userId: { not: caller.userId } }] }, select: { id: true, decidedAt: true, workflowId: true } });
    if (row === null) return { written: false };
    if (await actionStands(tx, row)) return { written: false };
    const queueWaitMs = row.decidedAt === null ? 0 : Math.max(0, now.getTime() - row.decidedAt.getTime());
    const created = await tx.curatorAction.create({ data: { suggestionId: row.id, curatorId: caller.userId, action: input.action, overrideCode: input.overrideCode, criterion: input.criterion, note: input.note, queueWaitMs, createdAt: now }, select: { id: true } });
    return { written: true, actionId: created.id, workflowId: row.workflowId };
  });
}

/**
 * Whether a curator's action of this visit stands (36 § 8): one made since the decision that queued the suggestion,
 * which its workflow records before anything else. A suggestion with no decision's time has no visit to count in.
 */
async function actionStands(tx: Rows, row: { readonly id: string; readonly decidedAt: Date | null }): Promise<boolean> {
  return row.decidedAt !== null && (await tx.curatorAction.count({ where: { suggestionId: row.id, seeded: false, createdAt: { gte: row.decidedAt } } })) > 0;
}

/** A contributor's request to withdraw, as written (45 § 5.2): the decision it was made against; or where the suggestion is, null for none of theirs. */
export type WithdrawalRequested = { readonly requested: true; readonly at: Date; readonly decidedAt: Date | null } | { readonly requested: false; readonly state: SuggestionState | null };

/**
 * A contributor's request to withdraw their own suggestion, written on the row before its workflow is told (feature-specs/45
 * § 5.2; unit 63c): only a person's, only where its workflow waits for a person, while no curator's action of this visit
 * stands, and guarded in the `UPDATE` on the decision it read. The run makes the move. The caller's own request already
 * standing is answered as it stands, with its instant, for the endpoint to send again: a request whose signal never left
 * — the server stopped between the two — is repaired so, and a run that holds it records it once (review of unit 63).
 */
export function requestWithdrawal(caller: UserCaller, id: string, at: Date, client: ImproveClient = getPrisma()): Promise<WithdrawalRequested> {
  return inTransaction(client, async (tx) => {
    const row = await tx.suggestion.findFirst({ where: { id, userId: caller.userId }, select: { id: true, origin: true, state: true, outcome: true, decidedAt: true, withdrawnAt: true } });
    if (row === null) return { requested: false, state: null };
    if (row.origin !== "HUMAN" || !takesWithdrawal(row.state, row.outcome) || (await actionStands(tx, row))) return { requested: false, state: row.state };
    if (row.withdrawnAt !== null) return { requested: true, at: row.withdrawnAt, decidedAt: row.decidedAt };
    const { count } = await tx.suggestion.updateMany({ where: { id, userId: caller.userId, state: row.state, decidedAt: row.decidedAt, withdrawnAt: null }, data: { withdrawnAt: at } });
    return count === 1 ? { requested: true, at, decidedAt: row.decidedAt } : { requested: false, state: row.state };
  });
}

/**
 * A withdrawal's request taken back (45 § 5.2, § 5.3): by its endpoint when the run could not be told, or by the run
 * when the request no longer stands. Only the request of that instant, and never a recorded one: a suggestion its
 * withdrawal closed keeps its `withdrawnAt` (and its own move writes it again, unit 63e). Whether there was one.
 */
export async function takeBackWithdrawal(caller: Caller, id: string, at: Date, client: ImproveClient = getPrisma()): Promise<boolean> {
  if (caller.kind === "service") requireService(caller);
  const mine: Prisma.SuggestionWhereInput = caller.kind === "user" ? { userId: caller.userId } : {};
  const { count } = await client.suggestion.updateMany({ where: { id, withdrawnAt: at, state: { in: [...WITHDRAWABLE_STATES] }, ...mine }, data: { withdrawnAt: null } });
  return count === 1;
}

/**
 * Whether a withdrawal still stands as the run reads it before recording (45 § 5.3; unit 63c): a person's suggestion,
 * the signal's user's, holding the request of that instant, under the decision the request was made against, still
 * where its workflow waits for a person, with no curator's action of this visit. Nothing of the person is returned.
 */
export function withdrawalStands(caller: ServiceCaller, id: string, request: { readonly userId: string; readonly at: Date; readonly decidedAt: Date | null }, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireService(caller);
  return inTransaction(client, async (tx) => {
    const row = await tx.suggestion.findFirst({ where: { id, origin: "HUMAN", userId: request.userId, withdrawnAt: request.at, decidedAt: request.decidedAt }, select: { id: true, state: true, outcome: true, decidedAt: true } });
    return row !== null && takesWithdrawal(row.state, row.outcome) && !(await actionStands(tx, row));
  });
}

/** A curator's merge as the decision endpoint writes it (feature-specs/37 § 5; unit 54c): a note at most, which is text here and its hash in the ledger. */
export interface MergeActionInput {
  readonly suggestionId: string;
  readonly note: string | null;
}

/**
 * The action of a curator's merge (37 § 5; unit 54c): written only while the suggestion is merging and its merge's
 * check passed, in one of the caller's parts and not the caller's own, as a decision's is; once a merge stands since
 * that check, a second is not written. How long it waited counts from the check that made it ready. The merge's
 * workflow, told of it, records it; this writes nothing to the ledger (invariant 17).
 */
export function writeMergeAction(caller: UserCaller, input: MergeActionInput, now: Date = new Date(), client: ImproveClient = getPrisma()): Promise<{ readonly written: true; readonly actionId: string } | { readonly written: false }> {
  if (caller.role !== "CURATOR" || caller.parts.length === 0) return Promise.resolve({ written: false });
  return inTransaction(client, async (tx) => {
    const row = await tx.suggestion.findFirst({ where: { id: input.suggestionId, state: "MERGING", parts: { hasSome: [...caller.parts] }, OR: [{ userId: null }, { userId: { not: caller.userId } }] }, select: { id: true, merge: { select: { check: true, mergedAt: true } } } });
    if (row === null || row.merge === null || row.merge.mergedAt !== null) return { written: false };
    const check = MergeCheckSchema.safeParse(row.merge.check);
    if (!check.success || check.data.stage !== "CHECKED" || check.data.verdict !== "PASSED") return { written: false };
    const readyAt = new Date(check.data.at);
    if ((await tx.curatorAction.count({ where: { suggestionId: row.id, action: "MERGE", seeded: false, createdAt: { gte: readyAt } } })) > 0) return { written: false };
    const created = await tx.curatorAction.create({ data: { suggestionId: row.id, curatorId: caller.userId, action: "MERGE", overrideCode: null, criterion: null, note: input.note, queueWaitMs: Math.max(0, now.getTime() - readyAt.getTime()), createdAt: now }, select: { id: true } });
    return { written: true, actionId: created.id };
  });
}

/**
 * A sampled change that stands (36 § 7.2; unit 54e): the month's verdict of `ACCEPT` on a merged suggestion, written as
 * a curator's action and nothing else — no workflow is told and no record follows, as a seed's decision — in one of
 * the caller's parts, not their own, once since it merged. Its other verdict, a revert, is `createRevert`.
 */
export function writeStandsVerdict(caller: UserCaller, suggestionId: string, note: string | null, now: Date = new Date(), client: ImproveClient = getPrisma()): Promise<{ readonly written: true; readonly actionId: string } | { readonly written: false }> {
  if (caller.role !== "CURATOR" || caller.parts.length === 0) return Promise.resolve({ written: false });
  return inTransaction(client, async (tx) => {
    const row = await tx.suggestion.findFirst({ where: { id: suggestionId, state: "MERGED", parts: { hasSome: [...caller.parts] }, OR: [{ userId: null }, { userId: { not: caller.userId } }] }, select: { id: true, merge: { select: { mergedAt: true, revertedBy: true } } } });
    if (row === null || row.merge === null || row.merge.mergedAt === null || row.merge.revertedBy !== null) return { written: false };
    if ((await tx.curatorAction.count({ where: { suggestionId: row.id, action: { in: ["ACCEPT", "REVERT"] }, seeded: false, createdAt: { gte: row.merge.mergedAt } } })) > 0) return { written: false };
    const created = await tx.curatorAction.create({ data: { suggestionId: row.id, curatorId: caller.userId, action: "ACCEPT", overrideCode: null, criterion: null, note, queueWaitMs: 0, createdAt: now }, select: { id: true } });
    return { written: true, actionId: created.id };
  });
}

/** A merged suggestion's verdict (36 § 7.2; 37 § 8): the curator's `ACCEPT` (stands) or `REVERT` since it merged, with the revert it made; null where none was given. */
export interface MergedVerdict {
  readonly action: "ACCEPT" | "REVERT";
  readonly curatorId: string | null;
  readonly createdAt: Date;
  readonly revertId: string | null;
}

export async function mergedVerdictOf(caller: UserCaller, suggestionId: string, client: ImproveClient = getPrisma()): Promise<MergedVerdict | null> {
  if (caller.role !== "CURATOR") return null;
  const row = await client.suggestion.findFirst({ where: { AND: [{ id: suggestionId, state: "MERGED" }, readableBy(caller)] }, select: { merge: { select: { mergedAt: true, revertedBy: true } } } });
  if (row?.merge?.mergedAt == null) return null;
  const action = await client.curatorAction.findFirst({ where: { suggestionId, action: { in: ["ACCEPT", "REVERT"] }, seeded: false, createdAt: { gte: row.merge.mergedAt } }, select: { action: true, curatorId: true, createdAt: true }, orderBy: { createdAt: "desc" } });
  if (action === null) return null;
  return { action: action.action === "REVERT" ? "REVERT" : "ACCEPT", curatorId: action.curatorId, createdAt: action.createdAt, revertId: row.merge.revertedBy };
}

/** A curator's revert as the decision endpoint writes it (feature-specs/37 § 8; unit 54e): the original, the note, and the revert's own rows, made from the original's as the release reads it now. */
export interface RevertInput {
  readonly originalId: string;
  readonly note: string;
  /** The release the revert starts from, and the chapter's version in it. */
  readonly releaseId: string;
  readonly chapterVersionId: string;
  /** The proposal that undoes the original, or the product's restructure for the curator's hand (lib/improve/revert.ts). */
  readonly proposal: Prisma.InputJsonValue;
  readonly proposalKey: string;
  readonly changeKind: ChangeKind;
  /** The original's anchor as the release reads it now: what the revert's merge holds `main` to (37 § 4.1 step 1). */
  readonly anchor: DraftInput["anchor"];
}

export type RevertWritten = { readonly written: true; readonly revertId: string; readonly actionId: string } | { readonly written: false };

/**
 * A curator's revert of a merged change (37 § 8; unit 54e), in one transaction: the original must be merged, in one of
 * the caller's parts, not their own, and not reverted already or being; the curator's `REVERT` action is written on
 * the original, with the note — which is text here and its hash in the ledger — and counts in precision from then (36
 * § 6.1); the revert is a suggestion of the chapter's next serial, a curator's (`CURATOR`, no contributor), merging
 * from the start, with the original's parts, class and rubric, the undoing proposal and the anchor as it reads now;
 * and the original's merge names it. Its merge, told the action, records the `curator` record on the revert.
 */
export function createRevert(caller: UserCaller, input: RevertInput, now: Date = new Date(), client: ImproveClient = getPrisma()): Promise<RevertWritten> {
  if (caller.role !== "CURATOR" || caller.parts.length === 0) return Promise.resolve({ written: false });
  return inTransaction<RevertWritten>(client, async (tx) => {
    const original = await tx.suggestion.findFirst({
      where: { id: input.originalId, state: "MERGED", parts: { hasSome: [...caller.parts] }, OR: [{ userId: null }, { userId: { not: caller.userId } }] },
      select: { id: true, chapterNumber: true, parts: true, changeClass: true, curatorReason: true, locale: true, rubricVersionId: true, merge: { select: { mergedAt: true, revertedBy: true } } },
    });
    if (original === null || original.merge === null || original.merge.mergedAt === null || original.merge.revertedBy !== null) return { written: false };
    if ((await tx.curatorAction.count({ where: { suggestionId: original.id, action: "REVERT" } })) > 0) return { written: false };
    const counter = await tx.suggestionCounter.upsert({ where: { chapterNumber: original.chapterNumber }, create: { chapterNumber: original.chapterNumber, next: 2 }, update: { next: { increment: 1 } }, select: { next: true } });
    const revert = await tx.suggestion.create({
      data: {
        id: suggestionIdOf(original.chapterNumber, counter.next - 1),
        origin: "CURATOR",
        userId: null,
        chapterNumber: original.chapterNumber,
        chapterVersionId: input.chapterVersionId,
        releaseId: input.releaseId,
        parts: [...original.parts],
        changeKind: input.changeKind,
        changeClass: original.changeClass,
        curatorReason: original.curatorReason,
        proposal: input.proposal,
        proposalKey: input.proposalKey,
        locale: original.locale,
        state: "MERGING",
        outcome: "ACCEPT",
        rubricVersionId: original.rubricVersionId,
        submittedAt: now,
        decidedAt: now,
        anchor: { create: { ...input.anchor } },
      },
      select: { id: true },
    });
    const action = await tx.curatorAction.create({ data: { suggestionId: original.id, curatorId: caller.userId, action: "REVERT", overrideCode: null, criterion: null, note: input.note, queueWaitMs: 0, createdAt: now }, select: { id: true } });
    /* The merge row is claimed on the condition that nobody claimed it: a second curator's transaction, waiting on the first's lock, updates nothing and loses, its rows rolled back (unit 54's review). */
    const claimed = await tx.merge.updateMany({ where: { suggestionId: original.id, revertedBy: null }, data: { revertedBy: revert.id } });
    if (claimed.count !== 1) throw new RevertedAlready();
    return { written: true, revertId: revert.id, actionId: action.id };
  }).catch((error: unknown): RevertWritten => {
    if (error instanceof RevertedAlready) return { written: false };
    throw error;
  });
}

/** The sentinel that rolls a losing revert back: thrown inside the transaction, caught at its door. */
class RevertedAlready extends Error {
  constructor() {
    super("reverted already");
    this.name = "RevertedAlready";
  }
}

/** The suggestion a revert undoes (37 § 8): the one whose merge names the revert; null for a suggestion that is no revert. */
export async function revertOf(caller: ServiceCaller, revertId: string, client: ImproveClient = getPrisma()): Promise<string | null> {
  requireMergeService(caller);
  const original = await client.merge.findFirst({ where: { revertedBy: revertId }, select: { suggestionId: true } });
  return original?.suggestionId ?? null;
}

/**
 * The curator's `REVERT` action a revert carries out (37 § 8; unit 54's review): the one on the suggestion whose merge
 * names the revert, for a merge run started again by `Re-run check`, which records the revert's `curator` record and
 * merges as the first start would. Null for a suggestion that is no revert. The curator's, in their parts.
 */
export async function revertActionOf(caller: UserCaller, revertId: string, client: ImproveClient = getPrisma()): Promise<string | null> {
  if (caller.role !== "CURATOR" || caller.parts.length === 0) return null;
  const original = await client.merge.findFirst({ where: { revertedBy: revertId, suggestion: { parts: { hasSome: [...caller.parts] } } }, select: { suggestionId: true } });
  if (original === null) return null;
  const action = await client.curatorAction.findFirst({ where: { suggestionId: original.suggestionId, action: "REVERT" }, select: { id: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return action?.id ?? null;
}

/** Take back an action its workflow was never told of (36 § 8: the engine unavailable, nothing written): the caller's own, and only while no record names it. */
export function withdrawCuratorAction(caller: UserCaller, actionId: string, client: ImproveClient = getPrisma()): Promise<boolean> {
  return inTransaction(client, async (tx) => {
    if ((await tx.calibrationEvent.count({ where: { curatorActionId: actionId } })) > 0) return false;
    const { count } = await tx.curatorAction.deleteMany({ where: { id: actionId, curatorId: caller.userId } });
    return count === 1;
  });
}

/** A curator's decision as the queue's detail shows it to a curator (36 § 5, § 8): who decided and when, and what; never the note. */
export interface QueueDecisionForCurator {
  readonly actionId: string;
  /** Null after the curator's account is hard-deleted. */
  readonly curatorId: string | null;
  readonly action: CuratorActionKind;
  readonly overrideCode: string | null;
  readonly criterion: string | null;
  readonly createdAt: Date;
  /** The workflow has recorded it: its calibration event, written in the step that appends the record (33 § 6.3), names it. */
  readonly recorded: boolean;
  /** An action of the visit to the queue that is still open: the suggestion is decided, and the workflow is recording it or has just done so. */
  readonly open: boolean;
}

/**
 * The curator's decision on a suggestion the caller curates (36 § 5, § 8): the newest action the workflow recorded, or
 * the open visit's action it is recording. An action never recorded and past its visit — a second curator's, which
 * the workflow dropped (33 § 20) — is passed over. Null for anyone but a curator who may read the suggestion.
 */
export async function queueDecisionOf(caller: UserCaller, suggestionId: string, client: ImproveClient = getPrisma()): Promise<QueueDecisionForCurator | null> {
  if (caller.role !== "CURATOR") return null;
  const row = await client.suggestion.findFirst({ where: { AND: [{ id: suggestionId }, readableBy(caller)] }, select: { state: true, decidedAt: true } });
  if (row === null) return null;
  const actions = await client.curatorAction.findMany({ where: { suggestionId, seeded: false }, select: { id: true, curatorId: true, action: true, overrideCode: true, criterion: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (actions.length === 0) return null;
  const recorded = new Set((await client.calibrationEvent.findMany({ where: { curatorActionId: { in: actions.map((action) => action.id) } }, select: { curatorActionId: true } })).map((event) => event.curatorActionId));
  const openOf = (createdAt: Date): boolean => row.state === "CURATOR_QUEUE" && row.decidedAt !== null && createdAt >= row.decidedAt;
  const shown = actions.find((action) => recorded.has(action.id) || openOf(action.createdAt));
  if (shown === undefined) return null;
  const { id, ...rest } = shown;
  return { actionId: id, ...rest, recorded: recorded.has(id), open: openOf(shown.createdAt) };
}

/** A decision of the caller's as "Decided today" lists it: a seed's under the seed's own id, with the answer and whether it matched (36 § 7.1). */
export interface DecidedToday {
  readonly suggestionId: string;
  readonly action: CuratorActionKind;
  readonly createdAt: Date;
  readonly seed: { readonly answer: CuratorActionKind; readonly matched: boolean } | null;
}

/** What the caller decided since `since` (36 § 3.1, "Decided today"): their own actions, newest first; never anyone else's. A seed's is revealed here, and only after it was decided. */
export async function curatorDecidedSince(caller: UserCaller, since: Date, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<DecidedToday>> {
  if (caller.role !== "CURATOR") return [];
  const actions = await client.curatorAction.findMany({ where: { curatorId: caller.userId, createdAt: { gte: since } }, select: { id: true, suggestionId: true, action: true, createdAt: true, seeded: true, seedMatched: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const seeded = actions.filter((action) => action.seeded).map((action) => action.id);
  const seeds = seeded.length === 0 ? [] : await client.curationSeed.findMany({ where: { actionId: { in: seeded } }, select: { id: true, actionId: true, answer: true } });
  const seedOfAction = new Map(seeds.map((seed) => [seed.actionId, seed]));
  return actions.flatMap((action): DecidedToday[] => {
    if (!action.seeded) return [{ suggestionId: action.suggestionId, action: action.action, createdAt: action.createdAt, seed: null }];
    /* A seed's decision is never listed under the suggestion's own id. */
    const seed = seedOfAction.get(action.id);
    return seed === undefined ? [] : [{ suggestionId: seed.id, action: action.action, createdAt: action.createdAt, seed: { answer: seed.answer, matched: action.seedMatched === true } }];
  });
}

/** How many of the caller's suggestions left draft since `since`: the submissions the daily limit counts, as the form's meta line says them (34 § 6). */
export function submittedSince(caller: UserCaller, since: Date, client: ImproveClient = getPrisma()): Promise<number> {
  return client.suggestion.count({ where: { userId: caller.userId, submittedAt: { gte: since } } });
}

/** The suggestion as an agent's activity reads it: every state, and nobody's name. */
export async function readSuggestionAsService(caller: ServiceCaller, id: string, client: ImproveClient = getPrisma()): Promise<SuggestionForService | null> {
  requireService(caller);
  const suggestion = await client.suggestion.findUnique({ where: { id }, select: SUGGESTION });
  return suggestion === null ? null : { ...suggestion, ...(await partsOf(client, suggestion.id)) };
}

/* ---------------------------------------------------------------- what is written */

/** What a draft is created from: the anchor as resolved against the current release, and the class computed from it. */
export interface DraftInput {
  readonly chapterNumber: number;
  readonly chapterVersionId: string;
  readonly releaseId: string;
  readonly parts: ReadonlyArray<Part>;
  readonly changeKind: ChangeKind;
  readonly changeClass: ChangeClass;
  readonly curatorReason: CuratorReason | null;
  readonly locale: Lang;
  readonly rubricVersionId: string;
  readonly anchor: {
    readonly kind: AnchorKind;
    readonly sectionAnchor: string;
    readonly figureAnchor: string | null;
    readonly sourceRowAnchor: string | null;
    readonly currentText: string;
    readonly contentSha256: string;
    readonly existsAtVersion: boolean;
  };
}

/**
 * A person's draft, with its id (29 § 4.2). The serial is the chapter's next, taken from `SuggestionCounter` in
 * the transaction that creates the draft: the statement that takes it holds the counter's row until that
 * transaction ends, so two drafts on one chapter cannot be given one serial, and a creation that fails gives its
 * serial back. An id is never reused: a deleted draft leaves a gap.
 */
export function createDraft(caller: UserCaller, draft: DraftInput, client: ImproveClient = getPrisma()): Promise<SuggestionForUser> {
  return inTransaction(client, async (tx) => {
    const counter = await tx.suggestionCounter.upsert({
      where: { chapterNumber: draft.chapterNumber },
      create: { chapterNumber: draft.chapterNumber, next: 2 },
      update: { next: { increment: 1 } },
      select: { next: true },
    });
    const suggestion = await tx.suggestion.create({
      data: {
        id: suggestionIdOf(draft.chapterNumber, counter.next - 1),
        origin: "HUMAN",
        userId: caller.userId,
        chapterNumber: draft.chapterNumber,
        chapterVersionId: draft.chapterVersionId,
        releaseId: draft.releaseId,
        parts: [...draft.parts],
        changeKind: draft.changeKind,
        changeClass: draft.changeClass,
        curatorReason: draft.curatorReason,
        locale: draft.locale,
        state: "DRAFT",
        rubricVersionId: draft.rubricVersionId,
        anchor: { create: { ...draft.anchor } },
      },
      select: OWNED_SUGGESTION,
    });
    return { ...suggestion, ...(await partsOf(tx, suggestion.id)) };
  });
}

/* ---------------------------------------------------------------- a contributor's draft from a research finding (feature-specs/48 § 8.2; unit 74) */

/** What a draft from a finding is created from: a draft's input, with the proposal and its key the finding gives, and its `https` sources. */
export interface FindingDraftInput extends DraftInput {
  readonly proposal: Prisma.InputJsonValue;
  readonly proposalKey: string;
  /** The finding's `https` sources, each once, in the reader's order: one pending `LINK` item each, up to the draft's limit. */
  readonly sources: ReadonlyArray<{ readonly url: string; readonly host: string }>;
}

/**
 * A contributor's draft from a research finding (48 § 8.2 step 7), as `createDraft` makes one — the chapter's next
 * serial, origin `HUMAN`, theirs — with the proposal and its key prefilled, `fromResearch` true, and one pending `LINK`
 * item for each of the first `max` sources (`ITEMS_PER_SUGGESTION_MAX`). The rationale is left empty: the researcher's
 * note is never copied into it, since the adjudicator reads a person's rationale and spec 42 keeps the note from it.
 * `fromResearch` is set here and nowhere else: provenance, never credit, and it names no finding and no asker
 * (invariant 35). Runs on the caller's client, the asker's own transaction that claims the finding (lib/db/research.ts
 * `claimFindingForDraft`). Its items' ids, in order, for their gradings.
 */
export function createDraftFromFinding(caller: UserCaller, input: FindingDraftInput, max: number, client: ImproveClient = getPrisma()): Promise<{ readonly id: string; readonly items: ReadonlyArray<string> }> {
  return inTransaction(client, async (tx) => {
    const counter = await tx.suggestionCounter.upsert({
      where: { chapterNumber: input.chapterNumber },
      create: { chapterNumber: input.chapterNumber, next: 2 },
      update: { next: { increment: 1 } },
      select: { next: true },
    });
    const id = suggestionIdOf(input.chapterNumber, counter.next - 1);
    await tx.suggestion.create({
      data: {
        id,
        origin: "HUMAN",
        userId: caller.userId,
        fromResearch: true,
        chapterNumber: input.chapterNumber,
        chapterVersionId: input.chapterVersionId,
        releaseId: input.releaseId,
        parts: [...input.parts],
        changeKind: input.changeKind,
        changeClass: input.changeClass,
        curatorReason: input.curatorReason,
        locale: input.locale,
        state: "DRAFT",
        rubricVersionId: input.rubricVersionId,
        proposal: input.proposal,
        proposalKey: input.proposalKey,
        anchor: { create: { ...input.anchor } },
        evidence: { create: input.sources.slice(0, max).map((source, index) => ({ ordinal: index + 1, kind: "LINK" as const, state: "PENDING" as const, url: source.url, host: source.host })) },
      },
      select: { id: true },
    });
    const items = await tx.evidenceItem.findMany({ where: { suggestionId: id }, orderBy: { ordinal: "asc" }, select: { id: true } });
    return { id, items: items.map((item) => item.id) };
  });
}

/**
 * A live suggestion with this proposal key, of any origin, in any state but `DRAFT` (spec 42 § 4.3's rule, which
 * `createFromResearch` applies; 48 § 8.2 step 6, § 8.5): its id, the oldest, or null. An id only — whether the caller
 * may be told it is `suggestionVisibleTo`'s to say.
 */
export async function liveSuggestionWithKey(caller: Caller, proposalKey: string, client: ImproveClient = getPrisma()): Promise<string | null> {
  void caller;
  const same = await client.suggestion.findFirst({ where: { proposalKey, state: { not: "DRAFT" } }, select: { id: true }, orderBy: { createdAt: "asc" } });
  return same?.id ?? null;
}

/**
 * Whether the caller may be told a suggestion's id as the one their finding doubles (48 § 8.5): their own, or merged
 * and so anyone's (35 D2). A suggestion submitted and not merged is not public; whether they asked the research that
 * proposed it is the research door's to add (`duplicateVisibleTo`), since no row here names an asker.
 */
export async function suggestionVisibleTo(caller: UserCaller, id: string, client: ImproveClient = getPrisma()): Promise<boolean> {
  return (await client.suggestion.count({ where: { id, OR: [{ userId: caller.userId }, { state: "MERGED" }] } })) > 0;
}

/** The caller's own suggestions among some ids, with their states (48 § 8.1): a drafted finding's draft, which the block opens while a draft and on its own page after; one deleted is absent. */
export async function ownSuggestionStates(caller: UserCaller, ids: ReadonlyArray<string>, client: ImproveClient = getPrisma()): Promise<ReadonlyMap<string, SuggestionState>> {
  if (ids.length === 0) return new Map();
  const rows = await client.suggestion.findMany({ where: { id: { in: [...ids] }, userId: caller.userId }, select: { id: true, state: true } });
  return new Map(rows.map((row) => [row.id, row.state]));
}

/* ---------------------------------------------------------------- a researcher's suggestion (feature-specs/42 § 4; unit 59b) */

/** What a valid finding becomes: the anchor as resolved against the release, the class computed from it, the proposal and its key, the note, the sources. */
export interface ResearchSubmission {
  readonly chapterNumber: number;
  readonly chapterVersionId: string;
  readonly releaseId: string;
  readonly parts: ReadonlyArray<Part>;
  readonly changeKind: ChangeKind;
  readonly changeClass: ChangeClass;
  readonly curatorReason: CuratorReason | null;
  readonly locale: Lang;
  readonly rubricVersionId: string;
  readonly anchor: DraftInput["anchor"];
  readonly proposal: Prisma.InputJsonValue;
  readonly proposalKey: string;
  /** The reader agent's note, kept as the rationale: shown to people, never given to the adjudicator (42 § 3, D1). */
  readonly note: string;
  /** The `https` addresses the reader saw (41 § 7), each one evidence item of kind LINK, pending, which the product's own fetcher opens again (42 § 4.2). */
  readonly sources: ReadonlyArray<{ readonly url: string; readonly host: string }>;
  readonly workflowIdOf: (suggestionId: string) => string;
  readonly now: Date;
}

export type ResearchCreated = { readonly created: true; readonly id: string } | { readonly created: false; readonly duplicateOf: string };

/**
 * A researcher's suggestion (42 § 4.1), as `service:researcher`, in one transaction: the serial from the chapter's
 * counter as a person's draft takes it, the row `SUBMITTED` at once with origin `RESEARCHER` and no `userId` — nobody
 * owns it (29 § 3) — its anchor, and one pending `LINK` item per source. The same proposal is not made twice (42 § 4.3):
 * a suggestion with the same key, of any origin and in any state but `DRAFT`, means `DUPLICATE` and nothing is
 * created; the key holds the anchor's content hash, so a changed text opens the question again. Nothing here names the
 * run, the message or the asker: the one reference points the other way, from the asker's own finding (40 § 3).
 */
export function createFromResearch(caller: ServiceCaller, input: ResearchSubmission, client: ImproveClient = getPrisma()): Promise<ResearchCreated> {
  requireService(caller);
  if (caller.id !== "service:researcher") throw new AppError("FORBIDDEN", "a researcher's suggestion is created by service:researcher alone (feature-specs/42 § 4.1)");
  return inTransaction(client, async (tx) => {
    const same = await tx.suggestion.findFirst({ where: { proposalKey: input.proposalKey, state: { not: "DRAFT" } }, select: { id: true }, orderBy: { createdAt: "asc" } });
    if (same !== null) return { created: false, duplicateOf: same.id };
    const counter = await tx.suggestionCounter.upsert({
      where: { chapterNumber: input.chapterNumber },
      create: { chapterNumber: input.chapterNumber, next: 2 },
      update: { next: { increment: 1 } },
      select: { next: true },
    });
    const id = suggestionIdOf(input.chapterNumber, counter.next - 1);
    await tx.suggestion.create({
      data: {
        id,
        origin: "RESEARCHER",
        userId: null,
        chapterNumber: input.chapterNumber,
        chapterVersionId: input.chapterVersionId,
        releaseId: input.releaseId,
        parts: [...input.parts],
        changeKind: input.changeKind,
        changeClass: input.changeClass,
        curatorReason: input.curatorReason,
        locale: input.locale,
        state: "SUBMITTED",
        submittedAt: input.now,
        workflowId: input.workflowIdOf(id),
        rubricVersionId: input.rubricVersionId,
        proposal: input.proposal,
        proposalKey: input.proposalKey,
        rationale: input.note,
        anchor: { create: { ...input.anchor } },
        evidence: { create: input.sources.map((source, index) => ({ ordinal: index + 1, kind: "LINK" as const, state: "PENDING" as const, url: source.url, host: source.host })) },
      },
      select: { id: true },
    });
    return { created: true, id };
  });
}

/**
 * The suggestions an asker's findings name (43 § 5.3; units 59d, 60b), by the ids the asker's own rows gave: suggestions
 * of origin `RESEARCHER` and nothing else, read as a service reads them — no owner, and nothing of the run or the
 * message, which no row of theirs names — with what hangs from them, for the panel's view and the endorse endpoints.
 */
export type ProposalForAsker = SuggestionForService;
/** What the endorse endpoints need of one: where it is, and its workflow. */
export type ProposalPlace = Pick<ProposalForAsker, "id" | "state" | "outcome" | "workflowId">;

export async function readProposalsForAsker(caller: UserCaller, ids: ReadonlyArray<string>, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<ProposalForAsker>> {
  void caller;
  if (ids.length === 0) return [];
  const rows = await client.suggestion.findMany({ where: { id: { in: [...ids] }, origin: "RESEARCHER" }, select: SUGGESTION, orderBy: { id: "asc" } });
  const read: ProposalForAsker[] = [];
  for (const row of rows) read.push({ ...row, ...(await partsOf(client, row.id)) });
  return read;
}

/**
 * The researcher's proposals closed since a moment, across every part (43 § 7.2, D6; unit 60d): the research log's
 * refuted and declined list, a curator's alone, read as a service reads them with what hangs from them. The log is one,
 * and a curator reads it as a curator, not as a part's.
 */
export async function closedResearchProposals(caller: UserCaller, since: Date, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<SuggestionForService>> {
  if (caller.role !== "CURATOR") return [];
  const rows = await client.suggestion.findMany({ where: { origin: "RESEARCHER", state: "CLOSED", closedAt: { gte: since } }, select: SUGGESTION, orderBy: { closedAt: "desc" } });
  const read: SuggestionForService[] = [];
  for (const row of rows) read.push({ ...row, ...(await partsOf(client, row.id)) });
  return read;
}

/**
 * One researcher's proposal a curator reads whatever its parts, once closed (43 § 7.2, D6; unit 60e): the research
 * log's line opens its record and its page. Nobody's own; null for anyone not a curator and for anything else.
 */
export async function readClosedResearchProposal(caller: UserCaller, id: string, client: ImproveClient = getPrisma()): Promise<SuggestionForUser | null> {
  if (caller.role !== "CURATOR") return null;
  const row = await client.suggestion.findFirst({ where: { id, origin: "RESEARCHER", state: "CLOSED" }, select: OWNED_SUGGESTION });
  return row === null ? null : { ...row, ...(await partsOf(client, row.id)) };
}

/** Where a researcher's suggestions stand (42 § 5), as `service:researcher`, by id: the state and the decision, nothing of a person. */
export async function researchSuggestionStates(caller: ServiceCaller, ids: ReadonlyArray<string>, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<{ readonly id: string; readonly state: SuggestionState; readonly outcome: Decision | null }>> {
  requireService(caller);
  if (ids.length === 0) return [];
  return client.suggestion.findMany({ where: { id: { in: [...ids] }, origin: "RESEARCHER" }, select: { id: true, state: true, outcome: true } });
}

/** A deleted draft's items, by id and state, so that a pending one's grading is cancelled (feature-specs/45 § 4). */
export type DraftDeleted = { readonly deleted: true; readonly items: ReadonlyArray<{ readonly id: string; readonly state: EvidenceState }> } | { readonly deleted: false };

/**
 * Delete the caller's own draft, with everything it has, and say which items it had, read in the same transaction.
 * `deleted: false` when there was no such draft of theirs: a suggestion past draft is never deleted.
 */
export function deleteDraft(caller: UserCaller, id: string, client: ImproveClient = getPrisma()): Promise<DraftDeleted> {
  return inTransaction(client, async (tx) => {
    const items = await tx.evidenceItem.findMany({ where: { suggestion: { id, userId: caller.userId, state: "DRAFT" } }, orderBy: { ordinal: "asc" }, select: { id: true, state: true } });
    const { count } = await tx.suggestion.deleteMany({ where: { id, userId: caller.userId, state: "DRAFT" } });
    return count === 1 ? { deleted: true, items } : { deleted: false };
  });
}

/** What may change with a suggestion's state. */
export interface TransitionPatch {
  readonly outcome?: Decision | null;
  readonly score?: number | null;
  readonly workflowId?: string;
  readonly submittedAt?: Date;
  readonly decidedAt?: Date;
  readonly closedAt?: Date;
  /** The reset a budget's wait marked; the decision's move clears what a wait left behind (33 § 7). */
  readonly budgetResetsAt?: null;
  /**
   * A contributor's request to withdraw (feature-specs/45 § 5.3; unit 63e): written again by the withdrawal's own move, so
   * the row follows its record whatever a take-back did meanwhile; cleared by every other move out of a waiting state,
   * since a decision recorded first ends the request.
   */
  readonly withdrawnAt?: Date | null;
}

/**
 * Whether the row moved. When it did not, `state` is where it is now, or null when there is no such suggestion for
 * this caller.
 */
export type Moved = { readonly moved: true; readonly state: SuggestionState } | { readonly moved: false; readonly state: SuggestionState | null };

/**
 * Move a suggestion from `from` to `to`, and only if it is still in `from` (29 § 4.1): the condition is in the
 * `UPDATE`, so an activity that runs twice finds the row already moved, changes nothing, and is told where the row
 * is. The patch is applied with the move or not at all.
 *
 * A person moves only their own suggestion, and only from draft to submitted, which is the one move an endpoint
 * makes on a person's behalf (feature-specs/31 § 6.1); every other move is a workflow's, and only one the table of
 * moves has (`SUGGESTION_MOVES`, 29 § 3.1; unit 50a). A workflow's move out of draft — its catch-up when the
 * endpoint did not get to make the move (31 § 6.1) — holds invariant 25 in its query: a person's suggestion leaves
 * `DRAFT` only with its contributor verified and their consent recorded, so the workflow cannot be first to move a
 * draft whose consent the endpoint is still writing.
 */
export async function transition(caller: Caller, id: string, from: SuggestionState, to: SuggestionState, patch: TransitionPatch = {}, client: ImproveClient = getPrisma()): Promise<Moved> {
  if (caller.kind === "user") {
    if (from !== "DRAFT" || to !== "SUBMITTED") throw new AppError("FORBIDDEN", `a person submits their own draft; ${from} to ${to} is a workflow's move (feature-specs/29 § 4.1).`);
  } else {
    requireService(caller);
    if (!isLegalMove(from, to)) throw new AppError("FORBIDDEN", `${from} to ${to} is not a move a suggestion makes (feature-specs/29 § 3.1).`);
  }
  const mine: Prisma.SuggestionWhereInput = caller.kind === "user" ? { userId: caller.userId } : {};
  const consented: Prisma.SuggestionWhereInput = caller.kind === "service" && from === "DRAFT" ? { user: { identityVerified: true, provenanceConsentAt: { not: null } } } : {};
  const { count } = await client.suggestion.updateMany({ where: { id, state: from, ...mine, ...consented }, data: { ...patch, state: to } });
  if (count === 1) return { moved: true, state: to };
  const now = await client.suggestion.findFirst({ where: { id, ...mine }, select: { state: true } });
  return { moved: false, state: now?.state ?? null };
}

/**
 * A decision's moves in one statement (33 § 6.1; unit 50e): along a path of the table's moves, each checked, from where
 * the suggestion must be to where the decision leaves it, with the patch, and only if it is still where the path
 * starts. The condition is in the `UPDATE`, so an activity that runs again finds the row moved and is told where it is.
 * A service's alone: a person moves nothing but their own draft.
 */
export async function moveAlong(caller: ServiceCaller, id: string, path: ReadonlyArray<SuggestionState>, patch: TransitionPatch = {}, client: ImproveClient = getPrisma()): Promise<Moved> {
  requireService(caller);
  const from = path[0];
  const to = path.at(-1);
  if (from === undefined || to === undefined || path.length < 2) throw new AppError("FORBIDDEN", "a decision moves a suggestion along at least one move (feature-specs/29 § 3.1).");
  path.slice(1).forEach((state, index) => {
    const before = path[index] ?? from;
    if (!isLegalMove(before, state)) throw new AppError("FORBIDDEN", `${before} to ${state} is not a move a suggestion makes (feature-specs/29 § 3.1).`);
  });
  const { count } = await client.suggestion.updateMany({ where: { id, state: from }, data: { ...patch, state: to } });
  if (count === 1) return { moved: true, state: to };
  const now = await client.suggestion.findUnique({ where: { id }, select: { state: true } });
  return { moved: false, state: now?.state ?? null };
}

/** What a draft's owner writes into it (feature-specs/31 § 4): the proposal with its key and the class it makes, and the rationale. */
export interface DraftPatch {
  readonly proposal?: {
    readonly proposal: Prisma.InputJsonValue;
    readonly proposalKey: string;
    readonly changeClass: ChangeClass;
    readonly curatorReason: CuratorReason | null;
  };
  readonly rationale?: string | null;
  /**
   * Graded items whose recency the proposal's fast-moving declaration moved, with their factor and score again
   * (`rescoredOf`; 30 § 3.4): written with the proposal, or not at all.
   */
  readonly rescored?: ReadonlyArray<{ readonly itemId: string; readonly recency: number; readonly adjustedScore: number }>;
}

/**
 * The states a suggestion takes new evidence and a changed rationale in (31 § 6.5): back from intake, or decided
 * or queued with "request more". The anchor and the proposal are never changed there: that is a different suggestion.
 */
export const REVISABLE: Prisma.SuggestionWhereInput = { OR: [{ state: "INTAKE_DECLINED" }, { state: { in: ["DECIDED", "CURATOR_QUEUE"] }, outcome: "REQUEST_MORE" }] };

/**
 * Write into the caller's own draft: the proposal (and the class recomputed from it) and the rationale, on a `DRAFT`
 * only; the rationale alone also on a suggestion open for revision. The row as it then is, or null when there is no
 * such suggestion of the caller's in a state that takes the change: not there, not theirs, and not open, are one
 * answer. Idempotent by content: the same patch twice is the same row. Graded items the proposal re-scored are
 * written in the same transaction, and only once the draft's own write has landed.
 */
export async function updateDraft(caller: UserCaller, id: string, patch: DraftPatch, client: ImproveClient = getPrisma()): Promise<SuggestionForUser | null> {
  const open: Prisma.SuggestionWhereInput = patch.proposal === undefined ? { OR: [{ state: "DRAFT" }, REVISABLE] } : { state: "DRAFT" };
  const data: Prisma.SuggestionUpdateManyMutationInput = {
    ...(patch.rationale === undefined ? {} : { rationale: patch.rationale }),
    ...(patch.proposal === undefined ? {} : { proposal: patch.proposal.proposal, proposalKey: patch.proposal.proposalKey, changeClass: patch.proposal.changeClass, curatorReason: patch.proposal.curatorReason }),
  };
  const written = await inTransaction(client, async (tx) => {
    const { count } = await tx.suggestion.updateMany({ where: { AND: [{ id, userId: caller.userId }, open] }, data });
    if (count !== 1) return false;
    for (const item of patch.rescored ?? []) {
      await tx.evidenceItem.updateMany({ where: { id: item.itemId, suggestionId: id, state: "GRADED" }, data: { recency: item.recency, adjustedScore: item.adjustedScore } });
    }
    return true;
  });
  if (!written) return null;
  return readSuggestion(caller, id, client);
}

/* ---------------------------------------------------------------- evidence items (32 § 8) */

export type EvidenceRow = Prisma.EvidenceItemGetPayload<{ select: typeof EVIDENCE }>;

/** What an item is created from: the id its caller allocated (an upload's ticket id, or a fresh one) and what the contributor gave. */
export interface EvidenceInput {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly url: string | null;
  readonly doi: string | null;
  readonly storageKey: string | null;
  /** A link's host as given; the fetcher writes the final one. */
  readonly host: string | null;
  /** An upload's file name as the browser gave it, for the list and the curator; never the grader's (34 § 25). Absent for every other kind. */
  readonly fileName?: string | null;
}

export type Added = { readonly added: true; readonly item: EvidenceRow; readonly existed: boolean } | { readonly added: false; readonly reason: "not_open" | "limit" };

/**
 * A new item on the caller's own suggestion while it takes evidence — a draft, or one open for revision (31 § 6.5) —
 * with the next ordinal, in one transaction so that two adds cannot share an ordinal or pass the limit together. An
 * id already there is the same item, answered again: the add is idempotent by the id the caller allocated (an
 * upload's ticket), and a retry of a `POST` that timed out creates nothing twice.
 */
export function addEvidenceItem(caller: UserCaller, suggestionId: string, input: EvidenceInput, max: number, client: ImproveClient = getPrisma()): Promise<Added> {
  return inTransaction(client, async (tx) => {
    const open = await tx.suggestion.findFirst({ where: { AND: [{ id: suggestionId, userId: caller.userId }, { OR: [{ state: "DRAFT" }, REVISABLE] }] }, select: { id: true } });
    if (open === null) return { added: false, reason: "not_open" };
    const existing = await tx.evidenceItem.findFirst({ where: { id: input.id, suggestionId }, select: EVIDENCE });
    if (existing !== null) return { added: true, item: existing, existed: true };
    const count = await tx.evidenceItem.count({ where: { suggestionId } });
    if (count >= max) return { added: false, reason: "limit" };
    const last = await tx.evidenceItem.aggregate({ where: { suggestionId }, _max: { ordinal: true } });
    const item = await tx.evidenceItem.create({
      data: { id: input.id, suggestionId, ordinal: (last._max.ordinal ?? 0) + 1, kind: input.kind, state: "PENDING", url: input.url, doi: input.doi, storageKey: input.storageKey, host: input.host, fileName: input.fileName ?? null },
      select: EVIDENCE,
    });
    return { added: true, item, existed: false };
  });
}

export type Removed = { readonly removed: true; readonly state: EvidenceState } | { readonly removed: false };

/** Remove an item of the caller's own suggestion while it takes evidence; what state the item was in says whether a workflow is to be cancelled. */
export function removeEvidenceItem(caller: UserCaller, suggestionId: string, itemId: string, client: ImproveClient = getPrisma()): Promise<Removed> {
  return inTransaction(client, async (tx) => {
    const open = await tx.suggestion.findFirst({ where: { AND: [{ id: suggestionId, userId: caller.userId }, { OR: [{ state: "DRAFT" }, REVISABLE] }] }, select: { id: true } });
    if (open === null) return { removed: false };
    const item = await tx.evidenceItem.findFirst({ where: { id: itemId, suggestionId }, select: { state: true } });
    if (item === null) return { removed: false };
    await tx.evidenceItem.delete({ where: { id: itemId } });
    return { removed: true, state: item.state };
  });
}

/** An item as a grading activity reads it: with its suggestion, every state, and nobody's name (invariant 12). */
export interface EvidenceForService {
  readonly item: EvidenceRow;
  readonly suggestion: SuggestionForService;
}

export async function readEvidenceAsService(caller: ServiceCaller, itemId: string, client: ImproveClient = getPrisma()): Promise<EvidenceForService | null> {
  requireService(caller);
  const owner = await client.evidenceItem.findUnique({ where: { id: itemId }, select: { suggestionId: true } });
  if (owner === null) return null;
  const item = await client.evidenceItem.findUnique({ where: { id: itemId }, select: EVIDENCE });
  const suggestion = await readSuggestionAsService(caller, owner.suggestionId, client);
  if (item === null || suggestion === null) return null;
  return { item, suggestion };
}

/**
 * The suggestion an evidence item belongs to, as its id and nothing more, read as the grader (feature-specs/49 § 7.2):
 * the trace a grade's activities take is the suggestion's, and the grade's workflow id names only the item. Null for an
 * item that is gone.
 */
export async function suggestionOfEvidenceItem(caller: ServiceCaller, itemId: string, client: ImproveClient = getPrisma()): Promise<string | null> {
  requireService(caller);
  if (caller.id !== "service:grader") throw new AppError("FORBIDDEN", "only the grader's activities read whose suggestion an item is by the item alone (feature-specs/49 § 7.2).");
  const row = await client.evidenceItem.findUnique({ where: { id: itemId }, select: { suggestionId: true } });
  return row?.suggestionId ?? null;
}

/**
 * Whose suggestion it is, as an id and nothing more, for three services. The grading activity (32 § 7.4, § 8): the
 * grade is charged to the contributor's principal and independence compares their verified address with the
 * publisher's domain, both of which `lib/db/account.ts` reads from the id. The intake activity (33 § 3, step 1;
 * Andre, 2026-10-06): the `submitted` record is signed with the contributor's pseudonym, `user:` and this id. The
 * adjudication activity (33 § 7; unit 50d): its call is charged to the contributor's principal, as the grade is. The
 * id is a uuid, never a name, and goes to no prompt; a service's read of the suggestion itself still carries no such
 * column (invariant 12). Null for a researcher's suggestion, which has no contributor, and for one whose
 * contributor's account is gone.
 */
export async function contributorIdOf(caller: ServiceCaller, suggestionId: string, client: ImproveClient = getPrisma()): Promise<string | null> {
  requireService(caller);
  if (caller.id !== "service:grader" && caller.id !== "service:intake" && caller.id !== "service:adjudicator") throw new AppError("FORBIDDEN", "only the grading, the intake and the adjudication activities are told whose suggestion it is (feature-specs/32 § 7.4, 33 § 3, § 7).");
  const row = await client.suggestion.findUnique({ where: { id: suggestionId }, select: { userId: true } });
  return row?.userId ?? null;
}

/** What the fetch left on a pending item (32 § 4.4): where it ended and what it found, before any grade. */
export interface FetchedFacts {
  readonly fetchStatus: string;
  readonly url?: string | null;
  readonly host: string | null;
  readonly title: string | null;
  readonly publishedOn: Date | null;
  readonly contentSha256: string | null;
  readonly textKey?: string | null;
}

/** The fetch's facts on an item still pending; false when the item is not pending or not there. */
export async function writeEvidenceFetched(caller: ServiceCaller, itemId: string, facts: FetchedFacts, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireService(caller);
  const { count } = await client.evidenceItem.updateMany({ where: { id: itemId, state: "PENDING" }, data: { fetchStatus: facts.fetchStatus, host: facts.host, title: facts.title, publishedOn: facts.publishedOn, contentSha256: facts.contentSha256, ...(facts.url === undefined ? {} : { url: facts.url }), ...(facts.textKey === undefined ? {} : { textKey: facts.textKey }) } });
  return count === 1;
}

/** The grade (32 § 7.2 as code made it, or `U` by intake rules): the item becomes `GRADED` once, and only from pending. */
export interface GradeFacts {
  readonly tier: EvidenceTier;
  readonly baseScore: number;
  readonly relevance: number | null;
  readonly recency: number | null;
  readonly independence: number | null;
  readonly adjustedScore: number;
  readonly reason: string;
  readonly gradedBy: string;
  readonly gradedAt: Date;
  readonly publishedOn: Date | null;
  readonly ageDays: number | null;
  readonly textKey?: string | null;
  readonly contentSha256?: string | null;
}

export async function writeEvidenceGraded(caller: ServiceCaller, itemId: string, facts: GradeFacts, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireService(caller);
  const { count } = await client.evidenceItem.updateMany({
    where: { id: itemId, state: "PENDING" },
    data: {
      state: "GRADED",
      tier: facts.tier,
      baseScore: facts.baseScore,
      relevance: facts.relevance,
      recency: facts.recency,
      independence: facts.independence,
      adjustedScore: facts.adjustedScore,
      reason: facts.reason,
      gradedBy: facts.gradedBy,
      gradedAt: facts.gradedAt,
      publishedOn: facts.publishedOn,
      ageDays: facts.ageDays,
      ...(facts.textKey === undefined ? {} : { textKey: facts.textKey }),
      ...(facts.contentSha256 === undefined ? {} : { contentSha256: facts.contentSha256 }),
    },
  });
  return count === 1;
}

/** Where the text the grader will read is kept (32 § 5), on a pending item. */
export async function writeEvidenceTextKey(caller: ServiceCaller, itemId: string, textKey: string, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireService(caller);
  const { count } = await client.evidenceItem.updateMany({ where: { id: itemId, state: "PENDING" }, data: { textKey } });
  return count === 1;
}

/** Why a pending item waits (32 § 8: the principal's cap, with the reset date), on its reason until it is graded. */
export async function writeEvidencePending(caller: ServiceCaller, itemId: string, reason: string, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireService(caller);
  const { count } = await client.evidenceItem.updateMany({ where: { id: itemId, state: "PENDING" }, data: { reason } });
  return count === 1;
}

/* ---------------------------------------------------------------- the suggestion workflow's steps (33 § 3) */

/** A sensor's verdict as its row holds it: the result, and the detail and data that stay in the row (28 § 5.3). */
export interface SensorVerdictInput {
  readonly sensor: SuggestionSensor;
  readonly result: SensorResult;
  readonly detail: string;
  readonly data: Prisma.InputJsonValue;
}

/**
 * The verdicts of a step's sensors on a submitted suggestion (33 § 3, step 2), one row a sensor, written over the
 * row a sensor had: a revision's attempt runs the sensors again, and the row says how they answered last. False when
 * the suggestion is not `SUBMITTED`: a step's verdicts are written while it is the step the suggestion is at.
 */
export function writeSensorVerdicts(caller: ServiceCaller, suggestionId: string, verdicts: ReadonlyArray<SensorVerdictInput>, at: Date, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireService(caller);
  return inTransaction(client, async (tx) => {
    const open = await tx.suggestion.findFirst({ where: { id: suggestionId, state: "SUBMITTED" }, select: { id: true } });
    if (open === null) return false;
    for (const verdict of verdicts) {
      const row = { result: verdict.result, detail: verdict.detail, data: verdict.data, createdAt: at };
      await tx.suggestionSensorVerdict.upsert({ where: { suggestionId_sensor: { suggestionId, sensor: verdict.sensor } }, create: { suggestionId, sensor: verdict.sensor, ...row }, update: row });
    }
    return true;
  });
}

/**
 * The suggestion's score as step 3 computes it from the rows (33 § 3.3), on a submitted suggestion, with no move:
 * the states are the decision's (unit 50e). False when the suggestion is not `SUBMITTED`.
 */
export async function writeSuggestionScore(caller: ServiceCaller, suggestionId: string, score: number, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireService(caller);
  const { count } = await client.suggestion.updateMany({ where: { id: suggestionId, state: "SUBMITTED" }, data: { score } });
  return count === 1;
}

/**
 * A submitted suggestion's parts widened by the parts the cross-chapter sensor found reading its anchor (33 § 4.2), so
 * those parts' curators see it (36 § 3); a part already there is kept once. False when the suggestion is not
 * `SUBMITTED`.
 */
export async function widenParts(caller: ServiceCaller, suggestionId: string, parts: ReadonlyArray<Part>, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireService(caller);
  return inTransaction(client, async (tx) => {
    const row = await tx.suggestion.findFirst({ where: { id: suggestionId, state: "SUBMITTED" }, select: { parts: true } });
    if (row === null) return false;
    const widened = [...new Set([...row.parts, ...parts])];
    if (widened.length > row.parts.length) await tx.suggestion.update({ where: { id: suggestionId }, data: { parts: widened } });
    return true;
  });
}

/** A decision as its row holds it (29 § 3; 33 § 5): who decided, the score against the class's thresholds, and for the adjudicator its guide, its model, its prompt and its failure. */
export interface AdjudicationInput {
  readonly decision: Decision;
  readonly decidedBy: Decider;
  readonly score: number;
  readonly acceptAt: number | null;
  readonly floorAt: number | null;
  readonly sufficientTier: EvidenceTier | null;
  readonly failingSensor: SuggestionSensor | null;
  readonly guideVersion: string | null;
  readonly guideSha256: string | null;
  readonly modelId: string | null;
  readonly promptSha256: string | null;
  /** The adjudicator's one failure, named, with the decision `CURATOR_REVIEW`; null when it decided. */
  readonly failure: string | null;
  readonly rubricVersionId: string;
  readonly decidedAt: Date;
  readonly traceId: string;
}

/** One criterion's line: its verdict, a value (`C`, `66<70`), and a reason of at most 30 words. */
export interface CriterionInput {
  readonly criterion: Criterion;
  readonly verdict: string;
  readonly reason: string;
}

/**
 * A suggestion's decision and its criteria (33 § 5, § 6.4), written over the ones it had in one transaction: the rows
 * hold the latest decision, the ledger every one. The first write of an attempt's trace id stands: a second write
 * under the same id — an adjudication that outlived its timeout, after the workflow recorded its failure — changes
 * nothing. Written by the two deciders the `decided` record names — the adjudicator, and the intake rules (50e) — on
 * a suggestion still `SUBMITTED`, the step a decision is made at; false when it is not, true when the attempt's row
 * stands, whoever wrote it.
 */
export function writeAdjudication(caller: ServiceCaller, suggestionId: string, adjudication: AdjudicationInput, criteria: ReadonlyArray<CriterionInput>, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireService(caller);
  if (caller.id !== "service:adjudicator" && caller.id !== "service:intake") throw new AppError("FORBIDDEN", "a decision is written by the adjudicator or by the intake rules (feature-specs/29 § 5, 33 § 5).");
  return inTransaction(client, async (tx) => {
    const open = await tx.suggestion.findFirst({ where: { id: suggestionId, state: "SUBMITTED" }, select: { id: true } });
    if (open === null) return false;
    /* Two statements that two writers of one trace cannot both get through: an update of another attempt's row, which
       waits on a row another writer holds and then finds it of this trace; or an insert that a row already there, or
       being written, turns into nothing. */
    const replaced = await tx.adjudication.updateMany({ where: { suggestionId, traceId: { not: adjudication.traceId } }, data: adjudication });
    const created = replaced.count === 1 ? 1 : (await tx.adjudication.createMany({ data: [{ suggestionId, ...adjudication }], skipDuplicates: true })).count;
    if (created === 0) return true;
    await tx.criterionVerdict.deleteMany({ where: { suggestionId } });
    if (criteria.length > 0) await tx.criterionVerdict.createMany({ data: criteria.map((line) => ({ suggestionId, ...line })) });
    return true;
  });
}

/**
 * A decision with no row of its own — the router's (33 § 19) — takes away the rows of an earlier attempt's, so that
 * the rows hold the latest decision and the ledger every one (§ 6.4). The intake service's, on a suggestion still
 * `SUBMITTED`; false when it is not.
 */
export function clearAdjudication(caller: ServiceCaller, suggestionId: string, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireService(caller);
  if (caller.id !== "service:intake") throw new AppError("FORBIDDEN", "the router's decision clears an earlier one's rows (feature-specs/33 § 20).");
  return inTransaction(client, async (tx) => {
    const open = await tx.suggestion.findFirst({ where: { id: suggestionId, state: "SUBMITTED" }, select: { id: true } });
    if (open === null) return false;
    await tx.criterionVerdict.deleteMany({ where: { suggestionId } });
    await tx.adjudication.deleteMany({ where: { suggestionId } });
    return true;
  });
}

/**
 * A revision's return to `SUBMITTED` (31 § 6.5; 33 § 6.4; unit 50e): from `INTAKE_DECLINED`, or from `DECIDED` or
 * `CURATOR_QUEUE` with outcome `REQUEST_MORE` — the states that take new evidence (`REVISABLE`), the condition in the
 * `UPDATE`, each a move the table has. A service's alone: the person's submit signals the workflow, which moves it.
 */
export async function reopenSuggestion(caller: ServiceCaller, id: string, client: ImproveClient = getPrisma()): Promise<Moved> {
  requireService(caller);
  /* a revision taken ends a withdrawal's request, should one stand (45 § 5.3): the run took the withdrawal first and found it no longer stood */
  const { count } = await client.suggestion.updateMany({ where: { AND: [{ id }, REVISABLE] }, data: { state: "SUBMITTED", withdrawnAt: null } });
  if (count === 1) return { moved: true, state: "SUBMITTED" };
  const now = await client.suggestion.findUnique({ where: { id }, select: { state: true } });
  return { moved: false, state: now?.state ?? null };
}

/**
 * How many of a contributor's suggestions were declined since `since` with every item graded `U` (33 § 7; unit 50f):
 * the throttle's count, as a number and never the rows, so the activity learns of the contributor's other suggestions
 * nothing but how many. A suggestion with no item, or one still pending, has nothing graded `U` and is not counted.
 * The intake service's alone.
 */
export function unverifiableDeclinesOf(caller: ServiceCaller, userId: string, since: Date, client: ImproveClient = getPrisma()): Promise<number> {
  requireService(caller);
  if (caller.id !== "service:intake") throw new AppError("FORBIDDEN", "the throttle's count is the workflow's (feature-specs/33 § 7).");
  return client.suggestion.count({ where: unverifiableDeclines(userId, since) });
}

/** The throttle's condition, one for the workflow's count and the person's own (`ownUnverifiableDeclines`). */
function unverifiableDeclines(userId: string, since: Date): Prisma.SuggestionWhereInput {
  return { userId, origin: "HUMAN", outcome: "DECLINE", decidedAt: { gte: since }, evidence: { some: {}, every: { tier: "U" } } };
}

/**
 * The reset a submitted suggestion's run sleeps until at a budget cap, or null once it wakes (33 § 7; unit 50f): what
 * the suggestion says where its state is shown, `waiting for budget · resets 01 Nov`. False when it is not submitted.
 */
export async function writeBudgetWait(caller: ServiceCaller, suggestionId: string, resetsAt: Date | null, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireService(caller);
  const { count } = await client.suggestion.updateMany({ where: { id: suggestionId, state: "SUBMITTED" }, data: { budgetResetsAt: resetsAt } });
  return count === 1;
}

/* ---------------------------------------------------------------- a curator's decision (33 § 6.3) */

const CURATOR_ACTION = { id: true, suggestionId: true, curatorId: true, action: true, overrideCode: true, criterion: true, note: true, seeded: true, seedMatched: true, queueWaitMs: true, createdAt: true } as const satisfies Prisma.CuratorActionSelect;

/** A curator's action as the workflow records it: the note as its hash, and who acted as an id. */
export interface CuratorActionForService {
  readonly id: string;
  readonly suggestionId: string;
  /** Null once the curator's account is gone; the ledger keeps the pseudonym. */
  readonly curatorId: string | null;
  readonly action: CuratorActionKind;
  readonly overrideCode: string | null;
  readonly criterion: string | null;
  readonly noteSha256: string | null;
  readonly seeded: boolean;
  readonly seedMatched: boolean | null;
  readonly queueWaitMs: number;
  readonly createdAt: Date;
}

/**
 * The action the decision endpoint wrote (36 § 5.1 step 4), for the workflow that records it (33 § 6.3; unit 50e): the
 * intake service's alone. The note leaves the door as its hash, the only form the `curator` record keeps (29 § 5), and
 * who acted as an id, which signs that record with the curator's pseudonym.
 */
export async function readCuratorAction(caller: ServiceCaller, actionId: string, client: ImproveClient = getPrisma()): Promise<CuratorActionForService | null> {
  requireService(caller);
  /* the suggestion's workflow records a decision; the merge's, a curator's merge (37 § 5; unit 54c) */
  if (caller.id !== "service:intake" && caller.id !== "service:merge") throw new AppError("FORBIDDEN", "a curator's action is read by the workflow that records it (feature-specs/33 § 6.3).");
  const row = await client.curatorAction.findUnique({ where: { id: actionId }, select: CURATOR_ACTION });
  if (row === null) return null;
  const { note, queueWaitMs, ...rest } = row;
  return { ...rest, queueWaitMs: Number(queueWaitMs), noteSha256: note === null ? null : sha256Hex(note) };
}

/** What the adjudicator or the rules said beside what the curator did (36 § 6), from one action. */
export interface CalibrationEventInput {
  readonly suggestionId: string;
  readonly curatorActionId: string;
  readonly criterion: string | null;
  /** The adjudicator's decision and the score it saw; null where no adjudicator decided (a curator-always change, a rule, its failure). */
  readonly adjudicatorDecision: Decision | null;
  readonly adjudicatorScore: number | null;
  readonly curatorAction: CuratorActionKind;
  readonly overrideCode: string | null;
  readonly seeded: boolean;
  readonly rubricVersionId: string;
  /** The step's own clock, so the quarter a rubric review counts in is the one the event is in (36 § 6.3); the database's when absent. */
  readonly createdAt?: Date;
}

/** The calibration event of a curator's action (invariant 17), written once for the action however often its step runs. */
export async function writeCalibrationEvent(caller: ServiceCaller, event: CalibrationEventInput, client: ImproveClient = getPrisma()): Promise<void> {
  requireService(caller);
  if (caller.id !== "service:intake") throw new AppError("FORBIDDEN", "a calibration event is written by the workflow that records the curator's decision (invariant 17).");
  await client.calibrationEvent.createMany({ data: [event], skipDuplicates: true });
}

/* ---------------------------------------------------------------- calibration (feature-specs/36 § 6) */

/*
 * What the three measures are taken over, and the rubric reviews they open. A curator reads them as the metrics'
 * aggregates (36 § 6.2): no row names anyone. The workflow's step that writes an event reads them to open a review
 * (§ 6.3), and only that step: `service:intake`, as it writes the event. Anyone else reads nothing.
 */
const readsCalibration = (caller: Caller): boolean => {
  if (caller.kind === "user") return caller.role === "CURATOR";
  requireService(caller);
  if (caller.id !== "service:intake") throw new AppError("FORBIDDEN", "calibration is read by a curator and by the workflow that records a curator's decision (feature-specs/36 § 6).");
  return true;
};

/** A calibration event as the measures read it (`lib/improve/calibration.ts`), with its suggestion's origin and when it was written. */
export interface CalibrationEventRow {
  readonly criterion: string | null;
  readonly adjudicatorDecision: Decision | null;
  readonly curatorAction: CuratorActionKind;
  readonly seeded: boolean;
  readonly origin: SuggestionOrigin;
  readonly createdAt: Date;
}

/** The events written from `from` to `to`, `to` excluded: seeds and all, which the measures leave out themselves. Empty for anyone but a curator. */
export async function calibrationEventsBetween(caller: Caller, from: Date, to: Date, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<CalibrationEventRow>> {
  if (!readsCalibration(caller)) return [];
  const rows = await client.calibrationEvent.findMany({
    where: { createdAt: { gte: from, lt: to } },
    select: { criterion: true, adjudicatorDecision: true, curatorAction: true, seeded: true, createdAt: true, suggestion: { select: { origin: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(({ suggestion, ...row }) => ({ ...row, origin: suggestion.origin }));
}

/** An accept of the adjudicator's, when it was made, and whether a curator has since reverted the suggestion (spec 37 § 8). */
export interface AdjudicatorAcceptRow {
  readonly origin: SuggestionOrigin;
  readonly decidedAt: Date;
  readonly reverted: boolean;
}

/** The adjudicator's accepts decided from `from` to `to`, `to` excluded: precision's denominator (36 § 6.1). Empty for anyone but a curator. */
export async function adjudicatorAcceptsBetween(caller: Caller, from: Date, to: Date, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<AdjudicatorAcceptRow>> {
  if (!readsCalibration(caller)) return [];
  const rows = await client.adjudication.findMany({
    where: { decision: "ACCEPT", decidedBy: "adjudicator", decidedAt: { gte: from, lt: to } },
    select: { decidedAt: true, suggestion: { select: { origin: true, curatorActions: { where: { action: "REVERT" }, select: { id: true }, take: 1 } } } },
    orderBy: [{ decidedAt: "asc" }, { suggestionId: "asc" }],
  });
  return rows.map((row) => ({ origin: row.suggestion.origin, decidedAt: row.decidedAt, reverted: row.suggestion.curatorActions.length > 0 }));
}

/** A rubric review as the rail names it (36 § 6.3): its id, its criterion and quarter, and the rate that opened it. */
export interface RubricReviewRow {
  readonly id: string;
  readonly criterion: string;
  readonly quarter: string;
  readonly rate: number;
  readonly overridden: number;
  readonly reviewed: number;
  readonly openedAt: Date;
}

const RUBRIC_REVIEW = { id: true, criterion: true, quarter: true, rate: true, overridden: true, reviewed: true, openedAt: true } as const satisfies Prisma.RubricReviewSelect;

/** The reviews opened in the quarters named (`2026-Q4`). Empty for anyone but a curator. */
export async function rubricReviewsIn(caller: Caller, quarters: ReadonlyArray<string>, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<RubricReviewRow>> {
  if (!readsCalibration(caller) || quarters.length === 0) return [];
  return client.rubricReview.findMany({ where: { quarter: { in: [...quarters] } }, select: RUBRIC_REVIEW, orderBy: [{ openedAt: "asc" }, { id: "asc" }] });
}

export interface RubricReviewInput {
  readonly criterion: string;
  readonly quarter: string;
  readonly rubricVersionId: string;
  readonly rate: number;
  readonly overridden: number;
  readonly reviewed: number;
}

/** `R-<rubric version>-<serial>`, four digits: R-1.2-0007 for v1.2's seventh. */
export const rubricReviewIdOf = (rubricVersionId: string, serial: number): string => `R-${rubricVersionId.replace(/^v/, "")}-${String(serial).padStart(4, "0")}`;

/**
 * A rubric review due (36 § 6.3), opened by the step that wrote the event which took the rate past the line: one per
 * criterion and quarter, so a step run again, or another event the same quarter, opens none twice — the one there is
 * answered. Its serial is the rubric version's next; two reviews opened at once for two criteria take two, the one
 * that finds its serial taken trying the next.
 */
export async function openRubricReview(caller: ServiceCaller, input: RubricReviewInput, client: ImproveClient = getPrisma()): Promise<{ readonly id: string; readonly opened: boolean }> {
  requireService(caller);
  if (caller.id !== "service:intake") throw new AppError("FORBIDDEN", "a rubric review is opened by the workflow that writes the calibration event (feature-specs/36 § 6.3).");
  for (let attempt = 0; ; attempt += 1) {
    const there = await client.rubricReview.findUnique({ where: { criterion_quarter: { criterion: input.criterion, quarter: input.quarter } }, select: { id: true } });
    if (there !== null) return { id: there.id, opened: false };
    const serial = (await client.rubricReview.count({ where: { rubricVersionId: input.rubricVersionId } })) + 1;
    try {
      const created = await client.rubricReview.create({ data: { id: rubricReviewIdOf(input.rubricVersionId, serial), ...input }, select: { id: true } });
      return { id: created.id, opened: true };
    } catch (error: unknown) {
      /* A serial, or this criterion and quarter, taken meanwhile: read again; the loop answers the one there. */
      if (!isUniqueViolation(error) || attempt >= 4) throw error;
    }
  }
}

/* ---------------------------------------------------------------- the merge (feature-specs/37 § 4) */

function requireMergeService(caller: ServiceCaller): void {
  requireService(caller);
  if (caller.id !== "service:merge") throw new AppError("FORBIDDEN", "a merge's row is written by the merge's activities alone (feature-specs/37 § 3).");
}

/** The suggestion's merge, or null before its merge began (unit 54b). */
export async function readMerge(caller: ServiceCaller, suggestionId: string, client: ImproveClient = getPrisma()): Promise<MergeRow | null> {
  requireMergeService(caller);
  return client.merge.findUnique({ where: { suggestionId }, select: MERGE });
}

/** What a merge's preparation writes (37 § 4.1, § 4.2): the branch, the product's commit or none yet, the versions and releases it starts from, and where it stands. */
export interface MergeInput {
  readonly branch: string;
  readonly commitSha: string | null;
  readonly versionFrom: string;
  readonly bump: string;
  readonly releaseFrom: string;
  readonly check: Prisma.InputJsonValue;
}

/** A merge's row, made or written over by each preparation (unit 54b): `service:merge`'s alone. */
export async function writeMerge(caller: ServiceCaller, suggestionId: string, input: MergeInput, client: ImproveClient = getPrisma()): Promise<void> {
  requireMergeService(caller);
  await client.merge.upsert({ where: { suggestionId }, create: { suggestionId, ...input }, update: { ...input } });
}

/**
 * The release a merge makes and the version it gives the chapter (37 § 5 steps 1 and 3; unit 54c), written before the
 * changelog's line and the tag that carry them, so that a step run again makes the same.
 */
export async function writeMergeRelease(caller: ServiceCaller, suggestionId: string, input: { readonly releaseTo: string; readonly versionTo: string }, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireMergeService(caller);
  const { count } = await client.merge.updateMany({ where: { suggestionId, mergedAt: null }, data: { releaseTo: input.releaseTo, versionTo: input.versionTo } });
  return count === 1;
}

/** A merge done (37 § 5 step 7; unit 54c): the commit `main` and the release's tag hold, the version the release gave the chapter, and when. */
export async function writeMergeDone(caller: ServiceCaller, suggestionId: string, input: { readonly commitSha: string; readonly versionTo: string; readonly mergedAt: Date }, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireMergeService(caller);
  const { count } = await client.merge.updateMany({ where: { suggestionId }, data: { commitSha: input.commitSha, versionTo: input.versionTo, mergedAt: input.mergedAt } });
  return count === 1;
}

/** A check's result on the merge's row (37 § 4.4): where it stands, the bump the branch makes, and the commit checked. False when the merge has no row. */
export async function writeMergeCheck(caller: ServiceCaller, suggestionId: string, check: Prisma.InputJsonValue, patch: { readonly bump?: string; readonly commitSha?: string } = {}, client: ImproveClient = getPrisma()): Promise<boolean> {
  requireMergeService(caller);
  const { count } = await client.merge.updateMany({ where: { suggestionId }, data: { check, ...patch } });
  return count === 1;
}

/* ---------------------------------------------------------------- the curator roster */

/*
 * These two take no caller. The first is how a caller comes to have parts at all: it is read for a session, before
 * anything is asked of a suggestion. The second is the operator's (`npm run roster:set`, 29 § 6.3): no screen and no
 * endpoint edits the roster, and no role of the product may. The development sign-in is the one other caller, for a
 * development curator, and only where it is switched on (29 § 17).
 */

/**
 * The parts a person curates at `at` (29 § 6.1): the roster's rows for them that have begun and have not ended. A
 * roster change is a row, never part of the policy bundle, so it takes effect on the next request.
 */
export async function currentParts(userId: string, at: Date = new Date(), client: ImproveClient = getPrisma()): Promise<ReadonlyArray<Part>> {
  const rows = await client.curatorRoster.findMany({ where: { userId, since: { lte: at }, OR: [{ until: null }, { until: { gt: at } }] }, select: { part: true }, orderBy: { part: "asc" } });
  return rows.map((row) => row.part);
}

/**
 * The curators of each of `parts` at `at`, as ids by part (36 § 4's routing sentence: `Routed to Part I (H. Okafor)`),
 * earliest on the roster first. The roster is public (spec 38 § 5), so this takes no caller either.
 */
export function curatorsOfParts(parts: ReadonlyArray<Part>, at: Date = new Date(), client: ImproveClient = getPrisma()): Promise<ReadonlyArray<{ readonly part: Part; readonly userId: string }>> {
  if (parts.length === 0) return Promise.resolve([]);
  return client.curatorRoster.findMany({ where: { part: { in: [...parts] }, since: { lte: at }, OR: [{ until: null }, { until: { gt: at } }] }, select: { part: true, userId: true }, orderBy: [{ part: "asc" }, { since: "asc" }, { userId: "asc" }] });
}

/**
 * The queue's open count for each of some parts (feature-specs/38 § 4; unit 55c): what waits in `CURATOR_QUEUE`
 * with the part among its parts — a shared item counted in each, one being withdrawn in none (review of unit 63) — a
 * count of the queue by part and never by person (invariant 26). It takes no caller, as `curatorsOfParts` does: the
 * roster panel is every account's.
 */
export async function queueCountByPart(parts: ReadonlyArray<Part>, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<{ readonly part: Part; readonly count: number }>> {
  if (parts.length === 0) return [];
  const rows = await client.suggestion.findMany({ where: { state: "CURATOR_QUEUE", withdrawnAt: null, parts: { hasSome: [...parts] } }, select: { parts: true } });
  return parts.map((part) => ({ part, count: rows.filter((row) => row.parts.includes(part)).length }));
}

/**
 * The ids of some people's suggestions, every state (feature-specs/38 § 3; unit 55b): an audit pack's account scope is
 * the records about the account's own suggestions, and an organisation's its members' (38 D1). The people are the
 * caller's own account or the organisation the caller administers, which the endpoint's policy decided; this is a list
 * of ids and no count by person (invariant 26). Drafts have no record and are left out.
 */
export async function suggestionIdsOf(userIds: ReadonlyArray<string>, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<string>> {
  if (userIds.length === 0) return [];
  const rows = await client.suggestion.findMany({ where: { userId: { in: [...userIds] }, state: { not: "DRAFT" } }, select: { id: true }, orderBy: { id: "asc" } });
  return rows.map((row) => row.id);
}

/** The decisions a curator makes in the queue (36 § 5): the actions whose wait is the time from queue entry to decision. */
const QUEUE_DECISIONS = ["ACCEPT", "KEEP_REQUEST_MORE", "DECLINE"] as const satisfies ReadonlyArray<CuratorActionKind>;

/**
 * How long the decisions since `since` waited, with the parts of the suggestion each decided (38 § 4; unit 55c): the
 * curators' own decisions, no seed's (36 § 7.1) and none with no wait, which is the verdict that a sampled change
 * stands (36 § 7.2), given on a merged suggestion and not in the queue. Two statements, as `partsOf` reads. No name,
 * no note, no id of a person: the roster panel is every account's.
 */
export async function decisionWaitsSince(since: Date, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<{ readonly parts: ReadonlyArray<Part>; readonly waitMs: number }>> {
  const actions = await client.curatorAction.findMany({ where: { seeded: false, action: { in: [...QUEUE_DECISIONS] }, createdAt: { gte: since }, queueWaitMs: { gt: 0 } }, select: { suggestionId: true, queueWaitMs: true } });
  if (actions.length === 0) return [];
  const suggestions = await client.suggestion.findMany({ where: { id: { in: [...new Set(actions.map((action) => action.suggestionId))] } }, select: { id: true, parts: true } });
  const partsOf = new Map(suggestions.map((row) => [row.id, row.parts]));
  return actions.map((action) => ({ parts: partsOf.get(action.suggestionId) ?? [], waitMs: Number(action.queueWaitMs) }));
}

export interface RosterEntry {
  readonly userId: string;
  readonly part: Part;
  readonly since: Date;
  /** Null while the person curates the part with no end set. */
  readonly until: Date | null;
}

/**
 * Put a person on the roster for a part, or set or clear when their row ends. A row that is in force keeps the day
 * it began; one that had ended, and a new one, begin at `at`. An end that is not after the beginning is refused
 * here, by name, before the database's check would refuse it.
 */
export async function setRosterEntry(entry: Pick<RosterEntry, "userId" | "part" | "until">, at: Date = new Date(), client: ImproveClient = getPrisma()): Promise<RosterEntry> {
  const key = { userId_part: { userId: entry.userId, part: entry.part } };
  const existing = await client.curatorRoster.findUnique({ where: key, select: { since: true, until: true } });
  const inForce = existing !== null && existing.since <= at && (existing.until === null || existing.until > at);
  const since = inForce ? existing.since : at;
  if (entry.until !== null && entry.until <= since) throw new AppError("INVALID_INPUT", `a roster row ends after it begins: it began ${since.toISOString()}`);
  return client.curatorRoster.upsert({ where: key, create: { userId: entry.userId, part: entry.part, since, until: entry.until }, update: { since, until: entry.until }, select: { userId: true, part: true, since: true, until: true } });
}

/* ---------------------------------------------------------------- the rubric's versions (29 § 3; 30 § 5)
 *
 * A published rubric is a row with the hash of its file and its thresholds as rows, so that an adjudication's
 * `rubricVersionId` names what was in force on its date. The rows are the platform's and public: the file is what
 * `GET /api/v1/rubric/*` serves, and no caller is asked for here, because an operator's command writes them and
 * anybody may read them.
 */

const RUBRIC_VERSION = { id: true, publishedAt: true, appliesAt: true, sha256: true } as const satisfies Prisma.RubricVersionSelect;
export type RubricVersionRow = Prisma.RubricVersionGetPayload<{ select: typeof RUBRIC_VERSION }>;

export interface RubricVersionInput {
  readonly id: string;
  readonly publishedAt: Date;
  readonly appliesAt: Date;
  readonly sha256: string;
  readonly tiers: Prisma.InputJsonValue;
  readonly adjustments: Prisma.InputJsonValue;
  readonly examples: Prisma.InputJsonValue;
  /** One per change class; both numbers null where no score decides. */
  readonly thresholds: ReadonlyArray<{ readonly changeClass: ChangeClass; readonly acceptAt: number | null; readonly floorAt: number | null }>;
}

export type RubricPublished = { readonly outcome: "published"; readonly thresholds: number } | { readonly outcome: "already"; readonly sha256: string };

/**
 * Publish a rubric version: its row and its threshold rows, once. A version already published with the same hash
 * is left as it is; one published with another hash is refused, because a version is never edited in place (30
 * § 5.1): a change is a new folder, a new hash, a new row.
 */
export function publishRubricVersion(input: RubricVersionInput, client: ImproveClient = getPrisma()): Promise<RubricPublished> {
  return inTransaction(client, async (tx) => {
    const existing = await tx.rubricVersion.findUnique({ where: { id: input.id }, select: { sha256: true } });
    if (existing !== null) {
      if (existing.sha256 !== input.sha256) throw new AppError("CONFLICT", `rubric ${input.id} is published with sha256 ${existing.sha256.slice(0, 12)}… and the file is ${input.sha256.slice(0, 12)}…: a version is never edited in place; make it a new version (feature-specs/30 § 5.1)`);
      return { outcome: "already", sha256: existing.sha256 };
    }
    await tx.rubricVersion.create({
      data: {
        id: input.id,
        publishedAt: input.publishedAt,
        appliesAt: input.appliesAt,
        sha256: input.sha256,
        tiers: input.tiers,
        adjustments: input.adjustments,
        examples: input.examples,
        thresholds: { create: input.thresholds.map((threshold) => ({ changeClass: threshold.changeClass, acceptAt: threshold.acceptAt, floorAt: threshold.floorAt })) },
      },
      select: { id: true },
    });
    return { outcome: "published", thresholds: input.thresholds.length };
  });
}

/** A published version by its id, or null. */
export function readRubricVersion(id: string, client: ImproveClient = getPrisma()): Promise<RubricVersionRow | null> {
  return client.rubricVersion.findUnique({ where: { id }, select: RUBRIC_VERSION });
}

/** The version in force at `at`: the latest published one that applies by then, or null when none does. */
export function currentRubricVersion(at: Date = new Date(), client: ImproveClient = getPrisma()): Promise<RubricVersionRow | null> {
  return client.rubricVersion.findFirst({ where: { appliesAt: { lte: at } }, orderBy: [{ appliesAt: "desc" }, { id: "desc" }], select: RUBRIC_VERSION });
}

/* ---------------------------------------------------------------- the audit export (feature-specs/38 § 3; unit 55b) */

/*
 * A request becomes a row in `PREPARING`, `ExportWorkflow` writes the pack and makes it `READY`, and its requester
 * reads it. `AuditExport` is not a tenant model: the platform keeps the rows, and the policy decides who asks and who
 * reads (policies/hb/audit.rego), so these take the requester's id, which the endpoint read from the session.
 */

export interface AuditExportRow {
  readonly id: string;
  readonly requestedById: string | null;
  readonly request: AuditExportScopeColumn;
  readonly fromSeq: number | null;
  readonly toSeq: number | null;
  readonly records: number;
  readonly headHash: string | null;
  readonly storageKey: string | null;
  readonly state: AuditExportState;
  readonly createdAt: Date;
  readonly readyAt: Date | null;
}

function auditRowOf(row: Prisma.AuditExportGetPayload<Record<string, never>>): AuditExportRow {
  const { scope, ...rest } = row;
  return { ...rest, request: AuditExportScopeColumnSchema.parse(scope), state: rest.state === "READY" ? "READY" : "PREPARING" };
}

/**
 * The request as a row, `PREPARING`, with the estimate as its count until the file says better — unless the requester
 * has asked for `limit` packs today already (38 § 5: four a day, the UTC day). The count and the row are one
 * transaction under the requester's advisory lock (lib/db/RAW_SQL.md), so two requests at once cannot both pass the
 * count (unit 55's review).
 */
export async function createAuditExport(requestedById: string, request: AuditExportRequest, estimate: number, now: Date, limit: number): Promise<{ readonly created: true; readonly row: AuditExportRow } | { readonly created: false; readonly spent: number }> {
  const column: AuditExportScopeColumn = { scope: request.scope, from: request.from, to: request.to, kinds: request.kinds };
  const day = dayOf(now);
  return getPrisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${requestedById}))`;
    const spent = await tx.auditExport.count({ where: { requestedById, createdAt: { gte: day.start, lt: day.end } } });
    if (spent >= limit) return { created: false, spent };
    const row = await tx.auditExport.create({ data: { requestedById, scope: column, records: estimate, state: "PREPARING", createdAt: now } });
    return { created: true, row: auditRowOf(row) };
  });
}

/** A row whose workflow the engine did not take, gone before anyone reads it as preparing (unit 55's review): only while `PREPARING`, and so never a pack. */
export async function removeAuditExport(id: string): Promise<void> {
  await getPrisma().auditExport.deleteMany({ where: { id, state: "PREPARING" } });
}

/** The reverts of some suggestions' merges (37 § 8): a revert's records are written on the revert, and an account's pack holds the undoing of its own changes too (unit 55's review). */
export async function revertIdsOf(suggestionIds: ReadonlyArray<string>, client: ImproveClient = getPrisma()): Promise<ReadonlyArray<string>> {
  if (suggestionIds.length === 0) return [];
  const rows = await client.merge.findMany({ where: { suggestionId: { in: [...suggestionIds] }, revertedBy: { not: null } }, select: { revertedBy: true } });
  return rows.flatMap((row) => (row.revertedBy === null ? [] : [row.revertedBy]));
}

/** A row by id, for the workflow; null when there is none. */
export async function readAuditExport(id: string): Promise<AuditExportRow | null> {
  const row = await getPrisma().auditExport.findUnique({ where: { id } });
  return row === null ? null : auditRowOf(row);
}

/** The requester's own row by id; null when it is not theirs, which the endpoint answers as not found. */
export async function readOwnAuditExport(requestedById: string, id: string): Promise<AuditExportRow | null> {
  const row = await getPrisma().auditExport.findFirst({ where: { id, requestedById } });
  return row === null ? null : auditRowOf(row);
}

/** The requester's latest row, for the panel's `last export` line; null before their first. */
export async function latestOwnAuditExport(requestedById: string): Promise<AuditExportRow | null> {
  const row = await getPrisma().auditExport.findFirst({ where: { requestedById }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return row === null ? null : auditRowOf(row);
}

/** The first instant of the UTC day `now` is in, and of the next: the day the four-a-day count is of (38 § 5). */
export function dayOf(now: Date): { readonly start: Date; readonly end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/** How many packs the requester asked for today, UTC. */
export function auditExportsToday(requestedById: string, now: Date): Promise<number> {
  const day = dayOf(now);
  return getPrisma().auditExport.count({ where: { requestedById, createdAt: { gte: day.start, lt: day.end } } });
}

export interface AuditPackFacts {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly records: number;
  readonly headHash: string;
  readonly storageKey: string;
}

/** The pack is in the store and its record appended: the row says so, once. */
export async function writeAuditExportReady(id: string, facts: AuditPackFacts, now: Date): Promise<void> {
  await getPrisma().auditExport.updateMany({ where: { id, state: "PREPARING" }, data: { ...facts, state: "READY", readyAt: now } });
}

/* ---------------------------------------------------------------- the Phase 4 gate's reads (feature-specs/39 § 2; unit 56) */

/*
 * What `npm run gate:phase4` reads of the improvement rows: counts and durations over the whole database, for the
 * operator's report and nothing else — no person is named, no suggestion is listed by person (invariant 26).
 */

/** P4.4: the decided curator-always suggestions, and how many of them an adjudicator's row naming a model decided — which must be none. */
export async function curatorAlwaysByModel(client: ImproveClient = getPrisma()): Promise<{ readonly decided: number; readonly byModel: number }> {
  return {
    /* a curator-always class is decided by the router, which writes no adjudication row: the decided are those with a decision */
    decided: await client.suggestion.count({ where: { changeClass: "CURATOR_ALWAYS", decidedAt: { not: null } } }),
    byModel: await client.adjudication.count({ where: { decidedBy: "adjudicator", modelId: { not: null }, suggestion: { changeClass: "CURATOR_ALWAYS" } } }),
  };
}

/** P4.10: every adjudication, and those whose rubric version names one (the column is NOT NULL; an empty string would be none). */
export async function adjudicationsVersioned(client: ImproveClient = getPrisma()): Promise<{ readonly total: number; readonly withRubric: number }> {
  return { total: await client.adjudication.count(), withRubric: await client.adjudication.count({ where: { rubricVersionId: { not: "" } } }) };
}

/** The cross-cutting measure: from submission to decision, in milliseconds, for every decided suggestion of an automatic class. */
export async function decisionDurationsMs(client: ImproveClient = getPrisma()): Promise<ReadonlyArray<number>> {
  const rows = await client.suggestion.findMany({ where: { changeClass: { not: "CURATOR_ALWAYS" }, submittedAt: { not: null }, decidedAt: { not: null } }, select: { submittedAt: true, decidedAt: true } });
  return rows.flatMap((row) => (row.submittedAt === null || row.decidedAt === null ? [] : [row.decidedAt.getTime() - row.submittedAt.getTime()]));
}

/** The cross-cutting measure: from submission to the merge, in milliseconds, for every merged suggestion. */
export async function completionDurationsMs(client: ImproveClient = getPrisma()): Promise<ReadonlyArray<number>> {
  const merges = await client.merge.findMany({ where: { mergedAt: { not: null } }, select: { suggestionId: true, mergedAt: true } });
  if (merges.length === 0) return [];
  const rows = await client.suggestion.findMany({ where: { id: { in: merges.map((merge) => merge.suggestionId) } }, select: { id: true, submittedAt: true } });
  const submitted = new Map(rows.map((row) => [row.id, row.submittedAt]));
  return merges.flatMap((merge) => {
    const at = submitted.get(merge.suggestionId);
    return at == null || merge.mergedAt === null ? [] : [merge.mergedAt.getTime() - at.getTime()];
  });
}

/** R5 (feature-specs/44; unit 61b): every evidence item of every researcher's suggestion, as the fetcher and the grader left it — ids and markers, no text. */
export async function researcherEvidence(client: ImproveClient = getPrisma()): Promise<ReadonlyArray<{ readonly id: string; readonly suggestionId: string; readonly state: string; readonly fetchStatus: string | null; readonly textKey: string | null; readonly contentSha256: string | null }>> {
  return client.evidenceItem.findMany({ where: { suggestion: { origin: "RESEARCHER" } }, select: { id: true, suggestionId: true, state: true, fetchStatus: true, textKey: true, contentSha256: true } });
}

/** The researcher's gate's measures (44 § 3): each researcher's suggestion — where it stands, when it entered the queue, whether its merge was reverted, the adjudicator's decision and the curators' actions on it, in order. */
export async function researcherSuggestionsForGate(client: ImproveClient = getPrisma()): Promise<
  ReadonlyArray<{ readonly id: string; readonly state: string; readonly decidedAt: Date | null; readonly revertedBy: string | null; readonly actions: ReadonlyArray<string> }>
> {
  const rows = await client.suggestion.findMany({ where: { origin: "RESEARCHER" }, select: { id: true, state: true, decidedAt: true, merge: { select: { revertedBy: true } }, curatorActions: { select: { action: true }, orderBy: { createdAt: "asc" } } } });
  return rows.map((row) => ({ id: row.id, state: row.state, decidedAt: row.decidedAt, revertedBy: row.merge?.revertedBy ?? null, actions: row.curatorActions.map((action) => action.action) }));
}

/**
 * 44 § 3, the adjudicator against the curators: of the suggestions of an origin the adjudicator decided and a curator
 * then decided too, how many the curator's first decision agreed with — an accept with an accept, a decline with a
 * decline, a request for more kept.
 */
export async function adjudicatorAgreement(origin: "HUMAN" | "RESEARCHER", client: ImproveClient = getPrisma()): Promise<{ readonly agreed: number; readonly decided: number }> {
  const decisions = ["ACCEPT", "DECLINE", "KEEP_REQUEST_MORE"] as const;
  const rows = await client.suggestion.findMany({
    where: { origin, adjudication: { decidedBy: "adjudicator" }, curatorActions: { some: { action: { in: [...decisions] } } } },
    select: { adjudication: { select: { decision: true } }, curatorActions: { where: { action: { in: [...decisions] } }, select: { action: true }, orderBy: { createdAt: "asc" }, take: 1 } },
  });
  const same = (decision: string | undefined, action: string | undefined): boolean => (decision === "REQUEST_MORE" ? action === "KEEP_REQUEST_MORE" : decision === action);
  return { agreed: rows.filter((row) => same(row.adjudication?.decision, row.curatorActions[0]?.action)).length, decided: rows.length };
}

/** P4.8: a chapter with a merged change, if the database has one, for the per-chapter export's neighbours. */
export async function firstMergedChapter(client: ImproveClient = getPrisma()): Promise<number | null> {
  const row = await client.suggestion.findFirst({ where: { state: "MERGED" }, select: { chapterNumber: true }, orderBy: { id: "asc" } });
  return row?.chapterNumber ?? null;
}
