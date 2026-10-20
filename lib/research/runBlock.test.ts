import { describe, expect, it } from "vitest";

import type { ResearchFindingView, ResearchRunLine, ResearchRunView } from "@/lib/schemas/api";
import type { ResearchStep } from "@/lib/schemas/researcher";

import { copyReportOf, findingUseLineOf, reportPiecesOf, runLinePartsOf, runUnderWay, runWordOf, stepCountsOf, stepLineOf } from "./runBlock";

const AT = "2026-10-12T10:31:00.000Z";

function finding(state: ResearchFindingView["use"]["state"], extra: Partial<ResearchFindingView> = {}): ResearchFindingView {
  return { id: "00000000-0000-4000-8000-000000000001", n: 1, textPurged: false, anchor: null, changeKind: null, changeClass: null, curatorReason: null, change: null, sources: null, note: null, use: { state, suggestionId: null, href: null, failure: null }, proposal: null, ...extra };
}

function run(line: ResearchRunLine, extra: Partial<ResearchRunView> = {}): Pick<ResearchRunView, "line" | "stale" | "findings" | "pages" | "usage" | "resetsAt"> {
  return { line, stale: false, findings: [], pages: [], usage: { searches: 0, pagesOpened: 0, pagesSeen: null, costUsd: null }, resetsAt: null, ...extra };
}

describe("a run's line (feature-specs/48 § 18)", () => {
  it("reads the state's word, and a detail after a `·` or joined to the word as its object", () => {
    expect(runLinePartsOf(run({ key: "queued", tone: "run" }))).toEqual({ word: "queued", tone: "run", detail: null });
    expect(runLinePartsOf(run({ key: "planning", tone: "run" })).detail).toEqual({ key: "planning", joined: false, values: {}, date: null });
    for (const key of ["reading", "checking", "writing"] as const) expect(runLinePartsOf(run({ key, tone: "run" }))).toEqual({ word: key, tone: "run", detail: { key, joined: true, values: {}, date: null } });
  });

  it("counts a done run's findings and pages read, and its pages opened once the list was purged", () => {
    const pages = [1, 2, 3].map((n) => ({ n, url: `https://example.org/${String(n)}`, host: "example.org", title: null, opened: n === 1, search: null }));
    const done = run({ key: "done", tone: "ok" }, { findings: [finding("VALID"), finding("SENT")], pages, usage: { searches: 2, pagesOpened: 1, pagesSeen: 3, costUsd: "0.61" } });
    expect(runLinePartsOf(done).detail).toEqual({ key: "done", joined: false, values: { f: 2, p: 3 }, date: null });
    const purged = run({ key: "donePurged", tone: "ok" }, { findings: [finding("PROPOSED")], usage: { searches: 2, pagesOpened: 4, pagesSeen: null, costUsd: null } });
    expect(runLinePartsOf(purged)).toEqual({ word: "done", tone: "ok", detail: { key: "donePurged", joined: false, values: { f: 1, o: 4 }, date: null } });
  });

  it("names the reset of a run the cap stopped, and reads every stop the engine will not move as `stopped`", () => {
    expect(runLinePartsOf(run({ key: "notStarted", tone: "warn" }, { resetsAt: AT })).detail).toEqual({ key: "notStarted", joined: false, values: {}, date: AT });
    expect(runLinePartsOf(run({ key: "stopped", tone: "warn" }, { resetsAt: AT }))).toEqual({ word: "stopped", tone: "warn", detail: { key: "stopped", joined: false, values: {}, date: AT } });
    /* a reset the row does not hold is not guessed */
    expect(runLinePartsOf(run({ key: "stopped", tone: "warn" })).detail).toBeNull();
    expect(runLinePartsOf(run({ key: "abandoned", tone: "mute" }))).toEqual({ word: "stopped", tone: "mute", detail: { key: "abandoned", joined: false, values: {}, date: null } });
    expect(runLinePartsOf(run({ key: "purged", tone: "mute" })).word).toBe("stopped");
    for (const key of ["refused", "failed", "notRun"] as const) expect(runLinePartsOf(run({ key, tone: "mute" })).detail).toBeNull();
  });

  it("is under way while its workflow moves it, and not once it is stale", () => {
    expect(runUnderWay({ line: { key: "reading", tone: "run" }, stale: false })).toBe(true);
    expect(runUnderWay({ line: { key: "abandoned", tone: "mute" }, stale: true })).toBe(false);
    expect(runUnderWay({ line: { key: "done", tone: "ok" }, stale: false })).toBe(false);
  });
});

describe("a run's live steps (§ 6)", () => {
  const steps: ReadonlyArray<ResearchStep> = [
    { seq: 0, at: AT, kind: "PLANNING" },
    { seq: 1, at: AT, kind: "SECTIONS", sections: ["21.3", "21.4"] as never },
    { seq: 2, at: AT, kind: "SEARCH", query: "idempotency key retention", results: null },
    { seq: 3, at: AT, kind: "SEARCH", query: "idempotency key retention", results: 6 },
    { seq: 4, at: AT, kind: "PAGE", url: "https://docs.stripe.com/api/idempotent_requests", title: null, opened: null },
    { seq: 5, at: AT, kind: "PAGE", url: "https://docs.stripe.com/api/idempotent_requests", title: "Idempotent requests", opened: true },
    { seq: 6, at: AT, kind: "PAGE", url: "https://Example.org/a", title: "  ", opened: true },
    { seq: 7, at: AT, kind: "PAGE", url: "not an address", title: null, opened: false },
    { seq: 8, at: AT, kind: "CHECKING" },
    { seq: 9, at: AT, kind: "WRITING" },
  ];

  it("words each step by its kind, a search and a page as they complete", () => {
    expect(steps.map(stepLineOf)).toEqual([
      { key: "planning", values: {} },
      { key: "sections", values: { ids: "21.3 · 21.4" } },
      { key: "searchPending", values: { query: "idempotency key retention" } },
      { key: "search", values: { query: "idempotency key retention", n: 6 } },
      { key: "pagePending", values: { host: "docs.stripe.com" } },
      { key: "page", values: { host: "docs.stripe.com", title: "Idempotent requests" } },
      { key: "pageUntitled", values: { host: "example.org" } },
      { key: "unreachable", values: { host: "not an address" } },
      { key: "checking", values: {} },
      { key: "writing", values: {} },
    ]);
  });

  it("counts the searches and the pages for the caption", () => {
    expect(stepCountsOf(steps)).toEqual({ searches: 2, pages: 4 });
    expect(stepCountsOf([])).toEqual({ searches: 0, pages: 0 });
  });
});

