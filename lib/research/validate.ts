import type { ResearchSection } from "@/lib/db/research";
import { anchorKindOf } from "@/lib/improve/suggest";
import { FINDINGS_MAX, NOTE_WORDS_MAX, PAGE_NOTE_WORDS_MAX, ReaderFindingSchema, ReaderNoteSchema, wordCount, type ReaderFinding, type ReaderNote } from "@/lib/schemas/researcher";
import { findSecrets } from "@/lib/security/redact";
import { schemaSensor } from "@/lib/sensors/intake";

/*
 * The validation of a reader's findings (feature-specs/41 § 7; unit 58e), pure. Every finding is checked in code before
 * it becomes anything, in the table's order: the finding has the shape the guide asks for (`PROPOSAL`, as the shape is
 * the proposal's); the anchor is in a section the reader was given and exists in the pinned release (`ANCHOR`); the
 * change kind may be anchored there and the proposal passes the intake's SCHEMA sensor — the passage occurs once, a
 * text edit changes no digit (`PROPOSAL`); the proposal changes something (`NO_CHANGE`); every
 * source is an `https` address the call's own tool results showed (`SOURCE_NOT_SEEN`); at least one source remains
 * (`NO_SOURCE`); the note is within its limit and passes the secret patterns (`NOTE`). Findings beyond the third are
 * dropped and counted. A refusal names its reason and nothing of the text, which is what the finding's row records.
 *
 * `SOURCE_NOT_SEEN` is the check that keeps the reader honest about where a claim came from: an address it wrote but
 * never opened is an invention, however plausible. Passing it earns a source nothing — the evidence fetcher opens every
 * one again (spec 42 § 4.2).
 */

export const INVALID_REASONS = ["ANCHOR", "PROPOSAL", "NO_CHANGE", "SOURCE_NOT_SEEN", "NO_SOURCE", "NOTE"] as const;
export type InvalidReason = (typeof INVALID_REASONS)[number];

export interface ValidationContext {
  /** The sections the reader was given, at the pinned release, with their figures and rows. */
  readonly sections: ReadonlyArray<ResearchSection>;
  /** The `https` addresses the call's tools returned or opened (lib/gateway/tools.ts `pagesSeen`). */
  readonly pages: ReadonlyArray<string>;
}

export type Validation = { readonly valid: true; readonly sources: ReadonlyArray<string> } | { readonly valid: false; readonly reason: InvalidReason };

const HTTPS = /^https:\/\//i;

/** The section an anchor belongs to among those given: the section itself, or the one holding the figure or the row; null when none. */
export function sectionOfAnchor(anchor: ReaderFinding["anchor"], sections: ReadonlyArray<ResearchSection>): ResearchSection | null {
  if (anchorKindOf(anchor.id) !== anchor.kind) return null;
  if (anchor.kind === "SECTION") return sections.find((section) => section.id === anchor.id) ?? null;
  if (anchor.kind === "FIGURE") return sections.find((section) => section.figures.some((figure) => figure.id === anchor.id)) ?? null;
  return sections.find((section) => section.rows.some((row) => row.id === anchor.id)) ?? null;
}

function normalisedSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Whether the proposal says what the book already says at the anchor (41 § 7, `NO_CHANGE`). */
export function changesNothing(finding: ReaderFinding, section: ResearchSection): boolean {
  const { proposal } = finding;
  switch (proposal.kind) {
    case "EDIT_TEXT":
      return normalisedSpace(proposal.before) === normalisedSpace(proposal.after);
    case "ADD_CLAIM":
      return normalisedSpace(section.text).includes(normalisedSpace(proposal.text));
    case "SET_VALUE": {
      const figure = section.figures.find((candidate) => candidate.id === finding.anchor.id);
      return figure !== undefined && figure.valueText.trim() === proposal.after.trim() && (figure.unit ?? null) === (proposal.unit ?? null);
    }
    case "EDIT_ROW": {
      const row = section.rows.find((candidate) => candidate.id === finding.anchor.id);
      if (row === undefined) return false;
      const same = [proposal.claim === undefined || proposal.claim === row.claim, proposal.citation === undefined || proposal.citation === row.citation, proposal.url === undefined || proposal.url === row.url, proposal.verifiedOn === undefined || proposal.verifiedOn === row.verifiedOn.toISOString().slice(0, 10)];
      return proposal.doi === undefined && proposal.value === undefined && same.every(Boolean);
    }
    case "ADD_ROW":
      return section.rows.some((row) => normalisedSpace(row.claim) === normalisedSpace(proposal.claim) || (proposal.url !== undefined && row.url === proposal.url));
    case "RESTRUCTURE":
      return false;
  }
}

