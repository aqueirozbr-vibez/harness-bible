import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import { contributorStandingOf, type ContributorStanding } from "@/lib/db/account";
import { currentChapterVersion, resolveAnchor, type ResolvedAnchor } from "@/lib/db/anchors";
import { getPrisma } from "@/lib/db/client";
import { recordAt } from "@/lib/db/ledger";
import { callerOf, createDraft, currentRubricVersion, deleteDraft, liveSuggestionWithKey, requestWithdrawal, takeBackWithdrawal, type DraftDeleted, type DraftInput, type DraftPatch, type WithdrawalRequested, readClosedResearchProposal, readMergedSuggestion, readProposalsForAsker, readRubricVersion, readSuggestion, type RubricVersionRow, type SuggestionForUser, transition, updateDraft } from "@/lib/db/improve";
import { askerOfProposal, duplicateVisibleTo } from "@/lib/db/research";
import type { Prisma } from "@/lib/db/generated/client";
import { currentRelease } from "@/lib/db/shared";
import { withSystem } from "@/lib/db/tenant";
import type { Locale } from "@/lib/i18n/routing";
import { fastMovingOf, proposalKeyOf, proposalTexts } from "@/lib/improve/proposal";
import { intakeFactsOf } from "@/lib/improve/intake";
import { gradedItemsOf, rescoredOf } from "@/lib/improve/scoring";
import type { PolicyResource } from "@/lib/policy/input";
import { ANCHOR_OF_CHANGE_KIND, classOf, type ClassAnchor } from "@/lib/rubric/changeClass";
import { scoreOf, wouldSuffice } from "@/lib/rubric/score";
import { predict } from "@/lib/rubric/thresholds";
import { loadRubric, type LoadedRubric } from "@/lib/rubrics/load";
import { intakeSensors, type IntakeVerdict } from "@/lib/sensors/intake";
import { stepKeyOf } from "@/lib/ledger/hash";
import { CriterionSchema, DeciderSchema, ProposalSchema, takesRevision, takesWithdrawal, type Part } from "@/lib/schemas/improve";
import { MergeCheckSchema } from "@/lib/schemas/merge";
import { SuggestionCreatedSchema, SuggestionCreateSchema, SuggestionDeletedSchema, SuggestionParamsSchema, SuggestionPatchSchema, SuggestionSubmitSchema, SuggestionSubmittedSchema, SuggestionViewSchema, SuggestionWithdrawnSchema, type EvidenceItemView, type SuggestionCreated, type SuggestionScoring, type SuggestionSubmitted, type SuggestionView, type SuggestionWithdrawn } from "@/lib/schemas/suggestions";
import { evidencePrefix } from "@/lib/schemas/storage";
import { GRADE_EVIDENCE_WORKFLOW, gradeEvidenceWorkflowId, SUGGESTION_REVISED_SIGNAL, SUGGESTION_WITHDRAWN_SIGNAL, SUGGESTION_WORKFLOW, suggestionWorkflowId, type WithdrawnSignal } from "@/lib/schemas/workflows";
import { removeObjectsUnder } from "@/lib/storage";
import { cancelWorkflow, signalWorkflow, startWorkflow, WorkflowNotFoundError, type StartedWorkflow } from "@/lib/workflows/client";

import { RECORD_POLL_MS, RECORD_WAIT_MS } from "./curation";

/*
 * The suggestion endpoints (feature-specs/31): intake, the part of Improve that refuses what does not say exactly
 * what would change and where, before anyone is paid to read it. Unit 48a is the draft's creation; 48b adds the
 * proposal, the read and the delete; 48d the submission.
 *
 * Nothing here calls a model (invariant 11): the anchor is rows of the release, the class is `classOf` on them,
 * the id is the chapter's next serial, and the thresholds are the published rubric's.
 */

/** TRD § 6.1: twenty drafts a day for a contributor, and twenty submissions, as the handler counts them. */
export const DRAFTS_A_DAY = { key: "user", limit: 20, windowS: 86_400 } as const;
/** Twenty submissions a person a day, as drafts are (31 § 3): the edit page's meta line says how many are spent. */
export const SUBMISSIONS_A_DAY = DRAFTS_A_DAY;
/** A suggestion's reads (31 § 4: 120 a minute); its owner's writes to a draft take the same, since the form's autosave is one a second at most (34 D3). */
export const SUGGESTION_RATE = { key: "user", limit: 120, windowS: 60 } as const;

/** TRD § 6.4's reason, as the throttle's detail carries it (31 § 6.3). */
const THROTTLE_REASON = "3 declines for unverifiable evidence in 30 days";

