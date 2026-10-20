import { describe, expect, it } from "vitest";

import { CHANGE_CLASSES, DECISIONS, SUGGESTION_SENSORS } from "@/lib/schemas/improve";
import { EXAMPLE_1, EXAMPLE_3, EXAMPLE_4, RUBRIC_V1_2, WORKED_EXAMPLES } from "@/tests/fixtures/rubric";

import { scoreOf, type GradedItem } from "./score";
import { consistent, predict, routeOf, ROUTES, type Routing, type SensorVerdict } from "./thresholds";

/*
 * The thresholds and the routing (feature-specs/30 § 4.3, § 4.4, § 10.4): where each worked example goes, what the
 * adjudicator may say, and the prediction the form shows, all from rubric v1.2 as data.
 */

const R = RUBRIC_V1_2;

const PASSING: ReadonlyArray<SensorVerdict> = [
  { sensor: "SCHEMA", result: "PASS" },
  { sensor: "ANCHOR_EXISTS", result: "PASS" },
  { sensor: "EVIDENCE_PARSES", result: "PASS" },
  { sensor: "RATIONALE_LENGTH", result: "WARN" },
];
const ONE_FAILED: ReadonlyArray<SensorVerdict> = [...PASSING, { sensor: "ANCHOR_EXISTS", result: "FAIL" }];

const routing = (over: Partial<Routing>): Routing => ({ changeClass: "CITED_FIGURE", score: 66, verdicts: PASSING, strongestTier: "C", ...over });

/** An example's routing as the workflow would assemble it: its class, its score by `scoreOf`, and the strongest item's tier. */
function routingOf(example: (typeof WORKED_EXAMPLES)[number], verdicts: ReadonlyArray<SensorVerdict> = PASSING): Routing {
  const items: GradedItem[] = example.items.map((item) => ({
    id: item.id,
    tier: item.tier,
    opened: true,
    relevance: item.factors[0],
    recency: item.factors[1],
    independence: item.factors[2],
    publisher: item.publisher,
  }));
  const scored = scoreOf(R, items);
  const strongest = example.items.find((item) => item.id === scored.strongestId);
  return { changeClass: example.changeClass, score: scored.score, verdicts, strongestTier: strongest === undefined ? null : strongest.tier };
}

describe("routeOf (30 § 4.4)", () => {
  it("routes the four worked examples as their screens say (§ 7)", () => {
    for (const example of WORKED_EXAMPLES) expect(routeOf(R, routingOf(example)).route, example.id).toBe(example.route);
  });

  it("declines at intake on a failed sensor, at any score and in any class, with no tier named", () => {
    for (const changeClass of CHANGE_CLASSES) {
      for (const score of [0, 66, 100]) {
        expect(routeOf(R, routing({ changeClass, score, verdicts: ONE_FAILED, strongestTier: "A" })), `${changeClass} ${String(score)}`).toEqual({ route: "DECLINE_AT_INTAKE", namedTier: null });
      }
    }
  });

  it("a warning is not a failure", () => {
    expect(routeOf(R, routing({ verdicts: PASSING })).route).toBe("ADJUDICATE");
    expect(routeOf(R, routing({ verdicts: [] })).route).toBe("ADJUDICATE");
  });

  it("sends a curator-always change to the curator, whatever the score", () => {
    for (const score of [0, 66, 110]) expect(routeOf(R, routing({ changeClass: "CURATOR_ALWAYS", score }))).toEqual({ route: "CURATOR", namedTier: null });
  });

  it("declines under the floor and adjudicates from the floor up, class by class", () => {
    const floors = { WORDING: 5, CITED_FIGURE: 25, NEW_CLAIM: 40 } as const;
    for (const [changeClass, floor] of Object.entries(floors) as ReadonlyArray<[keyof typeof floors, number]>) {
      expect(routeOf(R, routing({ changeClass, score: floor - 1 })), changeClass).toEqual({ route: "DECLINE_AT_INTAKE", namedTier: null });
      expect(routeOf(R, routing({ changeClass, score: floor })), changeClass).toEqual({ route: "ADJUDICATE", namedTier: null });
      expect(routeOf(R, routing({ changeClass, score: 100 })), changeClass).toEqual({ route: "ADJUDICATE", namedTier: null });
    }
  });

  it("the derived class: a tier A item under 100 asks for more by rule, naming tier A; no tier A item declines at intake, naming tier A (§ 10.4)", () => {
    expect(routeOf(R, routing({ changeClass: "DERIVED_FIGURE", score: 60, strongestTier: "A" }))).toEqual({ route: "REQUEST_MORE_BY_RULE", namedTier: "A" });
    expect(routeOf(R, routing({ changeClass: "DERIVED_FIGURE", score: 85, strongestTier: "B" }))).toEqual({ route: "DECLINE_AT_INTAKE", namedTier: "A" });
    expect(routeOf(R, routing({ changeClass: "DERIVED_FIGURE", score: 0, strongestTier: null }))).toEqual({ route: "DECLINE_AT_INTAKE", namedTier: "A" });
    expect(routeOf(R, routing({ changeClass: "DERIVED_FIGURE", score: 100, strongestTier: "A" }))).toEqual({ route: "ADJUDICATE", namedTier: null });
  });

  it("names the four routes", () => {
    expect(ROUTES).toEqual(["DECLINE_AT_INTAKE", "REQUEST_MORE_BY_RULE", "CURATOR", "ADJUDICATE"]);
  });
});

