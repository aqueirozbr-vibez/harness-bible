import type { EvidenceTier } from "@/lib/schemas/domain";
import type { ChangeClass } from "@/lib/schemas/improve";
import type { Relevance, RubricRules, Stake } from "@/lib/schemas/rubric";

/*
 * The rubric's score (feature-specs/30 § 3): the part of Improve a model never decides (invariant 8). A grader says
 * which tier an item is and how it bears on the claim; from there on it is this arithmetic, the same for every
 * contributor and for the researcher.
 *
 * Pure. Every function takes the rubric's rules and reads no file, no row and no clock; every number of a score is
 * the rubric's. The module imports nothing but the shared schemas' types (a lint rule holds it), and is kept at
 * 100 % branch coverage by `npm run test:rubric`.
 */

/** The three multipliers of an item, as its graded row stores them. */
export interface Factors {
  readonly relevance: number;
  readonly recency: number;
  readonly independence: number;
}

/**
 * Recency (§ 3.4) applies to fast-moving anchors only: prices, deadlines, model versions, benchmarks. A stable
 * anchor takes the stable factor whatever the item's age. An item with no date is an old one (D3).
 */
export function recencyOf(rules: RubricRules, ageDays: number | null, fastMoving: boolean): number {
  const { windows, older, stable } = rules.adjustments.recency;
  if (!fastMoving) return stable;
  if (ageDays === null) return older;
  return windows.find((window) => ageDays <= window.withinDays)?.factor ?? older;
}

/** The numbers for a grader's classifications (§ 3.2): looked up, so that a model's output is never a number of the score. */
export function factorsOf(rules: RubricRules, grade: { readonly relevance: Relevance; readonly stake: Stake; readonly ageDays: number | null }, fastMoving: boolean): Factors {
  return { relevance: rules.adjustments.relevance[grade.relevance], recency: recencyOf(rules, grade.ageDays, fastMoving), independence: rules.adjustments.independence[grade.stake] };
}

/* A factor is a number of hundredths (lib/schemas/rubric.ts), so the product is taken in whole numbers and no score
   is a rounding of binary fractions (D1). */
const HUNDREDTHS = 100;
const hundredths = (factor: number): number => Math.round(factor * HUNDREDTHS);

/** `floor(base × relevance × recency × independence)`: rounded down, so that no score reaches a threshold by rounding (§ 3.2, D1). */
export function adjustedOf(rules: RubricRules, tier: EvidenceTier, factors: Factors): number {
  const product = rules.tiers[tier].base * hundredths(factors.relevance) * hundredths(factors.recency) * hundredths(factors.independence);
  const scale = HUNDREDTHS ** 3;
  return (product - (product % scale)) / scale;
}

/** An evidence item as its graded row has it. An item that could not be opened has no factors. */
export interface GradedItem {
  readonly id: string;
  readonly tier: EvidenceTier;
  readonly opened: boolean;
  readonly relevance: number | null;
  readonly recency: number | null;
  readonly independence: number | null;
  /** Who published it, as the caller normalises it (a registrable domain); null when that is not known, as for an upload. */
  readonly publisher: string | null;
}

/** An item's arithmetic: `base × relevance × recency × independence = adjusted`. */
export interface ItemScore {
  readonly id: string;
  readonly tier: EvidenceTier;
  readonly base: number;
  readonly relevance: number | null;
  readonly recency: number | null;
  readonly independence: number | null;
  readonly adjusted: number;
}

export interface SuggestionScore {
  readonly score: number;
  /** The item that decides; null when no item scores above 0. */
  readonly strongestId: string | null;
  readonly corroboratedById: string | null;
  readonly perItem: ReadonlyArray<ItemScore>;
}

/** What the score reads of an item. A publisher is a name, or for an item that does not exist yet a mark of its own. */
interface Entry extends ItemScore {
  readonly opened: boolean;
  readonly publisher: string | symbol | null;
}

/** An item that was not opened is unverifiable whatever it claims to be (§ 3.1); one that lacks a factor has no product. */
function entryOf(rules: RubricRules, item: GradedItem): Entry {
  const tier = item.opened ? item.tier : "U";
  const relevance = item.opened ? item.relevance : null;
  const recency = item.opened ? item.recency : null;
  const independence = item.opened ? item.independence : null;
  const adjusted = relevance === null || recency === null || independence === null ? 0 : adjustedOf(rules, tier, { relevance, recency, independence });
  return { id: item.id, tier, base: rules.tiers[tier].base, relevance, recency, independence, adjusted, opened: item.opened, publisher: item.publisher };
}

/**
 * The item that corroborates `strongest` (§ 3.3, D2): another one, opened, of the rubric's tier or above,
 * independent, bearing on the claim at least partially, and from another publisher. Both publishers must be known:
 * what cannot be shown to be a second source is not counted as one.
 */
function corroboratorOf(rules: RubricRules, entries: ReadonlyArray<Entry>, strongest: Entry): Entry | null {
  const { corroboration, independence, relevance } = rules.adjustments;
  const found = entries.find(
    (entry) =>
      entry !== strongest &&
      entry.opened &&
      entry.base >= rules.tiers[corroboration.minTier].base &&
      entry.independence !== null &&
      hundredths(entry.independence) >= hundredths(independence.none) &&
      entry.relevance !== null &&
      hundredths(entry.relevance) >= hundredths(relevance.partial) &&
      entry.publisher !== null &&
      strongest.publisher !== null &&
      entry.publisher !== strongest.publisher,
  );
  return found ?? null;
}

