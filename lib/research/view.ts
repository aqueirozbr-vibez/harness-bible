import type { ProposalView, ResearchView } from "@/lib/schemas/api";
import { BUDGET_MARK, markOfQuestion, markOfSection, RESEARCH_RUNS_PER_DAY, type ResearchSkip, type ResearchState, type ResearchStarted } from "@/lib/schemas/research";

/*
 * The run as the line under an answer reads it (feature-specs/43 § 4; unit 60a), pure. Two things are built here: the
 * view — the state and skip of the run's row, the whole days since the sections or the question were researched (a
 * skip's number, from the platform's marks), the budget's reset (the `budget` mark's `until`), the proposals — and the
 * line, one key per state or skip of spec 40 § 3 with the hue of its mark and the numbers its words take, which the
 * dock's component renders from the catalogue. Every state and skip has a line (43 § 4.2); a refusal's run has none,
 * and the dock never asks for one.
 */

const DAY_MS = 86_400_000;

/**
 * A mark as the platform keeps it (40 § 3): when it was set, and until when it holds where that is said. The line reads
 * the marks (a skip's days, the budget's reset); it lives here since unit 70, which moved it out of `eligibility.ts`
 * ahead of that file's removal with the hand-over in unit 75 (feature-specs/48 § 9.2).
 */
export interface ResearchMarkRow {
  readonly key: string;
  readonly at: Date;
  readonly until: Date | null;
}

/** Whole days from `at` to `now`, never negative: the account page's way of counting. */
export function daysAgo(at: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY_MS));
}

export interface RunForView {
  readonly state: ResearchState;
  readonly skip: ResearchSkip | null;
  readonly sectionAnchors: ReadonlyArray<string>;
  readonly questionSha256: string;
}

/**
 * The days a skip's line names: for `DEDUPED` the most recent research of any cited section (the marks are overwritten
 * by every later run, so this is "most recently researched"), for `SAME_QUESTION` the question's mark; null otherwise
 * or when no mark stands.
 */
export function daysOf(run: Pick<RunForView, "skip" | "sectionAnchors" | "questionSha256">, marks: ReadonlyArray<ResearchMarkRow>, now: Date): number | null {
  if (run.skip === "SAME_QUESTION") {
    const mark = marks.find((candidate) => candidate.key === markOfQuestion(run.questionSha256));
    return mark === undefined ? null : daysAgo(mark.at, now);
  }
  if (run.skip === "DEDUPED") {
    const keys = new Set(run.sectionAnchors.map(markOfSection));
    const newest = marks.filter((candidate) => keys.has(candidate.key)).map((candidate) => candidate.at.getTime());
    return newest.length === 0 ? null : daysAgo(new Date(Math.max(...newest)), now);
  }
  return null;
}

/** The budget's reset the line names, for a turn skipped at the cap and a run waiting for it; null otherwise. */
export function resetsAtOf(run: Pick<RunForView, "state" | "skip">, marks: ReadonlyArray<ResearchMarkRow>): Date | null {
  if (run.state !== "WAITING_BUDGET" && run.skip !== "BUDGET") return null;
  const mark = marks.find((candidate) => candidate.key === BUDGET_MARK);
  return mark?.until ?? null;
}

/** The view of a run's row with the marks that stand and its proposals, as the asker is shown them (43 § 5.3; unit 60b). */
export function researchViewOf(run: RunForView, marks: ReadonlyArray<ResearchMarkRow>, proposals: ReadonlyArray<ProposalView>, now: Date): ResearchView {
  const resetsAt = resetsAtOf(run, marks);
  return { state: run.state, skip: run.skip, days: daysOf(run, marks, now), resetsAt: resetsAt === null ? null : resetsAt.toISOString(), proposals: [...proposals] };
}

