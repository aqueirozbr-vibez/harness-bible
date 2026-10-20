import { describe, expect, it } from "vitest";

import type { Proposal } from "@/lib/schemas/improve";

import { fastMovingOf } from "./proposal";

describe("fastMovingOf: whether recency applies to a suggestion's evidence (30 § 3.4)", () => {
  const claim = (fastMoving: boolean): Proposal => ({ kind: "ADD_CLAIM", text: "Provider tier 3 cut its batch price.", placeAfter: "end", fastMoving });
  const row = (fastMoving: boolean): Proposal => ({ kind: "ADD_ROW", claim: "batch discount, provider tier 3", citation: "Provider three pricing page", tier: "VENDOR", fastMoving });

  it("reads a claim's or a row's declaration, whatever the section's flag", () => {
    expect(fastMovingOf(claim(true), false)).toBe(true);
    expect(fastMovingOf(row(true), false)).toBe(true);
    expect(fastMovingOf(claim(false), true)).toBe(false);
    expect(fastMovingOf(row(false), true)).toBe(false);
  });

  it("reads the anchor's own flag for every other kind, and for a draft with no proposal yet", () => {
    expect(fastMovingOf({ kind: "SET_VALUE", after: "0.25", unit: "USD" }, true)).toBe(true);
    expect(fastMovingOf({ kind: "EDIT_ROW", claim: "cached-input price" }, false)).toBe(false);
    expect(fastMovingOf({ kind: "EDIT_TEXT", before: "three times", after: "four times" }, false)).toBe(false);
    expect(fastMovingOf({ kind: "RESTRUCTURE", description: "Split the section." }, true)).toBe(true);
    expect(fastMovingOf(null, true)).toBe(true);
    expect(fastMovingOf(null, false)).toBe(false);
  });
});
