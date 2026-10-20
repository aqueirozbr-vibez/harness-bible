import { describe, expect, it } from "vitest";

import { gateVerdict } from "@/lib/gate/common";

import { adminCriterion, curatedCriterion, curatedMeasures, formatPhase4Extras, ledgerCriterion, mergeCriterion, phase4Report, policyCriterion, rosterCondition, rubricCriterion, rubricPublishedCriterion, selectTests, suitesCriterion, summarise, timingMeasure, type CuratedFacts, type CuratedPair, type LedgerFacts, type TestOutcome, type TestSelection } from "./phase4";

/*
 * The Phase 4 gate's builders (feature-specs/39 § 7.2): each passes on its evidence, fails on evidence outside the
 * criterion, and is blocked when the evidence is not there — never a pass for a criterion nothing measured.
 */

const outcome = (file: string, name: string, status: TestOutcome["status"] = "passed"): TestOutcome => ({ file: `C:/app/${file}`, name, status });
const RUN: ReadonlyArray<TestOutcome> = [
  outcome("tests/integration/worked-examples.test.ts", "the four worked examples 1 · a cited date"),
  outcome("tests/integration/worked-examples.test.ts", "the four worked examples 2 · a cited figure"),
  outcome("tests/integration/worked-examples.test.ts", "the four worked examples 3 · a derived decision aid"),
  outcome("tests/integration/worked-examples.test.ts", "the four worked examples 4 · a cited price"),
  outcome("lib/api/endpoints/suggestions.test.ts", "is 422 INTAKE_<SENSOR> for the first sensor that fails"),
  outcome("lib/api/endpoints/suggestions.test.ts", "is 429 RATE_LIMITED past twenty in a day"),
  outcome("lib/sensors/intake.test.ts", "refuses a rationale over 200 words"),
];
const selection = (label: string, file: string, name?: RegExp, expected: number | null = null): TestSelection => ({ label, tests: selectTests(RUN, file, name), expected });

describe("selectTests and summarise", () => {
  it("selects by the file's end and the name, and counts what passed, failed and did not run, naming the problems", () => {
    expect(selectTests(RUN, "worked-examples.test.ts")).toHaveLength(4);
    expect(selectTests(RUN, "suggestions.test.ts", /INTAKE_/)).toHaveLength(1);
    expect(selectTests(RUN, "nowhere.test.ts")).toHaveLength(0);
    const summary = summarise([selection("the examples", "worked-examples.test.ts", /[1-4] · /, 4), { label: "a failed one", tests: [outcome("x.test.ts", "it broke", "failed"), outcome("x.test.ts", "it waited", "skipped")], expected: null }, selection("nothing", "nowhere.test.ts")]);
    expect(summary).toMatchObject({ passed: 4, failed: 1, notRun: 1, total: 6 });
    expect(summary.problems).toEqual(["a failed one: failed — it broke", "a failed one: skipped — it waited", "nothing: no such test in the run"]);
  });
});

describe("suitesCriterion (P4.1, P4.3, P4.5, P4.9)", () => {
  it("passes when every named test ran and passed, with the count", () => {
    const c = suitesCriterion("P4.1", [selection("the examples", "worked-examples.test.ts", /[1-4] · /, 4)], "the examples' suite");
    expect(c).toMatchObject({ id: "P4.1", status: "pass", measured: "4/4 tests passed" });
  });

  it("fails on a failed test, on fewer tests than named, and on a selection that found nothing", () => {
    expect(suitesCriterion("P4.1", [selection("the examples", "worked-examples.test.ts", /[1-3] · /, 4)], "how").status).toBe("fail");
    expect(suitesCriterion("P4.3", [{ label: "intake", tests: [outcome("a.test.ts", "x", "failed")], expected: null }], "how").note).toContain("failed — x");
    expect(suitesCriterion("P4.9", [selection("throttle", "nowhere.test.ts")], "how")).toMatchObject({ status: "fail", measured: "0/0 tests passed" });
  });

  it("is blocked when the suites did not run", () => {
    expect(suitesCriterion("P4.5", { blocked: "vitest wrote no report" }, "how")).toMatchObject({ status: "blocked", measured: "—", note: "vitest wrote no report" });
  });
});

