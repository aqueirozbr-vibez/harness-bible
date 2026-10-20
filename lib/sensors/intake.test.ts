import { describe, expect, it } from "vitest";

import { occurrences } from "@/lib/improve/passage";
import { CHANGE_KINDS, EVIDENCE_KINDS } from "@/lib/schemas/improve";

import { anchorExistsSensor, evidenceParsesSensor, intakeSensors, rationaleLengthSensor, schemaSensor, type AnchorFacts, type EvidenceFacts, type SchemaFacts } from "./intake";

/*
 * The four intake sensors (feature-specs/31 § 5, § 10.3): one passing and every failing case of the table, as
 * pure functions on rows. The sentences are what a curator reads on the Sensors table; the data is the same facts.
 */

const SECTION: NonNullable<SchemaFacts["section"]> = {
  id: "21.3",
  sourceText: "**Transient failures compound.** The P-101 task makes thirteen model or tool calls. If each has a 2% chance of a transient failure, the task completes with no failure only 77% of the time; at 5%, 51%. Retries are not optional at eleven steps. Retries are not optional.",
  figures: [
    { id: "F-21-04", valueText: "2%" },
    { id: "F-21-05", valueText: "77%" },
    { id: "F-21-06", valueText: "51%" },
  ],
};

const schema = (over: Partial<SchemaFacts>): SchemaFacts => ({ changeKind: "EDIT_TEXT", anchorKind: "SECTION", proposal: { kind: "EDIT_TEXT", before: "thirteen model or tool calls", after: "thirteen calls to a model or a tool" }, section: SECTION, ...over });

