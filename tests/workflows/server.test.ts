import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { describe, expect, it } from "vitest";

import { startTestServer, TEST_SERVER_DIR, TEST_SERVER_FIX, TEST_SERVER_VERSION, unavailable } from "./server";

/*
 * The workflow suites' precondition (feature-specs/28 § 6, § 10.6): a test server that cannot start fails the suite
 * with the command that fixes it, and that command, the pin and CI's cache all name the same thing. The start is
 * doubled here; that the real server starts is what every other file of this folder shows by running.
 */

const root = join(import.meta.dirname, "..", "..");
/* Line endings as `\n` whatever the checkout wrote: the order check below reads positions in the text. */
const read = (...path: string[]): string => readFileSync(join(root, ...path), "utf8").replace(/\r\n/g, "\n");
const manifest = JSON.parse(read("package.json")) as { readonly scripts: Record<string, string>; readonly dependencies: Record<string, string>; readonly devDependencies: Record<string, string> };

const rejection = (start: () => Promise<TestWorkflowEnvironment>): Promise<unknown> =>
  startTestServer(start).then(
    () => null,
    (error: unknown) => error,
  );

describe("a test server that cannot start", () => {
  it("is an error that says what was needed, where it is kept and the command that fixes it", async () => {
    const cause = new Error("Failed to start ephemeral server: failed to download ephemeral server executable: error sending request\n    at somewhere in the SDK");
    const failure = await rejection(() => Promise.reject(cause));
    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;
    expect(message).toContain("did not start: Failed to start ephemeral server: failed to download ephemeral server executable: error sending request");
    expect(message).not.toContain("at somewhere in the SDK");
    expect(message).toContain(`test server ${TEST_SERVER_VERSION}`);
    expect(message).toContain(TEST_SERVER_DIR);
    expect(message).toContain(`\`${TEST_SERVER_FIX}\``);
    expect((failure as Error).cause).toBe(cause);
  });

  it("names the fix for a failure that is not an Error too", () => {
    expect(unavailable("os error 216")).toContain("did not start: os error 216");
    expect(unavailable("os error 216")).toContain(TEST_SERVER_FIX);
  });

  it("is not caught when the server starts: the environment is handed back as it is", async () => {
    const environment = {} as TestWorkflowEnvironment;
    expect(await startTestServer(() => Promise.resolve(environment))).toBe(environment);
  });
});

describe("the fix the failure names", () => {
  it("is a script of package.json", () => {
    expect(TEST_SERVER_FIX).toBe("npm run workflows:test-server");
    expect(manifest.scripts["workflows:test-server"]).toBe("tsx scripts/workflows-test-server.ts");
  });
});

describe("the test server's pin", () => {
  it("is one release, written as the download service names its releases", () => {
    expect(TEST_SERVER_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("is kept inside node_modules, which git ignores and an install replaces", () => {
    expect(TEST_SERVER_DIR).toBe(join(root, "node_modules", ".cache", "temporal-test-server"));
  });

  it("comes with a testing package of the SDK's own version, installed for development only", () => {
    expect(manifest.devDependencies["@temporalio/testing"]).toBe(manifest.dependencies["@temporalio/worker"]);
    expect(manifest.dependencies["@temporalio/testing"]).toBeUndefined();
  });
});

describe("CI", () => {
  const ci = read(".github", "workflows", "ci.yml");

  it("caches the folder the server is kept in, under a key that changes with its release", () => {
    expect(ci).toContain("path: node_modules/.cache/temporal-test-server");
    expect(ci).toContain(`key: temporal-test-server-\${{ runner.os }}-${TEST_SERVER_VERSION}`);
  });

  it("restores the cache after the install that would delete it, and fetches the server before the tests need it", () => {
    const order = ["run: npm ci", "path: node_modules/.cache/temporal-test-server", `run: ${TEST_SERVER_FIX}`, "run: npm test"].map((step) => ci.indexOf(`${step}\n`));
    expect(Math.min(...order)).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
