import { proxyActivities } from "@temporalio/workflow";

import type { GradeEvidenceStage } from "@/lib/schemas/workflows";

import type { EvidenceActivities } from "./activities";

/*
 * One evidence item through the grader's three activities (feature-specs/32 § 8): fetched or opened, its text — or
 * since unit 49f a checked copy of a PDF or an image — stored, graded. GradeEvidenceWorkflow runs it when an item is
 * added, and SuggestionWorkflow for an item still pending when the suggestion is submitted, "by the same activities"
 * (33 § 3.2), so the numbers below are written once. An item that could not be opened ends after the first activity,
 * which wrote its `U` grade with no model called (§ 4.4, § 13.8); an item with nothing the grader can read ends after
 * the second the same way. A grade the principal's budget refused leaves the item pending with the reset date.
 *
 * The activities' timeouts and attempts, with their derivation: the fetch under the fetcher's own 20 s deadline,
 * twice for a DOI (the landing page and the record together) and the store's writes after it, so 60 s and three
 * attempts for what the network does to a first try; the text's extraction and storage of at most 5 MB, 60 s and
 * three attempts; the grade under its request row's worst case — 60 s for a text (20 s a try and the SDK's two
 * retries), 90 s for a PDF or an image (one try; lib/gateway/policy.ts) — with the reads around it, so 120 s and
 * **one** attempt: the gateway client retries by the row, every agent's cap is one attempt (invariant 15), and an
 * activity that tried again would be a second.
 */

const { fetchItem } = proxyActivities<Pick<EvidenceActivities, "fetchItem">>({ startToCloseTimeout: "60 seconds", retry: { maximumAttempts: 3 } });
const { storeText } = proxyActivities<Pick<EvidenceActivities, "storeText">>({ startToCloseTimeout: "60 seconds", retry: { maximumAttempts: 3 } });
const { gradeItem } = proxyActivities<Pick<EvidenceActivities, "gradeItem">>({ startToCloseTimeout: "120 seconds", retry: { maximumAttempts: 1 } });

export type ItemGrade = Awaited<ReturnType<EvidenceActivities["gradeItem"]>>;

/** The item fetched, stored and graded, each stage told as it begins; what the last activity to run answered. */
/** After a wait at the budget cap (33 § 7; unit 50f): the grade alone, the item's text being stored already. */
export function gradeItemAgain(itemId: string): Promise<ItemGrade> {
  return gradeItem(itemId);
}

export async function gradeOneItem(itemId: string, onStage: (stage: GradeEvidenceStage) => void = () => undefined): Promise<ItemGrade> {
  onStage("1 of 3");
  const fetched = await fetchItem(itemId);
  if (!fetched.opened) return { state: "GRADED", tier: "U" };

  onStage("2 of 3");
  const stored = await storeText(itemId);
  if (!stored.text) return { state: "GRADED", tier: "U" };

  onStage("3 of 3");
  return gradeItem(itemId);
}
