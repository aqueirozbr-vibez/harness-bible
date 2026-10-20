import { z } from "zod";

/*
 * What a call with the provider's web tools hands back besides its text (feature-specs/41 § 3, § 7; unit 58a): the
 * searches it ran and the addresses they returned, the fetches it made and the addresses they opened, read from the
 * response's content blocks by shape rather than by the SDK's types, so the stub's answer and the proxy's are read
 * alike and a block of another kind (thinking, text, a tool this product never asked for) passes unread. Pure, and
 * importable by the web tier: it holds no key and makes no call. The addresses are the run's list of pages really
 * seen; `SOURCE_NOT_SEEN` (41 § 7) is decided against them.
 *
 * Since unit 69c (feature-specs/48 § 5.4) a fetch's result also gives its page's title where the block carries one
 * (the document's own `title`, which the provider sets from the page), and `pagesRead` lists the same pages in the
 * order the turn met them, each once, with its title, whether a fetch opened it and the search whose results held
 * it: the run's page list, which the person reads and the report's page numbers point into.
 */

const HTTPS = /^https:\/\//i;

const ServerToolUseSchema = z.looseObject({ type: z.literal("server_tool_use"), id: z.string(), name: z.enum(["web_search", "web_fetch"]), input: z.unknown() });
const SearchResultSchema = z.looseObject({ type: z.literal("web_search_result"), url: z.string(), title: z.string().nullable().optional(), page_age: z.string().nullable().optional() });
const SearchErrorSchema = z.looseObject({ type: z.literal("web_search_tool_result_error"), error_code: z.string() });
const SearchResultBlockSchema = z.looseObject({ type: z.literal("web_search_tool_result"), tool_use_id: z.string(), content: z.union([z.array(SearchResultSchema), SearchErrorSchema]) });
const FetchResultSchema = z.looseObject({ type: z.literal("web_fetch_result"), url: z.string(), retrieved_at: z.string().nullable().optional() });
const FetchErrorSchema = z.looseObject({ type: z.literal("web_fetch_tool_result_error"), error_code: z.string() });
/** The fetched document's title, read apart from the result's shape so a document of another form never costs the address. */
const FetchTitleSchema = z.looseObject({ content: z.looseObject({ title: z.string() }) });
const FetchResultBlockSchema = z.looseObject({ type: z.literal("web_fetch_tool_result"), tool_use_id: z.string(), content: z.union([FetchResultSchema, FetchErrorSchema]) });
const TextBlockSchema = z.looseObject({ type: z.literal("text"), text: z.string() });

export interface WebSearchSeen {
  readonly toolUseId: string;
  /** The query the model wrote, when the block's input carried one as the tool documents it. */
  readonly query: string | null;
  /** The addresses the search returned, with their titles; empty when the search failed. */
  readonly results: ReadonlyArray<{ readonly url: string; readonly title: string | null }>;
  readonly error: string | null;
}

export interface WebFetchSeen {
  readonly toolUseId: string;
  /** The address the model asked for, when the block's input carried one. */
  readonly requested: string | null;
  /** The address the fetch opened (the provider's own report, after redirects); null when the fetch failed. */
  readonly opened: string | null;
  /** The opened page's title, when the result's document carries one (48 § 5.4); null otherwise and when the fetch failed. */
  readonly title: string | null;
  readonly error: string | null;
}

export interface ToolBlocksSeen {
  readonly searches: ReadonlyArray<WebSearchSeen>;
  readonly fetches: ReadonlyArray<WebFetchSeen>;
  /** The text blocks' texts in order: the answer the parser reads, with no tool result in it. */
  readonly texts: ReadonlyArray<string>;
}

function queryOf(input: unknown): string | null {
  const parsed = z.looseObject({ query: z.string() }).safeParse(input);
  return parsed.success ? parsed.data.query : null;
}

function urlOf(input: unknown): string | null {
  const parsed = z.looseObject({ url: z.string() }).safeParse(input);
  return parsed.success ? parsed.data.url : null;
}

