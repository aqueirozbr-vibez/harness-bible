import type { ResolvedAnchor } from "@/lib/db/anchors";
import type { Lang, Part } from "@/lib/db/generated/enums";
import type { ResearchSubmission } from "@/lib/db/improve";
import { proposalKeyOf, proposalTexts } from "@/lib/improve/proposal";
import { classOf } from "@/lib/rubric/changeClass";
import type { ReaderFinding } from "@/lib/schemas/researcher";
import { suggestionWorkflowId } from "@/lib/schemas/workflows";

/*
 * What a finding that passed the checks becomes in Improve (feature-specs/42 § 4; feature-specs/48 § 8.2 step 5,
 * § 8.4), pure: the anchor as resolved against the release again, the class computed as a person's draft has it (rule 3
 * reads the passage and the proposed text, rule 4 the tier), the proposal's key over the anchor's content, the note,
 * and the finding's `https` sources, each once. Moved here in unit 74 from `workers/research/submit.ts`, so that the
 * web tier's draft and the workers' send compute one class and one key: a contributor's draft from a finding and the
 * same finding sent as a researcher's proposal are the same change to the duplicate check (§ 8.5).
 */

const HTTPS = /^https:\/\//i;

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** The anchor as a suggestion stores it, from the release's read of it. */
function anchorOf(resolved: ResolvedAnchor): ResearchSubmission["anchor"] {
  return { kind: resolved.kind, sectionAnchor: resolved.sectionAnchor, figureAnchor: resolved.figureAnchor, sourceRowAnchor: resolved.sourceRowAnchor, currentText: resolved.currentText, contentSha256: resolved.contentSha256, existsAtVersion: true };
}

/** The finding's proposal key against its anchor as the release has it now (42 § 4.3): what the duplicate check compares. */
export function findingKeyOf(finding: ReaderFinding, resolved: ResolvedAnchor): string {
  return proposalKeyOf(anchorOf(resolved), finding.proposal);
}

/** The finding's `https` sources, trimmed and each once, in the reader's order, with their hosts. */
export function findingSourcesOf(finding: ReaderFinding): ReadonlyArray<{ readonly url: string; readonly host: string }> {
  return [...new Set(finding.sources.map((source) => source.url.trim()).filter((url) => HTTPS.test(url)))].map((url) => ({ url, host: hostOf(url) }));
}

/** The submission a finding makes, from the anchor as resolved and the rubric in force. */
export function submissionOf(finding: ReaderFinding, resolved: ResolvedAnchor, rubricVersionId: string, locale: Lang, now: Date): ResearchSubmission {
  const texts = proposalTexts(finding.proposal);
  const judged = resolved.kind === "SECTION" ? texts.anchoredPassage : resolved.currentText;
  const classified = classOf({ kind: resolved.kind, figure: resolved.figureAnchor === null ? null : { tier: resolved.tier ?? "OPEN", scenarioParam: resolved.scenarioParam }, text: judged }, finding.changeKind, { text: texts.proposedText, sourceTier: texts.sourceTier });
  const parts: Part[] = [...new Set<Part>([resolved.part, ...resolved.readBy.map((entry) => entry.part)])];
  return {
    chapterNumber: resolved.chapterNumber,
    chapterVersionId: resolved.chapterVersionId,
    releaseId: resolved.releaseId,
    parts,
    changeKind: finding.changeKind,
    changeClass: classified.changeClass,
    curatorReason: classified.curatorReason,
    locale,
    rubricVersionId,
    anchor: anchorOf(resolved),
    proposal: JSON.parse(JSON.stringify(finding.proposal)) as ResearchSubmission["proposal"],
    proposalKey: findingKeyOf(finding, resolved),
    note: finding.note,
    sources: findingSourcesOf(finding),
    workflowIdOf: suggestionWorkflowId,
    now,
  };
}

/**
 * The finding's sources that are not among a draft's evidence (48 § 8.2): those whose address no item of the draft
 * holds — a grading whose start failed, an item the contributor removed — read each time, never remembered.
 */
export function sourcesNotAmong<S extends { readonly url: string }>(sources: ReadonlyArray<S>, items: ReadonlyArray<{ readonly url: string | null }>): ReadonlyArray<S> {
  const held = new Set(items.flatMap((item) => (item.url === null ? [] : [item.url.trim()])));
  return sources.filter((source) => !held.has(source.url));
}
