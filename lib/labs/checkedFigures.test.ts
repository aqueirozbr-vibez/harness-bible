import { describe, expect, it } from "vitest";

import { parseFigureId, parseSectionId } from "@/lib/schemas/ids";

import { checkFigure, checkedFigures, derivedValue, matchesPrinted, parsePrinted, type LabFigureInput } from "./checkedFigures";

/*
 * The figures a lab checks against its last run (feature-specs/19 § 4, § 12.3): chapter 21's derive links as the
 * release stores them, against CI's derived.json for lab 21. The comparison is at the chapter's printed precision.
 */

const DERIVED = {
  timestamp: "2026-09-23T11:00:11.003216+00:00",
  backoff_schedule_s: [1, 2, 4, 8, 16, 30],
  "p_no_failure_13calls_f0.02": 0.769,
  "p_no_failure_13calls_f0.05": 0.513,
  "task_success_f0.02_retries1": 0.9948,
  "task_success_f0.05_retries1": 0.968,
  "task_success_f0.02_retries3": 1,
  expected_redo_fraction_no_checkpoint: 0.455,
  gopher_compute: "5.04e+23",
  nested: { A: { total: 810 } },
};

function figure(id: string, valueText: string, key: string): LabFigureInput {
  return { figureId: parseFigureId(id), sectionId: parseSectionId("21.3"), label: `figure ${id}`, valueText, tier: "DERIVED", key, line: 8, filePath: "derive.py" };
}

describe("the derived value under a key", () => {
  it("reads a plain key, a list element and a slash path, and says when the run did not write it", () => {
    expect(derivedValue(DERIVED, "p_no_failure_13calls_f0.02")).toBe(0.769);
    expect(derivedValue(DERIVED, "backoff_schedule_s[5]")).toBe(30);
    expect(derivedValue(DERIVED, "nested/A/total")).toBe(810);
    expect(derivedValue(DERIVED, "not_written")).toBeUndefined();
    expect(derivedValue(DERIVED, "backoff_schedule_s[9]")).toBeUndefined();
    expect(derivedValue(null, "x")).toBeUndefined();
  });
});

describe("the printed precision", () => {
  it("reads what the chapter prints: the number, whether it is a percent, and how many decimals", () => {
    expect(parsePrinted("77%")).toEqual({ value: 77, percent: true, decimals: 0, exponent: 0 });
    expect(parsePrinted("99.5%")).toEqual({ value: 99.5, percent: true, decimals: 1, exponent: 0 });
    expect(parsePrinted("1,433,086 queries")).toMatchObject({ value: 1433086, percent: false, decimals: 0 });
    expect(parsePrinted("5.04e+23")).toMatchObject({ value: 5.04e23, decimals: 2, exponent: 23 });
    expect(parsePrinted("open")).toBeNull();
  });

  it("holds the run to half a unit of the last printed digit, in the chapter's units", () => {
    expect(matchesPrinted(parsePrinted("77%")!, 0.769)).toBe(true);
    expect(matchesPrinted(parsePrinted("45%")!, 0.455)).toBe(true);
    expect(matchesPrinted(parsePrinted("99.5%")!, 0.9948)).toBe(true);
    expect(matchesPrinted(parsePrinted("100%")!, 1)).toBe(true);
    expect(matchesPrinted(parsePrinted("77%")!, 0.8)).toBe(false);
    expect(matchesPrinted(parsePrinted("99.5%")!, 0.99)).toBe(false);
    /* Two printed decimals of a power of ten: anything that prints as 5.04e+23 matches, and 5.046e+23 does not. */
    expect(matchesPrinted(parsePrinted("5.04e+23")!, 5.0401e23)).toBe(true);
    expect(matchesPrinted(parsePrinted("5.04e+23")!, 5.044e23)).toBe(true);
    expect(matchesPrinted(parsePrinted("5.04e+23")!, 5.046e23)).toBe(false);
  });
});

describe("checkFigure", () => {
  it("matches chapter 21's figures to CI's run, including a list element and a numeric string", () => {
    const rows = checkedFigures(
      [
        figure("F-21-14", "45%", "expected_redo_fraction_no_checkpoint"),
        figure("F-21-06", "77%", "p_no_failure_13calls_f0.02"),
        figure("F-21-24", "30", "backoff_schedule_s[5]"),
        figure("F-21-09", "99.5%", "task_success_f0.02_retries1"),
        figure("F-21-30", "5.04e+23", "gopher_compute"),
      ],
      DERIVED,
    );
    expect(rows.map((row) => [row.figureId, row.runValue, row.verdict])).toEqual([
      ["F-21-06", 0.769, "match"],
      ["F-21-09", 0.9948, "match"],
      ["F-21-14", 0.455, "match"],
      ["F-21-24", 30, "match"],
      ["F-21-30", 5.04e23, "match"],
    ]);
  });

  it("says diverge when the run disagrees, and missing with no value when the run did not write the key", () => {
    expect(checkFigure(figure("F-21-06", "77%", "p_no_failure_13calls_f0.05"), DERIVED)).toMatchObject({ runValue: 0.513, verdict: "diverge" });
    expect(checkFigure(figure("F-21-06", "77%", "never_written"), DERIVED)).toMatchObject({ runValue: null, verdict: "missing", chapterValue: "77%" });
    expect(checkFigure(figure("F-21-06", "77%", "p_no_failure_13calls_f0.02"), {})).toMatchObject({ verdict: "missing" });
  });

  it("compares a value that is not a number as text", () => {
    expect(checkFigure(figure("F-21-40", "written", "status"), { status: "written" }).verdict).toBe("match");
    expect(checkFigure(figure("F-21-40", "written", "status"), { status: "failed" }).verdict).toBe("diverge");
  });
});
