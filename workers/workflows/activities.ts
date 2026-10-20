import type { ReleaseId, SuggestionId } from "@/lib/schemas/ids";
import type { EvidenceTier } from "@/lib/schemas/domain";
import type { Decision, SensorResult, SuggestionSensor, SuggestionState } from "@/lib/schemas/improve";
import type { Route } from "@/lib/schemas/rubric";
import type { FindingFailure, PlannerRefusal, ResearchState } from "@/lib/schemas/research";
import type { EndorsedSignal, WithdrawnSignal } from "@/lib/schemas/workflows";

/*
 * What workflow code asks of the world (feature-specs/28 § 4.2): the activities' types and nothing else. A workflow
 * calls an activity through `proxyActivities<…>()` with one of these interfaces; the functions themselves live in
 * workers/activities/, which a workflow file may not import, because they reach the database, the gateway and the
 * network and a workflow must be replayable from its history alone.
 *
 * An activity's arguments and its result are ids, enumerations, numbers, booleans, hashes and instants, never text
 * a person or a model wrote: the engine keeps every one of them (28 § 5.3).
 */

/**
 * GradeEvidenceWorkflow's three (feature-specs/32 § 8; unit 49e): fetch or open the item, extract and store the
 * text, grade. Each reads the item's row and writes to it; what crosses the engine is a code, a boolean or an
 * instant, never the document or the reason (28 § 5.3). `fetchItem` writes the `U` grade itself for an item that
 * could not be opened, so the workflow ends after it with no model called (§ 13.8). `gradeItem` answers `PENDING`
 * with the reset date when the principal's budget refused the grade (§ 8), the one failure that is not tier `U`.
 */
export interface EvidenceActivities {
  fetchItem(itemId: string): Promise<{ readonly opened: boolean; readonly fetchStatus: string }>;
  /** `text`: whether the grader has something to read — the stored text, or since unit 49f a checked copy of a PDF's or an image's source. */
  storeText(itemId: string): Promise<{ readonly text: boolean }>;
  /** At the cap, the reset and how long until it (unit 50f): the suggestion's run sleeps that long, the clock being the activity's. */
  gradeItem(itemId: string): Promise<{ readonly state: "GRADED"; readonly tier: EvidenceTier } | { readonly state: "PENDING"; readonly resetsAt: string; readonly waitMs: number }>;
}

/** A sensor's result as it crosses the engine: the sensor and the verdict, never the detail (28 § 5.3). */
export interface SensorOutcome {
  readonly sensor: SuggestionSensor;
  readonly result: SensorResult;
}

/**
 * What step 7 came to (feature-specs/33 § 5; unit 50d): the adjudicator's decision, with the tier that would suffice
 * for a request for more; its one failure, named in the suggestion's row; the policy's refusal, with no call; or the
 * principal's budget, which waits (50f).
 */
export type AdjudicationOutcome =
  | { readonly outcome: "DECIDED"; readonly decision: Exclude<Decision, "CURATOR_REVIEW">; readonly sufficientTier: EvidenceTier | null }
  | { readonly outcome: "FAILED" | "REFUSED" }
  /** The principal's cap, with the reset and how long until it (unit 50f): the run sleeps that long and asks again. */
  | { readonly outcome: "BUDGET"; readonly resetsAt: string; readonly waitMs: number };

/**
 * Who decided, as it crosses the engine (33 § 6; unit 50e): the intake rules, with the decision a rule makes and what it
 * rests on; the router, for a class no score decides and for a policy that refused the adjudicator; or the
 * adjudicator, whose row says what it decided or how it failed.
 */
export type Decided =
  | { readonly by: "intake-rules"; readonly decision: "DECLINE" | "REQUEST_MORE"; readonly failingSensor: SuggestionSensor | null; readonly namedTier: EvidenceTier | null }
  | { readonly by: "router" }
  | { readonly by: "adjudicator" };

/** Where a decision left the suggestion: its state, the decision, and the tier that would suffice. */
export interface DecisionRecorded {
  readonly state: SuggestionState;
  readonly decision: Decision;
  readonly sufficientTier: EvidenceTier | null;
}

/** What recording a curator's decision came to: nothing, for an action that is not this queue's to decide; or where it left the suggestion. */
export type CuratorDecisionRecorded = { readonly recorded: false } | { readonly recorded: true; readonly state: SuggestionState; readonly decision: Decision };

