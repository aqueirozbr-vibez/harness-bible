import { describe, expect, it } from "vitest";

import type { ResearchSection } from "@/lib/db/research";
import type { ReaderFinding } from "@/lib/schemas/researcher";

import { changesNothing, checkNotes, sectionOfAnchor, validate, validateFindings } from "./validate";

/*
 * The validation of findings (feature-specs/41 § 7, § 11.6; unit 58e): one case per row of the table, in its order; a
 * fourth finding dropped and counted; the anchor of a figure or a row found through its section.
 */

const SECTION: ResearchSection = {
  id: "21.3",
  chapter: 21,
  version: "v1.0.0",
  title: "Idempotency keys",
  text: "A retried write without a key is a second write. Keep the key for 24 hours. Keys are compared byte for byte.",
  verifiedOn: new Date("2026-03-04T00:00:00Z"),
  figures: [{ id: "F-21-05", label: "expected work redone", valueText: "45", unit: "%", tier: "ANALYST", fastMoving: true, verifiedOn: null, sourceRow: "21.9 r4" }],
  rows: [{ id: "21.9 r4", claim: "Retry storms after a deploy", citation: "Vendor incident review", url: "https://vendor.example/incident", tier: "VENDOR", verifiedOn: new Date("2026-03-01T00:00:00Z"), fastMoving: true }],
};
const PAGES = ["https://standards.example/keys", "https://forum.example/t/1"];
const PEM_LINE = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
const CONTEXT = { sections: [SECTION], pages: PAGES };

const finding = (over: Partial<ReaderFinding> = {}): ReaderFinding => ({
  anchor: { kind: "SECTION", id: "21.3" },
  changeKind: "ADD_CLAIM",
  proposal: { kind: "ADD_CLAIM", text: "The 2026 revision keeps a key for at least 24 hours after the first response.", placeAfter: "end", fastMoving: true },
  sources: [{ url: "https://standards.example/keys" }],
  note: "The standard's 2026 revision states the window.",
  ...over,
});

