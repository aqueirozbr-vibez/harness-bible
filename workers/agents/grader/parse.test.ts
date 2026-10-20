import { describe, expect, it } from "vitest";

import { EvidenceGradeOutputSchema, parseEvidenceGrade, REASON_WORDS_MAX } from "./parse";

/*
 * The evidence grader's output parsed strictly (feature-specs/32 § 7.2, § 7.3): five keys and no others; B to G;
 * none or vendor; a date or null; at most thirty words. Each refusal names the first thing wrong in one sentence,
 * which becomes the item's reason. A fence or prose around the object is taken off, as for every agent.
 */

const GOOD = { tier: "C", relevance: "direct", stake: "vendor", publishedOn: "2026-07-14", reason: "The vendor's own pricing page states the figure the change proposes." };

describe("parseEvidenceGrade", () => {
  it("takes the object, with or without a fence or prose around it", () => {
    expect(parseEvidenceGrade(JSON.stringify(GOOD))).toEqual({ ok: true, grade: GOOD });
    expect(parseEvidenceGrade(`\`\`\`json\n${JSON.stringify(GOOD, null, 2)}\n\`\`\``)).toEqual({ ok: true, grade: GOOD });
    expect(parseEvidenceGrade(`Here is my classification:\n${JSON.stringify(GOOD)}\nDone.`)).toEqual({ ok: true, grade: GOOD });
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, publishedOn: null, stake: "none" }))).toMatchObject({ ok: true, grade: { publishedOn: null, stake: "none" } });
  });

  it("refuses text that is not JSON", () => {
    expect(parseEvidenceGrade("The document is a vendor page. Tier C.")).toEqual({ ok: false, reason: "the grader's output is not JSON" });
    expect(parseEvidenceGrade("")).toEqual({ ok: false, reason: "the grader's output is not JSON" });
    expect(parseEvidenceGrade("{ tier: C }")).toEqual({ ok: false, reason: "the grader's output is not JSON" });
  });

  it("refuses an unknown key, by name", () => {
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, score: 70 }))).toEqual({ ok: false, reason: "the grader's output has a key it may not have: score" });
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, adjusted: 56, base: 70 }))).toMatchObject({ ok: false, reason: expect.stringContaining("adjusted") as string });
  });

  it("refuses tier A and tier U, which are never the grader's to give, and anything that is not a tier", () => {
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, tier: "A" }))).toEqual({ ok: false, reason: "tier A is not the grader's to give" });
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, tier: "U" }))).toEqual({ ok: false, reason: "tier U is not the grader's to give" });
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, tier: "c" }))).toEqual({ ok: false, reason: "tier c is not the grader's to give" });
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, tier: 3 }))).toEqual({ ok: false, reason: "the grader's output names no tier" });
    const noTier: Record<string, unknown> = { ...GOOD };
    delete noTier["tier"];
    expect(parseEvidenceGrade(JSON.stringify(noTier))).toEqual({ ok: false, reason: "the grader's output names no tier" });
  });

  it("refuses a reason over thirty words, counting them, and an empty one", () => {
    const words = (n: number): string => Array.from({ length: n }, (_, index) => `w${String(index)}`).join(" ");
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, reason: words(31) }))).toEqual({ ok: false, reason: `the reason is 31 words, over ${String(REASON_WORDS_MAX)}` });
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, reason: words(30) }))).toMatchObject({ ok: true });
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, reason: "  " }))).toMatchObject({ ok: false, reason: expect.stringContaining("reason") as string });
  });

  it("refuses the third stake, which is code's, a relevance it does not know and a date that is not one", () => {
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, stake: "employer" }))).toMatchObject({ ok: false, reason: expect.stringContaining("stake") as string });
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, relevance: "strong" }))).toMatchObject({ ok: false, reason: expect.stringContaining("relevance") as string });
    expect(parseEvidenceGrade(JSON.stringify({ ...GOOD, publishedOn: "July 2026" }))).toMatchObject({ ok: false, reason: expect.stringContaining("publishedOn") as string });
    expect(parseEvidenceGrade(JSON.stringify([GOOD]))).toMatchObject({ ok: false });
  });

  it("is the schema the agent's output is held to: strict, five keys", () => {
    expect(Object.keys(EvidenceGradeOutputSchema.shape).sort()).toEqual(["publishedOn", "reason", "relevance", "stake", "tier"]);
    expect(EvidenceGradeOutputSchema.safeParse({ ...GOOD, extra: 1 }).success).toBe(false);
  });
});
