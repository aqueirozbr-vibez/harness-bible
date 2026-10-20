import { describe, expect, it } from "vitest";

import type { Proposal } from "@/lib/schemas/improve";

import { buildChapter, type BookFiles, type BuiltChapter } from "../build";
import { CH21_FILE, CH21_LAB_DIR, fixture } from "../parse/fixtures";
import { parseLab } from "../parse/lab";
import { applyProposal, type Applied, type EditAnchor } from "./apply";

/*
 * applyProposal on chapter 21 (feature-specs/33 § 4.1, § 11.4, § 14): each change kind applied and proved by
 * re-parsing, a change that would move an unrelated row refused, and each refusal named. No database, no repository.
 */

const CH21 = fixture(CH21_FILE);
const ON = new Date(Date.UTC(2026, 9, 7));

function book(text = CH21): BookFiles {
  return {
    chapters: [{ fileName: CH21_FILE, text, part: "part2" }],
    registry: new Map([[21, { verify: fixture("ch21-verify.md"), redteam: fixture("ch21-redteam.md") }]]),
    labs: new Map([[21, parseLab(CH21_LAB_DIR)]]),
    carries: new Map([[21, "LAB"]]),
    chapterMap: true,
    allFiles: [{ path: `book/part2/${CH21_FILE}`, content: text }],
  };
}