/** The view the `final` event seeds (40 § 6.1 step 4): the run's state and skip with their numbers, no proposal yet. */
export function researchViewOfStarted(started: ResearchStarted): ResearchView {
  /* a `final` of workers older than the web (or replayed from before unit 60a) has neither number: none, not undefined (review of unit 60) */
  return { state: started.state, skip: started.skip, days: started.days ?? null, resetsAt: started.resetsAt ?? null, proposals: [] };
}

/** The line's keys, one per row of 43 § 4.2; `none` is a refusal's run, which has no line. */
export const RESEARCH_LINE_KEYS = ["queued", "reading", "checking", "proposals", "nothing", "waiting", "budget", "deduped", "sameQuestion", "dailyLimit", "noCitation", "off", "offOrganisation", "notRun", "failed", "none"] as const;
export type ResearchLineKey = (typeof RESEARCH_LINE_KEYS)[number];

/** The hue of the line's mark (ui-context § 6): running with the caret, a proposal, a wait, or quiet. */
export type ResearchLineTone = "run" | "ok" | "warn" | "mute";

export interface ResearchLine {
  readonly key: ResearchLineKey;
  readonly tone: ResearchLineTone;
  /** The run is not over: the dock asks again (43 § 4.3, D1). */
  readonly follow: boolean;
  /** The numbers the words take: a count of proposals or of the day's runs, the days, the reset. */
  readonly n: number | null;
  readonly days: number | null;
  readonly resetsAt: Date | null;
}

const SKIP_LINES: Readonly<Record<ResearchSkip, { readonly key: ResearchLineKey; readonly tone: ResearchLineTone }>> = {
  OFF_USER: { key: "off", tone: "mute" },
  OFF_ORGANISATION: { key: "offOrganisation", tone: "mute" },
  NOT_AN_ANSWER: { key: "none", tone: "mute" },
  NO_CITATION: { key: "noCitation", tone: "mute" },
  DEDUPED: { key: "deduped", tone: "mute" },
  SAME_QUESTION: { key: "sameQuestion", tone: "mute" },
  DAILY_LIMIT: { key: "dailyLimit", tone: "mute" },
  BUDGET: { key: "budget", tone: "mute" },
  NOTHING_TO_RESEARCH: { key: "nothing", tone: "mute" },
  TEXT_PURGED: { key: "notRun", tone: "mute" },
  UNAVAILABLE: { key: "notRun", tone: "mute" },
};

export function researchLineOf(view: ResearchView): ResearchLine {
  const resetsAt = typeof view.resetsAt === "string" ? new Date(view.resetsAt) : null;
  const base = { n: null, days: view.days ?? null, resetsAt, follow: false };
  switch (view.state) {
    case "QUEUED":
    case "PLANNING":
      return { ...base, key: "queued", tone: "run", follow: true };
    case "READING":
      return { ...base, key: "reading", tone: "run", follow: true };
    case "VALIDATING":
    case "SUBMITTING":
    case "WRITING":
      return { ...base, key: "checking", tone: "run", follow: true };
    case "WAITING_BUDGET":
      return { ...base, key: "waiting", tone: "warn" };
    case "FAILED":
      return { ...base, key: "failed", tone: "mute" };
    /* a person's run's state (feature-specs/48 § 5); a run of an answered turn never reaches it */
    case "REFUSED":
      return { ...base, key: "notRun", tone: "mute" };
    case "DONE":
      return view.proposals.length === 0 ? { ...base, key: "nothing", tone: "mute" } : { ...base, key: "proposals", tone: "ok", n: view.proposals.length };
    case "SKIPPED": {
      const line = SKIP_LINES[view.skip ?? "UNAVAILABLE"];
      /* a legacy `off` reads `off` alone: the account page's switch it offered went in unit 75 (feature-specs/48 § 9.3, § 9.4) */
      return { ...base, key: line.key, tone: line.tone, n: line.key === "dailyLimit" ? RESEARCH_RUNS_PER_DAY : null };
    }
  }
}
