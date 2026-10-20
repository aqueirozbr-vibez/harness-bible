import { ActivityFailure, ApplicationFailure, CancellationScope, defineQuery, isCancellation, log, proxyActivities, setHandler, sleep, TimeoutFailure } from "@temporalio/workflow";

import { CODE_PATTERN, type ResearchState } from "@/lib/schemas/research";
import { RESEARCH_RUN_STAGE_QUERY, ResearchRunWorkflowInputSchema, type ResearchRunWorkflowInput, type ResearchRunWorkflowResult } from "@/lib/schemas/workflows";

import type { ResearchRunActivities, RunConclusion } from "./activities";

/*
 * ResearchRunWorkflow (feature-specs/48 § 5.1; unit 70b), under `research:<runId>` on the research queue: a person's
 * research run — load, plan, read, check, write, conclude. Its argument is the run's id and its asker's, both ids
 * (invariant 35); what each step answers is a state, a cause or a count, and the question, the brief, the pages and
 * the report stay in the asker's rows. Each agent has one attempt (invariant 15). It takes no signal and answers one
 * query, `stage`. It never sleeps on the budget and never waits on a suggestion: sending a finding is a later act of
 * its own (§ 8). Its one timer is the writer's wait at the key's rate limit: a 429 that never reached the provider is
 * not the writer's attempt, so the run waits 65 seconds and asks once more, and a second refusal ends it
 * `FAILED · RATE_LIMIT` with what it has (§ 5.6).
 *
 * How it ends (§ 5.1, § 7.2): `REFUSED` with the planner's cause; `SKIPPED · BUDGET` and `SKIPPED · UNAVAILABLE` where
 * the planner was refused before the provider saw it, which the day's count leaves out; `FAILED · BUDGET` where a later
 * call met the person's cap; `FAILED` with an agent's code; `SKIPPED · TEXT_PURGED` wherever a step finds the text gone
 * (a delete mid-run); `DONE`. A later step's failure keeps what earlier steps stored: a run whose writer failed still
 * shows its pages and findings.
 *
 * An end is always written. The body runs in a `try`: a cancellation (spec 46's erasure) is caught and the run is
 * concluded where the cancellation does not reach (`CancellationScope.nonCancellable`), `SKIPPED · TEXT_PURGED` where
 * its text is gone and `FAILED · CANCELLED` otherwise, each with its record; the cancellation then goes on, so the
 * engine closes the run as cancelled. Any other failure that escapes — the conclude's three attempts spent, a defect
 * after the read — calls `abandonRun`, a conditional update to `FAILED · INTERNAL` with no record, and is thrown on. A
 * workflow stuck in a loop of task failures is closed by the engine at the 90 minutes its entry gives it
 * (lib/schemas/workflows.ts), and the start endpoint ends its row (§ 5.2 check 3). The workflow is new, so neither
 * needs `patched()`: a patch guards a change to code that has running histories (code-standards § Workers). The
 * legacy `ResearchWorkflow` is not edited; its running histories replay its own code.
 *
 * The worst case: load 6 minutes with its retries, plan 10, read 35, check 6, write 5 + 65 s + 5, conclude 6 — about
 * 74 minutes. The three agents' steps heartbeat, so a worker lost to a restart fails the step within a minute.
 */

const { loadRun, validateRun, concludeRun, abandonRun } = proxyActivities<Pick<ResearchRunActivities, "loadRun" | "validateRun" | "concludeRun" | "abandonRun">>({ startToCloseTimeout: "2 minutes", retry: { maximumAttempts: 3 } });
/* one attempt each (invariant 15), and a heartbeat within the minute: the reader's turn is up to three streamed requests of 600 s (lib/gateway/policy.ts) */
const { planRun } = proxyActivities<Pick<ResearchRunActivities, "planRun">>({ startToCloseTimeout: "10 minutes", heartbeatTimeout: "60 seconds", retry: { maximumAttempts: 1 } });
const { readRun } = proxyActivities<Pick<ResearchRunActivities, "readRun">>({ startToCloseTimeout: "35 minutes", heartbeatTimeout: "60 seconds", retry: { maximumAttempts: 1 } });
const { writeReport } = proxyActivities<Pick<ResearchRunActivities, "writeReport">>({ startToCloseTimeout: "5 minutes", heartbeatTimeout: "60 seconds", retry: { maximumAttempts: 1 } });

/** The writer's one wait at the key's rate limit (48 § 5.6): past the minute the gateway's `tpm_limit` counts over. */
export const RATE_LIMIT_WAIT = "65 seconds";

export const researchRunStage = defineQuery<ResearchState>(RESEARCH_RUN_STAGE_QUERY);

/** The code an activity's failure carries: its type where it is a code of ours, `TIMEOUT` for a step the engine timed out (a heartbeat missed, a step's whole time spent), else `INTERNAL`. */
function codeOf(error: ActivityFailure): string {
  const { cause } = error;
  if (cause instanceof ApplicationFailure && typeof cause.type === "string" && CODE_PATTERN.test(cause.type)) return cause.type;
  if (cause instanceof TimeoutFailure) return "TIMEOUT";
  return "INTERNAL";
}

/** Where the steps left the run: an end for the conclude step, with how many findings passed; or a row already ended by another hand, which this run does not touch. */
type Steps = { readonly end: Exclude<RunConclusion, { readonly state: "CANCELLED" }>; readonly findings: number } | { readonly ended: ResearchState };

