import { beforeEach, describe, expect, it, vi } from "vitest";

import { ANSWER_PAYLOAD, CONTRIBUTOR, EXPORT_PAYLOAD, IMPROVE_RECORDS } from "@/tests/fixtures/ledger";

import { GENESIS_PREV_HASH, recordHash } from "./hash";

/*
 * The append path against an in-memory chain (feature-specs/14 § 4.2, § 9.2):
 * the fake transaction runs the same statements the client would, in order,
 * and can return a stale head from FOR UPDATE or fail an insert with P2002.
 * The database itself is exercised in tests/integration/ledger.test.ts.
 */

interface Row {
  readonly seq: number;
  readonly kind: string;
  readonly actor: string;
  readonly suggestionId: string | null;
  readonly chapterVersionId: string | null;
  readonly payload: unknown;
  readonly createdAt: Date;
  readonly prevHash: string;
  readonly hash: string;
}

const fake = vi.hoisted(() => {
  const state = {
    rows: [] as Row[],
    /** What the next FOR UPDATE statements return (`null` = no row); afterwards, the true head. */
    lockedSeqs: [] as Array<number | null>,
    /** Errors the next inserts throw instead of writing. */
    createFailures: [] as unknown[],
    statements: [] as string[],
    setvals: [] as unknown[],
  };
  const headRow = (): Row | null => (state.rows.length === 0 ? null : state.rows[state.rows.length - 1]);
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const text = strings.join("?");
      state.statements.push(text);
      if (text.includes("setval")) {
        state.setvals.push(values[0]);
        return [{ setval: values[0] }];
      }
      const next = state.lockedSeqs.shift();
      const row = next === undefined ? headRow() : next === null ? null : (state.rows.find((r) => r.seq === next) ?? null);
      return row === null ? [] : [{ seq: row.seq, hash: row.hash }];
    },
    ledgerRecord: {
      findFirst: async (): Promise<{ seq: number; hash: string } | null> => {
        const row = headRow();
        return row === null ? null : { seq: row.seq, hash: row.hash };
      },
      create: async ({ data }: { data: Row }): Promise<Row> => {
        const failure = state.createFailures.shift();
        if (failure !== undefined) throw failure;
        state.rows.push(data);
        return data;
      },
    },
  };
  const client = { $transaction: (fn: (t: typeof tx) => Promise<unknown>): Promise<unknown> => fn(tx) };
  return { state, client };
});

vi.mock("@/lib/db/client", () => ({ getPrisma: () => fake.client }));

import { append, type AppendInput } from "./append";

const ACTOR = "00000000-0000-4000-8000-00000000028b";
const AT = new Date("2026-09-23T14:35:00.123Z");
const input: Extract<AppendInput, { kind: "ANSWER" }> = { kind: "ANSWER", actor: ACTOR, suggestionId: null, chapterVersionId: "cv-21", payload: ANSWER_PAYLOAD };
const exportInput: Extract<AppendInput, { kind: "EXPORT" }> = { kind: "EXPORT", actor: "service:export", suggestionId: null, chapterVersionId: null, payload: EXPORT_PAYLOAD };
const forUpdates = (): number => fake.state.statements.filter((s) => s.includes("FOR UPDATE")).length;

beforeEach(() => {
  fake.state.rows.length = 0;
  fake.state.lockedSeqs.length = 0;
  fake.state.createFailures.length = 0;
  fake.state.statements.length = 0;
  fake.state.setvals.length = 0;
});

