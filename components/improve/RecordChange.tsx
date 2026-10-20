import { useTranslations } from "next-intl";

import { changeOf } from "@/lib/improve/outcomeView";
import type { SuggestionView } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

interface RecordChangeProps {
  readonly view: SuggestionView;
  /** The chapter's version the anchor is read at. */
  readonly version: string;
}

/**
 * The record's Change (feature-specs/35 § 5; the Improve-Record screen): where it is anchored and at which version,
 * the anchored text, the value or text before struck through and the proposed one after, and the class. The anchored
 * text, the before and the after are the book's English, which the anchor holds whichever edition the page serves,
 * and are marked so on a PT page (the 52c review).
 */
export function RecordChange({ view, version }: RecordChangeProps) {
  const t = useTranslations("improve.record.change");
  const tc = useTranslations("rubric.thresholds.class");
  const change = changeOf(view);
  const value = view.proposal?.kind === "SET_VALUE";
  const where = view.anchor.kind === "FIGURE" ? `${view.anchor.section} ${view.anchor.id}` : view.anchor.id;
  return (
    <section className="inst" aria-labelledby="record-change-title">
      <div className="inst-h">
        <h2 className="t" id="record-change-title">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{where}</span>
        <span className="ts">{version}</span>
      </div>
      <div className="inst-b col record-panel-body">
        {/* A passage's quote is its before: said once. */}
        {change.quote !== change.before ? (
          <p className="small record-quote" lang="en">
            {change.quote}
          </p>
        ) : null}
        {change.after !== null ? (
          <dl className="col record-change">
            {change.before !== null ? (
              <div className="row record-change-row">
                <dt className="cap">{t("before")}</dt>
                <dd className={cn("record-was", value ? "mono record-value" : "small")} lang="en">
                  {change.before}
                </dd>
              </div>
            ) : null}
            <div className="row record-change-row">
              <dt className="cap">{t("after")}</dt>
              <dd className={cn("d-new record-now", value ? "mono record-value" : "small")} lang="en">
                {change.after}
              </dd>
            </div>
          </dl>
        ) : null}
        <p className="help">{t("class", { name: tc(view.changeClass) })}</p>
      </div>
    </section>
  );
}