describe("a report paragraph (§ 5.7, § 11.3)", () => {
  it("cuts the text at each page it cites, and appends the pages its text does not mark", () => {
    expect(reportPiecesOf({ text: "Keys are kept 24 hours [1], some for longer [3].", pages: [1, 3, 2] }, new Set([1, 2, 3]))).toEqual({
      pieces: [
        { kind: "text", text: "Keys are kept 24 hours " },
        { kind: "page", n: 1 },
        { kind: "text", text: ", some for longer " },
        { kind: "page", n: 3 },
        { kind: "text", text: "." },
      ],
      trailing: [2],
    });
  });

  it("leaves a marker of a page the run does not have as text, and appends none it does not have", () => {
    expect(reportPiecesOf({ text: "[9] says so.", pages: [9] }, new Set([1]))).toEqual({ pieces: [{ kind: "text", text: "[9] says so." }], trailing: [] });
    expect(reportPiecesOf({ text: "[2]", pages: [] }, new Set([2]))).toEqual({ pieces: [{ kind: "page", n: 2 }], trailing: [] });
  });
});

describe("`Copy report` (§ 11.9; unit 73)", () => {
  const pages = [
    { n: 1, url: "https://docs.stripe.com/api/idempotent_requests", host: "docs.stripe.com", title: "Idempotent requests", opened: true, search: 1 },
    { n: 2, url: "https://www.rfc-editor.org/rfc/rfc9110.html", host: "www.rfc-editor.org", title: null, opened: false, search: 2 },
    { n: 3, url: "https://example.org/never-cited", host: "example.org", title: "Never cited", opened: true, search: 2 },
  ];

  it("copies each paragraph as it reads, its markers, the pages its text does not mark and its sections, then the pages they cite", () => {
    const report = {
      paragraphs: [
        { text: "Keys are kept for 24 hours [1].", sections: ["21.3" as never], pages: [1, 2] },
        { text: "A retry after that is a new write; [9] is no page of this run.", sections: [], pages: [] },
      ],
    };
    expect(copyReportOf({ report, pages })).toBe(
      [
        "Keys are kept for 24 hours [1]. [2] [21.3]",
        "A retry after that is a new write; [9] is no page of this run.",
        "[1] Idempotent requests · https://docs.stripe.com/api/idempotent_requests\n[2] https://www.rfc-editor.org/rfc/rfc9110.html",
      ].join("\n\n"),
    );
  });

  it("copies no list where no paragraph cites a page, and nothing for a run with no report", () => {
    expect(copyReportOf({ report: { paragraphs: [{ text: "The section says it all.", sections: ["21.4" as never], pages: [] }] }, pages })).toBe("The section says it all. [21.4]");
    expect(copyReportOf({ report: null, pages })).toBe("");
  });
});

describe("a line's word (§ 11.6, § 18)", () => {
  it("reads every stop the engine will not move as `stopped`, and a purged done run as done", () => {
    expect(runWordOf("donePurged")).toBe("done");
    expect(["abandoned", "purged", "stopped"].map((key) => runWordOf(key as ResearchRunLine["key"]))).toEqual(["stopped", "stopped", "stopped"]);
    expect(runWordOf("notRun")).toBe("notRun");
  });
});

describe("a finding's use where the block shows no button (§ 8.1)", () => {
  it("reads nothing for a finding still to use, and the purged sentence once its text is gone", () => {
    expect(findingUseLineOf(finding("VALID"))).toBeNull();
    expect(findingUseLineOf(finding("VALID", { textPurged: true }))).toEqual({ key: "purged", values: {} });
  });

  it("reads each outcome's line, a duplicate's id only where the view gave it", () => {
    expect(findingUseLineOf(finding("DRAFTED", { use: { state: "DRAFTED", suggestionId: "S-21-0042", href: null, failure: null } }))).toEqual({ key: "drafted", values: { id: "S-21-0042" } });
    expect(findingUseLineOf(finding("SENT"))?.key).toBe("sent");
    expect(findingUseLineOf(finding("PROPOSED", { textPurged: true }))?.key).toBe("proposed");
    expect(findingUseLineOf(finding("REFUTED"))?.key).toBe("refuted");
    expect(findingUseLineOf(finding("DUPLICATE"))).toEqual({ key: "duplicateHidden", values: {} });
    expect(findingUseLineOf(finding("DUPLICATE", { use: { state: "DUPLICATE", suggestionId: "S-21-0007", href: null, failure: null } }))).toEqual({ key: "duplicate", values: { id: "S-21-0007" } });
  });
});
