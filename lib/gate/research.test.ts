import { describe, expect, it } from "vitest";

import type { TestSelection } from "./phase4";
import { budgetCriterion, checkCriterion, curatorFirstCriterion, evidenceCriterion, formatResearchExtras, R_TEXT, researchMeasures, researchReport, suitesCriterion, turnsCriterion, type EvidenceFacts, type MeasureFacts, type ResearchBudgetFacts, type TurnsFacts } from "./research";

/*
 * The researcher's gate, pure (feature-specs/44 § 8.2; unit 61b): each criterion's builder passes, fails and is
 * blocked on what it is given; the measures of § 3, not yet measured until a real run; the report and its extras.
 * R1 and R9 as unit 75 reads them (feature-specs/48 § 25): nothing of research follows a turn, and a person's run is
 * never on the platform's research principal.
 */

const passed = (label: string, n = 2): TestSelection => ({ label, tests: Array.from({ length: n }, (_, index) => ({ file: "x.test.ts", name: `${label} ${String(index)}`, status: "passed" as const })), expected: null });
const failed = (label: string): TestSelection => ({ label, tests: [{ file: "x.test.ts", name: label, status: "failed" }], expected: null });
const BLOCKED = { blocked: "the suites did not report" };

const TURNS: TurnsFacts = {
  questions: 3,
  withResearch: [],
  changed: [],
  runs: 0,
  researchCalls: 0,
  refusals: [
    { cause: "R-SCOPE", refused: true, research: false, researchCalls: 0 },
    { cause: "R-RECOMPUTE", refused: true, research: false, researchCalls: 0 },
  ],
};

describe("the criteria that are their suites", () => {
  it("pass when every named test passed, fail on one that did not, and are blocked with the suites", () => {
    expect(suitesCriterion("R4", [passed("injection"), passed("validate")], "how")).toMatchObject({ id: "R4", text: R_TEXT.R4, status: "pass", measured: "4/4 tests passed" });
    expect(suitesCriterion("R4", [passed("injection"), failed("validate")], "how")).toMatchObject({ status: "fail", note: expect.stringContaining("failed — validate") });
    expect(suitesCriterion("R4", [{ label: "missing", tests: [], expected: null }], "how")).toMatchObject({ status: "fail", note: expect.stringContaining("no such test in the run") });
    expect(suitesCriterion("R4", BLOCKED, "how")).toMatchObject({ status: "blocked", note: "the suites did not report" });
  });
});

describe("R1: the gate's own turns", () => {
  it("passes when nothing of research followed any turn and every answer read back as its final event gave it", () => {
    expect(turnsCriterion([passed("stream")], TURNS)).toMatchObject({ status: "pass", measured: "2/2 tests passed · 3/3 answers read back as their final gave them · 0 run(s) · 0 research call(s) · 0 final event(s) with research · refusals 2/2 with nothing of research" });
  });

  it("fails on research in a final event, an answer read back otherwise, a run row, a research call, a refusal not refused or one with research", () => {
    expect(turnsCriterion([passed("a")], { ...TURNS, withResearch: ["golden-003"] }).note).toContain("1 final event(s) carried research: golden-003");
    expect(turnsCriterion([passed("a")], { ...TURNS, changed: ["golden-007"] }).note).toContain("1 answer(s) read back other than their final event gave them: golden-007");
    expect(turnsCriterion([passed("a")], { ...TURNS, runs: 2 }).note).toContain("2 research run(s) written for the gate's turns");
    expect(turnsCriterion([passed("a")], { ...TURNS, researchCalls: 1 }).note).toContain("1 research call(s) on the answered turns' traces");
    expect(turnsCriterion([passed("a")], { ...TURNS, refusals: [{ cause: "R-SCOPE", refused: false, research: true, researchCalls: 1 }] }).note).toEqual(expect.stringContaining("R-SCOPE was not refused"));
    expect(turnsCriterion([passed("a")], { ...TURNS, refusals: [{ cause: "R-SCOPE", refused: true, research: true, researchCalls: 1 }] }).note).toEqual(expect.stringContaining("R-SCOPE's refusal carried research in its final event; R-SCOPE's refusal made 1 research call(s)"));
    expect(turnsCriterion([passed("a")], { ...TURNS, refusals: [] }).note).toContain("no refusal was asked");
    expect(turnsCriterion([passed("a")], { ...TURNS, questions: 0 }).note).toContain("no answered question to ask");
    expect(turnsCriterion([failed("stream")], TURNS).status).toBe("fail");
  });

  it("is blocked when the turns could not be asked", () => {
    expect(turnsCriterion([passed("a")], { blocked: "the policy sidecar does not answer" })).toMatchObject({ status: "blocked", note: "the policy sidecar does not answer" });
  });
});

