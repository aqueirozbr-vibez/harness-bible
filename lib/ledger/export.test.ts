import { generateKeyPairSync, sign } from "node:crypto";
import { Writable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LedgerRecord } from "@/lib/db/generated/client";
import type { RecordFilter } from "@/lib/db/ledger";
import type { ExportTrailer } from "@/lib/schemas/ledger";

import { canonicalize, type JsonValue } from "./canonical";
import { GENESIS_PREV_HASH, recordHash } from "./hash";

/*
 * The JSONL export and its re-verification (feature-specs/14 § 5.2, § 9.4)
 * against an in-memory chain behind the two queries the export reads: an
 * `all` export of 30 records round-trips, a `chapter` export carries
 * predecessors and verifies without the other chapter's payloads, a flipped
 * byte fails, a trailer signed by another key fails. The two line shapes
 * are lib/schemas/ledger.ts's, tested field by field beside the schemas;
 * here a line either shape refuses is named by its number. The script's
 * EXPORT record and its refusals are checked by running the script in
 * tests/integration/ledger.test.ts.
 */

const ACTOR = "00000000-0000-4000-8000-00000000028c";
const CV21 = "cv-21";
const CV28 = "cv-28";
const S1 = "S-21-0001";

const fake = vi.hoisted(() => {
  const state = { chain: [] as LedgerRecord[] };
  return { state };
});

vi.mock("@/lib/db/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/ledger")>();
  return {
    ...actual,
    select: async (filter: RecordFilter): Promise<LedgerRecord[]> =>
      fake.state.chain.filter((r) => {
        const view = filter.view;
        const inView =
          view === null
            ? true
            : "chapterVersionId" in view
              ? r.chapterVersionId === view.chapterVersionId
              : "OR" in view
                ? view.OR.some((alternative) => ("actor" in alternative ? alternative.actor.in.includes(r.actor) : alternative.suggestionId.in.includes(r.suggestionId ?? "")))
                : typeof view.suggestionId === "string"
                  ? r.suggestionId === view.suggestionId
                  : view.suggestionId.in.includes(r.suggestionId ?? "");
        const afterFrom = filter.from === null || r.createdAt >= filter.from;
        const beforeTo = filter.to === null || r.createdAt <= filter.to;
        const ofKind = filter.kinds == null || filter.kinds.includes(r.kind);
        return inView && afterFrom && beforeTo && ofKind;
      }),
    hashesAt: async (seqs: readonly number[]): Promise<ReadonlyMap<number, string>> => new Map(fake.state.chain.filter((r) => seqs.includes(r.seq)).map((r) => [r.seq, r.hash])),
    recordsAt: async (seqs: readonly number[]): Promise<LedgerRecord[]> => fake.state.chain.filter((r) => seqs.includes(r.seq)),
  };
});

import { exportJsonl, exportKeyFromPem, verifyExport, type ExportScope } from "./export";

const createdAtOf = (seq: number): Date => new Date(Date.UTC(2026, 8, 23, 14, 35, 0, seq));

/** Every fifth record belongs to suggestion S-21-0001 and every third to chapter 21, unless `ofSuggestion` says otherwise; `createdAt` climbs one millisecond per `seq` unless `stampedAt` says otherwise. */
function makeChain(length: number, ofSuggestion: (seq: number) => boolean = (seq) => seq % 5 === 0, stampedAt: (seq: number) => Date = createdAtOf, shapeOf: (seq: number) => { readonly kind?: LedgerRecord["kind"]; readonly actor?: string } = () => ({})): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let seq = 1; seq <= length; seq += 1) {
    const shape = shapeOf(seq);
    const fields = {
      seq,
      kind: shape.kind ?? ("ANSWER" as const),
      actor: shape.actor ?? ACTOR,
      suggestionId: ofSuggestion(seq) ? S1 : null,
      chapterVersionId: seq % 3 === 0 ? CV21 : CV28,
      payload: { messageId: `m-${seq}`, claims: { total: seq, substituted: 0 } },
      createdAt: stampedAt(seq),
      prevHash,
    };
    const hash = recordHash(fields);
    records.push({ ...fields, hash });
    prevHash = hash;
  }
  return records;
}

