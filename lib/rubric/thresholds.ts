import type { EvidenceTier } from "@/lib/schemas/domain";
import type { ChangeClass, Decision, SensorResult, SuggestionSensor } from "@/lib/schemas/improve";
import { ROUTES, type Route, type RubricRules } from "@/lib/schemas/rubric";

/*
 * The thresholds and the routing (feature-specs/30 § 4.3, § 4.4): where a suggestion goes once its class and its
 * score are known, what the adjudicator may say of it, and the same two run on a draft for the form's predicted
 * outcome, which is why the prediction and the outcome cannot disagree about arithmetic.
 *
 * Pure: the rubric's rules are a parameter and every number is theirs.
 */

/** Where a scored suggestion goes (§ 4.4), as lib/schemas/rubric.ts names the routes. */
export { ROUTES, type Route };

export interface SensorVerdict {
  readonly sensor: SuggestionSensor;
  readonly result: SensorResult;
}

/** What the routing reads of a suggestion. */
export interface Routing {
  readonly changeClass: ChangeClass;
  readonly score: number;
  /** The intake sensors' verdicts as they stand; one `FAIL` declines at any score. */
  readonly verdicts: ReadonlyArray<SensorVerdict>;
  /** The tier of the item that decides the score; null when no item does. */
  readonly strongestTier: EvidenceTier | null;
}

export interface Routed {
  readonly route: Route;
  /** The one tier a rule names where it declines or asks for more by itself: a derived figure's tier A. Elsewhere `wouldSuffice` names the tiers. */
  readonly namedTier: EvidenceTier | null;
}

const failed = (verdicts: ReadonlyArray<SensorVerdict>): boolean => verdicts.some((verdict) => verdict.result === "FAIL");

/**
 * The route (§ 4.4): declined at intake when a sensor failed or the score is under the floor, with no model call
 * (invariant 11); the curator where no score decides; and the derived class's one rule of its own, since its
 * acceptance and its floor are both its single tier at the full score: a suggestion whose strongest item is that
 * tier but scores under the acceptance is asked for more by rule, and one with no item of that tier is declined,
 * each naming the tier (D6). Everything else is the adjudicator's.
 */
export function routeOf(rules: RubricRules, routing: Routing): Routed {
  if (failed(routing.verdicts)) return { route: "DECLINE_AT_INTAKE", namedTier: null };
  const threshold = rules.thresholds[routing.changeClass];
  if (threshold === null) return { route: "CURATOR", namedTier: null };
  if (threshold.onlyTier !== null) {
    if (routing.strongestTier !== threshold.onlyTier) return { route: "DECLINE_AT_INTAKE", namedTier: threshold.onlyTier };
    if (routing.score < threshold.acceptAt) return { route: "REQUEST_MORE_BY_RULE", namedTier: threshold.onlyTier };
    return { route: "ADJUDICATE", namedTier: null };
  }
  if (routing.score < threshold.floorAt) return { route: "DECLINE_AT_INTAKE", namedTier: null };
  return { route: "ADJUDICATE", namedTier: null };
}

/**
 * What the adjudicator may say (§ 4.4): accept only at the acceptance or above, with no sensor failed, and for a
 * class with a single tier only on an item of that tier; request more only at the floor or above; decline always.
 * Nothing it says decides a class no score decides, and sending a suggestion to the curator is the product's to do
 * when the adjudicator fails (invariant 15), not the adjudicator's to say.
 */
export function consistent(rules: RubricRules, decision: Decision, routing: Routing): boolean {
  const threshold = rules.thresholds[routing.changeClass];
  if (threshold === null) return false;
  switch (decision) {
    case "ACCEPT":
      return routing.score >= threshold.acceptAt && !failed(routing.verdicts) && (threshold.onlyTier === null || routing.strongestTier === threshold.onlyTier);
    case "REQUEST_MORE":
      return routing.score >= threshold.floorAt;
    case "DECLINE":
      return true;
    case "CURATOR_REVIEW":
      return false;
  }
}

/** The outcome the form predicts for a draft (§ 4.4; spec 34 § 5). */
export interface Prediction extends Routed {
  /** The decision the route leads to; on the adjudicator's route, the one that would be consistent at this score. */
  readonly decision: Decision;
  readonly acceptAt: number | null;
  readonly floorAt: number | null;
  /** For a request for more: how far the score is from the acceptance. */
  readonly shortBy: number | null;
}

function decisionOf(rules: RubricRules, route: Route, routing: Routing): Decision {
  if (route === "DECLINE_AT_INTAKE") return "DECLINE";
  if (route === "REQUEST_MORE_BY_RULE") return "REQUEST_MORE";
  return consistent(rules, "ACCEPT", routing) ? "ACCEPT" : "REQUEST_MORE";
}

/** `routeOf` and `consistent` run on a draft: what would happen if it were submitted now. */
export function predict(rules: RubricRules, routing: Routing): Prediction {
  const routed = routeOf(rules, routing);
  const threshold = rules.thresholds[routing.changeClass];
  if (threshold === null) return { ...routed, decision: routed.route === "DECLINE_AT_INTAKE" ? "DECLINE" : "CURATOR_REVIEW", acceptAt: null, floorAt: null, shortBy: null };
  const decision = decisionOf(rules, routed.route, routing);
  return { ...routed, decision, acceptAt: threshold.acceptAt, floorAt: threshold.floorAt, shortBy: decision === "REQUEST_MORE" ? threshold.acceptAt - routing.score : null };
}
