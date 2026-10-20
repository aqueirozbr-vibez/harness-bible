import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { WorkflowHandle } from "@temporalio/client";

import { RESEARCH_WORKFLOW, ResearchWorkflowResultSchema, researchWorkflowId } from "@/lib/schemas/workflows";
import type { ResearchActivities } from "@/workers/workflows/activities";
import { OUTCOMES_EVERY_MAX_MS, OUTCOMES_EVERY_MS, OUTCOMES_STEADY_MS } from "@/workers/research/pace";

import { workflowEnvironment } from "./environment";

/*
 * ResearchWorkflow on the test environment (feature-specs/40 § 6.2; unit 57d), its six activities doubled: a run whose
 * text was purged ends SKIPPED · TEXT_PURGED; the planner's failure ends it FAILED with the failure's code and asks no
 * second time (invariant 15); a plan of nothing ends SKIPPED · NOTHING_TO_RESEARCH; a cap waits for the reset the
 * activity gave, then asks again; a brief read and validated submits and ends DONE. Every argument that crosses the
 * engine is the run's id.
 */

const RUN = "33333333-3333-4333-8333-333333333333";
const MESSAGE = "44444444-4444-4444-8444-444444444444";
const ASKER = "55555555-5555-4555-8555-555555555555";

type Plan = Awaited<ReturnType<ResearchActivities["planResearch"]>>;
type Read = Awaited<ReturnType<ResearchActivities["readResearch"]>>;

type Outcomes = Awaited<ReturnType<ResearchActivities["findingOutcomes"]>>;

function doubles(script: { readonly loaded?: Awaited<ReturnType<ResearchActivities["loadResearch"]>>; readonly plans?: Array<Plan | ApplicationFailure>; readonly reads?: Array<Read | ApplicationFailure>; readonly valid?: number; readonly validateFails?: ApplicationFailure; readonly submitted?: ReadonlyArray<string>; readonly outcomes?: ReadonlyArray<Outcomes | ApplicationFailure>; readonly outcomesThen?: Outcomes } = {}) {
  const calls: string[] = [];
  const ends: Array<Parameters<ResearchActivities["concludeResearch"]>[1]> = [];
  const plans = [...(script.plans ?? [])];
  const reads = [...(script.reads ?? [])];
  const outcomes = [...(script.outcomes ?? [])];
  const activities: ResearchActivities = {
    async loadResearch(run) {
      calls.push(`load:${run.runId}:${run.userId}`);
      return script.loaded ?? { state: "LOADED", gap: false, sections: 1 };
    },
    async planResearch() {
      calls.push("plan");
      const answer = plans.shift() ?? { planned: "brief" };
      if (answer instanceof ApplicationFailure) throw answer;
      return answer;
    },
    async readResearch() {
      calls.push("read");
      const answer = reads.shift() ?? { findings: 2 };
      if (answer instanceof ApplicationFailure) throw answer;
      return answer;
    },
    async validateFindings() {
      calls.push("validate");
      if (script.validateFails !== undefined) throw script.validateFails;
      return { valid: script.valid ?? 2, invalid: 0, duplicate: 0 };
    },
    async submitFindings() {
      calls.push("submit");
      return { suggestionIds: script.submitted ?? [] };
    },
    async findingOutcomes() {
      calls.push("outcomes");
      const answer = outcomes.shift() ?? script.outcomesThen ?? { pending: 0, proposed: 0, refuted: 0 };
      if (answer instanceof ApplicationFailure) throw answer;
      return answer;
    },
    async concludeResearch(_runId, end) {
      calls.push(`conclude:${end.state}`);
      ends.push(end);
    },
  };
  return { activities, calls, ends };
}

/** The timers a run started, in seconds, in order. */
async function timersOf(handle: WorkflowHandle): Promise<ReadonlyArray<number>> {
  const { events } = await handle.fetchHistory();
  return (events ?? []).flatMap((event) => {
    const timeout = event.timerStartedEventAttributes?.startToFireTimeout;
    return timeout === null || timeout === undefined ? [] : [Number(timeout.seconds ?? 0)];
  });
}

