"use client";

import { useEffect } from "react";

/*
 * Records a section view once (feature-specs/05 § 5.3, D7): after DWELL_MS on
 * the page, or when the reader leaves the section first. The action's result
 * is ignored; a failed write is retried by the next view. `record` is a server
 * action reference, stable across renders. A section sent within REPEAT_MS is
 * not sent again, so a router refresh that remounts the reader records nothing.
 */

export const DWELL_MS = 15_000;
export const REPEAT_MS = 60_000;

type Record = (input: { sectionId: string; locale: string }) => Promise<unknown>;

const lastSent = new Map<string, number>();

export function useReadingProgress(sectionId: string, locale: string, record: Record, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      const now = Date.now();
      const previous = lastSent.get(sectionId);
      if (previous !== undefined && now - previous < REPEAT_MS) return;
      lastSent.set(sectionId, now);
      void record({ sectionId, locale }).catch(() => undefined);
    };
    const timer = window.setTimeout(send, DWELL_MS);
    return () => {
      window.clearTimeout(timer);
      send();
    };
  }, [sectionId, locale, record, enabled]);
}
