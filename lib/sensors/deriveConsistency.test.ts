import { describe, expect, it } from "vitest";

import { WITHHELD } from "@/lib/schemas/assistant";

import { deriveSensor, normaliseNumber, numbersOf, quotedNumbers } from "./deriveConsistency";

/*
 * The derive sensor (feature-specs/18 § 4, § 12.4): an explanation may quote only numbers the fenced aid result
 * carries. The fences here are lab 37's and lab 21's results at the book's inputs, as `aidResultForPrompt` shapes
 * them.
 */

const FENCE = {
  aid: "37.8-which-configuration",
  inputs: { qpd: 2000, tout: 400, tcache: 4000, esc: 10, route: 90 },
  steps: [
    { step: 1, line: null, values: {}, bars: [], headline: null, missing: [] },
    {
      step: 2,
      line: 24,
      values: { queries_per_month: 60000, "A/total": 810, "C/total": 237.59999999999997, saving_A_to_C_pct: 70.7 },
      bars: [
        { label: "a", value: 810, unit: "USD/month" },
        { label: "c", value: 237.6, unit: "USD/month" },
      ],
      headline: { kind: "ratio", times: 3.4 },
      missing: [],
    },
    { step: 3, line: 39, values: { "sensitivity_B/esc/0.0": 420, "sensitivity_B/esc/0.3": 780, C_total_route70: 305 }, bars: [], headline: null, missing: [] },
    { step: 4, line: 33, values: { breakeven_vs_C_queries: 1433086 }, bars: [], headline: { kind: "value", value: 1433086, unit: "queries per month" }, missing: [] },
  ],
};

/* Lab 21's keys carry the rates and counts the values were computed at; the first real walk quoted exactly these. */
const CH21 = {
  aid: "21.8-task-survival",
  inputs: { steps: 11, calls: 13, tokens_per_step: 7500 },
  steps: [
    { step: 2, line: 8, values: { "p_no_failure_13calls_f0.01": 0.878, "p_no_failure_13calls_f0.02": 0.769, "p_no_failure_13calls_f0.05": 0.513 }, bars: [{ label: "f2", value: 76.9, unit: "%" }], headline: { kind: "pct", percent: 76.9 }, missing: [] },
    { step: 4, line: 17, values: { expected_redo_fraction_no_checkpoint: 0.455, extra_tokens_per_1000_tasks_no_checkpoint: 75075 }, bars: [], headline: { kind: "pct", percent: 45.5 }, missing: [] },
  ],
};

const NUMBERS = numbersOf(FENCE);

describe("the derive sensor", () => {
  it("collects every number the fence carries, once, as a value or inside a key", () => {
    expect(NUMBERS).toEqual(expect.arrayContaining([2000, 10, 60000, 810, 237.59999999999997, 237.6, 70.7, 3.4, 1433086, 24, 2, 0, 0.3, 70]));
    expect(new Set(NUMBERS).size).toBe(NUMBERS.length);
    expect(numbersOf(CH21)).toEqual(expect.arrayContaining([13, 0.01, 0.02, 0.05, 1000, 0.769, 76.9]));
  });

  it("reads a quoted number through its separators and suffixes, and remembers a percent", () => {
    expect(normaliseNumber("1,433,086 queries")).toBe(1433086);
    expect(normaliseNumber("3.4×")).toBe(3.4);
    expect(normaliseNumber("70.7%")).toBe(70.7);
    expect(quotedNumbers("A costs 810 USD and C 237.6 USD: 3.4× cheaper, a 70.7% saving.").map(({ value, percent }) => [value, percent])).toEqual([
      [810, false],
      [237.6, false],
      [3.4, false],
      [70.7, true],
    ]);
  });

  it("sets names that look like numbers aside: a section, a figure, a step, a script line", () => {
    expect(quotedNumbers("Step 2 of 37.8, Figure 3 and Lab 37, from derive L24.")).toEqual([]);
    expect(quotedNumbers("passo 2 da 21.3")).toEqual([]);
    /* A two-digit value with one decimal is not a section reference when no chapter has that number. */
    expect(quotedNumbers("a saving of 62.4").map(({ value }) => value)).toEqual([62.4]);
  });

  it("passes an explanation whose every number the script wrote, however it is written", () => {
    const result = deriveSensor(
      [{ ordinal: 2, text: "At 60,000 queries per month A costs 810 USD and C 237.6 USD, so C is 3.4× cheaper per task (derive L24): a 70.7% saving." }],
      NUMBERS,
      "en",
    );
    expect(result.explanations[0]).toMatchObject({ ordinal: 2, withheld: false, unmatched: [] });
    expect(result.verdict).toMatchObject({ sensor: "derive", verdict: "PASS", detail: "derive output matched · 1 of 1", data: { total: 1, withheld: 0 } });
  });

  it("takes a quoted percent as the script's fraction, and a rate or count from the script's own keys", () => {
    const result = deriveSensor(
      [
        { ordinal: 2, text: "At a 2% per-call failure rate, 13 calls survive with probability 0.769, that is 76.9%; at 1% it is 87.8% and at 5% 51.3%." },
        { ordinal: 4, text: "Without checkpoints 45.5% of the work is redone, about 75,075 extra tokens per 1,000 tasks." },
        { ordinal: 3, text: "With escalation at 30% rather than 0%, B costs 780 against 420; routing 70% to the small model gives 305." },
      ],
      [...numbersOf(CH21), ...NUMBERS],
      "en",
    );
    expect(result.explanations.map((explanation) => explanation.withheld)).toEqual([false, false, false]);
    expect(result.verdict.verdict).toBe("PASS");
  });

  it("withholds an explanation that quotes a number the script did not write, and keeps the others", () => {
    const result = deriveSensor(
      [
        { ordinal: 1, text: "The inputs are the book's: 2,000 queries a day, 400 output tokens, 4,000 cached, 10% escalation, 90% routed." },
        { ordinal: 2, text: "C is 42× cheaper than A." },
        { ordinal: 4, text: "D breaks even against C at 1,433,086 queries per month." },
      ],
      NUMBERS,
      "en",
    );
    expect(result.explanations.map((explanation) => explanation.withheld)).toEqual([false, true, false]);
    expect(result.explanations[1]).toEqual({ ordinal: 2, text: WITHHELD.en, withheld: true, unmatched: ["42×"] });
    expect(result.verdict).toMatchObject({ verdict: "WARN", detail: "derive output matched · 2 of 3", data: { total: 3, withheld: 1, unmatched: "42×" } });
  });

  it("speaks the reader's language when it withholds, and says NA when there is nothing to check", () => {
    expect(deriveSensor([{ ordinal: 2, text: "C é 42× mais barata." }], NUMBERS, "pt").explanations[0]?.text).toBe(WITHHELD.pt);
    expect(deriveSensor([], NUMBERS, "en").verdict).toMatchObject({ verdict: "NA", detail: "no explanations to check" });
  });

  it("tolerates the printing of a value and nothing more: the long float, a fraction to three places, not a rounding away", () => {
    const check = (text: string, numbers = NUMBERS): boolean => deriveSensor([{ ordinal: 2, text }], numbers, "en").explanations[0]?.withheld === true;
    expect(check("C costs 237.59999999999997 USD.")).toBe(false);
    expect(check("C costs 238 USD.")).toBe(true);
    expect(check("Survival with one retry is 0.995.", numbersOf({ v: 0.9948 }))).toBe(false);
    expect(check("Survival is about 0.98.", numbersOf({ v: 0.9948 }))).toBe(true);
    expect(check("Survival is 77%.", numbersOf(CH21))).toBe(true);
  });
});
