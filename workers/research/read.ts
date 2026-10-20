import { ApplicationFailure } from "@temporalio/activity";

import { readResearchBrief, readResearchSections, writeBudgetMark, writeResearchCounts, writeResearchFound, type ResearchRunRow, type ResearchSection } from "@/lib/db/research";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { loadGuidePart, type Guide } from "@/lib/guides/load";
import type { Principal } from "@/lib/schemas/gateway";
import type { Rubric } from "@/lib/schemas/rubric";
import { defaultReaderDeps, read, type Read, type ReaderDeps, type ReaderInput } from "@/workers/agents/researcher/reader";

import { currentRubric, RESEARCHER_GUIDE_VERSION, researchPrincipalOf } from "./plan";

/*
 * The reader's step of a run (feature-specs/41 § 6; unit 58d), the activity's own code: the brief read back inside
 * the asker's context, the cited sections read at the run's release, the reader called once with the reader part of
 * the researcher's guide and the rubric in force, and what it found left on the run — the findings as written and
 * the pages the tools saw — for the validation and the submission, with the run's counts of searches and page reads.
 * The reader is given every section the answer cited: the planner's targets are among them and the brief says which
 * matter, and an anchor in any of them is one the reader was given (41 § 7). What comes back to the activity is the
 * count of findings, or the cap with its reset and the `budget` mark written (40 § 7.2). Every failure is an
 * `ApplicationFailure` with a code and no text: `READER_FAILED` for the agent's one failure, `TEXT_PURGED` where the
 * brief is gone, `RESEARCH_UNCONFIGURED` without a principal.
 */

export type ReadStep = { readonly findings: number; readonly searches: number; readonly pageReads: number } | { readonly planned: "budget"; readonly resetsAt: string; readonly waitMs: number };

export interface ReadStepDeps {
  readonly principal: () => Principal | null;
  readonly guide: () => Guide;
  readonly rubric: () => Promise<Rubric | null>;
  readonly readBrief: typeof readResearchBrief;
  readonly readSections: (releaseId: string, anchors: ReadonlyArray<string>) => Promise<ReadonlyArray<ResearchSection>>;
  readonly read: (input: Parameters<typeof read>[0], deps: ReaderDeps) => Promise<Read>;
  readonly reader: ReaderDeps;
  readonly writeFound: typeof writeResearchFound;
  /** The counts alone, for a turn that failed after the provider ran searches: they were charged (review of units 57–58). */
  readonly writeCounts: typeof writeResearchCounts;
  readonly writeBudgetMark: typeof writeBudgetMark;
  readonly log: (line: string) => void;
  readonly now: () => Date;
}

export function defaultReadStepDeps(): ReadStepDeps {
  return {
    principal: () => researchPrincipalOf(),
    guide: () => loadGuidePart("researcher", RESEARCHER_GUIDE_VERSION, "reader"),
    rubric: currentRubric,
    readBrief: readResearchBrief,
    readSections: readResearchSections,
    read,
    reader: defaultReaderDeps(),
    writeFound: writeResearchFound,
    writeCounts: writeResearchCounts,
    writeBudgetMark,
    log: (line) => console.info(line),
    now: () => new Date(),
  };
}

function fail(type: string, message: string): never {
  throw ApplicationFailure.create({ type, message, nonRetryable: true });
}

export async function readStep(run: ResearchRunRow, deps: ReadStepDeps = defaultReadStepDeps()): Promise<ReadStep> {
  const principal = deps.principal();
  if (principal === null) fail("RESEARCH_UNCONFIGURED", "RESEARCH_PRINCIPAL is not set: a run cannot call a model (feature-specs/40 § 7.1)");
  const brief = await deps.readBrief(run);
  if (brief === null) fail("TEXT_PURGED", `research run ${run.id}: the brief is gone`);
  const [sections, rubric] = await Promise.all([deps.readSections(run.releaseId, run.sectionAnchors), deps.rubric()]);
  const now = deps.now();
  const prompt: ReaderInput = { guide: deps.guide(), rubric, today: now.toISOString().slice(0, 10), sections, brief };

  let answer: Read;
  try {
    answer = await deps.read({ prompt, call: { principal, traceId: run.traceId, ref: run.id } }, deps.reader);
  } catch (error: unknown) {
    if (!(error instanceof BudgetExceededError)) throw error;
    await deps.writeBudgetMark(now, error.resetsAt);
    deps.log(`research ${run.id}: the reader met the cap; waiting until ${error.resetsAt.toISOString()} (trace ${run.traceId})`);
    return { planned: "budget", resetsAt: error.resetsAt.toISOString(), waitMs: Math.max(0, error.resetsAt.getTime() - now.getTime()) };
  }
  if (!answer.ok) {
    /* the provider charged the searches the turn made before it failed: the run and its record say so */
    await deps.writeCounts(run, { searches: answer.searches, pageReads: answer.fetches });
    deps.log(`research ${run.id}: the reader failed — ${answer.failure} (${String(answer.searches)} searches, ${String(answer.fetches)} fetches; trace ${run.traceId})`);
    fail("READER_FAILED", answer.failure);
  }
  /* the counts first, unguarded: a run whose conversation was deleted while the reader ran still says what the provider charged (45 § 3.5) */
  await deps.writeCounts(run, { searches: answer.searches, pageReads: answer.fetches });
  const { written } = await deps.writeFound(run, { findings: answer.output.findings, pages: [...answer.pages] });
  if (!written) fail("TEXT_PURGED", `research run ${run.id}: its text was purged while the reader ran`);
  deps.log(`research ${run.id}: the reader found ${String(answer.output.findings.length)} finding${answer.output.findings.length === 1 ? "" : "s"} over ${String(answer.searches)} searches and ${String(answer.fetches)} fetches (trace ${run.traceId})`);
  return { findings: answer.output.findings.length, searches: answer.searches, pageReads: answer.fetches };
}
