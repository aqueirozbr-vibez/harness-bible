import { EndorsedPayloadSchema, type LedgerKind } from "@/lib/schemas/ledger";

/*
 * Who stands behind a researcher's proposal (feature-specs/42 § 6, § 7; unit 59d), read from the records alone: the
 * latest `ENDORSED` record names the reader, by pseudonym, and the instant of their consent, unless it is the one that
 * took the name back. The ledger keeps both the endorsement and its withdrawal; the row of the asker's own is theirs and
 * never read for this. The merged record's `endorsedBy`, the history's contributor cell (where no merged record says it)
 * and the queue's line all ask here, and so does the workflow's activity before it records a withdrawal, which takes
 * back only the name of that instant (unit 59's review).
 */

export interface EndorsementRecord {
  readonly kind: LedgerKind | string;
  readonly actor: string;
  readonly payload: unknown;
}

/** The name standing on the proposal — the reader's pseudonym (`user:<id>`) and the instant of their consent — or null: none given, or the last one withdrawn or unreadable. */
export function standingEndorsementOf(records: ReadonlyArray<EndorsementRecord>): { readonly actor: string; readonly consentAt: string } | null {
  const last = [...records].reverse().find((record) => record.kind === "ENDORSED");
  if (last === undefined) return null;
  const parsed = EndorsedPayloadSchema.safeParse(last.payload);
  if (!parsed.success || parsed.data.withdrawn || !last.actor.startsWith("user:")) return null;
  return { actor: last.actor, consentAt: parsed.data.consentAt };
}

/** The pseudonym of the reader whose name stands on the proposal, or null. */
export function endorserOf(records: ReadonlyArray<EndorsementRecord>): string | null {
  return standingEndorsementOf(records)?.actor ?? null;
}
