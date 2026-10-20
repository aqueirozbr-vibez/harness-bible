import { z } from "zod";

import { EvidenceTierSchema } from "@/lib/schemas/domain";
import { SectionIdSchema, SuggestionIdSchema } from "@/lib/schemas/ids";
import { AnchorKindSchema, ChangeClassSchema, CriterionSchema, CuratorActionSchema, CuratorReasonSchema, DecisionSchema, PartSchema, SuggestionOriginSchema, SuggestionStateSchema } from "@/lib/schemas/improve";
import { MergeStateSchema } from "@/lib/schemas/merge";

/*
 * The curator queue's API (feature-specs/36 § 3, § 5, § 6; units 53a, 53c and 53d). Pure: zod and constants.
 */

/**
 * 36 § 3.1's groups that this build fills, in the screen's order: safety and operating-technology changes, scenario
 * parameters, structure, a new source tier, what a curator inspects, what is ready to merge and what merges waiting on
 * a hand (spec 37 § 6, unit 54b), and the monthly sample of accepted tier B (§ 7.2, unit 53e; empty while its number is
 * unset). Researcher proposals (spec 43 § 7.1; unit 60d): a researcher's proposal a curator decides, seven days, before
 * the inspections; "rubric change" is not built.
 */
export const QUEUE_GROUPS = ["safety", "scenario", "structure", "newTier", "researcher", "inspection", "ready", "merging", "sampled"] as const;
export const QueueGroupSchema = z.enum(QUEUE_GROUPS);
export type QueueGroup = z.infer<typeof QueueGroupSchema>;

/** `GET /api/v1/curation/queue?class=&part=`: one class, one of the caller's parts, or neither. */
export const CurationQueueQuerySchema = z.object({ class: ChangeClassSchema.optional(), part: PartSchema.optional() });

/**
 * An item (36 § 3.2): the suggestion, where it is anchored, its class and why a curator has it, its strongest item's
 * tier and its score, when it was submitted and queued, its deadline, and the parts whose curators may decide it. A
 * seed's flag is never here: a seed is indistinguishable until decided (36 § 7.1). The page words the class line.
 */
