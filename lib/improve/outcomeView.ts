import { deadlineOf, groupOf } from "@/lib/improve/queue";
import { EvidenceTierSchema, type EvidenceTier } from "@/lib/schemas/domain";
import type { SuggestionView } from "@/lib/schemas/suggestions";

/*
 * A suggestion's own page as its view gives it (feature-specs/35 § 4; unit 52b): which of § 4's variants it is, and
 * what the anchor's quote and its before and after are. Every number is the view's. Pure.
 */

/**
 * Whether the request for more that stands is a failed chapter's check's (spec 37 § 4.5; unit 54b): the merge's check
 * failed, and no decision of the adjudicator's or the rules' came after it — a revision decided again is that decision.
 */
function returnedByCheck(view: Pick<SuggestionView, "adjudication"> & { readonly merge?: SuggestionView["merge"] }): boolean {
  const check = view.merge?.check ?? null;
  if (check === null || check.stage !== "CHECKED" || check.verdict !== "FAILED") return false;
  return view.adjudication === null || view.adjudication.decidedAt <= check.at;
}

/**
 * § 4's variants, by where the suggestion is and what was decided; `notProposed` is a researcher's proposal closed where a
 * person's suggestion would be asked for more (42 § 3; review of unit 60); `withdrawing` and `withdrawn` a contributor's
 * withdrawal being recorded and recorded (feature-specs/45 § 5.4; unit 63d).
 */
export type OutcomeVariant = "progress" | "budget" | "declined" | "requestMore" | "requestMoreByRule" | "curator" | "recommended" | "accepted" | "checkFailed" | "notProposed" | "closed" | "withdrawing" | "withdrawn";

/**
 * A suggestion under way is in progress whatever an earlier attempt decided: a revision returns it to `SUBMITTED`
 * with that attempt's decision still in its row until the next one (33 § 6.4). Past that, the suggestion's own
 * outcome is the decision that stands: the router writes no decision row (33 § 6.1), and a curator's decision moves
 * the suggestion without rewriting the row (33 § 6.3). The row says who decided: an adjudicator's or a rule's decline
 * ends in `CLOSED` as a curator's does, and only the row's decline tells them apart; a request for more is by rule
 * where the intake rules asked for it, and the check's where an accepted change's chapter's check failed (unit 54b).
 * A researcher's proposal is closed where a person's suggestion would be asked for more — by the rules, by the
 * adjudicator, or by the check after a curator's accept — and none of those is a curator closing it (review of unit 60).
 */
export function variantOf(view: Pick<SuggestionView, "state" | "outcome" | "adjudication" | "budgetResetsAt" | "origin"> & { readonly merge?: SuggestionView["merge"]; readonly withdrawnAt?: string | null }): OutcomeVariant {
  if (view.state === "SUBMITTED" || view.state === "GRADED" || view.state === "SENSED") return view.budgetResetsAt !== null ? "budget" : "progress";
  if (view.state === "MERGING" || view.state === "MERGED") return "accepted";
  const row = view.adjudication;
  /* a contributor's withdrawal (45 § 5.4): recorded, it is what closed the suggestion, whatever was decided before — an intake
     decline withdrawn would otherwise read as declined; asked for, it is being recorded wherever the suggestion waited */
  const withdrawn = (view.withdrawnAt ?? null) !== null;
  if (view.state === "CLOSED") {
    if (withdrawn) return "withdrawn";
    if (row !== null && row.decision === "DECLINE") return "declined";
    /* a curator's close writes DECLINE; a request for more that closed it is the check's or Improve's own */
    if (view.origin === "RESEARCHER" && view.outcome === "REQUEST_MORE") return returnedByCheck(view) ? "checkFailed" : "notProposed";
    return "closed";
  }
  if (withdrawn) return "withdrawing";
  const decision = view.outcome ?? row?.decision ?? null;
  if (decision === null) return view.budgetResetsAt !== null ? "budget" : "progress";
  /* a researcher's proposal the adjudicator accepted is a recommendation a curator decides (42 § 3; 43 § 7.1) */
  if (decision === "ACCEPT") return view.origin === "RESEARCHER" && view.state === "CURATOR_QUEUE" ? "recommended" : "accepted";
  if (decision === "DECLINE") return "declined";
  if (decision === "CURATOR_REVIEW") return "curator";
  /* accepted, and returned by the chapter's check: not the adjudicator asking for more (37 § 4.5) */
  if (returnedByCheck(view)) return "checkFailed";
  return row !== null && row.decision === "REQUEST_MORE" && row.decidedBy === "intake-rules" ? "requestMoreByRule" : "requestMore";
}