/** A sink that keeps what was written and completes each write on the next turn, so a small high-water mark makes `write` return false and the drain path runs. */
class Collector extends Writable {
  readonly chunks: string[] = [];

  constructor(highWaterMark?: number) {
    super({ highWaterMark, decodeStrings: false });
  }

  _write(chunk: unknown, _encoding: string, callback: () => void): void {
    this.chunks.push(String(chunk));
    setImmediate(callback);
  }

  /** Ends the sink and returns every line once the buffered writes have completed. */
  lines(): Promise<string[]> {
    return new Promise((resolve) => this.end(() => resolve(this.chunks.join("").split("\n"))));
  }
}

const KEY = generateKeyPairSync("ed25519");
const OTHER_KEY = generateKeyPairSync("ed25519");
const pem = (key: typeof KEY.privateKey): string => key.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = (key: typeof KEY.publicKey): string => key.export({ type: "spki", format: "pem" }).toString();
const PUBLIC = publicPem(KEY.publicKey);
const NOW = new Date("2026-09-23T16:00:00.000Z");
const deps = { key: exportKeyFromPem(pem(KEY.privateKey)), now: () => NOW };

async function exported(scope: ExportScope, highWaterMark?: number): Promise<{ lines: string[]; trailer: ExportTrailer }> {
  const sink = new Collector(highWaterMark);
  const trailer = await exportJsonl(scope, sink, deps);
  return { lines: await sink.lines(), trailer };
}

type Line = { [name: string]: JsonValue };
const parse = (line: string): Line => JSON.parse(line) as Line;
const reline = (line: Line): string => canonicalize(line);
const at = (seq: number): LedgerRecord => fake.state.chain[seq - 1];

beforeEach(() => {
  fake.state.chain = makeChain(30);
});

describe("exportKeyFromPem", () => {
  it("refuses without a key, with a PEM that is not a key, and with a key that is not Ed25519", () => {
    expect(() => exportKeyFromPem(undefined)).toThrow(expect.objectContaining({ code: "LEDGER_KEY_MISSING" }));
    expect(() => exportKeyFromPem("-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n")).toThrow(expect.objectContaining({ code: "LEDGER_KEY_INVALID" }));
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(() => exportKeyFromPem(pem(rsa.privateKey))).toThrow(expect.objectContaining({ code: "LEDGER_KEY_INVALID", message: expect.stringContaining("rsa") }));
    expect(exportKeyFromPem(pem(KEY.privateKey)).asymmetricKeyType).toBe("ed25519");
  });
});