describe("R5: the evidence", () => {
  const facts: EvidenceFacts = { suggestions: 2, items: 3, pending: 1, opened: 2, withoutFetch: [], textWithoutHash: [], textNotOpened: [], missingText: [], sourceMismatch: [] };
  it("passes with every item tried by the fetcher and every text opened, hashed and stored", () => {
    expect(evidenceCriterion([passed("evidence")], facts)).toMatchObject({ status: "pass", measured: expect.stringContaining("3 item(s) of 2 researcher suggestion(s), 2 opened with a stored text, 1 still pending") });
  });
  it("fails on an item the fetcher never tried, a text without its hash, a text it did not open, a text not in the store", () => {
    const note = evidenceCriterion([passed("evidence")], { ...facts, withoutFetch: ["e1"], textWithoutHash: ["e2"], textNotOpened: ["e3"], missingText: ["e4"], sourceMismatch: ["e5"] }).note;
    for (const said of ["with no fetch status: e1", "a text and no hash, or a hash and no text: e2", "a text the fetcher did not open: e3", "whose text the store does not hold: e4", "whose source is not what the fetcher hashed: e5"]) expect(note).toContain(said);
  });
  it("is blocked without the database", () => {
    expect(evidenceCriterion([passed("evidence")], { blocked: "DATABASE_URL" }).status).toBe("blocked");
  });
});

describe("R6: a curator before every merge", () => {
  it("passes with every merged researcher's suggestion accepted first and the policy's tests passing; fails otherwise; blocked without opa", () => {
    expect(curatorFirstCriterion([passed("paths")], { passed: 74, failed: 0, total: 74 }, { merged: 1, withoutAccept: [] })).toMatchObject({ status: "pass", measured: expect.stringContaining("1 researcher suggestion(s) merged, 1 after a curator's accept · opa 74/74") });
    expect(curatorFirstCriterion([passed("paths")], { passed: 74, failed: 0, total: 74 }, { merged: 1, withoutAccept: ["S-21-0001"] }).note).toContain("merged with no curator's accept before: S-21-0001");
    expect(curatorFirstCriterion([passed("paths")], { passed: 73, failed: 1, total: 74 }, { merged: 0, withoutAccept: [] }).status).toBe("fail");
    expect(curatorFirstCriterion([passed("paths")], { blocked: "opa could not be run" }, { merged: 0, withoutAccept: [] }).status).toBe("blocked");
  });
});

describe("R9: whose budget a run spends", () => {
  it("passes with no person's run on the platform's principal and no month past its cap; fails on either; blocked without the database", () => {
    const facts: ResearchBudgetFacts = { principal: "org:o1", personRunsOnPlatform: [], personCalls: 12, months: [{ month: "2026-10", spentUsd: 0.89, capUsd: 20 }] };
    expect(budgetCriterion([passed("cap")], facts)).toMatchObject({ status: "pass", measured: "2/2 tests passed · 0 person's run(s) on the platform · 12 research call(s) of people's runs on their own principals · 2026-10 $0.89 of $20.00" });
    expect(budgetCriterion([passed("cap")], { ...facts, personRunsOnPlatform: ["r1", "r2"] }).note).toContain("2 person's run(s) with a call on the platform's research principal: r1, r2");
    expect(budgetCriterion([passed("cap")], { ...facts, months: [{ month: "2026-10", spentUsd: 20.4, capUsd: 20 }] }).note).toContain("2026-10: $20.40 past the cap of $20.00");
    expect(budgetCriterion([passed("cap")], { ...facts, principal: null, months: [] })).toMatchObject({ status: "pass", measured: expect.stringContaining("no platform month spent"), note: expect.stringContaining("no research principal here") });
    expect(budgetCriterion([passed("cap")], { blocked: "no database" }).status).toBe("blocked");
  });
});