export interface SuggestionEndpointDeps {
  readonly standing: (user: SessionUser) => Promise<ContributorStanding>;
  readonly release: () => Promise<{ readonly id: string }>;
  readonly anchor: (kind: ResolvedAnchor["kind"], id: string, locale: Locale) => Promise<ResolvedAnchor | null>;
  readonly rubric: () => Promise<RubricVersionRow | null>;
  readonly rubricById: (id: string) => Promise<RubricVersionRow | null>;
  readonly loadRubric: (version: string) => LoadedRubric;
  readonly createDraft: (user: SessionUser, draft: DraftInput) => Promise<SuggestionForUser>;
  readonly read: (user: SessionUser, id: string) => Promise<SuggestionForUser | null>;
  /** The suggestion once merged, which anyone may read (35 D2; unit 54d). */
  readonly readMerged: (id: string) => Promise<SuggestionForUser | null>;
  readonly update: (user: SessionUser, id: string, patch: DraftPatch) => Promise<SuggestionForUser | null>;
  readonly remove: (user: SessionUser, id: string) => Promise<DraftDeleted>;
  /** A pending item's grading cancelled; true when a run was there to cancel (32 § 8). */
  readonly cancelGrading: (itemId: string) => Promise<boolean>;
  /** Every object a suggestion's evidence stored, removed (45 § 4); true when something was there. */
  readonly removeEvidence: (suggestionId: string) => Promise<boolean>;
  /** The pinned release's version of a chapter, for the anchor sensor's sentence when the anchor is gone. */
  readonly chapterVersion: (chapterNumber: number) => Promise<{ readonly id: string; readonly version: string } | null>;
  readonly start: (suggestionId: string) => Promise<StartedWorkflow>;
  /** A revision, with the `decidedAt` of the decision it answers (33 § 20). */
  readonly signalRevised: (workflowId: string, decidedAt: Date) => Promise<void>;
  /** A contributor's request to withdraw, written on the row before the workflow is told (45 § 5.2): the decision it was made against, or why not. */
  readonly requestWithdrawal: (user: SessionUser, id: string, at: Date) => Promise<WithdrawalRequested>;
  /** That request taken back, as it was; whether there was one to take back. */
  readonly takeBackWithdrawal: (user: SessionUser, id: string, at: Date) => Promise<boolean>;
  readonly signalWithdrawn: (workflowId: string, withdrawn: WithdrawnSignal) => Promise<void>;
  /** The `retracted` record under its step key, by its `seq`, once the workflow has written it. */
  readonly retracted: (suggestionId: string, stepKey: string) => Promise<number | null>;
  readonly pause: (ms: number) => Promise<void>;
  /** The person's consent to provenance, given now, put on file (31 § 6.2): before the workflow is started, so that its own move out of draft may be first (unit 50a). */
  readonly consent: (user: SessionUser) => Promise<void>;
  /** `DRAFT → SUBMITTED` with the workflow's id. */
  readonly submit: (user: SessionUser, id: string, workflowId: string) => Promise<{ readonly moved: boolean; readonly state: SuggestionForUser["state"] | null }>;
  /** A live suggestion with a proposal key (feature-specs/48 § 8.5): its id, or null. */
  readonly live: (user: SessionUser, proposalKey: string) => Promise<string | null>;
  /** Whether the caller may be told a suggestion's id as the one their draft doubles (48 § 8.5). */
  readonly visible: (user: SessionUser, suggestionId: string) => Promise<boolean>;
  readonly now: () => Date;
}

/**
 * The consent given now, on file before the workflow is started (31 § 6.2; unit 50a). Since 50a the workflow's own
 * move out of draft holds invariant 25 in its query — the contributor verified, their consent on file — so the
 * consent goes first: the workflow's catch-up move (31 § 6.1) is then allowed the moment it runs, and a submission
 * whose endpoint is slow or never makes its move still leaves draft with the consent behind it. A start that fails
 * leaves the consent on file and the suggestion a draft; the consent was the person's all the same.
 */
export async function recordConsent(user: SessionUser, at: Date): Promise<void> {
  await withSystem(() => getPrisma().user.updateMany({ where: { id: user.id, provenanceConsentAt: null }, data: { provenanceConsentAt: at } }));
}

/** The person's own move out of draft (31 § 6.1 step 6), after the start; the workflow may have made it first. */
async function submitDraft(user: SessionUser, id: string, workflowId: string, at: Date): Promise<{ readonly moved: boolean; readonly state: SuggestionForUser["state"] | null }> {
  return withSystem(() => transition(callerOf(user), id, "DRAFT", "SUBMITTED", { submittedAt: at, workflowId }));
}

const DEPS: SuggestionEndpointDeps = {
  standing: (user) => contributorStandingOf(user),
  release: () => currentRelease(),
  anchor: (kind, id, locale) => resolveAnchor(kind, id, locale),
  rubric: () => currentRubricVersion(),
  rubricById: (id) => readRubricVersion(id),
  loadRubric: (version) => loadRubric(version),
  createDraft: (user, draft) => createDraft(callerOf(user), draft),
  read: (user, id) => readSuggestion(callerOf(user), id),
  readMerged: (id) => readMergedSuggestion(id),
  update: (user, id, patch) => updateDraft(callerOf(user), id, patch),
  remove: (user, id) => deleteDraft(callerOf(user), id),
  cancelGrading: (itemId) => cancelEvidenceGrading(itemId),
  removeEvidence: (suggestionId) => removeObjectsUnder(evidencePrefix(suggestionId)),
  chapterVersion: (chapterNumber) => currentChapterVersion(chapterNumber),
  start: (suggestionId) => startWorkflow(SUGGESTION_WORKFLOW, suggestionWorkflowId(suggestionId), { suggestionId: suggestionId as SuggestionCreated["id"] }),
  signalRevised: (workflowId, decidedAt) => signalWorkflow(SUGGESTION_WORKFLOW, workflowId, SUGGESTION_REVISED_SIGNAL, { decidedAt: decidedAt.toISOString() }),
  requestWithdrawal: (user, id, at) => requestWithdrawal(callerOf(user), id, at),
  takeBackWithdrawal: (user, id, at) => takeBackWithdrawal(callerOf(user), id, at),
  signalWithdrawn: (workflowId, withdrawn) => signalWorkflow(SUGGESTION_WORKFLOW, workflowId, SUGGESTION_WITHDRAWN_SIGNAL, withdrawn),
  retracted: async (suggestionId, stepKey) => (await recordAt(suggestionId, "RETRACTED", stepKey))?.seq ?? null,
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  consent: (user) => recordConsent(user, new Date()),
  submit: (user, id, workflowId) => submitDraft(user, id, workflowId, new Date()),
  live: (user, key) => liveSuggestionWithKey(callerOf(user), key),
  visible: duplicateVisibleTo,
  now: () => new Date(),
};

/** An item's grading cancelled (32 § 8), for the item's delete and the draft's: true when a run was there to cancel. */
export async function cancelEvidenceGrading(itemId: string): Promise<boolean> {
  try {
    await cancelWorkflow(GRADE_EVIDENCE_WORKFLOW, gradeEvidenceWorkflowId(itemId));
    return true;
  } catch (error: unknown) {
    if (error instanceof WorkflowNotFoundError) return false;
    throw error;
  }
}

