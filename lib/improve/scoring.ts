import type { SuggestionForService } from "@/lib/db/improve";
import { registrableDomain } from "@/lib/improve/independence";
import { adjustedOf, recencyOf, type GradedItem } from "@/lib/rubric/score";
import type { RubricRules } from "@/lib/schemas/rubric";

/*
 * A suggestion's evidence rows as `lib/rubric`'s score reads them (feature-specs/30 § 3.3): the graded items in the
 * order they were added, each with its tier, whether it was opened, its three factors as numbers, and its publisher —
 * its host's registrable domain, as independence reads it (32 § 7.4); an upload has none. One mapping serves the
 * view's preview and the score the suggestion workflow records, because "the same function must serve the preview"
 * (33 § 3.3): the two cannot differ. And the items a draft's changed fast-moving declaration scores again.
 */

type EvidenceRow = SuggestionForService["evidence"][number];

export interface GradedRows<T extends EvidenceRow> {
  /** The rows that are graded, in the order they were added. */
  readonly graded: ReadonlyArray<T>;
  /** The same rows as `scoreOf` takes them. */
  readonly items: ReadonlyArray<GradedItem>;
}

const factorOf = (value: EvidenceRow["relevance"]): number | null => (value === null ? null : Number(value));

export function gradedItemsOf<T extends EvidenceRow>(evidence: ReadonlyArray<T>): GradedRows<T> {
  const graded = evidence.filter((item) => item.state === "GRADED" && item.tier !== null && item.adjustedScore !== null);
  return {
    graded,
    items: graded.map((item) => ({
      id: item.id,
      tier: item.tier ?? "U",
      opened: (item.fetchStatus ?? "").startsWith("opened:"),
      relevance: factorOf(item.relevance),
      recency: factorOf(item.recency),
      independence: factorOf(item.independence),
      publisher: item.host === null ? null : registrableDomain(item.host),
    })),
  };
}

/** A graded item's recency and score as a changed fast-moving declaration makes them. */
export interface Rescored {
  readonly itemId: string;
  readonly recency: number;
  readonly adjustedScore: number;
}

/**
 * The graded items whose recency the draft's fast-moving declaration now moves (30 § 3.4, as decided; 34 § 24): each
 * with its recency again by `recencyOf`, from the age its grader recorded, and its score again by `adjustedOf`. An
 * item's recency is fixed when it is graded, so a box ticked after it would leave the item scored as the other kind
 * of claim while the panel, the view and the adjudicator read the new one (unit 51d's review). An item with no factors
 * (`U`) has nothing to move, and one whose recency already agrees is left out. Pure: no model is asked.
 */
export function rescoredOf(evidence: ReadonlyArray<EvidenceRow>, rules: RubricRules, fastMoving: boolean): Rescored[] {
  return evidence.flatMap((item) => {
    if (item.state !== "GRADED" || item.tier === null || item.tier === "U") return [];
    const relevance = factorOf(item.relevance);
    const recency = factorOf(item.recency);
    const independence = factorOf(item.independence);
    if (relevance === null || recency === null || independence === null) return [];
    const moved = recencyOf(rules, item.ageDays, fastMoving);
    return moved === recency ? [] : [{ itemId: item.id, recency: moved, adjustedScore: adjustedOf(rules, item.tier, { relevance, recency: moved, independence }) }];
  });
}
