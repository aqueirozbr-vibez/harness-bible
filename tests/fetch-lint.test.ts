import { join } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/*
 * feature-specs/32 § 4, § 13.9: the evidence fetcher (workers/fetch/) is imported nowhere in the web tier — not
 * from app/, components/, lib/ or pipeline/, not by the web tier's two clients in lib/workflows/ and lib/gateway/,
 * and not by the workflow suites' helpers. The rule is `no-restricted-imports` in eslint.config.mjs, with its own
 * group beside the one that closes workers/ as a whole, so that the fetcher stays closed should workers/ ever be
 * opened. This test lints a snippet under each folder, so the rule itself is verified, not only the tree today.
 */

const root = join(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: root });

async function fetcherMessages(file: string, source: string): Promise<ReadonlyArray<string>> {
  const [result] = await eslint.lintText(source, { filePath: join(root, file) });
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports" && m.message.includes("feature-specs/32")).map((m) => m.message);
}

const FETCH = 'import { fetchEvidence } from "@/workers/fetch/fetch";\nexport const x = fetchEvidence;\n';
const GUARD = 'import { checkUrl } from "@/workers/fetch/guard";\nexport const x = checkUrl;\n';
const RELATIVE = 'import { checkUrl } from "../workers/fetch/guard";\nexport const x = checkUrl;\n';
const RELATIVE_DEEP = 'import { extractHtml } from "../../workers/fetch/html";\nexport const x = extractHtml;\n';

describe("the web tier cannot import the evidence fetcher", { timeout: 60_000 }, () => {
  it("refuses workers/fetch/ under app/, components/, lib/, lib/workflows/, lib/gateway/, pipeline/, infra/ and the workflow suites' helpers", async () => {
    for (const file of ["app/api/v1/x/route.ts", "components/improve/X.tsx", "lib/db/x.ts", "lib/workflows/x.ts", "lib/gateway/x.ts", "lib/api/endpoints/x.ts", "pipeline/x.ts", "infra/gateway/stub/x.ts", "tests/workflows/x.ts"]) {
      expect(await fetcherMessages(file, FETCH), file).toHaveLength(1);
      expect(await fetcherMessages(file, GUARD), file).toHaveLength(1);
    }
    expect(await fetcherMessages("lib/x.ts", RELATIVE)).toHaveLength(1);
    expect(await fetcherMessages("lib/api/x.ts", RELATIVE_DEEP)).toHaveLength(1);
    expect((await fetcherMessages("app/x.ts", FETCH))[0]).toContain("invariant 34");
  });

  it("allows the workers themselves, the script that runs it by hand, and tests", async () => {
    expect(await fetcherMessages("workers/activities/x.ts", FETCH)).toEqual([]);
    expect(await fetcherMessages("workers/fetch/x.ts", 'import { checkUrl } from "./guard";\nexport const x = checkUrl;\n')).toEqual([]);
    expect(await fetcherMessages("scripts/fetch-check.ts", FETCH)).toEqual([]);
    expect(await fetcherMessages("tests/x.test.ts", FETCH)).toEqual([]);
    expect(await fetcherMessages("tests/integration/x.test.ts", GUARD)).toEqual([]);
    expect(await fetcherMessages("workers/fetch/fetch.test.ts", 'import { fetchEvidence } from "./fetch";\nexport const x = fetchEvidence;\n')).toEqual([]);
  });

  it("keeps the whole of workers/ closed to the web tier beside it (the blocks do not replace each other)", async () => {
    const [result] = await eslint.lintText(FETCH, { filePath: join(root, "lib/db/x.ts") });
    expect(result.messages.filter((m) => m.ruleId === "no-restricted-imports")).toHaveLength(2);
  });
});
