import { digitsOf, figureIn, occurrences } from "@/lib/improve/passage";
import { countWords, RATIONALE_WORDS_MAX } from "@/lib/improve/words";
import type { JsonValue } from "@/lib/ledger/canonical";
import { ANCHOR_OF_CHANGE_KIND } from "@/lib/rubric/changeClass";
import { ProposalSchema, type AnchorKind, type ChangeKind, type EvidenceKind, type EvidenceState, type SuggestionOrigin, type SuggestionSensor } from "@/lib/schemas/improve";

/*
 * The four intake sensors (feature-specs/31 § 5): deterministic, each given rows and never a database, each
 * answering `{ sensor, result, detail, data }` as a `SuggestionSensorVerdict` row holds it. They run twice: at the
 * submit endpoint, so a person is told at once what to fix, and in the workflow, so that nothing that reached it by
 * another road skips them (§ 1). What is merely weak passes here: an item graded U or G parses; the floor declines
 * it after grading.
 *
 * `detail` is one line a curator reads on the Sensors table of the adjudication page, in the form the Components
 * screen gives (`F-23-07 does not exist at ch23 v1.4.1`); `data` is the same facts for a page to print in its own
 * words.
 */

export interface IntakeVerdict {
  readonly sensor: SuggestionSensor;
  readonly result: "PASS" | "FAIL";
  readonly detail: string;
  readonly data: JsonValue;
}

const pass = (sensor: SuggestionSensor, detail: string, data: JsonValue = {}): IntakeVerdict => ({ sensor, result: "PASS", detail, data });
const fail = (sensor: SuggestionSensor, detail: string, data: JsonValue = {}): IntakeVerdict => ({ sensor, result: "FAIL", detail, data });

/* ---------------------------------------------------------------- SCHEMA */

export interface SchemaFacts {
  readonly changeKind: ChangeKind;
  readonly anchorKind: AnchorKind;
  /** The proposal as stored: JSON, or null while none was written. */
  readonly proposal: unknown;
  /** The anchored section's source text and figures, for a passage to be found in and a figure to be kept out of; null for a figure or a row. */
  readonly section: { readonly id: string; readonly sourceText: string; readonly figures: ReadonlyArray<{ readonly id: string; readonly valueText: string }> } | null;
}

/**
 * The proposal parses for its change kind; the kind is allowed on the anchor's kind; a quoted passage occurs exactly
 * once in the section's source text; a text edit neither overlaps a figure nor changes a digit; `after` differs
 * from `before`.
 */
export function schemaSensor(facts: SchemaFacts): IntakeVerdict {
  const sensor = "SCHEMA";
  const allowed = ANCHOR_OF_CHANGE_KIND[facts.changeKind];
  if (allowed !== facts.anchorKind) return fail(sensor, `${facts.changeKind} is made on a ${allowed.toLowerCase().replace("_", " ")}, not on a ${facts.anchorKind.toLowerCase().replace("_", " ")}`, { field: "changeKind", allowed, anchorKind: facts.anchorKind });
  if (facts.proposal === null || facts.proposal === undefined) return fail(sensor, "no proposal was written", { field: "proposal" });
  const parsed = ProposalSchema.safeParse(facts.proposal);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue === undefined || issue.path.length === 0 ? "proposal" : issue.path.map(String).join(".");
    return fail(sensor, `proposal.${field}: ${issue?.message ?? "does not parse"}`, { field });
  }
  const proposal = parsed.data;
  if (proposal.kind !== facts.changeKind) return fail(sensor, `the proposal is a ${proposal.kind}; the draft is a ${facts.changeKind}`, { field: "proposal.kind", changeKind: facts.changeKind, proposalKind: proposal.kind });

  if (proposal.kind === "EDIT_TEXT" || proposal.kind === "ADD_CLAIM") {
    if (facts.section === null) return fail(sensor, `${proposal.kind} needs the section's text`, { field: "section" });
    const field = proposal.kind === "EDIT_TEXT" ? "before" : "placeAfter";
    const passage = proposal.kind === "EDIT_TEXT" ? proposal.before : proposal.placeAfter;
    if (passage !== "end") {
      const times = occurrences(facts.section.sourceText, passage);
      if (times !== 1) return fail(sensor, `${field}: the passage occurs ${String(times)} times in ${facts.section.id}; it must occur once`, { field, occurrences: times, section: facts.section.id });
    }
  }
  if (proposal.kind === "EDIT_TEXT" && facts.section !== null) {
    const figure = figureIn(proposal.before, facts.section.figures);
    if (figure !== null) return fail(sensor, `before: overlaps figure ${figure}; anchor the figure instead`, { field: "before", figure });
    if (digitsOf(proposal.before) !== digitsOf(proposal.after)) {
      const named = figureIn(proposal.after, facts.section.figures);
      return fail(sensor, named === null ? "after: changes a digit; a number is changed by anchoring its figure" : `after: changes a digit; anchor figure ${named} instead`, { field: "after", figure: named });
    }
    if (proposal.before === proposal.after) return fail(sensor, "after: is the same as before", { field: "after" });
  }
  return pass(sensor, `parses as ${proposal.kind} on a ${facts.anchorKind.toLowerCase().replace("_", " ")}`, { kind: proposal.kind });
}

/* ---------------------------------------------------------------- ANCHOR_EXISTS */

export interface AnchorFacts {
  /** The anchor as the draft recorded it. */
  readonly anchor: { readonly kind: AnchorKind; readonly sectionAnchor: string; readonly figureAnchor: string | null; readonly sourceRowAnchor: string | null; readonly contentSha256: string; readonly currentText: string };
  /** The pinned release's version of the chapter, for the sentence. */
  readonly chapter: { readonly number: number; readonly version: string };
  /** The anchor as the pinned release has it now, or null when it has not. */
  readonly now: { readonly contentSha256: string; readonly currentText: string } | null;
}

