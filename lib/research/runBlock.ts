import { hostOf } from "@/lib/research/runView";
import type { ReportParagraph, ResearchStep } from "@/lib/schemas/researcher";
import type { ResearchFindingView, ResearchRunLine, ResearchRunView } from "@/lib/schemas/api";

/*
 * What the Research page's run block says, decided here and worded by the catalogue (feature-specs/48 § 11.3, § 18,
 * § 19; unit 72), pure: the run's line as a word, how its detail joins it and the detail's values; each live step as a
 * key and its values; the steps' counts for their caption; a report paragraph cut into its text and its page
 * references; and the line a finding's use reads where the run block shows no button (unit 74 adds the buttons). The
 * components format the dates and the catalogue the words, so nothing here is a sentence.
 */

/** The words of `research.line.word.*`: the line's state as a status mark (§ 18). */
export type RunWordKey = "queued" | "planning" | "reading" | "checking" | "writing" | "done" | "refused" | "notStarted" | "stopped" | "failed" | "notRun";

/** The line's parts: the word, then its detail — after a `·`, or joined to the word as its object (`reading the web`). */
export interface RunLineParts {
  readonly word: RunWordKey;
  readonly tone: ResearchRunLine["tone"];
  readonly detail: { readonly key: string; readonly joined: boolean; readonly values: Readonly<Record<string, number>>; readonly date: string | null } | null;
}

/** Each of the fourteen line keys' word (§ 18): a stale run, an abandoned one and one a delete or the seed's loss stopped all read `stopped`. */
const WORD_OF: Readonly<Record<ResearchRunLine["key"], RunWordKey>> = {
  queued: "queued",
  planning: "planning",
  reading: "reading",
  checking: "checking",
  writing: "writing",
  done: "done",
  donePurged: "done",
  refused: "refused",
  notStarted: "notStarted",
  stopped: "stopped",
  failed: "failed",
  abandoned: "stopped",
  purged: "stopped",
  notRun: "notRun",
};

/** A line key's word: the run's state as the person reads it, which the statistics count their ends by too (§ 11.6; unit 73). */
export function runWordOf(key: ResearchRunLine["key"]): RunWordKey {
  return WORD_OF[key];
}

/**
 * A run's line (§ 18, § 20): its words change once a state, never once a poll, so the counts that grow during the read
 * are the steps' caption's and never the line's. `done` counts the findings that passed and the pages read; once the
 * text is purged the pages read are no longer known, and the pages opened are counted instead. A reset's date is the
 * component's to format.
 */
export function runLinePartsOf(run: Pick<ResearchRunView, "line" | "findings" | "pages" | "usage" | "resetsAt">): RunLineParts {
  const { key, tone } = run.line;
  const word = runWordOf(key);
  const plain = (detail: string, joined: boolean): RunLineParts => ({ word, tone, detail: { key: detail, joined, values: {}, date: null } });
  switch (key) {
    case "planning":
      return plain("planning", false);
    case "reading":
    case "checking":
    case "writing":
      return plain(key, true);
    case "done":
      return { word, tone, detail: { key: "done", joined: false, values: { f: run.findings.length, p: run.pages.length }, date: null } };
    case "donePurged":
      return { word, tone, detail: { key: "donePurged", joined: false, values: { f: run.findings.length, o: run.usage.pagesOpened }, date: null } };
    case "notStarted":
    case "stopped":
      return { word, tone, detail: run.resetsAt === null ? null : { key, joined: false, values: {}, date: run.resetsAt } };
    case "abandoned":
      return plain("abandoned", false);
    case "purged":
      return plain("purged", false);
    case "queued":
    case "refused":
    case "failed":
    case "notRun":
      return { word, tone, detail: null };
    default: {
      const never: never = key;
      return never;
    }
  }
}

/** Under way: a run its workflow still moves, which only the newest of a research can be (§ 5.2, § 6). A stale run is not. */
export function runUnderWay(run: Pick<ResearchRunView, "line" | "stale">): boolean {
  return run.line.tone === "run" && !run.stale;
}

/** A live step's words (`research.steps.*`) and their values (§ 6, § 19). */
export interface StepLine {
  readonly key: "planning" | "sections" | "searchPending" | "search" | "pagePending" | "page" | "pageUntitled" | "unreachable" | "checking" | "writing";
  readonly values: Readonly<Record<string, string | number>>;
}

/** One step as its row reads: a search with its results once they arrived, a page by its host, then what opened. */
export function stepLineOf(step: ResearchStep): StepLine {
  switch (step.kind) {
    case "PLANNING":
      return { key: "planning", values: {} };
    case "SECTIONS":
      return { key: "sections", values: { ids: step.sections.join(" · ") } };
    case "SEARCH":
      return step.results === null ? { key: "searchPending", values: { query: step.query } } : { key: "search", values: { query: step.query, n: step.results } };
    case "PAGE": {
      const host = hostOf(step.url);
      if (step.opened === null) return { key: "pagePending", values: { host } };
      if (!step.opened) return { key: "unreachable", values: { host } };
      return step.title === null || step.title.trim() === "" ? { key: "pageUntitled", values: { host } } : { key: "page", values: { host, title: step.title } };
    }
    case "CHECKING":
      return { key: "checking", values: {} };
    case "WRITING":
      return { key: "writing", values: {} };
    default: {
      const never: never = step;
      return never;
    }
  }
}

