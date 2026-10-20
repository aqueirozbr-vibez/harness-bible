import { changeOf } from "@/lib/improve/outcomeView";
import { deadlineOf, groupOf } from "@/lib/improve/queue";
import type { ProposalView } from "@/lib/schemas/api";
import type { EvidenceTier } from "@/lib/schemas/domain";
import { ProposalSchema, type AnchorKind, type ChangeClass, type ChangeKind, type CuratorReason, type Decision, type Part, type SuggestionOrigin, type SuggestionState } from "@/lib/schemas/improve";

/*
 * A research proposal as the reader who asked is shown it (feature-specs/43 § 5.3; unit 60b), pure: the anchor with its
 * section's title, the class, the change before and after as the edit page's fixed proposal shows it, each source's
 * host, tier and adjusted score, the score against the accept line, the researcher's note, where the proposal stands
 * — with a curator and by when, being merged, accepted in a chapter version, declined by a curator, returned by the
 * chapter's check — and the reader's own name on it. One presenter for the panel under the answer, the landing page's
 * list (60c) and the research endpoint. Nothing here names the run, the message or the question: the rows it reads
 * are the suggestion's, which say nothing of them (40 § 3).
 */

/** The suggestion's rows this view reads: the door's `readProposalsForAsker`, a researcher's suggestion and what hangs from it. */
export interface ProposalRow {
  readonly id: string;
  readonly origin: SuggestionOrigin;
  readonly state: SuggestionState;
  readonly outcome: Decision | null;
  readonly changeKind: ChangeKind;
  readonly changeClass: ChangeClass;
  readonly curatorReason: CuratorReason | null;
  readonly proposal: unknown;
  readonly rationale: string | null;
  readonly score: number | null;
  readonly parts: ReadonlyArray<Part>;
  readonly locale: "EN" | "PT";
  readonly decidedAt: Date | null;
  readonly anchor: { readonly kind: AnchorKind; readonly sectionAnchor: string | null; readonly figureAnchor: string | null; readonly sourceRowAnchor: string | null; readonly currentText: string } | null;
  readonly evidence: ReadonlyArray<{ readonly ordinal: number; readonly host: string | null; readonly tier: EvidenceTier | null; readonly adjustedScore: number | null }>;
  readonly adjudication: { readonly acceptAt: number | null; readonly decidedAt: Date | null } | null;
  readonly merge: { readonly versionTo: string | null } | null;
}

export interface ProposalViewInput {
  readonly row: ProposalRow;
  /** The anchor's section's title in the suggestion's edition; null where the release has no such section. */
  readonly title: string | null;
  /** The instant of the reader's own name on it, from their row; null where they have put none. */
  readonly endorsedAt: Date | null;
}

/** Where a proposal stands, as its line says it (43 § 5.1). */
function whereOf(row: ProposalRow): ProposalView["where"] {
  const base = { state: row.state, parts: [...row.parts], decisionBy: null, version: null, closedBy: null };
  switch (row.state) {
    case "CURATOR_QUEUE": {
      const group = groupOf(row);
      /* from when it entered the queue, as the queue counts it: a merge sent back moves the suggestion's time, not the adjudication's (review of unit 60) */
      const entered = row.decidedAt ?? row.adjudication?.decidedAt ?? null;
      const due = group === null ? null : deadlineOf(group, entered);
      return { ...base, decisionBy: due === null ? null : due.toISOString() };
    }
    case "MERGED":
      return { ...base, version: row.merge?.versionTo ?? null };
    case "CLOSED":
      /* a researcher's proposal is closed by a curator's decline, or by its chapter's check after a curator's accept (37 § 4.5) */
      return { ...base, closedBy: row.outcome === "REQUEST_MORE" ? "check" : "curator" };
    default:
      return base;
  }
}

/** The anchor's own id: the figure's or the row's where it is one, else the section's. */
function anchorIdOf(anchor: NonNullable<ProposalRow["anchor"]>): string {
  return anchor.figureAnchor ?? anchor.sourceRowAnchor ?? anchor.sectionAnchor ?? "";
}

export function proposalViewOf({ row, title, endorsedAt }: ProposalViewInput): ProposalView {
  const parsed = ProposalSchema.safeParse(row.proposal);
  const change = row.anchor === null || !parsed.success ? { before: null, after: null } : changeOf({ anchor: { currentText: row.anchor.currentText }, proposal: parsed.data });
  return {
    suggestionId: row.id,
    anchor: row.anchor === null ? null : { kind: row.anchor.kind, id: anchorIdOf(row.anchor), section: row.anchor.sectionAnchor, title },
    changeKind: row.changeKind,
    changeClass: row.changeClass,
    curatorReason: row.curatorReason,
    change: { before: change.before, after: change.after },
    contentLang: row.locale === "PT" ? "pt" : "en",
    sources: row.evidence.map((item) => ({ host: item.host, tier: item.tier, adjusted: item.adjustedScore })),
    score: row.score,
    acceptAt: row.adjudication?.acceptAt ?? null,
    note: row.rationale,
    where: whereOf(row),
    endorsed: endorsedAt === null ? null : { byMe: true, at: endorsedAt.toISOString() },
  };
}
