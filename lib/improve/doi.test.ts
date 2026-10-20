import { describe, expect, it } from "vitest";

import { doiUrl, normaliseDoi } from "./doi";

describe("normaliseDoi", () => {
  it.each<[string, string | null]>([
    ["10.1038/171737a0", "10.1038/171737a0"],
    ["10.1000/182", "10.1000/182"],
    ["https://doi.org/10.1038/171737a0", "10.1038/171737a0"],
    ["http://dx.doi.org/10.1038/171737a0", "10.1038/171737a0"],
    ["HTTPS://DOI.ORG/10.1038/171737A0", "10.1038/171737a0"],
    ["doi:10.1038/171737a0", "10.1038/171737a0"],
    ["DOI: 10.1038/171737a0", "10.1038/171737a0"],
    ["  10.1038/171737a0  ", "10.1038/171737a0"],
    ["https://doi.org/10.1000/182#top", "10.1000/182#top"], // a fragment is part of the suffix as a DOI reads it; doi.org decides
    ["https://doi.org/10.1016/j.cell.2026.01.001", "10.1016/j.cell.2026.01.001"],
    ["https://doi.org/10.1002/(SICI)1097-0258(19980430)17:8%3C857::AID-SIM777%3E3.0.CO;2-E", "10.1002/(sici)1097-0258(19980430)17:8<857::aid-sim777>3.0.co;2-e"],
    ["10.1038", null],
    ["10.1038/", null],
    ["11.1038/171737a0", null],
    ["10.103/171737a0", null],
    ["10.1038/171 737a0", null],
    ["https://example.com/10.1038/171737a0", null],
    ["", null],
    ["not a doi", null],
    ["10.1038/%E0%A4%A", null], // bad percent encoding
  ])("%s → %s", (input, expected) => {
    expect(normaliseDoi(input)).toBe(expected);
  });
});

describe("doiUrl", () => {
  it("is the resolver's URL with the suffix encoded", () => {
    expect(doiUrl("10.1038/171737a0")).toBe("https://doi.org/10.1038/171737a0");
    expect(doiUrl("10.1002/(sici)1097-0258(19980430)17:8<857::aid-sim777>3.0.co;2-e")).toBe("https://doi.org/10.1002/(sici)1097-0258(19980430)17%3A8%3C857%3A%3Aaid-sim777%3E3.0.co%3B2-e");
    expect(doiUrl("10.1000/a/b")).toBe("https://doi.org/10.1000/a/b");
  });
});
