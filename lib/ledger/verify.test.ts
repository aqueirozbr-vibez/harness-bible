import { describe, expect, it } from "vitest";

import { GENESIS_PREV_HASH, recordHash, sha256Hex } from "./hash";
import { verifyChain, verifyView, type ChainRecord, type ViewRecord } from "./verify";

/*
 * Chain verification (feature-specs/14 § 5.1, § 9.3): a chain of 30 verifies;
 * an altered payload or createdAt breaks at that seq naming both hashes; a
 * filtered view of every third record verifies with its neighbours and
 * predecessors; an expectHead mismatch is named.
 */

const ACTOR = "00000000-0000-4000-8000-00000000028c";
const CV21 = "cv-21";
const CV28 = "cv-28";

/** A chain of `length` records from the genesis: every third record belongs to chapter 21, the rest to chapter 28. */
function makeChain(length: number): ChainRecord[] {
  const records: ChainRecord[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let seq = 1; seq <= length; seq += 1) {
    const fields = {
      seq,
      kind: "ANSWER",
      actor: ACTOR,
      suggestionId: null,
      chapterVersionId: seq % 3 === 0 ? CV21 : CV28,
      payload: { messageId: `m-${seq}`, claims: { total: seq, substituted: 0 } },
      createdAt: new Date(Date.UTC(2026, 8, 23, 14, 35, 0, seq)),
      prevHash,
    };
    const hash = recordHash(fields);
    records.push({ ...fields, hash });
    prevHash = hash;
  }
  return records;
}

const chain = makeChain(30);
const at = (seq: number): ChainRecord => chain[seq - 1];
const replace = (records: readonly ChainRecord[], seq: number, patch: Partial<ChainRecord>): ChainRecord[] => records.map((r) => (r.seq === seq ? { ...r, ...patch } : r));

/** Chapter 21's view (seq 3, 6, …, 30) with each record's predecessor carried, as an export line would. */
function view21(): ViewRecord[] {
  return chain.filter((r) => r.chapterVersionId === CV21).map((r) => ({ ...r, predecessor: { seq: r.seq - 1, hash: at(r.seq - 1).hash } }));
}

describe("verifyChain", () => {
  it("verifies a chain of 30 from the genesis and reports its span and head", () => {
    expect(verifyChain(chain)).toEqual({ ok: true, records: 30, from: 1, to: 30, firstBreak: null, headHash: at(30).hash });
  });

  it("verifies a range against the hash before it and the head after it", () => {
    const range = chain.slice(9, 20);
    expect(verifyChain(range, { prevOfFirst: at(9).hash, expectHead: at(20).hash })).toMatchObject({ ok: true, records: 11, from: 10, to: 20, headHash: at(20).hash });
    expect(verifyChain(range).firstBreak).toEqual({ seq: 10, field: "prevHash", expected: GENESIS_PREV_HASH, found: at(9).hash });
  });

  it("names the record whose payload was altered, with the hash it should have and the one it carries", () => {
    const altered = replace(chain, 17, { payload: { messageId: "m-17", claims: { total: 17, substituted: 1 } } });
    const check = verifyChain(altered);
    expect(check.ok).toBe(false);
    expect(check.headHash).toBeNull();
    expect(check.firstBreak).toEqual({ seq: 17, field: "hash", expected: recordHash(altered[16]), found: at(17).hash });
    expect(check).toMatchObject({ records: 30, from: 1, to: 30 });
  });

  it("breaks when createdAt moves by one millisecond", () => {
    const altered = replace(chain, 4, { createdAt: new Date(at(4).createdAt.getTime() + 1) });
    expect(verifyChain(altered).firstBreak).toMatchObject({ seq: 4, field: "hash", found: at(4).hash });
  });

  it("breaks when a record re-hashed after a change no longer links to its predecessor", () => {
    const fields = { ...at(12), prevHash: sha256Hex("elsewhere") };
    const altered = replace(chain, 12, { ...fields, hash: recordHash(fields) });
    expect(verifyChain(altered).firstBreak).toEqual({ seq: 12, field: "prevHash", expected: at(11).hash, found: fields.prevHash });
  });

  it("breaks on a gap, a duplicate and a step back in seq", () => {
    expect(verifyChain([...chain.slice(0, 5), ...chain.slice(6)]).firstBreak).toEqual({ seq: 7, field: "seq", expected: "6", found: "7" });
    expect(verifyChain([at(1), at(2), at(2)]).firstBreak).toEqual({ seq: 2, field: "seq", expected: "3", found: "2" });
    expect(verifyChain([at(1), at(2), at(1)]).firstBreak).toEqual({ seq: 1, field: "seq", expected: "3", found: "1" });
  });

  it("names an expectHead mismatch on the last record", () => {
    const check = verifyChain(chain, { expectHead: at(29).hash });
    expect(check.firstBreak).toEqual({ seq: 30, field: "head", expected: at(29).hash, found: at(30).hash });
    expect(check.ok).toBe(false);
  });

  it("accepts an empty chain unless a head was expected", () => {
    expect(verifyChain([])).toEqual({ ok: true, records: 0, from: 0, to: 0, firstBreak: null, headHash: null });
    expect(verifyChain([], { expectHead: at(1).hash })).toEqual({ ok: false, records: 0, from: 0, to: 0, firstBreak: { seq: 0, field: "head", expected: at(1).hash, found: "" }, headHash: null });
  });
});

