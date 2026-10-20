import { describe, expect, it } from "vitest";

import { figureText, rowText } from "@/lib/improve/anchorText";

import { buildChapter, type BookFiles } from "./build";
import { anchorTextAt, chapterPathOf, deriveFileOf, derivedLabOf, dryRun, labPathOf, reproductionOf } from "./check";
import { applyProposal } from "./edit/apply";
import { CH21_FILE, CH21_LAB_DIR, fixture } from "./parse/fixtures";
import { parseLab } from "./parse/lab";
import { renderHash } from "./renderHash";

/*
 * The chapter's check, the pipeline's half (feature-specs/37 § 4.4; unit 54b), on chapter 21: an anchor read again as
 * the draft recorded it, and the dry run — a tree that builds passes with its chapters' hashes and the bump, one that
 * does not parse fails, and a derived figure the change unlinked fails it while the book's own do not. No disk.
 */

const CH21 = fixture(CH21_FILE);
const LAB = parseLab(CH21_LAB_DIR);

function book(text = CH21): BookFiles {
  return {
    chapters: [{ fileName: CH21_FILE, text, part: "part2" }],
    registry: new Map([[21, { verify: fixture("ch21-verify.md"), redteam: fixture("ch21-redteam.md") }]]),
    labs: new Map([[21, LAB]]),
    carries: new Map([[21, "LAB"]]),
    chapterMap: true,
    allFiles: [{ path: `book/part2/${CH21_FILE}`, content: text }],
  };
}

const MAIN = book();
const BUILT = buildChapter(MAIN.chapters[0], MAIN, { locale: "en", previous: new Map() });