describe("SCHEMA", () => {
  it("passes a text edit whose passage is in the section once, with no figure in it and no digit changed", () => {
    expect(schemaSensor(schema({}))).toEqual({ sensor: "SCHEMA", result: "PASS", detail: "parses as EDIT_TEXT on a section", data: { kind: "EDIT_TEXT" } });
  });

  it("passes every other kind on its own anchor", () => {
    expect(schemaSensor(schema({ changeKind: "SET_VALUE", anchorKind: "FIGURE", proposal: { kind: "SET_VALUE", after: "4", unit: null }, section: null })).result).toBe("PASS");
    expect(schemaSensor(schema({ changeKind: "EDIT_ROW", anchorKind: "SOURCE_ROW", proposal: { kind: "EDIT_ROW", citation: "Vendor docs, 2026" }, section: null })).result).toBe("PASS");
    expect(schemaSensor(schema({ changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "A fourth retry costs more than it saves.", placeAfter: "Retries are not optional at eleven steps.", fastMoving: false } })).result).toBe("PASS");
    expect(schemaSensor(schema({ changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "A fourth retry costs more than it saves.", placeAfter: "end", fastMoving: false } })).result).toBe("PASS");
    expect(schemaSensor(schema({ changeKind: "ADD_ROW", proposal: { kind: "ADD_ROW", claim: "x", citation: "y", tier: "PRIMARY", fastMoving: false } })).result).toBe("PASS");
    expect(schemaSensor(schema({ changeKind: "RESTRUCTURE", proposal: { kind: "RESTRUCTURE", description: "Split at the second heading." } })).result).toBe("PASS");
  });

  it("fails a change kind the anchor's kind does not take, naming the one it takes", () => {
    const verdict = schemaSensor(schema({ changeKind: "SET_VALUE", anchorKind: "SECTION", proposal: { kind: "SET_VALUE", after: "4", unit: null } }));
    expect(verdict).toEqual({ sensor: "SCHEMA", result: "FAIL", detail: "SET_VALUE is made on a figure, not on a section", data: { field: "changeKind", allowed: "FIGURE", anchorKind: "SECTION" } });
    for (const changeKind of CHANGE_KINDS) {
      expect(schemaSensor(schema({ changeKind, anchorKind: changeKind === "SET_VALUE" ? "SOURCE_ROW" : "FIGURE", proposal: null })).result, changeKind).toBe("FAIL");
    }
  });

  it("fails a draft with no proposal, and a proposal that does not parse, naming the field", () => {
    expect(schemaSensor(schema({ proposal: null }))).toMatchObject({ result: "FAIL", detail: "no proposal was written", data: { field: "proposal" } });
    expect(schemaSensor(schema({ proposal: { kind: "EDIT_TEXT", before: "", after: "x" } }))).toMatchObject({ result: "FAIL", data: { field: "before" } });
    expect(schemaSensor(schema({ proposal: { kind: "EDIT_TEXT", before: "a" } }))).toMatchObject({ result: "FAIL", data: { field: "after" } });
    expect(schemaSensor(schema({ proposal: { kind: "NOTHING" } }))).toMatchObject({ result: "FAIL", data: { field: "kind" } });
    expect(schemaSensor(schema({ proposal: "a string" }))).toMatchObject({ result: "FAIL", data: { field: "proposal" } });
  });

  it("fails a proposal of another kind than the draft's", () => {
    expect(schemaSensor(schema({ proposal: { kind: "RESTRUCTURE", description: "x" } }))).toMatchObject({ result: "FAIL", detail: "the proposal is a RESTRUCTURE; the draft is a EDIT_TEXT", data: { field: "proposal.kind", changeKind: "EDIT_TEXT", proposalKind: "RESTRUCTURE" } });
  });

  it("fails a passage that is not in the section, or is there twice, for a text edit and for a claim's place", () => {
    expect(schemaSensor(schema({ proposal: { kind: "EDIT_TEXT", before: "fourteen calls", after: "fifteen calls" } }))).toMatchObject({ result: "FAIL", detail: "before: the passage occurs 0 times in 21.3; it must occur once", data: { field: "before", occurrences: 0, section: "21.3" } });
    expect(schemaSensor(schema({ proposal: { kind: "EDIT_TEXT", before: "Retries are not optional", after: "Retries are required" } }))).toMatchObject({ result: "FAIL", data: { field: "before", occurrences: 2 } });
    expect(schemaSensor(schema({ changeKind: "ADD_CLAIM", proposal: { kind: "ADD_CLAIM", text: "x", placeAfter: "not in the section", fastMoving: false } }))).toMatchObject({ result: "FAIL", data: { field: "placeAfter", occurrences: 0 } });
    expect(schemaSensor(schema({ section: null }))).toMatchObject({ result: "FAIL", detail: "EDIT_TEXT needs the section's text", data: { field: "section" } });
  });

  it("fails a text edit whose passage overlaps a figure, naming the figure to anchor instead (D2)", () => {
    expect(schemaSensor(schema({ proposal: { kind: "EDIT_TEXT", before: "no failure only 77% of the time", after: "no failure in only 77% of runs" } }))).toMatchObject({ result: "FAIL", detail: "before: overlaps figure F-21-05; anchor the figure instead", data: { field: "before", figure: "F-21-05" } });
  });

  it("fails a text edit that changes a digit, naming the figure when the new number is one of the section's", () => {
    expect(schemaSensor(schema({ proposal: { kind: "EDIT_TEXT", before: "thirteen model or tool calls", after: "14 model or tool calls" } }))).toMatchObject({ result: "FAIL", detail: "after: changes a digit; a number is changed by anchoring its figure", data: { field: "after", figure: null } });
    expect(schemaSensor(schema({ proposal: { kind: "EDIT_TEXT", before: "thirteen model or tool calls", after: "calls that fail 51% of the time" } }))).toMatchObject({ result: "FAIL", detail: "after: changes a digit; anchor figure F-21-06 instead", data: { field: "after", figure: "F-21-06" } });
    /* The same digits in another order are the same digits: not a change of a number, and a wording the sensor lets through. */
    expect(schemaSensor(schema({ proposal: { kind: "EDIT_TEXT", before: "Retries are not optional at eleven steps.", after: "At eleven steps, retries are not optional." } })).result).toBe("PASS");
  });

  it("fails a text edit that changes nothing", () => {
    expect(schemaSensor(schema({ proposal: { kind: "EDIT_TEXT", before: "thirteen model or tool calls", after: "thirteen model or tool calls" } }))).toMatchObject({ result: "FAIL", detail: "after: is the same as before", data: { field: "after" } });
  });

  it("counts a passage's occurrences without overlap", () => {
    expect(occurrences("aaaa", "aa")).toBe(2);
    expect(occurrences("abc", "")).toBe(0);
    expect(occurrences("abc", "d")).toBe(0);
    expect(occurrences("a.b a.b", "a.b")).toBe(2);
  });
});