/**
 * What the page's reads compare to know it is out of date: the state, when the decision in the row was made, and the
 * budget's reset while the run waits at a cap. A revision under way keeps the earlier attempt's decision until its own
 * (33 § 6.4), so the decision alone would not say whether anything moved, and an attempt decided as the last one was
 * still differs by its time; a wait at the cap begins and ends with the state unchanged (33 § 7).
 */
export function refreshKeyOf(view: { readonly state: string; readonly adjudication: { readonly decidedAt: string } | null; readonly budgetResetsAt: string | null; readonly withdrawnAt?: string | null; readonly merge?: { readonly check: { readonly at: string } | null; readonly releaseTo?: string | null; readonly mergedAt?: string | null } | null }): string {
  /* a curator's merge moves its row without a new check (unit 54c): the release it sets aside, then when it merged */
  /* and a withdrawal asked for, or taken back, which moves no state (45 § 5.2) */
  return `${view.state}|${view.adjudication?.decidedAt ?? ""}|${view.budgetResetsAt ?? ""}|${view.merge?.check?.at ?? ""}|${view.merge?.releaseTo ?? ""}|${view.merge?.mergedAt ?? ""}|${view.withdrawnAt ?? ""}`;
}

/**
 * How long a withdrawal asked for may stand unrecorded before its owner is offered `Withdraw` again (review of unit 63).
 * A run records one in moments, so a request still standing after this may be one whose signal never left — the
 * server stopped between the two — and the endpoint sends it again; a run that holds it records it once.
 */
export const WITHDRAWAL_RESEND_MS = 120_000;

/** Whether a withdrawal asked for at `withdrawnAt` has stood unrecorded long enough to be offered again. */
export function resendsWithdrawal(withdrawnAt: string | null, now: Date): boolean {
  return withdrawnAt !== null && now.getTime() - Date.parse(withdrawnAt) >= WITHDRAWAL_RESEND_MS;
}

/** Who declined, for the decline's line: the intake rules, a failing sensor, or the adjudicator. */
export function declinedBy(adjudication: NonNullable<SuggestionView["adjudication"]>): "intake" | "sensor" | "adjudicator" {
  if (adjudication.failingSensor !== null) return "sensor";
  return adjudication.decidedBy === "adjudicator" ? "adjudicator" : "intake";
}

/**
 * A suggestion's pages' title, the anchor (35 § 4, § 5): a section's id and title, a figure's id and label, a row's id
 * and claim. A figure's text is `label · value`, a row's `claim — citation`; the page words it as `improve.outcome.title.<kind>`.
 */
export function anchorTitleOf(anchor: Pick<SuggestionView["anchor"], "kind" | "id" | "currentText">, sectionTitle: string): { readonly kind: "SECTION"; readonly id: string; readonly title: string } | { readonly kind: "FIGURE"; readonly id: string; readonly label: string } | { readonly kind: "SOURCE_ROW"; readonly id: string; readonly claim: string } {
  const text = anchor.currentText;
  if (anchor.kind === "SECTION") return { kind: "SECTION", id: anchor.id, title: sectionTitle };
  if (anchor.kind === "FIGURE") return { kind: "FIGURE", id: anchor.id, label: text.lastIndexOf(" · ") < 0 ? text : text.slice(0, text.lastIndexOf(" · ")) };
  return { kind: "SOURCE_ROW", id: anchor.id, claim: text.indexOf(" — ") < 0 ? text : text.slice(0, text.indexOf(" — ")) };
}

