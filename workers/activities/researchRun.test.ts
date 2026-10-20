import { ApplicationFailure, CancelledFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";

import type { ConversationRunRow, NewResearchStep, ResearchStepPatch } from "@/lib/db/research";
import type { PersonRunEnd } from "@/lib/research/record";
import type { ResearchState } from "@/lib/schemas/research";
import type { ResearchLine } from "@/lib/telemetry/lines";

import { researchRunActivities, type ActivityCancellation, type ResearchRunActivityDeps } from "./researchRun";

/*
 * A person's run's activities (feature-specs/48 § 5.1, § 6, § 15; unit 70b), the door and the agents' steps doubled:
 * what each writes of the run's state and steps, the question redacted again with the workers' secrets, the reset at
 * the cap, `writingAt` before the writer, the end before the record and the record before the line, the cancellation
 * resolved by whether the text is gone, the catch-all's abandon; the heartbeat while an agent's step runs; a
 * cancellation that ends an agent's step at once and aborts the signal its work was handed; and the lines, with counts
 * and outcomes and never a word.
 */

const ROW: ConversationRunRow = {
  id: "33333333-3333-4333-8333-333333333333",
  userId: "55555555-5555-4555-8555-555555555555",
  organisationId: null,
  conversationId: "44444444-4444-4444-8444-444444444444",
  ordinal: 1,
  releaseId: "2026.09",
  locale: "EN",
  state: "QUEUED",
  skip: null,
  failure: null,
  refusal: null,
  gap: false,
  sectionAnchors: [],
  targetAnchors: [],
  questionSha256: "e".repeat(64),
  briefSha256: null,
  searches: 0,
  pageReads: 0,
  workflowId: "research:33333333-3333-4333-8333-333333333333",
  traceId: "f".repeat(32),
  textPurgedAt: null,
  writingAt: null,
  budgetResetsAt: null,
  createdAt: new Date("2026-10-12T10:00:00.000Z"),
};
const REF = { runId: ROW.id, userId: ROW.userId };
/** A value of the workers' own secrets, as the gateway's master key is: the web tier's redaction does not know it. */
const WORKERS_ONLY = "workers-only-value-0042";
/** A cancellation that never comes, as outside an activity. */
const NEVER: ActivityCancellation = { signal: new AbortController().signal, cancelled: new Promise<never>(() => undefined) };

/** A cancellation the case delivers by hand, as a heartbeat's answer delivers it to an activity. */
function cancellable(): { readonly cancellation: ActivityCancellation; readonly cancel: () => void } {
  const controller = new AbortController();
  let reject: (error: unknown) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, rejecting) => {
    reject = rejecting;
  });
  cancelled.catch(() => undefined);
  return {
    cancellation: { signal: controller.signal, cancelled },
    cancel: () => {
      controller.abort();
      reject(new CancelledFailure("CANCELLED"));
    },
  };
}

function harness(over: Partial<ResearchRunActivityDeps> = {}, row: Partial<ConversationRunRow> = {}) {
  let current: ConversationRunRow = { ...ROW, ...row };
  const states: Array<{ state: ResearchState; extra: object }> = [];
  const steps: Array<{ step: NewResearchStep; once: boolean }> = [];
  const completed: Array<{ seq: number; patch: ResearchStepPatch }> = [];
  const lines: ResearchLine[] = [];
  const records: Array<{ row: ConversationRunRow; end: PersonRunEnd }> = [];
  const written: Record<string, unknown> = {};
  let heartbeats = 0;
  let clock = new Date("2026-10-12T10:05:00.000Z").getTime();
  const deps: ResearchRunActivityDeps = {
    readRow: async () => current,
    readQuestion: async () => `Is ${WORKERS_ONLY} safe to retry with?`,
    writeQuestion: async (_run, question, sha) => {
      written.question = question;
      written.questionSha256 = sha;
      return { written: true };
    },
    secrets: () => [WORKERS_ONLY],
    writeState: async (_run, state, extra = {}) => {
      states.push({ state, extra });
      const ended = ["DONE", "SKIPPED", "FAILED", "REFUSED"].includes(current.state);
      if (ended) return { written: false };
      current = { ...current, state, ...(extra as object) } as ConversationRunRow;
      return { written: true };
    },
    appendStep: async (_run, step, options = {}) => {
      steps.push({ step, once: options.once === true });
      return steps.length - 1;
    },
    completeStep: async (_run, seq, patch) => {
      completed.push({ seq, patch });
      return true;
    },
    writeWritingAt: async (_run, at) => {
      written.writingAt ??= at;
    },
    writeBudgetResetsAt: async (_run, resetsAt) => {
      written.budgetResetsAt = resetsAt;
    },
    plan: async () => ({ planned: "brief", brief: "Look for the current practice.", briefSha256: "d".repeat(64), targets: ["21.3"], sections: ["21.3", "21.4"] }),
    read: async () => ({ read: "found", findings: 2, searches: 3, pageReads: 1 }),
    validate: async () => ({ valid: 1, invalid: 1 }),
    write: async () => ({ written: "report", findings: 1, paragraphs: 3, dropped: 1 }),
    record: async (recorded, end) => {
      records.push({ row: recorded, end });
      return null;
    },
    findings: async () => [{ outcome: "VALID" }, { outcome: "INVALID" }],
    line: (line) => lines.push(line),
    heartbeat: () => {
      heartbeats += 1;
    },
    heartbeatEveryMs: 5,
    cancellation: () => NEVER,
    log: () => undefined,
    now: () => {
      clock += 1_000;
      return new Date(clock);
    },
    ...over,
  };
  return { activities: researchRunActivities(deps), states, steps, completed, lines, records, written, heartbeats: () => heartbeats, row: () => current };
}

