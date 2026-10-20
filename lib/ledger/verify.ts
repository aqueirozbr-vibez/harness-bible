import { GENESIS_PREV_HASH, recordHash, type HashableRecord } from "./hash";

/*
 * Chain verification (architecture § 4.3; feature-specs/14 § 5.1): every hash
 * is recomputed from the record's own fields, every `prevHash` is compared
 * with its predecessor's hash, `seq` is checked for continuity, and the last
 * hash against the head a caller expects. The walk stops at the first break
 * and names it. A filtered view (a suggestion's or a chapter's records) is
 * verified against its two chain neighbours and, across the gaps where other
 * records sit, against each record's predecessor as the export carries it
 * and, where a check reads them back, the link the record after it carries.
 * A record deleted from a view leaves no trace in the view itself: a walk of
 * the whole range finds it.
 */

/** A stored record: the hashed fields plus the hash the chain recorded for it. */
export interface ChainRecord extends HashableRecord {
  readonly hash: string;
}

/** A record's chain predecessor as recorded: the `seq` before it and that record's hash. A type alias, not an interface, so an export line carrying it is a `JsonValue`. */
export type Predecessor = {
  readonly seq: number;
  readonly hash: string;
};

/** The record after one in the chain as recorded: its `seq` and the link it carries. A type alias, as `Predecessor` is. */
export type Successor = {
  readonly seq: number;
  readonly prevHash: string;
};

/**
 * A record of a filtered view. `predecessor` is carried by an export line; `null` marks the genesis; absent means
 * unknown, as a database row is. `successor` is the record after it where the view does not hold that one, read back
 * from the chain (`checkedView`): a record rewritten with a fresh hash still breaks at the link the next record
 * carries (the 52c review). `null` marks a record the chain lacks; absent means unchecked, as on an export line. The
 * view's last record has none: the neighbour after it answers for it.
 */
export interface ViewRecord extends ChainRecord {
  readonly predecessor?: Predecessor | null;
  readonly successor?: Successor | null;
}

export interface ChainNeighbours {
  readonly before: ChainRecord | null;
  readonly after: ChainRecord | null;
}

/** What broke: the record's own hash, its link, its `seq`, the predecessor it needed, or the head the caller expected. */
export type BreakField = "hash" | "prevHash" | "seq" | "predecessor" | "head";

export interface ChainBreak {
  readonly seq: number;
  readonly field: BreakField;
  readonly expected: string;
  readonly found: string;
}

export interface ChainCheck {
  readonly ok: boolean;
  readonly records: number;
  readonly from: number;
  readonly to: number;
  readonly firstBreak: ChainBreak | null;
  readonly headHash: string | null;
}

export interface VerifyChainOptions {
  /** The hash the first record must link to: the genesis hash for a full chain (the default), the neighbour's for a range. */
  readonly prevOfFirst?: string;
  /** The head hash the last record must equal. */
  readonly expectHead?: string;
}

interface WalkOptions {
  /** A trusted hash for the first record's link; `null` resolves it from the record's own predecessor or the genesis. */
  readonly prevOfFirst: string | null;
  readonly gaps: boolean;
  readonly expectHead: string | null;
}

/** A contiguous run of records, `from` to `to`, linked from `prevOfFirst` and ending at `expectHead` when given. */
export function verifyChain(records: readonly ChainRecord[], opts: VerifyChainOptions = {}): ChainCheck {
  return walk(records, { prevOfFirst: opts.prevOfFirst ?? GENESIS_PREV_HASH, gaps: false, expectHead: opts.expectHead ?? null });
}

/**
 * A filtered view in chain order with its two neighbours: the record before
 * the first and the one after the last, by `seq`. Gaps inside the view are
 * allowed and crossed through each record's carried predecessor; the
 * neighbours are re-hashed too, since the check runs on them as well.
 */
