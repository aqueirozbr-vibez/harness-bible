"use client";

import { useEffect, useRef, useState } from "react";

import { EVIDENCE_POLL_MS } from "@/lib/improve/evidenceView";
import { ResearchRunViewSchema, type ResearchRunView } from "@/lib/schemas/api";
import { RESEARCH_RUN_EXECUTION_TIMEOUT_MS } from "@/lib/schemas/workflows";

/*
 * Following a research run while it is under way (feature-specs/48 § 6; unit 72), the pattern of `useResearchFollow`:
 * every 2 s the page asks `GET /api/v1/research/runs/{id}` and puts the answer on the run, so each step shows as it
 * happens without a reload. Two seconds is the interval Andre set for the evidence list (spec 34 D2, `EVIDENCE_POLL_MS`),
 * because a step is seconds apart; thirty reads a minute stay inside the endpoint's sixty.
 *
 * It stops when the follower says the view is what it waited for (a run at an end, or stale); and it stops and says it
 * lost the run (`still under way · reload to follow`) on a 401, 403 or 404 — a session that ended, or a research deleted
 * elsewhere — the run keeping its last view, and after 90 minutes, the workflow's own bound. A stop that said nothing
 * would leave the run under way on screen for ever, and the composer busy with it (unit 72's review). A 429 waits what
 * `Retry-After` says; a 5xx, a body that does not parse or a network failure is tried again at the next tick. A hidden
 * document is not read, and is read at once when seen again.
 *
 * The same follow serves a finding after a send (§ 8.3, unit 74), with its own end and its minute. Its state is one
 * plain object made once (code-standards § React components), which the suite drives with fake timers.
 */

export const RUN_POLL_MS = EVIDENCE_POLL_MS;
export const RUN_FOLLOW_FOR_MS = RESEARCH_RUN_EXECUTION_TIMEOUT_MS;

export interface RunFollowDeps {
  /** The run's view, read as the page reads it. */
  readonly read: (runId: string) => Promise<Response>;
  readonly onView: (view: ResearchRunView) => void;
  /** Whether this view is the end of the follow. */
  readonly until: (view: ResearchRunView) => boolean;
  /** The run can no longer be followed: the bound passed with it still not at its end, or a 401, 403 or 404. */
  readonly onLost: () => void;
  /** Whether the document is seen, and a way to hear when it is seen again; the hook gives the document's. */
  readonly visible: () => boolean;
  readonly onVisible: (listener: () => void) => () => void;
  readonly now: () => number;
  readonly everyMs?: number;
  readonly forMs?: number;
}

export interface RunFollow {
  /** Stop asking: the component went, or the run changed. */
  readonly stop: () => void;
}

/** Follow one run from now; the first read is one interval away, since the caller already holds a view. */
export function createRunFollow(runId: string, deps: RunFollowDeps): RunFollow {
  const everyMs = deps.everyMs ?? RUN_POLL_MS;
  const forMs = deps.forMs ?? RUN_FOLLOW_FOR_MS;
  const since = deps.now();
  const state = { gone: false, reading: false, timer: null as ReturnType<typeof setTimeout> | null };

  const end = (): void => {
    state.gone = true;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    unlisten();
  };

  const schedule = (ms: number): void => {
    if (state.gone || !deps.visible()) return;
    state.timer = setTimeout(() => void tick(), ms);
  };

  const tick = async (): Promise<void> => {
    state.timer = null;
    if (state.gone || state.reading) return;
    /* hidden: nothing asked, and nothing scheduled until the document is seen again */
    if (!deps.visible()) return;
    if (deps.now() - since > forMs) {
      end();
      deps.onLost();
      return;
    }
    state.reading = true;
    let next = everyMs;
    try {
      const response = await deps.read(runId);
      if (state.gone) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        end();
        deps.onLost();
        return;
      }
      if (response.status === 429) {
        const after = Number(response.headers.get("retry-after"));
        if (Number.isFinite(after) && after > 0) next = Math.max(next, after * 1_000);
      } else if (response.ok) {
        const parsed = ResearchRunViewSchema.safeParse(await response.json());
        if (state.gone) return;
        if (parsed.success) {
          deps.onView(parsed.data);
          if (deps.until(parsed.data)) {
            end();
            return;
          }
        }
      }
    } catch {
      /* the network: asked again at the next tick */
    } finally {
      state.reading = false;
    }
    schedule(next);
  };

  const unlisten = deps.onVisible(() => {
    if (!state.gone && state.timer === null && !state.reading) void tick();
  });
  schedule(everyMs);
  return { stop: end };
}

/**
 * The hook: follows `runId` while it is not null, and says whether it lost the run. A new id starts a new follow; the
 * callbacks are read through a ref, so a render does not restart it.
 */
export function useRunFollow(runId: string | null, follower: { readonly onView: (view: ResearchRunView) => void; readonly until: (view: ResearchRunView) => boolean; readonly forMs?: number }): { readonly lost: boolean } {
  const latest = useRef(follower);
  useEffect(() => {
    latest.current = follower;
  });
  const [lost, setLost] = useState<string | null>(null);

  useEffect(() => {
    if (runId === null) return;
    const follow = createRunFollow(runId, {
      read: (id) => fetch(`/api/v1/research/runs/${id}`, { headers: { accept: "application/json" } }),
      onView: (view) => latest.current.onView(view),
      until: (view) => latest.current.until(view),
      onLost: () => setLost(runId),
      visible: () => document.visibilityState !== "hidden",
      onVisible: (listener) => {
        const seen = (): void => {
          if (document.visibilityState === "visible") listener();
        };
        document.addEventListener("visibilitychange", seen);
        return () => document.removeEventListener("visibilitychange", seen);
      },
      now: () => Date.now(),
      forMs: latest.current.forMs,
    });
    return () => follow.stop();
  }, [runId]);

  return { lost: runId !== null && lost === runId };
}
