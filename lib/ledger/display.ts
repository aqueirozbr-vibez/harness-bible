import type { LedgerKind } from "@/lib/schemas/ledger";

import { shortHash } from "./hash";

/*
 * The screens' record line (feature-specs/14 § 6): `hash 8c21f04e9ab3 · prev
 * 3f7a91c2d0e5` on an answer, `prev … · hash …` per record on the history
 * and record pages. The only ledger module the web tier renders from besides
 * the queries; the hashes keep their first 12 hex characters and nothing here
 * localises (ids, hashes and code never do).
 */

/** The fields the line reads; a `LedgerRecord` row has them all. */
export interface LedgerLineInput {
  readonly seq: number;
  readonly kind: LedgerKind;
  readonly hash: string;
  readonly prevHash: string;
  readonly createdAt: Date;
}

export interface LedgerLine {
  readonly short: string;
  readonly prevShort: string;
  readonly seq: number;
  readonly kind: LedgerKind;
  readonly createdAt: Date;
}

export function ledgerLine(record: LedgerLineInput): LedgerLine {
  return { short: shortHash(record.hash), prevShort: shortHash(record.prevHash), seq: record.seq, kind: record.kind, createdAt: record.createdAt };
}

/** A hash alone in the same 12-character form: a chain's head (`head 3c07e9a14b52`, feature-specs/35 § 5). */
export function hashLine(hash: string): string {
  return shortHash(hash);
}
