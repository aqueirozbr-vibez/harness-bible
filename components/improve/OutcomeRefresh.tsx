"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { EVIDENCE_POLL_MS } from "@/lib/improve/evidenceView";
import { refreshKeyOf } from "@/lib/improve/outcomeView";

interface OutcomeRefreshProps {
  /** The suggestion the page shows. */
  readonly id: string;
  /** Its state, its decision's time and its merge's last check as the page was drawn (`refreshKeyOf`): a read that differs redraws it. */
  readonly drawn: string;
  /** How long to keep reading; unbounded when absent. */
  readonly forMs?: number;
}

/**
 * While a suggestion is in progress, its page reads it again at the suggest form's interval (34 D2, 2 s; spec 35 § 4)
 * and redraws itself, from the server, once its state or its decision has moved. A hidden tab is not read. It draws
 * nothing of its own. Where the suggestion waits on its owner, it reads for a minute only: long enough to see a
 * revision just sent taken up by the workflow, which moves it back to `SUBMITTED` (33 § 6.4).
 */
export function OutcomeRefresh({ id, drawn, forMs }: OutcomeRefreshProps) {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const until = forMs === undefined ? null : performance.now() + forMs;
    const tick = async (): Promise<void> => {
      timer = null;
      if (until !== null && performance.now() > until) return;
      if (document.visibilityState !== "hidden") {
        try {
          const response = await fetch(`/api/v1/suggestions/${encodeURIComponent(id)}`, { cache: "no-store" });
          if (response.ok) {
            const view = (await response.json()) as { state?: unknown; adjudication?: { decidedAt?: unknown } | null; budgetResetsAt?: unknown; withdrawnAt?: unknown; merge?: { check?: { at?: unknown } | null; releaseTo?: unknown; mergedAt?: unknown } | null };
            const checkedAt = view.merge?.check?.at;
            const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
            const merge = view.merge === null || view.merge === undefined ? null : { check: typeof checkedAt === "string" ? { at: checkedAt } : null, releaseTo: text(view.merge.releaseTo), mergedAt: text(view.merge.mergedAt) };
            const key = refreshKeyOf({ state: String(view.state), adjudication: typeof view.adjudication?.decidedAt === "string" ? { decidedAt: view.adjudication.decidedAt } : null, budgetResetsAt: typeof view.budgetResetsAt === "string" ? view.budgetResetsAt : null, merge, withdrawnAt: text(view.withdrawnAt) });
            if (key !== drawn) {
              router.refresh();
              return;
            }
          }
        } catch {
          /* the next read is two seconds away */
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), EVIDENCE_POLL_MS);
    };
    timer = setTimeout(() => void tick(), EVIDENCE_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [id, drawn, forMs, router]);
  return null;
}
