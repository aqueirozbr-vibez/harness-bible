import { z } from "zod";

import { SourceTierSchema } from "@/lib/schemas/domain";

/*
 * The vocabulary of Improve (feature-specs/29 § 3): the enumerations the improvement rows are written in, as zod
 * schemas for everything that is not the database's own code. Each list mirrors its Prisma enum exactly, in order
 * (code-standards § TypeScript), and improve.test.ts holds every one to that, so the two cannot drift.
 *
 * Pure: zod and constants. The ledger's payloads (./ledger.ts) and, from unit 48, the API's requests are built
 * from these.
 */

/** The book's parts, as the curator roster and a suggestion's `parts` name them. */
export const PARTS = ["P0", "P1", "P2", "P3", "P4"] as const;
export const PartSchema = z.enum(PARTS);
export type Part = z.infer<typeof PartSchema>;

/** `CURATOR` since unit 54e: a curator's revert of a merged change, which has no contributor (feature-specs/37 § 8). */
export const SUGGESTION_ORIGINS = ["HUMAN", "RESEARCHER", "CURATOR"] as const;
export const SuggestionOriginSchema = z.enum(SUGGESTION_ORIGINS);
export type SuggestionOrigin = z.infer<typeof SuggestionOriginSchema>;

export const ANCHOR_KINDS = ["SECTION", "FIGURE", "SOURCE_ROW"] as const;
export const AnchorKindSchema = z.enum(ANCHOR_KINDS);
export type AnchorKind = z.infer<typeof AnchorKindSchema>;

/** What is proposed (feature-specs/30 § 4.1). */
export const CHANGE_KINDS = ["EDIT_TEXT", "SET_VALUE", "EDIT_ROW", "ADD_CLAIM", "ADD_ROW", "RESTRUCTURE"] as const;
export const ChangeKindSchema = z.enum(CHANGE_KINDS);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

/** Computed in code from the anchor and the change kind, never chosen by a person or a model (invariant 8). */
export const CHANGE_CLASSES = ["WORDING", "CITED_FIGURE", "DERIVED_FIGURE", "NEW_CLAIM", "CURATOR_ALWAYS"] as const;
export const ChangeClassSchema = z.enum(CHANGE_CLASSES);
export type ChangeClass = z.infer<typeof ChangeClassSchema>;

/** Why a suggestion is `CURATOR_ALWAYS`: set for that class and for no other. */
export const CURATOR_REASONS = ["SAFETY_OT", "SCENARIO_PARAMETER", "STRUCTURE", "NEW_SOURCE_TIER", "RUBRIC"] as const;
export const CuratorReasonSchema = z.enum(CURATOR_REASONS);
export type CuratorReason = z.infer<typeof CuratorReasonSchema>;

export const EVIDENCE_KINDS = ["LINK", "DOI", "UPLOAD", "LAB_RUN"] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EVIDENCE_STATES = ["PENDING", "GRADED"] as const;
export const EvidenceStateSchema = z.enum(EVIDENCE_STATES);
export type EvidenceState = z.infer<typeof EvidenceStateSchema>;

export const DECISIONS = ["ACCEPT", "REQUEST_MORE", "DECLINE", "CURATOR_REVIEW"] as const;
export const DecisionSchema = z.enum(DECISIONS);
export type Decision = z.infer<typeof DecisionSchema>;

/** Where a suggestion is (feature-specs/29 § 3.1). */
export const SUGGESTION_STATES = ["DRAFT", "SUBMITTED", "INTAKE_DECLINED", "GRADED", "SENSED", "DECIDED", "CURATOR_QUEUE", "MERGING", "MERGED", "CLOSED"] as const;
export const SuggestionStateSchema = z.enum(SUGGESTION_STATES);
export type SuggestionState = z.infer<typeof SuggestionStateSchema>;

