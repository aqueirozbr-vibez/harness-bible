import { ActivityFailure, ApplicationFailure, ChildWorkflowFailure, condition, defineQuery, defineSignal, executeChild, log, patched, proxyActivities, setHandler, sleep, TimeoutFailure, uuid4, workflowInfo } from "@temporalio/workflow";

import { mergesAfter, takesRevision, type Decision, type SuggestionState } from "@/lib/schemas/improve";
import { CuratorDecisionSignalSchema, EndorsedSignalSchema, mergeWorkflowId, RevisedSignalSchema, SUGGESTION_CURATOR_SIGNAL, SUGGESTION_ENDORSED_SIGNAL, SUGGESTION_REVISED_SIGNAL, SUGGESTION_WAITS_QUERY, SUGGESTION_WITHDRAWN_SIGNAL, SuggestionWorkflowInputSchema, type EndorsedSignal, type SuggestionWaits, type SuggestionWorkflowInput, type SuggestionWorkflowResult, WithdrawnSignalSchema, type WithdrawnSignal } from "@/lib/schemas/workflows";

import type { AdjudicationOutcome, Decided, SuggestionActivities } from "./activities";
import { gradeItemAgain, gradeOneItem } from "./grading";
import { MergeWorkflow } from "./merge";

/*
 * SuggestionWorkflow (feature-specs/33 § 3; unit 50a), started by the submit endpoint under `suggestion:<id>`: the
 * spec's nine steps, everything deterministic before a frontier call (invariant 11).
 *
 *   1 record — the move out of draft when the endpoint has not made it, and the `submitted` record;
 *   2 intake — the four sensors of spec 31 § 5, their verdicts written as rows; a failure is a decline by rule (9a);
 *   3 grade  — every item still pending through the grader's three activities (`grading.ts`), in the order they were
 *              added, then the score from the rows and the `graded` record;
 *   4 route  — the route of the suggestion's class, score and verdicts, by its own rubric;
 *   5 sense  — for a route that goes on (to a curator or the adjudicator), the three consistency sensors (unit 50c),
 *              their verdicts written as rows; a failure is a decline by rule (9a), naming the sensor, as at step 2;
 *   6 class  — a class no score decides goes to a curator (9c), and no model reads it (unit 50d);
 *   7 adjudicate — one frontier call as `service:adjudicator` (unit 50d): its decision, or — its failure, the policy's
 *              refusal, or this activity's own failure, recorded by the next — the curator (9c, invariant 15);
 *   8, 9 decide — wherever the steps ended: the decision's rows, the `sensors` and `decided` records, and the moves to
 *              where it leaves the suggestion (unit 50e): a decline by rule (9a), a request for more by rule (9b), the
 *              curator (9c), or the adjudicator's decision.
 *
 * Then it waits where a person may still act (33 § 6.3 to § 6.5; unit 50e, part 2), with no timer: in the queue for
 * `curatorDecision({ actionId })`, whose activity records the curator's decision and moves the suggestion; and where
 * the suggestion takes new evidence — `INTAKE_DECLINED`, or a request for more in `DECIDED` or the queue — for
 * `revised`, which returns it to `SUBMITTED` and runs steps 2 to 9 again as the next attempt, whose step keys and trace
 * id are its own (§ 6.4). Every signal is kept, whenever it comes — a person may act the moment a decision's move is
 * committed, before the run has seen it — and is taken where it applies: an action in the queue, a revision where the
 * suggestion takes one. Its activity says whether it does — an action of this visit, a revision of the decision that
 * stands (§ 20) — and one that does not, or a revision's step that fails, leaves the run waiting; a curator's action
 * whose step failed is recorded again later, since it stands (unit 53's review). Wherever it waits, it also takes
 * `withdrawn` (feature-specs/45 § 5.3; unit 63e) — after an action already queued, before a revision — whose activity
 * judges whether the request still stands, records it and closes the suggestion, and the run ends there; one whose
 * step failed is recorded again later, as an action is. The `waits` query says what the run waits for. The workflow ends at
 * `CLOSED`. An accept — a curator's, in `MERGING`, or the adjudicator's of a person's suggestion, in `DECIDED` — starts
 * `MergeWorkflow` as its child under `merge:<id>` (spec 37 § 4; unit 54b), and the run goes on from where the merge
 * leaves the suggestion: back with a curator, or returned as a request for more, it waits there again. A run that ended
 * at an accept before the merge existed replays as it ran (the patch `54b-merge-child`).
 * A grade or an adjudication the principal's budget refused (unit 50f; spec 28 § 4) is waited out: the suggestion says
 * until when, the run sleeps until the reset — no activity retries into a cap — and asks again: the grade alone, the
 * item's text being stored, or the adjudicator once more, its refused call never made. After every decline — by rule, by the adjudicator, by a curator —
 * the throttle's count runs (33 § 7; unit 50f); its failure leaves the run where it was.
 *
 * A waiting run replays this code when the workers restart: a change to what it asks of the engine needs `patched()`
 * or the waiting runs ended first.
 *
 * The activities' timeouts and attempts, with their derivation: `runIntake`, `pendingItems` and `routeSuggestion` are
 * a few reads and at most one write of rows, the work the proving workflow's reads and the submit's first move were
 * given five seconds and three attempts for (28 § 12; 31 § 6.4). The two steps that append — `recordSubmitted` and
 * `recordGraded`, which also reads each item's object in the store — wait on the chain's lock, a transaction bounded
 * at 2 s for a connection and 5 s once held, twice when it retries a race (Prisma's defaults; lib/ledger/append.ts):
 * they have the 60 s and three attempts of the grader's own store step (`grading.ts`), well over that, so an attempt
 * the engine times out is not still appending beside its retry. A retry finds the row moved and the record written
 * and does nothing twice. The grader's three keep their own. `runConsistency` reads the book's files from disk and
 * builds the chapter twice over besides its rows, work of a few seconds on this machine: it has the 60 s and three
 * attempts of the steps above that do more than a few reads, recorded for Andre with the others. `adjudicateSuggestion`
 * has one attempt, the adjudicator's cap (invariant 15): a second would be a second frontier call. Its 180 s are the
 * call's 120 s (the `adjudicator` row) and a minute for its reads and its one write. `recordAdjudicatorFailure` writes a
 * row after reading a few; `recordDecision`, `recordCuratorDecision`, `recordWithdrawal` and `reopenForRevision` append
 * records and move the row: the 60 s and three attempts of the steps that append or write after reading. `throttleOnDecline` reads a row,
 * counts and writes one: the 5 s and three attempts of the steps that read a few and write one.
 */

