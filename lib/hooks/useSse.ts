"use client";

import { useCallback, useRef, useState } from "react";

/*
 * The assistant's stream on the client (feature-specs/16 § 5.9). A POST with a body and headers, so not
 * `EventSource`: the response body is read through a `TextDecoder` and split into frames here.
 *
 * `parseFrames` is pure and tested on its own, because the one thing that must not go wrong is the boundary: a
 * frame split across two reads must arrive as one event, and a half-read frame must wait rather than render.
 */

export const SSE_STEPS = ["running", "retrieving", "drafting", "checking", "grading", "repairing"] as const;
export type SseStep = (typeof SSE_STEPS)[number];

export interface SseFrame {
  readonly id: string;
  readonly event: string;
  readonly data: unknown;
}

export interface SseError {
  readonly code: string;
  readonly message: string;
  /** When the budget resets, for the 402 line (feature-specs/15 § 5.3). */
  readonly resetsAt?: string;
  /** Seconds from `Retry-After` on a 429. */
  readonly retryAfterS?: number;
  /** The error's own detail: a 422's field errors, or a failed aid run's exit code (feature-specs/18 § 6, § 7). */
  readonly detail?: unknown;
}

/**
 * Split whatever has arrived into whole frames and whatever is left. A comment line (`: keepalive`) is a frame with
 * no event name and is dropped; an unparseable `data:` line is dropped too, because the stream's contract is that
 * the final event is the answer — half of one is not a smaller answer, it is none.
 */
export function parseFrames(buffer: string): { readonly frames: ReadonlyArray<SseFrame>; readonly rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  for (;;) {
    const cut = rest.indexOf("\n\n");
    if (cut < 0) break;
    const block = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    let id = "";
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event.length === 0) continue;
    try {
      frames.push({ id, event, data: JSON.parse(data.length === 0 ? "null" : data) });
    } catch {
      /* Not the protocol: the caller ends the turn on the missing `final` rather than on a guess. */
    }
  }
  return { frames, rest };
}

export type SseStatus = "idle" | "waiting" | "streaming" | "done" | "failed";

export interface SseTurn {
  readonly status: SseStatus;
  /** The last `status` event's step, for the dock's status line. */
  readonly step: SseStep | null;
  /** The draft as it arrives. Never a citation, never a chip: those come with `final` (invariant 14). */
  readonly tokens: string;
  readonly meta: Record<string, unknown> | null;
  readonly final: Record<string, unknown> | null;
  readonly error: SseError | null;
}

const IDLE: SseTurn = { status: "idle", step: null, tokens: "", meta: null, final: null, error: null };

function stepOf(data: unknown): SseStep | null {
  const step = typeof data === "object" && data !== null ? (data as { step?: unknown }).step : undefined;
  return SSE_STEPS.find((candidate) => candidate === step) ?? null;
}

function objectOf(data: unknown): Record<string, unknown> | null {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

function errorOf(data: unknown): SseError {
  const row = objectOf(data) ?? {};
  return {
    code: typeof row.code === "string" ? row.code : "INTERNAL",
    message: typeof row.message === "string" ? row.message : "",
    ...(typeof row.resetsAt === "string" ? { resetsAt: row.resetsAt } : {}),
    ...(row.detail === undefined ? {} : { detail: row.detail }),
  };
}

/**
 * One turn's stream. `start` takes the POST to make, so the same hook serves every question; `abort` stops reading
 * and leaves the turn running server side, which is what the reader's row will say when the dock asks again (§ 5.9).
 */
/** What one turn ended as: the caller commits the answer or shows the error, without watching an effect for it. */
export interface SseOutcome {
  readonly final: Record<string, unknown> | null;
  readonly error: SseError | null;
  /** The `meta` event, which is where the turn's trace id is (feature-specs/15 § 6.1). */
  readonly meta: Record<string, unknown> | null;
}

export function useSse(): SseTurn & {
  readonly start: (post: () => Promise<Response>) => Promise<SseOutcome>;
  readonly abort: () => void;
  readonly reset: () => void;
} {
  const [turn, setTurn] = useState<SseTurn>(IDLE);
  const controller = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setTurn(IDLE);
  }, []);

  const abort = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
  }, []);

  const start = useCallback(async (post: () => Promise<Response>): Promise<SseOutcome> => {
    setTurn({ ...IDLE, status: "waiting" });
    const fail = (error: SseError): SseOutcome => {
      setTurn({ ...IDLE, status: "failed", error });
      return { final: null, error, meta: null };
    };

    let response: Response;
    try {
      response = await post();
    } catch {
      return fail({ code: "ASSISTANT_UNAVAILABLE", message: "" });
    }

    /* A status code means the stream never opened: the body is the API's error object (feature-specs/15 § 5.3). */
    if (!response.ok || response.body === null) {
      const body = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown; detail?: unknown } | null;
      const retry = response.headers.get("Retry-After");
      return fail({
        code: typeof body?.code === "string" ? body.code : "INTERNAL",
        message: typeof body?.message === "string" ? body.message : "",
        ...(typeof (body?.detail as { resetsAt?: unknown } | undefined)?.resetsAt === "string" ? { resetsAt: (body?.detail as { resetsAt: string }).resetsAt } : {}),
        ...(body?.detail === undefined ? {} : { detail: body.detail }),
        ...(retry === null ? {} : { retryAfterS: Number(retry) }),
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let open = true;
    const outcome: { final: Record<string, unknown> | null; error: SseError | null; meta: Record<string, unknown> | null } = { final: null, error: null, meta: null };
    try {
      while (open) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const { frames, rest } = parseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          switch (frame.event) {
            case "meta":
              outcome.meta = objectOf(frame.data);
              setTurn((current) => ({ ...current, status: "streaming", meta: outcome.meta }));
              break;
            case "status":
              setTurn((current) => ({ ...current, status: "streaming", step: stepOf(frame.data) ?? current.step }));
              break;
            case "token": {
              const text = objectOf(frame.data)?.text;
              if (typeof text === "string") setTurn((current) => ({ ...current, status: "streaming", tokens: current.tokens + text }));
              break;
            }
            case "final":
              outcome.final = objectOf(frame.data);
              setTurn((current) => ({ ...current, status: "done", final: outcome.final }));
              open = false;
              break;
            case "error":
              outcome.error = errorOf(frame.data);
              setTurn((current) => ({ ...current, status: "failed", error: outcome.error }));
              open = false;
              break;
            default:
              break;
          }
        }
      }
      /* The connection dropped after `meta` without a verdict: the row has the turn's state, so the dock asks for it
         again rather than guessing from the tokens it holds (§ 5.9). */
      if (outcome.final === null && outcome.error === null) outcome.error = { code: "ASSISTANT_UNAVAILABLE", message: "" };
    } catch {
      if (outcome.final === null && outcome.error === null) outcome.error = { code: "ASSISTANT_UNAVAILABLE", message: "" };
    } finally {
      reader.releaseLock();
    }
    if (outcome.final === null && outcome.error !== null) setTurn({ ...IDLE, status: "failed", error: outcome.error });
    return outcome;
  }, []);

  return { ...turn, start, abort, reset };
}
