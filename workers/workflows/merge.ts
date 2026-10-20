import { ActivityFailure, ApplicationFailure, condition, defineQuery, defineSignal, log, proxyActivities, setHandler, TimeoutFailure, workflowInfo } from "@temporalio/workflow";

import { MERGE_RECHECK_SIGNAL, MERGE_SIGNAL, MERGE_STAGE_QUERY, MergeSignalSchema, MergeWorkflowInputSchema, type MergeStage, type MergeWorkflowInput, type MergeWorkflowResult } from "@/lib/schemas/workflows";

import type { MergeActivities } from "./activities";

/*
 * MergeWorkflow (feature-specs/37 § 4; unit 54b), the child of a suggestion's workflow under `merge:<id>`: prepare the
 * branch (§ 4.1 to § 4.3), check it (§ 4.4), and act on the check (§ 4.5). Where the merge cannot go on, it waits, with
 * no timer, for `recheck`, which `Re-run check` sends, and then prepares and checks again:
 *
 *   - the repository unavailable (§ 3), until the operator sets it;
 *   - a curator's hand (§ 4.3), until they commit to the branch;
 *   - the lab not run where the change could move a derived figure (D4), until a runner runs it (54b part 2);
 *   - passed, until the curator's merge (54c);
 *   - a step that failed, its attempts spent, until someone looks.
 *
 * A curator's merge (§ 5; unit 54c) is `merge({ actionId })`, kept whenever it comes and taken once the check passed:
 * the action recorded, then `main` moved to the branch and tagged, the tag published as a release, and the `merged`
 * record, the suggestion `MERGED` — where the run ends. `main` or the branch moved since the check, or a check that no
 * longer passed, and the merge prepares and checks again at once, the curator's merge standing: a curator never merges
 * an unchecked tree. A step of it that failed waits for `recheck`; once `main` holds the change and is tagged, what is
 * left — the release and the record — is all a recheck runs again. An action that is none of this check's is dropped.
 * A revert's merge (§ 8; unit 54e) is told the curator's action in its input: it records the action first, since the
 * revert's commit follows from the record, and merges once its check passes; its check failed, it waits as `FAILED`
 * for the curator's hand and `recheck`, since its return moves nothing.
 *
 * It returns where it left the suggestion: back with a curator when `main` moved under the anchor (§ 4.1 step 1),
 * returned as a request for more when the check failed (§ 4.5), or wherever another move took it. Every pass prepares
 * again, so a `main` that moved since is met at § 4.1 and a branch kept from an earlier pass starts over on it.
 *
 * The activities' timeouts and attempts, with their derivation: preparing writes two of the book's trees out, reads the
 * book from one, builds the chapter twice and commits — seconds on this machine — and has five minutes, well over it.
 * Checking writes two trees out and builds every chapter of one, the work of an ingestion without its writes, about ten
 * seconds; then runs the chapter's lab, capped at the lab tier's ten minutes (`Lab.wallClockCapS` 600), and again on
 * `main` where it did not run on the branch: thirty minutes holds both runs at their cap and the builds. Both have three
 * attempts, each idempotent on the row and the repository. A failed check's return moves the row: the 60 s and three
 * attempts of the steps that write after reading (suggestion.ts). The merge's own (unit 54c): recording the curator's
 * action and the `merged` record append and write after reading, the same 60 s and three attempts; moving `main`
 * reads a tree's file, commits one, moves a ref and tags — a preparation's work — and has its five minutes; publishing
 * runs the pipeline's ingestion of the whole book, its diagrams rendered, under its own twenty-minute cap
 * (pipeline/publish.ts), then the vectors' carry, under five: forty minutes holds both. Their failures are said on the
 * row and not tried again but by a recheck — a render hash that differs, `main` checked out — except a timeout.
 */

