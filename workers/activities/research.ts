import { ApplicationFailure } from "@temporalio/activity";

import { readFindings, readResearchRun, readResearchTurn, writeResearchState, type ResearchRunRow } from "@/lib/db/research";
import { runEndOf } from "@/lib/research/record";
import { CODE_PATTERN, type FindingOutcome } from "@/lib/schemas/research";
import { logResearch, researchLineOf, type ResearchLine } from "@/lib/telemetry/lines";
import { planStep, type PlanStep } from "@/workers/research/plan";
import { readStep, type ReadStep } from "@/workers/research/read";
import { outcomesStep } from "@/workers/research/outcomes";
import { recordResearch, type ResearchEnd } from "@/workers/research/record";
import { submitStep } from "@/workers/research/submit";
import { validateStep } from "@/workers/research/validate";

import type { ResearchActivities, ResearchRunRef } from "../workflows/activities";

/*
 * ResearchWorkflow's activities (feature-specs/40 § 6.2; unit 57d): the run's row read as the platform to learn whose it
 * is, the turn read inside the reader's own tenant context, the state written as the run moves. The planner is
 * `workers/research/plan.ts` (41 § 5; unit 58c): its brief is stored on the run with its hash and never returned to the
 * workflow, which learns only that there is one. The reader is `workers/research/read.ts` (41 § 6; unit 58d): what it
 * found stays on the run and the workflow learns the count. The validation is `workers/research/validate.ts` (41 § 7;
 * unit 58e): each finding's row with its reason, the valid ordinals left on the run for the submission. The conclude
 * step appends the RESEARCH record (40 § 6.3) after the run's state, once by its step key. The submission is
 * `workers/research/submit.ts` (42 § 4; unit 59b) and the outcomes `workers/research/outcomes.ts` (42 § 5; unit 59c).
 * Each agent's step and the run's end print their line (44 § 4; unit 61a): `research.plan`, `research.read`,
 * `research.run`, with the run's id, the outcome, the counts and the time, on the turn's trace.
 */

export interface ResearchActivityDeps {
  readonly readRow: (runId: string, userId: string) => Promise<ResearchRunRow | null>;
  readonly readTurn: (run: Pick<ResearchRunRow, "userId" | "messageId">) => Promise<{ readonly question: string | null; readonly answer: string | null } | null>;
  readonly writeState: typeof writeResearchState;
  /** The planner's step (41 § 5): the brief, nothing, or the cap with its reset. */
  readonly plan: (run: ResearchRunRow) => Promise<PlanStep>;
  /** The reader's step (41 § 6): the count of findings, or the cap with its reset. */
  readonly read: (run: ResearchRunRow) => Promise<ReadStep>;
  /** The validation (41 § 7): the three counts. */
  readonly validate: (run: ResearchRunRow) => Promise<{ readonly valid: number; readonly invalid: number; readonly duplicate: number }>;
  /** The submission (42 § 4; unit 59b): the ids of the suggestions made. */
  readonly submit: (run: ResearchRunRow) => Promise<{ readonly suggestionIds: ReadonlyArray<string> }>;
  /** The outcomes (42 § 5; unit 59c): each submitted finding's, as its suggestion stands. */
  readonly outcomes: (run: ResearchRunRow) => Promise<{ readonly pending: number; readonly proposed: number; readonly refuted: number }>;
  /** The RESEARCH record (40 § 6.3), once. */
  readonly record: (run: ResearchRunRow, end: ResearchEnd) => Promise<unknown>;
  /** The findings' outcomes, for the run's line. */
  readonly findings: (run: Pick<ResearchRunRow, "id" | "userId">) => Promise<ReadonlyArray<{ readonly outcome: FindingOutcome }>>;
  /** Prints a step's line and records its span (44 § 4). */
  readonly line: (line: ResearchLine) => void;
  readonly now: () => Date;
}

export function defaultResearchDeps(): ResearchActivityDeps {
  return {
    readRow: readResearchRun,
    readTurn: readResearchTurn,
    writeState: writeResearchState,
    plan: (run) => planStep(run),
    read: (run) => readStep(run),
    validate: (run) => validateStep(run),
    submit: (run) => submitStep(run),
    outcomes: (run) => outcomesStep(run),
    record: (run, end) => recordResearch(run, end),
    findings: (run) => readFindings(run),
    line: logResearch,
    now: () => new Date(),
  };
}

/** What a step's failure is, as its line says it: the code the step threw with, else `INTERNAL`; a purge is not a failure. */
function failedOf(error: unknown): { readonly outcome: "purged" | "failed"; readonly code: string } {
  const type = error instanceof ApplicationFailure ? (error.type ?? null) : null;
  const code = type !== null && CODE_PATTERN.test(type) ? type : "INTERNAL";
  return { outcome: code === "TEXT_PURGED" ? "purged" : "failed", code };
}

