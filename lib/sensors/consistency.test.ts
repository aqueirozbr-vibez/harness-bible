import { describe, expect, it } from "vitest";

import { consistencySensors, crossChapterSensor, deriveConsistencySensor, lintSensor, type Reading } from "./consistency";

/* The three consistency sensors (feature-specs/33 § 4.2), each answer on facts alone. */

function reading(anchor: string, section: string, rule: Reading["rule"], settable = true): Reading {
  return { anchor, section, part: section.startsWith("37") ? "P3" : "P2", rule, settable };
}

describe("DERIVE_CONSISTENCY", () => {
  it("is not this sensor's for anything but a derived figure", () => {
    expect(deriveConsistencySensor({ figure: null, proposed: null, labRuns: [] }).result).toBe("NA");
    expect(deriveConsistencySensor({ figure: { id: "F-21-15", tier: "ILLUSTRATIVE" }, proposed: "600", labRuns: [] }).result).toBe("NA");
  });

  it("fails a derived figure no tier A run changed, which is every one in this build (invariant 5)", () => {
    expect(deriveConsistencySensor({ figure: { id: "F-21-06", tier: "DERIVED" }, proposed: "78%", labRuns: [] })).toEqual({
      sensor: "DERIVE_CONSISTENCY",
      result: "FAIL",
      detail: "F-21-06 is derived: it changes only with its script, and no tier A run changed derive.py and printed 78%",
      data: { figure: "F-21-06", labRuns: 0 },
    });
    expect(deriveConsistencySensor({ figure: { id: "F-21-06", tier: "DERIVED" }, proposed: "78%", labRuns: [{ changedScript: true, printed: "77%" }] }).result).toBe("FAIL");
  });

  it("passes a run that changed the script and printed the value proposed", () => {
    expect(deriveConsistencySensor({ figure: { id: "F-21-06", tier: "DERIVED" }, proposed: "78%", labRuns: [{ changedScript: true, printed: "78%" }] }).result).toBe("PASS");
  });
});

describe("CROSS_CHAPTER", () => {
  it("passes an anchor nothing else reads", () => {
    expect(crossChapterSensor({ anchor: "F-21-15", parts: ["P2"], setsValue: true, readings: [] })).toMatchObject({ result: "PASS", detail: "nothing else reads F-21-15" });
  });

  it("warns, naming every other reading in the screen's words and the parts to add, and never declines", () => {
    const warned = crossChapterSensor({ anchor: "F-23-06", parts: ["P2"], setsValue: true, readings: [reading("F-37-12", "37.4", "figure")] });
    expect(warned).toEqual({ sensor: "CROSS_CHAPTER", result: "WARN", detail: "F-23-06 also at 37.4 — a change would need both", data: { readings: [{ anchor: "F-37-12", section: "37.4", rule: "figure" }], parts: ["P3"] } });
    const rows = crossChapterSensor({ anchor: "21.9 r9", parts: ["P2"], setsValue: false, readings: [reading("F-21-01", "21.1", "row"), reading("F-21-30", "21.3", "row")] });
    expect(rows).toMatchObject({ result: "WARN", detail: "21.9 r9 also at 21.1, 21.3 — a change would need all of them", data: { parts: [] } });
  });

  it("fails only a value set on a figure whose other reading cannot take it", () => {
    const facts = { anchor: "F-23-06", parts: ["P2" as const], readings: [reading("F-37-12", "37.4", "figure", false)] };
    expect(crossChapterSensor({ ...facts, setsValue: true })).toMatchObject({ result: "FAIL", detail: "F-23-06 is also F-37-12 at 37.4, which the edit cannot set to the value: the two would disagree" });
    /* a wording change near it is still only a warning */
    expect(crossChapterSensor({ ...facts, setsValue: false }).result).toBe("WARN");
  });
});

describe("LINT", () => {
  it("passes a change that applies, fails one refused as a fault, and leaves to a curator what is made by hand (Andre, 2026-10-07)", () => {
    expect(lintSensor({ changeKind: "SET_VALUE", applied: { applied: true } }).result).toBe("PASS");
    expect(lintSensor({ changeKind: "EDIT_ROW", applied: { refused: "unexpected-change", row: "21.2", detail: "a source chip names no row instead of 21.9 r1" } })).toMatchObject({ result: "FAIL", detail: "unexpected-change: 21.2, a source chip names no row instead of 21.9 r1" });
    expect(lintSensor({ changeKind: "SET_VALUE", applied: { refused: "manual", row: "F-21-07", detail: "a scenario parameter of the lab changes with its script (invariant 5)" } }).result).toBe("NA");
    expect(lintSensor({ changeKind: "RESTRUCTURE", applied: { refused: "manual", row: "21.3", detail: "a restructure is made by hand" } }).result).toBe("NA");
    expect(lintSensor({ changeKind: "EDIT_TEXT", applied: null })).toMatchObject({ result: "NA", detail: "the files read are not the release's, so the change could not be applied" });
  });
});

describe("consistencySensors", () => {
  it("answers the three in the spec's order", () => {
    const verdicts = consistencySensors({
      derive: { figure: null, proposed: null, labRuns: [] },
      crossChapter: { anchor: "21.3", parts: ["P2"], setsValue: false, readings: [] },
      lint: { changeKind: "EDIT_TEXT", applied: { applied: true } },
    });
    expect(verdicts.map((v) => [v.sensor, v.result])).toEqual([["DERIVE_CONSISTENCY", "NA"], ["CROSS_CHAPTER", "PASS"], ["LINT", "PASS"]]);
  });
});
