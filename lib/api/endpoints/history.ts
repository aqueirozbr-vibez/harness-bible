import { createHash } from "node:crypto";
import { Writable } from "node:stream";

import { EXPORT_RATE } from "@/lib/api/endpoints/assistant";
import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import { readChapterHistory } from "@/lib/db/chapterHistory";
import { mergedOfChapter } from "@/lib/db/improve";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { append, type AppendInput } from "@/lib/ledger/append";
import { exportJsonl, exportKeyFromPem } from "@/lib/ledger/export";
import type { PolicyResource } from "@/lib/policy/input";
import { NoBodySchema } from "@/lib/schemas/api";
import { ChapterHistoryParamsSchema, ChapterHistorySchema, type ChapterHistory } from "@/lib/schemas/history";
import type { ExportTrailer } from "@/lib/schemas/ledger";

/*
 * A chapter's improvement history (feature-specs/37 § 7; unit 54d): `GET /api/v1/chapters/{n}/history`, public, as the
 * Chapter-History page draws it, the chain checked on each request; and its export, the ledger's chapter scope — the
 * chapter's merged suggestions' records (35 D2) — as signed JSONL, for anyone signed in, which appends its own
 * `EXPORT` record under the person's pseudonym, as a suggestion's export does. A history of no merged suggestion has
 * nothing to export.
 */

const PUBLIC_RATE = { key: "ip", limit: 120, windowS: 60 } as const;
const content = (id: string): PolicyResource => ({ kind: "content", id });

export interface HistoryEndpointDeps {
  readonly history: (chapterNumber: number, now: Date) => Promise<ChapterHistory | null>;
  /** The chapter's merged suggestions' ids: the chapter scope's; none is nothing to export, said before the key is asked for. */
  readonly mergedIds: (chapterNumber: number) => Promise<ReadonlyArray<string>>;
  readonly exportFile: (chapterDigits: string, suggestionIds: ReadonlyArray<string>) => Promise<{ readonly file: Buffer; readonly trailer: ExportTrailer }>;
  readonly appendExport: (input: AppendInput) => Promise<unknown>;
  readonly now: () => Date;
}

async function exportFile(chapterDigits: string, suggestionIds: ReadonlyArray<string>): Promise<{ readonly file: Buffer; readonly trailer: ExportTrailer }> {
  const key = exportKeyFromPem(env.LEDGER_EXPORT_KEY);
  const chunks: Buffer[] = [];
  const sink = new Writable({
    highWaterMark: 1 << 20,
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  const trailer = await exportJsonl({ kind: "chapter", id: chapterDigits, suggestionIds }, sink, { key, now: () => new Date() });
  return { file: Buffer.concat(chunks), trailer };
}

const DEPS: HistoryEndpointDeps = {
  history: (chapterNumber, now) => readChapterHistory(chapterNumber, now),
  mergedIds: async (chapterNumber) => (await mergedOfChapter(chapterNumber)).map((row) => row.id),
  exportFile,
  appendExport: (input) => append(input),
  now: () => new Date(),
};

function requireUser(session: SessionUser | null): SessionUser {
  if (session === null) throw new ApiError("NO_SESSION", "sign in to use this endpoint");
  return session;
}

export function historyEndpoints(deps: HistoryEndpointDeps = DEPS): {
  readonly chapterHistory: Spec<typeof ChapterHistoryParamsSchema, undefined, undefined, typeof ChapterHistorySchema>;
  readonly chapterHistoryExport: Spec<typeof ChapterHistoryParamsSchema, undefined, undefined, typeof NoBodySchema>;
} {
  return {
    chapterHistory: {
      path: "/api/v1/chapters/{n}/history",
      method: "GET",
      summary: "A chapter's improvement history: its versions newest first, each merged change with its evidence and the people who made it, the credit list, what changed by layer, and the chain checked now",
      auth: "public",
      params: ChapterHistoryParamsSchema,
      response: ChapterHistorySchema,
      rateLimit: PUBLIC_RATE,
      policy: { action: "read", resource: ({ params }) => content(`ch${params.n}`) },
      run: async ({ params }) => {
        const history = await deps.history(Number(params.n), deps.now());
        if (history === null) throw new ApiError("NOT_FOUND", `chapter ${params.n} is not in the pinned release`);
        return history;
      },
    },
    chapterHistoryExport: {
      path: "/api/v1/chapters/{n}/history/export",
      method: "GET",
      summary: "Download a chapter's records — its merged suggestions' — as signed JSONL, for anyone signed in; the export is recorded",
      auth: "session",
      params: ChapterHistoryParamsSchema,
      response: NoBodySchema,
      rateLimit: EXPORT_RATE,
      writes: true,
      policy: { action: "read", resource: ({ params }) => content(`ch${params.n}`) },
      run: async ({ session, params, traceId }) => {
        const user = requireUser(session);
        const ids = await deps.mergedIds(Number(params.n));
        if (ids.length === 0) throw new ApiError("NOTHING_TO_EXPORT", `chapter ${params.n} has no merged change yet: nothing to export`);
        let exported: { readonly file: Buffer; readonly trailer: ExportTrailer };
        try {
          exported = await deps.exportFile(params.n, ids);
        } catch (error: unknown) {
          if (error instanceof AppError && error.code === "LEDGER_EXPORT_EMPTY") throw new ApiError("NOTHING_TO_EXPORT", `chapter ${params.n} has no record yet`);
          /* No key, no export (14 § 7): the operator's variable is named in the log, and the person sees INTERNAL. */
          if (error instanceof AppError && (error.code === "LEDGER_KEY_MISSING" || error.code === "LEDGER_KEY_INVALID")) {
            console.error("export refused", traceId, error.message);
            throw new ApiError("INTERNAL", "the export key is not available");
          }
          throw error;
        }
        const { file, trailer } = exported;
        /* The export is a record of no suggestion's: it is the chapter's, and the chain holds it under the person's pseudonym. */
        await deps.appendExport({
          kind: "EXPORT",
          actor: `user:${user.id}`,
          suggestionId: null,
          chapterVersionId: null,
          payload: { scope: trailer.scope, fromSeq: trailer.fromSeq, toSeq: trailer.toSeq, records: trailer.records, headHash: trailer.headHash, fileSha256: createHash("sha256").update(file).digest("hex") },
        });
        return new Response(new Uint8Array(file), {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "content-disposition": `attachment; filename="hb-chapter-${params.n}-history.jsonl"`,
            "cache-control": "private, no-store",
          },
        });
      },
    },
  };
}

export const { chapterHistory, chapterHistoryExport } = historyEndpoints();
