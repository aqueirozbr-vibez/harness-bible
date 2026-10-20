import { z } from "zod";

import { countWords } from "@/lib/improve/words";
import { RelevanceSchema } from "@/lib/schemas/rubric";
import { jsonBody, unfenced } from "@/workers/agents/unfenced";

/*
 * The evidence grader's output, parsed strictly (feature-specs/32 § 7.2, § 7.3): five keys and no others, a tier
 * the grader may give (B to G; A and U are never its to give), a relevance, a stake of `none` or `vendor` (the
 * third, `employer`, is code's), a date or null, a reason of at most thirty words. Anything else is the one failure
 * the agent has (invariant 15): the item is tier U with the reason this parser gives, and nothing numeric is read
 * from the text — the score is `lib/rubric`'s on the classifications (invariant 8).
 */

export const GRADER_TIERS = ["B", "C", "D", "E", "F", "G"] as const;
export const GraderTierSchema = z.enum(GRADER_TIERS);
export type GraderTier = z.infer<typeof GraderTierSchema>;

export const GRADER_STAKES = ["none", "vendor"] as const;
export const GraderStakeSchema = z.enum(GRADER_STAKES);

export const REASON_WORDS_MAX = 30;

export const EvidenceGradeOutputSchema = z.strictObject({
  tier: GraderTierSchema,
  relevance: RelevanceSchema,
  stake: GraderStakeSchema,
  publishedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD").nullable(),
  reason: z
    .string()
    .trim()
    .min(1, "a reason is required")
    .refine((reason) => countWords(reason) <= REASON_WORDS_MAX, `a reason of at most ${String(REASON_WORDS_MAX)} words`),
});
export type EvidenceGradeOutput = z.infer<typeof EvidenceGradeOutputSchema>;

export type ParsedGrade = { readonly ok: true; readonly grade: EvidenceGradeOutput } | { readonly ok: false; readonly reason: string };

/** One sentence naming the first thing wrong, for the row's reason and the ledger's hash of it. */
function reasonOf(error: z.ZodError, value: unknown): string {
  const issue = error.issues[0];
  if (issue === undefined) return "the grader's output does not match its schema";
  const path = issue.path.map(String).join(".");
  if (issue.code === "unrecognized_keys") return `the grader's output has a key it may not have: ${issue.keys.join(", ")}`;
  if (path === "tier") {
    const given = typeof value === "object" && value !== null ? (value as { tier?: unknown }).tier : undefined;
    return typeof given === "string" ? `tier ${given} is not the grader's to give` : "the grader's output names no tier";
  }
  if (path === "reason" && issue.code === "custom") {
    const given = typeof value === "object" && value !== null ? (value as { reason?: unknown }).reason : undefined;
    return typeof given === "string" ? `the reason is ${String(countWords(given))} words, over ${String(REASON_WORDS_MAX)}` : issue.message;
  }
  return `${path === "" ? "the grader's output" : path}: ${issue.message}`;
}

export function parseEvidenceGrade(text: string): ParsedGrade {
  let value: unknown;
  try {
    value = JSON.parse(jsonBody(unfenced(text))) as unknown;
  } catch {
    return { ok: false, reason: "the grader's output is not JSON" };
  }
  const parsed = EvidenceGradeOutputSchema.safeParse(value);
  return parsed.success ? { ok: true, grade: parsed.data } : { ok: false, reason: reasonOf(parsed.error, value) };
}
