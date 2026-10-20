"use client";

import { useEffect, useState } from "react";

/** Name of the window event that carries a short status line (`copied`) for the status bar. */
export const STATUS_EVENT = "hb:status";

const HOLD_MS = 3000;

/** A status-bar cell that shows a transient line for three seconds. A line in the bar, never a toast (ui-context § 11). */
export function StatusNote() {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let timer: number | null = null;
    const onStatus = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setText(detail);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setText(null), HOLD_MS);
    };
    window.addEventListener(STATUS_EVENT, onStatus);
    return () => {
      window.removeEventListener(STATUS_EVENT, onStatus);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  if (text === null) return null;
  return (
    <span role="status" className="statusnote">
      {text}
    </span>
  );
}
