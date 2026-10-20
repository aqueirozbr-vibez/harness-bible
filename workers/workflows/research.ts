import { ActivityFailure, ApplicationFailure, defineQuery, log, ParentClosePolicy, patched, proxyActivities, setHandler, sleep, startChild } from "@temporalio/workflow";

import { RESEARCH_STAGE_QUERY, ResearchWorkflowInputSchema, type ResearchWorkflowInput, type ResearchWorkflowResult } from "@/lib/schemas/workflows";
import type { ResearchState } from "@/lib/schemas/research";
import { SuggestionIdSchema } from "@/lib/schemas/ids";
import { suggestionWorkflowId } from "@/lib/schemas/workflows";
import { nextOutcomesWaitMs, OUTCOMES_EVERY_MS, OUTCOMES_FOR_MS } from "@/workers/research/pace";

import type { ResearchActivities } from "./activities";
import { SuggestionWorkflow } from "./suggestion";

/*
 * ResearchWorkflow (feature-specs/40 § 6.2; unit 57d), under `research:<messageId>`: load, plan, read, validate, submit,
 * conclude. Each agent has one attempt (invariant 15): the planner's or the reader's failure ends the run FAILED with a
 * code, and the marks stay. At the cap the run becomes WAITING_BUDGET and sleeps until the reset the activity gave
 * (40 § 7.2), then asks again. A turn whose text the purge took before the run read it — or while it waited, or between
 * two of its steps (the activities say so with the code TEXT_PURGED) — ends SKIPPED · TEXT_PURGED, never FAILED.
 * The suggestions a run submits (spec 42 § 4; unit 59b) run as children of their own, abandoned at the parent's
 * close so a curator's decision days later is still theirs to take; the run then waits for each to reach a place
 * (42 § 5) — the queue, a merge, or closed — asking the outcomes activity as `nextOutcomesWaitMs` paces it, for at most
 * OUTCOMES_FOR_MS, and ends DONE with what was proposed. An ask that fails is the last answer kept and asked again at
 * the next, never the run's end. A child that could not be started is a finding left SUBMITTED with no workflow, which
 * the outcomes read as still deciding until the wait runs out; the run says so in its log. The pacing of the asks is
 * `workers/research/pace.ts`'s since unit 74, moved there unchanged so that `SendFindingWorkflow` waits as this does
 * (feature-specs/48 § 8.4): the same constants and the same function, so a history this code recorded replays alike.
 */

const { loadResearch, validateFindings, submitFindings, findingOutcomes, concludeResearch } = proxyActivities<Pick<ResearchActivities, "loadResearch" | "validateFindings" | "submitFindings" | "findingOutcomes" | "concludeResearch">>({ startToCloseTimeout: "2 minutes", retry: { maximumAttempts: 3 } });
/* one attempt each (invariant 15): a model asked twice would be two calls for one answer; the reader's turn is up to
   three streamed requests of 600 s (lib/gateway/policy.ts), so its activity has 35 minutes */
const { planResearch } = proxyActivities<Pick<ResearchActivities, "planResearch">>({ startToCloseTimeout: "10 minutes", retry: { maximumAttempts: 1 } });
const { readResearch } = proxyActivities<Pick<ResearchActivities, "readResearch">>({ startToCloseTimeout: "35 minutes", retry: { maximumAttempts: 1 } });

export const researchStage = defineQuery<ResearchState>(RESEARCH_STAGE_QUERY);

function codeOf(error: unknown): string {
  if (error instanceof ActivityFailure && error.cause instanceof ApplicationFailure) return error.cause.type ?? "APPLICATION_FAILURE";
  if (error instanceof ActivityFailure) return "ACTIVITY_FAILED";
  return "UNKNOWN";
}

const TEXT_PURGED = "TEXT_PURGED";

/** A run waiting for its suggestions replays this code when the workers restart (code-standards): the review of unit 61's new branch is a patch. */
export const VALIDATION_FAILURE_PATCH = "61-validation-failure-concluded";

