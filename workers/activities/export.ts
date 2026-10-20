import { createHash, createPublicKey } from "node:crypto";
import { Writable } from "node:stream";

import { ApplicationFailure } from "@temporalio/activity";

import { exportScopeOf, readAuditExport, resolveAuditScope, writeAuditExportReady, type AuditExportRow } from "@/lib/db/auditExport";
import { auditExportRecord } from "@/lib/db/ledger";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { append, type AppendInput } from "@/lib/ledger/append";
import { exportJsonl, exportKeyFromPem, verifyExport, type ExportKey, type ExportScope } from "@/lib/ledger/export";
import { auditObjectKey, ledgerKindsOf } from "@/lib/schemas/audit";
import type { ExportTrailer } from "@/lib/schemas/ledger";
import { getObject, putObject } from "@/lib/storage";

import type { AuditPackWritten, ExportActivities } from "../workflows/activities";

/*
 * ExportWorkflow's activities (feature-specs/38 § 3; unit 55b). `writeAuditPack` selects the scope's records with
 * their predecessors, writes the signed JSONL to the store, reads the object back and verifies it with the public half
 * of the export key — so `READY` means a pack that verifies, and the panel's `chain verified` is the row's state.
 * `recordAuditPack` appends the `EXPORT` record under the requester's pseudonym, once: the record names the export in
 * its payload, and a retry finds it there. A row the requester asked for and that is already `READY` makes both answer
 * from the row, so nothing is written twice. The store being unavailable, or the key, is a failure the engine retries.
 */

export interface ExportActivityDeps {
  readonly readRow: (exportId: string) => Promise<AuditExportRow | null>;
  readonly scopeOf: (row: AuditExportRow) => Promise<ExportScope>;
  readonly exportFile: (scope: ExportScope, now: Date) => Promise<{ readonly file: Buffer; readonly trailer: ExportTrailer }>;
  readonly store: (key: string, file: Buffer) => Promise<void>;
  readonly readBack: (key: string) => Promise<Buffer | null>;
  readonly verify: (lines: ReadonlyArray<string>) => boolean;
  readonly recordOf: (exportId: string) => Promise<{ readonly seq: number } | null>;
  readonly appendRecord: (input: AppendInput) => Promise<unknown>;
  readonly ready: (exportId: string, pack: AuditPackWritten, now: Date) => Promise<void>;
  readonly now: () => Date;
}

/** The export key, read once per process; absent or invalid is a failure the engine retries, the operator's variable named in the log. */
let key: ExportKey | null = null;
function exportKey(): ExportKey {
  key ??= exportKeyFromPem(env.LEDGER_EXPORT_KEY);
  return key;
}

async function exportFile(scope: ExportScope, now: Date): Promise<{ readonly file: Buffer; readonly trailer: ExportTrailer }> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    highWaterMark: 1 << 20,
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  const trailer = await exportJsonl(scope, sink, { key: exportKey(), now: () => now });
  return { file: Buffer.concat(chunks), trailer };
}

async function readBack(objectKey: string): Promise<Buffer | null> {
  const object = await getObject(objectKey as Parameters<typeof getObject>[0]);
  if (object === null) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of object.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

export function defaultExportDeps(): ExportActivityDeps {
  return {
    readRow: readAuditExport,
    scopeOf: async (row) => exportScopeOf(row.request, await resolveAuditScope(row.request.scope)),
    exportFile,
    store: async (objectKey, file) => {
      await putObject(objectKey as Parameters<typeof putObject>[0], file, "application/x-ndjson");
    },
    readBack,
    verify: (lines) => verifyExport(lines, createPublicKey(exportKey()).export({ type: "spki", format: "pem" }).toString()).ok,
    recordOf: (exportId) => auditExportRecord(exportId),
    appendRecord: (input) => append(input),
    ready: (exportId, pack, now) => writeAuditExportReady(exportId, { fromSeq: pack.fromSeq, toSeq: pack.toSeq, records: pack.records, headHash: pack.headHash, storageKey: pack.storageKey }, now),
    now: () => new Date(),
  };
}

/** A failure the engine must not retry: the row is gone, or its scope selects nothing, which the endpoint refused before it made the row. */
function unretryable(type: string, message: string): ApplicationFailure {
  return ApplicationFailure.create({ type, message, nonRetryable: true });
}

function packOfRow(row: AuditExportRow): AuditPackWritten | null {
  if (row.state !== "READY" || row.fromSeq === null || row.toSeq === null || row.headHash === null || row.storageKey === null) return null;
  return { fromSeq: row.fromSeq, toSeq: row.toSeq, records: row.records, headHash: row.headHash, fileSha256: "", storageKey: row.storageKey };
}

export function exportActivities(deps: ExportActivityDeps = defaultExportDeps()): ExportActivities {
  return {
    async writeAuditPack(exportId) {
      const row = await deps.readRow(exportId);
      if (row === null) throw unretryable("EXPORT_ROW_MISSING", `audit export ${exportId} has no row`);
      const done = packOfRow(row);
      if (done !== null) return done;
      const scope = await deps.scopeOf(row);
      let exported: { readonly file: Buffer; readonly trailer: ExportTrailer };
      try {
        exported = await deps.exportFile(scope, deps.now());
      } catch (error: unknown) {
        if (error instanceof AppError && error.code === "LEDGER_EXPORT_EMPTY") throw unretryable("EXPORT_EMPTY", `audit export ${exportId} selects no record`);
        throw error;
      }
      const storageKey = auditObjectKey(exportId);
      await deps.store(storageKey, exported.file);
      /* Read back and verified: the pack that is READY is one that verifies with the public key alone. */
      const stored = await deps.readBack(storageKey);
      if (stored === null || !stored.equals(exported.file)) throw new AppError("EXPORT_STORE_MISMATCH", `audit export ${exportId}: the store did not give back the pack that was written`);
      if (!deps.verify(stored.toString("utf8").split("\n"))) throw new AppError("EXPORT_UNVERIFIED", `audit export ${exportId}: the pack written does not verify`);
      const { trailer } = exported;
      return { fromSeq: trailer.fromSeq, toSeq: trailer.toSeq, records: trailer.records, headHash: trailer.headHash, fileSha256: createHash("sha256").update(exported.file).digest("hex"), storageKey };
    },

    async recordAuditPack(exportId, pack) {
      const row = await deps.readRow(exportId);
      if (row === null) throw unretryable("EXPORT_ROW_MISSING", `audit export ${exportId} has no row`);
      if (row.state === "READY") return;
      /* The record once: a retry after the append finds the record by the export's id in its payload. */
      const existing = await deps.recordOf(exportId);
      if (existing === null) {
        await deps.appendRecord({
          kind: "EXPORT",
          actor: row.requestedById === null ? "service:audit" : `user:${row.requestedById}`,
          suggestionId: null,
          chapterVersionId: null,
          payload: {
            scope: { kind: row.request.scope.kind, id: row.request.scope.id, from: row.request.from, to: row.request.to, kinds: [...ledgerKindsOf(row.request.kinds)] },
            fromSeq: pack.fromSeq,
            toSeq: pack.toSeq,
            records: pack.records,
            headHash: pack.headHash,
            fileSha256: pack.fileSha256,
            exportId,
          },
        });
      }
      await deps.ready(exportId, pack, deps.now());
    },
  };
}

export const exportActivitiesDefault: ExportActivities = exportActivities();
