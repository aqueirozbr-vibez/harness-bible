import { ApplicationFailure, CancelledFailure } from "@temporalio/activity";
import { WorkflowFailedError, type WorkflowHandle } from "@temporalio/client";
import { describe, expect, it } from "vitest";

import type { ConversationRunRow } from "@/lib/db/research";
import { loadGuidePart } from "@/lib/guides/load";
import { RESEARCH_RUN_WORKFLOW, RESEARCH_RUN_STAGE_QUERY, ResearchRunWorkflowResultSchema, researchRunWorkflowId } from "@/lib/schemas/workflows";
import type { ResearchLine } from "@/lib/telemetry/lines";
import { defaultResearchRunDeps, researchRunActivities } from "@/workers/activities/researchRun";
import { readRunStep, type ReadRunDeps } from "@/workers/research/run/read";
import type { ResearchRunActivities, RunConclusion } from "@/workers/workflows/activities";

import { workflowEnvironment } from "./environment";

/*
 * ResearchRunWorkflow on the test environment (feature-specs/48 § 5.1, § 26 unit 70; unit 70b), its seven activities
 * doubled: done, each step once with the run's ids as its only argument; refused by the planner with its cause; the
 * person's cap at the planner (`SKIPPED · BUDGET`), at the reader and at the writer (`FAILED · BUDGET`); the gateway
 * refusing the planner (`SKIPPED · UNAVAILABLE`); the writer at the key's rate once (a 65-second wait, then done) and
 * twice (`FAILED · RATE_LIMIT`); the reader's and the writer's own failures; a heartbeat missed, which fails the step
 * within the minute; a cancellation, concluded with its record where the cancellation does not reach, which also stops
 * the read it found running — the real read step and activity, their rows and the reader doubled — with nothing written
 * after the end; a defect after the read and a conclude that cannot conclude, both abandoned; the text purged at each
 * step; and a history that holds only ids, enumerations, numbers and instants.
 */

const RUN = "66666666-6666-4666-8666-666666666666";
const ASKER = "77777777-7777-4777-8777-777777777777";
/** The run's row, as the real read step reads it. */
const ROW: ConversationRunRow = {
  id: RUN,
  userId: ASKER,
  organisationId: null,
  conversationId: "88888888-8888-4888-8888-888888888888",
  ordinal: 1,
  releaseId: "2026.09",
  locale: "EN",
  state: "READING",
  skip: null,
  failure: null,
  refusal: null,
  gap: false,
  sectionAnchors: ["21.3"],
  targetAnchors: ["21.3"],
  questionSha256: "e".repeat(64),
  briefSha256: "d".repeat(64),
  searches: 0,
  pageReads: 0,
  workflowId: researchRunWorkflowId(RUN),
  traceId: "f".repeat(32),
  textPurgedAt: null,
  writingAt: null,
  budgetResetsAt: null,
  createdAt: new Date("2026-10-12T10:00:00.000Z"),
};

type Load = Awaited<ReturnType<ResearchRunActivities["loadRun"]>>;
type Plan = Awaited<ReturnType<ResearchRunActivities["planRun"]>>;
type Read = Awaited<ReturnType<ResearchRunActivities["readRun"]>>;
type Write = Awaited<ReturnType<ResearchRunActivities["writeReport"]>>;
type Step<T> = T | Error | (() => Promise<T>);

const failure = (type: string) => ApplicationFailure.create({ type, message: `the double fails with ${type}`, nonRetryable: true });

async function answer<T>(step: Step<T>): Promise<T> {
  if (step instanceof Error) throw step;
  if (typeof step === "function") return (step as () => Promise<T>)();
  return step;
}