export async function ResearchWorkflow(rawInput: ResearchWorkflowInput): Promise<ResearchWorkflowResult> {
  const input = ResearchWorkflowInputSchema.parse(rawInput);
  const { runId } = input;
  const run = { runId, userId: input.userId };
  let stage: ResearchState = "QUEUED";
  setHandler(researchStage, () => stage);
  const end = async (state: ResearchWorkflowResult["state"], findings: number, conclusion: Parameters<ResearchActivities["concludeResearch"]>[1]): Promise<ResearchWorkflowResult> => {
    await concludeResearch(run, conclusion);
    stage = state;
    return { runId, state, findings };
  };

  const loaded = await loadResearch(run);
  if (loaded.state === "GONE") throw ApplicationFailure.nonRetryable(`research run ${runId} has no row`, "RESEARCH_RUN_MISSING");
  if (loaded.state === "PURGED") return end("SKIPPED", 0, { state: "SKIPPED", skip: "TEXT_PURGED" });

  stage = "PLANNING";
  let planned: Awaited<ReturnType<ResearchActivities["planResearch"]>>;
  for (;;) {
    try {
      planned = await planResearch(run);
    } catch (error: unknown) {
      if (codeOf(error) === TEXT_PURGED) return end("SKIPPED", 0, { state: "SKIPPED", skip: "TEXT_PURGED" });
      log.warn("research: the planner failed", { runId, code: codeOf(error) });
      return end("FAILED", 0, { state: "FAILED", failure: codeOf(error) });
    }
    if (planned.planned !== "budget") break;
    stage = "WAITING_BUDGET";
    log.info("research: waiting for the budget", { runId, resetsAt: planned.resetsAt });
    await sleep(Math.max(1_000, planned.waitMs));
    stage = "PLANNING";
  }
  if (planned.planned === "nothing") return end("SKIPPED", 0, { state: "SKIPPED", skip: "NOTHING_TO_RESEARCH" });

  stage = "READING";
  let read: Awaited<ReturnType<ResearchActivities["readResearch"]>>;
  for (;;) {
    try {
      read = await readResearch(run);
    } catch (error: unknown) {
      if (codeOf(error) === TEXT_PURGED) return end("SKIPPED", 0, { state: "SKIPPED", skip: "TEXT_PURGED" });
      log.warn("research: the reader failed", { runId, code: codeOf(error) });
      return end("FAILED", 0, { state: "FAILED", failure: codeOf(error) });
    }
    if (!("planned" in read)) break;
    stage = "WAITING_BUDGET";
    await sleep(Math.max(1_000, read.waitMs));
    stage = "READING";
  }

  stage = "VALIDATING";
  let submitted: { readonly suggestionIds: ReadonlyArray<string> };
  try {
    const validated = await validateFindings(run);
    stage = "SUBMITTING";
    submitted = validated.valid === 0 ? { suggestionIds: [] } : await submitFindings(run);
    log.info("research: submitted", { runId, suggestions: submitted.suggestionIds.length, invalid: validated.invalid, duplicate: validated.duplicate });
  } catch (error: unknown) {
    if (codeOf(error) === TEXT_PURGED) return end("SKIPPED", 0, { state: "SKIPPED", skip: "TEXT_PURGED" });
    /* an activity's failure ends the run FAILED with its code, its record and its line written, as an agent's does (review of unit 61) */
    if (!(error instanceof ActivityFailure) || !patched(VALIDATION_FAILURE_PATCH)) throw error;
    log.warn("research: the validation or the submission failed", { runId, code: codeOf(error) });
    return end("FAILED", 0, { state: "FAILED", failure: codeOf(error) });
  }
  /* each suggestion's workflow, a child abandoned at the parent's close: a second start of the same id is the running one's */
  for (const suggestionId of submitted.suggestionIds) {
    try {
      await startChild(SuggestionWorkflow, { workflowId: suggestionWorkflowId(suggestionId), args: [{ suggestionId: SuggestionIdSchema.parse(suggestionId) }], parentClosePolicy: ParentClosePolicy.ABANDON });
    } catch (error: unknown) {
      log.warn("research: a suggestion's workflow could not be started", { runId, suggestionId, code: codeOf(error) });
    }
  }
  /* proposed or refuted (42 § 5): where each stands, asked until none is still deciding or the wait runs out */
  const waitingSince = Date.now();
  let outcomes: Awaited<ReturnType<ResearchActivities["findingOutcomes"]>> = { pending: submitted.suggestionIds.length, proposed: 0, refuted: 0 };
  const ask = async (): Promise<void> => {
    try {
      outcomes = await findingOutcomes(run);
    } catch (error: unknown) {
      if (!(error instanceof ActivityFailure)) throw error;
      log.warn("research: where the suggestions stand could not be read, and is asked again", { runId, code: codeOf(error) });
    }
  };
  if (outcomes.pending > 0) await ask();
  let every = OUTCOMES_EVERY_MS;
  while (outcomes.pending > 0 && Date.now() - waitingSince < OUTCOMES_FOR_MS) {
    await sleep(every);
    await ask();
    every = nextOutcomesWaitMs(every, Date.now() - waitingSince);
  }
  log.info("research: outcomes", { runId, proposed: outcomes.proposed, refuted: outcomes.refuted, pending: outcomes.pending });
  return end("DONE", read.findings, { state: "DONE" });
}
