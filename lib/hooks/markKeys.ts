"use client";

import { useEffect, type RefObject } from "react";

/*
 * The bridge between the keyboard map and the marks controls (feature-specs/07 § 9).
 * The map's targets come from a server component and cannot carry callbacks, so
 * `b` and `n` dispatch window events; the visible control (the rail renders
 * twice, one copy hidden per breakpoint) answers.
 */

export const MARK_KEY_EVENTS = { bookmark: "hb:mark-bookmark", note: "hb:mark-note" } as const;

export type MarkKey = keyof typeof MARK_KEY_EVENTS;

export function dispatchMarkKey(kind: MarkKey): void {
  window.dispatchEvent(new CustomEvent(MARK_KEY_EVENTS[kind]));
}

/** Run `handler` on the key's event while the element in `ref` is displayed. */
export function useMarkKey(kind: MarkKey, ref: RefObject<HTMLElement | null>, handler: () => void): void {
  useEffect(() => {
    const onEvent = () => {
      const element = ref.current;
      if (element !== null && element.offsetParent !== null) handler();
    };
    window.addEventListener(MARK_KEY_EVENTS[kind], onEvent);
    return () => window.removeEventListener(MARK_KEY_EVENTS[kind], onEvent);
  }, [kind, ref, handler]);
}