describe("loadRun", () => {
  it("redacts the question again with the workers' own secrets and writes it back with its hash, then PLANNING and its step, once", async () => {
    const run = harness();
    expect(await run.activities.loadRun(REF)).toEqual({ state: "LOADED" });
    expect(run.written.question).toBe("Is [redacted:process-secret] safe to retry with?");
    expect(run.written.questionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.written.questionSha256).not.toBe(ROW.questionSha256);
    expect(run.states.map((entry) => entry.state)).toEqual(["PLANNING"]);
    expect(run.steps).toEqual([{ step: { kind: "PLANNING", at: expect.any(String) }, once: true }]);
    const clean = harness({ readQuestion: async () => "Why does a retried write become a second write?" });
    await clean.activities.loadRun(REF);
    expect(clean.written.question).toBeUndefined();
  });

  it("says GONE with no row, ENDED where another hand ended it, PURGED where the research was deleted or its text is gone", async () => {
    expect(await harness({ readRow: async () => null }).activities.loadRun(REF)).toEqual({ state: "GONE" });
    expect(await harness({}, { state: "SKIPPED", skip: "UNAVAILABLE" }).activities.loadRun(REF)).toEqual({ state: "ENDED", ended: "SKIPPED" });
    expect(await harness({}, { conversationId: null }).activities.loadRun(REF)).toEqual({ state: "PURGED" });
    expect(await harness({}, { textPurgedAt: new Date() }).activities.loadRun(REF)).toEqual({ state: "PURGED" });
    expect(await harness({ readQuestion: async () => null }).activities.loadRun(REF)).toEqual({ state: "PURGED" });
    expect(await harness({ writeQuestion: async () => ({ written: false }) }).activities.loadRun(REF)).toEqual({ state: "PURGED" });
  });
});

