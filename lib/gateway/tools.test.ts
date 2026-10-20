import { describe, expect, it } from "vitest";

import { researchTools, ServerToolsSchema } from "@/lib/schemas/gateway";

import { pagesRead, pagesSeen, serverToolUsageOf, toolBlocksOf, toolEventOf, usesOf } from "./tools";
import { remainingTools } from "./turn";

/*
 * What a call with the web tools hands back (feature-specs/41 § 3, § 7; unit 58a), read from blocks by shape: the
 * searches with their queries and results, the fetches with the address opened or the error, the texts; the pages
 * really seen as `https` addresses once each; the uses a continuation's limits are computed from; the provider's own
 * counts. And the typed tools themselves: the two the spec names and nothing else. Since unit 69c (feature-specs/48
 * § 5.4): a fetch's page title, and the pages read in the order the turn met them.
 */

const BLOCKS = [
  { type: "thinking", thinking: "…", signature: "s" },
  { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "idempotency keys retention" } },
  {
    type: "web_search_tool_result",
    tool_use_id: "s1",
    content: [
      { type: "web_search_result", url: "https://standards.example/keys", title: "Keys", encrypted_content: "x", page_age: null },
      { type: "web_search_result", url: "http://plain.example/keys", title: "Plain", encrypted_content: "x", page_age: "1 day" },
    ],
  },
  { type: "server_tool_use", id: "f1", name: "web_fetch", input: { url: "https://standards.example/keys" } },
  { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url: "https://standards.example/keys/", retrieved_at: "2026-10-10T00:00:00Z", content: { type: "document", source: { type: "text", media_type: "text/plain", data: "…" }, title: "Keys", citations: null } } },
  { type: "server_tool_use", id: "f2", name: "web_fetch", input: { url: "https://gone.example/" } },
  { type: "web_fetch_tool_result", tool_use_id: "f2", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } },
  { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "second" } },
  { type: "web_search_tool_result", tool_use_id: "s2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
  { type: "text", text: '{"findings":[]}' },
];

describe("toolBlocksOf and pagesSeen", () => {
  it("reads the searches, the fetches and the texts by shape, and passes other blocks unread", () => {
    const seen = toolBlocksOf(BLOCKS);
    expect(seen.searches).toEqual([
      { toolUseId: "s1", query: "idempotency keys retention", results: [{ url: "https://standards.example/keys", title: "Keys" }, { url: "http://plain.example/keys", title: "Plain" }], error: null },
      { toolUseId: "s2", query: "second", results: [], error: "max_uses_exceeded" },
    ]);
    expect(seen.fetches).toEqual([
      { toolUseId: "f1", requested: "https://standards.example/keys", opened: "https://standards.example/keys/", title: "Keys", error: null },
      { toolUseId: "f2", requested: "https://gone.example/", opened: null, title: null, error: "url_not_accessible" },
    ]);
    expect(seen.texts).toEqual(['{"findings":[]}']);
    expect(usesOf(seen)).toEqual({ searches: 2, fetches: 2 });
  });

  it("lists the https addresses a search returned or a fetch opened, once each; not the fetch that failed, not a plain http result", () => {
    expect(pagesSeen(toolBlocksOf(BLOCKS))).toEqual(["https://standards.example/keys", "https://standards.example/keys/"]);
    expect(pagesSeen(toolBlocksOf([]))).toEqual([]);
  });

  it("keeps a use whose result never arrived, as a paused turn leaves it", () => {
    const seen = toolBlocksOf([{ type: "server_tool_use", id: "s9", name: "web_search", input: { query: "q" } }]);
    expect(seen.searches).toEqual([{ toolUseId: "s9", query: "q", results: [], error: null }]);
    expect(pagesSeen(seen)).toEqual([]);
  });

  it("lists the pages read once each in the order the turn met them, with the fetch's title, opened, and the search that held them (48 § 5.4)", () => {
    expect(pagesRead(BLOCKS)).toEqual([
      { url: "https://standards.example/keys", title: "Keys", opened: false, search: 1 },
      { url: "https://standards.example/keys/", title: "Keys", opened: true, search: null },
    ]);
    const interleaved = [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "first" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a.example/one", title: "One (search)" }, { type: "web_search_result", url: "https://b.example/two", title: null }] },
      { type: "server_tool_use", id: "f1", name: "web_fetch", input: { url: "https://b.example/two" } },
      { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url: "https://b.example/two", content: { type: "document", source: { type: "text", data: "…" }, title: "Two, as the page titles itself" } } },
      { type: "server_tool_use", id: "f2", name: "web_fetch", input: { url: "https://c.example/three" } },
      { type: "web_fetch_tool_result", tool_use_id: "f2", content: { type: "web_fetch_result", url: "https://c.example/three", content: { type: "document", source: { type: "text", data: "…" } } } },
      { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "second" } },
      { type: "web_search_tool_result", tool_use_id: "s2", content: [{ type: "web_search_result", url: "https://a.example/one", title: "One again" }, { type: "web_search_result", url: "https://c.example/three", title: "Three (search)" }, { type: "web_search_result", url: "https://d.example/four", title: "Four" }] },
      { type: "server_tool_use", id: "f3", name: "web_fetch", input: { url: "https://e.example/gone" } },
      { type: "web_fetch_tool_result", tool_use_id: "f3", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } },
    ];
    expect(pagesRead(interleaved)).toEqual([
      { url: "https://a.example/one", title: "One (search)", opened: false, search: 1 },
      { url: "https://b.example/two", title: "Two, as the page titles itself", opened: true, search: 1 },
      { url: "https://c.example/three", title: "Three (search)", opened: true, search: 2 },
      { url: "https://d.example/four", title: "Four", opened: false, search: 2 },
    ]);
    /* the same set as the pages seen, which SOURCE_NOT_SEEN and a note's check read */
    expect(new Set(pagesRead(interleaved).map((page) => page.url))).toEqual(new Set(pagesSeen(toolBlocksOf(interleaved))));
    expect(pagesRead([])).toEqual([]);
  });

  it("reads the provider's counts from the usage, zeros without the tools", () => {
    expect(serverToolUsageOf({ server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 } })).toEqual({ searches: 3, fetches: 1 });
    expect(serverToolUsageOf({ server_tool_use: null })).toEqual({ searches: 0, fetches: 0 });
    expect(serverToolUsageOf(undefined)).toEqual({ searches: 0, fetches: 0 });
  });
});

