import { ApplicationFailure, defineQuery, setHandler } from "@temporalio/workflow";

import { GRADE_EVIDENCE_STAGE_QUERY, GradeEvidenceInputSchema, type GradeEvidenceInput, type GradeEvidenceResult, type GradeEvidenceStage } from "@/lib/schemas/workflows";

import { gradeOneItem } from "./grading";

/*
 * GradeEvidenceWorkflow (feature-specs/32 § 8): one evidence item, fetched or opened, its text extracted and
 * stored, graded — three activities in order (`grading.ts`, with their timeouts and attempts and why), the stage of
 * each answered to the `stage` query, which is the number the form's loader shows. An item that could not be opened
 * ends after the first activity, which wrote its `U` grade with no model called (§ 4.4, § 13.8); an item with nothing
 * the grader can read — no text, or since unit 49f a PDF or an image the provider would refuse (another type than
 * given, too large, a side over 8000 px) — ends after the second the same way. A grade the principal's budget refused
 * leaves the item pending with the reset date on its row, and the workflow says so: nothing is graded `U` for lack of
 * budget.
 */

export const gradeEvidenceStage = defineQuery<GradeEvidenceStage>(GRADE_EVIDENCE_STAGE_QUERY);

export async function GradeEvidenceWorkflow(input: GradeEvidenceInput): Promise<GradeEvidenceResult> {
  if (!GradeEvidenceInputSchema.safeParse(input).success) {
    throw ApplicationFailure.nonRetryable("GradeEvidenceWorkflow takes { itemId: <uuid> }", "WORKFLOW_INPUT");
  }
  let stage: GradeEvidenceStage = "1 of 3";
  setHandler(gradeEvidenceStage, () => stage);

  const graded = await gradeOneItem(input.itemId, (next) => {
    stage = next;
  });
  return graded.state === "GRADED" ? { itemId: input.itemId, state: "GRADED", tier: graded.tier } : { itemId: input.itemId, state: "PENDING", tier: null };
}