describe("ANCHOR_EXISTS", () => {
  const anchor: AnchorFacts["anchor"] = { kind: "FIGURE", sectionAnchor: "23.3", figureAnchor: "F-23-06", sourceRowAnchor: null, contentSha256: "a".repeat(64), currentText: "routing savings · 2.4×" };
  const chapter = { number: 23, version: "1.4.1" };

  it("passes an anchor that is in the release with the text the draft recorded, and says where", () => {
    expect(anchorExistsSensor({ anchor, chapter, now: { contentSha256: "a".repeat(64), currentText: "routing savings · 2.4×" } })).toEqual({ sensor: "ANCHOR_EXISTS", result: "PASS", detail: "F-23-06 at ch23 v1.4.1", data: { anchor: "F-23-06", chapter: 23, version: "1.4.1", exists: true } });
  });

  it("fails an anchor the release has not, in the Components screen's words", () => {
    expect(anchorExistsSensor({ anchor: { ...anchor, figureAnchor: "F-23-07" }, chapter, now: null })).toEqual({ sensor: "ANCHOR_EXISTS", result: "FAIL", detail: "F-23-07 does not exist at ch23 v1.4.1", data: { anchor: "F-23-07", chapter: 23, version: "1.4.1", exists: false } });
  });

  it("fails an anchor whose text changed in a later release, and says what it reads now", () => {
    const verdict = anchorExistsSensor({ anchor, chapter: { number: 23, version: "1.5.0" }, now: { contentSha256: "b".repeat(64), currentText: "routing savings · 1.9×" } });
    expect(verdict).toEqual({ sensor: "ANCHOR_EXISTS", result: "FAIL", detail: "F-23-06 changed since the draft at ch23 v1.5.0", data: { anchor: "F-23-06", chapter: 23, version: "1.5.0", exists: true, was: "routing savings · 2.4×", now: "routing savings · 1.9×" } });
  });

  it("names a section and a row by their own ids, with the chapter's two digits", () => {
    expect(anchorExistsSensor({ anchor: { kind: "SECTION", sectionAnchor: "01.2", figureAnchor: null, sourceRowAnchor: null, contentSha256: "a".repeat(64), currentText: "x" }, chapter: { number: 1, version: "1.0.0" }, now: null }).detail).toBe("01.2 does not exist at ch01 v1.0.0");
    expect(anchorExistsSensor({ anchor: { kind: "SOURCE_ROW", sectionAnchor: "21.9", figureAnchor: null, sourceRowAnchor: "21.9 r4", contentSha256: "a".repeat(64), currentText: "x" }, chapter: { number: 21, version: "1.4.1" }, now: { contentSha256: "a".repeat(64), currentText: "x" } }).detail).toBe("21.9 r4 at ch21 v1.4.1");
  });

  it("prints one v when the release's version already carries it", () => {
    expect(anchorExistsSensor({ anchor: { kind: "SECTION", sectionAnchor: "22.3", figureAnchor: null, sourceRowAnchor: null, contentSha256: "a".repeat(64), currentText: "x" }, chapter: { number: 22, version: "v1.0.0" }, now: { contentSha256: "a".repeat(64), currentText: "x" } }).detail).toBe("22.3 at ch22 v1.0.0");
  });
});

describe("EVIDENCE_PARSES", () => {
  const item = (ordinal: number, over: Partial<EvidenceFacts["items"][number]> = {}): EvidenceFacts["items"][number] => ({ ordinal, kind: "LINK", state: "GRADED", url: "https://provider-two.example/pricing", doi: null, storageKey: null, labRunId: null, ...over });

  it("passes one or more items, each with what its kind needs and graded, whatever its tier", () => {
    expect(evidenceParsesSensor({ requireGraded: true, items: [item(1)] })).toEqual({ sensor: "EVIDENCE_PARSES", result: "PASS", detail: "1 item, each graded", data: { items: 1 } });
    expect(evidenceParsesSensor({ requireGraded: true, items: [item(1), item(2, { kind: "DOI", url: null, doi: "10.1000/182" }), item(3, { kind: "UPLOAD", url: null, storageKey: "uploads/x.pdf" }), item(4, { kind: "LAB_RUN", url: null, labRunId: "run-1" })] })).toMatchObject({ result: "PASS", detail: "4 items, each graded" });
  });

  it("fails with no item", () => {
    expect(evidenceParsesSensor({ requireGraded: true, items: [] })).toEqual({ sensor: "EVIDENCE_PARSES", result: "FAIL", detail: "no evidence item; a suggestion carries at least one", data: { items: 0 } });
  });

  it("fails an item that lacks what its kind needs, naming the item and the lack, in the items' order", () => {
    for (const kind of EVIDENCE_KINDS) {
      const bare = item(2, { kind, url: null, doi: null, storageKey: null, labRunId: null });
      const verdict = evidenceParsesSensor({ requireGraded: true, items: [bare, item(1)] });
      expect(verdict.result, kind).toBe("FAIL");
      expect(verdict.data, kind).toMatchObject({ item: 2, kind });
      expect(verdict.detail, kind).toMatch(/^item 2: a [A-Z_]+ needs /);
    }
    expect(evidenceParsesSensor({ requireGraded: true, items: [item(1, { url: null })] }).detail).toBe("item 1: a LINK needs a url");
  });

  it("leaves an item not yet through the fetcher to the workflow's step 3 where grading is not required now, and still asks every item for what its kind needs (Andre, 2026-10-07)", () => {
    expect(evidenceParsesSensor({ requireGraded: false, items: [item(1), item(2, { state: "PENDING" })] })).toEqual({ sensor: "EVIDENCE_PARSES", result: "PASS", detail: "2 items, each with what its kind needs", data: { items: 2 } });
    expect(evidenceParsesSensor({ requireGraded: false, items: [item(1, { state: "PENDING", url: null })] }).detail).toBe("item 1: a LINK needs a url");
    expect(evidenceParsesSensor({ requireGraded: false, items: [] }).result).toBe("FAIL");
  });

  it("fails an item the fetcher has not been through", () => {
    expect(evidenceParsesSensor({ requireGraded: true, items: [item(1), item(2, { state: "PENDING" })] })).toEqual({ sensor: "EVIDENCE_PARSES", result: "FAIL", detail: "item 2: not through the fetcher yet (PENDING)", data: { item: 2, kind: "LINK", lacks: "grading", state: "PENDING" } });
  });
});

