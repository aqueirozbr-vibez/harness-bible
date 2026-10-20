"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { stepCountsOf, stepLineOf } from "@/lib/research/runBlock";
import type { ResearchStep } from "@/lib/schemas/researcher";

/*
 * A run's live steps (feature-specs/48 § 6, § 11.3; unit 72): a compact ordered list under the line — planning, the
 * sections, each search with its results, each page as it opens, checking, writing — open while the run is under way
 * and folded into `steps · 14` when it ends, the toggle opening it again. Its caption carries the counts that grow
 * during the read (`steps · 3 searches · 4 pages`), so the line's words change once a state. The whole of it is
 * `aria-live="off"` inside the column's log: twenty searches are not twenty announcements, and the list is readable in
 * place (§ 20). The queries, hosts and titles are model and web text, rendered as plain text and wrapping anywhere.
 */

interface RunStepsProps {
  readonly runId: string;
  readonly steps: ReadonlyArray<ResearchStep>;
  readonly underWay: boolean;
}

export function RunSteps({ runId, steps, underWay }: RunStepsProps) {
  const t = useTranslations("research.steps");
  /* open while the run is under way; folded when it ends, as the person may open it again (React's own way to follow a prop) */
  const [open, setOpen] = useState(underWay);
  const [seen, setSeen] = useState(underWay);
  if (seen !== underWay) {
    setSeen(underWay);
    setOpen(underWay);
  }
  if (steps.length === 0) return <div className="run-steps" aria-live="off" />;
  const counts = stepCountsOf(steps);
  const listId = `run-${runId}-steps`;
  return (
    <div className="run-steps" aria-live="off">
      <button type="button" className="run-steps-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((current) => !current)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        {underWay ? t("caption", { s: counts.searches, p: counts.pages }) : t("folded", { n: steps.length })}
      </button>
      <ol id={listId} className="run-steps-list" hidden={!open}>
        {steps.map((step) => {
          const line = stepLineOf(step);
          return <li key={step.seq}>{t(line.key, line.values)}</li>;
        })}
      </ol>
    </div>
  );
}
