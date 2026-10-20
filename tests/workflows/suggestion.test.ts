import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ApplicationFailure } from "@temporalio/activity";
import { WorkflowFailedError, type WorkflowHandle } from "@temporalio/client";
import { temporal } from "@temporalio/proto";
import { describe, expect, it } from "vitest";

import { pathOf } from "@/lib/improve/decision";
import type { Decision } from "@/lib/schemas/improve";
import { SUGGESTION_CURATOR_SIGNAL, SUGGESTION_ENDORSED_SIGNAL, SUGGESTION_REVISED_SIGNAL, SUGGESTION_WITHDRAWN_SIGNAL, SUGGESTION_WAITS_QUERY, SUGGESTION_WORKFLOW, SuggestionWaitsSchema, SuggestionWorkflowResultSchema, suggestionWorkflowId, type SuggestionWaits, type SuggestionWorkflowResult } from "@/lib/schemas/workflows";
import type { AdjudicationOutcome, CuratorDecisionRecorded, EvidenceActivities, MergeActivities, MergeChecked, MergePrepared, SensorOutcome, SuggestionActivities } from "@/workers/workflows/activities";

import { workflowEnvironment } from "./environment";

/*
 * SuggestionWorkflow in Temporal's test environment (feature-specs/33 § 3; unit 50a): the real workflow code as the
 * workers bundle it, with its activities doubled — its own and the grader's three, which it runs for an item still
 * pending. Steps 1 to 4 in order; a failing sensor ends the attempt before any grade (invariant 11); a pending item goes
 * through fetch, store and grade with the grader's two early exits; a grade or an adjudication the budget refused is
 * slept out until the reset (unit 50f) and asked again;
 * record; the route and the tier a rule names are returned; a bad argument asks nothing; a row step is tried again.
 * Since unit 50c a route that goes on, to a curator or the adjudicator, runs step 5, whose failure declines by rule.
 * Since unit 50d a curator's route ends at step 6 with no model asked, and the adjudicator's runs step 7 once: its
 * decision, or the curator for its failure, the policy's refusal or the activity's own failure, which the next records.
 * Since unit 50e every attempt that reaches a decision records it by who made it, and the run then waits where a person
 * may act — the queue for a curator, a request for more or a decline by rule for a revision — and takes only the
 * signals that apply there; the decision's double answers with the state `pathOf` gives, as the activity does. A run
 * left waiting is checked to wait, through its `waits` query, and then ended. Since part 2's review every signal is
 * kept, whenever it comes, and taken where it applies, its activity judging whether it does: a signal sent while the
 * decision is still being recorded is not lost, and a step of the waits that fails leaves the run waiting. Since unit
 * 50f every decline is followed by the throttle's count. Since unit 54b an accept starts the merge as a child, whose
 * three activities are doubled too: by default the merge finds the suggestion where the decision left it and ends,
 * so the run ends there as before; a merge that returns the suggestion has the run wait where it left it. Since unit
 * 63e (feature-specs/45 § 5.3) every wait also takes a contributor's withdrawal, after an action already queued and
 * before a revision; and a run recorded before it replays as it ran.
 */

const SUGGESTION = "S-21-0016";
const FIRST = "4f1c9a2e-0000-4000-8000-0000000050a1";
const SECOND = "4f1c9a2e-0000-4000-8000-0000000050a2";
const ACTION = "4f1c9a2e-0000-4000-8000-0000000050e1";
const LATER = "4f1c9a2e-0000-4000-8000-0000000050e2";
/** A principal's cap, a week from the test's clock: the reset, and the wait the activity measured to it. */
const CAP = { resetsAt: "2026-11-01T00:00:00.000Z", waitMs: 7 * 86_400_000 } as const;
/** When the decision a revision answers was made, as the submit endpoint reads it. */
const DECIDED_AT = "2026-10-07T12:00:00.000Z";
/** A contributor's withdrawal, as the withdraw endpoint signals it (45 § 5.2). */
const WITHDRAWN = { userId: "11111111-1111-4111-8111-111111111111", at: "2026-10-11T12:00:00.000Z", decidedAt: DECIDED_AT } as const;
const PASSES: ReadonlyArray<SensorOutcome> = (["SCHEMA", "ANCHOR_EXISTS", "EVIDENCE_PARSES", "RATIONALE_LENGTH"] as const).map((sensor) => ({ sensor, result: "PASS" }));
const CONSISTENT: ReadonlyArray<SensorOutcome> = [{ sensor: "DERIVE_CONSISTENCY", result: "NA" }, { sensor: "CROSS_CHAPTER", result: "PASS" }, { sensor: "LINT", result: "PASS" }];
const ACCEPTED: AdjudicationOutcome = { outcome: "DECIDED", decision: "ACCEPT", sufficientTier: null };

interface ItemBehaviour {
  readonly opened?: boolean;
  readonly text?: boolean;
  readonly budget?: boolean;
}

interface Options {
  readonly verdicts?: ReadonlyArray<SensorOutcome>;
  readonly pending?: Readonly<Record<string, ItemBehaviour>>;
  readonly route?: Awaited<ReturnType<SuggestionActivities["routeSuggestion"]>>;
  readonly consistency?: ReadonlyArray<SensorOutcome>;
  readonly submittedFailures?: number;
  readonly holdSubmitted?: boolean;
  /** Hold the first decision's record until released: a signal sent then comes before the run waits. */
  readonly holdDecision?: boolean;
  /** Step 7's answer in the first attempt, or the failure the activity throws; `ACCEPTED` when unset. */
  readonly adjudication?: AdjudicationOutcome | ApplicationFailure;
  /** The first adjudication meets the principal's cap; the next answers as above. */
  readonly adjudicationAtCap?: boolean;
  /** Step 7's answer in a revision's attempt. */
  readonly revisedAdjudication?: AdjudicationOutcome;
  /** What recording step 7's own failure answers — what the attempt's row says — or the failure it throws. */
  readonly recorded?: AdjudicationOutcome | ApplicationFailure;
  /** What recording each curator's decision answers, in turn, or the failure it throws; a move to `MERGING` when none is left. */
  readonly curator?: ReadonlyArray<CuratorDecisionRecorded | ApplicationFailure>;
  readonly reopened?: boolean;
  /** What preparing the merge answers, in turn; by default the suggestion where the decision left it, no merge's (unit 54b). */
  readonly prepared?: ReadonlyArray<MergePrepared>;
  /** What checking it answers, in turn. */
  readonly checked?: ReadonlyArray<MergeChecked>;
  /** How many records of a reader's name fail before one is written (unit 59's review). */
  readonly endorsementFailures?: number;
  /** What recording each withdrawal answers, in turn, or the failure it throws; recorded when none is left (45 § 5.3). */
  readonly withdrawal?: ReadonlyArray<{ readonly recorded: boolean } | ApplicationFailure>;
}

