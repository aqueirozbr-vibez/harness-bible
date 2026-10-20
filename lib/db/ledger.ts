import { getPrisma, type ExtendedClient } from "@/lib/db/client";
import type { LedgerRecord } from "@/lib/db/generated/client";
import type { LedgerKind } from "@/lib/db/generated/enums";
import type { JsonValue } from "@/lib/ledger/canonical";
import { stepKeyOf } from "@/lib/ledger/hash";
import { verifyView, type ChainCheck, type ChainRecord, type ViewRecord } from "@/lib/ledger/verify";

/*
 * The ledger's queries (feature-specs/14 § 4.2): the chain head, a range, the
 * filtered views and their chain neighbours. Nothing here writes; the one
 * writer is `lib/ledger/append.ts`. `LedgerRecord` is not a tenant model: the
 * platform owns the chain and a per-account or per-chapter view is a filter.
 */

/** The members a query needs, which an interactive transaction's client also has. */
export type LedgerClient = Pick<ExtendedClient, "$queryRaw" | "ledgerRecord">;

export interface ChainHead {
  readonly seq: number;
  readonly hash: string;
}

/** The newest record's `seq` and `hash`, or null on an empty chain. */
export function head(client: LedgerClient = getPrisma()): Promise<ChainHead | null> {
  return client.ledgerRecord.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, hash: true } });
}

/**
 * Locks the chain head for the transaction (`SELECT … FOR UPDATE`) and returns
 * it, so concurrent appends queue behind the lock (spec § 4.2, D3). A `FOR
 * UPDATE` that waited returns the row its snapshot chose, not a row committed
 * meanwhile, so the head is re-read in a fresh statement and the lock is taken
 * again until the locked row is the head that statement sees. An empty chain
 * locks nothing; the primary key catches the first two appends' race there.
 */
export async function lockHead(tx: LedgerClient): Promise<ChainHead | null> {
  for (;;) {
    const locked = await tx.$queryRaw<ChainHead[]>`SELECT "seq", "hash" FROM "LedgerRecord" ORDER BY "seq" DESC LIMIT 1 FOR UPDATE`;
    const fresh = await head(tx);
    const lockedSeq = locked.length === 0 ? null : locked[0].seq;
    if (lockedSeq === (fresh === null ? null : fresh.seq)) return fresh;
  }
}

/** Records `from` to `to` inclusive, in chain order. */
export function range(from: number, to: number, client: LedgerClient = getPrisma()): Promise<LedgerRecord[]> {
  return client.ledgerRecord.findMany({ where: { seq: { gte: from, lte: to } }, orderBy: { seq: "asc" } });
}

/**
 * A filtered view: one suggestion's or one chapter version's records (architecture § 4.3: a view is a filter, not a
 * chain); or, since unit 54d, a chapter's history — the records of its merged suggestions, which are public (35 D2)
 * and which the chapter's history page lists and exports (37 § 7). A chapter's history of no merged suggestion is empty.
 * Since unit 55b, an account's view (38 § 3): the records it is the actor of — a curator's, a reader's answers, its
 * exports — and the records about its own suggestions, whoever wrote them; for an organisation, its members'.
 */
export type LedgerView =
  | { readonly suggestionId: string }
  | { readonly chapterVersionId: string }
  | { readonly suggestionId: { readonly in: string[] } }
  | { readonly OR: Array<{ readonly actor: { readonly in: string[] } } | { readonly suggestionId: { readonly in: string[] } }> };

/** An account's view from its pseudonyms and its suggestions' ids (38 § 3; unit 55b). */
export function accountView(actors: ReadonlyArray<string>, suggestionIds: ReadonlyArray<string>): LedgerView {
  return { OR: [{ actor: { in: [...actors] } }, { suggestionId: { in: [...suggestionIds] } }] };
}

export function view(filter: LedgerView, client: LedgerClient = getPrisma()): Promise<LedgerRecord[]> {
  return client.ledgerRecord.findMany({ where: filter, orderBy: { seq: "asc" } });
}

/**
 * The record of a suggestion's workflow step, if one was written (feature-specs/28 § 4.4): an activity that appends
 * looks here first, by the step key its payload carries (`sha256(workflowId + ":" + step)`), and returns what it
 * finds, so a retried step writes its record once. A suggestion's records are few and `(suggestionId, seq)` is indexed.
 */
export function recordAt(suggestionId: string, kind: LedgerRecord["kind"], stepKey: string, client: LedgerClient = getPrisma()): Promise<LedgerRecord | null> {
  return client.ledgerRecord.findFirst({ where: { suggestionId, kind, payload: { path: ["stepKey"], equals: stepKey } }, orderBy: { seq: "asc" } });
}

