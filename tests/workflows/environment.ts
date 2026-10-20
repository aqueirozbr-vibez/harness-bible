import { inspect } from "node:util";

import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, type LogEntry, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { afterAll, beforeAll, beforeEach } from "vitest";

import { bundleWorkflows } from "@/workers/temporal";

import { environmentOf, type WorkflowEnvironment } from "./environmentOf";
import { startTestServer } from "./server";

export { environmentOf, type WorkflowEnvironment };

/*
 * The environment a workflow's test runs in (feature-specs/28 § 6): Temporal's time-skipping test server, the
 * workflow code bundled exactly as the workers bundle it, and a worker per test whose activities are the doubles
 * the test hands it. Nothing here reaches the database, the gateway or the compose engine, so these suites are
 * part of `npm test` on any machine that has the server's file (./server.ts).
 *
 *   const environment = workflowEnvironment();
 *   it("...", () => environment().withWorker(doubles, async (taskQueue) => { ... }));
 *
 * One server per test file, started in a `beforeAll`. Its clock is one clock: awaiting a workflow's result moves it
 * for everything running on it, so the tests of a file run one after another (vitest's default) and never
 * `concurrent`.
 *
 * The clock is free for as long as `client.workflow.result()` waits, and it moves to the next timer whenever nothing
 * is running. The server gives every workflow an execution timeout of ten years as its one timer of its own, so a
 * workflow left running when the awaited one ends — a child abandoned at its parent's close, parked on a condition —
 * is where the clock goes next: ten years, the child TIMED_OUT, and the file's later cases waiting out their timers
 * in real time. A workflow whose children outlive it is awaited with `resultOf`, which moves the clock one step at
 * a time and takes the result through a client that leaves the clock alone.
 */

/** The first start downloads 58 MB; every later one takes a fraction of a second. The lint suite's allowance. */
const START_TIMEOUT_MS = 120_000;


/*
 * What the SDK says while a test runs. A test of a failure makes it say a great deal (each failed activity, each
 * failed workflow, with a stack), which printed beside a green result reads as something broken. And when a test is
 * red for a reason of the engine's, a workflow task that keeps failing for one, these lines are the only place the
 * reason is. So they are held, and printed for a test that failed.
 */
const held: LogEntry[] = [];

function printHeld(): void {
  for (const entry of held) console.warn(`[temporal ${entry.level}] ${entry.message}${entry.meta === undefined ? "" : ` ${inspect(entry.meta, { depth: 4, breakLength: 160 })}`}`);
}

/**
 * Hold the SDK's lines for the test file that calls this, inside a `describe` or at the top of the file, before
 * anything of the SDK is started. `workflowEnvironment()` calls it; the integration suite, which runs the workers'
 * real worker and not this environment, calls it by itself. Returns the logger, for what takes one as an argument.
 */
export function holdSdkLogs(): DefaultLogger {
  const logger = new DefaultLogger("WARN", (entry) => {
    held.push(entry);
  });
  beforeAll(() => {
    try {
      /* `forward` sends the lines of the SDK's native half through the same logger instead of straight to the console. */
      Runtime.install({ logger, telemetryOptions: { logging: { forward: {} } } });
    } catch {
      /* A runtime is already installed in this process: its logger stands. */
    }
  });
  beforeEach(({ onTestFailed }) => {
    held.length = 0;
    onTestFailed(printHeld);
  });
  return logger;
}

/**
 * Register the environment for the test file that calls this, and return the way to reach it from a test. It fails
 * the file, naming the fix, when the server cannot start (./server.ts): it does not skip.
 */
export function workflowEnvironment(): () => WorkflowEnvironment {
  let server: TestWorkflowEnvironment | null = null;
  let bundle: WorkflowBundleWithSourceMap | null = null;
  const logger = holdSdkLogs();

  beforeAll(async () => {
    server = await startTestServer();
    bundle = await bundleWorkflows(logger);
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    await server?.teardown();
  });

  return () => {
    const running = server;
    const workflowBundle = bundle;
    if (running === null || workflowBundle === null) throw new Error("workflowEnvironment() is read inside a test, after its beforeAll has run");
    return environmentOf(running, workflowBundle);
  };
}

