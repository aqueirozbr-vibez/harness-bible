import { ApplicationFailure, CancelledFailure, Context } from "@temporalio/activity";

import {
  appendRunStep,
  completeRunStep,
  ENDED_STATES,
  readConversationRun,
  readFindings,
  readRunQuestion,
  writeBudgetResetsAt,
  writeResearchState,
  writeRunQuestion,
  writeWritingAt,
  type ConversationRunRow,
  type NewResearchStep,
  type RunRef,
} from "@/lib/db/research";
import { questionSha256Of } from "@/lib/research/question";
import { runEndOf, type PersonRunEnd } from "@/lib/research/record";
import { SectionIdSchema } from "@/lib/schemas/ids";
import { CODE_PATTERN, PLANNER_REFUSALS, type FindingOutcome, type PlannerRefusal } from "@/lib/schemas/research";
import { processSecrets } from "@/lib/security/processSecrets";
import { redactSecrets } from "@/lib/security/redact";
import { logResearch, researchLineOf, type ResearchLine } from "@/lib/telemetry/lines";
import { planRunStep, type PlanRunStep } from "@/workers/research/run/plan";
import { defaultReadRunDeps, readRunStep, type ReadRunStep, type ReadSteps } from "@/workers/research/run/read";
import { recordPersonRun } from "@/workers/research/run/record";
import { stepQueue } from "@/workers/research/run/steps";
import { validateRunStep } from "@/workers/research/run/validate";
import { defaultWriteRunDeps, writeRunStep, type WriteRunStep } from "@/workers/research/run/write";

import type { ResearchRunActivities, ResearchRunRef, RunConclusion } from "../workflows/activities";

/*
 * ResearchRunWorkflow's activities (feature-specs/48 § 5.1; unit 70b): a person's run read and written inside the
 * asker's own tenant context by the ids the workflow was given, the state written as the run moves, each step's live
 * step on the run's row (§ 6), and the agents' steps in workers/research/run/. The planner, the reader and the writer
 * are called on the person's principal (§ 7.1); nothing here reads `RESEARCH_PRINCIPAL`.
 *
 *   loadRun       the run, its question redacted again with the workers' own secrets — the gateway's master key is
 *                 registered in the workers alone — and written back where that changed it (§ 5.2), `PLANNING`;
 *   planRun       the plan (./run/plan.ts), the brief, the run's sections and targets stored with `READING`, and the
 *                 `SECTIONS` step; at the cap the reset on the row;
 *   readRun       the read (./run/read.ts), its blocks turned into steps through one ordered chain of one-statement
 *                 writes, the chain awaited before `found` is stored;
 *   validateRun   `VALIDATING` and its step, the check (./run/validate.ts);
 *   writeReport   `WRITING`, `writingAt` where it is not yet set, its step, the writer (./run/write.ts);
 *   concludeRun   the end state first, then the `RESEARCH` record once (./run/record.ts), then the `research.run` line,
 *                 as `concludeResearch` orders them, so a record that fails leaves the row ended;
 *   abandonRun    the catch-all's: `FAILED · INTERNAL` where the run has not ended, and no record.
 *
 * The three agents' steps heartbeat (§ 5.1): from a 20-second timer while they run, and the read from each block the
 * stream completes too, so a worker lost to a restart fails the step within the minute the workflow allows. A live
 * step that fails to write is logged and never fails its step. Each step prints its line (lib/telemetry/lines.ts):
 * `research.plan`, `research.read`, `research.write` and `research.run`, with counts and the outcome, never a word.
 *
 * A cancellation reaches an agent's step (review of unit 70). The workflow's steps are cancelled `TRY_CANCEL`, so the
 * workflow concludes a cancelled run at once, `FAILED · CANCELLED` or `SKIPPED · TEXT_PURGED` (spec 46's erasure, an
 * operator), while the step learns of it on its next heartbeat. The step's work is raced against the activity's
 * `cancelled`, so the step ends as cancelled within that heartbeat instead of running on for up to 35 minutes, and the
 * work is handed the activity's `cancellationSignal`: the reader's streams are sent with it and aborted, and neither the
 * read nor the write stores anything once it has fired — no counts, no `found`, no report onto the ended row.
 *
 * No agent is paid for on a row that has ended (review of unit 71). `planRun`, `readRun` and `writeReport` read the
 * row first, and where another hand has ended it — the start took it back `SKIPPED · UNAVAILABLE` after the engine had
 * the workflow after all, or a second start ended it `FAILED · ABANDONED` (48 § 5.2 check 3) — they call no model and
 * fail `RUN_ENDED`. The workflow then concludes as for any failure, and the conclude writes nothing over that end: its
 * write is conditional on a run not ended, and the record and the line say what the row says. A record follows only
 * where a planner was paid before the row ended (48 § 15); a row ended before the plan has none, as `loadRun`'s `ENDED`.
 */

