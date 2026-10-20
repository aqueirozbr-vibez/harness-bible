import { z } from "zod";

import { FindingFailureSchema, ResearchStateSchema } from "@/lib/schemas/research";

import { ReleaseIdSchema, SuggestionIdSchema } from "@/lib/schemas/ids";
import { EvidenceTierSchema } from "@/lib/schemas/domain";
import { DecisionSchema, EvidenceStateSchema, SuggestionSensorSchema, SuggestionStateSchema } from "@/lib/schemas/improve";
import { RouteSchema } from "@/lib/schemas/rubric";

/*
 * The workflow engine's vocabulary, shared by the web tier, the workers and the workflow code itself
 * (feature-specs/28). The address and the namespace the environment names; the task queues; and for each workflow
 * its name, the schema of its argument and of its result, its signals and its id.
 *
 * Workflow code imports this file, so it must stay pure: zod, other schemas, constants and functions of their
 * arguments. Nothing here may read a clock, the environment or the network.
 */

const MAX_PORT = 65_535;

/** The engine's frontend as its SDK takes it: a host and a port, no scheme (`127.0.0.1:7233`, `temporal:7233`). */
export const TemporalAddressSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:[1-9]\d{0,4}$/, "a host and a port, without a scheme: 127.0.0.1:7233")
  .refine((value) => Number(value.slice(value.lastIndexOf(":") + 1)) <= MAX_PORT, "the port is at most 65535");

/** A namespace of the engine: lower-case letters, digits and hyphens, as compose registers `harness-bible`. */
export const TemporalNamespaceSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lower-case letters, digits and hyphens: harness-bible");

/**
 * The two task queues (feature-specs/28 § 4.1). Two, so that a month's research waiting on its budget never holds a
 * suggestion back: suggestions, merges and exports on one, research on the other.
 */
export const TASK_QUEUES = { improve: "hb-improve", research: "hb-research" } as const;
export type TaskQueue = (typeof TASK_QUEUES)[keyof typeof TASK_QUEUES];

/*
 * ProvingWorkflow (feature-specs/28 § 4.5): the engine's own health check. It reads the release id, waits for
 * `proceed` or a minute, reads the ledger's head, and returns the three. Asked `stage`, it says which of those it
 * is doing: the one query of the workflow that exists to prove that a workflow can be started, signalled and asked.
 */
export const PROVING_WORKFLOW = "ProvingWorkflow";
export const PROVING_SIGNAL = "proceed";
export const PROVING_QUERY = "stage";
export const ProvingInputSchema = z.strictObject({ token: z.uuid() });
export type ProvingInput = z.infer<typeof ProvingInputSchema>;
export const ProvingResultSchema = z.strictObject({ releaseId: ReleaseIdSchema, headSeq: z.int().nonnegative(), signalled: z.boolean() });
export type ProvingResult = z.infer<typeof ProvingResultSchema>;

/** Reading the release, waiting for `proceed`, reading the ledger's head, returned. */
export const ProvingStageSchema = z.enum(["release", "waiting", "head", "done"]);
export type ProvingStage = z.infer<typeof ProvingStageSchema>;

/** `proving:<uuid>`. The id is the deduplication: a second start with a running id returns the running one (28 § 4.3). */
export const ProvingWorkflowIdSchema = z.templateLiteral(["proving:", z.uuid()]);
export function provingWorkflowId(token: string): string {
  return `proving:${token}`;
}

/*
 * SuggestionWorkflow (feature-specs/31 § 6, 33): started by the submit endpoint under `suggestion:<id>` with the
 * suggestion's id, signalled `revised` when its owner submits it again with new evidence (31 § 6.5). Since unit 50a it
 * runs steps 1 to 4 of spec 33 § 3 and ends with where it left the suggestion; 48d's stand-in of this name is gone.
 */
export const SUGGESTION_WORKFLOW = "SuggestionWorkflow";
export const SUGGESTION_REVISED_SIGNAL = "revised";
/**
 * A revision, as the submit endpoint signals it (31 § 6.5; 33 § 20): the decision it answers, by the suggestion's
 * `decidedAt` as the endpoint read it, so that the run tells a revision of the decision that stands from one sent
 * against an earlier decision.
 */
