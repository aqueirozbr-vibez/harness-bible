import { CONVERSATIONS_MAX, CONVERSATIONS_PAGE, type PageQuery } from "@/lib/assistant/links";

/*
 * Where the Research page's links lead (feature-specs/48 § 11.1, § 11.3), the pattern of `lib/assistant/links.ts`: the
 * page's state is its URL, each parameter left out at its default so the plain URL is the plain page.
 *
 * `research` is the open research: absent and `1` are the empty column, ready for a question; on every other page the
 * same parameter will be the Research dock's (unit 77), as `ask` is the Assistant's. `from` is an Assistant answer a
 * research is seeded from, read only while no research is open (A6). `w`, `n` and `view` are the Assistant page's own.
 */

/** The Research page's URL state (§ 11.1). */
export interface ResearchPageState {
  /** The open research's id, `1` for the empty column; null when absent. */
  readonly research?: string | null;
  /** The Assistant answer the column is seeded from (A6). */
  readonly from?: string | null;
  readonly window?: "month" | "all";
  readonly listed?: number;
  /** Under 1000px, which region is in front; `dock` is the research column, as the Assistant page names its own. */
  readonly view?: "dock" | "conversations" | "stats";
}

/** `/[lang]/research` with its state. */
export function researchPageHref(locale: string, state: ResearchPageState = {}): string {
  const query = new URLSearchParams();
  if (state.research !== undefined && state.research !== null && state.research !== "") query.set("research", state.research);
  if (state.from !== undefined && state.from !== null && state.from !== "") query.set("from", state.from);
  if (state.window === "all") query.set("w", "all");
  if (state.listed !== undefined && state.listed > CONVERSATIONS_PAGE) query.set("n", String(Math.min(CONVERSATIONS_MAX, state.listed)));
  if (state.view === "conversations" || state.view === "stats") query.set("view", state.view);
  const search = query.toString();
  return `/${locale}/research${search.length === 0 ? "" : `?${search}`}`;
}

/** The page's state as its URL carries it; anything else reads as the default. `n` is counted in steps of twenty. */
export function researchPageStateOf(query: PageQuery): Required<ResearchPageState> {
  const one = (key: string): string => (typeof query[key] === "string" ? (query[key] as string) : "");
  const n = /^\d+$/.test(one("n")) ? Number(one("n")) : CONVERSATIONS_PAGE;
  return {
    research: one("research") === "" ? null : one("research"),
    from: one("from") === "" ? null : one("from"),
    window: one("w") === "all" ? "all" : "month",
    listed: Math.min(CONVERSATIONS_MAX, Math.max(CONVERSATIONS_PAGE, Math.ceil(n / CONVERSATIONS_PAGE) * CONVERSATIONS_PAGE)),
    view: one("view") === "conversations" ? "conversations" : one("view") === "stats" ? "stats" : "dock",
  };
}

/** Where a research's links into the book are made: the Research page, or the Research dock with its open research (unit 77). */
export interface ResearchRefBase {
  readonly locale: string;
  /** The Research dock's `research` value, so the dock stays open where the link leads; null on the Research page, which holds its own column. */
  readonly research: string | null;
}

const SECTION = /^\d{2}\.[1-9]$/;

/**
 * A section in a research — a report's chip, a finding's anchor, a refusal's pointer (§ 11.3): the reader at that
 * section, with no dock parameter from the Research page, and with `research=<id>` from the Research dock so the dock
 * stays open there. Any other id is the book's resolver's. The Assistant's `refHref` would add `?ask=`, which opens the
 * Assistant's dock on a research's link.
 */
export function researchRefHref(base: ResearchRefBase, id: string): string {
  if (!SECTION.test(id)) return `/${base.locale}/ref/${encodeURIComponent(id)}`;
  const reader = `/${base.locale}/ch/${id.slice(0, 2)}/${id}`;
  return base.research === null ? reader : `${reader}?research=${encodeURIComponent(base.research)}`;
}

/** A run's page row (§ 11.3): every run of a research is one log and numbers its pages from 1, so the id names the run as well as the page. */
export function runPageId(runId: string, n: number): string {
  return `run-${runId}-page-${String(n)}`;
}

/** `href` with the Research dock's `research` set (§ 12; unit 77): the page the dock is on may carry parameters of its own. */
export function withResearch(href: string, research: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}research=${encodeURIComponent(research)}`;
}

/**
 * The page's own URL without the Research dock's parameter: where closing the dock returns to (§ 12). Only `research`
 * leaves, so the Assistant page under the dock keeps its open conversation (`ask`), and step 1 or the Rubric page their
 * way back (`from`).
 */
export function researchDockCloseHref(locale: string, path: ReadonlyArray<string>, query: PageQuery): string {
  const kept = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "research" || value === undefined) continue;
    for (const entry of typeof value === "string" ? [value] : value) kept.append(key, entry);
  }
  const search = kept.toString();
  return `/${[locale, ...path].join("/")}${search.length === 0 ? "" : `?${search}`}`;
}

/** The two docks on every page (§ 12): the Assistant's, opened by `a` and `ask`, and research's, opened by `r` and `research`. */
export type DockName = "assistant" | "research";

/** The page a path is under its locale (`/en/assistant/…` is `assistant`), as the slot's mounts read the path's first segment. */
function pageOfPath(pathname: string): string {
  return pathname.split("/")[2] ?? "";
}

/** The other dock's parameters on this page, unless the page holds them as its own state: `ask` and `draft` on `/assistant`, `research` on `/research`. */
function otherDockParams(pathname: string, dock: DockName): ReadonlyArray<string> {
  const page = pageOfPath(pathname);
  if (dock === "research") return page === "assistant" ? [] : ["ask", "draft"];
  return page === "research" ? [] : ["research"];
}

/**
 * The URL a dock's key opens it at, empty (§ 12): its own parameter set afresh, and the other dock's dropped unless they
 * are the page's own state, where the dock opens over the page and the page keeps its conversation or its research —
 * `r` on `/assistant?ask=<id>`, `a` on `/research?research=<id>`. Nothing else is touched: no key drops `from`. `href` is
 * a path with its search, as `location` gives them.
 */
export function openDockHref(href: string, dock: DockName): string {
  const url = new URL(href, "http://dock.invalid");
  const own = dock === "research" ? ["research"] : ["ask", "draft"];
  for (const key of [...own, ...otherDockParams(url.pathname, dock)]) url.searchParams.delete(key);
  url.searchParams.append(dock === "research" ? "research" : "ask", "1");
  return `${url.pathname}${url.search}`;
}

/**
 * With a key's own dock already on the page, the URL that closes the other dock open over it, so the key's dock takes its
 * place (§ 12: "`a` with the research dock open opens the Assistant's in its place, and `r` likewise"); null when no
 * other dock is open. Only the Assistant page's column and the Research page's can stand under the other dock, since
 * elsewhere one dock at a time is ever rendered.
 */
export function otherDockClosedHref(href: string, dock: DockName): string | null {
  const url = new URL(href, "http://dock.invalid");
  const other = otherDockParams(url.pathname, dock);
  if (!other.some((key) => url.searchParams.has(key))) return null;
  for (const key of other) url.searchParams.delete(key);
  return `${url.pathname}${url.search}`;
}
