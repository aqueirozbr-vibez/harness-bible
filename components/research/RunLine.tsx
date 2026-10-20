"use client";

import { useTranslations } from "next-intl";

import { StatusMark } from "@/components/ui/StatusMark";
import { formatDayMonth } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { runLinePartsOf } from "@/lib/research/runBlock";
import type { ResearchRunView } from "@/lib/schemas/api";

/*
 * A research run's line (feature-specs/48 § 11.3, § 18, § 20; unit 72): the existing `.research-line` form — `research
 * ·` then the state's word as a lower-case status mark (`.st.st-plain`, a word and a shape, never colour alone, the
 * caret while the run is under way) and its detail, after a `·` or joined to the word as its object (`reading the
 * web`). Its words change once a state and never once a poll: the counts that grow during the read are the steps'
 * caption's. It is atomic, so a change is read whole, and has no live role of its own, since the column's log is one.
 * A run the page stopped following after 90 minutes reads `still under way · reload to follow` (§ 6).
 */

interface RunLineProps {
  readonly run: ResearchRunView;
  readonly locale: Locale;
  /** The follow gave up at its bound with the run still under way. */
  readonly lost: boolean;
}

export function RunLine({ run, locale, lost }: RunLineProps) {
  const t = useTranslations("research.line");
  const parts = runLinePartsOf(run);
  const sep = (
    <span className="sep" aria-hidden="true">
      ·
    </span>
  );
  const detail = parts.detail;
  return (
    <div className="inst-f research-line" aria-atomic="true" data-line={run.line.key}>
      <span className="research-label">{t("label")}</span>
      {sep}
      <StatusMark tone={parts.tone} caret={parts.tone === "run" && !lost} className="st-plain">
        {t(`word.${parts.word}`)}
      </StatusMark>
      {lost ? (
        <>
          {sep}
          <span>{t("followLost")}</span>
        </>
      ) : detail === null ? null : (
        <>
          {detail.joined ? null : sep}
          <span>{t(`detail.${detail.key}`, { ...detail.values, date: detail.date === null ? "" : formatDayMonth(new Date(detail.date), locale) })}</span>
        </>
      )}
    </div>
  );
}
