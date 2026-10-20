import { describe, expect, it } from "vitest";

import { E2E_FLOWS, E2E_LOCALES, E2E_PATHS, type E2eReport } from "@/lib/schemas/e2e";
import type { TruncationReport } from "@/lib/schemas/layout";

import { bareNumbers, flowsCriterion, formatGateReport, gateVerdict, peekCriterion, percentile, resumeCriterion, truncationCriterion, type Criterion, type GateReport } from "./phase1";

const criterion = (id: string, status: Criterion["status"]): Criterion => ({ id, text: `criterion ${id}`, status, measured: "x", note: "n" });

describe("gateVerdict", () => {
  it("is met only when every criterion passes", () => {
    expect(gateVerdict([criterion("P1.1", "pass"), criterion("P1.2", "pass")])).toEqual({ met: true, counts: { pass: 2, fail: 0, blocked: 0, deferred: 0 } });
    expect(gateVerdict([criterion("P1.1", "pass"), criterion("P1.2", "blocked")]).met).toBe(false);
    expect(gateVerdict([criterion("P1.1", "pass"), criterion("P1.2", "deferred")]).met).toBe(false);
    expect(gateVerdict([criterion("P1.1", "fail")]).counts.fail).toBe(1);
    expect(gateVerdict([]).met).toBe(false);
  });
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 95)).toBeNaN();
  });
});

describe("bareNumbers", () => {
  it("counts numbers in prose outside chips, links, figure spans and the pipeline's exclusions", () => {
    const html = [
      '<p>Three writes in 11 steps and <span class="fig-der" data-figure="F-21-01">45%</span> <a class="derive" href="/en/labs/lab-21#L8">ƒ L8</a> of the task.</p>',
      '<p>See <a class="xref" href="/en/ref/26.3" data-ref="26.3">26.3</a>, Figure 3, Table 2 and <a class="src" href="#r4" data-row="21.9 r4">21.9 r4</a> (vendor, 2024).</p>',
      "<p>Since 2019 the rate is $x = 3$ and the section is 21.4; the year 2026 is not a figure.</p>",
      '<pre class="code"><span class="ln">1</span> retries = 3</pre>',
      "<p>Costs of 1,500 tokens and 2.5 ms remain bare.</p>",
      '<p>A cited <span data-figure="F-21-02">40%</span> and an open <span data-figure="F-21-03">7 steps</span> <span class="chip c-open"><i>open</i> open</span> are figures, not bare.</p>',
    ].join("");
    const found = bareNumbers(html);
    expect(found.map((f) => f.token)).toEqual(["11", "1,500 tokens", "2.5 ms"]);
    expect(found[0].context).toContain("11 steps");
  });

  it("returns nothing for an empty body or a body with only tagged figures", () => {
    expect(bareNumbers("")).toEqual([]);
    expect(bareNumbers('<p><span class="fig-ill" data-figure="F-01-01">40%</span> <span class="chip c-ill"><i>ill</i> illustrative</span></p>')).toEqual([]);
  });
});

describe("formatGateReport", () => {
  it("prints one block per criterion and the verdict line", () => {
    const report: GateReport = {
      phase: 1,
      release: "2026.09",
      appUrl: "http://localhost:3000",
      criteria: [criterion("P1.1", "pass"), criterion("P1.2", "fail"), criterion("P1.3", "blocked"), criterion("P1.4", "deferred")],
      met: false,
      startedAt: "2026-09-23T10:00:00.000Z",
      finishedAt: "2026-09-23T10:01:00.000Z",
    };
    const text = formatGateReport(report);
    expect(text).toContain("Phase 1 gate · release 2026.09");
    expect(text).toContain("■ pass     P1.1");
    expect(text).toContain("□ FAIL     P1.2");
    expect(text).toContain("◧ blocked  P1.3");
    expect(text).toContain("· deferred P1.4");
    expect(text.trim().endsWith("GATE NOT MET · 1 pass · 1 fail · 1 blocked · 1 deferred")).toBe(true);
  });
});

