import { describe, expect, it } from "vitest";

import { countWords, RATIONALE_WORDS_MAX } from "./words";

describe("countWords (feature-specs/31 § 5)", () => {
  it("counts runs of non-whitespace, whatever the whitespace", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
    expect(countWords("one")).toBe(1);
    expect(countWords("one two")).toBe(2);
    expect(countWords("  one   two\nthree\t four  ")).toBe(4);
    expect(countWords("$0.30 → $0.25, per M tokens.")).toBe(6);
    expect(countWords("não-ASCII também conta")).toBe(3);
  });

  it("is the screen's count: 142 words are 142, and the limit is 200", () => {
    expect(countWords(Array.from({ length: 142 }, (_, index) => `w${String(index)}`).join(" "))).toBe(142);
    expect(RATIONALE_WORDS_MAX).toBe(200);
  });
});
