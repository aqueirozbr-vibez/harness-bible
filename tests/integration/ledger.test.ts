import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPrisma } from "@/lib/db/client";
import { erasedRecordAt, erasedStepKeyOf, hashesAt, head, neighbours, range, recordAt, researchRecordAt, select, toChainRecord, view } from "@/lib/db/ledger";
import { env } from "@/lib/env";
import { append } from "@/lib/ledger/append";
import type { JsonValue } from "@/lib/ledger/canonical";
import { exportKeyFromPem, exportJsonl, verifyExport } from "@/lib/ledger/export";
import { GENESIS_PREV_HASH, recordHash } from "@/lib/ledger/hash";
import { verifyChain, verifyView } from "@/lib/ledger/verify";
import { suggestionIdOf } from "@/lib/schemas/ids";
import { ExportPayloadSchema } from "@/lib/schemas/ledger";
import { acquire, LEDGER_LOCK } from "@/tests/fixtures/exclusive";
import { ANSWER_PAYLOAD, IMPROVE_RECORDS, READER } from "@/tests/fixtures/ledger";

/*
 * The ledger against the release database (feature-specs/14 § 9.2): twenty
 * parallel appends, the append-only trigger and the client guard, the queries.
 * The chain is never emptied (nothing may delete a record), so the appends are
 * checked relative to the head found at the start: on a fresh database that is
 * seq 1…20. The records stay in the development ledger. The export script is
 * run as a child process (spec § 9.4: its EXPORT record names the file's hash;
 * it refuses without LEDGER_EXPORT_KEY), so the EXPORT record it appends stays
 * too.
 *
 * The suite holds `LEDGER_LOCK` (tests/fixtures/exclusive.ts) for its whole run: from unit 29 the assistant's
 * turns append to the same chain from another suite, and contiguous seq numbers are only contiguous to the one
 * suite appending.
 */
const hasDatabase = env.DATABASE_URL !== undefined;

const PARALLEL = 20;
const ACTOR = "00000000-0000-4000-8000-00000000028b";
const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const SCRIPT_TIMEOUT_MS = 60_000;