describe("P1.8 from the truncation suite's report (unit 23c)", () => {
  const screen = (id: string, viewport: number, findings: TruncationReport["screens"][number]["findings"] = []) => ({ id, path: `/pt/${id}`, viewport, labels: 100, findings });
  const report = (over: Partial<TruncationReport> = {}): TruncationReport => ({
    release: "2026.09",
    ranAt: "2026-10-05T10:00:00.000Z",
    baseUrl: "http://localhost:3000",
    fixture: { strings: 978, exempt: 7, padded: 735, short: [] },
    screens: [screen("home", 1440), screen("home", 390), screen("reader", 1440)],
    skipped: [],
    ...over,
  });

  it("passes when every screen was rendered, none has a truncated label and the fixture holds", () => {
    const criterion = truncationCriterion(report(), "2026.09");
    expect(criterion.status).toBe("pass");
    expect(criterion.id).toBe("P1.8");
    expect(criterion.measured).toBe("3 renders · 300 labels · 0 truncated · fixture 978 strings · 735 lengthened · 7 with no label");
    expect(criterion.note).toContain("Run 2026-10-05 against http://localhost:3000.");
  });

  it("is blocked, not passed, when the suite has not been run or ran on another release", () => {
    expect(truncationCriterion(null, "2026.09")).toMatchObject({ status: "blocked", measured: "the suite has not been run" });
    expect(truncationCriterion(report({ release: "2026.08" }), "2026.09")).toMatchObject({ status: "blocked", measured: "the suite's report is of release 2026.08" });
  });

  it("fails on a truncated label, counting them and naming the first", () => {
    const clipped = { kind: "clipped" as const, element: "div.inst-h", text: "Capítulo 21", by: 119 };
    const criterion = truncationCriterion(report({ screens: [screen("home", 1440), screen("reader", 1440, [clipped, { ...clipped, kind: "spills" }]), screen("search", 390, [clipped])] }), "2026.09");
    expect(criterion.status).toBe("fail");
    expect(criterion.measured).toBe("3 truncated labels on 2 of 3 renders · fixture 978 strings · 735 lengthened · 7 with no label");
    expect(criterion.note).toContain("1440 reader · clipped · div.inst-h");
  });

  it("fails when a fixture string is not 30 % longer than its EN counterpart, whatever the screens say", () => {
    const criterion = truncationCriterion(report({ fixture: { strings: 978, exempt: 7, padded: 735, short: ["chrome.nav.book"] } }), "2026.09");
    expect(criterion).toMatchObject({ status: "fail", measured: "1 fixture strings are not 30 % longer than their EN counterpart" });
    expect(criterion.note).toContain("chrome.nav.book");
  });

  it("is blocked when a screen was not rendered: what was not measured did not pass", () => {
    const criterion = truncationCriterion(report({ skipped: [{ id: "marks", viewport: 1440, reason: "the dev sign-in answered 404" }] }), "2026.09");
    expect(criterion).toMatchObject({ status: "blocked", measured: "3 renders measured, 1 not rendered" });
    expect(criterion.note).toContain("1440 marks (the dev sign-in answered 404)");
  });

  it("puts a truncated label before a screen that was not rendered: a failure seen is a failure", () => {
    const clipped = { kind: "clipped" as const, element: "div.inst-h", text: "x", by: 4 };
    expect(truncationCriterion(report({ screens: [screen("home", 1440, [clipped])], skipped: [{ id: "marks", viewport: 1440, reason: "r" }] }), "2026.09").status).toBe("fail");
  });
});

