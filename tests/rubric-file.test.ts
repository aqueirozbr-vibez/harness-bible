import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalise } from "@/lib/guides/load";
import { adjustedOf, factorsOf, scoreOf, type GradedItem } from "@/lib/rubric/score";
import { predict, routeOf } from "@/lib/rubric/thresholds";
import { hasRubric, listRubricVersions, loadRubric, readRubricManifest, RUBRIC_DIR } from "@/lib/rubrics/load";
import { freeTextIn } from "@/lib/schemas/freeText";
import { CHANGE_CLASSES } from "@/lib/schemas/improve";
import { RubricSchema, type Rubric } from "@/lib/schemas/rubric";
import { sha256 } from "@/pipeline/renderHash";
import { RUBRIC_V1_2, WORKED_EXAMPLES } from "@/tests/fixtures/rubric";

/*
 * The published rubric as a file (feature-specs/30 § 5.1): rubric/v1.2 loads, hash-checked against its manifest;
 * its rules are the fixture the rubric's suites assert against; every number of its worked examples is what the
 * arithmetic computes from its items; it holds no sentence; and a changed byte, a file that is not a rubric, or a
 * folder named for another version are each refused.
 */

const v12 = loadRubric("v1.2");
const rubric: Rubric = v12.rubric;

/** An example's items as graded rows, with the factors the file states. */
const itemsOf = (example: Rubric["examples"][number]): GradedItem[] =>
  example.items.map((item, index) => ({ id: `item-${String(index)}`, tier: item.tier, opened: true, relevance: item.factors.relevance, recency: item.factors.recency, independence: item.factors.independence, publisher: `publisher-${String(index)}.example` }));

describe("rubric/v1.2", () => {
  it("is the only version in the folder, and loads against its manifest's hash", () => {
    expect(listRubricVersions()).toEqual(["v1.2"]);
    expect(hasRubric("v1.2")).toBe(true);
    expect(v12.sha256).toBe(readRubricManifest("v1.2").sha256);
    expect(v12.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rubric.version).toBe("v1.2");
    expect(rubric.appliesAt).toBe("2026-07-01");
  });

  it("has the rules the suites assert against", () => {
    expect({ tiers: rubric.tiers, adjustments: rubric.adjustments, thresholds: rubric.thresholds }).toEqual(RUBRIC_V1_2);
  });

  it("maps each of the book's seven chips to the tier the Rubric screen gives it", () => {
    expect(rubric.chips).toEqual({ PRIMARY: "B", VENDOR: "C", ANALYST: "D", PRACTITIONER: "E", ILLUSTRATIVE: null, DERIVED: "A", OPEN: "U" });
  });

  it("carries the four worked examples, each with the numbers the fixtures hold", () => {
    expect(rubric.examples.map((example) => example.id)).toEqual(WORKED_EXAMPLES.map((example) => example.id));
    for (const [index, example] of rubric.examples.entries()) {
      const fixture = WORKED_EXAMPLES[index];
      expect(fixture, example.id).toBeDefined();
      if (fixture === undefined) continue;
      expect(example, example.id).toMatchObject({ changeKind: fixture.changeKind, changeClass: fixture.changeClass, fastMoving: fixture.fastMoving, score: fixture.score, route: fixture.route, decision: fixture.predicted });
      expect(example.items.map((item) => [item.tier, item.relevance, item.stake, item.ageDays, item.base, item.adjusted])).toEqual(fixture.items.map((item) => [item.tier, item.relevance, item.stake, item.ageDays, item.base, item.adjusted]));
      expect(fixture.items[example.strongestItem]?.id).toBe(fixture.strongestId);
      expect(example.corroboratedBy === null ? null : fixture.items[example.corroboratedBy]?.id).toBe(fixture.corroboratedById);
    }
  });

  it("states of each example only what the arithmetic computes from its items", () => {
    for (const example of rubric.examples) {
      for (const item of example.items) {
        expect(item.factors, `${example.id} ${item.tier}`).toEqual(factorsOf(rubric, item, example.fastMoving));
        expect(item.base, `${example.id} ${item.tier}`).toBe(rubric.tiers[item.tier].base);
        expect(item.adjusted, `${example.id} ${item.tier}`).toBe(adjustedOf(rubric, item.tier, item.factors));
      }
      const scored = scoreOf(rubric, itemsOf(example));
      expect(scored.score, example.id).toBe(example.score);
      expect(scored.strongestId, example.id).toBe(`item-${String(example.strongestItem)}`);
      expect(scored.corroboratedById, example.id).toBe(example.corroboratedBy === null ? null : `item-${String(example.corroboratedBy)}`);
      const threshold = rubric.thresholds[example.changeClass];
      expect([example.acceptAt, example.floorAt], example.id).toEqual([threshold?.acceptAt ?? null, threshold?.floorAt ?? null]);
      const strongest = example.items[example.strongestItem];
      const routing = { changeClass: example.changeClass, score: scored.score, verdicts: [], strongestTier: strongest?.tier ?? null };
      expect(routeOf(rubric, routing).route, example.id).toBe(example.route);
      expect(predict(rubric, routing).decision, example.id).toBe(example.decision);
    }
  });

  it("names a threshold for every class, its changelog ends with itself, and it holds no sentence", () => {
    expect(Object.keys(rubric.thresholds)).toEqual([...CHANGE_CLASSES]);
    expect(rubric.changelog.map((entry) => entry.version)).toEqual(["v1.0", "v1.1", "v1.2"]);
    expect(freeTextIn(RubricSchema)).toEqual([]);
  });
});

describe("loadRubric refuses", () => {
  function copyOf(): string {
    const dir = mkdtempSync(join(tmpdir(), "hb-rubric-"));
    cpSync(join(RUBRIC_DIR, "v1.2"), join(dir, "v1.2"), { recursive: true });
    return dir;
  }

  it("a changed byte: a rubric is never edited in place", () => {
    const dir = copyOf();
    const file = join(dir, "v1.2", "rubric.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"bonus": 10', '"bonus": 11'));
    expect(() => loadRubric("v1.2", dir)).toThrow(/rubric v1\.2 has changed .* never edited in place/);
  });

  it("a file that is not a rubric, even when its manifest is pinned to it", () => {
    const dir = copyOf();
    const file = join(dir, "v1.2", "rubric.json");
    const text = readFileSync(file, "utf8").replace('"bonus": 10', '"bonus": 10.5');
    writeFileSync(file, text);
    const manifest = join(dir, "v1.2", "manifest.json");
    writeFileSync(manifest, JSON.stringify({ ...(JSON.parse(readFileSync(manifest, "utf8")) as object), sha256: sha256(normalise(text)) }));
    expect(() => loadRubric("v1.2", dir)).toThrow(/rubric v1\.2 is not a rubric: adjustments\.corroboration\.bonus/);
  });

  it("a folder named for another version than the file says", () => {
    const dir = copyOf();
    cpSync(join(dir, "v1.2"), join(dir, "v9.9"), { recursive: true });
    expect(() => loadRubric("v9.9", dir)).toThrow("rubric v9.9 says it is v1.2");
    expect(listRubricVersions(dir)).toEqual(["v1.2", "v9.9"]);
  });

  it("knows what is not a version", () => {
    expect(hasRubric("current")).toBe(false);
    expect(hasRubric("v9.9")).toBe(false);
    expect(hasRubric("../guides")).toBe(false);
    expect(listRubricVersions(join(RUBRIC_DIR, "nowhere"))).toEqual([]);
  });
});