export function requireUser(session: SessionUser | null): SessionUser {
  if (session === null) throw new ApiError("NO_SESSION", "sign in to suggest a change");
  return session;
}

/** The throttle (31 § 6.3): a contributor with `throttledUntil` in the future creates and submits nothing until then. */
export async function refuseIfThrottled(deps: Pick<SuggestionEndpointDeps, "standing" | "now">, user: SessionUser): Promise<ContributorStanding> {
  const standing = await deps.standing(user);
  if (standing.throttledUntil !== null && standing.throttledUntil > deps.now()) {
    throw new ApiError("SUGGESTION_THROTTLED", "suggestions are paused for this account", { throttledUntil: standing.throttledUntil.toISOString(), reason: THROTTLE_REASON });
  }
  return standing;
}

/** The rubric in force, loaded; a deployment with none published cannot take a suggestion. */
export async function rubricInForce(deps: Pick<SuggestionEndpointDeps, "rubric" | "loadRubric">): Promise<LoadedRubric> {
  const row = await deps.rubric();
  if (row === null) throw new ApiError("INTERNAL", "no rubric is published");
  const loaded = deps.loadRubric(row.id);
  if (loaded.sha256 !== row.sha256) throw new ApiError("INTERNAL", `rubric ${row.id} is published with sha256 ${row.sha256.slice(0, 12)}… and the file here is ${loaded.sha256.slice(0, 12)}…`);
  return loaded;
}

/** The rubric a row was written against, loaded and checked against its row: what its thresholds are read from. */
async function rubricOf(deps: Pick<SuggestionEndpointDeps, "rubricById" | "loadRubric">, version: string): Promise<LoadedRubric> {
  const row = await deps.rubricById(version);
  if (row === null) throw new ApiError("INTERNAL", `rubric ${version} is not published`);
  const loaded = deps.loadRubric(version);
  if (loaded.sha256 !== row.sha256) throw new ApiError("INTERNAL", `rubric ${version} is published with sha256 ${row.sha256.slice(0, 12)}… and the file here is ${loaded.sha256.slice(0, 12)}…`);
  return loaded;
}

type StoredAnchor = NonNullable<SuggestionForUser["anchor"]>;

/** The anchor's id as the reader prints it: the figure's, the row's, or the section's. */
const anchorIdOf = (anchor: StoredAnchor): string => anchor.figureAnchor ?? anchor.sourceRowAnchor ?? anchor.sectionAnchor;

const localeOf = (lang: SuggestionForUser["locale"]): Locale => (lang === "PT" ? "pt" : "en");

/**
 * The suggestion as the policy sees it: its owner, its parts, its class and its origin (29 § 6.2). Read through the
 * door with the caller's own condition, so what the caller may not read is not there, and the policy is asked all
 * the same for what is (invariant 23).
 */
export async function resourceOf(deps: Pick<SuggestionEndpointDeps, "read">, session: SessionUser | null, id: string): Promise<PolicyResource> {
  const row = await deps.read(requireUser(session), id);
  if (row === null) throw new ApiError("NOT_FOUND", `suggestion ${id} is not here, or not yours to read`);
  return { kind: "suggestion", id: row.id, ownerId: row.userId, parts: row.parts, changeClass: row.changeClass, origin: row.origin };
}

/**
 * The suggestion's score and predicted outcome on this read (32 § 8; 30 § 3.3, § 4.4), from the graded items and the
 * sensors' verdicts as they stand, by `lib/rubric` and nothing else (invariant 8): the form displays and computes
 * nothing. Null while no item is graded. An item's publisher, for corroboration, is its host's registrable domain,
 * as independence reads it (32 § 7.4); an upload has none.
 */
export function scoringOf(rubric: LoadedRubric["rubric"], row: Pick<SuggestionForUser, "changeClass" | "evidence" | "sensorVerdicts">, fastMoving: boolean): SuggestionScoring | null {
  const { graded, items } = gradedItemsOf(row.evidence);
  if (graded.length === 0) return null;
  const score = scoreOf(rubric, items);
  const strongest = graded.find((item) => item.id === score.strongestId);
  const prediction = predict(rubric, { changeClass: row.changeClass, score: score.score, verdicts: row.sensorVerdicts.map((verdict) => ({ sensor: verdict.sensor, result: verdict.result })), strongestTier: strongest?.tier ?? null });
  return {
    score: score.score,
    strongestItemId: score.strongestId,
    corroboratedById: score.corroboratedById,
    gradedItems: graded.length,
    pendingItems: row.evidence.length - graded.length,
    prediction: { route: prediction.route, decision: prediction.decision, namedTier: prediction.namedTier, acceptAt: prediction.acceptAt, floorAt: prediction.floorAt, shortBy: prediction.shortBy },
    wouldSuffice: wouldSuffice(rubric, items, row.changeClass, fastMoving).map(({ tier, adjusted, withinDays, by, bonus, score: reached }) => ({ tier, adjusted, withinDays, by, bonus, score: reached })),
  };
}

const isoOf = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * An evidence item as the view shows it (31 § 4; 32 § 4), from its row: what the read, a save's answer and the add's
 * answer all carry. While it is pending its stage is read from what the grading workflow's activities have written
 * (32 § 8): nothing fetched is `1 of 3`, fetched with no text stored `2 of 3`, the text stored `3 of 3` (the grade, or
 * a wait at the budget cap, whose reason the row holds).
 */
