import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/*
 * feature-specs/28 § 4.2: a workflow is replayed from its history, so a file under workers/workflows/ imports the
 * engine's workflow API, files of its own folder and the shared schemas, and nothing else — since unit 74 also the one
 * pure module named on the list, `workers/research/pace.ts` (feature-specs/48 § 8.4). The rule is
 * `no-restricted-imports` in eslint.config.mjs; this test lints a snippet of each kind so the rule itself is
 * verified, not only the folder as it stands today (as tests/gateway-lint.test.ts does for invariant 6).
 */

const root = join(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: root });

async function restricted(file: string, source: string): Promise<ReadonlyArray<string>> {
  const [result] = await eslint.lintText(source, { filePath: join(root, file) });
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

const importing = (specifier: string, type = false): string => `import ${type ? "type " : ""}{ x } from "${specifier}";\nexport const y${type ? ": x | null = null" : " = x"};\n`;

const REFUSED = [
  "@/lib/db/client",
  "@/lib/db/improve",
  "@/lib/gateway/client",
  "@/lib/env",
  "@/lib/rubric/score",
  "@/workers/activities/proving",
  /* the one pure module of workers/research on the list is the pacing (unit 74): its neighbours, which reach the database, are not */
  "@/workers/research/outcomes",
  "@/workers/research/pace/other",
  "../activities/proving",
  "../activities",
  "./../activities",
  "./nested/../../activities/proving",
  "@/lib/schemas/../db/client",
  "node:fs",
  "node:crypto",
  "fs",
  "zod",
  "@temporalio/client",
  "@temporalio/worker",
  "@temporalio/activity",
  "@temporalio/workflow/lib/internals",
];
const ALLOWED = ["@temporalio/workflow", "./activities", "./proving", "@/lib/schemas/workflows", "@/lib/schemas/ids", "@/workers/research/pace"];

describe("workflow code imports the engine's workflow API, its own folder and the shared schemas, and nothing else", { timeout: 120_000 }, () => {
  it("refuses the database, the gateway, the environment, activities, Node built-ins and everything not named", async () => {
    for (const specifier of REFUSED) {
      const messages = await restricted("workers/workflows/x.ts", importing(specifier));
      expect(messages.length, specifier).toBeGreaterThan(0);
      expect(messages[0], specifier).toContain("feature-specs/28 § 4.2");
    }
  });

  it("refuses them as type imports too: the allow-list is short enough to hold a workflow's types", async () => {
    expect((await restricted("workers/workflows/x.ts", importing("../activities/proving", true))).length).toBeGreaterThan(0);
    expect((await restricted("workers/workflows/x.ts", importing("@/lib/db/client", true))).length).toBeGreaterThan(0);
  });

  it("allows @temporalio/workflow, files of the folder, lib/schemas and the pacing module named on the list", async () => {
    for (const specifier of ALLOWED) expect(await restricted("workers/workflows/x.ts", importing(specifier)), specifier).toEqual([]);
    expect(await restricted("workers/workflows/deep/x.ts", importing("./sibling"))).toEqual([]);
  });

  it("leaves the rest of the workers alone: an activity reaches the database, which is what activities are for", async () => {
    expect(await restricted("workers/activities/x.ts", importing("@/lib/db/client"))).toEqual([]);
    expect(await restricted("workers/activities/x.ts", importing("../workflows/activities", true))).toEqual([]);
    expect(await restricted("workers/temporal.ts", importing("@temporalio/worker"))).toEqual([]);
  });
});

/*
 * feature-specs/28 § 5: lib/workflows/client.ts is the web tier's only import of the engine's SDK, so every start,
 * signal and query is validated, bounded and fails closed in one place; and it imports the SDK's client alone,
 * because the worker's package carries a native module that must never be in the web container's build.
 */
describe("the web tier reaches the workflow engine through lib/workflows/client.ts alone", { timeout: 120_000 }, () => {
  const SDK = ["@temporalio/client", "@temporalio/worker", "@temporalio/workflow", "@temporalio/common", "@temporalio/testing"];

  it("refuses every package of the SDK under app/, components/, lib/ and pipeline/", async () => {
    for (const file of ["app/api/v1/suggestions/route.ts", "components/improve/X.tsx", "lib/db/improve.ts", "lib/gateway/x.ts", "lib/schemas/workflows.ts", "pipeline/x.ts"]) {
      for (const specifier of SDK) {
        const messages = await restricted(file, importing(specifier));
        expect(messages.length, `${file} · ${specifier}`).toBe(1);
        expect(messages[0], `${file} · ${specifier}`).toContain("feature-specs/28 § 5");
      }
    }
  });

  it("allows the SDK's client in lib/workflows/, and no other package of it", async () => {
    expect(await restricted("lib/workflows/client.ts", importing("@temporalio/client"))).toEqual([]);
    for (const specifier of SDK.filter((name) => name !== "@temporalio/client")) {
      expect((await restricted("lib/workflows/client.ts", importing(specifier))).length, specifier).toBe(1);
    }
  });

  it("keeps the rest of the web tier's rules in lib/workflows/: no gateway client, no import of the workers", async () => {
    expect((await restricted("lib/workflows/client.ts", importing("@/lib/gateway/client"))).length).toBe(1);
    expect((await restricted("lib/workflows/client.ts", importing("@/workers/temporal"))).length).toBe(1);
    expect(await restricted("lib/workflows/client.ts", importing("@/lib/schemas/workflows"))).toEqual([]);
  });

  it("leaves the workers, the scripts and the workflow suites' helpers their SDK", async () => {
    expect(await restricted("workers/temporal.ts", importing("@temporalio/worker"))).toEqual([]);
    expect(await restricted("workers/x.ts", importing("@temporalio/client"))).toEqual([]);
    expect(await restricted("scripts/workflows-check.ts", importing("@temporalio/client"))).toEqual([]);
    expect(await restricted("tests/workflows/environment.ts", importing("@temporalio/testing"))).toEqual([]);
    expect(await restricted("tests/integration/x.test.ts", importing("@temporalio/client"))).toEqual([]);
  });
});

describe("the engine's SDK is loaded only when an engine is configured", () => {
  const main = readFileSync(join(root, "workers", "main.ts"), "utf8");

  it("is imported by workers/main.ts on demand, never at the top of the file", () => {
    expect(main).toContain('import("./temporal")');
    expect(main).not.toMatch(/^import .* from "\.\/temporal";$/m);
    expect(main).not.toMatch(/^import .* from "@temporalio\//m);
  });
});
