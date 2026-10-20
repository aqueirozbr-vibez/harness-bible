import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { once } from "node:events";
import type { Writable } from "node:stream";

import { accountView, hashesAt, recordsAt, select, toChainRecord, type LedgerView } from "@/lib/db/ledger";
import { AppError } from "@/lib/errors";
import { ExportLineSchema, ExportTrailerLineSchema, type ExportTrailer, type LedgerKind } from "@/lib/schemas/ledger";

import { canonicalize, type JsonValue } from "./canonical";
import { hashable } from "./hash";
import { verifyView, type ChainCheck, type Predecessor, type ViewRecord } from "./verify";

/*
 * The JSONL export with its signed trailer (architecture § 4.3;
 * feature-specs/14 § 5.2, D2). One canonical line per record, the hashed
 * form plus `hash`; a filtered scope's lines also carry the record's
 * predecessor, so the file verifies without the records between them. The
 * trailer is signed with the platform's Ed25519 export key and re-verified
 * with the public half alone. `exportJsonl` reads the chain and writes;
 * `verifyExport` is pure and re-reads a file: every hash, every link, the
 * head and the signature. Both line shapes are the schemas in
 * lib/schemas/ledger.ts, so a trailer is read with the scope the `EXPORT`
 * payload is written with.
 */

export type ExportScope =
  | { readonly kind: "all"; readonly from?: Date; readonly to?: Date }
  | { readonly kind: "suggestion"; readonly id: string; readonly from?: Date; readonly to?: Date }
  /** A chapter's history (feature-specs/37 § 7; unit 54d): `id` is the chapter's number as the book writes it (`21`), and the records are its merged suggestions' (35 D2). Since unit 55b, `kinds` narrows the audit pack's (38 § 3). */
  | { readonly kind: "chapter"; readonly id: string; readonly suggestionIds: readonly string[]; readonly kinds?: readonly LedgerKind[]; readonly from?: Date; readonly to?: Date }
  /**
   * An account's records (feature-specs/38 § 3; unit 55b): `id` is the account's — a person's or an organisation's — and
   * the records are those its pseudonyms wrote and those about its own suggestions, narrowed to `kinds` when given.
   */
  | { readonly kind: "account"; readonly id: string; readonly actors: readonly string[]; readonly suggestionIds: readonly string[]; readonly kinds?: readonly LedgerKind[]; readonly from?: Date; readonly to?: Date }
  /**
   * A conversation's own records, by their `seq`s; `id` is the conversation's (feature-specs/17 § 6). No window: the ids
   * are the scope. Since unit 73 a person's research's own `RESEARCH` records too, `id` the research's (feature-specs/48
   * § 11.10): the trailer, and the `EXPORT` record written from it, name the scope's kind.
   */
  | { readonly kind: "messages" | "research"; readonly id: string; readonly seqs: readonly number[] };

/** A scope named by its records' `seq`s, which has no view and no window. */
type BySeqs = Extract<ExportScope, { readonly seqs: readonly number[] }>;

/** The view a scope selects, or null for the whole chain; a scope by `seq` selects none. */
export function viewOf(scope: Exclude<ExportScope, BySeqs>): LedgerView | null {
  switch (scope.kind) {
    case "all":
      return null;
    case "suggestion":
      return { suggestionId: scope.id };
    case "chapter":
      return { suggestionId: { in: [...scope.suggestionIds] } };
    case "account":
      return accountView(scope.actors, scope.suggestionIds);
  }
}

/** The kinds a scope narrows to, or null for every kind. */
function kindsOf(scope: ExportScope): readonly LedgerKind[] | null {
  return (scope.kind === "chapter" || scope.kind === "account") && scope.kinds !== undefined ? scope.kinds : null;
}

/** The platform export key: an Ed25519 private key (`LEDGER_EXPORT_KEY`). */
export type ExportKey = KeyObject;

export interface ExportDeps {
  readonly key: ExportKey;
  readonly now: () => Date;
}

export interface ExportCheck {
  readonly ok: boolean;
  /** Record lines read (the trailer excluded). */
  readonly lines: number;
  /** The 1-based number of the first line that is not a canonical record line, or null. */
  readonly malformedLine: number | null;
  readonly trailer: ExportTrailer | null;
  readonly signature: "valid" | "invalid" | "missing";
  readonly chain: ChainCheck | null;
  /** The chain's head, span and count equal what the signed trailer states. */
  readonly matchesTrailer: boolean;
}

/** `LEDGER_EXPORT_KEY` as a key object; absent refuses (spec § 7), anything but an Ed25519 private key too. */
export function exportKeyFromPem(pem: string | undefined): ExportKey {
  if (pem === undefined) throw new AppError("LEDGER_KEY_MISSING", "LEDGER_EXPORT_KEY is not set; an export is signed with the platform export key and refuses without it (feature-specs/14 § 7). Appends still work.");
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new AppError("LEDGER_KEY_INVALID", "LEDGER_EXPORT_KEY is not a PEM private key; `npm run ledger:keygen` writes one.");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new AppError("LEDGER_KEY_INVALID", `LEDGER_EXPORT_KEY is a ${key.asymmetricKeyType} key; the export trailer is signed with Ed25519 (feature-specs/14 D2).`);
  return key;
}