export const RevisedSignalSchema = z.strictObject({ decidedAt: z.iso.datetime() });
export type RevisedSignal = z.infer<typeof RevisedSignalSchema>;
/** A curator's decision, as the decision endpoint signals it (36 § 5.1 step 5; 33 § 6.3): the action's id only (28 § 5.3). */
export const SUGGESTION_CURATOR_SIGNAL = "curatorDecision";
export const CuratorDecisionSignalSchema = z.strictObject({ actionId: z.uuid() });
export type CuratorDecisionSignal = z.infer<typeof CuratorDecisionSignalSchema>;
/**
 * An endorsement, as the endorse endpoint signals it (42 § 6; unit 59d): whose name — the reader's id, which the record
 * carries as their pseudonym — the instant of the consent the row holds, and whether this takes it back. No text (28 § 5.3);
 * the row itself is the asker's and the activity does not read it.
 */
export const SUGGESTION_ENDORSED_SIGNAL = "endorsed";
export const EndorsedSignalSchema = z.strictObject({ userId: z.uuid(), at: z.iso.datetime(), withdrawn: z.boolean() });
export type EndorsedSignal = z.infer<typeof EndorsedSignalSchema>;
/**
 * A contributor's withdrawal, as the withdraw endpoint signals it (feature-specs/45 § 5.2; unit 63c): whose — the
 * contributor's id — the instant the request was written on the row, and the decision it was made against, by the
 * suggestion's `decidedAt` as the request read it, null where the queue holds one with none. Ids and instants only (28 § 5.3).
 */
export const SUGGESTION_WITHDRAWN_SIGNAL = "withdrawn";
export const WithdrawnSignalSchema = z.strictObject({ userId: z.uuid(), at: z.iso.datetime(), decidedAt: z.iso.datetime().nullable() });
export type WithdrawnSignal = z.infer<typeof WithdrawnSignalSchema>;
/** What a run waits for where its decision left the suggestion (33 § 6.3 to § 6.5): a curator, a revision, or both; null while an attempt runs, and at an end. */
export const SUGGESTION_WAITS_QUERY = "waits";
export const SuggestionWaitsSchema = z.strictObject({ curator: z.boolean(), revision: z.boolean() }).nullable();
export type SuggestionWaits = z.infer<typeof SuggestionWaitsSchema>;
export const SuggestionWorkflowInputSchema = z.strictObject({ suggestionId: SuggestionIdSchema });
export type SuggestionWorkflowInput = z.infer<typeof SuggestionWorkflowInputSchema>;
/**
 * Where steps 1 to 4 left the suggestion (33 § 3; unit 50a): its state, which stays `SUBMITTED` until unit 50e's
 * decision moves it; the route — step 4's, or `DECLINE_AT_INTAKE` with the sensor that failed at step 2 — or null
 * when a grade waits on the budget (50f); the tier a rule named; and the score, null before step 3 has run.
 */
export const SuggestionWorkflowResultSchema = z.strictObject({
  suggestionId: SuggestionIdSchema,
  state: SuggestionStateSchema,
  route: RouteSchema.nullable(),
  failingSensor: SuggestionSensorSchema.nullable(),
  namedTier: EvidenceTierSchema.nullable(),
  /* No ceiling: a strongest item at 100 with the corroboration bonus scores above it (30 § 3.3), as the graded record may say. */
  score: z.number().int().nonnegative().nullable(),
  /* The decided record's (unit 50e): a rule's, the curator's, or the adjudicator's — CURATOR_REVIEW for its failure or the policy's refusal; null when nothing was decided, while the budget waits. Since unit 54b also the merge's: CURATOR_REVIEW when `main` moved under the anchor, REQUEST_MORE when the check failed. `state` is where the decision, or the merge, left the suggestion. */
  decision: DecisionSchema.nullable(),
  sufficientTier: EvidenceTierSchema.nullable(),
});
export type SuggestionWorkflowResult = z.infer<typeof SuggestionWorkflowResultSchema>;
/** `suggestion:S-21-0016`: the suggestion's own id, so a second submit is handed the running workflow (28 § 4.3). */
export const SuggestionWorkflowIdSchema = z.string().regex(/^suggestion:S-\d{2}-\d{4,}$/, "a workflow id like suggestion:S-21-0016");
export function suggestionWorkflowId(suggestionId: string): string {
  return `suggestion:${suggestionId}`;
}

