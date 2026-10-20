import { randomUUID } from "node:crypto";

import { WorkflowFailedError } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";

import { ReleaseIdSchema } from "@/lib/schemas/ids";
import { PROVING_QUERY, PROVING_SIGNAL, PROVING_WORKFLOW, ProvingResultSchema, provingWorkflowId } from "@/lib/schemas/workflows";
import type { ProvingActivities } from "@/workers/workflows/activities";

import { workflowEnvironment } from "./environment";

/*
 * ProvingWorkflow in Temporal's test environment (feature-specs/28 § 6, § 10.5): the real workflow code, bundled as
 * the workers bundle it, on a server whose clock is moved instead of waited on, with its two activities replaced
 * by doubles. It is the first workflow suite and the pattern for the ones that follow: what a workflow decides is
 * tested here, in `npm test`, with no database and no engine in a container; what its activities do is tested
 * beside them.
 */

const RELEASE = ReleaseIdSchema.parse("2026.09");
const HEAD = 5828;

/** The two reads as doubles that count their calls. `fail` makes the first read throw that many times before it answers. */
function doubles(options: { readonly fail?: number; readonly hold?: Promise<void>; readonly entered?: () => void } = {}) {
  const calls = { release: 0, head: 0 };
  const activities: ProvingActivities = {
    async currentReleaseId() {
      calls.release += 1;
      options.entered?.();
      await options.hold;
      if (calls.release <= (options.fail ?? 0)) throw new Error("the database did not answer");
      return RELEASE;
    },
    async ledgerHeadSeq() {
      calls.head += 1;
      return HEAD;
    },
  };
  return { activities, calls };
}

/** The engine wraps a failure in the step it failed in (the workflow, then the activity); the first cause is at the bottom. */
const rootCause = (error: unknown): unknown => (error instanceof Error && error.cause !== undefined ? rootCause(error.cause) : error);

const startOptions = (taskQueue: string, token: string = randomUUID()) => ({ taskQueue, workflowId: provingWorkflowId(token), args: [{ token }] });

describe("ProvingWorkflow in the test environment", () => {
  const environment = workflowEnvironment();

  it("returns what its two activities read, and says it was signalled", async () => {
    const { activities, calls } = doubles();
    const result = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(PROVING_WORKFLOW, startOptions(taskQueue));
      await handle.signal(PROVING_SIGNAL);
      return ProvingResultSchema.parse(await handle.result());
    });
    expect(result).toEqual({ releaseId: RELEASE, headSeq: HEAD, signalled: true });
    expect(calls).toEqual({ release: 1, head: 1 });
  });

  /*
   * § 10.5. Nothing here waits a minute: the test's own timeout is vitest's five seconds. That the minute passed
   * all the same is read from the engine, whose clock stood a minute later when the workflow closed.
   */
  it("waits a minute of the engine's time for the signal, then goes on without it", async () => {
    const { activities, calls } = doubles();
    const { result, engineMs } = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(PROVING_WORKFLOW, startOptions(taskQueue));
      const outcome = ProvingResultSchema.parse(await handle.result());
      const { startTime, closeTime } = await handle.describe();
      return { result: outcome, engineMs: (closeTime?.getTime() ?? Number.NaN) - startTime.getTime() };
    });
    expect(result).toEqual({ releaseId: RELEASE, headSeq: HEAD, signalled: false });
    expect(engineMs).toBeGreaterThanOrEqual(60_000);
    expect(calls).toEqual({ release: 1, head: 1 });
  });

  it("takes a signal that arrives while its first activity is still running", async () => {
    let release = (): void => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { activities } = doubles({ hold, entered });
    const result = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(PROVING_WORKFLOW, startOptions(taskQueue));
      await running;
      await handle.signal(PROVING_SIGNAL);
      release();
      return ProvingResultSchema.parse(await handle.result());
    });
    expect(result.signalled).toBe(true);
  });

  it("says which step it is at to whoever asks: reading the release, waiting, done", async () => {
    let release = (): void => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { activities } = doubles({ hold, entered });
    const stages = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(PROVING_WORKFLOW, startOptions(taskQueue));
      await running;
      const first = await handle.query<string>(PROVING_QUERY);
      release();
      await vi.waitFor(async () => expect(await handle.query<string>(PROVING_QUERY)).toBe("waiting"));
      await handle.signal(PROVING_SIGNAL);
      await handle.result();
      return [first, "waiting", await handle.query<string>(PROVING_QUERY)];
    });
    expect(stages).toEqual(["release", "waiting", "done"]);
  });

  it("runs an activity again when it fails, and has its answer on the third attempt", async () => {
    const { activities, calls } = doubles({ fail: 2 });
    const result = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(PROVING_WORKFLOW, startOptions(taskQueue));
      await handle.signal(PROVING_SIGNAL);
      return ProvingResultSchema.parse(await handle.result());
    });
    expect(result).toEqual({ releaseId: RELEASE, headSeq: HEAD, signalled: true });
    expect(calls).toEqual({ release: 3, head: 1 });
  });

  it("fails when an activity has failed three times, and never runs the one after it", async () => {
    const { activities, calls } = doubles({ fail: 3 });
    const failure = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(PROVING_WORKFLOW, startOptions(taskQueue));
      return handle.result().then(
        () => null,
        (error: unknown) => error,
      );
    });
    expect(failure).toBeInstanceOf(WorkflowFailedError);
    expect(rootCause(failure)).toMatchObject({ message: "the database did not answer" });
    expect(calls).toEqual({ release: 3, head: 0 });
  });

  it("refuses an argument that is not { token: uuid } for good, without running an activity", async () => {
    const { activities, calls } = doubles();
    const failure = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(PROVING_WORKFLOW, { taskQueue, workflowId: provingWorkflowId(randomUUID()), args: [{ token: "not-a-uuid" }] });
      return handle.result().then(
        () => null,
        (error: unknown) => error,
      );
    });
    expect(failure).toBeInstanceOf(WorkflowFailedError);
    expect((failure as WorkflowFailedError).cause).toMatchObject({ type: "WORKFLOW_INPUT", nonRetryable: true });
    expect(calls).toEqual({ release: 0, head: 0 });
  });
});
