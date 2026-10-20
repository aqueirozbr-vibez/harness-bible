import { describe, expect, it } from "vitest";

import { ResearchRunViewSchema, type ProposalView } from "@/lib/schemas/api";
import { ReaderFindingSchema, ReportSchema, ResearchStepsSchema, type ResearchFound } from "@/lib/schemas/researcher";
import { RESEARCH_RUN_EXECUTION_TIMEOUT_MS } from "@/lib/schemas/workflows";

import { findingUseOf, findingViewOf, hostOf, pagesOf, refusalPointerIdsOf, runLineOf, runViewOf, type FindingFacts, type RunViewRow } from "./runView";

/*
 * A person's run as the page shows it (feature-specs/48 § 16, § 18; unit 71), pure: the line of each state, the stale
 * run, the pages before and after the reader answered, a finding's change and class as a submission computes them, what
 * a purged run keeps, the refusal's pointers, and a view that its schema takes whole and that carries nothing § 16 keeps
 * from a client.
 */

const NOW = new Date("2026-10-12T15:00:00.000Z");
const RUN: RunViewRow = {
  id: "33333333-3333-4333-8333-333333333333",
  conversationId: "44444444-4444-4444-8444-444444444444",
  ordinal: 1,
  locale: "EN",
  question: "What changed in idempotency key retention since 21.3 was verified?",
  state: "DONE",
  skip: null,
  failure: null,
  refusal: null,
  sectionAnchors: ["21.3", "21.4", "21.5"],
  budgetResetsAt: null,
  searches: 2,
  pageReads: 1,
  flagReason: null,
  flaggedAt: null,
  createdAt: new Date("2026-10-12T14:50:00.000Z"),
  finishedAt: new Date("2026-10-12T14:52:00.000Z"),
  textPurgedAt: null,
};

const STEPS = ResearchStepsSchema.parse([
  { seq: 0, kind: "PLANNING", at: "2026-10-12T14:50:01.000Z" },
  { seq: 1, kind: "SECTIONS", at: "2026-10-12T14:50:05.000Z", sections: ["21.3"] },
  { seq: 2, kind: "SEARCH", at: "2026-10-12T14:50:10.000Z", query: "idempotency key retention", results: 6 },
  { seq: 3, kind: "PAGE", at: "2026-10-12T14:50:20.000Z", url: "https://docs.stripe.com/api/idempotent_requests", title: "Idempotent requests", opened: true },
  { seq: 4, kind: "PAGE", at: "2026-10-12T14:50:30.000Z", url: "https://example.org/gone", title: null, opened: false },
  { seq: 5, kind: "PAGE", at: "2026-10-12T14:50:31.000Z", url: "https://example.net/pending", title: null, opened: null },
]);

const FOUND: ResearchFound = {
  findings: [],
  pages: ["https://docs.stripe.com/api/idempotent_requests", "https://www.ietf.org/draft"],
  read: [
    { url: "https://docs.stripe.com/api/idempotent_requests", title: "Idempotent requests", opened: true, search: 1 },
    { url: "https://www.ietf.org/draft", title: null, opened: false, search: 1 },
  ],
  says: [{ url: "https://docs.stripe.com/api/idempotent_requests", says: "Keys are kept for 24 hours." }],
};

const SET_VALUE = ReaderFindingSchema.parse({ anchor: { kind: "FIGURE", id: "F-21-03" }, changeKind: "SET_VALUE", proposal: { kind: "SET_VALUE", after: "48", unit: "hours" }, sources: [{ url: "https://docs.stripe.com/api/idempotent_requests" }, { url: "https://docs.stripe.com/api/idempotent_requests " }, { url: "http://plain.example/x" }], note: "Doubled in 2026." });
const FIGURE_ANCHOR: NonNullable<FindingFacts["anchor"]> = { kind: "FIGURE", sectionAnchor: "21.3", figureAnchor: "F-21-03", tier: "VENDOR", scenarioParam: false, currentText: "Key retention · 24 hours" };

