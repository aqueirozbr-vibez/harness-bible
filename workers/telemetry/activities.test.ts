import { ApplicationFailure, CancelledFailure, type Context } from "@temporalio/activity";
import type { ActivityExecuteInput } from "@temporalio/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/errors";
import { logActivity, logResearch, researchLineOf } from "@/lib/telemetry/lines";
import { LINE_KINDS } from "@/lib/telemetry/print";
import { setSpanSink, withSpanScope, type SpanRecord } from "@/lib/telemetry/spans";
import { workflowTraceId } from "@/lib/telemetry/subjects";

import { activitySpans, endOf, inActivitySpan, type ActivitySpanDeps, type ExecutionInfo } from "./activities";

/*
 * The activity interceptor on a fake context (feature-specs/49 § 7.1, § 16 unit 84): an `activity` line and a span per
 * execution, with the workflow's type and id, the attempt and the outcome, and never an error's message; the
 * activity's own spans under it; an activity's throw rethrown unchanged; a failing lookup, the derived trace; a legacy
 * research run, no trace attribute; and the interceptor's own failures costing a span, never the activity.
 */

const RUN = "33333333-3333-4333-8333-333333333333";
const RUN_TRACE = "0af7651916cd43dd8448eb211c80319c";
const SECRET_WORDS = "the page at https://pages.example/private said the brief";

const INFO: ExecutionInfo = { activityType: "planRun", attempt: 2, workflowType: "ResearchRunWorkflow", workflowExecution: { workflowId: `research:${RUN}`, runId: "e2c1b7a0-0000-4000-8000-000000000001" } };

let spans: SpanRecord[] = [];
let printed: Array<Record<string, unknown>> = [];
let warnings: string[] = [];

function deps(overrides: Partial<ActivitySpanDeps> = {}): ActivitySpanDeps {
  return {
    lookups: {
      suggestionOfEvidenceItem: () => Promise.resolve(null),
      researchTraceOf: (id) => Promise.resolve(id === RUN ? { runId: RUN, traceId: RUN_TRACE } : null),
      researchTraceOfFinding: () => Promise.resolve(null),
    },
    warn: (line) => warnings.push(line),
    log: logActivity,
    ...overrides,
  };
}

const activityLines = (): Array<Record<string, unknown>> => printed.filter((line) => line.kind === "activity");

beforeEach(() => {
  spans = [];
  printed = [];
  warnings = [];
  setSpanSink((record) => spans.push(record));
  vi.spyOn(console, "info").mockImplementation((text: unknown) => {
    printed.push(JSON.parse(String(text)) as Record<string, unknown>);
  });
});

afterEach(() => {
  setSpanSink(null);
  vi.restoreAllMocks();
});

