import { describe, expect, it } from "vitest";

import type { SuggestionView } from "@/lib/schemas/suggestions";

import { changeOf, declinedBy, queueDeadlineOf, refreshKeyOf, resendsWithdrawal, shortHash, throttleNoteOf, variantOf, WITHDRAWAL_RESEND_MS } from "./outcomeView";

type Decided = NonNullable<SuggestionView["adjudication"]>;
const decided = (fields: Partial<Decided>): Decided => ({ decision: "REQUEST_MORE", decidedBy: "adjudicator", score: 66, acceptAt: 70, floorAt: 25, sufficientTier: null, failingSensor: null, guideVersion: "v2.1", modelId: "m", rubricVersion: "v1.2", decidedAt: "2026-10-08T12:00:00.000Z", criteria: [], ...fields });
/* The suggestion's outcome is the row's decision unless a case says otherwise: the router writes no row, and a curator moves the outcome alone. */
const at = (state: SuggestionView["state"], adjudication: Decided | null, budgetResetsAt: string | null = null, outcome: SuggestionView["outcome"] = adjudication?.decision ?? null, origin: SuggestionView["origin"] = "HUMAN") => variantOf({ state, outcome, adjudication, budgetResetsAt, origin });

describe("variantOf: § 4's variants", () => {
  it("reads a researcher's proposal the adjudicator accepted, in the queue, as a recommendation; merging, merged or a person's accept as accepted (43 § 7.1)", () => {
    expect(at("CURATOR_QUEUE", decided({ decision: "ACCEPT" }), null, "ACCEPT", "RESEARCHER")).toBe("recommended");
    expect(at("MERGING", decided({ decision: "ACCEPT" }), null, "ACCEPT", "RESEARCHER")).toBe("accepted");
    expect(at("DECIDED", decided({ decision: "ACCEPT" }), null, "ACCEPT", "HUMAN")).toBe("accepted");
    expect(at("CURATOR_QUEUE", decided({ decision: "CURATOR_REVIEW" }), null, "CURATOR_REVIEW", "RESEARCHER")).toBe("curator");
  });

  it("in progress, or waiting for budget, until something is decided", () => {
    expect(at("SUBMITTED", null)).toBe("progress");
    expect(at("SENSED", null)).toBe("progress");
    expect(at("GRADED", null, "2026-11-01T00:00:00.000Z")).toBe("budget");
  });

  it("by the decision once there is one, and by the state past it", () => {
    expect(at("INTAKE_DECLINED", decided({ decision: "DECLINE", decidedBy: "intake-rules" }))).toBe("declined");
    expect(at("CURATOR_QUEUE", decided({}))).toBe("requestMore");
    expect(at("CURATOR_QUEUE", decided({ decidedBy: "intake-rules", sufficientTier: "A" }))).toBe("requestMoreByRule");
    expect(at("CURATOR_QUEUE", decided({ decision: "CURATOR_REVIEW" }))).toBe("curator");
    expect(at("DECIDED", decided({ decision: "ACCEPT" }))).toBe("accepted");
    expect(at("MERGED", decided({ decision: "ACCEPT" }))).toBe("accepted");
  });

  it("a decline that ends in CLOSED is still a decline; closed is a curator's", () => {
    expect(at("CLOSED", decided({ decision: "DECLINE" }))).toBe("declined");
    expect(at("CLOSED", decided({ decision: "DECLINE", decidedBy: "intake-rules" }))).toBe("declined");
    expect(at("CLOSED", decided({ decision: "CURATOR_REVIEW", decidedBy: "router" }))).toBe("closed");
    expect(at("CLOSED", decided({}))).toBe("closed");
  });

  it("a researcher's proposal closed by no curator says so: the rules' or the adjudicator's request for more is not proposed, the check's after an accept is the check's (review of unit 60)", () => {
    const failed = { check: { stage: "CHECKED", at: "2026-10-09T10:00:00.000Z", verdict: "FAILED" } } as unknown as SuggestionView["merge"];
    const closed = (adjudication: Decided | null, outcome: SuggestionView["outcome"], merge: SuggestionView["merge"] = null) => variantOf({ state: "CLOSED", outcome, adjudication, budgetResetsAt: null, merge, origin: "RESEARCHER" });
    expect(closed(decided({ decidedBy: "intake-rules", sufficientTier: "A" }), "REQUEST_MORE")).toBe("notProposed");
    expect(closed(decided({}), "REQUEST_MORE")).toBe("notProposed");
    /* recommended, accepted by a curator, and the chapter's check failed: closed, and the check's */
    expect(closed(decided({ decision: "ACCEPT", decidedAt: "2026-10-08T12:00:00.000Z" }), "REQUEST_MORE", failed)).toBe("checkFailed");
    /* a curator's decline of a recommendation is a curator's close; Improve's own decline stays a decline */
    expect(closed(decided({ decision: "ACCEPT" }), "DECLINE")).toBe("closed");
    expect(closed(decided({ decision: "DECLINE", decidedBy: "intake-rules" }), "DECLINE")).toBe("declined");
    /* a person's suggestion closed is a curator's, as before */
    expect(variantOf({ state: "CLOSED", outcome: "REQUEST_MORE", adjudication: decided({}), budgetResetsAt: null, origin: "HUMAN" })).toBe("closed");
  });

  it("a contributor's withdrawal: being recorded wherever the suggestion waited, withdrawn once closed, before any decline (45 § 5.4)", () => {
    const AT = "2026-10-11T13:00:00.000Z";
    const of = (state: SuggestionView["state"], adjudication: Decided | null, outcome: SuggestionView["outcome"], withdrawnAt: string | null) => variantOf({ state, outcome, adjudication, budgetResetsAt: null, origin: "HUMAN", withdrawnAt });
    expect(of("CURATOR_QUEUE", decided({ decision: "CURATOR_REVIEW" }), "CURATOR_REVIEW", AT)).toBe("withdrawing");
    expect(of("DECIDED", decided({}), "REQUEST_MORE", AT)).toBe("withdrawing");
    expect(of("INTAKE_DECLINED", decided({ decision: "DECLINE", decidedBy: "intake-rules" }), "DECLINE", AT)).toBe("withdrawing");
    /* closed by the withdrawal: not the decline it was withdrawn from, nor a curator's close */
    expect(of("CLOSED", decided({ decision: "DECLINE", decidedBy: "intake-rules" }), "DECLINE", AT)).toBe("withdrawn");
    expect(of("CLOSED", decided({}), "REQUEST_MORE", AT)).toBe("withdrawn");
    /* none asked for: as before */
    expect(of("CLOSED", decided({ decision: "DECLINE", decidedBy: "intake-rules" }), "DECLINE", null)).toBe("declined");
    expect(of("CURATOR_QUEUE", decided({ decision: "CURATOR_REVIEW" }), "CURATOR_REVIEW", null)).toBe("curator");
    expect(at("CLOSED", decided({}))).toBe("closed");
  });

  it("and a withdrawal still being recorded is offered again once it has stood WITHDRAWAL_RESEND_MS, never before, never where none was asked for (review of unit 63)", () => {
    const asked = "2026-10-11T13:00:00.000Z";
    expect(resendsWithdrawal(asked, new Date(Date.parse(asked) + WITHDRAWAL_RESEND_MS - 1))).toBe(false);
    expect(resendsWithdrawal(asked, new Date(Date.parse(asked) + WITHDRAWAL_RESEND_MS))).toBe(true);
    expect(resendsWithdrawal(null, new Date(Date.parse(asked) + WITHDRAWAL_RESEND_MS))).toBe(false);
  });

  it("a suggestion the router queued has no decision row, and is with a curator; a curator's decision is the outcome, not the row", () => {
    expect(at("CURATOR_QUEUE", null, null, "CURATOR_REVIEW")).toBe("curator");
    /* An adjudicator's failure queued for a curator, who keeps the request for more: the row still says CURATOR_REVIEW. */
    expect(at("DECIDED", decided({ decision: "CURATOR_REVIEW" }), null, "REQUEST_MORE")).toBe("requestMore");
    expect(at("DECIDED", null, null, "REQUEST_MORE")).toBe("requestMore");
    expect(at("CLOSED", decided({ decision: "CURATOR_REVIEW", decidedBy: "router" }), null, "DECLINE")).toBe("closed");
  });

  it("a revision under way is in progress, the earlier attempt's decision notwithstanding", () => {
    expect(at("SUBMITTED", decided({ decision: "DECLINE", decidedBy: "intake-rules" }))).toBe("progress");
    expect(at("GRADED", decided({}), "2026-11-01T00:00:00.000Z")).toBe("budget");
  });

  it("an accepted change its chapter's check returned is the check's request for more, until a revision is decided again (37 § 4.5)", () => {
    const checked = (verdict: "PASSED" | "FAILED") => ({ check: { stage: "CHECKED", at: "2026-10-09T10:00:00.000Z", verdict } }) as unknown as SuggestionView["merge"];
    const of = (adjudication: Decided | null, merge: SuggestionView["merge"], state: SuggestionView["state"] = "DECIDED", outcome: SuggestionView["outcome"] = "REQUEST_MORE") => variantOf({ state, outcome, adjudication, budgetResetsAt: null, merge, origin: "HUMAN" });
    expect(of(decided({ decision: "ACCEPT" }), checked("FAILED"))).toBe("checkFailed");
    /* a curator-always change the router queued has no row: the curator's accept, then the check's return */
    expect(of(null, checked("FAILED"))).toBe("checkFailed");
    /* the revision decided again after the check: the adjudicator's own request for more */
    expect(of(decided({ decidedAt: "2026-10-09T11:00:00.000Z" }), checked("FAILED"))).toBe("requestMore");
    /* a check that passed, or none, returns nothing; accepted again, it merges */
    expect(of(decided({ decision: "ACCEPT" }), checked("PASSED"))).toBe("requestMore");
    expect(of(decided({ decision: "ACCEPT" }), null)).toBe("requestMore");
    expect(of(decided({ decision: "ACCEPT" }), checked("FAILED"), "MERGING", "ACCEPT")).toBe("accepted");
  });

  it("names who declined", () => {
    expect(declinedBy(decided({ decision: "DECLINE", decidedBy: "intake-rules" }))).toBe("intake");
    expect(declinedBy(decided({ decision: "DECLINE", decidedBy: "intake-rules", failingSensor: "ANCHOR_EXISTS" }))).toBe("sensor");
    expect(declinedBy(decided({ decision: "DECLINE" }))).toBe("adjudicator");
  });
});

