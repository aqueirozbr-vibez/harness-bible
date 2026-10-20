import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { WorkflowHandle } from "@temporalio/client";

import { findingWorkflowId, SEND_FINDING_WORKFLOW, SendFindingWorkflowResultSchema } from "@/lib/schemas/workflows";
import { OUTCOMES_EVERY_MAX_MS, OUTCOMES_EVERY_MS, OUTCOMES_STEADY_MS } from "@/workers/research/pace";
import type { SendFindingActivities } from "@/workers/workflows/activities";

import { workflowEnvironment } from "./environment";

/*
 * SendFindingWorkflow on the test environment (feature-specs/48 § 8.4; unit 74), its two activities doubled: every end
 * of the send — the finding gone, used by another hand, failed with its code, a duplicate — ends the workflow with no
 * child and no ask; a suggestion made starts its workflow as an abandoned child and is asked after, paced as the legacy
 * run paces it, until Improve places it; an ask that fails is asked again; a finding gone while it waits ends the wait;
 * forty days still deciding end it undecided; a cancellation ends it with nothing owed. Every argument that crosses the
 * engine is the finding's id and its asker's, and its history holds no sentence.
 */

const FINDING = "77777777-7777-4777-8777-777777777777";
const ASKER = "55555555-5555-4555-8555-555555555555";

type Sent = Awaited<ReturnType<SendFindingActivities["sendFinding"]>>;
type Outcome = Awaited<ReturnType<SendFindingActivities["findingOutcome"]>>["outcome"];

function doubles(script: { readonly sent?: Sent | ApplicationFailure; readonly outcomes?: ReadonlyArray<Outcome | ApplicationFailure>; readonly outcomesThen?: Outcome } = {}) {
  const calls: string[] = [];
  const outcomes = [...(script.outcomes ?? [])];
  const activities: SendFindingActivities = {
    async sendFinding(finding) {
      calls.push(`send:${finding.findingId}:${finding.userId}`);
      const sent = script.sent ?? { sent: "submitted", suggestionId: "S-21-0101" };
      if (sent instanceof ApplicationFailure) throw sent;
      return sent;
    },
    async findingOutcome(finding) {
      calls.push(`outcome:${finding.findingId}`);
      const next = outcomes.shift() ?? script.outcomesThen ?? "PROPOSED";
      if (next instanceof ApplicationFailure) throw next;
      return { outcome: next };
    },
  };
  return { activities, calls };
}

/* the child's first activity, doubled to end the child at once: the send abandons it either way */
const endingChild = {
  recordSubmitted: async () => {
    throw ApplicationFailure.create({ type: "DOUBLE", message: "a double ends the child", nonRetryable: true });
  },
};

/** Every payload of every event, decoded: what the engine keeps of the send (as tests/workflows/researchRun.test.ts reads them). */
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

/** The strings a send's history may hold: an id, a suggestion's id, an enumeration's value, a code — never a sentence. */
const ALLOWED = [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, /^S-\d{2}-\d{4,}$/, /^[A-Z][A-Z0-9_]*$/, /^(submitted|duplicate|failed|used|gone)$/];
function strangersIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (!ALLOWED.some((pattern) => pattern.test(value))) out.push(value);
  } else if (Array.isArray(value)) for (const item of value) strangersIn(item, out);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) strangersIn(item, out);
  return out;
}

/** The timers a run started, in seconds, in order; and whether it started a child. */
async function historyOf(handle: WorkflowHandle): Promise<{ readonly timers: ReadonlyArray<number>; readonly children: ReadonlyArray<string> }> {
  const { events } = await handle.fetchHistory();
  return {
    timers: (events ?? []).flatMap((event) => {
      const timeout = event.timerStartedEventAttributes?.startToFireTimeout;
      return timeout === null || timeout === undefined ? [] : [Number(timeout.seconds ?? 0)];
    }),
    children: (events ?? []).flatMap((event) => {
      const id = event.startChildWorkflowExecutionInitiatedEventAttributes?.workflowId;
      return id === null || id === undefined ? [] : [id];
    }),
  };
}

