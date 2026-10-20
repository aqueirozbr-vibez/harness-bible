import { z } from "zod";

import { FigureIdSchema, ReleaseIdSchema, SectionIdSchema, SourceRowIdSchema } from "@/lib/schemas/ids";

/*
 * The assistant's golden set (architecture § 6.2, § 9; the Phase 2 gate):
 * one question per line of golden/assistant/<release>.jsonl with the answer
 * the book itself fixes: which sections and figures a correct answer cites,
 * or which refusal cause applies. Generated from the release's rows
 * (lib/golden/assistant.ts), so every label is checkable against the
 * database and no label is a guess. Curators relabel by editing the file.
 */

export const GOLDEN_KINDS = ["figure", "claim", "compare", "lab", "refusal"] as const;
export const ASSISTANT_MODES = ["explain", "compare", "walk", "lab", "brief"] as const;
export const REFUSAL_CAUSES = ["R-SCOPE", "R-SCOPE-OT", "R-RECOMPUTE", "R-UNVERIFIED"] as const;

export const GoldenItemSchema = z
  .object({
    id: z.string().regex(/^G-\d{4}$/),
    kind: z.enum(GOLDEN_KINDS),
    mode: z.enum(ASSISTANT_MODES),
    language: z.enum(["en", "pt"]),
    /** Where the question is asked from: the chapter and, when one, the section open in the reader. */
    context: z.object({ chapter: z.number().int().min(0).max(40), section: SectionIdSchema.nullable() }).readonly(),
    question: z.string().min(8),
    expected: z
      .object({
        /** A correct answer cites these; each is checked as "cited somewhere in the answer". */
        citations: z.array(z.object({ sectionId: SectionIdSchema, figureId: FigureIdSchema.nullable() }).readonly()).readonly(),
        /** For compare questions: every chapter the answer must cite from. */
        chapters: z.array(z.number().int().min(0).max(40)).readonly(),
        sourceRowId: SourceRowIdSchema.nullable(),
        /** The value a figure question must quote as printed, for the citation sensor's check. */
        valueText: z.string().nullable(),
        refusal: z.object({ cause: z.enum(REFUSAL_CAUSES) }).readonly().nullable(),
      })
      .readonly(),
    generator: z.object({ template: z.string().min(1), release: ReleaseIdSchema }).readonly(),
  })
  .readonly();

export type GoldenItem = z.infer<typeof GoldenItemSchema>;
export type GoldenItemInput = z.input<typeof GoldenItemSchema>;
export type RefusalCause = (typeof REFUSAL_CAUSES)[number];
