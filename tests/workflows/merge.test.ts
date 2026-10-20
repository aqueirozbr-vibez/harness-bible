import { ApplicationFailure } from "@temporalio/activity";
import { WorkflowFailedError, type WorkflowHandle } from "@temporalio/client";
import { describe, expect, it } from "vitest";

import { MERGE_RECHECK_SIGNAL, MERGE_SIGNAL, MERGE_STAGE_QUERY, MERGE_WORKFLOW, MergeStageSchema, MergeWorkflowResultSchema, mergeWorkflowId, type MergeStage, type MergeWorkflowResult } from "@/lib/schemas/workflows";
import type { MergeActionRecorded, MergeActivities, MergeChecked, MergedMain, MergeLeft, MergePrepared, MergePublished } from "@/workers/workflows/activities";

import { workflowEnvironment } from "./environment";

/*
 * MergeWorkflow in Temporal's test environment (feature-specs/37 § 4; unit 54b), its three activities doubled: prepare,
 * check, and a failed check's return. It returns where `main` moving under the anchor, or a failed check, leaves the
 * suggestion; and waits for `recheck` where the merge cannot go on — the repository unavailable, a curator's hand, the
 * lab not run, passed, a step whose attempts are spent — saying where through its `stage` query. A recheck sent while a
 * pass runs is a pass more, never lost.
 *
 * A curator's merge (37 § 5; unit 54c), its four steps doubled too: taken once the check passed, whenever it was sent;
 * `main` moved since, checked again at once and merged; a step that failed waits, and once `main` is tagged a recheck
 * runs the release and the record alone; an action none of this check's is dropped, and the next one taken. A revert
 * (37 § 8; unit 54e) is told its action in the input and merges once the check passes; its failed check waits.
 */

const SUGGESTION = "S-21-0016";

interface Script {
  readonly prepared?: ReadonlyArray<MergePrepared | ApplicationFailure>;
  readonly checked?: ReadonlyArray<MergeChecked | ApplicationFailure>;
  /** Hold the first check until released: a recheck sent then comes while the pass runs. */
  readonly holdCheck?: boolean;
  readonly recorded?: ReadonlyArray<MergeActionRecorded | ApplicationFailure>;
  /** A revert's return moves nothing: it stays merging (37 § 8). */
  readonly stays?: boolean;
  readonly moved?: ReadonlyArray<MergedMain | ApplicationFailure>;
  readonly published?: ReadonlyArray<MergePublished | ApplicationFailure>;
}

const ACTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function doubles(script: Script) {
  const calls: string[] = [];
  const prepared = [...(script.prepared ?? [])];
  const checked = [...(script.checked ?? [])];
  const recorded = [...(script.recorded ?? [])];
  const moved = [...(script.moved ?? [])];
  const published = [...(script.published ?? [])];
  const answer = <T>(queue: Array<T | ApplicationFailure>, otherwise: T): T => {
    const next = queue.shift() ?? otherwise;
    if (next instanceof ApplicationFailure) throw next;
    return next;
  };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = script.holdCheck === true;
  const activities: MergeActivities = {
    async prepareMerge(suggestionId) {
      calls.push(`prepareMerge:${suggestionId}`);
      const answer = prepared.shift() ?? { outcome: "BRANCHED" };
      if (answer instanceof ApplicationFailure) throw answer;
      return answer;
    },
    async checkMerge() {
      calls.push("checkMerge");
      if (held) {
        held = false;
        await gate;
      }
      const answer = checked.shift() ?? { verdict: "PASSED" };
      if (answer instanceof ApplicationFailure) throw answer;
      return answer;
    },
    async returnMerge(): Promise<MergeLeft> {
      calls.push("returnMerge");
      return script.stays === true ? { state: "MERGING", decision: "ACCEPT" } : { state: "DECIDED", decision: "REQUEST_MORE" };
    },
    async recordMergeAction(_suggestionId, workflowId, actionId) {
      calls.push(`recordMergeAction:${workflowId}:${actionId}`);
      return answer(recorded, { recorded: true });
    },
    async mergeMain() {
      calls.push("mergeMain");
      return answer(moved, { outcome: "TAGGED", releaseId: "2026.10" });
    },
    async publishMerge() {
      calls.push("publishMerge");
      return answer(published, { releaseId: "2026.10", carried: 361 });
    },
    async recordMerged(_suggestionId, _workflowId, actionId): Promise<MergeLeft> {
      calls.push(`recordMerged:${actionId}`);
      return { state: "MERGED", decision: "ACCEPT" };
    },
  };
  return { activities, calls, release: () => release() };
}

