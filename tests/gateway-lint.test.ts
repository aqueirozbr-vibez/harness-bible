import { join } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/*
 * feature-specs/11 § 5.5, § 12.2 and feature-specs/12 § 4.3, § 7.1: the web container's build has no import of
 * lib/gateway/client.ts, keys.ts, embed.ts or rerank.ts — the four modules that decrypt the principal's key and
 * reach the proxy. The rule is `no-restricted-imports` in eslint.config.mjs; this test lints a snippet under each
 * folder so the rule itself is verified, not only the tree as it stands today.
 */

const root = join(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: root });

async function restricted(file: string, source: string): Promise<ReadonlyArray<string>> {
  const [result] = await eslint.lintText(source, { filePath: join(root, file) });
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

const CLIENT = 'import { callModel } from "@/lib/gateway/client";\nexport const x = callModel;\n';
const KEYS = 'import { decryptKey } from "@/lib/gateway/keys";\nexport const x = decryptKey;\n';
const EMBED = 'import { embedTexts } from "@/lib/gateway/embed";\nexport const x = embedTexts;\n';
const RERANK = 'import { rerank } from "@/lib/gateway/rerank";\nexport const x = rerank;\n';
const RELATIVE = 'import { decryptKey } from "../lib/gateway/keys";\nexport const x = decryptKey;\n';
const WORKERS = 'import { gatewayCheck } from "@/workers/check";\nimport { ensureKey } from "@/workers/keys";\nexport const x = [gatewayCheck, ensureKey];\n';
const WORKERS_DEEP = 'import { assemble } from "@/workers/agents/assistant/assemble";\nexport const x = assemble;\n';
const WORKERS_RELATIVE = 'import { gatewayCheck } from "../workers/check";\nexport const x = gatewayCheck;\n';
const WORKERS_CLIENT = 'import { workersFetch } from "@/lib/workers/client";\nexport const x = workersFetch;\n';
const ALLOWED = 'import { BudgetExceededError } from "@/lib/gateway/errors";\nimport { priceOf } from "@/lib/gateway/prices";\nimport { monthSpend } from "@/lib/db/budget";\nexport const x = [BudgetExceededError, priceOf, monthSpend];\n';

describe("the web tier cannot import the gateway client, the key cipher or the two calls built on them", { timeout: 60_000 }, () => {
  it("refuses client.ts, keys.ts, embed.ts and rerank.ts under app/, components/ and lib/", async () => {
    for (const file of ["app/api/v1/x/route.ts", "components/assistant/X.tsx", "lib/db/x.ts", "pipeline/x.ts", "scripts/x.ts"]) {
      expect(await restricted(file, CLIENT), file).toHaveLength(1);
      expect(await restricted(file, KEYS), file).toHaveLength(1);
      expect(await restricted(file, EMBED), file).toHaveLength(1);
      expect(await restricted(file, RERANK), file).toHaveLength(1);
    }
    expect((await restricted("app/x.ts", CLIENT))[0]).toContain("invariant 6");
    expect(await restricted("app/x.ts", RELATIVE)).toHaveLength(1);
  });

  it("allows errors.ts, prices.ts and lib/db/budget.ts everywhere", async () => {
    expect(await restricted("app/x.ts", ALLOWED)).toEqual([]);
    expect(await restricted("components/admin/X.tsx", ALLOWED)).toEqual([]);
  });

  it("allows the workers, the gateway folder itself and tests", async () => {
    expect(await restricted("workers/x.ts", CLIENT)).toEqual([]);
    expect(await restricted("workers/x.ts", KEYS)).toEqual([]);
    expect(await restricted("workers/embed.ts", EMBED)).toEqual([]);
    expect(await restricted("workers/x.ts", RERANK)).toEqual([]);
    expect(await restricted("lib/gateway/x.ts", KEYS)).toEqual([]);
    expect(await restricted("lib/gateway/x.ts", EMBED)).toEqual([]);
    expect(await restricted("tests/x.test.ts", CLIENT)).toEqual([]);
    expect(await restricted("tests/integration/x.test.ts", RERANK)).toEqual([]);
  });
});

/*
 * The same invariant through the transitive path (feature-specs/11 § 5.5, § 7.1): workers/check.ts and
 * workers/keys.ts import the client and the cipher, so an import of workers/ from the web tier reaches them.
 * The door that stays open is lib/workers/client.ts, which the web tier dials over HTTP (§ 7.2).
 */
describe("the web tier cannot import the workers", { timeout: 60_000 }, () => {
  it("refuses workers/ under app/, components/, lib/, pipeline/ and infra/", async () => {
    for (const file of ["app/api/v1/x/route.ts", "components/assistant/X.tsx", "lib/db/x.ts", "lib/gateway/x.ts", "pipeline/x.ts", "infra/gateway/stub/x.ts"]) {
      expect(await restricted(file, WORKERS), file).toHaveLength(2);
      expect(await restricted(file, WORKERS_DEEP), file).toHaveLength(1);
      expect(await restricted(file, WORKERS_RELATIVE), file).toHaveLength(1);
    }
    expect((await restricted("app/x.ts", WORKERS))[0]).toContain("invariant 6");
  });

  it("allows lib/workers/client.ts, the workers themselves, the scripts that run their code and tests", async () => {
    for (const file of ["app/api/v1/x/route.ts", "components/assistant/X.tsx", "lib/db/x.ts"]) {
      expect(await restricted(file, WORKERS_CLIENT), file).toEqual([]);
    }
    expect(await restricted("scripts/x.ts", WORKERS)).toEqual([]);
    expect(await restricted("workers/x.ts", WORKERS)).toEqual([]);
    expect(await restricted("tests/x.test.ts", WORKERS)).toEqual([]);
  });

  it("keeps the client and the cipher restricted where the workers group is added (the blocks do not replace each other)", async () => {
    expect(await restricted("app/x.ts", CLIENT)).toHaveLength(1);
    expect(await restricted("scripts/x.ts", KEYS)).toHaveLength(1);
    expect(await restricted("scripts/x.ts", RERANK)).toHaveLength(1);
    expect(await restricted("lib/gateway/x.ts", CLIENT)).toEqual([]);
  });
});
