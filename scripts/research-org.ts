import "dotenv/config";

import { parseArgs } from "node:util";

import { newTraceId } from "@/lib/api/trace";
import { recordAuthEvent } from "@/lib/db/audit";
import { getPrisma } from "@/lib/db/client";
import { ensureResearchOrganisation, RESEARCH_ORGANISATION_NAME, setOrganisationResearch } from "@/lib/db/research";
import { env } from "@/lib/env";
import { tokensOfUsd } from "@/lib/gateway/prices";

/*
 * npm run research:org -- --organisation <id> --set on|off (feature-specs/40 § 8.2, D5): an organisation's switch for
 * research by its members (feature-specs/48 § 9.4, D2: kept). On by default (A4); with no organisation admin screen
 * yet, this command is how it is set, and each run is one row of the audit log (`research_set`) with the organisation
 * and the setting. Off, the start endpoint refuses a member's research (48 § 5.2 check 5) before anything is spent. A
 * member's own switch went with the automatic research in unit 75 (48 § 9.4).
 *
 * npm run research:org -- --create (feature-specs/40 § 7.1, 43 § 3.3; unit 60a): the platform's research organisation,
 * `Research`, with the token cap that is A14's US$ 20 a month at the frontier input price — the `max_budget` of the key
 * `npm run gateway:key -- --org <id>` then mints — no seats and no IDE minutes; `--tokens-per-minute` is the key's rate
 * (a number no spec gives; 100,000 unless said). It prints the id and the two steps that follow, and creates nothing
 * when the organisation exists. One audit row (`research_org_created`). The organisation is marked and found by
 * `Organisation.researchPrincipal` (feature-specs/48 § 7.3; review of unit 70), never by its name: the research views
 * read the platform's payer from that column, and one organisation at most holds it.
 */

const RESEARCH_BUDGET_USD = 20;
const DEFAULT_TOKENS_PER_MINUTE = 100_000;

function refuse(message: string): never {
  console.error(`${message}\nusage: npm run research:org -- --organisation <organisation id> --set on|off\n       npm run research:org -- --create [--tokens-per-minute <n>]`);
  process.exit(1);
}

async function create(tokensPerMinuteArg: string | undefined): Promise<number> {
  const tokensPerMinute = tokensPerMinuteArg === undefined ? DEFAULT_TOKENS_PER_MINUTE : Number(tokensPerMinuteArg);
  if (!Number.isInteger(tokensPerMinute) || tokensPerMinute <= 0) refuse("--tokens-per-minute takes a whole number above zero");
  const tokenCap = BigInt(tokensOfUsd(RESEARCH_BUDGET_USD));
  const result = await ensureResearchOrganisation({ tokenCap, tokensPerMinute });
  if (result.created) {
    const traceId = newTraceId();
    await recordAuthEvent({ kind: "research_org_created", userId: null, detail: { organisationId: result.id, tokenCap: tokenCap.toString(), tokensPerMinute, budgetUsd: RESEARCH_BUDGET_USD }, traceId });
    console.log(`created the research organisation "${RESEARCH_ORGANISATION_NAME}" ${result.id} with a token cap of ${tokenCap.toString()} (US$ ${String(RESEARCH_BUDGET_USD)} a month at the frontier input price), ${String(tokensPerMinute)} tokens a minute (audit ${traceId})`);
  } else {
    console.log(`the research organisation exists: ${result.id}`);
  }
  console.log(`next: npm run gateway:key -- --org ${result.id}\n      RESEARCH_PRINCIPAL=org:${result.id} in .env, then restart the workers (feature-specs/43 § 3.3)`);
  return 0;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { organisation: { type: "string" }, set: { type: "string" }, create: { type: "boolean" }, "tokens-per-minute": { type: "string" } }, strict: true });
  if (env.DATABASE_URL === undefined) refuse("research:org needs DATABASE_URL");
  if (values.create === true) return create(values["tokens-per-minute"]);
  if (values.organisation === undefined || values.organisation.trim() === "") refuse("name the organisation by its id: --organisation");
  if (values.set !== "on" && values.set !== "off") refuse("say --set on or --set off");
  const on = values.set === "on";
  const result = await setOrganisationResearch(values.organisation, on);
  if (!result.found) refuse(`no organisation has the id ${values.organisation}`);
  const traceId = newTraceId();
  await recordAuthEvent({ kind: "research_set", userId: null, detail: { organisationId: values.organisation, researchEnabled: on }, traceId });
  console.log(`research for organisation ${values.organisation}: ${on ? "on" : "off"} (audit ${traceId})`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => (env.DATABASE_URL === undefined ? undefined : getPrisma().$disconnect()));
