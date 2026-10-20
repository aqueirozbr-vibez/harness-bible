import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import { resolveAnchor, type ResolvedAnchor } from "@/lib/db/anchors";
import { adjudicatorAcceptsBetween, calibrationEventsBetween, callerOf, createRevert, curatorDecidedSince, writeStandsVerdict, curatorQueue, revertActionOf, mergedInParts, mergingInParts, readSuggestion, rubricReviewsIn, seedOf, seedsOffered, withdrawCuratorAction, writeCuratorAction, writeMergeAction, writeSeedDecision, type AdjudicatorAcceptRow, type CalibrationEventRow, type CuratorActionInput, type CuratorActionWritten, type DecidedToday, type MergeActionInput, type MergeRow, type QueueFilter, type QueueRow, type RevertInput, type RevertWritten, type RubricReviewRow, type SeedForCurator, type SuggestionForUser } from "@/lib/db/improve";
import { env } from "@/lib/env";
import { recordAt } from "@/lib/db/ledger";
import { KAPPA_GATE, KAPPA_RETIRE, measuresOf, MEASURE_MIN, OVERRIDE_REVIEW, OVERRIDE_TARGET, PRECISION_TARGET, quarterBefore, quarterOf, type Measures, type Quarter } from "@/lib/improve/calibration";
import { decisionOf } from "@/lib/improve/curation";
import { mergeStateOf } from "@/lib/improve/merge";
import { proposalKeyOf } from "@/lib/improve/proposal";
import { reverseOf } from "@/lib/improve/revert";
import { deadlineOf, groupOf, GROUP_DEADLINE_HOURS, marksOf, strongestTierOf } from "@/lib/improve/queue";
import { monthOf, sampleOf, seedsWanted, type Month } from "@/lib/improve/seeds";
import { stepKeyOf } from "@/lib/ledger/hash";
import type { PolicyResource } from "@/lib/policy/input";
import { CurationDecidedSchema, CurationDecisionParamsSchema, CurationDecisionSchema, CurationMetricsSchema, CurationQueueQuerySchema, CurationQueueSchema, CurationRecheckedSchema, QUEUE_GROUPS, type CalibrationReading, type CurationDecided, type CurationDecision, type CurationMetrics, type CurationQueue, type CurationRechecked, type QueueItem } from "@/lib/schemas/curation";
import { mergesAfter, ProposalSchema, type AnchorKind, type ChangeClass, type Criterion, type Part } from "@/lib/schemas/improve";
import { MergeCheckSchema, type MergeState } from "@/lib/schemas/merge";
import { MERGE_RECHECK_SIGNAL, MERGE_SIGNAL, MERGE_WORKFLOW, mergeWorkflowId, SUGGESTION_CURATOR_SIGNAL, SUGGESTION_WORKFLOW } from "@/lib/schemas/workflows";
import { signalWorkflow, startWorkflow, WorkflowNotFoundError } from "@/lib/workflows/client";

/*
 * The curator queue's API (feature-specs/36 § 3, § 5). The reads (unit 53a): what waits for the caller's parts, in
 * groups, each item with its deadline (A15), what the caller decided today, and the header's marks. The decision (unit
 * 53c): the action written, the suggestion's workflow told; the workflow writes the `curator` record and the
 * calibration event and moves the suggestion (33 § 6.3), never this handler (invariant 17). The metrics (unit 53d):
 * the adjudicator's calibration against the curators, by quarter, over those events. Seeds and the monthly sample
 * (unit 53e): ordinary items of the queue, each off until Andre sets its number (36 § 7). The merges (unit 54b): what
 * is ready to merge and what merges waiting on a hand, as groups of the queue; and `Re-run check`, which tells a merge
 * to prepare and check again (37 § 4.3, § 4.5), or starts one where none runs. A curator's merge (unit 54c): `MERGE`,
 * the decision endpoint's fourth action, on a suggestion ready to merge, told to its merge's workflow (37 § 5). A
 * curator's revert (unit 54e): `REVERT`, its fifth, on a merged suggestion, with a note: a merge in the other
 * direction, a suggestion of the chapter's own whose merge is started with the action (37 § 8).
 */

/** 36 § 3: 120 a minute. */
const QUEUE_RATE = { key: "user", limit: 120, windowS: 60 } as const;
/** 36 § 5: 60 an hour. */
const DECISION_RATE = { key: "user", limit: 60, windowS: 3_600 } as const;
/** 36 § 6.2: 60 a minute. */
const METRICS_RATE = { key: "user", limit: 60, windowS: 60 } as const;
/** How many quarters the metrics give, newest first: this one and the three before it, a year. */
const METRICS_QUARTERS = 4;
/** How long the decision waits for the workflow's record before it answers 202 (36 § 5.1), and how often it looks. */
export const RECORD_WAIT_MS = 5_000;
export const RECORD_POLL_MS = 250;