describe("the criteria the end-to-end suite measures (unit 23d)", () => {
  const SECTIONS = 362;
  const flows: E2eReport["flows"] = E2E_FLOWS.flatMap((id) => E2E_LOCALES.map((locale) => ({ kind: "flow" as const, id, locale, passed: true, failure: null, screens: 2, axe: [] })));
  const keyboard: E2eReport["keyboard"] = E2E_LOCALES.map((locale) => ({ kind: "keyboard" as const, locale, walked: SECTIONS, helped: SECTIONS, keys: { j: true, k: true, "]": true, "[": true, "/": true }, failures: [] }));
  const walked: E2eReport["peek"][number] = { kind: "peek", locale: "en", sections: SECTIONS, references: 2664, targets: 222, kinds: { section: 147, chapter: 41, lab: 34 }, opened: 2664, stayed: 2664, focusReturned: 2664, failures: [] };
  const resume: E2eReport["resume"] = E2E_PATHS.map((path) => ({ kind: "resume" as const, path, read: "21.3", landed: "21.3", ok: true, failure: null }));
  const report = (over: Partial<E2eReport> = {}): E2eReport => ({ release: "2026.09", ranAt: "2026-10-05T10:00:00.000Z", baseUrl: "http://localhost:3000", flows, keyboard, peek: [walked], resume, ...over });
  const TARGETS = { total: 222, unresolved: [] };

  describe("P1.9, the flows and the keyboard map", () => {
    it("passes when every flow ran in both languages, axe found nothing and the map answered on every reader page", () => {
      const criterion = flowsCriterion(report(), "2026.09", SECTIONS);
      expect(criterion.status).toBe("pass");
      expect(criterion.measured).toBe("12 flows passed (6 in EN and PT) · 0 axe violations on 24 screens · keyboard map on every reader page: EN 362/362, PT 362/362");
    });

    it("is blocked when the suite has not run, ran on another release, or left a flow or a walk out", () => {
      expect(flowsCriterion(null, "2026.09", SECTIONS)).toMatchObject({ status: "blocked", measured: "the suite has not been run" });
      expect(flowsCriterion(report({ release: "2026.08" }), "2026.09", SECTIONS)).toMatchObject({ status: "blocked", measured: "the suite's report is of release 2026.08" });
      const partial = flowsCriterion(report({ flows: flows.slice(0, 10), keyboard: keyboard.slice(0, 1) }), "2026.09", SECTIONS);
      expect(partial.status).toBe("blocked");
      expect(partial.measured).toContain("10/12 flows and 1/2 keyboard walks run");
      expect(partial.measured).toContain("account (en)");
    });

    it("fails on a flow that failed, on an axe violation, and on a reader page the walk did not reach", () => {
      const failed = flowsCriterion(report({ flows: flows.map((flow, index) => (index === 3 ? { ...flow, passed: false, failure: "the peek did not open" } : flow)) }), "2026.09", SECTIONS);
      expect(failed).toMatchObject({ status: "fail" });
      expect(failed.note).toContain("read-a-section (pt): the peek did not open");

      const violation = { screen: "search results", rule: "color-contrast", nodes: 2, target: ".hit .meta" };
      const axe = flowsCriterion(report({ flows: flows.map((flow, index) => (index === 4 ? { ...flow, passed: false, failure: "1 axe violation: color-contrast on search results", axe: [violation] } : flow)) }), "2026.09", SECTIONS);
      expect(axe.status).toBe("fail");
      expect(axe.measured).toContain("1 axe violations on 24 screens");

      const short = flowsCriterion(report({ keyboard: keyboard.map((walk) => (walk.locale === "en" ? { ...walk, walked: 300, helped: 300 } : walk)) }), "2026.09", SECTIONS);
      expect(short.status).toBe("fail");
      expect(short.measured).toContain("EN 300/362");

      const key = flowsCriterion(report({ keyboard: keyboard.map((walk) => ({ ...walk, keys: { ...walk.keys, "]": false } })) }), "2026.09", SECTIONS);
      expect(key.status).toBe("fail");
    });

    it("puts a failure seen before a part that is missing", () => {
      const criterion = flowsCriterion(report({ flows: flows.slice(0, 1).map((flow) => ({ ...flow, passed: false, failure: "x" })), keyboard: [] }), "2026.09", SECTIONS);
      expect(criterion.status).toBe("fail");
    });
  });

  describe("P1.4, the peek", () => {
    it("passes when every target resolves and every reference clicked opened, stayed and gave focus back", () => {
      const criterion = peekCriterion(report(), "2026.09", SECTIONS, TARGETS);
      expect(criterion.status).toBe("pass");
      expect(criterion.measured).toBe("222/222 distinct targets resolve in the release · 2664/2664 references opened a peek · 2664 left the reader on its section · 2664 gave focus back on esc");
      expect(criterion.note).toContain("362/362 reader pages");
      expect(criterion.note).toContain("222/222 distinct targets met (41 chapter, 34 lab, 147 section)");
    });

    it("fails a pass that did not look through every page or did not meet every target the release names", () => {
      expect(peekCriterion(report({ peek: [{ ...walked, sections: 300 }] }), "2026.09", SECTIONS, TARGETS).status).toBe("fail");
      expect(peekCriterion(report({ peek: [{ ...walked, targets: 221 }] }), "2026.09", SECTIONS, TARGETS).status).toBe("fail");
      expect(peekCriterion(report({ peek: [{ ...walked, references: 0, opened: 0, stayed: 0, focusReturned: 0 }] }), "2026.09", SECTIONS, TARGETS).status).toBe("fail");
    });

    it("fails on an unresolved target whatever the browser saw, and on a reference whose focus did not return", () => {
      expect(peekCriterion(report(), "2026.09", SECTIONS, { total: 222, unresolved: ["section 99.9"] })).toMatchObject({ status: "fail" });
      const lost = peekCriterion(report({ peek: [{ ...walked, focusReturned: 2663, failures: ["21.3 → ch22: focus did not return"] }] }), "2026.09", SECTIONS, TARGETS);
      expect(lost.status).toBe("fail");
      expect(lost.note).toContain("21.3 → ch22: focus did not return");
    });

    it("is blocked while the browser has not walked the references of this release", () => {
      expect(peekCriterion(null, "2026.09", SECTIONS, TARGETS)).toMatchObject({ status: "blocked", measured: "222/222 distinct targets resolve in the release · the suite has not been run" });
      expect(peekCriterion(report({ peek: [] }), "2026.09", SECTIONS, TARGETS).measured).toContain("the suite did not walk the cross-references");
      expect(peekCriterion(report({ release: "2026.08" }), "2026.09", SECTIONS, TARGETS).status).toBe("blocked");
    });
  });

  describe("P1.6, the resume", () => {
    it("passes when each of the three paths resumed on the section read in another context", () => {
      const criterion = resumeCriterion(report(), "2026.09");
      expect(criterion.status).toBe("pass");
      expect(criterion.measured).toContain("3/3 paths resumed in a second browser context");
    });

    it("fails when a path landed somewhere else, and is blocked when a path was not run", () => {
      const wrong = resumeCriterion(report({ resume: resume.map((part, index) => (index === 1 ? { ...part, landed: "16.1", ok: false } : part)) }), "2026.09");
      expect(wrong).toMatchObject({ status: "fail", measured: "2/3 paths resumed on the section read" });
      expect(wrong.note).toContain("builder: read 21.3, landed on 16.1");
      expect(resumeCriterion(report({ resume: resume.slice(0, 2) }), "2026.09")).toMatchObject({ status: "blocked" });
      expect(resumeCriterion(null, "2026.09")).toMatchObject({ status: "blocked", measured: "the suite has not been run" });
    });
  });
});
