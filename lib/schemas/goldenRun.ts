import { z } from "zod";

import { ASSISTANT_MODES, GOLDEN_KINDS } from "@/lib/schemas/golden";
import { ReleaseIdSchema } from "@/lib/schemas/ids";

/*
 * One golden item as it was answered (feature-specs/22 § 4): a line of
 * pipeline/reports/golden-run-<release>-<stub|real>.jsonl. The gate's measures read these lines and nothing else, so
 * a reviewer can rerun the arithmetic of a report from the file it names. A line holds what was cited, counted and
 * timed; it holds no question and no answer text, which stay in the golden set and in the conversation's own rows.
 *
 * Two fields say more than the spec's sketch of the record, because two criteria need them: `claims` separates a
 * claim that was not found from one that was replaced (P2.1a counts an answer only when neither happened), and
 * `frontier` keeps one entry per call on the frontier alias, in order, because "a cache hit on every call after the
 * first" (P2.5b) cannot be read from a sum.
 */

export const RUN_GRADES = ["stub", "real"] as const;
export type RunGrade = (typeof RUN_GRADES)[number];

/** The grader's four criteria (guides/assistant/<version>/grader.md), by the names its output uses. */
export const GRADER_CRITERIA = ["supported", "precise", "complete", "in_scope"] as const;
export type GraderCriterion = (typeof GRADER_CRITERIA)[number];

const CriteriaSchema = z.strictObject({ supported: z.boolean(), precise: z.boolean(), complete: z.boolean(), in_scope: z.boolean() }).readonly();

export const GoldenRunItemSchema = z
  .strictObject({
    id: z.string().regex(/^G-\d{4}$/),
    kind: z.enum(GOLDEN_KINDS),
    mode: z.enum(ASSISTANT_MODES),
    language: z.enum(["en", "pt"]),
    /** How the turn ended: answered, refused, or failed after the question was recorded. */
    outcome: z.enum(["answer", "refusal", "failed"]),
    refusalCause: z.string().nullable(),
    /** A failed turn's code (`ASSISTANT_UNAVAILABLE`, `BUDGET_EXCEEDED`, …). */
    code: z.string().nullable(),
    /** The assistant row the turn wrote: what a label names. */
    messageId: z.string().nullable(),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
    citedSections: z.array(z.string()).readonly(),
    citedFigures: z.array(z.string()).readonly(),
    /** Every expected citation was cited; for a compare item every expected chapter; for a refusal item the expected cause. */
    expectedHit: z.boolean(),
    claims: z.strictObject({ total: z.number().int().min(0), notFound: z.number().int().min(0), substituted: z.number().int().min(0) }).readonly(),
    verdicts: z.array(z.strictObject({ sensor: z.string(), verdict: z.string() }).readonly()).readonly(),
    grounded: z.number().min(0).max(1).nullable(),
    /** The grader's verdict on each criterion, true for PASS; null when the answer was not graded. */
    graderCriteria: CriteriaSchema.nullable(),
    /**
     * The hash of the cached prompt prefix. The one cache breakpoint sits immediately after the guide
     * (workers/agents/assistant/assemble.ts), so the cached prefix is the guide's bytes and its hash is the guide's:
     * the row's `guideSha256`. Not the row's `promptSha256`, which also covers the retrieved sections and so
     * differs with every question.
     */
    prefixSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    firstTokenMs: z.number().int().min(0).nullable(),
    totalMs: z.number().int().min(0).nullable(),
    /** One entry per call on the frontier alias, in the order they were made, with the tokens it read from the cache. */
    frontier: z.array(z.strictObject({ kind: z.enum(["assistant", "grading"]), cacheRead: z.number().int().min(0) }).readonly()).readonly(),
    /** Calls on the small alias: the scope classifier's. */
    smallCalls: z.number().int().min(0),
    costUsd: z.number().min(0),
    ledgerSeq: z.number().int().positive().nullable(),
  })
  .readonly();

export type GoldenRunItem = z.infer<typeof GoldenRunItemSchema>;

/** The first line of a run file: which run this is, so a report can name it and a label can point at it. */
export const GoldenRunHeaderSchema = z
  .strictObject({
    run: z.literal("golden"),
    release: ReleaseIdSchema,
    grade: z.enum(RUN_GRADES),
    startedAt: z.iso.datetime(),
    /** The account the run's conversations belong to: the gate's checks and `gate:show` read the rows as it. */
    userId: z.string().min(1),
    /** True when the run stopped before the last item (a budget refusal, § 7): the file is kept and says so. */
    partial: z.boolean(),
  })
  .readonly();

export type GoldenRunHeader = z.infer<typeof GoldenRunHeaderSchema>;
