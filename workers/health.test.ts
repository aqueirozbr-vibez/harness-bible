import { describe, expect, it } from "vitest";

import { engineProbe, PROBE_DEADLINE_MS, PROBE_REFRESH_MS, probeEngine } from "./health";

/*
 * The workflow engine's state on /health (feature-specs/28 § 4.5). The gateway's probe is exercised through the
 * surface in workers/server.test.ts; the engine's check is a function the workers give the probe, so it is doubled
 * here and the real one (workers/temporal.ts `checkEngine`) is run against the engine by `npm run workflows:check`
 * and the unit's verification.
 */

const never = () => new Promise<void>(() => undefined);

describe("probeEngine", () => {
  const now = () => new Date(0);

  it("is off when no engine is configured, without asking anything", async () => {
    expect(await probeEngine({ check: undefined, now })).toBe("off");
  });

  it("is up when the check resolves, and hands the check the deadline it must meet", async () => {
    const asked: number[] = [];
    const state = await probeEngine({
      check: async (deadlineMs) => {
        asked.push(deadlineMs);
      },
      now,
    });
    expect(state).toBe("up");
    expect(asked).toEqual([PROBE_DEADLINE_MS]);
  });

  it("is down when the check rejects", async () => {
    expect(await probeEngine({ check: () => Promise.reject(new Error("namespace not found")), now })).toBe("down");
  });

  it("is down at the deadline when the check never settles, so /health is never held", async () => {
    const started = performance.now();
    expect(await probeEngine({ check: never, now, deadlineMs: 40 })).toBe("down");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps its deadline strictly inside the 5 s the web tier gives the /health route", () => {
    expect(PROBE_DEADLINE_MS).toBeLessThan(5_000);
  });
});

describe("engineProbe", () => {
  it("asks once while its answer is younger than the refresh interval, and again after", async () => {
    let at = 0;
    let checks = 0;
    let fail = false;
    const probe = engineProbe({
      check: async () => {
        checks += 1;
        if (fail) throw new Error("gone");
      },
      now: () => new Date(at),
    });
    expect(await probe()).toBe("up");
    at = PROBE_REFRESH_MS - 1;
    fail = true;
    expect(await probe()).toBe("up");
    expect(checks).toBe(1);
    at = PROBE_REFRESH_MS;
    expect(await probe()).toBe("down");
    expect(checks).toBe(2);
  });

  it("runs one check for callers that arrive together", async () => {
    let checks = 0;
    let release: () => void = () => undefined;
    const probe = engineProbe({
      check: () => {
        checks += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      now: () => new Date(0),
    });
    const both = Promise.all([probe(), probe()]);
    await Promise.resolve();
    release();
    expect(await both).toEqual(["up", "up"]);
    expect(checks).toBe(1);
  });

  it("stays off without a check, and asks nothing", async () => {
    const probe = engineProbe({ check: undefined, now: () => new Date(0) });
    expect(await probe()).toBe("off");
  });
});
