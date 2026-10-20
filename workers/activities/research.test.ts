import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { ResearchRunRow } from "@/lib/db/research";
import type { ResearchLine } from "@/lib/telemetry/lines";

import { researchActivities, type ResearchActivityDeps } from "./research";

/*
 * The research activities' lines (feature-specs/44 § 4; unit 61a), the steps doubled: `research.plan` and
 * `research.read` as each agent's step ends — with its outcome, its counts, or the code it failed with — and
 * `research.run` as the run ends, with what its findings came to; each on the turn's trace, none with a word of text.
 */

const RUN: ResearchRunRow = {
  id: "33333333-3333-4333-8333-333333333333",
  messageId: "44444444-4444-4444-8444-444444444444",
  userId: "55555555-5555-4555-8555-555555555555",
  organisationId: null,
  releaseId: "2026.09",
  locale: "EN",
  state: "PLANNING",
  skip: null,
  failure: null,
  gap: false,
  sectionAnchors: ["21.3"],
  questionSha256: "e".repeat(64),
  briefSha256: null,
  searches: 3,
  pageReads: 2,
  workflowId: "research:44444444-4444-4444-8444-444444444444",
  traceId: "f".repeat(32),
  textPurgedAt: null,
  createdAt: new Date("2026-10-10T12:00:00.000Z"),
};
const REF = { runId: RUN.id, userId: RUN.userId };

function harness(over: Partial<ResearchActivityDeps> = {}) {
  const lines: ResearchLine[] = [];
  const states: string[] = [];
  /* each step takes a second on the clock */
  let clock = new Date("2026-10-10T12:05:00.000Z").getTime();
  const deps: ResearchActivityDeps = {
    readRow: async () => RUN,
    readTurn: async () => ({ question: "q", answer: "a" }),
    writeState: async (_run, state) => {
      states.push(state);
      return { written: true };
    },
    plan: async () => ({ planned: "brief", brief: "a brief", briefSha256: "d".repeat(64) }),
    read: async () => ({ findings: 2, searches: 4, pageReads: 1 }),
    validate: async () => ({ valid: 2, invalid: 0, duplicate: 0 }),
    submit: async () => ({ suggestionIds: [] }),
    outcomes: async () => ({ pending: 0, proposed: 0, refuted: 0 }),
    record: async () => null,
    findings: async () => [{ outcome: "PROPOSED" }, { outcome: "REFUTED" }, { outcome: "INVALID" }],
    line: (line) => lines.push(line),
    now: () => {
      clock += 1_000;
      return new Date(clock);
    },
    ...over,
  };
  return { activities: researchActivities(deps), lines, states };
}

describe("the research activities' lines", () => {
  it("prints research.plan with how the planner's step ended, a brief's text in no line", async () => {
    const { activities, lines } = harness();
    expect(await activities.planResearch(REF)).toEqual({ planned: "brief" });
    expect(lines).toEqual([{ traceId: RUN.traceId, stage: "plan", runId: RUN.id, outcome: "brief", code: null, searches: null, pageReads: null, findings: null, proposed: null, refuted: null, ms: 1_000 }]);
    expect(JSON.stringify(lines)).not.toContain("a brief");
    const nothing = harness({ plan: async () => ({ planned: "nothing" }) });
    await nothing.activities.planResearch(REF);
    expect(nothing.lines.map((line) => line.outcome)).toEqual(["nothing"]);
  });

  it("prints a failed step's line with the code it failed with, a purge as purged, and anything else as INTERNAL; the failure goes on to the workflow", async () => {
    const failed = harness({
      plan: async () => {
        throw ApplicationFailure.create({ type: "PLANNER_FAILED", message: "the output was not JSON", nonRetryable: true });
      },
    });
    await expect(failed.activities.planResearch(REF)).rejects.toThrow("the output was not JSON");
    expect(failed.lines).toMatchObject([{ stage: "plan", outcome: "failed", code: "PLANNER_FAILED" }]);
    expect(JSON.stringify(failed.lines)).not.toContain("JSON");
    const purged = harness({
      read: async () => {
        throw ApplicationFailure.create({ type: "TEXT_PURGED", message: "the brief is gone", nonRetryable: true });
      },
    });
    await expect(purged.activities.readResearch(REF)).rejects.toThrow();
    expect(purged.lines).toMatchObject([{ stage: "read", outcome: "purged", code: "TEXT_PURGED" }]);
    const crashed = harness({
      read: async () => {
        throw new TypeError("cannot read properties of undefined");
      },
    });
    await expect(crashed.activities.readResearch(REF)).rejects.toThrow(TypeError);
    expect(crashed.lines).toMatchObject([{ stage: "read", outcome: "failed", code: "INTERNAL" }]);
  });

  it("prints research.read with the reader's counts, and gives the workflow the count alone", async () => {
    const { activities, lines, states } = harness();
    expect(await activities.readResearch(REF)).toEqual({ findings: 2 });
    expect(lines).toMatchObject([{ stage: "read", outcome: "found", findings: 2, searches: 4, pageReads: 1, ms: 1_000 }]);
    expect(states).toEqual(["VALIDATING"]);
    const capped = harness({ read: async () => ({ planned: "budget", resetsAt: "2026-11-01T00:00:00.000Z", waitMs: 5 }) });
    expect(await capped.activities.readResearch(REF)).toMatchObject({ planned: "budget" });
    expect(capped.lines).toMatchObject([{ stage: "read", outcome: "budget", findings: null }]);
  });

  it("prints research.run as the run ends: the state, the code, the row's counts, what the findings came to and the run's whole time", async () => {
    const { activities, lines, states } = harness();
    await activities.concludeResearch(REF, { state: "DONE" });
    expect(states).toEqual(["DONE"]);
    /* from the hand-over at 12:00 to the end, the state written at 12:05:01 and the line at 12:05:02 */
    expect(lines).toEqual([{ traceId: RUN.traceId, stage: "run", runId: RUN.id, outcome: "DONE", code: null, searches: 3, pageReads: 2, findings: 3, proposed: 1, refuted: 1, ms: 302_000 }]);
    const skipped = harness({ findings: async () => [] });
    await skipped.activities.concludeResearch(REF, { state: "SKIPPED", skip: "NOTHING_TO_RESEARCH" });
    expect(skipped.lines).toMatchObject([{ outcome: "SKIPPED", code: "NOTHING_TO_RESEARCH", findings: 0 }]);
    const failed = harness({ findings: async () => [] });
    await failed.activities.concludeResearch(REF, { state: "FAILED", failure: "Error" });
    expect(failed.lines).toMatchObject([{ outcome: "FAILED", code: "INTERNAL" }]);
  });
});

describe("loadResearch", () => {
  it("reads no turn for a run whose text was purged or whose conversation was deleted, and moves nothing (45 § 3.5)", async () => {
    const read: Array<string | null> = [];
    const detached = harness({
      readRow: async () => ({ ...RUN, state: "QUEUED", messageId: null, textPurgedAt: new Date("2026-10-10T12:01:00.000Z") }),
      readTurn: async (run) => {
        read.push(run.messageId);
        return null;
      },
    });
    expect(await detached.activities.loadResearch(REF)).toEqual({ state: "PURGED" });
    expect(read).toEqual([]);
    expect(detached.states).toEqual([]);
    const loaded = harness();
    expect(await loaded.activities.loadResearch(REF)).toEqual({ state: "LOADED", gap: false, sections: 1 });
    expect(loaded.states).toEqual(["PLANNING"]);
  });
});