describe("an anchor read again from the book's files (37 § 4.1 step 1)", () => {
  it("reads a section, a figure and a source row as the draft recorded them", () => {
    const section = BUILT.sections.find((candidate) => candidate.id === "21.3");
    expect(anchorTextAt(MAIN, 21, { kind: "SECTION", id: "21.3" })).toBe(section?.markdownEn);
    const figure = BUILT.sections.flatMap((candidate) => candidate.figures).find((candidate) => candidate.valueText === "77%");
    expect(figure).toBeDefined();
    expect(anchorTextAt(MAIN, 21, { kind: "FIGURE", id: figure?.id ?? "" })).toBe(figureText(figure ?? { label: "", valueText: "", unit: null }));
    const row = BUILT.sourceRows[0];
    expect(anchorTextAt(MAIN, 21, { kind: "SOURCE_ROW", id: `21.9 r${String(row.ordinal)}` })).toBe(rowText(row));
  });

  it("reads nothing where there is no such anchor, chapter or parse", () => {
    expect(anchorTextAt(MAIN, 21, { kind: "SECTION", id: "21.12" })).toBeNull();
    expect(anchorTextAt(MAIN, 21, { kind: "SOURCE_ROW", id: "21.9 r99" })).toBeNull();
    expect(anchorTextAt(MAIN, 36, { kind: "SECTION", id: "36.3" })).toBeNull();
    expect(anchorTextAt(book(CH21.replace(/^## 21\.5 Failure$/m, "")), 21, { kind: "SECTION", id: "21.3" })).toBeNull();
  });

  it("names the chapter's file, its lab folder and a derived figure's derive file as the repository does", () => {
    expect(chapterPathOf(MAIN, 21)).toBe(`book/part2/${CH21_FILE}`);
    expect(labPathOf(MAIN, 21)).toBe(`labs/${LAB.folder}`);
    expect([chapterPathOf(MAIN, 36), labPathOf(MAIN, 36)]).toEqual([null, null]);
    const derived = BUILT.sections.flatMap((section) => section.figures).find((figure) => figure.valueText === "77%");
    expect(deriveFileOf(MAIN, 21, derived?.id ?? "")).toBe(`labs/${LAB.folder}/derive.py`);
    const cited = BUILT.sections.flatMap((section) => section.figures).find((figure) => figure.derive === null);
    expect(deriveFileOf(MAIN, 21, cited?.id ?? "")).toBeNull();
  });
});

describe("the dry run (37 § 4.4 part 1)", () => {
  it("fails the tree as it is — nothing to merge, no version to bump — and passes a changed one with each chapter's hash, the lab and the suite", async () => {
    /* a branch whose chapter reads as main's would merge nothing, again and again (unit 54's review): the dry run says so */
    const same = await dryRun(MAIN, MAIN, 21);
    expect(same).toMatchObject({ lint: "FAIL", failure: { reason: "unchanged" }, chapters: [], bump: null });
    expect(same.failure?.detail).toContain("chapter 21");
    const applied = applyProposal(MAIN, { kind: "SECTION", id: "21.3" }, { kind: "EDIT_TEXT", before: "Retries are not optional at eleven steps.", after: "Retries are required at eleven steps." });
    if ("refused" in applied) throw new Error(applied.detail);
    const run = await dryRun(applied.files, MAIN, 21);
    expect(run).toMatchObject({ lint: "PASS", failure: null, chapters: [{ number: 21, hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string }], bump: "patch", lab: { id: LAB.id, folder: LAB.folder }, suite: { reproduced: 1, total: 1, failing: [] } });
    expect(run.treeHash).toMatch(/^[0-9a-f]{40}$/);
    /* the render hash a release of the tree would have, for the id the merge gives it (D1) */
    expect(renderHash(run.chapters, "2026.10")).toBe(renderHash([{ number: 21, hash: run.chapters[0]?.hash ?? "" }], "2026.10"));
  });

  it("passes a wording change applied as the merge applies it, a patch", async () => {
    const applied = applyProposal(MAIN, { kind: "SECTION", id: "21.3" }, { kind: "EDIT_TEXT", before: "Retries are not optional at eleven steps.", after: "Retries are required at eleven steps." });
    if ("refused" in applied) throw new Error(applied.detail);
    const run = await dryRun(applied.files, MAIN, 21);
    expect(run).toMatchObject({ lint: "PASS", bump: "patch" });
    expect(run.chapters[0]?.hash).not.toBe(BUILT.contentHash);
  });

  it("names a minor bump for a sub-heading changed, and a major one for the chapter retitled; a layer of no known title does not parse", async () => {
    const subHeading = CH21.replace("### Workflows and activities", "### Workflows, activities and histories");
    expect((await dryRun(book(subHeading), MAIN, 21)).bump).toBe("minor");
    const retitled = CH21.replace("# Chapter 21 — Control plane and durable execution", "# Chapter 21 — Control plane and durable work");
    expect((await dryRun(book(retitled), MAIN, 21)).bump).toBe("major");
    expect((await dryRun(book(CH21.replace(/^## 21\.3 Worked numbers$/m, "## 21.3 Worked figures")), MAIN, 21)).failure?.reason).toBe("does-not-parse");
  });

  it("fails a tree that does not parse, and one that lost the chapter", async () => {
    const broken = await dryRun(book(CH21.replace(/^## 21\.5 Failure$/m, "")), MAIN, 21);
    expect(broken).toMatchObject({ lint: "FAIL", failure: { reason: "does-not-parse" }, chapters: [] });
    expect(broken.failure?.detail).toContain(CH21_FILE);
    expect((await dryRun(MAIN, MAIN, 36)).failure?.reason).toBe("chapter-missing");
  });

  it("fails a derived figure the change unlinked, naming it, and not the book's own unlinked figures", async () => {
    const run = await dryRun(book(CH21.replace("no failure only 77% of the time", "no failure only 78% of the time")), MAIN, 21);
    expect(run).toMatchObject({ lint: "FAIL", failure: { reason: "unlinked-derived" } });
    expect(run.failure?.detail).toContain("78%");
    /* held to the same tree, the chapter's unlinked figures, if any, are main's too: what fails it is that nothing changed */
    expect((await dryRun(MAIN, MAIN, 21)).failure?.reason).toBe("unchanged");
  });

  it("counts a lab with no derive script as none: it prints no derived figure (chapter 28's)", async () => {
    const scriptless: BookFiles = { ...MAIN, labs: new Map([[21, { ...LAB, files: LAB.files.filter((file) => file.path !== "derive.py") }]]) };
    expect(derivedLabOf(scriptless, 21)).toBeNull();
    expect(derivedLabOf(MAIN, 21)).toEqual({ id: LAB.id, folder: LAB.folder });
    expect((await dryRun(scriptless, scriptless, 21)).lab).toBeNull();
  });

  it("states a lab that did not reproduce in the suite, beside the result", async () => {
    const failing: BookFiles = { ...MAIN, labs: new Map([[21, { ...LAB, ciVerdict: "NOT_REPRODUCED" }]]) };
    expect((await dryRun(failing, MAIN, 21)).suite).toEqual({ reproduced: 0, total: 1, failing: [21] });
  });
});

describe("a lab's run against the figures the branch states (37 § 4.4 part 2)", () => {
  it("reproduces when the run prints what the branch's results hold, whenever it ran", () => {
    expect(reproductionOf(MAIN, 21, { ...LAB.derived, timestamp: "2026-10-09T12:00:00Z" })).toEqual({ figures: [], keys: [] });
  });

  it("names the figure a run no longer prints as the branch states it, and the result that moved", () => {
    const run = reproductionOf(MAIN, 21, { ...LAB.derived, "p_no_failure_13calls_f0.02": 0.78 });
    expect(run.figures).toEqual([expect.objectContaining({ valueText: "77%", key: "p_no_failure_13calls_f0.02" })]);
    expect(run.keys).toEqual([{ key: "p_no_failure_13calls_f0.02", stated: 0.769, printed: 0.78 }]);
  });

  it("names a result the run did not print, and its figures", () => {
    const rest = Object.fromEntries(Object.entries(LAB.derived).filter(([key]) => key !== "p_no_failure_13calls_f0.02"));
    const run = reproductionOf(MAIN, 21, rest);
    expect(run.keys).toEqual([{ key: "p_no_failure_13calls_f0.02", stated: 0.769, printed: null }]);
    expect(run.figures.map((figure) => figure.key)).toContain("p_no_failure_13calls_f0.02");
  });
});