const { runIntake, pendingItems, routeSuggestion, throttleOnDecline, markBudgetWait } = proxyActivities<Pick<SuggestionActivities, "runIntake" | "pendingItems" | "routeSuggestion" | "throttleOnDecline" | "markBudgetWait">>({
  startToCloseTimeout: "5 seconds",
  retry: { maximumAttempts: 3 },
});
const { recordSubmitted, recordGraded, runConsistency, recordAdjudicatorFailure, recordDecision, recordCuratorDecision, reopenForRevision, recordEndorsement, recordWithdrawal } = proxyActivities<
  Pick<SuggestionActivities, "recordSubmitted" | "recordGraded" | "runConsistency" | "recordAdjudicatorFailure" | "recordDecision" | "recordCuratorDecision" | "reopenForRevision" | "recordEndorsement" | "recordWithdrawal">
>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 3 },
});
const { adjudicateSuggestion } = proxyActivities<Pick<SuggestionActivities, "adjudicateSuggestion">>({ startToCloseTimeout: "180 seconds", retry: { maximumAttempts: 1 } });

const revised = defineSignal<[unknown]>(SUGGESTION_REVISED_SIGNAL);
const curatorDecision = defineSignal<[unknown]>(SUGGESTION_CURATOR_SIGNAL);
const endorsed = defineSignal<[unknown]>(SUGGESTION_ENDORSED_SIGNAL);
const withdrawn = defineSignal<[unknown]>(SUGGESTION_WITHDRAWN_SIGNAL);
export const suggestionWaits = defineQuery<SuggestionWaits>(SUGGESTION_WAITS_QUERY);