export interface CurationEndpointDeps {
  readonly queue: (user: SessionUser, filter: { readonly part: Part | null; readonly changeClass: ChangeClass | null }) => Promise<ReadonlyArray<QueueRow>>;
  readonly decidedSince: (user: SessionUser, since: Date) => Promise<ReadonlyArray<DecidedToday>>;
  readonly now: () => Date;
  /** The suggestion as the caller may read it: a curator, past draft in one of their parts. */
  readonly read: (user: SessionUser, id: string) => Promise<SuggestionForUser | null>;
  readonly write: (user: SessionUser, input: CuratorActionInput, now: Date) => Promise<CuratorActionWritten>;
  readonly withdraw: (user: SessionUser, actionId: string) => Promise<boolean>;
  /** `curatorDecision({ actionId })` to the suggestion's workflow (33 § 6.3); the id only (28 § 5.3). */
  readonly signal: (workflowId: string, actionId: string) => Promise<void>;
  /** The `curator` record the workflow wrote under the step key, by its `seq`; null until it has. */
  readonly recorded: (suggestionId: string, stepKey: string) => Promise<number | null>;
  readonly pause: (ms: number) => Promise<void>;
  /** The calibration events written in a span, the adjudicator's accepts decided in it, and the reviews of some quarters (36 § 6). */
  readonly calibration: (user: SessionUser, from: Date, to: Date) => Promise<ReadonlyArray<CalibrationEventRow>>;
  readonly accepts: (user: SessionUser, from: Date, to: Date) => Promise<ReadonlyArray<AdjudicatorAcceptRow>>;
  readonly reviews: (user: SessionUser, quarters: ReadonlyArray<string>) => Promise<ReadonlyArray<RubricReviewRow>>;
  /** The share of a queue that seeds may make up (36 § 7.1), and how many merged tier-B suggestions a part's sample draws a month (§ 7.2): 0 and null until Andre sets them. */
  readonly seedShare: number;
  readonly samplePerMonth: number | null;
  /** The caller's seeds to show, as queue rows; the merged suggestions a sample is drawn from; a seed of the caller's by its id; and its decision. */
  readonly seeds: (user: SessionUser, wanted: number, filter: QueueFilter, now: Date) => Promise<ReadonlyArray<QueueRow>>;
  readonly merged: (user: SessionUser, filter: QueueFilter) => Promise<ReadonlyArray<QueueRow>>;
  readonly seed: (user: SessionUser, id: string) => Promise<SeedForCurator | null>;
  readonly writeSeed: (user: SessionUser, seedId: string, input: Omit<CuratorActionInput, "suggestionId">, now: Date) => Promise<{ readonly written: true; readonly actionId: string } | { readonly written: false }>;
  /** What merges in the caller's parts, with its merges (37 § 6). */
  readonly merging: (user: SessionUser, filter: QueueFilter) => Promise<ReadonlyArray<QueueRow & { readonly merge: MergeRow | null }>>;
  /** `recheck` to the suggestion's merge; or, where none runs, a merge started: whether it was. */
  readonly recheck: (user: SessionUser, suggestionId: string) => Promise<{ readonly started: boolean }>;
  /** A curator's merge written (37 § 5; unit 54c), and `merge({ actionId })` to the suggestion's merge: the id only (28 § 5.3). */
  readonly writeMerge: (user: SessionUser, input: MergeActionInput, now: Date) => Promise<{ readonly written: true; readonly actionId: string } | { readonly written: false }>;
  readonly signalMerge: (suggestionId: string, actionId: string) => Promise<void>;
  /** A revert (37 § 8; unit 54e): the original's anchor as the release reads it now, the revert written with its action, and its merge started with the action. */
  readonly anchor: (kind: AnchorKind, id: string, locale: "en" | "pt") => Promise<ResolvedAnchor | null>;
  readonly writeRevert: (user: SessionUser, input: RevertInput, now: Date) => Promise<RevertWritten>;
  readonly startRevert: (revertId: string, actionId: string) => Promise<void>;
  /** The month's verdict that a sampled, merged change stands (36 § 7.2; unit 54e): the action alone. */
  readonly writeStands: (user: SessionUser, suggestionId: string, note: string | null, now: Date) => Promise<{ readonly written: true; readonly actionId: string } | { readonly written: false }>;
}

