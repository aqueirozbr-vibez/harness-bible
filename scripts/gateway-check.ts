import "dotenv/config";

import { parseArgs } from "node:util";

import { getPrisma } from "@/lib/db/client";
import type { Principal } from "@/lib/schemas/gateway";
import { startTelemetry, stopTelemetry } from "@/lib/telemetry/tracer";
import { gatewayCheck } from "@/workers/check";
import { checkPrincipalOf } from "@/workers/env";

/*
 * npm run gateway:check (feature-specs/11 § 3.6, § 12.4): one `hb-small` call through the client with the
 * principal's key and the usage block printed; the smoke test of a fresh environment. The spec runs it bare, so
 * the principal defaults to GATEWAY_CHECK_PRINCIPAL from the environment (`org:<id>` or `user:<id>`, an id the
 * operator sets in .env, never a value this script invents), and --org or --user overrides it. The call writes its
 * BudgetLedger row and span line like any other.
 */

function usage(message: string): never {
  console.error(`${message}\nusage: npm run gateway:check [-- --org <organisationId> | --user <userId>]; without a flag, GATEWAY_CHECK_PRINCIPAL from the environment`);
  process.exit(1);
}

function principalFromArgs(): Principal {
  const { values } = parseArgs({ options: { org: { type: "string" }, user: { type: "string" } }, strict: true });
  if (values.org !== undefined && values.user !== undefined) usage("name at most one of --org and --user");
  if (values.org !== undefined) return { organisationId: values.org };
  if (values.user !== undefined) return { userId: values.user };
  const configured = ((): Principal | null => {
    try {
      return checkPrincipalOf();
    } catch (error: unknown) {
      usage(error instanceof Error ? error.message : String(error));
    }
  })();
  if (configured === null) usage("GATEWAY_CHECK_PRINCIPAL is not set: name --org or --user, or set it in .env (feature-specs/11 § 3.6)");
  return configured;
}

const principal = principalFromArgs();
/* The call's span is exported too when a collector is configured, so the gateway's generation has its parent there (feature-specs/49 § 16, unit 80). */
startTelemetry("hb-jobs")
  .then(() => gatewayCheck(principal))
  .then((check) => {
    console.log(JSON.stringify(check, null, 2));
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopTelemetry();
    await getPrisma().$disconnect();
  });