describe("RATIONALE_LENGTH", () => {
  const words = (n: number): string => Array.from({ length: n }, (_, index) => `w${String(index)}`).join(" ");

  it("passes a person's rationale of 1 to 200 words, and a researcher's note of 0 to 200", () => {
    expect(rationaleLengthSensor({ rationale: "One.", origin: "HUMAN" })).toEqual({ sensor: "RATIONALE_LENGTH", result: "PASS", detail: "1 words", data: { words: 1, least: 1, most: 200 } });
    expect(rationaleLengthSensor({ rationale: words(200), origin: "HUMAN" }).result).toBe("PASS");
    expect(rationaleLengthSensor({ rationale: null, origin: "RESEARCHER" })).toMatchObject({ result: "PASS", data: { words: 0, least: 0, most: 200 } });
    expect(rationaleLengthSensor({ rationale: words(200), origin: "RESEARCHER" }).result).toBe("PASS");
  });

  it("fails a person's rationale of no words, and anyone's of 201", () => {
    expect(rationaleLengthSensor({ rationale: null, origin: "HUMAN" })).toEqual({ sensor: "RATIONALE_LENGTH", result: "FAIL", detail: "0 words; a rationale is 1 to 200", data: { words: 0, least: 1, most: 200 } });
    expect(rationaleLengthSensor({ rationale: "   ", origin: "HUMAN" }).result).toBe("FAIL");
    expect(rationaleLengthSensor({ rationale: words(201), origin: "HUMAN" })).toEqual({ sensor: "RATIONALE_LENGTH", result: "FAIL", detail: "201 words; at most 200", data: { words: 201, least: 1, most: 200 } });
    expect(rationaleLengthSensor({ rationale: words(201), origin: "RESEARCHER" }).result).toBe("FAIL");
  });
});

describe("intakeSensors", () => {
  it("runs the four in the spec's order and reads no database", () => {
    const verdicts = intakeSensors({
      schema: schema({}),
      anchor: { anchor: { kind: "SECTION", sectionAnchor: "21.3", figureAnchor: null, sourceRowAnchor: null, contentSha256: "a".repeat(64), currentText: SECTION.sourceText }, chapter: { number: 21, version: "1.4.1" }, now: { contentSha256: "a".repeat(64), currentText: SECTION.sourceText } },
      evidence: { requireGraded: true, items: [{ ordinal: 1, kind: "LINK", state: "GRADED", url: "https://x.example/", doi: null, storageKey: null, labRunId: null }] },
      rationale: { rationale: "The release raised the cap.", origin: "HUMAN" },
    });
    expect(verdicts.map((verdict) => [verdict.sensor, verdict.result])).toEqual([
      ["SCHEMA", "PASS"],
      ["ANCHOR_EXISTS", "PASS"],
      ["EVIDENCE_PARSES", "PASS"],
      ["RATIONALE_LENGTH", "PASS"],
    ]);
  });
});
