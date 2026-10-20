import { createServer } from "node:net";

import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { STATUS_OF, toApiError } from "@/lib/api/errors";
import { PROVING_QUERY, PROVING_SIGNAL, PROVING_WORKFLOW, provingWorkflowId, RESEARCH_RUN_EXECUTION_TIMEOUT_MS, RESEARCH_RUN_WORKFLOW, researchRunWorkflowId, TASK_QUEUES } from "@/lib/schemas/workflows";
import { ROUTE_TIMEOUT_MS } from "@/lib/workers/client";

import {
  cancelWorkflow,
  closeWorkflowsEngines,
  queryWorkflow,
  sdkEngine,
  signalWorkflow,
  startWorkflow,
  workflowRunning,
  WORKFLOWS_DEADLINE_MS,
  WorkflowNotFoundError,
  WorkflowsUnavailableError,
  type CallBound,
  type EngineAddress,
  type WorkflowsClientDeps,
  type WorkflowsEngine,
} from "./client";

/*
 * The web tier's client of the workflow engine with the engine doubled (feature-specs/28 § 5, § 10.7): what it
 * sends, what it refuses before sending, the deadline it holds every call to, and that it fails closed. The last
 * case runs the SDK itself against a port nothing listens on. The client against a running engine is
 * tests/integration/workflows.test.ts.
 */

const TOKEN = "77f2989b-15a5-46e4-9946-5ea4103f87d9";
const ID = provingWorkflowId(TOKEN);
const RUN = "01a10cb8-1a90-7880-b6c7-6a29dc1f1915";
const AT: EngineAddress = { address: "engine.test:7233", namespace: "harness-bible" };

interface Seen {
  readonly kind: "start" | "signal" | "query" | "cancel" | "describe";
  readonly call: unknown;
  readonly bound: CallBound;
}

