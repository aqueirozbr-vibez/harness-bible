import { createHash } from "node:crypto";
import { Writable } from "node:stream";

import { EXPORT_RATE } from "@/lib/api/endpoints/assistant";
import { readAskerProposal, resourceOf, SUGGESTION_RATE } from "@/lib/api/endpoints/suggestions";
import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import type { LedgerRecord } from "@/lib/db/generated/client";
import type { PolicyResource } from "@/lib/policy/input";
import { callerOf, readClosedResearchProposal, readMergedSuggestion, readSuggestion, type SuggestionForUser } from "@/lib/db/improve";
import { checkedView, countView } from "@/lib/db/ledger";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { append, type AppendInput } from "@/lib/ledger/append";
import { exportJsonl, exportKeyFromPem } from "@/lib/ledger/export";
import type { ChainCheck } from "@/lib/ledger/verify";
import { NoBodySchema } from "@/lib/schemas/api";
import type { ExportTrailer } from "@/lib/schemas/ledger";
import { SuggestionParamsSchema, SuggestionRecordSchema, type SuggestionRecord } from "@/lib/schemas/suggestions";

/*
 * A suggestion's record as JSON (feature-specs/35 § 5; TRD § 6.1; unit 52c): its records in chain order with their
 * hashes, and the chain checked on this request. And its export (part 2): the ledger's JSONL in its `suggestion`
 * scope with the signed trailer, which appends its own `EXPORT` record, as a conversation's export does (spec 17 § 6).
 * The same audience as the record page and the suggestion's own read before a merge: its owner, and a curator of one
 * of its parts once it is past draft (35 D2); once merged, anyone, signed out included (unit 54d), which the policy is
 * told as the resource's `merged`.
 */

export interface RecordEndpointDeps {
  /** A researcher's closed proposal as any curator reads it (43 D6). */
  readonly readClosed: (user: SessionUser, id: string) => Promise<SuggestionForUser | null>;
  /** A researcher's proposal as the reader who asked reads it (43 D7). */
  readonly readAsker: (user: SessionUser, id: string) => Promise<SuggestionForUser | null>;
  readonly read: (user: SessionUser, id: string) => Promise<SuggestionForUser | null>;
  /** The suggestion once merged, anyone's to read (35 D2; unit 54d). */
  readonly readMerged: (id: string) => Promise<SuggestionForUser | null>;
  readonly record: (suggestionId: string) => Promise<{ readonly rows: ReadonlyArray<LedgerRecord>; readonly chain: ChainCheck }>;
  /** How many records the suggestion's view holds: none is nothing to export, said before the key is asked for. */
  readonly records: (suggestionId: string) => Promise<number>;
  /** The suggestion's records as signed JSONL, with its trailer; signed with the platform's export key (14 § 7). */
  readonly exportFile: (suggestionId: string) => Promise<{ readonly file: Buffer; readonly trailer: ExportTrailer }>;
  /** The `EXPORT` record the export appends, by the one writer (lib/ledger/append.ts). */
  readonly appendExport: (input: AppendInput) => Promise<unknown>;
}