function doubles(options: Options = {}) {
  const calls: string[] = [];
  const args: Record<string, ReadonlyArray<unknown>> = {};
  /* Each attempt's graded record: its attempt and its trace id. */
  const attempts: Array<readonly [unknown, unknown]> = [];
  let failures = options.submittedFailures ?? 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = options.pending ?? {};
  const curator = [...(options.curator ?? [])];
  const withdrawal = [...(options.withdrawal ?? [])];
  let endorsementFailures = options.endorsementFailures ?? 0;
  /* What the suggestion said of a wait at a budget cap, in turn: the reset, then null when it woke. */
  const budgetMarks: Array<string | null> = [];
  const gradedTimes = new Map<string, number>();
  let atCap = options.adjudicationAtCap === true;
  /* What step 7 came to, as its row would say it: the activity's answer, or the failure recorder's. */
  let adjudicated: AdjudicationOutcome | null = null;
  /* Where the last decision left the suggestion, which the merge's doubles find. */
  let left: { state: SuggestionWorkflowResult["state"]; decision: Decision | null } = { state: "SUBMITTED", decision: null };
  const prepared = [...(options.prepared ?? [])];
  const checked = [...(options.checked ?? [])];
  const own: SuggestionActivities = {
    async recordSubmitted(suggestionId, workflowId) {
      calls.push("recordSubmitted");
      args.recordSubmitted = [suggestionId, workflowId];
      if (options.holdSubmitted === true) await gate;
      if (failures > 0) {
        failures -= 1;
        throw ApplicationFailure.retryable("the row was not there yet", "STILL_A_DRAFT");
      }
      return { state: "SUBMITTED" };
    },
    async runIntake(suggestionId) {
      calls.push("runIntake");
      args.runIntake = [suggestionId];
      return options.verdicts ?? PASSES;
    },
    async pendingItems() {
      calls.push("pendingItems");
      return Object.keys(pending);
    },
    async recordGraded(suggestionId, workflowId, attempt, traceId) {
      calls.push("recordGraded");
      args.recordGraded = [suggestionId, workflowId, attempt, traceId];
      attempts.push([attempt, traceId]);
      return { score: 56, strongestTier: "C" };
    },
    async routeSuggestion(suggestionId, score, strongestTier, verdicts) {
      calls.push("routeSuggestion");
      args.routeSuggestion = [suggestionId, score, strongestTier, verdicts];
      return options.route ?? { route: "ADJUDICATE", namedTier: null };
    },
    async runConsistency(suggestionId) {
      calls.push("runConsistency");
      args.runConsistency = [suggestionId];
      return options.consistency ?? CONSISTENT;
    },
    async adjudicateSuggestion(suggestionId, workflowId, attempt, traceId) {
      calls.push("adjudicateSuggestion");
      args.adjudicateSuggestion = [suggestionId, workflowId, attempt, traceId];
      if (atCap) {
        atCap = false;
        return { outcome: "BUDGET", ...CAP };
      }
      const answer = attempt === 1 ? options.adjudication : options.revisedAdjudication;
      if (answer instanceof ApplicationFailure) throw answer;
      adjudicated = answer ?? ACCEPTED;
      return adjudicated;
    },
    async recordAdjudicatorFailure(suggestionId, traceId, code) {
      calls.push("recordAdjudicatorFailure");
      args.recordAdjudicatorFailure = [suggestionId, traceId, code];
      if (options.recorded instanceof ApplicationFailure) throw options.recorded;
      adjudicated = options.recorded ?? { outcome: "FAILED" };
      return adjudicated;
    },
    async recordDecision(suggestionId, workflowId, attempt, traceId, decided) {
      calls.push("recordDecision");
      args.recordDecision = [suggestionId, workflowId, attempt, traceId, decided];
      if (options.holdDecision === true && attempt === 1) await gate;
      const ruled = decided.by === "intake-rules" ? decided : null;
      const fromRow = decided.by === "adjudicator" && adjudicated?.outcome === "DECIDED" ? adjudicated : null;
      const decision: Decision = ruled?.decision ?? fromRow?.decision ?? "CURATOR_REVIEW";
      const state = pathOf(decision, decided.by, "HUMAN").at(-1) ?? "SUBMITTED";
      left = { state, decision };
      return { state, decision, sufficientTier: ruled?.namedTier ?? fromRow?.sufficientTier ?? null };
    },
    async recordCuratorDecision(suggestionId, workflowId, actionId) {
      calls.push("recordCuratorDecision");
      args.recordCuratorDecision = [suggestionId, workflowId, actionId];
      const answer = curator.shift();
      if (answer instanceof ApplicationFailure) throw answer;
      const recorded = answer ?? { recorded: true, state: "MERGING", decision: "ACCEPT" };
      if (recorded.recorded) left = { state: recorded.state, decision: recorded.decision };
      return recorded;
    },
    async markBudgetWait(suggestionId, resetsAt) {
      calls.push("markBudgetWait");
      budgetMarks.push(resetsAt);
    },
    async throttleOnDecline(suggestionId) {
      calls.push("throttleOnDecline");
      args.throttleOnDecline = [suggestionId];
      return { throttledUntil: null };
    },
    async recordEndorsement(suggestionId, workflowId, endorsed) {
      calls.push(`recordEndorsement:${endorsed.withdrawn ? "withdrawn" : "endorsed"}`);
      args.recordEndorsement = [suggestionId, workflowId, endorsed];
      if (endorsementFailures > 0) {
        endorsementFailures -= 1;
        throw ApplicationFailure.create({ type: "LEDGER_DOWN", message: "the ledger is away", nonRetryable: true });
      }
      return { recorded: true };
    },
    async recordWithdrawal(suggestionId, workflowId, withdrawn) {
      calls.push("recordWithdrawal");
      args.recordWithdrawal = [suggestionId, workflowId, withdrawn];
      const answer = withdrawal.shift();
      if (answer instanceof ApplicationFailure) throw answer;
      const recorded = answer ?? { recorded: true };
      if (recorded.recorded) left = { state: "CLOSED", decision: left.decision };
      return recorded;
    },
    async reopenForRevision(suggestionId, workflowId, attempt, decidedAt) {
      calls.push("reopenForRevision");
      args.reopenForRevision = [suggestionId, workflowId, attempt, decidedAt];
      return { reopened: options.reopened ?? true };
    },
  };
  const grader: EvidenceActivities = {
    async fetchItem(itemId) {
      calls.push(`fetchItem:${itemId}`);
      return pending[itemId]?.opened === false ? { opened: false, fetchStatus: "unreachable:403" } : { opened: true, fetchStatus: "opened:200" };
    },
    async storeText(itemId) {
      calls.push(`storeText:${itemId}`);
      return { text: pending[itemId]?.text !== false };
    },
    async gradeItem(itemId) {
      calls.push(`gradeItem:${itemId}`);
      /* an item at the cap meets it the first time, and is graded once the run has slept until the reset */
      const times = (gradedTimes.get(itemId) ?? 0) + 1;
      gradedTimes.set(itemId, times);
      return pending[itemId]?.budget === true && times === 1 ? { state: "PENDING", ...CAP } : { state: "GRADED", tier: "C" };
    },
  };
  const merge: MergeActivities = {
    async prepareMerge(suggestionId) {
      calls.push("prepareMerge");
      args.prepareMerge = [suggestionId];
      const answer = prepared.shift() ?? { outcome: "NOT_MERGING", ...left };
      if (answer.outcome === "MOVED" || answer.outcome === "NOT_MERGING") left = { state: answer.state, decision: answer.decision };
      return answer;
    },
    async checkMerge() {
      calls.push("checkMerge");
      return checked.shift() ?? { verdict: "PASSED" };
    },
    async returnMerge() {
      calls.push("returnMerge");
      left = { state: "DECIDED", decision: "REQUEST_MORE" };
      return left;
    },
    /* a curator's merge (unit 54c) is the merge suite's: nothing here signals one */
    async recordMergeAction() {
      calls.push("recordMergeAction");
      return { recorded: false };
    },
    async mergeMain() {
      calls.push("mergeMain");
      return { outcome: "AGAIN" };
    },
    async publishMerge() {
      calls.push("publishMerge");
      return { releaseId: "2026.10", carried: null };
    },
    async recordMerged() {
      calls.push("recordMerged");
      return left;
    },
  };
  return { activities: { ...own, ...grader, ...merge }, calls, args, attempts, budgetMarks, release: () => release() };
}

