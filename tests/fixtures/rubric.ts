import type { ClassAnchor, ClassProposal } from "@/lib/rubric/changeClass";
import type { Route } from "@/lib/rubric/thresholds";
import type { EvidenceTier } from "@/lib/schemas/domain";
import type { ChangeClass, ChangeKind, Decision } from "@/lib/schemas/improve";
import type { Relevance, RubricRules, Stake } from "@/lib/schemas/rubric";

/*
 * Rubric v1.2's rules and the PRD's four worked examples (feature-specs/30 § 3, § 4.3, § 7), shared by the rubric's
 * suites. Every number is the Rubric screen's or the example's own screen's; none is this file's.
 *
 * An example gives each item as the grader and the fetcher would leave it (a tier, a classification, a stake, an
 * age, a publisher) and the numbers the sources print for it. Example 4's hosts are its screen's
 * (`provider-two.example`, `price-tracker.example`). Example 1's link has a host on no screen, so the one here is
 * the fixture's own and nothing depends on it; an upload and a lab run have no publisher.
 */

export const RUBRIC_V1_2: RubricRules = {
  tiers: {
    A: { base: 100, stakeAtBest: "none" },
    B: { base: 85, stakeAtBest: "none" },
    C: { base: 70, stakeAtBest: "vendor" },
    D: { base: 60, stakeAtBest: "none" },
    E: { base: 40, stakeAtBest: "none" },
    F: { base: 25, stakeAtBest: "none" },
    G: { base: 5, stakeAtBest: "none" },
    U: { base: 0, stakeAtBest: "none" },
  },
  adjustments: {
    relevance: { direct: 1.0, partial: 0.6, tangential: 0.2 },
    recency: {
      windows: [
        { withinDays: 90, factor: 1.0 },
        { withinDays: 365, factor: 0.7 },
      ],
      older: 0.3,
      stable: 1.0,
    },
    independence: { none: 1.0, vendor: 0.8, employer: 0.7 },
    corroboration: { bonus: 10, minTier: "D" },
  },
  thresholds: {
    WORDING: { acceptAt: 40, floorAt: 5, onlyTier: null },
    CITED_FIGURE: { acceptAt: 70, floorAt: 25, onlyTier: null },
    DERIVED_FIGURE: { acceptAt: 100, floorAt: 100, onlyTier: "A" },
    NEW_CLAIM: { acceptAt: 85, floorAt: 40, onlyTier: null },
    CURATOR_ALWAYS: null,
  },
};

export interface ExampleItem {
  readonly id: string;
  readonly tier: EvidenceTier;
  readonly relevance: Relevance;
  readonly stake: Stake;
  readonly ageDays: number | null;
  readonly publisher: string | null;
  /** As the source prints the item's arithmetic: base × relevance × recency × independence = adjusted. */
  readonly base: number;
  readonly factors: readonly [number, number, number];
  readonly adjusted: number;
}

export interface WorkedExample {
  readonly id: string;
  /** The change as the class reads it (30 § 4.2): its kind, its anchor and its proposal, from the example's screen. */
  readonly changeKind: ChangeKind;
  readonly anchor: ClassAnchor;
  readonly proposal: ClassProposal;
  readonly changeClass: ChangeClass;
  readonly fastMoving: boolean;
  readonly items: ReadonlyArray<ExampleItem>;
  readonly score: number;
  readonly strongestId: string;
  readonly corroboratedById: string | null;
  /** Where it goes with every intake sensor passing, and what the form predicts (30 § 4.4, § 7). */
  readonly route: Route;
  readonly predicted: Decision;
  readonly shortBy: number | null;
}

