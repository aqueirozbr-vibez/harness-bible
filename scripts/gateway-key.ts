import "dotenv/config";

import { parseArgs } from "node:util";

import { getPrisma } from "@/lib/db/client";
import { env } from "@/lib/env";
import type { Principal } from "@/lib/schemas/gateway";
import { workersEnv } from "@/workers/env";
import { ensureKey, keyDb, rotateKey, type KeyDeps } from "@/workers/keys";

/*
 * npm run gateway:key -- --org <organisationId> | --user <userId> (feature-specs/11 § 3.6): mints the principal's
 * virtual key when it has none, rotates it otherwise, through the workers' code path, so "only the workers mint
 * keys" holds on the development machine too. LITELLM_MASTER_KEY and the individual caps are read from this
 * process's environment through workers/env.ts, as the workers read them (spec § 8: never the web tier's
 * schema). Prints the gateway's id for the key, never the key.
 */

function usage(message: string): never {
  console.error(`${message}\nusage: npm run gateway:key -- --org <organisationId> | --user <userId>`);
  process.exit(1);
}

function principalFromArgs(): Principal {
  const { values } = parseArgs({ options: { org: { type: "string" }, user: { type: "string" } }, strict: true });
  if ((values.org === undefined) === (values.user === undefined)) usage("name exactly one of --org and --user");
  return values.org !== undefined ? { organisationId: values.org } : { userId: values.user ?? "" };
}

async function main(): Promise<void> {
  const principal = principalFromArgs();
  const workers = workersEnv();
  const deps: KeyDeps = {
    gatewayUrl: env.GATEWAY_URL,
    masterKey: workers.masterKey,
    keySecret: env.GATEWAY_KEY_SECRET,
    individual: workers.individual,
    fetch: globalThis.fetch,
    now: () => new Date(),
    db: keyDb,
  };
  const existing = await keyDb.findKey(principal);
  const info = existing === null ? await ensureKey(principal, deps) : await rotateKey(principal, deps);
  const who = "organisationId" in principal ? `organisation ${principal.organisationId}` : `user ${principal.userId}`;
  console.log(`gateway:key ${existing === null ? "minted" : "rotated"} the key of ${who}: gateway id ${info.litellmKeyId}${info.rotatedAt === null ? "" : `, rotated ${info.rotatedAt.toISOString()}`}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
