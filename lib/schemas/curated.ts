import { z } from "zod";

import { EvidenceTierSchema } from "@/lib/schemas/domain";
import { RUN_GRADES } from "@/lib/schemas/goldenRun";
import { ChangeClassSchema, ChangeKindSchema, DecisionSchema, ProposalSchema } from "@/lib/schemas/improve";
import { RelevanceSchema } from "@/lib/schemas/rubric";

/*
 * The curated set of suggestions (feature-specs/39 § 3; TRD § 8.1): 100 suggestions generated from the release's own
 * rows, the labels a curator gives each, and a run of the set through the workflow. Three files, three schemas, each
 * read strictly as the Phase 2 pattern reads its labels (lib/gate/labels.ts): a line the gate cannot read must not
 * become one item fewer without anyone noticing.
 */

/** `G-21-0001`: the chapter and a serial, as a suggestion's id is, with the set's own prefix. */
export const CuratedIdSchema = z.string().regex(/^G-\d{2}-\d{4}$/, "a curated id like G-21-0001");

/** An evidence document of the set, kept as a fixture file beside it: what the grader reads, and the tier the generator meant it to be. */
export const CuratedEvidenceSchema = z.strictObject({
  /** The fixture's path under golden/suggestions/evidence/. */
  file: z.string().regex(/^[A-Za-z0-9._-]+\.(txt|md)$/),
  /** The tier the document was written to be: the label says what it is. */
  meantTier: EvidenceTierSchema,
  meantRelevance: RelevanceSchema,
  /** The document's date, for recency; null for an undated one. */
  dated: z.iso.date().nullable(),
  /** The source's domain, for independence against the figure's vendor, where the rubric reads one. */
  domain: z.string().min(1).nullable(),
});
export type CuratedEvidence = z.infer<typeof CuratedEvidenceSchema>;

export const CuratedItemSchema = z.strictObject({
  id: CuratedIdSchema,
  chapter: z.int().min(0).max(40),
  anchor: z.strictObject({ kind: z.enum(["SECTION", "FIGURE", "SOURCE_ROW"]), id: z.string().min(1) }),
  changeKind: ChangeKindSchema,
  changeClass: ChangeClassSchema,
  proposal: ProposalSchema,
  rationale: z.string().min(1).max(2000),
  /** The vendor the anchored figure is of, as a domain, where it has one: a document of that domain has a stake the rubric discounts. */
  vendorDomain: z.string().min(1).nullable(),
  /** The anchor moves fast (a price, a deadline, a version), so a document's age weighs (30 § 3.4). */
  fastMoving: z.boolean(),
  evidence: z.array(CuratedEvidenceSchema).min(1).max(4),
  /** The outcome the rubric's arithmetic expects from the meant tiers: the score always; the decision where a rule decides it, null where the adjudicator or a curator does. */
  expected: z.strictObject({ score: z.int().min(0).max(110), decision: DecisionSchema.nullable() }),
});
export type CuratedItem = z.infer<typeof CuratedItemSchema>;

/** A curator's label of one item: the tier and relevance of its strongest evidence, the decision they would take, and the criteria they disagree with the adjudicator on. */
export const CuratedLabelSchema = z.strictObject({
  id: CuratedIdSchema,
  tier: EvidenceTierSchema,
  relevance: RelevanceSchema,
  decision: z.enum(["ACCEPT", "REQUEST_MORE", "DECLINE"]),
  /** The adjudicator's criteria the curator disagrees with, by name, when they read its decision; empty when none. */
  disagreed: z.array(z.string().min(1)).optional(),
  note: z.string().max(400).optional(),
  labelledBy: z.string().min(1),
  labelledAt: z.iso.datetime(),
});
export type CuratedLabel = z.infer<typeof CuratedLabelSchema>;

/** One item of a run of the set: the suggestion it became and the decision the workflow reached. */
export const CuratedRunItemSchema = z.strictObject({
  id: CuratedIdSchema,
  suggestionId: z.string().min(1).nullable(),
  decision: DecisionSchema.nullable(),
  decidedBy: z.enum(["intake-rules", "router", "adjudicator"]).nullable(),
  score: z.int().min(0).max(110).nullable(),
  /** The six lines of the adjudication as the record has them (33 § 5.3): a tier, a factor, a bonus, a word; empty where none was written. */
  criteria: z.array(z.strictObject({ criterion: z.string().min(1), verdict: z.string() })),
  /** What the item's run cost, in dollars, from the ledger's rows for its grading and adjudication. */
  costUsd: z.number().nonnegative(),
});
export type CuratedRunItem = z.infer<typeof CuratedRunItemSchema>;

export const CuratedRunHeaderSchema = z.strictObject({
  release: z.string().min(1),
  grade: z.enum(RUN_GRADES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Whose budget the run was charged to: the principal Andre named. */
  principal: z.string().min(1),
  costUsd: z.number().nonnegative(),
});
export type CuratedRunHeader = z.infer<typeof CuratedRunHeaderSchema>;

export const CuratedRunSchema = z.strictObject({ header: CuratedRunHeaderSchema, items: z.array(CuratedRunItemSchema) });
export type CuratedRun = z.infer<typeof CuratedRunSchema>;
