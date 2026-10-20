import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { getPrisma } from "@/lib/db/client";
import { env } from "@/lib/env";
import { REPORTS_DIR } from "@/lib/gate/goldenRun";
import type { ResearchCheckFacts } from "@/lib/gate/research";
import { principalOfId, type Principal } from "@/lib/schemas/gateway";
import { researchCheck, type ResearchCheck } from "@/workers/research/check";

/*
 * npm run research:check (feature-specs/41 § 3, § 11.1; unit 58a): the proof that the pinned proxy carries the
 * provider's web tools and their result blocks on its Anthropic route, which is not known until a real call makes a
 * real search. One reader-row call with both web tools limited to one use each — one search, one fetch — through the
 * real gateway with the research principal's key (workers/research/check.ts); the report printed is the blocks' types,
 * the provider's counts, the gateway's spend before and after and the ledger row's cost. It costs money — one search's
 * fee, one page's tokens — so it is Andre's to run, as every real-provider run is. If the blocks come back as text alone,
 * or the proxy refuses the `tools` field, the unit stops (rules § 4.4) with the two options spec 41 § 3 names: a newer
 * pin of the proxy, or the provider's search by a route the proxy does forward. The key is never printed.
 *
 * Since unit 61b it also writes `pipeline/reports/research-check-<date>.json`, the facts without the answer's text,
 * which the researcher's gate reads for R11 (feature-specs/44 § 2).
 */

/** What the gate reads of the check: whether both tools came back through the proxy, the counts and the cost. */
function factsOf(report: ResearchCheck, at: Date): ResearchCheckFacts {
  return {
    at: at.toISOString(),
    toolsCarried: report.toolsCarried,
    fetchCarried: report.fetchCarried,
    searches: report.searches.usage,
    fetches: report.fetches.usage,
    costUsd: report.ledger.reduce((sum, row) => sum + row.costUsd, 0),
    searchFeeUsd: report.searchFeeUsd,
    gatewayDeltaUsd: report.gatewaySpend.delta,
  };
}

function usage(message: string): never {
  console.error(`${message}\nusage: npm run research:check [-- --principal org:<organisationId>]; without the flag, RESEARCH_PRINCIPAL from the environment`);
  process.exit(1);
}

function principalFromArgs(): Principal {
  const { values } = parseArgs({ options: { principal: { type: "string" } }, strict: true });
  const value = values.principal ?? env.RESEARCH_PRINCIPAL;
  if (value === undefined) usage("RESEARCH_PRINCIPAL is not set: name --principal org:<id>, or set it in .env (feature-specs/40 § 7.1)");
  const principal = principalOfId(value);
  if (principal === null || !("organisationId" in principal)) usage("the research principal is an organisation: org:<organisationId>");
  return principal;
}

researchCheck(principalFromArgs())
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    const at = new Date();
    mkdirSync(REPORTS_DIR, { recursive: true });
    const path = join(REPORTS_DIR, `research-check-${at.toISOString().slice(0, 10)}.json`);
    writeFileSync(path, `${JSON.stringify(factsOf(report, at), null, 2)}\n`);
    console.log(`facts written to ${path}`);
    if (!report.toolsCarried || !report.fetchCarried) {
      console.error(`the proxy did not carry the ${report.toolsCarried ? "fetch tool's" : "web tools'"} blocks: stop (feature-specs/41 § 3) — a newer pin of the proxy, or the provider's search by a route the proxy forwards`);
      process.exitCode = 2;
    }
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