describe("rubricCriterion (P4.2)", () => {
  const tests = [selection("the sensors' suite stands in", "intake.test.ts")];
  it("passes at 100 % of branches with the suites green, fails one branch short, and is blocked without a coverage summary", () => {
    expect(rubricCriterion({ covered: 40, total: 40, files: 5 }, tests)).toMatchObject({ status: "pass", measured: "branches 40/40 (100.0 %) · 1/1 tests passed" });
    const short = rubricCriterion({ covered: 39, total: 40, files: 5 }, tests);
    expect(short.status).toBe("fail");
    expect(short.note).toContain("1 branch(es) of lib/rubric untested");
    expect(rubricCriterion({ blocked: "no summary" }, tests).status).toBe("blocked");
  });
});

describe("policyCriterion (P4.4)", () => {
  const tests = [selection("the router", "intake.test.ts")];
  it("passes with the policy's tests green and no curator-always suggestion adjudicated by a model; fails on either; is blocked without opa", () => {
    expect(policyCriterion({ passed: 72, failed: 0, total: 72 }, { decided: 3, byModel: 0 }, tests)).toMatchObject({ status: "pass", measured: "opa 72/72 · curator-always decided 3, by a model 0 · 1/1 tests passed" });
    expect(policyCriterion({ passed: 71, failed: 1, total: 72 }, { decided: 3, byModel: 0 }, tests).status).toBe("fail");
    expect(policyCriterion({ passed: 72, failed: 0, total: 72 }, { decided: 3, byModel: 1 }, tests).note).toContain("1 curator-always suggestion(s) adjudicated by a model");
    expect(policyCriterion({ blocked: "opa could not be run" }, { decided: 0, byModel: 0 }, tests).status).toBe("blocked");
  });
});

describe("curatedCriterion (P4.6)", () => {
  const facts: CuratedFacts = { set: { file: "golden/suggestions-2026.09.jsonl", items: 100 }, labels: { file: "golden/suggestions/labels/2026.09.jsonl", items: 100 }, run: { file: "suggestions-run-2026.09-real-x.json", items: 100, real: true }, command: "npm run gate:suggestions:run -- --real", estimateUsd: 6 };
  /* a hundred labelled and run: 76 the adjudicator's, 19 a rule's at intake, 5 the router's to a curator (as the generated set has them) */
  const pairs: ReadonlyArray<CuratedPair> = Array.from({ length: 100 }, (_, i) => {
    const byRule = i >= 76 && i < 95;
    const toCurator = i >= 95;
    const label = toCurator ? "REQUEST_MORE" : byRule ? "DECLINE" : i < 40 ? "ACCEPT" : i < 70 ? "REQUEST_MORE" : "DECLINE";
    return { id: `G-21-${String(i + 1).padStart(4, "0")}`, label, decided: toCurator ? "CURATOR_REVIEW" : i === 75 ? "ACCEPT" : label, decidedBy: toCurator ? "router" : byRule ? "intake-rules" : "adjudicator", disagreed: i === 75 ? ["independence"] : [] };
  });

  it("is blocked naming what is missing — the set, the labels, a real run — and the command with its estimate", () => {
    const none = curatedCriterion({ ...facts, set: null, labels: null, run: null }, null);
    expect(none.status).toBe("blocked");
    expect(none.note).toContain("the set");
    expect(none.note).toContain("the curators' labels");
    expect(none.note).toContain("npm run gate:suggestions:run -- --real");
    expect(none.note).toContain("$6.00");
    const stubOnly = curatedCriterion({ ...facts, run: { file: "suggestions-run-2026.09-stub.json", items: 100, real: false } }, null);
    expect(stubOnly.status).toBe("blocked");
    expect(stubOnly.measured).toBe("set 100 items · labels 100 · stub run 100 items");
  });

  it("measures precision as accepted where the label declines, and the override rate, over the adjudicator's decisions alone, passing under the ceilings with the whole set run", () => {
    const measures = curatedMeasures(pairs);
    expect(measures).toMatchObject({ items: 100, adjudicated: 76, byRule: 19, toCurator: 5, reviewOpened: [] });
    expect(measures.precision).toBeCloseTo(1 / 76, 9);
    expect(measures.overrideRate).toBeCloseTo(1 / 76, 9);
    expect(measures.perCriterion.independence).toBeCloseTo(1 / 76, 9);
    expect(curatedCriterion(facts, pairs)).toMatchObject({ status: "pass", measured: "100 items ran (76 adjudicated, 19 by rule, 5 a curator's) · precision 1.3 % · override 1.3 %" });
  });

  it("fails past a ceiling, opens a rubric review for a criterion over 20 %, and fails a set not wholly labelled and run", () => {
    const bad: ReadonlyArray<CuratedPair> = pairs.map((pair, i) => (i < 20 ? { ...pair, label: "DECLINE", decided: "ACCEPT", disagreed: ["recency"] } : pair));
    const c = curatedCriterion(facts, bad);
    expect(c.status).toBe("fail");
    /* twenty turned and the one false accept the set had, over the adjudicator's 76 */
    expect(c.measured).toContain("precision 27.6 %");
    expect(c.note).toContain("opened for recency");
    const partial = curatedCriterion(facts, pairs.slice(0, 90));
    expect(partial.status).toBe("fail");
    expect(partial.note).toContain("90 labelled and 90 run of the 100");
    const notRun = curatedCriterion(facts, pairs.map((pair, i) => (i === 3 ? { ...pair, decided: null, decidedBy: null } : pair)));
    expect(notRun.note).toContain("100 labelled and 99 run of the 100");
  });
});