describe("the run's line (48 § 18)", () => {
  const line = (run: Partial<RunViewRow>, now = NOW) => runLineOf({ ...RUN, ...run }, now);

  it("reads each state under way with a running mark, and its words once a state", () => {
    expect(line({ state: "QUEUED" })).toEqual({ line: { key: "queued", tone: "run" }, stale: false });
    expect(line({ state: "PLANNING" }).line.key).toBe("planning");
    expect(line({ state: "READING" }).line.key).toBe("reading");
    expect(line({ state: "VALIDATING" }).line.key).toBe("checking");
    expect(line({ state: "WRITING" }).line.key).toBe("writing");
  });

  it("marks a run still under way past the workflow's 90 minutes stale, with no answer from the engine (§ 6)", () => {
    const old = new Date(NOW.getTime() - RESEARCH_RUN_EXECUTION_TIMEOUT_MS - 1);
    expect(line({ state: "READING", createdAt: old })).toEqual({ line: { key: "abandoned", tone: "mute" }, stale: true });
    expect(line({ state: "READING", createdAt: new Date(NOW.getTime() - RESEARCH_RUN_EXECUTION_TIMEOUT_MS) }).stale).toBe(false);
    /* an ended run is never stale, however old */
    expect(line({ state: "DONE", createdAt: old })).toEqual({ line: { key: "done", tone: "ok" }, stale: false });
  });

  it("reads each end by its skip or its failure, and never says the failure's code", () => {
    expect(line({ state: "DONE", textPurgedAt: NOW }).line).toEqual({ key: "donePurged", tone: "ok" });
    expect(line({ state: "REFUSED", refusal: "R-SCOPE" }).line).toEqual({ key: "refused", tone: "mute" });
    expect(line({ state: "SKIPPED", skip: "BUDGET" }).line).toEqual({ key: "notStarted", tone: "warn" });
    expect(line({ state: "SKIPPED", skip: "TEXT_PURGED" }).line).toEqual({ key: "purged", tone: "mute" });
    expect(line({ state: "SKIPPED", skip: "UNAVAILABLE" }).line).toEqual({ key: "notRun", tone: "mute" });
    expect(line({ state: "FAILED", failure: "BUDGET" }).line).toEqual({ key: "stopped", tone: "warn" });
    expect(line({ state: "FAILED", failure: "ABANDONED" }).line).toEqual({ key: "abandoned", tone: "mute" });
    expect(line({ state: "FAILED", failure: "WRITER_FAILED" }).line).toEqual({ key: "failed", tone: "mute" });
  });
});

describe("the pages (48 § 16)", () => {
  it("are the pages the steps opened until the reader answered, numbered in order, a pending one not yet opened", () => {
    expect(pagesOf(null, STEPS, false)).toEqual([
      { n: 1, url: "https://docs.stripe.com/api/idempotent_requests", host: "docs.stripe.com", title: "Idempotent requests", opened: true, search: null },
      { n: 2, url: "https://example.org/gone", host: "example.org", title: null, opened: false, search: null },
      { n: 3, url: "https://example.net/pending", host: "example.net", title: null, opened: false, search: null },
    ]);
  });

  it("are the turn's own list once it answered, numbered as the writer read them, and none once purged", () => {
    expect(pagesOf(FOUND, STEPS, false)).toEqual([
      { n: 1, url: "https://docs.stripe.com/api/idempotent_requests", host: "docs.stripe.com", title: "Idempotent requests", opened: true, search: 1 },
      { n: 2, url: "https://www.ietf.org/draft", host: "www.ietf.org", title: null, opened: false, search: 1 },
    ]);
    expect(pagesOf(FOUND, STEPS, true)).toEqual([]);
  });

  it("names a host, or the address itself where it does not parse", () => {
    expect(hostOf("https://Docs.Stripe.com/x")).toBe("docs.stripe.com");
    expect(hostOf("not an address")).toBe("not an address");
  });
});

