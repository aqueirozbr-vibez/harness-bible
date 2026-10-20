import type { ResolvedAnchor } from "@/lib/db/anchors";
import type { SuggestionForService } from "@/lib/db/improve";
import type { IntakeFacts } from "@/lib/sensors/intake";

/*
 * The facts the four intake sensors read (feature-specs/31 § 5), from a suggestion's rows and its anchor resolved
 * again against the pinned release. The submit endpoint and the suggestion workflow's intake step both build them
 * here, so a suggestion meets the same sensors on the same reads at both (33 § 3, step 2). `resolved` is null when the
 * anchor is not at the release any more; `chapter` is the version it was resolved at, or the chapter's current one
 * when it no longer resolves, and null when neither is known. `requireGraded` is the endpoint's (every item through
 * the fetcher already) and not the workflow's, whose step 3 grades what is still pending (Andre, 2026-10-07).
 */

type IntakeRow = Pick<SuggestionForService, "changeKind" | "proposal" | "chapterNumber" | "evidence" | "rationale" | "origin">;
type StoredAnchor = NonNullable<SuggestionForService["anchor"]>;

export function intakeFactsOf(row: IntakeRow, anchor: StoredAnchor, resolved: ResolvedAnchor | null, chapter: { readonly version: string } | null, requireGraded: boolean): IntakeFacts {
  return {
    schema: {
      changeKind: row.changeKind,
      anchorKind: anchor.kind,
      proposal: row.proposal,
      section: anchor.kind === "SECTION" && resolved !== null ? { id: anchor.sectionAnchor, sourceText: resolved.currentText, figures: resolved.figures } : anchor.kind === "SECTION" ? { id: anchor.sectionAnchor, sourceText: anchor.currentText, figures: [] } : null,
    },
    anchor: {
      anchor: { kind: anchor.kind, sectionAnchor: anchor.sectionAnchor, figureAnchor: anchor.figureAnchor, sourceRowAnchor: anchor.sourceRowAnchor, contentSha256: anchor.contentSha256, currentText: anchor.currentText },
      chapter: { number: row.chapterNumber, version: chapter?.version ?? "?" },
      now: resolved === null ? null : { contentSha256: resolved.contentSha256, currentText: resolved.currentText },
    },
    evidence: { requireGraded, items: row.evidence.map((item) => ({ ordinal: item.ordinal, kind: item.kind, state: item.state, url: item.url, doi: item.doi, storageKey: item.storageKey, labRunId: item.labRunId })) },
    rationale: { rationale: row.rationale, origin: row.origin },
  };
}
