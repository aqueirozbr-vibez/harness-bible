import { describe, expect, it } from "vitest";

import { EvidenceTierSchema, type EvidenceTier } from "@/lib/schemas/domain";
import { CHANGE_CLASSES } from "@/lib/schemas/improve";
import { RELEVANCES, STAKES, type RubricRules } from "@/lib/schemas/rubric";
import { EXAMPLE_1, EXAMPLE_2, EXAMPLE_3, EXAMPLE_4, RUBRIC_V1_2, WORKED_EXAMPLES, type ExampleItem, type WorkedExample } from "@/tests/fixtures/rubric";

import { adjustedOf, factorsOf, recencyOf, scoreOf, wouldSuffice, type GradedItem } from "./score";

/*
 * The rubric's score (feature-specs/30 § 3, § 7): the four worked examples of the PRD to the number, every branch
 * of the arithmetic, and the properties the spec names. The rubric is always a parameter; the numbers asserted here
 * are v1.2's, from tests/fixtures/rubric.ts.
 */

const R = RUBRIC_V1_2;

/** An example's item as its graded row would hand it to the score: the factors looked up, not typed. */
function graded(item: ExampleItem, fastMoving: boolean): GradedItem {
  return { id: item.id, tier: item.tier, opened: true, ...factorsOf(R, item, fastMoving), publisher: item.publisher };
}
const itemsOf = (example: WorkedExample): ReadonlyArray<GradedItem> => example.items.map((item) => graded(item, example.fastMoving));

/** An opened item at its tier's best unless told otherwise. */
function item(id: string, tier: EvidenceTier, over: Partial<GradedItem> = {}): GradedItem {
  return { id, tier, opened: true, relevance: 1, recency: 1, independence: 1, publisher: `${id}.example`, ...over };
}

describe("recencyOf (30 § 3.4)", () => {
  it("is the stable factor for an anchor that is not fast-moving, whatever the item's age", () => {
    for (const age of [0, 90, 91, 365, 366, 10_000, null]) expect(recencyOf(R, age, false), String(age)).toBe(1.0);
  });

  it("is by the item's age for a fast-moving anchor: the first window it is within, to the day", () => {
    expect(recencyOf(R, 0, true)).toBe(1.0);
    expect(recencyOf(R, 90, true)).toBe(1.0);
    expect(recencyOf(R, 91, true)).toBe(0.7);
    expect(recencyOf(R, 365, true)).toBe(0.7);
    expect(recencyOf(R, 366, true)).toBe(0.3);
  });

  it("takes an item with no date as an old one: a price of unknown age is an old price (D3)", () => {
    expect(recencyOf(R, null, true)).toBe(0.3);
  });

  it("reads its numbers from the rubric it is given", () => {
    const other: RubricRules = { ...R, adjustments: { ...R.adjustments, recency: { windows: [{ withinDays: 30, factor: 0.9 }], older: 0.1, stable: 0.5 } } };
    expect([recencyOf(other, 30, true), recencyOf(other, 31, true), recencyOf(other, null, true), recencyOf(other, 5, false)]).toEqual([0.9, 0.1, 0.1, 0.5]);
  });
});

describe("factorsOf (30 § 3.2)", () => {
  it("looks each classification up in the rubric", () => {
    for (const relevance of RELEVANCES) {
      for (const stake of STAKES) {
        expect(factorsOf(R, { relevance, stake, ageDays: 150 }, true)).toEqual({ relevance: R.adjustments.relevance[relevance], recency: 0.7, independence: R.adjustments.independence[stake] });
      }
    }
  });
});

