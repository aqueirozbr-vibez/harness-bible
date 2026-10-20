import { describe, expect, it } from "vitest";

import rubric from "@/rubric/v1.2/rubric.json";

import type { EvidenceItemView } from "@/lib/schemas/suggestions";

import { ageOf, budgetResetOf, causeOf, fetchStateOf, locationOf, newlyGraded, RULED_CAUSES, ruledOf, stageNumberOf, stakeOf, stillGrading, windowOf } from "./evidenceView";

const { independence, recency } = rubric.adjustments;

describe("fetchStateOf: what an item's fetch status says (32 § 4.2)", () => {
  it("reads opened, unreachable, unsupported, nothing supplied, and not fetched yet", () => {
    expect(fetchStateOf("opened:200")).toEqual({ kind: "opened", status: "200" });
    expect(fetchStateOf("unreachable:403")).toEqual({ kind: "unreachable", cause: "403" });
    expect(fetchStateOf("unreachable:dns")).toEqual({ kind: "unreachable", cause: "dns" });
    expect(fetchStateOf("unreachable:doi_form")).toEqual({ kind: "unreachable", cause: "doi_form" });
    expect(fetchStateOf("unsupported:application/zip")).toEqual({ kind: "unsupported", type: "application/zip" });
    expect(fetchStateOf("not_supplied")).toEqual({ kind: "notSupplied" });
    expect(fetchStateOf(null)).toBeNull();
  });
});

describe("ruledOf: why an item that opened was graded U, as the form words it", () => {
  it("names each of intake rules' reasons, and gives every other the grader's sentence", () => {
    for (const cause of RULED_CAUSES) expect(ruledOf(cause)).toBe(cause);
    for (const other of ["gateway refused (400)", "gateway unavailable (timeout)", "provider refusal (unspecified)", "grading failed before an answer", "bytes_until_49f", "media_mismatch ", null]) expect(ruledOf(other)).toBe("grader");
  });
});

describe("what the list reads for, and what it announces", () => {
  const item = (id: string, fields: Partial<EvidenceItemView>): EvidenceItemView => ({ id, ordinal: 1, kind: "LINK", state: "PENDING", url: null, doi: null, fileName: null, labRunId: null, title: null, host: null, publishedOn: null, ageDays: null, fetchStatus: null, tier: null, baseScore: null, relevance: null, recency: null, independence: null, adjustedScore: null, reason: null, gradedBy: null, gradedAt: null, stage: "1 of 3", ...fields }) as EvidenceItemView;

  it("reads for an item still grading, not for one waiting at the budget cap, which nothing in a draft ends", () => {
    expect(stillGrading(item("a", {}))).toBe(true);
    expect(stillGrading(item("a", { stage: "3 of 3", reason: "budget cap; resets 2026-11-01" }))).toBe(false);
    expect(stillGrading(item("a", { state: "GRADED", tier: "C", stage: null }))).toBe(false);
  });

  it("announces the items a read finds graded with a tier that were pending before it, not a failure, nor one graded already", () => {
    const before = [item("a", {}), item("b", {}), item("c", { state: "GRADED", tier: "D", stage: null }), item("d", {})];
    const after = [item("a", { state: "GRADED", tier: "C", adjustedScore: 56, stage: null }), item("b", { state: "GRADED", tier: "U", stage: null }), item("c", { state: "GRADED", tier: "D", stage: null }), item("d", { stage: "2 of 3" }), item("e", { state: "GRADED", tier: "B", stage: null })];
    expect(newlyGraded(before, after).map((graded) => graded.id)).toEqual(["a"]);
    expect(newlyGraded([], after)).toEqual([]);
  });
});

describe("causeOf: why a link could not be opened, as the form words it", () => {
  it("tells an HTTP status from the network's causes and from the guard's refusals", () => {
    expect(causeOf("403")).toEqual({ kind: "status", status: "403" });
    expect(causeOf("dns")).toEqual({ kind: "network", cause: "dns" });
    expect(causeOf("redirect_target")).toEqual({ kind: "network", cause: "redirect_target" });
    expect(causeOf("doi_form")).toEqual({ kind: "network", cause: "doi_form" });
    for (const refused of ["private", "loopback", "scheme", "link_local", "internal_name", "credentials"]) expect(causeOf(refused)).toEqual({ kind: "guard" });
  });
});

describe("ageOf: an item's age in the unit a person reads", () => {
  it("counts days to sixty, months to two years, then years", () => {
    expect(ageOf(12)).toEqual({ unit: "day", n: 12 });
    expect(ageOf(59)).toEqual({ unit: "day", n: 59 });
    expect(ageOf(150)).toEqual({ unit: "month", n: 5 });
    expect(ageOf(729)).toEqual({ unit: "month", n: 24 });
    expect(ageOf(1100)).toEqual({ unit: "year", n: 3 });
    expect(ageOf(-1)).toEqual({ unit: "day", n: 0 });
  });
});

describe("stakeOf and windowOf: the stake and the recency window the rubric's factors name", () => {
  it("reads the independence factor back to its stake by the rubric's own table", () => {
    expect(stakeOf(1, independence)).toBe("none");
    expect(stakeOf(0.8, independence)).toBe("vendor");
    expect(stakeOf(0.7, independence)).toBe("employer");
    expect(stakeOf(0.5, independence)).toBeNull();
    expect(stakeOf(null, independence)).toBeNull();
  });

  it("names a window only where recency cost something", () => {
    expect(windowOf(1, recency)).toBeNull();
    expect(windowOf(0.7, recency)).toEqual({ kind: "within", days: 365 });
    expect(windowOf(0.3, recency)).toEqual({ kind: "older" });
    expect(windowOf(null, recency)).toBeNull();
    expect(windowOf(0.5, recency)).toBeNull();
  });
});

describe("budgetResetOf, stageNumberOf and locationOf", () => {
  it("reads the reset day from the grading activity's reason, and nothing from another", () => {
    expect(budgetResetOf("budget cap; resets 2026-11-01")).toBe("2026-11-01");
    expect(budgetResetOf("the vendor's own pricing page states the figure")).toBeNull();
    expect(budgetResetOf(null)).toBeNull();
  });

  it("numbers a stage and places an item", () => {
    expect([stageNumberOf("1 of 3"), stageNumberOf("2 of 3"), stageNumberOf("3 of 3")]).toEqual([1, 2, 3]);
    expect(locationOf({ kind: "LINK", url: "https://provider-two.example/pricing#cached-input", doi: null })).toBe("provider-two.example/pricing#cached-input");
    expect(locationOf({ kind: "DOI", url: null, doi: "10.1000/182" })).toBe("10.1000/182");
    expect(locationOf({ kind: "UPLOAD", url: null, doi: null })).toBeNull();
  });
});
