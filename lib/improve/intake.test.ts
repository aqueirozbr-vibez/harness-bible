import { describe, expect, it } from "vitest";

import type { ResolvedAnchor } from "@/lib/db/anchors";
import type { SuggestionForService } from "@/lib/db/improve";

import { intakeFactsOf } from "./intake";

type Anchor = NonNullable<SuggestionForService["anchor"]>;

const SECTION = { kind: "SECTION", sectionAnchor: "21.3", figureAnchor: null, sourceRowAnchor: null, contentSha256: "a".repeat(64), currentText: "Retries are not optional at eleven steps." } as unknown as Anchor;
const FIGURE = { ...SECTION, kind: "FIGURE", figureAnchor: "F-21-02" } as unknown as Anchor;
const ROW = {
  changeKind: "EDIT_TEXT",
  proposal: { kind: "EDIT_TEXT", before: "not optional", after: "required" },
  chapterNumber: 21,
  rationale: "Because.",
  origin: "HUMAN",
  evidence: [{ id: "i", ordinal: 1, kind: "LINK", state: "GRADED", url: "https://x.example/", doi: null, storageKey: null, labRunId: null, tier: "C", host: "x.example" }],
} as unknown as Parameters<typeof intakeFactsOf>[0];
const RESOLVED = { contentSha256: "b".repeat(64), currentText: "Retries are required.", figures: [{ id: "F-21-02" }] } as unknown as ResolvedAnchor;

describe("intakeFactsOf", () => {
  it("reads a section resolved at the release: its text and figures now, the version it was resolved at", () => {
    const facts = intakeFactsOf(ROW, SECTION, RESOLVED, { version: "v1.3.2" }, true);
    expect(facts.schema).toEqual({ changeKind: "EDIT_TEXT", anchorKind: "SECTION", proposal: ROW.proposal, section: { id: "21.3", sourceText: "Retries are required.", figures: [{ id: "F-21-02" }] } });
    expect(facts.anchor).toEqual({
      anchor: { kind: "SECTION", sectionAnchor: "21.3", figureAnchor: null, sourceRowAnchor: null, contentSha256: "a".repeat(64), currentText: "Retries are not optional at eleven steps." },
      chapter: { number: 21, version: "v1.3.2" },
      now: { contentSha256: "b".repeat(64), currentText: "Retries are required." },
    });
    /* An item as the sensor reads it, and nothing else of the row. */
    expect(facts.evidence).toEqual({ requireGraded: true, items: [{ ordinal: 1, kind: "LINK", state: "GRADED", url: "https://x.example/", doi: null, storageKey: null, labRunId: null }] });
    expect(facts.rationale).toEqual({ rationale: "Because.", origin: "HUMAN" });
  });

  it("reads a section no longer at the release from what the draft stored, and a figure without a section's text", () => {
    const gone = intakeFactsOf(ROW, SECTION, null, null, false);
    /* The workflow's step 2 leaves the grading to step 3. */
    expect(gone.evidence.requireGraded).toBe(false);
    expect(gone.schema.section).toEqual({ id: "21.3", sourceText: "Retries are not optional at eleven steps.", figures: [] });
    expect(gone.anchor.now).toBeNull();
    expect(gone.anchor.chapter).toEqual({ number: 21, version: "?" });
    expect(intakeFactsOf(ROW, FIGURE, RESOLVED, { version: "v1.3.2" }, true).schema.section).toBeNull();
  });
});
