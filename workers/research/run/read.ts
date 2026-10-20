import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { ApplicationFailure } from "@temporalio/activity";

import { readResearchBrief, readResearchSections, writeResearchCounts, writeResearchFound, type ConversationRunRow, type ResearchSection } from "@/lib/db/research";
import { BudgetExceededError } from "@/lib/gateway/errors";
import { turnCountsOf } from "@/lib/gateway/turn";
import { loadGuidePart, type Guide } from "@/lib/guides/load";
import type { Rubric } from "@/lib/schemas/rubric";
import { defaultReaderDeps, read, type Read, type ReadInput, type ReaderDeps, type ReaderInput } from "@/workers/agents/researcher/v2/reader";
import { currentRubric } from "@/workers/research/plan";

import { principalOfRun, RESEARCHER_V2_GUIDE_VERSION } from "./plan";

/*
 * The read of a person's run (feature-specs/48 § 5.4; unit 70b), the activity's own code: the brief read back inside
 * the asker's context, the targets' sections — at most three, not every section of the run — read at the run's
 * release, the reader called once with the reader part of the guide's version 2 and the rubric in force, its blocks
 * handed to the run's live steps as the stream completes them (`onBlock`, § 6), and what it found left on the run for
 * the check and the writer: the findings and the notes as the reader wrote them, every `https` address the tools saw
 * (`pages`) and every page the turn saw in order (`read`). The run's counts of searches and page reads are written
 * whatever the turn ended as, since the provider charged them: before the run ends `FAILED · BUDGET` when a request
 * met the person's cap, read from the error with `turnCountsOf`, and before `FAILED · READER_FAILED`. Every failure is
 * an `ApplicationFailure` with a code and no text: `READER_FAILED` for the agent's one failure, `TEXT_PURGED` where the
 * brief is gone or the text went while the reader ran. The live steps' chain is the caller's to await before `found`
 * is stored, which `settled` does here.
 *
 * `signal` is the activity's cancellation (48 § 5.1; review of unit 70). The reader's streams are sent with it, so a
 * cancelled run stops reading; and once it has fired nothing more is written — neither the counts nor `found` — since
 * the workflow has already concluded the run, `FAILED · CANCELLED` or `SKIPPED · TEXT_PURGED`, with its record: the
 * step fails `CANCELLED` instead, which nobody awaits.
 */

export type ReadRunStep = { readonly read: "found"; readonly findings: number; readonly searches: number; readonly pageReads: number } | { readonly read: "budget"; readonly resetsAt: Date; readonly searches: number; readonly pageReads: number };

export interface ReadRunDeps {
  readonly guide: () => Guide;
  readonly rubric: () => Promise<Rubric | null>;
  readonly readBrief: typeof readResearchBrief;
  readonly readSections: (releaseId: string, anchors: ReadonlyArray<string>) => Promise<ReadonlyArray<ResearchSection>>;
  readonly read: (input: ReadInput, deps: ReaderDeps) => Promise<Read>;
  readonly reader: ReaderDeps;
  readonly writeFound: typeof writeResearchFound;
  readonly writeCounts: typeof writeResearchCounts;
  readonly log: (line: string) => void;
  readonly now: () => Date;
}

export function defaultReadRunDeps(): ReadRunDeps {
  return {
    guide: () => loadGuidePart("researcher", RESEARCHER_V2_GUIDE_VERSION, "reader"),
    rubric: currentRubric,
    readBrief: readResearchBrief,
    readSections: readResearchSections,
    read,
    reader: defaultReaderDeps(),
    writeFound: writeResearchFound,
    writeCounts: writeResearchCounts,
    log: (line) => console.info(line),
    now: () => new Date(),
  };
}

function fail(type: string, message: string): never {
  throw ApplicationFailure.create({ type, message, nonRetryable: true });
}

/** The live steps the read feeds (./steps.ts): each block as it completes, and the chain's end. */
export interface ReadSteps {
  readonly onBlock: (block: ContentBlock) => void;
  readonly settled: () => Promise<void>;
}

export async function readRunStep(run: ConversationRunRow, steps: ReadSteps, deps: ReadRunDeps = defaultReadRunDeps(), signal?: AbortSignal): Promise<ReadRunStep> {
  /* the run cancelled while the reader ran: the workflow ended it, with its record, so nothing more goes onto the row */
  const ended = (what: string): void => {
    if (signal?.aborted === true) fail("CANCELLED", `research run ${run.id}: cancelled while the reader ran; ${what} not written`);
  };
  const brief = await deps.readBrief(run);
  if (brief === null) fail("TEXT_PURGED", `research run ${run.id}: the brief is gone`);
  const [sections, rubric] = await Promise.all([deps.readSections(run.releaseId, run.targetAnchors), deps.rubric()]);
  const prompt: ReaderInput = { guide: deps.guide(), rubric, today: deps.now().toISOString().slice(0, 10), sections, brief };

  let answer: Read;
  try {
    answer = await deps.read({ prompt, call: { principal: principalOfRun(run), traceId: run.traceId, ref: run.id }, onBlock: steps.onBlock, ...(signal === undefined ? {} : { signal }) }, deps.reader);
  } catch (error: unknown) {
    if (!(error instanceof BudgetExceededError)) throw error;
    ended("the counts");
    /* a request after the first may have met the cap: what the ones before it searched was charged (48 § 5.4) */
    const counts = turnCountsOf(error) ?? { searches: 0, fetches: 0 };
    await deps.writeCounts(run, { searches: counts.searches, pageReads: counts.fetches });
    await steps.settled();
    deps.log(`research ${run.id}: the reader met the person's cap; the run ends with what it has, resets ${error.resetsAt.toISOString()} (trace ${run.traceId})`);
    return { read: "budget", resetsAt: error.resetsAt, searches: counts.searches, pageReads: counts.fetches };
  }
  ended("the counts");
  /* the counts first, unguarded: a run whose research was deleted while the reader ran still says what the provider charged */
  await deps.writeCounts(run, { searches: answer.searches, pageReads: answer.fetches });
  await steps.settled();
  ended("found");
  if (!answer.ok) {
    deps.log(`research ${run.id}: the reader failed — ${answer.failure} (${String(answer.searches)} searches, ${String(answer.fetches)} fetches; trace ${run.traceId})`);
    fail("READER_FAILED", answer.failure);
  }
  const { written } = await deps.writeFound(run, { findings: answer.output.findings, pages: [...answer.pages], notes: answer.output.notes, read: [...answer.read] });
  if (!written) fail("TEXT_PURGED", `research run ${run.id}: its text was purged while the reader ran`);
  deps.log(`research ${run.id}: the reader found ${String(answer.output.findings.length)} finding${answer.output.findings.length === 1 ? "" : "s"} and ${String(answer.output.notes.length)} note${answer.output.notes.length === 1 ? "" : "s"} over ${String(answer.searches)} searches and ${String(answer.fetches)} fetches (trace ${run.traceId})`);
  return { read: "found", findings: answer.output.findings.length, searches: answer.searches, pageReads: answer.fetches };
}
