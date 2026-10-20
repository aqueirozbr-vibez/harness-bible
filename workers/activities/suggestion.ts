import { ApplicationFailure } from "@temporalio/activity";

import { contributorForGrading, throttleContributor, type ContributorForGrading } from "@/lib/db/account";
import { researchPrincipalOf } from "@/workers/research/plan";
import { currentChapterVersion, releaseReadings, resolveAnchor, type ResolvedAnchor } from "@/lib/db/anchors";
import { adjudicationUsageOf, gradingUsageOf, type Usage } from "@/lib/db/budget";
import { getPrisma } from "@/lib/db/client";
import type { Prisma } from "@/lib/db/generated/client";
import { calibrationEventsBetween, clearAdjudication, contributorIdOf, currentParts, moveAlong, takeBackWithdrawal, withdrawalStands, openRubricReview, readCuratorAction, readRubricVersion, readSuggestionAsService, reopenSuggestion, transition, unverifiableDeclinesOf, widenParts, writeBudgetWait, writeAdjudication, writeCalibrationEvent, writeSensorVerdicts, writeSuggestionScore, type AdjudicationInput, type RubricVersionRow, type ServiceCaller, type SuggestionForService } from "@/lib/db/improve";
import { view } from "@/lib/db/ledger";
import { endorsementOf } from "@/lib/db/research";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { loadGuide, type Guide } from "@/lib/guides/load";
import type { Locale } from "@/lib/i18n/routing";
import { env } from "@/lib/env";
import { overrideRates, quarterOf, reviewsDue } from "@/lib/improve/calibration";
import { curatorPathOf, detailSha256Of, pathOf, ruleCriteria } from "@/lib/improve/decision";
import { standingEndorsementOf } from "@/lib/improve/endorsement";
import { fastMovingOf } from "@/lib/improve/proposal";
import { intakeFactsOf } from "@/lib/improve/intake";
import { throttleUntil, throttleWindowStart } from "@/lib/improve/throttle";
import { readingsOf } from "@/lib/improve/readings";
import { gradedItemsOf } from "@/lib/improve/scoring";
import { countWords } from "@/lib/improve/words";
import { canonicalize, type JsonValue } from "@/lib/ledger/canonical";
import { sha256Hex } from "@/lib/ledger/hash";
import { serviceSubject } from "@/lib/policy/input";
import { authorize } from "@/lib/policy/opa";
import { scoreOf, wouldSuffice } from "@/lib/rubric/score";
import { routeOf } from "@/lib/rubric/thresholds";
import { loadRubric, type LoadedRubric } from "@/lib/rubrics/load";
import type { Principal } from "@/lib/schemas/gateway";
import { ProposalSchema, takesRevision, type Criterion, type Decision } from "@/lib/schemas/improve";
import { CuratorPayloadSchema, EndorsedPayloadSchema, GradedPayloadSchema, HostSchema, RetractedPayloadSchema, SubmittedPayloadSchema } from "@/lib/schemas/ledger";
import type { ObjectKey } from "@/lib/schemas/storage";
import { consistencySensors } from "@/lib/sensors/consistency";
import { intakeSensors } from "@/lib/sensors/intake";
import { objectStore, type ObjectStore } from "@/lib/storage";
import { loadBook, type BookFiles } from "@/pipeline/build";
import { applyProposal } from "@/pipeline/edit/apply";
import { treeHash } from "@/pipeline/renderHash";
import { adjudicate, type AdjudicateInput, type Adjudicated } from "@/workers/agents/adjudicator/adjudicate";
import { recordedMismatch, type AdjudicatorInput, type RecordedHashes } from "@/workers/agents/adjudicator/assemble";

import type { AdjudicationOutcome, CuratorDecisionRecorded, DecisionRecorded, SuggestionActivities } from "../workflows/activities";
import { appendOnce, stepKeyOf } from "./ledger";