const DEPS: CurationEndpointDeps = {
  queue: (user, filter) => curatorQueue(callerOf(user), filter),
  decidedSince: (user, since) => curatorDecidedSince(callerOf(user), since),
  now: () => new Date(),
  read: (user, id) => readSuggestion(callerOf(user), id),
  write: (user, input, now) => writeCuratorAction(callerOf(user), input, now),
  withdraw: (user, actionId) => withdrawCuratorAction(callerOf(user), actionId),
  signal: (workflowId, actionId) => signalWorkflow(SUGGESTION_WORKFLOW, workflowId, SUGGESTION_CURATOR_SIGNAL, { actionId }),
  recorded: async (suggestionId, stepKey) => (await recordAt(suggestionId, "CURATOR", stepKey))?.seq ?? null,
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  calibration: (user, from, to) => calibrationEventsBetween(callerOf(user), from, to),
  accepts: (user, from, to) => adjudicatorAcceptsBetween(callerOf(user), from, to),
  reviews: (user, quarters) => rubricReviewsIn(callerOf(user), quarters),
  seedShare: Number(env.CURATOR_SEED_SHARE ?? "0"),
  samplePerMonth: env.CURATOR_SAMPLE_PER_MONTH === undefined ? null : Number(env.CURATOR_SAMPLE_PER_MONTH),
  seeds: (user, wanted, filter, now) => seedsOffered(callerOf(user), wanted, filter, now),
  merged: (user, filter) => mergedInParts(callerOf(user), filter),
  seed: (user, id) => seedOf(callerOf(user), id),
  writeSeed: (user, seedId, input, now) => writeSeedDecision(callerOf(user), seedId, input, now),
  merging: (user, filter) => mergingInParts(callerOf(user), filter),
  recheck: async (user, suggestionId) => {
    try {
      await signalWorkflow(MERGE_WORKFLOW, mergeWorkflowId(suggestionId), MERGE_RECHECK_SIGNAL, null);
      return { started: false };
    } catch (error: unknown) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
      /* an accept from before unit 54b, or one whose run ended: a merge of its own, which nothing waits on; a revert's run is told its action again, so it records and merges as the first would (unit 54's review) */
      const actionId = await revertActionOf(callerOf(user), suggestionId);
      await startWorkflow(MERGE_WORKFLOW, mergeWorkflowId(suggestionId), { suggestionId: suggestionId as never, ...(actionId === null ? {} : { actionId }) });
      return { started: true };
    }
  },
  writeMerge: (user, input, now) => writeMergeAction(callerOf(user), input, now),
  signalMerge: (suggestionId, actionId) => signalWorkflow(MERGE_WORKFLOW, mergeWorkflowId(suggestionId), MERGE_SIGNAL, { actionId }),
  anchor: (kind, id, locale) => resolveAnchor(kind, id, locale),
  writeRevert: (user, input, now) => createRevert(callerOf(user), input, now),
  startRevert: async (revertId, actionId) => {
    await startWorkflow(MERGE_WORKFLOW, mergeWorkflowId(revertId), { suggestionId: revertId as never, actionId });
  },
  writeStands: (user, suggestionId, note, now) => writeStandsVerdict(callerOf(user), suggestionId, note, now),
};

/**
 * The suggestion as the policy decides on it (36 § 5.1 step 1): its owner, its parts, its class and its origin; read
 * with the caller's own condition. A seed's id is decided on as the suggestion it is of (36 § 7.1).
 */
async function curationResourceOf(deps: Pick<CurationEndpointDeps, "read" | "seed">, session: SessionUser | null, id: string): Promise<PolicyResource> {
  const user = requireUser(session);
  const seed = await deps.seed(user, id);
  const row = await deps.read(user, seed === null ? id : seed.suggestionId);
  if (row === null) throw new ApiError("NOT_FOUND", `suggestion ${id} is not here, or not in your parts`);
  return { kind: "curation", id: row.id, ownerId: row.userId, parts: row.parts, changeClass: row.changeClass, origin: row.origin };
}

function requireUser(session: SessionUser | null): SessionUser {
  if (session === null) throw new ApiError("NO_SESSION", "sign in to use this endpoint");
  return session;
}

/**
 * A decision on a seed (36 § 7.1): the override rule against what stood when the queue showed it, the action written
 * `seeded` and compared with the answer, and nothing else — no workflow is told, so no record follows, and the answer
 * carries none: 200 with no `ledgerSeq`. It is then revealed under "Decided today".
 */
