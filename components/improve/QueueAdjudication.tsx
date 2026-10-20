import { useTranslations } from "next-intl";

import { StatusMark } from "@/components/ui/StatusMark";
import { formatDateTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { SuggestionView } from "@/lib/schemas/suggestions";

interface QueueAdjudicationProps {
  readonly locale: Locale;
  readonly view: SuggestionView;
}

const TONE = { PASS: "ok", FAIL: "fail", WARN: "warn", NA: "mute" } as const;

/**
 * The detail's Adjudication (feature-specs/36 § 4; the Curator-Queue screen): the sensors' verdicts beside the
 * criteria's reasons, and the evidence that was named as sufficient. Absent for a curator-always change, which no
 * adjudicator saw; a decision by rule is said to be the rules'.
 */
export function QueueAdjudication({ locale, view }: QueueAdjudicationProps) {
  const t = useTranslations("improve.queue.adjudication");
  const ts = useTranslations("improve.outcome.sensors");
  const tq = useTranslations("improve.outcome.reasons.name");
  const decision = view.adjudication;
  if (view.changeClass === "CURATOR_ALWAYS" || (decision === null && view.sensors.length === 0)) return null;
  const by = decision === null ? null : decision.decidedBy === "adjudicator" ? t("byAdjudicator", { guide: decision.guideVersion ?? "—" }) : t(decision.decidedBy === "router" ? "byRouter" : "byRules");
  return (
    <section className="inst" aria-labelledby="queue-adjudication-title">
      <div className="inst-h">
        <h2 className="t" id="queue-adjudication-title">
          {t("title")}
        </h2>
        {by !== null ? (
          <>
            <span className="sep">·</span>
            <span>{by}</span>
          </>
        ) : null}
        {decision !== null ? <span className="ts">{formatDateTime(new Date(decision.decidedAt), locale)}</span> : null}
      </div>
      <div className="inst-b queue-adjudication">
        <ul className="col queue-adjudication-list" aria-label={t("sensors")}>
          {view.sensors.map((verdict) => (
            <li key={verdict.sensor} className="between small">
              <span className="mono faint">{ts(`name.${verdict.sensor}`)}</span>
              <StatusMark tone={TONE[verdict.result]}>{ts(`result.${verdict.result}`)}</StatusMark>
            </li>
          ))}
        </ul>
        <ul className="col small queue-adjudication-list" aria-label={t("criteria")}>
          {(decision?.criteria ?? []).map((line) => (
            <li key={line.criterion}>
              <span className="mono faint">{tq(line.criterion)}</span> {line.reason ?? line.verdict}
            </li>
          ))}
        </ul>
      </div>
      {decision !== null && decision.sufficientTier !== null ? <div className="inst-f">{t("sufficient", { tier: decision.sufficientTier })}</div> : null}
    </section>
  );
}
