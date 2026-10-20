import { ApplicationFailure } from "@temporalio/activity";

import { researchCallsOf, type ResearchCallRow } from "@/lib/db/budget";
import { researchRecordAt } from "@/lib/db/ledger";
import { readFindings, type ResearchRunRow } from "@/lib/db/research";
import { AppError } from "@/lib/errors";
import { loadGuidePart } from "@/lib/guides/load";
import { append } from "@/lib/ledger/append";
import { stepKeyOf } from "@/lib/ledger/hash";
import { researchPayloadOf, runEndOf, type RecordFacts } from "@/lib/research/record";
import type { Principal } from "@/lib/schemas/gateway";
import type { FindingOutcome } from "@/lib/schemas/research";

import { RESEARCHER_GUIDE_VERSION, researchPrincipalOf } from "./plan";

/*
 * The `RESEARCH` record of a run (feature-specs/40 § 6.3; unit 58e), appended by the conclude step as
 * `service:researcher`, with no suggestion and no chapter version: that research ran and what came of it. Its facts
 * are read where they are — the findings' rows in the asker's context, the model calls' rows under the research
 * principal — and `researchPayloadOf` builds the payload or says there is nothing to record (a run that never
 * planned). The step key is `sha256(workflowId + ":research:1")`, so a retried conclude finds the record it wrote
 * (28 § 4.4). A payload the schema refuses is the code's error and is not retried.
 */

export type ResearchEnd = { readonly state: "DONE" } | { readonly state: "SKIPPED"; readonly skip: "NOTHING_TO_RESEARCH" | "TEXT_PURGED" } | { readonly state: "FAILED"; readonly failure: string };

export interface RecordStepDeps {
  readonly principal: () => Principal | null;
  readonly guide: () => { readonly version: string; readonly sha256: string };
  readonly readFindings: (run: Pick<ResearchRunRow, "id" | "userId">) => Promise<ReadonlyArray<{ readonly ordinal: number; readonly outcome: FindingOutcome }>>;
  readonly calls: (principal: Principal, runId: string) => Promise<ReadonlyArray<ResearchCallRow>>;
  readonly recordAt: (stepKey: string) => Promise<{ readonly seq: number } | null>;
  readonly append: typeof append;
  readonly log: (line: string) => void;
}

export function defaultRecordStepDeps(): RecordStepDeps {
  return {
    principal: () => researchPrincipalOf(),
    guide: () => {
      const part = loadGuidePart("researcher", RESEARCHER_GUIDE_VERSION, "planner");
      return { version: part.version, sha256: part.sha256 };
    },
    readFindings,
    calls: researchCallsOf,
    recordAt: researchRecordAt,
    append,
    log: (line) => console.info(line),
  };
}

/**
 * What the run planned, from its row and its end: a brief where its hash stands; nothing where the planner said so; failed
 * where the run ended FAILED with no brief for a reason that is the planner's or the brief sensor's (the call was made);
 * null where it never planned — unconfigured, or the text purged before.
 */
export function plannedOf(run: Pick<ResearchRunRow, "briefSha256">, end: ResearchEnd): "brief" | "nothing" | "failed" | null {
  if (run.briefSha256 !== null) return "brief";
  if (end.state === "SKIPPED" && end.skip === "NOTHING_TO_RESEARCH") return "nothing";
  if (end.state === "FAILED" && (end.failure === "PLANNER_FAILED" || end.failure.startsWith("BRIEF_"))) return "failed";
  return null;
}

/** The record, written once; `null` where the run has nothing to record. */
export async function recordResearch(run: ResearchRunRow, end: ResearchEnd, deps: RecordStepDeps = defaultRecordStepDeps()): Promise<{ readonly seq: number } | null> {
  const planned = plannedOf(run, end);
  if (planned === null) return null;
  const principal = deps.principal();
  if (principal === null) return null;
  /* a run that concludes has its workflow; one skipped before any planned nothing (45 § 3.5) */
  if (run.workflowId === null) return null;
  const stepKey = stepKeyOf(run.workflowId, "research:1");
  const found = await deps.recordAt(stepKey);
  if (found !== null) return { seq: found.seq };
  const [findings, calls] = await Promise.all([deps.readFindings(run), deps.calls(principal, run.id)]);
  const facts: RecordFacts = { run, planned, end: runEndOf(end), findings, calls, guide: deps.guide(), stepKey };
  const payload = researchPayloadOf(facts);
  if (payload === null) {
    deps.log(`research ${run.id}: no RESEARCH record — the run planned ${planned} but its calls' rows do not say by what (trace ${run.traceId})`);
    return null;
  }
  try {
    const record = await deps.append({ kind: "RESEARCH", payload, actor: "service:researcher", suggestionId: null, chapterVersionId: null });
    return { seq: record.seq };
  } catch (error: unknown) {
    if (error instanceof AppError && (error.code === "LEDGER_PAYLOAD" || error.code === "LEDGER_COLUMNS")) throw ApplicationFailure.nonRetryable(`research record of ${run.id}: ${error.message}`, error.code);
    throw error;
  }
}