describe("planRun", () => {
  it("stores the brief with the run's sections and targets, READING, and the SECTIONS step of the targets; prints research.plan with no word of the brief", async () => {
    const run = harness();
    expect(await run.activities.planRun(REF)).toEqual({ planned: "brief" });
    expect(run.states).toEqual([{ state: "READING", extra: { brief: "Look for the current practice.", briefSha256: "d".repeat(64), sectionAnchors: ["21.3", "21.4"], targetAnchors: ["21.3"] } }]);
    expect(run.steps.map((entry) => entry.step)).toEqual([{ kind: "SECTIONS", at: expect.any(String), sections: ["21.3"] }]);
    expect(run.lines).toEqual([expect.objectContaining({ stage: "plan", outcome: "brief", runId: ROW.id, code: null })]);
    expect(JSON.stringify(run.lines)).not.toContain("current practice");
    expect(run.heartbeats()).toBeGreaterThanOrEqual(1);
  });

  it("answers a refusal, the cap with its reset on the row, and the gateway's refusal, each with the run's sections written for the card", async () => {
    const refused = harness({ plan: async () => ({ planned: "refused", refusal: "R-PERSONAL", sections: ["21.3"] }) });
    expect(await refused.activities.planRun(REF)).toEqual({ planned: "refused", refusal: "R-PERSONAL" });
    expect(refused.states).toEqual([{ state: "PLANNING", extra: { sectionAnchors: ["21.3"] } }]);
    const resetsAt = new Date("2026-11-01T00:00:00.000Z");
    const budget = harness({ plan: async () => ({ planned: "budget", resetsAt, sections: [] }) });
    expect(await budget.activities.planRun(REF)).toEqual({ planned: "budget" });
    expect(budget.written.budgetResetsAt).toEqual(resetsAt);
    expect(budget.lines.map((line) => line.outcome)).toEqual(["budget"]);
    expect(await harness({ plan: async () => ({ planned: "unavailable", sections: [] }) }).activities.planRun(REF)).toEqual({ planned: "unavailable" });
  });

  it("prints a failed plan's line with its code and lets the failure go on; fails TEXT_PURGED where the brief could not be stored", async () => {
    const failing = harness({ plan: async () => Promise.reject(ApplicationFailure.create({ type: "BRIEF_QUESTION", message: "x", nonRetryable: true })) });
    await expect(failing.activities.planRun(REF)).rejects.toMatchObject({ type: "BRIEF_QUESTION" });
    expect(failing.lines).toEqual([expect.objectContaining({ stage: "plan", outcome: "failed", code: "BRIEF_QUESTION" })]);
    const defect = harness({ plan: async () => Promise.reject(new TypeError("a defect")) });
    await expect(defect.activities.planRun(REF)).rejects.toThrow(TypeError);
    expect(defect.lines[0]).toMatchObject({ outcome: "failed", code: "INTERNAL" });
    const purged = harness({ writeState: async () => ({ written: false }) });
    await expect(purged.activities.planRun(REF)).rejects.toMatchObject({ type: "TEXT_PURGED" });
    expect(purged.steps).toEqual([]);
  });

  it("heartbeats from a timer while the planner runs (48 § 5.1)", async () => {
    const slow = harness({ plan: () => new Promise((resolve) => setTimeout(() => resolve({ planned: "unavailable", sections: [] }), 40)) });
    await slow.activities.planRun(REF);
    expect(slow.heartbeats()).toBeGreaterThanOrEqual(3);
  });
});

describe("readRun", () => {
  it("turns the reader's blocks into steps in order through the one chain, completing each, before it answers; prints research.read with the counts", async () => {
    const run = harness({
      read: async (_row, steps) => {
        steps.onBlock({ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "idempotency key retention" } } as never);
        steps.onBlock({ type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://standards.example/keys", title: "Keys" }] } as never);
        steps.onBlock({ type: "server_tool_use", id: "f1", name: "web_fetch", input: { url: "https://standards.example/keys" } } as never);
        steps.onBlock({ type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } } as never);
        steps.onBlock({ type: "text", text: "{}" } as never);
        await steps.settled();
        return { read: "found", findings: 1, searches: 1, pageReads: 1 };
      },
    });
    expect(await run.activities.readRun(REF)).toEqual({ read: "found", findings: 1 });
    expect(run.steps.map((entry) => entry.step.kind)).toEqual(["SEARCH", "PAGE"]);
    expect(run.completed).toEqual([
      { seq: 0, patch: { results: 1 } },
      { seq: 1, patch: { opened: false } },
    ]);
    expect(run.heartbeats()).toBeGreaterThanOrEqual(5);
    expect(run.lines).toEqual([expect.objectContaining({ stage: "read", outcome: "found", findings: 1, searches: 1, pageReads: 1 })]);
  });

  it("answers the person's cap with the reset on the row, and prints the read's line with the counts it was charged for", async () => {
    const resetsAt = new Date("2026-11-01T00:00:00.000Z");
    const run = harness({ read: async () => ({ read: "budget", resetsAt, searches: 2, pageReads: 1 }) });
    expect(await run.activities.readRun(REF)).toEqual({ read: "budget" });
    expect(run.written.budgetResetsAt).toEqual(resetsAt);
    expect(run.lines).toEqual([expect.objectContaining({ stage: "read", outcome: "budget", searches: 2, pageReads: 1 })]);
    const failed = harness({ read: async () => Promise.reject(ApplicationFailure.create({ type: "READER_FAILED", message: "x", nonRetryable: true })) });
    await expect(failed.activities.readRun(REF)).rejects.toMatchObject({ type: "READER_FAILED" });
    expect(failed.lines[0]).toMatchObject({ outcome: "failed", code: "READER_FAILED" });
  });

  it("ends at once as cancelled when the activity is cancelled mid-read (spec 46's erasure, an operator), aborting the signal the read was handed, and prints the read's line CANCELLED (48 § 5.1; review of unit 70)", async () => {
    const { cancellation, cancel } = cancellable();
    const handed: { signal: AbortSignal | null } = { signal: null };
    let entered: () => void = () => undefined;
    const inRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    /* a reader that would read on for its half hour: it answers only when its signal fires, and then too late */
    const run = harness({
      cancellation: () => cancellation,
      read: (_row, _steps, signal) => {
        handed.signal = signal;
        entered();
        return new Promise<never>(() => undefined);
      },
    });
    const reading = run.activities.readRun(REF);
    await inRead;
    expect(handed.signal?.aborted).toBe(false);
    cancel();
    await expect(reading).rejects.toBeInstanceOf(CancelledFailure);
    expect(handed.signal?.aborted).toBe(true);
    expect(run.lines).toEqual([expect.objectContaining({ stage: "read", outcome: "failed", code: "CANCELLED" })]);
    expect(run.written).toEqual({});
  });
});

