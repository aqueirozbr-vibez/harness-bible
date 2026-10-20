import { z } from "zod";

import { EvidenceTierSchema, SourceTierSchema } from "@/lib/schemas/domain";
import { SectionIdSchema, SuggestionIdSchema } from "@/lib/schemas/ids";
import { LedgerKindSchema } from "@/lib/schemas/ledger";
import { MergeViewSchema } from "@/lib/schemas/merge";
import {
  AnchorKindSchema,
  ChangeClassSchema,
  ChangeKindSchema,
  CriterionSchema,
  CuratorReasonSchema,
  DeciderSchema,
  DecisionSchema,
  EvidenceKindSchema,
  EvidenceStateSchema,
  ProposalSchema,
  SensorResultSchema,
  SuggestionOriginSchema,
  SuggestionSensorSchema,
  SuggestionStateSchema,
} from "@/lib/schemas/improve";
import { RouteSchema } from "@/lib/schemas/rubric";
import { GradeEvidenceStageSchema } from "@/lib/schemas/workflows";

/*
 * The suggestion endpoints' requests and responses (feature-specs/31): what a contributor sends and is told.
 * Unit 48a is the draft's creation; 48b adds the proposal, the read and the delete; 48d the submission.
 *
 * Pure: zod and the shared schemas.
 */

/** An anchor as the reader prints it: `21.3`, `F-21-03`, `21.9 r4` (31 § 3). Its form by kind is the endpoint's to check. */
export const AnchorRefSchema = z.strictObject({ kind: AnchorKindSchema, id: z.string().trim().min(1).max(40) });
export type AnchorRef = z.infer<typeof AnchorRefSchema>;

/** `POST /api/v1/suggestions`. The anchor is optional in the schema so that its absence is told by name, `ANCHOR_REQUIRED`, and not as a malformed body. */
export const SuggestionCreateSchema = z.strictObject({
  anchor: AnchorRefSchema.optional(),
  changeKind: ChangeKindSchema,
  locale: z.enum(["en", "pt"]),
});
export type SuggestionCreate = z.infer<typeof SuggestionCreateSchema>;

/** Another place of the book that reads the anchor: a source row's figures, a figure that also appears in another chapter. */
export const ReadBySchema = z.strictObject({ section: SectionIdSchema, title: z.string() });

/** The thresholds of the draft's class; both null where no score decides. */
export const ThresholdsSchema = z.strictObject({ acceptAt: z.number().int().min(0).max(100).nullable(), floorAt: z.number().int().min(0).max(100).nullable() });

/** The draft as created (31 § 3). */
export const SuggestionCreatedSchema = z.strictObject({
  id: SuggestionIdSchema,
  state: z.literal("DRAFT"),
  changeKind: ChangeKindSchema,
  changeClass: ChangeClassSchema,
  curatorReason: CuratorReasonSchema.nullable(),
  thresholds: ThresholdsSchema,
  fastMoving: z.boolean(),
  rubricVersion: z.string(),
  anchor: z.strictObject({
    kind: AnchorKindSchema,
    id: z.string(),
    section: SectionIdSchema,
    currentText: z.string(),
    /** The anchored figure's or row's source tier; null for a section. */
    tier: SourceTierSchema.nullable(),
    /** When the anchored row was last verified, or the chapter version was; null when neither has been. */
    verifiedOn: z.iso.datetime().nullable(),
    readBy: z.array(ReadBySchema),
  }),
});
export type SuggestionCreated = z.infer<typeof SuggestionCreatedSchema>;

/** `PATCH /api/v1/suggestions/{id}` (31 § 4): the proposal, the rationale, or both. An empty patch changes nothing and is not an error. */
/** The longest rationale a save takes, in characters; the 200 words are the sensor's, at submission (31 § 5). */
export const RATIONALE_CHARS_MAX = 20_000;

export const SuggestionPatchSchema = z.strictObject({ proposal: ProposalSchema.optional(), rationale: z.string().trim().max(RATIONALE_CHARS_MAX).nullable().optional() });
export type SuggestionPatch = z.infer<typeof SuggestionPatchSchema>;

export const SuggestionParamsSchema = z.object({ id: SuggestionIdSchema });

const Factor = z.number().min(0).max(1);