/**
 * SuggestionWorkflow's steps 1 to 4 (feature-specs/33 § 3; unit 50a), each as the service the spec names: 1, 2 and 4
 * as `service:intake`, and step 3's record as `service:grader`, which signs `graded`. Each is idempotent on the row
 * and the ledger, so the engine may run any of them again: a record is written once, by its step key. Step 3's
 * grading of an item still pending is GradeEvidenceWorkflow's three activities, which the workflow runs itself.
 */
export interface SuggestionActivities {
  /** Step 1: `DRAFT → SUBMITTED` with the workflow's id when the endpoint has not made the move, then the `submitted` record; the state the row is in after. */
  recordSubmitted(suggestionId: SuggestionId, workflowId: string): Promise<{ readonly state: SuggestionState }>;
  /** Step 2: the four intake sensors on the rows, their verdicts written as rows; each sensor's result, in the spec's order. */
  runIntake(suggestionId: SuggestionId): Promise<ReadonlyArray<SensorOutcome>>;
  /** The items still pending, in the order they were added. */
  pendingItems(suggestionId: SuggestionId): Promise<ReadonlyArray<string>>;
  /** Step 3's record: the score from the rows, the `graded` record of this attempt, and the score written; the score and its strongest item's tier. */
  recordGraded(suggestionId: SuggestionId, workflowId: string, attempt: number, traceId: string): Promise<{ readonly score: number; readonly strongestTier: EvidenceTier | null }>;
  /** Step 4: the route of the suggestion's class, its score and this attempt's verdicts, by its own rubric; the tier a rule names. */
  routeSuggestion(suggestionId: SuggestionId, score: number, strongestTier: EvidenceTier | null, verdicts: ReadonlyArray<SensorOutcome>): Promise<{ readonly route: Route; readonly namedTier: EvidenceTier | null }>;
  /** Step 5 (33 § 4.2; unit 50c): the three consistency sensors' verdicts written as rows, the parts a shared anchor reaches added; their results. */
  runConsistency(suggestionId: SuggestionId): Promise<ReadonlyArray<SensorOutcome>>;
  /** Step 7 (33 § 5; unit 50d), as `service:adjudicator`: the policy asked, the recorded texts checked, one frontier call, its decision or its failure written as rows; what it came to. */
  adjudicateSuggestion(suggestionId: SuggestionId, workflowId: string, attempt: number, traceId: string): Promise<AdjudicationOutcome>;
  /** Step 7 when that activity itself failed — threw, or ran out of time: the failure written as the adjudicator's by its code, unless the attempt's row is there; what the attempt's row then says it came to. */
  recordAdjudicatorFailure(suggestionId: SuggestionId, traceId: string, code: string): Promise<AdjudicationOutcome>;
  /** Steps 8 and 9 (33 § 6; unit 50e): a rule's decision written as rows, the `sensors` and `decided` records once each and in that order, and the moves to where the decision leaves the suggestion. */
  recordDecision(suggestionId: SuggestionId, workflowId: string, attempt: number, traceId: string, decided: Decided): Promise<DecisionRecorded>;
  /** The curator's decision (33 § 6.3; unit 50e): the `curator` record and the calibration event of the action the endpoint wrote, once each, then the move. */
  recordCuratorDecision(suggestionId: SuggestionId, workflowId: string, actionId: string): Promise<CuratorDecisionRecorded>;
  /** The reset the run sleeps until at a budget cap, or null when it wakes (33 § 7; unit 50f), on the suggestion's row for its page. */
  markBudgetWait(suggestionId: SuggestionId, resetsAt: string | null): Promise<void>;
  /** After a decline (33 § 7; unit 50f): a person's declines on unverifiable evidence counted, and the contributor throttled at the third; when until. */
  throttleOnDecline(suggestionId: SuggestionId): Promise<{ readonly throttledUntil: string | null }>;
  /** A reader's name on a researcher's proposal, or taken back (42 § 6; unit 59d): the `ENDORSED` record, once by its step, with the reader's pseudonym as actor. */
  recordEndorsement(suggestionId: SuggestionId, workflowId: string, endorsed: EndorsedSignal): Promise<{ readonly recorded: boolean }>;
  /**
   * A contributor's withdrawal where the run waits for a person (feature-specs/45 § 5.3; unit 63e): the `RETRACTED` record
   * once by its step, then `CLOSED`; or, where the request no longer stands, the request taken back and nothing recorded.
   */
  recordWithdrawal(suggestionId: SuggestionId, workflowId: string, withdrawn: WithdrawnSignal): Promise<{ readonly recorded: boolean }>;
  /** A revision's return (31 § 6.5; 33 § 6.4; unit 50e): back to `SUBMITTED` from a state that takes new evidence, and the attempt's `submitted` record; whether it returned. */
  reopenForRevision(suggestionId: SuggestionId, workflowId: string, attempt: number, decidedAt: string): Promise<{ readonly reopened: boolean }>;
}