describe("SendFindingWorkflow in the test environment", () => {
  const environment = workflowEnvironment();
  const start = (taskQueue: string) => environment().client.workflow.start(SEND_FINDING_WORKFLOW, { taskQueue, workflowId: findingWorkflowId(FINDING), args: [{ findingId: FINDING, userId: ASKER }] });
  /* the abandoned child is awaited while the worker still runs: a child left with an activity on a queue nobody polls
     would hold the test server's clock for the cases after (tests/workflows/environment.ts) */
  const settleChildren = async (children: ReadonlyArray<string>): Promise<void> => {
    /* asked by `describe`, which leaves the test server's clock alone, as a `result()` of the time-skipping client does not */
    for (const child of children) {
      const handle = environment().client.workflow.getHandle(child);
      for (let tries = 0; tries < 100 && (await handle.describe()).status.name === "RUNNING"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const run = async (activities: SendFindingActivities | (SendFindingActivities & typeof endingChild)) =>
    environment().withWorker(activities, async (taskQueue) => {
      const handle = await start(taskQueue);
      const result = SendFindingWorkflowResultSchema.parse(await handle.result());
      const history = await historyOf(handle);
      await settleChildren(history.children);
      return { result, history };
    });

  it("sends, starts the suggestion's workflow as an abandoned child, and ends PROPOSED once Improve places it; the ids are its only arguments", async () => {
    const send = doubles({ outcomes: ["PENDING", "PENDING", "PROPOSED"] });
    const { result, history } = await run({ ...send.activities, ...endingChild });
    expect(result).toEqual({ findingId: FINDING, end: "PROPOSED", suggestionId: "S-21-0101", failure: null });
    expect(send.calls).toEqual([`send:${FINDING}:${ASKER}`, `outcome:${FINDING}`, `outcome:${FINDING}`, `outcome:${FINDING}`]);
    expect(history.children).toEqual(["suggestion:S-21-0101"]);
    expect(history.timers).toEqual([OUTCOMES_EVERY_MS / 1000, OUTCOMES_EVERY_MS / 1000]);
  });

  it("ends REFUTED as the ask says, the child abandoned to its own decision", async () => {
    const send = doubles({ outcomes: ["PENDING", "REFUTED"] });
    const { result, history } = await run({ ...send.activities, ...endingChild });
    expect(result).toMatchObject({ end: "REFUTED", suggestionId: "S-21-0101" });
    expect(history.timers).toEqual([OUTCOMES_EVERY_MS / 1000]);
  });

  it("ends at the send where it made nothing to wait for: the finding gone, used by another hand, failed with its code, a duplicate — no child, no ask", async () => {
    for (const [sent, end] of [
      [{ sent: "gone" }, { end: "GONE", suggestionId: null, failure: null }],
      [{ sent: "used" }, { end: "USED", suggestionId: null, failure: null }],
      [{ sent: "failed", failure: "NO_RUBRIC" }, { end: "FAILED", suggestionId: null, failure: "NO_RUBRIC" }],
      [{ sent: "failed", failure: "ANCHOR_UNKNOWN" }, { end: "FAILED", suggestionId: null, failure: "ANCHOR_UNKNOWN" }],
      /* the month's thirty taken by the time the send's transaction ran (D5; review of unit 74) */
      [{ sent: "failed", failure: "SENDS_LIMIT" }, { end: "FAILED", suggestionId: null, failure: "SENDS_LIMIT" }],
      [{ sent: "duplicate", suggestionId: "S-21-0007" }, { end: "DUPLICATE", suggestionId: "S-21-0007", failure: null }],
    ] as const) {
      const send = doubles({ sent });
      const { result, history } = await run(send.activities);
      expect(result).toEqual({ findingId: FINDING, ...end });
      expect(send.calls).toEqual([`send:${FINDING}:${ASKER}`]);
      expect(history.children).toEqual([]);
    }
  });

  it("asks again where an ask failed, and ends as the next answer says, never failed by it", async () => {
    const send = doubles({ outcomes: [ApplicationFailure.create({ type: "DB_DOWN", message: "the database is away", nonRetryable: true }), "PROPOSED"] });
    const { result } = await run({ ...send.activities, ...endingChild });
    expect(result).toMatchObject({ end: "PROPOSED" });
    expect(send.calls.filter((call) => call.startsWith("outcome:"))).toHaveLength(2);
  });

  it("ends the wait where the finding is gone while it waits (a delete's sweep, an erasure); its child runs on", async () => {
    const send = doubles({ outcomes: ["PENDING", "GONE"] });
    const { result, history } = await run({ ...send.activities, ...endingChild });
    expect(result).toEqual({ findingId: FINDING, end: "GONE", suggestionId: "S-21-0101", failure: null });
    expect(history.children).toEqual(["suggestion:S-21-0101"]);
  });

  it("asks every 30 s for ten minutes, then twice as long each time up to two hours, and ends UNDECIDED after forty days", async () => {
    const send = doubles({ outcomesThen: "PENDING" });
    const { result, history } = await run({ ...send.activities, ...endingChild });
    expect(result).toMatchObject({ end: "UNDECIDED", suggestionId: "S-21-0101" });
    const asks = send.calls.filter((call) => call.startsWith("outcome:")).length;
    expect(asks).toBeGreaterThan(450);
    expect(asks).toBeLessThan(560);
    expect(history.timers.slice(0, OUTCOMES_STEADY_MS / OUTCOMES_EVERY_MS)).toEqual(Array.from({ length: OUTCOMES_STEADY_MS / OUTCOMES_EVERY_MS }, () => OUTCOMES_EVERY_MS / 1000));
    expect(Math.max(...history.timers)).toBe(OUTCOMES_EVERY_MAX_MS / 1000);
  }, 180_000);

  it("ends with nothing owed where it is cancelled while it waits (spec 46's erasure)", async () => {
    const send = doubles({ outcomesThen: "PENDING" });
    const cancelled = await environment().withWorker({ ...send.activities, ...endingChild }, async (taskQueue) => {
      const handle = await start(taskQueue);
      /* the first ask has been answered PENDING: the workflow sleeps on its first timer */
      for (let tries = 0; tries < 200 && !send.calls.some((call) => call.startsWith("outcome:")); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      await handle.cancel();
      const ended = await handle.result().then(
        () => "completed",
        (error: unknown) => (error instanceof Error ? error.name : "unknown"),
      );
      await settleChildren((await historyOf(handle)).children);
      return ended;
    });
    expect(cancelled).not.toBe("completed");
    expect(send.calls.filter((call) => call.startsWith("send:"))).toHaveLength(1);
  });

  it("holds nothing but ids, codes and enumerations in its history (invariant 35)", async () => {
    const send = doubles({ outcomes: ["PENDING", "PROPOSED"] });
    const payloads = await environment().withWorker({ ...send.activities, ...endingChild }, async (taskQueue) => {
      const handle = await start(taskQueue);
      await handle.result();
      await settleChildren((await historyOf(handle)).children);
      return payloadsOf((await handle.fetchHistory()).events ?? []);
    });
    expect(payloads.length).toBeGreaterThan(5);
    expect(strangersIn(payloads)).toEqual([]);
  });
});
