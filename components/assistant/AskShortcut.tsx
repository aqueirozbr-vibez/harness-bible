"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { isEditableTarget, resolveKeyAction, shortcutsDisabled, type KeyState } from "@/lib/hooks/useKeyboardMap";
import { openDockHref, otherDockClosedHref } from "@/lib/research/links";

/*
 * `a` on every page (feature-specs/24 § 6.1). The key has one owner: with the Assistant's dock on the page it moves
 * focus into it, and without one it opens the dock where the reader is, by adding `ask=1` to the URL they are on. The
 * dock is found by `data-dock="assistant"`, since the Research page's column carries `.dock` as well (feature-specs/48
 * § 12): on that page `a` opens the Assistant's dock over it and leaves the research composer alone. The guards are
 * the keyboard map's own (`resolveKeyAction`: no modifier, not while typing, not after `g`), so the key behaves the
 * same on a page that mounts the map and on one that does not.
 *
 * Since unit 77 the Research dock is on every page too, and one dock is open at a time (48 § 12): opening the
 * Assistant's drops `research` from the URL unless the path is `/research`, whose own research it is, so the Assistant
 * takes the Research dock's place; on `/research` it opens over the page, which keeps its research. On `/assistant`,
 * whose column is the Assistant's own, `a` with the Research dock over the page focuses the column and closes the dock.
 */

/** How long a `g` waits for its second key, as the keyboard map waits. */
const PENDING_MS = 1000;

export function AskShortcut() {
  const router = useRouter();

  useEffect(() => {
    let state: KeyState = { pendingG: false };
    let pendingTimer: number | null = null;
    const disabled = shortcutsDisabled();

    const onKeyDown = (event: KeyboardEvent): void => {
      const resolved = resolveKeyAction(event.key, state, {
        inField: isEditableTarget(event.target),
        disabled,
        modifier: event.ctrlKey || event.metaKey || event.altKey,
      });
      state = resolved.state;
      if (pendingTimer !== null) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (state.pendingG) {
        pendingTimer = window.setTimeout(() => {
          state = { pendingG: false };
        }, PENDING_MS);
      }
      if (resolved.action !== "ask") return;
      /* an open modal dialog owns the keyboard (the review of unit 77): ‘a’ must not move the focus out of it, nor swap a dock
         away while a confirmed request is out, so that its answer never lands behind a closed dialog (feature-specs/45 § 20) */
      if (document.querySelector("[aria-modal='true']") !== null) return;

      event.preventDefault();
      const here = `${window.location.pathname}${window.location.search}`;
      /* the Assistant's own dock: the Research page's column is a `.dock` too, and `a` never writes into it (feature-specs/48 § 12) */
      const dock = document.querySelector<HTMLElement>('.dock[data-dock="assistant"]');
      if (dock !== null) {
        /* An open dock: `a` is "write the question", not "open it again". A walk has no ask box, so its form takes the focus. */
        const field = dock.querySelector<HTMLElement>(".dock-textarea") ?? dock.querySelector<HTMLElement>("form select, form input");
        field?.focus();
        /* the Assistant page's column under the Research dock: the dock goes, and the column is in front (48 § 12) */
        const closed = otherDockClosedHref(here, "assistant");
        if (closed !== null) router.push(closed, { scroll: false });
        return;
      }
      /* `ask` and `draft` afresh, and `research` dropped but on the Research page (48 § 12) */
      router.push(openDockHref(here, "assistant"), { scroll: false });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);
    };
  }, [router]);

  return null;
}