/** How often the agents' steps heartbeat while a call is out (48 § 5.1): a third of the workflow's 60 seconds. */
export const HEARTBEAT_EVERY_MS = 20_000;

export interface ResearchRunActivityDeps {
  readonly readRow: typeof readConversationRun;
  readonly readQuestion: typeof readRunQuestion;
  readonly writeQuestion: typeof writeRunQuestion;
  /** The literal values this process must never pass on: the workers' own, the gateway's master key among them. */
  readonly secrets: () => ReadonlyArray<string>;
  readonly writeState: typeof writeResearchState;
  readonly appendStep: typeof appendRunStep;
  readonly completeStep: typeof completeRunStep;
  readonly writeWritingAt: typeof writeWritingAt;
  readonly writeBudgetResetsAt: typeof writeBudgetResetsAt;
  readonly plan: (run: ConversationRunRow) => Promise<PlanRunStep>;
  /** The read, told the activity's cancellation: its streams are aborted by it, and it stores nothing once it fired. */
  readonly read: (run: ConversationRunRow, steps: ReadSteps, signal: AbortSignal) => Promise<ReadRunStep>;
  readonly validate: (run: ConversationRunRow) => Promise<{ readonly valid: number; readonly invalid: number }>;
  /** The write, told the activity's cancellation: it stores no report once it fired. */
  readonly write: (run: ConversationRunRow, signal: AbortSignal) => Promise<WriteRunStep>;
  /** The `RESEARCH` record (48 § 15), once. */
  readonly record: (run: ConversationRunRow, end: PersonRunEnd) => Promise<unknown>;
  readonly findings: (run: RunRef) => Promise<ReadonlyArray<{ readonly outcome: FindingOutcome }>>;
  readonly line: (line: ResearchLine) => void;
  readonly heartbeat: () => void;
  readonly heartbeatEveryMs: number;
  /** The activity's cancellation, read when an agent's step starts. */
  readonly cancellation: () => ActivityCancellation;
  readonly log: (line: string) => void;
  readonly now: () => Date;
}

/** What an activity is told of its cancellation (48 § 5.1): the signal the work is handed, and the promise that rejects with `CancelledFailure` when it comes. */
export interface ActivityCancellation {
  readonly signal: AbortSignal;
  readonly cancelled: Promise<never>;
}

/** The activity's heartbeat; outside an activity — a step called directly, as a test does — there is none to send. */
function activityHeartbeat(): void {
  try {
    Context.current().heartbeat();
  } catch {
    /* not inside an activity */
  }
}

/** The activity's own cancellation, delivered by a heartbeat; outside an activity, one that never comes. */
export function activityCancellation(): ActivityCancellation {
  try {
    const context = Context.current();
    return { signal: context.cancellationSignal, cancelled: context.cancelled };
  } catch {
    /* not inside an activity: nothing can cancel the step */
    return { signal: new AbortController().signal, cancelled: new Promise<never>(() => undefined) };
  }
}

export function defaultResearchRunDeps(): ResearchRunActivityDeps {
  return {
    readRow: readConversationRun,
    readQuestion: readRunQuestion,
    writeQuestion: writeRunQuestion,
    secrets: processSecrets,
    writeState: writeResearchState,
    appendStep: appendRunStep,
    completeStep: completeRunStep,
    writeWritingAt,
    writeBudgetResetsAt,
    plan: (run) => planRunStep(run),
    read: (run, steps, signal) => readRunStep(run, steps, defaultReadRunDeps(), signal),
    validate: (run) => validateRunStep(run),
    write: (run, signal) => writeRunStep(run, defaultWriteRunDeps(), signal),
    record: (run, end) => recordPersonRun(run, end),
    findings: (run) => readFindings(run),
    line: logResearch,
    heartbeat: activityHeartbeat,
    heartbeatEveryMs: HEARTBEAT_EVERY_MS,
    cancellation: activityCancellation,
    log: (line) => console.info(line),
    now: () => new Date(),
  };
}

