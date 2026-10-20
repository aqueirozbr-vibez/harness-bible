import { describe, expect, it } from "vitest";

import { budgetView, type BudgetFacts } from "./view";

/*
 * The budget meter's numbers (feature-specs/21 § 4, § 13.3). The screen's month: 1.84 M of a 2.50 M cap on 21 Sep,
 * which at the frontier input price of $5 a million is $9.20 of $12.50.
 */

const NOW = new Date("2026-09-21T15:00:00Z");

const SCREEN: BudgetFacts = {
  month: "2026-09",
  kinds: [
    { kind: "ASSISTANT", costUsd: "4.2", suggestion: false },
    { kind: "GRADING", costUsd: "1.5", suggestion: false },
    { kind: "LAB", costUsd: "3.5", suggestion: false },
    { kind: "EMBED", costUsd: "0", suggestion: false },
    { kind: "RERANK", costUsd: "0", suggestion: false },
  ],
  answers: 1206,
  suggestions: { grading: 0, adjudication: 0 },
  capTokens: 2_500_000,
};

/** A contributor's month (feature-specs/38 § 2): three suggestions graded, two of them adjudicated, beside the assistant's own grader. */
const CONTRIBUTOR: BudgetFacts = {
  ...SCREEN,
  kinds: [...SCREEN.kinds, { kind: "GRADING", costUsd: "0.6", suggestion: true }, { kind: "ADJUDICATION", costUsd: "0.4", suggestion: true }],
  suggestions: { grading: 3, adjudication: 2 },
};

