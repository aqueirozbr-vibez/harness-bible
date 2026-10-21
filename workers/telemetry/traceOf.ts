import type { ResearchTrace } from "@/lib/db/research";
import { RESEARCH_WORKFLOW } from "@/lib/schemas/workflows";
import type { TraceAttributes } from "@/lib/telemetry/langfuse";
import { subjectOf, suggestionTraceId, traceAttributesOf, workflowTraceId } from "@/lib/telemetry/subjects";

/*
 * The trace a workflow's activity is filed under (feature-specs/49 § 7.2): its subject's, from the workflow's id alone
 * where the id names it (a suggestion, a merge, an export, the proving run), and by one primary-key read where the id
 * names a record whose trace is stored (a research run, a finding's send) or whose subject is another record's (an
 * evidence item's grade). No cache: a cache would need a size, and an activity already makes reads of its own.
 */

/** The three reads, each by primary key; the defaults are lib/db's doors (workers/telemetry/activities.ts). */
export interface TraceLookups {
  readonly suggestionOfEvidenceItem: (itemId: string) => Promise<string | null>;
  readonly researchTraceOf: (id: string) => Promise<ResearchTrace | null>;
  readonly researchTraceOfFinding: (findingId: string) => Promise<ResearchTrace | null>;
}

export interface ActivityTrace {
  readonly traceId: string;
  /** The subject's trace attributes (§ 6.4); none for the legacy research workflow, whose runs carry their turn's. */
  readonly trace?: TraceAttributes;
  /** The legacy research workflow: its spans carry the mark and their run's id instead (§ 6.4). */
  readonly legacy: boolean;
  readonly runId: string | null;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "Error");

/**
 * Resolves the trace. A read that fails or finds nothing (a run deleted, a finding detached, an item removed) falls
 * back to `workflowTraceId(workflowId)` and says so in one warning line, with the workflow's type and the error's
 * name: a span may land in a trace of its own, and the activity runs either way.
 */
export async function traceOf(workflowType: string, workflowId: string, lookups: TraceLookups, warn: (line: string) => void): Promise<ActivityTrace> {
  const legacy = workflowType === RESEARCH_WORKFLOW;
  const subject = subjectOf(workflowId);
  const derived = (cause: string | null): ActivityTrace => {
    if (cause !== null) warn(`telemetry: ${workflowType}'s activity is filed under its workflow's own trace (${cause})`);
    const trace = traceAttributesOf(workflowType, { workflowId });
    return { traceId: workflowTraceId(workflowId), ...(trace === undefined ? {} : { trace }), legacy, runId: null };
  };
  const ofRun = (found: ResearchTrace | null): ActivityTrace => {
    if (found === null) return derived("NOT_FOUND");
    const trace = traceAttributesOf(workflowType, { workflowId, runId: found.runId });
    return { traceId: found.traceId, ...(trace === undefined ? {} : { trace }), legacy, runId: found.runId };
  };
  try {
    switch (subject.kind) {
      case "suggestion": {
        const trace = traceAttributesOf(workflowType, { workflowId, suggestionId: subject.suggestionId });
        return { traceId: suggestionTraceId(subject.suggestionId), ...(trace === undefined ? {} : { trace }), legacy, runId: null };
      }
      case "evidence": {
        const suggestionId = await lookups.suggestionOfEvidenceItem(subject.itemId);
        if (suggestionId === null) return derived("NOT_FOUND");
        const trace = traceAttributesOf(workflowType, { workflowId, suggestionId });
        return { traceId: suggestionTraceId(suggestionId), ...(trace === undefined ? {} : { trace }), legacy, runId: null };
      }
      case "research":
        /* one id form for both research workflows: a person's run is read by its id first, a legacy one by its message's */
        return ofRun(await lookups.researchTraceOf(subject.id));
      case "finding":
        return ofRun(await lookups.researchTraceOfFinding(subject.findingId));
      case "workflow":
        return derived(null);
    }
  } catch (error: unknown) {
    return derived(errorName(error));
  }
}