/** The record's short form, as the screen prints it: `rec#a91f·20d6`. */
export const shortHash = (hash: string): string => `${hash.slice(0, 4)}·${hash.slice(-4)}`;

/**
 * The anchor's quote and the change's before and after, by kind (31 § 4): a figure's or a row's own text and the value
 * or the row proposed; a section's passage and its replacement, or the claim, the row or the restructure added. The
 * edit page's revision shows the same, from the anchor's text alone.
 */
export function changeOf(view: { readonly anchor: { readonly currentText: string }; readonly proposal: SuggestionView["proposal"] }): { readonly quote: string; readonly before: string | null; readonly after: string | null } {
  const { anchor, proposal } = view;
  const value = (text: string): string => text.slice(text.lastIndexOf(" · ") + 3);
  if (proposal === null) return { quote: anchor.currentText, before: null, after: null };
  switch (proposal.kind) {
    case "SET_VALUE":
      return { quote: anchor.currentText, before: value(anchor.currentText), after: `${proposal.after}${proposal.unit === null ? "" : ` ${proposal.unit}`}` };
    case "EDIT_TEXT":
      return { quote: proposal.before, before: proposal.before, after: proposal.after };
    case "EDIT_ROW":
      /* Each field the row's edit changes, in the row's order: a new link, DOI or verification date is the change too. */
      return {
        quote: anchor.currentText,
        before: anchor.currentText,
        after: [proposal.claim, proposal.citation, proposal.url, proposal.doi, proposal.verifiedOn, proposal.value === undefined ? undefined : `${proposal.value.after}${proposal.value.unit === null ? "" : ` ${proposal.value.unit}`}`].filter((part) => part !== undefined).join(" — "),
      };
    case "ADD_CLAIM":
      return { quote: proposal.placeAfter === "end" ? anchor.currentText.slice(-280) : proposal.placeAfter, before: null, after: proposal.text };
    case "ADD_ROW":
      return { quote: anchor.currentText.slice(0, 280), before: null, after: `${proposal.claim} — ${proposal.citation}` };
    case "RESTRUCTURE":
      return { quote: anchor.currentText.slice(0, 280), before: null, after: proposal.description };
  }
}

/**
 * When a suggestion with a curator is due (35 § 4: `with a curator · part iii`, and the deadline's date): the queue's
 * own deadline (`lib/improve/queue.ts`, 36 § 3.1), counted from when it entered the queue — the suggestion's own
 * decision time, as the queue counts it, which a merge sent back to the queue moves and the adjudication's does not
 * (review of unit 60). None for a change that has no group in this build.
 */
export function queueDeadlineOf(view: Pick<SuggestionView, "changeClass" | "curatorReason" | "outcome" | "adjudication" | "decidedAt" | "origin">): Date | null {
  const entered = view.decidedAt ?? view.adjudication?.decidedAt ?? null;
  const group = groupOf(view);
  return entered === null || group === null ? null : deadlineOf(group, new Date(entered));
}

/**
 * Whether this suggestion's decline counts towards the throttle (33 § 7: declined with every item graded `U`), for the
 * throttle box's note (35 § 4): null where it was not declined, or while any item is ungraded (one added for a
 * revision), since what it will count is not known yet; else the strongest tier graded.
 */
export function throttleNoteOf(view: Pick<SuggestionView, "outcome" | "evidence">): { readonly counts: boolean; readonly tier: EvidenceTier } | null {
  if (view.outcome !== "DECLINE" || view.evidence.some((item) => item.tier === null)) return null;
  const tiers = view.evidence.flatMap((item) => (item.tier === null ? [] : [item.tier]));
  const strongest = EvidenceTierSchema.options.find((tier) => tiers.includes(tier));
  if (strongest === undefined) return null;
  return { counts: view.evidence.length > 0 && view.evidence.every((item) => item.tier === "U"), tier: strongest };
}