interface Decided {
  readonly score: number;
  readonly strongest: Entry | null;
  readonly corroborator: Entry | null;
}

/**
 * The strongest item decides, and the corroboration is added once, after it is chosen (§ 3.3). Of items equally
 * strong the strongest is the first that has a corroborating item, or the first of them when none has.
 */
function decide(rules: RubricRules, entries: ReadonlyArray<Entry>): Decided {
  const top = Math.max(0, ...entries.map((entry) => entry.adjusted));
  if (top === 0) return { score: 0, strongest: null, corroborator: null };
  let first: Entry | null = null;
  for (const entry of entries) {
    if (entry.adjusted !== top) continue;
    const corroborator = corroboratorOf(rules, entries, entry);
    if (corroborator !== null) return { score: top + rules.adjustments.corroboration.bonus, strongest: entry, corroborator };
    first ??= entry;
  }
  return { score: top, strongest: first, corroborator: null };
}

/**
 * The suggestion's score (§ 3.3): the strongest item's adjusted score, plus the corroboration when a second
 * independent item exists. Never a sum, never an average. Each item's adjusted score is computed here from its
 * tier and its factors, whatever a row says it was.
 */
export function scoreOf(rules: RubricRules, items: ReadonlyArray<GradedItem>): SuggestionScore {
  const entries = items.map((item) => entryOf(rules, item));
  const decided = decide(rules, entries);
  return {
    score: decided.score,
    strongestId: decided.strongest === null ? null : decided.strongest.id,
    corroboratedById: decided.corroborator === null ? null : decided.corroborator.id,
    perItem: entries.map(({ id, tier, base, relevance, recency, independence, adjusted }) => ({ id, tier, base, relevance, recency, independence, adjusted })),
  };
}

/**
 * How one more item of a tier would bring the suggestion to its acceptance: by its own adjusted score; as the
 * strongest item, with an item already there corroborating it; by corroborating the strongest item already there;
 * or only together with a second independent item of its tier.
 */
export type SufficientBy = "ALONE" | "CORROBORATED" | "CORROBORATING" | "WITH_A_SECOND";

export interface Sufficient {
  readonly tier: EvidenceTier;
  /** One item of the tier at its best: direct, recent where the anchor is fast-moving, with the least stake the tier allows. */
  readonly adjusted: number;
  /** For a fast-moving anchor, the age in days within which the item is at its best; null for a stable one. */
  readonly withinDays: number | null;
  readonly by: SufficientBy;
  /** The corroboration counted in `score`: 0 where the item suffices alone. */
  readonly bonus: number;
  /** What the suggestion's score would be: `adjusted + bonus`, or for a corroborating item the present strongest's with the bonus. */
  readonly score: number;
}

/** The spec's "at most two" (§ 3.5). */
const SUFFICIENT_AT_MOST = 2;

/**
 * Which evidence would turn this into an acceptance (§ 3.5). For each tier from the weakest up: would one more item
 * of that tier, at its best, reach the class's acceptance, alone or with the corroboration the present items would
 * then give or receive; and failing that, would it with a second independent item of its tier. The two weakest
 * tiers that do are returned, those that ask for one item before the one that asks for two.
 *
 * Nothing is named where no score decides, or where the items there already reach the acceptance.
 */
export function wouldSuffice(rules: RubricRules, items: ReadonlyArray<GradedItem>, changeClass: ChangeClass, fastMoving: boolean): ReadonlyArray<Sufficient> {
  const threshold = rules.thresholds[changeClass];
  if (threshold === null) return [];
  const present = items.map((item) => entryOf(rules, item));
  if (decide(rules, present).score >= threshold.acceptAt) return [];

  const { recency, relevance, independence, corroboration } = rules.adjustments;
  const withinDays = fastMoving ? recency.windows[0].withinDays : null;
  const tiers = (Object.keys(rules.tiers) as EvidenceTier[]).filter((tier) => threshold.onlyTier === null || tier === threshold.onlyTier).sort((a, b) => rules.tiers[a].base - rules.tiers[b].base);
  const named: Sufficient[] = [];
  for (const tier of tiers) {
    if (named.length === SUFFICIENT_AT_MOST) break;
    /* An item that does not exist yet, of a publisher none of the present items has. */
    const best = (): Entry => ({
      ...entryOf(rules, { id: "", tier, opened: true, relevance: relevance.direct, recency: recencyOf(rules, 0, fastMoving), independence: independence[rules.tiers[tier].stakeAtBest], publisher: null }),
      publisher: Symbol("an item not yet there"),
    });
    const one = best();
    const entry = { tier, adjusted: one.adjusted, withinDays };
    if (one.adjusted >= threshold.acceptAt) {
      named.push({ ...entry, by: "ALONE", bonus: 0, score: one.adjusted });
      continue;
    }
    const withOne = decide(rules, [...present, one]);
    if (withOne.score >= threshold.acceptAt) {
      named.push({ ...entry, by: withOne.strongest === one ? "CORROBORATED" : "CORROBORATING", bonus: corroboration.bonus, score: withOne.score });
      continue;
    }
    const withTwo = decide(rules, [...present, one, best()]);
    if (withTwo.score >= threshold.acceptAt) named.push({ ...entry, by: "WITH_A_SECOND", bonus: corroboration.bonus, score: withTwo.score });
  }
  return [...named].sort((a, b) => Number(a.by === "WITH_A_SECOND") - Number(b.by === "WITH_A_SECOND"));
}