/** A fetch result's page title: the document's `title`, when it is a non-empty string. */
function titleOf(result: unknown): string | null {
  const parsed = FetchTitleSchema.safeParse(result);
  return parsed.success && parsed.data.content.title.trim().length > 0 ? parsed.data.content.title : null;
}

/**
 * The tool blocks of one or more responses' content, in order. A `server_tool_use` names the search or the fetch;
 * its result block follows under the same `tool_use_id`. A use whose result never arrived (a paused turn ends
 * between the two) is kept with no results and no error.
 */
export function toolBlocksOf(content: ReadonlyArray<unknown>): ToolBlocksSeen {
  const searches = new Map<string, WebSearchSeen>();
  const fetches = new Map<string, WebFetchSeen>();
  const texts: string[] = [];
  for (const block of content) {
    const use = ServerToolUseSchema.safeParse(block);
    if (use.success) {
      if (use.data.name === "web_search") searches.set(use.data.id, { toolUseId: use.data.id, query: queryOf(use.data.input), results: [], error: null });
      else fetches.set(use.data.id, { toolUseId: use.data.id, requested: urlOf(use.data.input), opened: null, title: null, error: null });
      continue;
    }
    const search = SearchResultBlockSchema.safeParse(block);
    if (search.success) {
      const seen = searches.get(search.data.tool_use_id) ?? { toolUseId: search.data.tool_use_id, query: null, results: [], error: null };
      const content = search.data.content;
      searches.set(seen.toolUseId, Array.isArray(content) ? { ...seen, results: content.map((result) => ({ url: result.url, title: result.title ?? null })) } : { ...seen, error: content.error_code });
      continue;
    }
    const fetch = FetchResultBlockSchema.safeParse(block);
    if (fetch.success) {
      const seen = fetches.get(fetch.data.tool_use_id) ?? { toolUseId: fetch.data.tool_use_id, requested: null, opened: null, title: null, error: null };
      const content = fetch.data.content;
      fetches.set(seen.toolUseId, content.type === "web_fetch_result" ? { ...seen, opened: content.url, title: titleOf(content) } : { ...seen, error: content.error_code });
      continue;
    }
    const text = TextBlockSchema.safeParse(block);
    if (text.success) texts.push(text.data.text);
  }
  return { searches: [...searches.values()], fetches: [...fetches.values()], texts };
}

/**
 * One tool block as a person's run's live step reads it (feature-specs/48 § 6; unit 70b): a search asked or answered, a
 * fetch asked or answered, by the block's own shape. A search's answer is the number of results it listed (none for a
 * failed search); a fetch's is the address it opened and the page's title, or nothing for one that failed. Progress,
 * never evidence: the run's pages and `SOURCE_NOT_SEEN` are read from the whole turn with `toolBlocksOf`.
 */
export type ToolEvent =
  | { readonly kind: "search"; readonly toolUseId: string; readonly query: string | null }
  | { readonly kind: "fetch"; readonly toolUseId: string; readonly requested: string | null }
  | { readonly kind: "searched"; readonly toolUseId: string; readonly results: number }
  | { readonly kind: "fetched"; readonly toolUseId: string; readonly opened: string | null; readonly title: string | null };

/** The block as a tool event, or null for a block of any other kind. */
export function toolEventOf(block: unknown): ToolEvent | null {
  const use = ServerToolUseSchema.safeParse(block);
  if (use.success) return use.data.name === "web_search" ? { kind: "search", toolUseId: use.data.id, query: queryOf(use.data.input) } : { kind: "fetch", toolUseId: use.data.id, requested: urlOf(use.data.input) };
  const search = SearchResultBlockSchema.safeParse(block);
  if (search.success) return { kind: "searched", toolUseId: search.data.tool_use_id, results: Array.isArray(search.data.content) ? search.data.content.length : 0 };
  const fetch = FetchResultBlockSchema.safeParse(block);
  if (fetch.success) {
    const content = fetch.data.content;
    return content.type === "web_fetch_result" ? { kind: "fetched", toolUseId: fetch.data.tool_use_id, opened: content.url, title: titleOf(content) } : { kind: "fetched", toolUseId: fetch.data.tool_use_id, opened: null, title: null };
  }
  return null;
}

