import type { EvidenceItemView, SuggestionScoring, SuggestionView } from "@/lib/schemas/suggestions";

/*
 * The edit page's right column as the draft's read gives it (feature-specs/34 § 6; unit 51e): where the score stands
 * between the floor and the acceptance, the rows of "how it is computed", which of the prediction's forms the badge
 * and its sentence take, and which items it waits on. Every number is the view's; these only sort it into what the
 * column words.
 *
 * Pure, and light enough for a client island.
 */

/** Where a score stands against the class's thresholds. */
export type Band = "under" | "between" | "accepted";

/** Null where no score decides the class (curator always: no thresholds). */
export function bandOf(score: number, thresholds: SuggestionView["thresholds"]): Band | null {
  if (thresholds.acceptAt === null || thresholds.floorAt === null) return null;
  if (score >= thresholds.acceptAt) return "accepted";
  return score < thresholds.floorAt ? "under" : "between";
}

/** One row of "how it is computed", as the screen lists them. */
export type ComputedRow =
  | { readonly kind: "strongest"; readonly ordinal: number; readonly tier: string; readonly score: number }
  | { readonly kind: "corroboration"; readonly ordinal: number; readonly tier: string; readonly bonus: number }
  | { readonly kind: "alone"; readonly ordinal: number; readonly score: number }
  | { readonly kind: "grading"; readonly ordinal: number };

/**
 * The strongest item and its adjusted score; the corroboration and what it added (the score past the strongest's);
 * then every other item in its order — a graded one alone, its own score not added (the corroborating one too, as the
 * screen has it), one still grading. The score is never a sum (30 § 3.3).
 */
export function computedRowsOf(scoring: SuggestionScoring, items: ReadonlyArray<EvidenceItemView>): ComputedRow[] {
  const strongest = items.find((item) => item.id === scoring.strongestItemId);
  const corroborating = items.find((item) => item.id === scoring.corroboratedById);
  const rows: ComputedRow[] = [];
  if (strongest !== undefined) rows.push({ kind: "strongest", ordinal: strongest.ordinal, tier: strongest.tier ?? "U", score: strongest.adjustedScore ?? 0 });
  if (strongest !== undefined && corroborating !== undefined) rows.push({ kind: "corroboration", ordinal: corroborating.ordinal, tier: corroborating.tier ?? "U", bonus: scoring.score - (strongest.adjustedScore ?? 0) });
  for (const item of items) {
    if (item.id === strongest?.id) continue;
    rows.push(item.state === "PENDING" ? { kind: "grading", ordinal: item.ordinal } : { kind: "alone", ordinal: item.ordinal, score: item.adjustedScore ?? 0 });
  }
  return rows;
}

/** The prediction's form: the badge and the sentence the column shows for it. */
export type PredictionKey = "ACCEPT" | "REQUEST_MORE" | "REQUEST_MORE_BY_RULE" | "DECLINE" | "CURATOR";

export function predictionKeyOf(prediction: SuggestionScoring["prediction"]): PredictionKey {
  if (prediction.route === "CURATOR") return "CURATOR";
  if (prediction.route === "DECLINE_AT_INTAKE") return "DECLINE";
  if (prediction.route === "REQUEST_MORE_BY_RULE") return "REQUEST_MORE_BY_RULE";
  return prediction.decision === "ACCEPT" ? "ACCEPT" : "REQUEST_MORE";
}

/** What Submit needs to know (34 § 6, § 7): whether consent is asked for, a pause the throttle set, and how many of the day's submissions are spent. */
export interface SubmitFacts {
  readonly consentNeeded: boolean;
  /** ISO; null when no pause is set. */
  readonly throttledUntil: string | null;
  readonly submitted: number;
  readonly perDay: number;
  /** The throttle's numbers, which the pause's notice says (33 § 7). */
  readonly throttle: { readonly declines: number; readonly withinDays: number };
}

/** The ordinals the prediction waits on, as the list prints them (`03`): the items still grading. */
export function gradingOrdinalsOf(items: ReadonlyArray<EvidenceItemView>): string[] {
  return items.filter((item) => item.state === "PENDING").map((item) => String(item.ordinal).padStart(2, "0"));
}