describe("toolEventOf (feature-specs/48 § 6)", () => {
  it("reads each tool block as the run's live step reads it, in the blocks' order, and nothing of any other block", () => {
    expect(BLOCKS.map(toolEventOf)).toEqual([
      null,
      { kind: "search", toolUseId: "s1", query: "idempotency keys retention" },
      { kind: "searched", toolUseId: "s1", results: 2 },
      { kind: "fetch", toolUseId: "f1", requested: "https://standards.example/keys" },
      { kind: "fetched", toolUseId: "f1", opened: "https://standards.example/keys/", title: "Keys" },
      { kind: "fetch", toolUseId: "f2", requested: "https://gone.example/" },
      { kind: "fetched", toolUseId: "f2", opened: null, title: null },
      { kind: "search", toolUseId: "s2", query: "second" },
      { kind: "searched", toolUseId: "s2", results: 0 },
      null,
    ]);
  });

  it("keeps a use whose input carries no query or address, with none", () => {
    expect(toolEventOf({ type: "server_tool_use", id: "s3", name: "web_search", input: {} })).toEqual({ kind: "search", toolUseId: "s3", query: null });
    expect(toolEventOf({ type: "server_tool_use", id: "x", name: "code_execution", input: {} })).toBeNull();
  });
});

describe("the typed server tools (41 § 3)", () => {
  it("builds the reader's two tools with ten uses each, and nothing else passes the schema", () => {
    const tools = researchTools();
    expect(tools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 10 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
    ]);
    expect(ServerToolsSchema.safeParse(tools).success).toBe(true);
    expect(ServerToolsSchema.safeParse([{ type: "web_search_20260209", name: "web_search", max_uses: 11 }]).success).toBe(false);
    expect(ServerToolsSchema.safeParse([{ type: "web_search_20260209", name: "web_search", max_uses: 10, allowed_domains: ["a.example"] }]).success).toBe(false);
    expect(ServerToolsSchema.safeParse([{ name: "lookup", description: "a client tool", input_schema: { type: "object" } }]).success).toBe(false);
    expect(ServerToolsSchema.safeParse([...(tools ?? []), { type: "web_search_20260209", name: "web_search", max_uses: 1 }]).success).toBe(false);
    expect(ServerToolsSchema.safeParse([]).success).toBe(false);
  });

  it("lowers a continuation's limits to what is left, leaves out a tool with no use left, and says null when neither has one", () => {
    const tools = researchTools() ?? [];
    expect(remainingTools(tools, { searches: 1, fetches: 0 })).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 9 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
    ]);
    expect(remainingTools(tools, { searches: 10, fetches: 2 })).toEqual([{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 }]);
    expect(remainingTools(tools, { searches: 3, fetches: 10 })).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 7 }]);
    expect(remainingTools(tools, { searches: 10, fetches: 10 })).toBeNull();
    expect(researchTools({ searches: 0, fetches: 4 })).toEqual([{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 }]);
    expect(researchTools({ searches: 0, fetches: 0 })).toBeNull();
  });
});