describe("a finding as the person is shown it (48 § 16, § 8.1)", () => {
  const row = { id: "55555555-5555-4555-8555-555555555555", outcome: "VALID" as const, suggestionId: null, failure: null };
  /* nothing of a suggestion to say: an unused finding's facts */
  const none = { draftState: null, duplicateVisible: false } as const;

  it("carries its change and class as a submission computes them, its https sources once each, and its note", () => {
    const view = findingViewOf(row, 1, false, { finding: SET_VALUE, anchor: FIGURE_ANCHOR, title: "Worked numbers", proposal: null, use: none });
    expect(view).toEqual({
      id: row.id,
      n: 1,
      textPurged: false,
      anchor: { kind: "FIGURE", id: "F-21-03", section: "21.3", title: "Worked numbers" },
      changeKind: "SET_VALUE",
      changeClass: "CITED_FIGURE",
      curatorReason: null,
      change: { before: "24 hours", after: "48 hours" },
      sources: [{ url: "https://docs.stripe.com/api/idempotent_requests", host: "docs.stripe.com" }],
      note: "Doubled in 2026.",
      use: { state: "VALID", suggestionId: null, href: null, failure: null },
      proposal: null,
    });
  });

  it("sends a change about operating plant equipment to a curator, as the class rule does", () => {
    const ot = ReaderFindingSchema.parse({ anchor: { kind: "SECTION", id: "21.3" }, changeKind: "EDIT_TEXT", proposal: { kind: "EDIT_TEXT", before: "Retry the request.", after: "Bypass the interlock and retry." }, sources: [{ url: "https://example.org/a" }], note: "A page says so." });
    const view = findingViewOf(row, 1, false, { finding: ot, anchor: { kind: "SECTION", sectionAnchor: "21.3", figureAnchor: null, tier: null, scenarioParam: false, currentText: "Retry the request." }, title: "Worked numbers", proposal: null, use: none });
    expect(view).toMatchObject({ changeClass: "CURATOR_ALWAYS", curatorReason: "SAFETY_OT", change: { before: "Retry the request.", after: "Bypass the interlock and retry." } });
  });

  it("keeps an anchor the release no longer has by its kind and id, with no section, class or change", () => {
    expect(findingViewOf(row, 2, false, { finding: SET_VALUE, anchor: null, title: null, proposal: null, use: none })).toMatchObject({ n: 2, anchor: { kind: "FIGURE", id: "F-21-03", section: null, title: null }, changeKind: "SET_VALUE", changeClass: null, curatorReason: null, change: null, note: "Doubled in 2026." });
  });

  it("is its use alone once its run's text is purged", () => {
    expect(findingViewOf({ ...row, outcome: "PROPOSED", suggestionId: "S-21-0042" }, 1, true, { finding: SET_VALUE, anchor: FIGURE_ANCHOR, title: "Worked numbers", proposal: null, use: none })).toEqual({
      id: row.id,
      n: 1,
      textPurged: true,
      anchor: null,
      changeKind: null,
      changeClass: null,
      curatorReason: null,
      change: null,
      sources: null,
      note: null,
      use: { state: "PROPOSED", suggestionId: "S-21-0042", href: null, failure: null },
      proposal: null,
    });
  });

  it("shows a suggestion's id only where it is the person's to see: their draft, the proposal they asked; a sent, refuted or hidden duplicate one's is withheld (§ 8.5, D3)", () => {
    const facts = { finding: SET_VALUE, anchor: FIGURE_ANCHOR, title: null, proposal: { suggestionId: "S-21-0042" } as ProposalView, use: { draftState: "DRAFT" as const, duplicateVisible: false } };
    const use = (outcome: Parameters<typeof findingViewOf>[0]["outcome"]) => findingViewOf({ ...row, outcome, suggestionId: "S-21-0042" }, 1, false, facts);
    expect(use("DRAFTED").use).toEqual({ state: "DRAFTED", suggestionId: "S-21-0042", href: "/improve/S-21-0042/edit", failure: null });
    expect(use("PROPOSED")).toMatchObject({ use: { state: "PROPOSED", suggestionId: "S-21-0042", href: null }, proposal: { suggestionId: "S-21-0042" } });
    for (const outcome of ["SUBMITTED", "REFUTED", "DUPLICATE"] as const) expect(use(outcome)).toMatchObject({ use: { suggestionId: null, href: null }, proposal: null });
    expect(use("SUBMITTED").use.state).toBe("SENT");
    expect(findingViewOf({ ...row, failure: "NO_RUBRIC" }, 1, false, facts).use.failure).toBe("NO_RUBRIC");
  });

  it("opens a draft on its edit page while it is one and on its own page after, nothing once it is deleted; a visible duplicate on its record (unit 74)", () => {
    const drafted = { ...row, outcome: "DRAFTED" as const, suggestionId: "S-21-0042" };
    expect(findingUseOf(drafted, { draftState: "DRAFT", duplicateVisible: false }).href).toBe("/improve/S-21-0042/edit");
    expect(findingUseOf(drafted, { draftState: "SUBMITTED", duplicateVisible: false }).href).toBe("/improve/S-21-0042");
    expect(findingUseOf(drafted, { draftState: null, duplicateVisible: false })).toEqual({ state: "DRAFTED", suggestionId: "S-21-0042", href: null, failure: null });
    const duplicate = { ...row, outcome: "DUPLICATE" as const, suggestionId: "S-21-0007" };
    expect(findingUseOf(duplicate, { draftState: null, duplicateVisible: true })).toEqual({ state: "DUPLICATE", suggestionId: "S-21-0007", href: "/improve/S-21-0007/record", failure: null });
    expect(findingUseOf(duplicate, { draftState: null, duplicateVisible: false })).toEqual({ state: "DUPLICATE", suggestionId: null, href: null, failure: null });
  });

  it("carries a send's failure only while the finding is unused: a code an earlier send left is no use's once it moved", () => {
    expect(findingUseOf({ ...row, failure: "ANCHOR_UNKNOWN" }, { draftState: null, duplicateVisible: false }).failure).toBe("ANCHOR_UNKNOWN");
    expect(findingUseOf({ ...row, outcome: "SUBMITTED", suggestionId: "S-21-0042", failure: "NO_RUBRIC" }, { draftState: null, duplicateVisible: false }).failure).toBeNull();
    expect(findingUseOf({ ...row, outcome: "REFUTED", suggestionId: "S-21-0042" }, { draftState: null, duplicateVisible: true })).toEqual({ state: "REFUTED", suggestionId: null, href: null, failure: null });
  });
});