describe("ResearchWorkflow in the test environment", () => {
  const environment = workflowEnvironment();
  const start = (taskQueue: string) => environment().client.workflow.start(RESEARCH_WORKFLOW, { taskQueue, workflowId: researchWorkflowId(MESSAGE), args: [{ runId: RUN, userId: ASKER }] });

  it("plans, reads, validates, submits and concludes DONE, each step once, with the run's id as its only argument", async () => {
    const run = doubles();
    const result = await environment().withWorker(run.activities, async (taskQueue) => ResearchWorkflowResultSchema.parse(await (await start(taskQueue)).result()));
    expect(result).toEqual({ runId: RUN, state: "DONE", findings: 2 });
    expect(run.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "validate", "submit", "conclude:DONE"]);
  });

  it("ends SKIPPED · TEXT_PURGED when the turn's text is gone, asking no model", async () => {
    const run = doubles({ loaded: { state: "PURGED" } });
    const result = await environment().withWorker(run.activities, async (taskQueue) => ResearchWorkflowResultSchema.parse(await (await start(taskQueue)).result()));
    expect(result).toMatchObject({ state: "SKIPPED", findings: 0 });
    expect(run.calls).toEqual([`load:${RUN}:${ASKER}`, "conclude:SKIPPED"]);
    expect(run.ends).toEqual([{ state: "SKIPPED", skip: "TEXT_PURGED" }]);
  });

  it("ends FAILED with the planner's code after one attempt (invariant 15), and SKIPPED · NOTHING_TO_RESEARCH on a plan of nothing", async () => {
    const failing = doubles({ plans: [ApplicationFailure.create({ type: "PLANNER_NOT_BUILT", message: "not yet", nonRetryable: true })] });
    const failed = await environment().withWorker(failing.activities, async (taskQueue) => ResearchWorkflowResultSchema.parse(await (await start(taskQueue)).result()));
    expect(failed).toMatchObject({ state: "FAILED" });
    expect(failing.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "conclude:FAILED"]);
    expect(failing.ends).toEqual([{ state: "FAILED", failure: "PLANNER_NOT_BUILT" }]);
    const nothing = doubles({ plans: [{ planned: "nothing" }] });
    await environment().withWorker(nothing.activities, async (taskQueue) => (await start(taskQueue)).result());
    expect(nothing.ends).toEqual([{ state: "SKIPPED", skip: "NOTHING_TO_RESEARCH" }]);
  });

  it("ends SKIPPED · TEXT_PURGED, not FAILED, when an activity finds the text purged on the way: at the planner, at the reader, at the validation (40 § 8.3)", async () => {
    const purged = () => ApplicationFailure.create({ type: "TEXT_PURGED", message: "the text is gone", nonRetryable: true });
    const atPlanner = doubles({ plans: [purged()] });
    expect(await environment().withWorker(atPlanner.activities, async (taskQueue) => ResearchWorkflowResultSchema.parse(await (await start(taskQueue)).result()))).toMatchObject({ state: "SKIPPED", findings: 0 });
    expect(atPlanner.ends).toEqual([{ state: "SKIPPED", skip: "TEXT_PURGED" }]);
    const atReader = doubles({ reads: [purged()] });
    await environment().withWorker(atReader.activities, async (taskQueue) => (await start(taskQueue)).result());
    expect(atReader.ends).toEqual([{ state: "SKIPPED", skip: "TEXT_PURGED" }]);
    const atValidation = doubles({ validateFails: purged() });
    await environment().withWorker(atValidation.activities, async (taskQueue) => (await start(taskQueue)).result());
    expect(atValidation.ends).toEqual([{ state: "SKIPPED", skip: "TEXT_PURGED" }]);
    expect(atValidation.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "validate", "conclude:SKIPPED"]);
  });

  it("ends FAILED with the code where the validation or the submission failed, concluding as any failure does (review of unit 61)", async () => {
    const run = doubles({ validateFails: ApplicationFailure.create({ type: "NO_RUBRIC", message: "no rubric is published", nonRetryable: true }) });
    const result = await environment().withWorker(run.activities, async (taskQueue) => ResearchWorkflowResultSchema.parse(await (await start(taskQueue)).result()));
    expect(result).toMatchObject({ state: "FAILED", findings: 0 });
    expect(run.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "validate", "conclude:FAILED"]);
    expect(run.ends).toEqual([{ state: "FAILED", failure: "NO_RUBRIC" }]);
  });

  it("starts each suggestion's workflow as an abandoned child, then asks where they stand until none is still deciding (42 § 4, § 5)", async () => {
    const run = doubles({ submitted: ["S-21-0101", "S-21-0102"], outcomes: [{ pending: 2, proposed: 0, refuted: 0 }, { pending: 1, proposed: 1, refuted: 0 }, { pending: 0, proposed: 1, refuted: 1 }] });
    /* the child's first activity, doubled to end the child at once: the parent abandons it either way */
    const withChild = { ...run.activities, recordSubmitted: async () => { throw ApplicationFailure.create({ type: "DOUBLE", message: "a double ends the child", nonRetryable: true }); } };
    const result = await environment().withWorker(withChild, async (taskQueue) => ResearchWorkflowResultSchema.parse(await (await start(taskQueue)).result()));
    expect(result).toEqual({ runId: RUN, state: "DONE", findings: 2 });
    expect(run.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "validate", "submit", "outcomes", "outcomes", "outcomes", "conclude:DONE"]);
  });

  /* the child's first activity, doubled to end the child at once: the parent abandons it either way */
  const endingChild = { recordSubmitted: async () => { throw ApplicationFailure.create({ type: "DOUBLE", message: "a double ends the child", nonRetryable: true }); } };

  it("asks again where an ask failed — the database away a moment — and ends DONE as the next answer says, never FAILED (unit 59's review)", async () => {
    const run = doubles({ submitted: ["S-21-0101"], outcomes: [ApplicationFailure.create({ type: "DB_DOWN", message: "the database is away", nonRetryable: true }), { pending: 0, proposed: 1, refuted: 0 }] });
    const result = await environment().withWorker({ ...run.activities, ...endingChild }, async (taskQueue) => ResearchWorkflowResultSchema.parse(await (await start(taskQueue)).result()));
    expect(result).toMatchObject({ state: "DONE" });
    expect(run.calls.filter((call) => call === "outcomes")).toHaveLength(2);
    expect(run.ends).toEqual([{ state: "DONE" }]);
  });

  it("asks a suggestion still deciding every 30 s for ten minutes, then twice as long each time up to two hours, and ends after forty days with a history the engine holds (unit 59's review)", async () => {
    const run = doubles({ submitted: ["S-21-0101"], outcomesThen: { pending: 1, proposed: 0, refuted: 0 } });
    const { result, timers } = await environment().withWorker({ ...run.activities, ...endingChild }, async (taskQueue) => {
      const handle = await start(taskQueue);
      const ended = ResearchWorkflowResultSchema.parse(await handle.result());
      return { result: ended, timers: await timersOf(handle) };
    });
    expect(result).toMatchObject({ state: "DONE" });
    const asks = run.calls.filter((call) => call === "outcomes").length;
    /* forty days in about five hundred asks, not the hundred thousand of an ask every 30 s */
    expect(asks).toBeGreaterThan(450);
    expect(asks).toBeLessThan(560);
    expect(timers.slice(0, OUTCOMES_STEADY_MS / OUTCOMES_EVERY_MS)).toEqual(Array.from({ length: OUTCOMES_STEADY_MS / OUTCOMES_EVERY_MS }, () => OUTCOMES_EVERY_MS / 1000));
    expect(Math.max(...timers)).toBe(OUTCOMES_EVERY_MAX_MS / 1000);
    expect(timers.length).toBe(asks - 1);
  }, 180_000);

  it("waits for the budget's reset where the cap refused the planner, then plans again and goes on (40 § 7.2)", async () => {
    const capped = doubles({ plans: [{ planned: "budget", resetsAt: "2026-11-01T00:00:00.000Z", waitMs: 3_600_000 }, { planned: "brief" }], valid: 0 });
    const result = await environment().withWorker(capped.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      /* the test server skips time: the hour's sleep passes at once */
      return ResearchWorkflowResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "DONE", findings: 2 });
    expect(capped.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "plan", "read", "validate", "conclude:DONE"]);
  });
});
