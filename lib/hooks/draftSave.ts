"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { dispatchDraftView, onDraftFlush, onDraftStop } from "@/lib/hooks/draftView";
import type { Proposal } from "@/lib/schemas/improve";
import { SuggestionViewSchema, type SuggestionView } from "@/lib/schemas/suggestions";

/*
 * The suggest form's autosave (feature-specs/34 § 5; D3, Andre, 2026-10-07): a change is saved one second after the
 * last keystroke, and at once when a field loses focus, through `PATCH /api/v1/suggestions/{id}`, posted as the
 * create posts, so that the endpoint's role, policy and rate apply. The answer is the draft's view with its class
 * recomputed. The editor, the class panel and the status bar's cell are separate trees, so the save tells the other
 * two through a window event, as the dock tells the status bar (`hb:assistant`).
 *
 * After each save the page is refreshed in the router, as the dock refreshes after its writes: the router keeps the
 * page as it was first loaded for Back and Forward, and a page restored from there would start the fields, and the
 * next save, from a proposal the server no longer holds. The fields keep what they hold; a refresh does not reset them.
 *
 * Since unit 51e the same machine saves the rationale, its own field (`rationale`), and a save's answer goes on to the
 * score column as a fresh view of the draft; `Save draft` asks every field to save at once.
 */

export const DRAFT_SAVE_EVENT = "hb:draft-save";

/** D3: the pause after the last keystroke before a change is saved. */
export const AUTOSAVE_PAUSE_MS = 1000;

/** What a save tells the class panel: the class the server computed for the proposal it now has, and whether recency applies to it. */
export type DraftClass = Pick<SuggestionView, "changeClass" | "curatorReason" | "thresholds" | "fastMoving">;

export type DraftSaveDetail =
  /** A change not yet saved. */
  | { readonly state: "dirty" }
  /** The fields as they stand are what the server already has. */
  | { readonly state: "clean" }
  /** The fields make no proposal, so nothing is sent: the reason is the field's. */
  | { readonly state: "invalid"; readonly message: string }
  | { readonly state: "saving" }
  | { readonly state: "saved"; readonly at: string; readonly draftClass: DraftClass }
  /** `reached`: the server answered, with its reason when it gave one; else the request did not reach it. */
  | { readonly state: "failed"; readonly reached: boolean; readonly message: string | null; readonly traceId: string | null };

/** A save's state as the page hears it: with the field it is of, so that Submit can wait for each (unit 51e). */
export type DraftSaveEvent = DraftSaveDetail & { readonly field?: DraftField };

export function dispatchDraftSave(detail: DraftSaveEvent): void {
  window.dispatchEvent(new CustomEvent<DraftSaveEvent>(DRAFT_SAVE_EVENT, { detail }));
}

/** Listen for the saves of the draft on this page; the returned function stops listening. */
export function onDraftSave(listener: (detail: DraftSaveEvent) => void): () => void {
  const handle = (event: Event): void => listener((event as CustomEvent<DraftSaveEvent>).detail);
  window.addEventListener(DRAFT_SAVE_EVENT, handle);
  return () => window.removeEventListener(DRAFT_SAVE_EVENT, handle);
}

/** What a machine saves: the proposal (each editor) or the rationale (step 4). */
export type DraftField = "proposal" | "rationale";

export interface DraftAutosave {
  /** Every edit: what the field makes — the proposal, or the rationale's text — or why it makes none. */
  readonly change: (value: Proposal | string | null, problem: string | null) => void;
  /** A field lost focus: save now what is not saved. */
  readonly flush: () => void;
  /** The page is going away: send what is not saved with `keepalive`, and wait for no answer. */
  readonly leave: () => void;
  /** The draft is gone (45 § 4): nothing more is sent, and a request still out says nothing when it answers. */
  readonly halt: () => void;
}

export interface DraftAutosaveDeps {
  /** The `PATCH` of one body; `keepalive` when the page is going away. */
  readonly send: (body: string, keepalive: boolean) => Promise<Response>;
  readonly dispatch: (detail: DraftSaveDetail) => void;
  readonly now: () => Date;
  /** A save's answer, the draft as the server now holds it, for whoever draws it. */
  readonly view?: (payload: unknown) => void;
}

/**
 * The autosave's state, outside React so that one exists per page and its timer and request outlive renders.
 *
 * One request at a time. A change made while one is out is compared with what the server will hold once it returns,
 * and is sent then: when its pause is over, or at once if the pause ended while the request was out. A proposal the
 * server already has is not sent again. A failed save is not tried again by itself, so a refusal is not repeated
 * every second; the next edit or blur tries again.
 *
 * Fields that make no proposal send nothing. They say so after the same pause, or on blur, rather than at every
 * keystroke of a value still being typed (`0.` on the way to `0.25`).
 */
