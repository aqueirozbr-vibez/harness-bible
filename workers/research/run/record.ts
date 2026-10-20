import { ApplicationFailure } from "@temporalio/activity";

import { researchCallsOf, type TimedResearchCallRow } from "@/lib/db/budget";
import { researchRecordAt } from "@/lib/db/ledger";
import { readFindings, readRunReport, type ConversationRunRow, type RunRef } from "@/lib/db/research";
import { AppError } from "@/lib/errors";
import { loadGuidePart } from "@/lib/guides/load";
import { append } from "@/lib/ledger/append";
import { canonicalize, type JsonValue } from "@/lib/ledger/canonical";
import { sha256Hex, stepKeyOf } from "@/lib/ledger/hash";
import { personPayloadOf, type PersonRunEnd } from "@/lib/research/record";
import type { Principal } from "@/lib/schemas/gateway";
import type { FindingOutcome } from "@/lib/schemas/research";
import type { Report } from "@/lib/schemas/researcher";

import { principalOfRun, RESEARCHER_V2_GUIDE_VERSION } from "./plan";

/*
 * The `RESEARCH` record of a person's run (feature-specs/48 § 15; unit 70b), appended once by the conclude step, after
 * the run's end state, by the step key `sha256(workflowId + ":research:1")`, so a retried conclude finds the record it
 * wrote (28 § 4.4). The actor is the person who asked and paid, `user:<id>`, as an `ANSWER` record's is the reader; it
 * names no suggestion and no message. Its calls are read where they were charged — under the person's own principal,
 * from the run's `organisationId` and `userId` — so it needs no research principal; the reader's and the writer's
 * frontier calls are told apart by the run's `writingAt` (lib/research/record.ts). The report's hash is of its
 * canonical form (RFC 8785, the ledger's own), so the same paragraphs hash alike whatever the column's key order. A
 * payload the schema refuses is the code's error and is not retried.
 */

export interface PersonRecordDeps {
  readonly guide: () => { readonly version: string; readonly sha256: string };
  readonly readFindings: (run: RunRef) => Promise<ReadonlyArray<{ readonly ordinal: number; readonly outcome: FindingOutcome }>>;
  readonly readReport: (run: RunRef) => Promise<Report | null>;
  readonly calls: (principal: Principal, runId: string) => Promise<ReadonlyArray<TimedResearchCallRow>>;
  readonly recordAt: (stepKey: string) => Promise<{ readonly seq: number } | null>;
  readonly append: typeof append;
  readonly log: (line: string) => void;
}

export function defaultPersonRecordDeps(): PersonRecordDeps {
  return {
    guide: () => {
      const part = loadGuidePart("researcher", RESEARCHER_V2_GUIDE_VERSION, "planner");
      return { version: part.version, sha256: part.sha256 };
    },
    readFindings,
    readReport: readRunReport,
    calls: researchCallsOf,
    recordAt: researchRecordAt,
    append,
    log: (line) => console.info(line),
  };
}

/** The report's hash: sha256 over its canonical JSON. */
export function reportSha256Of(report: Report): string {
  return sha256Hex(canonicalize(report as unknown as JsonValue));
}

/** The record, written once; null where the run has nothing to record: no planner answered it, or its calls' rows do not say by what. */
export async function recordPersonRun(run: ConversationRunRow, end: PersonRunEnd, deps: PersonRecordDeps = defaultPersonRecordDeps()): Promise<{ readonly seq: number } | null> {
  /* a run that concludes has its workflow; one refused by rule at its start has none, and no record (48 § 15) */
  if (run.workflowId === null) return null;
  const stepKey = stepKeyOf(run.workflowId, "research:1");
  const found = await deps.recordAt(stepKey);
  if (found !== null) return { seq: found.seq };
  const [findings, calls, report] = await Promise.all([deps.readFindings(run), deps.calls(principalOfRun(run), run.id), deps.readReport(run)]);
  const payload = personPayloadOf({ run, end, findings, calls, guide: deps.guide(), stepKey, reportSha256: report === null ? null : reportSha256Of(report) });
  if (payload === null) {
    deps.log(`research ${run.id}: no RESEARCH record — no planner answered the run, or its calls' rows do not say by what (trace ${run.traceId})`);
    return null;
  }
  try {
    const record = await deps.append({ kind: "RESEARCH", payload, actor: `user:${run.userId}`, suggestionId: null, chapterVersionId: null });
    return { seq: record.seq };
  } catch (error: unknown) {
    if (error instanceof AppError && (error.code === "LEDGER_PAYLOAD" || error.code === "LEDGER_COLUMNS")) throw ApplicationFailure.nonRetryable(`research record of ${run.id}: ${error.message}`, error.code);
    throw error;
  }
}