describe("changeOf and shortHash", () => {
  const anchor = { kind: "FIGURE", id: "F-23-06", section: "23.3", currentText: "cost reduction at 95% quality retention · 2.4×", contentSha256: "a", existsAtVersion: true, readBy: [] } as unknown as SuggestionView["anchor"];

  it("a value: the figure's text quoted, its value before and the proposed one after", () => {
    expect(changeOf({ anchor, proposal: { kind: "SET_VALUE", after: "1.3", unit: "×" } })).toEqual({ quote: "cost reduction at 95% quality retention · 2.4×", before: "2.4×", after: "1.3 ×" });
  });

  it("a passage: the passage quoted, and its replacement; nothing proposed yet, the anchor alone", () => {
    expect(changeOf({ anchor, proposal: { kind: "EDIT_TEXT", before: "three times", after: "four times" } })).toEqual({ quote: "three times", before: "three times", after: "four times" });
    expect(changeOf({ anchor, proposal: null })).toEqual({ quote: anchor.currentText, before: null, after: null });
  });

  it("a row's edit shows every field it changes, a link or a date alone included", () => {
    const row = { ...anchor, kind: "SOURCE_ROW", currentText: "List prices — vendor page" } as SuggestionView["anchor"];
    expect(changeOf({ anchor: row, proposal: { kind: "EDIT_ROW", url: "https://example.org/new" } }).after).toBe("https://example.org/new");
    expect(changeOf({ anchor: row, proposal: { kind: "EDIT_ROW", claim: "List prices", verifiedOn: "2026-10-01" } }).after).toBe("List prices — 2026-10-01");
  });

  it("prints a record's hash as the screen does", () => {
    expect(shortHash("a91f0000000000000000000020d6")).toBe("a91f·20d6");
  });
});