/**
 * The moves a suggestion's state makes (feature-specs/29 § 3.1): the one table, written with the workflow that makes
 * them (unit 50a) and given to the door, which refuses a service's move outside it. A move's conditions — whose
 * accept may merge, which revision returns to `SUBMITTED` — are in the query that makes it, not here. Unit 50e added
 * `SUBMITTED → CURATOR_QUEUE`: a person's request for more by rule, which goes to the queue for inspection (33 § 6.1)
 * without the adjudicator's `DECIDED`, and with no consistency sensors run to have been `SENSED`; and `DECIDED →
 * SUBMITTED` and `CURATOR_QUEUE → SUBMITTED`, a revision's return from a request for more (31 § 6.5; 33 § 6.4), whose
 * condition on the outcome is in the door's query.
 */
export const SUGGESTION_MOVES: Readonly<Record<SuggestionState, ReadonlyArray<SuggestionState>>> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["INTAKE_DECLINED", "GRADED", "CURATOR_QUEUE"],
  INTAKE_DECLINED: ["CLOSED", "SUBMITTED"],
  GRADED: ["SENSED"],
  SENSED: ["DECIDED", "CURATOR_QUEUE"],
  DECIDED: ["MERGING", "CURATOR_QUEUE", "CLOSED", "SUBMITTED"],
  CURATOR_QUEUE: ["MERGING", "DECIDED", "CLOSED", "SUBMITTED"],
  MERGING: ["MERGED", "DECIDED"],
  MERGED: ["CLOSED"],
  CLOSED: [],
};

export const isLegalMove = (from: SuggestionState, to: SuggestionState): boolean => SUGGESTION_MOVES[from].includes(to);

/**
 * Whether a suggestion takes a revision where it is (31 § 6.5): declined at intake, or asked for more in `DECIDED` or
 * the queue. The one predicate for the submit endpoint, the workflow and its activity; the door's `REVISABLE` is the
 * same condition as a query.
 */
export function takesRevision(state: SuggestionState, outcome: Decision | null): boolean {
  return state === "INTAKE_DECLINED" || ((state === "DECIDED" || state === "CURATOR_QUEUE") && outcome === "REQUEST_MORE");
}

/** The states a person's suggestion is withdrawn from (feature-specs/45 § 5.1): where its workflow waits for a person. */
export const WITHDRAWABLE_STATES = ["INTAKE_DECLINED", "DECIDED", "CURATOR_QUEUE"] as const satisfies ReadonlyArray<SuggestionState>;

/**
 * Whether a suggestion takes a withdrawal where it is (45 § 5.1): in a curator's queue, or wherever it takes a revision
 * — the places its workflow waits for a person. The one predicate for the endpoint, the door, the workflow's activity,
 * the record and the page.
 */
export function takesWithdrawal(state: SuggestionState, outcome: Decision | null): boolean {
  return state === "CURATOR_QUEUE" || takesRevision(state, outcome);
}

/**
 * Whether a decision leaves a suggestion to merge (feature-specs/37 § 4; unit 54b): any a curator accepted, in
 * `MERGING`; a person's the adjudicator accepted, which waits in `DECIDED` (a researcher's goes to a curator first,
 * invariant 32). The suggestion's workflow starts its merge by it.
 */
export function mergesAfter(state: SuggestionState, decision: Decision | null): boolean {
  return state === "MERGING" || (state === "DECIDED" && decision === "ACCEPT");
}

/** The four intake sensors and the three of consistency. */
export const SUGGESTION_SENSORS = ["SCHEMA", "ANCHOR_EXISTS", "EVIDENCE_PARSES", "RATIONALE_LENGTH", "DERIVE_CONSISTENCY", "CROSS_CHAPTER", "LINT"] as const;
export const SuggestionSensorSchema = z.enum(SUGGESTION_SENSORS);
export type SuggestionSensor = z.infer<typeof SuggestionSensorSchema>;