const anchorId = (anchor: AnchorFacts["anchor"]): string => anchor.figureAnchor ?? anchor.sourceRowAnchor ?? anchor.sectionAnchor;
/* The release stores a chapter's version as `v1.0.0`; the sentence prints one `v` whichever form arrives. */
const chapterAt = (chapter: AnchorFacts["chapter"]): string => `ch${String(chapter.number).padStart(2, "0")} v${chapter.version.replace(/^v/, "")}`;

/** The anchor exists in the pinned release, and its text is the one the draft recorded. */
export function anchorExistsSensor(facts: AnchorFacts): IntakeVerdict {
  const sensor = "ANCHOR_EXISTS";
  const id = anchorId(facts.anchor);
  if (facts.now === null) return fail(sensor, `${id} does not exist at ${chapterAt(facts.chapter)}`, { anchor: id, chapter: facts.chapter.number, version: facts.chapter.version, exists: false });
  if (facts.now.contentSha256 !== facts.anchor.contentSha256) {
    return fail(sensor, `${id} changed since the draft at ${chapterAt(facts.chapter)}`, { anchor: id, chapter: facts.chapter.number, version: facts.chapter.version, exists: true, was: facts.anchor.currentText, now: facts.now.currentText });
  }
  return pass(sensor, `${id} at ${chapterAt(facts.chapter)}`, { anchor: id, chapter: facts.chapter.number, version: facts.chapter.version, exists: true });
}

/* ---------------------------------------------------------------- EVIDENCE_PARSES */

export interface EvidenceFacts {
  readonly items: ReadonlyArray<{ readonly ordinal: number; readonly kind: EvidenceKind; readonly state: EvidenceState; readonly url: string | null; readonly doi: string | null; readonly storageKey: string | null; readonly labRunId: string | null }>;
  /**
   * Whether every item must have been through the fetcher already. The submit endpoint requires it, since a person
   * waits for their own items (31 § 6.1). The suggestion workflow's step 2 does not: it asks each item for what its
   * kind needs and leaves the grading to step 3, which grades what is still pending before the score (33 § 3.2;
   * Andre, 2026-10-07) — a researcher's items arrive ungraded, and a person's item added while the submission was
   * under way is graded there rather than declined.
   */
  readonly requireGraded: boolean;
}

const NEEDS: Readonly<Record<EvidenceKind, { readonly field: "url" | "doi" | "storageKey" | "labRunId"; readonly word: string }>> = {
  LINK: { field: "url", word: "a url" },
  DOI: { field: "doi", word: "a DOI" },
  UPLOAD: { field: "storageKey", word: "an uploaded file" },
  LAB_RUN: { field: "labRunId", word: "a saved lab run" },
};

/** At least one evidence item, each with what its kind needs and, where the caller requires it, through the fetcher (graded, whatever its tier). */
export function evidenceParsesSensor(facts: EvidenceFacts): IntakeVerdict {
  const sensor = "EVIDENCE_PARSES";
  if (facts.items.length === 0) return fail(sensor, "no evidence item; a suggestion carries at least one", { items: 0 });
  for (const item of [...facts.items].sort((a, b) => a.ordinal - b.ordinal)) {
    const needs = NEEDS[item.kind];
    if (item[needs.field] === null) return fail(sensor, `item ${String(item.ordinal)}: a ${item.kind} needs ${needs.word}`, { item: item.ordinal, kind: item.kind, lacks: needs.field });
    if (facts.requireGraded && item.state !== "GRADED") return fail(sensor, `item ${String(item.ordinal)}: not through the fetcher yet (${item.state})`, { item: item.ordinal, kind: item.kind, lacks: "grading", state: item.state });
  }
  const count = `${String(facts.items.length)} item${facts.items.length === 1 ? "" : "s"}`;
  return pass(sensor, facts.requireGraded ? `${count}, each graded` : `${count}, each with what its kind needs`, { items: facts.items.length });
}

/* ---------------------------------------------------------------- RATIONALE_LENGTH */

export interface RationaleFacts {
  readonly rationale: string | null;
  readonly origin: SuggestionOrigin;
}

/** A person's rationale is 1 to 200 words; a researcher's note is at most 200. */
export function rationaleLengthSensor(facts: RationaleFacts): IntakeVerdict {
  const sensor = "RATIONALE_LENGTH";
  const words = countWords(facts.rationale ?? "");
  const least = facts.origin === "HUMAN" ? 1 : 0;
  if (words < least) return fail(sensor, `${String(words)} words; a rationale is ${String(least)} to ${String(RATIONALE_WORDS_MAX)}`, { words, least, most: RATIONALE_WORDS_MAX });
  if (words > RATIONALE_WORDS_MAX) return fail(sensor, `${String(words)} words; at most ${String(RATIONALE_WORDS_MAX)}`, { words, least, most: RATIONALE_WORDS_MAX });
  return pass(sensor, `${String(words)} words`, { words, least, most: RATIONALE_WORDS_MAX });
}

/* ---------------------------------------------------------------- all four */

export interface IntakeFacts {
  readonly schema: SchemaFacts;
  readonly anchor: AnchorFacts;
  readonly evidence: EvidenceFacts;
  readonly rationale: RationaleFacts;
}

/** The four, in the spec's order; the first failure is what the submit endpoint names (§ 6.1 step 4). */
export function intakeSensors(facts: IntakeFacts): ReadonlyArray<IntakeVerdict> {
  return [schemaSensor(facts.schema), anchorExistsSensor(facts.anchor), evidenceParsesSensor(facts.evidence), rationaleLengthSensor(facts.rationale)];
}