describe("refreshKeyOf: what the page's reads compare", () => {
  it("moves with the state, the decision's time, and a wait at the budget cap that begins or ends", () => {
    const base = { state: "SUBMITTED", adjudication: null, budgetResetsAt: null };
    expect(refreshKeyOf(base)).not.toBe(refreshKeyOf({ ...base, budgetResetsAt: "2026-11-01T00:00:00.000Z" }));
    expect(refreshKeyOf(base)).not.toBe(refreshKeyOf({ ...base, state: "GRADED" }));
    expect(refreshKeyOf({ ...base, state: "INTAKE_DECLINED", adjudication: { decidedAt: "2026-10-08T11:33:56.641Z" } })).not.toBe(refreshKeyOf({ ...base, state: "INTAKE_DECLINED", adjudication: { decidedAt: "2026-10-08T20:49:09.630Z" } }));
  });

  it("moves with a curator's merge, which writes no new check: its release set aside, then when it merged (unit 54c)", () => {
    const merging = { state: "MERGING", adjudication: null, budgetResetsAt: null, merge: { check: { at: "2026-10-09T12:00:00.000Z" }, releaseTo: null, mergedAt: null } };
    const set = { ...merging, merge: { ...merging.merge, releaseTo: "2026.10" } };
    expect(refreshKeyOf(set)).not.toBe(refreshKeyOf(merging));
    expect(refreshKeyOf({ ...set, merge: { ...set.merge, mergedAt: "2026-10-09T12:05:00.000Z" } })).not.toBe(refreshKeyOf(set));
  });

  it("moves with a withdrawal asked for or taken back, which moves no state (45 § 5.2)", () => {
    const queued = { state: "CURATOR_QUEUE", adjudication: { decidedAt: "2026-10-11T12:00:00.000Z" }, budgetResetsAt: null };
    const asked = { ...queued, withdrawnAt: "2026-10-11T13:00:00.000Z" };
    expect(refreshKeyOf(asked)).not.toBe(refreshKeyOf(queued));
    expect(refreshKeyOf({ ...asked, withdrawnAt: null })).toBe(refreshKeyOf(queued));
  });
});

