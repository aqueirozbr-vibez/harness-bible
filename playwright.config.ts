import { defineConfig } from "@playwright/test";

import { env } from "@/lib/env";

/*
 * Browser suites (TRD test pyramid; project-overview § Success criteria · Phase 1). They run against a server that
 * is already up at APP_URL, as `npm run gate:phase1` does: the pages need the release database, the policy sidecar
 * and, for the signed-in screens, the dev sign-in, none of which a test runner should start on its own.
 *
 * `*.spec.ts` is Playwright's; `*.test.ts` stays vitest's (vitest.config.mts), so `npm test` never opens a browser.
 */
export default defineConfig({
  testDir: "tests",
  testMatch: /.*\.spec\.ts$/,
  /* One worker: the suites share a development server and a development database. */
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  timeout: 600_000,
  outputDir: "test-results",
  globalTeardown: "./tests/e2e/teardown.ts",
  use: { baseURL: env.APP_URL.replace(/\/$/, "") },
});
