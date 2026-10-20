import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadGuidePart } from "@/lib/guides/load";
import { ASSISTANT_GUIDE_VERSION } from "@/lib/schemas/assistant";
import { GoldenItemSchema, type GoldenItem } from "@/lib/schemas/golden";
import { GoldenRunItemSchema, GRADER_CRITERIA, type GoldenRunItem } from "@/lib/schemas/goldenRun";
import { LabelSchema, type Label } from "@/lib/schemas/labels";

import { labelsFileName, readLabels } from "./labels";
import { LABELS_MIN } from "./phase2";
import { criteriaOf, labellable, labelTemplate, progressText, showText, unlabelled, type ShowInput } from "./show";

/*
 * The labeller's reading aid (feature-specs/22 § 5, D3): what `npm run gate:show` prints of an answer, what it
 * never prints (the grader's reading), and the labels file it tells the labeller to write.
 */

const RUN_FILE = "golden-run-2026.09-real-20261004T135325Z.jsonl";

const ITEM: GoldenItem = GoldenItemSchema.parse({
  id: "G-0042",
  kind: "figure",
  mode: "explain",
  language: "en",
  context: { chapter: 21, section: "21.3" },
  question: 'In section 21.3, what is the value of "expected work redone"?',
  expected: { citations: [{ sectionId: "21.3", figureId: "F-21-05" }], chapters: [21], sourceRowId: null, valueText: "45%", refusal: null },
  generator: { template: "figure.en", release: "2026.09" },
});

function record(n: number, overrides: Partial<GoldenRunItem> = {}): GoldenRunItem {
  return GoldenRunItemSchema.parse({
    id: `G-${String(n).padStart(4, "0")}`,
    kind: "figure",
    mode: "explain",
    language: "en",
    outcome: "answer",
    refusalCause: null,
    code: null,
    messageId: `m-${String(n)}`,
    traceId: n.toString(16).padStart(32, "0"),
    citedSections: ["21.3"],
    citedFigures: ["F-21-05"],
    expectedHit: true,
    claims: { total: 2, notFound: 0, substituted: 1 },
    verdicts: [{ sensor: "grader", verdict: "FAIL" }],
    grounded: 0.25,
    graderCriteria: { supported: false, precise: false, complete: false, in_scope: true },
    prefixSha256: "a".repeat(64),
    firstTokenMs: 900,
    totalMs: 4000,
    frontier: [],
    smallCalls: 1,
    costUsd: 0.2,
    ledgerSeq: n,
    ...overrides,
  });
}

function label(n: number, overrides: Partial<Label> = {}): Label {
  return LabelSchema.parse({ goldenId: `G-${String(n).padStart(4, "0")}`, runFile: RUN_FILE, messageId: `m-${String(n)}`, grounded: true, criteria: { supported: true, precise: true, complete: true, in_scope: true }, labeller: "andre", labelledAt: "2026-10-05T10:00:00.000Z", ...overrides });
}

function input(overrides: Partial<ShowInput> = {}): ShowInput {
  return {
    item: ITEM,
    record: record(42),
    run: { file: RUN_FILE, grade: "real" },
    answer: {
      conversationId: "c-42",
      text: "expected work redone: 45% (21.3). the book does not cover this",
      guideVersion: "v1.12",
      substituted: 1,
      citations: [{ ordinal: 1, sectionId: "21.3", figureId: "F-21-05", version: "v1.0.0", editionLang: "EN", claimText: "expected work redone: 45% (21.3)." }],
    },
    sections: [{ sectionId: "21.3", title: "Worked numbers", figures: [{ figureId: "F-21-05", label: "expected work redone", valueText: "45%" }] }],
    criteria: { text: "**supported** — every claim follows from the section it cites.", file: "guides/assistant/v1.12/grader.md" },
    labelsFile: "golden/assistant/labels/2026.09.jsonl",
    labeller: "andre",
    labelled: null,
    pageUrl: "http://localhost:3000/en/assistant/c-42",
    now: new Date("2026-10-05T10:00:00.000Z"),
    ...overrides,
  };
}

