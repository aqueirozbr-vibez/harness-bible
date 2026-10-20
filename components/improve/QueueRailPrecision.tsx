import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusMark } from "@/components/ui/StatusMark";
import { formatNumber, formatPercent } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { shortHash } from "@/lib/improve/outcomeView";
import type { QueueCalibration } from "@/lib/db/queuePage";
import type { CalibrationReading, CurationMetrics } from "@/lib/schemas/curation";
import type { StatusTone } from "@/lib/schemas/domain";

interface QueueRailPrecisionProps {
  readonly locale: Locale;
  readonly quarter: string;
  readonly precision: CalibrationReading["precision"];
  readonly lines: CurationMetrics["lines"];
  readonly rubric: QueueCalibration["rubric"];
}

type Zone = "none" | "within" | "over";
const TONE: Readonly<Record<Zone, StatusTone>> = { none: "mute", within: "ok", over: "fail" };

/**
 * Adjudication precision (36 § 6.4; the Curator-Queue screen): the share of the adjudicator's accepts a curator later
 * reverted, whether it is within its target, its counts and the target; and the footer's link to the public rubric
 * with its hash. Under the minimum, a dash and the counts. The monthly tier-B sample's row is 53e's.
 */
export function QueueRailPrecision({ locale, quarter, precision, lines, rubric }: QueueRailPrecisionProps) {
  const t = useTranslations("improve.queue.rail.precision");
  const zone: Zone = precision.rate === null ? "none" : precision.rate < lines.precisionTarget ? "within" : "over";
  return (
    <section className="inst" aria-labelledby="queue-rail-precision">
      <div className="inst-h">
        <h2 className="t" id="queue-rail-precision">
          {t("title")}
        </h2>
        <span className="ts">{quarter}</span>
      </div>
      <div className="inst-b col queue-rail-body">
        <div className="between queue-rail-reading">
          <span className="midnum">{precision.rate === null ? "—" : t("rate", { pct: formatPercent(precision.rate * 100, locale) })}</span>
          <StatusMark tone={TONE[zone]}>{t(`status.${zone}`)}</StatusMark>
        </div>
        <dl className="kv queue-rail-kv">
          <dt>{t("reverted")}</dt>
          <dd>{t("counts", { n: precision.reverted, of: precision.accepted })}</dd>
          <dt>{t("target")}</dt>
          <dd>{t("targetValue", { pct: formatNumber(lines.precisionTarget * 100, locale) })}</dd>
        </dl>
      </div>
      {rubric !== null ? (
        <div className="inst-f queue-rail-foot">
          <Link className="xref" href={`/${locale}/rubric`}>
            {t("rubric", { version: rubric.version })}
          </Link>
          <span className="tex">#{shortHash(rubric.sha256)}</span>
        </div>
      ) : null}
    </section>
  );
}