describe("validateRun and writeReport", () => {
  it("writes VALIDATING and the CHECKING step once, then checks", async () => {
    const run = harness();
    expect(await run.activities.validateRun(REF)).toEqual({ valid: 1, invalid: 1 });
    expect(run.states.map((entry) => entry.state)).toEqual(["VALIDATING"]);
    expect(run.steps).toEqual([{ step: { kind: "CHECKING", at: expect.any(String) }, once: true }]);
  });

  it("writes WRITING, writingAt before the writer and its step once; keeps the first writingAt on the second attempt; prints research.write with the paragraphs kept and dropped", async () => {
    let calledAt: unknown = null;
    const run = harness({
      write: async () => {
        calledAt = run.written.writingAt;
        return { written: "report", findings: 1, paragraphs: 3, dropped: 1 };
      },
    });
    expect(await run.activities.writeReport(REF, 1)).toEqual({ written: "report" });
    expect(calledAt).toBeInstanceOf(Date);
    expect(run.steps).toEqual([{ step: { kind: "WRITING", at: expect.any(String) }, once: true }]);
    expect(run.lines).toEqual([expect.objectContaining({ stage: "write", outcome: "report", findings: 1, paragraphs: 3, dropped: 1 })]);
    const first = run.written.writingAt;
    await run.activities.writeReport(REF, 2);
    expect(run.written.writingAt).toBe(first);
  });

  it("answers the key's rate and the person's cap, the cap's reset on the row; a failed write's line has its code", async () => {
    expect(await harness({ write: async () => ({ written: "rate_limit" }) }).activities.writeReport(REF, 1)).toEqual({ written: "rate_limit" });
    const resetsAt = new Date("2026-11-01T00:00:00.000Z");
    const budget = harness({ write: async () => ({ written: "budget", resetsAt }) });
    expect(await budget.activities.writeReport(REF, 1)).toEqual({ written: "budget" });
    expect(budget.written.budgetResetsAt).toEqual(resetsAt);
    const failed = harness({ write: async () => Promise.reject(ApplicationFailure.create({ type: "WRITER_FAILED", message: "x", nonRetryable: true })) });
    await expect(failed.activities.writeReport(REF, 1)).rejects.toMatchObject({ type: "WRITER_FAILED" });
    expect(failed.lines[0]).toMatchObject({ stage: "write", outcome: "failed", code: "WRITER_FAILED" });
  });
});

describe("an agent's step on a row another hand ended (review of unit 71)", () => {
  it("calls no planner, reader or writer on a run its start took back or a second start ended, writes nothing, and fails RUN_ENDED", async () => {
    for (const ended of [
      { state: "SKIPPED", skip: "UNAVAILABLE" },
      { state: "FAILED", failure: "ABANDONED" },
    ] as const) {
      const called: string[] = [];
      const said: string[] = [];
      const run = harness(
        {
          plan: async () => {
            called.push("planner");
            return { planned: "unavailable", sections: [] };
          },
          read: async () => {
            called.push("reader");
            return { read: "found", findings: 0, searches: 0, pageReads: 0 };
          },
          write: async () => {
            called.push("writer");
            return { written: "rate_limit" };
          },
          log: (line) => said.push(line),
        },
        ended,
      );
      await expect(run.activities.planRun(REF)).rejects.toMatchObject({ type: "RUN_ENDED", nonRetryable: true });
      await expect(run.activities.readRun(REF)).rejects.toMatchObject({ type: "RUN_ENDED" });
      await expect(run.activities.writeReport(REF, 1)).rejects.toMatchObject({ type: "RUN_ENDED" });
      expect(called).toEqual([]);
      expect(run.states).toEqual([]);
      expect(run.steps).toEqual([]);
      expect(run.written).toEqual({});
      expect(run.lines).toEqual([]);
      expect(run.heartbeats()).toBe(0);
      expect(said).toHaveLength(3);
      expect(said.every((line) => line.includes(`ended ${ended.state}`))).toBe(true);
    }
  });

  it("then concludes nothing over the other hand's end: the record and the line say what the row says", async () => {
    const run = harness({}, { state: "FAILED", failure: "ABANDONED", briefSha256: "d".repeat(64) });
    expect(await run.activities.concludeRun(REF, { state: "FAILED", failure: "RUN_ENDED" })).toEqual({ state: "FAILED" });
    expect(run.row()).toMatchObject({ state: "FAILED", failure: "ABANDONED" });
    expect(run.records[0]?.end).toEqual({ state: "FAILED", failure: "ABANDONED" });
    expect(run.lines).toEqual([expect.objectContaining({ stage: "run", outcome: "FAILED", code: "ABANDONED" })]);
  });
});