/*
 * SuggestionWorkflow's steps 1 to 4 (feature-specs/33 § 3; unit 50a). Each reads the suggestion through the door as
 * the service the spec names, writes its rows and its ledger record, and hands the engine ids, enumerations and
 * numbers only (28 § 5.3); each is idempotent on the row and the ledger, so the engine may run it again.
 *
 * Step 1 moves the draft out when the endpoint has not (31 § 6.1), a move the door makes only for a verified,
 * consenting contributor (invariant 25): a draft still waiting on the endpoint's own move is tried again. Its
 * `submitted` record is signed with the contributor's pseudonym (Andre, 2026-10-06: the intake activity is told the
 * id, as the grader is) or `service:researcher`, and says `verified` true for a person — no person's suggestion leaves
 * draft unverified — and null for a researcher's. The proposal is recorded as the sha256 of its canonical JSON (the
 * ledger's own RFC 8785 form, which the adjudicator's assembler recomputes, 33 § 5.2), the rationale as its sha256
 * and its word count, and each item's host only when it is a host name the record's schema takes.
 *
 * Step 2 runs the four intake sensors on the facts the submit endpoint builds (`intakeFactsOf`), with the anchor
 * resolved again against the release, and writes their verdicts as rows: the detail stays there.
 *
 * Step 3's record runs after the grader's own activities have graded what was pending. It scores the rows as the
 * view does (`gradedItemsOf`, `scoreOf`, the suggestion's own rubric, checked against its published hash), appends the
 * `graded` record — every item with its tier, factors, adjusted score, the sha256 of the grader's reason and of what
 * the grader read (the store's hash of the object under the item's `text` key), and the suggestion's grading calls'
 * tokens since its last `graded` record (Andre, 2026-10-06) — and only then writes the score, so the row follows the
 * ledger. A graded item with no fetch status, reason or grader is a corrupt row, and the step fails for it.
 *
 * Step 4 routes by `routeOf` with the same checked rubric and this attempt's verdicts, never the `Threshold` rows,
 * which hold no column for the derived class's single tier (30 § 13).
 *
 * Step 5 (unit 50c) runs the three consistency sensors on the release's rows and the book's files, writes their
 * verdicts as rows and adds to the suggestion's parts those its anchor's other readings reach (33 § 4.2, § 15). The
 * files are read where the book is kept (`BOOK_DIR`) and used only when their tree hash is the release's: the change
 * is applied to what was released, or `LINT` says it could not be. A row is dated by the run's day (50b's decision 4).
 *
 * Step 7 (unit 50d) is the adjudicator's one call, as `service:adjudicator`. The policy is asked first — `decide` for
 * a person's suggestion, `recommend` for a researcher's — and a refusal sends the suggestion to a curator with no call
 * (33 § 5.1). Then what was recorded: this run's `submitted` and `graded` records, each text a stranger wrote checked
 * against the hash its record holds and the score against the recorded one (§ 5.2). The prompt is built from the
 * rows — the anchor as the release has it now, the items with their factors and reasons, the arithmetic by the
 * suggestion's own rubric, the seven sensors as their rows say, a person's rationale and nothing that names them —
 * and the call is charged to the contributor's principal with the suggestion as its `ref` (§ 7). The decision and its
 * six criteria, or the one failure, named, are written as the suggestion's rows: only what they came to crosses the
 * engine (28 § 5.3). A budget refusal writes nothing and answers the reset and how long until it, which the run sleeps
 * (unit 50f).
 *
 * Steps 8 and 9 (unit 50e) record the decision, whoever made it: a rule's as its own `Adjudication`, decided by the
 * intake rules with six lines built from the grades (33 § 3.1); the adjudicator's as step 7 left it; the router's — a
 * class no score decides, a policy that refused the adjudicator — with no row, since no adjudicator saw it (36 § 4).
 * Then the `sensors` record (the verdicts that exist by then, the parts, one hash over the details) and the `decided`
 * record (the row's decision, thresholds and criteria with their reasons as hashes, the adjudicator's guide, model,
 * prompt and tokens), once each and in that order (33 § 6.2), and only then the moves to where the decision leaves
 * the suggestion (`pathOf`). A step run again finds each done.
 *
 * While the suggestion waits (part 2), three more. A curator's decision in the queue (33 § 6.3) appends the `curator`
 * record — signed with the curator's pseudonym, the note as its hash, the part the curator's roster met — and the
 * calibration event (36 § 6) in one step (invariant 17), each once for the action, then moves the suggestion
 * (`curatorPathOf`); an action of another suggestion, one past the queue, or one that is no queue's decision is
 * nothing to record. A revision's return (33 § 6.4) moves the suggestion back to `SUBMITTED` from a state that takes new
 * evidence and appends the attempt's own `submitted` record, so that its rationale and items as they now stand are
 * what the adjudicator's assembler checks. A contributor's withdrawal (feature-specs/45 § 5.3; unit 63e) appends the
 * `retracted` record, signed with the contributor's pseudonym, then closes the suggestion; one that no longer stands
 * records nothing and its request is taken back. A curator's decision recorded first ends a request standing with it.
 *
 * After a person's decline (unit 50f), by rule, by the adjudicator or by a curator, the throttle (33 § 7): the
 * contributor's suggestions declined in the last thirty days with every item graded `U` are counted, and at three the
 * contributor makes no new suggestion for thirty days. A researcher is never throttled.
 */

const INTAKE: ServiceCaller = { kind: "service", id: "service:intake" };
const GRADER: ServiceCaller = { kind: "service", id: "service:grader" };
const ADJUDICATOR: ServiceCaller = { kind: "service", id: "service:adjudicator" };

/** The adjudicator's guide, the first version here (33 § 5.1). */
export const ADJUDICATOR_GUIDE_VERSION = "v2.1";

export interface SuggestionActivityDeps {
  readonly store: () => ObjectStore;
  readonly anchor: (kind: ResolvedAnchor["kind"], id: string, locale: Locale) => Promise<ResolvedAnchor | null>;
  readonly chapterVersion: (chapterNumber: number) => Promise<{ readonly id: string; readonly version: string } | null>;
  readonly rubricVersion: (id: string) => Promise<RubricVersionRow | null>;
  readonly loadRubric: (version: string) => LoadedRubric;
  readonly contributor: (userId: string) => Promise<ContributorForGrading | null>;
  /** The platform's research principal (40 § 7.1): a researcher's suggestion is graded and adjudicated under it (42 § 3); null while unset. */
  readonly researchPrincipal: () => Principal | null;
  /** A reader's name on a proposal as their own row holds it, read in their context (42 § 6; unit 59's review). */
  readonly endorsement: (userId: string, suggestionId: string) => Promise<{ readonly createdAt: Date } | null>;
  readonly gradingUsage: (principal: Principal, suggestionId: string, since: Date | null) => Promise<Usage>;
  readonly adjudicationUsage: (principal: Principal, suggestionId: string, since: Date | null) => Promise<Usage>;
  readonly readings: typeof releaseReadings;
  /** The book's files as the content pipeline reads them; null when there is no book to read. */
  readonly book: () => BookFiles | null;
  readonly authorize: typeof authorize;
  readonly adjudicatorGuide: () => Guide;
  readonly adjudicate: (input: AdjudicateInput) => Promise<Adjudicated>;
  readonly now: () => Date;
}

/** The book where it is kept, or null when it is not there. */
function bookAt(dir: string): BookFiles | null {
  try {
    return loadBook(dir);
  } catch {
    return null;
  }
}

export const defaultSuggestionDeps = (): SuggestionActivityDeps => ({
  store: objectStore,
  anchor: resolveAnchor,
  chapterVersion: currentChapterVersion,
  rubricVersion: readRubricVersion,
  loadRubric,
  contributor: contributorForGrading,
  researchPrincipal: () => researchPrincipalOf(),
  endorsement: endorsementOf,
  gradingUsage: gradingUsageOf,
  adjudicationUsage: adjudicationUsageOf,
  readings: releaseReadings,
  book: () => bookAt(env.BOOK_DIR),
  authorize,
  adjudicatorGuide: () => loadGuide("adjudicator", ADJUDICATOR_GUIDE_VERSION),
  adjudicate: (input) => adjudicate(input),
  now: () => new Date(),
});

const failure = (message: string, code: string): ApplicationFailure => ApplicationFailure.nonRetryable(message, code);

async function read(caller: ServiceCaller, suggestionId: string, client?: Parameters<typeof readSuggestionAsService>[2]): Promise<SuggestionForService> {
  const row = await readSuggestionAsService(caller, suggestionId, client);
  if (row === null) throw failure(`${suggestionId}: no such suggestion`, "SUGGESTION_MISSING");
  return row;
}

/** The rules of the rubric a suggestion was written against, from the file, checked against the hash it was published with. */
async function rulesOf(deps: SuggestionActivityDeps, version: string): Promise<LoadedRubric["rubric"]> {
  const row = await deps.rubricVersion(version);
  if (row === null) throw failure(`rubric ${version} is not published`, "NO_RUBRIC");
  const loaded = deps.loadRubric(version);
  if (loaded.sha256 !== row.sha256) throw failure(`rubric ${version}: the file here is not the one published`, "NO_RUBRIC");
  return loaded.rubric;
}