/** Until the merge waits at a stage that is no step's — or the one asked for — and that stage; it fails after five seconds. */
async function waitingAt(handle: WorkflowHandle, stage?: MergeStage): Promise<MergeStage> {
  for (let tries = 0; tries < 500; tries += 1) {
    const now = MergeStageSchema.parse(await handle.query(MERGE_STAGE_QUERY));
    if (stage === undefined ? now !== "PREPARING" && now !== "CHECKING" : now === stage) return now;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the merge never waited");
}

describe("MergeWorkflow in the test environment", () => {
  const environment = workflowEnvironment();
  const start = (taskQueue: string, suggestionId = SUGGESTION) => environment().client.workflow.start(MERGE_WORKFLOW, { taskQueue, workflowId: mergeWorkflowId(suggestionId), args: [{ suggestionId }] });
  const run = async (activities: object): Promise<MergeWorkflowResult> => environment().withWorker(activities, async (taskQueue) => MergeWorkflowResultSchema.parse(await (await start(taskQueue)).result()));

  it("returns a moved anchor's suggestion to the curator, and a failed check's as a request for more (§ 4.1 step 1, § 4.5)", async () => {
    const moved = doubles({ prepared: [{ outcome: "MOVED", state: "CURATOR_QUEUE", decision: "CURATOR_REVIEW" }] });
    expect(await run(moved.activities)).toEqual({ suggestionId: SUGGESTION, state: "CURATOR_QUEUE", decision: "CURATOR_REVIEW" });
    expect(moved.calls).toEqual([`prepareMerge:${SUGGESTION}`]);

    const failed = doubles({ checked: [{ verdict: "FAILED" }] });
    expect(await run(failed.activities)).toEqual({ suggestionId: SUGGESTION, state: "DECIDED", decision: "REQUEST_MORE" });
    expect(failed.calls).toEqual([`prepareMerge:${SUGGESTION}`, "checkMerge", "returnMerge"]);

    const elsewhere = doubles({ prepared: [{ outcome: "NOT_MERGING", state: "CLOSED", decision: "DECLINE" }] });
    expect(await run(elsewhere.activities)).toEqual({ suggestionId: SUGGESTION, state: "CLOSED", decision: "DECLINE" });
  });

  it("waits where the merge cannot go on, says where, and prepares and checks again on recheck (§ 4.3, § 4.5)", async () => {
    const id = "S-21-0019";
    const waits = doubles({
      prepared: [{ outcome: "UNAVAILABLE" }, { outcome: "MANUAL" }, { outcome: "MANUAL" }, { outcome: "BRANCHED" }, { outcome: "MOVED", state: "CURATOR_QUEUE", decision: "CURATOR_REVIEW" }],
      checked: [{ verdict: "MANUAL" }, { verdict: "NOT_RUN" }, { verdict: "PASSED" }],
    });
    const result = await environment().withWorker(waits.activities, async (taskQueue) => {
      const handle = await start(taskQueue, id);
      const stages: MergeStage[] = [];
      for (const expected of ["UNAVAILABLE", "MANUAL", "NOT_RUN", "PASSED"] as const) {
        stages.push(await waitingAt(handle, expected));
        await handle.signal(MERGE_RECHECK_SIGNAL);
      }
      return { stages, result: MergeWorkflowResultSchema.parse(await handle.result()) };
    });
    expect(result.stages).toEqual(["UNAVAILABLE", "MANUAL", "NOT_RUN", "PASSED"]);
    expect(result.result).toMatchObject({ state: "CURATOR_QUEUE", decision: "CURATOR_REVIEW" });
    expect(waits.calls).toEqual([`prepareMerge:${id}`, `prepareMerge:${id}`, "checkMerge", `prepareMerge:${id}`, "checkMerge", `prepareMerge:${id}`, "checkMerge", `prepareMerge:${id}`]);
  });

  it("waits after a step whose attempts are spent, rather than end, and goes on at recheck", async () => {
    const id = "S-21-0017";
    const failing = doubles({ prepared: [ApplicationFailure.nonRetryable("the book's tree did not load", "BOOK_UNREADABLE"), { outcome: "BRANCHED" }], checked: [ApplicationFailure.nonRetryable("the branch is gone", "BRANCH_MISSING"), { verdict: "FAILED" }] });
    const result = await environment().withWorker(failing.activities, async (taskQueue) => {
      const handle = await start(taskQueue, id);
      const first = await waitingAt(handle);
      await handle.signal(MERGE_RECHECK_SIGNAL);
      /* the second pass: prepared, then its check failed in turn */
      for (let tries = 0; tries < 500 && !failing.calls.includes("checkMerge"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await waitingAt(handle);
      await handle.signal(MERGE_RECHECK_SIGNAL);
      return { first, second, result: MergeWorkflowResultSchema.parse(await handle.result()) };
    });
    expect(result).toMatchObject({ first: "STEP_FAILED", second: "STEP_FAILED", result: { state: "DECIDED", decision: "REQUEST_MORE" } });
    expect(failing.calls).toEqual([`prepareMerge:${id}`, `prepareMerge:${id}`, "checkMerge", `prepareMerge:${id}`, "checkMerge", "returnMerge"]);
  });

  it("keeps a recheck sent while a pass runs: the pass ends, and another begins at once", async () => {
    const id = "S-21-0018";
    const early = doubles({ holdCheck: true, checked: [{ verdict: "PASSED" }, { verdict: "FAILED" }] });
    const result = await environment().withWorker(early.activities, async (taskQueue) => {
      const handle = await start(taskQueue, id);
      for (let tries = 0; tries < 500 && !early.calls.includes("checkMerge"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      await handle.signal(MERGE_RECHECK_SIGNAL);
      early.release();
      return MergeWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "DECIDED", decision: "REQUEST_MORE" });
    expect(early.calls).toEqual([`prepareMerge:${id}`, "checkMerge", `prepareMerge:${id}`, "checkMerge", "returnMerge"]);
  });

  it("merges once the check passed (37 § 5): the curator's action recorded, main tagged, the release published, the merged record; then MERGED", async () => {
    const id = "S-21-0020";
    const merging = doubles({});
    const result = await environment().withWorker(merging.activities, async (taskQueue) => {
      const handle = await start(taskQueue, id);
      await waitingAt(handle, "PASSED");
      await handle.signal(MERGE_SIGNAL, { actionId: ACTION });
      return MergeWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toEqual({ suggestionId: id, state: "MERGED", decision: "ACCEPT" });
    expect(merging.calls).toEqual([`prepareMerge:${id}`, "checkMerge", `recordMergeAction:${mergeWorkflowId(id)}:${ACTION}`, "mergeMain", "publishMerge", `recordMerged:${ACTION}`]);
  });

  it("keeps a merge sent before the check passed, and takes it once it has; ignores one that names no action", async () => {
    const id = "S-21-0021";
    const early = doubles({ holdCheck: true });
    const result = await environment().withWorker(early.activities, async (taskQueue) => {
      const handle = await start(taskQueue, id);
      for (let tries = 0; tries < 500 && !early.calls.includes("checkMerge"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      await handle.signal(MERGE_SIGNAL, { actionId: "not an id" } as never);
      await handle.signal(MERGE_SIGNAL, { actionId: ACTION });
      early.release();
      return MergeWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "MERGED" });
    expect(early.calls).toEqual([`prepareMerge:${id}`, "checkMerge", `recordMergeAction:${mergeWorkflowId(id)}:${ACTION}`, "mergeMain", "publishMerge", `recordMerged:${ACTION}`]);
  });

  it("checks again at once where main or the branch moved since the check, the curator's merge standing, and merges then (§ 5 step 2)", async () => {
    const id = "S-21-0022";
    const moved = doubles({ moved: [{ outcome: "AGAIN" }] });
    const result = await environment().withWorker(moved.activities, async (taskQueue) => {
      const handle = await start(taskQueue, id);
      await waitingAt(handle, "PASSED");
      await handle.signal(MERGE_SIGNAL, { actionId: ACTION });
      return MergeWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "MERGED" });
    const recordAction = `recordMergeAction:${mergeWorkflowId(id)}:${ACTION}`;
    expect(moved.calls).toEqual([`prepareMerge:${id}`, "checkMerge", recordAction, "mergeMain", `prepareMerge:${id}`, "checkMerge", recordAction, "mergeMain", "publishMerge", `recordMerged:${ACTION}`]);
  });

  it("checks again after an AGAIN at most twice in a row, then waits for a hand: main that keeps moving is not a hot loop (unit 54's review)", async () => {
    const id = "S-21-0024";
    const restless = doubles({ moved: [{ outcome: "AGAIN" }, { outcome: "AGAIN" }, { outcome: "AGAIN" }, { outcome: "AGAIN" }] });
    const result = await environment().withWorker(restless.activities, async (taskQueue) => {
      const handle = await start(taskQueue, id);
      await waitingAt(handle, "PASSED");
      await handle.signal(MERGE_SIGNAL, { actionId: ACTION });
      expect(await waitingAt(handle, "STEP_FAILED")).toBe("STEP_FAILED");
      /* three merges tried, three checks; a recheck tries once more, and the fifth answer lets it through */
      expect(restless.calls.filter((call) => call === "mergeMain")).toHaveLength(3);
      await handle.signal(MERGE_RECHECK_SIGNAL);
      return MergeWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "MERGED" });
    expect(restless.calls.filter((call) => call === "mergeMain")).toHaveLength(5);
    expect(restless.calls.filter((call) => call === "publishMerge")).toHaveLength(1);
  });

  it("waits after a step of the merge that failed; once main is tagged, a recheck runs the release and the record alone", async () => {
    const id = "S-21-0023";
    const failing = doubles({ published: [ApplicationFailure.nonRetryable("the render hash is not the check's", "RENDER_HASH_MISMATCH")] });
    const result = await environment().withWorker(failing.activities, async (taskQueue) => {
      const handle = await start(taskQueue, id);
      await waitingAt(handle, "PASSED");
      await handle.signal(MERGE_SIGNAL, { actionId: ACTION });
      const stuck = await waitingAt(handle, "STEP_FAILED");
      await handle.signal(MERGE_RECHECK_SIGNAL);
      return { stuck, result: MergeWorkflowResultSchema.parse(await handle.result()) };
    });
    expect(result).toMatchObject({ stuck: "STEP_FAILED", result: { state: "MERGED" } });
    expect(failing.calls).toEqual([`prepareMerge:${id}`, "checkMerge", `recordMergeAction:${mergeWorkflowId(id)}:${ACTION}`, "mergeMain", "publishMerge", "publishMerge", `recordMerged:${ACTION}`]);
  });

  it("before main is tagged, a recheck after a failed step prepares and checks again, then merges with the action that stands", async () => {
    const id = "S-21-0024";
    const failing = doubles({ moved: [ApplicationFailure.nonRetryable("main is checked out in the book's repository", "BOOK_REPO_MAIN_CHECKED_OUT")] });
    const result = await environment().withWorker(failing.activities, async (taskQueue) => {
      const handle = await start(taskQueue, id);
      await waitingAt(handle, "PASSED");
      await handle.signal(MERGE_SIGNAL, { actionId: ACTION });
      await waitingAt(handle, "STEP_FAILED");
      await handle.signal(MERGE_RECHECK_SIGNAL);
      return MergeWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "MERGED" });
    const recordAction = `recordMergeAction:${mergeWorkflowId(id)}:${ACTION}`;
    expect(failing.calls).toEqual([`prepareMerge:${id}`, "checkMerge", recordAction, "mergeMain", `prepareMerge:${id}`, "checkMerge", recordAction, "mergeMain", "publishMerge", `recordMerged:${ACTION}`]);
  });

  it("drops an action that is none of this check's, waits at passed, and takes the next", async () => {
    const id = "S-21-0025";
    const stale = doubles({ recorded: [{ recorded: false }] });
    const result = await environment().withWorker(stale.activities, async (taskQueue) => {
      const handle = await start(taskQueue, id);
      await waitingAt(handle, "PASSED");
      await handle.signal(MERGE_SIGNAL, { actionId: ACTION });
      for (let tries = 0; tries < 500 && !stale.calls.some((call) => call.endsWith(ACTION)); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      const waiting = await waitingAt(handle, "PASSED");
      await handle.signal(MERGE_SIGNAL, { actionId: SECOND });
      return { waiting, result: MergeWorkflowResultSchema.parse(await handle.result()) };
    });
    expect(result).toMatchObject({ waiting: "PASSED", result: { state: "MERGED" } });
    expect(stale.calls).toEqual([`prepareMerge:${id}`, "checkMerge", `recordMergeAction:${mergeWorkflowId(id)}:${ACTION}`, `recordMergeAction:${mergeWorkflowId(id)}:${SECOND}`, "mergeMain", "publishMerge", `recordMerged:${SECOND}`]);
  });

  it("records a revert's action first, then merges with it once the check passed, with no signal (37 § 8; unit 54e)", async () => {
    const id = "S-21-0026";
    const revert = doubles({});
    const result = await environment().withWorker(revert.activities, async (taskQueue) => MergeWorkflowResultSchema.parse(await (await environment().client.workflow.start(MERGE_WORKFLOW, { taskQueue, workflowId: mergeWorkflowId(id), args: [{ suggestionId: id, actionId: ACTION }] })).result()));
    expect(result).toEqual({ suggestionId: id, state: "MERGED", decision: "ACCEPT" });
    /* the action recorded first — the revert's commit follows from the record — then taken once the check passed */
    const recordAction = `recordMergeAction:${mergeWorkflowId(id)}:${ACTION}`;
    expect(revert.calls).toEqual([recordAction, `prepareMerge:${id}`, "checkMerge", recordAction, "mergeMain", "publishMerge", `recordMerged:${ACTION}`]);
  });

  it("leaves a revert whose check failed waiting as failed, for the curator's hand, and merges once a recheck passes", async () => {
    const id = "S-21-0027";
    const failed = doubles({ stays: true, checked: [{ verdict: "FAILED" }, { verdict: "PASSED" }] });
    const result = await environment().withWorker(failed.activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(MERGE_WORKFLOW, { taskQueue, workflowId: mergeWorkflowId(id), args: [{ suggestionId: id, actionId: ACTION }] });
      const waiting = await waitingAt(handle, "FAILED");
      await handle.signal(MERGE_RECHECK_SIGNAL);
      return { waiting, result: MergeWorkflowResultSchema.parse(await handle.result()) };
    });
    expect(result).toMatchObject({ waiting: "FAILED", result: { state: "MERGED" } });
    const recordAction = `recordMergeAction:${mergeWorkflowId(id)}:${ACTION}`;
    expect(failed.calls).toEqual([recordAction, `prepareMerge:${id}`, "checkMerge", "returnMerge", `prepareMerge:${id}`, "checkMerge", recordAction, "mergeMain", "publishMerge", `recordMerged:${ACTION}`]);
  });

  it("fails without retry on an argument that is not a suggestion's id, having asked nothing", async () => {
    const nothing = doubles({});
    const failed = await environment()
      .withWorker(nothing.activities, async (taskQueue) => (await environment().client.workflow.start(MERGE_WORKFLOW, { taskQueue, workflowId: "merge:S-21-9999", args: [{ suggestionId: "21-0016" } as never] })).result())
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(WorkflowFailedError);
    expect(nothing.calls).toEqual([]);
  });
});