function doubles(script: { readonly loaded?: Load; readonly plan?: Step<Plan>; readonly read?: Step<Read>; readonly validate?: Step<{ valid: number; invalid: number }>; readonly writes?: ReadonlyArray<Step<Write>>; readonly conclude?: ReadonlyArray<ApplicationFailure> } = {}) {
  const calls: string[] = [];
  const ends: RunConclusion[] = [];
  const writes = [...(script.writes ?? [])];
  const concludeFailures = [...(script.conclude ?? [])];
  const activities: ResearchRunActivities = {
    async loadRun(run) {
      calls.push(`load:${run.runId}:${run.userId}`);
      return script.loaded ?? { state: "LOADED" };
    },
    async planRun() {
      calls.push("plan");
      return answer(script.plan ?? { planned: "brief" });
    },
    async readRun() {
      calls.push("read");
      return answer(script.read ?? { read: "found", findings: 2 });
    },
    async validateRun() {
      calls.push("validate");
      return answer(script.validate ?? { valid: 1, invalid: 1 });
    },
    async writeReport(_run, attempt) {
      calls.push(`write:${String(attempt)}`);
      return answer(writes.shift() ?? { written: "report" });
    },
    async concludeRun(_run, end) {
      calls.push(`conclude:${end.state}`);
      const failed = concludeFailures.shift();
      if (failed !== undefined) throw failed;
      ends.push(end);
      const state = end.state === "CANCELLED" ? "FAILED" : end.state;
      return { state };
    },
    async abandonRun() {
      calls.push("abandon");
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

/** Every payload of every event, decoded: what the engine keeps of the run. */
function payloadsOf(event: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(event)) for (const item of event) payloadsOf(item, out);
  else if (typeof event === "object" && event !== null) {
    const record = event as Record<string, unknown>;
    if ("payloads" in record && Array.isArray(record.payloads)) {
      for (const payload of record.payloads as ReadonlyArray<{ readonly metadata?: Record<string, Uint8Array> | null; readonly data?: Uint8Array | null }>) {
        const encoding = payload.metadata?.encoding === undefined ? "" : Buffer.from(payload.metadata.encoding).toString("utf8");
        out.push(encoding === "json/plain" ? JSON.parse(Buffer.from(payload.data ?? new Uint8Array()).toString("utf8")) : encoding === "binary/null" ? null : `encoding ${encoding}`);
      }
    } else for (const item of Object.values(record)) payloadsOf(item, out);
  }
  return out;
}

/** The strings a run's history may hold (invariant 35): an id, an enumeration's value, a cause, an instant — never a sentence. */
const ALLOWED = [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, /^[A-Z][A-Z0-9_]*$/, /^R-[A-Z]+$/, /^(brief|refused|budget|unavailable|found|report|rate_limit)$/, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/];
function strangersIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (!ALLOWED.some((pattern) => pattern.test(value))) out.push(value);
  } else if (Array.isArray(value)) for (const item of value) strangersIn(item, out);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) strangersIn(item, out);
  return out;
}

