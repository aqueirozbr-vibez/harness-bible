import { z } from "zod";

import { EvidenceKindSchema } from "@/lib/schemas/improve";
import { SuggestionIdSchema } from "@/lib/schemas/ids";
import { ObjectKeySchema } from "@/lib/schemas/storage";
import { EvidenceItemViewSchema } from "@/lib/schemas/suggestions";
import { GradeEvidenceStageSchema } from "@/lib/schemas/workflows";

/*
 * The evidence endpoints' vocabulary (feature-specs/32 § 8): what a contributor adds, what the add answers, what
 * the delete answers. The suggestion's scoring as the view carries it is `SuggestionScoringSchema` in
 * suggestions.ts, beside the view. The one number is Andre's: ten items a suggestion (D4, decided 2026-10-06).
 */

/** D4 (Andre, 2026-10-06): the PRD's own sentence, "ten weak items never equal one strong one". */
export const ITEMS_PER_SUGGESTION_MAX = 10;

/** An `https` URL as a contributor gives it; the fetcher's guard judges the rest in the workflow (32 § 4.1). */
const EvidenceUrlSchema = z.url({ protocol: /^https$/, hostname: z.regexes.domain }).max(2048);

/** A DOI as a person writes it; `normaliseDoi` brings it to its bare form or refuses it (unit 49c). */
const DoiInputSchema = z.string().trim().min(7).max(300);

/**
 * `POST /suggestions/{id}/evidence`: one of the four kinds with what it needs. A lab run is named so that the
 * endpoint can refuse it by name (`EVIDENCE_KIND_NOT_YET`) rather than as an unknown kind.
 */
export const EvidenceAddSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("LINK"), url: EvidenceUrlSchema }),
  z.strictObject({ kind: z.literal("DOI"), doi: DoiInputSchema }),
  /* An upload's file name, as the browser gave it, is kept for the list and the curator and never read by the grader (34 § 25). */
  z.strictObject({ kind: z.literal("UPLOAD"), uploadKey: ObjectKeySchema, fileName: z.string().trim().min(1).max(255).optional() }),
  z.strictObject({ kind: z.literal("LAB_RUN"), labRunId: z.string().min(1).max(200) }),
]);
export type EvidenceAdd = z.infer<typeof EvidenceAddSchema>;

/** What the add answers (202): the item as created, pending, and the workflow grading it. */
export const EvidenceAddedSchema = z.strictObject({
  suggestionId: SuggestionIdSchema,
  item: EvidenceItemViewSchema,
  workflowId: z.string(),
  stage: GradeEvidenceStageSchema,
});
export type EvidenceAdded = z.infer<typeof EvidenceAddedSchema>;

export const EvidenceItemParamsSchema = z.object({ id: SuggestionIdSchema, itemId: z.uuid() });

export const EvidenceDeletedSchema = z.strictObject({
  suggestionId: SuggestionIdSchema,
  itemId: z.uuid(),
  removed: z.literal(true),
  /** Whether a grading workflow was cancelled for it (a pending item's). */
  cancelled: z.boolean(),
});
export type EvidenceDeleted = z.infer<typeof EvidenceDeletedSchema>;

export const EVIDENCE_KINDS_ADDABLE = EvidenceKindSchema.exclude(["LAB_RUN"]);
