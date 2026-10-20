import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * A lock across suites, for the one thing the integration suites cannot each have their own of: the development
 * ledger. Its chain is a single sequence, so a suite that asserts contiguous seq numbers or that its own record is
 * the head owns the chain while it runs, and another suite that appends waits for it (`tests/integration/ledger`
 * and the assistant's turns of feature-specs/15 § 6.3). Vitest runs files in parallel and in separate processes,
 * so the lock is a directory: `mkdir` is one atomic step on every platform this repository runs on.
 *
 * The rule this encodes, for any suite added later: append to the development ledger only while holding
 * `LEDGER_LOCK`, and never assert anything about the chain outside your own range without it.
 */

export const LEDGER_LOCK = "hb-ledger";

/**
 * The dashboard's role (infra/observability/init.sql): its grants are catalog rows that two sessions granting at once
 * update under each other ("tuple concurrently updated"), so a suite that applies the file holds this while it does.
 */
export const METRICS_ROLE_LOCK = "hb-metrics-role";

/** A lock older than this is a crashed suite's, not a running one's; five minutes is well over any suite's run. */
const STALE_MS = 300_000;
const POLL_MS = 50;

function pathOf(name: string): string {
  return join(tmpdir(), `${name}.lock`);
}

function ageOf(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Take the named lock, waiting up to `timeoutMs` for whoever holds it. Returns the release, which every caller
 * must run in `afterAll` — a lock left behind would stall the next run until it goes stale.
 */
export async function acquire(name: string, timeoutMs = 240_000): Promise<() => void> {
  const path = pathOf(name);
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(path);
      return () => rmSync(path, { recursive: true, force: true });
    } catch {
      const age = ageOf(path);
      if (age !== null && age > STALE_MS) {
        /* The holder died without releasing it; a stale lock must not stop the suite for ever. */
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > until) throw new Error(`the ${name} lock is still held after ${String(Math.round(timeoutMs / 1000))} s (tests/fixtures/exclusive.ts)`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}
