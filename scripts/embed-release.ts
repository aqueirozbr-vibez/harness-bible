import "dotenv/config";

import { parseArgs } from "node:util";

import { getPrisma } from "@/lib/db/client";
import { carryEmbeddings, requireEmbedWrites } from "@/lib/db/search";
import { currentRelease } from "@/lib/db/shared";
import type { Principal } from "@/lib/schemas/gateway";
import { embedRelease } from "@/workers/embed";

/*
 * npm run embed:release (feature-specs/12 § 4.2): the embedding job on the current release, or on `--release <id>`.
 * With `--carry-from <id>` (unit 54c), the job's carry alone: each section whose embedded text is unchanged from the
 * release named keeps that release's vector, with no model call and so no principal, batch or bound; a merge runs it
 * on the release it made, and the changed sections wait for the job's own run.
 * The package script sets EMBED=1, the flag the one content write of § 4.2 needs, as `npm run ingest` sets
 * PIPELINE=1; run this file without it and the write is refused with CONTENT_READ_ONLY.
 *
 * Two values this script cannot invent and so asks for (rules § 4.5):
 * --org <id> | --user <id>   whose key and whose budget rows. D4 wants a platform principal with its own key and
 *                            budget; neither the principal union nor `GatewayKey` can hold one yet and its cap is
 *                            owed, so the operator names an existing principal until then (tracker Open Questions).
 * --batch <n>                texts per `hb-embed` call. The provider's own per-request limit is owed (§ 4.2).
 * --max-chars <n>            characters of a section embedded. What a long section's vector should represent is a
 *                            product decision nobody has made (tracker Open Questions, 2026-09-25); the machine's
 *                            own bound is measurable, so the operator states it and the report says how many
 *                            sections were cut. 16000 is what the self-hosted embedder serves here; 24000 is killed.
 */

function usage(message: string): never {
  console.error(`${message}\nusage: npm run embed:release -- (--org <organisationId> | --user <userId>) --batch <texts per call> [--release <releaseId>]`);
  process.exit(1);
}

interface Arguments {
  readonly principal: Principal;
  readonly batchSize: number;
  readonly maxCharacters: number;
  readonly releaseId: string | null;
}

/** `--release <id> --carry-from <id>`: the carry alone, which asks no model (unit 54c). */
function carryArgs(): { readonly releaseId: string; readonly from: string } | null {
  const { values } = parseArgs({ options: { org: { type: "string" }, user: { type: "string" }, batch: { type: "string" }, "max-chars": { type: "string" }, release: { type: "string" }, "carry-from": { type: "string" } }, strict: true });
  if (values["carry-from"] === undefined) return null;
  if (values.release === undefined) usage("the carry names the release it fills: --release <id> --carry-from <id>");
  return { releaseId: values.release, from: values["carry-from"] };
}

function parse(): Arguments {
  const { values } = parseArgs({ options: { org: { type: "string" }, user: { type: "string" }, batch: { type: "string" }, "max-chars": { type: "string" }, release: { type: "string" }, "carry-from": { type: "string" } }, strict: true });
  if (values.org !== undefined && values.user !== undefined) usage("name at most one of --org and --user");
  const principal: Principal | null = values.org !== undefined ? { organisationId: values.org } : values.user !== undefined ? { userId: values.user } : null;
  if (principal === null) usage("name the principal whose key pays for indexing: --org <organisationId> or --user <userId>");
  if (values.batch === undefined) usage("name the texts per call: --batch <n> (the provider's limit is owed, feature-specs/12 § 4.2)");
  if (!/^\d+$/.test(values.batch) || Number(values.batch) < 1) usage(`--batch must be a whole number of at least 1, not ${values.batch}`);
  const maxChars = values["max-chars"];
  if (maxChars === undefined) usage("name the characters of a section to embed: --max-chars <n> (what a long section's vector represents is owed, feature-specs/12 § 4.2)");
  if (!/^\d+$/.test(maxChars) || Number(maxChars) < 1) usage(`--max-chars must be a whole number of at least 1, not ${maxChars}`);
  return { principal, batchSize: Number(values.batch), maxCharacters: Number(maxChars), releaseId: values.release ?? null };
}

async function main(): Promise<void> {
  const carry = carryArgs();
  if (carry !== null) {
    requireEmbedWrites();
    const carried = await carryEmbeddings(carry.releaseId, carry.from);
    console.log(JSON.stringify({ releaseId: carry.releaseId, from: carry.from, carried }));
    return;
  }
  const args = parse();
  /* Before any gateway call: a run that cannot write its vectors must cost nothing (feature-specs/12 § 4.2). */
  requireEmbedWrites();
  const releaseId = args.releaseId ?? (await currentRelease()).id;
  const report = await embedRelease({ releaseId, principal: args.principal, batchSize: args.batchSize, maxCharacters: args.maxCharacters });
  console.log(JSON.stringify(report, null, 2));
  if (report.stopped !== null) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
