import { canonicalize, type JsonValue } from "@/lib/ledger/canonical";
import { sha256 } from "@/pipeline/renderHash";
import type { Proposal } from "@/lib/schemas/improve";

/*
 * What a proposal is to the parts of Improve that do not store it (feature-specs/31 § 4; 42 § 4.3): its
 * normalised form, the key that says two proposals are one, and the texts the class's rule 3 reads of it.
 *
 * Pure.
 */

/** Whitespace is not a difference: every string of the proposal trimmed, with its runs of whitespace as one space. */
export function normaliseProposal(proposal: Proposal): Proposal {
  const text = (value: string): string => value.trim().replace(/\s+/g, " ");
  switch (proposal.kind) {
    case "EDIT_TEXT":
      return { kind: proposal.kind, before: text(proposal.before), after: text(proposal.after) };
    case "SET_VALUE":
      return { kind: proposal.kind, after: text(proposal.after), unit: proposal.unit === null ? null : text(proposal.unit) };
    case "EDIT_ROW":
      return {
        kind: proposal.kind,
        ...(proposal.claim === undefined ? {} : { claim: text(proposal.claim) }),
        ...(proposal.citation === undefined ? {} : { citation: text(proposal.citation) }),
        ...(proposal.url === undefined ? {} : { url: proposal.url.trim() }),
        ...(proposal.doi === undefined ? {} : { doi: proposal.doi.trim() }),
        ...(proposal.verifiedOn === undefined ? {} : { verifiedOn: proposal.verifiedOn }),
        ...(proposal.value === undefined ? {} : { value: { after: text(proposal.value.after), unit: proposal.value.unit === null ? null : text(proposal.value.unit) } }),
      };
    case "ADD_CLAIM":
      return { kind: proposal.kind, text: text(proposal.text), placeAfter: proposal.placeAfter === "end" ? "end" : text(proposal.placeAfter), fastMoving: proposal.fastMoving };
    case "ADD_ROW":
      return {
        kind: proposal.kind,
        claim: text(proposal.claim),
        citation: text(proposal.citation),
        ...(proposal.url === undefined ? {} : { url: proposal.url.trim() }),
        ...(proposal.doi === undefined ? {} : { doi: proposal.doi.trim() }),
        tier: typeof proposal.tier === "string" ? proposal.tier : { newTier: text(proposal.tier.newTier) },
        fastMoving: proposal.fastMoving,
      };
    case "RESTRUCTURE":
      return { kind: proposal.kind, description: text(proposal.description) };
  }
}

/** The anchor as the key reads it: where, and what the book said there, so that a changed text opens the question again (42 § 4.3). */
export interface KeyedAnchor {
  readonly kind: "SECTION" | "FIGURE" | "SOURCE_ROW";
  readonly sectionAnchor: string;
  readonly figureAnchor: string | null;
  readonly sourceRowAnchor: string | null;
  readonly contentSha256: string;
}

/** sha256 over the anchor and the normalised proposal, in the ledger's canonical form: the same proposal at the same text has one key. */
export function proposalKeyOf(anchor: KeyedAnchor, proposal: Proposal): string {
  const normalised = normaliseProposal(proposal);
  return sha256(
    canonicalize({
      anchor: { kind: anchor.kind, sectionAnchor: anchor.sectionAnchor, figureAnchor: anchor.figureAnchor, sourceRowAnchor: anchor.sourceRowAnchor, contentSha256: anchor.contentSha256 },
      proposal: JSON.parse(JSON.stringify(normalised)) as JsonValue,
    }),
  );
}

/** What the class reads of a proposal (30 § 4.2): the passage it anchors to, the text it proposes, and the tier it names. */
export interface ProposalTexts {
  /** For a section: the passage the proposal quotes. A figure's or a row's own text is the anchor's and not the proposal's. */
  readonly anchoredPassage: string;
  readonly proposedText: string;
  readonly sourceTier: string | null;
}

export function proposalTexts(proposal: Proposal): ProposalTexts {
  switch (proposal.kind) {
    case "EDIT_TEXT":
      return { anchoredPassage: proposal.before, proposedText: proposal.after, sourceTier: null };
    case "SET_VALUE":
      return { anchoredPassage: "", proposedText: `${proposal.after}${proposal.unit === null ? "" : ` ${proposal.unit}`}`, sourceTier: null };
    case "EDIT_ROW":
      return { anchoredPassage: "", proposedText: [proposal.claim, proposal.citation, proposal.value === undefined ? undefined : `${proposal.value.after}${proposal.value.unit === null ? "" : ` ${proposal.value.unit}`}`].filter((part) => part !== undefined).join(" — "), sourceTier: null };
    case "ADD_CLAIM":
      return { anchoredPassage: proposal.placeAfter === "end" ? "" : proposal.placeAfter, proposedText: proposal.text, sourceTier: null };
    case "ADD_ROW":
      return { anchoredPassage: "", proposedText: `${proposal.claim} — ${proposal.citation}`, sourceTier: typeof proposal.tier === "string" ? proposal.tier : proposal.tier.newTier };
    case "RESTRUCTURE":
      return { anchoredPassage: "", proposedText: proposal.description, sourceTier: null };
  }
}

/**
 * Whether the recency factor applies to a suggestion's evidence (30 § 3.4): the anchor's own flag, the book's, except
 * for a claim or a row added, which the book has no flag for yet. That one declares its own (31 § 4: "false for a
 * section until the proposal declares it"), and the curator sees the declaration. The grader, the adjudicator, the
 * view and the edit page read it here, one rule for all four (Andre, 2026-10-08, on the recommendation).
 */
export function fastMovingOf(proposal: Proposal | null, anchorFastMoving: boolean): boolean {
  if (proposal !== null && (proposal.kind === "ADD_CLAIM" || proposal.kind === "ADD_ROW")) return proposal.fastMoving;
  return anchorFastMoving;
}