/*
 * GradeEvidenceWorkflow (feature-specs/32 § 8; unit 49e): started by the add endpoint under `evidence:<itemId>` for
 * one item, it runs three activities — fetch or open, extract and store the text, grade — and answers the stage it
 * is at to the `stage` query, the number the form's loader shows. It returns where it left the item: `GRADED` with
 * the tier, or `PENDING` when the principal's budget refused the grade (§ 8: the item waits, with the reset date on
 * its row). Nothing it carries is text: the document and the grade's reason are rows and objects, read by the
 * activities (28 § 5.3).
 */
export const GRADE_EVIDENCE_WORKFLOW = "GradeEvidenceWorkflow";
export const GRADE_EVIDENCE_STAGE_QUERY = "stage";
export const GradeEvidenceInputSchema = z.strictObject({ itemId: z.uuid() });
export type GradeEvidenceInput = z.infer<typeof GradeEvidenceInputSchema>;
export const GradeEvidenceStageSchema = z.enum(["1 of 3", "2 of 3", "3 of 3"]);
export type GradeEvidenceStage = z.infer<typeof GradeEvidenceStageSchema>;
export const GradeEvidenceResultSchema = z.strictObject({ itemId: z.uuid(), state: EvidenceStateSchema, tier: EvidenceTierSchema.nullable() });
export type GradeEvidenceResult = z.infer<typeof GradeEvidenceResultSchema>;
export const GradeEvidenceWorkflowIdSchema = z.string().regex(/^evidence:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a workflow id like evidence:<itemId>");
export function gradeEvidenceWorkflowId(itemId: string): string {
  return `evidence:${itemId}`;
}

/*
 * MergeWorkflow (feature-specs/37 § 4; unit 54b): the child a suggestion's workflow starts under `merge:<id>` where a
 * decision leaves the suggestion to merge. It prepares the branch and checks it, then waits where the merge cannot go on
 * — the repository unavailable, a curator's hand needed, the lab not run, a step failed, or passed until the curator's
 * merge (54c) — for `recheck`, which `Re-run check` sends; asked `stage`, it says where it is. It returns where it left
 * the suggestion: back with a curator when `main` moved under the anchor, returned as a request for more when the check
 * failed.
 */
export const MERGE_WORKFLOW = "MergeWorkflow";
export const MERGE_RECHECK_SIGNAL = "recheck";
/** A curator's merge (37 § 5; unit 54c): the action's id only (28 § 5.3), which the endpoint wrote. */
export const MERGE_SIGNAL = "merge";
export const MergeSignalSchema = z.strictObject({ actionId: z.uuid() });
export const MERGE_STAGE_QUERY = "stage";
/** A revert's merge (37 § 8; unit 54e) is told the curator's action from the start: it merges once its check passes, with no second press. */
export const MergeWorkflowInputSchema = z.strictObject({ suggestionId: SuggestionIdSchema, actionId: z.uuid().optional() });
export type MergeWorkflowInput = z.infer<typeof MergeWorkflowInputSchema>;
/**
 * Preparing, checking, or waiting for `recheck` where the merge cannot go on: the repository unavailable, a curator's
 * hand, the lab not run, passed, or a step that failed; and merging into `main` once a curator merged (unit 54c).
 */
export const MergeStageSchema = z.enum(["PREPARING", "CHECKING", "UNAVAILABLE", "MANUAL", "NOT_RUN", "PASSED", "STEP_FAILED", "MERGING", "FAILED", "MOVED"]);
export type MergeStage = z.infer<typeof MergeStageSchema>;
export const MergeWorkflowResultSchema = z.strictObject({ suggestionId: SuggestionIdSchema, state: SuggestionStateSchema, decision: DecisionSchema.nullable() });
export type MergeWorkflowResult = z.infer<typeof MergeWorkflowResultSchema>;
/** `merge:S-36-0198`: the suggestion's own id, so one suggestion has one merge running. */
export const MergeWorkflowIdSchema = z.string().regex(/^merge:S-\d{2}-\d{4,}$/, "a workflow id like merge:S-36-0198");
export function mergeWorkflowId(suggestionId: string): string {
  return `merge:${suggestionId}`;
}

/**
 * ExportWorkflow (feature-specs/38 § 3; unit 55b): the audit pack under `export:<id>`, the `AuditExport` row's id. It
 * writes the pack to the store, re-reads and verifies it, appends the `EXPORT` record and makes the row `READY`;
 * where the store is unavailable it retries, and nothing is appended until the file exists (38 § 5). Asked `stage`,
 * it says where it is.
 */
export const EXPORT_WORKFLOW = "ExportWorkflow";
export const EXPORT_STAGE_QUERY = "stage";
export const ExportWorkflowInputSchema = z.strictObject({ exportId: z.uuid() });
export type ExportWorkflowInput = z.infer<typeof ExportWorkflowInputSchema>;
export const ExportStageSchema = z.enum(["WRITING", "RECORDING", "READY"]);
export type ExportStage = z.infer<typeof ExportStageSchema>;
export const ExportWorkflowResultSchema = z.strictObject({ exportId: z.uuid(), records: z.int().nonnegative(), headHash: z.string().regex(/^[0-9a-f]{64}$/) });
export type ExportWorkflowResult = z.infer<typeof ExportWorkflowResultSchema>;
export const ExportWorkflowIdSchema = z.string().regex(/^export:[0-9a-f-]{36}$/, "a workflow id like export:<the row's uuid>");
export function exportWorkflowId(exportId: string): string {
  return `export:${exportId}`;
}

/**
 * ResearchWorkflow (feature-specs/40 § 6.2; unit 57d): the research run of one answered turn, under `research:<messageId>`
 * on the research queue, started at the turn's end once the run's row was QUEUED — until unit 75, which took the hand-over
 * out of the turn (feature-specs/48 § 9.2): nothing starts one now, and it stays registered for the runs still waiting
 * until unit 78 removes it. It loads the turn inside the reader's own tenant context, plans, reads, validates, submits
 * one suggestion per valid finding and concludes with the RESEARCH record. The question is never a workflow argument:
 * the run's id is. Asked `stage`, it says where it is.
 */
export const RESEARCH_WORKFLOW = "ResearchWorkflow";
export const RESEARCH_STAGE_QUERY = "stage";
/** The run's id and the asker's: both ids, so the activities read and write inside the asker's own tenant context (40 § 6.2 step 1). */
export const ResearchWorkflowInputSchema = z.strictObject({ runId: z.uuid(), userId: z.uuid() });
export type ResearchWorkflowInput = z.infer<typeof ResearchWorkflowInputSchema>;
export const ResearchWorkflowResultSchema = z.strictObject({ runId: z.uuid(), state: ResearchStateSchema, findings: z.int().nonnegative() });
export type ResearchWorkflowResult = z.infer<typeof ResearchWorkflowResultSchema>;
export const ResearchWorkflowIdSchema = z.string().regex(/^research:[0-9a-f-]{36}$/, "a workflow id like research:<the message's uuid>");
export function researchWorkflowId(messageId: string): string {
  return `research:${messageId}`;
}

/**
 * ResearchRunWorkflow (feature-specs/48 § 5.1; unit 70b): a person's research run, under `research:<runId>` on the
 * research queue — the legacy workflow's id form, which `ResearchWorkflowIdSchema` already admits, since a run's id and
 * a message's are both uuids and never the same. Started by the start endpoint (unit 71) once the run's row is QUEUED.
 * It loads the run inside the asker's own tenant context, plans, reads, checks, writes the report and concludes with
 * the `RESEARCH` record; it takes no signal, sleeps only at the writer's rate limit, and is closed by the engine at 90
 * minutes, the bound the start endpoint and the page's follow count on (§ 5.2, § 6). The question is never an argument:
 * the run's id and the asker's are. Asked `stage`, it says where it is.
 */
export const RESEARCH_RUN_WORKFLOW = "ResearchRunWorkflow";
export const RESEARCH_RUN_STAGE_QUERY = "stage";
export const ResearchRunWorkflowInputSchema = z.strictObject({ runId: z.uuid(), userId: z.uuid() });
export type ResearchRunWorkflowInput = z.infer<typeof ResearchRunWorkflowInputSchema>;
/** The state the run's row was left in, and how many of its findings passed the checks (0 where the run ended before them). */
export const ResearchRunWorkflowResultSchema = z.strictObject({ runId: z.uuid(), state: ResearchStateSchema, findings: z.int().nonnegative() });
export type ResearchRunWorkflowResult = z.infer<typeof ResearchRunWorkflowResultSchema>;
export function researchRunWorkflowId(runId: string): string {
  return `research:${runId}`;
}
/**
 * The run's whole bound (48 § 5.1): its six steps at their worst take about 74 minutes with their retries' backoff
 * (load 6, plan 10, read 35, validate 6, write 5 + 65 s + 5, conclude 6), so 90 minutes closes only a run stuck in a
 * loop of workflow-task failures, which the SDK would otherwise retry without end.
 */
export const RESEARCH_RUN_EXECUTION_TIMEOUT_MS = 90 * 60_000;

/**
 * A finding's send to Improve, `finding:<findingId>` (feature-specs/48 § 8.4): SendFindingWorkflow's id. The sweep of
 * detached runs asks the engine about it (§ 17.2), and a second press while it runs is handed the same run (§ 8.3).
 */
export const FindingWorkflowIdSchema = z.string().regex(/^finding:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a workflow id like finding:<the finding's uuid>");
export function findingWorkflowId(findingId: string): string {
  return `finding:${findingId}`;
}

/**
 * SendFindingWorkflow (feature-specs/48 § 8.4; unit 74), under `finding:<findingId>` on the research queue: a person's
 * finding sent to Improve as a researcher's proposal. Started by the send endpoint with nothing claimed; its first step
 * claims the finding and makes the suggestion in one transaction, or writes on the finding why it could not; then the
 * suggestion's own workflow runs as an abandoned child, and the finding is asked after until it is proposed or refuted,
 * paced as the legacy run paces it (`workers/research/pace.ts`). Its argument is the finding's id and its asker's, both
 * ids (invariant 35); it takes no signal, answers no query, and writes no record of its own: the suggestion's
 * `submitted` record, `service:researcher`'s, is the record of the sending.
 */
export const SEND_FINDING_WORKFLOW = "SendFindingWorkflow";
export const SendFindingWorkflowInputSchema = z.strictObject({ findingId: z.uuid(), userId: z.uuid() });
export type SendFindingWorkflowInput = z.infer<typeof SendFindingWorkflowInputSchema>;
/**
 * How a send ended: the finding gone, at the send or while it waited; already used, by another hand; failed with the
 * code written on it; a duplicate of a suggestion already made; proposed or refuted by Improve; or still deciding when
 * the forty days ran out.
 */
export const SEND_FINDING_ENDS = ["GONE", "USED", "FAILED", "DUPLICATE", "PROPOSED", "REFUTED", "UNDECIDED"] as const;
export const SendFindingWorkflowResultSchema = z.strictObject({
  findingId: z.uuid(),
  end: z.enum(SEND_FINDING_ENDS),
  /** The suggestion the send made, where it made one. */
  suggestionId: SuggestionIdSchema.nullable(),
  failure: FindingFailureSchema.nullable(),
});
export type SendFindingWorkflowResult = z.infer<typeof SendFindingWorkflowResultSchema>;

/**
 * What a workflow is to whatever starts, signals or asks it (feature-specs/28 § 5): where it runs, the form of its
 * id, and a schema for everything that crosses to the engine or comes back. A signal that carries nothing has
 * `null` for its schema. Every schema here passes `freeTextIn` (./freeText.ts): none can hold a sentence.
 */
export interface WorkflowDefinition {
  readonly taskQueue: TaskQueue;
  /** `<kind>:<the id of what it is about>` (28 § 4.3). */
  readonly id: z.ZodType<string>;
  readonly input: z.ZodType;
  readonly result: z.ZodType;
  readonly signals: Readonly<Record<string, z.ZodType | null>>;
  readonly queries: Readonly<Record<string, z.ZodType>>;
  /**
   * The engine closes a run of it after this many milliseconds, whatever it is doing (`workflowExecutionTimeout`); absent,
   * the engine's own default, which is none. A person's research run has 90 minutes (feature-specs/48 § 5.1).
   */
  readonly executionTimeoutMs?: number;
}

/**
 * Every workflow of the product, by the name its function is exported under (workers/workflows/index.ts). The web
 * tier's client (lib/workflows/client.ts) is typed by this table and validates against it before it sends; a
 * workflow joins it in the unit that writes the workflow.
 */
export const WORKFLOWS = {
  [PROVING_WORKFLOW]: {
    taskQueue: TASK_QUEUES.improve,
    id: ProvingWorkflowIdSchema,
    input: ProvingInputSchema,
    result: ProvingResultSchema,
    signals: { [PROVING_SIGNAL]: null },
    queries: { [PROVING_QUERY]: ProvingStageSchema },
  },
  [SUGGESTION_WORKFLOW]: {
    taskQueue: TASK_QUEUES.improve,
    id: SuggestionWorkflowIdSchema,
    input: SuggestionWorkflowInputSchema,
    result: SuggestionWorkflowResultSchema,
    signals: { [SUGGESTION_REVISED_SIGNAL]: RevisedSignalSchema, [SUGGESTION_CURATOR_SIGNAL]: CuratorDecisionSignalSchema, [SUGGESTION_ENDORSED_SIGNAL]: EndorsedSignalSchema, [SUGGESTION_WITHDRAWN_SIGNAL]: WithdrawnSignalSchema },
    queries: { [SUGGESTION_WAITS_QUERY]: SuggestionWaitsSchema },
  },
  [GRADE_EVIDENCE_WORKFLOW]: {
    taskQueue: TASK_QUEUES.improve,
    id: GradeEvidenceWorkflowIdSchema,
    input: GradeEvidenceInputSchema,
    result: GradeEvidenceResultSchema,
    signals: {},
    queries: { [GRADE_EVIDENCE_STAGE_QUERY]: GradeEvidenceStageSchema },
  },
  [MERGE_WORKFLOW]: {
    taskQueue: TASK_QUEUES.improve,
    id: MergeWorkflowIdSchema,
    input: MergeWorkflowInputSchema,
    result: MergeWorkflowResultSchema,
    signals: { [MERGE_RECHECK_SIGNAL]: null, [MERGE_SIGNAL]: MergeSignalSchema },
    queries: { [MERGE_STAGE_QUERY]: MergeStageSchema },
  },
  [EXPORT_WORKFLOW]: {
    taskQueue: TASK_QUEUES.improve,
    id: ExportWorkflowIdSchema,
    input: ExportWorkflowInputSchema,
    result: ExportWorkflowResultSchema,
    signals: {},
    queries: { [EXPORT_STAGE_QUERY]: ExportStageSchema },
  },
  [RESEARCH_WORKFLOW]: {
    taskQueue: TASK_QUEUES.research,
    id: ResearchWorkflowIdSchema,
    input: ResearchWorkflowInputSchema,
    result: ResearchWorkflowResultSchema,
    signals: {},
    queries: { [RESEARCH_STAGE_QUERY]: ResearchStateSchema },
  },
  [RESEARCH_RUN_WORKFLOW]: {
    taskQueue: TASK_QUEUES.research,
    id: ResearchWorkflowIdSchema,
    input: ResearchRunWorkflowInputSchema,
    result: ResearchRunWorkflowResultSchema,
    signals: {},
    queries: { [RESEARCH_RUN_STAGE_QUERY]: ResearchStateSchema },
    executionTimeoutMs: RESEARCH_RUN_EXECUTION_TIMEOUT_MS,
  },
  [SEND_FINDING_WORKFLOW]: {
    taskQueue: TASK_QUEUES.research,
    id: FindingWorkflowIdSchema,
    input: SendFindingWorkflowInputSchema,
    result: SendFindingWorkflowResultSchema,
    signals: {},
    queries: {},
  },
} as const satisfies Readonly<Record<string, WorkflowDefinition>>;

export type WorkflowName = keyof typeof WORKFLOWS;
type Defined<N extends WorkflowName> = (typeof WORKFLOWS)[N];
export type WorkflowInput<N extends WorkflowName> = z.infer<Defined<N>["input"]>;
export type SignalName<N extends WorkflowName> = keyof Defined<N>["signals"] & string;
/** The signal's one argument, or `null` for a signal that carries nothing. */
export type SignalInput<N extends WorkflowName, S extends SignalName<N>> = Defined<N>["signals"][S] extends z.ZodType ? z.infer<Defined<N>["signals"][S]> : null;
export type QueryName<N extends WorkflowName> = keyof Defined<N>["queries"] & string;
export type QueryAnswer<N extends WorkflowName, Q extends QueryName<N>> = Defined<N>["queries"][Q] extends z.ZodType ? z.infer<Defined<N>["queries"][Q]> : never;
