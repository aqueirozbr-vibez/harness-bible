import { createHash } from "node:crypto";

import { canonicalize, type JsonValue } from "./canonical";

/*
 * The ledger's hashes (architecture § 4.3; feature-specs/14 § 3.2): sha256
 * over the RFC 8785 form of exactly the eight hashed fields, so a record's
 * hash covers its contents and its predecessor's hash, and a verifier can
 * recompute it from the row alone.
 */

/** Lower-case hex sha256 over the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A workflow step's ledger key (feature-specs/28 § 4.4): `sha256(workflowId + ":" + step)`, the step being the record's
 * kind and its attempt (`graded:1`) or, for a curator's decision, `curator:<actionId>`. The workers write a step's record
 * under it once; the decision endpoint (unit 53c) waits for the `curator` record by it.
 */
export const stepKeyOf = (workflowId: string, step: string): string => sha256Hex(`${workflowId}:${step}`);

/** `sha256("harness-bible-ledger-genesis")`: the `prevHash` of the first record. */
export const GENESIS_PREV_HASH = "ebe4996dd2a72beea926ad3070d840f0e5a5e13969ff1a6ee244e48a784a1d7c";

/** The fields a record's hash covers. `kind` is the record kind's name as stored; the append path narrows it to the kinds the schema knows. */
export interface HashableRecord {
  readonly seq: number;
  readonly kind: string;
  readonly actor: string;
  readonly suggestionId: string | null;
  readonly chapterVersionId: string | null;
  readonly payload: JsonValue;
  readonly createdAt: Date;
  readonly prevHash: string;
}

/** The hashed form: the eight fields, nulls kept, `createdAt` as an ISO-8601 UTC string with millisecond precision. A type alias, not an interface, so it is a `JsonValue`. */
export type HashedForm = {
  readonly seq: number;
  readonly kind: string;
  readonly actor: string;
  readonly suggestionId: string | null;
  readonly chapterVersionId: string | null;
  readonly payload: JsonValue;
  readonly createdAt: string;
  readonly prevHash: string;
};

export function hashable(record: HashableRecord): HashedForm {
  return {
    seq: record.seq,
    kind: record.kind,
    actor: record.actor,
    suggestionId: record.suggestionId,
    chapterVersionId: record.chapterVersionId,
    payload: record.payload,
    createdAt: record.createdAt.toISOString(),
    prevHash: record.prevHash,
  };
}

export function recordHash(record: HashableRecord): string {
  return sha256Hex(canonicalize(hashable(record)));
}

/** The display form: the first 12 hex characters (`chained · sha-256, first 12 hex`). */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