const { prepareMerge } = proxyActivities<Pick<MergeActivities, "prepareMerge">>({ startToCloseTimeout: "5 minutes", retry: { maximumAttempts: 3 } });
const { checkMerge } = proxyActivities<Pick<MergeActivities, "checkMerge">>({ startToCloseTimeout: "30 minutes", retry: { maximumAttempts: 3 } });
const { returnMerge, recordMergeAction, recordMerged } = proxyActivities<Pick<MergeActivities, "returnMerge" | "recordMergeAction" | "recordMerged">>({ startToCloseTimeout: "60 seconds", retry: { maximumAttempts: 3 } });
const { mergeMain } = proxyActivities<Pick<MergeActivities, "mergeMain">>({ startToCloseTimeout: "5 minutes", retry: { maximumAttempts: 3 } });
const { publishMerge } = proxyActivities<Pick<MergeActivities, "publishMerge">>({ startToCloseTimeout: "40 minutes", retry: { maximumAttempts: 3 } });

/** Checks again after `main` or the branch moved under a merge, in a row, before the run waits for a hand (unit 54's review). */
const AGAIN_LIMIT = 3;

const recheck = defineSignal(MERGE_RECHECK_SIGNAL);
const merge = defineSignal<[unknown]>(MERGE_SIGNAL);
export const mergeStage = defineQuery<MergeStage>(MERGE_STAGE_QUERY);

/** A failed activity's code, for the log: the type its own failure gave, or that it ran out of time. */
function codeOf(error: ActivityFailure): string {
  if (error.cause instanceof ApplicationFailure) return error.cause.type ?? "APPLICATION_FAILURE";
  if (error.cause instanceof TimeoutFailure) return "TIMEOUT";
  return "ACTIVITY_FAILED";
}

/** A step whose failure leaves the merge waiting for `recheck` rather than ends it: a merge that waited weeks is not lost to one bad step. */
async function orNull<T>(step: () => Promise<T>, suggestionId: string): Promise<T | null> {
  try {
    return await step();
  } catch (error: unknown) {
    if (!(error instanceof ActivityFailure)) throw error;
    log.warn("a step of the merge failed, and it waits for recheck", { suggestionId, code: codeOf(error) });
    return null;
  }
}

