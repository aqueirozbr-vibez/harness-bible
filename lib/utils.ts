import { clsx, type ClassValue } from "clsx";

/**
 * Merge class names. Accepts strings, arrays, and `{ class: boolean }` maps,
 * drops falsy values, and joins the rest.
 *
 * Order in JSX: hb.css role classes first, then layout utilities, then state
 * classes (code-standards § Styling). Utilities in this project are layout-only,
 * so no Tailwind conflict resolution is needed; if two spacing utilities ever
 * collide, fix the caller rather than adding a merge library.
 */
export function cn(...inputs: ReadonlyArray<ClassValue>): string {
  return clsx(inputs);
}