/** The steps' caption's counts (§ 11.3): the searches and the pages asked for so far. */
export function stepCountsOf(steps: ReadonlyArray<ResearchStep>): { readonly searches: number; readonly pages: number } {
  return { searches: steps.filter((step) => step.kind === "SEARCH").length, pages: steps.filter((step) => step.kind === "PAGE").length };
}

/** A piece of a report paragraph: its own words, or a page it cites, which renders as `[n]` linked to the page's row. */
export type ReportPiece = { readonly kind: "text"; readonly text: string } | { readonly kind: "page"; readonly n: number };

const PAGE_MARKER = /\[(\d+)\]/g;

/**
 * A report paragraph as the page renders it (§ 5.7, § 11.3): its text cut at each `[n]` the run has a page for, so that
 * the paragraph is plain text with no link but its page numbers; then the pages its `pages` names that its text does not
 * mark, appended as markers of their own. A marker for a page the run does not have stays text: the report sensor drops
 * such a paragraph, and nothing may point nowhere.
 */
export function reportPiecesOf(paragraph: Pick<ReportParagraph, "text" | "pages">, pages: ReadonlySet<number>): { readonly pieces: ReadonlyArray<ReportPiece>; readonly trailing: ReadonlyArray<number> } {
  const pieces: ReportPiece[] = [];
  const marked = new Set<number>();
  let at = 0;
  for (const match of paragraph.text.matchAll(PAGE_MARKER)) {
    const n = Number(match[1]);
    if (!pages.has(n)) continue;
    const start = match.index;
    if (start > at) pieces.push({ kind: "text", text: paragraph.text.slice(at, start) });
    pieces.push({ kind: "page", n });
    marked.add(n);
    at = start + match[0].length;
  }
  if (at < paragraph.text.length) pieces.push({ kind: "text", text: paragraph.text.slice(at) });
  return { pieces, trailing: [...new Set(paragraph.pages)].filter((n) => pages.has(n) && !marked.has(n)) };
}

/**
 * `Copy report` (§ 11.9; unit 73): what the report shows, as text. Each paragraph as it reads — its words with the `[n]`
 * its text holds, the pages it cites that its text does not mark appended as `[n]`, and the sections it cites as
 * `[21.3]`, the form `Copy with citations` gives a section (lib/assistant/turns.ts) — then, after a blank line, the
 * numbered list of the pages the paragraphs cite, each `[n]` with its title where it has one and its address, in the
 * run's own numbering, so every marker copied finds its page. A page the run does not have is no marker, as on screen.
 * Empty for a run with no report.
 */
export function copyReportOf(run: Pick<ResearchRunView, "report" | "pages">): string {
  if (run.report === null) return "";
  const known = new Set(run.pages.map((page) => page.n));
  const cited = new Set<number>();
  const paragraphs = run.report.paragraphs.map((paragraph) => {
    const { pieces, trailing } = reportPiecesOf(paragraph, known);
    for (const piece of pieces) if (piece.kind === "page") cited.add(piece.n);
    for (const n of trailing) cited.add(n);
    return [paragraph.text, ...trailing.map((n) => `[${String(n)}]`), ...paragraph.sections.map((section) => `[${section}]`)].join(" ");
  });
  const list = run.pages.filter((page) => cited.has(page.n)).map((page) => `[${String(page.n)}] ${page.title === null ? page.url : `${page.title} · ${page.url}`}`);
  return [...paragraphs, ...(list.length === 0 ? [] : [list.join("\n")])].join("\n\n");
}

/** What a finding's use reads where the run block shows no button (§ 8.1, § 11.3): its outcome's line, or nothing for one still to use. */
export interface FindingUseLine {
  readonly key: "drafted" | "sent" | "proposed" | "refuted" | "duplicate" | "duplicateHidden" | "purged";
  readonly values: Readonly<Record<string, string>>;
}

export function findingUseLineOf(finding: Pick<ResearchFindingView, "use" | "textPurged">): FindingUseLine | null {
  const { state, suggestionId } = finding.use;
  switch (state) {
    /* unused: its button's place (unit 74); once the text is gone it can no longer be used, and says so */
    case "VALID":
      return finding.textPurged ? { key: "purged", values: {} } : null;
    case "DRAFTED":
      return { key: "drafted", values: { id: suggestionId ?? "—" } };
    case "SENT":
      return { key: "sent", values: {} };
    case "PROPOSED":
      return { key: "proposed", values: {} };
    case "REFUTED":
      return { key: "refuted", values: {} };
    /* a duplicate's id only where it is the person's to see, which the view has already decided (§ 8.5) */
    case "DUPLICATE":
      return suggestionId === null ? { key: "duplicateHidden", values: {} } : { key: "duplicate", values: { id: suggestionId } };
    default: {
      const never: never = state;
      return never;
    }
  }
}

/** The uses that count as a finding turned into an improvement, for a research's line in the list (§ 11.4): drafted, or sent whatever became of it. */
export const USED_STATES: ReadonlySet<ResearchFindingView["use"]["state"]> = new Set(["DRAFTED", "SENT", "DUPLICATE", "PROPOSED", "REFUTED"]);