const anchorIdOf = (anchor: NonNullable<SuggestionForService["anchor"]>): string => anchor.figureAnchor ?? anchor.sourceRowAnchor ?? anchor.sectionAnchor;

/** What this attempt recorded of the texts (33 § 5.2): its `submitted` record's hashes and its `graded` record's, with the score; null when either record is missing. */
function recordedOf(records: Awaited<ReturnType<typeof view>>, workflowId: string, attempt: number): (RecordedHashes & { readonly score: number }) | null {
  const submittedKey = stepKeyOf(workflowId, `submitted:${String(attempt)}`);
  const gradedKey = stepKeyOf(workflowId, `graded:${String(attempt)}`);
  let submitted = null;
  let graded = null;
  for (const record of records) {
    if (record.kind === "SUBMITTED") {
      const parsed = SubmittedPayloadSchema.safeParse(record.payload);
      if (parsed.success && parsed.data.stepKey === submittedKey) submitted = parsed.data;
    }
    if (record.kind === "GRADED") {
      const parsed = GradedPayloadSchema.safeParse(record.payload);
      if (parsed.success && parsed.data.stepKey === gradedKey) graded = parsed.data;
    }
  }
  if (submitted === null || graded === null) return null;
  return { proposalSha256: submitted.proposalSha256, rationaleSha256: submitted.rationaleSha256, reasonSha256: new Map(graded.items.map((item) => [item.id, item.reasonSha256])), score: graded.score };
}

const factorOf = (value: SuggestionForService["evidence"][number]["relevance"]): number | null => (value === null ? null : Number(value));

/**
 * An attempt's `submitted` record (33 § 3, step 1; § 6.4): the first at submission, a revision's at its return. It is
 * signed with the contributor's pseudonym, or `service:researcher`; the proposal is its canonical JSON's sha256, the
 * rationale its sha256 and word count, each item's host only in the form the record takes.
 */
async function appendSubmitted(row: SuggestionForService, workflowId: string, attempt: number): Promise<void> {
  const { anchor, proposal, proposalKey } = row;
  if (anchor === null) throw failure(`${row.id}: no anchor`, "NO_ANCHOR");
  if (proposal === null || proposalKey === null) throw failure(`${row.id}: no proposal`, "NO_PROPOSAL");
  let actor = "service:researcher";
  if (row.origin === "HUMAN") {
    const contributorId = await contributorIdOf(INTAKE, row.id);
    if (contributorId === null) throw failure(`${row.id}: its contributor's account is gone`, "CONTRIBUTOR_GONE");
    actor = `user:${contributorId}`;
  }
  const stepKey = stepKeyOf(workflowId, `submitted:${String(attempt)}`);
  await appendOnce(
    {
      kind: "SUBMITTED",
      actor,
      suggestionId: row.id,
      chapterVersionId: row.chapterVersionId,
      payload: {
        stepKey,
        rubricVersion: row.rubricVersionId,
        origin: row.origin,
        releaseId: row.releaseId,
        changeKind: row.changeKind,
        changeClass: row.changeClass,
        curatorReason: row.curatorReason,
        anchor: { kind: anchor.kind, section: anchor.sectionAnchor, figure: anchor.figureAnchor, sourceRow: anchor.sourceRowAnchor, chapterVersionId: row.chapterVersionId, contentSha256: anchor.contentSha256, existsAtVersion: anchor.existsAtVersion },
        proposalSha256: sha256Hex(canonicalize(proposal as JsonValue)),
        proposalKey,
        rationaleSha256: row.rationale === null ? null : sha256Hex(row.rationale),
        rationaleWords: countWords(row.rationale ?? ""),
        evidence: row.evidence.map((item) => ({ id: item.id, kind: item.kind, host: HostSchema.safeParse(item.host).success ? item.host : null, doi: item.doi })),
        verified: row.origin === "HUMAN" ? true : null,
      },
    },
    stepKey,
  );
}

/** What an attempt came to by its row: its decision, or the curator's when the row is a failure's or is not the attempt's. */
function outcomeOf(adjudication: SuggestionForService["adjudication"], traceId: string): AdjudicationOutcome {
  if (adjudication === null || adjudication.traceId !== traceId || adjudication.decision === "CURATOR_REVIEW") return { outcome: "FAILED" };
  return { outcome: "DECIDED", decision: adjudication.decision, sufficientTier: adjudication.sufficientTier };
}

/** A decision no model made spends nothing (33 § 3.1). */
const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

/** A rubric that cannot be loaded as published — `NO_RUBRIC`, which no retry mends — is what a step may go without; any other failure is retried. */
const unloadable = (error: unknown): boolean => error instanceof ApplicationFailure && error.type === "NO_RUBRIC";

/** The adjudicator's guide when it loads; null when loading it is what failed. */
function guideOrNull(deps: SuggestionActivityDeps): Guide | null {
  try {
    return deps.adjudicatorGuide();
  } catch {
    return null;
  }
}

/** The research principal as a researcher's suggestion's contributor (42 § 3): its key, no e-mail, no employer; null while unset, which the steps refuse as NO_PRINCIPAL. */
function researcherContributor(principal: Principal | null): ContributorForGrading | null {
  return principal === null ? null : { principal, verifiedEmail: null };
}