describe("mergeCriterion (P4.7)", () => {
  it("passes the local part and names CI as blocked; fails when the suite fails; is blocked when it did not run", () => {
    const pass = mergeCriterion([selection("the merge's suite", "intake.test.ts")], { host: false, runner: false });
    expect(pass.status).toBe("pass");
    expect(pass.note).toContain('"CI runs the lab suite" is blocked: no host for the book\'s repository and no runner');
    expect(mergeCriterion([{ label: "merge", tests: [outcome("merge.test.ts", "x", "failed")], expected: null }], { host: true, runner: true }).status).toBe("fail");
    expect(mergeCriterion({ blocked: "no run" }, { host: false, runner: false }).status).toBe("blocked");
  });
});

describe("ledgerCriterion (P4.8)", () => {
  const facts: LedgerFacts = { views: [{ suggestionId: "S-21-0001", ok: true, records: 5 }], suggestionExport: { ok: true, lines: 5, carries: true }, chapterExport: { chapter: "21", ok: true, lines: 9, neighbours: true }, suites: [selection("the export's suite", "intake.test.ts")] };
  it("passes with every view and export verified, fails on a broken view or an export with no predecessor, and is blocked without the key", () => {
    expect(ledgerCriterion(facts)).toMatchObject({ status: "pass", measured: "1/1 records verify · 1/1 tests passed" });
    expect(ledgerCriterion({ ...facts, views: [{ suggestionId: "S-21-0001", ok: false, records: 5 }] }).status).toBe("fail");
    expect(ledgerCriterion({ ...facts, suggestionExport: { ok: true, lines: 5, carries: false } }).note).toContain("carries no predecessor");
    expect(ledgerCriterion({ ...facts, chapterExport: null }).note).toContain("no chapter in the database has a merged change");
    expect(ledgerCriterion({ ...facts, suggestionExport: { blocked: "no key" } }).status).toBe("blocked");
    expect(ledgerCriterion({ ...facts, views: [] }).status).toBe("fail");
  });
});

