import { z } from "zod";
import { jsonBody, unfenced } from "@/workers/agents/unfenced";

import type { Guide } from "@/lib/guides/load";
import type { ResolvedClaim, SensorVerdict } from "@/lib/schemas/assistant";
import type { PromptMessage, PromptSection, TextBlock } from "@/workers/agents/assistant/assemble";
import { sectionFence } from "@/workers/agents/assistant/assemble";

/*
 * The grounding grader (feature-specs/13 § 7.3; architecture § 6.2). A second frontier call in an isolated
 * context: it is given the grader's own rules, the sections, and the answer's claims after substitution, and
 * nothing else. It never sees the question, the conversation, the reader, or the first call's reasoning.
 *
 * The isolation is the point. A grader that knew what was asked would forgive a claim for being responsive, and
 * the question this sensor exists to answer is narrower: do these claims stand on these sections?
 *
 * The score is computed here, from the criteria, and the model's own number is ignored if it writes one
 * (invariant 12: no score is taken from a model). `grader.md` says so too, so the model is not surprised.
 */

export const CRITERIA = ["supported", "precise", "complete", "in_scope"] as const;
export type CriterionName = (typeof CRITERIA)[number];

export const CriterionSchema = z
  .strictObject({
    name: z.enum(CRITERIA),
    verdict: z.enum(["PASS", "FAIL"]),
    reason: z.string().max(400),
  })
  .readonly();

/** The model's output. A `grounded` field is accepted and ignored, so a model that writes one is not an error. */
export const GraderOutputSchema = z
  .looseObject({ criteria: z.array(CriterionSchema).readonly() })
  .readonly();
export type GraderOutput = z.infer<typeof GraderOutputSchema>;

export interface GraderPromptInput {
  readonly guide: Guide;
  readonly sections: ReadonlyArray<PromptSection>;
  /** The claims **after** substitution: the grader judges what the reader will see, not what the model first wrote. */
  readonly claims: ReadonlyArray<ResolvedClaim>;
}

export interface GraderPrompt {
  readonly system: ReadonlyArray<TextBlock>;
  readonly messages: ReadonlyArray<PromptMessage>;
}

/**
 * The grader's prompt. Three slots and no others: its rules, the sections, the claims. There is no field here for
 * the question or the conversation, for the same reason the assistant's input type has none for the reader.
 */
export function assembleGrader(input: GraderPromptInput): GraderPrompt {
  const claims = input.claims
    .map((claim, index) => `${String(index + 1)}. [${claim.sectionId}${claim.figureId === null ? "" : ` ${claim.figureId}`}] ${claim.text}`)
    .join("\n");
  return {
    system: [{ type: "text", text: input.guide.prefix, cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: input.sections.map(sectionFence).join("\n\n") },
      { role: "user", content: `<claims>\n${claims}\n</claims>` },
    ],
  };
}

export interface Graded {
  /** The share of criteria that passed, computed here. Null when the grader could not be run or read. */
  readonly grounded: number | null;
  readonly criteria: ReadonlyArray<z.infer<typeof CriterionSchema>>;
  readonly verdict: SensorVerdict;
}

/** The score at or above which an answer ships without a repair (§ 7.3). */
export const GROUNDED_FLOOR = 0.7;

/** The score from the criteria, never from the model: the share that passed, weighted equally (invariant 12). */
export function scoreOf(criteria: ReadonlyArray<z.infer<typeof CriterionSchema>>): number {
  if (criteria.length === 0) return 0;
  return criteria.filter((criterion) => criterion.verdict === "PASS").length / criteria.length;
}

/** The grader's raw text in; a score, the criteria and the verdict out. Never throws: a bad answer is `NA`. */
export function readGrade(text: string): Graded {
  let parsed: unknown;
  try {
    /* The real grader fences its object too; a fence is not a missing grade (workers/agents/unfenced.ts). */
    parsed = JSON.parse(jsonBody(unfenced(text)));
  } catch {
    return unavailable("the grader's answer was not JSON");
  }
  const result = GraderOutputSchema.safeParse(parsed);
  if (!result.success) return unavailable("the grader's answer did not match its schema");

  const criteria = result.data.criteria;
  if (criteria.length === 0) return unavailable("the grader returned no criteria");

  const grounded = scoreOf(criteria);
  const failed = criteria.filter((criterion) => criterion.verdict === "FAIL");
  return {
    grounded,
    criteria,
    verdict: {
      sensor: "grader",
      verdict: grounded >= GROUNDED_FLOOR ? "PASS" : "FAIL",
      detail: `grounded ${grounded.toFixed(2)} · isolated context` + (failed.length === 0 ? "" : ` · ${failed.map((criterion) => criterion.name).join(", ")}`),
      /* The names beside the count (feature-specs/22 § 5): the gate's κ per criterion reads which of the four
         failed, and a sentence is not a place to read a fact from. */
      data: { grounded, criteria: criteria.length, failed: failed.length, failedCriteria: failed.map((criterion) => criterion.name).join(",") },
    },
  };
}

/** The grader could not be run or could not be read: the answer ships with no score and the span says why (§ 7.3). */
export function unavailable(reason: string): Graded {
  return {
    grounded: null,
    criteria: [],
    verdict: { sensor: "grader", verdict: "NA", detail: reason, data: { grounded: 0, criteria: 0, failed: 0 } },
  };
}

/** The repair instruction the grader's failures become (§ 8): the criteria that failed, in the model's own words. */
export function repairFromGrade(graded: Graded): string {
  const failed = graded.criteria.filter((criterion) => criterion.verdict === "FAIL");
  const lines = failed.map((criterion) => `- ${criterion.name}: ${criterion.reason}`).join("\n");
  return `A grader judged your answer against the sections alone and failed these criteria:\n${lines}\nAnswer again, correcting them, citing only the sections you were given.`;
}