describe("append", () => {
  /* feature-specs/29 § 5, § 10.5: the eight kinds of Improve and the researcher, placeholders until unit 46c; a withdrawal's the ninth since unit 63c (45 § 5.3). */
  it("admits each of the nine kinds of Improve and the researcher, one chain through them", async () => {
    for (const record of IMPROVE_RECORDS) await append(record, { now: () => AT });
    expect(fake.state.rows.map((row) => row.kind)).toEqual(["SUBMITTED", "GRADED", "SENSORS", "DECIDED", "CURATOR", "MERGED", "RESEARCH", "ENDORSED", "RETRACTED"]);
    expect(fake.state.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const [index, row] of fake.state.rows.entries()) {
      const given = IMPROVE_RECORDS[index];
      expect(row).toMatchObject({ actor: given.actor, suggestionId: given.suggestionId, chapterVersionId: given.chapterVersionId });
      expect(row.payload).toBe(given.payload);
      expect(row.prevHash).toBe(index === 0 ? GENESIS_PREV_HASH : fake.state.rows[index - 1].hash);
    }
  });

  it("refuses each of the eight with one key its schema does not name, before any statement runs", async () => {
    for (const record of IMPROVE_RECORDS) {
      const withAKey = { ...record, payload: { ...record.payload, note: "the curator's own words" } } as unknown as AppendInput;
      await expect(append(withAKey), record.kind).rejects.toMatchObject({ code: "LEDGER_PAYLOAD", message: expect.stringContaining("nothing was written") });
    }
    expect(fake.state.statements).toEqual([]);
    expect(fake.state.rows).toEqual([]);
  });

  it("refuses a record whose own columns are not its kind's, before any statement runs", async () => {
    const [submitted, , , decided, curator, , research] = IMPROVE_RECORDS;
    const forged: ReadonlyArray<AppendInput> = [
      { ...decided, actor: CONTRIBUTOR },
      { ...curator, actor: "service:adjudicator" },
      { ...submitted, suggestionId: null },
      { ...submitted, chapterVersionId: null },
      { ...research, suggestionId: "S-15-0377" },
    ];
    for (const record of forged) {
      await expect(append(record), `${record.kind} by ${record.actor}`).rejects.toMatchObject({ code: "LEDGER_COLUMNS", message: expect.stringContaining("nothing was written") });
    }
    expect(fake.state.statements).toEqual([]);
    expect(fake.state.rows).toEqual([]);
  });

  it("refuses a payload its kind's schema rejects before the transaction opens, naming the field", async () => {
    const withText = { ...ANSWER_PAYLOAD, answerSha256: "The cached-input price is US$ 0.25 per M tokens." };
    await expect(append({ ...input, payload: withText })).rejects.toMatchObject({ code: "LEDGER_PAYLOAD", message: expect.stringContaining("payload.answerSha256") });
    await expect(append({ ...exportInput, payload: { ...EXPORT_PAYLOAD, scope: { ...EXPORT_PAYLOAD.scope, kind: "all" } } })).rejects.toMatchObject({ code: "LEDGER_PAYLOAD", message: expect.stringContaining("payload.scope.id") });
    expect(fake.state.statements).toEqual([]);
    expect(fake.state.rows).toEqual([]);
  });

  it("stores the payload exactly as given once the schema accepts it", async () => {
    const record = await append(exportInput, { now: () => AT });
    expect(record.payload).toEqual(EXPORT_PAYLOAD);
    expect(record.hash).toBe(recordHash({ seq: 1, kind: "EXPORT", actor: "service:export", suggestionId: null, chapterVersionId: null, payload: EXPORT_PAYLOAD, createdAt: AT, prevHash: GENESIS_PREV_HASH }));
  });

  it("writes the first record against the genesis hash with seq 1 and advances the sequence", async () => {
    const record = await append(input, { now: () => AT });
    expect(record.seq).toBe(1);
    expect(record.prevHash).toBe(GENESIS_PREV_HASH);
    expect(record.createdAt).toEqual(AT);
    expect(record.kind).toBe("ANSWER");
    expect(record.hash).toBe(recordHash({ seq: 1, kind: "ANSWER", actor: ACTOR, suggestionId: null, chapterVersionId: "cv-21", payload: input.payload, createdAt: AT, prevHash: GENESIS_PREV_HASH }));
    expect(fake.state.statements[0]).toContain("FOR UPDATE");
    expect(fake.state.statements[1]).toContain("setval(pg_get_serial_sequence('\"LedgerRecord\"', 'seq'), ?)");
    expect(fake.state.setvals).toEqual([1]);
  });

  it("links the next record to the head and stamps it with the clock when none is given", async () => {
    const first = await append(input, { now: () => AT });
    const before = Date.now();
    const second = await append({ ...exportInput, suggestionId: "S-21-0001" });
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(second.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(second.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(second.hash).toBe(recordHash({ ...second, payload: EXPORT_PAYLOAD }));
    expect(second.hash).not.toBe(first.hash);
    expect(fake.state.setvals).toEqual([1, 2]);
  });

  it("takes the lock again when FOR UPDATE returned a head older than a fresh read sees", async () => {
    await append(input, { now: () => AT });
    await append(input, { now: () => AT });
    fake.state.statements.length = 0;
    /* A waiter's FOR UPDATE returns the row its snapshot chose: nothing, then seq 1, while the head is 2. */
    fake.state.lockedSeqs.push(null, 1);
    const record = await append(input, { now: () => AT });
    expect(record.seq).toBe(3);
    expect(record.prevHash).toBe(fake.state.rows[1].hash);
    expect(forUpdates()).toBe(3);
  });

  it("retries once when the primary key was taken and links to the new head", async () => {
    await append(input, { now: () => AT });
    fake.state.createFailures.push({ code: "P2002" });
    const record = await append(input, { now: () => AT });
    expect(record.seq).toBe(2);
    expect(forUpdates()).toBe(3);
    expect(fake.state.rows).toHaveLength(2);
  });

  it("surfaces LEDGER_CONFLICT after the second primary-key failure", async () => {
    fake.state.createFailures.push({ code: "P2002" }, { code: "P2002" });
    await expect(append(input, { now: () => AT })).rejects.toMatchObject({ code: "LEDGER_CONFLICT" });
    expect(fake.state.rows).toEqual([]);
    expect(fake.state.setvals).toEqual([]);
  });

  it("rethrows any other failure without a retry, on the first and on the second attempt", async () => {
    const other = { code: "P2000", message: "value too long" };
    fake.state.createFailures.push(other);
    await expect(append(input, { now: () => AT })).rejects.toBe(other);
    expect(forUpdates()).toBe(1);

    fake.state.statements.length = 0;
    fake.state.createFailures.push({ code: "P2002" }, other);
    await expect(append(input, { now: () => AT })).rejects.toBe(other);
    expect(forUpdates()).toBe(2);

    for (const thrown of ["connection reset", null, { message: "no code" }]) {
      fake.state.createFailures.push(thrown);
      await expect(append(input, { now: () => AT })).rejects.toBe(thrown);
    }
    expect(fake.state.rows).toEqual([]);
  });
});
