/*
 * Where the focus goes back to when the Research dock closes (feature-specs/48 § 12, "as the Assistant's"; spec 24 § 9:
 * "`esc` closes it and returns focus to where it was when `a` was pressed"). The dock is opened by a navigation —
 * `r` pushes the page's URL with `research=1`, and the slot renders the dock — so nothing in the dock's own tree saw the
 * focus before its composer took it: the key's owner remembers the element, and the dock's close gives it back when it is
 * still on the page. Opened by a link or a load, there is nothing to remember, and the focus stays where the close
 * leaves it.
 *
 * Module state, browser-only: one dock is open at a time, and one tab is one module.
 */

let opener: HTMLElement | null = null;

/** The key's owner, before it opens the dock: the element that has the focus, unless that is the page itself. */
export function rememberDockOpener(): void {
  const active = document.activeElement;
  opener = active instanceof HTMLElement && active !== document.body ? active : null;
}

/** The dock's close: the focus back on what had it when the key opened the dock, once, if it is still on the page. */
export function returnDockFocus(): void {
  const element = opener;
  opener = null;
  if (element !== null && element.isConnected) element.focus();
}
