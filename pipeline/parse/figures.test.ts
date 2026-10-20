import { describe, expect, it } from "vitest";

import { bodyVocabularyViolations } from "@/lib/schemas/chapter";

import { buildChapter, EN_LABELS, type BookFiles } from "../build";
import { CITE_SOURCE, declaredDefault, figurePass, NUM_SOURCE, parseValue, tiersOf } from "./figures";
import { CH21_FILE, CH21_LAB_DIR, fixture } from "./fixtures";
import { deriveSource, parseLab } from "./lab";

/* The linter's regexes, ported verbatim: the same corpus must match the same way. */
describe("CITE and NUM", () => {
  const cite = new RegExp(CITE_SOURCE, "i");
  const num = new RegExp(NUM_SOURCE);
  const corpus: ReadonlyArray<[string, boolean, boolean]> = [
    ["(scenario, ch16)", true, false],
    ["(ch16, ch22 scenario)", true, false],
    ["(illustrative)", true, false],
    ["(illustrative rate; arithmetic derived)", true, false],
    ["(vendor, Temporal docs, verified Sep 2026)", true, true],
    ["(Garcia-Molina & Salem 1987)", true, true],
    ["(compacted)", false, false],
    ["(see below)", false, false],
    ["a 2% chance", false, true],
    ["7,500 tokens per step", false, true],
    ["0.4% per step", false, true],
    ["about 75,000 extra tokens", false, true],
    ["1 s interval", false, true],
    ["$0.05 per vCPU-hour", false, true],
    ["version v1.2 of the SDK", false, false],
    ["at step 7.", false, true],
    ["P-101 work order", false, false],
    ["a 100-step runaway plan", false, false],
    ["thirteen model or tool calls", false, false],
    ["12-Factor Agents", false, false],
    ["30 seconds, sixty-one in total", false, true],
    ["3× the baseline", false, true],
    ["2 GB of memory", false, true],
    ["file derive.py line 14", false, true],
    ["ISO 27001", false, true],
    ["error 0xC0E9", false, false],
    ["step k of 11", false, true],
    ["14 h 20 m", false, true],
    ["one crash per 500 tasks", false, true],
    ["2_000 queries", false, false],
  ];
  it.each(corpus)("%s → cite %s, num %s", (line, hasCite, hasNum) => {
    expect(cite.test(line)).toBe(hasCite);
    expect(num.test(line)).toBe(hasNum);
  });
});

describe("tier words", () => {
  it("reads tiers in order and treats a bare year as primary", () => {
    expect(tiersOf("(illustrative rate; arithmetic derived)")).toEqual([
      { tier: "ILLUSTRATIVE", scenario: false },
      { tier: "DERIVED", scenario: false },
    ]);
    expect(tiersOf("(scenario, ch16)")).toEqual([{ tier: "ILLUSTRATIVE", scenario: true }]);
    expect(tiersOf("(Garcia-Molina & Salem 1987)")).toEqual([{ tier: "PRIMARY", scenario: false }]);
    expect(tiersOf("(compacted)")).toEqual([]);
  });

  it("recognises the section declaration paragraph", () => {
    expect(declaredDefault("All figures from `derive.py` (derived).")).toEqual({ tier: "DERIVED", scenario: false });
    expect(declaredDefault("All figures are illustrative (illustrative) except 3 (vendor).")).toBeNull();
    expect(declaredDefault("The task makes 13 calls (scenario).")).toBeNull();
  });

  it("parses values and units", () => {
    expect(parseValue("0.4%")).toEqual({ value: 0.4, unit: "%" });
    expect(parseValue("7,500")).toEqual({ value: 7500, unit: null });
    expect(parseValue("1 s")).toEqual({ value: 1, unit: "s" });
    expect(parseValue("$0.05")).toEqual({ value: 0.05, unit: "USD" });
    expect(parseValue("3×")).toEqual({ value: 3, unit: "×" });
  });
});