/** Where a merge left the suggestion, when it is the merge's to say: its state and the decision that stands. */
export interface MergeLeft {
  readonly state: SuggestionState;
  readonly decision: Decision | null;
}

/**
 * What preparing a merge came to (feature-specs/37 § 4.1 to § 4.3; unit 54b): the repository could not be opened; the
 * product's commit on the branch, to check; a branch for a curator's hand; `main` moved under the anchor, the suggestion
 * back with a curator; or a suggestion that is no merge's, where it is.
 */
export type MergePrepared = { readonly outcome: "UNAVAILABLE" | "BRANCHED" | "MANUAL" } | ({ readonly outcome: "MOVED" | "NOT_MERGING" } & MergeLeft);

/** What the chapter's check came to (37 § 4.4): its verdict; a curator's branch that still lacks something; the repository unavailable; or a suggestion that is no merge's. */
export type MergeChecked = { readonly verdict: "PASSED" | "FAILED" | "NOT_RUN" | "MANUAL" | "UNAVAILABLE" } | ({ readonly verdict: "NOT_MERGING" } & MergeLeft);

/** A curator's merge recorded (37 § 5; unit 54c): its `curator` record written, or the action none of this check's. */
export interface MergeActionRecorded {
  readonly recorded: boolean;
}

/**
 * What moving `main` came to (37 § 5 steps 1 to 3; unit 54c): the release tagged on it; or the check to make again —
 * `main` or the branch moved since it, or it no longer passed — before anything is tagged (§ 5 step 2).
 */
export type MergedMain = { readonly outcome: "TAGGED"; readonly releaseId: string } | { readonly outcome: "AGAIN" };

/** The release published (37 § 5 steps 4 to 6; unit 54c), and how many of its sections kept their vectors; null where the carry did not run. */
export interface MergePublished {
  readonly releaseId: string;
  readonly carried: number | null;
}

/**
 * MergeWorkflow's activities (37 § 4, § 5), as `service:merge`, each idempotent on the row and the repository: the
 * branch made from `main` with the product's commit, or left for a curator's hand; the check, written on the merge's
 * row; and a failed check's return (unit 54b). Then, once a curator merges (unit 54c): their action recorded; `main`
 * moved to the branch with the changelog's line, and tagged; the tag ingested by the pipeline and published, the
 * unchanged sections' vectors carried; and the `merged` record, the suggestion `MERGED`. What crosses the engine is an
 * outcome, ids and a state; the reasons, the texts and the check's output are the merge's row.
 */
/**
 * ExportWorkflow's two (feature-specs/38 § 3; unit 55b): write the pack and append its record. `writeAuditPack` reads
 * the row, selects the records, writes the signed JSONL to the store under `audit/<id>.jsonl`, reads it back and
 * verifies it; what crosses the engine is the pack's span, count and hashes. `recordAuditPack` appends the `EXPORT`
 * record once (looked up by the export's id in its payload) and makes the row `READY`. A row already `READY` makes
 * both answer what it holds, so a retried step writes nothing twice.
 */
export interface ExportActivities {
  writeAuditPack(exportId: string): Promise<AuditPackWritten>;
  recordAuditPack(exportId: string, pack: AuditPackWritten): Promise<void>;
}

export interface AuditPackWritten {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly records: number;
  readonly headHash: string;
  readonly fileSha256: string;
  readonly storageKey: string;
}

/**
 * ResearchWorkflow's six (feature-specs/40 § 6.2; unit 57d): load the turn, plan, read, validate, submit, conclude. Each
 * takes the run's id and answers states and counts; the question, the answer, the brief and the findings' text stay in
 * the rows and the activities' memory (28 § 5.3). The planner and the reader are spec 41's (unit 58): until they are
 * built, `plan` fails the run with `PLANNER_NOT_BUILT`, a code on the row, and the marks stay.
 */
