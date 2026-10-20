import { describe, expect, it } from "vitest";

import en from "../messages/en.json";
import pt from "../messages/pt.json";

/*
 * Message key parity (code-standards § Next.js i18n): every key in one
 * catalogue exists in the other. Values may differ; keys may not.
 */

function flatten(value: unknown, prefix = ""): ReadonlyArray<string> {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => flatten(v, prefix === "" ? k : `${prefix}.${k}`));
}

describe("message catalogues", () => {
  it("have identical key sets in en and pt", () => {
    const enKeys = [...flatten(en)].sort();
    const ptKeys = [...flatten(pt)].sort();
    expect(ptKeys).toEqual(enKeys);
  });

  it("have no empty strings", () => {
    for (const catalogue of [en, pt]) {
      const leaves = flatten(catalogue).map((key) =>
        key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], catalogue),
      );
      expect(leaves.every((v) => typeof v === "string" && v.length > 0)).toBe(true);
    }
  });
});