function book(): BookFiles {
  const lab = parseLab(CH21_LAB_DIR);
  return {
    chapters: [{ fileName: CH21_FILE, text: fixture(CH21_FILE), part: "part2" }],
    registry: new Map([[21, { verify: fixture("ch21-verify.md"), redteam: fixture("ch21-redteam.md") }]]),
    labs: new Map([[21, lab]]),
    carries: new Map([[21, "LAB"]]),
    chapterMap: true,
    allFiles: [],
  };
}

describe("figurePass on a paragraph", () => {
  const derive = deriveSource(parseLab(CH21_LAB_DIR));
  const ctx = { chapter: 21, startOrdinal: 1, sectionDefault: null, derive, sourceRows: [{ id: "21.9 r1", ordinal: 1, tokens: ["temporal"] }], labels: EN_LABELS };

  it("gives a number the tier of its sentence's parenthetical and cites the source row", () => {
    const out = figurePass("Temporal starts at a 1 s interval with a backoff coefficient of 2.0 (vendor, Temporal documentation).", ctx);
    expect(out.figures.map((f) => [f.valueText, f.tier, f.sourceRowId])).toEqual([
      ["1 s", "VENDOR", "21.9 r1"],
      ["2.0", "VENDOR", "21.9 r1"],
    ]);
    expect(out.html).toContain('<span class="chip t-ven"><i>ven</i> vendor · 21.9 r1</span>');
    expect(out.html).toContain('data-figure="F-21-01">1 s</span>');
    expect(out.unmatchedSources).toEqual([]);
  });

  it("links a derived number to derive.py and drops the parenthetical", () => {
    const out = figurePass("The expected work redone is 45% of the task (derived).", ctx);
    expect(out.figures).toHaveLength(1);
    expect(out.figures[0].tier).toBe("DERIVED");
    expect(out.figures[0].derive?.key).toBe("expected_redo_fraction_no_checkpoint");
    expect(out.figures[0].derive?.line).toBe(14);
    expect(out.html).toContain('<a class="derive" href="/en/labs/lab-21/derive.py#L14"');
    expect(out.html).not.toContain("(derived)");
  });

  it("marks an unmatched derived number OPEN and reports it", () => {
    const out = figurePass("The lab shows 12,345 of them (derived).", ctx);
    expect(out.figures[0].tier).toBe("OPEN");
    expect(out.unlinked).toEqual([{ label: "the lab shows", valueText: "12,345", candidates: [] }]);
    expect(out.html).toContain('class="chip t-opn"');
  });

  it("falls back to the other tier of a mixed parenthetical", () => {
    const out = figurePass("If 2% of writes are retried, twenty duplicates follow (illustrative rate; arithmetic derived).", ctx);
    expect(out.figures.map((f) => [f.valueText, f.tier])).toEqual([["2%", "ILLUSTRATIVE"]]);
    expect(out.unlinked).toEqual([]);
  });

  it("keeps a parenthetical that is prose instead of chipping it", () => {
    const text = "(Properties as stated in each vendor's documentation, vendor, verified Sep 2026. The plant's residency requirement, ch36, is the row that decides.)";
    const out = figurePass(text, ctx);
    expect(out.html).toBe(text);
    expect(out.refs).toEqual([{ targetKind: "chapter", targetId: "ch36" }]);
  });

  it("counts numbers with no tier at all", () => {
    const out = figurePass("Three writes in 11 steps.", { ...ctx, derive: null });
    expect(out.figures).toEqual([]);
    expect(out.untieredNumbers).toBe(1);
  });

  it("says where each figure's printed value sits in the paragraph it was given (feature-specs/33 § 4.1)", () => {
    const html = "The supervisor&#39;s queue starts at a <strong>1 s</strong> interval with a backoff coefficient of 2.0 (vendor, Temporal documentation).";
    const out = figurePass(html, ctx);
    expect(out.figures.map((f) => f.valueText)).toEqual(["1 s", "2.0"]);
    expect(out.spans.map((s) => html.slice(s.start, s.end))).toEqual(["1 s", "2.0"]);
  });

  it("leaves numbers inside chips, links and section references alone", () => {
    const out = figurePass('See <a class="xref" href="/en/ref/26.3">26.3</a> and Figure 21.3; row 21.9 r4 (vendor).', ctx);
    expect(out.figures).toEqual([]);
  });
});