export function suggestionActivities(deps: SuggestionActivityDeps = defaultSuggestionDeps()): SuggestionActivities {
  return {
    async recordSubmitted(suggestionId, workflowId) {
      const moved = await transition(INTAKE, suggestionId, "DRAFT", "SUBMITTED", { submittedAt: deps.now(), workflowId });
      if (moved.state === null) throw failure(`${suggestionId}: no such suggestion`, "SUGGESTION_MISSING");
      if (moved.state === "DRAFT") throw ApplicationFailure.retryable(`${suggestionId}: still a draft, its consent not yet recorded by the endpoint's own move`, "STILL_A_DRAFT");

      const row = await read(INTAKE, suggestionId);
      await appendSubmitted(row, workflowId, 1);
      return { state: row.state };
    },

    async runIntake(suggestionId) {
      const row = await read(INTAKE, suggestionId);
      if (row.anchor === null) throw failure(`${suggestionId}: no anchor`, "NO_ANCHOR");
      const resolved = await deps.anchor(row.anchor.kind, anchorIdOf(row.anchor), row.locale === "PT" ? "pt" : "en");
      const chapter = resolved === null ? await deps.chapterVersion(row.chapterNumber) : { version: resolved.chapterVersion };
      /* Each item's form only: what is still pending is graded at step 3 (Andre, 2026-10-07). */
      const verdicts = intakeSensors(intakeFactsOf(row, row.anchor, resolved, chapter, false));
      const written = await writeSensorVerdicts(INTAKE, suggestionId, verdicts.map((verdict) => ({ sensor: verdict.sensor, result: verdict.result, detail: verdict.detail, data: verdict.data as Prisma.InputJsonValue })), deps.now());
      if (!written) throw failure(`${suggestionId}: not submitted`, "NOT_SUBMITTED");
      return verdicts.map(({ sensor, result }) => ({ sensor, result }));
    },

    async pendingItems(suggestionId) {
      const row = await read(INTAKE, suggestionId);
      return row.evidence.filter((item) => item.state === "PENDING").map((item) => item.id);
    },

    async recordGraded(suggestionId, workflowId, attempt, traceId) {
      /* The rows the score is computed from are read in one transaction (33 § 3.3). */
      const row = await getPrisma().$transaction((tx) => read(GRADER, suggestionId, tx));
      if (row.state !== "SUBMITTED") throw failure(`${suggestionId}: not submitted`, "NOT_SUBMITTED");
      if (row.evidence.some((item) => item.state === "PENDING")) throw failure(`${suggestionId}: an item is still pending`, "ITEM_PENDING");
      const rules = await rulesOf(deps, row.rubricVersionId);
      const { graded, items } = gradedItemsOf(row.evidence);
      if (graded.length !== row.evidence.length) throw failure(`${suggestionId}: an item is graded with no tier or no score`, "ITEM_INCOMPLETE");
      const scored = scoreOf(rules, items);
      const perItem = new Map(scored.perItem.map((entry) => [entry.id, entry]));

      const recorded = [];
      for (const item of graded) {
        const entry = perItem.get(item.id);
        if (entry === undefined || item.fetchStatus === null || item.reason === null || item.gradedBy === null) throw failure(`${item.id}: graded with no fetch status, reason or grader`, "ITEM_INCOMPLETE");
        /* What the grader read is the object under the item's `text` key; its hash is the store's (32 § 5, § 19). */
        const stored = item.textKey === null ? null : await deps.store().head(item.textKey as ObjectKey);
        /* A model's grade with what it read gone is not recorded as having read nothing. */
        if (item.textKey !== null && stored === null && item.gradedBy !== "intake-rules") throw failure(`${item.id}: what the grader read is not in the store`, "TEXT_MISSING");
        recorded.push({ id: item.id, kind: item.kind, fetchStatus: item.fetchStatus, tier: entry.tier, base: entry.base, relevance: entry.relevance, recency: entry.recency, independence: entry.independence, adjusted: entry.adjusted, gradedBy: item.gradedBy, reasonSha256: sha256Hex(item.reason), contentSha256: stored?.sha256 ?? null });
      }

      const stepKey = stepKeyOf(workflowId, `graded:${String(attempt)}`);
      const contributorId = row.origin === "HUMAN" ? await contributorIdOf(GRADER, suggestionId) : null;
      const contributor = row.origin === "RESEARCHER" ? researcherContributor(deps.researchPrincipal()) : contributorId === null ? null : await deps.contributor(contributorId);
      if (contributor === null) throw failure(`${suggestionId}: no principal its grading was charged to`, "NO_PRINCIPAL");
      const before = (await view({ suggestionId })).filter((record) => record.kind === "GRADED" && (record.payload as { readonly stepKey?: string }).stepKey !== stepKey);
      const usage = await deps.gradingUsage(contributor.principal, suggestionId, before.at(-1)?.createdAt ?? null);

      await appendOnce(
        {
          kind: "GRADED",
          actor: "service:grader",
          suggestionId,
          chapterVersionId: row.chapterVersionId,
          payload: { stepKey, rubricVersion: row.rubricVersionId, origin: row.origin, items: recorded, score: scored.score, strongestItemId: scored.strongestId, corroboratedById: scored.corroboratedById, usage, traceId },
        },
        stepKey,
      );
      if (!(await writeSuggestionScore(GRADER, suggestionId, scored.score))) throw failure(`${suggestionId}: not submitted when its score was written`, "NOT_SUBMITTED");
      return { score: scored.score, strongestTier: scored.strongestId === null ? null : (perItem.get(scored.strongestId)?.tier ?? null) };
    },

    async routeSuggestion(suggestionId, score, strongestTier, verdicts) {
      const row = await read(INTAKE, suggestionId);
      const rules = await rulesOf(deps, row.rubricVersionId);
      return routeOf(rules, { changeClass: row.changeClass, score, verdicts, strongestTier });
    },

    async runConsistency(suggestionId) {
      const row = await read(INTAKE, suggestionId);
      if (row.anchor === null) throw failure(`${suggestionId}: no anchor`, "NO_ANCHOR");
      const proposal = ProposalSchema.safeParse(row.proposal);
      if (!proposal.success) throw failure(`${suggestionId}: no proposal its kind reads`, "NO_PROPOSAL");
      const anchor = { kind: row.anchor.kind, id: anchorIdOf(row.anchor) };
      const release = await deps.readings(anchor.kind, anchor.id);
      const figure = anchor.kind === "FIGURE" ? (release.figures.find((f) => f.id === anchor.id) ?? null) : null;
      const files = deps.book();
      const applied = files === null || treeHash(files.allFiles) !== release.gitSha ? null : applyProposal(files, anchor, proposal.data, { on: deps.now() });
      const verdicts = consistencySensors({
        /* a lab run is refused as evidence until the IDE (32 § 3), so no suggestion has one */
        derive: { figure: figure === null ? null : { id: figure.id, tier: figure.tier }, proposed: proposal.data.kind === "SET_VALUE" ? proposal.data.after : null, labRuns: [] },
        crossChapter: { anchor: anchor.id, parts: row.parts, setsValue: proposal.data.kind === "SET_VALUE", readings: readingsOf(anchor, release.figures, release.references) },
        lint: { changeKind: row.changeKind, applied: applied === null ? null : "refused" in applied ? { refused: applied.refused, row: applied.row, detail: applied.detail } : { applied: true } },
      });
      const written = await writeSensorVerdicts(INTAKE, suggestionId, verdicts.map((verdict) => ({ sensor: verdict.sensor, result: verdict.result, detail: verdict.detail, data: verdict.data as Prisma.InputJsonValue })), deps.now());
      if (!written) throw failure(`${suggestionId}: not submitted`, "NOT_SUBMITTED");
      const parts = (verdicts.find((v) => v.sensor === "CROSS_CHAPTER")?.data as { readonly parts?: ReadonlyArray<SuggestionForService["parts"][number]> } | undefined)?.parts ?? [];
      if (parts.length > 0 && !(await widenParts(INTAKE, suggestionId, parts))) throw failure(`${suggestionId}: not submitted`, "NOT_SUBMITTED");
      return verdicts.map(({ sensor, result }) => ({ sensor, result }));
    },

    async adjudicateSuggestion(suggestionId, workflowId, attempt, traceId): Promise<AdjudicationOutcome> {
      const row = await read(ADJUDICATOR, suggestionId);
      if (row.state !== "SUBMITTED") throw failure(`${suggestionId}: not submitted`, "NOT_SUBMITTED");
      if (row.anchor === null) throw failure(`${suggestionId}: no anchor`, "NO_ANCHOR");
      const anchorId = anchorIdOf(row.anchor);

      /* A person's suggestion is the adjudicator's to decide, a researcher's only to recommend on (invariant 32). A refusal by the rules is the curator's, with no row. */
      const asked = await deps.authorize(serviceSubject(ADJUDICATOR.id), row.origin === "RESEARCHER" ? "recommend" : "decide", { kind: "curation", id: suggestionId, parts: [...row.parts], changeClass: row.changeClass, origin: row.origin }, { traceId, releaseId: row.releaseId });
      if (!asked.allow && asked.reason === "policy_deny") return { outcome: "REFUSED" };

      const rules = await rulesOf(deps, row.rubricVersionId);
      const threshold = rules.thresholds[row.changeClass];
      if (threshold === null) throw failure(`${suggestionId}: no score decides its class`, "NOT_ADJUDICABLE");
      const { graded, items } = gradedItemsOf(row.evidence);
      const scored = scoreOf(rules, items);
      const guide = deps.adjudicatorGuide();
      const decided = (over: Pick<AdjudicationInput, "decision" | "sufficientTier" | "failingSensor" | "modelId" | "promptSha256" | "failure">): AdjudicationInput => ({ decidedBy: "adjudicator", score: scored.score, acceptAt: threshold.acceptAt, floorAt: threshold.floorAt, guideVersion: guide.version, guideSha256: guide.sha256, rubricVersionId: row.rubricVersionId, decidedAt: deps.now(), traceId, ...over });
      /* The one failure (invariant 15): named on the row, and the suggestion is a curator's. */
      const failed = async (named: string, answered: { readonly model: string | null; readonly promptSha256: string | null } = { model: null, promptSha256: null }): Promise<AdjudicationOutcome> => {
        const written = await writeAdjudication(ADJUDICATOR, suggestionId, decided({ decision: "CURATOR_REVIEW", sufficientTier: null, failingSensor: null, modelId: answered.model, promptSha256: answered.promptSha256, failure: named }), []);
        if (!written) throw failure(`${suggestionId}: not submitted`, "NOT_SUBMITTED");
        return { outcome: "FAILED" };
      };

      /* A policy that could not be asked — the sidecar unreachable, an answer that is not one — denies (invariant 23) but refuses nothing: the adjudicator's failure, named. */
      if (!asked.allow) return failed(`the policy could not be asked (${asked.reason})`);
      const recorded = recordedOf(await view({ suggestionId }), workflowId, attempt);
      if (recorded === null) return failed("this run's submitted or graded record is missing");
      const mismatch = recordedMismatch({ proposal: row.proposal as JsonValue, rationale: row.rationale, reasons: graded.map((item) => ({ id: item.id, ordinal: item.ordinal, reason: item.reason ?? "" })) }, recorded);
      if (mismatch !== null) return failed(mismatch);
      if (scored.score !== recorded.score) return failed(`the score is ${String(scored.score)}, not the ${String(recorded.score)} its graded record holds`);
      const resolved = await deps.anchor(row.anchor.kind, anchorId, row.locale === "PT" ? "pt" : "en");
      if (resolved === null) return failed(`${anchorId} is not in the current release`);
      const fastMoving = fastMovingOf(row.proposal === null ? null : ProposalSchema.parse(row.proposal), resolved.fastMoving);

      const contributorId = row.origin === "HUMAN" ? await contributorIdOf(ADJUDICATOR, suggestionId) : null;
      const contributor = row.origin === "RESEARCHER" ? researcherContributor(deps.researchPrincipal()) : contributorId === null ? null : await deps.contributor(contributorId);
      if (contributor === null) throw failure(`${suggestionId}: no principal its adjudication is charged to`, "NO_PRINCIPAL");

      const ordinalOf = (id: string | null): number | null => graded.find((item) => item.id === id)?.ordinal ?? null;
      const sensors = row.sensorVerdicts.map(({ sensor, result, detail }) => ({ sensor, result, detail }));
      const prompt: AdjudicatorInput = {
        guide,
        rubric: rules,
        anchor: { kind: row.anchor.kind, id: anchorId, chapter: row.chapterNumber, text: resolved.currentText, fastMoving },
        change: { kind: row.changeKind, changeClass: row.changeClass, proposal: row.proposal as JsonValue },
        items: graded.map((item) => ({ ordinal: item.ordinal, kind: item.kind, tier: item.tier ?? "U", relevance: factorOf(item.relevance), recency: factorOf(item.recency), independence: factorOf(item.independence), adjusted: item.adjustedScore ?? 0, opened: (item.fetchStatus ?? "").startsWith("opened:"), reason: item.reason ?? "" })),
        arithmetic: { score: scored.score, acceptAt: threshold.acceptAt, floorAt: threshold.floorAt, onlyTier: threshold.onlyTier, strongest: ordinalOf(scored.strongestId), corroboratedBy: ordinalOf(scored.corroboratedById), wouldSuffice: wouldSuffice(rules, items, row.changeClass, fastMoving).map((sufficient) => sufficient.tier) },
        sensors,
        /* a researcher's note is never the adjudicator's to read (29 § 3; 42 § 3) */
        rationale: row.origin === "HUMAN" ? row.rationale : null,
        contributor: row.origin === "HUMAN" ? { verified: true } : null,
      };
      const strongestTier = graded.find((item) => item.id === scored.strongestId)?.tier ?? null;

      let answer: Adjudicated;
      try {
        answer = await deps.adjudicate({ prompt, call: { principal: contributor.principal, traceId, ref: suggestionId }, rules, routing: { changeClass: row.changeClass, score: scored.score, verdicts: sensors, strongestTier } });
      } catch (error: unknown) {
        if (error instanceof BudgetExceededError) return { outcome: "BUDGET", resetsAt: error.resetsAt.toISOString(), waitMs: Math.max(0, error.resetsAt.getTime() - deps.now().getTime()) };
        throw error;
      }
      if (!answer.ok) return failed(answer.failure, answer);
      const { output } = answer;
      const written = await writeAdjudication(
        ADJUDICATOR,
        suggestionId,
        decided({ decision: output.decision, sufficientTier: output.sufficientTier ?? null, failingSensor: output.failingSensor ?? null, modelId: answer.model, promptSha256: answer.promptSha256, failure: null }),
        output.criteria.map((line) => ({ criterion: line.name, verdict: line.verdict, reason: line.reason })),
      );
      if (!written) throw failure(`${suggestionId}: not submitted`, "NOT_SUBMITTED");
      return { outcome: "DECIDED", decision: output.decision, sufficientTier: output.sufficientTier ?? null };
    },

    async recordAdjudicatorFailure(suggestionId, traceId, code) {
      const row = await read(ADJUDICATOR, suggestionId);
      /* The adjudication may have written its row before the engine gave up on it: then that row stands. */
      if (row.adjudication?.traceId !== traceId) {
        /* What failed may be what the failure would quote — a rubric or a guide that is not the one published — so either may be missing. */
        const threshold = await rulesOf(deps, row.rubricVersionId).then(
          (rules) => rules.thresholds[row.changeClass],
          (error: unknown) => {
            if (!unloadable(error)) throw error;
            return null;
          },
        );
        const guide = guideOrNull(deps);
        /* False when the suggestion has left `SUBMITTED`: then there is no decision of this step to write. */
        await writeAdjudication(ADJUDICATOR, suggestionId, { decision: "CURATOR_REVIEW", decidedBy: "adjudicator", score: row.score ?? 0, acceptAt: threshold?.acceptAt ?? null, floorAt: threshold?.floorAt ?? null, sufficientTier: null, failingSensor: null, guideVersion: guide?.version ?? null, guideSha256: guide?.sha256 ?? null, modelId: null, promptSha256: null, failure: `the adjudication did not finish (${code})`, rubricVersionId: row.rubricVersionId, decidedAt: deps.now(), traceId }, []);
      }
      /* What stands for the attempt is its row's first write, whoever made it. */
      return outcomeOf((await read(ADJUDICATOR, suggestionId)).adjudication, traceId);
    },

    async recordDecision(suggestionId, workflowId, attempt, traceId, decided): Promise<DecisionRecorded> {
      const caller = decided.by === "adjudicator" ? ADJUDICATOR : INTAKE;
      const before = await read(caller, suggestionId);
      /* A rule decides by the rubric; the router's record and the adjudicator's missing row need only its thresholds, and go without them when loading it is what failed (33 § 18). */
      const rules = await rulesOf(deps, before.rubricVersionId).catch((error: unknown) => {
        if (decided.by === "intake-rules" || !unloadable(error)) throw error;
        return null;
      });
      /* The router's decision has no row: an earlier attempt's would otherwise stand for it (§ 6.4). */
      if (decided.by === "router" && before.adjudication !== null && before.state === "SUBMITTED" && !(await clearAdjudication(INTAKE, suggestionId))) throw failure(`${suggestionId}: not submitted`, "NOT_SUBMITTED");
      const threshold = rules?.thresholds[before.changeClass] ?? null;
      const ofTheAttempt = (row: SuggestionForService): SuggestionForService["adjudication"] => (row.adjudication?.traceId === traceId ? row.adjudication : null);

      /* The decision's rows: a rule's written here; the adjudicator's as step 7 left them, or as its failure when it left none; the router's are none. */
      if (decided.by !== "router" && ofTheAttempt(before) === null) {
        const base = { score: 0, acceptAt: threshold?.acceptAt ?? null, floorAt: threshold?.floorAt ?? null, guideVersion: null, guideSha256: null, modelId: null, promptSha256: null, rubricVersionId: before.rubricVersionId, decidedAt: deps.now(), traceId };
        let written: boolean;
        if (decided.by === "intake-rules") {
          if (rules === null) throw failure(`${suggestionId}: no rubric to decide by`, "NO_RUBRIC");
          const { graded, items } = gradedItemsOf(before.evidence);
          const scored = scoreOf(rules, items);
          const criteria = ruleCriteria({ scored, items: graded.map((item) => ({ id: item.id, ordinal: item.ordinal, reason: item.reason ?? "" })), threshold, decision: decided.decision, failingSensor: decided.failingSensor, namedTier: decided.namedTier });
          written = await writeAdjudication(INTAKE, suggestionId, { ...base, decision: decided.decision, decidedBy: "intake-rules", score: scored.score, sufficientTier: decided.namedTier, failingSensor: decided.failingSensor, failure: null }, criteria);
        } else {
          written = await writeAdjudication(ADJUDICATOR, suggestionId, { ...base, decision: "CURATOR_REVIEW", decidedBy: "adjudicator", score: before.score ?? 0, sufficientTier: null, failingSensor: null, failure: "the adjudication left no row of its attempt" }, []);
        }
        if (!written) throw failure(`${suggestionId}: not submitted`, "NOT_SUBMITTED");
      }
      const row = await read(caller, suggestionId);
      const adjudication = decided.by === "router" ? null : ofTheAttempt(row);
      if (decided.by !== "router" && adjudication === null) throw failure(`${suggestionId}: no row of this attempt's decision`, "NO_DECISION");
      const decision: Decision = adjudication?.decision ?? "CURATOR_REVIEW";
      const path = pathOf(decision, decided.by, row.origin);
      const to = path.at(-1) ?? "SUBMITTED";

      /*
       * The adjudicator's calls since this attempt's graded record, under the principal they were charged to (§ 7):
       * none to count once the contributor's account is gone, nor for a researcher's suggestion until its principal
       * exists (59b). Counted before either record is appended, so that nothing between the two can fail.
       */
      let usage = NO_USAGE;
      if (decided.by === "adjudicator") {
        const contributorId = row.origin === "HUMAN" ? await contributorIdOf(ADJUDICATOR, suggestionId) : null;
        const contributor = row.origin === "RESEARCHER" ? researcherContributor(deps.researchPrincipal()) : contributorId === null ? null : await deps.contributor(contributorId);
        if (contributor !== null) {
          const gradedKey = stepKeyOf(workflowId, `graded:${String(attempt)}`);
          const since = (await view({ suggestionId })).find((record) => record.kind === "GRADED" && (record.payload as { readonly stepKey?: string }).stepKey === gradedKey)?.createdAt ?? null;
          usage = await deps.adjudicationUsage(contributor.principal, suggestionId, since);
        }
      }

      /* The two records, once each and in that order (33 § 6.2): the verdicts that exist by then, then the decision. */
      const sensorsKey = stepKeyOf(workflowId, `sensors:${String(attempt)}`);
      await appendOnce(
        {
          kind: "SENSORS",
          actor: "service:intake",
          suggestionId,
          chapterVersionId: row.chapterVersionId,
          payload: { stepKey: sensorsKey, rubricVersion: row.rubricVersionId, origin: row.origin, verdicts: row.sensorVerdicts.map(({ sensor, result }) => ({ sensor, result })), parts: [...row.parts], detailSha256: detailSha256Of(row.sensorVerdicts) },
        },
        sensorsKey,
      );
      const decidedKey = stepKeyOf(workflowId, `decided:${String(attempt)}`);
      await appendOnce(
        {
          kind: "DECIDED",
          actor: decided.by === "adjudicator" ? "service:adjudicator" : "service:intake",
          suggestionId,
          chapterVersionId: row.chapterVersionId,
          payload: {
            stepKey: decidedKey,
            rubricVersion: row.rubricVersionId,
            origin: row.origin,
            decision,
            decidedBy: decided.by,
            score: adjudication?.score ?? row.score ?? 0,
            acceptAt: adjudication === null ? (threshold?.acceptAt ?? null) : adjudication.acceptAt,
            floorAt: adjudication === null ? (threshold?.floorAt ?? null) : adjudication.floorAt,
            sufficientTier: adjudication?.sufficientTier ?? null,
            failingSensor: adjudication?.failingSensor ?? null,
            criteria: (adjudication === null ? [] : row.criteria).map((line) => ({ name: line.criterion as Criterion, verdict: line.verdict, reasonSha256: sha256Hex(line.reason) })),
            guide: adjudication?.guideVersion != null && adjudication.guideSha256 != null ? { version: adjudication.guideVersion, sha256: adjudication.guideSha256 } : null,
            modelId: adjudication?.modelId ?? null,
            promptSha256: adjudication?.promptSha256 ?? null,
            usage,
            traceId,
          },
        },
        decidedKey,
      );

      const now = deps.now();
      /* A decision ends any wait at a budget cap, so a mark a wait left behind goes with the move. */
      const moved = await moveAlong(caller, suggestionId, path, { outcome: decision, decidedAt: now, budgetResetsAt: null, ...(to === "CLOSED" ? { closedAt: now } : {}) });
      if (moved.state !== to) throw failure(`${suggestionId}: ${moved.state ?? "gone"}, not ${to}, where its decision leaves it`, "NOT_MOVED");
      return { state: to, decision, sufficientTier: adjudication?.sufficientTier ?? null };
    },

    async recordCuratorDecision(suggestionId, workflowId, actionId): Promise<CuratorDecisionRecorded> {
      const action = await readCuratorAction(INTAKE, actionId);
      /* A seed's decision is never signalled, so never recorded (36 § 7.1): one that came here would be nothing to record. */
      if (action === null || action.suggestionId !== suggestionId || action.curatorId === null || action.seeded) return { recorded: false };
      const row = await read(INTAKE, suggestionId);
      const decided = curatorPathOf(action.action, row.origin);
      if (decided === null) return { recorded: false };
      const to = decided.path.at(-1) ?? "CURATOR_QUEUE";
      const stepKey = stepKeyOf(workflowId, `curator:${actionId}`);
      const recordedBefore = (await view({ suggestionId })).some((record) => record.kind === "CURATOR" && (record.payload as { readonly stepKey?: string }).stepKey === stepKey);
      /*
       * In the queue, an action of this visit: made since the suggestion entered it (`decidedAt`), not one of an
       * earlier visit sent again (33 § 20). Past the queue, only this step's own run before, which recorded the action
       * and moved the suggestion where it leaves it.
       */
      if (row.state === "CURATOR_QUEUE") {
        if (row.decidedAt !== null && action.createdAt < row.decidedAt) return { recorded: false };
      } else if (!recordedBefore || row.state !== to) return { recorded: false };

      /* The part the curator's roster met (29 § 6.1), when they decided: the record names one. */
      const rostered = await currentParts(action.curatorId, action.createdAt);
      const part = row.parts.find((candidate) => rostered.includes(candidate)) ?? row.parts[0];
      if (part === undefined) throw failure(`${suggestionId}: no part`, "NO_PART");
      /* An action whose code or criterion the record does not take is no decision to record: its endpoint (53c) refuses them, and a run that waited is not lost to one such row. */
      const payload = CuratorPayloadSchema.safeParse({ stepKey, rubricVersion: row.rubricVersionId, origin: row.origin, action: action.action, overrideCode: action.overrideCode, criterion: action.criterion, noteSha256: action.noteSha256, seeded: action.seeded, seedMatched: action.seedMatched, queueWaitMs: action.queueWaitMs, part });
      if (!payload.success) return { recorded: false };
      await appendOnce({ kind: "CURATOR", actor: `user:${action.curatorId}`, suggestionId, chapterVersionId: row.chapterVersionId, payload: payload.data }, stepKey);
      /* What the adjudicator said beside what the curator did: none where no adjudicator decided (36 § 5.2). */
      const adjudicated = row.adjudication?.decidedBy === "adjudicator" && row.adjudication.decision !== "CURATOR_REVIEW" ? row.adjudication : null;
      const now = deps.now();
      await writeCalibrationEvent(INTAKE, { suggestionId, curatorActionId: action.id, criterion: action.criterion, adjudicatorDecision: adjudicated?.decision ?? null, adjudicatorScore: adjudicated?.score ?? null, curatorAction: action.action, overrideCode: action.overrideCode, seeded: action.seeded, rubricVersionId: row.rubricVersionId, createdAt: now });
      /* A rubric review for each criterion whose rate this quarter has passed 20 % (36 § 6.3): one per criterion and quarter, so a step run again opens none twice. */
      const quarter = quarterOf(now);
      const rates = overrideRates(await calibrationEventsBetween(INTAKE, quarter.from, quarter.to));
      for (const criterion of reviewsDue(rates)) {
        const reading = rates.criteria.find((entry) => entry.criterion === criterion);
        if (reading?.rate != null) await openRubricReview(INTAKE, { criterion, quarter: quarter.label, rubricVersionId: row.rubricVersionId, rate: reading.rate, overridden: reading.overridden, reviewed: rates.reviewed });
      }

      /* a curator's decision recorded first ends a contributor's request to withdraw, should one stand (45 § 5.3) */
      const moved = await moveAlong(INTAKE, suggestionId, decided.path, { outcome: decided.decision, decidedAt: now, withdrawnAt: null, ...(to === "CLOSED" ? { closedAt: now } : {}) });
      if (moved.state !== to) throw failure(`${suggestionId}: ${moved.state ?? "gone"}, not ${to}, where the curator's decision leaves it`, "NOT_MOVED");
      return { recorded: true, state: to, decision: decided.decision };
    },

    async recordEndorsement(suggestionId, workflowId, endorsed) {
      const row = await read(INTAKE, suggestionId);
      /* a person's suggestion takes no endorsement: its contributor is its name (42 § 3) */
      if (row.origin !== "RESEARCHER") return { recorded: false };
      /* after the merged record the credit is written (42 § 6): nothing of a name follows it */
      const records = await view({ suggestionId });
      if (records.some((record) => record.kind === "MERGED")) return { recorded: false };
      /*
       * What the endpoint left, read again in the reader's own context, as a curator's action is before its record (unit
       * 59's review). A name is recorded while the row of that instant stands. A withdrawal takes back the name of that
       * instant: it is recorded while no row of that instant stands and the records' standing name is that one. A signal
       * the endpoint took back — the engine late to answer, the row removed or put back — or one overtaken by the reader's
       * next press records nothing, and the ledger says what the reader was left with.
       */
      const standing = await deps.endorsement(endorsed.userId, suggestionId);
      const rowOfThatInstant = standing !== null && standing.createdAt.toISOString() === endorsed.at;
      const named = standingEndorsementOf(records);
      const nameOfThatInstant = named !== null && named.actor === `user:${endorsed.userId}` && named.consentAt === endorsed.at;
      if (endorsed.withdrawn ? rowOfThatInstant || !nameOfThatInstant : !rowOfThatInstant) return { recorded: false };
      const stepKey = stepKeyOf(workflowId, `${endorsed.withdrawn ? "withdraw" : "endorse"}:${endorsed.at}`);
      const payload = EndorsedPayloadSchema.safeParse({ stepKey, consentAt: endorsed.at, withdrawn: endorsed.withdrawn });
      if (!payload.success) return { recorded: false };
      await appendOnce({ kind: "ENDORSED", actor: `user:${endorsed.userId}`, suggestionId, chapterVersionId: row.chapterVersionId, payload: payload.data }, stepKey);
      return { recorded: true };
    },

    async recordWithdrawal(suggestionId, workflowId, withdrawn) {
      const at = new Date(withdrawn.at);
      const stepKey = stepKeyOf(workflowId, `retracted:${withdrawn.at}`);
      /* a step run again after it recorded finds its record by its key and only finishes the move: it never judges the request twice */
      const recordedBefore = (await view({ suggestionId })).some((record) => record.kind === "RETRACTED" && (record.payload as { readonly stepKey?: string }).stepKey === stepKey);
      const row = await read(INTAKE, suggestionId);
      if (!recordedBefore) {
        /* the contributor's, holding the request of that instant, under the decision it was made against, still waiting for a person, no curator's action of this visit */
        const stands = await withdrawalStands(INTAKE, suggestionId, { userId: withdrawn.userId, at, decidedAt: withdrawn.decidedAt === null ? null : new Date(withdrawn.decidedAt) });
        const payload = RetractedPayloadSchema.safeParse({ stepKey, rubricVersion: row.rubricVersionId, origin: row.origin, from: row.state, outcome: row.outcome });
        if (!stands || !payload.success) {
          await takeBackWithdrawal(INTAKE, suggestionId, at);
          return { recorded: false };
        }
        await appendOnce({ kind: "RETRACTED", actor: `user:${withdrawn.userId}`, suggestionId, chapterVersionId: row.chapterVersionId, payload: payload.data }, stepKey);
      }
      if (row.state !== "CLOSED") {
        /* the outcome and the decision's time stay: a withdrawn decline still counts for the throttle (45 § 5.3); the request's instant is written again with the move */
        const moved = await moveAlong(INTAKE, suggestionId, [row.state, "CLOSED"], { closedAt: deps.now(), withdrawnAt: at });
        if (moved.state !== "CLOSED") throw failure(`${suggestionId}: ${moved.state ?? "gone"}, not CLOSED, where its withdrawal leaves it`, "NOT_MOVED");
      }
      return { recorded: true };
    },

    async markBudgetWait(suggestionId, resetsAt) {
      await writeBudgetWait(INTAKE, suggestionId, resetsAt === null ? null : new Date(resetsAt));
    },

    async throttleOnDecline(suggestionId) {
      const row = await read(INTAKE, suggestionId);
      if (row.origin !== "HUMAN" || row.outcome !== "DECLINE") return { throttledUntil: null };
      const contributorId = await contributorIdOf(INTAKE, suggestionId);
      if (contributorId === null) return { throttledUntil: null };
      const now = deps.now();
      const until = throttleUntil(await unverifiableDeclinesOf(INTAKE, contributorId, throttleWindowStart(now)), now);
      if (until === null) return { throttledUntil: null };
      await throttleContributor(contributorId, until);
      return { throttledUntil: until.toISOString() };
    },

    async reopenForRevision(suggestionId, workflowId, attempt, decidedAt) {
      const row = await read(INTAKE, suggestionId);
      /* `SUBMITTED` while the run waits is this step's own run before, which made the move: what is left is the record. */
      if (row.state !== "SUBMITTED") {
        /* A revision answers the decision that stands; one sent against an earlier decision answers none (33 § 20). */
        if (!takesRevision(row.state, row.outcome) || row.decidedAt?.toISOString() !== decidedAt) return { reopened: false };
        if ((await reopenSuggestion(INTAKE, suggestionId)).state !== "SUBMITTED") return { reopened: false };
      }
      /* The record of the row the move froze: a submitted suggestion takes no edit (31 § 6.5), so it says what the attempt reads. */
      await appendSubmitted(await read(INTAKE, suggestionId), workflowId, attempt);
      return { reopened: true };
    },
  };
}

export const suggestionActivitiesDefault: SuggestionActivities = suggestionActivities();