/** Chapter 21 with the book's sixth column, Link, which the fixture's table predates. */
const WITH_LINKS = CH21.replace(/^\| # \| Claim or figure \| Source \| Tier \| Verified \|$/m, "| # | Claim or figure | Source | Tier | Verified | Link |")
  .replace(/^\|---\|---\|---\|---\|---\|$/m, "|---|---|---|---|---|---|")
  .replace(/^(\| \d+ \|.*\|) *$/gm, "$1 — |");

function section(id: string): EditAnchor {
  return { kind: "SECTION", id };
}
function figure(id: string): EditAnchor {
  return { kind: "FIGURE", id };
}
function row(id: string): EditAnchor {
  return { kind: "SOURCE_ROW", id };
}

function rebuilt(applied: Applied): BuiltChapter {
  if ("refused" in applied) throw new Error(`refused: ${applied.refused} ${applied.row} ${applied.detail}`);
  return buildChapter(applied.files.chapters[0], applied.files, { locale: "en", previous: new Map() });
}
function figuresOf(chapter: BuiltChapter): BuiltChapter["sections"][number]["figures"] {
  return chapter.sections.flatMap((s) => s.figures);
}
const BEFORE = buildChapter(book().chapters[0], book(), { locale: "en", previous: new Map() });

/** Chapter 21 with three paragraphs more in 21.4: a zero-padded time, a value another figure's label holds, a piece of a longer number. */
const EXTRA = CH21.replace(/^## 21\.5 Failure$/m, "The run ends at 07:05 (vendor, Temporal documentation).\n\nLatency rose from 120 ms to 150 ms (vendor, Temporal documentation).\n\nA window of 128,000-token prompts fits it (vendor, Temporal documentation).\n\n## 21.5 Failure");
const EXTRA_FIGURES = buildChapter(book(EXTRA).chapters[0], book(EXTRA), { locale: "en", previous: new Map() }).sections[3].figures;
function extra(valueText: string): EditAnchor {
  const found = EXTRA_FIGURES.find((f) => f.valueText === valueText);
  if (found === undefined) throw new Error(`no figure ${valueText} in 21.4`);
  return figure(found.id);
}

describe("applyProposal: each change kind, proved", () => {
  it("EDIT_TEXT rewords a passage of its section and returns the file it touched, whole", () => {
    const applied = applyProposal(book(), section("21.2"), { kind: "EDIT_TEXT", before: "A workflow does no I/O of its own.", after: "A workflow performs no I/O of its own." });
    expect("touched" in applied && applied.touched).toEqual([{ path: `book/part2/${CH21_FILE}`, before: CH21, after: CH21.replace("A workflow does no I/O", "A workflow performs no I/O") }]);
    expect(rebuilt(applied).sections[1].markdownEn).toContain("A workflow performs no I/O of its own.");
    /* the book's other files and the tree's copy of the chapter follow */
    expect("files" in applied && applied.files.allFiles[0].content).toContain("performs no I/O");
  });

  it("EDIT_TEXT in the first layer may change the standfirst", () => {
    const applied = applyProposal(book(), section("21.1"), { kind: "EDIT_TEXT", before: "The maintenance agent reaches step eight", after: "The maintenance agent arrives at step eight" });
    expect(rebuilt(applied).standfirst.startsWith("The maintenance agent arrives at step eight")).toBe(true);
  });

  it("SET_VALUE prints the value in the figure's own shape; the paragraph's other labels may follow it", () => {
    const applied = applyProposal(book(), figure("F-21-17"), { kind: "SET_VALUE", after: "80000", unit: null });
    const after = figuresOf(rebuilt(applied));
    expect(after.find((f) => f.id === "F-21-17")).toMatchObject({ valueText: "80,000", value: 80000, tier: "ILLUSTRATIVE" });
    expect(after.map((f) => f.valueText)).toEqual(figuresOf(BEFORE).map((f) => (f.id === "F-21-17" ? "80,000" : f.valueText)));
  });

  it("ADD_CLAIM at the end of a section, as a paragraph of its own: a figure it adds shifts every later figure's id, which is not a difference (Andre, 2026-10-07)", () => {
    const applied = applyProposal(book(), section("21.1"), { kind: "ADD_CLAIM", text: "The wait costs 14 hours of a running task (illustrative).", placeAfter: "end", fastMoving: false });
    const after = rebuilt(applied);
    expect(after.sections[0].markdownEn.endsWith("\n\nThe wait costs 14 hours of a running task (illustrative).")).toBe(true);
    expect(figuresOf(after)).toHaveLength(figuresOf(BEFORE).length + 1);
    expect(figuresOf(after).find((f) => f.id === "F-21-05")).toMatchObject({ valueText: "14", tier: "ILLUSTRATIVE" });
    /* what was F-21-17 is F-21-18 now, and reads the same */
    expect(figuresOf(after).find((f) => f.id === "F-21-18")?.valueText).toBe("75,000");
  });

  it("SET_VALUE keeps a value's zero padding, groups four digits as the book does, and lets the paragraph's other labels follow (decision 2)", () => {
    expect(figuresOf(rebuilt(applyProposal(book(EXTRA), extra("05"), { kind: "SET_VALUE", after: "9", unit: null }))).some((f) => f.valueText === "09")).toBe(true);
    expect(figuresOf(rebuilt(applyProposal(book(), figure("F-21-15"), { kind: "SET_VALUE", after: "2000", unit: null }))).find((f) => f.id === "F-21-15")?.valueText).toBe("2,000");
    const after = figuresOf(rebuilt(applyProposal(book(EXTRA), extra("120 ms"), { kind: "SET_VALUE", after: "130", unit: "ms" })));
    expect(after.find((f) => f.valueText === "150 ms")?.label).toBe("latency rose from 130 ms to");
  });

  it("ADD_CLAIM after a bold run-in steps past its closing marks, which the reader did not quote", () => {
    const applied = applyProposal(book(), section("21.3"), { kind: "ADD_CLAIM", text: "So do retries.", placeAfter: "Transient failures compound.", fastMoving: false });
    expect(rebuilt(applied).sections[2].markdownEn).toContain("**Transient failures compound.** So do retries.");
  });

  it("ADD_CLAIM after a sentence joins its paragraph", () => {
    const applied = applyProposal(book(), section("21.2"), { kind: "ADD_CLAIM", text: "Nor does it read a clock.", placeAfter: "A workflow does no I/O of its own.", fastMoving: false });
    expect(rebuilt(applied).sections[1].markdownEn).toContain("A workflow does no I/O of its own. Nor does it read a clock.");
  });

  it("EDIT_ROW writes the named cells and the day it was verified as the book writes a month", () => {
    const applied = applyProposal(book(), row("21.9 r4"), { kind: "EDIT_ROW", claim: "Sagas, compensation and their limits", verifiedOn: "2026-10-05" });
    const r4 = rebuilt(applied).sourceRows.find((r) => r.ordinal === 4);
    expect(r4).toMatchObject({ claim: "Sagas, compensation and their limits", citation: 'Garcia-Molina & Salem, "Sagas," SIGMOD 1987', verifiedText: "Oct 2026" });
  });

  it("EDIT_ROW: the decision's day wins over the proposal's own date (37 § 4.1 step 2)", () => {
    const applied = applyProposal(book(), row("21.9 r4"), { kind: "EDIT_ROW", claim: "Sagas", verifiedOn: "2026-10-05" }, { on: new Date(Date.UTC(2026, 10, 3)) });
    expect(rebuilt(applied).sourceRows.find((r) => r.ordinal === 4)?.verifiedText).toBe("Nov 2026");
  });

  it("EDIT_ROW with a DOI writes its doi.org link in the Link column; the decision's day, when given, is the row's", () => {
    const applied = applyProposal(book(WITH_LINKS), row("21.9 r4"), { kind: "EDIT_ROW", doi: "10.1145/38713.38742" }, { on: ON });
    expect(rebuilt(applied).sourceRows.find((r) => r.ordinal === 4)).toMatchObject({ url: "https://doi.org/10.1145/38713.38742", doi: "10.1145/38713.38742", verifiedText: "Oct 2026" });
  });

  it("ADD_ROW after the last row, numbered next, dated by the day given; it may take figures no row read before", () => {
    const applied = applyProposal(book(WITH_LINKS), section("21.3"), { kind: "ADD_ROW", claim: "Illustrative failure rates", citation: "Illustrative assumptions of this chapter", url: "https://example.org/rates", tier: "ILLUSTRATIVE", fastMoving: false }, { on: ON });
    const after = rebuilt(applied);
    expect(after.sourceRows.at(-1)).toMatchObject({ ordinal: 11, claim: "Illustrative failure rates", tier: "ILLUSTRATIVE", url: "https://example.org/rates", verifiedText: "Oct 2026" });
    /* "(illustrative)" was read by no row; now 21.9 r11 */
    expect(figuresOf(after).find((f) => f.id === "F-21-15")?.sourceRowId).toBe("21.9 r11");
  });
});

describe("applyProposal: refusals", () => {
  const refusal = (applied: Applied) => ("refused" in applied ? { refused: applied.refused, row: applied.row } : null);

  it("refuses a change that would move a row the edit does not touch, naming it (unexpected-change)", () => {
    /* r9's citation reworded: the scenario's parentheticals no longer read it, 21.3's chip and four figures of 21.1 would lose their row */
    expect(refusal(applyProposal(book(), row("21.9 r9"), { kind: "EDIT_ROW", citation: "Assumptions of the example" }))).toEqual({ refused: "unexpected-change", row: "21.3" });
    /* r1's citation reworded: no figure reads r1, but 21.2's chips name it (found by the review of part 2) */
    expect(refusal(applyProposal(book(), row("21.9 r1"), { kind: "EDIT_ROW", citation: "Workflow engine manual" }))).toEqual({ refused: "unexpected-change", row: "21.2" });
    /* a tier taken away from the numbers of its sentence */
    expect(refusal(applyProposal(book(), section("21.3"), { kind: "EDIT_TEXT", before: " tasks (illustrative) and", after: " tasks and" }))).toEqual({ refused: "unexpected-change", row: "F-21-15" });
    /* a claim whose parenthetical becomes its paragraph's last, which gives 08:02 another tier: only labels may change there */
    expect(refusal(applyProposal(book(), section("21.1"), { kind: "ADD_CLAIM", text: "The wait costs 14 hours of a running task (illustrative).", placeAfter: "The approval arrives at 08:02 the next morning.", fastMoving: false }))).toEqual({ refused: "unexpected-change", row: "F-21-03" });
  });

  it("refuses as manual what the file has no place for or a function cannot do (Andre, 2026-10-07)", () => {
    expect(refusal(applyProposal(book(), section("21.3"), { kind: "RESTRUCTURE", description: "Split the worked numbers." }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), figure("F-21-06"), { kind: "SET_VALUE", after: "78", unit: "%" }))).toEqual({ refused: "manual", row: "F-21-06" });
    /* a scenario parameter under 21.3's derived tag: its tier is whether derive.py names it, so the value changes with the script */
    expect(refusal(applyProposal(book(), figure("F-21-07"), { kind: "SET_VALUE", after: "6", unit: "%" }))).toEqual({ refused: "manual", row: "F-21-07" });
    expect(refusal(applyProposal(book(), figure("F-21-05"), { kind: "SET_VALUE", after: "3", unit: "s" }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), row("21.9 r4"), { kind: "EDIT_ROW", value: { after: "3", unit: null } }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), row("21.9 r4"), { kind: "EDIT_ROW", claim: "a | b" }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), row("21.9 r4"), { kind: "EDIT_ROW", url: "https://example.org/sagas" }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), section("21.3"), { kind: "ADD_ROW", claim: "c", citation: "d", tier: "VENDOR", fastMoving: false }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), section("21.3"), { kind: "ADD_ROW", claim: "c", citation: "d", tier: { newTier: "hearsay" }, fastMoving: false }, { on: ON }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), section("21.1"), { kind: "ADD_CLAIM", text: "It waits.", placeAfter: "The approval arrives at", fastMoving: false }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), section("21.9"), { kind: "ADD_CLAIM", text: "A claim.", placeAfter: "end", fastMoving: false }))?.refused).toBe("manual");
    /* found by the review of part 2: each would have been written somewhere it does not belong, or refused as a fault */
    expect(refusal(applyProposal(book(), figure("F-21-05"), { kind: "SET_VALUE", after: "5", unit: "%" }))).toEqual({ refused: "manual", row: "F-21-05" });
    expect(refusal(applyProposal(book(), figure("F-21-15"), { kind: "SET_VALUE", after: "50.5", unit: null }))).toEqual({ refused: "manual", row: "F-21-15" });
    expect(refusal(applyProposal(book(EXTRA), extra("128"), { kind: "SET_VALUE", after: "200", unit: null }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), section("21.3"), { kind: "ADD_CLAIM", text: "It is widely used.", placeAfter: "All figures from `derive.", fastMoving: false }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), section("21.2"), { kind: "ADD_CLAIM", text: "So do retries.", placeAfter: "because every result is in the history before the workflow moves on.", fastMoving: false }))).toEqual({ refused: "manual", row: "21.2" });
    expect(refusal(applyProposal(book(), section("21.2"), { kind: "EDIT_TEXT", before: "Timer + signal; no thread held", after: "Timer + signal | no thread held" }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), section("21.2"), { kind: "EDIT_TEXT", before: "A workflow does no I/O of its own.", after: "A workflow does no I/O of its own.\n\n### Replay" }))).toEqual({ refused: "manual", row: "21.2" });
    expect(refusal(applyProposal(book(), section("21.4"), { kind: "ADD_CLAIM", text: "*Lab 21 reproduces on every run of 300 tasks (illustrative).*", placeAfter: "end", fastMoving: false }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(), section("21.4"), { kind: "ADD_CLAIM", text: "[1]: https://example.org/lab21", placeAfter: "end", fastMoving: false }))?.refused).toBe("manual");
    expect(refusal(applyProposal(book(WITH_LINKS), row("21.9 r4"), { kind: "EDIT_ROW", url: "https://en.wikipedia.org/wiki/Saga_(pattern)" }))?.refused).toBe("manual");
    const proseOnly = "# Chapter 21 — Control plane and durable execution\n\n*Part II · No lab · Verified as of September 2026*\n\nOne paragraph.\n";
    expect(refusal(applyProposal(book(proseOnly), section("21.1"), { kind: "ADD_ROW", claim: "c", citation: "d", tier: "VENDOR", fastMoving: false }, { on: ON }))).toEqual({ refused: "manual", row: "21.9" });
  });

  it("refuses what the files do not hold (not-found) and an edit after which the chapter does not parse (does-not-parse)", () => {
    expect(refusal(applyProposal(book(), section("21.2"), { kind: "EDIT_TEXT", before: "a passage the chapter does not have", after: "x" }))?.refused).toBe("not-found");
    expect(refusal(applyProposal(book(), section("21.2"), { kind: "EDIT_TEXT", before: "workflow", after: "flow" }))?.refused).toBe("not-found");
    expect(refusal(applyProposal(book(), figure("F-21-99"), { kind: "SET_VALUE", after: "3", unit: null }))?.refused).toBe("not-found");
    expect(refusal(applyProposal(book(), section("22.1"), { kind: "EDIT_TEXT", before: "a", after: "b" }))?.refused).toBe("not-found");
    expect(refusal(applyProposal(book(WITH_LINKS), section("21.3"), { kind: "ADD_ROW", claim: "c", citation: "d", url: "ftp://files.example/x", tier: "VENDOR", fastMoving: false } as Proposal, { on: ON }))?.refused).toBe("does-not-parse");
    expect(refusal(applyProposal(book(), section("21.2"), { kind: "EDIT_TEXT", before: "A workflow does no I/O of its own.", after: "A workflow does no [I/O](javascript:alert(1)) of its own." }))?.refused).toBe("does-not-parse");
  });
});