async function decideSeed(deps: CurationEndpointDeps, user: SessionUser, seed: SeedForCurator, body: CurationDecision): Promise<CurationDecided> {
  if (seed.decided !== null) throw new ApiError("CONFLICT", `${seed.id} is decided already`, { state: "DECIDED" });
  if (body.action === "MERGE" || body.action === "REVERT") throw new ApiError("CONFLICT", `${seed.id} is decided by accepting, keeping the request for more or declining; a seed is never merged or reverted`, { state: "CURATOR_QUEUE" });
  const row = await deps.read(user, seed.suggestionId);
  if (row === null) throw new ApiError("NOT_FOUND", `suggestion ${seed.id} is not here, or not in your parts`);
  const note = body.note === undefined || body.note.trim() === "" ? null : body.note;
  const decided = decisionOf({ action: body.action, origin: row.origin, changeClass: row.changeClass, standing: seed.standing, overrideCode: body.overrideCode ?? null, criterion: body.criterion ?? null, note });
  if (decided.refusal !== null) throw new ApiError(decided.refusal, `this decision is ${decided.kind === "override" ? "an override" : decided.kind === "agreement" ? "an agreement" : "the curator's own"}: ${decided.refusal}`, { kind: decided.kind });
  const written = await deps.writeSeed(user, seed.id, { action: body.action, overrideCode: body.overrideCode ?? null, criterion: decided.criterion, note }, deps.now());
  if (!written.written) throw new ApiError("CONFLICT", `${seed.id} is no longer in your queue`);
  return { actionId: written.actionId, ledgerSeq: null };
}

/**
 * The `curator` record the workflow writes under the step key (36 § 5.1 step 6): the answer once it has, by its `seq`;
 * or 202 while it records, which the page says (`recording`).
 */
async function recordedOrRecording(deps: CurationEndpointDeps, suggestionId: string, stepKey: string, actionId: string): Promise<CurationDecided | Response> {
  for (let waited = 0; waited < RECORD_WAIT_MS; waited += RECORD_POLL_MS) {
    const seq = await deps.recorded(suggestionId, stepKey);
    if (seq !== null) {
      const answer: CurationDecided = { actionId, ledgerSeq: seq };
      return answer;
    }
    await deps.pause(RECORD_POLL_MS);
  }
  const recording: CurationDecided = { actionId, ledgerSeq: null };
  return new Response(JSON.stringify(recording), { status: 202, headers: { "content-type": "application/json; charset=utf-8" } });
}

/**
 * A curator's merge (37 § 5; unit 54c): on a suggestion whose merge's check passed — the "Ready to merge" group — with
 * a note at most, and no override's code or criterion, which a merge has none of. The action written, the merge's
 * workflow told with its id (the suggestion's own run waits on its merge then); that workflow writes the `curator`
 * record (invariant 17), which the answer gives as a decision's does. An action its workflow was never told of is taken
 * back: the engine down is the pipeline's 503, a merge that has ended a conflict that `Re-run check` answers.
 */
async function decideMerge(deps: CurationEndpointDeps, user: SessionUser, row: SuggestionForUser, body: CurationDecision): Promise<CurationDecided | Response> {
  if (body.overrideCode !== undefined || body.criterion !== undefined) throw new ApiError("INVALID_INPUT", "a merge takes no override code and no criterion");
  if (row.state !== "MERGING") throw new ApiError("CONFLICT", `suggestion ${row.id} is ${row.state}: it is not merging`, { state: row.state });
  const note = body.note === undefined || body.note.trim() === "" ? null : body.note;
  const written = await deps.writeMerge(user, { suggestionId: row.id, note }, deps.now());
  if (!written.written) throw new ApiError("CONFLICT", `suggestion ${row.id} is not ready to merge: its check has not passed, or a merge of it stands`, { state: row.state });
  const { actionId } = written;
  try {
    await deps.signalMerge(row.id, actionId);
  } catch (error: unknown) {
    await deps.withdraw(user, actionId);
    if (error instanceof WorkflowNotFoundError) throw new ApiError("CONFLICT", `suggestion ${row.id}: its merge has ended and cannot take a merge; Re-run check starts one`, { workflowId: mergeWorkflowId(row.id) });
    throw error;
  }
  return recordedOrRecording(deps, row.id, stepKeyOf(mergeWorkflowId(row.id), `curator:${actionId}`), actionId);
}

/**
 * A curator's revert (37 § 8; unit 54e): of a merged suggestion in one of their parts, not their own, with a note. The
 * proposal that undoes the original is made from its proposal and the text it read — a passage's edit exchanged, a
 * value set back — or is the curator's hand, a restructure of the product's words that the merge leaves for their
 * commit (§ 4.3). The revert's anchor is the original's as the release reads it now, which its merge holds `main` to
 * (§ 4.1 step 1). Written in one transaction with the curator's `REVERT` action on the original, which counts in
 * precision (36 § 6.1); then its merge is started with the action, and merges once its check passes. The record is
 * the merge's to write (invariant 17): the answer is 202 with the revert's id.
 */