export function itemViewOf(item: SuggestionForUser["evidence"][number]): EvidenceItemView {
  return {
    id: item.id,
    ordinal: item.ordinal,
    kind: item.kind,
    state: item.state,
    url: item.url,
    doi: item.doi,
    fileName: item.fileName,
    labRunId: item.labRunId,
    title: item.title,
    host: item.host,
    publishedOn: isoOf(item.publishedOn),
    ageDays: item.ageDays,
    fetchStatus: item.fetchStatus,
    tier: item.tier,
    baseScore: item.baseScore,
    relevance: item.relevance === null ? null : Number(item.relevance),
    recency: item.recency === null ? null : Number(item.recency),
    independence: item.independence === null ? null : Number(item.independence),
    adjustedScore: item.adjustedScore,
    reason: item.reason,
    gradedBy: item.gradedBy,
    gradedAt: isoOf(item.gradedAt),
    stage: item.state !== "PENDING" ? null : item.fetchStatus === null ? "1 of 3" : item.textKey === null ? "2 of 3" : "3 of 3",
  };
}

/** The suggestion as its owner or a curator reads it (31 § 4), with the thresholds of the rubric it was written against and who else reads its anchor. */
async function viewOf(deps: Pick<SuggestionEndpointDeps, "rubricById" | "loadRubric" | "anchor">, user: SessionUser | null, row: SuggestionForUser): Promise<SuggestionView> {
  if (row.anchor === null) throw new ApiError("INTERNAL", `suggestion ${row.id} has no anchor`);
  const { rubric } = await rubricOf(deps, row.rubricVersionId);
  const threshold = rubric.thresholds[row.changeClass];
  const resolved = await deps.anchor(row.anchor.kind, anchorIdOf(row.anchor), localeOf(row.locale));
  const proposal = row.proposal === null ? null : ProposalSchema.parse(row.proposal);
  const fastMoving = fastMovingOf(proposal, resolved?.fastMoving ?? false);
  return {
    id: row.id as SuggestionView["id"],
    origin: row.origin,
    own: user !== null && row.userId === user.id,
    fromResearch: row.fromResearch,
    state: row.state,
    outcome: row.outcome,
    changeKind: row.changeKind,
    changeClass: row.changeClass,
    curatorReason: row.curatorReason,
    thresholds: { acceptAt: threshold === null ? null : threshold.acceptAt, floorAt: threshold === null ? null : threshold.floorAt },
    fastMoving,
    rubricVersion: row.rubricVersionId,
    locale: localeOf(row.locale),
    chapter: row.chapterNumber,
    release: row.releaseId,
    anchor: {
      kind: row.anchor.kind,
      id: anchorIdOf(row.anchor),
      section: row.anchor.sectionAnchor as SuggestionView["anchor"]["section"],
      currentText: row.anchor.currentText,
      contentSha256: row.anchor.contentSha256,
      existsAtVersion: row.anchor.existsAtVersion,
      readBy: (resolved?.readBy ?? []).map((entry) => ({ section: entry.section as SuggestionView["anchor"]["section"], title: entry.title })),
    },
    proposal,
    rationale: row.rationale,
    score: row.score,
    scoring: scoringOf(rubric, row, fastMoving),
    evidence: row.evidence.map(itemViewOf),
    sensors: row.sensorVerdicts.map((verdict) => ({ sensor: verdict.sensor, result: verdict.result, detail: verdict.detail, createdAt: verdict.createdAt.toISOString() })),
    adjudication:
      row.adjudication === null
        ? null
        : {
            decision: row.adjudication.decision,
            decidedBy: DeciderSchema.parse(row.adjudication.decidedBy),
            score: row.adjudication.score,
            acceptAt: row.adjudication.acceptAt,
            floorAt: row.adjudication.floorAt,
            sufficientTier: row.adjudication.sufficientTier,
            failingSensor: row.adjudication.failingSensor,
            guideVersion: row.adjudication.guideVersion,
            modelId: row.adjudication.modelId,
            rubricVersion: row.adjudication.rubricVersionId,
            decidedAt: row.adjudication.decidedAt.toISOString(),
            criteria: row.criteria.map((criterion) => ({ criterion: CriterionSchema.parse(criterion.criterion), verdict: criterion.verdict, reason: criterion.reason })),
          },
    createdAt: row.createdAt.toISOString(),
    submittedAt: isoOf(row.submittedAt),
    decidedAt: isoOf(row.decidedAt),
    closedAt: isoOf(row.closedAt),
    withdrawnAt: isoOf(row.withdrawnAt),
    budgetResetsAt: isoOf(row.budgetResetsAt),
    merge: mergeViewOf(row.merge, user?.role === "CURATOR"),
  };
}

/**
 * The suggestion's merge as its view carries it (37 § 4, § 6; unit 54b): a row of no known form reads as none begun.
 * A step's error and the repository's absence are in the operator's words, which name the server's folders: a reader
 * who is not a curator, the contributor on their own page, has the step, its code and the state, and not the words.
 */
function mergeViewOf(merge: SuggestionForUser["merge"], curator: boolean): SuggestionView["merge"] {
  if (merge === null) return null;
  const parsed = MergeCheckSchema.safeParse(merge.check);
  const check = !parsed.success ? null : curator ? parsed.data : parsed.data.stage === "ERROR" ? { ...parsed.data, message: "" } : parsed.data.stage === "UNAVAILABLE" ? { ...parsed.data, reason: "" } : parsed.data;
  const bump = z.enum(["patch", "minor", "major"]).safeParse(merge.bump);
  return { branch: merge.branch, commitSha: merge.commitSha, versionFrom: merge.versionFrom, versionTo: merge.versionTo, bump: bump.success ? bump.data : "patch", releaseFrom: merge.releaseFrom, releaseTo: merge.releaseTo, mergedAt: isoOf(merge.mergedAt), revertedBy: merge.revertedBy, check };
}

/**
 * The suggestion as `GET /suggestions/{id}` answers it, read through the door with the caller's own condition: what
 * the endpoint returns, and what the edit page renders, so that every number on the page is the read's (34 § 5).
 * Null where the caller may not read it.
 */
export async function readSuggestionView(user: SessionUser, id: string, deps: Pick<SuggestionEndpointDeps, "read" | "rubricById" | "loadRubric" | "anchor"> = DEPS): Promise<SuggestionView | null> {
  const row = await deps.read(user, id);
  return row === null ? null : viewOf(deps, user, row);
}

