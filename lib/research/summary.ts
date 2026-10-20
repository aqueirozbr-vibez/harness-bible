import { USED_STATES } from "@/lib/research/runBlock";
import type { ResearchRunView } from "@/lib/schemas/api";

/*
 * A research's line in the Research page's list (feature-specs/48 § 11.4): its label is the chapters of its runs'
 * sections, never the person's words (spec 23 D8), so it survives the 30-day purge; its meta says when it last ran, how
 * many runs it has, how many findings passed the checks — the run's line's count — and, where any was, how many of them
 * were turned into improvements, whether it began from an Assistant answer, and whether its words are gone. The list is the server's (`listResearchConversations`); a research created by its
 * first question has no row there until the page refreshes, so its line is built here from the column's own runs, by
 * the rules the door counts with, and stands first where the server will put it — as `lineOfTurns` does for the
 * Assistant (lib/assistant/summary.ts).
 */

export interface ResearchConversationLine {
  readonly id: string;
  /** The chapters of its runs' sections (the planners' targets), in order of first appearance. */
  readonly chapters: ReadonlyArray<number>;
  /** When its newest run was started, or when it was opened. */
  readonly lastRunAt: string;
  readonly runs: number;
  /** Its findings that passed the checks, as each run's line counts them. */
  readonly findings: number;
  /** Of those, the ones drafted or sent to Improve. */
  readonly used: number;
  /** Seeded from an Assistant answer (A6). */
  readonly seeded: boolean;
  /** Every run's words removed after 30 days (§ 17.1). */
  readonly textPurged: boolean;
}

/** The chapters of some section ids, in order of first appearance: `["21.3", "20.1", "21.4"]` → `[21, 20]`. */
export function chaptersOfSections(sections: ReadonlyArray<string>): ReadonlyArray<number> {
  return [...new Set(sections.map((section) => Number(section.slice(0, 2))).filter((chapter) => Number.isInteger(chapter)))];
}

/** `now` is the caller's clock: a research whose first question was just asked has no stored run yet. */
export function lineOfRuns(id: string, runs: ReadonlyArray<Pick<ResearchRunView, "sections" | "findings" | "createdAt" | "textPurged">>, seeded: boolean, now: string): ResearchConversationLine {
  return {
    id,
    chapters: chaptersOfSections(runs.flatMap((run) => run.sections.map((section) => section.id))),
    lastRunAt: runs.at(-1)?.createdAt ?? now,
    runs: runs.length,
    findings: runs.reduce((sum, run) => sum + run.findings.length, 0),
    used: runs.reduce((sum, run) => sum + run.findings.filter((finding) => USED_STATES.has(finding.use.state)).length, 0),
    seeded,
    textPurged: runs.length > 0 && runs.every((run) => run.textPurged),
  };
}