describe("budgetView", () => {
  it("reads the screen's month: 73.6%, 1.84 M of 2.50 M, 0.66 M left, the cap on 29 Sep", () => {
    const view = budgetView(SCREEN, NOW);
    expect(view.state).toBe("running");
    expect(view.used).toBe(1_840_000);
    expect(view.cap).toBe(2_500_000);
    expect(view.left).toBe(660_000);
    expect(view.percent?.toFixed(1)).toBe("73.6");
    expect(view.share).toBe(view.percent);
    expect((view.perDay / 1_000_000).toFixed(3)).toBe("0.088");
    expect(view.capDate).toBe("2026-09-29T00:00:00.000Z");
    expect(view.monthStart).toBe("2026-09-01T00:00:00.000Z");
    expect(view.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("puts the assistant's grader in the assistant's row, counts the answers, and has the rows sum to what was used", () => {
    const view = budgetView(SCREEN, NOW);
    expect(view.rows).toEqual([
      { consumer: "assistant", tokens: 1_140_000, share: expect.closeTo(45.6, 6) as number },
      { consumer: "research", tokens: 0, share: 0 },
      { consumer: "grading", tokens: 0, share: 0 },
      { consumer: "adjudication", tokens: 0, share: 0 },
      { consumer: "retrieval", tokens: 0, share: 0 },
      { consumer: "labs", tokens: 700_000, share: expect.closeTo(28, 6) as number },
    ]);
    expect(view.answers).toBe(1206);
    expect(view.suggestions).toEqual({ grading: 0, adjudication: 0 });
    expect(view.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(view.used);
  });

  it("gives a contributor's grading and adjudication their own rows, by the suggestion the calls served, and the rows still sum to the total (38 § 2)", () => {
    const view = budgetView(CONTRIBUTOR, NOW);
    expect(view.used).toBe(2_040_000);
    expect(view.rows).toEqual([
      { consumer: "assistant", tokens: 1_140_000, share: expect.closeTo(45.6, 6) as number },
      { consumer: "research", tokens: 0, share: 0 },
      { consumer: "grading", tokens: 120_000, share: expect.closeTo(4.8, 6) as number },
      { consumer: "adjudication", tokens: 80_000, share: expect.closeTo(3.2, 6) as number },
      { consumer: "retrieval", tokens: 0, share: 0 },
      { consumer: "labs", tokens: 700_000, share: expect.closeTo(28, 6) as number },
    ]);
    expect(view.suggestions).toEqual({ grading: 3, adjudication: 2 });
    expect(view.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(view.used);
    /* The assistant's answers are its own: the grader's calls that served a suggestion are not among them. */
    expect(view.answers).toBe(1206);
  });

  it("is empty with no rows this month, and still names the cap and the reset", () => {
    const view = budgetView({ ...SCREEN, kinds: [], answers: 0 }, NOW);
    expect(view).toMatchObject({ state: "empty", used: 0, left: 2_500_000, percent: 0, perDay: 0, capDate: null, resetsAt: "2026-10-01T00:00:00.000Z" });
    expect(view.rows.map((row) => row.tokens)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("stops at 100% at the cap and past it, with nothing left and no projection", () => {
    const at = budgetView({ ...SCREEN, kinds: [{ kind: "ASSISTANT", costUsd: "12.5", suggestion: false }] }, NOW);
    expect(at).toMatchObject({ state: "atcap", used: 2_500_000, left: 0, percent: 100, capDate: null });
    const past = budgetView({ ...SCREEN, kinds: [{ kind: "ASSISTANT", costUsd: "12.9", suggestion: false }] }, NOW);
    expect(past).toMatchObject({ state: "atcap", used: 2_580_000, left: 0, percent: 100 });
    /* The headline stops at the cap; the breakdown keeps the call that crossed it, so its rows still sum to its total. */
    expect(past.share).toBeCloseTo(103.2, 6);
    expect(past.rows[0]?.share).toBeCloseTo(103.2, 6);
    expect(budgetView({ ...SCREEN, kinds: [], capTokens: 0 }, NOW)).toMatchObject({ state: "atcap", percent: 100, share: null, left: 0 });
  });

  it("has no percentage, nothing left to name and no projection without a cap", () => {
    const view = budgetView({ ...SCREEN, capTokens: null }, NOW);
    expect(view).toMatchObject({ state: "nocap", used: 1_840_000, cap: null, left: null, percent: null, share: null, capDate: null, perDay: 0 });
    expect(view.rows.every((row) => row.share === null)).toBe(true);
  });

  it("says the pace does not reach the cap when it does not", () => {
    const view = budgetView({ ...SCREEN, kinds: [{ kind: "ASSISTANT", costUsd: "1.5", suggestion: false }] }, NOW);
    expect(view).toMatchObject({ state: "running", used: 300_000, capDate: null });
    expect(view.perDay).toBeCloseTo(14_285.71, 1);
  });

  it("has a row for every kind the gateway writes, so the rows always sum to what the gateway counted", () => {
    const kinds: BudgetFacts["kinds"] = [
      { kind: "ASSISTANT", costUsd: "1", suggestion: false },
      { kind: "GRADING", costUsd: "0.5", suggestion: true },
      { kind: "ADJUDICATION", costUsd: "0.5", suggestion: true },
      { kind: "EMBED", costUsd: "0.25", suggestion: false },
      { kind: "RERANK", costUsd: "0.25", suggestion: false },
      { kind: "LAB", costUsd: "0.5", suggestion: false },
      { kind: "RESEARCH", costUsd: "0.5", suggestion: false },
    ];
    const view = budgetView({ ...SCREEN, kinds }, NOW);
    expect(view.used).toBe(700_000);
    expect(view.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(700_000);
  });

  it("gives a person's research its own row, beside the assistant's (feature-specs/48 § 7.1)", () => {
    const view = budgetView({ ...SCREEN, kinds: [...SCREEN.kinds, { kind: "RESEARCH", costUsd: "0.6", suggestion: false }] }, NOW);
    expect(view.rows.map((row) => row.consumer)).toEqual(["assistant", "research", "grading", "adjudication", "retrieval", "labs"]);
    expect(view.rows[1]).toEqual({ consumer: "research", tokens: 120_000, share: expect.closeTo(4.8, 6) as number });
    expect(view.used).toBe(1_960_000);
    expect(view.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(view.used);
  });

  it("resets on the first of January after a December", () => {
    expect(budgetView({ ...SCREEN, month: "2026-12" }, new Date("2026-12-05T00:00:00Z")).resetsAt).toBe("2027-01-01T00:00:00.000Z");
  });
});
