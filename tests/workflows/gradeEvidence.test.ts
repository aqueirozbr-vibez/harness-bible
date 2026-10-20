import { WorkflowFailedError } from "@temporalio/client";
import { describe, expect, it } from "vitest";

import { GRADE_EVIDENCE_STAGE_QUERY, GRADE_EVIDENCE_WORKFLOW, GradeEvidenceResultSchema, gradeEvidenceWorkflowId } from "@/lib/schemas/workflows";
import type { EvidenceActivities } from "@/workers/workflows/activities";

import { workflowEnvironment } from "./environment";

/*
 * GradeEvidenceWorkflow in Temporal's test environment (feature-specs/32 § 8): the real workflow code as the workers
 * bundle it, with its three activities doubled. The three run in order and the stage query answers each; an item
 * that could not be opened ends after the first with no grade asked; one with no text ends after the second; a
 * grade the budget refused ends pending; a cancel while an activity runs ends the workflow as cancelled; a bad
 * argument fails without retry.
 */

const ITEM = "4f1c9a2e-0000-4000-8000-000000000010";

interface Doubles {
  readonly activities: EvidenceActivities;
  readonly calls: string[];
  /** Resolve to let a blocked `gradeItem` or `fetchItem` go on. */
  readonly release: () => void;
}

function doubles(options: { readonly opened?: boolean; readonly text?: boolean; readonly budget?: boolean; readonly blockOn?: "fetchItem" | "gradeItem" } = {}): Doubles {
  const calls: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const activities: EvidenceActivities = {
    async fetchItem(itemId) {
      calls.push(`fetchItem:${itemId}`);
      if (options.blockOn === "fetchItem") await gate;
      return options.opened === false ? { opened: false, fetchStatus: "unreachable:private" } : { opened: true, fetchStatus: "opened:200" };
    },
    async storeText(itemId) {
      calls.push(`storeText:${itemId}`);
      return { text: options.text !== false };
    },
    async gradeItem(itemId) {
      calls.push(`gradeItem:${itemId}`);
      if (options.blockOn === "gradeItem") await gate;
      return options.budget === true ? { state: "PENDING", resetsAt: "2026-11-01T00:00:00.000Z", waitMs: 604_800_000 } : { state: "GRADED", tier: "C" };
    },
  };
  return { activities, calls, release: () => release() };
}

const rootCause = (error: unknown): unknown => (error instanceof Error && error.cause !== undefined ? rootCause(error.cause) : error);

describe("GradeEvidenceWorkflow in the test environment", () => {
  const environment = workflowEnvironment();

  it("runs fetch, store and grade in order, answers the stage at each, and returns the grade", async () => {
    const { activities, calls, release } = doubles({ blockOn: "gradeItem" });
    const result = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(GRADE_EVIDENCE_WORKFLOW, { taskQueue, workflowId: gradeEvidenceWorkflowId(ITEM), args: [{ itemId: ITEM }] });
      /* The third activity is held; by then the stage says so. */
      for (let tries = 0; tries < 50 && !calls.includes(`gradeItem:${ITEM}`); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await handle.query(GRADE_EVIDENCE_STAGE_QUERY)).toBe("3 of 3");
      release();
      const done = GradeEvidenceResultSchema.parse(await handle.result());
      expect(await handle.query(GRADE_EVIDENCE_STAGE_QUERY)).toBe("3 of 3");
      return done;
    });
    expect(result).toEqual({ itemId: ITEM, state: "GRADED", tier: "C" });
    expect(calls).toEqual([`fetchItem:${ITEM}`, `storeText:${ITEM}`, `gradeItem:${ITEM}`]);
  });

  it("ends after the fetch, as U, for an item that could not be opened: no text stored, no grade asked", async () => {
    const { activities, calls } = doubles({ opened: false });
    const result = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(GRADE_EVIDENCE_WORKFLOW, { taskQueue, workflowId: gradeEvidenceWorkflowId("4f1c9a2e-0000-4000-8000-000000000011"), args: [{ itemId: "4f1c9a2e-0000-4000-8000-000000000011" }] });
      const done = GradeEvidenceResultSchema.parse(await handle.result());
      expect(await handle.query(GRADE_EVIDENCE_STAGE_QUERY)).toBe("1 of 3");
      return done;
    });
    expect(result).toEqual({ itemId: "4f1c9a2e-0000-4000-8000-000000000011", state: "GRADED", tier: "U" });
    expect(calls).toEqual(["fetchItem:4f1c9a2e-0000-4000-8000-000000000011"]);
  });

  it("ends after the text step, as U, for an item with no text to grade", async () => {
    const { activities, calls } = doubles({ text: false });
    const result = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(GRADE_EVIDENCE_WORKFLOW, { taskQueue, workflowId: gradeEvidenceWorkflowId("4f1c9a2e-0000-4000-8000-000000000012"), args: [{ itemId: "4f1c9a2e-0000-4000-8000-000000000012" }] });
      return GradeEvidenceResultSchema.parse(await handle.result());
    });
    expect(result).toMatchObject({ state: "GRADED", tier: "U" });
    expect(calls).toHaveLength(2);
  });

  it("leaves the item pending when the budget refused the grade", async () => {
    const { activities } = doubles({ budget: true });
    const result = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(GRADE_EVIDENCE_WORKFLOW, { taskQueue, workflowId: gradeEvidenceWorkflowId("4f1c9a2e-0000-4000-8000-000000000013"), args: [{ itemId: "4f1c9a2e-0000-4000-8000-000000000013" }] });
      return GradeEvidenceResultSchema.parse(await handle.result());
    });
    expect(result).toEqual({ itemId: "4f1c9a2e-0000-4000-8000-000000000013", state: "PENDING", tier: null });
  });

  it("ends as cancelled when asked to while the fetch runs, with nothing after it", async () => {
    const { activities, calls, release } = doubles({ blockOn: "fetchItem" });
    const failure = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(GRADE_EVIDENCE_WORKFLOW, { taskQueue, workflowId: gradeEvidenceWorkflowId("4f1c9a2e-0000-4000-8000-000000000014"), args: [{ itemId: "4f1c9a2e-0000-4000-8000-000000000014" }] });
      for (let tries = 0; tries < 50 && calls.length === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
      await handle.cancel();
      const outcome = await handle.result().then(
        () => null,
        (error: unknown) => error,
      );
      release();
      return outcome;
    });
    expect(failure).toBeInstanceOf(WorkflowFailedError);
    expect(String((failure as Error).message)).toMatch(/cancel/i);
    expect(calls).toEqual(["fetchItem:4f1c9a2e-0000-4000-8000-000000000014"]);
  });

  it("fails without retry on an argument that is not an item's id", async () => {
    const { activities, calls } = doubles();
    const failure = await environment().withWorker(activities, async (taskQueue) => {
      const handle = await environment().client.workflow.start(GRADE_EVIDENCE_WORKFLOW, { taskQueue, workflowId: gradeEvidenceWorkflowId("4f1c9a2e-0000-4000-8000-000000000015"), args: [{ itemId: "nonsense" }] });
      return handle.result().then(
        () => null,
        (error: unknown) => error,
      );
    });
    expect(failure).toBeInstanceOf(WorkflowFailedError);
    expect(rootCause(failure)).toMatchObject({ type: "WORKFLOW_INPUT" });
    expect(calls).toEqual([]);
  });
});
