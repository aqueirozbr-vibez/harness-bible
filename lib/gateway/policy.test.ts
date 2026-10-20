import { describe, expect, it } from "vitest";

import { REQUEST_ROWS } from "@/lib/schemas/gateway";

import { limitsFor, limitsOfRow, REQUEST_POLICIES, requestFor, type PolicyName } from "./policy";

describe("request policy per purpose (feature-specs/11 § 5.3, D6)", () => {
  it("gives every purpose all six fields and a reason", () => {
    const names = Object.keys(REQUEST_POLICIES) as PolicyName[];
    expect(names).toEqual(["assistantDraft", "assistantRepair", "groundingGrader", "scopeClassifier", "evidenceGrader", "evidenceGraderBytes", "adjudicator", "researchPlanner", "researchReader", "researchWriter"]);
    expect(names).toEqual([...REQUEST_ROWS]);
    for (const name of names) {
      const policy = REQUEST_POLICIES[name];
      expect(policy.alias).toMatch(/^hb-/);
      expect(Number.isInteger(policy.maxTokens) && policy.maxTokens > 0).toBe(true);
      expect(policy.effort === null || policy.effort === "low" || policy.effort === "medium" || policy.effort === "high").toBe(true);
      expect(policy.timeoutMs).toBeGreaterThan(0);
      expect(Number.isInteger(policy.maxRetries) && policy.maxRetries >= 0).toBe(true);
      expect(typeof policy.stream).toBe("boolean");
      expect(policy.reason.length).toBeGreaterThan(0);
    }
  });

  it("holds the spec's table", () => {
    expect(REQUEST_POLICIES.assistantDraft).toMatchObject({ alias: "hb-frontier", maxTokens: 64_000, effort: "medium", timeoutMs: 60_000, maxRetries: 2, stream: true });
    expect(REQUEST_POLICIES.assistantRepair).toMatchObject({ alias: "hb-frontier", maxTokens: 16_000, effort: "medium", timeoutMs: 60_000, maxRetries: 2, stream: false });
    expect(REQUEST_POLICIES.groundingGrader).toMatchObject({ alias: "hb-frontier", maxTokens: 16_000, effort: "medium", timeoutMs: 30_000, maxRetries: 2, stream: false });
    expect(REQUEST_POLICIES.scopeClassifier).toMatchObject({ alias: "hb-small", maxTokens: 256, effort: null, timeoutMs: 5_000, maxRetries: 1, stream: false });
    expect(REQUEST_POLICIES.evidenceGrader).toMatchObject({ alias: "hb-small", maxTokens: 512, effort: null, timeoutMs: 20_000, maxRetries: 2, stream: false });
  });

  /* A timeout is retried, so the wall clock a caller may wait is the row's timeout times its attempts. The number
   * belongs in the reason a reader sees, and this keeps the two from drifting apart. */
  it("states each row's worst-case wall clock in its reason", () => {
    for (const name of Object.keys(REQUEST_POLICIES) as PolicyName[]) {
      const policy = REQUEST_POLICIES[name];
      const worstCaseMs = policy.timeoutMs * (policy.maxRetries + 1);
      expect(policy.reason).toContain(`worst case ${worstCaseMs / 1_000} s`);
    }
  });

  it("builds the request fields a policy fixes", () => {
    expect(requestFor("assistantDraft")).toEqual({ model: "hb-frontier", max_tokens: 64_000, output_config: { effort: "medium" } });
    expect(requestFor("assistantRepair")).toEqual({ model: "hb-frontier", max_tokens: 16_000, output_config: { effort: "medium" } });
    expect(requestFor("groundingGrader")).toEqual({ model: "hb-frontier", max_tokens: 16_000, output_config: { effort: "medium" } });
  });

  /* `hb-small` is claude-haiku-4-5, which answers 400 to `output_config.effort`: the classifier's request carries no
   * `output_config` at all, not an empty one, so nobody adds an effort to it later. */
  it("emits no output_config for the scope classifier", () => {
    const params = requestFor("scopeClassifier");
    expect(params).toEqual({ model: "hb-small", max_tokens: 256 });
    expect(params).not.toHaveProperty("output_config");
    expect(Object.keys(params)).toEqual(["model", "max_tokens"]);
    expect(JSON.stringify(params)).not.toContain("output_config");
  });

  /* `limitsFor` keys on `(purpose, alias)`, which is the same pair for the draft and the repair: the draft's row
   * answers for both, so the repair's own limits are only ever read through it. Keep them equal or the repair's
   * numbers say one thing and the request carries another. */
  it("keeps the repair's limits equal to the draft's, because limitsFor cannot tell the two apart", () => {
    expect(REQUEST_POLICIES.assistantRepair.timeoutMs).toBe(REQUEST_POLICIES.assistantDraft.timeoutMs);
    expect(REQUEST_POLICIES.assistantRepair.maxRetries).toBe(REQUEST_POLICIES.assistantDraft.maxRetries);
    expect(limitsFor("assistant", "hb-frontier")).toEqual({ timeoutMs: REQUEST_POLICIES.assistantRepair.timeoutMs, maxRetries: REQUEST_POLICIES.assistantRepair.maxRetries });
  });

  it("names the timeout and the retry count by purpose and alias, and refuses a pair without a row", () => {
    expect(limitsFor("assistant", "hb-frontier")).toEqual({ timeoutMs: 60_000, maxRetries: 2 });
    expect(limitsFor("assistant", "hb-small")).toEqual({ timeoutMs: 5_000, maxRetries: 1 });
    expect(limitsFor("grading", "hb-frontier")).toEqual({ timeoutMs: 30_000, maxRetries: 2 });
    expect(limitsFor("grading", "hb-small")).toEqual({ timeoutMs: 20_000, maxRetries: 2 });
    expect(() => limitsFor("adjudication", "hb-small")).toThrow(/no request policy/);
    expect(() => limitsFor("embed", "hb-embed")).toThrow(/GATEWAY_POLICY_UNKNOWN|no request policy/);
    /* unit 50d: the adjudicator's one try of 120 s (feature-specs/33 § 5.1) */
    expect(limitsFor("adjudication", "hb-frontier")).toEqual({ timeoutMs: 120_000, maxRetries: 0 });
    expect(() => limitsFor("lab", "hb-frontier")).toThrow(/no request policy/);
    /* unit 58a: the planner's one try of 30 s on the small model, the reader's one request of 180 s (feature-specs/41 § 3) */
    expect(limitsFor("research", "hb-small")).toEqual({ timeoutMs: 30_000, maxRetries: 0 });
    expect(limitsFor("research", "hb-frontier")).toEqual({ timeoutMs: 600_000, maxRetries: 0 });
    expect(REQUEST_POLICIES.researchPlanner).toMatchObject({ alias: "hb-small", maxTokens: 1_024, effort: null, stream: false });
    expect(REQUEST_POLICIES.researchReader).toMatchObject({ alias: "hb-frontier", maxTokens: 16_000, effort: "medium", stream: true });
    expect(requestFor("researchPlanner")).toEqual({ model: "hb-small", max_tokens: 1_024 });
  });

  /* Unit 49f: a PDF or an image shares the text row's purpose and alias, so the call names its row. */
  it("gives a PDF or an image its own row, one try of 90 s, which a call names, and refuses a row of another alias", () => {
    expect(REQUEST_POLICIES.evidenceGraderBytes).toMatchObject({ alias: "hb-small", maxTokens: 512, effort: null, timeoutMs: 90_000, maxRetries: 0, stream: false });
    expect(limitsOfRow("evidenceGraderBytes", "hb-small")).toEqual({ timeoutMs: 90_000, maxRetries: 0 });
    expect(limitsOfRow("evidenceGrader", "hb-small")).toEqual(limitsFor("grading", "hb-small"));
    expect(() => limitsOfRow("evidenceGraderBytes", "hb-frontier")).toThrow(/is for hb-small, not hb-frontier/);
    expect(() => limitsOfRow("assistantDraft", "hb-small")).toThrow(/GATEWAY_POLICY_UNKNOWN|is for hb-frontier/);
    expect(requestFor("evidenceGraderBytes")).toEqual({ model: "hb-small", max_tokens: 512 });
  });

  /* Unit 69d: the research writer shares its purpose and alias with the reader (feature-specs/48 § 5.6, D1), so the call names it. */
  it("gives the research writer its own row, one unstreamed try of 120 s, which a call names, while the pair still answers the reader's", () => {
    expect(REQUEST_POLICIES.researchWriter).toMatchObject({ alias: "hb-frontier", maxTokens: 16_000, effort: "medium", timeoutMs: 120_000, maxRetries: 0, stream: false });
    expect(limitsOfRow("researchWriter", "hb-frontier")).toEqual({ timeoutMs: 120_000, maxRetries: 0 });
    expect(limitsFor("research", "hb-frontier")).toEqual({ timeoutMs: 600_000, maxRetries: 0 });
    expect(() => limitsOfRow("researchWriter", "hb-small")).toThrow(/is for hb-frontier, not hb-small/);
    expect(requestFor("researchWriter")).toEqual({ model: "hb-frontier", max_tokens: 16_000, output_config: { effort: "medium" } });
  });
});
