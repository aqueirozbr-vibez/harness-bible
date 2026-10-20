import { describe, expect, it } from "vitest";

import { ProposalViewSchema } from "@/lib/schemas/api";

import { proposalViewOf, type ProposalRow } from "./proposalView";

/*
 * A research proposal as the asker is shown it (feature-specs/43 § 5.3; unit 60b): the anchor and its section's title,
 * the class, the change before and after as the edit page's fixed proposal has it, the sources as graded, the score
 * against the accept line, the note, where it stands — with a curator by the queue's deadline, being merged, in a
 * chapter version, declined by a curator, returned by the chapter's check — and the asker's own name; and it is the
 * API's shape, field for field.
 */

const QUEUED_AT = new Date("2026-10-10T12:00:00.000Z");

const PROPOSAL_ROW: ProposalRow = {
  id: "S-21-0101",
  origin: "RESEARCHER",
  state: "CURATOR_QUEUE",
  outcome: "ACCEPT",
  changeKind: "ADD_CLAIM",
  changeClass: "NEW_CLAIM",
  curatorReason: null,
  proposal: { kind: "ADD_CLAIM", text: "Keys are kept for at least 24 hours after the first response.", placeAfter: "end", fastMoving: true },
  rationale: "The standard says so, in its section on retention.",
  score: 85,
  parts: ["P3", "P4"],
  locale: "EN",
  decidedAt: QUEUED_AT,
  anchor: { kind: "SECTION", sectionAnchor: "21.3", figureAnchor: null, sourceRowAnchor: null, currentText: "A retried write without a key is a second write." },
  evidence: [{ ordinal: 1, host: "standards.example", tier: "B", adjustedScore: 85 }],
  adjudication: { acceptAt: 85, decidedAt: QUEUED_AT },
  merge: null,
};

describe("proposalViewOf", () => {
  it("shows a proposal with a curator: the anchor and its title, the class, the claim to add, the source as graded, the score against the accept line, the note, the parts and the queue's deadline, no name yet", () => {
    const view = proposalViewOf({ row: PROPOSAL_ROW, title: "Idempotency keys", endorsedAt: null });
    expect(ProposalViewSchema.parse(view)).toEqual(view);
    expect(view).toEqual({
      suggestionId: "S-21-0101",
      anchor: { kind: "SECTION", id: "21.3", section: "21.3", title: "Idempotency keys" },
      changeKind: "ADD_CLAIM",
      changeClass: "NEW_CLAIM",
      curatorReason: null,
      change: { before: null, after: "Keys are kept for at least 24 hours after the first response." },
      contentLang: "en",
      sources: [{ host: "standards.example", tier: "B", adjusted: 85 }],
      score: 85,
      acceptAt: 85,
      note: "The standard says so, in its section on retention.",
      /* the researcher group's seven days, from the decision that queued it (43 § 7.1) */
      where: { state: "CURATOR_QUEUE", parts: ["P3", "P4"], decisionBy: "2026-10-17T12:00:00.000Z", version: null, closedBy: null },
      endorsed: null,
    });
  });

  it("dates the decision from when the proposal entered the queue, as the queue does, not from an older adjudication (review of unit 60)", () => {
    const back = proposalViewOf({ row: { ...PROPOSAL_ROW, decidedAt: new Date("2026-10-12T09:00:00.000Z") }, title: null, endorsedAt: null });
    expect(back.where.decisionBy).toBe("2026-10-19T09:00:00.000Z");
  });

  it("says where it went: being merged, in a chapter version, declined by a curator, returned by the chapter's check; and the asker's name with its instant", () => {
    expect(proposalViewOf({ row: { ...PROPOSAL_ROW, state: "MERGING" }, title: null, endorsedAt: null }).where).toMatchObject({ state: "MERGING", decisionBy: null });
    expect(proposalViewOf({ row: { ...PROPOSAL_ROW, state: "MERGED", merge: { versionTo: "v1.3.3" } }, title: null, endorsedAt: null }).where).toMatchObject({ state: "MERGED", version: "v1.3.3" });
    expect(proposalViewOf({ row: { ...PROPOSAL_ROW, state: "CLOSED", outcome: "DECLINE" }, title: null, endorsedAt: null }).where).toMatchObject({ state: "CLOSED", closedBy: "curator" });
    expect(proposalViewOf({ row: { ...PROPOSAL_ROW, state: "CLOSED", outcome: "REQUEST_MORE" }, title: null, endorsedAt: null }).where).toMatchObject({ state: "CLOSED", closedBy: "check" });
    expect(proposalViewOf({ row: PROPOSAL_ROW, title: null, endorsedAt: QUEUED_AT }).endorsed).toEqual({ byMe: true, at: QUEUED_AT.toISOString() });
  });

  it("shows a value's before and after, a figure's own id with its section, a curator-always class with its reason and no accept line, and a PT proposal in its edition", () => {
    const figure = proposalViewOf({
      row: { ...PROPOSAL_ROW, changeKind: "SET_VALUE", changeClass: "CURATOR_ALWAYS", curatorReason: "SCENARIO_PARAMETER", locale: "PT", proposal: { kind: "SET_VALUE", after: "48", unit: "h" }, anchor: { kind: "FIGURE", sectionAnchor: "21.3", figureAnchor: "F-21-03", sourceRowAnchor: null, currentText: "Retenção da chave · 24 h" }, adjudication: { acceptAt: null, decidedAt: QUEUED_AT } },
      title: "Chaves de idempotência",
      endorsedAt: null,
    });
    expect(figure).toMatchObject({ anchor: { kind: "FIGURE", id: "F-21-03", section: "21.3" }, change: { before: "24 h", after: "48 h" }, changeClass: "CURATOR_ALWAYS", curatorReason: "SCENARIO_PARAMETER", acceptAt: null, contentLang: "pt" });
    /* a scenario parameter's group: five days */
    expect(figure.where.decisionBy).toBe("2026-10-15T12:00:00.000Z");
  });

  it("shows no change where the proposal does not read, and no anchor where it has none, rather than failing", () => {
    expect(proposalViewOf({ row: { ...PROPOSAL_ROW, proposal: { kind: "NOT_A_KIND" } }, title: null, endorsedAt: null }).change).toEqual({ before: null, after: null });
    expect(proposalViewOf({ row: { ...PROPOSAL_ROW, anchor: null }, title: null, endorsedAt: null })).toMatchObject({ anchor: null, change: { before: null, after: null } });
  });
});