describe("consistent (30 § 4.4, § 10.4): what the adjudicator may say", () => {
  it("refuses an accept at 66 against 70, and one at 69; allows one at 70: the acceptance, to the point, in every class", () => {
    expect(consistent(R, "ACCEPT", routing({ score: 66 }))).toBe(false);
    const accepts = { WORDING: 40, CITED_FIGURE: 70, NEW_CLAIM: 85 } as const;
    for (const [changeClass, acceptAt] of Object.entries(accepts) as ReadonlyArray<[keyof typeof accepts, number]>) {
      expect(consistent(R, "ACCEPT", routing({ changeClass, score: acceptAt - 1 })), changeClass).toBe(false);
      expect(consistent(R, "ACCEPT", routing({ changeClass, score: acceptAt })), changeClass).toBe(true);
    }
  });

  it("refuses an accept with a failed sensor, at any score", () => {
    expect(consistent(R, "ACCEPT", routing({ score: 100, verdicts: ONE_FAILED }))).toBe(false);
  });

  it("refuses an accept of a derived figure on tier B, and allows one on tier A at 100", () => {
    expect(consistent(R, "ACCEPT", routing({ changeClass: "DERIVED_FIGURE", score: 100, strongestTier: "B" }))).toBe(false);
    expect(consistent(R, "ACCEPT", routing({ changeClass: "DERIVED_FIGURE", score: 100, strongestTier: "A" }))).toBe(true);
  });

  it("refuses a request for more under the floor, and allows one from the floor up", () => {
    expect(consistent(R, "REQUEST_MORE", routing({ score: 24 }))).toBe(false);
    expect(consistent(R, "REQUEST_MORE", routing({ score: 25 }))).toBe(true);
    expect(consistent(R, "REQUEST_MORE", routing({ score: 66 }))).toBe(true);
  });

  it("allows a decline always", () => {
    for (const score of [0, 24, 66, 100]) expect(consistent(R, "DECLINE", routing({ score })), String(score)).toBe(true);
    expect(consistent(R, "DECLINE", routing({ verdicts: ONE_FAILED }))).toBe(true);
  });

  it("never lets the adjudicator send a suggestion to the curator, or decide a class no score decides", () => {
    expect(consistent(R, "CURATOR_REVIEW", routing({}))).toBe(false);
    for (const decision of DECISIONS) expect(consistent(R, decision, routing({ changeClass: "CURATOR_ALWAYS", score: 100 })), decision).toBe(false);
  });

  it("allows accept for the first worked example and nothing above request more for the fourth", () => {
    expect(consistent(R, "ACCEPT", routingOf(EXAMPLE_1))).toBe(true);
    expect(consistent(R, "ACCEPT", routingOf(EXAMPLE_4))).toBe(false);
    expect(consistent(R, "REQUEST_MORE", routingOf(EXAMPLE_4))).toBe(true);
  });
});

