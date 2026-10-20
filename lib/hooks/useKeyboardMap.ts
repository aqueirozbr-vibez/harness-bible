"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { dispatchMarkKey } from "@/lib/hooks/markKeys";

/*
 * The global keyboard map (ui-context § 12, feature-specs/03 § 9).
 * resolveKeyAction is pure and unit-tested; the hook wires it to the window.
 */

export type KeyAction = "next" | "prev" | "prevChapter" | "nextChapter" | "lab" | "ask" | "research" | "search" | "help" | "escape" | "bookmark" | "note";

export interface KeyTargets {
  readonly next: string | null;
  readonly prev: string | null;
  readonly nextChapter: string | null;
  readonly prevChapter: string | null;
  readonly lab: string | null;
}

export interface KeyState {
  /** `g` was pressed and `l` may follow. */
  readonly pendingG: boolean;
}

export interface KeyResolution {
  readonly action: KeyAction | null;
  readonly state: KeyState;
}

/** Storage key of the per-viewer preference that turns single-key shortcuts off. */
export const KEYS_PREFERENCE = "hb.keys";

/**
 * Decide what a key press does. Shortcuts never fire with a modifier held,
 * while focus is in a field (except `esc`), or when the viewer turned them off.
 */
export function resolveKeyAction(
  key: string,
  state: KeyState,
  context: { readonly inField: boolean; readonly disabled: boolean; readonly modifier: boolean },
): KeyResolution {
  const idle: KeyState = { pendingG: false };
  if (key === "Escape") return { action: "escape", state: idle };
  if (context.disabled || context.inField || context.modifier) return { action: null, state: idle };
  if (state.pendingG) {
    return { action: key === "l" ? "lab" : null, state: idle };
  }
  switch (key) {
    case "j":
      return { action: "next", state: idle };
    case "k":
      return { action: "prev", state: idle };
    case "[":
      return { action: "prevChapter", state: idle };
    case "]":
      return { action: "nextChapter", state: idle };
    case "g":
      return { action: null, state: { pendingG: true } };
    case "a":
      return { action: "ask", state: idle };
    /* the Research dock's key (feature-specs/48 § 12, D4), with `a`'s guards above: no modifier, not in a field, not after `g` */
    case "r":
      return { action: "research", state: idle };
    case "b":
      return { action: "bookmark", state: idle };
    case "n":
      return { action: "note", state: idle };
    case "/":
      return { action: "search", state: idle };
    case "?":
      return { action: "help", state: idle };
    default:
      return { action: null, state: idle };
  }
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function shortcutsDisabled(): boolean {
  try {
    return window.localStorage.getItem(KEYS_PREFERENCE) === "off";
  } catch {
    return false;
  }
}

/** Mount once per page; returns the help-dialog state for the KeyboardMap component. */
export function useKeyboardMap(targets: KeyTargets): { readonly helpOpen: boolean; readonly closeHelp: () => void } {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  useEffect(() => {
    let state: KeyState = { pendingG: false };
    let pendingTimer: number | null = null;
    const disabled = shortcutsDisabled();

    const go = (href: string | null) => {
      if (href !== null) router.push(href);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const { action, state: nextState } = resolveKeyAction(event.key, state, {
        inField: isEditableTarget(event.target),
        disabled,
        modifier: event.ctrlKey || event.metaKey || event.altKey,
      });
      state = nextState;
      if (pendingTimer !== null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (state.pendingG) {
        pendingTimer = window.setTimeout(() => {
          state = { pendingG: false };
        }, 1000);
      }
      if (action === null) return;
      switch (action) {
        case "next":
          go(targets.next);
          break;
        case "prev":
          go(targets.prev);
          break;
        case "nextChapter":
          go(targets.nextChapter);
          break;
        case "prevChapter":
          go(targets.prevChapter);
          break;
        case "lab":
          go(targets.lab);
          break;
        case "ask":
        case "research":
          /* `a` is the assistant's on every page, and `AskShortcut` owns it (feature-specs/24 § 6.1); `r` is the Research
             dock's, and `ResearchShortcut` owns it (feature-specs/48 § 12): this map resolves both keys, so each owner
             agrees with it on when a key counts, and leaves the act to the one owner. */
          break;
        case "search": {
          const input = document.querySelector<HTMLInputElement>(".searchbox-input");
          if (input !== null) {
            event.preventDefault();
            input.focus();
          }
          break;
        }
        case "help":
          event.preventDefault();
          setHelpOpen((open) => !open);
          break;
        case "escape":
          setHelpOpen(false);
          break;
        case "bookmark":
        case "note":
          /* Answered by the visible marks control when the reader is signed in (feature-specs/07 § 9). */
          dispatchMarkKey(action);
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);
    };
  }, [router, targets]);

  return { helpOpen, closeHelp };
}