export function researchActivities(deps: ResearchActivityDeps = defaultResearchDeps()): ResearchActivities {
  const row = async (ref: ResearchRunRef): Promise<ResearchRunRow> => {
    const run = await deps.readRow(ref.runId, ref.userId);
    if (run === null) throw ApplicationFailure.create({ type: "RESEARCH_RUN_MISSING", message: `research run ${ref.runId} has no row`, nonRetryable: true });
    return run;
  };
  const ref = (run: ResearchRunRow): Pick<ResearchRunRow, "id" | "userId"> => ({ id: run.id, userId: run.userId });
  return {
    async loadResearch(input) {
      const run = await deps.readRow(input.runId, input.userId);
      if (run === null) return { state: "GONE" };
      /* text purged, or the run detached by its conversation's delete: no read of the turn (45 § 3.5) */
      if (run.textPurgedAt !== null) return { state: "PURGED" };
      const turn = await deps.readTurn(run);
      if (turn === null || turn.question === null || turn.answer === null) return { state: "PURGED" };
      await deps.writeState(ref(run), "PLANNING", {}, deps.now());
      return { state: "LOADED", gap: run.gap, sections: run.sectionAnchors.length };
    },
    async planResearch(input) {
      const run = await row(input);
      const started = deps.now().getTime();
      const at = { traceId: run.traceId, runId: run.id };
      let planned: PlanStep;
      try {
        planned = await deps.plan(run);
      } catch (error: unknown) {
        const failed = failedOf(error);
        deps.line(researchLineOf("plan", at, failed.outcome, deps.now().getTime() - started, { code: failed.code }));
        throw error;
      }
      deps.line(researchLineOf("plan", at, planned.planned, deps.now().getTime() - started));
      if (planned.planned === "budget") {
        await deps.writeState(ref(run), "WAITING_BUDGET", {}, deps.now());
        return planned;
      }
      if (planned.planned === "nothing") return planned;
      /* the brief stays in the asker's rows; the engine learns that there is one (invariant 35) */
      const { written } = await deps.writeState(ref(run), "READING", { brief: planned.brief, briefSha256: planned.briefSha256 }, deps.now());
      if (!written) throw ApplicationFailure.create({ type: "TEXT_PURGED", message: `research run ${run.id}: its text was purged while the planner ran`, nonRetryable: true });
      return { planned: "brief" };
    },
    async readResearch(input) {
      const run = await row(input);
      const started = deps.now().getTime();
      const at = { traceId: run.traceId, runId: run.id };
      let read: ReadStep;
      try {
        read = await deps.read(run);
      } catch (error: unknown) {
        const failed = failedOf(error);
        deps.line(researchLineOf("read", at, failed.outcome, deps.now().getTime() - started, { code: failed.code }));
        throw error;
      }
      if ("planned" in read) {
        deps.line(researchLineOf("read", at, "budget", deps.now().getTime() - started));
        await deps.writeState(ref(run), "WAITING_BUDGET", {}, deps.now());
        return read;
      }
      deps.line(researchLineOf("read", at, "found", deps.now().getTime() - started, { findings: read.findings, searches: read.searches, pageReads: read.pageReads }));
      await deps.writeState(ref(run), "VALIDATING", {}, deps.now());
      /* the workflow learns the count; the searches are the run's row's */
      return { findings: read.findings };
    },
    async validateFindings(input) {
      const run = await row(input);
      const counts = await deps.validate(run);
      await deps.writeState(ref(run), "SUBMITTING", {}, deps.now());
      return counts;
    },
    async submitFindings(input) {
      const run = await row(input);
      return deps.submit(run);
    },
    async findingOutcomes(input) {
      const run = await row(input);
      return deps.outcomes(run);
    },
    async concludeResearch(input, end) {
      const run = await row(input);
      if (end.state === "DONE") await deps.writeState(ref(run), "DONE", {}, deps.now());
      else if (end.state === "SKIPPED") await deps.writeState(ref(run), "SKIPPED", { skip: end.skip }, deps.now());
      else await deps.writeState(ref(run), "FAILED", { failure: end.failure }, deps.now());
      /* the ledger's one line for the run, after its state, so a retried conclude finds the record by its key */
      await deps.record(run, end);
      /* and its line, from the row as the run left it and what its findings came to */
      const findings = await deps.findings(ref(run));
      const ended = runEndOf(end);
      deps.line(
        researchLineOf("run", { traceId: run.traceId, runId: run.id }, ended.state, Math.max(0, deps.now().getTime() - run.createdAt.getTime()), {
          code: ended.code,
          searches: run.searches,
          pageReads: run.pageReads,
          findings: findings.length,
          proposed: findings.filter((finding) => finding.outcome === "PROPOSED").length,
          refuted: findings.filter((finding) => finding.outcome === "REFUTED").length,
        }),
      );
    },
  };
}

export const researchActivitiesDefault: ResearchActivities = researchActivities();