/** The `RESEARCH` record of a run's step, if one was written (feature-specs/40 § 6.3): it names no suggestion, so it is found by its kind and step key alone. */
export function researchRecordAt(stepKey: string, client: LedgerClient = getPrisma()): Promise<LedgerRecord | null> {
  return client.ledgerRecord.findFirst({ where: { kind: "RESEARCH", suggestionId: null, payload: { path: ["stepKey"], equals: stepKey } }, orderBy: { seq: "asc" } });
}

/**
 * The `RESEARCH` records of some runs' steps, in chain order (feature-specs/48 § 11.10; unit 73): `researchRecordAt`'s
 * predicate for several step keys in one statement, for a research's export and whether its page offers one. A key no
 * record carries is simply absent.
 */
export function researchRecordsAt(stepKeys: ReadonlyArray<string>, client: LedgerClient = getPrisma()): Promise<LedgerRecord[]> {
  if (stepKeys.length === 0) return Promise.resolve([]);
  return client.ledgerRecord.findMany({ where: { kind: "RESEARCH", suggestionId: null, OR: stepKeys.map((stepKey) => ({ payload: { path: ["stepKey"], equals: stepKey } })) }, orderBy: { seq: "asc" } });
}

/** The step key of a conversation's `ERASED` record (feature-specs/45 § 3.7): one a conversation, whichever request writes it. */
export const erasedStepKeyOf = (conversationId: string): string => stepKeyOf(`conversation:${conversationId}`, "erased");

/** The `ERASED` record's step key for a person's research conversation (feature-specs/48 § 15): one a research, and never an Assistant conversation's. */
export const researchErasedStepKeyOf = (researchId: string): string => stepKeyOf(`research:${researchId}`, "erased");

/** The `ERASED` record of a conversation's deletion, if one was written (45 § 3.7; unit 62d): it names no suggestion, so it is found by its kind and step key alone, as a research record is. */
export function erasedRecordAt(stepKey: string, client: LedgerClient = getPrisma()): Promise<LedgerRecord | null> {
  return client.ledgerRecord.findFirst({ where: { kind: "ERASED", suggestionId: null, payload: { path: ["stepKey"], equals: stepKey } }, orderBy: { seq: "asc" } });
}

export interface RecordFilter {
  /** A view, or null for the whole chain. */
  readonly view: LedgerView | null;
  /** A `createdAt` window; null on either side means unbounded. */
  readonly from: Date | null;
  readonly to: Date | null;
  /** The kinds of record wanted (38 § 3; unit 55b); absent or null is every kind. */
  readonly kinds?: ReadonlyArray<LedgerKind> | null;
}

function whereOf(filter: RecordFilter) {
  return { ...(filter.view ?? {}), createdAt: { gte: filter.from ?? undefined, lte: filter.to ?? undefined }, ...(filter.kinds == null ? {} : { kind: { in: [...filter.kinds] } }) };
}

/** The records an export covers (feature-specs/14 § 5.2): a view or the whole chain, inside the window, in chain order. */
export function select(filter: RecordFilter, client: LedgerClient = getPrisma()): Promise<LedgerRecord[]> {
  return client.ledgerRecord.findMany({ where: whereOf(filter), orderBy: { seq: "asc" } });
}

/** How many records an export would cover (38 § 3: the form's estimate is a count query, never a guess). */
export function countSelected(filter: RecordFilter, client: LedgerClient = getPrisma()): Promise<number> {
  return client.ledgerRecord.count({ where: whereOf(filter) });
}

/** The `EXPORT` record an audit export appended, by the export's id in its payload (38 § 3; unit 55b): so a retried step writes its record once. */
export function auditExportRecord(exportId: string, client: LedgerClient = getPrisma()): Promise<LedgerRecord | null> {
  return client.ledgerRecord.findFirst({ where: { kind: "EXPORT", payload: { path: ["exportId"], equals: exportId } }, orderBy: { seq: "asc" } });
}

/** The records named by `seq`, in chain order: a conversation's own `ANSWER` records for its export (feature-specs/17 § 6). */
export function recordsAt(seqs: readonly number[], client: LedgerClient = getPrisma()): Promise<LedgerRecord[]> {
  return client.ledgerRecord.findMany({ where: { seq: { in: [...seqs] } }, orderBy: { seq: "asc" } });
}