/** Writes the scope's records and the signed trailer to `sink` and returns the trailer. */
export async function exportJsonl(scope: ExportScope, sink: Writable, deps: ExportDeps): Promise<ExportTrailer> {
  const rows = "seqs" in scope ? await recordsAt(scope.seqs) : await select({ view: viewOf(scope), from: scope.from ?? null, to: scope.to ?? null, kinds: kindsOf(scope) });
  if (rows.length === 0) throw new AppError("LEDGER_EXPORT_EMPTY", "the scope matches no record; nothing to sign.");
  const records = rows.map(toChainRecord);
  // An `all` window selects by `createdAt`, which each writer's clock stamps, so it can skip a lower `seq`: only the contiguous chain from the genesis verifies without predecessors.
  const contiguous = records.every((record, index) => index === 0 || record.seq === records[index - 1].seq + 1);
  const carry = scope.kind !== "all" || records[0].seq !== 1 || !contiguous;
  const predecessors = carry ? await predecessorsOf(records.map((r) => r.seq)) : null;
  for (const record of records) {
    const line = { ...hashable(record), hash: record.hash };
    await writeLine(sink, canonicalize(predecessors === null ? line : { ...line, predecessor: predecessors.get(record.seq) ?? null }));
  }
  const last = records[records.length - 1];
  const kinds = kindsOf(scope);
  const unsigned = {
    headHash: last.hash,
    fromSeq: records[0].seq,
    toSeq: last.seq,
    records: records.length,
    scope: { kind: scope.kind, id: scope.kind === "all" ? null : scope.id, from: windowOf(scope).from?.toISOString() ?? null, to: windowOf(scope).to?.toISOString() ?? null, ...(kinds === null ? {} : { kinds: [...kinds] }) },
    exportedAt: deps.now().toISOString(),
  };
  const trailer: ExportTrailer = { ...unsigned, signature: sign(null, Buffer.from(canonicalize(unsigned), "utf8"), deps.key).toString("hex") };
  await writeLine(sink, canonicalize({ trailer }));
  return trailer;
}

/** A scope's `createdAt` window; a scope by `seq` has none, because its ids are its whole extent. */
function windowOf(scope: ExportScope): { readonly from?: Date; readonly to?: Date } {
  return "seqs" in scope ? {} : { from: scope.from, to: scope.to };
}

/** Each record's predecessor by `seq`; a record at `seq` 1 has none and is left out (its line carries `null`). */
async function predecessorsOf(seqs: readonly number[]): Promise<ReadonlyMap<number, Predecessor>> {
  const wanted = seqs.filter((seq) => seq > 1).map((seq) => seq - 1);
  const hashes = await hashesAt(wanted);
  const result = new Map<number, Predecessor>();
  for (const seq of wanted) {
    const hash = hashes.get(seq);
    if (hash === undefined) throw new AppError("LEDGER_PREDECESSOR_MISSING", `record ${seq} is missing from the chain; the export cannot carry the predecessor of ${seq + 1}.`);
    result.set(seq + 1, { seq, hash });
  }
  return result;
}

async function writeLine(sink: Writable, text: string): Promise<void> {
  if (!sink.write(`${text}\n`)) await once(sink, "drain");
}

/** The public half of the export key as a key object; anything but an Ed25519 public key refuses with `LEDGER_KEY_INVALID`, as `exportKeyFromPem` does. */
function publicKeyFromPem(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new AppError("LEDGER_KEY_INVALID", "the public key is not a PEM public key; infra/ledger/export-public.pem holds the export key's public half.");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new AppError("LEDGER_KEY_INVALID", `the public key is a ${key.asymmetricKeyType} key; the export trailer is signed with Ed25519 (feature-specs/14 D2).`);
  return key;
}

/** Re-verifies an export file's lines with the public half of the export key (a PEM); a PEM that is not an Ed25519 public key throws `LEDGER_KEY_INVALID`. */
export function verifyExport(lines: readonly string[], publicKeyPem: string): ExportCheck {
  const body = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const trailer = body.length === 0 ? null : parseTrailer(body[body.length - 1]);
  if (trailer === null) {
    return { ok: false, lines: body.length, malformedLine: body.length === 0 ? null : body.length, trailer: null, signature: "missing", chain: null, matchesTrailer: false };
  }
  const { signature, ...unsigned } = trailer;
  const signatureState = verify(null, Buffer.from(canonicalize(unsigned), "utf8"), publicKeyFromPem(publicKeyPem), Buffer.from(signature, "hex")) ? "valid" : "invalid";
  const records: ViewRecord[] = [];
  for (let index = 0; index < body.length - 1; index += 1) {
    const record = parseLine(body[index]);
    if (record === null) return { ok: false, lines: body.length - 1, malformedLine: index + 1, trailer, signature: signatureState, chain: null, matchesTrailer: false };
    records.push(record);
  }
  const chain = verifyView(records, { before: null, after: null });
  const matchesTrailer = chain.headHash === trailer.headHash && chain.from === trailer.fromSeq && chain.to === trailer.toSeq && chain.records === trailer.records;
  return { ok: signatureState === "valid" && chain.ok && matchesTrailer, lines: records.length, malformedLine: null, trailer, signature: signatureState, chain, matchesTrailer };
}

type JsonObject = { readonly [name: string]: JsonValue };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The line's JSON when it is exactly its own canonical form, else null; a number JSON.parse reads as Infinity (`1e400`) has no canonical form. */
function parseCanonical(text: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) && canonicalize(value) === text ? value : null;
  } catch {
    return null;
  }
}

function parseLine(text: string): ViewRecord | null {
  const value = parseCanonical(text);
  if (value === null) return null;
  const line = ExportLineSchema.safeParse(value);
  if (!line.success) return null;
  return { ...line.data, createdAt: new Date(line.data.createdAt) };
}

function parseTrailer(text: string): ExportTrailer | null {
  const value = parseCanonical(text);
  if (value === null) return null;
  const line = ExportTrailerLineSchema.safeParse(value);
  return line.success ? line.data.trailer : null;
}