type SuggestionId = SuggestionWorkflowInput["suggestionId"];

/** A failed activity's code, for its row: the type its own failure gave, or that it ran out of time. */
function codeOf(error: ActivityFailure): string {
  if (error.cause instanceof ApplicationFailure) return error.cause.type ?? "APPLICATION_FAILURE";
  if (error.cause instanceof TimeoutFailure) return "TIMEOUT";
  return "ACTIVITY_FAILED";
}

/**
 * Step 7, whose every failure is the curator's. The activity's own failure, thrown or timed out, is recorded by the
 * next, which answers what the attempt's row says: the decision, when the activity wrote it before the engine gave up
 * on it. Should that fail too, the suggestion is still the curator's, its failure unwritten.
 */
async function adjudicateOnce(suggestionId: SuggestionId, workflowId: string, attempt: number, traceId: string): Promise<AdjudicationOutcome> {
  try {
    return await adjudicateSuggestion(suggestionId, workflowId, attempt, traceId);
  } catch (error: unknown) {
    if (!(error instanceof ActivityFailure)) throw error;
    try {
      return await recordAdjudicatorFailure(suggestionId, traceId, codeOf(error));
    } catch (recording: unknown) {
      if (!(recording instanceof ActivityFailure)) throw recording;
      return { outcome: "FAILED" };
    }
  }
}

/** A step of the waits, whose failure leaves the run waiting rather than ends it: a run that waited weeks is not lost to one bad row (33 § 20). */
async function orNull<T>(step: () => Promise<T>, suggestionId: SuggestionId): Promise<T | null> {
  try {
    return await step();
  } catch (error: unknown) {
    if (!(error instanceof ActivityFailure)) throw error;
    log.warn("a step of the waits failed, and the run waits on", { suggestionId, code: codeOf(error) });
    return null;
  }
}

/**
 * The least a run sleeps at a budget cap: a reset already past, or one the gateway has not yet made, measures a wait of
 * nothing, and two asks at the cap a moment apart would follow each other until the run's history was full.
 */
const LEAST_BUDGET_WAIT_MS = 60_000;

/**
 * The wait at a budget cap (33 § 7; unit 50f): the suggestion says until when, the run sleeps until the reset — a
 * minute at the least — and the suggestion says it no longer waits. The activity that met the cap measured the wait,
 * the standards keeping the clock out of workflow code; the marks are its page's, and their failure leaves the wait as
 * it is, the decision's move clearing a mark left behind.
 */
async function sleepUntilReset(suggestionId: SuggestionId, wait: { readonly resetsAt: string; readonly waitMs: number }): Promise<void> {
  await orNull(() => markBudgetWait(suggestionId, wait.resetsAt), suggestionId);
  await sleep(Math.max(wait.waitMs, LEAST_BUDGET_WAIT_MS));
  await orNull(() => markBudgetWait(suggestionId, null), suggestionId);
}