/** The run as every research activity names it: its id and the asker's, so each reads and writes inside the asker's own tenant context. */
export interface ResearchRunRef {
  readonly runId: string;
  readonly userId: string;
}

export interface ResearchActivities {
  /** Step 1: the turn read inside the reader's own tenant context; `purged` where the text is gone (40 § 8.3). */
  loadResearch(run: ResearchRunRef): Promise<{ readonly state: "LOADED"; readonly gap: boolean; readonly sections: number } | { readonly state: "PURGED" } | { readonly state: "GONE" }>;
  /** Step 2: the planner's brief, or nothing to research; at the cap, the reset the run sleeps until (40 § 7.2). */
  planResearch(run: ResearchRunRef): Promise<{ readonly planned: "brief" } | { readonly planned: "nothing" } | { readonly planned: "budget"; readonly resetsAt: string; readonly waitMs: number }>;
  /** Step 3: the reader's findings, as a count; at the cap, the reset. */
  readResearch(run: ResearchRunRef): Promise<{ readonly findings: number } | { readonly planned: "budget"; readonly resetsAt: string; readonly waitMs: number }>;
  /** Step 4: each finding checked in code; how many are valid. */
  validateFindings(run: ResearchRunRef): Promise<{ readonly valid: number; readonly invalid: number; readonly duplicate: number }>;
  /** Step 5: one suggestion per valid finding, its workflow started as a child by the workflow itself; the ids the children are of. */
  submitFindings(run: ResearchRunRef): Promise<{ readonly suggestionIds: ReadonlyArray<string> }>;
  /** Step 5, continued (42 § 5): where each submitted finding's suggestion stands — proposed, refuted, or still deciding — written to the finding's row; the counts. */
  findingOutcomes(run: ResearchRunRef): Promise<{ readonly pending: number; readonly proposed: number; readonly refuted: number }>;
  /** Step 6: the RESEARCH record and the run DONE, or ended where it stands with the state given. */
  concludeResearch(run: ResearchRunRef, end: { readonly state: "DONE" } | { readonly state: "SKIPPED"; readonly skip: "NOTHING_TO_RESEARCH" | "TEXT_PURGED" } | { readonly state: "FAILED"; readonly failure: string }): Promise<void>;
}

/**
 * How a person's run ends, as ResearchRunWorkflow hands it to its conclude step (feature-specs/48 § 5.1): done; refused
 * by its planner, with the cause; skipped, its text gone, at the person's cap or refused by the gateway before the
 * provider saw a call; failed with a code; or cancelled, which the step itself makes `SKIPPED · TEXT_PURGED` where the
 * run's text is gone (spec 46's erasure deletes the research first) and `FAILED · CANCELLED` otherwise.
 */
export type RunConclusion =
  | { readonly state: "DONE" }
  | { readonly state: "REFUSED"; readonly refusal: PlannerRefusal }
  | { readonly state: "SKIPPED"; readonly skip: "TEXT_PURGED" | "BUDGET" | "UNAVAILABLE" }
  | { readonly state: "FAILED"; readonly failure: string }
  | { readonly state: "CANCELLED" };

/**
 * ResearchRunWorkflow's seven (feature-specs/48 § 5.1; unit 70b): load, plan, read, check, write, conclude, and the
 * catch-all's abandon. Each takes the run's id and its asker's and answers states and counts; the question, the brief,
 * what the reader found, the steps and the report stay in the asker's rows and the activities' memory (invariant 35).
 * Each activity writes the run's state as it moves and its live step; the conclude step writes the end, then the
 * `RESEARCH` record once, then the run's line.
 */
