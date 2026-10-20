import { describe, expect, it } from "vitest";

import { GoldenItemSchema } from "@/lib/schemas/golden";

import { generateGoldenSet, MIX, seeded, shuffle, TOTAL, usableLabel, type GoldenSource } from "./assistant";

function source(): GoldenSource {
  const chapters = Array.from({ length: 41 }, (_, n) => ({
    number: n,
    title: `Chapter ${n}`,
    part: n === 0 ? "P0" : n < 16 ? "P1" : n < 34 ? "P2" : "P3",
    verified: n <= 33,
    labId: n === 0 || n === 33 ? null : `lab-${String(n).padStart(2, "0")}`,
    refersTo: n > 1 ? [n - 1, n - 2] : [],
  }));
  const figures = chapters.flatMap((c) =>
    Array.from({ length: 8 }, (_, i) => ({
      id: `F-${String(c.number).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`,
      sectionId: `${String(c.number).padStart(2, "0")}.${(i % 8) + 1}`,
      chapter: c.number,
      label: `figure ${i} of ${c.number}`,
      valueText: `${i + 1}%`,
      tier: i % 3 === 0 ? "DERIVED" : i % 3 === 1 ? "VENDOR" : "ILLUSTRATIVE",
    })),
  );
  const sourceRows = chapters.flatMap((c) => Array.from({ length: 3 }, (_, i) => ({ id: `${String(c.number).padStart(2, "0")}.9 r${i + 1}`, chapter: c.number, claim: `claim ${i} of chapter ${c.number}`, tier: "PRIMARY" })));
  return { release: "2026.09", figures, sourceRows, chapters };
}

describe("golden set generator", () => {
  it("is deterministic for a release and yields the planned mix of 300", () => {
    const a = generateGoldenSet(source());
    const b = generateGoldenSet(source());
    expect(a).toEqual(b);
    expect(a).toHaveLength(TOTAL);
    expect(TOTAL).toBe(300);
    const counts = a.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.kind]: (acc[item.kind] ?? 0) + 1 }), {});
    expect(counts).toEqual({ figure: MIX.figure, claim: MIX.claim, compare: MIX.compare, lab: MIX.lab, refusal: MIX.refusal });
    expect(a.filter((i) => i.language === "pt")).toHaveLength(MIX.figurePt);
    expect(a.map((i) => i.id)).toEqual(a.map((_, i) => `G-${String(i + 1).padStart(4, "0")}`));
    expect(seeded("x")()).toBe(seeded("x")());
    expect(shuffle([1, 2, 3, 4], seeded("s"))).not.toEqual(shuffle([1, 2, 3, 4], seeded("t")));
  });

  it("labels every item from the rows: figures cite their section and id, refusals carry a cause, nothing cites an unverified or illustrative figure", () => {
    const items = generateGoldenSet(source());
    for (const item of items) GoldenItemSchema.parse(item);
    const figure = items.find((i) => i.kind === "figure");
    expect(figure?.expected.citations[0].figureId).toMatch(/^F-\d{2}-\d{2}$/);
    expect(figure?.expected.valueText).toMatch(/%$/);
    expect(items.filter((i) => i.kind === "figure").every((i) => i.context.chapter <= 33)).toBe(true);
    const refusals = items.filter((i) => i.kind === "refusal");
    expect(new Set(refusals.map((i) => i.expected.refusal?.cause))).toEqual(new Set(["R-SCOPE", "R-SCOPE-OT", "R-RECOMPUTE", "R-UNVERIFIED"]));
    expect(refusals.filter((i) => i.expected.refusal?.cause === "R-UNVERIFIED").every((i) => i.context.chapter >= 34)).toBe(true);
    expect(items.filter((i) => i.kind === "compare").every((i) => i.expected.chapters.length === 2)).toBe(true);
    expect(items.filter((i) => i.kind === "claim").every((i) => i.expected.sourceRowId !== null)).toBe(true);
    expect(items.filter((i) => i.kind === "lab").every((i) => i.expected.citations[0].sectionId.endsWith(".4"))).toBe(true);
    expect(refusals.filter((i) => i.expected.refusal?.cause === "R-UNVERIFIED")).toHaveLength(12);
    expect(refusals.filter((i) => i.mode === "brief").length).toBeGreaterThan(0);
  });

  it("asks only about labels the extractor left readable", () => {
    expect(usableLabel("expected work redone")).toBe(true);
    expect(usableLabel("000 tokens →")).toBe(false);
    expect(usableLabel("episodic about")).toBe(false);
    expect(usableLabel("x")).toBe(false);
    expect(usableLabel("cache hit rate")).toBe(true);
  });
});