/**
 * A researcher's proposal as the reader who asked reads it (feature-specs/43 § 8, D7, D12; unit 60e): the suggestion a
 * `PROPOSED` finding of their own names — the one direction that link is followed — as a service reads it, with no
 * owner; nobody's own, the merge's operator words left out. Null for anyone else and for anything else.
 */
export async function readAskerProposal(user: SessionUser, id: string): Promise<SuggestionForUser | null> {
  if (!(await askerOfProposal(user, id))) return null;
  const [row] = await readProposalsForAsker(callerOf(user), [id]);
  /* a researcher's proposal is nobody's, and never drafted from a finding: that is a person's draft (48 § 8.6) */
  return row === undefined ? null : { ...row, userId: null, fromResearch: false };
}

export async function readAskerProposalView(user: SessionUser, id: string, deps: Pick<SuggestionEndpointDeps, "rubricById" | "loadRubric" | "anchor"> = DEPS): Promise<SuggestionView | null> {
  const row = await readAskerProposal(user, id);
  return row === null ? null : viewOf(deps, null, row);
}

/** A closed researcher's proposal as a curator reads it whatever its parts (43 D6; unit 60e): the research log opens it. */
export async function readClosedResearchView(user: SessionUser, id: string, deps: Pick<SuggestionEndpointDeps, "rubricById" | "loadRubric" | "anchor"> = DEPS): Promise<SuggestionView | null> {
  const row = await readClosedResearchProposal(callerOf(user), id);
  return row === null ? null : viewOf(deps, user, row);
}

/**
 * A merged suggestion as anyone reads it (35 D2; unit 54d): the chapter's history links to its record. Nobody's own,
 * and the merge's operator words left out, as for any reader who is not a curator. Null for one that is not merged.
 */
export async function readMergedSuggestionView(id: string, deps: Pick<SuggestionEndpointDeps, "readMerged" | "rubricById" | "loadRubric" | "anchor"> = DEPS): Promise<SuggestionView | null> {
  const row = await deps.readMerged(id);
  return row === null ? null : viewOf(deps, null, row);
}

/**
 * The figure's facts the class reads (rules 2 and 5), from the release where the anchor still is; where it is not,
 * from what the draft's class already says, so that a release that moved under a draft does not reclassify it
 * before the `ANCHOR_EXISTS` sensor has refused it. For a section, the text rule 3 reads is the passage the
 * proposal quotes (31 § 11); a figure's or a row's own text is read as at creation.
 */
function classAnchorOf(row: SuggestionForUser, anchor: StoredAnchor, resolved: ResolvedAnchor | null, anchoredPassage: string): ClassAnchor {
  const figure =
    anchor.kind !== "FIGURE"
      ? null
      : resolved !== null && resolved.figureAnchor !== null
        ? { tier: resolved.tier ?? "OPEN", scenarioParam: resolved.scenarioParam }
        : { tier: row.changeClass === "DERIVED_FIGURE" ? ("DERIVED" as const) : ("OPEN" as const), scenarioParam: row.curatorReason === "SCENARIO_PARAMETER" };
  return { kind: anchor.kind, figure, text: anchor.kind === "SECTION" ? anchoredPassage : anchor.currentText };
}

/** Whether a suggestion is in a state that takes new evidence and a submission again (31 § 6.5). */
export function revisable(row: SuggestionForUser): boolean {
  return takesRevision(row.state, row.outcome);
}

/**
 * The four intake sensors on the suggestion's rows (31 § 5, § 6.1 step 4): the anchor resolved again against the
 * pinned release, the section's figures with it, the items and the rationale as they stand. Pure functions on what
 * is read here; the workflow runs the same on its own reads (50a).
 */
async function intakeOf(deps: Pick<SuggestionEndpointDeps, "anchor" | "chapterVersion">, row: SuggestionForUser, anchor: StoredAnchor): Promise<ReadonlyArray<IntakeVerdict>> {
  const resolved = await deps.anchor(anchor.kind, anchorIdOf(anchor), localeOf(row.locale));
  const chapter = resolved === null ? await deps.chapterVersion(row.chapterNumber) : { id: resolved.chapterVersionId, version: resolved.chapterVersion };
  /* A person submits once their items are through the fetcher (31 § 6.1). */
  return intakeSensors(intakeFactsOf(row, anchor, resolved, chapter, true));
}