describe("validate", () => {
  it("passes a finding anchored in a given section, with a proposal that changes something, sources the call saw and a short note", () => {
    expect(validate(finding(), CONTEXT)).toEqual({ valid: true, sources: ["https://standards.example/keys"] });
    expect(validate(finding({ sources: [{ url: "https://standards.example/keys" }, { url: " https://standards.example/keys " }, { url: "https://forum.example/t/1" }] }), CONTEXT)).toEqual({ valid: true, sources: ["https://standards.example/keys", "https://forum.example/t/1"] });
  });

  it("ANCHOR: a section the reader was not given, an id of another form, a figure of another section", () => {
    expect(validate(finding({ anchor: { kind: "SECTION", id: "22.1" } }), CONTEXT)).toEqual({ valid: false, reason: "ANCHOR" });
    expect(validate(finding({ anchor: { kind: "SECTION", id: "F-21-05" } }), CONTEXT)).toEqual({ valid: false, reason: "ANCHOR" });
    expect(validate(finding({ anchor: { kind: "FIGURE", id: "F-21-99" }, changeKind: "SET_VALUE", proposal: { kind: "SET_VALUE", after: "50", unit: "%" } }), CONTEXT)).toEqual({ valid: false, reason: "ANCHOR" });
    expect(sectionOfAnchor({ kind: "FIGURE", id: "F-21-05" }, [SECTION])?.id).toBe("21.3");
    expect(sectionOfAnchor({ kind: "SOURCE_ROW", id: "21.9 r4" }, [SECTION])?.id).toBe("21.3");
  });

  it("PROPOSAL: a kind the anchor does not take, a proposal of another kind, a passage that does not occur once, an edit that changes a digit", () => {
    expect(validate(finding({ changeKind: "SET_VALUE", proposal: { kind: "SET_VALUE", after: "50", unit: "%" } }), CONTEXT)).toEqual({ valid: false, reason: "PROPOSAL" });
    expect(validate(finding({ changeKind: "EDIT_TEXT", proposal: { kind: "ADD_CLAIM", text: "x", placeAfter: "end", fastMoving: false } }), CONTEXT)).toEqual({ valid: false, reason: "PROPOSAL" });
    expect(validate(finding({ changeKind: "EDIT_TEXT", proposal: { kind: "EDIT_TEXT", before: "write", after: "operation" } }), CONTEXT)).toEqual({ valid: false, reason: "PROPOSAL" });
    expect(validate(finding({ changeKind: "EDIT_TEXT", proposal: { kind: "EDIT_TEXT", before: "Keep the key for 24 hours.", after: "Keep the key for 48 hours." } }), CONTEXT)).toEqual({ valid: false, reason: "PROPOSAL" });
    expect(validate(finding({ changeKind: "EDIT_TEXT", proposal: { kind: "EDIT_TEXT", before: "Keys are compared byte for byte.", after: "Keys are compared byte for byte, case included." } }), CONTEXT)).toEqual({ valid: true, sources: ["https://standards.example/keys"] });
  });

  it("NO_CHANGE: a claim the section already makes, a value the figure already has, a row as it stands", () => {
    expect(validate(finding({ proposal: { kind: "ADD_CLAIM", text: "Keep the key for 24 hours.", placeAfter: "end", fastMoving: false } }), CONTEXT)).toEqual({ valid: false, reason: "NO_CHANGE" });
    expect(validate(finding({ anchor: { kind: "FIGURE", id: "F-21-05" }, changeKind: "SET_VALUE", proposal: { kind: "SET_VALUE", after: "45", unit: "%" } }), CONTEXT)).toEqual({ valid: false, reason: "NO_CHANGE" });
    expect(validate(finding({ anchor: { kind: "FIGURE", id: "F-21-05" }, changeKind: "SET_VALUE", proposal: { kind: "SET_VALUE", after: "50", unit: "%" } }), CONTEXT)).toMatchObject({ valid: true });
    expect(validate(finding({ anchor: { kind: "SOURCE_ROW", id: "21.9 r4" }, changeKind: "EDIT_ROW", proposal: { kind: "EDIT_ROW", verifiedOn: "2026-03-01" } }), CONTEXT)).toEqual({ valid: false, reason: "NO_CHANGE" });
    expect(validate(finding({ anchor: { kind: "SOURCE_ROW", id: "21.9 r4" }, changeKind: "EDIT_ROW", proposal: { kind: "EDIT_ROW", verifiedOn: "2026-10-01" } }), CONTEXT)).toMatchObject({ valid: true });
    expect(validate(finding({ changeKind: "ADD_ROW", proposal: { kind: "ADD_ROW", claim: "Retry storms after a deploy", citation: "Elsewhere", tier: "VENDOR", fastMoving: true } }), CONTEXT)).toEqual({ valid: false, reason: "NO_CHANGE" });
    expect(validate(finding({ changeKind: "ADD_ROW", proposal: { kind: "ADD_ROW", claim: "The 2026 revision's retention window", citation: "Standards body, 2026 revision", url: "https://standards.example/keys", tier: "PRIMARY", fastMoving: true } }), CONTEXT)).toMatchObject({ valid: true });
    expect(changesNothing(finding({ changeKind: "RESTRUCTURE", proposal: { kind: "RESTRUCTURE", description: "Split the section." } }), SECTION)).toBe(false);
  });

  it("SOURCE_NOT_SEEN: an address no block returned or opened, or a plain http one; NO_SOURCE: nothing left", () => {
    expect(validate(finding({ sources: [{ url: "https://unseen.example/retry-safety" }] }), CONTEXT)).toEqual({ valid: false, reason: "SOURCE_NOT_SEEN" });
    expect(validate(finding({ sources: [{ url: "https://standards.example/keys" }, { url: "https://unseen.example/" }] }), CONTEXT)).toEqual({ valid: false, reason: "SOURCE_NOT_SEEN" });
    expect(validate(finding({ sources: [{ url: "http://standards.example/keys" }] }), { sections: [SECTION], pages: ["http://standards.example/keys"] })).toEqual({ valid: false, reason: "SOURCE_NOT_SEEN" });
    expect(validate(finding({ sources: [{ url: "   " }] }), CONTEXT)).toEqual({ valid: false, reason: "NO_SOURCE" });
  });

  it("NOTE: more than 200 words, or a secret by the product's patterns", () => {
    expect(validate(finding({ note: Array.from({ length: 201 }, () => "word").join(" ") }), CONTEXT)).toEqual({ valid: false, reason: "NOTE" });
    expect(validate(finding({ note: `The page held ${PEM_LINE} in a code block.` }), CONTEXT)).toEqual({ valid: false, reason: "NOTE" });
  });

  it("refuses a finding that is not of the guide's shape as PROPOSAL, alone, and keeps the others", () => {
    const shaped = finding();
    const raw: unknown[] = [{ ...shaped, proposal: { kind: "SET_VALUE", after: "45%", unit: null } }, { ...shaped, confidence: 0.9 }, shaped];
    const validated = validateFindings(raw, CONTEXT);
    expect(validated.findings.map((entry) => [entry.ordinal, entry.finding === null ? "unshaped" : "shaped", entry.verdict.valid ? "valid" : entry.verdict.reason])).toEqual([
      [1, "unshaped", "PROPOSAL"],
      [2, "unshaped", "PROPOSAL"],
      [3, "shaped", "valid"],
    ]);
  });

  it("drops a fourth finding and counts it; the first three keep their ordinals and verdicts", () => {
    const four: unknown[] = [finding(), finding({ sources: [{ url: "https://unseen.example/" }] }), finding({ anchor: { kind: "SECTION", id: "22.1" } }), finding()];
    const validated = validateFindings(four, CONTEXT);
    expect(validated.dropped).toBe(1);
    expect(validated.findings.map((entry) => [entry.ordinal, entry.verdict.valid ? "valid" : entry.verdict.reason])).toEqual([
      [1, "valid"],
      [2, "SOURCE_NOT_SEEN"],
      [3, "ANCHOR"],
    ]);
    expect(validateFindings([], CONTEXT)).toEqual({ findings: [], dropped: 0 });
  });
});

