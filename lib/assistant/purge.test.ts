import { describe, expect, it } from "vitest";

import { purgedModeResult } from "./purge";

/*
 * The purge of a stored mode result (feature-specs/21 § 3): the model's sentences go, the script's numbers and the
 * run's table stay, and a value with nothing of the model's in it comes back unchanged so the purge writes nothing.
 */

const WALK = {
  aidId: "21.8-task-survival",
  inputs: { steps: 11, calls: 13, tokens_per_step: 7500 },
  run: { exitCode: 0, timedOut: false, ms: 640 },
  pricesVerifiedAt: null,
  sameAsBook: true,
  steps: [{ ordinal: 2, titleKey: "noFailure", line: 8, pricesFrom: null, values: { p: 0.769 }, bars: [{ labelKey: "f2", tone: "ver", unit: "%", shown: 76.9, width: 87.6 }], headline: { kind: "pct", percent: 76.9 }, missing: [] }],
  explanations: [{ ordinal: 2, text: "At a 2% rate, 13 calls survive with probability 76.9%.", withheld: false }],
};

const LAB = {
  reproduces: "The survival arithmetic of chapter 21.",
  divergingMeans: "A diverging figure would mean the chapter and its script disagree.",
  lab: { labId: "lab-21", number: 21, title: "Control plane", verdict: "REPRODUCED", checkedAt: "2026-09-23T11:00:11.122Z", expectedRuntimeS: null, declaresModelCalls: false, figures: [{ figureId: "F-21-06", sectionId: "21.3", label: "no failure", key: "p", chapterValue: "77%", runValue: 0.769, verdict: "match", line: 8 }] },
};

describe("purgedModeResult", () => {
  it("keeps a walk's run, values and bars and empties its explanations", () => {
    const purged = purgedModeResult("WALK", WALK) as typeof WALK;
    expect(purged.explanations).toEqual([{ ordinal: 2, text: "", withheld: false }]);
    expect(purged.steps).toEqual(WALK.steps);
    expect(purged.run).toEqual(WALK.run);
    expect(purged.inputs).toEqual(WALK.inputs);
  });

  it("keeps a lab's run table and drops the model's two lines", () => {
    const purged = purgedModeResult("lab", LAB) as typeof LAB;
    expect(purged.reproduces).toBe("");
    expect(purged.divergingMeans).toBeNull();
    expect(purged.lab).toEqual(LAB.lab);
  });

  it("drops a compare's open point and a brief's decision and condition, keeping the stance", () => {
    expect(purgedModeResult("COMPARE", { openPoint: "Who owns the key." })).toEqual({ openPoint: null });
    expect(purgedModeResult("BRIEF", { decision: "route review first", stance: "conditional", condition: "while escalation stays low" })).toEqual({ stance: "conditional" });
  });

  it("is idempotent, and leaves alone what holds none of the model's words", () => {
    const once = purgedModeResult("WALK", WALK);
    expect(purgedModeResult("WALK", once)).toEqual(once);
    /* The same value, by identity, whatever order its keys come back in: that is how the purge knows not to write. */
    expect(purgedModeResult("WALK", once)).toBe(once);
    const reordered = { explanations: [{ withheld: false, text: "", ordinal: 2 }], steps: WALK.steps, sameAsBook: true, pricesVerifiedAt: null, run: WALK.run, inputs: WALK.inputs, aidId: WALK.aidId };
    expect(purgedModeResult("WALK", reordered)).toBe(reordered);
    const lab = purgedModeResult("LAB", LAB);
    expect(purgedModeResult("LAB", lab)).toBe(lab);
    const open = { openPoint: null };
    expect(purgedModeResult("COMPARE", open)).toBe(open);
    const stance = { stance: "conditional" };
    expect(purgedModeResult("BRIEF", stance)).toBe(stance);
    expect(purgedModeResult("LAB", purgedModeResult("LAB", LAB))).toEqual(purgedModeResult("LAB", LAB));
    expect(purgedModeResult("EXPLAIN", null)).toBeNull();
    expect(purgedModeResult("WALK", { something: "else" })).toEqual({ something: "else" });
    expect(purgedModeResult("COMPARE", { openPoint: null })).toEqual({ openPoint: null });
  });
});