describe("R11: the one paid call", () => {
  const facts = { at: "2026-10-10T20:00:00.000Z", toolsCarried: true, fetchCarried: true, searches: 1, fetches: 1, costUsd: 0.04, searchFeeUsd: 0.01, gatewayDeltaUsd: 0.04 };
  it("is blocked, naming the command, until the check's report exists", () => {
    expect(checkCriterion(null)).toMatchObject({ status: "blocked", note: expect.stringContaining("npm run research:check") });
  });
  it("passes on a report with both tools carried and a cost; fails on one without", () => {
    expect(checkCriterion({ file: "pipeline/reports/research-check-2026-10-10.json", facts })).toMatchObject({ status: "pass", measured: expect.stringContaining("tools carried · fetch carried") });
    expect(checkCriterion({ file: "f", facts: { ...facts, fetchCarried: false } }).note).toContain("did not carry the fetch tool's blocks");
    expect(checkCriterion({ file: "f", facts: { ...facts, costUsd: 0 } }).status).toBe("fail");
  });
});

describe("§ 3's measures and the report", () => {
  const facts: MeasureFacts = {
    realRun: true,
    runs: { all: 10, reachedReader: 6, plannedNothing: 3 },
    spend: { usd: 3, runsRead: 6 },
    findings: { all: 9, PROPOSED: 2, REFUTED: 3, INVALID: 4 },
    refutedBy: { floor: 2, adjudicatorRequest: 1 },
    refutedTiers: { G: 2, U: 1 },
    decided: { accepted: 1, declined: 1 },
    merged: { merged: 1, reverted: 0 },
    agreement: { research: { agreed: 1, decided: 2 }, people: { agreed: 9, decided: 10 } },
    endorsement: { shown: 2, endorsed: 1 },
    toShownMs: [600_000, 900_000],
    toShownSkipped: 0,
    toDecisionMs: [3_600_000, 9 * 86_400_000],
  };
  it("words each measure with its counts, and none as measured until a real run exists", () => {
    const measures = researchMeasures(facts);
    expect(measures.map((measure) => measure.name)).toEqual(["cost of a run", "what a run yields", "what Improve does with findings", "the strongest tier of refuted findings", "the researcher's precision", "the adjudicator on research", "endorsement", "time"]);
    expect(measures[0]?.value).toBe("$0.5000 a run that read ($3.0000 over 6, whoever paid)");
    expect(measures[1]?.value).toBe("1.50 finding(s) a run that planned a brief (6) · planned nothing 30.0 % (3/10)");
    expect(measures[4]?.value).toBe("accepted 50.0 % (1/2) of the proposals a curator decided · reverted 0.0 % (0/1) of those merged");
    expect(measures[7]?.value).toContain("50.0 % (1/2) within 7 days");
    expect(measures[7]?.value).not.toContain("skipped");
    /* a finding whose detached run the sweep deleted is skipped, and said (45 § 3.5) */
    expect(researchMeasures({ ...facts, toShownSkipped: 2 })[7]?.value).toContain("over 2 (2 skipped: no run left)");
    expect(researchMeasures({ ...facts, realRun: false }).every((measure) => measure.value.startsWith("not yet measured"))).toBe(true);
  });

  it("is met only when every criterion passes, and prints the measures beneath", () => {
    const pass = suitesCriterion("R2", [passed("the thirty")], "how");
    const blocked = checkCriterion(null);
    const report = researchReport({ release: "2026.09", appUrl: "http://localhost:3000", startedAt: "a", finishedAt: "b", criteria: [pass, blocked], measures: researchMeasures(facts), measuredFrom: "from the rows", outcomes: [{ file: "C:/app/lib/research/x.test.ts", name: "n", status: "passed" }] });
    expect(report).toMatchObject({ phase: 5, met: false, suites: [{ file: "lib/research/x.test.ts", passed: 1, failed: 0, total: 1 }] });
    expect(researchReport({ release: "r", appUrl: "u", startedAt: "a", finishedAt: "b", criteria: [pass], measures: [], measuredFrom: "", outcomes: [] }).met).toBe(true);
    expect(formatResearchExtras(report)).toContain("none has a target and none moves the exit");
  });
});