describe("adjustedOf (30 § 3.2, D1)", () => {
  it("is base × relevance × recency × independence for every tier at its best", () => {
    for (const tier of EvidenceTierSchema.options) expect(adjustedOf(R, tier, { relevance: 1, recency: 1, independence: 1 }), tier).toBe(R.tiers[tier].base);
  });

  it("rounds down, so that no score reaches a threshold by rounding", () => {
    /* 85 × 0.6 × 0.7 × 0.8 = 28.56; 25 × 0.2 × 0.3 × 0.7 = 1.05; 5 × 0.6 = 3.0 exactly; 5 × 0.2 × 0.3 × 0.7 = 0.21 */
    expect(adjustedOf(R, "B", { relevance: 0.6, recency: 0.7, independence: 0.8 })).toBe(28);
    expect(adjustedOf(R, "F", { relevance: 0.2, recency: 0.3, independence: 0.7 })).toBe(1);
    expect(adjustedOf(R, "G", { relevance: 0.6, recency: 1, independence: 1 })).toBe(3);
    expect(adjustedOf(R, "G", { relevance: 0.2, recency: 0.3, independence: 0.7 })).toBe(0);
  });

  it("is exact where binary floating point is not: every product of the rubric's values, against whole-number arithmetic", () => {
    const hundredths = [100, 60, 20, 70, 30, 80];
    for (const tier of EvidenceTierSchema.options) {
      for (const r of hundredths) {
        for (const c of hundredths) {
          for (const i of hundredths) {
            const whole = (BigInt(R.tiers[tier].base) * BigInt(r) * BigInt(c) * BigInt(i)) / BigInt(1_000_000);
            expect(adjustedOf(R, tier, { relevance: r / 100, recency: c / 100, independence: i / 100 }), `${tier} ${String(r)} ${String(c)} ${String(i)}`).toBe(Number(whole));
          }
        }
      }
    }
  });
});

describe("scoreOf: the four worked examples, to the number (30 § 7)", () => {
  for (const example of WORKED_EXAMPLES) {
    it(`${example.id}: ${example.items.map((entry) => `${entry.tier} ${String(entry.adjusted)}`).join(", ")} → ${String(example.score)}`, () => {
      const scored = scoreOf(R, itemsOf(example));
      expect(scored.perItem).toEqual(
        example.items.map((entry) => ({ id: entry.id, tier: entry.tier, base: entry.base, relevance: entry.factors[0], recency: entry.factors[1], independence: entry.factors[2], adjusted: entry.adjusted })),
      );
      expect(scored.score).toBe(example.score);
      expect(scored.strongestId).toBe(example.strongestId);
      expect(scored.corroboratedById).toBe(example.corroboratedById);
    });
  }
});