/** 1 · the Annex III date in 36.3: the regulation's own text, nine days old. 85 ≥ 70: adjudicate, and accept is consistent. */
export const EXAMPLE_1: WorkedExample = {
  id: "S-36-0198",
  changeKind: "EDIT_ROW",
  anchor: { kind: "SOURCE_ROW", figure: null, text: "EU AI Act Annex III obligations apply from 2 Aug 2026. Official Journal regulation text." },
  proposal: { text: "EU AI Act Annex III obligations apply from 2 Dec 2027.", sourceTier: null },
  changeClass: "CITED_FIGURE",
  fastMoving: true,
  items: [{ id: "ex1-01", tier: "B", relevance: "direct", stake: "none", ageDays: 9, publisher: "official-journal.example", base: 85, factors: [1.0, 1.0, 1.0], adjusted: 85 }],
  score: 85,
  strongestId: "ex1-01",
  corroboratedById: null,
  route: "ADJUDICATE",
  predicted: "ACCEPT",
  shortBy: null,
};

/** 2 · routing savings in 23.3: an uploaded screenshot of a thread, posted 19 days before. 5 < 25: declined at intake. */
export const EXAMPLE_2: WorkedExample = {
  id: "S-23-0412",
  changeKind: "SET_VALUE",
  anchor: { kind: "FIGURE", figure: { tier: "ANALYST", scenarioParam: false }, text: "F-23-06 routing savings 2.4×" },
  proposal: { text: "1.3×", sourceTier: null },
  changeClass: "CITED_FIGURE",
  fastMoving: true,
  items: [{ id: "ex2-01", tier: "G", relevance: "direct", stake: "none", ageDays: 19, publisher: null, base: 5, factors: [1.0, 1.0, 1.0], adjusted: 5 }],
  score: 5,
  strongestId: "ex2-01",
  corroboratedById: null,
  route: "DECLINE_AT_INTAKE",
  predicted: "DECLINE",
  shortBy: null,
};

/** 3 · the repair cap of Lab 22: a saved run on the contributor's own golden set. 100 × 0.6 = 60 < 100, tier A only: request more by rule. */
export const EXAMPLE_3: WorkedExample = {
  id: "S-22-0356",
  changeKind: "SET_VALUE",
  anchor: { kind: "FIGURE", figure: { tier: "DERIVED", scenarioParam: false }, text: "repair cap 3" },
  proposal: { text: "4", sourceTier: null },
  changeClass: "DERIVED_FIGURE",
  fastMoving: false,
  items: [{ id: "ex3-01", tier: "A", relevance: "partial", stake: "none", ageDays: null, publisher: null, base: 100, factors: [0.6, 1.0, 1.0], adjusted: 60 }],
  score: 60,
  strongestId: "ex3-01",
  corroboratedById: null,
  route: "REQUEST_MORE_BY_RULE",
  predicted: "REQUEST_MORE",
  shortBy: 40,
};

/** 4 · the cached-input price in 15.9: the vendor's page, 12 days old, then a price tracker, five months old. 56 + 10 = 66 < 70: request more, short by 4. */
export const EXAMPLE_4: WorkedExample = {
  id: "S-15-0377",
  changeKind: "EDIT_ROW",
  anchor: { kind: "SOURCE_ROW", figure: null, text: "r12 · cached-input price $0.30 per M tokens · provider tier 2 pricing page" },
  proposal: { text: "cached-input price $0.25 per M tokens", sourceTier: null },
  changeClass: "CITED_FIGURE",
  fastMoving: true,
  items: [
    { id: "ex4-01", tier: "C", relevance: "direct", stake: "vendor", ageDays: 12, publisher: "provider-two.example", base: 70, factors: [1.0, 1.0, 0.8], adjusted: 56 },
    { id: "ex4-02", tier: "D", relevance: "direct", stake: "none", ageDays: 150, publisher: "price-tracker.example", base: 60, factors: [1.0, 0.7, 1.0], adjusted: 42 },
  ],
  score: 66,
  strongestId: "ex4-01",
  corroboratedById: "ex4-02",
  route: "ADJUDICATE",
  predicted: "REQUEST_MORE",
  shortBy: 4,
};

export const WORKED_EXAMPLES: ReadonlyArray<WorkedExample> = [EXAMPLE_1, EXAMPLE_2, EXAMPLE_3, EXAMPLE_4];
