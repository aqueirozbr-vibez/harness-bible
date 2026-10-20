import { getPrisma } from "@/lib/db/client";
import type { LedgerRecord } from "@/lib/db/generated/client";
import { lockHead } from "@/lib/db/ledger";
import { AppError, isUniqueViolation } from "@/lib/errors";
import { LedgerPayloadSchema, recordIssue, type LedgerPayloadInput } from "@/lib/schemas/ledger";

import { GENESIS_PREV_HASH, recordHash } from "./hash";

/*
 * The ledger's one writer (feature-specs/14 § 4.2; code-standards § Data and
 * storage; architecture § 11 invariants 16 and 18). In one transaction: lock
 * and read the chain head, compute `seq`, `prevHash` and the hash, insert with
 * `seq` named, and advance the sequence to match so a gap cannot appear. A
 * writer that still raced a stale head fails on the primary key, retries once
 * and then surfaces `LEDGER_CONFLICT`. Before any of that the payload is
 * checked against its kind's schema (`LEDGER_PAYLOAD`) and the record's own
 * columns against its kind's rule (`LEDGER_COLUMNS`: who may be its actor, and
 * whether it names a suggestion), so nothing is written for a record either
 * refuses. Every kind is admitted since unit 46c (feature-specs/29 § 5).
 * Nothing else inserts a record; nothing updates or deletes one.
 */

/** The kind with its payload (lib/schemas/ledger.ts) and the record's other columns. `actor` is a pseudonymous user id or a service identity; never a name or an e-mail. */
export type AppendInput = LedgerPayloadInput & {
  readonly actor: string;
  readonly suggestionId: string | null;
  readonly chapterVersionId: string | null;
};

export interface AppendDeps {
  readonly now?: () => Date;
}

export async function append(input: AppendInput, deps: AppendDeps = {}): Promise<LedgerRecord> {
  const check = LedgerPayloadSchema.safeParse({ kind: input.kind, payload: input.payload });
  if (!check.success) {
    const issues = check.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new AppError("LEDGER_PAYLOAD", `the ${input.kind} payload fails its schema (feature-specs/14 § 6) and nothing was written: ${issues}`);
  }
  const columns = recordIssue(input);
  if (columns !== null) throw new AppError("LEDGER_COLUMNS", `${columns} (feature-specs/29 § 5); nothing was written.`);
  const now = deps.now ?? (() => new Date());
  try {
    return await attempt(input, now);
  } catch (error) {
    if (!isSeqTaken(error)) throw error;
  }
  try {
    return await attempt(input, now);
  } catch (error) {
    if (!isSeqTaken(error)) throw error;
    throw new AppError("LEDGER_CONFLICT", "two appends raced on the chain head twice; append again.");
  }
}

function attempt(input: AppendInput, now: () => Date): Promise<LedgerRecord> {
  return getPrisma().$transaction(async (tx) => {
    const current = await lockHead(tx);
    const fields = {
      seq: current === null ? 1 : current.seq + 1,
      kind: input.kind,
      actor: input.actor,
      suggestionId: input.suggestionId,
      chapterVersionId: input.chapterVersionId,
      payload: input.payload,
      createdAt: now(),
      prevHash: current === null ? GENESIS_PREV_HASH : current.hash,
    };
    const record = await tx.ledgerRecord.create({ data: { ...fields, hash: recordHash(fields) } });
    await tx.$queryRaw`SELECT setval(pg_get_serial_sequence('"LedgerRecord"', 'seq'), ${fields.seq})`;
    return record;
  });
}

/** A unique-constraint refusal; on this table it is the primary key `seq` a concurrent writer took first. */
function isSeqTaken(error: unknown): boolean {
  return isUniqueViolation(error);
}