/** The hash of each record named by `seq`: an export's predecessors. A `seq` the chain lacks is absent from the map. */
export async function hashesAt(seqs: readonly number[], client: LedgerClient = getPrisma()): Promise<ReadonlyMap<number, string>> {
  const rows = await client.ledgerRecord.findMany({ where: { seq: { in: [...seqs] } }, select: { seq: true, hash: true } });
  return new Map(rows.map((row) => [row.seq, row.hash]));
}

/** The link each record named by `seq` carries (its `prevHash`): the records after a view's own, which its check holds the view to. A `seq` the chain lacks is absent. */
export async function linksAt(seqs: readonly number[], client: LedgerClient = getPrisma()): Promise<ReadonlyMap<number, string>> {
  const rows = await client.ledgerRecord.findMany({ where: { seq: { in: [...seqs] } }, select: { seq: true, prevHash: true } });
  return new Map(rows.map((row) => [row.seq, row.prevHash]));
}

/** How many records a view holds: whether a suggestion has anything to export before the export key is asked for (35 § 5). */
export function countView(filter: LedgerView, client: LedgerClient = getPrisma()): Promise<number> {
  return client.ledgerRecord.count({ where: filter });
}

/** A row as the verifier and the export read it: the payload is the JSON the column holds, which the column cannot hold as anything else. */
export function toChainRecord(row: LedgerRecord): ChainRecord {
  return { seq: row.seq, kind: row.kind, actor: row.actor, suggestionId: row.suggestionId, chapterVersionId: row.chapterVersionId, payload: row.payload as JsonValue, createdAt: row.createdAt, prevHash: row.prevHash, hash: row.hash };
}

/** The neighbour rows as the database serves them; `toChainRecord` maps them to the verifier's `ChainNeighbours`. */
export interface NeighbourRows {
  readonly before: LedgerRecord | null;
  readonly after: LedgerRecord | null;
}

/** The record before `firstSeq` and the one after `lastSeq`: the two chain neighbours a filtered view is verified against. */
export async function neighbours(firstSeq: number, lastSeq: number, client: LedgerClient = getPrisma()): Promise<NeighbourRows> {
  const [before, after] = await Promise.all([
    client.ledgerRecord.findFirst({ where: { seq: { lt: firstSeq } }, orderBy: { seq: "desc" } }),
    client.ledgerRecord.findFirst({ where: { seq: { gt: lastSeq } }, orderBy: { seq: "asc" } }),
  ]);
  return { before, after };
}

/**
 * A filtered view and its chain check, made now (feature-specs/35 § 5; unit 52c): `verifyView` over the view's
 * records, each with its chain predecessor read back so the walk crosses the gaps where other records sit, the link
 * of the record after each one the view does not hold — so a record of the view rewritten with a fresh hash breaks at
 * its successor (the 52c review) — and the two neighbours outside the view. What a suggestion's record page and its
 * `GET …/record` both say; never cached. A record deleted from the view is not seen here; a walk of the range is.
 */
export async function checkedView(filter: LedgerView, client: LedgerClient = getPrisma()): Promise<{ readonly rows: ReadonlyArray<LedgerRecord>; readonly chain: ChainCheck }> {
  const rows = await view(filter, client);
  if (rows.length === 0) return { rows, chain: verifyView([], { before: null, after: null }) };
  /* Each record but the last whose next record is not the view's: the last's is the neighbour after it. */
  const gapAfter = (index: number): boolean => index < rows.length - 1 && rows[index + 1].seq !== rows[index].seq + 1;
  const [predecessors, links, around] = await Promise.all([
    hashesAt(rows.map((row) => row.seq - 1).filter((seq) => seq > 0), client),
    linksAt(rows.flatMap((row, index) => (gapAfter(index) ? [row.seq + 1] : [])), client),
    neighbours(rows[0].seq, rows[rows.length - 1].seq, client),
  ]);
  const records: ViewRecord[] = rows.map((row, index) => {
    const hash = predecessors.get(row.seq - 1);
    const link = links.get(row.seq + 1);
    return {
      ...toChainRecord(row),
      /* The genesis record has none; a predecessor the chain lacks is left unknown, and the check names the break. */
      ...(row.seq === 1 ? { predecessor: null } : hash === undefined ? {} : { predecessor: { seq: row.seq - 1, hash } }),
      /* A successor the chain lacks is null, and the check names the break. */
      ...(gapAfter(index) ? { successor: link === undefined ? null : { seq: row.seq + 1, prevHash: link } } : {}),
    };
  });
  return { rows, chain: verifyView(records, { before: around.before === null ? null : toChainRecord(around.before), after: around.after === null ? null : toChainRecord(around.after) }) };
}
