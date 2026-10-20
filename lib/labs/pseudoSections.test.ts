import { describe, expect, it } from "vitest";

import { parseFigureId, parseSectionId } from "@/lib/schemas/ids";

import { checkedFigures, type LabFigureInput } from "./checkedFigures";
import { factsLine, labModeResultOf, lastRunText, pseudoId, readmeText, runtimeText, type LabFacts } from "./pseudoSections";

/*
 * The two pseudo-sections of lab mode (feature-specs/19 § 4, § 12.3), on a chapter 21 fixture: the README under its
 * facts line, the last run with one line per checked figure, and the shape the turn stores for the dock.
 */

const DERIVED = { "p_no_failure_13calls_f0.02": 0.769, "p_no_failure_13calls_f0.05": 0.513, "task_success_f0.02_retries1": 0.9948, "backoff_schedule_s": [1, 2, 4, 8, 16, 30] };

function figure(id: string, valueText: string, key: string): LabFigureInput {
  return { figureId: parseFigureId(id), sectionId: parseSectionId("21.3"), label: `figure ${id}`, valueText, tier: "DERIVED", key, line: 8, filePath: "derive.py" };
}

const FIGURES = [figure("F-21-06", "77%", "p_no_failure_13calls_f0.02"), figure("F-21-08", "51%", "p_no_failure_13calls_f0.05"), figure("F-21-09", "99.5%", "task_success_f0.02_retries1"), figure("F-21-24", "30", "backoff_schedule_s[5]")];

const FACTS: LabFacts = {
  labId: "lab-21",
  number: 21,
  title: "Control plane and durable execution",
  expectedRuntimeS: 120,
  declaresModelCalls: false,
  egressExtra: [],
  ciVerdict: "REPRODUCED",
  ciCheckedAt: "2026-09-23T11:00:11.122Z",
  figures: checkedFigures(FIGURES, DERIVED),
};

describe("the lab pseudo-sections", () => {
  it("names them by lab and kind", () => {
    expect(pseudoId("lab-21", "readme")).toBe("lab:lab-21:readme");
    expect(pseudoId("lab-21", "lastRun")).toBe("lab:lab-21:lastRun");
  });

  it("opens the README with the facts line", () => {
    expect(factsLine(FACTS)).toBe("Lab 21 · expected runtime 2 m · model calls: none · egress: none");
    expect(readmeText(FACTS, "  # Lab 21\n\nReproduces the survival curve.\n")).toBe("Lab 21 · expected runtime 2 m · model calls: none · egress: none\n\n# Lab 21\n\nReproduces the survival curve.");
    expect(factsLine({ ...FACTS, expectedRuntimeS: null, declaresModelCalls: true, egressExtra: ["pypi.org"] })).toBe("Lab 21 · expected runtime not declared · model calls: declared · egress: pypi.org");
    expect([45, 60, 168].map(runtimeText)).toEqual(["45 s", "1 m", "2 m 48 s"]);
  });

  it("lists the last run and one line per checked figure, values from the Figure rows and the run", () => {
    expect(lastRunText(FACTS).split("\n")).toEqual([
      "last run: REPRODUCED · CI · 23 Sep 2026",
      "F-21-06 p_no_failure_13calls_f0.02 · chapter 77% · last run 0.769 · match",
      "F-21-08 p_no_failure_13calls_f0.05 · chapter 51% · last run 0.513 · match",
      "F-21-09 task_success_f0.02_retries1 · chapter 99.5% · last run 0.9948 · match",
      "F-21-24 backoff_schedule_s[5] · chapter 30 · last run 30 · match",
    ]);
  });

  it("says `last run: none` when CI never ran, and `—` for a key the run did not write", () => {
    const never: LabFacts = { ...FACTS, ciVerdict: null, ciCheckedAt: null, figures: checkedFigures(FIGURES.slice(0, 1), {}) };
    expect(lastRunText(never).split("\n")).toEqual(["last run: none", "F-21-06 p_no_failure_13calls_f0.02 · chapter 77% · last run — · missing"]);
  });

  it("shapes the turn's result from the model's sentences and the run's table", () => {
    const result = labModeResultOf({ reproduces: "The survival curve.", divergingMeans: null }, FACTS);
    expect(result.reproduces).toBe("The survival curve.");
    expect(result.lab).toMatchObject({ labId: "lab-21", number: 21, verdict: "REPRODUCED", checkedAt: "2026-09-23T11:00:11.122Z", expectedRuntimeS: 120 });
    expect(result.lab.figures.map((entry) => [entry.figureId, entry.verdict])).toEqual([
      ["F-21-06", "match"],
      ["F-21-08", "match"],
      ["F-21-09", "match"],
      ["F-21-24", "match"],
    ]);
    expect(labModeResultOf(null, FACTS).reproduces).toBe("");
  });
});
