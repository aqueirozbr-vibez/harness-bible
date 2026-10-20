/*
 * Where the dock's links lead (feature-specs/24 § 4, § 5.5). Since Assistant 2.0 the dock may be open on any page, so
 * a link can no longer assume a reader section beside it: a reference opens the peek when there is one, and the
 * reader at the cited section otherwise, with the conversation still open there.
 */

export interface RefBase {
  /** The reader section's own URL when the dock stands beside one: a reference opens the peek there (feature-specs/16 § 5.5). */
  readonly peek: string | null;
  readonly locale: string;
  /** The `ask` value a link carries so the conversation stays open: its id, or `1` before the first turn. */
  readonly ask: string;
}

const SECTION = /^\d{2}\.[1-9]$/;

/** The link of a cited section, a refusal's pointer or any other book reference shown in the dock. */
export function refHref(base: RefBase, id: string): string {
  if (base.peek !== null) return `${base.peek}/ref/${id}`;
  /* Outside the reader a section opens in the reader with the dock beside it; the cited passages are highlighted there. */
  if (SECTION.test(id)) return `/${base.locale}/ch/${id.slice(0, 2)}/${id}?ask=${base.ask}`;
  /* A lab or a chapter reference: the book's own resolver decides where it lives. */
  return `/${base.locale}/ref/${id}`;
}

/** `href` with `ask` set: the page the dock is on may carry parameters of its own (`/en/search?q=cache`). */
export function withAsk(href: string, ask: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}ask=${encodeURIComponent(ask)}`;
}

/** The dock opened on a page with a draft in its ask box (feature-specs/24 § 6.2). */
export function withDraft(href: string, draft: string): string {
  return `${withAsk(href, "1")}&draft=${encodeURIComponent(draft)}`;
}

/** A page's search parameters as Next hands them to a page. */
export type PageQuery = Record<string, string | ReadonlyArray<string> | undefined>;

/** The section a reader page shows, when the path is one: `["ch", "21", "21.3"]` → `"21.3"`. */
export function readerSectionOf(path: ReadonlyArray<string>): string | null {
  const [first, chapter, section] = path;
  if (path.length !== 3 || first !== "ch" || chapter === undefined || section === undefined) return null;
  return /^\d{2}$/.test(chapter) && /^\d{2}\.[1-9]$/.test(section) && section.slice(0, 2) === chapter ? section : null;
}

/** The page's own URL without the dock's two parameters: where closing the dock returns to. */
export function pageHref(locale: string, path: ReadonlyArray<string>, query: PageQuery): string {
  const kept = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "ask" || key === "draft" || value === undefined) continue;
    for (const entry of typeof value === "string" ? [value] : value) kept.append(key, entry);
  }
  const search = kept.toString();
  return `/${[locale, ...path].join("/")}${search.length === 0 ? "" : `?${search}`}`;
}

/** The assistant page's URL state (feature-specs/26 § 3): the open conversation, the statistics window, how many conversations are listed, and under 1000px which region is in front. */
export interface AssistantPageState {
  readonly ask?: string | null;
  readonly window?: "month" | "all";
  readonly listed?: number;
  readonly view?: "dock" | "conversations" | "stats";
}

/** How many conversations the page lists at first, and at most. */
export const CONVERSATIONS_PAGE = 20;
export const CONVERSATIONS_MAX = 200;

/** `/[lang]/assistant` with its state, each parameter left out at its default so the plain URL is the plain page. */
export function assistantPageHref(locale: string, state: AssistantPageState = {}): string {
  const query = new URLSearchParams();
  if (state.ask !== undefined && state.ask !== null && state.ask !== "") query.set("ask", state.ask);
  if (state.window === "all") query.set("w", "all");
  if (state.listed !== undefined && state.listed > CONVERSATIONS_PAGE) query.set("n", String(Math.min(CONVERSATIONS_MAX, state.listed)));
  if (state.view === "conversations" || state.view === "stats") query.set("view", state.view);
  const search = query.toString();
  return `/${locale}/assistant${search.length === 0 ? "" : `?${search}`}`;
}

/** The page's state as its URL carries it; anything else reads as the default. */
export function assistantPageStateOf(query: PageQuery): Required<AssistantPageState> {
  const one = (key: string): string => (typeof query[key] === "string" ? (query[key] as string) : "");
  const n = /^\d+$/.test(one("n")) ? Number(one("n")) : CONVERSATIONS_PAGE;
  return {
    ask: one("ask") === "" ? null : one("ask"),
    window: one("w") === "all" ? "all" : "month",
    listed: Math.min(CONVERSATIONS_MAX, Math.max(CONVERSATIONS_PAGE, n)),
    view: one("view") === "conversations" ? "conversations" : one("view") === "stats" ? "stats" : "dock",
  };
}