describe("concludeRun and abandonRun", () => {
  it("writes the end first, then the record from the row the end left, then the run's line; a refusal's code is its cause with underscores", async () => {
    const order: string[] = [];
    const run = harness({
      record: async (recorded, end) => {
        order.push(`record:${recorded.state}:${end.state}`);
        return null;
      },
      line: (line) => order.push(`line:${line.stage}:${line.outcome}:${String(line.code)}`),
    });
    expect(await run.activities.concludeRun(REF, { state: "REFUSED", refusal: "R-SCOPE" })).toEqual({ state: "REFUSED" });
    expect(run.states).toEqual([{ state: "REFUSED", extra: { refusal: "R-SCOPE" } }]);
    expect(order).toEqual(["record:REFUSED:REFUSED", "line:run:REFUSED:R_SCOPE"]);
  });

  it("writes DONE, a skip and a failure as given; the line counts the findings that passed", async () => {
    for (const [end, state, extra] of [
      [{ state: "DONE" }, "DONE", {}],
      [{ state: "SKIPPED", skip: "BUDGET" }, "SKIPPED", { skip: "BUDGET" }],
      [{ state: "FAILED", failure: "RATE_LIMIT" }, "FAILED", { failure: "RATE_LIMIT" }],
    ] as const) {
      const run = harness();
      await run.activities.concludeRun(REF, end);
      expect(run.states).toEqual([{ state, extra }]);
      expect(run.records[0]?.end).toEqual(end);
      expect(run.lines).toEqual([expect.objectContaining({ stage: "run", outcome: state, findings: 1 })]);
    }
  });

  it("concludes a cancellation SKIPPED · TEXT_PURGED where the text is gone and FAILED · CANCELLED otherwise, each with its record", async () => {
    const gone = harness({}, { textPurgedAt: new Date() });
    await gone.activities.concludeRun(REF, { state: "CANCELLED" });
    expect(gone.states).toEqual([{ state: "SKIPPED", extra: { skip: "TEXT_PURGED" } }]);
    expect(gone.records[0]?.end).toEqual({ state: "SKIPPED", skip: "TEXT_PURGED" });
    const kept = harness();
    await kept.activities.concludeRun(REF, { state: "CANCELLED" });
    expect(kept.states).toEqual([{ state: "FAILED", extra: { failure: "CANCELLED" } }]);
    expect(kept.records[0]?.end).toEqual({ state: "FAILED", failure: "CANCELLED" });
  });

  it("records a retried conclude by the end the row already holds", async () => {
    const run = harness({}, { state: "FAILED", failure: "WRITER_FAILED" });
    expect(await run.activities.concludeRun(REF, { state: "FAILED", failure: "WRITER_FAILED" })).toEqual({ state: "FAILED" });
    expect(run.records[0]?.end).toEqual({ state: "FAILED", failure: "WRITER_FAILED" });
  });

  it("abandons a run that has not ended as FAILED · INTERNAL, with no record, and leaves an ended one alone", async () => {
    const run = harness();
    await run.activities.abandonRun(REF);
    expect(run.states).toEqual([{ state: "FAILED", extra: { failure: "INTERNAL" } }]);
    expect(run.records).toEqual([]);
    expect(run.lines).toEqual([expect.objectContaining({ stage: "run", outcome: "FAILED", code: "INTERNAL" })]);
    const ended = harness({}, { state: "DONE" });
    await ended.activities.abandonRun(REF);
    expect(ended.lines).toEqual([]);
    await harness({ readRow: async () => null }).activities.abandonRun(REF);
  });
});
