import { canonicalize } from "@/lib/ledger/canonical";
import { sha256Hex } from "@/lib/ledger/hash";
import type { SuggestionScore } from "@/lib/rubric/score";
import type { EvidenceTier } from "@/lib/schemas/domain";
import { SUGGESTION_SENSORS, type Criterion, type CuratorAction, type Decider, type Decision, type SuggestionOrigin, type SuggestionSensor, type SuggestionState } from "@/lib/schemas/improve";

/*
 * The decision as the workflow records it (feature-specs/33 § 6; unit 50e), pure: where each decision leaves a
 * suggestion, as a path of the table's moves (29 § 3.1); the six lines a decision by rule is recorded with (33 § 3.1);
 * and the one hash the `sensors` record holds over the sensors' details (29 § 5).
 *
 * Every step before the decision runs while the suggestion is `SUBMITTED`, so each path starts there. A path that
 * reaches the adjudicator or the curator passes through `GRADED` and `SENSED`, which the suggestion reached when its
 * items were graded over the floor and its consistency sensors recorded; a decision by rule never did. A person's
 * accepted suggestion stays `DECIDED`: its `MergeWorkflow` moves it to `MERGING` as it starts (unit 54b).
 */

/** The steps that ran before a decision past the rules. */
const SENSED: ReadonlyArray<SuggestionState> = ["SUBMITTED", "GRADED", "SENSED"];

/**
 * Where a decision leaves a suggestion, from `SUBMITTED` (33 § 6.1). A person's decline by rule may be revised
 * (`INTAKE_DECLINED`, 31 § 6.5), and a request for more by rule waits in the queue for inspection; for a researcher's,
 * nobody is there to add evidence, so either is a refutation (`CLOSED`, 29 § 3.1). The adjudicator's accept is a
 * person's to merge and a researcher's for a curator (invariant 32); its request for more goes to the queue, or ends
 * a researcher's; its decline closes; its failure, and a class no score decides, go to the curator.
 */
export function pathOf(decision: Decision, decidedBy: Decider, origin: SuggestionOrigin): ReadonlyArray<SuggestionState> {
  const person = origin === "HUMAN";
  if (decidedBy === "intake-rules") {
    if (decision === "REQUEST_MORE" && person) return ["SUBMITTED", "CURATOR_QUEUE"];
    return person ? ["SUBMITTED", "INTAKE_DECLINED"] : ["SUBMITTED", "INTAKE_DECLINED", "CLOSED"];
  }
  switch (decision) {
    case "ACCEPT":
      return person ? [...SENSED, "DECIDED"] : [...SENSED, "DECIDED", "CURATOR_QUEUE"];
    case "REQUEST_MORE":
      return [...SENSED, "DECIDED", person ? "CURATOR_QUEUE" : "CLOSED"];
    case "DECLINE":
      return [...SENSED, "DECIDED", "CLOSED"];
    case "CURATOR_REVIEW":
      return [...SENSED, "CURATOR_QUEUE"];
  }
}

/**
 * Where a curator's decision in the queue leaves a suggestion (33 § 6.3; 29 § 3.1): an accept to `MERGING`, the
 * merge's (54b); a kept request for more to `DECIDED`, where a person may revise; a decline closed. Null for the
 * actions that are no queue's decision — a merge, a revert (spec 37) — and for a request for more kept on a
 * researcher's proposal, which takes accept or decline alone (42 § 7; 43 D16): its endpoint refuses the action, and an
 * action that reached here all the same is recorded as nothing.
 */
export function curatorPathOf(action: CuratorAction, origin: SuggestionOrigin): { readonly path: ReadonlyArray<SuggestionState>; readonly decision: Decision } | null {
  switch (action) {
    case "ACCEPT":
      return { path: ["CURATOR_QUEUE", "MERGING"], decision: "ACCEPT" };
    case "KEEP_REQUEST_MORE":
      return origin === "HUMAN" ? { path: ["CURATOR_QUEUE", "DECIDED"], decision: "REQUEST_MORE" } : null;
    case "DECLINE":
      return { path: ["CURATOR_QUEUE", "CLOSED"], decision: "DECLINE" };
    default:
      return null;
  }
}

/** What a decision by rule is made from: the score's arithmetic, each graded item's place and reason, the class's thresholds. */
export interface RuleCriteriaInput {
  readonly scored: SuggestionScore;
  readonly items: ReadonlyArray<{ readonly id: string; readonly ordinal: number; readonly reason: string }>;
  /** Null for a class no score decides. */
  readonly threshold: { readonly acceptAt: number; readonly floorAt: number } | null;
  readonly decision: "DECLINE" | "REQUEST_MORE";
  /** The sensor a decline rests on; null for one by the arithmetic. */
  readonly failingSensor: SuggestionSensor | null;
  /** The one tier a rule names: the derived class's (30 § 4.4). */
  readonly namedTier: EvidenceTier | null;
}