/** An evidence item as its owner and a curator read it (32 § 4): what was given, what the fetcher found, what the grader said. */
export const EvidenceItemViewSchema = z.strictObject({
  id: z.uuid(),
  ordinal: z.number().int().positive(),
  kind: EvidenceKindSchema,
  state: EvidenceStateSchema,
  url: z.string().nullable(),
  doi: z.string().nullable(),
  /** An upload's file name as the contributor's browser gave it; never read by the grader (34 § 25). */
  fileName: z.string().nullable(),
  labRunId: z.string().nullable(),
  title: z.string().nullable(),
  host: z.string().nullable(),
  publishedOn: z.iso.datetime().nullable(),
  ageDays: z.number().int().nullable(),
  fetchStatus: z.string().nullable(),
  tier: EvidenceTierSchema.nullable(),
  baseScore: z.number().int().nullable(),
  relevance: Factor.nullable(),
  recency: Factor.nullable(),
  independence: Factor.nullable(),
  adjustedScore: z.number().int().nullable(),
  reason: z.string().nullable(),
  gradedBy: z.string().nullable(),
  gradedAt: z.iso.datetime().nullable(),
  /**
   * While the item is pending, the grading workflow's stage (32 § 8: `1 of 3` opening, `2 of 3` reading the text,
   * `3 of 3` grading), read from what each of its activities writes on the row, so that a page that asks every two
   * seconds (34 D2) asks the engine nothing; null once graded.
   */
  stage: GradeEvidenceStageSchema.nullable(),
});
export type EvidenceItemView = z.infer<typeof EvidenceItemViewSchema>;

/** The suggestion's score and predicted outcome as the view carries them (30 § 3.3, § 4.4; 32 § 8), computed on read by `lib/rubric`: the form displays and computes nothing. */
/**
 * A tier that would suffice (`wouldSuffice`, 30 § 4.4): one item of it at its best — direct, recent within `withinDays`
 * where recency applies, with the least stake the tier allows — and the score the suggestion would then make. The
 * form's `would suffice` box words these; it computes nothing (34 § 6).
 */
export const SufficientSchema = z.strictObject({
  tier: EvidenceTierSchema,
  adjusted: z.number().int(),
  withinDays: z.number().int().nullable(),
  by: z.enum(["ALONE", "CORROBORATED", "CORROBORATING", "WITH_A_SECOND"]),
  bonus: z.number().int(),
  score: z.number().int(),
});
export type SufficientView = z.infer<typeof SufficientSchema>;

export const SuggestionScoringSchema = z.strictObject({
  score: z.number().int().min(0).max(100),
  strongestItemId: z.uuid().nullable(),
  corroboratedById: z.uuid().nullable(),
  /** Items counted: the graded ones; a pending item is not yet a score. */
  gradedItems: z.number().int().nonnegative(),
  pendingItems: z.number().int().nonnegative(),
  prediction: z.strictObject({
    route: RouteSchema,
    decision: DecisionSchema,
    namedTier: EvidenceTierSchema.nullable(),
    acceptAt: z.number().int().nullable(),
    floorAt: z.number().int().nullable(),
    shortBy: z.number().int().nullable(),
  }),
  /** What one more item would have to be for the score to reach the acceptance; empty at or past it, and where no score decides. */
  wouldSuffice: z.array(SufficientSchema),
});
export type SuggestionScoring = z.infer<typeof SuggestionScoringSchema>;

export const SensorVerdictViewSchema = z.strictObject({ sensor: SuggestionSensorSchema, result: SensorResultSchema, detail: z.string(), createdAt: z.iso.datetime() });

export const AdjudicationViewSchema = z.strictObject({
  decision: DecisionSchema,
  decidedBy: DeciderSchema,
  score: z.number().int(),
  acceptAt: z.number().int().nullable(),
  floorAt: z.number().int().nullable(),
  sufficientTier: EvidenceTierSchema.nullable(),
  failingSensor: SuggestionSensorSchema.nullable(),
  guideVersion: z.string().nullable(),
  modelId: z.string().nullable(),
  rubricVersion: z.string(),
  decidedAt: z.iso.datetime(),
  criteria: z.array(z.strictObject({ criterion: CriterionSchema, verdict: z.string(), reason: z.string().nullable() })),
});

/**
 * A suggestion as its owner or a curator reads it (31 § 4): the draft or the submitted suggestion with its anchor,
 * proposal, evidence, score and, once they exist, sensors and adjudication. What `PATCH` answers too, since the
 * class and the thresholds come back with every change.
 */
