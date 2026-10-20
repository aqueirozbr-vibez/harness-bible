import { decimalOfPrinted } from "@/lib/improve/value";
import type { ChangeKind, Proposal } from "@/lib/schemas/improve";
import { parseValue } from "@/pipeline/parse/figures";

/*
 * A revert (feature-specs/37 § 8; unit 54e), pure: the proposal that undoes a merged one, where a function can make it,
 * and the words of one a curator makes by hand. A revert is a merge in the other direction: the same check, the same
 * release steps, its own records; what `applyProposal` cannot undo — a claim or a row added, a row edited, a
 * restructure — is left for the curator's hand, as any change it refuses is (§ 4.3).
 */

/** The value a figure's text ends with (`cost reduction at 95% quality retention · 2.4×` → `2.4×`). */
const valueOf = (text: string): string => text.slice(text.lastIndexOf(" · ") + 3);

export type Reverse = { readonly byHand: false; readonly proposal: Proposal } | { readonly byHand: true; readonly proposal: Proposal; readonly why: string };

/**
 * The proposal that undoes `proposal`, as merged on `anchorText` (the anchor's text as the original read it): a
 * passage's edit with before and after exchanged; a value set back to the one the figure had. Anything else is the
 * curator's hand: a restructure of the product's own words, which `applyProposal` refuses as one (§ 4.3), so the
 * branch waits for their commit.
 */
export function reverseOf(originalId: string, kind: ChangeKind, proposal: Proposal | null, anchorText: string): Reverse {
  const byHand = (why: string): Reverse => ({ byHand: true, proposal: { kind: "RESTRUCTURE", description: `Revert of ${originalId}: ${why}` }, why });
  if (proposal === null) return byHand("the original's proposal is not here");
  switch (proposal.kind) {
    case "EDIT_TEXT":
      return { byHand: false, proposal: { kind: "EDIT_TEXT", before: proposal.after, after: proposal.before } };
    case "SET_VALUE": {
      /* The anchor's text is `label · valueText unit`, and the pipeline's `valueText` carries the unit already (`77% %`, `1 s s`): the unit is taken off once before the value is read (unit 54's review). */
      const printed = valueOf(proposal.unit !== null && anchorText.endsWith(` ${proposal.unit}`) ? anchorText.slice(0, -(proposal.unit.length + 1)) : anchorText);
      const was = parseValue(printed);
      if (was.value === null) return byHand("the value the figure had cannot be read from its text");
      /* the digits as the book printed them, so `$0.30` comes back as `0.30` and not `0.3`, and the file byte for byte */
      return { byHand: false, proposal: { kind: "SET_VALUE", after: decimalOfPrinted(printed) ?? String(was.value), unit: proposal.unit } };
    }
    case "ADD_CLAIM":
      return byHand("the claim added is taken out by hand");
    case "ADD_ROW":
      return byHand("the source row added is taken out by hand");
    case "EDIT_ROW":
      return byHand("the source row's fields are put back by hand");
    case "RESTRUCTURE":
      return byHand("the restructure is undone by hand");
  }
}

/** A revert's commit subject (§ 4.2's form): `S-21-0010: revert S-21-0001 at 21.3`. */
export function revertSubjectOf(revertId: string, originalId: string, anchorId: string): string {
  return `${revertId}: revert ${originalId} at ${anchorId}`;
}
