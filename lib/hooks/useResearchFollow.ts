"use client";

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import type { Turn } from "@/lib/assistant/turns";
import { researchLineOf } from "@/lib/research/view";
import { ResearchViewSchema } from "@/lib/schemas/api";

/*
 * Following a run while it is not over (feature-specs/43 § 4.3, D1, D14; unit 60a): every 5 s the dock reads
 * `GET /api/v1/assistant/messages/{id}/research` for the newest turns whose research is still under way — at most
 * three, which is twelve reads a minute each against the reader's sixty — and puts the answer on the turn, so the line
 * moves from `queued` to its end without a reload. It stops for a turn at an end (DONE, SKIPPED, FAILED,
 * WAITING_BUDGET), after ten minutes of asking, and on a 401, 403 or 404, the line keeping its last words; a 429 waits
 * what `Retry-After` says; a 5xx or a network failure is tried again at the next tick. A hidden document is not read,
 * and is read at once when seen again (the evidence list's own pattern).
 */

export const RESEARCH_POLL_MS = 5_000;
export const RESEARCH_POLL_FOR_MS = 600_000;
export const RESEARCH_FOLLOW_MAX = 3;

/** The turns the dock follows: answered, with research under way, the newest first, at most RESEARCH_FOLLOW_MAX. */
export function turnsToFollow(turns: ReadonlyArray<Turn>): ReadonlyArray<string> {
  return turns
    .flatMap((turn) => (turn.answer !== null && turn.answer.refusal === null && turn.answer.research !== null && researchLineOf(turn.answer.research).follow ? [turn.answer.messageId] : []))
    .slice(-RESEARCH_FOLLOW_MAX)
    .reverse();
}

interface ReadOutcome {
  readonly stop: boolean;
  /** When the server asked for a wait, in milliseconds. */
  readonly waitMs: number | null;
}

async function readOne(messageId: string, apply: (view: ReturnType<typeof ResearchViewSchema.parse>) => void): Promise<ReadOutcome> {
  try {
    const response = await fetch(`/api/v1/assistant/messages/${messageId}/research`, { headers: { accept: "application/json" } });
    if (response.status === 429) {
      const after = Number(response.headers.get("retry-after"));
      return { stop: false, waitMs: Number.isFinite(after) && after > 0 ? after * 1_000 : null };
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) return { stop: true, waitMs: null };
    if (!response.ok) return { stop: false, waitMs: null };
    const parsed = ResearchViewSchema.safeParse(await response.json());
    if (parsed.success) apply(parsed.data);
    return { stop: false, waitMs: null };
  } catch {
    return { stop: false, waitMs: null };
  }
}

export function useResearchFollow(turns: ReadonlyArray<Turn>, setTurns: Dispatch<SetStateAction<ReadonlyArray<Turn>>>, enabled: boolean): void {
  const following = turnsToFollow(turns).join(",");
  const stopped = useRef(new Set<string>());
  const since = useRef(new Map<string, number>());

  useEffect(() => {
    const ids = following.length === 0 ? [] : following.split(",").filter((id) => !stopped.current.has(id));
    if (!enabled || ids.length === 0) return;
    let gone = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const now = Date.now();
    for (const id of ids) if (!since.current.has(id)) since.current.set(id, now);

    const tick = async (): Promise<void> => {
      timer = null;
      if (gone || reading) return;
      reading = true;
      let next = RESEARCH_POLL_MS;
      for (const id of ids) {
        if (gone) break;
        /* a turn the reader may no longer read (401, 403, 404), or past the bound: asked no more (review of unit 60) */
        if (stopped.current.has(id)) continue;
        if (Date.now() - (since.current.get(id) ?? Date.now()) > RESEARCH_POLL_FOR_MS) {
          stopped.current.add(id);
          continue;
        }
        const outcome = await readOne(id, (view) => {
          setTurns((current) => current.map((turn) => (turn.answer?.messageId === id ? { ...turn, answer: { ...turn.answer, research: view } } : turn)));
        });
        if (outcome.stop) stopped.current.add(id);
        if (outcome.waitMs !== null) next = Math.max(next, outcome.waitMs);
      }
      reading = false;
      if (!gone && ids.some((id) => !stopped.current.has(id)) && document.visibilityState !== "hidden") timer = setTimeout(() => void tick(), next);
    };
    const seen = (): void => {
      if (document.visibilityState === "visible" && timer === null && !reading) void tick();
    };
    document.addEventListener("visibilitychange", seen);
    if (document.visibilityState !== "hidden") timer = setTimeout(() => void tick(), RESEARCH_POLL_MS);
    return () => {
      gone = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [following, enabled, setTurns]);
}
