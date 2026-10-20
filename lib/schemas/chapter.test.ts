import { describe, expect, it } from "vitest";

import { bodyVocabularyViolations, ChapterDataSchema, classifyRef, PeekDataSchema, sourceLinkOf, type ChapterDataInput } from "./chapter";

describe("body vocabulary", () => {
  it("accepts the reader vocabulary, mermaid classes inside svg included", () => {
    expect(bodyVocabularyViolations('<p>A <span class="fig-der">86</span> <a class="derive" href="/x">ƒ L41</a></p>')).toEqual([]);
    expect(bodyVocabularyViolations('<figure class="fig box"><svg><g class="node default"><rect/><text class="nodeLabel">A</text></g></svg></figure>')).toEqual([]);
  });
  it("rejects tags, classes, handlers, styles and javascript urls outside it", () => {
    expect(bodyVocabularyViolations("<script>1</script>")).toContain("<script>");
    expect(bodyVocabularyViolations('<p class="card">x</p>')).toContain(".card");
    expect(bodyVocabularyViolations('<a onclick="x()">x</a>')).toContain("on* handler");
    expect(bodyVocabularyViolations('<a href="javascript:void(0)">x</a>')).toContain("javascript: url");
    expect(bodyVocabularyViolations("<svg><style>x</style></svg>")).toContain("<style>");
    expect(bodyVocabularyViolations("<svg><filter/></svg>")).toContain("<filter>");
  });
});

const section = (id: string, ordinal: number) => ({ id, ordinal, title: `Layer ${ordinal}`, href: `/en/ch/21/${id}` });

const input = (): ChapterDataInput => ({
  release: { id: "2026.09", gitSha: "e8e9d1730630b2cf1615ef7eb0cdf7d64b33a4e2" },
  chapter: {
    number: 21,
    part: "P2",
    title: "Control plane and durable execution",
    standfirst: "A task that outlives its worker must resume where it stopped.",
    version: "v1.0.0",
    sourceLang: "EN",
    editionLang: "EN",
    verify: "PASSED",
    redteam: "PASSED",
    redteamOpen: 0,
    verifiedAt: "2026-09-21T00:00:00.000Z",
    contentHash: "a40c34bbaf6d0ff6a62cfe558b6f44cea9f8addff72f10e80326aef8e75bc647",
    words: 7054,
    derivedFigures: { linked: 13, total: 13 },
    citedFigures: { total: 25, fastMoving: 0 },
    oldestCheckDays: 1,
    historyCount: 1,
    lab: { id: "lab-21", verdict: "REPRODUCED", lastRunAt: "2026-09-22T00:17:36.896Z", lastRunBy: "ci", expectedRuntimeS: null },
  },
  outline: {
    partTitleKey: "P2",
    range: { from: 16, to: 33, count: 18 },
    neighbours: [{ number: 21, title: "Control plane and durable execution", href: "/en/ch/21" }],
    layers: [section("21.1", 1), section("21.2", 2), section("21.3", 3)],
  },
  section: {
    id: "21.3",
    ordinal: 3,
    layer: "WORKED_NUMBERS",
    title: "Worked numbers",
    bodyHtml: '<p>The expected work redone is <span class="fig-der" data-figure="F-21-05">45%</span> <a class="derive" href="/en/labs/lab-21/derive.py#L14" data-figure="F-21-05" data-line="14" title="derive.py line 14">ƒ L14</a>.</p>',
    figures: [{ id: "F-21-05", label: "expected work redone", valueText: "45%", tier: "DERIVED", derive: { labId: "lab-21", filePath: "derive.py", line: 14, key: "expected_redo_fraction_no_checkpoint" }, sourceRowId: null, fastMoving: false, ageDays: null }],
    sourceRows: [{ id: "21.9 r8", ordinal: 8, claim: "Redo fraction", citation: "labs/ch21-control-plane/derive.py", url: null, doi: null, link: null, tier: "DERIVED", verifiedAt: "2026-09-21T00:00:00.000Z", fastMoving: false, stale: false }],
    hasSourceLinks: false,
    prev: { id: "21.2", href: "/en/ch/21/21.2" },
    next: { id: "21.4", href: "/en/ch/21/21.4" },
    codeBlocks: [{ index: 0, file: "lab-21/derive.py", lines: { from: 14, to: 17 }, language: "python", labHref: "/en/labs/lab-21/derive.py#L14" }],
  },
  progress: null,
  marks: null,
});