/** Steps 2 to 9 of one attempt (§ 6.4): the first after step 1, a revision's after its return. `state` is where step 1 or the return left the suggestion. */
async function runAttempt(suggestionId: SuggestionId, workflowId: string, attempt: number, state: SuggestionState): Promise<SuggestionWorkflowResult> {
  const none = { route: null, failingSensor: null, namedTier: null, score: null, decision: null, sufficientTier: null } as const;
  /* The attempt's trace id: its graded and decided records', and its calls' (33 § 12). */
  const traceId = uuid4().replace(/-/g, "");
  const decide = (decided: Decided) => recordDecision(suggestionId, workflowId, attempt, traceId, decided);

  const verdicts = await runIntake(suggestionId);
  const failing = verdicts.find((verdict) => verdict.result === "FAIL");
  if (failing !== undefined) {
    const decided = await decide({ by: "intake-rules", decision: "DECLINE", failingSensor: failing.sensor, namedTier: null });
    return { suggestionId, ...none, ...decided, route: "DECLINE_AT_INTAKE", failingSensor: failing.sensor };
  }

  for (const itemId of await pendingItems(suggestionId)) {
    let graded = await gradeOneItem(itemId);
    while (graded.state === "PENDING") {
      await sleepUntilReset(suggestionId, graded);
      graded = await gradeItemAgain(itemId);
    }
  }
  const graded = await recordGraded(suggestionId, workflowId, attempt, traceId);

  const routed = await routeSuggestion(suggestionId, graded.score, graded.strongestTier, verdicts);
  const result = { suggestionId, state, ...none, route: routed.route, namedTier: routed.namedTier, score: graded.score };
  if (routed.route === "DECLINE_AT_INTAKE" || routed.route === "REQUEST_MORE_BY_RULE") {
    return { ...result, ...(await decide({ by: "intake-rules", decision: routed.route === "DECLINE_AT_INTAKE" ? "DECLINE" : "REQUEST_MORE", failingSensor: null, namedTier: routed.namedTier })) };
  }

  const sensed = await runConsistency(suggestionId);
  const inconsistent = sensed.find((verdict) => verdict.result === "FAIL");
  if (inconsistent !== undefined) {
    const decided = await decide({ by: "intake-rules", decision: "DECLINE", failingSensor: inconsistent.sensor, namedTier: null });
    return { ...result, ...decided, route: "DECLINE_AT_INTAKE", failingSensor: inconsistent.sensor };
  }
  if (routed.route === "CURATOR") return { ...result, ...(await decide({ by: "router" })) };

  let adjudicated = await adjudicateOnce(suggestionId, workflowId, attempt, traceId);
  while (adjudicated.outcome === "BUDGET") {
    await sleepUntilReset(suggestionId, adjudicated);
    adjudicated = await adjudicateOnce(suggestionId, workflowId, attempt, traceId);
  }
  return { ...result, ...(await decide(adjudicated.outcome === "REFUSED" ? { by: "router" } : { by: "adjudicator" })) };
}

/**
 * How long a run waits before it records again a curator's action whose step failed, its attempts spent: a minute,
 * doubling to an hour. The action stands — the endpoint takes no second one for the visit (36 § 8) — so a run that
 * dropped it would leave the suggestion in the queue for good (unit 53's review). The patch keeps a run that dropped one
 * before this replaying as it ran.
 */
const RECORD_AGAIN_MS = 60_000;
const RECORD_AGAIN_MAX_MS = 3_600_000;
const RECORD_AGAIN_PATCH = "53-record-curator-action-again";
/** A reader's name whose record failed is asked again in the same way (unit 59's review): the credit is read from the records alone. */
const ENDORSE_AGAIN_PATCH = "59-record-endorsement-again";

/** An accept starts its merge as a child (spec 37 § 4; unit 54b); a run that ended at one before replays as it ran. */
const MERGE_PATCH = "54b-merge-child";

/**
 * A contributor's withdrawal (feature-specs/45 § 5.3; unit 63e): a run that waited before it replays as it ran, and drops
 * a withdrawal its history holds and its code never took. Checked at the one command, never at the handler: a check at
 * the start answers false while a waiting run replays, and is not remembered.
 */
const WITHDRAWAL_PATCH = "63e-withdrawal";

/** What a suggestion left where a decision put it waits for: a curator in the queue, a revision where it takes new evidence (31 § 6.5); null where the workflow ends. */
type Waits = NonNullable<SuggestionWaits>;