async function exportFile(suggestionId: string): Promise<{ readonly file: Buffer; readonly trailer: ExportTrailer }> {
  const key = exportKeyFromPem(env.LEDGER_EXPORT_KEY);
  const chunks: Buffer[] = [];
  const sink = new Writable({
    highWaterMark: 1 << 20,
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  const trailer = await exportJsonl({ kind: "suggestion", id: suggestionId }, sink, { key, now: () => new Date() });
  return { file: Buffer.concat(chunks), trailer };
}

const DEPS: RecordEndpointDeps = {
  read: (user, id) => readSuggestion(callerOf(user), id),
  readMerged: (id) => readMergedSuggestion(id),
  readClosed: (user, id) => readClosedResearchProposal(callerOf(user), id),
  readAsker: (user, id) => readAskerProposal(user, id),
  record: (suggestionId) => checkedView({ suggestionId }),
  records: (suggestionId) => countView({ suggestionId }),
  exportFile,
  appendExport: (input) => append(input),
};

function requireUser(session: SessionUser | null): SessionUser {
  if (session === null) throw new ApiError("NO_SESSION", "sign in to use this endpoint");
  return session;
}

/**
 * The suggestion as its reader may have it, and how: by their own read (its owner, a curator of its parts); a
 * researcher's closed proposal by any curator (43 D6); a researcher's proposal by the reader who asked (43 D7); or,
 * merged, by anyone (35 D2). Each read is the door's, with its own condition.
 */
async function readableAs(deps: Pick<RecordEndpointDeps, "read" | "readMerged" | "readClosed" | "readAsker">, session: SessionUser | null, id: string): Promise<{ readonly row: SuggestionForUser; readonly as: "own" | "closed" | "asker" | "merged" } | null> {
  const own = session === null ? null : await deps.read(session, id);
  if (own !== null) return { row: own, as: "own" };
  const closed = session === null ? null : await deps.readClosed(session, id);
  if (closed !== null) return { row: closed, as: "closed" };
  const asked = session === null ? null : await deps.readAsker(session, id);
  if (asked !== null) return { row: asked, as: "asker" };
  const merged = await deps.readMerged(id);
  return merged === null ? null : { row: merged, as: "merged" };
}

async function readable(deps: Pick<RecordEndpointDeps, "read" | "readMerged" | "readClosed" | "readAsker">, session: SessionUser | null, id: string): Promise<SuggestionForUser | null> {
  return (await readableAs(deps, session, id))?.row ?? null;
}

/** The policy's resource: the suggestion's facts, and how its reader came by it — merged, closed, or as its asker, whose resource is the proposal (43 D7). */
async function recordResourceOf(deps: Pick<RecordEndpointDeps, "read" | "readMerged" | "readClosed" | "readAsker">, session: SessionUser | null, id: string): Promise<PolicyResource> {
  const read = await readableAs(deps, session, id);
  if (read === null) throw new ApiError("NOT_FOUND", `suggestion ${id} is not here, or not yours to read`);
  const { row, as } = read;
  if (as === "asker" && session !== null) return { kind: "proposal", id: row.id, ownerId: session.id };
  return { kind: "suggestion", id: row.id, ownerId: row.userId, parts: row.parts, changeClass: row.changeClass, origin: row.origin, ...(as === "merged" ? { merged: true } : {}), ...(as === "closed" ? { closed: true } : {}) };
}

export function recordEndpoints(deps: RecordEndpointDeps = DEPS): {
  readonly suggestionRecord: Spec<typeof SuggestionParamsSchema, undefined, undefined, typeof SuggestionRecordSchema>;
  readonly suggestionRecordExport: Spec<typeof SuggestionParamsSchema, undefined, undefined, typeof NoBodySchema>;
} {
  return {
    suggestionRecord: {
      path: "/api/v1/suggestions/{id}/record",
      method: "GET",
      summary: "A suggestion's records with their hashes and the chain checked now, for its owner or a curator of one of its parts; once merged, for anyone",
      auth: "public",
      params: SuggestionParamsSchema,
      response: SuggestionRecordSchema,
      rateLimit: SUGGESTION_RATE,
      policy: { action: "read", resource: ({ session, params }) => recordResourceOf(deps, session, params.id) },
      run: async ({ session, params }) => {
        const row = await readable(deps, session, params.id);
        if (row === null) throw new ApiError("NOT_FOUND", `suggestion ${params.id} is not here, or not yours to read`);
        const { rows, chain } = await deps.record(row.id);
        const answer: SuggestionRecord = {
          id: row.id as SuggestionRecord["id"],
          records: rows.map((record) => ({ seq: record.seq, kind: record.kind, actor: record.actor, payload: record.payload as SuggestionRecord["records"][number]["payload"], createdAt: record.createdAt.toISOString(), prevHash: record.prevHash, hash: record.hash })),
          chain: { ok: chain.ok, records: chain.records, headHash: chain.headHash, firstBreak: chain.firstBreak },
        };
        return answer;
      },
    },
    suggestionRecordExport: {
      path: "/api/v1/suggestions/{id}/record/export",
      method: "GET",
      summary: "Download a suggestion's records as signed JSONL, for its owner or a curator of one of its parts; the export is recorded",
      auth: "session",
      params: SuggestionParamsSchema,
      response: NoBodySchema,
      rateLimit: EXPORT_RATE,
      writes: true,
      policy: { action: "read", resource: ({ session, params }) => resourceOf(deps, session, params.id) },
      run: async ({ session, params, traceId }) => {
        const user = requireUser(session);
        const row = await deps.read(user, params.id);
        if (row === null) throw new ApiError("NOT_FOUND", `suggestion ${params.id} is not here, or not yours to read`);
        /* A draft has no record to sign (35 § 5), whether or not this deployment holds the key. */
        if (row.state === "DRAFT") throw new ApiError("NOTHING_TO_EXPORT", `suggestion ${row.id} has no record yet: it has not been submitted`);
        /* Nor one submitted whose workflow has not recorded it yet: the same answer with or without the key, as a conversation's (17 § 6). */
        if ((await deps.records(row.id)) === 0) throw new ApiError("NOTHING_TO_EXPORT", `suggestion ${row.id} has no record yet`);
        let exported: { readonly file: Buffer; readonly trailer: ExportTrailer };
        try {
          exported = await deps.exportFile(row.id);
        } catch (error: unknown) {
          if (error instanceof AppError && error.code === "LEDGER_EXPORT_EMPTY") throw new ApiError("NOTHING_TO_EXPORT", `suggestion ${row.id} has no record yet`);
          /* No key, no export: an unsigned file would be a file that looks like a record (14 § 7). Its message names
             the variable for the operator; the person sees INTERNAL, as a conversation's export does. */
          if (error instanceof AppError && (error.code === "LEDGER_KEY_MISSING" || error.code === "LEDGER_KEY_INVALID")) {
            console.error("export refused", traceId, error.message);
            throw new ApiError("INTERNAL", "the export key is not available");
          }
          throw error;
        }
        const { file, trailer } = exported;
        /* The export is a record of the suggestion's own: it joins its view, so its page and its next export show it. */
        await deps.appendExport({
          kind: "EXPORT",
          actor: `user:${user.id}`,
          suggestionId: row.id,
          chapterVersionId: null,
          payload: { scope: trailer.scope, fromSeq: trailer.fromSeq, toSeq: trailer.toSeq, records: trailer.records, headHash: trailer.headHash, fileSha256: createHash("sha256").update(file).digest("hex") },
        });
        return new Response(new Uint8Array(file), {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "content-disposition": `attachment; filename="hb-suggestion-${row.id}.jsonl"`,
            "cache-control": "private, no-store",
          },
        });
      },
    },
  };
}

export const { suggestionRecord, suggestionRecordExport } = recordEndpoints();
