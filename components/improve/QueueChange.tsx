import { useTranslations } from "next-intl";

import { changeOf } from "@/lib/improve/outcomeView";
import type { SuggestionView } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

interface QueueChangeProps {
  readonly view: SuggestionView;
}

/**
 * The detail's Change (feature-specs/36 § 4; the Curator-Queue screen): where it is anchored, its class and thresholds,
 * and the current text or value beside the proposed one — struck through, an arrow, then the new. Both are the book's
 * English, which the anchor holds whichever edition the page serves, and are marked so (the 52c review).
 */
export function QueueChange({ view }: QueueChangeProps) {
  const t = useTranslations("improve.queue.change");
  const tc = useTranslations("rubric.thresholds.class");
  const change = changeOf(view);
  const value = view.proposal?.kind === "SET_VALUE";
  const where = view.anchor.kind === "FIGURE" ? `${view.anchor.section} ${view.anchor.id}` : view.anchor.id;
  const { acceptAt, floorAt } = view.thresholds;
  return (
    <section className="inst" aria-labelledby="queue-change-title">
      <div className="inst-h">
        <h2 className="t" id="queue-change-title">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{where}</span>
        <span className="sep">·</span>
        <span>{tc(view.changeClass)}</span>
        {acceptAt !== null && floorAt !== null ? <span className="ts">{t("thresholds", { accept: acceptAt, floor: floorAt })}</span> : null}
      </div>
      <div className="inst-b queue-change">
        <div className="col queue-change-side">
          <span className="cap">{t("current", { where })}</span>
          {change.quote !== change.before ? (
            <span className="small" lang="en">
              {change.quote}
            </span>
          ) : null}
          {change.before !== null ? (
            <span className={cn("queue-was", value ? "mono queue-value" : "small")} lang="en">
              {change.before}
            </span>
          ) : null}
        </div>
        <span className="mono faint" aria-hidden="true">
          →
        </span>
        <div className="col queue-change-side">
          <span className="cap">{t("proposed")}</span>
          <span className={cn("d-new queue-now", value ? "mono queue-value" : "small")} lang={change.after === null ? undefined : "en"}>
            {change.after ?? "—"}
          </span>
        </div>
      </div>
    </section>
  );
}