export async function MergeWorkflow(input: MergeWorkflowInput): Promise<MergeWorkflowResult> {
  if (!MergeWorkflowInputSchema.safeParse(input).success) {
    throw ApplicationFailure.nonRetryable("MergeWorkflow takes { suggestionId: S-NN-NNNN }", "WORKFLOW_INPUT");
  }
  const { suggestionId } = input;
  const { workflowId } = workflowInfo();
  let stage: MergeStage = "PREPARING";
  /* Every recheck is counted, whenever it comes: one sent while a pass runs is a pass more. */
  let asked = 0;
  /* Every curator's merge is kept, whenever it comes, and taken once the check passed (unit 54c); a revert's is given at the start (unit 54e). */
  const merges: string[] = input.actionId === undefined ? [] : [input.actionId];
  setHandler(mergeStage, () => stage);
  setHandler(recheck, () => {
    asked += 1;
  });
  setHandler(merge, (signal) => {
    const parsed = MergeSignalSchema.safeParse(signal);
    if (parsed.success) merges.push(parsed.data.actionId);
    else log.warn("merge ignored: it names no action (37 § 5)", { suggestionId });
  });

  /* The curator's merge being made, and whether `main` holds it, tagged: then the release and the record are what is left. */
  let taken: string | null = null;
  let tagged = false;
  /* Whether this pass prepares and checks: the first, a recheck's, and one after `main` or the branch moved (§ 5 step 2). */
  let pass = true;
  /* A revert's action, recorded before its first preparation (§ 8), and again at a recheck until it is. */
  let recordedFirst = input.actionId === undefined;
  /* How many times in a row `main` or the branch moved under a merge and it was checked again: a third is not tried at once (unit 54's review). */
  let againInARow = 0;

  /** The merge's steps (§ 5), from where they stand; where it ends, the suggestion `MERGED`, or what the run does next. */
  const mergeOnce = async (actionId: string): Promise<MergeWorkflowResult | "AGAIN" | "DROPPED" | "WAIT"> => {
    stage = "MERGING";
    if (!tagged) {
      const recorded = await orNull(() => recordMergeAction(suggestionId, workflowId, actionId), suggestionId);
      if (recorded === null) {
        stage = "STEP_FAILED";
        return "WAIT";
      }
      if (!recorded.recorded) {
        log.warn("merge not recorded: its action is none of this check's", { suggestionId, actionId });
        stage = "PASSED";
        return "DROPPED";
      }
      const moved = await orNull(() => mergeMain(suggestionId), suggestionId);
      if (moved === null) {
        stage = "STEP_FAILED";
        return "WAIT";
      }
      if (moved.outcome === "AGAIN") return "AGAIN";
      tagged = true;
    }
    const published = await orNull(() => publishMerge(suggestionId), suggestionId);
    const done = published === null ? null : await orNull(() => recordMerged(suggestionId, workflowId, actionId), suggestionId);
    if (done === null) {
      stage = "STEP_FAILED";
      return "WAIT";
    }
    return { suggestionId, ...done };
  };

  for (;;) {
    const answered = asked;
    if (pass && !tagged) {
      stage = "PREPARING";
      if (!recordedFirst && input.actionId !== undefined) {
        const first = await orNull(() => recordMergeAction(suggestionId, workflowId, input.actionId ?? ""), suggestionId);
        recordedFirst = first?.recorded === true;
      }
      const prepared = await orNull(() => prepareMerge(suggestionId), suggestionId);
      if (prepared !== null && (prepared.outcome === "NOT_MERGING" || (prepared.outcome === "MOVED" && prepared.state !== "MERGING"))) return { suggestionId, state: prepared.state, decision: prepared.decision };
      if (prepared === null) stage = "STEP_FAILED";
      /* a revert whose anchor moved waits, merging, for the curator's hand and recheck (§ 8; unit 54's review) */
      else if (prepared.outcome === "MOVED") stage = "MOVED";
      else if (prepared.outcome === "UNAVAILABLE") stage = "UNAVAILABLE";
      else {
        stage = "CHECKING";
        const checked = await orNull(() => checkMerge(suggestionId), suggestionId);
        if (checked !== null && checked.verdict === "NOT_MERGING") return { suggestionId, state: checked.state, decision: checked.decision };
        if (checked?.verdict === "FAILED") {
          const returned = await orNull(() => returnMerge(suggestionId), suggestionId);
          /* a revert's return moves nothing: it waits, failed, for the curator's hand (§ 8) */
          if (returned !== null && returned.state !== "MERGING") return { suggestionId, ...returned };
          stage = returned === null ? "STEP_FAILED" : "FAILED";
        } else stage = checked === null ? "STEP_FAILED" : checked.verdict;
      }
    }
    pass = false;

    /* § 5: a curator's merge, once the check passed — or, `main` tagged, to finish */
    if (taken === null && stage === "PASSED") taken = merges.shift() ?? null;
    if (taken !== null && (tagged || stage === "PASSED")) {
      const outcome = await mergeOnce(taken);
      if (outcome === "AGAIN") {
        againInARow += 1;
        if (againInARow < AGAIN_LIMIT) {
          pass = true;
          continue;
        }
        log.warn("merge checked again twice and main or the branch kept moving; it waits for recheck", { suggestionId });
        stage = "STEP_FAILED";
      } else againInARow = 0;
      if (outcome === "DROPPED") {
        taken = null;
        continue;
      }
      if (outcome !== "WAIT" && outcome !== "AGAIN") return outcome;
    }
    await condition(() => asked > answered || (taken === null && stage === "PASSED" && merges.length > 0));
    pass = asked > answered;
    /* a hand's recheck is a fresh allowance of checks after `main` moved */
    if (pass) againInARow = 0;
  }
}
