import "dotenv/config";

import { parseArgs } from "node:util";

import { newTraceId } from "@/lib/api/trace";
import { recordAuthEvent } from "@/lib/db/audit";
import { getPrisma } from "@/lib/db/client";
import { currentParts, setRosterEntry } from "@/lib/db/improve";
import { withSystem } from "@/lib/db/tenant";
import { PARTS, PartSchema } from "@/lib/schemas/improve";

/*
 * npm run roster:set -- --email <e-mail> --part <part> [--until <date>] (feature-specs/29 § 6.3): puts a person on
 * the curator roster for a part of the book, or sets when their row ends. It is how an operator writes a roster row:
 * no screen edits the roster, and no role of the product may. The development sign-in is the one other writer: it
 * puts a development curator on it for every part (feature-specs/29 § 17), never in production.
 *
 *   npm run roster:set -- --email ana@example.org --part P3                     from now, with no end
 *   npm run roster:set -- --email ana@example.org --part P3 --until 2027-01-01  until that day begins, UTC
 *
 * The roster says which parts a curator may decide; it does not make anyone a curator. The role is the identity
 * provider's and is mirrored at sign-in, so a row for an account of another role waits for the role, and the
 * command says so. A change takes effect on the person's next request: the roster is read for each one.
 *
 * Each run is one row of the audit log (`roster_set`), with the part and the dates and never the e-mail.
 */

function refuse(message: string): never {
  console.error(`${message}\nusage: npm run roster:set -- --email <e-mail> --part <${PARTS.join("|")}> [--until <YYYY-MM-DD or an ISO instant>]`);
  process.exit(1);
}

function arguments_(): { readonly email: string; readonly part: (typeof PARTS)[number]; readonly until: Date | null } {
  const { values } = parseArgs({ options: { email: { type: "string" }, part: { type: "string" }, until: { type: "string" } }, strict: true });
  if (values.email === undefined || !values.email.includes("@")) refuse("name the account by its e-mail: --email");
  const part = PartSchema.safeParse(values.part);
  if (!part.success) refuse(`name one part of the book: --part ${PARTS.join(", ")}`);
  if (values.until === undefined) return { email: values.email, part: part.data, until: null };
  const until = new Date(values.until);
  if (Number.isNaN(until.getTime())) refuse("--until is a date (2027-01-01, the day it begins in UTC) or an ISO instant");
  return { email: values.email, part: part.data, until };
}

async function main(): Promise<void> {
  const { email, part, until } = arguments_();
  const user = await withSystem(() => getPrisma().user.findUnique({ where: { email }, select: { id: true, role: true, displayName: true, deletedAt: true, deletionRequestedAt: true } }));
  if (user === null || user.deletedAt !== null || user.deletionRequestedAt !== null) {
    refuse("no account has that e-mail, or it is being deleted: the person signs in once before they can be put on the roster");
  }
  const entry = await setRosterEntry({ userId: user.id, part, until });
  await recordAuthEvent({ kind: "roster_set", userId: user.id, detail: { part, since: entry.since.toISOString(), until: entry.until === null ? null : entry.until.toISOString() }, traceId: newTraceId() });

  const parts = await currentParts(user.id);
  console.log(`roster:set ${user.displayName} (${user.id}) is on the roster for ${part} since ${entry.since.toISOString()}${entry.until === null ? ", with no end" : ` until ${entry.until.toISOString()}`}`);
  console.log(`roster:set parts in force for them now: ${parts.length === 0 ? "none" : parts.join(", ")}`);
  if (user.role !== "CURATOR") {
    console.log(`roster:set this account's role is ${user.role}: the row decides nothing until the identity provider gives the account the curator role, which is mirrored at the next sign-in`);
  }
  console.log("roster:set the roster is shown to curators and organisation admins: a curator's display name stands beside their parts on Book management (feature-specs/38 § 4, 47 D1)");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