describe("ResearchRunWorkflow in the test environment", () => {
  const environment = workflowEnvironment();
  const start = (taskQueue: string) => environment().client.workflow.start(RESEARCH_RUN_WORKFLOW, { taskQueue, workflowId: researchRunWorkflowId(RUN), args: [{ runId: RUN, userId: ASKER }] });
  const runOf = async (activities: ResearchRunActivities) => environment().withWorker(activities, async (taskQueue) => ResearchRunWorkflowResultSchema.parse(await (await start(taskQueue)).result()));

  it("loads, plans, reads, checks, writes and concludes DONE, each step once, with the run's ids as its only argument and a history of ids and enumerations", async () => {
    const run = doubles({ plan: { planned: "brief" }, read: { read: "found", findings: 3 }, validate: { valid: 2, invalid: 1 } });
    const { result, payloads, stage } = await environment().withWorker(run.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      const ended = ResearchRunWorkflowResultSchema.parse(await handle.result());
      const history = await handle.fetchHistory();
      return { result: ended, payloads: payloadsOf(history.events ?? []), stage: await handle.query(RESEARCH_RUN_STAGE_QUERY) };
    });
    expect(result).toEqual({ runId: RUN, state: "DONE", findings: 2 });
    expect(run.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "validate", "write:1", "conclude:DONE"]);
    expect(run.ends).toEqual([{ state: "DONE" }]);
    expect(stage).toBe("DONE");
    expect(payloads.length).toBeGreaterThan(8);
    expect(strangersIn(payloads)).toEqual([]);
  });

  it("ends REFUSED with the planner's cause, R-SCOPE and R-PERSONAL, asking no reader", async () => {
    for (const refusal of ["R-SCOPE", "R-PERSONAL"] as const) {
      const run = doubles({ plan: { planned: "refused", refusal } });
      expect(await runOf(run.activities)).toEqual({ runId: RUN, state: "REFUSED", findings: 0 });
      expect(run.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "conclude:REFUSED"]);
      expect(run.ends).toEqual([{ state: "REFUSED", refusal }]);
    }
  });

  it("ends SKIPPED · BUDGET at the person's cap at the planner and SKIPPED · UNAVAILABLE where the gateway refused it, reading nothing (48 § 7.2)", async () => {
    const budget = doubles({ plan: { planned: "budget" } });
    expect(await runOf(budget.activities)).toMatchObject({ state: "SKIPPED", findings: 0 });
    expect(budget.ends).toEqual([{ state: "SKIPPED", skip: "BUDGET" }]);
    expect(budget.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "conclude:SKIPPED"]);
    const unavailable = doubles({ plan: { planned: "unavailable" } });
    await runOf(unavailable.activities);
    expect(unavailable.ends).toEqual([{ state: "SKIPPED", skip: "UNAVAILABLE" }]);
  });

  it("ends FAILED · BUDGET at the person's cap at the reader, writing nothing after; and at the writer, with the findings it has (48 § 7.2)", async () => {
    const atReader = doubles({ read: { read: "budget" } });
    expect(await runOf(atReader.activities)).toEqual({ runId: RUN, state: "FAILED", findings: 0 });
    expect(atReader.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "conclude:FAILED"]);
    expect(atReader.ends).toEqual([{ state: "FAILED", failure: "BUDGET" }]);
    const atWriter = doubles({ writes: [{ written: "budget" }] });
    expect(await runOf(atWriter.activities)).toEqual({ runId: RUN, state: "FAILED", findings: 1 });
    expect(atWriter.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "validate", "write:1", "conclude:FAILED"]);
    expect(atWriter.ends).toEqual([{ state: "FAILED", failure: "BUDGET" }]);
  });

  it("waits 65 seconds once when the writer meets the key's rate limit and asks again (48 § 5.6); a second refusal ends it FAILED · RATE_LIMIT", async () => {
    const once = doubles({ writes: [{ written: "rate_limit" }, { written: "report" }] });
    const { result, timers } = await environment().withWorker(once.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      const ended = ResearchRunWorkflowResultSchema.parse(await handle.result());
      return { result: ended, timers: await timersOf(handle) };
    });
    expect(result).toEqual({ runId: RUN, state: "DONE", findings: 1 });
    expect(once.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "validate", "write:1", "write:2", "conclude:DONE"]);
    expect(timers).toEqual([65]);
    const twice = doubles({ writes: [{ written: "rate_limit" }, { written: "rate_limit" }] });
    expect(await runOf(twice.activities)).toEqual({ runId: RUN, state: "FAILED", findings: 1 });
    expect(twice.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "validate", "write:1", "write:2", "conclude:FAILED"]);
    expect(twice.ends).toEqual([{ state: "FAILED", failure: "RATE_LIMIT" }]);
  });

  it("ends FAILED with the agent's code after one attempt (invariant 15): the planner's, the brief sensor's, the reader's, the writer's", async () => {
    for (const [script, code, calls] of [
      [{ plan: failure("PLANNER_FAILED") }, "PLANNER_FAILED", ["plan"]],
      [{ plan: failure("BRIEF_QUESTION") }, "BRIEF_QUESTION", ["plan"]],
      [{ read: failure("READER_FAILED") }, "READER_FAILED", ["plan", "read"]],
      [{ writes: [failure("WRITER_FAILED")] }, "WRITER_FAILED", ["plan", "read", "validate", "write:1"]],
    ] as const) {
      const run = doubles(script);
      expect(await runOf(run.activities)).toMatchObject({ state: "FAILED" });
      expect(run.calls).toEqual([`load:${RUN}:${ASKER}`, ...calls, "conclude:FAILED"]);
      expect(run.ends).toEqual([{ state: "FAILED", failure: code }]);
    }
  });

  it("ends SKIPPED · TEXT_PURGED wherever a step finds the text gone — at the load, the plan, the read, the check, the write — never FAILED (48 § 5.1)", async () => {
    const purged = () => failure("TEXT_PURGED");
    for (const [script, last] of [
      [{ loaded: { state: "PURGED" } }, `load:${RUN}:${ASKER}`],
      [{ plan: purged() }, "plan"],
      [{ read: purged() }, "read"],
      [{ validate: purged() }, "validate"],
      [{ writes: [purged()] }, "write:1"],
    ] as const) {
      const run = doubles(script);
      expect(await runOf(run.activities)).toMatchObject({ state: "SKIPPED" });
      expect(run.calls.at(-2)).toBe(last);
      expect(run.ends).toEqual([{ state: "SKIPPED", skip: "TEXT_PURGED" }]);
    }
  });

  it("leaves a run another hand already ended as it stands, concluding nothing (a start the web tier took back)", async () => {
    const run = doubles({ loaded: { state: "ENDED", ended: "SKIPPED" } });
    expect(await runOf(run.activities)).toEqual({ runId: RUN, state: "SKIPPED", findings: 0 });
    expect(run.calls).toEqual([`load:${RUN}:${ASKER}`]);
  });

  it("gives each agent's step a heartbeat of a minute, so a step whose worker is lost fails within it, and ends the run FAILED · TIMEOUT with what it has (48 § 5.1)", async () => {
    /* what the engine is told of each step: its whole time and, for the three agents, the heartbeat it waits for */
    const run = doubles();
    const scheduled = await environment().withWorker(run.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      await handle.result();
      const { events } = await handle.fetchHistory();
      return (events ?? []).flatMap((event) => {
        const attributes = event.activityTaskScheduledEventAttributes;
        if (attributes === null || attributes === undefined) return [];
        /* a step with no heartbeat has none to wait for: the engine reads zero */
        const seconds = (duration: { seconds?: unknown } | null | undefined) => Number(duration?.seconds ?? 0);
        return [[attributes.activityType?.name ?? "", seconds(attributes.startToCloseTimeout), seconds(attributes.heartbeatTimeout)]];
      });
    });
    expect(scheduled).toEqual([
      ["loadRun", 120, 0],
      ["planRun", 600, 60],
      ["readRun", 2_100, 60],
      ["validateRun", 120, 0],
      ["writeReport", 300, 60],
      ["concludeRun", 120, 0],
    ]);
    /* a worker lost mid-read: no heartbeat and no answer, until the test lets it go; the engine's clock moved past the minute */
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lost = doubles({
      read: async () => {
        entered();
        await stuck;
        return { read: "found", findings: 1 };
      },
    });
    const result = await environment().withWorker(lost.activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      const ended = handle.result();
      await inRead;
      await environment().sleep("70 seconds");
      const settled = ResearchRunWorkflowResultSchema.parse(await ended);
      release();
      return settled;
    });
    expect(result).toEqual({ runId: RUN, state: "FAILED", findings: 0 });
    expect(lost.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "conclude:FAILED"]);
    expect(lost.ends).toEqual([{ state: "FAILED", failure: "TIMEOUT" }]);
  }, 60_000);

  it("concludes a cancelled run where the cancellation does not reach, with its record, closes the workflow as cancelled, and stops the read it found running: the step ends at its next heartbeat, the reader's signal aborted, nothing written after the end (48 § 5.1; spec 46's erasure; review of unit 70)", async () => {
    let entered: () => void = () => undefined;
    const inRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let answer: () => void = () => undefined;
    const late = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const written: string[] = [];
    const lines: ResearchLine[] = [];
    const seen: { signal: AbortSignal | null; activity: Promise<string> | null; step: Promise<unknown> | null } = { signal: null, activity: null, step: null };
    /* the read step as the workers run it, its rows doubled; a reader that would read on, answering only when the test lets it — after the end */
    const readDeps: ReadRunDeps = {
      guide: () => loadGuidePart("researcher", "v2.0", "reader"),
      rubric: async () => null,
      readBrief: async () => "Look for the current practice.",
      readSections: async () => [],
      read: async (input) => {
        seen.signal = input.signal ?? null;
        entered();
        await late;
        return { ok: true, output: { findings: [], notes: [] }, model: "claude-opus-5", usage: null, promptSha256: "a".repeat(64), searches: 2, fetches: 1, pages: [], read: [], continuations: 0 };
      },
      reader: { gateway: {} as ReadRunDeps["reader"]["gateway"] },
      writeFound: async () => {
        written.push("found");
        return { written: true };
      },
      writeCounts: async () => {
        written.push("counts");
      },
      log: () => undefined,
      now: () => new Date(),
    };
    /* the activity as the workers run it: its heartbeat and its cancellation are the activity's own */
    const real = researchRunActivities({
      ...defaultResearchRunDeps(),
      readRow: async () => ROW,
      read: (row, steps, signal) => {
        const step = readRunStep(row, steps, readDeps, signal);
        seen.step = step.then(
          () => "stored",
          (error: unknown) => (error instanceof ApplicationFailure ? error.type : error),
        );
        return step;
      },
      line: (line) => lines.push(line),
      log: () => undefined,
      heartbeatEveryMs: 100,
    });
    const run = doubles();
    const activities: ResearchRunActivities = {
      ...run.activities,
      readRun(ref) {
        run.calls.push("read");
        const reading = real.readRun(ref);
        seen.activity = reading.then(
          () => "answered",
          (error: unknown) => (error instanceof CancelledFailure ? "cancelled" : String(error)),
        );
        return reading;
      },
    };
    const outcome = await environment().withWorker(
      activities,
      async (taskQueue) => {
        const handle = await start(taskQueue);
        await inRead;
        await handle.cancel();
        const failed = await handle.result().then(
          () => null,
          (error: unknown) => error,
        );
        /* the step learns of the cancellation from a heartbeat's answer and ends, the reader still reading */
        const activity = await seen.activity;
        const abortedBeforeTheAnswer = seen.signal?.aborted;
        answer();
        return { failed, status: (await handle.describe()).status.name, activity, abortedBeforeTheAnswer, step: await seen.step };
      },
      { heartbeatsEvery: "100 milliseconds" },
    );
    expect(outcome.failed).toBeInstanceOf(WorkflowFailedError);
    expect(outcome.status).toBe("CANCELLED");
    expect(run.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "conclude:CANCELLED"]);
    expect(run.ends).toEqual([{ state: "CANCELLED" }]);
    expect(outcome.activity).toBe("cancelled");
    expect(outcome.abortedBeforeTheAnswer).toBe(true);
    /* the reader answered after the end: the step stored nothing, neither the counts nor found */
    expect(outcome.step).toBe("CANCELLED");
    expect(written).toEqual([]);
    expect(lines).toEqual([expect.objectContaining({ stage: "read", outcome: "failed", code: "CANCELLED" })]);
  }, 60_000);

  it("abandons a run whose failure escapes its steps — a defect after the read, a conclude whose three attempts are spent — as FAILED · INTERNAL with no record, and fails the workflow (48 § 5.1)", async () => {
    const defect = doubles({ validate: failure("NO_RUBRIC") });
    const failed = await environment().withWorker(defect.activities, async (taskQueue) => (await start(taskQueue)).result().then(() => null, (error: unknown) => error));
    expect(failed).toBeInstanceOf(WorkflowFailedError);
    expect(defect.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "validate", "abandon"]);
    expect(defect.ends).toEqual([]);
    /* the database away for each of the conclude's three attempts: a failure the engine retries */
    const unconcluded = doubles({ conclude: [1, 2, 3].map(() => ApplicationFailure.create({ type: "DB_DOWN", message: "the database is away", nonRetryable: false })) });
    const failedToo = await environment().withWorker(unconcluded.activities, async (taskQueue) => (await start(taskQueue)).result().then(() => null, (error: unknown) => error));
    expect(failedToo).toBeInstanceOf(WorkflowFailedError);
    expect(unconcluded.calls).toEqual([`load:${RUN}:${ASKER}`, "plan", "read", "validate", "write:1", "conclude:DONE", "conclude:DONE", "conclude:DONE", "abandon"]);
  }, 60_000);
});