/** What a step's failure is, as its line says it: `CANCELLED` for the activity's cancellation, the code the step threw with, else `INTERNAL`; a purge is not a failure. */
function failedOf(error: unknown): { readonly outcome: "purged" | "failed"; readonly code: string } {
  if (error instanceof CancelledFailure) return { outcome: "failed", code: "CANCELLED" };
  const type = error instanceof ApplicationFailure ? (error.type ?? null) : null;
  const code = type !== null && CODE_PATTERN.test(type) ? type : "INTERNAL";
  return { outcome: code === "TEXT_PURGED" ? "purged" : "failed", code };
}

function purged(run: RunRef, when: string): never {
  throw ApplicationFailure.create({ type: "TEXT_PURGED", message: `research run ${run.id}: its text was purged ${when}`, nonRetryable: true });
}

/** The code an agent's step fails with where its row has already ended (review of unit 71): no model is called on it. */
export const RUN_ENDED = "RUN_ENDED";

/** How the run ended, from its row as the end left it: what the record and the line say, whichever attempt of the conclude wrote it. */
function endOfRow(row: ConversationRunRow, fallback: PersonRunEnd): PersonRunEnd {
  switch (row.state) {
    case "DONE":
      return { state: "DONE" };
    case "SKIPPED":
      return { state: "SKIPPED", skip: row.skip ?? "UNAVAILABLE" };
    case "FAILED":
      return { state: "FAILED", failure: row.failure ?? "INTERNAL" };
    case "REFUSED":
      return row.refusal !== null && (PLANNER_REFUSALS as ReadonlyArray<string>).includes(row.refusal) ? { state: "REFUSED", refusal: row.refusal as PlannerRefusal } : fallback;
    default:
      return fallback;
  }
}