describe("the grader's criteria, as its own guide states them", () => {
  it("is the guide's section on the four criteria and stops before how to answer", () => {
    const text = criteriaOf(loadGuidePart("assistant", ASSISTANT_GUIDE_VERSION, "grader").prefix);
    expect(text).not.toBeNull();
    for (const name of GRADER_CRITERIA) expect(text).toContain(`**${name}**`);
    expect(text).not.toContain("## ");
    expect(text).not.toContain('"verdict"');
  });

  it("is null for a text without that heading, and reads a CRLF checkout the same", () => {
    expect(criteriaOf("# A guide\n\n## Something else\n\ntext")).toBeNull();
    expect(criteriaOf("# G\r\n\r\n## The four criteria\r\n\r\nthe four\r\n\r\n## How to answer\r\n\r\njson")).toBe("the four");
  });
});

describe("what can be labelled, and what is left", () => {
  const items = [record(1), record(2), record(3, { grounded: null, graderCriteria: null }), record(4, { outcome: "refusal", refusalCause: "R-SCOPE", messageId: "m-4", grounded: null, graderCriteria: null }), record(5, { outcome: "failed", code: "NO_FINAL", messageId: null, grounded: null, graderCriteria: null })];

  it("is an answer the grader graded: a refusal, a failed turn and an ungraded answer pair with no label", () => {
    expect(labellable(items).map((item) => item.id)).toEqual(["G-0001", "G-0002"]);
    expect(unlabelled(items, [label(2)]).map((item) => item.id)).toEqual(["G-0001"]);
    /* A label is of an answer: one that names another run's answer to the same question leaves this one unlabelled. */
    expect(unlabelled(items, [label(1, { messageId: "m-of-another-run" })]).map((item) => item.id)).toEqual(["G-0001", "G-0002"]);
  });

  it("says where the labelling stands against what the gate needs, and what to read next", () => {
    const text = progressText({ file: RUN_FILE, grade: "real", items }, [label(2), label(9, { messageId: "m-of-another-run" })], LABELS_MIN, "golden/assistant/labels/2026.09.jsonl");
    expect(text).toContain(`${RUN_FILE} · real · 5 items, 2 answered and graded`);
    expect(text).toContain(`labelled 1 of the ${String(LABELS_MIN)} the gate needs (golden/assistant/labels/2026.09.jsonl: 2 line(s), 1 of them for another run or an answer this run did not grade)`);
    expect(text).toContain("next to read: G-0001");
    expect(text).toContain("npm run gate:show -- G-0001");
    expect(progressText({ file: RUN_FILE, grade: "real", items }, [label(1), label(2)], LABELS_MIN, "f")).toContain("every graded answer of this run has a label.");
    expect(progressText({ file: "golden-run-2026.09-stub.jsonl", grade: "stub", items: [items[2] ?? record(3)] }, [], LABELS_MIN, "f")).toContain("nothing here can be labelled");
  });
});

describe("the label line to complete", () => {
  it("is refused as printed and accepted once every verdict is written", () => {
    const line = labelTemplate(record(42), RUN_FILE, "curator", new Date("2026-10-05T10:00:00.000Z"));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({ goldenId: "G-0042", runFile: RUN_FILE, messageId: "m-42", grounded: null, labeller: "curator", labelledAt: "2026-10-05T10:00:00.000Z" });
    expect(LabelSchema.safeParse(parsed).success).toBe(false);
    expect(LabelSchema.safeParse({ ...parsed, grounded: false, criteria: { supported: false, precise: true, complete: true, in_scope: true } }).success).toBe(true);
  });
});