describe("exportJsonl", () => {
  it("writes an all export of 30 records as canonical lines and a signed trailer, which verifies", async () => {
    const { lines, trailer } = await exported({ kind: "all" });
    expect(lines).toHaveLength(32);
    expect(lines[31]).toBe("");
    const first = parse(lines[0]);
    expect(Object.keys(first)).toEqual(["actor", "chapterVersionId", "createdAt", "hash", "kind", "payload", "prevHash", "seq", "suggestionId"]);
    expect(first).toMatchObject({ seq: 1, prevHash: GENESIS_PREV_HASH, hash: at(1).hash, createdAt: "2026-09-23T14:35:00.001Z", suggestionId: null, chapterVersionId: CV28 });
    expect(trailer).toMatchObject({ headHash: at(30).hash, fromSeq: 1, toSeq: 30, records: 30, scope: { kind: "all", id: null, from: null, to: null }, exportedAt: "2026-09-23T16:00:00.000Z" });
    expect(trailer.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(parse(lines[30])).toEqual({ trailer });
    expect(verifyExport(lines, PUBLIC)).toEqual({ ok: true, lines: 30, malformedLine: null, trailer, signature: "valid", chain: { ok: true, records: 30, from: 1, to: 30, firstBreak: null, headHash: at(30).hash }, matchesTrailer: true });
  });

  it("waits for the sink to drain when a write is buffered", async () => {
    const { lines } = await exported({ kind: "all" }, 1);
    expect(lines).toHaveLength(32);
    expect(verifyExport(lines, PUBLIC).ok).toBe(true);
  });

  /* The chapter scope since unit 54d: the chapter's merged suggestions' records (37 § 7), named by the chapter's number. */
  it("carries predecessors on a chapter export — its merged suggestions' records — which verifies without the other records", async () => {
    const { lines, trailer } = await exported({ kind: "chapter", id: "21", suggestionIds: [S1] });
    expect(lines).toHaveLength(8);
    const fifth = parse(lines[0]);
    expect(fifth).toMatchObject({ seq: 5, predecessor: { seq: 4, hash: at(4).hash } });
    expect(lines.slice(0, 6).map((l) => parse(l).seq)).toEqual([5, 10, 15, 20, 25, 30]);
    expect(lines.join("\n")).not.toContain("m-2\"");
    expect(trailer).toMatchObject({ headHash: at(30).hash, fromSeq: 5, toSeq: 30, records: 6, scope: { kind: "chapter", id: "21", from: null, to: null } });
    expect(verifyExport(lines, PUBLIC)).toMatchObject({ ok: true, lines: 6, chain: { ok: true, from: 5, to: 30, records: 6 }, matchesTrailer: true });
    /* a chapter of no merged suggestion matches nothing */
    await expect(exportJsonl({ kind: "chapter", id: "28", suggestionIds: [] }, new Collector(), deps)).rejects.toMatchObject({ code: "LEDGER_EXPORT_EMPTY" });
  });

  it("carries predecessors on a suggestion export and on an all export that starts after the genesis", async () => {
    const suggestion = await exported({ kind: "suggestion", id: S1 });
    expect(suggestion.lines.slice(0, 6).map((l) => parse(l).seq)).toEqual([5, 10, 15, 20, 25, 30]);
    expect(parse(suggestion.lines[0]).predecessor).toEqual({ seq: 4, hash: at(4).hash });
    expect(verifyExport(suggestion.lines, PUBLIC).ok).toBe(true);

    const from = at(11).createdAt;
    const to = at(20).createdAt;
    const window = await exported({ kind: "all", from, to });
    expect(window.trailer).toMatchObject({ fromSeq: 11, toSeq: 20, records: 10, scope: { kind: "all", id: null, from: from.toISOString(), to: to.toISOString() } });
    expect(parse(window.lines[0]).predecessor).toEqual({ seq: 10, hash: at(10).hash });
    expect(verifyExport(window.lines, PUBLIC).ok).toBe(true);
  });

  it("carries predecessors on an all window that skips a record whose writer's clock ran behind", async () => {
    fake.state.chain = makeChain(10, undefined, (seq) => new Date(createdAtOf(seq).getTime() - (seq === 5 ? 2000 : 0)));
    const { lines, trailer } = await exported({ kind: "all", from: at(1).createdAt });
    expect(trailer).toMatchObject({ fromSeq: 1, toSeq: 10, records: 9 });
    expect(lines.slice(0, 9).map((l) => parse(l).seq)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10]);
    expect(parse(lines[0])).toMatchObject({ seq: 1, predecessor: null });
    expect(parse(lines[4])).toMatchObject({ seq: 6, predecessor: { seq: 5, hash: at(5).hash } });
    expect(verifyExport(lines, PUBLIC)).toMatchObject({ ok: true, chain: { ok: true, records: 9, from: 1, to: 10, firstBreak: null }, matchesTrailer: true });
  });

  it("marks the genesis record's predecessor null when a filtered scope includes seq 1", async () => {
    fake.state.chain = makeChain(30, (seq) => seq === 1 || seq % 5 === 0);
    const { lines } = await exported({ kind: "suggestion", id: S1 });
    expect(parse(lines[0])).toMatchObject({ seq: 1, predecessor: null });
    expect(verifyExport(lines, PUBLIC)).toMatchObject({ ok: true, chain: { from: 1, to: 30, records: 7 } });
  });

  /* The scope of feature-specs/17 § 6, written in unit 31d: a conversation's own records, named by `seq`, with no window. */
  it("writes a conversation's own records by their seqs, each with its predecessor and with no window, which verifies", async () => {
    const { lines, trailer } = await exported({ kind: "messages", id: "conversation-of-the-suite", seqs: [7, 4, 19] });
    expect(lines).toHaveLength(5);
    expect(lines.slice(0, 3).map((l) => parse(l).seq)).toEqual([4, 7, 19]);
    expect(parse(lines[0]).predecessor).toEqual({ seq: 3, hash: at(3).hash });
    expect(trailer).toMatchObject({ headHash: at(19).hash, fromSeq: 4, toSeq: 19, records: 3, scope: { kind: "messages", id: "conversation-of-the-suite", from: null, to: null } });
    expect(verifyExport(lines, PUBLIC)).toMatchObject({ ok: true, lines: 3, chain: { ok: true, from: 4, to: 19, records: 3 }, matchesTrailer: true });
    await expect(exportJsonl({ kind: "messages", id: "conversation-of-the-suite", seqs: [] }, new Collector(), deps)).rejects.toMatchObject({ code: "LEDGER_EXPORT_EMPTY" });
  });

  /* A person's research's own RESEARCH records (feature-specs/48 § 11.10; unit 73): named by `seq` as a conversation's, the trailer naming the research. */
  it("writes a research's own records by their seqs, the trailer's scope the research's, which verifies", async () => {
    const { lines, trailer } = await exported({ kind: "research", id: "research-of-the-suite", seqs: [12, 5] });
    expect(lines.slice(0, 2).map((l) => parse(l).seq)).toEqual([5, 12]);
    expect(parse(lines[1]).predecessor).toEqual({ seq: 11, hash: at(11).hash });
    expect(trailer).toMatchObject({ fromSeq: 5, toSeq: 12, records: 2, scope: { kind: "research", id: "research-of-the-suite", from: null, to: null } });
    expect(verifyExport(lines, PUBLIC)).toMatchObject({ ok: true, lines: 2, matchesTrailer: true });
  });

  it("exports an account's view — what its pseudonym wrote and what is about its suggestions — narrowed to kinds, naming them in the trailer (38 § 3)", async () => {
    /* The actor of records 3 and 8 is the account, as a curator; every fifth record is about its suggestion S1, whoever wrote it; the narrowed pack wants its CURATOR records only. */
    fake.state.chain = makeChain(20, undefined, undefined, (seq) => (seq === 3 || seq === 8 ? { actor: "user:00000000-0000-4000-8000-000000000055", kind: "CURATOR" } : {}));
    const whole = await exported({ kind: "account", id: "00000000-0000-4000-8000-000000000055", actors: ["user:00000000-0000-4000-8000-000000000055"], suggestionIds: [S1] });
    expect(whole.lines.filter((l) => l !== "" && !l.includes('"trailer"')).map((l) => parse(l).seq)).toEqual([3, 5, 8, 10, 15, 20]);
    expect(whole.trailer.scope).toEqual({ kind: "account", id: "00000000-0000-4000-8000-000000000055", from: null, to: null });
    expect(verifyExport(whole.lines, PUBLIC).ok).toBe(true);
    const narrowed = await exported({ kind: "account", id: "00000000-0000-4000-8000-000000000055", actors: ["user:00000000-0000-4000-8000-000000000055"], suggestionIds: [S1], kinds: ["CURATOR"] });
    expect(narrowed.lines.filter((l) => l !== "" && !l.includes('"trailer"')).map((l) => parse(l).seq)).toEqual([3, 8]);
    expect(narrowed.trailer.scope).toEqual({ kind: "account", id: "00000000-0000-4000-8000-000000000055", from: null, to: null, kinds: ["CURATOR"] });
    expect(verifyExport(narrowed.lines, PUBLIC)).toMatchObject({ ok: true, lines: 2, matchesTrailer: true });
  });

  it("refuses a scope that matches nothing", async () => {
    await expect(exportJsonl({ kind: "account", id: "00000000-0000-4000-8000-000000000055", actors: [], suggestionIds: [] }, new Collector(), deps)).rejects.toMatchObject({ code: "LEDGER_EXPORT_EMPTY" });
    await expect(exportJsonl({ kind: "chapter", id: "99", suggestionIds: ["S-99-0001"] }, new Collector(), deps)).rejects.toMatchObject({ code: "LEDGER_EXPORT_EMPTY" });
    await expect(exportJsonl({ kind: "all", from: new Date("2027-01-01T00:00:00.000Z") }, new Collector(), deps)).rejects.toMatchObject({ code: "LEDGER_EXPORT_EMPTY" });
  });

  it("refuses to write a predecessor the chain lacks", async () => {
    fake.state.chain = fake.state.chain.filter((r) => r.seq !== 4);
    await expect(exportJsonl({ kind: "chapter", id: "21", suggestionIds: [S1] }, new Collector(), deps)).rejects.toMatchObject({ code: "LEDGER_PREDECESSOR_MISSING", message: expect.stringContaining("record 4 is missing") });
  });
});