/** An agent's step that failed: its text gone is a skip, any other failure the run's failure with its code. A cancellation, and a failure of the workflow's own code, go on up. */
function failedAt(error: unknown, findings: number): Steps {
  if (isCancellation(error) || !(error instanceof ActivityFailure)) throw error;
  const code = codeOf(error);
  return { end: code === "TEXT_PURGED" ? { state: "SKIPPED", skip: "TEXT_PURGED" } : { state: "FAILED", failure: code }, findings };
}

async function steps(run: { readonly runId: string; readonly userId: string }, at: (stage: ResearchState) => void): Promise<Steps> {
  const loaded = await loadRun(run);
  if (loaded.state === "GONE") throw ApplicationFailure.nonRetryable(`research run ${run.runId} has no row`, "RESEARCH_RUN_MISSING");
  if (loaded.state === "ENDED") return { ended: loaded.ended };
  if (loaded.state === "PURGED") return { end: { state: "SKIPPED", skip: "TEXT_PURGED" }, findings: 0 };

  at("PLANNING");
  let planned: Awaited<ReturnType<ResearchRunActivities["planRun"]>>;
  try {
    planned = await planRun(run);
  } catch (error: unknown) {
    log.warn("research: the plan failed", { runId: run.runId });
    return failedAt(error, 0);
  }
  if (planned.planned === "refused") return { end: { state: "REFUSED", refusal: planned.refusal }, findings: 0 };
  /* no model answered: not counted toward the 30 (48 § 7.2) */
  if (planned.planned === "budget") return { end: { state: "SKIPPED", skip: "BUDGET" }, findings: 0 };
  if (planned.planned === "unavailable") return { end: { state: "SKIPPED", skip: "UNAVAILABLE" }, findings: 0 };

  at("READING");
  let read: Awaited<ReturnType<ResearchRunActivities["readRun"]>>;
  try {
    read = await readRun(run);
  } catch (error: unknown) {
    log.warn("research: the read failed", { runId: run.runId });
    return failedAt(error, 0);
  }
  if (read.read === "budget") return { end: { state: "FAILED", failure: "BUDGET" }, findings: 0 };

  at("VALIDATING");
  let validated: Awaited<ReturnType<ResearchRunActivities["validateRun"]>>;
  try {
    validated = await validateRun(run);
  } catch (error: unknown) {
    /* the text gone is a skip; any other failure of the check is a defect after the read, the catch-all's (48 § 5.1) */
    if (!isCancellation(error) && error instanceof ActivityFailure && codeOf(error) === "TEXT_PURGED") return { end: { state: "SKIPPED", skip: "TEXT_PURGED" }, findings: 0 };
    throw error;
  }

  at("WRITING");
  const write = async (attempt: number): Promise<Awaited<ReturnType<ResearchRunActivities["writeReport"]>> | Steps> => {
    try {
      return await writeReport(run, attempt);
    } catch (error: unknown) {
      log.warn("research: the write failed", { runId: run.runId, attempt });
      return failedAt(error, validated.valid);
    }
  };
  let written = await write(1);
  if ("written" in written && written.written === "rate_limit") {
    /* the gateway's 429 never reached the provider: not the writer's one attempt; the run waits it out once (48 § 5.6) */
    log.info("research: the writer met the key's rate; waiting once", { runId: run.runId });
    await sleep(RATE_LIMIT_WAIT);
    written = await write(2);
    if ("written" in written && written.written === "rate_limit") return { end: { state: "FAILED", failure: "RATE_LIMIT" }, findings: validated.valid };
  }
  if (!("written" in written)) return written;
  if (written.written === "budget") return { end: { state: "FAILED", failure: "BUDGET" }, findings: validated.valid };
  return { end: { state: "DONE" }, findings: validated.valid };
}

export async function ResearchRunWorkflow(rawInput: ResearchRunWorkflowInput): Promise<ResearchRunWorkflowResult> {
  const input = ResearchRunWorkflowInputSchema.parse(rawInput);
  const run = { runId: input.runId, userId: input.userId };
  let stage: ResearchState = "QUEUED";
  setHandler(researchRunStage, () => stage);
  let cancelled = false;
  try {
    try {
      const left = await steps(run, (next) => {
        stage = next;
      });
      if ("ended" in left) {
        stage = left.ended;
        return { runId: run.runId, state: left.ended, findings: 0 };
      }
      const concluded = await concludeRun(run, left.end);
      stage = concluded.state;
      return { runId: run.runId, state: concluded.state, findings: left.findings };
    } catch (error: unknown) {
      if (!isCancellation(error)) throw error;
      cancelled = true;
      /* spec 46's erasure, or an operator's cancel: the end written where the cancellation does not reach, with its record (48 § 5.1) */
      const concluded = await CancellationScope.nonCancellable(() => concludeRun(run, { state: "CANCELLED" }));
      stage = concluded.state;
      throw error;
    }
  } catch (error: unknown) {
    if (cancelled && isCancellation(error)) throw error;
    /* anything else that escapes: the row ended FAILED · INTERNAL, no record, and the failure thrown on */
    log.warn("research: the run failed outside its steps; it is abandoned", { runId: run.runId });
    await CancellationScope.nonCancellable(() => abandonRun(run));
    stage = "FAILED";
    throw error;
  }
}