export function verifyView(records: readonly ViewRecord[], neighbours: ChainNeighbours): ChainCheck {
  const { before, after } = neighbours;
  if (before !== null) {
    const ownHash = recordHash(before);
    if (ownHash !== before.hash) return broken(records, { seq: before.seq, field: "hash", expected: ownHash, found: before.hash });
    if (records.length > 0 && before.seq !== records[0].seq - 1) return broken(records, { seq: records[0].seq, field: "seq", expected: String(before.seq + 1), found: String(records[0].seq) });
  }
  if (after !== null) {
    const ownHash = recordHash(after);
    if (ownHash !== after.hash) return broken(records, { seq: after.seq, field: "hash", expected: ownHash, found: after.hash });
    if (records.length > 0 && after.seq !== records[records.length - 1].seq + 1) {
      return broken(records, { seq: after.seq, field: "seq", expected: String(records[records.length - 1].seq + 1), found: String(after.seq) });
    }
  }
  return walk(records, { prevOfFirst: before === null ? null : before.hash, gaps: true, expectHead: after === null ? null : after.prevHash });
}

function walk(records: readonly ViewRecord[], opts: WalkOptions): ChainCheck {
  if (records.length === 0) {
    return { ok: opts.expectHead === null, records: 0, from: 0, to: 0, firstBreak: opts.expectHead === null ? null : { seq: 0, field: "head", expected: opts.expectHead, found: "" }, headHash: null };
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const ownHash = recordHash(record);
    if (ownHash !== record.hash) return broken(records, { seq: record.seq, field: "hash", expected: ownHash, found: record.hash });
    const expected = expectedPrev(records, index, opts);
    if (typeof expected !== "string") return broken(records, expected);
    if (record.prevHash !== expected) return broken(records, { seq: record.seq, field: "prevHash", expected, found: record.prevHash });
    const following = linkAfter(records, index, opts);
    if (following !== null) return broken(records, following);
  }
  const last = records[records.length - 1];
  if (opts.expectHead !== null && last.hash !== opts.expectHead) return broken(records, { seq: last.seq, field: "head", expected: opts.expectHead, found: last.hash });
  return { ok: true, records: records.length, from: records[0].seq, to: last.seq, firstBreak: null, headHash: last.hash };
}

/** The hash `records[index].prevHash` must equal, or the break that stops it being known. */
function expectedPrev(records: readonly ViewRecord[], index: number, opts: WalkOptions): string | ChainBreak {
  const record = records[index];
  if (index > 0) {
    const previous = records[index - 1];
    if (record.seq === previous.seq + 1) return previous.hash;
    if (!opts.gaps || record.seq <= previous.seq) return { seq: record.seq, field: "seq", expected: String(previous.seq + 1), found: String(record.seq) };
    return carried(record);
  }
  return opts.prevOfFirst ?? carried(record);
}

/** Inside a view, where the record after this one is not the view's: that record's link, when given, must be this record's hash. */
function linkAfter(records: readonly ViewRecord[], index: number, opts: WalkOptions): ChainBreak | null {
  const record = records[index];
  const next = records[index + 1];
  if (!opts.gaps || record.successor === undefined || next === undefined || next.seq === record.seq + 1) return null;
  const successor = record.successor;
  if (successor === null) return { seq: record.seq + 1, field: "seq", expected: String(record.seq + 1), found: "" };
  if (successor.seq !== record.seq + 1) return { seq: successor.seq, field: "seq", expected: String(record.seq + 1), found: String(successor.seq) };
  if (successor.prevHash !== record.hash) return { seq: successor.seq, field: "prevHash", expected: record.hash, found: successor.prevHash };
  return null;
}

/** The link a record carries itself: its predecessor's hash, or the genesis for `seq` 1. */
function carried(record: ViewRecord): string | ChainBreak {
  const predecessor = record.predecessor ?? null;
  if (predecessor === null) {
    return record.seq === 1 ? GENESIS_PREV_HASH : { seq: record.seq, field: "predecessor", expected: String(record.seq - 1), found: "" };
  }
  if (predecessor.seq !== record.seq - 1) return { seq: record.seq, field: "predecessor", expected: String(record.seq - 1), found: String(predecessor.seq) };
  return predecessor.hash;
}

function broken(records: readonly ChainRecord[], firstBreak: ChainBreak): ChainCheck {
  return { ok: false, records: records.length, from: records.length === 0 ? 0 : records[0].seq, to: records.length === 0 ? 0 : records[records.length - 1].seq, firstBreak, headHash: null };
}