describe("checkNotes (feature-specs/48 § 5.5)", () => {
  const PAGES = ["https://standards.example/keys", "https://forum.example/t/4412"];

  it("keeps a note on a page the turn saw, within 60 words and with no secret, and drops and counts every other", () => {
    const kept = { url: "https://standards.example/keys", says: "The 2026 revision keeps a key for at least 24 hours." };
    const notes = [
      kept,
      { url: " https://forum.example/t/4412 ", says: "Engineers describe retry storms after a deploy." },
      /* a page the turn never saw */
      { url: "https://unseen.example/retry-safety", says: "The page says retries are safe." },
      /* more than 60 words */
      { url: "https://standards.example/keys", says: Array.from({ length: 61 }, () => "word").join(" ") },
      /* a secret by the product's patterns */
      { url: "https://standards.example/keys", says: `The page held ${PEM_LINE} in a code block.` },
      /* not the guide's shape */
      { url: "https://standards.example/keys" },
      { url: "https://standards.example/keys", says: "x", extra: true },
      "a sentence",
    ];
    const checked = checkNotes(notes, PAGES);
    expect(checked.says).toEqual([kept, { url: "https://forum.example/t/4412", says: "Engineers describe retry storms after a deploy." }]);
    expect(checked.dropped).toBe(6);
  });

  it("keeps none of none, and drops every note when the turn saw no page", () => {
    expect(checkNotes([], PAGES)).toEqual({ says: [], dropped: 0 });
    expect(checkNotes([{ url: PAGES[0], says: "A note." }], [])).toEqual({ says: [], dropped: 1 });
  });
});