export function researchRunActivities(deps: ResearchRunActivityDeps = defaultResearchRunDeps()): ResearchRunActivities {
  const row = async (ref: ResearchRunRef): Promise<ConversationRunRow> => {
    const run = await deps.readRow(ref.runId, ref.userId);
    if (run === null) throw ApplicationFailure.create({ type: "RESEARCH_RUN_MISSING", message: `research run ${ref.runId} has no row`, nonRetryable: true });
    return run;
  };
  /* the row before an agent is paid for: one another hand has ended is not this workflow's to spend on (review of unit 71) */
  const unended = async (ref: ResearchRunRef, agent: "planner" | "reader" | "writer"): Promise<ConversationRunRow> => {
    const run = await row(ref);
    if (!ENDED_STATES.includes(run.state)) return run;
    deps.log(`research ${run.id}: the run had ended ${run.state} before its ${agent} was called; no model is called (trace ${run.traceId})`);
    throw ApplicationFailure.create({ type: RUN_ENDED, message: `research run ${run.id}: it ended ${run.state} before its ${agent}`, nonRetryable: true });
  };
  const at = (run: ConversationRunRow) => ({ traceId: run.traceId, runId: run.id });
  /* a live step is progress: one that fails to write is logged and never fails the step (48 § 6) */
  const step = async (run: ConversationRunRow, written: NewResearchStep, once = false): Promise<void> => {
    try {
      await deps.appendStep(run, written, { once });
    } catch (error: unknown) {
      deps.log(`research ${run.id}: the ${written.kind} step was not written (${error instanceof Error ? error.name : "unknown"}; trace ${run.traceId})`);
    }
  };
  /*
   * An agent's step: heartbeating while the work runs, and raced against the activity's cancellation, which a heartbeat
   * delivers, so a cancelled step ends at once as cancelled. The work is handed the signal: the reader's streams are
   * aborted by it, and a work that still answers stores nothing (the race has already answered for it).
   */
  const beating = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const { signal, cancelled } = deps.cancellation();
    deps.heartbeat();
    const timer = setInterval(deps.heartbeat, deps.heartbeatEveryMs);
    try {
      return await Promise.race([work(signal), cancelled]);
    } finally {
      clearInterval(timer);
    }
  };
  const since = (started: number): number => Math.max(0, deps.now().getTime() - started);
  return {
    async loadRun(input) {
      const run = await deps.readRow(input.runId, input.userId);
      if (run === null) return { state: "GONE" };
      /* a start the web tier took back after the engine had it after all (28 § 4.3): the row is not this workflow's to run */
      if (ENDED_STATES.includes(run.state)) return { state: "ENDED", ended: run.state };
      /* the research deleted, or its text purged, before the run read it (48 § 17) */
      if (run.conversationId === null || run.textPurgedAt !== null) return { state: "PURGED" };
      const question = await deps.readQuestion(run);
      if (question === null) return { state: "PURGED" };
      /* the web tier redacted with its own secrets; the workers hold one it does not, the gateway's master key (48 § 5.2) */
      const redaction = redactSecrets(question, deps.secrets());
      if (redaction.findings.length > 0) {
        const { written } = await deps.writeQuestion(run, redaction.text, questionSha256Of(redaction.text));
        if (!written) return { state: "PURGED" };
        deps.log(`research ${run.id}: the workers redacted ${String(redaction.findings.length)} secret${redaction.findings.length === 1 ? "" : "s"} in the question before any prompt (trace ${run.traceId})`);
      }
      await deps.writeState(run, "PLANNING", {}, deps.now());
      await step(run, { kind: "PLANNING", at: deps.now().toISOString() }, true);
      return { state: "LOADED" };
    },

    async planRun(input) {
      const run = await unended(input, "planner");
      const started = deps.now().getTime();
      let planned: PlanRunStep;
      try {
        planned = await beating(() => deps.plan(run));
      } catch (error: unknown) {
        const failed = failedOf(error);
        deps.line(researchLineOf("plan", at(run), failed.outcome, since(started), { code: failed.code }));
        throw error;
      }
      deps.line(researchLineOf("plan", at(run), planned.planned, since(started)));
      if (planned.planned !== "brief") {
        /* the run's sections, which a refusal's card points at (48 § 5.3); the end itself is the conclude step's */
        if (planned.planned === "budget") await deps.writeBudgetResetsAt(run, planned.resetsAt);
        await deps.writeState(run, "PLANNING", { sectionAnchors: planned.sections }, deps.now());
        return planned.planned === "refused" ? { planned: "refused", refusal: planned.refusal } : { planned: planned.planned };
      }
      /* the brief stays in the asker's rows; the engine learns that there is one (invariant 35) */
      const { written } = await deps.writeState(run, "READING", { brief: planned.brief, briefSha256: planned.briefSha256, sectionAnchors: planned.sections, targetAnchors: planned.targets }, deps.now());
      if (!written) purged(run, "while the planner ran");
      /* the targets passed the brief sensor's TARGET, so each is one of the run's sections; a step is progress and never fails the plan */
      const targets = planned.targets.flatMap((target) => {
        const parsed = SectionIdSchema.safeParse(target);
        return parsed.success ? [parsed.data] : [];
      });
      if (targets.length > 0) await step(run, { kind: "SECTIONS", at: deps.now().toISOString(), sections: targets });
      return { planned: "brief" };
    },

    async readRun(input) {
      const run = await unended(input, "reader");
      const started = deps.now().getTime();
      const steps = stepQueue(run, { append: (ref, written) => deps.appendStep(ref, written), complete: deps.completeStep, heartbeat: deps.heartbeat, log: deps.log, now: deps.now });
      let read: ReadRunStep;
      try {
        read = await beating((signal) => deps.read(run, steps, signal));
      } catch (error: unknown) {
        await steps.settled();
        const failed = failedOf(error);
        deps.line(researchLineOf("read", at(run), failed.outcome, since(started), { code: failed.code }));
        throw error;
      }
      if (read.read === "budget") {
        await deps.writeBudgetResetsAt(run, read.resetsAt);
        deps.line(researchLineOf("read", at(run), "budget", since(started), { searches: read.searches, pageReads: read.pageReads }));
        return { read: "budget" };
      }
      deps.line(researchLineOf("read", at(run), "found", since(started), { findings: read.findings, searches: read.searches, pageReads: read.pageReads }));
      /* the workflow learns the count; the pages and the notes are the run's row's */
      return { read: "found", findings: read.findings };
    },

    async validateRun(input) {
      const run = await row(input);
      await deps.writeState(run, "VALIDATING", {}, deps.now());
      /* the step shows no count of what was checked (A7) */
      await step(run, { kind: "CHECKING", at: deps.now().toISOString() }, true);
      return deps.validate(run);
    },

    async writeReport(input, attempt) {
      const run = await unended(input, "writer");
      const started = deps.now().getTime();
      await deps.writeState(run, "WRITING", {}, deps.now());
      /* before the call: the writer's rows are the run's frontier rows from here; a second attempt keeps the first instant */
      await deps.writeWritingAt(run, deps.now());
      await step(run, { kind: "WRITING", at: deps.now().toISOString() }, true);
      let written: WriteRunStep;
      try {
        written = await beating((signal) => deps.write(run, signal));
      } catch (error: unknown) {
        const failed = failedOf(error);
        deps.line(researchLineOf("write", at(run), failed.outcome, since(started), { code: failed.code }));
        throw error;
      }
      if (written.written === "report") {
        deps.line(researchLineOf("write", at(run), "report", since(started), { findings: written.findings, paragraphs: written.paragraphs, dropped: written.dropped }));
        return { written: "report" };
      }
      if (written.written === "budget") await deps.writeBudgetResetsAt(run, written.resetsAt);
      else deps.log(`research ${run.id}: the writer's attempt ${String(attempt)} met the key's rate; ${attempt === 1 ? "the run waits once and asks again" : "the run ends"} (trace ${run.traceId})`);
      deps.line(researchLineOf("write", at(run), written.written, since(started)));
      return { written: written.written };
    },

    async concludeRun(input, end: RunConclusion) {
      const run = await row(input);
      /* a cancellation (spec 46's erasure, which deletes the research first): skipped where the text is gone, failed otherwise */
      const resolved: Exclude<RunConclusion, { readonly state: "CANCELLED" }> = end.state === "CANCELLED" ? (run.textPurgedAt !== null ? { state: "SKIPPED", skip: "TEXT_PURGED" } : { state: "FAILED", failure: "CANCELLED" }) : end;
      if (resolved.state === "DONE") await deps.writeState(run, "DONE", {}, deps.now());
      else if (resolved.state === "REFUSED") await deps.writeState(run, "REFUSED", { refusal: resolved.refusal }, deps.now());
      else if (resolved.state === "SKIPPED") await deps.writeState(run, "SKIPPED", { skip: resolved.skip }, deps.now());
      else await deps.writeState(run, "FAILED", { failure: resolved.failure }, deps.now());
      /* the row as the end left it, whichever attempt wrote it: the record and the line say what it says */
      const ended = await row(input);
      const settled = endOfRow(ended, resolved);
      await deps.record(ended, settled);
      const findings = await deps.findings(ended);
      const line = runEndOf(settled);
      deps.line(
        researchLineOf("run", at(ended), line.state, Math.max(0, deps.now().getTime() - ended.createdAt.getTime()), {
          code: line.code,
          searches: ended.searches,
          pageReads: ended.pageReads,
          findings: findings.filter((finding) => finding.outcome !== "INVALID").length,
        }),
      );
      return { state: ended.state };
    },

    async abandonRun(input) {
      const run = await deps.readRow(input.runId, input.userId);
      if (run === null) return;
      const { written } = await deps.writeState(run, "FAILED", { failure: "INTERNAL" }, deps.now());
      if (written) deps.line(researchLineOf("run", at(run), "FAILED", Math.max(0, deps.now().getTime() - run.createdAt.getTime()), { code: "INTERNAL", searches: run.searches, pageReads: run.pageReads }));
    },
  };
}

export const researchRunActivitiesDefault: ResearchRunActivities = researchRunActivities();