/** How many uses of each tool the content holds: the count a continued turn's remaining limits are computed from (41 § 3). */
export function usesOf(seen: ToolBlocksSeen): { readonly searches: number; readonly fetches: number } {
  return { searches: seen.searches.length, fetches: seen.fetches.length };
}

/**
 * The pages really seen (41 § 3, § 7): every `https` address a search returned or a fetch opened, once each, in order
 * of appearance. An address the model asked to fetch but that did not open is not among them, nor is a plain `http`
 * one: a source must be an `https` address the call saw (41 § 7, `SOURCE_NOT_SEEN`).
 */
export function pagesSeen(seen: ToolBlocksSeen): ReadonlyArray<string> {
  const pages = new Set<string>();
  for (const search of seen.searches) for (const result of search.results) if (HTTPS.test(result.url)) pages.add(result.url);
  for (const fetch of seen.fetches) if (fetch.opened !== null && HTTPS.test(fetch.opened)) pages.add(fetch.opened);
  return [...pages];
}

/** A page of the run's list (48 § 5.4): the shape of `ReadPageSchema` (lib/schemas/researcher.ts), which this module does not import. */
export interface PageRead {
  readonly url: string;
  readonly title: string | null;
  /** A fetch of this turn opened it. */
  readonly opened: boolean;
  /** The one-based number of the first search whose results held it, counted in the order the searches were made; null for a page only a fetch reached. */
  readonly search: number | null;
}

/**
 * Every page the turn saw, once each, in the order it first appeared (48 § 5.4): a search's results in their order,
 * then a page a fetch opened, which is marked opened where a search had listed it and added where none had. The set is
 * `pagesSeen`'s — `https` addresses that a search returned or a fetch opened, never a fetch that failed — so a note on
 * a page among `found.pages` is a page of this list, and its position here is the number the report cites it by. A
 * title is the fetched document's where it has one, else the search result's.
 */
export function pagesRead(content: ReadonlyArray<unknown>): ReadonlyArray<PageRead> {
  const searchNumbers = new Map<string, number>();
  const pages = new Map<string, PageRead>();
  const numberOf = (toolUseId: string): number => {
    const known = searchNumbers.get(toolUseId);
    if (known !== undefined) return known;
    searchNumbers.set(toolUseId, searchNumbers.size + 1);
    return searchNumbers.size;
  };
  for (const block of content) {
    const use = ServerToolUseSchema.safeParse(block);
    if (use.success) {
      if (use.data.name === "web_search") numberOf(use.data.id);
      continue;
    }
    const search = SearchResultBlockSchema.safeParse(block);
    if (search.success) {
      const results = search.data.content;
      if (!Array.isArray(results)) continue;
      const n = numberOf(search.data.tool_use_id);
      for (const result of results) {
        if (!HTTPS.test(result.url)) continue;
        const seen = pages.get(result.url);
        /* a Map keeps a key's first position when it is set again, so a page keeps the place it first appeared in */
        pages.set(result.url, seen === undefined ? { url: result.url, title: result.title ?? null, opened: false, search: n } : { ...seen, title: seen.title ?? result.title ?? null, search: seen.search ?? n });
      }
      continue;
    }
    const fetch = FetchResultBlockSchema.safeParse(block);
    if (fetch.success && fetch.data.content.type === "web_fetch_result" && HTTPS.test(fetch.data.content.url)) {
      const url = fetch.data.content.url;
      const title = titleOf(fetch.data.content);
      const seen = pages.get(url);
      pages.set(url, seen === undefined ? { url, title, opened: true, search: null } : { ...seen, title: title ?? seen.title, opened: true });
    }
  }
  return [...pages.values()];
}

/** The provider's own counts of tool requests from a message's usage block, zeros when the call carried no tool. */
export function serverToolUsageOf(usage: { readonly server_tool_use?: { readonly web_search_requests?: number; readonly web_fetch_requests?: number } | null } | null | undefined): { readonly searches: number; readonly fetches: number } {
  return { searches: usage?.server_tool_use?.web_search_requests ?? 0, fetches: usage?.server_tool_use?.web_fetch_requests ?? 0 };
}