/** An engine that records what it was asked and answers as told; by default a start is a run, a query is `waiting`. */
function doubled(answers: Partial<WorkflowsEngine> = {}, overrides: Partial<WorkflowsClientDeps> = {}) {
  const seen: Seen[] = [];
  const asked: EngineAddress[] = [];
  const engine: WorkflowsEngine = {
    start: (call, bound) => {
      seen.push({ kind: "start", call, bound });
      return answers.start?.(call, bound) ?? Promise.resolve({ runId: RUN });
    },
    signal: (call, bound) => {
      seen.push({ kind: "signal", call, bound });
      return answers.signal?.(call, bound) ?? Promise.resolve();
    },
    query: (call, bound) => {
      seen.push({ kind: "query", call, bound });
      return answers.query?.(call, bound) ?? Promise.resolve("waiting");
    },
    cancel: (call, bound) => {
      seen.push({ kind: "cancel", call, bound });
      return answers.cancel?.(call, bound) ?? Promise.resolve();
    },
    describe: (call, bound) => {
      seen.push({ kind: "describe", call, bound });
      return answers.describe?.(call, bound) ?? Promise.resolve({ running: true });
    },
  };
  const deps: WorkflowsClientDeps = {
    ...AT,
    deadlineMs: WORKFLOWS_DEADLINE_MS,
    engine: (at) => {
      asked.push(at);
      return engine;
    },
    ...overrides,
  };
  return { seen, asked, deps };
}

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("startWorkflow", () => {
  it("sends the workflow's name, its id, its own task queue and the argument, and returns the run", async () => {
    const { seen, asked, deps } = doubled();
    const before = Date.now();
    expect(await startWorkflow(PROVING_WORKFLOW, ID, { token: TOKEN }, deps)).toEqual({ workflowId: ID, runId: RUN });
    expect(asked).toEqual([AT]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("start");
    expect(seen[0]?.call).toEqual({ name: "ProvingWorkflow", workflowId: ID, taskQueue: TASK_QUEUES.improve, input: { token: TOKEN } });
    expect(seen[0]?.bound.at).toBeGreaterThanOrEqual(before + WORKFLOWS_DEADLINE_MS);
    expect(seen[0]?.bound.at).toBeLessThanOrEqual(Date.now() + WORKFLOWS_DEADLINE_MS);
    expect(seen[0]?.bound.signal.aborted).toBe(false);
  });

  it("passes a workflow's execution timeout where its entry has one: a person's research run is closed by the engine at 90 minutes (feature-specs/48 § 5.1)", async () => {
    const { seen, deps } = doubled();
    const runId = "7d0c5a51-6f8e-4d0a-9d55-2b1f3c6a7e90";
    const userId = "0b3e1f7c-2d9a-4c55-8e61-5a4f3b2c1d0e";
    await startWorkflow(RESEARCH_RUN_WORKFLOW, researchRunWorkflowId(runId), { runId, userId }, deps);
    expect(seen[0]?.call).toEqual({ name: "ResearchRunWorkflow", workflowId: `research:${runId}`, taskQueue: TASK_QUEUES.research, input: { runId, userId }, executionTimeoutMs: RESEARCH_RUN_EXECUTION_TIMEOUT_MS });
    expect(RESEARCH_RUN_EXECUTION_TIMEOUT_MS).toBe(90 * 60_000);
    /* a workflow with none is sent none: the engine's own default stands */
    await startWorkflow(PROVING_WORKFLOW, ID, { token: TOKEN }, deps);
    expect(Object.hasOwn((seen[1]?.call ?? {}) as object, "executionTimeoutMs")).toBe(false);
  });

  it("refuses an argument that is not the workflow's before anything is sent: a sentence, a key nobody named", async () => {
    const { seen, asked, deps } = doubled();
    expect(await rejection(startWorkflow(PROVING_WORKFLOW, ID, { token: "what is in 21.3?" }, deps))).toBeInstanceOf(ZodError);
    expect(await rejection(startWorkflow(PROVING_WORKFLOW, ID, { token: TOKEN, question: "what is in 21.3?" } as never, deps))).toBeInstanceOf(ZodError);
    expect(seen).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("refuses an id that is not of the workflow's form", async () => {
    const { seen, deps } = doubled();
    for (const id of [`suggestion:${TOKEN}`, TOKEN, "proving:what is in 21.3?", `${ID} `, ""]) {
      expect(await rejection(startWorkflow(PROVING_WORKFLOW, id, { token: TOKEN }, deps)), id).toBeInstanceOf(ZodError);
    }
    expect(seen).toEqual([]);
  });
});

describe("signalWorkflow", () => {
  it("sends the signal to the id, with null for a signal that carries nothing", async () => {
    const { seen, deps } = doubled();
    await signalWorkflow(PROVING_WORKFLOW, ID, PROVING_SIGNAL, null, deps);
    expect(seen.map(({ kind, call }) => ({ kind, call }))).toEqual([{ kind: "signal", call: { workflowId: ID, signal: "proceed", input: null } }]);
  });

  it("refuses a signal the workflow does not take, without sending it", async () => {
    const { seen, deps } = doubled();
    for (const signal of ["cancel", "toString", "constructor"]) {
      expect(await rejection(signalWorkflow(PROVING_WORKFLOW, ID, signal as never, null as never, deps)), signal).toMatchObject({ code: "INTERNAL" });
    }
    expect(seen).toEqual([]);
  });
});

describe("cancelWorkflow", () => {
  it("asks the engine to cancel the run under the id, and refuses an id of the wrong form without asking", async () => {
    const { seen, deps } = doubled();
    await cancelWorkflow(PROVING_WORKFLOW, ID, deps);
    expect(seen.map(({ kind, call }) => ({ kind, call }))).toEqual([{ kind: "cancel", call: { workflowId: ID } }]);
    await expect(cancelWorkflow(PROVING_WORKFLOW, "evidence:nonsense", deps)).rejects.toBeInstanceOf(ZodError);
    expect(seen).toHaveLength(1);
  });

  it("passes a run that is gone through as WorkflowNotFoundError, for the caller to take as done", async () => {
    const { deps } = doubled({ cancel: () => Promise.reject(new WorkflowNotFoundError(ID)) });
    await expect(cancelWorkflow(PROVING_WORKFLOW, ID, deps)).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });
});

describe("workflowRunning (feature-specs/45 § 3.5)", () => {
  it("asks the engine whether the run under the id still runs; one it no longer knows does not; an id of the wrong form is refused unasked", async () => {
    const { seen, deps } = doubled();
    expect(await workflowRunning(PROVING_WORKFLOW, ID, deps)).toBe(true);
    expect(seen.map(({ kind, call }) => ({ kind, call }))).toEqual([{ kind: "describe", call: { workflowId: ID } }]);
    expect(await workflowRunning(PROVING_WORKFLOW, ID, doubled({ describe: () => Promise.resolve({ running: false }) }).deps)).toBe(false);
    expect(await workflowRunning(PROVING_WORKFLOW, ID, doubled({ describe: () => Promise.reject(new WorkflowNotFoundError(ID)) }).deps)).toBe(false);
    await expect(workflowRunning(PROVING_WORKFLOW, "evidence:nonsense", deps)).rejects.toBeInstanceOf(ZodError);
    expect(seen).toHaveLength(1);
  });

  it("is unavailable, not false, where the engine cannot be reached: the sweep then stops for the night", async () => {
    await expect(workflowRunning(PROVING_WORKFLOW, ID, doubled({}, { address: undefined }).deps)).rejects.toBeInstanceOf(WorkflowsUnavailableError);
    await expect(workflowRunning(PROVING_WORKFLOW, ID, doubled({ describe: () => Promise.reject(new WorkflowsUnavailableError("connection", "no engine")) }).deps)).rejects.toBeInstanceOf(WorkflowsUnavailableError);
  });
});

describe("queryWorkflow", () => {
  it("asks the id and returns an answer of the query's own shape", async () => {
    const { seen, deps } = doubled();
    expect(await queryWorkflow(PROVING_WORKFLOW, ID, PROVING_QUERY, deps)).toBe("waiting");
    expect(seen.map(({ kind, call }) => ({ kind, call }))).toEqual([{ kind: "query", call: { workflowId: ID, query: "stage" } }]);
  });

  it("is unavailable when the answer is not the query's shape: it is not handed on", async () => {
    for (const answer of ["what is in 21.3?", 3, null, { stage: "waiting" }]) {
      const { deps } = doubled({ query: () => Promise.resolve(answer) });
      expect(await rejection(queryWorkflow(PROVING_WORKFLOW, ID, PROVING_QUERY, deps)), JSON.stringify(answer)).toMatchObject({ code: "WORKFLOWS_UNAVAILABLE", cause: "malformed" });
    }
  });

  it("refuses a query the workflow does not answer, without asking it", async () => {
    const { seen, deps } = doubled();
    expect(await rejection(queryWorkflow(PROVING_WORKFLOW, ID, "history" as never, deps))).toMatchObject({ code: "INTERNAL" });
    expect(seen).toEqual([]);
  });
});

describe("failing closed (feature-specs/28 § 5, § 10.7)", () => {
  it("is unavailable at once without TEMPORAL_ADDRESS or TEMPORAL_NAMESPACE: no engine is even asked for", async () => {
    for (const missing of [{ address: undefined }, { namespace: undefined }]) {
      const { seen, asked, deps } = doubled({}, missing);
      const started = performance.now();
      const failures = [
        await rejection(startWorkflow(PROVING_WORKFLOW, ID, { token: TOKEN }, deps)),
        await rejection(signalWorkflow(PROVING_WORKFLOW, ID, PROVING_SIGNAL, null, deps)),
        await rejection(queryWorkflow(PROVING_WORKFLOW, ID, PROVING_QUERY, deps)),
      ];
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(WorkflowsUnavailableError);
        expect(failure).toMatchObject({ code: "WORKFLOWS_UNAVAILABLE", cause: "unconfigured" });
      }
      expect(performance.now() - started).toBeLessThan(100);
      expect(seen).toEqual([]);
      expect(asked).toEqual([]);
    }
  });

  it("is unavailable at the deadline when the engine does not answer, and cancels what it had sent", async () => {
    const { seen, deps } = doubled({ start: () => never() }, { deadlineMs: 40 });
    const started = performance.now();
    const failure = await rejection(startWorkflow(PROVING_WORKFLOW, ID, { token: TOKEN }, deps));
    const elapsed = performance.now() - started;
    expect(failure).toMatchObject({ code: "WORKFLOWS_UNAVAILABLE", cause: "timeout" });
    expect((failure as Error).message).toBe("start ProvingWorkflow: the workflow engine did not answer within 40 ms");
    /* A timer may fire a millisecond early by the clock that measures it. */
    expect(elapsed).toBeGreaterThanOrEqual(35);
    expect(elapsed).toBeLessThan(1_000);
    expect(seen[0]?.bound.signal.aborted).toBe(true);
  });

  it("cancels nothing once the engine has answered", async () => {
    const { seen, deps } = doubled({}, { deadlineMs: 30 });
    await startWorkflow(PROVING_WORKFLOW, ID, { token: TOKEN }, deps);
    await pause(60);
    expect(seen[0]?.bound.signal.aborted).toBe(false);
  });

  it("hands on what the engine said as it said it: unavailable, nothing under that id, or a failure it does not know", async () => {
    const unknown = new TypeError("something else");
    for (const thrown of [new WorkflowsUnavailableError("connection", "the workflow engine could not be reached"), new WorkflowNotFoundError(ID), unknown]) {
      const { deps } = doubled({ signal: () => Promise.reject(thrown) });
      expect(await rejection(signalWorkflow(PROVING_WORKFLOW, ID, PROVING_SIGNAL, null, deps))).toBe(thrown);
    }
  });
});

describe("what a route handler answers", () => {
  it("is 503 for an engine that is unavailable and 404 for an id nothing runs under", () => {
    expect(STATUS_OF.WORKFLOWS_UNAVAILABLE).toBe(503);
    expect(toApiError(new WorkflowsUnavailableError("timeout", "the workflow engine did not answer in time"))).toMatchObject({ status: 503, code: "WORKFLOWS_UNAVAILABLE" });
    expect(toApiError(new WorkflowNotFoundError(ID))).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("holds every call to the deadline the product gives the workers' /health", () => {
    expect(WORKFLOWS_DEADLINE_MS).toBe(ROUTE_TIMEOUT_MS["/health"]);
  });
});

describe("the SDK behind the client, on a port nothing listens on (feature-specs/28 § 10.7)", () => {
  afterAll(closeWorkflowsEngines);

  const closedPort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (address !== null && typeof address === "object") resolve(address.port);
          else reject(new Error("the test's server had no port"));
        });
      });
    });

  /* Shorter than the product's so the suite stays quick; the property is "within the deadline", whatever it is. */
  const DEADLINE_MS = 300;
  /*
   * Between its retries the SDK waits on a timer, each wait 1.7 times the last with a fifth of jitter, from a tenth
   * of a second. The wait under way when 300 ms pass is at most 0.35 s; this is that, with room.
   */
  const SDK_NEXT_RETRY_MS = 600;

  it("is unavailable within the deadline, not after the SDK's own retries", async () => {
    const deps: WorkflowsClientDeps = { address: `127.0.0.1:${String(await closedPort())}`, namespace: "harness-bible", deadlineMs: DEADLINE_MS, engine: sdkEngine };
    const started = performance.now();
    const failure = await rejection(startWorkflow(PROVING_WORKFLOW, ID, { token: TOKEN }, deps));
    const elapsed = performance.now() - started;
    expect(failure).toBeInstanceOf(WorkflowsUnavailableError);
    expect(failure).toMatchObject({ code: "WORKFLOWS_UNAVAILABLE" });
    expect(elapsed).toBeLessThan(DEADLINE_MS + 500);

    /*
     * The SDK still holds that call: its next retry is waiting on a timer. Closing now, at once, is the worst moment
     * to close. If the close did not wait for that call to settle, the timer would fire on a closed connection: an
     * exception nothing can catch, which fails the whole run and not this test. So the test stays long enough for
     * that timer to have fired; with the wait in place there is nothing left to fire.
     */
    await closeWorkflowsEngines();
    await pause(SDK_NEXT_RETRY_MS);
  });
});