export function createDraftAutosave(saved: Proposal | string | null, deps: DraftAutosaveDeps, field: DraftField = "proposal"): DraftAutosave {
  const bodyOf = (value: Proposal | string): string => JSON.stringify({ [field]: value });
  /** The body the server has: the field as loaded, then each one saved. */
  let sent = saved === null ? null : bodyOf(saved);
  /** The body of the request that is out; null while none is. */
  let flying: string | null = null;
  /** The body the fields make now; null while they make none. */
  let pending: string | null = null;
  /** Why the fields make no proposal now; null while they make one. */
  let problemNow: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let halted = false;

  const stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flush = (): void => {
    stop();
    if (halted) return;
    const body = pending;
    if (body === null) {
      if (problemNow !== null) deps.dispatch({ state: "invalid", message: problemNow });
      return;
    }
    /* The request that is out looks again when it returns. */
    if (flying !== null) return;
    if (body === sent) {
      deps.dispatch({ state: "clean" });
      return;
    }
    flying = body;
    deps.dispatch({ state: "saving" });
    void (async () => {
      let saved = false;
      try {
        const response = await deps.send(body, false);
        const payload = (await response.json().catch(() => null)) as (Partial<SuggestionView> & { message?: unknown; traceId?: unknown }) | null;
        /* the draft went while this was out: nothing is said of it (45 § 4) */
        if (halted) return;
        if (response.ok && payload !== null && payload.changeClass !== undefined && payload.thresholds !== undefined) {
          sent = body;
          saved = true;
          /* The fields moved on while it was out: they are not saved as they stand, so no `saved` is said for them —
             Submit waits for every field's `saved`, and would otherwise send what the server has, not what the page
             shows (34 § 26). The newer body's own save says it, below. */
          if (pending === null || pending === body) deps.dispatch({ state: "saved", at: deps.now().toISOString(), draftClass: { changeClass: payload.changeClass, curatorReason: payload.curatorReason ?? null, thresholds: payload.thresholds, fastMoving: payload.fastMoving === true } });
          deps.view?.(payload);
        } else {
          deps.dispatch({ state: "failed", reached: true, message: typeof payload?.message === "string" ? payload.message : null, traceId: typeof payload?.traceId === "string" ? payload.traceId : null });
        }
      } catch {
        if (halted) return;
        deps.dispatch({ state: "failed", reached: false, message: null, traceId: null });
      }
      flying = null;
      /* The fields moved on while the request was out: theirs is the status, and theirs the next save. */
      if (pending !== null && pending !== sent && pending !== body) {
        if (timer === null) flush();
        else if (saved) deps.dispatch({ state: "dirty" });
      } else if (saved && pending === null && problemNow !== null) {
        deps.dispatch({ state: "invalid", message: problemNow });
      }
    })();
  };

  const change = (value: Proposal | string | null, problem: string | null): void => {
    stop();
    if (halted) return;
    pending = value === null || problem !== null ? null : bodyOf(value);
    problemNow = pending === null ? (problem ?? "") : null;
    if (pending !== null && pending === (flying ?? sent)) {
      deps.dispatch({ state: flying === null ? "clean" : "saving" });
      return;
    }
    deps.dispatch({ state: "dirty" });
    timer = setTimeout(flush, AUTOSAVE_PAUSE_MS);
  };

  const leave = (): void => {
    if (halted) return;
    const body = pending;
    if (body === null || body === (flying ?? sent)) return;
    stop();
    /* A request still out may reach the server after this one: the fields' last state is sent all the same (34 § 19). */
    void deps.send(body, true).catch(() => undefined);
  };

  const halt = (): void => {
    halted = true;
    stop();
    pending = null;
    problemNow = null;
  };

  return { change, flush, leave, halt };
}

/**
 * A field's side of the autosave: one per mounted editor, and one for the rationale, which sends what is unsaved when
 * the page goes away and at once when `Save draft` asks.
 */
export function useDraftAutosave(id: string, saved: Proposal | string | null, field: DraftField = "proposal"): DraftAutosave {
  const router = useRouter();
  const [autosave] = useState(() =>
    createDraftAutosave(
      saved,
      {
        send: (body, keepalive) => fetch(`/api/v1/suggestions/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body, keepalive }),
        dispatch: (detail) => {
          dispatchDraftSave({ ...detail, field });
          if (detail.state === "saved") router.refresh();
        },
        now: () => new Date(),
        view: (payload) => {
          const view = SuggestionViewSchema.safeParse(payload);
          if (view.success) dispatchDraftView(view.data);
        },
      },
      field,
    ),
  );
  useEffect(() => {
    window.addEventListener("pagehide", autosave.leave);
    const unflush = onDraftFlush(autosave.flush);
    const unstop = onDraftStop(autosave.halt);
    return () => {
      window.removeEventListener("pagehide", autosave.leave);
      unflush();
      unstop();
      autosave.leave();
    };
  }, [autosave]);
  return autosave;
}