describe("predict (30 § 4.4): the same two, run on a draft", () => {
  it("predicts the four worked examples as their screens print: accept; decline under the floor; request more by rule, short by 40; request more, short by 4", () => {
    for (const example of WORKED_EXAMPLES) {
      const prediction = predict(R, routingOf(example));
      expect(prediction, example.id).toMatchObject({ route: example.route, decision: example.predicted, shortBy: example.shortBy });
    }
    expect(predict(R, routingOf(EXAMPLE_3))).toEqual({ route: "REQUEST_MORE_BY_RULE", namedTier: "A", decision: "REQUEST_MORE", acceptAt: 100, floorAt: 100, shortBy: 40 });
    expect(predict(R, routingOf(EXAMPLE_4))).toEqual({ route: "ADJUDICATE", namedTier: null, decision: "REQUEST_MORE", acceptAt: 70, floorAt: 25, shortBy: 4 });
  });

  it("says the curator decides a curator-always change, with no thresholds, unless a sensor failed", () => {
    expect(predict(R, routing({ changeClass: "CURATOR_ALWAYS", score: 0 }))).toEqual({ route: "CURATOR", namedTier: null, decision: "CURATOR_REVIEW", acceptAt: null, floorAt: null, shortBy: null });
    expect(predict(R, routing({ changeClass: "CURATOR_ALWAYS", score: 0, verdicts: ONE_FAILED }))).toEqual({ route: "DECLINE_AT_INTAKE", namedTier: null, decision: "DECLINE", acceptAt: null, floorAt: null, shortBy: null });
  });

  it("predicts a decline with the thresholds beside it, so the form can say under which floor", () => {
    expect(predict(R, routing({ score: 24 }))).toEqual({ route: "DECLINE_AT_INTAKE", namedTier: null, decision: "DECLINE", acceptAt: 70, floorAt: 25, shortBy: null });
    expect(predict(R, routing({ score: 100, verdicts: ONE_FAILED }))).toEqual({ route: "DECLINE_AT_INTAKE", namedTier: null, decision: "DECLINE", acceptAt: 70, floorAt: 25, shortBy: null });
  });

  it("never disagrees with the route and the consistency it is made of, over every class, score and sensor state", () => {
    for (const changeClass of CHANGE_CLASSES) {
      for (const verdicts of [PASSING, ONE_FAILED]) {
        for (const strongestTier of ["A", "B", null] as const) {
          for (let score = 0; score <= 110; score += 1) {
            const here = routing({ changeClass, score, verdicts, strongestTier });
            const prediction = predict(R, here);
            const routed = routeOf(R, here);
            expect(prediction.route, JSON.stringify(here)).toBe(routed.route);
            expect(prediction.namedTier, JSON.stringify(here)).toBe(routed.namedTier);
            if (prediction.route === "ADJUDICATE") expect(consistent(R, prediction.decision, here), JSON.stringify(here)).toBe(true);
            if (prediction.decision === "ACCEPT") expect(consistent(R, "ACCEPT", here), JSON.stringify(here)).toBe(true);
            if (prediction.shortBy !== null) expect(prediction.shortBy, JSON.stringify(here)).toBe((prediction.acceptAt ?? 0) - score);
          }
        }
      }
    }
  });

  it("reads every sensor the product has as a verdict", () => {
    for (const sensor of SUGGESTION_SENSORS) {
      expect(routeOf(R, routing({ verdicts: [{ sensor, result: "FAIL" }] })).route, sensor).toBe("DECLINE_AT_INTAKE");
      expect(routeOf(R, routing({ verdicts: [{ sensor, result: "NA" }] })).route, sensor).toBe("ADJUDICATE");
    }
  });
});