export function suggestionEndpoints(deps: SuggestionEndpointDeps = DEPS): {
  readonly suggestionCreate: Spec<undefined, undefined, typeof SuggestionCreateSchema, typeof SuggestionCreatedSchema>;
  readonly suggestionRead: Spec<typeof SuggestionParamsSchema, undefined, undefined, typeof SuggestionViewSchema>;
  readonly suggestionPatch: Spec<typeof SuggestionParamsSchema, undefined, typeof SuggestionPatchSchema, typeof SuggestionViewSchema>;
  readonly suggestionDelete: Spec<typeof SuggestionParamsSchema, undefined, undefined, typeof SuggestionDeletedSchema>;
  readonly suggestionSubmit: Spec<typeof SuggestionParamsSchema, undefined, typeof SuggestionSubmitSchema, typeof SuggestionSubmittedSchema>;
  readonly suggestionWithdraw: Spec<typeof SuggestionParamsSchema, undefined, undefined, typeof SuggestionWithdrawnSchema>;
} {
  return {
    suggestionSubmit: {
      path: "/api/v1/suggestions/{id}/submit",
      method: "POST",
      summary: "Submit a draft of one's own: consent, the four intake sensors, the workflow started, then the row marked submitted; a suggestion open for revision is signalled instead",
      auth: "session",
      role: "CONTRIBUTOR",
      params: SuggestionParamsSchema,
      body: SuggestionSubmitSchema,
      response: SuggestionSubmittedSchema,
      rateLimit: SUBMISSIONS_A_DAY,
      idempotent: true,
      policy: { action: "submit", resource: ({ session, params }) => resourceOf(deps, session, params.id) },
      run: async ({ session, params, body }) => {
        const user = requireUser(session);
        /* 2 the throttle; the daily limit is the pipeline's. */
        const standing = await refuseIfThrottled(deps, user);
        const row = await deps.read(user, params.id);
        if (row === null || row.anchor === null) throw new ApiError("NOT_FOUND", `suggestion ${params.id} is not here, or not yours`);
        const id = params.id;

        /* A suggestion already submitted: the running workflow, not a second one (31 § 10.4). */
        if (row.state !== "DRAFT" && !revisable(row)) {
          if (row.workflowId === null) throw new ApiError("CONFLICT", `suggestion ${id} is ${row.state}`, { state: row.state });
          const answer: SuggestionSubmitted = { id: row.id as SuggestionSubmitted["id"], state: row.state, workflowId: row.workflowId };
          return answer;
        }

        /* 3 consent (invariant 25): on file, or given now. */
        const consentNow = standing.provenanceConsentAt === null;
        if (consentNow && !body.consent) throw new ApiError("CONSENT_REQUIRED", "a person's suggestion leaves draft with their consent to provenance", { consent: false });

        /* 4 the sensors: the first failure is the answer, and nothing is recorded. */
        const verdicts = await intakeOf(deps, row, row.anchor);
        const failed = verdicts.find((verdict) => verdict.result === "FAIL");
        if (failed !== undefined) throw new ApiError(`INTAKE_${failed.sensor}`, failed.detail, { sensor: failed.sensor, detail: failed.detail, data: failed.data });

        /* A draft from a research finding is checked against the live keys again (feature-specs/48 § 8.5; unit 74), at its
           current key, which an edit may have changed: a finding sent with the same key after the draft was made passed
           `createFromResearch`, which ignores drafts. Its id only where it is the caller's to see. A person's ordinary
           draft keeps today's rule: two people's drafts of one change are adjudicated each on its own. */
        if (row.state === "DRAFT" && row.fromResearch && row.proposalKey !== null) {
          const same = await deps.live(user, row.proposalKey);
          if (same !== null && same !== row.id) throw new ApiError("PROPOSAL_DUPLICATE", "the same change is already proposed in Improve", { suggestionId: (await deps.visible(user, same)) ? same : null });
        }

        /* A revision (31 § 6.5): the running workflow is told, and nothing is started. */
        if (row.state !== "DRAFT") {
          if (row.workflowId === null || row.decidedAt === null) throw new ApiError("CONFLICT", `suggestion ${id} is ${row.state} with no workflow or no decision to revise`, { state: row.state });
          try {
            await deps.signalRevised(row.workflowId, row.decidedAt);
          } catch (error: unknown) {
            if (error instanceof WorkflowNotFoundError) throw new ApiError("CONFLICT", `suggestion ${id}: its workflow has ended and cannot take a revision`, { state: row.state, workflowId: row.workflowId });
            throw error;
          }
          const revised: SuggestionSubmitted = { id: row.id as SuggestionSubmitted["id"], state: row.state, workflowId: row.workflowId };
          return revised;
        }

        /* The consent given now on file first, so that the workflow's own move out of draft may be first (invariant 25; unit 50a). */
        if (consentNow) await deps.consent(user);
        /* 5 the workflow first: if the engine does not answer this is a 503 and still a draft. */
        const started = await deps.start(id);
        /* 6 only then the row: a crash between the two leaves a running workflow whose first activity makes this same move. */
        const moved = await deps.submit(user, id, started.workflowId);
        const submitted: SuggestionSubmitted = { id: row.id as SuggestionSubmitted["id"], state: moved.moved ? "SUBMITTED" : (moved.state ?? "SUBMITTED"), workflowId: started.workflowId };
        return submitted;
      },
    },
    suggestionWithdraw: {
      path: "/api/v1/suggestions/{id}/withdraw",
      method: "POST",
      summary: "Withdraw a suggestion of one's own where its workflow waits for a person: the request written on the row, the workflow told, and its retracted record awaited; 202 while it records",
      auth: "session",
      role: "CONTRIBUTOR",
      params: SuggestionParamsSchema,
      response: SuggestionWithdrawnSchema,
      rateLimit: SUGGESTION_RATE,
      idempotent: true,
      policy: { action: "write", resource: ({ session, params }) => resourceOf(deps, session, params.id) },
      run: async ({ session, params, traceId }): Promise<SuggestionWithdrawn | Response> => {
        const user = requireUser(session);
        const id = params.id;
        /* 1 where it is: a person's, where its workflow waits for a person (45 § 5.1) */
        const row = await deps.read(user, id);
        if (row === null) throw new ApiError("NOT_FOUND", `suggestion ${id} is not here, or not yours`);
        const refused = (state: SuggestionForUser["state"]): ApiError => new ApiError("CONFLICT", `suggestion ${id} is ${state}: a suggestion is withdrawn only where it waits for a person`, { state, outcome: row.outcome });
        if (row.origin !== "HUMAN" || row.workflowId === null || !takesWithdrawal(row.state, row.outcome)) throw refused(row.state);
        const { workflowId } = row;

        /* 2 the request on the row, refused while a curator's action of this visit stands; the caller's own request already
           standing is that request, sent again with its instant — one whose signal never left is repaired so (review of unit 63) */
        const asked = await deps.requestWithdrawal(user, row.id, deps.now());
        if (!asked.requested) {
          if (asked.state === null) throw new ApiError("NOT_FOUND", `suggestion ${id} is not here, or not yours`);
          throw refused(asked.state);
        }
        const { at } = asked;

        /* 3 the workflow told, with the decision the request was made against; not told, the request is taken back as it was */
        try {
          await deps.signalWithdrawn(workflowId, { userId: user.id, at: at.toISOString(), decidedAt: asked.decidedAt === null ? null : asked.decidedAt.toISOString() });
        } catch (error: unknown) {
          const takenBack = await deps.takeBackWithdrawal(user, row.id, at).catch((undo: unknown) => {
            /* no sweep clears a request left standing: the line names it (45 § 9) */
            console.error("withdrawal: the request was not taken back after its signal failed", traceId, row.id, undo instanceof Error ? undo.message : String(undo));
            return true;
          });
          /* nothing to take back: the run took the signal as the engine's answer was late, and closed it (45 § 5.3) — its record is what answers */
          if (takenBack) {
            if (error instanceof WorkflowNotFoundError) throw new ApiError("CONFLICT", `suggestion ${id}: its workflow has ended and cannot take a withdrawal`, { state: row.state, workflowId });
            throw error;
          }
        }

        /* 4 the `retracted` record under the step key the workflow writes it with: then where the suggestion is, read again; or 202 while it
           records. The signal is delivered, so the run decides: a read that fails here answers 202 too (review of unit 63). */
        const stepKey = stepKeyOf(workflowId, `retracted:${at.toISOString()}`);
        try {
          for (let waited = 0; waited < RECORD_WAIT_MS; waited += RECORD_POLL_MS) {
            const seq = await deps.retracted(row.id, stepKey);
            if (seq !== null) {
              const after = await deps.read(user, id);
              const withdrawn: SuggestionWithdrawn = { id: row.id as SuggestionWithdrawn["id"], state: after?.state ?? row.state, ledgerSeq: seq };
              return withdrawn;
            }
            await deps.pause(RECORD_POLL_MS);
          }
        } catch (error: unknown) {
          console.warn("withdrawal: its record was not read after the signal was delivered", traceId, row.id, error instanceof Error ? error.message : String(error));
        }
        const recording: SuggestionWithdrawn = { id: row.id as SuggestionWithdrawn["id"], state: row.state, ledgerSeq: null };
        return new Response(JSON.stringify(recording), { status: 202, headers: { "content-type": "application/json; charset=utf-8" } });
      },
    },
    suggestionRead: {
      path: "/api/v1/suggestions/{id}",
      method: "GET",
      summary: "A suggestion as its owner or a curator of one of its parts reads it: anchor, proposal, evidence, score, and the sensors and adjudication once they exist",
      auth: "session",
      params: SuggestionParamsSchema,
      response: SuggestionViewSchema,
      rateLimit: SUGGESTION_RATE,
      policy: { action: "read", resource: ({ session, params }) => resourceOf(deps, session, params.id) },
      run: async ({ session, params }) => {
        const view = await readSuggestionView(requireUser(session), params.id, deps);
        if (view === null) throw new ApiError("NOT_FOUND", `suggestion ${params.id} is not here, or not yours to read`);
        return view;
      },
    },
    suggestionPatch: {
      path: "/api/v1/suggestions/{id}",
      method: "PATCH",
      summary: "Write the proposal and the rationale into a draft of one's own; the class and the thresholds come back recomputed. Idempotent by content",
      auth: "session",
      role: "CONTRIBUTOR",
      params: SuggestionParamsSchema,
      body: SuggestionPatchSchema,
      response: SuggestionViewSchema,
      rateLimit: SUGGESTION_RATE,
      policy: { action: "write", resource: ({ session, params }) => resourceOf(deps, session, params.id) },
      run: async ({ session, params, body }) => {
        const user = requireUser(session);
        const row = await deps.read(user, params.id);
        if (row === null || row.anchor === null) throw new ApiError("NOT_FOUND", `suggestion ${params.id} is not here, or not yours to read`);
        if (body.proposal !== undefined && body.proposal.kind !== row.changeKind) {
          throw new ApiError("CHANGE_KIND_INVALID", `the draft is a ${row.changeKind}; its proposal is one too`, { changeKind: row.changeKind, proposalKind: body.proposal.kind });
        }
        let patch: DraftPatch = { ...(body.rationale === undefined ? {} : { rationale: body.rationale }) };
        if (body.proposal !== undefined) {
          /* The class, again, from the anchor and what is now proposed: rule 3 reads the passage and the proposed text, rule 4 the tier (31 § 4). */
          const texts = proposalTexts(body.proposal);
          const resolved = await deps.anchor(row.anchor.kind, anchorIdOf(row.anchor), localeOf(row.locale));
          const classified = classOf(classAnchorOf(row, row.anchor, resolved, texts.anchoredPassage), row.changeKind, { text: texts.proposedText, sourceTier: texts.sourceTier });
          /* Recency follows a claim's or a row's declaration (30 § 3.4): graded items it now moves are scored again, in the same write (34 § 24). */
          const graded = row.evidence.some((item) => item.state === "GRADED" && item.recency !== null);
          const rescored = graded ? rescoredOf(row.evidence, (await rubricOf(deps, row.rubricVersionId)).rubric, fastMovingOf(body.proposal, resolved?.fastMoving ?? false)) : [];
          patch = {
            ...patch,
            proposal: {
              proposal: JSON.parse(JSON.stringify(body.proposal)) as Prisma.InputJsonValue,
              proposalKey: proposalKeyOf(row.anchor, body.proposal),
              changeClass: classified.changeClass,
              curatorReason: classified.curatorReason,
            },
            ...(rescored.length === 0 ? {} : { rescored }),
          };
        }
        const updated = await deps.update(user, params.id, patch);
        if (updated === null) {
          const what = body.proposal === undefined ? "a rationale changes on a draft or a suggestion open for revision" : "a proposal changes on a draft only";
          throw new ApiError("CONFLICT", `suggestion ${params.id} is ${row.state}: ${what}`, { state: row.state, outcome: row.outcome });
        }
        return viewOf(deps, user, updated);
      },
    },
    suggestionDelete: {
      path: "/api/v1/suggestions/{id}",
      method: "DELETE",
      summary: "Delete a draft of one's own, with everything it has; a suggestion past draft is a record and stays",
      auth: "session",
      role: "CONTRIBUTOR",
      params: SuggestionParamsSchema,
      response: SuggestionDeletedSchema,
      rateLimit: SUGGESTION_RATE,
      policy: { action: "write", resource: ({ session, params }) => resourceOf(deps, session, params.id) },
      run: async ({ session, params, traceId }) => {
        const user = requireUser(session);
        const deleted = await deps.remove(user, params.id);
        if (!deleted.deleted) {
          const row = await deps.read(user, params.id);
          if (row === null) throw new ApiError("NOT_FOUND", `suggestion ${params.id} is not here, or not yours`);
          throw new ApiError("CONFLICT", `suggestion ${params.id} is ${row.state}: only a draft is deleted`, { state: row.state });
        }
        /*
         * What the draft stored goes with it (feature-specs/45 § 4): each pending item's grading cancelled, and every
         * object under the draft's prefix removed, an upload never added as an item included. The draft is gone by now,
         * so neither is a refusal: a grading whose item is gone ends at its next step, and its own write then removes what
         * it stored; a failure here is logged with the trace.
         */
        for (const item of deleted.items.filter((each) => each.state === "PENDING")) {
          await deps.cancelGrading(item.id).catch((error: unknown) => console.warn("draft deleted: a grading was not cancelled", traceId, item.id, error instanceof Error ? error.message : String(error)));
        }
        await deps.removeEvidence(params.id).catch((error: unknown) => console.warn("draft deleted: its stored evidence was not removed", traceId, params.id, error instanceof Error ? error.message : String(error)));
        return { id: params.id, deleted: true as const };
      },
    },
    suggestionCreate: {
      path: "/api/v1/suggestions",
      method: "POST",
      summary: "Start a draft suggestion on a section, a figure or a source row of the pinned release: its anchor resolved, its class computed, its id allocated",
      auth: "session",
      role: "CONTRIBUTOR",
      body: SuggestionCreateSchema,
      response: SuggestionCreatedSchema,
      rateLimit: DRAFTS_A_DAY,
      idempotent: true,
      policy: { action: "create", resource: ({ session }) => ({ kind: "suggestion", id: null, ownerId: requireUser(session).id, origin: "HUMAN" }) },
      run: async ({ session, body }) => {
        const user = requireUser(session);
        await refuseIfThrottled(deps, user);

        if (body.anchor === undefined) throw new ApiError("ANCHOR_REQUIRED", "a suggestion points at a section, a figure or a source row");
        const allowed = ANCHOR_OF_CHANGE_KIND[body.changeKind];
        if (allowed !== body.anchor.kind) throw new ApiError("CHANGE_KIND_INVALID", `${body.changeKind} is made on a ${allowed.toLowerCase().replace("_", " ")}, not on a ${body.anchor.kind.toLowerCase().replace("_", " ")}`, { changeKind: body.changeKind, anchorKind: body.anchor.kind, allowed });

        const release = await deps.release();
        const anchor = await deps.anchor(body.anchor.kind, body.anchor.id, body.locale);
        if (anchor === null) throw new ApiError("ANCHOR_UNKNOWN", `${body.anchor.id} is not in the pinned release`, { release: release.id });

        const { rubric } = await rubricInForce(deps);
        /* The class, from the anchor alone: the proposal is not written yet, and 48b computes it again on every change
           of it. The text rule 3 reads of a section is the passage the proposal will quote, not the section's whole
           source: a chapter about a pump's work order would otherwise be the curator's at every line (31 § 10.2 has a
           draft on 21.3 as WORDING). A figure's or a row's own text is read now. */
        const judged = anchor.kind === "SECTION" ? "" : anchor.currentText;
        const classified = classOf({ kind: anchor.kind, figure: anchor.figureAnchor === null ? null : { tier: anchor.tier ?? "OPEN", scenarioParam: anchor.scenarioParam }, text: judged }, body.changeKind, { text: "", sourceTier: null });
        const parts: Part[] = [...new Set<Part>([anchor.part, ...anchor.readBy.map((entry) => entry.part)])];
        const draft = await deps.createDraft(user, {
          chapterNumber: anchor.chapterNumber,
          chapterVersionId: anchor.chapterVersionId,
          releaseId: anchor.releaseId,
          parts,
          changeKind: body.changeKind,
          changeClass: classified.changeClass,
          curatorReason: classified.curatorReason,
          locale: body.locale === "pt" ? "PT" : "EN",
          rubricVersionId: rubric.version,
          anchor: { kind: anchor.kind, sectionAnchor: anchor.sectionAnchor, figureAnchor: anchor.figureAnchor, sourceRowAnchor: anchor.sourceRowAnchor, currentText: anchor.currentText, contentSha256: anchor.contentSha256, existsAtVersion: true },
        });
        const threshold = rubric.thresholds[classified.changeClass];
        const created: SuggestionCreated = {
          id: draft.id as SuggestionCreated["id"],
          state: "DRAFT",
          changeKind: draft.changeKind,
          changeClass: draft.changeClass,
          curatorReason: draft.curatorReason,
          thresholds: { acceptAt: threshold === null ? null : threshold.acceptAt, floorAt: threshold === null ? null : threshold.floorAt },
          fastMoving: anchor.fastMoving,
          rubricVersion: rubric.version,
          anchor: {
            kind: anchor.kind,
            id: body.anchor.id,
            section: anchor.sectionAnchor as SuggestionCreated["anchor"]["section"],
            currentText: anchor.currentText,
            tier: anchor.tier,
            verifiedOn: anchor.verifiedOn === null ? null : anchor.verifiedOn.toISOString(),
            readBy: anchor.readBy.map((entry) => ({ section: entry.section as SuggestionCreated["anchor"]["section"], title: entry.title })),
          },
        };
        return created;
      },
    },
  };
}

export const { suggestionCreate, suggestionRead, suggestionPatch, suggestionDelete, suggestionSubmit, suggestionWithdraw } = suggestionEndpoints();