describe("verifyExport", () => {
  it("fails a line whose payload byte was flipped, naming the seq and both hashes", async () => {
    const { lines } = await exported({ kind: "all" });
    const flipped = [...lines];
    flipped[16] = lines[16].replace('"substituted":0', '"substituted":1');
    const check = verifyExport(flipped, PUBLIC);
    expect(check.ok).toBe(false);
    expect(check.signature).toBe("valid");
    expect(check.chain?.firstBreak).toMatchObject({ seq: 17, field: "hash", found: at(17).hash });
    expect(check.matchesTrailer).toBe(false);
  });

  it("fails a line that is not its own canonical form, or not JSON, naming the line", async () => {
    const { lines } = await exported({ kind: "all" });
    const spaced = [...lines];
    spaced[4] = lines[4].replace('"seq":5', '"seq": 5');
    expect(verifyExport(spaced, PUBLIC)).toMatchObject({ ok: false, malformedLine: 5, chain: null, signature: "valid", lines: 30 });
    const broken = [...lines];
    broken[0] = lines[0].slice(1);
    expect(verifyExport(broken, PUBLIC)).toMatchObject({ ok: false, malformedLine: 1 });
    const array = [...lines];
    array[0] = "[]";
    expect(verifyExport(array, PUBLIC)).toMatchObject({ ok: false, malformedLine: 1 });
    const infinite = [...lines];
    infinite[2] = lines[2].replace('"seq":3', '"seq":1e400');
    expect(verifyExport(infinite, PUBLIC)).toMatchObject({ ok: false, malformedLine: 3, chain: null });
  });

  it("refuses a public key that is not an Ed25519 PEM", async () => {
    const { lines } = await exported({ kind: "all" });
    expect(() => verifyExport(lines, "-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----\n")).toThrow(expect.objectContaining({ code: "LEDGER_KEY_INVALID" }));
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(() => verifyExport(lines, publicPem(rsa.publicKey))).toThrow(expect.objectContaining({ code: "LEDGER_KEY_INVALID", message: expect.stringContaining("rsa") }));
  });

  it("fails a trailer signed by another key, and one whose signed fields were edited", async () => {
    const { lines } = await exported({ kind: "all" });
    const sink = new Collector();
    const other = await exportJsonl({ kind: "all" }, sink, { key: exportKeyFromPem(pem(OTHER_KEY.privateKey)), now: () => NOW });
    const otherLines = await sink.lines();
    expect(verifyExport(otherLines, PUBLIC)).toMatchObject({ ok: false, signature: "invalid", chain: { ok: true }, matchesTrailer: true, trailer: other });
    expect(verifyExport(otherLines, publicPem(OTHER_KEY.publicKey)).ok).toBe(true);
    const edited = [...lines];
    edited[30] = reline({ trailer: { ...parse(lines[30]).trailer as Line, records: 29 } });
    expect(verifyExport(edited, PUBLIC)).toMatchObject({ ok: false, signature: "invalid", matchesTrailer: false });
  });

  it("fails when the records do not match the trailer's span or count, or the chain is broken", async () => {
    const { lines } = await exported({ kind: "chapter", id: "21", suggestionIds: [S1] });
    const missing = [...lines.slice(0, 2), ...lines.slice(3)];
    expect(verifyExport(missing, PUBLIC)).toMatchObject({ ok: false, signature: "valid", chain: { ok: true, records: 5 }, matchesTrailer: false });
    const shortened = [...lines.slice(0, 5), lines[6], lines[7]];
    expect(verifyExport(shortened, PUBLIC)).toMatchObject({ ok: false, chain: { ok: true, to: 25 }, matchesTrailer: false });
    const shifted = [...lines.slice(1)];
    expect(verifyExport(shifted, PUBLIC)).toMatchObject({ ok: false, chain: { ok: true, from: 10 }, matchesTrailer: false });
    const whole = await exported({ kind: "all" });
    const relinked = [...whole.lines];
    relinked[10] = reline({ ...parse(whole.lines[10]), prevHash: at(9).hash });
    expect(verifyExport(relinked, PUBLIC)).toMatchObject({ ok: false, chain: { ok: false, firstBreak: { seq: 11, field: "hash" } } });
  });

  it("reports a missing or malformed trailer", async () => {
    const { lines } = await exported({ kind: "all" });
    expect(verifyExport([], PUBLIC)).toEqual({ ok: false, lines: 0, malformedLine: null, trailer: null, signature: "missing", chain: null, matchesTrailer: false });
    expect(verifyExport([""], PUBLIC)).toMatchObject({ ok: false, lines: 0, malformedLine: null, signature: "missing" });
    expect(verifyExport(lines.slice(0, 30), PUBLIC)).toMatchObject({ ok: false, lines: 30, malformedLine: 30, trailer: null, signature: "missing" });
    const trailer = parse(lines[30]).trailer as Line;
    const scope = trailer.scope as Line;
    const cases: Line[] = [
      { trailer, extra: 1 },
      { trailer: "x" },
      { trailer: { ...trailer, scope: { ...scope, kind: "everything" } } },
      { trailer: { ...trailer, signature: "zz" } },
    ];
    for (const malformed of cases) {
      expect(verifyExport([...lines.slice(0, 30), reline(malformed), ""], PUBLIC), reline(malformed)).toMatchObject({ ok: false, malformedLine: 31, trailer: null, signature: "missing" });
    }
    expect(verifyExport([...lines.slice(0, 30), lines[30].replace('"trailer":', '"trailer": ')], PUBLIC)).toMatchObject({ ok: false, malformedLine: 31, trailer: null, signature: "missing" });
    const other = reline({ trailer: { ...trailer, scope: { ...scope, kind: "suggestion", id: "S-21-0001", from: "2026-09-23T00:00:00.000Z", to: "2026-09-24T00:00:00.000Z" } } });
    expect(verifyExport([...lines.slice(0, 30), other], PUBLIC)).toMatchObject({ signature: "invalid", trailer: { scope: { kind: "suggestion", id: "S-21-0001" } } });
  });

  it("reports a signed trailer whose scope the EXPORT payload's schema refuses as malformed, not as signed", async () => {
    const { lines } = await exported({ kind: "all" });
    const divergent: Line = { ...(parse(lines[30]).trailer as Line), scope: { kind: "all", id: "x", from: "yesterday", to: null } };
    delete divergent.signature;
    const signature = sign(null, Buffer.from(canonicalize(divergent), "utf8"), KEY.privateKey).toString("hex");
    const check = verifyExport([...lines.slice(0, 30), reline({ trailer: { ...divergent, signature } }), ""], PUBLIC);
    expect(check).toMatchObject({ ok: false, malformedLine: 31, trailer: null, signature: "missing", chain: null });
  });

  it("reports a record line of the wrong shape", async () => {
    const { lines } = await exported({ kind: "chapter", id: "21", suggestionIds: [S1] });
    const line = parse(lines[1]);
    const bare = parse(lines[1]);
    delete bare.predecessor;
    const cases: Line[] = [
      { ...bare, extra: 1 },
      { ...line, seq: "10" },
      { ...line, createdAt: "2026-09-23T14:35:00Z" },
      { ...line, predecessor: { seq: 9 } },
    ];
    for (const malformed of cases) {
      expect(verifyExport([lines[0], reline(malformed), ...lines.slice(2)], PUBLIC), reline(malformed)).toMatchObject({ ok: false, malformedLine: 2, chain: null });
    }
    expect(verifyExport([lines[0], reline({ ...line, suggestionId: S1, chapterVersionId: null }), ...lines.slice(2)], PUBLIC)).toMatchObject({ malformedLine: null, chain: { firstBreak: { seq: 10, field: "hash" } } });
  });
});