describe("the activity spans (49 § 7.1)", () => {
  it("prints one activity line and records one span per execution, a root, with the activity's work nested under it", async () => {
    const value = await inActivitySpan(INFO, async () => {
      /* the run's own line, printed by the activity as it would be */
      logResearch(researchLineOf("plan", { traceId: RUN_TRACE, runId: RUN }, "brief", 12));
      return "planned";
    }, deps());
    expect(value).toBe("planned");
    expect(activityLines()).toEqual([{ kind: "activity", traceId: RUN_TRACE, activity: "planRun", workflowType: "ResearchRunWorkflow", workflowId: `research:${RUN}`, attempt: 2, outcome: "ok", code: null, ms: expect.any(Number) as number }]);
    const activity = spans.find((span) => span.name === "activity.planRun");
    const plan = spans.find((span) => span.name === "research.plan");
    expect(spans.map((span) => span.name)).toEqual(["research.plan", "activity.planRun"]);
    expect(activity).toMatchObject({ traceId: RUN_TRACE, parentId: null, spanId: expect.stringMatching(/^[0-9a-f]{16}$/) as string });
    expect(activity?.attributes).toMatchObject({ "hb.workflow.type": "ResearchRunWorkflow", "hb.workflow.id": `research:${RUN}`, "hb.activity.attempt": 2, "hb.outcome": "ok", "hb.code": null, "langfuse.trace.name": "research.run", "langfuse.trace.tags": ["research"], "langfuse.trace.metadata.run_id": RUN });
    expect(activity).not.toHaveProperty("error");
    expect(activity?.attributes).not.toHaveProperty("hb.parent");
    /* the run's line nests under the activity and carries the subject's trace attributes */
    expect(plan?.parentId).toBe(activity?.spanId);
    expect(plan?.attributes).toMatchObject({ "langfuse.trace.name": "research.run", "langfuse.trace.metadata.run_id": RUN });
    expect(warnings).toEqual([]);
  });

  it("rethrows an activity's throw unchanged, and its line and span say failed with the code and never the message", async () => {
    const thrown = ApplicationFailure.create({ type: "BUDGET_EXCEEDED", message: SECRET_WORDS, nonRetryable: true });
    let caught: unknown;
    try {
      await inActivitySpan(INFO, () => Promise.reject(thrown), deps());
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBe(thrown);
    expect(activityLines()).toEqual([expect.objectContaining({ outcome: "failed", code: "BUDGET_EXCEEDED", attempt: 2 })]);
    expect(spans).toEqual([expect.objectContaining({ name: "activity.planRun", error: "BUDGET_EXCEEDED", attributes: expect.objectContaining({ "hb.outcome": "failed", "hb.code": "BUDGET_EXCEEDED" }) as unknown })]);
    expect(JSON.stringify([printed, spans])).not.toContain("pages.example");
  });

  it("names how a throw ended: a time-out a failure, a cancellation cancelled, a code where the error has one, else its name", () => {
    expect(endOf(new CancelledFailure("TIMED_OUT"))).toEqual({ outcome: "failed", code: "TIMEOUT" });
    for (const reason of ["CANCELLED", "WORKER_SHUTDOWN", "NOT_FOUND"]) expect(endOf(new CancelledFailure(reason)), reason).toEqual({ outcome: "cancelled", code: "CANCELLED" });
    /* what the SDK reports to the engine as a failure is one here too, with its reason */
    for (const reason of ["PAUSED", "RESET", "HEARTBEAT_DETAILS_CONVERSION_FAILED"]) expect(endOf(new CancelledFailure(reason)), reason).toEqual({ outcome: "failed", code: reason });
    /* the context's reason decides, whatever an abort-aware call rejected with on it */
    const aborted = Object.assign(new Error(SECRET_WORDS), { name: "AbortError" });
    expect(endOf(aborted, "CANCELLED")).toEqual({ outcome: "cancelled", code: "CANCELLED" });
    expect(endOf(aborted, "TIMED_OUT")).toEqual({ outcome: "failed", code: "TIMEOUT" });
    expect(endOf(aborted)).toEqual({ outcome: "failed", code: "AbortError" });
    expect(endOf(ApplicationFailure.create({ type: "RATE_LIMIT", message: SECRET_WORDS }))).toEqual({ outcome: "failed", code: "RATE_LIMIT" });
    expect(endOf(new AppError("GATEWAY_BUDGET", SECRET_WORDS))).toEqual({ outcome: "failed", code: "GATEWAY_BUDGET" });
    /* a type that is no code, a plain error and a thrown string: the name */
    expect(endOf(ApplicationFailure.create({ type: "some words", message: SECRET_WORDS }))).toEqual({ outcome: "failed", code: "ApplicationFailure" });
    expect(endOf(new TypeError(SECRET_WORDS))).toEqual({ outcome: "failed", code: "TypeError" });
    expect(endOf(SECRET_WORDS)).toEqual({ outcome: "failed", code: "Error" });
  });

  it("records a cancellation with its code and no error status", async () => {
    await expect(inActivitySpan(INFO, () => Promise.reject(new CancelledFailure("CANCELLED")), deps())).rejects.toBeInstanceOf(CancelledFailure);
    expect(spans).toEqual([expect.objectContaining({ attributes: expect.objectContaining({ "hb.outcome": "cancelled", "hb.code": "CANCELLED" }) as unknown })]);
    expect(spans[0]).not.toHaveProperty("error");
  });

  it("files the execution under the workflow's derived trace where the lookup fails, and runs the activity", async () => {
    const failing = deps({ lookups: { ...deps().lookups, researchTraceOf: () => Promise.reject(new Error(SECRET_WORDS)) } });
    expect(await inActivitySpan(INFO, () => Promise.resolve(1), failing)).toBe(1);
    expect(spans).toEqual([expect.objectContaining({ name: "activity.planRun", traceId: workflowTraceId(`research:${RUN}`) })]);
    expect(activityLines()[0]).toMatchObject({ traceId: workflowTraceId(`research:${RUN}`), outcome: "ok" });
    expect(warnings).toEqual(["telemetry: ResearchRunWorkflow's activity is filed under its workflow's own trace (Error)"]);
  });

  it("sets no trace attribute for a legacy research run: its mark and its run's id, in its turn's trace", async () => {
    const legacy: ExecutionInfo = { ...INFO, activityType: "planResearch", workflowType: "ResearchWorkflow", workflowExecution: { workflowId: `research:${RUN}`, runId: "e2c1b7a0-0000-4000-8000-000000000002" } };
    await inActivitySpan(legacy, async () => {
      logResearch(researchLineOf("run", { traceId: RUN_TRACE, runId: RUN }, "DONE", 40));
    }, deps());
    const [run, activity] = spans;
    expect(activity?.attributes).toMatchObject({ "hb.legacy": true, "hb.research.run_id": RUN, "hb.workflow.type": "ResearchWorkflow" });
    expect(activityLines()[0]).toMatchObject({ legacy: true, runId: RUN });
    for (const span of spans) expect(Object.keys(span.attributes).filter((key) => key.startsWith("langfuse.trace.") || key === "langfuse.release"), span.name).toEqual([]);
    expect(run?.parentId).toBe(activity?.spanId);
  });

  it("costs a span's facts and never the activity when its own line fails, on success and on a throw", async () => {
    const broken = deps({
      log: () => {
        throw new RangeError("no stdout");
      },
    });
    expect(await inActivitySpan(INFO, () => Promise.resolve("ran"), broken)).toBe("ran");
    expect(warnings).toEqual(["telemetry: an activity's line was not printed (RangeError)"]);
    /* the scope records its own span plain, a root with its own id, so the activity's children still have their parent */
    expect(spans).toEqual([expect.objectContaining({ name: "activity.planRun", traceId: RUN_TRACE, parentId: null, spanId: expect.stringMatching(/^[0-9a-f]{16}$/) as string })]);
    expect(spans[0]).not.toHaveProperty("error");
    /* a throw with the line broken: the same error, and the span failed with the error's name */
    spans = [];
    const thrown = new TypeError(SECRET_WORDS);
    await expect(inActivitySpan(INFO, () => Promise.reject(thrown), broken)).rejects.toBe(thrown);
    expect(spans).toEqual([expect.objectContaining({ name: "activity.planRun", error: "TypeError", parentId: null })]);
    expect(JSON.stringify(spans)).not.toContain("pages.example");
  });

  it("never fails the activity, nor changes its error, when the line and the warning both fail", async () => {
    const silent = deps({
      log: () => {
        throw new RangeError("no stdout");
      },
      warn: () => {
        throw new Error("stderr closed");
      },
    });
    expect(await inActivitySpan(INFO, () => Promise.resolve("ran"), silent)).toBe("ran");
    expect(spans).toEqual([expect.not.objectContaining({ error: expect.anything() as unknown })]);
    const thrown = ApplicationFailure.create({ type: "BUDGET_EXCEEDED", message: SECRET_WORDS });
    await expect(inActivitySpan(INFO, () => Promise.reject(thrown), silent)).rejects.toBe(thrown);
    /* a lookup that finds nothing, its warning lost: the derived trace, and the activity runs */
    spans = [];
    const lost = deps({
      lookups: { ...deps().lookups, researchTraceOf: () => Promise.resolve(null) },
      warn: () => {
        throw new Error("stderr closed");
      },
    });
    expect(await inActivitySpan(INFO, () => Promise.resolve("ran again"), lost)).toBe("ran again");
    expect(spans).toEqual([expect.objectContaining({ name: "activity.planRun", traceId: workflowTraceId(`research:${RUN}`) })]);
  });

  it("is a root of its subject's trace even inside another scope of the same trace, with none of that scope's attributes", async () => {
    /* a legacy run's activity shares its turn's trace: were the worker's code inside the turn's scope, it would not nest there */
    const legacy: ExecutionInfo = { ...INFO, activityType: "planResearch", workflowType: "ResearchWorkflow" };
    await withSpanScope({ traceId: RUN_TRACE, spanId: "c".repeat(16), request: true, trace: { name: "assistant.turn", tags: ["turn"] } }, () => inActivitySpan(legacy, () => Promise.resolve(), deps()));
    await withSpanScope({ traceId: RUN_TRACE, spanId: "c".repeat(16), request: true, trace: { name: "assistant.turn", tags: ["turn"] } }, () => inActivitySpan(INFO, () => Promise.resolve(), deps()));
    const [legacySpan, runSpan] = spans;
    expect(legacySpan).toMatchObject({ name: "activity.planResearch", parentId: null });
    expect(Object.keys(legacySpan?.attributes ?? {}).filter((key) => key.startsWith("langfuse.trace.") || key === "hb.parent")).toEqual([]);
    expect(runSpan).toMatchObject({ name: "activity.planRun", parentId: null, attributes: expect.objectContaining({ "langfuse.trace.name": "research.run" }) as unknown });
    expect(runSpan?.attributes).not.toHaveProperty("hb.parent");
  });

  it("leaves an activity no workflow started alone, and the line kind is the collector's", async () => {
    expect(await inActivitySpan({ activityType: "standalone", attempt: 1 }, () => Promise.resolve(3), deps())).toBe(3);
    expect(spans).toEqual([]);
    expect(printed).toEqual([]);
    expect(LINE_KINDS).toContain("activity");
  });

  it("is an interceptor factory: execute runs next with its input inside the span", async () => {
    const factory = activitySpans(deps());
    const inbound = factory({ info: INFO, cancellationSignal: new AbortController().signal } as unknown as Context).inbound;
    const input: ActivityExecuteInput = { args: [{ runId: RUN }], headers: {} };
    const next = vi.fn((given: ActivityExecuteInput) => Promise.resolve(given.args.length));
    expect(await inbound?.execute?.(input, next)).toBe(1);
    expect(next).toHaveBeenCalledWith(input);
    expect(spans.map((span) => span.name)).toEqual(["activity.planRun"]);
  });

  it("reads a cancellation's reason from the activity's context, as the SDK aborts it", async () => {
    const controller = new AbortController();
    controller.abort(new CancelledFailure("CANCELLED"));
    const inbound = activitySpans(deps())({ info: INFO, cancellationSignal: controller.signal } as unknown as Context).inbound;
    /* an abort-aware call rejects with its own error on the aborted signal */
    const aborted = Object.assign(new Error(SECRET_WORDS), { name: "AbortError" });
    await expect(inbound?.execute?.({ args: [], headers: {} }, () => Promise.reject(aborted))).rejects.toBe(aborted);
    expect(activityLines()).toEqual([expect.objectContaining({ outcome: "cancelled", code: "CANCELLED" })]);
    expect(spans[0]).not.toHaveProperty("error");
  });
});