function waitsFor(state: SuggestionState, decision: Decision | null): Waits | null {
  const curator = state === "CURATOR_QUEUE";
  const revision = takesRevision(state, decision);
  return curator || revision ? { curator, revision } : null;
}

export async function SuggestionWorkflow(input: SuggestionWorkflowInput): Promise<SuggestionWorkflowResult> {
  if (!SuggestionWorkflowInputSchema.safeParse(input).success) {
    throw ApplicationFailure.nonRetryable("SuggestionWorkflow takes { suggestionId: S-NN-NNNN }", "WORKFLOW_INPUT");
  }
  const { suggestionId } = input;
  const { workflowId } = workflowInfo();

  /*
   * A reader's name on a researcher's proposal, or taken back (42 § 6; unit 59d), whenever it comes — in the queue or
   * while the merge runs — recorded in its order by its activity, beside the run rather than in its way. The credit is
   * read from the records alone (lib/improve/endorsement.ts), so a record that fails is asked again after a minute, then
   * twice as long each time up to an hour, as a curator's action is (unit 59's review), and the names after it wait their
   * turn. The run ends after the last one is recorded.
   */
  const endorsements: EndorsedSignal[] = [];
  let ended = false;
  setHandler(endorsed, (signal) => {
    const parsed = EndorsedSignalSchema.safeParse(signal);
    if (parsed.success) endorsements.push(parsed.data);
    else log.warn("endorsed ignored: it names no reader (42 § 6)", { suggestionId });
  });
  const recordingEndorsements = (async () => {
    let againMs = RECORD_AGAIN_MS;
    for (;;) {
      await condition(() => endorsements.length > 0 || ended);
      const next = endorsements.shift();
      if (next === undefined) return;
      const recorded = await orNull(() => recordEndorsement(suggestionId, workflowId, next), suggestionId);
      if (recorded === null && patched(ENDORSE_AGAIN_PATCH)) {
        endorsements.unshift(next);
        await sleep(againMs);
        againMs = Math.min(againMs * 2, RECORD_AGAIN_MAX_MS);
        continue;
      }
      againMs = RECORD_AGAIN_MS;
    }
  })();
  try {
    return await decideAndWait(suggestionId, workflowId);
  } finally {
    ended = true;
    await recordingEndorsements;
  }
}

