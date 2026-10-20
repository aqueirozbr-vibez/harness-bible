import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { handler, type HandlerDeps } from "@/lib/api/handler";
import type { SessionUser } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import type { AppendInput } from "@/lib/ledger/append";
import type { ChapterHistory } from "@/lib/schemas/history";
import type { ExportTrailer } from "@/lib/schemas/ledger";

import { historyEndpoints, type HistoryEndpointDeps } from "./history";

/*
 * A chapter's history (feature-specs/37 § 7; unit 54d), the loader, the rows and the ledger doubled: public, as the
 * chapter's own read is, and not found for a chapter the release has not; its export for anyone signed in, the
 * chapter scope's signed JSONL as an attachment with its `EXPORT` record under the person's pseudonym, nothing to
 * export for a chapter with no merged change, and no export without the platform key.
 */

const READER: SessionUser = { id: "11111111-1111-4111-8111-111111111111", organisationId: null, role: "READER", displayName: "A reader", locale: "en", identityVerified: false, parts: [], sessionId: "s1" };
const FILE = Buffer.from('{"seq":1}\n{"trailer":{}}\n');
const TRAILER: ExportTrailer = { headHash: "d".repeat(64), fromSeq: 14647, toSeq: 15394, records: 8, scope: { kind: "chapter", id: "21", from: null, to: null }, exportedAt: "2026-10-10T12:00:00.000Z", signature: "e".repeat(128) };
const HISTORY: ChapterHistory = {
  chapter: 21 as ChapterHistory["chapter"],
  version: "v1.0.1",
  release: "2026.10" as ChapterHistory["release"],
  rows: [],
  stats: { versions: 2, from: "v1.0.0", to: "v1.0.1", contributed: 1, overrides: { count: 0, latest: null }, reverted: 0 },
  credit: [],
  layers: [],
  chain: { ok: true, records: 4, headHash: "a".repeat(64), firstBreak: null },
  checkedAt: "2026-10-10T12:00:00.000Z",
};

function harness(over: Partial<HistoryEndpointDeps> = {}) {
  const appended: AppendInput[] = [];
  const asked: Array<readonly [string, ReadonlyArray<string>]> = [];
  const deps: HistoryEndpointDeps = {
    history: async (chapterNumber) => (chapterNumber === 21 ? HISTORY : null),
    mergedIds: async (chapterNumber) => (chapterNumber === 21 ? ["S-21-0001", "S-21-0002"] : []),
    exportFile: async (digits, ids) => {
      asked.push([digits, ids]);
      return { file: FILE, trailer: TRAILER };
    },
    appendExport: async (input) => {
      appended.push(input);
    },
    now: () => new Date("2026-10-10T12:00:00.000Z"),
    ...over,
  };
  const pipeline = (session: SessionUser | null): HandlerDeps => ({
    sessionFromRequest: async () => session,
    authorize: async () => ({ allow: true }),
    consume: async () => ({ allowed: true, limit: 10, remaining: 9, resetS: 6, retryAfterS: 0 }),
    idempotency: { begin: async () => ({ kind: "new" }), complete: async () => undefined, abandon: async () => undefined },
    audit: async () => undefined,
    log: () => undefined,
  });
  const { chapterHistory, chapterHistoryExport } = historyEndpoints(deps);
  const read = (n: string, session: SessionUser | null = null): Promise<Response> => handler(chapterHistory, pipeline(session))(new Request(`http://localhost:3000/api/v1/chapters/${n}/history`), { params: { n } });
  const download = (session: SessionUser | null, n = "21"): Promise<Response> => handler(chapterHistoryExport, pipeline(session))(new Request(`http://localhost:3000/api/v1/chapters/${n}/history/export`, { headers: { "sec-fetch-site": "same-origin" } }), { params: { n } });
  return { read, download, appended, asked };
}

describe("GET /api/v1/chapters/{n}/history (37 § 7)", () => {
  it("is public, rate-limited by address, and decided as the chapter's own read is", () => {
    const { chapterHistory } = historyEndpoints();
    expect(chapterHistory).toMatchObject({ path: "/api/v1/chapters/{n}/history", method: "GET", auth: "public", rateLimit: { key: "ip", limit: 120, windowS: 60 }, policy: { action: "read" } });
  });

  it("answers the history to anyone, and not found for a chapter the release has not or a number of the wrong form", async () => {
    const { read } = harness();
    const response = await read("21");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(HISTORY);
    expect((await read("21", READER)).status).toBe(200);
    expect((await read("99")).status).toBe(404);
    expect((await read("7")).status).toBe(400);
  });
});

describe("GET /api/v1/chapters/{n}/history/export (37 § 7)", () => {
  it("is declared as a suggestion's export: a session, ten a minute, a read that writes", () => {
    const { chapterHistoryExport } = historyEndpoints();
    expect(chapterHistoryExport).toMatchObject({ path: "/api/v1/chapters/{n}/history/export", method: "GET", auth: "session", rateLimit: { key: "user", limit: 10, windowS: 60 }, writes: true, policy: { action: "read" } });
  });

  it("answers the chapter scope's signed JSONL as an attachment, and records the export under the person's pseudonym with the file's hash", async () => {
    const { download, appended, asked } = harness();
    const response = await download(READER);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="hb-chapter-21-history.jsonl"');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(FILE);
    expect(asked).toEqual([["21", ["S-21-0001", "S-21-0002"]]]);
    expect(appended).toEqual([{ kind: "EXPORT", actor: `user:${READER.id}`, suggestionId: null, chapterVersionId: null, payload: { scope: TRAILER.scope, fromSeq: 14647, toSeq: 15394, records: 8, headHash: TRAILER.headHash, fileSha256: createHash("sha256").update(FILE).digest("hex") } }]);
  });

  it("is refused signed out, has nothing to export for a chapter with no merged change, and no export without the key; nothing is recorded", async () => {
    const { download, appended } = harness();
    expect((await download(null)).status).toBe(401);
    const empty = await download(READER, "28");
    expect(empty.status).toBe(404);
    expect(await empty.json()).toMatchObject({ code: "NOTHING_TO_EXPORT" });
    const unkeyed = harness({ exportFile: async () => Promise.reject(new AppError("LEDGER_KEY_MISSING", "LEDGER_EXPORT_KEY is not set")) });
    expect((await unkeyed.download(READER)).status).toBe(500);
    expect(appended).toEqual([]);
    expect(unkeyed.appended).toEqual([]);
  });
});