/** One finding against the table of § 7, in its order. */
export function validate(finding: ReaderFinding, context: ValidationContext): Validation {
  const section = sectionOfAnchor(finding.anchor, context.sections);
  if (section === null) return { valid: false, reason: "ANCHOR" };
  const schema = schemaSensor({ changeKind: finding.changeKind, anchorKind: finding.anchor.kind, proposal: finding.proposal, section: finding.anchor.kind === "SECTION" ? { id: section.id, sourceText: section.text, figures: section.figures.map((figure) => ({ id: figure.id, valueText: figure.valueText })) } : null });
  if (schema.result === "FAIL") return { valid: false, reason: "PROPOSAL" };
  if (changesNothing(finding, section)) return { valid: false, reason: "NO_CHANGE" };
  const sources = [...new Set(finding.sources.map((source) => source.url.trim()).filter((url) => url.length > 0))];
  const seen = new Set(context.pages);
  if (sources.some((url) => !HTTPS.test(url) || !seen.has(url))) return { valid: false, reason: "SOURCE_NOT_SEEN" };
  if (sources.length === 0) return { valid: false, reason: "NO_SOURCE" };
  if (wordCount(finding.note) > NOTE_WORDS_MAX || findSecrets(finding.note).length > 0) return { valid: false, reason: "NOTE" };
  return { valid: true, sources };
}

export interface ValidatedFinding {
  /** One-based, in the reader's order: the finding's row. */
  readonly ordinal: number;
  /** The finding as parsed; null where it was not of the guide's shape and the verdict says `PROPOSAL`. */
  readonly finding: ReaderFinding | null;
  readonly verdict: Validation;
}

export interface ValidatedFindings {
  readonly findings: ReadonlyArray<ValidatedFinding>;
  /** How many were beyond the third and dropped unread (A13). */
  readonly dropped: number;
}

/** Every finding the reader wrote, as written, up to the third, each with its verdict; the rest dropped and counted. */
export function validateFindings(findings: ReadonlyArray<unknown>, context: ValidationContext): ValidatedFindings {
  const kept = findings.slice(0, FINDINGS_MAX);
  return {
    findings: kept.map((raw, index) => {
      const parsed = ReaderFindingSchema.safeParse(raw);
      if (!parsed.success) return { ordinal: index + 1, finding: null, verdict: { valid: false, reason: "PROPOSAL" } };
      return { ordinal: index + 1, finding: parsed.data, verdict: validate(parsed.data, context) };
    }),
    dropped: Math.max(0, findings.length - FINDINGS_MAX),
  };
}

/**
 * A person's run's page notes checked in code (feature-specs/48 § 5.5; unit 70a), pure. A note is kept only when its
 * shape is the guide's, its address is among the pages the turn saw (`found.pages`, the same list `SOURCE_NOT_SEEN` is
 * decided against), it is at most 60 words, and it passes the secret patterns. What is kept is `found.says`, the
 * writer's to read; a note that fails is dropped and counted, never stored, and never shown.
 */
export function checkNotes(notes: ReadonlyArray<unknown>, pages: ReadonlyArray<string>): { readonly says: ReadonlyArray<ReaderNote>; readonly dropped: number } {
  const seen = new Set(pages);
  const says: ReaderNote[] = [];
  for (const raw of notes) {
    const parsed = ReaderNoteSchema.safeParse(raw);
    if (!parsed.success) continue;
    const note = { url: parsed.data.url.trim(), says: parsed.data.says };
    if (!seen.has(note.url) || wordCount(note.says) > PAGE_NOTE_WORDS_MAX || findSecrets(note.says).length > 0) continue;
    says.push(note);
  }
  return { says, dropped: notes.length - says.length };
}