export const QueueItemSchema = z.strictObject({
  id: SuggestionIdSchema,
  anchor: z.strictObject({ kind: AnchorKindSchema, id: z.string(), section: SectionIdSchema }),
  changeClass: ChangeClassSchema,
  curatorReason: CuratorReasonSchema.nullable(),
  outcome: DecisionSchema.nullable(),
  tier: EvidenceTierSchema.nullable(),
  score: z.number().int().nullable(),
  state: SuggestionStateSchema,
  submittedAt: z.iso.datetime().nullable(),
  /** When it entered the queue: the decision that sent it there. */
  queuedAt: z.iso.datetime().nullable(),
  deadline: z.iso.datetime().nullable(),
  parts: z.array(PartSchema),
  /** In more than one part's queue: the first curator to decide decides it (36 § 3.2). */
  shared: z.boolean(),
  /** An accepted suggestion's merge, in a word (37 § 6): null for an item a curator decides. */
  merge: MergeStateSchema.nullable(),
  /** Whose it is: a researcher's proposal is marked `research` on its class line (43 § 7.1; unit 60d). */
  origin: SuggestionOriginSchema,
  /** A contributor's draft from a research finding (feature-specs/48 § 8.6; unit 74): its class line reads `from research`, provenance and never credit. */
  fromResearch: z.boolean(),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

/** `POST /api/v1/curation/{suggestionId}/decision` (36 § 5). */
export const CurationDecisionParamsSchema = z.object({ suggestionId: SuggestionIdSchema });

/**
 * A curator's decision (36 § 5): the action; for an override, the coded reason and the criterion; and the note, at
 * most 400 characters, kept as text on the action and only as its hash in the ledger (D4).
 */
export const CurationDecisionSchema = z.strictObject({
  /** `MERGE` on a suggestion whose merge's check passed (feature-specs/37 § 5; unit 54c), with a note at most; `REVERT` on a merged one, with a note (37 § 8; unit 54e). */
  action: z.enum(["ACCEPT", "KEEP_REQUEST_MORE", "DECLINE", "MERGE", "REVERT"]),
  overrideCode: z.string().regex(/^OV-[A-Z]{3}-\d{2}$/, "an override code like OV-IND-02").optional(),
  criterion: CriterionSchema.optional(),
  note: z.string().max(400).optional(),
});
export type CurationDecision = z.infer<typeof CurationDecisionSchema>;

/** `POST /api/v1/curation/{suggestionId}/recheck` (37 § 4.3, § 4.5; unit 54b) answers 202: the merge was told to prepare and check again, or, where none ran, one was started. */
export const CurationRecheckedSchema = z.strictObject({ suggestionId: SuggestionIdSchema, started: z.boolean() });
export type CurationRechecked = z.infer<typeof CurationRecheckedSchema>;

/** What the decision answers: the action, and the `curator` record's `seq` once the workflow has written it, or null while it records (202). */
/** `revertId` (unit 54e): the revert a curator's `REVERT` made, a suggestion of the chapter's own, whose merge records the action. */
export const CurationDecidedSchema = z.strictObject({ actionId: z.uuid(), ledgerSeq: z.number().int().positive().nullable(), revertId: SuggestionIdSchema.optional() });
export type CurationDecided = z.infer<typeof CurationDecidedSchema>;

/** A calendar quarter, UTC (36 § 6.1): `2026-Q4`. */
export const QuarterSchema = z.string().regex(/^\d{4}-Q[1-4]$/, "a quarter like 2026-Q4");

/** The three measures over one span (36 § 6.1), each with its counts; a rate and κ null under the minimum. */
export const CalibrationReadingSchema = z.strictObject({
  overrideRate: z.strictObject({
    /** The decisions reviewed that had an adjudication: each rate's denominator. */
    reviewed: z.number().int().nonnegative(),
    criteria: z.array(z.strictObject({ criterion: CriterionSchema, overridden: z.number().int().nonnegative(), rate: z.number().min(0).max(1).nullable() })),
  }),
  kappa: z.strictObject({ pairs: z.number().int().nonnegative(), agreed: z.number().int().nonnegative(), value: z.number().min(-1).max(1).nullable() }),
  precision: z.strictObject({ accepted: z.number().int().nonnegative(), reverted: z.number().int().nonnegative(), rate: z.number().min(0).max(1).nullable() }),
});
export type CalibrationReading = z.infer<typeof CalibrationReadingSchema>;

/** A rubric review opened by a quarter's rate (36 § 6.3): `R-1.2-0007`, its criterion, and the rate that passed the line with its counts. */
export const RubricReviewSchema = z.strictObject({
  id: z.string().regex(/^R-[0-9.]+-\d{4}$/),
  criterion: CriterionSchema,
  rate: z.number().min(0).max(1),
  overridden: z.number().int().nonnegative(),
  reviewed: z.number().int().nonnegative(),
  openedAt: z.iso.datetime(),
});

/**
 * `GET /api/v1/curation/metrics` (36 § 6.2): the three measures by quarter, newest first — this one and the three
 * before it — over every suggestion and over the researcher's proposals alone (spec 44), with the reviews each
 * quarter's rates opened; the lines the rail draws; and the count under which a measure is not given.
 */
export const CurationMetricsSchema = z.strictObject({
  now: z.iso.datetime(),
  minimum: z.number().int().positive(),
  lines: z.strictObject({ overrideTarget: z.number(), overrideReview: z.number(), kappaRetire: z.number(), kappaGate: z.number(), precisionTarget: z.number() }),
  quarters: z.array(
    z.strictObject({
      quarter: QuarterSchema,
      from: z.iso.datetime(),
      to: z.iso.datetime(),
      all: CalibrationReadingSchema,
      researcher: CalibrationReadingSchema,
      reviews: z.array(RubricReviewSchema),
    }),
  ),
});
export type CurationMetrics = z.infer<typeof CurationMetricsSchema>;

/** The queue as its page reads it: the caller's parts, the groups that have items, what the caller decided today, and the header's marks at `now`. */
export const CurationQueueSchema = z.strictObject({
  parts: z.array(PartSchema),
  /** A group's deadline in hours (A15); null for the sample, due by the month's end (§ 3.1). */
  groups: z.array(z.strictObject({ group: QueueGroupSchema, deadlineHours: z.number().int().positive().nullable(), items: z.array(QueueItemSchema) })),
  /** What the caller decided today; a seed's under its own id, revealed with the answer and whether it matched (36 § 7.1). */
  decidedToday: z.array(z.strictObject({ id: SuggestionIdSchema, action: CuratorActionSchema, decidedAt: z.iso.datetime(), seed: z.strictObject({ answer: CuratorActionSchema, matched: z.boolean() }).nullable() })),
  marks: z.strictObject({ overdue: z.number().int().nonnegative(), dueSoon: z.number().int().nonnegative(), inSla: z.number().int().nonnegative() }),
  /** The instant the deadlines were measured against. */
  now: z.iso.datetime(),
});
export type CurationQueue = z.infer<typeof CurationQueueSchema>;
