import { describe, expect, it } from "vitest";

import type { ResearchFindingView } from "@/lib/schemas/api";

import { chaptersOfSections, lineOfRuns } from "./summary";

const use = (state: ResearchFindingView["use"]["state"]) => ({ use: { state, suggestionId: null, href: null, failure: null } }) as ResearchFindingView;

describe("a research's line in the list (feature-specs/48 § 11.4)", () => {
  it("labels it by the chapters of its runs' sections, in order of first appearance", () => {
    expect(chaptersOfSections(["21.3", "20.1", "21.4", "09.2"])).toEqual([21, 20, 9]);
    expect(chaptersOfSections([])).toEqual([]);
  });

  it("builds the open research's line from the column's runs, as the door counts", () => {
    const runs = [
      { sections: [{ id: "21.3", title: null }], findings: [use("VALID"), use("DRAFTED")], createdAt: "2026-10-12T10:31:00.000Z", textPurged: false },
      { sections: [{ id: "20.1", title: null }, { id: "21.4", title: null }], findings: [use("SENT"), use("PROPOSED"), use("REFUTED"), use("DUPLICATE")], createdAt: "2026-10-12T11:02:00.000Z", textPurged: false },
    ];
    expect(lineOfRuns("r-1", runs, true, "2026-10-12T12:00:00.000Z")).toEqual({ id: "r-1", chapters: [21, 20], lastRunAt: "2026-10-12T11:02:00.000Z", runs: 2, findings: 6, used: 5, seeded: true, textPurged: false });
  });

  it("stands a research with no run yet at the caller's clock, its words not removed", () => {
    expect(lineOfRuns("r-2", [], false, "2026-10-12T12:00:00.000Z")).toEqual({ id: "r-2", chapters: [], lastRunAt: "2026-10-12T12:00:00.000Z", runs: 0, findings: 0, used: 0, seeded: false, textPurged: false });
    expect(lineOfRuns("r-3", [{ sections: [], findings: [], createdAt: "2026-09-01T00:00:00.000Z", textPurged: true }], false, "2026-10-12T12:00:00.000Z").textPurged).toBe(true);
  });
});
