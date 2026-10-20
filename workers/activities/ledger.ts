import { ApplicationFailure } from "@temporalio/activity";

import { recordAt } from "@/lib/db/ledger";
import { AppError } from "@/lib/errors";
import { append, type AppendInput } from "@/lib/ledger/append";

/*
 * A workflow step's ledger record, written once (feature-specs/28 § 4.4; code-standards): the step key is
 * `sha256(workflowId + ":" + step)`, the step being the record's kind and the attempt — `submitted:1`, `graded:1` —
 * so a revision's attempt writes records of its own and a retry of the same step finds the one it wrote (33 § 6.4).
 * Temporal's own retry attempt is never part of the key. The record found or appended is answered by its `seq`, never
 * its payload (28 § 5.3).
 *
 * The look and the append are two statements, not one: an attempt that outlives its timeout while still running
 * could append beside its retry. A key unique in the database would need a migration, and the lookup under the
 * chain's lock a change to the protected append; recorded.
 */

/* One definition, in lib (`lib/ledger/hash.ts`): the decision endpoint (unit 53c) waits for the `curator` record by its key. */
export { stepKeyOf } from "@/lib/ledger/hash";

export interface AppendOnceDeps {
  readonly recordAt: typeof recordAt;
  readonly append: typeof append;
}

/** The step's record: the one already written under `stepKey`, or the one appended now. A payload or columns refusal is the code's error and is not retried. */
export async function appendOnce(input: AppendInput & { readonly suggestionId: string }, stepKey: string, deps: AppendOnceDeps = { recordAt, append }): Promise<{ readonly seq: number }> {
  const found = await deps.recordAt(input.suggestionId, input.kind, stepKey);
  if (found !== null) return { seq: found.seq };
  try {
    return { seq: (await deps.append(input)).seq };
  } catch (error: unknown) {
    if (error instanceof AppError && (error.code === "LEDGER_PAYLOAD" || error.code === "LEDGER_COLUMNS")) throw ApplicationFailure.nonRetryable(`${input.kind} of ${input.suggestionId}: ${error.message}`, error.code);
    throw error;
  }
}
