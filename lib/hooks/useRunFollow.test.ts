import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResearchRunView } from "@/lib/schemas/api";

import { createRunFollow, RUN_FOLLOW_FOR_MS, RUN_POLL_MS } from "./useRunFollow";

const RUN = "00000000-0000-4000-8000-0000000072a1";

function view(key: ResearchRunView["line"]["key"], tone: ResearchRunView["line"]["tone"], stale = false): ResearchRunView {
  return {
    id: RUN,
    conversationId: "00000000-0000-4000-8000-0000000072a0",
    ordinal: 1,
    question: "How long are idempotency keys kept?",
    language: "en",
    seeded: false,
    state: tone === "run" ? "READING" : "DONE",
    line: { key, tone },
    stale,
    refusal: null,
    resetsAt: null,
    steps: [],
    sections: [],
    report: null,
    pages: [],
    findings: [],
    usage: { searches: 0, pagesOpened: 0, pagesSeen: null, costUsd: null },
    flag: null,
    createdAt: "2026-10-12T10:31:00.000Z",
    finishedAt: null,
    textPurged: false,
  };
}

/** A follow on doubles: the answers in order (the last repeated), the views it handed on, whether it lost the run. */
function harness(answers: ReadonlyArray<() => Response | Promise<Response>>) {
  let clock = 0;
  let visible = true;
  let listener: (() => void) | null = null;
  const reads: number[] = [];
  const views: string[] = [];
  let lost = false;
  const follow = createRunFollow(RUN, {
    read: async () => {
      reads.push(clock);
      const answer = answers[Math.min(reads.length - 1, answers.length - 1)];
      if (answer === undefined) throw new Error("no answer");
      return answer();
    },
    onView: (seen) => views.push(seen.line.key),
    until: (seen) => seen.line.tone !== "run" || seen.stale,
    onLost: () => {
      lost = true;
    },
    visible: () => visible,
    onVisible: (heard) => {
      listener = heard;
      return () => {
        listener = null;
      };
    },
    now: () => clock,
  });
  /** Move the clock and the timers together, letting each read settle. */
  const pass = async (ms: number): Promise<void> => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  return {
    follow,
    pass,
    reads,
    views,
    lost: () => lost,
    hide: () => {
      visible = false;
    },
    show: () => {
      visible = true;
      listener?.();
    },
    listening: () => listener !== null,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("following a research run (feature-specs/48 § 6)", () => {
  it("reads every 2 s, hands on each view, and stops at an end", async () => {
    const run = harness([json(view("planning", "run")), json(view("reading", "run")), json(view("done", "ok"))]);
    expect(run.reads).toEqual([]);
    await run.pass(RUN_POLL_MS);
    await run.pass(RUN_POLL_MS);
    await run.pass(RUN_POLL_MS);
    await run.pass(RUN_POLL_MS * 5);
    expect(run.views).toEqual(["planning", "reading", "done"]);
    expect(run.reads).toEqual([RUN_POLL_MS, RUN_POLL_MS * 2, RUN_POLL_MS * 3]);
    expect(run.listening()).toBe(false);
  });

  it("stops at a stale run, which nothing moves any more", async () => {
    const run = harness([json(view("abandoned", "mute", true))]);
    await run.pass(RUN_POLL_MS * 4);
    expect(run.views).toEqual(["abandoned"]);
    expect(run.reads).toHaveLength(1);
  });

  it("stops on 401, 403 and 404, keeping the last view, and says it lost the run, as the 90 minutes do (unit 72's review)", async () => {
    for (const status of [401, 403, 404]) {
      const run = harness([json(view("reading", "run")), json({ code: "NOT_FOUND" }, status)]);
      await run.pass(RUN_POLL_MS);
      expect(run.lost()).toBe(false);
      await run.pass(RUN_POLL_MS * 6);
      expect(run.reads).toHaveLength(2);
      expect(run.views).toEqual(["reading"]);
      expect(run.lost()).toBe(true);
      expect(run.listening()).toBe(false);
    }
  });

  it("waits what a 429's Retry-After says, and tries a 5xx, a bad body or the network again at the next tick", async () => {
    const run = harness([json({ code: "RATE_LIMITED" }, 429, { "retry-after": "7" }), json({}, 503), json({ not: "a view" }), () => Promise.reject(new Error("offline")), json(view("done", "ok"))]);
    await run.pass(RUN_POLL_MS);
    expect(run.reads).toEqual([RUN_POLL_MS]);
    await run.pass(RUN_POLL_MS * 3);
    expect(run.reads).toHaveLength(1);
    await run.pass(1_000);
    expect(run.reads).toEqual([RUN_POLL_MS, RUN_POLL_MS + 7_000]);
    await run.pass(RUN_POLL_MS * 3);
    expect(run.views).toEqual(["done"]);
    expect(run.reads).toHaveLength(5);
  });

  it("asks nothing while the document is hidden, and asks at once when it is seen again", async () => {
    const run = harness([json(view("reading", "run"))]);
    await run.pass(RUN_POLL_MS);
    run.hide();
    await run.pass(RUN_POLL_MS * 10);
    expect(run.reads).toHaveLength(1);
    run.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.reads).toHaveLength(2);
  });

  it("gives up after 90 minutes, the workflow's own bound, and says it lost the run", async () => {
    const run = harness([json(view("reading", "run"))]);
    await run.pass(RUN_FOLLOW_FOR_MS);
    expect(run.lost()).toBe(false);
    await run.pass(RUN_POLL_MS);
    await run.pass(RUN_POLL_MS);
    expect(run.lost()).toBe(true);
    const reads = run.reads.length;
    await run.pass(RUN_POLL_MS * 10);
    expect(run.reads).toHaveLength(reads);
  });

  it("stops when told, a read in flight handing nothing on", async () => {
    let settle: (response: Response) => void = () => undefined;
    const run = harness([() => new Promise<Response>((resolve) => (settle = resolve))]);
    await run.pass(RUN_POLL_MS);
    run.follow.stop();
    settle(json(view("done", "ok"))());
    await run.pass(RUN_POLL_MS * 3);
    expect(run.views).toEqual([]);
    expect(run.reads).toHaveLength(1);
  });
});
