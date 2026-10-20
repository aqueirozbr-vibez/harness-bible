import "dotenv/config";

import { parseArgs } from "node:util";

import { logJob } from "@/lib/api/log";
import { newTraceId } from "@/lib/api/trace";
import { purgeAssistantText, TEXT_RETENTION_DAYS } from "@/lib/db/assistant";
import { getPrisma } from "@/lib/db/client";
import { purgeResearchRuns, sweepDetachedRuns } from "@/lib/db/research";
import { FindingWorkflowIdSchema, RESEARCH_WORKFLOW, SEND_FINDING_WORKFLOW } from "@/lib/schemas/workflows";
import { ANSWER_DEADLINE_MS } from "@/lib/workers/client";
import { closeWorkflowsEngines, WorkflowsUnavailableError, workflowRunning } from "@/lib/workflows/client";
import { startTelemetry, stopTelemetry } from "@/lib/telemetry/tracer";

/*
 * npm run assistant:purge (feature-specs/15 § 8): the nightly retention run. A reader's words live 30 days; their
 * citations, verdicts, flags, timings and hashes live on, and so does every ledger record — the record proves what
 * was answered by its hashes, so it still matches a conversation whose words are gone (invariant 18). This run
 * appends no ledger record of its own. Since unit 70 it then purges a person's research the same way, each run by its
 * own age (feature-specs/48 § 17.1). Since unit 62f it then sweeps the research runs a conversation's delete
 * detached, once the cap's 24 hours have passed and the engine says their workflows have ended (feature-specs/45
 * § 3.5) — since unit 70 a run detached from a research conversation too, and the sent findings it kept while their
 * workflows ran (48 § 17.2); an engine it cannot reach skips that step for the night, and the line says so.
 *
 * The schedule is code outside the application until Temporal (code-standards § Data; feature-specs/21 § 3.1):
 * `infra/schedules/` holds the crontab and the Windows registration. `npm run auth:sweep` stays separate: it clears
 * sessions, keys and audit rows. Each run prints its counts and one `kind: "job"` line; a run that throws prints the
 * line with its error and exits 1.
 *
 * Two values it does not invent (rules § 4.5): the retention window is the architecture's 30 days, and a turn
 * counts as abandoned after the `/answer` route's own deadline, which is spec 11's timeouts summed — the longest a
 * flow can still be running. `--now` moves the clock for the verification of § 12.6 and nothing else.
 */

function usage(message: string): never {
  console.error(`${message}\nusage: npm run assistant:purge [-- --now <ISO instant>]`);
  process.exit(1);
}

function parse(): { readonly now: Date } {
  const { values } = parseArgs({ options: { now: { type: "string" } }, strict: true });
  if (values.now === undefined) return { now: new Date() };
  const now = new Date(values.now);
  if (Number.isNaN(now.getTime())) usage(`--now must be an ISO instant, not ${values.now}`);
  return { now };
}

const ABANDONED_AFTER_MS = ANSWER_DEADLINE_MS;
const JOB = "assistant:purge";

/**
 * Whether the workflow under `workflowId` still runs, for the sweep: a run's, `research:<id>`, of either research
 * workflow, which share the id's form; or a sent finding's, `finding:<id>` (feature-specs/48 § 8.4), which is
 * SendFindingWorkflow's, asked of the engine as a run's is since unit 74 entered it in WORKFLOWS. Null where the engine
 * cannot be reached: the sweep stops for the night.
 */
async function engineRunning(workflowId: string): Promise<boolean | null> {
  try {
    return FindingWorkflowIdSchema.safeParse(workflowId).success ? await workflowRunning(SEND_FINDING_WORKFLOW, workflowId) : await workflowRunning(RESEARCH_WORKFLOW, workflowId);
  } catch (error: unknown) {
    if (error instanceof WorkflowsUnavailableError) return null;
    throw error;
  }
}

async function main(): Promise<void> {
  /* The job's line is a span too when a collector is configured (feature-specs/21 § 5.1). */
  await startTelemetry("hb-jobs");
  const { now } = parse();
  const traceId = newTraceId();
  const started = performance.now();
  try {
    const counts = await purgeAssistantText({ now, abandonedAfterMs: ABANDONED_AFTER_MS });
    console.log(
      `assistant:purge kept ${String(TEXT_RETENTION_DAYS)} days: ${String(counts.messages)} message(s), ${String(counts.citations)} citation(s) and ${String(counts.modeResults)} mode result(s) cleared, ` +
        `${String(counts.conversations)} conversation(s) marked purged, ${String(counts.closed)} abandoned turn(s) closed, across ${String(counts.readers)} reader(s)`,
    );
    /* a person's research, each run by its own age (feature-specs/48 § 17.1) */
    const research = await purgeResearchRuns({ now });
    console.log(`assistant:purge kept ${String(TEXT_RETENTION_DAYS)} days of research: ${String(research.runs)} run(s) emptied, ${String(research.conversations)} research(es) marked purged, across ${String(research.readers)} reader(s)`);
    /* an engine that cannot be reached answers null: the sweep stops for the night rather than guess */
    const swept = await sweepDetachedRuns({ now, running: engineRunning });
    console.log(
      swept.engineAnswered
        ? `assistant:purge swept ${String(swept.deleted)} detached research run(s), kept ${String(swept.running)} still running, ${String(swept.proposalsKept)} proposal(s) and ${String(swept.findingsKept)} finding(s) still being sent, deleted ${String(swept.findingsDeleted)} detached finding(s) no longer owed, across ${String(swept.readers)} reader(s)`
        : `assistant:purge skipped the rest of the research sweep: the workflow engine could not be reached (${String(swept.deleted)} detached run(s) swept before it)`,
    );
    logJob({
      traceId,
      job: JOB,
      counts: {
        ...counts,
        researchRunsPurged: research.runs,
        researchesPurged: research.conversations,
        sweptRuns: swept.deleted,
        sweptRunning: swept.running,
        sweptProposalsKept: swept.proposalsKept,
        sweptFindingsKept: swept.findingsKept,
        sweptFindingsDeleted: swept.findingsDeleted,
        sweepEngineAnswered: swept.engineAnswered ? 1 : 0,
      },
      ms: Math.round(performance.now() - started),
    });
  } catch (error: unknown) {
    logJob({ traceId, job: JOB, counts: {}, ms: Math.round(performance.now() - started), error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    throw error;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeWorkflowsEngines();
    await stopTelemetry();
    await getPrisma().$disconnect();
  });