export interface CriterionLine {
  readonly criterion: Criterion;
  /** A value, in the form the `decided` record takes (29 § 13): `C`, `1.00`, `+10`, `5<25`, `none`. */
  readonly verdict: string;
  readonly reason: string;
}

const factor = (value: number | null): string => (value === null ? "none" : value.toFixed(2));

/** The score against the class's thresholds, as one value: under the floor, under the acceptance, or at it. */
function againstThresholds(score: number, threshold: RuleCriteriaInput["threshold"]): string {
  if (threshold === null) return "none";
  if (score < threshold.floorAt) return `${String(score)}<${String(threshold.floorAt)}`;
  if (score < threshold.acceptAt) return `${String(score)}<${String(threshold.acceptAt)}`;
  return `${String(score)}>=${String(threshold.acceptAt)}`;
}

function thresholdReason(input: RuleCriteriaInput, strongestTier: EvidenceTier | null): string {
  const { scored, threshold } = input;
  const score = String(scored.score);
  if (input.failingSensor !== null) return `Declined by the ${input.failingSensor} sensor before any adjudicator, whatever the score.`;
  if (threshold === null) return "No score decides this class; a curator does.";
  if (input.decision === "REQUEST_MORE") return `Score ${score} is under the acceptance of ${String(threshold.acceptAt)}, which only an item of tier ${input.namedTier ?? "A"} reaches: more is asked for by rule.`;
  if (input.namedTier !== null) return strongestTier === null ? `The class accepts only tier ${input.namedTier}, and no item scores above zero: declined by rule.` : `The class accepts only tier ${input.namedTier}, and the strongest item is tier ${strongestTier}: declined by rule.`;
  return `Score ${score} is under the class's floor of ${String(threshold.floorAt)}: declined without an adjudicator.`;
}

/**
 * The six lines of a decision by rule, built from the grades (33 § 3.1): the strongest item's tier with the grader's
 * own reason; its relevance, recency and independence with their values; the corroboration's bonus; the score against
 * the thresholds (`5<25`, which the page writes `5 < floor 25`). With no item above zero, each says so.
 */
export function ruleCriteria(input: RuleCriteriaInput): ReadonlyArray<CriterionLine> {
  const { scored } = input;
  const strongest = scored.perItem.find((entry) => entry.id === scored.strongestId) ?? null;
  const ordinalOf = (id: string | null): string => String(input.items.find((item) => item.id === id)?.ordinal ?? "?");
  const bonus = strongest === null || scored.corroboratedById === null ? null : scored.score - strongest.adjusted;
  if (strongest === null) {
    const none = (criterion: Criterion): CriterionLine => ({ criterion, verdict: "none", reason: "No item scores above zero, so none decides the score." });
    return [none("tier"), none("relevance"), none("recency"), none("independence"), none("corroboration"), { criterion: "threshold", verdict: againstThresholds(scored.score, input.threshold), reason: thresholdReason(input, null) }];
  }
  const which = `Item ${ordinalOf(strongest.id)}'s`;
  return [
    { criterion: "tier", verdict: strongest.tier, reason: input.items.find((item) => item.id === strongest.id)?.reason ?? "" },
    { criterion: "relevance", verdict: factor(strongest.relevance), reason: `${which} relevance, as the grader classified it and the rubric weighs it.` },
    { criterion: "recency", verdict: factor(strongest.recency), reason: `${which} recency, by its age and whether the passage moves fast.` },
    { criterion: "independence", verdict: factor(strongest.independence), reason: `${which} independence, by its publisher against what the claim is about.` },
    {
      criterion: "corroboration",
      verdict: bonus === null ? "none" : `+${String(bonus)}`,
      reason: bonus === null ? "No second independent item corroborates the strongest." : `Item ${ordinalOf(scored.corroboratedById)} corroborates item ${ordinalOf(strongest.id)} from another publisher.`,
    },
    { criterion: "threshold", verdict: againstThresholds(scored.score, input.threshold), reason: thresholdReason(input, strongest.tier) },
  ];
}

/** The `sensors` record's one hash over the sensors' details (29 § 5): each verdict's sensor and detail, in the sensors' order, as canonical JSON. */
export function detailSha256Of(verdicts: ReadonlyArray<{ readonly sensor: SuggestionSensor; readonly detail: string }>): string {
  const ordered = [...verdicts].sort((a, b) => SUGGESTION_SENSORS.indexOf(a.sensor) - SUGGESTION_SENSORS.indexOf(b.sensor));
  return sha256Hex(canonicalize(ordered.map(({ sensor, detail }) => ({ sensor, detail }))));
}
