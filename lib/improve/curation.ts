import type { ChangeClass, Criterion, Decision, SuggestionOrigin } from "@/lib/schemas/improve";

/*
 * What a curator's decision is, and what it needs (feature-specs/36 § 5.2; unit 53c). Pure.
 *
 * An override is a decision that differs from what the adjudicator or the rules decided: accepting what was left at
 * request more or declined, declining what was accepted. Accepting against the adjudicator needs the criterion
 * overridden, a coded reason tied to it, and a note; declining against it needs the criterion and a note, and no code,
 * since none is given for that direction (D1). A curator-always change, and an adjudicator's failure, have no
 * adjudication to override: any action with a note, and no code. Agreeing — keeping a request for more, accepting an
 * accept — is recorded as agreement, the override rate's denominator.
 *
 * A researcher's proposal takes two decisions, accept or decline (feature-specs/42 § 7; unit 59e): nobody would
 * answer a request for more, so keeping one is refused, `NOT_FOR_RESEARCH`, before anything else is weighed.
 */

/** The four codes of the adjudicator guide v2.1 (the Curator-Queue screen), each tied to its criterion. */
export const OVERRIDE_CODES: Readonly<Record<string, Criterion>> = { "OV-IND-01": "independence", "OV-IND-02": "independence", "OV-REC-01": "recency", "OV-REL-01": "relevance" };

/** At most 400 characters (36 § 5.2; `CuratorAction.note`). */
export const NOTE_CHARS_MAX = 400;

export type CuratorDecisionAction = "ACCEPT" | "KEEP_REQUEST_MORE" | "DECLINE";

export type DecisionKind = "agreement" | "override" | "decision";

export type DecisionRefusal = "OVERRIDE_CODE_REQUIRED" | "OVERRIDE_CODE_INVALID" | "OVERRIDE_CODE_NOT_TAKEN" | "OVERRIDE_CRITERION_REQUIRED" | "OVERRIDE_CRITERION_NOT_TAKEN" | "OVERRIDE_NOTE_REQUIRED" | "NOT_FOR_RESEARCH";

export interface DecisionInput {
  readonly action: CuratorDecisionAction;
  /** Whose the suggestion is: a researcher's takes no request for more (42 § 7). */
  readonly origin: SuggestionOrigin;
  readonly changeClass: ChangeClass;
  /** What stands: the suggestion's outcome as it entered the queue — a request for more, an accept, or a curator's review. */
  readonly standing: Decision | null;
  readonly overrideCode: string | null;
  readonly criterion: Criterion | null;
  readonly note: string | null;
}

/**
 * The decision's kind, the criterion it records (a code's own where the curator named none), and the first refusal
 * of § 5.2, if any. A criterion is an override's alone: on any other decision it is refused, as a code is, so that no
 * agreement is recorded as overriding one (unit 53's review).
 */
export function decisionOf(input: DecisionInput): { readonly kind: DecisionKind; readonly criterion: Criterion | null; readonly refusal: DecisionRefusal | null } {
  if (input.action === "KEEP_REQUEST_MORE" && input.origin === "RESEARCHER") return { kind: "decision", criterion: null, refusal: "NOT_FOR_RESEARCH" };
  const note = input.note === null || input.note.trim() === "" ? null : input.note;
  const coded = input.overrideCode === null ? null : (OVERRIDE_CODES[input.overrideCode] ?? null);
  /* No adjudication to override: a curator-always change, or an adjudicator's failure. */
  if (input.changeClass === "CURATOR_ALWAYS" || input.standing === "CURATOR_REVIEW" || input.standing === null) {
    if (input.overrideCode !== null) return { kind: "decision", criterion: null, refusal: "OVERRIDE_CODE_NOT_TAKEN" };
    if (input.criterion !== null) return { kind: "decision", criterion: null, refusal: "OVERRIDE_CRITERION_NOT_TAKEN" };
    return { kind: "decision", criterion: null, refusal: note === null ? "OVERRIDE_NOTE_REQUIRED" : null };
  }
  const against = (input.action === "ACCEPT" && (input.standing === "REQUEST_MORE" || input.standing === "DECLINE")) || (input.action === "DECLINE" && input.standing === "ACCEPT");
  if (!against) {
    const kind: DecisionKind = (input.action === "KEEP_REQUEST_MORE" && input.standing === "REQUEST_MORE") || (input.action === "ACCEPT" && input.standing === "ACCEPT") ? "agreement" : "decision";
    return { kind, criterion: null, refusal: input.overrideCode !== null ? "OVERRIDE_CODE_NOT_TAKEN" : input.criterion !== null ? "OVERRIDE_CRITERION_NOT_TAKEN" : null };
  }
  if (input.action === "DECLINE") {
    /* Declining what was accepted: the criterion disputed and a note; no code is given for this direction (D1). */
    if (input.overrideCode !== null) return { kind: "override", criterion: input.criterion, refusal: "OVERRIDE_CODE_NOT_TAKEN" };
    if (input.criterion === null) return { kind: "override", criterion: null, refusal: "OVERRIDE_CRITERION_REQUIRED" };
    return { kind: "override", criterion: input.criterion, refusal: note === null ? "OVERRIDE_NOTE_REQUIRED" : null };
  }
  /* Accepting against the adjudicator: a code tied to the criterion overridden, and a note. */
  if (input.overrideCode === null) return { kind: "override", criterion: input.criterion, refusal: "OVERRIDE_CODE_REQUIRED" };
  if (coded === null || (input.criterion !== null && input.criterion !== coded)) return { kind: "override", criterion: input.criterion, refusal: "OVERRIDE_CODE_INVALID" };
  return { kind: "override", criterion: coded, refusal: note === null ? "OVERRIDE_NOTE_REQUIRED" : null };
}
