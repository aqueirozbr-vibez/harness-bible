import { z } from "zod";

import { countWords } from "@/lib/improve/words";
import { EvidenceTierSchema } from "@/lib/schemas/domain";
import { CRITERIA, CriterionSchema, SuggestionSensorSchema } from "@/lib/schemas/improve";
import { CriterionVerdictValueSchema } from "@/lib/schemas/ledger";
import { jsonBody, unfenced } from "@/workers/agents/unfenced";

/*
 * The adjudicator's output, parsed strictly (feature-specs/33 § 5.3, § 5.4 check 1): a decision of the three it may
 * make, exactly six criteria, one for each name, each with a verdict — a value in the form the `decided` record takes
 * (`C`, `0.8`, `66<70`; 29 § 12), never a phrase — and a reason of at most thirty words; a tier that
 * would suffice with a request for more and only then; a failing sensor only with a decline. Anything else is the
 * agent's one failure (invariant 15): the suggestion goes to a curator with the reason this parser gives.
 */

export const REASON_WORDS_MAX = 30;

export const ADJUDICATOR_DECISIONS = ["ACCEPT", "REQUEST_MORE", "DECLINE"] as const;

const CriterionOutputSchema = z.strictObject({
  name: CriterionSchema,
  verdict: z.string().trim().pipe(CriterionVerdictValueSchema),
  reason: z
    .string()
    .trim()
    .min(1, "a reason is required")
    .refine((reason) => countWords(reason) <= REASON_WORDS_MAX, `a reason of at most ${String(REASON_WORDS_MAX)} words`),
});

export const AdjudicationOutputSchema = z
  .strictObject({
    decision: z.enum(ADJUDICATOR_DECISIONS),
    criteria: z.array(CriterionOutputSchema),
    sufficientTier: EvidenceTierSchema.optional(),
    failingSensor: SuggestionSensorSchema.optional(),
  })
  .superRefine((output, ctx) => {
    const names = output.criteria.map((c) => c.name);
    const missing = CRITERIA.filter((name) => !names.includes(name));
    if (names.length !== CRITERIA.length || missing.length > 0) ctx.addIssue({ code: "custom", path: ["criteria"], message: missing.length > 0 ? `no verdict on ${missing.join(", ")}` : "one verdict for each of the six criteria, and no more" });
    if (output.decision === "REQUEST_MORE" && output.sufficientTier === undefined) ctx.addIssue({ code: "custom", path: ["sufficientTier"], message: "a request for more names the tier that would suffice" });
    if (output.decision !== "REQUEST_MORE" && output.sufficientTier !== undefined) ctx.addIssue({ code: "custom", path: ["sufficientTier"], message: "a tier that would suffice goes only with a request for more" });
    if (output.decision !== "DECLINE" && output.failingSensor !== undefined) ctx.addIssue({ code: "custom", path: ["failingSensor"], message: "a failing sensor goes only with a decline" });
  });
export type AdjudicationOutput = z.infer<typeof AdjudicationOutputSchema>;

export type ParsedAdjudication = { readonly ok: true; readonly output: AdjudicationOutput } | { readonly ok: false; readonly reason: string };

export function parseAdjudication(text: string): ParsedAdjudication {
  let value: unknown;
  try {
    value = JSON.parse(jsonBody(unfenced(text))) as unknown;
  } catch {
    return { ok: false, reason: "the adjudicator's output is not JSON" };
  }
  const parsed = AdjudicationOutputSchema.safeParse(value);
  if (parsed.success) return { ok: true, output: parsed.data };
  const issue = parsed.error.issues[0];
  if (issue === undefined) return { ok: false, reason: "the adjudicator's output does not match its schema" };
  if (issue.code === "unrecognized_keys") return { ok: false, reason: `the adjudicator's output has a key it may not have: ${issue.keys.join(", ")}` };
  const path = issue.path.map(String).join(".");
  return { ok: false, reason: `${path === "" ? "the adjudicator's output" : path}: ${issue.message}` };
}