describe("scoreOf (30 § 3.3)", () => {
  it("is 0, with no strongest item, for no items at all", () => {
    expect(scoreOf(R, [])).toEqual({ score: 0, strongestId: null, corroboratedById: null, perItem: [] });
  });

  it("grades an item that was not opened as unverifiable whatever it claims to be, and a suggestion with no opened item scores 0", () => {
    const scored = scoreOf(R, [item("a", "B", { opened: false }), item("b", "A", { opened: false, relevance: null, recency: null, independence: null })]);
    expect(scored).toMatchObject({ score: 0, strongestId: null, corroboratedById: null });
    expect(scored.perItem).toEqual([
      { id: "a", tier: "U", base: 0, relevance: null, recency: null, independence: null, adjusted: 0 },
      { id: "b", tier: "U", base: 0, relevance: null, recency: null, independence: null, adjusted: 0 },
    ]);
  });

  it("scores an opened item that lacks a factor at 0, and keeps the tier it was given", () => {
    for (const missing of ["relevance", "recency", "independence"] as const) {
      const scored = scoreOf(R, [item("a", "B", { [missing]: null })]);
      expect(scored.perItem[0], missing).toMatchObject({ tier: "B", base: 85, adjusted: 0 });
      expect(scored, missing).toMatchObject({ score: 0, strongestId: null });
    }
  });

  it("is the strongest item's adjusted score: never a sum, never an average", () => {
    const scored = scoreOf(R, [item("e", "E"), item("f", "F"), item("g", "G")]);
    expect(scored).toMatchObject({ score: 40, strongestId: "e", corroboratedById: null });
  });

  it("adds the corroboration once, however many items qualify, and names the first that does", () => {
    const scored = scoreOf(R, [item("b", "B"), item("d1", "D"), item("c", "C"), item("d2", "D")]);
    expect(scored).toMatchObject({ score: 95, strongestId: "b", corroboratedById: "d1" });
  });

  describe("what corroborates: a second item of tier D or above, independent, opened, on the claim, from another publisher", () => {
    const strongest = item("s", "C", { independence: 0.8, publisher: "vendor.example" });
    const cases: ReadonlyArray<readonly [string, GradedItem, boolean]> = [
      ["tier D, independent, direct", item("x", "D", { recency: 0.3 }), true],
      ["tier D, independent, partial", item("x", "D", { relevance: 0.6 }), true],
      ["tier A, the strongest tier there is, weakly adjusted", item("x", "A", { relevance: 0.6, recency: 0.3 }), true],
      ["tier E: below D", item("x", "E"), false],
      ["tier D of the vendor concerned: not independent", item("x", "D", { independence: 0.8 }), false],
      ["tier D of the contributor's employer: not independent", item("x", "D", { independence: 0.7 }), false],
      ["tier D, tangential: it says nothing of the claim", item("x", "D", { relevance: 0.2 }), false],
      ["tier D that was not opened", item("x", "D", { opened: false }), false],
      ["tier D whose row has no independence", item("x", "D", { independence: null }), false],
      ["tier D whose row has no relevance", item("x", "D", { relevance: null }), false],
      ["tier D of the same publisher: a second page of one publisher is not a second source", item("x", "D", { recency: 0.3, publisher: "vendor.example" }), false],
      ["tier D of no known publisher", item("x", "D", { recency: 0.3, publisher: null }), false],
    ];
    for (const [name, second, corroborates] of cases) {
      it(`${name}: ${corroborates ? "+10" : "nothing"}`, () => {
        const scored = scoreOf(R, [strongest, second]);
        expect(scored.strongestId).toBe("s");
        expect(scored.score).toBe(corroborates ? 66 : 56);
        expect(scored.corroboratedById).toBe(corroborates ? "x" : null);
      });
    }

    it("nothing corroborates a strongest item whose publisher is not known", () => {
      expect(scoreOf(R, [item("s", "B", { publisher: null }), item("x", "D")])).toMatchObject({ score: 85, strongestId: "s", corroboratedById: null });
    });

    it("the strongest item never corroborates itself", () => {
      expect(scoreOf(R, [item("s", "B")])).toMatchObject({ score: 85, corroboratedById: null });
    });
  });

  describe("two items equally strong", () => {
    it("the first is the strongest when neither is corroborated", () => {
      expect(scoreOf(R, [item("a", "D", { publisher: null }), item("b", "D", { publisher: null })])).toMatchObject({ score: 60, strongestId: "a", corroboratedById: null });
    });

    it("the one that is corroborated is the strongest, wherever it stands", () => {
      /* a, an upload, and b, an analyst's page, both stand at 60: nothing can be shown to be another publisher than
         a's, so only b has a second independent item, c. */
      const a = item("a", "A", { relevance: 0.6, publisher: null });
      const b = item("b", "D");
      const c = item("c", "D", { recency: 0.3 });
      expect(scoreOf(R, [a, b, c])).toMatchObject({ score: 70, strongestId: "b", corroboratedById: "c" });
      expect(scoreOf(R, [b, a, c])).toMatchObject({ score: 70, strongestId: "b", corroboratedById: "c" });
    });
  });
});

