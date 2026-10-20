import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { normalisedQuestion, questionSha256Of } from "./question";

/* A research question's one hash (feature-specs/40 § 5; 48 § 4.2, § 15): the normalised question, then sha256. */

describe("a research question's hash", () => {
  it("normalises the question for its hash alone: lower-cased, whitespace collapsed", () => {
    expect(normalisedQuestion("  What   does the\nbook say?  ")).toBe("what does the book say?");
  });

  it("hashes the normalised question, so two spellings of one question have one hash", () => {
    const expected = createHash("sha256").update("what does the book say?", "utf8").digest("hex");
    expect(questionSha256Of("What does the book say?")).toBe(expected);
    expect(questionSha256Of("  WHAT does\tthe book   say? ")).toBe(expected);
    expect(questionSha256Of("What does the book say")).not.toBe(expected);
  });
});
