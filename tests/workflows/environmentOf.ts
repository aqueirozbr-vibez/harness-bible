import { randomUUID } from "node:crypto";

import { Client, type WorkflowHandle } from "@temporalio/client";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";

/*
 * The environment a workflow runs in on Temporal's time-skipping test server (feature-specs/28 § 6), around a server
 * already started and a bundle already made: the suites' own (./environment.ts, which starts them in a `beforeAll`)
 * and a seed's (scripts/research-seed.ts), which has no test runner and so no vitest here.
 */

export interface WorkflowEnvironment {
  /** Awaiting a workflow's result through this client moves the server's clock to the workflow's next timer. */
  readonly client: Client;
  /** Move the server's clock forward by hand, for what happens between a workflow's start and its result. */
  readonly sleep: (duration: number | string) => Promise<void>;
  /**
   * The result of a workflow some of whose children outlive it: the clock moved by `step` — the longest timer the
   * workflow sets — until the workflow ends, and never further (see above). Its children are left where they stand.
   */
  readonly resultOf: <T>(handle: WorkflowHandle, step: number | string) => Promise<T>;
  /**
   * Run `during` while a worker polls a task queue of its own with `activities` as its activities, and stop the
   * worker when `during` settles. The queue is new each time, so no test is handed another's task. `heartbeatsEvery`
   * bounds how long the worker holds an activity's heartbeats before it sends one (the SDK's
   * `maxHeartbeatThrottleInterval`, 48 seconds for a heartbeat timeout of a minute), for a test of what a heartbeat's
   * answer delivers: an activity learns of its cancellation from it.
   */
  readonly withWorker: <T>(activities: object, during: (taskQueue: string) => Promise<T>, options?: { readonly heartbeatsEvery?: string }) => Promise<T>;
  /** Replay a recorded history against the bundle: it settles when the code makes the commands the history holds, and fails where it does not. */
  readonly replay: (history: unknown, workflowId: string) => Promise<void>;
}

/** The environment around a test server already started and a bundle already made: the suites' own, and a seed's (scripts/research-seed.ts). */
export function environmentOf(running: TestWorkflowEnvironment, workflowBundle: WorkflowBundleWithSourceMap): WorkflowEnvironment {
  return {
    client: running.client,
    sleep: (duration) => running.sleep(duration),
    resultOf: async <T>(handle: WorkflowHandle, step: number | string): Promise<T> => {
      while ((await handle.describe()).status.name === "RUNNING") await running.sleep(step);
      const still = new Client({ connection: running.connection, namespace: running.namespace });
      return (await still.workflow.getHandle(handle.workflowId, undefined, { followRuns: false }).result()) as T;
    },
    withWorker: async (activities, during, options = {}) => {
      const taskQueue = `test-${randomUUID()}`;
      const worker = await Worker.create({ connection: running.nativeConnection, taskQueue, workflowBundle, activities, ...(options.heartbeatsEvery === undefined ? {} : { maxHeartbeatThrottleInterval: options.heartbeatsEvery }) });
      return worker.runUntil(() => during(taskQueue));
    },
    replay: (history, workflowId) => Worker.runReplayHistory({ workflowBundle }, history, workflowId),
  };
}