describe("wouldSuffice (30 § 3.5)", () => {
  it("S-15-0377: an independent tier D item at most 90 days old as the strongest, 60 + 10 = 70; or tier B, 85", () => {
    expect(wouldSuffice(R, itemsOf(EXAMPLE_4), EXAMPLE_4.changeClass, EXAMPLE_4.fastMoving)).toEqual([
      { tier: "D", adjusted: 60, withinDays: 90, by: "CORROBORATED", bonus: 10, score: 70 },
      { tier: "B", adjusted: 85, withinDays: 90, by: "ALONE", bonus: 0, score: 85 },
    ]);
  });

  it("S-23-0412: tier B reaches 85 alone; tier D, 60 alone, asks for more, and a second independent D adds 10", () => {
    expect(wouldSuffice(R, itemsOf(EXAMPLE_2), EXAMPLE_2.changeClass, EXAMPLE_2.fastMoving)).toEqual([
      { tier: "B", adjusted: 85, withinDays: 90, by: "ALONE", bonus: 0, score: 85 },
      { tier: "D", adjusted: 60, withinDays: 90, by: "WITH_A_SECOND", bonus: 10, score: 70 },
    ]);
  });

  it("S-22-0356, a derived figure: tier A only, and of a stable anchor no age is asked", () => {
    expect(wouldSuffice(R, itemsOf(EXAMPLE_3), EXAMPLE_3.changeClass, EXAMPLE_3.fastMoving)).toEqual([{ tier: "A", adjusted: 100, withinDays: null, by: "ALONE", bonus: 0, score: 100 }]);
  });

  it("S-36-0198, already at 85 against 70: nothing more is asked", () => {
    expect(wouldSuffice(R, itemsOf(EXAMPLE_1), EXAMPLE_1.changeClass, EXAMPLE_1.fastMoving)).toEqual([]);
  });

  it("names only the class's single tier where it has one, whatever other tiers would reach its acceptance", () => {
    /* At v1.2's numbers nothing but tier A reaches 100; with a derived figure accepted at 90, tier B corroborated would, and still only A is named. */
    const lower: RubricRules = { ...R, thresholds: { ...R.thresholds, DERIVED_FIGURE: { acceptAt: 90, floorAt: 90, onlyTier: "A" } } };
    const present = [item("d", "D")];
    expect(wouldSuffice(lower, present, "DERIVED_FIGURE", false)).toEqual([{ tier: "A", adjusted: 100, withinDays: null, by: "ALONE", bonus: 0, score: 100 }]);
    expect(wouldSuffice({ ...lower, thresholds: { ...lower.thresholds, DERIVED_FIGURE: { acceptAt: 90, floorAt: 90, onlyTier: null } } }, present, "DERIVED_FIGURE", false).map((entry) => entry.tier)).toEqual(["B", "A"]);
  });

  it("names nothing where no score decides", () => {
    expect(wouldSuffice(R, itemsOf(EXAMPLE_4), "CURATOR_ALWAYS", true)).toEqual([]);
    expect(wouldSuffice(R, [], "CURATOR_ALWAYS", false)).toEqual([]);
  });

  it("never names tier C for a cited figure: at its best it is the page of the vendor concerned, 70 × 0.8 = 56", () => {
    for (const example of [EXAMPLE_2, EXAMPLE_4]) {
      expect(wouldSuffice(R, itemsOf(example), "CITED_FIGURE", true).map((entry) => entry.tier)).not.toContain("C");
    }
  });

  it("names the two weakest tiers that do, the weaker first: with nothing yet, a wording change is tier E or tier D", () => {
    expect(wouldSuffice(R, [], "WORDING", false)).toEqual([
      { tier: "E", adjusted: 40, withinDays: null, by: "ALONE", bonus: 0, score: 40 },
      { tier: "D", adjusted: 60, withinDays: null, by: "ALONE", bonus: 0, score: 60 },
    ]);
  });

  it("with nothing yet, a new claim is tier B, 85, or tier A", () => {
    expect(wouldSuffice(R, [], "NEW_CLAIM", true).map((entry) => [entry.tier, entry.by, entry.score])).toEqual([
      ["B", "ALONE", 85],
      ["A", "ALONE", 100],
    ]);
  });

  it("names an item that would corroborate the present strongest and not replace it", () => {
    /* A tier B page of the vendor concerned stands at 68 against 70; one independent D behind it adds the 10. A
       second vendor page, tier C, is not independent and adds nothing. */
    const present = [item("b", "B", { independence: 0.8 })];
    expect(wouldSuffice(R, present, "CITED_FIGURE", true)).toEqual([
      { tier: "D", adjusted: 60, withinDays: 90, by: "CORROBORATING", bonus: 10, score: 78 },
      { tier: "B", adjusted: 85, withinDays: 90, by: "ALONE", bonus: 0, score: 85 },
    ]);
  });

  it("is the hypothetical item of each tier, never one of the present items: the items given are not changed", () => {
    const present = itemsOf(EXAMPLE_4);
    const before = JSON.stringify(present);
    wouldSuffice(R, present, "CITED_FIGURE", true);
    expect(JSON.stringify(present)).toBe(before);
  });

  it("every tier it names would be accepted by the score, for every class and every worked example", () => {
    for (const example of WORKED_EXAMPLES) {
      for (const changeClass of CHANGE_CLASSES) {
        const threshold = R.thresholds[changeClass];
        const named = wouldSuffice(R, itemsOf(example), changeClass, example.fastMoving);
        expect(named.length, `${example.id} ${changeClass}`).toBeLessThanOrEqual(2);
        for (const entry of named) {
          expect(entry.score, `${example.id} ${changeClass} ${entry.tier}`).toBeGreaterThanOrEqual(threshold?.acceptAt ?? Number.POSITIVE_INFINITY);
          expect(entry.adjusted + entry.bonus === entry.score || entry.by === "CORROBORATING", `${example.id} ${changeClass} ${entry.tier}`).toBe(true);
        }
      }
    }
  });
});