describe("chapter 21 through buildChapter", () => {
  const b = book();
  const chapter = buildChapter(b.chapters[0], b, { locale: "en", previous: new Map() });
  const worked = chapter.sections[2];

  it("links every derived figure of 21.3 to derive.py", () => {
    expect(chapter.derivedTotal).toBe(12);
    expect(chapter.derivedLinked).toBe(12);
    const byValue = (v: string) => worked.figures.find((f) => f.valueText === v);
    expect(byValue("77%")?.derive).toMatchObject({ labId: "lab-21", filePath: "derive.py", line: 8, key: "p_no_failure_13calls_f0.02" });
    expect(byValue("99.5%")?.derive).toMatchObject({ line: 12, key: "task_success_f0.02_retries1" });
    expect(byValue("45%")?.derive).toMatchObject({ line: 14, key: "expected_redo_fraction_no_checkpoint" });
    expect(byValue("30")?.derive).toMatchObject({ line: 27, key: "backoff_schedule_s[5]" });
    /* "(illustrative)" governs its sentence, so the 75,000 derived from it stays illustrative, as written */
    expect(byValue("75,000")).toMatchObject({ tier: "ILLUSTRATIVE", derive: null });
  });

  it("treats derive.py's own parameters as scenario inputs", () => {
    const five = worked.figures.filter((f) => f.valueText === "5%");
    expect(five.length).toBeGreaterThan(0);
    expect(five.every((f) => f.tier === "ILLUSTRATIVE" && f.scenarioParam)).toBe(true);
  });

  it("marks up the section in the reader vocabulary", () => {
    expect(worked.htmlEn).toContain('<a class="derive" href="/en/labs/lab-21/derive.py#L14" data-figure="F-21-');
    expect(worked.htmlEn).toContain('<span class="chip t-ill"><i>ill</i> scenario · ch16, ch22</span>');
    expect(worked.htmlEn).toContain('<a class="xref" href="/en/ref/ch22" data-ref="ch22">ch22</a>');
    expect(worked.htmlEn).toContain("supervisor&#39;s approval");
    expect(worked.xrefs).toContainEqual({ targetKind: "chapter", targetId: "ch16" });
    expect(bodyVocabularyViolations(worked.htmlEn)).toEqual([]);
    expect(worked.figures.map((f) => f.id)[0]).toMatch(/^F-21-\d{2}$/);
  });

  it("carries the chapter's counts, status and lab", () => {
    expect(chapter.words).toBe(7114);
    expect(chapter.sourceRows).toHaveLength(10);
    expect(chapter.verifyStatus).toBe("PASSED");
    expect(chapter.redteamStatus).toBe("PASSED");
    expect(chapter.verifiedAt?.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(chapter.lab?.ciVerdict).toBe("REPRODUCED");
    expect(chapter.version).toBe("v1.0.0");
    expect(chapter.carries).toBe("LAB");
    expect(chapter.sections.map((s) => s.mermaid.length).reduce((a, c) => a + c, 0)).toBe(2);
    expect(chapter.report.stub).toBe(false);
  });

  it("numbers the derive.py code block from its real line", () => {
    const labBlocks = chapter.sections.flatMap((s) => s.codeBlocks).filter((c) => c.file !== null);
    expect(labBlocks.length).toBeGreaterThan(0);
    expect(labBlocks[0].file).toBe("lab-21/executor.py");
    expect(labBlocks[0].lines?.from).toBe(1);
    expect(labBlocks[0].lines?.to).toBeGreaterThan(1);
    expect(labBlocks[0].labHref).toBe("/en/labs/lab-21/executor.py#L1");
  });
});
