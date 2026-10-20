import { SourceTierSchema, type SourceTier } from "@/lib/schemas/domain";
import type { AnchorKind, ChangeClass, ChangeKind, CuratorReason } from "@/lib/schemas/improve";
import { aboutOperatingEquipment } from "@/lib/sensors/scope";

/*
 * What a change is and which class it falls in (feature-specs/30 § 4.1, § 4.2). The class is computed from rows of
 * the release and fields of the proposal, never chosen by a person or a model (invariant 8), and it is what the
 * thresholds are read by. First match wins, in the order of the spec's table.
 *
 * Pure. The one vocabulary for "this is about operating equipment" is the assistant's scope sensor's (D4), read
 * here of the anchored text and of the proposed text.
 */

/** Where each kind of change is anchored (§ 4.1). Any other pairing is the schema sensor's to refuse (spec 31 § 5); this does not check it. */
export const ANCHOR_OF_CHANGE_KIND: Readonly<Record<ChangeKind, AnchorKind>> = {
  EDIT_TEXT: "SECTION",
  SET_VALUE: "FIGURE",
  EDIT_ROW: "SOURCE_ROW",
  ADD_CLAIM: "SECTION",
  ADD_ROW: "SECTION",
  RESTRUCTURE: "SECTION",
};

/** The anchor as the class reads it: its kind, the figure's row where it is one, and what it says. */
export interface ClassAnchor {
  readonly kind: AnchorKind;
  /** The anchored figure's row: its source tier and whether it is a scenario parameter. Null for a section or a row. */
  readonly figure: { readonly tier: SourceTier; readonly scenarioParam: boolean } | null;
  /** The anchored text: the quoted passage of a section, a figure's label and value, a source row's claim and citation. */
  readonly text: string;
}

/** The proposal as the class reads it. */
export interface ClassProposal {
  /** The proposed text: the new passage or sentence, the new value with its unit, the new row's claim and citation. */
  readonly text: string;
  /** The source tier a proposed row names, as given, or null where the proposal names none (spec 31 § 4). */
  readonly sourceTier: string | null;
}

export interface Classified {
  readonly changeClass: ChangeClass;
  /** Set for `CURATOR_ALWAYS` and for no other class. */
  readonly curatorReason: CuratorReason | null;
  /** The row of § 4.2 that decided. */
  readonly rule: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

const curator = (curatorReason: CuratorReason, rule: 1 | 2 | 3 | 4): Classified => ({ changeClass: "CURATOR_ALWAYS", curatorReason, rule });

/**
 * The class of a change (§ 4.2), first match wins:
 *
 *   1  a restructure                                          curator always · structure
 *   2  the anchored figure is a scenario parameter            curator always · scenario parameter
 *   3  the anchored or the proposed text is about operating
 *      equipment, by the assistant's own vocabulary           curator always · safety and OT boundary
 *   4  the proposal names a source tier the book has not      curator always · new source tier
 *   5  a value set on a derived figure                        derived figure
 *   6  a value set on any other figure; a row edited          cited figure
 *   7  a claim or a row added                                 new claim
 *   8  a passage edited                                       wording
 *
 * Rule 3 errs towards the curator on purpose: a false match costs a curator a look, a miss lets a model decide a
 * safety statement. `RUBRIC`, the sixth curator reason, has no rule here: a rubric change has no chapter anchor.
 */
export function classOf(anchor: ClassAnchor, changeKind: ChangeKind, proposal: ClassProposal): Classified {
  if (changeKind === "RESTRUCTURE") return curator("STRUCTURE", 1);
  if (anchor.figure !== null && anchor.figure.scenarioParam) return curator("SCENARIO_PARAMETER", 2);
  if (aboutOperatingEquipment(anchor.text) || aboutOperatingEquipment(proposal.text)) return curator("SAFETY_OT", 3);
  if (proposal.sourceTier !== null && !SourceTierSchema.safeParse(proposal.sourceTier).success) return curator("NEW_SOURCE_TIER", 4);
  if (changeKind === "SET_VALUE" && anchor.figure !== null && anchor.figure.tier === "DERIVED") return { changeClass: "DERIVED_FIGURE", curatorReason: null, rule: 5 };
  if (changeKind === "SET_VALUE" || changeKind === "EDIT_ROW") return { changeClass: "CITED_FIGURE", curatorReason: null, rule: 6 };
  if (changeKind === "ADD_CLAIM" || changeKind === "ADD_ROW") return { changeClass: "NEW_CLAIM", curatorReason: null, rule: 7 };
  return { changeClass: "WORDING", curatorReason: null, rule: 8 };
}
