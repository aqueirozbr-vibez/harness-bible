import { describe, expect, it } from "vitest";

import { bumpOf, nextVersion, subHeadingsOf } from "./versions";

const current = { title: "T", layerTitles: ["Intuition", "Mechanism"], subHeadings: ["A", "B"], contentHash: "h2" };
const previous = { ...current, contentHash: "h1", version: "v1.2.3" };

describe("nextVersion (D4)", () => {
  it("starts every chapter at v1.0.0", () => {
    expect(nextVersion(current, null)).toBe("v1.0.0");
  });
  it("keeps the version when the content hash is unchanged", () => {
    expect(nextVersion({ ...current, contentHash: "h1" }, previous)).toBe("v1.2.3");
  });
  it("bumps patch for text-only changes, minor for sub-heading changes, major for structure", () => {
    expect(nextVersion(current, previous)).toBe("v1.2.4");
    expect(nextVersion({ ...current, subHeadings: ["A", "C"] }, previous)).toBe("v1.3.0");
    expect(nextVersion({ ...current, layerTitles: ["Intuition", "Mechanics"] }, previous)).toBe("v2.0.0");
    expect(nextVersion({ ...current, title: "New" }, previous)).toBe("v2.0.0");
  });
  it("names the bump a merge will make by the same rule, and none when nothing changed (feature-specs/37 § 5)", () => {
    expect(bumpOf(previous, { ...current, contentHash: "h1" })).toBeNull();
    expect(bumpOf(previous, current)).toBe("patch");
    expect(bumpOf(previous, { ...current, subHeadings: ["A", "C"] })).toBe("minor");
    expect(bumpOf(previous, { ...current, layerTitles: ["Intuition", "Mechanics"] })).toBe("major");
  });
  it("lists ### sub-headings", () => {
    expect(subHeadingsOf("### One\ntext\n## Not\n### Two  \n")).toEqual(["One", "Two"]);
  });
});
