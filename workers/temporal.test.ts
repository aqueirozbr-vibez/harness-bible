import { describe, expect, it } from "vitest";

import { engineConfigOf, type EngineConfig } from "./env";
import { PROBE_REFRESH_MS } from "./health";
import { superviseEngine, type RunningEngine, type SuperviseDeps } from "./temporal";

/*
 * The workers as the engine's worker (feature-specs/28 § 4, § 7): the configuration, and the supervision that
 * keeps trying when the engine is not there. The engine itself is doubled here; a worker really polling, a workflow
 * really running and surviving a kill are the unit's verification (`npm run workflows:check`), and from unit 45c
 * the workflow suite's.
 */

const CONFIG: EngineConfig = { address: "127.0.0.1:7233", namespace: "harness-bible" };

describe("engineConfigOf", () => {
  it("is null without an address: no engine, no worker", () => {
    expect(engineConfigOf({ address: undefined, namespace: undefined })).toBeNull();
    expect(engineConfigOf({ address: undefined, namespace: "harness-bible" })).toBeNull();
  });

  it("takes an address with its namespace", () => {
    expect(engineConfigOf({ address: "127.0.0.1:7233", namespace: "harness-bible" })).toEqual(CONFIG);
  });

  it("refuses an address without a namespace instead of assuming one", () => {
    expect(() => engineConfigOf({ address: "127.0.0.1:7233", namespace: undefined })).toThrow(/TEMPORAL_NAMESPACE is not set/);
  });
});

/** An engine that runs until it is stopped, or until the test makes it fail. */
function engine(): { readonly running: RunningEngine; readonly fail: (error: Error) => void; readonly stopped: () => boolean } {
  let settle: { resolve: () => void; reject: (error: Error) => void } = { resolve: () => undefined, reject: () => undefined };
  let stopped = false;
  const done = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return {
    running: {
      done,
      stop: async () => {
        stopped = true;
        settle.resolve();
        await done;
      },
    },
    fail: (error) => settle.reject(error),
    stopped: () => stopped,
  };
}

/** Lets the supervisor's loop take its next steps. */
const turn = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("superviseEngine", () => {
  it("starts the engine worker, says what it polls, and stops it when asked", async () => {
    const lines: string[] = [];
    const one = engine();
    const deps: SuperviseDeps = { start: async () => one.running, wait: async () => undefined, log: (line) => lines.push(line) };
    const supervised = superviseEngine(CONFIG, deps);
    await turn();
    expect(lines).toEqual(["workflows: polling hb-improve and hb-research at 127.0.0.1:7233 (namespace harness-bible)"]);
    await supervised.stop();
    expect(one.stopped()).toBe(true);
    expect(lines).toHaveLength(1);
  });

  it("tries again at the probes' interval when the engine is not there, and says so each time", async () => {
    const lines: string[] = [];
    const waits: number[] = [];
    const one = engine();
    let attempts = 0;
    const deps: SuperviseDeps = {
      start: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("Failed to connect before the deadline\n    at somewhere");
        return one.running;
      },
      wait: async (ms) => {
        waits.push(ms);
      },
      log: (line) => lines.push(line),
    };
    const supervised = superviseEngine(CONFIG, deps);
    await turn();
    expect(attempts).toBe(3);
    expect(waits).toEqual([PROBE_REFRESH_MS, PROBE_REFRESH_MS]);
    expect(lines.slice(0, 2)).toEqual(Array(2).fill("workflows: no worker is running (Failed to connect before the deadline); trying again in 30 s"));
    expect(lines[2]).toContain("polling hb-improve and hb-research");
    await supervised.stop();
  });

  it("starts a new worker when the running one fails", async () => {
    const lines: string[] = [];
    const first = engine();
    const second = engine();
    const engines = [first, second];
    let started = 0;
    const deps: SuperviseDeps = {
      start: async () => {
        const next = engines[started];
        started += 1;
        if (next === undefined) throw new Error("no third engine in this test");
        return next.running;
      },
      wait: async () => undefined,
      log: (line) => lines.push(line),
    };
    const supervised = superviseEngine(CONFIG, deps);
    await turn();
    first.fail(new Error("worker stopped: the task queue poller failed"));
    await turn();
    expect(started).toBe(2);
    expect(lines[1]).toBe("workflows: no worker is running (worker stopped: the task queue poller failed); trying again in 30 s");
    await supervised.stop();
    expect(second.stopped()).toBe(true);
  });

  it("stops at once while waiting to try again, without starting anything more", async () => {
    let attempts = 0;
    const deps: SuperviseDeps = {
      start: async () => {
        attempts += 1;
        throw new Error("unreachable");
      },
      /* The real wait: resolves when the stop aborts it, long before its thirty seconds. */
      wait: (_ms, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve();
          });
        }),
      log: () => undefined,
    };
    const supervised = superviseEngine(CONFIG, deps);
    await turn();
    expect(attempts).toBe(1);
    await supervised.stop();
    expect(attempts).toBe(1);
  });

  it("stops an engine that finished starting only after the stop was asked for", async () => {
    const late = engine();
    let release: () => void = () => undefined;
    const deps: SuperviseDeps = {
      start: () =>
        new Promise<RunningEngine>((resolve) => {
          release = () => {
            resolve(late.running);
          };
        }),
      wait: async () => undefined,
      log: () => undefined,
    };
    const supervised = superviseEngine(CONFIG, deps);
    await turn();
    const stopping = supervised.stop();
    release();
    await stopping;
    expect(late.stopped()).toBe(true);
  });
});