export interface ResearchRunActivities {
  /** Step 1: the run read inside the asker's context, its question redacted again with the workers' secrets, `PLANNING` and its step; `PURGED` where the text is gone, `ENDED` where the row already ended (a start the web tier took back), `GONE` with no row. */
  loadRun(run: ResearchRunRef): Promise<{ readonly state: "LOADED" } | { readonly state: "PURGED" } | { readonly state: "GONE" } | { readonly state: "ENDED"; readonly ended: ResearchState }>;
  /** Step 2: the sections, the planner, the brief sensor; the brief, the targets and the `SECTIONS` step stored. Or the planner's refusal, the person's cap (its reset on the row), the gateway's refusal. */
  planRun(run: ResearchRunRef): Promise<{ readonly planned: "brief" } | { readonly planned: "refused"; readonly refusal: PlannerRefusal } | { readonly planned: "budget" } | { readonly planned: "unavailable" }>;
  /** Step 3: the reader with the two web tools, its steps written as each block arrives, `found` stored; the count of findings, or the person's cap. */
  readRun(run: ResearchRunRef): Promise<{ readonly read: "found"; readonly findings: number } | { readonly read: "budget" }>;
  /** Step 4: each finding checked in code, a `VALID` or `INVALID` row each; each page's note checked. */
  validateRun(run: ResearchRunRef): Promise<{ readonly valid: number; readonly invalid: number }>;
  /** Step 5: `writingAt`, the writer, the report sensor, the report stored; or the key's rate limit (`attempt` 1, waited out once), or the person's cap. */
  writeReport(run: ResearchRunRef, attempt: number): Promise<{ readonly written: "report" } | { readonly written: "rate_limit" } | { readonly written: "budget" }>;
  /** Step 6: the end state first, then the `RESEARCH` record once, then the `research.run` line; the state the row was left in. */
  concludeRun(run: ResearchRunRef, end: RunConclusion): Promise<{ readonly state: ResearchState }>;
  /** The catch-all (48 § 5.1): `FAILED · INTERNAL` where the run has not ended, no record. */
  abandonRun(run: ResearchRunRef): Promise<void>;
}

/** A finding as the send's activities name it: its id and its asker's, so each reads and writes inside the asker's own tenant context. */
export interface FindingRunRef {
  readonly findingId: string;
  readonly userId: string;
}

/**
 * SendFindingWorkflow's two (feature-specs/48 § 8.4; unit 74), as `service:researcher`: the send — the finding claimed
 * and the researcher's proposal made in one transaction, or why not written on the finding — and the ask of where the
 * proposal stands, written as the finding's outcome. What crosses the engine is an outcome, a code and a suggestion's id;
 * the finding's text stays in the asker's rows (invariant 35).
 */
export interface SendFindingActivities {
  /** The send: `submitted` with the suggestion (made now, or by an earlier attempt), a `duplicate` of one, `failed` with the code written on the finding, `used` by another hand, or `gone`. */
  sendFinding(finding: FindingRunRef): Promise<{ readonly sent: "submitted"; readonly suggestionId: string } | { readonly sent: "duplicate"; readonly suggestionId: string } | { readonly sent: "failed"; readonly failure: FindingFailure } | { readonly sent: "used" } | { readonly sent: "gone" }>;
  /** Where its proposal stands, the outcome written once Improve placed it: still deciding, proposed, refuted, or the finding gone. */
  findingOutcome(finding: FindingRunRef): Promise<{ readonly outcome: "PENDING" | "PROPOSED" | "REFUTED" | "GONE" }>;
}

export interface MergeActivities {
  /** § 4.1 to § 4.3: the move to `MERGING` a person's accept waits for; the anchor read again at `main`; the proposal applied; the branch and its commit. */
  prepareMerge(suggestionId: SuggestionId): Promise<MergePrepared>;
  /** § 4.3's verification of a curator's branch, then § 4.4's check of the branch's tree. */
  checkMerge(suggestionId: SuggestionId): Promise<MergeChecked>;
  /** § 4.5: a failed check returns the suggestion as a request for more; where it left it. */
  returnMerge(suggestionId: SuggestionId): Promise<MergeLeft>;
  /** § 5: a curator's merge, its `curator` record under the step key `curator:<actionId>` of this workflow. */
  recordMergeAction(suggestionId: SuggestionId, workflowId: string, actionId: string): Promise<MergeActionRecorded>;
  /** § 5 steps 1 to 3: the release's id and version, the changelog's line, the fast-forward and the tag. */
  mergeMain(suggestionId: SuggestionId): Promise<MergedMain>;
  /** § 5 steps 4 to 6: the tag ingested, its render hash held to the check's, and the vectors carried. */
  publishMerge(suggestionId: SuggestionId): Promise<MergePublished>;
  /** § 5 step 7: the `merged` record on the chapter's new version, the merge's row done, the suggestion `MERGED`, the branch deleted. */
  recordMerged(suggestionId: SuggestionId, workflowId: string, actionId: string): Promise<MergeLeft>;
}

/** ProvingWorkflow's two reads. */
export interface ProvingActivities {
  /** The id of the release the reader is pinned to. */
  currentReleaseId(): Promise<ReleaseId>;
  /** The ledger's newest `seq`, or 0 on an empty chain. */
  ledgerHeadSeq(): Promise<number>;
}