export const SENSOR_RESULTS = ["PASS", "FAIL", "WARN", "NA"] as const;
export const SensorResultSchema = z.enum(SENSOR_RESULTS);
export type SensorResult = z.infer<typeof SensorResultSchema>;

export const CURATOR_ACTIONS = ["ACCEPT", "KEEP_REQUEST_MORE", "DECLINE", "MERGE", "REVERT"] as const;
export const CuratorActionSchema = z.enum(CURATOR_ACTIONS);
export type CuratorAction = z.infer<typeof CuratorActionSchema>;

/** The six lines of an adjudication: a column of `CriterionVerdict`, and the adjudicator's output (feature-specs/33 § 5.3). Not a database enum. */
export const CRITERIA = ["tier", "relevance", "recency", "independence", "corroboration", "threshold"] as const;
export const CriterionSchema = z.enum(CRITERIA);
export type Criterion = z.infer<typeof CriterionSchema>;

/** Who decided: a rule at intake, the router by the change's class, or the adjudicator. A column of `Adjudication`. Not a database enum. */
export const DECIDERS = ["intake-rules", "router", "adjudicator"] as const;
export const DeciderSchema = z.enum(DECIDERS);
export type Decider = z.infer<typeof DeciderSchema>;

/* ---------------------------------------------------------------- the proposal (feature-specs/31 § 4) */

/** A passage or a sentence as a contributor writes it: at least one character that is not whitespace. The body's size is the pipeline's limit. */
const TextSchema = z.string().trim().min(1);
/** A decimal as the book prints one: `0.25`, `-3`, `1450`. A string, so that no binary fraction stands between the contributor and the row. */
export const DecimalTextSchema = z.string().trim().regex(/^-?\d+(?:\.\d+)?$/, "a decimal like 0.25");
const UrlSchema = z.string().trim().url().max(2048);
const DoiTextSchema = z.string().trim().regex(/^10\.\d{4,9}\/[!-~]+$/, "a DOI like 10.1000/182");

/** A value with its unit, as `SET_VALUE` and a row's `value` carry it; the unit null for a count or a ratio. */
export const ValueSchema = z.strictObject({ after: DecimalTextSchema, unit: TextSchema.max(40).nullable() });

/** A proposed row's tier: one of the book's seven, or a new one, which makes the change the curator's (30 § 4.2 rule 4). */
export const ProposedTierSchema = z.union([SourceTierSchema, z.strictObject({ newTier: TextSchema.max(40) })]);

/**
 * What is proposed, a union on the change kind (31 § 4). Each member carries exactly what its kind needs, and the
 * schema sensor (48c) checks the rest: that the passage is in the section once, that a number in prose is not
 * changed, that `after` differs from `before`.
 */
export const ProposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("EDIT_TEXT"), before: TextSchema, after: TextSchema }),
  z.strictObject({ kind: z.literal("SET_VALUE"), ...ValueSchema.shape }),
  z
    .strictObject({
      kind: z.literal("EDIT_ROW"),
      claim: TextSchema.optional(),
      citation: TextSchema.optional(),
      url: UrlSchema.optional(),
      doi: DoiTextSchema.optional(),
      verifiedOn: z.iso.date().optional(),
      value: ValueSchema.optional(),
    })
    .refine((row) => Object.keys(row).length > 1, { message: "a row edit changes at least one of claim, citation, url, doi, verifiedOn or value" }),
  z.strictObject({ kind: z.literal("ADD_CLAIM"), text: TextSchema, placeAfter: z.union([z.literal("end"), TextSchema]), fastMoving: z.boolean() }),
  z.strictObject({ kind: z.literal("ADD_ROW"), claim: TextSchema, citation: TextSchema, url: UrlSchema.optional(), doi: DoiTextSchema.optional(), tier: ProposedTierSchema, fastMoving: z.boolean() }),
  z.strictObject({ kind: z.literal("RESTRUCTURE"), description: TextSchema }),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