type Doubled = ReturnType<typeof doubles>;

/** The timers a run started, in seconds: a sleep at a budget cap is one. */
async function timersOf(handle: WorkflowHandle): Promise<ReadonlyArray<number>> {
  const { events } = await handle.fetchHistory();
  return (events ?? []).flatMap((event) => {
    const timeout = event.timerStartedEventAttributes?.startToFireTimeout;
    return timeout === null || timeout === undefined ? [] : [Number(timeout.seconds ?? 0)];
  });
}

const rootCause = (error: unknown): unknown => (error instanceof Error && error.cause !== undefined ? rootCause(error.cause) : error);

/** Until the run waits for something — its `waits` query answers — and that answer; it fails after five seconds. */
async function waiting(handle: WorkflowHandle): Promise<NonNullable<SuggestionWaits>> {
  for (let tries = 0; tries < 500; tries += 1) {
    const waits = SuggestionWaitsSchema.parse(await handle.query(SUGGESTION_WAITS_QUERY));
    if (waits !== null) return waits;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the run never waited");
}

describe("SuggestionWorkflow in the test environment", () => {
  const environment = workflowEnvironment();
  const start = (taskQueue: string, suggestionId = SUGGESTION) => environment().client.workflow.start(SUGGESTION_WORKFLOW, { taskQueue, workflowId: suggestionWorkflowId(suggestionId), args: [{ suggestionId }] });

  const run = async (activities: object, suggestionId = SUGGESTION): Promise<SuggestionWorkflowResult> => environment().withWorker(activities, async (taskQueue) => SuggestionWorkflowResultSchema.parse(await (await start(taskQueue, suggestionId)).result()));

  /** Run to the decision, check what the run then waits for, and end it there. */
  const waitsAfter = async (doubled: Doubled): Promise<NonNullable<SuggestionWaits>> =>
    environment().withWorker(doubled.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      const waits = await waiting(handle);
      await handle.terminate("the test has what it needs");
      return waits;
    });

  it("runs steps 1 to 9 in order — the record, the sensors, a pending item through the grader, the graded record, the route, the consistency sensors, the adjudicator, the decision — and ends at an accept", async () => {
    const { activities, calls, args } = doubles({ pending: { [FIRST]: {} } });
    expect(await run(activities)).toEqual({ suggestionId: SUGGESTION, state: "DECIDED", route: "ADJUDICATE", failingSensor: null, namedTier: null, score: 56, decision: "ACCEPT", sufficientTier: null });
    /* the accept starts the merge, whose double finds the suggestion where the decision left it */
    expect(calls).toEqual(["recordSubmitted", "runIntake", "pendingItems", `fetchItem:${FIRST}`, `storeText:${FIRST}`, `gradeItem:${FIRST}`, "recordGraded", "routeSuggestion", "runConsistency", "adjudicateSuggestion", "recordDecision", "prepareMerge"]);
    expect(args.prepareMerge).toEqual([SUGGESTION]);
    expect(args.recordSubmitted).toEqual([SUGGESTION, `suggestion:${SUGGESTION}`]);
    /* The graded record's step: this workflow's id, attempt 1, and a trace id of its own. */
    expect(args.recordGraded?.slice(0, 3)).toEqual([SUGGESTION, `suggestion:${SUGGESTION}`, 1]);
    expect(args.recordGraded?.[3]).toMatch(/^[0-9a-f]{32}$/);
    /* The route is asked with step 3's score and tier and step 2's verdicts. */
    expect(args.routeSuggestion).toEqual([SUGGESTION, 56, "C", PASSES]);
    /* The adjudicator is asked, and the decision recorded, under the same run, attempt and trace id as the graded record (33 § 12). */
    expect(args.adjudicateSuggestion).toEqual(args.recordGraded);
    expect(args.recordDecision).toEqual([...(args.recordGraded ?? []), { by: "adjudicator" }]);
  });

  it("declines by rule at a failing sensor, with no item graded, no score and no route asked (invariant 11), and waits for a revision", async () => {
    const verdicts = PASSES.map((verdict) => (verdict.sensor === "ANCHOR_EXISTS" ? { ...verdict, result: "FAIL" as const } : verdict));
    const doubled = doubles({ verdicts, pending: { [FIRST]: {} } });
    expect(await waitsAfter(doubled)).toEqual({ curator: false, revision: true });
    expect(doubled.calls).toEqual(["recordSubmitted", "runIntake", "recordDecision", "throttleOnDecline"]);
    expect(doubled.args.recordDecision?.[4]).toEqual({ by: "intake-rules", decision: "DECLINE", failingSensor: "ANCHOR_EXISTS", namedTier: null });
  });

  it("takes an item that could not be opened, or has nothing to read, no further, and then records and routes", async () => {
    const { activities, calls } = doubles({ pending: { [FIRST]: { opened: false }, [SECOND]: { text: false } } });
    expect(await run(activities)).toMatchObject({ route: "ADJUDICATE", score: 56 });
    expect(calls).toEqual(["recordSubmitted", "runIntake", "pendingItems", `fetchItem:${FIRST}`, `fetchItem:${SECOND}`, `storeText:${SECOND}`, "recordGraded", "routeSuggestion", "runConsistency", "adjudicateSuggestion", "recordDecision", "prepareMerge"]);
  });

  it("only records and routes when nothing is pending, as for a person whose items were graded when they were added", async () => {
    const { activities, calls } = doubles();
    expect(await run(activities)).toMatchObject({ route: "ADJUDICATE", score: 56 });
    expect(calls).toEqual(["recordSubmitted", "runIntake", "pendingItems", "recordGraded", "routeSuggestion", "runConsistency", "adjudicateSuggestion", "recordDecision", "prepareMerge"]);
  });

  it("sleeps at a budget cap until the reset, saying so on the suggestion, then grades the item again, its text already stored, and goes on (33 § 7, § 11.11; unit 50f)", async () => {
    const doubled = doubles({ pending: { [FIRST]: { budget: true }, [SECOND]: {} } });
    const { result, timers } = await environment().withWorker(doubled.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      return { result: SuggestionWorkflowResultSchema.parse(await handle.result()), timers: await timersOf(handle) };
    });
    expect(result).toMatchObject({ state: "DECIDED", route: "ADJUDICATE", score: 56, decision: "ACCEPT" });
    /* the run slept a week, as the activity measured it, and woke when the test's clock passed the reset */
    expect(timers).toEqual([7 * 86_400]);
    expect(doubled.budgetMarks).toEqual([CAP.resetsAt, null]);
    expect(doubled.calls.slice(0, 9)).toEqual(["recordSubmitted", "runIntake", "pendingItems", `fetchItem:${FIRST}`, `storeText:${FIRST}`, `gradeItem:${FIRST}`, "markBudgetWait", "markBudgetWait", `gradeItem:${FIRST}`]);
  });

  it("records a rule's request for more with the tier it names, for the queue and a revision alike, and a rule's decline for a revision; step 5 does not run for either", async () => {
    const asked = doubles({ route: { route: "REQUEST_MORE_BY_RULE", namedTier: "A" } });
    expect(await waitsAfter(asked)).toEqual({ curator: true, revision: true });
    expect(asked.args.recordDecision?.[4]).toEqual({ by: "intake-rules", decision: "REQUEST_MORE", failingSensor: null, namedTier: "A" });
    expect(asked.calls).not.toContain("runConsistency");
    const declined = doubles({ route: { route: "DECLINE_AT_INTAKE", namedTier: null } });
    expect(await waitsAfter(declined)).toEqual({ curator: false, revision: true });
    expect(declined.args.recordDecision?.[4]).toEqual({ by: "intake-rules", decision: "DECLINE", failingSensor: null, namedTier: null });
    expect(declined.calls).not.toContain("runConsistency");
  });

  it("runs step 5 for a route that goes on, and declines by rule at a failing consistency sensor, naming it (unit 50c); a warning declines nothing", async () => {
    const failed = doubles({ consistency: [{ sensor: "DERIVE_CONSISTENCY", result: "NA" }, { sensor: "CROSS_CHAPTER", result: "WARN" }, { sensor: "LINT", result: "FAIL" }] });
    expect(await waitsAfter(failed)).toEqual({ curator: false, revision: true });
    expect(failed.calls).not.toContain("adjudicateSuggestion");
    expect(failed.args.runConsistency).toEqual([SUGGESTION]);
    expect(failed.args.recordDecision?.[4]).toEqual({ by: "intake-rules", decision: "DECLINE", failingSensor: "LINT", namedTier: null });
    const warned = doubles({ route: { route: "CURATOR", namedTier: null }, consistency: [{ sensor: "DERIVE_CONSISTENCY", result: "NA" }, { sensor: "CROSS_CHAPTER", result: "WARN" }, { sensor: "LINT", result: "NA" }] });
    expect(await waitsAfter(warned)).toEqual({ curator: true, revision: false });
    expect(warned.calls.slice(-2)).toEqual(["runConsistency", "recordDecision"]);
  });

  it("sends a curator's route to the queue at step 6, asking no model, and waits there for the curator's decision, which it records and ends at (33 § 6.3)", async () => {
    const doubled = doubles({ route: { route: "CURATOR", namedTier: null } });
    const result = await environment().withWorker(doubled.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      expect(await waiting(handle)).toEqual({ curator: true, revision: false });
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toEqual({ suggestionId: SUGGESTION, state: "MERGING", route: "CURATOR", failingSensor: null, namedTier: null, score: 56, decision: "ACCEPT", sufficientTier: null });
    expect(doubled.calls).not.toContain("adjudicateSuggestion");
    expect(doubled.args.recordDecision?.[4]).toEqual({ by: "router" });
    expect(doubled.args.recordCuratorDecision).toEqual([SUGGESTION, `suggestion:${SUGGESTION}`, ACTION]);
  });

  it("records a reader's name on a proposal in the queue, and the name taken back, each by its activity in order and beside the wait; a name sent as the decision comes is recorded before the run ends (42 § 6; unit 59d)", async () => {
    const doubled = doubles({ route: { route: "CURATOR", namedTier: null } });
    const endorsed = { userId: "11111111-1111-4111-8111-111111111111", at: "2026-10-10T12:00:00.000Z", withdrawn: false };
    const result = await environment().withWorker(doubled.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      expect(await waiting(handle)).toEqual({ curator: true, revision: false });
      await handle.signal(SUGGESTION_ENDORSED_SIGNAL, endorsed);
      await handle.signal(SUGGESTION_ENDORSED_SIGNAL, { ...endorsed, withdrawn: true });
      /* a signal that names no reader is ignored, and the run still waits */
      await handle.signal(SUGGESTION_ENDORSED_SIGNAL, { userId: "nobody" });
      for (let tries = 0; tries < 200 && !doubled.calls.includes("recordEndorsement:withdrawn"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await waiting(handle)).toEqual({ curator: true, revision: false });
      await handle.signal(SUGGESTION_ENDORSED_SIGNAL, { ...endorsed, at: "2026-10-10T12:05:00.000Z" });
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "MERGING", decision: "ACCEPT" });
    expect(doubled.calls.filter((call) => call.startsWith("recordEndorsement"))).toEqual(["recordEndorsement:endorsed", "recordEndorsement:withdrawn", "recordEndorsement:endorsed"]);
    expect(doubled.args.recordEndorsement).toEqual([SUGGESTION, `suggestion:${SUGGESTION}`, { ...endorsed, at: "2026-10-10T12:05:00.000Z" }]);
  });

  it("asks a reader's name again after a while where its record failed, before the next, and the run ends once it is written (unit 59's review)", async () => {
    const doubled = doubles({ route: { route: "CURATOR", namedTier: null }, endorsementFailures: 1 });
    const endorsed = { userId: "11111111-1111-4111-8111-111111111111", at: "2026-10-10T12:00:00.000Z", withdrawn: false };
    const result = await environment().withWorker(doubled.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      expect(await waiting(handle)).toEqual({ curator: true, revision: false });
      await handle.signal(SUGGESTION_ENDORSED_SIGNAL, endorsed);
      await handle.signal(SUGGESTION_ENDORSED_SIGNAL, { ...endorsed, withdrawn: true });
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "MERGING", decision: "ACCEPT" });
    /* the failed one first, asked again after its wait, then the withdrawal after it: none lost, the order kept */
    expect(doubled.calls.filter((call) => call.startsWith("recordEndorsement"))).toEqual(["recordEndorsement:endorsed", "recordEndorsement:endorsed", "recordEndorsement:withdrawn"]);
  });

  it("records step 7's request for more, which waits for a curator or a revision; its decline ends the run; its failure and the policy's refusal wait in the queue, recorded by who decided; a cap is slept out and the adjudicator asked again (units 50d, 50f)", async () => {
    const asked = doubles({ adjudication: { outcome: "DECIDED", decision: "REQUEST_MORE", sufficientTier: "D" } });
    expect(await waitsAfter(asked)).toEqual({ curator: true, revision: true });
    expect(await run(doubles({ adjudication: { outcome: "DECIDED", decision: "DECLINE", sufficientTier: null } }).activities)).toMatchObject({ state: "CLOSED", decision: "DECLINE", failingSensor: null });
    for (const [outcome, by] of [["FAILED", "adjudicator"], ["REFUSED", "router"]] as const) {
      const doubled = doubles({ adjudication: { outcome } });
      expect(await waitsAfter(doubled), outcome).toEqual({ curator: true, revision: false });
      /* the activity recorded its own failure, or the refusal needs no row; the decision is recorded by who made it */
      expect(doubled.calls, outcome).not.toContain("recordAdjudicatorFailure");
      expect(doubled.args.recordDecision?.[4], outcome).toEqual({ by });
    }
    /* the principal's cap: the run sleeps until the reset and asks the adjudicator again, then decides (unit 50f) */
    const capped = doubles({ adjudicationAtCap: true });
    const { result, timers } = await environment().withWorker(capped.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      return { result: SuggestionWorkflowResultSchema.parse(await handle.result()), timers: await timersOf(handle) };
    });
    expect(result).toMatchObject({ state: "DECIDED", route: "ADJUDICATE", decision: "ACCEPT" });
    expect(timers).toEqual([7 * 86_400]);
    expect(capped.budgetMarks).toEqual([CAP.resetsAt, null]);
    expect(capped.calls.filter((call) => call === "adjudicateSuggestion")).toHaveLength(2);
    expect(capped.calls.filter((call) => call === "recordDecision")).toHaveLength(1);
  });

  it("asks the adjudicator once, never again when it fails, and has its failure recorded by its code for the curator (invariant 15)", async () => {
    const thrown = doubles({ adjudication: ApplicationFailure.retryable("the database went away", "DATABASE_GONE") });
    expect(await waitsAfter(thrown)).toEqual({ curator: true, revision: false });
    expect(thrown.calls.filter((call) => call === "adjudicateSuggestion")).toHaveLength(1);
    expect(thrown.calls.slice(-3)).toEqual(["adjudicateSuggestion", "recordAdjudicatorFailure", "recordDecision"]);
    expect(thrown.args.recordAdjudicatorFailure).toEqual([SUGGESTION, thrown.args.recordGraded?.[3], "DATABASE_GONE"]);
  });

  it("returns what the attempt's row says when the activity wrote it before failing, and the curator when even its failure cannot be written", async () => {
    const lost = doubles({ adjudication: ApplicationFailure.retryable("the completion was lost", "LOST"), recorded: ACCEPTED });
    expect(await run(lost.activities)).toMatchObject({ state: "DECIDED", route: "ADJUDICATE", decision: "ACCEPT" });
    const unwritten = doubles({ adjudication: ApplicationFailure.retryable("the database went away", "DATABASE_GONE"), recorded: ApplicationFailure.nonRetryable("still gone", "DATABASE_GONE") });
    expect(await waitsAfter(unwritten)).toEqual({ curator: true, revision: false });
    expect(unwritten.calls.filter((call) => call === "recordAdjudicatorFailure")).toHaveLength(1);
  });

  it("leaves a request for more a curator kept waiting for a revision, and a revision runs steps 2 to 9 again as attempt 2, under its own trace id (33 § 6.4)", async () => {
    const doubled = doubles({ adjudication: { outcome: "DECIDED", decision: "REQUEST_MORE", sufficientTier: "D" }, curator: [{ recorded: true, state: "DECIDED", decision: "REQUEST_MORE" }], revisedAdjudication: ACCEPTED });
    const result = await environment().withWorker(doubled.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      expect(await waiting(handle)).toEqual({ curator: true, revision: true });
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      for (let tries = 0; tries < 500 && !doubled.calls.includes("recordCuratorDecision"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      /* kept at request for more: now in DECIDED, the queue is done with it and only a revision moves it */
      expect(await waiting(handle)).toEqual({ curator: false, revision: true });
      await handle.signal(SUGGESTION_REVISED_SIGNAL, { decidedAt: DECIDED_AT });
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "DECIDED", route: "ADJUDICATE", decision: "ACCEPT" });
    /* the revision's activity is told the decision it answers, to judge it by (33 § 20) */
    expect(doubled.args.reopenForRevision).toEqual([SUGGESTION, `suggestion:${SUGGESTION}`, 2, DECIDED_AT]);
    const [first, second] = doubled.attempts;
    expect([first?.[0], second?.[0]]).toEqual([1, 2]);
    expect(second?.[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(second?.[1]).not.toBe(first?.[1]);
    expect(doubled.args.recordDecision?.slice(2, 4)).toEqual([2, second?.[1]]);
    expect(doubled.calls.filter((call) => call === "runIntake")).toHaveLength(2);
  });

  it("keeps a signal that comes before the run waits: a curator's decision sent while the decision is still being recorded is taken once it waits (the review of part 2)", async () => {
    const doubled = doubles({ route: { route: "CURATOR", namedTier: null }, holdDecision: true });
    const result = await environment().withWorker(doubled.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      for (let tries = 0; tries < 500 && !doubled.calls.includes("recordDecision"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      /* the move is made, the curator acts, and only then does the run see its decision */
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      doubled.release();
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "MERGING", decision: "ACCEPT" });
    expect(doubled.args.recordCuratorDecision).toEqual([SUGGESTION, `suggestion:${SUGGESTION}`, ACTION]);
  });

  it("takes each action in turn — one that is none of this visit's costs the next nothing — and records again, a minute later, an action whose step failed, since it stands (the review of part 2; unit 53's review)", async () => {
    const turns = doubles({ route: { route: "CURATOR", namedTier: null }, holdDecision: true, curator: [{ recorded: false }, { recorded: true, state: "CLOSED", decision: "DECLINE" }] });
    const declined = await environment().withWorker(turns.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      for (let tries = 0; tries < 500 && !turns.calls.includes("recordDecision"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: LATER });
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      turns.release();
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(declined).toMatchObject({ state: "CLOSED", decision: "DECLINE" });
    expect(turns.calls.filter((call) => call === "recordCuratorDecision")).toHaveLength(2);

    /* The step's attempts spent (the ledger's lock, say): the endpoint takes no second action for the visit, so the run records this one again after a minute rather than drop it. */
    const failing = doubles({ route: { route: "CURATOR", namedTier: null }, curator: [ApplicationFailure.nonRetryable("the ledger's lock was not had in time", "LEDGER_BUSY")] });
    const accepted = await environment().withWorker(failing.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      await waiting(handle);
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      const result = SuggestionWorkflowResultSchema.parse(await handle.result());
      return { result, timers: await timersOf(handle) };
    });
    expect(accepted.result).toMatchObject({ state: "MERGING", decision: "ACCEPT" });
    expect(failing.calls.filter((call) => call === "recordCuratorDecision")).toHaveLength(2);
    expect(failing.args.recordCuratorDecision).toEqual([SUGGESTION, `suggestion:${SUGGESTION}`, ACTION]);
    expect(accepted.timers).toEqual([60]);
  });

  it("takes each signal only where it applies, and its activity judges it: a revision sent before any decision answers none; a curator's decision is nothing to a decline by rule, nor a revision to a curator's change", async () => {
    /* a revision signalled while the first attempt runs is kept, and its activity finds it answers no decision that stands */
    const early = doubles({ holdSubmitted: true, route: { route: "REQUEST_MORE_BY_RULE", namedTier: "A" }, reopened: false });
    await environment().withWorker(early.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      await handle.signal(SUGGESTION_REVISED_SIGNAL, { decidedAt: "2026-01-01T00:00:00.000Z" });
      early.release();
      for (let tries = 0; tries < 500 && !early.calls.includes("reopenForRevision"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await waiting(handle)).toEqual({ curator: true, revision: true });
      await handle.terminate("the test has what it needs");
    });
    expect(early.args.reopenForRevision?.[3]).toBe("2026-01-01T00:00:00.000Z");
    expect(early.calls.filter((call) => call === "runIntake")).toHaveLength(1);

    /* declined by rule: a curator's decision is never taken, and the revision after it is */
    const declined = doubles({ route: { route: "DECLINE_AT_INTAKE", namedTier: null } });
    await environment().withWorker(declined.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      await waiting(handle);
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      await handle.signal(SUGGESTION_REVISED_SIGNAL, { decidedAt: DECIDED_AT });
      for (let tries = 0; tries < 500 && declined.calls.filter((call) => call === "recordDecision").length < 2; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await waiting(handle)).toEqual({ curator: false, revision: true });
      await handle.terminate("the test has what it needs");
    });
    expect(declined.calls).toContain("reopenForRevision");
    expect(declined.calls).not.toContain("recordCuratorDecision");

    /* in the queue for a curator's change: a revision is never taken, and the action after it is */
    const queued = doubles({ route: { route: "CURATOR", namedTier: null }, curator: [{ recorded: true, state: "CLOSED", decision: "DECLINE" }] });
    const result = await environment().withWorker(queued.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      await waiting(handle);
      await handle.signal(SUGGESTION_REVISED_SIGNAL, { decidedAt: DECIDED_AT });
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "CLOSED", decision: "DECLINE" });
    expect(queued.calls).not.toContain("reopenForRevision");
  });

  it("counts toward the throttle after every decline — by rule, by the adjudicator, by a curator — and after nothing else (unit 50f)", async () => {
    const declined = doubles({ adjudication: { outcome: "DECIDED", decision: "DECLINE", sufficientTier: null } });
    expect(await run(declined.activities)).toMatchObject({ state: "CLOSED", decision: "DECLINE" });
    expect(declined.calls.slice(-2)).toEqual(["recordDecision", "throttleOnDecline"]);
    expect(declined.args.throttleOnDecline).toEqual([SUGGESTION]);

    const accepted = doubles();
    await run(accepted.activities);
    expect(accepted.calls).not.toContain("throttleOnDecline");

    const curator = doubles({ route: { route: "CURATOR", namedTier: null }, curator: [{ recorded: true, state: "CLOSED", decision: "DECLINE" }] });
    await environment().withWorker(curator.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      await waiting(handle);
      expect(curator.calls).not.toContain("throttleOnDecline");
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      await handle.result();
    });
    expect(curator.calls.slice(-2)).toEqual(["recordCuratorDecision", "throttleOnDecline"]);
  });

  it("starts the merge after an accept and waits where it leaves the suggestion: a failed check's request for more for a revision, a moved anchor for a curator (unit 54b)", async () => {
    /* the adjudicator's accept of a person's suggestion; the check fails, and the suggestion is returned for more */
    const failed = doubles({ prepared: [{ outcome: "BRANCHED" }], checked: [{ verdict: "FAILED" }] });
    const returned = await environment().withWorker(failed.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      const waits = await waiting(handle);
      await handle.terminate("the test has what it needs");
      return waits;
    });
    expect(returned).toEqual({ curator: false, revision: true });
    expect(failed.calls.slice(-4)).toEqual(["recordDecision", "prepareMerge", "checkMerge", "returnMerge"]);

    /* a curator's accept; main moved under the anchor, and the suggestion is a curator's again, who may decline it */
    const moved = doubles({ route: { route: "CURATOR", namedTier: null }, prepared: [{ outcome: "MOVED", state: "CURATOR_QUEUE", decision: "CURATOR_REVIEW" }], curator: [{ recorded: true, state: "MERGING", decision: "ACCEPT" }, { recorded: true, state: "CLOSED", decision: "DECLINE" }] });
    const declined = await environment().withWorker(moved.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      await waiting(handle);
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      for (let tries = 0; tries < 500 && !moved.calls.includes("prepareMerge"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await waiting(handle)).toEqual({ curator: true, revision: false });
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: LATER });
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(declined).toMatchObject({ state: "CLOSED", decision: "DECLINE" });
    expect(moved.calls.filter((call) => call === "prepareMerge")).toHaveLength(1);
  });

  it("sleeps a minute at the least when the reset has passed or is not yet made, so asks at the cap never follow each other at once (the review of 50f)", async () => {
    const doubled = doubles({ adjudicationAtCap: true });
    const passed = { ...doubled.activities, adjudicateSuggestion: async (...args: Parameters<SuggestionActivities["adjudicateSuggestion"]>) => {
      const answer = await doubled.activities.adjudicateSuggestion(...args);
      return answer.outcome === "BUDGET" ? { ...answer, waitMs: 0 } : answer;
    } };
    const timers = await environment().withWorker(passed, async (taskQueue) => {
      const handle = await start(taskQueue);
      await handle.result();
      return timersOf(handle);
    });
    expect(timers).toEqual([60]);
  });

  it("tries the first step again while the row is not there yet, and goes on when it is", async () => {
    const { activities, calls } = doubles({ submittedFailures: 2 });
    expect(await run(activities)).toMatchObject({ route: "ADJUDICATE" });
    expect(calls.filter((call) => call === "recordSubmitted")).toHaveLength(3);
  });

  it("fails without retry on an argument that is not a suggestion's id, having asked nothing", async () => {
    const { activities, calls } = doubles();
    const failed = await run(activities, "nonsense").catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(WorkflowFailedError);
    expect(rootCause(failed)).toMatchObject({ type: "WORKFLOW_INPUT" });
    expect(calls).toEqual([]);
  });

  it("takes a contributor's withdrawal wherever the run waits — the queue, a decline by rule, a request for more — and ends CLOSED with the decision that stood; a signal that names no contributor is ignored (45 § 5.3)", async () => {
    const queued = doubles({ route: { route: "CURATOR", namedTier: null } });
    const closed = await environment().withWorker(queued.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      expect(await waiting(handle)).toEqual({ curator: true, revision: false });
      await handle.signal(SUGGESTION_WITHDRAWN_SIGNAL, { userId: "nobody" });
      expect(await waiting(handle)).toEqual({ curator: true, revision: false });
      await handle.signal(SUGGESTION_WITHDRAWN_SIGNAL, WITHDRAWN);
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(closed).toEqual({ suggestionId: SUGGESTION, state: "CLOSED", route: "CURATOR", failingSensor: null, namedTier: null, score: 56, decision: "CURATOR_REVIEW", sufficientTier: null });
    expect(queued.args.recordWithdrawal).toEqual([SUGGESTION, `suggestion:${SUGGESTION}`, WITHDRAWN]);
    expect(queued.calls.filter((call) => call === "recordWithdrawal")).toHaveLength(1);

    /* a decline by rule: closed with its decline, the throttle counted once, at the decline, and not again */
    const declined = doubles({ route: { route: "DECLINE_AT_INTAKE", namedTier: null } });
    const fromDecline = await environment().withWorker(declined.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      expect(await waiting(handle)).toEqual({ curator: false, revision: true });
      await handle.signal(SUGGESTION_WITHDRAWN_SIGNAL, WITHDRAWN);
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(fromDecline).toMatchObject({ state: "CLOSED", decision: "DECLINE" });
    expect(declined.calls.filter((call) => call === "throttleOnDecline")).toHaveLength(1);

    /* a request for more by rule, where a curator and a revision are both waited for */
    const askedForMore = doubles({ route: { route: "REQUEST_MORE_BY_RULE", namedTier: "A" } });
    const fromRequest = await environment().withWorker(askedForMore.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      expect(await waiting(handle)).toEqual({ curator: true, revision: true });
      await handle.signal(SUGGESTION_WITHDRAWN_SIGNAL, WITHDRAWN);
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(fromRequest).toMatchObject({ state: "CLOSED", decision: "REQUEST_MORE" });

    /* a request made where the queue holds no decision's time: its signal says so, and is taken as any other */
    const timeless = doubles({ route: { route: "CURATOR", namedTier: null } });
    const fromTimeless = await environment().withWorker(timeless.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      await waiting(handle);
      await handle.signal(SUGGESTION_WITHDRAWN_SIGNAL, { ...WITHDRAWN, decidedAt: null });
      return SuggestionWorkflowResultSchema.parse(await handle.result());
    });
    expect(fromTimeless).toMatchObject({ state: "CLOSED" });
    expect(timeless.args.recordWithdrawal).toEqual([SUGGESTION, `suggestion:${SUGGESTION}`, { ...WITHDRAWN, decidedAt: null }]);
  });

  it("takes a curator's action already queued first, then the withdrawal, then a revision; a withdrawal that no longer stands leaves the run waiting (45 § 5.3)", async () => {
    const doubled = doubles({ route: { route: "REQUEST_MORE_BY_RULE", namedTier: "A" }, holdDecision: true, curator: [{ recorded: true, state: "DECIDED", decision: "REQUEST_MORE" }], withdrawal: [{ recorded: false }] });
    const result = await environment().withWorker(doubled.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      for (let tries = 0; tries < 500 && !doubled.calls.includes("recordDecision"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      /* sent in this order while the decision is still being recorded: the run takes them in its own */
      await handle.signal(SUGGESTION_REVISED_SIGNAL, { decidedAt: DECIDED_AT });
      await handle.signal(SUGGESTION_WITHDRAWN_SIGNAL, WITHDRAWN);
      await handle.signal(SUGGESTION_CURATOR_SIGNAL, { actionId: ACTION });
      doubled.release();
      /* the revision's attempt runs to its own wait before the run is ended: one ended mid-attempt leaves an activity the test server's clock waits for */
      for (let tries = 0; tries < 500 && doubled.calls.filter((call) => call === "recordDecision").length < 2; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      await waiting(handle);
      await handle.terminate("the test has what it needs");
      return doubled.calls.filter((call) => call === "recordCuratorDecision" || call === "recordWithdrawal" || call === "reopenForRevision");
    });
    expect(result).toEqual(["recordCuratorDecision", "recordWithdrawal", "reopenForRevision"]);
  });

  it("records again, a minute later, a withdrawal whose step failed, since it stands (45 § 5.3)", async () => {
    const failing = doubles({ route: { route: "CURATOR", namedTier: null }, withdrawal: [ApplicationFailure.nonRetryable("the ledger's lock was not had in time", "LEDGER_BUSY")] });
    const withdrew = await environment().withWorker(failing.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      await waiting(handle);
      await handle.signal(SUGGESTION_WITHDRAWN_SIGNAL, WITHDRAWN);
      const result = SuggestionWorkflowResultSchema.parse(await handle.result());
      return { result, timers: await timersOf(handle) };
    });
    expect(withdrew.result).toMatchObject({ state: "CLOSED", decision: "CURATOR_REVIEW" });
    expect(failing.calls.filter((call) => call === "recordWithdrawal")).toHaveLength(2);
    expect(withdrew.timers).toEqual([60]);
  });

  /*
   * A run that waited before unit 63e replays as it ran (feature-specs/45 § 5.3, § 8): its history, recorded on the code
   * before the change, holds a `withdrawn` signal that code had no handler for, a curator's action recorded again after a
   * minute, and a revision's attempt. The fixture is the History message's protobuf encoding: this install has four copies
   * of protobufjs, and the SDK's JSON helpers find the wrong one.
   */
  it("replays a run recorded before unit 63e as it ran: a withdrawal its code never took is dropped, not recorded (45 § 5.3, § 8)", async () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "workflows", "suggestion-before-63e.json"), "utf8")) as { readonly history: string };
    const history = temporal.api.history.v1.History.decode(Buffer.from(fixture.history, "base64"));
    await expect(environment().replay(history, suggestionWorkflowId(SUGGESTION))).resolves.toBeUndefined();
  });
});