async function decideRevert(deps: CurationEndpointDeps, user: SessionUser, row: SuggestionForUser, body: CurationDecision): Promise<Response> {
  if (body.overrideCode !== undefined || body.criterion !== undefined) throw new ApiError("INVALID_INPUT", "a revert takes no override code and no criterion");
  const note = body.note === undefined || body.note.trim() === "" ? null : body.note;
  if (note === null) throw new ApiError("REVERT_NOTE_REQUIRED", "a revert says why: give a note");
  if (row.state !== "MERGED") throw new ApiError("CONFLICT", `suggestion ${row.id} is ${row.state}: only a merged change is reverted`, { state: row.state });
  if (row.merge === null || row.merge.mergedAt === null) throw new ApiError("CONFLICT", `suggestion ${row.id} has no merge to revert`, { state: row.state });
  if (row.merge.revertedBy !== null) throw new ApiError("CONFLICT", `suggestion ${row.id} is reverted already, by ${row.merge.revertedBy}`, { revertedBy: row.merge.revertedBy });
  if (row.anchor === null) throw new ApiError("CONFLICT", `suggestion ${row.id} has no anchor`);
  const anchorId = row.anchor.figureAnchor ?? row.anchor.sourceRowAnchor ?? row.anchor.sectionAnchor;
  const now = await deps.anchor(row.anchor.kind, anchorId, row.locale === "PT" ? "pt" : "en");
  if (now === null) throw new ApiError("CONFLICT", `the anchor ${anchorId} is not in the release any more: the revert is the curator's hand on the repository`, { anchor: anchorId });
  const proposal = ProposalSchema.safeParse(row.proposal);
  const reverse = reverseOf(row.id, row.changeKind, proposal.success ? proposal.data : null, row.anchor.currentText);
  const anchor = { kind: now.kind, sectionAnchor: now.sectionAnchor, figureAnchor: now.figureAnchor, sourceRowAnchor: now.sourceRowAnchor, currentText: now.currentText, contentSha256: now.contentSha256, existsAtVersion: true };
  const written = await deps.writeRevert(user, { originalId: row.id, note, releaseId: now.releaseId, chapterVersionId: now.chapterVersionId, proposal: reverse.proposal, proposalKey: proposalKeyOf(anchor, reverse.proposal), changeKind: reverse.proposal.kind, anchor }, deps.now());
  if (!written.written) throw new ApiError("CONFLICT", `suggestion ${row.id} is not yours to revert: not merged, not in your parts, your own, or reverted already`, { state: row.state });
  try {
    await deps.startRevert(written.revertId, written.actionId);
  } catch (error: unknown) {
    /* the revert is written and the engine did not take its merge: Re-run check on the revert starts it with its action (unit 54's review) */
    if (error instanceof ApiError) throw new ApiError(error.code, `${error.message}; the revert ${written.revertId} is written, and Re-run check on it starts its merge`, { ...(typeof error.detail === "object" && error.detail !== null ? error.detail : {}), revertId: written.revertId });
    throw error;
  }
  const started: CurationDecided = { actionId: written.actionId, ledgerSeq: null, revertId: written.revertId as CurationDecided["revertId"] };
  return new Response(JSON.stringify(started), { status: 202, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** The month's sample (36 § 7.2): for each of the parts asked, `perMonth` of the merged suggestions whose strongest item was tier B, drawn by the month; a suggestion of two parts once. */
function sampled(rows: ReadonlyArray<QueueRow>, parts: ReadonlyArray<Part>, month: Month, perMonth: number): ReadonlyArray<QueueRow> {
  const tierB = rows.filter((row) => strongestTierOf(row.graded) === "B");
  const drawn = new Set(parts.flatMap((part) => sampleOf(tierB.filter((row) => row.parts.includes(part)).map((row) => row.id), month.label, perMonth)));
  return tierB.filter((row) => drawn.has(row.id));
}

/**
 * The item as 36 § 3.2 has it, with its group and deadline; null for a change that has no group in this build. A
 * sampled item is filed by the sample: in it since the month began, due by its end (§ 3.1).
 */
function itemOf(row: QueueRow, sample: { readonly group: "sampled" | "ready" | "merging"; readonly queuedAt: Date; readonly deadline: Date | null; readonly merge?: MergeState } | null = null): { readonly group: (typeof QUEUE_GROUPS)[number]; readonly item: QueueItem } | null {
  const group = sample?.group ?? groupOf(row);
  if (group === null || row.anchor === null) return null;
  const { anchor } = row;
  const queuedAt = sample?.queuedAt ?? row.decidedAt;
  const deadline = sample?.deadline ?? deadlineOf(group, row.decidedAt);
  return {
    group,
    item: {
      id: row.id as QueueItem["id"],
      anchor: { kind: anchor.kind, id: anchor.figureAnchor ?? anchor.sourceRowAnchor ?? anchor.sectionAnchor, section: anchor.sectionAnchor as QueueItem["anchor"]["section"] },
      changeClass: row.changeClass,
      curatorReason: row.curatorReason,
      outcome: row.outcome,
      tier: strongestTierOf(row.graded),
      score: row.score,
      state: row.state,
      submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
      queuedAt: queuedAt === null ? null : queuedAt.toISOString(),
      deadline: deadline === null ? null : deadline.toISOString(),
      parts: [...row.parts],
      shared: row.parts.length > 1,
      merge: sample?.merge ?? null,
      origin: row.origin,
      fromResearch: row.fromResearch,
    },
  };
}

/**
 * An accepted suggestion as the queue files it (37 § 6; 36 § 3.1, D3): ready to merge once its check passed, else
 * merging, waiting on a hand; in the group since its merge's last word — the check, or where none has run the accept —
 * and due seven days after.
 */
function mergeItemOf(row: QueueRow & { readonly merge: MergeRow | null }): ReturnType<typeof itemOf> {
  const parsed = MergeCheckSchema.safeParse(row.merge?.check);
  const check = parsed.success ? parsed.data : null;
  const merge = mergeStateOf(check, row.merge);
  const group = merge === "READY" ? "ready" : "merging";
  const queuedAt = check === null ? row.decidedAt : new Date(check.at);
  return queuedAt === null ? null : itemOf(row, { group, queuedAt, deadline: deadlineOf(group, queuedAt), merge });
}

/**
 * The queue as the endpoint answers it and the queue page renders it (36 § 3, § 4): the caller's open items in their
 * groups, what they decided since midnight UTC, and the marks at `now`. A group with nothing in it is absent (36 § 8).
 */
export async function readCurationQueue(user: SessionUser, filter: { readonly part: Part | null; readonly changeClass: ChangeClass | null }, deps: CurationEndpointDeps = DEPS): Promise<CurationQueue> {
  const now = deps.now();
  /* Today begins at midnight, UTC, as every time the API gives. */
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [rows, decided, merging] = await Promise.all([deps.queue(user, filter), deps.decidedSince(user, midnight), deps.merging(user, filter)]);
  /* Seeds, none at share 0 (A16), and the month's sample, none while unset (36 § 7): ordinary items, filed as any is. */
  const wanted = seedsWanted(deps.seedShare, rows.length);
  const month = monthOf(now);
  const [seeds, merged] = await Promise.all([wanted === 0 ? Promise.resolve([]) : deps.seeds(user, wanted, filter, now), deps.samplePerMonth === null ? Promise.resolve([]) : deps.merged(user, filter)]);
  const parts = filter.part === null ? user.parts : user.parts.filter((part) => part === filter.part);
  const sample = deps.samplePerMonth === null ? [] : sampled(merged, parts, month, deps.samplePerMonth);
  const filed = [
    ...[...rows, ...seeds].flatMap((row) => {
      const entry = itemOf(row);
      return entry === null ? [] : [entry];
    }),
    ...sample.flatMap((row) => {
      const entry = itemOf(row, { group: "sampled", queuedAt: month.from, deadline: month.to });
      return entry === null ? [] : [entry];
    }),
    ...merging.flatMap((row) => {
      const entry = mergeItemOf(row);
      return entry === null ? [] : [entry];
    }),
  ].sort((a, b) => (a.item.queuedAt ?? "").localeCompare(b.item.queuedAt ?? "") || a.item.id.localeCompare(b.item.id));
  const groups = QUEUE_GROUPS.flatMap((group) => {
    const items = filed.filter((entry) => entry.group === group).map((entry) => entry.item);
    return items.length === 0 ? [] : [{ group, deadlineHours: GROUP_DEADLINE_HOURS[group], items }];
  });
  return {
    parts: [...user.parts],
    groups,
    decidedToday: decided.map((action) => ({ id: action.suggestionId as CurationQueue["decidedToday"][number]["id"], action: action.action, decidedAt: action.createdAt.toISOString(), seed: action.seed })),
    marks: marksOf(filed.map((entry) => (entry.item.deadline === null ? null : new Date(entry.item.deadline))), now),
    now: now.toISOString(),
  };
}

/** The measures as the answer carries them. */
const readingOf = (measures: Measures): CalibrationReading => ({ overrideRate: { reviewed: measures.overrideRate.reviewed, criteria: measures.overrideRate.criteria.map((entry) => ({ ...entry })) }, kappa: { ...measures.kappa }, precision: { ...measures.precision } });

/**
 * The calibration as the endpoint answers it and the queue's rail draws it (36 § 6.1, § 6.2): the three measures for
 * this quarter and the three before it, newest first, over everything and over the researcher's proposals alone, with
 * the rubric reviews each quarter opened. Read in three statements over the year, then sorted by quarter.
 */
export async function readCurationMetrics(user: SessionUser, deps: Pick<CurationEndpointDeps, "now" | "calibration" | "accepts" | "reviews"> = DEPS): Promise<CurationMetrics> {
  const now = deps.now();
  const current = quarterOf(now);
  const quarters = Array.from({ length: METRICS_QUARTERS }, (_, back) => quarterBefore(current, back));
  const oldest = quarters[quarters.length - 1] ?? current;
  const [events, accepts, reviews] = await Promise.all([deps.calibration(user, oldest.from, current.to), deps.accepts(user, oldest.from, current.to), deps.reviews(user, quarters.map((quarter) => quarter.label))]);
  const within =
    (quarter: Quarter) =>
    (at: Date): boolean =>
      at >= quarter.from && at < quarter.to;
  return {
    now: now.toISOString(),
    minimum: MEASURE_MIN,
    lines: { overrideTarget: OVERRIDE_TARGET, overrideReview: OVERRIDE_REVIEW, kappaRetire: KAPPA_RETIRE, kappaGate: KAPPA_GATE, precisionTarget: PRECISION_TARGET },
    quarters: quarters.map((quarter) => {
      const inside = within(quarter);
      const { all, researcher } = measuresOf(
        events.filter((event) => inside(event.createdAt)),
        accepts.filter((accept) => inside(accept.decidedAt)),
      );
      return {
        quarter: quarter.label,
        from: quarter.from.toISOString(),
        to: quarter.to.toISOString(),
        all: readingOf(all),
        researcher: readingOf(researcher),
        reviews: reviews.filter((review) => review.quarter === quarter.label).map((review) => ({ id: review.id, criterion: review.criterion as Criterion, rate: review.rate, overridden: review.overridden, reviewed: review.reviewed, openedAt: review.openedAt.toISOString() })),
      };
    }),
  };
}

export function curationEndpoints(deps: CurationEndpointDeps = DEPS): {
  readonly curationQueue: Spec<undefined, typeof CurationQueueQuerySchema, undefined, typeof CurationQueueSchema>;
  readonly curationMetrics: Spec<undefined, undefined, undefined, typeof CurationMetricsSchema>;
  readonly curationDecision: Spec<typeof CurationDecisionParamsSchema, undefined, typeof CurationDecisionSchema, typeof CurationDecidedSchema>;
  readonly curationRecheck: Spec<typeof CurationDecisionParamsSchema, undefined, undefined, typeof CurationRecheckedSchema>;
} {
  return {
    curationRecheck: {
      path: "/api/v1/curation/{suggestionId}/recheck",
      method: "POST",
      summary: "A curator of the part has an accepted suggestion's merge prepare its branch and check it again — after a commit of their own on the branch, or once what stopped it is set right — or starts its merge where none runs",
      auth: "session",
      role: "CURATOR",
      params: CurationDecisionParamsSchema,
      response: CurationRecheckedSchema,
      rateLimit: DECISION_RATE,
      idempotent: true,
      policy: { action: "decide", resource: ({ session, params }) => curationResourceOf(deps, session, params.suggestionId) },
      run: async ({ session, params }) => {
        const user = requireUser(session);
        const row = await deps.read(user, params.suggestionId);
        if (row === null) throw new ApiError("NOT_FOUND", `suggestion ${params.suggestionId} is not here, or not in your parts`);
        /* accepted, and merging or waiting for its merge to begin (37 § 4); anything else has no merge to check */
        if (!mergesAfter(row.state, row.outcome)) throw new ApiError("CONFLICT", `suggestion ${row.id} is ${row.state}: it has no merge to check`, { state: row.state });
        const asked: CurationRechecked = { suggestionId: row.id as CurationRechecked["suggestionId"], ...(await deps.recheck(user, row.id)) };
        return new Response(JSON.stringify(asked), { status: 202, headers: { "content-type": "application/json; charset=utf-8" } });
      },
    },
    curationDecision: {
      path: "/api/v1/curation/{suggestionId}/decision",
      method: "POST",
      summary: "A curator decides a suggestion in the queue of one of their parts: accept, keep the request for more, or decline, with a coded reason and a note where the decision overrides the adjudicator; or merges one whose check passed; or reverts a merged one, with a note",
      auth: "session",
      role: "CURATOR",
      params: CurationDecisionParamsSchema,
      body: CurationDecisionSchema,
      response: CurationDecidedSchema,
      rateLimit: DECISION_RATE,
      idempotent: true,
      policy: { action: "decide", resource: ({ session, params }) => curationResourceOf(deps, session, params.suggestionId) },
      run: async ({ session, params, body }) => {
        const user = requireUser(session);
        /* A seed is decided as one, and recorded nowhere but its action (36 § 7.1). */
        const seed = await deps.seed(user, params.suggestionId);
        if (seed !== null) return decideSeed(deps, user, seed, body);
        const row = await deps.read(user, params.suggestionId);
        if (row === null) throw new ApiError("NOT_FOUND", `suggestion ${params.suggestionId} is not here, or not in your parts`);
        /* A merge is the curator's action on a checked branch, not a decision in the queue (37 § 5); a revert, on a merged change (37 § 8); an accept of a merged change is the month's verdict that it stands (36 § 7.2). */
        if (body.action === "MERGE") return decideMerge(deps, user, row, body);
        if (body.action === "REVERT") return decideRevert(deps, user, row, body);
        if (body.action === "ACCEPT" && row.state === "MERGED") {
          if (body.overrideCode !== undefined || body.criterion !== undefined) throw new ApiError("INVALID_INPUT", "a change that stands takes no override code and no criterion");
          const stands = await deps.writeStands(user, row.id, body.note === undefined || body.note.trim() === "" ? null : body.note, deps.now());
          if (!stands.written) throw new ApiError("CONFLICT", `suggestion ${row.id} is not yours to judge: not in your parts, your own, or judged already since it merged`, { state: row.state });
          const answer: CurationDecided = { actionId: stands.actionId, ledgerSeq: null };
          return answer;
        }
        /* 2 in the queue; decided by another curator meanwhile, or never queued, it is not (36 § 8). */
        if (row.state !== "CURATOR_QUEUE") throw new ApiError("CONFLICT", `suggestion ${row.id} is ${row.state}: it is not in the queue`, { state: row.state });
        /* 3 the override rule (36 § 5.2). */
        const note = body.note === undefined || body.note.trim() === "" ? null : body.note;
        const decided = decisionOf({ action: body.action, origin: row.origin, changeClass: row.changeClass, standing: row.outcome, overrideCode: body.overrideCode ?? null, criterion: body.criterion ?? null, note });
        if (decided.refusal !== null) throw new ApiError(decided.refusal, `this decision is ${decided.kind === "override" ? "an override" : decided.kind === "agreement" ? "an agreement" : "the curator's own"}: ${decided.refusal}`, { kind: decided.kind });
        /* 4 the action; 5 the workflow told. Nothing reaches the ledger from here (invariant 17). */
        const written = await deps.write(user, { suggestionId: row.id, action: body.action, overrideCode: body.overrideCode ?? null, criterion: decided.criterion, note }, deps.now());
        if (!written.written) throw new ApiError("CONFLICT", `suggestion ${row.id} is no longer in your queue`);
        const { actionId, workflowId } = written;
        if (workflowId === null) {
          await deps.withdraw(user, actionId);
          throw new ApiError("CONFLICT", `suggestion ${row.id} has no workflow to tell`);
        }
        try {
          await deps.signal(workflowId, actionId);
        } catch (error: unknown) {
          /* Not told, so not written either (36 § 8): the engine down is the pipeline's 503, an ended workflow a conflict. */
          await deps.withdraw(user, actionId);
          if (error instanceof WorkflowNotFoundError) throw new ApiError("CONFLICT", `suggestion ${row.id}: its workflow has ended and cannot take a decision`, { workflowId });
          throw error;
        }
        /* 6 the record, once the workflow has written it; or 202 while it records, which the page says (`recording`). */
        return recordedOrRecording(deps, row.id, stepKeyOf(workflowId, `curator:${actionId}`), actionId);
      },
    },
    curationQueue: {
      path: "/api/v1/curation/queue",
      method: "GET",
      summary: "What waits for the caller's parts of the book, in the curator queue's groups, each item with its deadline; and what the caller decided today",
      auth: "session",
      role: "CURATOR",
      query: CurationQueueQuerySchema,
      response: CurationQueueSchema,
      rateLimit: QUEUE_RATE,
      policy: { action: "read", resource: () => ({ kind: "curation", id: null }) },
      run: ({ session, query }) => readCurationQueue(requireUser(session), { part: query.part ?? null, changeClass: query.class ?? null }, deps),
    },
    curationMetrics: {
      path: "/api/v1/curation/metrics",
      method: "GET",
      summary: "The adjudicator's calibration against the curators by quarter: the override rate per criterion, κ and adjudication precision, each with its counts, and the rubric reviews the rates opened",
      auth: "session",
      role: "CURATOR",
      response: CurationMetricsSchema,
      rateLimit: METRICS_RATE,
      policy: { action: "read", resource: () => ({ kind: "curation", id: null }) },
      run: ({ session }) => readCurationMetrics(requireUser(session), deps),
    },
  };
}

export const { curationQueue, curationDecision, curationMetrics, curationRecheck } = curationEndpoints();