describe("ChapterData", () => {
  it("coerces ISO dates and accepts a lab without a stated runtime", () => {
    const data = ChapterDataSchema.parse(input());
    expect(data.chapter.verifiedAt?.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(data.chapter.lab?.lastRunAt).toBeInstanceOf(Date);
    expect(data.section.sourceRows[0].verifiedAt.getUTCFullYear()).toBe(2026);
  });

  it("derives a source row's link and refuses a non-http(s) target (feature-specs/10 § 5.3)", () => {
    expect(sourceLinkOf("https://docs.temporal.io/", null)).toEqual({ href: "https://docs.temporal.io/", kind: "url" });
    expect(sourceLinkOf(null, "10.1145/38713.38742")).toEqual({ href: "https://doi.org/10.1145/38713.38742", kind: "doi" });
    expect(sourceLinkOf("https://doi.org/10.1145/38713.38742", "10.1145/38713.38742")).toEqual({ href: "https://doi.org/10.1145/38713.38742", kind: "doi" });
    expect(sourceLinkOf("https://a.example/", "10.1/x")).toEqual({ href: "https://a.example/", kind: "url" });
    expect(sourceLinkOf(null, null)).toBeNull();
    expect(sourceLinkOf("javascript:alert(1)", null)).toBeNull();
    expect(sourceLinkOf("not a url", null)).toBeNull();
    const base = input();
    const row = base.section.sourceRows[0];
    const withLink = { ...base, section: { ...base.section, hasSourceLinks: true, sourceRows: [{ ...row, link: { href: "https://docs.temporal.io/", kind: "url" as const } }] } };
    expect(ChapterDataSchema.parse(withLink).section.sourceRows[0].link?.kind).toBe("url");
    const bad = { ...base, section: { ...base.section, sourceRows: [{ ...row, link: { href: "javascript:alert(1)", kind: "url" as const } }] } };
    expect(() => ChapterDataSchema.parse(bad)).toThrow();
  });

  it("accepts the prose-only outline of two layers and rejects more than nine", () => {
    const two = input();
    expect(() => ChapterDataSchema.parse({ ...two, outline: { ...two.outline, layers: [section("00.1", 1), section("00.9", 9)] } })).not.toThrow();
    const ten = Array.from({ length: 10 }, (_, i) => section(`21.${(i % 9) + 1}`, (i % 9) + 1));
    expect(() => ChapterDataSchema.parse({ ...two, outline: { ...two.outline, layers: ten } })).toThrow();
  });

  it("refuses a body outside the vocabulary", () => {
    const bad = input();
    expect(() => ChapterDataSchema.parse({ ...bad, section: { ...bad.section, bodyHtml: '<p class="x">1</p>' } })).toThrow(/body vocabulary/);
  });
});

describe("peek", () => {
  it("parses a peek and classifies refs", () => {
    const peek = PeekDataSchema.parse({ id: "26.3", kind: "section", title: "Sensors and verification", caption: "sensors and verification · mechanism", version: "v1.0.0", bodyHtml: "<p>x</p>", verifiedAt: "2026-09-04T00:00:00.000Z", openHref: "/en/ch/26/26.3" });
    expect(peek.verifiedAt).toBeInstanceOf(Date);
    expect(classifyRef("26.3")).toEqual({ kind: "section", sectionId: "26.3" });
    expect(classifyRef("ch31")).toEqual({ kind: "chapter", chapter: 31 });
    expect(classifyRef("lab21")).toEqual({ kind: "lab", chapter: 21 });
    expect(classifyRef("nope")).toBeNull();
  });
});
