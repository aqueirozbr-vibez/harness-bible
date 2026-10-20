"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { rememberDockOpener } from "@/lib/hooks/dockOpener";
import { isEditableTarget, resolveKeyAction, shortcutsDisabled, type KeyState } from "@/lib/hooks/useKeyboardMap";
import { openDockHref, otherDockClosedHref } from "@/lib/research/links";

/*
 * `r` on every page (feature-specs/48 § 12, D4; unit 77), `AskShortcut`'s pattern for the Research dock. The key has
 * one owner: with research's column on the page — the Research dock, or the Research page's own column — it moves the
 * focus into its question; without one it opens the dock where the person is, by adding `research=1` to the URL they
 * are on. The column is found by `data-dock="research"`, never by `.dock`, which the Assistant's dock carries as well, so
 * `r` never writes into the Assistant's ask box (§ 20).
 *
 * One dock at a time (§ 12): opening the Research dock drops `ask` and `draft` unless the path is `/assistant`, whose own
 * conversation they are — there it opens over the page, which keeps its conversation — and touches nothing else (no key
 * drops `from`). On `/research`, whose column is research's own, `r` with the Assistant's dock over the page focuses the
 * column and closes that dock, so research is in front again.
 *
 * The guards are the keyboard map's own (`resolveKeyAction`: no modifier, not while typing, not after `g`), so `r`
 * behaves as `a` does on a page that mounts the map and on one that does not. Before it opens the dock it remembers what
 * had the focus, which the dock's close gives it back (`lib/hooks/dockOpener.ts`).
 */

/** How long a `g` waits for its second key, as the keyboard map waits. */
const PENDING_MS = 1000;

export function ResearchShortcut() {
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
      if (resolved.action !== "research") return;
      /* an open modal dialog owns the keyboard (the review of unit 77): ‘r’ must not move the focus out of it, nor swap a dock
         away while a confirmed request is out, so that its answer never lands behind a closed dialog (feature-specs/45 § 20) */
      if (document.querySelector("[aria-modal='true']") !== null) return;

      event.preventDefault();
      const here = `${window.location.pathname}${window.location.search}`;
      const column = document.querySelector<HTMLElement>('.dock[data-dock="research"]');
      if (column !== null) {
        /* research on the page: `r` is "write the question", not "open it again" */
        column.querySelector<HTMLElement>(".dock-textarea")?.focus();
        /* the Research page's column under the Assistant's dock: the dock goes, and the column is in front (§ 12) */
        const closed = otherDockClosedHref(here, "research");
        if (closed !== null) router.push(closed, { scroll: false });
        return;
      }
      rememberDockOpener();
      router.push(openDockHref(here, "research"), { scroll: false });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);
    };
  }, [router]);

  return null;
}