describe("one answer, laid out for its labeller", () => {
  it("prints the question, the answer, what it cites as the book prints it, the criteria and the label line", () => {
    const text = showText(input());
    expect(text).toContain(`G-0042 · figure · explain · en · ${RUN_FILE}`);
    expect(text).toContain('In section 21.3, what is the value of "expected work redone"?');
    expect(text).toContain("asked from chapter 21, section 21.3");
    expect(text).toContain("the golden label expects: 21.3 F-21-05 · printed as 45%");
    expect(text).toContain("the answer · message m-42");
    expect(text).toContain("  expected work redone: 45% (21.3). the book does not cover this");
    expect(text).toContain("(1 claim(s) were replaced by the citation sensor");
    expect(text).toContain("1. 21.3 F-21-05 · Worked numbers · v1.0.0 EN");
    expect(text).toContain('the book prints F-21-05 "expected work redone" as 45%');
    expect(text).toContain("the four criteria (guides/assistant/v1.12/grader.md)");
    expect(text).toContain("  **supported** — every claim follows from the section it cites.");
    expect(text).toContain("one line of golden/assistant/labels/2026.09.jsonl, with true or false in place of each null:");
    expect(text).toContain('"goldenId":"G-0042"');
    expect(text).toContain("http://localhost:3000/en/assistant/c-42");
  });

  it("never prints the grader's reading: not its score, not a verdict, not which criteria it failed", () => {
    /* The record holds a score of 0.25 and a FAIL on three criteria; a labeller who saw them would copy them. */
    const text = showText(input());
    expect(text).not.toContain("0.25");
    expect(text).not.toMatch(/\bFAIL\b|\bPASS\b/);
    expect(text).not.toMatch(/grounded["']?\s*[:=]\s*(0|1|true|false)/);
    expect(text).not.toContain('"supported":false');
  });

  it("says when a cited section or figure is not what the release holds", () => {
    const text = showText(input({ sections: [{ sectionId: "21.3", title: "Worked numbers", figures: [] }], answer: { ...(input().answer ?? { conversationId: "", text: "", guideVersion: null, substituted: 0, citations: [] }), citations: [{ ordinal: 1, sectionId: "21.3", figureId: "F-21-99", version: "v1.0.0", editionLang: "EN", claimText: null }, { ordinal: 2, sectionId: "99.1", figureId: null, version: "v1.0.0", editionLang: "EN", claimText: "x" }] } }));
    expect(text).toContain("F-21-99 is not a figure of that section in this release");
    expect(text).toContain("2. 99.1 · not a section of this release");
  });

  it("has nothing to label for a refusal or a failed turn", () => {
    const refused = showText(input({ record: record(42, { outcome: "refusal", refusalCause: "R-UNVERIFIED", grounded: null, graderCriteria: null }) }));
    expect(refused).toContain("refused · R-UNVERIFIED");
    expect(refused).toContain("nothing to label");
    expect(refused).not.toContain('"goldenId"');
    expect(showText(input({ record: record(42, { outcome: "failed", code: "BUDGET_EXCEEDED", messageId: null, grounded: null, graderCriteria: null }) }))).toContain("failed · BUDGET_EXCEEDED");
  });

  it("says why an answer cannot be read: its row is elsewhere, or its text was purged", () => {
    expect(showText(input({ answer: null }))).toContain("is not in this database");
    const purged = showText(input({ answer: { conversationId: "c-42", text: null, guideVersion: "v1.12", substituted: 0, citations: [] } }));
    expect(purged).toContain("the purge removes an answer's text after 30 days");
    expect(purged).not.toContain('"goldenId"');
  });

  it("warns before a label that would measure nothing or count twice", () => {
    expect(showText(input({ run: { file: "golden-run-2026.09-stub.jsonl", grade: "stub" }, record: record(42, { grounded: null, graderCriteria: null }) }))).toMatch(/the grader did not grade this answer[\s\S]*this is a stub answer/);
    expect(showText(input({ labelled: label(42) }))).toContain("already labelled by andre at 2026-10-05T10:00:00.000Z");
    expect(showText(input({ criteria: null }))).toContain("the grader's guide of v1.12 is not in guides/");
  });
});

describe("the labels file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-labels-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is empty when nobody has labelled yet", () => {
    expect(readLabels(dir, "2026.09")).toEqual([]);
  });

  it("reads one label a line and skips blank ones", () => {
    writeFileSync(join(dir, labelsFileName("2026.09")), `${JSON.stringify(label(1))}\n\n${JSON.stringify(label(2, { grounded: false }))}\n`);
    expect(readLabels(dir, "2026.09")).toEqual([label(1), label(2, { grounded: false })]);
  });

  it("stops at a line that is not a label and names it, instead of counting one label fewer", () => {
    const template = labelTemplate(record(3), RUN_FILE, "andre", new Date("2026-10-05T10:00:00.000Z"));
    writeFileSync(join(dir, labelsFileName("2026.10")), `${JSON.stringify(label(1))}\n${template}\n`);
    expect(() => readLabels(dir, "2026.10")).toThrow(/2026\.10\.jsonl:2 is not a label: grounded/);
    writeFileSync(join(dir, labelsFileName("2026.11")), "{not json\n");
    expect(() => readLabels(dir, "2026.11")).toThrow("2026.11.jsonl:1 is not JSON");
  });
});