/** The run itself: the attempt, the decision, and the waits where a person may act (33 § 6). */
async function decideAndWait(suggestionId: SuggestionId, workflowId: string): Promise<SuggestionWorkflowResult> {
  /* Every signal is kept, in order: the decision each revision answers, and each action. */
  let waiting: Waits | null = null;
  const revisions: string[] = [];
  const actions: string[] = [];
  const withdrawals: WithdrawnSignal[] = [];
  setHandler(suggestionWaits, () => waiting);
  setHandler(revised, (signal) => {
    const parsed = RevisedSignalSchema.safeParse(signal);
    if (parsed.success) revisions.push(parsed.data.decidedAt);
    else log.warn("revised ignored: it names no decision (33 § 20)", { suggestionId });
  });
  setHandler(curatorDecision, (signal) => {
    const parsed = CuratorDecisionSignalSchema.safeParse(signal);
    if (parsed.success) actions.push(parsed.data.actionId);
    else log.warn("curatorDecision ignored: it names no action (33 § 6.3)", { suggestionId });
  });
  setHandler(withdrawn, (signal) => {
    const parsed = WithdrawnSignalSchema.safeParse(signal);
    if (parsed.success) withdrawals.push(parsed.data);
    else log.warn("withdrawn ignored: it names no contributor, instant or decision (45 § 5.3)", { suggestionId });
  });

  /*
   * After a decline, the throttle's count (33 § 7): its activity knows whose suggestion it is and whether it counts.
   * After an accept, the merge (37 § 4), until it leaves the suggestion where something else is waited for; should the
   * child itself fail, the suggestion stays where the decision left it and the run ends there.
   */
  const afterDecision = async (decided: SuggestionWorkflowResult): Promise<SuggestionWorkflowResult> => {
    if (decided.decision === "DECLINE") await orNull(() => throttleOnDecline(suggestionId), suggestionId);
    if (!mergesAfter(decided.state, decided.decision) || !patched(MERGE_PATCH)) return decided;
    try {
      const merged = await executeChild(MergeWorkflow, { workflowId: mergeWorkflowId(suggestionId), args: [{ suggestionId }] });
      return { ...decided, state: merged.state, decision: merged.decision, sufficientTier: null };
    } catch (error: unknown) {
      if (!(error instanceof ChildWorkflowFailure)) throw error;
      log.warn("the merge failed, and the suggestion stays where its accept left it", { suggestionId });
      return decided;
    }
  };

  const { state } = await recordSubmitted(suggestionId, workflowId);
  let attempt = 1;
  let recordAgainMs = RECORD_AGAIN_MS;
  let result = await afterDecision(await runAttempt(suggestionId, workflowId, attempt, state));
  for (;;) {
    const waits = waitsFor(result.state, result.decision);
    if (waits === null) return result;
    waiting = waits;
    /* a withdrawal is taken wherever the run waits: each wait is one of the places it applies (45 § 5.1) */
    await condition(() => (waits.curator && actions.length > 0) || (waits.revision && revisions.length > 0) || withdrawals.length > 0);
    waiting = null;

    /* Each action in turn: one that is none of this visit's costs no other its place (33 § 20). */
    const actionId = waits.curator ? actions.shift() : undefined;
    if (actionId !== undefined) {
      const recorded = await orNull(() => recordCuratorDecision(suggestionId, workflowId, actionId), suggestionId);
      if (recorded === null && patched(RECORD_AGAIN_PATCH)) {
        actions.unshift(actionId);
        await sleep(recordAgainMs);
        recordAgainMs = Math.min(recordAgainMs * 2, RECORD_AGAIN_MAX_MS);
        continue;
      }
      recordAgainMs = RECORD_AGAIN_MS;
      if (recorded?.recorded === true) result = await afterDecision({ ...result, state: recorded.state, decision: recorded.decision, sufficientTier: null });
      else log.warn("curatorDecision not recorded: its action is none of this visit's", { suggestionId, actionId });
      continue;
    }

    /* A contributor's withdrawal (45 § 5.3): after an action already queued, which goes first, and before a revision. */
    const withdrawal = withdrawals.shift();
    if (withdrawal !== undefined) {
      if (!patched(WITHDRAWAL_PATCH)) continue;
      const withdrew = await orNull(() => recordWithdrawal(suggestionId, workflowId, withdrawal), suggestionId);
      if (withdrew === null) {
        /* its record may stand before its move: it is recorded again later, never dropped half done */
        withdrawals.unshift(withdrawal);
        await sleep(recordAgainMs);
        recordAgainMs = Math.min(recordAgainMs * 2, RECORD_AGAIN_MAX_MS);
        continue;
      }
      recordAgainMs = RECORD_AGAIN_MS;
      /* closed, with the decision that stood: no throttle counted again, no merge (45 § 5.3) */
      if (withdrew.recorded) result = { ...result, state: "CLOSED" };
      else log.warn("withdrawn not recorded: it no longer stands, and its request was taken back (45 § 5.3)", { suggestionId });
      continue;
    }

    const decidedAt = revisions.shift();
    if (decidedAt === undefined) continue;
    const reopened = await orNull(() => reopenForRevision(suggestionId, workflowId, attempt + 1, decidedAt), suggestionId);
    if (reopened?.reopened !== true) {
      log.warn("revised not taken: it answers no decision that stands", { suggestionId, decidedAt });
      continue;
    }
    attempt += 1;
    result = await afterDecision(await runAttempt(suggestionId, workflowId, attempt, "SUBMITTED"));
  }
}