describe("verifyView", () => {
  const records = view21();
  const neighbours = { before: at(2), after: null };

  it("verifies every third record with its neighbours and carried predecessors", () => {
    expect(verifyView(records, neighbours)).toEqual({ ok: true, records: 10, from: 3, to: 30, firstBreak: null, headHash: at(30).hash });
    const inner = records.slice(1, 9);
    expect(verifyView(inner, { before: at(5), after: at(28) })).toMatchObject({ ok: true, records: 8, from: 6, to: 27, headHash: at(27).hash });
  });

  it("verifies database rows, which carry no predecessor, when the view is contiguous", () => {
    expect(verifyView(chain.slice(4, 9), { before: at(4), after: at(10) })).toMatchObject({ ok: true, from: 5, to: 9 });
    expect(verifyView(chain.slice(0, 3), { before: null, after: at(4) })).toMatchObject({ ok: true, from: 1, to: 3 });
  });

  it("needs a predecessor across a gap, and one at the right seq", () => {
    const bare = at(15);
    expect(verifyView([...records.slice(0, 4), bare, ...records.slice(5)], neighbours).firstBreak).toEqual({ seq: 15, field: "predecessor", expected: "14", found: "" });
    expect(verifyView([...records.slice(0, 4), { ...bare, predecessor: null }, ...records.slice(5)], neighbours).firstBreak).toEqual({ seq: 15, field: "predecessor", expected: "14", found: "" });
    const wrongSeq = { ...records[4], predecessor: { seq: 13, hash: at(13).hash } };
    expect(verifyView([...records.slice(0, 4), wrongSeq, ...records.slice(5)], neighbours).firstBreak).toEqual({ seq: 15, field: "predecessor", expected: "14", found: "13" });
    const wrongHash = { ...records[4], predecessor: { seq: 14, hash: at(13).hash } };
    expect(verifyView([...records.slice(0, 4), wrongHash, ...records.slice(5)], neighbours).firstBreak).toEqual({ seq: 15, field: "prevHash", expected: at(13).hash, found: at(14).hash });
  });

  it("resolves the first record from its own predecessor, or the genesis at seq 1, when there is no neighbour before it", () => {
    expect(verifyView(records, { before: null, after: null })).toMatchObject({ ok: true, from: 3 });
    expect(verifyView([at(1), records[0]], { before: null, after: null })).toMatchObject({ ok: true, from: 1, to: 3 });
    expect(verifyView([{ ...records[0], predecessor: null }], { before: null, after: null }).firstBreak).toEqual({ seq: 3, field: "predecessor", expected: "2", found: "" });
  });

  it("checks the neighbours' own hashes and their adjacency", () => {
    expect(verifyView(records, { before: { ...at(2), hash: at(1).hash }, after: null }).firstBreak).toEqual({ seq: 2, field: "hash", expected: at(2).hash, found: at(1).hash });
    expect(verifyView(records, { before: at(1), after: null }).firstBreak).toEqual({ seq: 3, field: "seq", expected: "2", found: "3" });
    expect(verifyView(records.slice(0, 9), { before: at(2), after: { ...at(28), payload: {} } }).firstBreak).toMatchObject({ seq: 28, field: "hash", found: at(28).hash });
    expect(verifyView(records.slice(0, 9), { before: at(2), after: at(29) }).firstBreak).toEqual({ seq: 29, field: "seq", expected: "28", found: "29" });
    expect(verifyView(records.slice(0, 9), { before: at(2), after: at(28) })).toMatchObject({ ok: true, headHash: at(27).hash });
  });

  it("checks the last record against the record after it", () => {
    const forged = { ...at(28), prevHash: at(26).hash };
    const after = { ...forged, hash: recordHash(forged) };
    expect(verifyView(records.slice(0, 9), { before: at(2), after }).firstBreak).toEqual({ seq: 27, field: "head", expected: at(26).hash, found: at(27).hash });
  });

  it("holds a record to the link the next record carries, where the view does not hold that one (the 52c review)", () => {
    const linked = (list: readonly ViewRecord[]): ViewRecord[] => list.map((r, i) => (i < list.length - 1 && list[i + 1].seq !== r.seq + 1 ? { ...r, successor: { seq: r.seq + 1, prevHash: at(r.seq + 1).prevHash } } : r));
    expect(verifyView(linked(records), neighbours)).toEqual({ ok: true, records: 10, from: 3, to: 30, firstBreak: null, headHash: at(30).hash });
    /* Record 9 rewritten with a fresh hash, its own link kept: its predecessor still matches, and only the record after it, which no longer links to it, gives it away. */
    const fields = { ...at(9), payload: { messageId: "m-9", claims: { total: 9, substituted: 1 } } };
    const rewritten: ViewRecord = { ...records[2], ...fields, hash: recordHash(fields) };
    const forged = [...records.slice(0, 2), rewritten, ...records.slice(3)];
    expect(verifyView(forged, neighbours).ok).toBe(true);
    expect(verifyView(linked(forged), neighbours).firstBreak).toEqual({ seq: 10, field: "prevHash", expected: rewritten.hash, found: at(9).hash });
    /* A successor the chain lacks, or one at another seq, is named. */
    expect(verifyView([{ ...records[0], successor: null }, ...records.slice(1)], neighbours).firstBreak).toEqual({ seq: 4, field: "seq", expected: "4", found: "" });
    expect(verifyView([{ ...records[0], successor: { seq: 5, prevHash: at(5).prevHash } }, ...records.slice(1)], neighbours).firstBreak).toEqual({ seq: 5, field: "seq", expected: "4", found: "5" });
    /* The last record's is the neighbour after it, and contiguous records need none. */
    expect(verifyView([...records.slice(0, 9), { ...records[9], successor: null }], neighbours)).toMatchObject({ ok: true });
    expect(verifyView(chain.slice(4, 9).map((r) => ({ ...r, successor: null })), { before: at(4), after: at(10) })).toMatchObject({ ok: true });
  });

  it("refuses a step back inside a view and reports an empty view", () => {
    expect(verifyView([records[1], records[0]], { before: null, after: null }).firstBreak).toEqual({ seq: 3, field: "seq", expected: "7", found: "3" });
    expect(verifyView([], { before: null, after: null })).toEqual({ ok: true, records: 0, from: 0, to: 0, firstBreak: null, headHash: null });
    expect(verifyView([], { before: at(2), after: at(4) })).toMatchObject({ ok: false, firstBreak: { seq: 0, field: "head", expected: at(3).hash, found: "" } });
    expect(verifyView([], { before: { ...at(2), hash: "0" }, after: null })).toMatchObject({ ok: false, from: 0, to: 0, firstBreak: { seq: 2, field: "hash" } });
  });
});
