import { join } from "node:path";

import { Connection } from "@temporalio/client";
import { bundleWorkflowCode, NativeConnection, Runtime, Worker, type Logger, type WorkflowBundleWithSourceMap } from "@temporalio/worker";

import { TASK_QUEUES } from "@/lib/schemas/workflows";

import { activities } from "./activities";
import type { EngineConfig } from "./env";
import { PROBE_REFRESH_MS } from "./health";
import { activitySpans } from "./telemetry/activities";

/*
 * The workers as a worker of the workflow engine (feature-specs/28 § 4): the connection, the two task queues, the
 * start, the stop, and the supervision that keeps the process alive when the engine is not there.
 *
 * It runs in the workers process beside the HTTP surface, because that is the process that holds
 * GATEWAY_KEY_SECRET and activities are where model calls are made (invariant 6). Without TEMPORAL_ADDRESS none of
 * it starts, and this file is not even loaded (workers/main.ts imports it on demand): the SDK's worker carries a
 * native module, and a machine that runs no engine should not need one, as no OpenTelemetry code loads without a
 * collector. The reader and the assistant need no workflow.
 */

const WORKFLOWS_PATH = join(import.meta.dirname, "workflows");
const REPOSITORY_ROOT = join(import.meta.dirname, "..");

export interface RunningEngine {
  /** Settles when every worker has stopped: resolved after `stop`, rejected when one failed. */
  readonly done: Promise<void>;
  readonly stop: () => Promise<void>;
}

/**
 * The workflow code as the engine runs it: the SDK's own bundle of workers/workflows, compiled for its deterministic
 * sandbox. The `@/` alias is added because workflow code imports lib/schemas by it, as the rest of the repository
 * does. The workflow tests run this same bundle (tests/workflows/environment.ts), so what they pass is what the
 * workers load. `logger` is where the bundler reports; the SDK's default prints the bundle's size.
 */
export function bundleWorkflows(logger?: Logger): Promise<WorkflowBundleWithSourceMap> {
  return bundleWorkflowCode({
    workflowsPath: WORKFLOWS_PATH,
    ...(logger === undefined ? {} : { logger }),
    webpackConfigHook: (webpack) => ({ ...webpack, resolve: { ...webpack.resolve, alias: { ...(webpack.resolve?.alias as Record<string, string> | undefined), "@": REPOSITORY_ROOT } } }),
  });
}

/**
 * Connect, bundle the workflow code once, and poll the task queues: both of the product's unless a caller names
 * its own, which is how the integration suite runs the real worker on a queue nothing else polls.
 */
export async function startEngine(config: EngineConfig, taskQueues: ReadonlyArray<string> = Object.values(TASK_QUEUES)): Promise<RunningEngine> {
  const connection = await NativeConnection.connect({ address: config.address });
  try {
    /* The process's own logger, so the bundler reports where the workers do and a suite that holds the SDK's lines holds this one. */
    const bundle = await bundleWorkflows(Runtime.instance().logger);
    /* each activity's execution as a span of its subject's trace (feature-specs/49 § 7.1); the workflow suites build their own workers without it */
    const workers = await Promise.all(taskQueues.map((taskQueue) => Worker.create({ connection, namespace: config.namespace, taskQueue, workflowBundle: bundle, activities, interceptors: { activity: [activitySpans()] } })));
    const runs = workers.map((worker) => worker.run());
    const shutdown = (): void => {
      for (const worker of workers) {
        /* A worker that already stopped, or is stopping, refuses a second request; that is the state asked for. */
        try {
          worker.shutdown();
        } catch {
          /* already stopping */
        }
      }
    };
    /* One worker failing stops the other: half an engine is not a state the supervisor should have to reason about. */
    const done = Promise.all(runs)
      .then(() => undefined)
      .catch(async (error: unknown) => {
        shutdown();
        await Promise.allSettled(runs);
        throw error;
      })
      .finally(() => connection.close());
    return {
      done,
      stop: async () => {
        shutdown();
        await done.catch(() => undefined);
      },
    };
  } catch (error: unknown) {
    await connection.close();
    throw error;
  }
}

export interface SuperviseDeps {
  readonly start: (config: EngineConfig) => Promise<RunningEngine>;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly log: (line: string) => void;
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/**
 * Keep an engine worker running for as long as the process lives (feature-specs/28 § 7). An engine that is not
 * there at start, or goes away for good, does not take the workers' HTTP surface down with it: the start is tried
 * again at the interval the health probes already refresh at, and `/health` says `down` meanwhile.
 */
export function superviseEngine(config: EngineConfig, deps: SuperviseDeps = { start: startEngine, wait, log: (line) => console.log(line) }): { readonly stop: () => Promise<void> } {
  const stopping = new AbortController();
  let running: RunningEngine | null = null;

  const loop = (async () => {
    while (!stopping.signal.aborted) {
      try {
        running = await deps.start(config);
        if (stopping.signal.aborted) {
          await running.stop();
          break;
        }
        deps.log(`workflows: polling ${Object.values(TASK_QUEUES).join(" and ")} at ${config.address} (namespace ${config.namespace})`);
        await running.done;
      } catch (error: unknown) {
        if (!stopping.signal.aborted) deps.log(`workflows: no worker is running (${firstLine(error)}); trying again in ${String(PROBE_REFRESH_MS / 1000)} s`);
      } finally {
        running = null;
      }
      if (!stopping.signal.aborted) await deps.wait(PROBE_REFRESH_MS, stopping.signal);
    }
  })();

  return {
    stop: async () => {
      stopping.abort();
      await running?.stop();
      await loop;
    },
  };
}

/**
 * The health check's question (feature-specs/28 § 4.5): does the engine answer, and does it know the namespace.
 * A connection of its own each time, closed again: the probe is cached for thirty seconds and must not depend on
 * the worker's state, which is what it is there to report on.
 */
export async function checkEngine(config: EngineConfig, deadlineMs: number): Promise<void> {
  const connection = await Connection.connect({ address: config.address, connectTimeout: deadlineMs });
  try {
    await connection.withDeadline(Date.now() + deadlineMs, () => connection.workflowService.describeNamespace({ namespace: config.namespace }));
  } finally {
    await connection.close();
  }
}
