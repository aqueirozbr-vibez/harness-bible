import { z } from "zod";

/*
 * A curator's label on one answer (feature-specs/22 § 5, D3; architecture § 6.2): one line of
 * golden/assistant/labels/<release>.jsonl. The labeller reads the answer as a reader would and says whether it is
 * grounded, and how it does on each of the grader's four criteria. The grader's own verdicts are not shown to the
 * labeller: κ is agreement between two independent readings, and a label written after seeing the grader's is not one.
 *
 * In Phase 2 the labels are a file, written by Andre or a curator; the curator queue is Phase 4's.
 */

export const LABELLERS = ["curator", "andre"] as const;

export const LabelSchema = z
  .strictObject({
    goldenId: z.string().regex(/^G-\d{4}$/),
    /** The run file the answer is in, by name: `golden-run-2026.09-real.jsonl`. */
    runFile: z.string().regex(/^golden-run-[\w.-]+\.jsonl$/),
    /** The answer that was read: a label is of one answer, not of a question. */
    messageId: z.string().min(1),
    grounded: z.boolean(),
    criteria: z.strictObject({ supported: z.boolean(), precise: z.boolean(), complete: z.boolean(), in_scope: z.boolean() }).readonly(),
    labeller: z.enum(LABELLERS),
    labelledAt: z.iso.datetime(),
  })
  .readonly();

export type Label = z.infer<typeof LabelSchema>;