describe("rubricPublishedCriterion (P4.10)", () => {
  it("passes with the page and the JSON answering 200 and every adjudication versioned; fails otherwise; is blocked when the app is not there", () => {
    expect(rubricPublishedCriterion({ page: 200, json: 200, version: "v1.2", adjudications: { total: 9, withRubric: 9 } })).toMatchObject({ status: "pass", measured: "page 200 · json 200 (v1.2) · 9/9 adjudications versioned" });
    expect(rubricPublishedCriterion({ page: 500, json: 200, version: "v1.2", adjudications: { total: 9, withRubric: 9 } }).status).toBe("fail");
    expect(rubricPublishedCriterion({ page: 200, json: 200, version: null, adjudications: { total: 9, withRubric: 9 } }).note).toContain("no rubric version");
    expect(rubricPublishedCriterion({ page: 200, json: 200, version: "v1.2", adjudications: { total: 9, withRubric: 8 } }).note).toContain("1 adjudication(s) without a rubric version");
    expect(rubricPublishedCriterion({ blocked: "the app is not running" }).status).toBe("blocked");
  });
});

describe("adminCriterion (P4.11)", () => {
  const suites = [selection("audit", "intake.test.ts")];
  it("passes with the suites green and no capped month over; fails on an overage; is blocked when the cap cannot be read; names the organisation's half", () => {
    const pass = adminCriterion({ suites, cap: { principals: 1, monthsOver: 0 }, organisations: false });
    expect(pass).toMatchObject({ status: "pass", measured: "1/1 tests passed · 1 capped principal(s), 0 month(s) over" });
    expect(pass.note).toContain("the organisation's admin is blocked");
    expect(adminCriterion({ suites, cap: { principals: 1, monthsOver: 2 }, organisations: true }).status).toBe("fail");
    expect(adminCriterion({ suites, cap: { blocked: "no ledger" }, organisations: true }).status).toBe("blocked");
  });
});

describe("the roster condition, the measures and the report", () => {
  it("wants two curators a part, naming the parts that fall short", () => {
    expect(rosterCondition([{ part: "P0", curators: 2 }, { part: "P1", curators: 1 }, { part: "P2", curators: 0 }])).toEqual({ met: false, parts: expect.any(Array) as unknown, short: ["P1", "P2"] });
    expect(rosterCondition([{ part: "P0", curators: 6 }]).met).toBe(true);
    expect(rosterCondition([]).met).toBe(false);
  });

  it("measures p95 and how many fell within the limit, null for nothing", () => {
    expect(timingMeasure([1000, 2000, 700_000], 600_000)).toEqual({ items: 3, p95Ms: 700_000, within: 2, limitMs: 600_000 });
    expect(timingMeasure([], 600_000)).toEqual({ items: 0, p95Ms: null, within: 0, limitMs: 600_000 });
  });

  it("is met only when every criterion passes, and lists the suites by file", () => {
    const criteria = [suitesCriterion("P4.1", [selection("the examples", "worked-examples.test.ts", /[1-4] · /, 4)], "how"), curatedCriterion({ set: null, labels: null, run: null, command: "cmd", estimateUsd: 6 }, null)];
    const report = phase4Report({ release: "2026.09", appUrl: "http://localhost:3000", startedAt: "2026-10-10T12:00:00.000Z", finishedAt: "2026-10-10T12:05:00.000Z", criteria, roster: rosterCondition([{ part: "P0", curators: 2 }]), measures: { decision: timingMeasure([1000], 600_000), completion: timingMeasure([], 86_400_000) }, outcomes: RUN });
    expect(report.met).toBe(false);
    expect(gateVerdict(report.criteria).counts).toEqual({ pass: 1, fail: 0, blocked: 1, deferred: 0 });
    expect(report.suites.map((suite) => suite.file)).toEqual(["lib/api/endpoints/suggestions.test.ts", "lib/sensors/intake.test.ts", "tests/integration/worked-examples.test.ts"]);
    expect(formatPhase4Extras(report)).toContain("■ roster: at least 2 curators a part — P0 2");
    expect(formatPhase4Extras(report)).toContain("time to completion: 0 merged, p95 —");
  });
});
