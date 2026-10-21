import "dotenv/config";

import { parseArgs } from "node:util";

import { getPrisma } from "@/lib/db/client";
import { principalsWithKeys } from "@/lib/db/gateway";
import { env, messageTextGate } from "@/lib/env";
import { principalId, type Principal } from "@/lib/schemas/gateway";
import { workersEnv } from "@/workers/env";
import { ensureKey, keyDb, rotateKey, type KeyDeps } from "@/workers/keys";

/*
 * npm run gateway:key -- --org <organisationId> | --user <userId> (feature-specs/11 § 3.6): mints the principal's
 * virtual key when it has none, rotates it otherwise, through the workers' code path, so "only the workers mint
 * keys" holds on the development machine too. LITELLM_MASTER_KEY and the individual caps are read from this
 * process's environment through workers/env.ts, as the workers read them (spec § 8: never the web tier's
 * schema). Prints the gateway's id for the key, never the key. A key minted while this process's development text
 * gate is on carries the flag that lets its requests opt out of the gateway's redaction (feature-specs/49 § 9.2, D2).
 *
 * npm run gateway:key -- --flagged (feature-specs/49 § 16, unit 82): which keys carry that flag. For each principal
 * with a key it asks the gateway's /key/info, by the key's hash, under the master key, and prints the principal,
 * the gateway's id and flagged or not; never a key. It changes nothing.
 */

function usage(message: string): never {
  console.error(`${message}\nusage: npm run gateway:key -- --org <organisationId> | --user <userId> | --flagged`);
  process.exit(1);
}

const { values } = parseArgs({ options: { org: { type: "string" }, user: { type: "string" }, flagged: { type: "boolean" } }, strict: true });

function principalFromArgs(): Principal {
  if ((values.org === undefined) === (values.user === undefined)) usage("name exactly one of --org and --user, or --flagged alone");
  return values.org !== undefined ? { organisationId: values.org } : { userId: values.user ?? "" };
}

/** The keys whose metadata lets their requests opt out of redaction, asked of the gateway itself: ids only. */
async function listFlagged(): Promise<void> {
  const masterKey = workersEnv().masterKey;
  if (env.GATEWAY_URL === undefined || masterKey === undefined) usage("GATEWAY_URL and LITELLM_MASTER_KEY must be set: /key/info is a management route");
  let keys = 0;
  let flagged = 0;
  let unknown = 0;
  for (const principal of await principalsWithKeys()) {
    const row = await keyDb.findKey(principal);
    if (row === null) continue;
    keys += 1;
    const response = await fetch(`${env.GATEWAY_URL}/key/info?key=${encodeURIComponent(row.litellmKeyId)}`, { headers: { authorization: `Bearer ${masterKey}` } });
    /* A row whose key this gateway does not hold (a test fixture's, minted against the stub) cannot opt out of
       anything, but only LiteLLM's own answer says so: a route's 404 or the stub's is a wrong GATEWAY_URL, an error
       (unit 82's review). */
    if (response.status === 404) {
      const answer = (await response.json().catch(() => null)) as { readonly error?: { readonly type?: string; readonly param?: string } } | null;
      if (answer?.error?.type === "not_found_error" && answer.error.param === "key") {
        unknown += 1;
        console.log(`${principalId(principal)} · gateway id ${row.litellmKeyId} · unknown to this gateway, so not flagged`);
        continue;
      }
    }
    if (!response.ok) {
      console.error(`${principalId(principal)} · gateway id ${row.litellmKeyId} · /key/info answered ${String(response.status)}`);
      process.exitCode = 1;
      continue;
    }
    const answer = (await response.json()) as { readonly info?: { readonly metadata?: Readonly<Record<string, unknown>> } };
    const flag = answer.info?.metadata?.allow_client_message_redaction_opt_out === true;
    if (flag) flagged += 1;
    console.log(`${principalId(principal)} · gateway id ${row.litellmKeyId} · ${flag ? "flagged" : "not flagged"}`);
  }
  console.log(`gateway:key --flagged · ${String(keys)} keys · ${String(flagged)} flagged · ${String(unknown)} unknown to this gateway`);
  if (keys > 0 && unknown === keys) {
    console.error(`gateway:key --flagged: no key is known to ${env.GATEWAY_URL}; is GATEWAY_URL the gateway the workers call?`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (values.flagged === true) {
    if (values.org !== undefined || values.user !== undefined) usage("--flagged takes no principal");
    await listFlagged();
    return;
  }
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
    messageText: messageTextGate,
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
