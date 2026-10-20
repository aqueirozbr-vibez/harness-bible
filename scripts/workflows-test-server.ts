import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import type { TestWorkflowEnvironment } from "@temporalio/testing";

import { startTestServer, TEST_SERVER_DIR, TEST_SERVER_VERSION } from "@/tests/workflows/server";

/*
 * npm run workflows:test-server (feature-specs/28 § 6): fetches Temporal's time-skipping test server if this
 * install does not have it, starts it once and stops it. It is the command a workflow suite names when its
 * environment cannot start, and the step CI runs before `npm test` so that its cache holds the file.
 *
 * A file that is there and does not start (a download cut short, a file for another platform) is deleted and
 * fetched again, once. A second failure is the answer.
 */

async function start(): Promise<TestWorkflowEnvironment> {
  try {
    return await startTestServer();
  } catch (error: unknown) {
    if (!existsSync(TEST_SERVER_DIR) || readdirSync(TEST_SERVER_DIR).length === 0) throw error;
    console.log(`workflows: the test server in ${TEST_SERVER_DIR} did not start; fetching it again`);
    rmSync(TEST_SERVER_DIR, { recursive: true, force: true });
    return startTestServer();
  }
}

async function main(): Promise<void> {
  const started = performance.now();
  const server = await start();
  try {
    const megabytes = readdirSync(TEST_SERVER_DIR).reduce((sum, file) => sum + statSync(join(TEST_SERVER_DIR, file)).size, 0) / (1024 * 1024);
    console.log(`workflows: the test server ${TEST_SERVER_VERSION} starts on this machine · ${megabytes.toFixed(0)} MB in ${TEST_SERVER_DIR} · ${(performance.now() - started).toFixed(0)} ms`);
  } finally {
    await server.teardown();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