/* A small generator with a fixed seed: the properties are checked on the same thousands of item sets on every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomItem(next: () => number, id: string, publishers: ReadonlyArray<string | null>): GradedItem {
  const pick = <T,>(values: ReadonlyArray<T>): T => values[Math.floor(next() * values.length)] as T;
  return {
    id,
    tier: pick(EvidenceTierSchema.options),
    opened: next() > 0.15,
    relevance: pick([1, 0.6, 0.2]),
    recency: pick([1, 0.7, 0.3]),
    independence: pick([1, 0.8, 0.7]),
    publisher: pick(publishers),
  };
}

function randomItems(next: () => number, publishers: ReadonlyArray<string | null>): GradedItem[] {
  return Array.from({ length: Math.floor(next() * 7) }, (_, index) => randomItem(next, `i${String(index)}`, publishers));
}

describe("the properties of the score (30 § 7)", () => {
  const PUBLISHERS = ["one.example", "two.example", "three.example", null];
  const RUNS = 4_000;

  it("never exceeds 110, and is the strongest item's adjusted score with the corroboration or without", () => {
    const next = generator(30);
    for (let run = 0; run < RUNS; run += 1) {
      const scored = scoreOf(R, randomItems(next, PUBLISHERS));
      const top = Math.max(0, ...scored.perItem.map((entry) => entry.adjusted));
      expect(scored.score).toBeLessThanOrEqual(110);
      expect(scored.score).toBe(top + (scored.corroboratedById === null ? 0 : 10));
    }
  });

  it("does not depend on anything but the items: the same items in the same order score the same", () => {
    const next = generator(31);
    for (let run = 0; run < 500; run += 1) {
      const items = randomItems(next, PUBLISHERS);
      expect(scoreOf(R, items)).toEqual(scoreOf(R, items.map((entry) => ({ ...entry }))));
    }
  });

  it("is never lowered by adding an item of a publisher that is known and is none of the items'", () => {
    const next = generator(32);
    for (let run = 0; run < RUNS; run += 1) {
      const items = randomItems(next, PUBLISHERS);
      const added = randomItem(next, "added", ["another.example"]);
      expect(scoreOf(R, [...items, added]).score, JSON.stringify([items, added])).toBeGreaterThanOrEqual(scoreOf(R, items).score);
    }
  });

  it("can be lowered by a stronger item that shares its publisher with the only corroborating item, or has no known publisher: the strongest item is chosen first", () => {
    /* The rule as the PRD and the Rubric screen state it ("added once, after the strongest item is chosen"), kept
       as stated. The spec's property "adding an item never lowers it" does not hold in these two cases; the tracker
       has the question. */
    const vendor = item("v", "C", { independence: 0.8, publisher: "vendor.example" });
    const tracker = item("t", "D", { recency: 0.7, publisher: "tracker.example" });
    expect(scoreOf(R, [vendor, tracker]).score).toBe(66);
    expect(scoreOf(R, [vendor, tracker, item("t2", "D", { publisher: "tracker.example" })])).toMatchObject({ score: 60, strongestId: "t2", corroboratedById: null });
    expect(scoreOf(R, [vendor, tracker, item("u", "D", { publisher: null })])).toMatchObject({ score: 60, strongestId: "u", corroboratedById: null });
  });

  it("ten items of tier G score what one does, and less than one item of tier F", () => {
    const tenG = Array.from({ length: 10 }, (_, index) => item(`g${String(index)}`, "G"));
    expect(scoreOf(R, tenG).score).toBe(5);
    expect(scoreOf(R, [item("f", "F")]).score).toBe(25);
    expect(scoreOf(R, [...tenG, item("f", "F")])).toMatchObject({ score: 25, strongestId: "f" });
  });

  it("removing the corroborating item lowers the score by exactly 10, or by nothing when another item corroborates too", () => {
    const next = generator(33);
    let lowered = 0;
    let kept = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const items = randomItems(next, PUBLISHERS);
      const scored = scoreOf(R, items);
      if (scored.corroboratedById === null) continue;
      const without = scoreOf(R, items.filter((entry) => entry.id !== scored.corroboratedById));
      if (without.corroboratedById === null) {
        expect(without.score, JSON.stringify(items)).toBe(scored.score - 10);
        lowered += 1;
      } else {
        expect(without.score, JSON.stringify(items)).toBe(scored.score);
        kept += 1;
      }
    }
    /* Both happen among the sets generated, so both halves of the property were met. */
    expect(lowered).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
  });
});