describe("queueDeadlineOf: 36 § 3.1's deadlines, from the decision that queued it", () => {
  /* The router writes no row: the time it queued the suggestion is the suggestion's own decidedAt. */
  const queued = (curatorReason: SuggestionView["curatorReason"]) => queueDeadlineOf({ changeClass: curatorReason === null ? "WORDING" : "CURATOR_ALWAYS", curatorReason, outcome: "CURATOR_REVIEW", adjudication: null, decidedAt: "2026-10-08T12:00:00.000Z", origin: "HUMAN" });

  it("counts from when it entered the queue, as the queue does: a merge that sent it back moves the suggestion's time, not the adjudication's (review of unit 60)", () => {
    const back = queueDeadlineOf({ changeClass: "NEW_CLAIM", curatorReason: null, outcome: "CURATOR_REVIEW", adjudication: decided({ decision: "ACCEPT", decidedAt: "2026-10-01T12:00:00.000Z" }), decidedAt: "2026-10-06T14:00:00.000Z", origin: "RESEARCHER" });
    expect(back?.toISOString()).toBe("2026-10-13T14:00:00.000Z");
  });

  it("a day for safety, five for a parameter or a structure, six for a new tier, seven for an inspection", () => {
    expect(queued("SAFETY_OT")?.toISOString()).toBe("2026-10-09T12:00:00.000Z");
    expect(queued("SCENARIO_PARAMETER")?.toISOString()).toBe("2026-10-13T12:00:00.000Z");
    expect(queued("STRUCTURE")?.toISOString()).toBe("2026-10-13T12:00:00.000Z");
    expect(queued("NEW_SOURCE_TIER")?.toISOString()).toBe("2026-10-14T12:00:00.000Z");
    expect(queued(null)?.toISOString()).toBe("2026-10-15T12:00:00.000Z");
  });

  it("none for a rubric change, which has no group, nor before a decision", () => {
    expect(queued("RUBRIC")).toBeNull();
    expect(queueDeadlineOf({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT", outcome: null, adjudication: null, decidedAt: null, origin: "HUMAN" })).toBeNull();
  });
});

describe("throttleNoteOf: whether a decline counts towards the throttle", () => {
  const item = (tier: SuggestionView["evidence"][number]["tier"]) => ({ tier }) as SuggestionView["evidence"][number];

  it("counts a decline whose every item is U; names the strongest tier of one that is not", () => {
    expect(throttleNoteOf({ outcome: "DECLINE", evidence: [item("U"), item("U")] })).toEqual({ counts: true, tier: "U" });
    expect(throttleNoteOf({ outcome: "DECLINE", evidence: [item("U"), item("G")] })).toEqual({ counts: false, tier: "G" });
    expect(throttleNoteOf({ outcome: "DECLINE", evidence: [item("D"), item("B")] })).toEqual({ counts: false, tier: "B" });
  });

  it("says nothing of a suggestion not declined, or while an item is ungraded, as one added for a revision is", () => {
    expect(throttleNoteOf({ outcome: "REQUEST_MORE", evidence: [item("U")] })).toBeNull();
    expect(throttleNoteOf({ outcome: "DECLINE", evidence: [item(null)] })).toBeNull();
    expect(throttleNoteOf({ outcome: "DECLINE", evidence: [item("U"), item(null)] })).toBeNull();
  });
});