interface ScriptRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `scripts/ledger-export.ts` as `npm run ledger:export` does, with `env` as the child's whole environment. */
function runExportScript(args: readonly string[], env: NodeJS.ProcessEnv): Promise<ScriptRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, "scripts/ledger-export.ts", ...args], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!hasDatabase)("the ledger against the database", () => {
  let chapterVersionId = "";
  let firstSeq = 0;
  let release: () => void = () => undefined;

  beforeAll(async () => {
    /* The chain is one sequence and these cases assert contiguous seq numbers and their own record as the head, so
       the suite owns it while it runs; the assistant's turns (feature-specs/15 § 6.3) wait for the lock. */
    release = await acquire(LEDGER_LOCK);
    const version = await getPrisma().chapterVersion.findFirstOrThrow({ where: { chapterNumber: 21, release: { isCurrent: true } }, select: { id: true } });
    chapterVersionId = version.id;
    /* The lock is another suite's for as long as that suite runs, which is longer than a hook's ten seconds: the
       hook waits as the other holders of the lock do (found in unit 46a, when this suite came second and timed out). */
  }, 300_000);
  /* Released whatever the suite hits: a lock left behind would stall the next run (tests/fixtures/exclusive.ts). */
  afterAll(() => {
    release();
  });

  it("appends twenty records in parallel with contiguous seq and an unbroken chain", async () => {
    const before = await head();
    firstSeq = before === null ? 1 : before.seq + 1;
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, index) =>
        append({ kind: "ANSWER", actor: ACTOR, suggestionId: null, chapterVersionId, payload: { ...ANSWER_PAYLOAD, messageId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` } }),
      ),
    );
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: PARALLEL }, (_, i) => firstSeq + i));

    const rows = await range(firstSeq, firstSeq + PARALLEL - 1);
    expect(rows).toHaveLength(PARALLEL);
    let prev = before === null ? GENESIS_PREV_HASH : before.hash;
    for (const row of rows) {
      expect(row.prevHash).toBe(prev);
      expect(recordHash({ ...row, payload: row.payload as JsonValue })).toBe(row.hash);
      prev = row.hash;
    }
    expect(await head()).toEqual({ seq: firstSeq + PARALLEL - 1, hash: prev });

    const [sequence] = await getPrisma().$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM "LedgerRecord_seq_seq"`;
    expect(Number(sequence.last_value)).toBe(firstSeq + PARALLEL - 1);
  });

  it("refuses an update or a delete in the client before the database", async () => {
    const prisma = getPrisma();
    const where = { seq: firstSeq };
    await expect(prisma.ledgerRecord.update({ where, data: { actor: "x" } })).rejects.toMatchObject({ code: "LEDGER_APPEND_ONLY" });
    await expect(prisma.ledgerRecord.updateMany({ where, data: { actor: "x" } })).rejects.toMatchObject({ code: "LEDGER_APPEND_ONLY" });
    await expect(prisma.ledgerRecord.upsert({ where, create: { kind: "ANSWER", actor: ACTOR, payload: {}, prevHash: GENESIS_PREV_HASH, hash: GENESIS_PREV_HASH }, update: {} })).rejects.toMatchObject({ code: "LEDGER_APPEND_ONLY" });
    await expect(prisma.ledgerRecord.delete({ where })).rejects.toMatchObject({ code: "LEDGER_APPEND_ONLY" });
    await expect(prisma.ledgerRecord.deleteMany({ where })).rejects.toMatchObject({ code: "LEDGER_APPEND_ONLY" });
  });

  it("refuses an update or a delete at the database through the trigger", async () => {
    const prisma = getPrisma();
    await expect(prisma.$executeRaw`UPDATE "LedgerRecord" SET "actor" = 'x' WHERE "seq" = ${firstSeq}`).rejects.toThrow(/LEDGER_APPEND_ONLY/);
    await expect(prisma.$executeRaw`DELETE FROM "LedgerRecord" WHERE "seq" = ${firstSeq}`).rejects.toThrow(/LEDGER_APPEND_ONLY/);
    const row = await prisma.ledgerRecord.findUniqueOrThrow({ where: { seq: firstSeq } });
    expect(row.actor).toBe(ACTOR);
  });

  it("serves a chapter's view in chain order with its two neighbours", async () => {
    const records = await view({ chapterVersionId });
    const seqs = records.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(records.every((r) => r.chapterVersionId === chapterVersionId)).toBe(true);
    expect(seqs.filter((s) => s >= firstSeq && s < firstSeq + PARALLEL)).toHaveLength(PARALLEL);

    const around = await neighbours(firstSeq + 1, firstSeq + PARALLEL - 2);
    expect(around.before?.seq).toBe(firstSeq);
    expect(around.after?.seq).toBe(firstSeq + PARALLEL - 1);
    const edge = await neighbours(1, firstSeq + PARALLEL - 1);
    expect(edge.before).toBeNull();
    expect(edge.after).toBeNull();
  });

  it("verifies the chain it appended and the chapter's view against its neighbours", async () => {
    const rows = await range(firstSeq, firstSeq + PARALLEL - 1);
    const before = await neighbours(firstSeq, firstSeq + PARALLEL - 1);
    const check = verifyChain(rows.map(toChainRecord), { prevOfFirst: before.before?.hash ?? GENESIS_PREV_HASH });
    expect(check).toMatchObject({ ok: true, records: PARALLEL, from: firstSeq, to: firstSeq + PARALLEL - 1, firstBreak: null });

    const records = (await view({ chapterVersionId })).map(toChainRecord);
    const around = await neighbours(records[0].seq, records[records.length - 1].seq);
    const predecessors = await hashesAt(records.map((r) => r.seq - 1));
    const carried = records.map((r) => ({ ...r, predecessor: r.seq === 1 ? null : { seq: r.seq - 1, hash: predecessors.get(r.seq - 1) ?? "" } }));
    expect(verifyView(carried, { before: around.before === null ? null : toChainRecord(around.before), after: around.after === null ? null : toChainRecord(around.after) })).toMatchObject({ ok: true, records: records.length, firstBreak: null });
  });

  /* The chapter scope is a chapter's history since unit 54d (its merged suggestions' records), so the suite's own twenty, which are nobody's suggestion's, go out as the window they fill. */
  it("exports a window of the chain as signed JSONL that re-verifies with the public key alone", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const chunks: string[] = [];
    const sink = new Writable({
      decodeStrings: false,
      write(chunk: unknown, _encoding: string, callback: () => void): void {
        chunks.push(String(chunk));
        callback();
      },
    });
    const own = await range(firstSeq, firstSeq + PARALLEL - 1);
    const window = { from: own[0].createdAt, to: own[own.length - 1].createdAt };
    const trailer = await exportJsonl({ kind: "all", ...window }, sink, { key: exportKeyFromPem(privateKey.export({ type: "pkcs8", format: "pem" }).toString()), now: () => new Date() });
    await new Promise<void>((resolve) => sink.end(resolve));
    const lines = chunks.join("").split("\n");
    const selected = await select({ view: null, ...window });
    expect(trailer).toMatchObject({ records: selected.length, fromSeq: selected[0].seq, toSeq: selected[selected.length - 1].seq, headHash: selected[selected.length - 1].hash, scope: { kind: "all", id: null, from: window.from.toISOString(), to: window.to.toISOString() } });
    expect(lines).toHaveLength(selected.length + 2);
    expect(verifyExport(lines, publicKey.export({ type: "spki", format: "pem" }).toString())).toMatchObject({ ok: true, lines: selected.length, signature: "valid", matchesTrailer: true, chain: { ok: true, firstBreak: null } });
  });

  /*
   * feature-specs/29 § 5, § 10.5. The records stay in the development ledger like every other this suite appends,
   * so they are about nothing real: a suggestion of chapter 98, which no book has, with a serial taken from the
   * chain's own head so that each run's is its own, and a chapter version that does not exist.
   */
  it("appends a record of each of the nine kinds of Improve and the researcher (a withdrawal's since unit 63c), and the chain verifies through them", async () => {
    const before = await head();
    const first = before === null ? 1 : before.seq + 1;
    const suggestionId = suggestionIdOf(98, first);
    const versionOfNoChapter = "00000000-0000-4000-8000-0000000046c0";
    const records = IMPROVE_RECORDS.map((record) => (record.suggestionId === null ? record : { ...record, suggestionId, chapterVersionId: versionOfNoChapter }));

    const appended = [];
    for (const record of records) appended.push(await append(record));
    expect(appended.map((row) => row.seq)).toEqual(records.map((_, index) => first + index));
    expect(appended.map((row) => row.kind)).toEqual(["SUBMITTED", "GRADED", "SENSORS", "DECIDED", "CURATOR", "MERGED", "RESEARCH", "ENDORSED", "RETRACTED"]);
    for (const [index, row] of appended.entries()) {
      expect(row).toMatchObject({ actor: records[index].actor, suggestionId: records[index].suggestionId, chapterVersionId: records[index].chapterVersionId });
      expect(row.payload).toEqual(records[index].payload);
    }

    const rows = await range(first, first + records.length - 1);
    expect(verifyChain(rows.map(toChainRecord), { prevOfFirst: before?.hash ?? GENESIS_PREV_HASH })).toMatchObject({ ok: true, records: records.length, from: first, to: first + records.length - 1, firstBreak: null });

    /* The suggestion's own view: its eight records in the order they were written. The research record is in nobody's. */
    const ofTheSuggestion = await view({ suggestionId });
    expect(ofTheSuggestion.map((row) => row.kind)).toEqual(["SUBMITTED", "GRADED", "SENSORS", "DECIDED", "CURATOR", "MERGED", "ENDORSED", "RETRACTED"]);
    expect(ofTheSuggestion.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 7, 8].map((offset) => first + offset));

    /* A step's record by its key (unit 50a): the one written, and none for another key, another kind or another suggestion. */
    const submitted = records[0] as { readonly payload: { readonly stepKey: string } };
    expect((await recordAt(suggestionId, "SUBMITTED", submitted.payload.stepKey))?.seq).toBe(first);
    expect(await recordAt(suggestionId, "SUBMITTED", "0".repeat(64))).toBeNull();
    expect(await recordAt(suggestionId, "GRADED", submitted.payload.stepKey)).toBeNull();
    expect(await recordAt(suggestionIdOf(98, first + 1_000_000), "SUBMITTED", submitted.payload.stepKey)).toBeNull();

    /* A key nobody named, and a record signed by the wrong hand: refused, and the head has not moved. */
    const head8 = await head();
    await expect(append({ ...records[3], payload: { ...records[3].payload, note: "the adjudicator's own words" } } as never)).rejects.toMatchObject({ code: "LEDGER_PAYLOAD" });
    await expect(append({ ...records[3], actor: records[0].actor } as never)).rejects.toMatchObject({ code: "LEDGER_COLUMNS" });
    expect(await head()).toEqual(head8);
  });

  it("appends a reader's deletion of a conversation, a person's record about nothing, found by its step key alone (feature-specs/45 § 3.7; unit 62d)", async () => {
    /* a conversation nobody has: the record stays in the development ledger, as this suite's others do */
    const conversationId = randomUUID();
    const stepKey = erasedStepKeyOf(conversationId);
    expect(stepKey).toBe(erasedStepKeyOf(conversationId));
    expect(stepKey).not.toBe(erasedStepKeyOf(randomUUID()));
    const erased = await append({ kind: "ERASED", actor: READER, suggestionId: null, chapterVersionId: null, payload: { stepKey, scope: { kind: "conversation", id: conversationId } } });
    expect(erased).toMatchObject({ kind: "ERASED", actor: READER, suggestionId: null, chapterVersionId: null, payload: { stepKey, scope: { kind: "conversation", id: conversationId } } });
    expect((await erasedRecordAt(stepKey))?.seq).toBe(erased.seq);
    expect(await erasedRecordAt(erasedStepKeyOf(randomUUID()))).toBeNull();
    expect(await researchRecordAt(stepKey)).toBeNull();
    /* refused when it names a suggestion, or carries a word of the conversation */
    const before = await head();
    await expect(append({ kind: "ERASED", actor: READER, suggestionId: suggestionIdOf(98, erased.seq), chapterVersionId: null, payload: { stepKey, scope: { kind: "conversation", id: conversationId } } })).rejects.toMatchObject({ code: "LEDGER_COLUMNS" });
    await expect(append({ kind: "ERASED", actor: READER, suggestionId: null, chapterVersionId: null, payload: { stepKey, scope: { kind: "conversation", id: conversationId }, title: "Refunds" } } as never)).rejects.toMatchObject({ code: "LEDGER_PAYLOAD" });
    expect(await head()).toEqual(before);
  });

  describe("the export script", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-ledger-export-"));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("writes a window's signed export and appends the EXPORT record whose fileSha256 matches the file", async () => {
      const out = join(dir, "window.jsonl");
      /* the suite's own twenty, by the window they fill: the chapter scope is a chapter's merged suggestions' records since unit 54d, and the development database merges none */
      const own = await range(firstSeq, firstSeq + PARALLEL - 1);
      const run = await runExportScript(["--scope", "all", "--from", own[0].createdAt.toISOString(), "--to", own[own.length - 1].createdAt.toISOString(), "--out", out], { ...process.env, LEDGER_EXPORT_KEY: privatePem });
      expect(run.stderr.split("\n").filter((line) => line !== "" && !line.startsWith("◇ injected env"))).toEqual([]);
      expect(run.code).toBe(0);
      const file = readFileSync(out);
      const check = verifyExport(file.toString("utf8").split("\n"), publicPem);
      expect(check).toMatchObject({ ok: true, signature: "valid", matchesTrailer: true, chain: { ok: true, firstBreak: null } });
      const trailer = check.trailer;
      expect(trailer).not.toBeNull();

      const top = await head();
      expect(top).not.toBeNull();
      const seq = top?.seq ?? 0;
      const [record] = await range(seq, seq);
      expect(record).toMatchObject({ kind: "EXPORT", actor: "service:export", suggestionId: null, chapterVersionId: null });
      expect(seq).toBeGreaterThan(trailer?.toSeq ?? Number.POSITIVE_INFINITY);
      expect(ExportPayloadSchema.parse(record.payload)).toEqual({
        scope: trailer?.scope,
        fromSeq: trailer?.fromSeq,
        toSeq: trailer?.toSeq,
        records: trailer?.records,
        headHash: trailer?.headHash,
        fileSha256: createHash("sha256").update(file).digest("hex"),
      });
      expect(run.stdout).toContain(`EXPORT record seq ${seq}`);
    }, SCRIPT_TIMEOUT_MS);

    it("refuses without LEDGER_EXPORT_KEY, writes no file and appends nothing", async () => {
      const before = await head();
      const out = join(dir, "refused.jsonl");
      // The script loads .env itself, which would put the development key back: point dotenv at a file that does not exist. The refusal comes before any query, so the database is withheld too.
      const childEnv: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: join(dir, "absent.env") };
      delete childEnv.LEDGER_EXPORT_KEY;
      delete childEnv.DATABASE_URL;
      const run = await runExportScript(["--scope", "all", "--out", out], childEnv);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("AppError: LEDGER_EXPORT_KEY is not set");
      expect(run.stderr).not.toContain("\n    at ");
      expect(existsSync(out)).toBe(false);
      expect(await head()).toEqual(before);
    }, SCRIPT_TIMEOUT_MS);

    it("refuses a scope that matches no record, writes no file and appends nothing", async () => {
      const before = await head();
      const out = join(dir, "empty-scope.jsonl");
      /* chapter 98 is no book's, so nothing of it is merged: the chapter scope holds no record */
      const run = await runExportScript(["--scope", "chapter", "--id", "98", "--out", out], { ...process.env, LEDGER_EXPORT_KEY: privatePem });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("AppError: the scope matches no record; nothing to sign.");
      expect(run.stderr).not.toContain("\n    at ");
      expect(existsSync(out)).toBe(false);
      expect(await head()).toEqual(before);
    }, SCRIPT_TIMEOUT_MS);

    it("reports a file it cannot open as one line and appends nothing", async () => {
      const before = await head();
      const out = join(dir, "missing", "all.jsonl");
      const run = await runExportScript(["--scope", "all", "--out", out], { ...process.env, LEDGER_EXPORT_KEY: privatePem });
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/^Error: ENOENT: no such file or directory, open /m);
      expect(run.stderr).not.toContain("\n    at ");
      expect(existsSync(out)).toBe(false);
      expect(await head()).toEqual(before);
    }, SCRIPT_TIMEOUT_MS);
  });
});
