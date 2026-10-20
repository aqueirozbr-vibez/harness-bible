import { describe, expect, it } from "vitest";

import { chaptersOf, definitionOf, PATH_DEFINITIONS, PathDefinitionSchema, stopId, stopsOf } from "./definitions";

describe("path definitions (05 § 4.2)", () => {
  it("are the three sequences of the Book-Paths screen", () => {
    expect(PATH_DEFINITIONS.map((d) => [d.key, d.version, stopsOf(d).length])).toEqual([
      ["executive", "v1.1", 8],
      ["builder", "v1.2", 14],
      ["foundations", "v1.0", 15],
    ]);
    expect(stopsOf(definitionOf("builder")).map(stopId)).toEqual(["ch16", "ch17", "ch18", "ch19", "ch20", "ch21", "ch22", "ch23", "ch25", "ch26", "ch27", "ch28", "ch29", "ch31"]);
    expect(stopsOf(definitionOf("executive")).map(stopId)).toEqual(["ch00", "ch34", "ch37", "ch38", "ch36", "ch39", "ch40", "decision-aids-8"]);
    expect(chaptersOf(definitionOf("executive"))).toEqual([0, 21, 23, 28, 31, 34, 36, 37, 38, 39, 40]);
  });

  it("validate and carry unique stop ids", () => {
    for (const definition of PATH_DEFINITIONS) {
      expect(() => PathDefinitionSchema.parse(definition)).not.toThrow();
      const ids = stopsOf(definition).map(stopId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