export const SuggestionViewSchema = z.strictObject({
  id: SuggestionIdSchema,
  origin: SuggestionOriginSchema,
  /** The contributor's own: true for the owner, false for a curator reading another's. */
  own: z.boolean(),
  /**
   * Drafted from a research finding (feature-specs/48 § 8.6; unit 74): provenance, never credit. The edit page labels
   * the prefilled proposal as the researcher's work by it; nothing here names the finding or who asked.
   */
  fromResearch: z.boolean(),
  state: SuggestionStateSchema,
  outcome: DecisionSchema.nullable(),
  changeKind: ChangeKindSchema,
  changeClass: ChangeClassSchema,
  curatorReason: CuratorReasonSchema.nullable(),
  thresholds: ThresholdsSchema,
  /** Whether the recency factor applies to the evidence (30 § 3.4): the anchor's flag, or a claim's or a row's own declaration (`fastMovingOf`). */
  fastMoving: z.boolean(),
  rubricVersion: z.string(),
  locale: z.enum(["en", "pt"]),
  chapter: z.number().int().min(0).max(99),
  release: z.string(),
  anchor: z.strictObject({
    kind: AnchorKindSchema,
    id: z.string(),
    section: SectionIdSchema,
    currentText: z.string(),
    contentSha256: z.string(),
    existsAtVersion: z.boolean(),
    readBy: z.array(ReadBySchema),
  }),
  proposal: ProposalSchema.nullable(),
  rationale: z.string().nullable(),
  score: z.number().int().nullable(),
  /** The score and the predicted outcome computed on this read from the graded items (32 § 8; 30 § 3.3, § 4.4); null while no item is graded. */
  scoring: SuggestionScoringSchema.nullable(),
  evidence: z.array(EvidenceItemViewSchema),
  sensors: z.array(SensorVerdictViewSchema),
  adjudication: AdjudicationViewSchema.nullable(),
  createdAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  /** When its contributor asked to withdraw it (45 § 5): while it waits, the withdrawal is being recorded; once `CLOSED`, it was withdrawn. */
  withdrawnAt: z.iso.datetime().nullable(),
  /** The reset its run sleeps until at a budget cap (33 § 7): the page's `waiting for budget · resets 01 Nov`; null when it is not waiting. */
  budgetResetsAt: z.iso.datetime().nullable(),
  /** Its merge, once one began (37 § 4, § 6; unit 54b): the branch, the versions, and where the chapter's check stands. */
  merge: MergeViewSchema.nullable(),
});
export type SuggestionView = z.infer<typeof SuggestionViewSchema>;

/**
 * `GET /api/v1/suggestions/{id}/record` (35 § 5; TRD § 6.1): the suggestion's records as the ledger holds them, with
 * their hashes, and the chain checked on this request. A person is their pseudonym here, as in the ledger; the page
 * is where a name may be shown.
 */
export const SuggestionRecordSchema = z.strictObject({
  id: SuggestionIdSchema,
  records: z.array(
    z.strictObject({
      seq: z.number().int().positive(),
      kind: LedgerKindSchema,
      actor: z.string(),
      payload: z.json(),
      createdAt: z.iso.datetime(),
      prevHash: z.string().regex(/^[0-9a-f]{64}$/),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
  chain: z.strictObject({
    ok: z.boolean(),
    records: z.number().int().nonnegative(),
    headHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    firstBreak: z.strictObject({ seq: z.number().int().nonnegative(), field: z.enum(["hash", "prevHash", "seq", "predecessor", "head"]), expected: z.string(), found: z.string() }).nullable(),
  }),
});
export type SuggestionRecord = z.infer<typeof SuggestionRecordSchema>;

/** `POST /api/v1/suggestions/{id}/submit` (31 § 6): the consent a person gives with their first submission. */
export const SuggestionSubmitSchema = z.strictObject({ consent: z.boolean() });
export type SuggestionSubmit = z.infer<typeof SuggestionSubmitSchema>;

/** What a submission answers: the state and the workflow working on it; for a suggestion already submitted, the running one. */
export const SuggestionSubmittedSchema = z.strictObject({ id: SuggestionIdSchema, state: SuggestionStateSchema, workflowId: z.string() });
export type SuggestionSubmitted = z.infer<typeof SuggestionSubmittedSchema>;

/**
 * `POST /api/v1/suggestions/{id}/withdraw` (feature-specs/45 § 5.2): where the suggestion is, read again once its
 * `retracted` record stands, with the record's `seq`; `ledgerSeq` null while the workflow records it (202).
 */
export const SuggestionWithdrawnSchema = z.strictObject({ id: SuggestionIdSchema, state: SuggestionStateSchema, ledgerSeq: z.number().int().positive().nullable() });
export type SuggestionWithdrawn = z.infer<typeof SuggestionWithdrawnSchema>;

/** `DELETE /api/v1/suggestions/{id}`: the draft that went. */
export const SuggestionDeletedSchema = z.strictObject({ id: SuggestionIdSchema, deleted: z.literal(true) });