describe("the refusal's pointers (48 § 5.2, § 5.3)", () => {
  it("are the Assistant's two for plant equipment, the run's first two sections for one not about the book, and none otherwise", () => {
    expect(refusalPointerIdsOf("R-SCOPE-OT", RUN.sectionAnchors)).toEqual(["35.2", "28.1"]);
    expect(refusalPointerIdsOf("R-SCOPE", RUN.sectionAnchors)).toEqual(["21.3", "21.4"]);
    expect(refusalPointerIdsOf("R-UNVERIFIED", RUN.sectionAnchors)).toEqual([]);
    expect(refusalPointerIdsOf("R-PERSONAL", RUN.sectionAnchors)).toEqual([]);
  });
});

describe("the run's view (48 § 16)", () => {
  const report = ReportSchema.parse({ paragraphs: [{ text: "The pages say keys are kept for a day [1].", sections: ["21.3"], pages: [1] }], dropped: { ADDRESS: 1 } });
  const parts = { seeded: true, steps: STEPS, report, found: FOUND, sections: [{ id: "21.3", title: "Worked numbers" }], pointers: [], findings: [], costUsd: "0.6123" };

  it("is whole by its schema: the report's paragraphs without what the sensor dropped, the turn's pages, the usage", () => {
    const view = ResearchRunViewSchema.parse(runViewOf({ ...RUN, flagReason: "wrong_citation", flaggedAt: NOW }, parts, NOW));
    expect(view).toMatchObject({
      id: RUN.id,
      ordinal: 1,
      language: "en",
      seeded: true,
      state: "DONE",
      line: { key: "done", tone: "ok" },
      stale: false,
      refusal: null,
      report: { paragraphs: [{ text: "The pages say keys are kept for a day [1].", sections: ["21.3"], pages: [1] }] },
      usage: { searches: 2, pagesOpened: 1, pagesSeen: 2, costUsd: "0.6123" },
      flag: { kind: "report", reason: "wrong_citation" },
      finishedAt: "2026-10-12T14:52:00.000Z",
      textPurged: false,
    });
    expect(view.report).not.toHaveProperty("dropped");
    expect(view.pages).toHaveLength(2);
  });

  it("is a refusal's card for a refused run, its cause the code", () => {
    const pointers = [{ sectionId: "35.2", title: "What an agent may read" }];
    expect(runViewOf({ ...RUN, state: "REFUSED", refusal: "R-SCOPE-OT", finishedAt: RUN.createdAt }, { ...parts, report: null, found: null, steps: [], pointers }, NOW).refusal).toEqual({ cause: "R-SCOPE-OT", code: "R-SCOPE-OT", pointers, beforeRetrieval: true });
  });

  it("keeps a purged run's line, counts and flag, and nothing of its text", () => {
    const view = runViewOf({ ...RUN, question: null, textPurgedAt: NOW }, parts, NOW);
    expect(view).toMatchObject({ question: null, steps: [], report: null, pages: [], line: { key: "donePurged" }, usage: { searches: 2, pagesOpened: 1, pagesSeen: null }, textPurged: true });
  });

  it("says when a run met the cap", () => {
    expect(runViewOf({ ...RUN, state: "SKIPPED", skip: "BUDGET", budgetResetsAt: new Date("2026-11-01T00:00:00.000Z") }, parts, NOW)).toMatchObject({ line: { key: "notStarted", tone: "warn" }, resetsAt: "2026-11-01T00:00:00.000Z" });
  });
});
