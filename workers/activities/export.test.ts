import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AuditExportRow } from "@/lib/db/auditExport";
import type { AppendInput } from "@/lib/ledger/append";
import type { ExportTrailer } from "@/lib/schemas/ledger";

import type { AuditPackWritten } from "../workflows/activities";
import { exportActivities, type ExportActivityDeps } from "./export";

/*
 * ExportWorkflow's activities (feature-specs/38 § 3; unit 55b), the rows, the ledger and the store doubled: the pack is
 * written, read back and verified before anything says READY; a store that gives back something else, or a pack that
 * does not verify, is a failure the engine retries; the record is appended once, by the export's id in its payload;
 * a row already READY makes both steps answer from the row.
 */

const ID = "55555555-5555-4555-8555-555555555555";
const ME = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-10T12:00:00.000Z");
const FILE = Buffer.from('{"seq":3}\n{"seq":5}\n{"trailer":{}}\n');
const TRAILER: ExportTrailer = { headHash: "a".repeat(64), fromSeq: 3, toSeq: 5, records: 2, scope: { kind: "account", id: ME, from: "2026-09-01T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z", kinds: ["DECIDED", "MERGED"] }, exportedAt: NOW.toISOString(), signature: "e".repeat(128) };
const SHA = createHash("sha256").update(FILE).digest("hex");

function row(over: Partial<AuditExportRow> = {}): AuditExportRow {
  return { id: ID, requestedById: ME, request: { scope: { kind: "account", id: ME }, from: "2026-09-01T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z", kinds: ["adjudications", "merges"] }, fromSeq: null, toSeq: null, records: 2, headHash: null, storageKey: null, state: "PREPARING", createdAt: NOW, readyAt: null, ...over };
}

function harness(over: Partial<ExportActivityDeps> = {}) {
  const store = new Map<string, Buffer>();
  const appended: AppendInput[] = [];
  const ready: Array<{ exportId: string; pack: AuditPackWritten }> = [];
  let recorded: { seq: number } | null = null;
  const deps: ExportActivityDeps = {
    readRow: async () => row(),
    scopeOf: async () => ({ kind: "account", id: ME, actors: [`user:${ME}`], suggestionIds: ["S-21-0001"], kinds: ["DECIDED", "MERGED"], from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-10-10T00:00:00.000Z") }),
    exportFile: async () => ({ file: FILE, trailer: TRAILER }),
    store: async (key, file) => {
      store.set(key, file);
    },
    readBack: async (key) => store.get(key) ?? null,
    verify: () => true,
    recordOf: async () => recorded,
    appendRecord: async (input) => {
      appended.push(input);
      recorded = { seq: 41 };
    },
    ready: async (exportId, pack) => {
      ready.push({ exportId, pack });
    },
    now: () => NOW,
    ...over,
  };
  return { activities: exportActivities(deps), store, appended, ready, record: () => (recorded = { seq: 40 }) };
}

const PACK: AuditPackWritten = { fromSeq: 3, toSeq: 5, records: 2, headHash: "a".repeat(64), fileSha256: SHA, storageKey: `audit/${ID}.jsonl` };

describe("writeAuditPack", () => {
  it("writes the pack under audit/<id>.jsonl, reads it back, verifies it, and answers the trailer's span and the file's hash", async () => {
    const { activities, store } = harness();
    expect(await activities.writeAuditPack(ID)).toEqual(PACK);
    expect(store.get(`audit/${ID}.jsonl`)).toEqual(FILE);
  });

  it("fails — for the engine to try again — when the store gives back something else, or the pack does not verify; and does not retry a row that is gone or selects nothing", async () => {
    const other = harness({ readBack: async () => Buffer.from("not the pack") });
    await expect(other.activities.writeAuditPack(ID)).rejects.toMatchObject({ code: "EXPORT_STORE_MISMATCH" });
    const unverified = harness({ verify: () => false });
    await expect(unverified.activities.writeAuditPack(ID)).rejects.toMatchObject({ code: "EXPORT_UNVERIFIED" });
    const gone = harness({ readRow: async () => null });
    await expect(gone.activities.writeAuditPack(ID)).rejects.toMatchObject({ type: "EXPORT_ROW_MISSING", nonRetryable: true });
  });

  it("answers from a row already READY, writing nothing", async () => {
    const { activities, store } = harness({ readRow: async () => row({ state: "READY", fromSeq: 3, toSeq: 5, headHash: "a".repeat(64), storageKey: `audit/${ID}.jsonl`, readyAt: NOW }) });
    expect(await activities.writeAuditPack(ID)).toMatchObject({ fromSeq: 3, toSeq: 5, records: 2, headHash: "a".repeat(64), storageKey: `audit/${ID}.jsonl` });
    expect(store.size).toBe(0);
  });
});

describe("recordAuditPack", () => {
  it("appends the EXPORT record under the requester's pseudonym, naming the export, the kinds the file holds and its hash, then makes the row READY", async () => {
    const { activities, appended, ready } = harness();
    await activities.recordAuditPack(ID, PACK);
    expect(appended).toEqual([{ kind: "EXPORT", actor: `user:${ME}`, suggestionId: null, chapterVersionId: null, payload: { scope: { kind: "account", id: ME, from: "2026-09-01T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z", kinds: ["DECIDED", "MERGED", "RETRACTED"] }, fromSeq: 3, toSeq: 5, records: 2, headHash: "a".repeat(64), fileSha256: SHA, exportId: ID } }]);
    expect(ready).toEqual([{ exportId: ID, pack: PACK }]);
  });

  it("appends nothing twice: a record that names the export already is found, and the row is made READY all the same", async () => {
    const { activities, appended, ready, record } = harness();
    record();
    await activities.recordAuditPack(ID, PACK);
    expect(appended).toEqual([]);
    expect(ready).toHaveLength(1);
  });

  it("does nothing for a row already READY, and does not retry a row that is gone", async () => {
    const done = harness({ readRow: async () => row({ state: "READY" }) });
    await done.activities.recordAuditPack(ID, PACK);
    expect(done.appended).toEqual([]);
    expect(done.ready).toEqual([]);
    const gone = harness({ readRow: async () => null });
    await expect(gone.activities.recordAuditPack(ID, PACK)).rejects.toMatchObject({ type: "EXPORT_ROW_MISSING" });
  });
});
