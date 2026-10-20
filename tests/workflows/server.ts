import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { TestWorkflowEnvironment } from "@temporalio/testing";

/*
 * Temporal's time-skipping test server (feature-specs/28 § 6): the engine the workflow tests run on. It is a
 * program of its own, not a package: the SDK downloads it once and starts it on a free port of the loopback, and a
 * timer of seven days fires in milliseconds because the server's clock is moved, not waited on.
 *
 * This file is the one place that says which server, where it is kept and what to do when it does not start. The
 * tests reach it through ./environment.ts; `npm run workflows:test-server` reaches it directly, and is the fix the
 * failure names. Nothing here imports vitest, so the script can.
 */

/**
 * The server's release: it ships with Temporal's Java SDK, and this is the one the vendor's "default" answered for
 * SDK 1.24.0 on 2026-10-05. Pinned as every image and package is; .github/workflows/ci.yml keys its cache by it.
 */
export const TEST_SERVER_VERSION = "v1.40.0";

/** Where the download is kept: inside node_modules, so it is ignored by git and lives exactly as long as an install. */
export const TEST_SERVER_DIR = join(import.meta.dirname, "..", "..", "node_modules", ".cache", "temporal-test-server");

/** The command the failure names, and the script package.json gives it. */
export const TEST_SERVER_FIX = "npm run workflows:test-server";

/*
 * The SDK downloads the file again once it is older than a time to live, one day unless told, and has no way to
 * say "never". The version is pinned, so the file's age means nothing: ten years stands for never, and `npm test`
 * does not come to need the network every morning.
 */
const KEEP_DOWNLOAD = "3650 days";

export type StartTestServer = () => Promise<TestWorkflowEnvironment>;

const startPinned: StartTestServer = () => {
  mkdirSync(TEST_SERVER_DIR, { recursive: true });
  return TestWorkflowEnvironment.createTimeSkipping({
    server: { executable: { type: "cached-download", downloadDir: TEST_SERVER_DIR, version: TEST_SERVER_VERSION, ttl: KEEP_DOWNLOAD } },
  });
};

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/** What a suite says when its engine is not there: what was needed, where it is kept, and the command that fixes it. */
export function unavailable(error: unknown): string {
  return [
    `The workflow test environment did not start: ${firstLine(error)}`,
    `It needs Temporal's test server ${TEST_SERVER_VERSION}, a program the SDK downloads once from temporal.download into ${TEST_SERVER_DIR}.`,
    `Run \`${TEST_SERVER_FIX}\` on a machine that can reach it: the command fetches the server, replaces a file that does not start, and starts it once (feature-specs/28 § 6).`,
  ].join("\n");
}

/**
 * Start the test server, downloading it the first time. A server that cannot start is an error that names the fix,
 * never a reason to skip: a workflow suite that did not run must not look like one that passed.
 */
export async function startTestServer(start: StartTestServer = startPinned): Promise<TestWorkflowEnvironment> {
  try {
    return await start();
  } catch (error: unknown) {
    throw new Error(unavailable(error), { cause: error });
  }
}
