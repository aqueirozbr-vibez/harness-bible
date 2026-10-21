import { sha256Hex } from "@/lib/ledger/hash";
import type { TraceAttributes } from "@/lib/telemetry/langfuse";
import {
  EXPORT_WORKFLOW,
  FindingWorkflowIdSchema,
  GRADE_EVIDENCE_WORKFLOW,
  GradeEvidenceWorkflowIdSchema,
  MERGE_WORKFLOW,
  MergeWorkflowIdSchema,
  PROVING_WORKFLOW,
  RESEARCH_RUN_WORKFLOW,
  RESEARCH_WORKFLOW,
  ResearchWorkflowIdSchema,
  SEND_FINDING_WORKFLOW,
  SUGGESTION_WORKFLOW,
  SuggestionWorkflowIdSchema,
} from "@/lib/schemas/workflows";

/*
 * The subjects a workflow's work belongs to, and their traces (feature-specs/49 § 6.1, § 7.2): the pure half of the
 * activity spans' resolution, which `workers/telemetry/traceOf.ts` completes with a read where a workflow's id names
 * a record and not its trace. A trace id derived from a seed, as Langfuse's own SDKs derive one, can be found again
 * from the seed alone: a suggestion's from its id, any other workflow's from its workflow id.
 */

/** A suggestion's one trace, its whole life long: the first 32 hex of sha256(`suggestion:` + its id). */
export function suggestionTraceId(suggestionId: string): string {
  return sha256Hex(`suggestion:${suggestionId}`).slice(0, 32);
}

/** The trace of a workflow no record names one for (an export, the engine's proving run), or whose record is gone. */
export function workflowTraceId(workflowId: string): string {
  return sha256Hex(`workflow:${workflowId}`).slice(0, 32);
}

/** What a workflow id names (§ 7.2's rows), by the id forms of lib/schemas/workflows.ts. */
export type WorkflowSubject =
  | { readonly kind: "suggestion"; readonly suggestionId: string }
  | { readonly kind: "evidence"; readonly itemId: string }
  | { readonly kind: "research"; readonly id: string }
  | { readonly kind: "finding"; readonly findingId: string }
  | { readonly kind: "workflow" };

const afterPrefix = (workflowId: string): string => workflowId.slice(workflowId.indexOf(":") + 1);

export function subjectOf(workflowId: string): WorkflowSubject {
  if (SuggestionWorkflowIdSchema.safeParse(workflowId).success || MergeWorkflowIdSchema.safeParse(workflowId).success) return { kind: "suggestion", suggestionId: afterPrefix(workflowId) };
  if (GradeEvidenceWorkflowIdSchema.safeParse(workflowId).success) return { kind: "evidence", itemId: afterPrefix(workflowId) };
  /* a run's id for a person's run, its message's for a legacy one: one form (lib/schemas/workflows.ts) */
  if (ResearchWorkflowIdSchema.safeParse(workflowId).success) return { kind: "research", id: afterPrefix(workflowId) };
  if (FindingWorkflowIdSchema.safeParse(workflowId).success) return { kind: "finding", findingId: afterPrefix(workflowId) };
  return { kind: "workflow" };
}

/** The record ids a subject's trace attributes may carry (§ 6.4, § 6.5): ids of records, never a person's. */
export interface SubjectIds {
  readonly workflowId: string;
  readonly runId?: string | null;
  readonly suggestionId?: string | null;
}

/**
 * The trace name, tags and metadata of a workflow's activities (§ 6.4, § 7.2), by its type. The legacy research
 * workflow has none: its runs carry their turn's trace, whose name and tags are the turn's. A workflow type this table
 * does not name has none either.
 */
export function traceAttributesOf(workflowType: string, ids: SubjectIds): TraceAttributes | undefined {
  switch (workflowType) {
    case RESEARCH_RUN_WORKFLOW:
    case SEND_FINDING_WORKFLOW:
      return { name: "research.run", tags: ["research"], metadata: ids.runId == null ? {} : { run_id: ids.runId } };
    case SUGGESTION_WORKFLOW:
    case GRADE_EVIDENCE_WORKFLOW:
    case MERGE_WORKFLOW:
      return { name: "suggestion", tags: ["suggestion"], metadata: ids.suggestionId == null ? {} : { suggestion_id: ids.suggestionId } };
    case EXPORT_WORKFLOW:
      return { name: "export", tags: ["export"], metadata: { workflow_id: ids.workflowId } };
    case PROVING_WORKFLOW:
      return { name: "engine.check", tags: ["check"], metadata: { workflow_id: ids.workflowId } };
    case RESEARCH_WORKFLOW:
    default:
      return undefined;
  }
}
