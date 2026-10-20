import { describe, expect, it } from "vitest";

import { monthOf, sampleOf, seedMatched, seedsWanted } from "./seeds";

/*
 * The queue's two calibration mechanisms (feature-specs/36 § 7, § 11.7; unit 53e): at share zero no queue ever has a
 * seed (a property over random queues); above it, seeds up to the share; the month and its sample, the same draw on
 * every read and another the next month.
 */

/** A small deterministic generator, so the property's queues are the same on every run. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe("seedsWanted (36 § 7.1)", () => {
  it("never offers a seed at share zero, whatever the queue (A16)", () => {
    const random = lcg(53);
    for (let run = 0; run < 1_000; run += 1) {
      const real = Math.floor(random() * 500);
      expect(seedsWanted(0, real), `a queue of ${String(real)}`).toBe(0);
    }
    expect(seedsWanted(Number.NaN, 10)).toBe(0);
  });

  it("keeps seeds to their share of all the items above it, rounded down", () => {
    /* at 0.5 as many seeds as real items; at 0.2 one seed in five items; at 0.05 one in twenty */
    expect([seedsWanted(0.5, 3), seedsWanted(0.5, 10), seedsWanted(0.2, 8), seedsWanted(0.2, 3), seedsWanted(0.05, 19), seedsWanted(0.05, 20)]).toEqual([3, 10, 2, 0, 1, 1]);
    const random = lcg(536);
    for (let run = 0; run < 1_000; run += 1) {
      const share = Math.floor(random() * 99) / 100;
      const real = Math.floor(random() * 300);
      const seeds = seedsWanted(share, real);
      if (real + seeds > 0) expect(seeds / (real + seeds), `${String(seeds)} seeds in ${String(real)} at ${String(share)}`).toBeLessThanOrEqual(share + 1e-9);
    }
  });

  it("offers none in an empty queue, nor for a share of 1 or more", () => {
    expect([seedsWanted(0.5, 0), seedsWanted(1, 10), seedsWanted(1.5, 10)]).toEqual([0, 0, 0]);
  });

  it("matches a decision to the answer by its action", () => {
    expect([seedMatched("DECLINE", "DECLINE"), seedMatched("ACCEPT", "KEEP_REQUEST_MORE")]).toEqual([true, false]);
  });
});

describe("the monthly sample (36 § 7.2)", () => {
  it("is due by the month's end, UTC", () => {
    expect(monthOf(new Date("2026-10-09T08:00:00.000Z"))).toEqual({ label: "2026-10", from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-11-01T00:00:00.000Z") });
    expect(monthOf(new Date("2026-12-31T23:59:59.999Z")).to).toEqual(new Date("2027-01-01T00:00:00.000Z"));
  });

  it("draws the same items on every read of a month, another set the next, never more than asked", () => {
    const ids = Array.from({ length: 30 }, (_, index) => `S-36-${String(index + 1).padStart(4, "0")}`);
    const october = sampleOf(ids, "2026-10", 2);
    expect(october).toHaveLength(2);
    expect(sampleOf([...ids].reverse(), "2026-10", 2)).toEqual(october);
    expect(sampleOf(ids, "2026-11", 2)).not.toEqual(october);
    expect(sampleOf(ids.slice(0, 1), "2026-10", 2)).toEqual(["S-36-0001"]);
    expect(sampleOf(ids, "2026-10", 0)).toEqual([]);
  });
});
