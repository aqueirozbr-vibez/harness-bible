import { useTranslations } from "next-intl";

import { formatNumber, formatPercent } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { CalibrationReading, CurationMetrics } from "@/lib/schemas/curation";
import { cn } from "@/lib/utils";

interface QueueRailOverrideProps {
  readonly locale: Locale;
  readonly quarter: string;
  readonly reading: CalibrationReading["overrideRate"];
  readonly reviews: CurationMetrics["quarters"][number]["reviews"];
  readonly lines: CurationMetrics["lines"];
}

/** The bars' scale, the screen's: 0 to 25 %. */
const SCALE = 0.25;
const at = (rate: number): string => `${String(Math.min(rate / SCALE, 1) * 100)}%`;

/**
 * The override rate per criterion (36 § 6.4; the Curator-Queue screen): the legend — target 10 %, review 20 %, the
 * scale — then each criterion of the rubric with its overrides of the quarter's reviewed decisions, its rate and its
 * bar. A criterion past the review line is marked, and where its rate opened a rubric review, the review's id (§ 6.3).
 */
export function QueueRailOverride({ locale, quarter, reading, reviews, lines }: QueueRailOverrideProps) {
  const t = useTranslations("improve.queue.rail.override");
  const tc = useTranslations("improve.outcome.reasons.name");
  const whole = (rate: number): string => formatNumber(rate * 100, locale);
  return (
    <section className="inst" aria-labelledby="queue-rail-override">
      <div className="inst-h">
        <h2 className="t" id="queue-rail-override">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{t("cap")}</span>
        <span className="ts">{quarter}</span>
      </div>
      <div className="inst-b col queue-rail-body">
        <div className="row meta queue-rail-legend">
          <span className="row queue-rail-key">
            <i aria-hidden="true" />
            {t("target", { pct: whole(lines.overrideTarget) })}
          </span>
          <span className="row queue-rail-key is-review">
            <i aria-hidden="true" />
            {t("review", { pct: whole(lines.overrideReview) })}
          </span>
          <span className="faint">{t("scale", { pct: whole(SCALE) })}</span>
        </div>
        {reading.criteria.map((entry) => {
          const review = reviews.find((candidate) => candidate.criterion === entry.criterion) ?? null;
          const past = review !== null || (entry.rate !== null && entry.rate > lines.overrideReview);
          return (
            <div key={entry.criterion} className={cn("col queue-rail-row", past && "is-review")}>
              <div className="between small">
                <span className="queue-rail-name">
                  {tc(entry.criterion)} <span className="meta">{t("counts", { n: entry.overridden, of: reading.reviewed })}</span>
                </span>
                <span className="score">{entry.rate === null ? "—" : t("rate", { pct: formatPercent(entry.rate * 100, locale) })}</span>
              </div>
              <div className="queue-rail-bar" aria-hidden="true">
                {entry.rate !== null ? <i style={{ width: at(entry.rate) }} /> : null}
                <span className="queue-rail-tick" style={{ left: at(lines.overrideTarget) }} />
                <span className="queue-rail-tick is-review" style={{ left: at(lines.overrideReview) }} />
              </div>
              {review !== null ? (
                <div className="between queue-rail-review">
                  <span className="st-block sb-warn">{t("triggered")}</span>
                  <span className="mono small">{review.id}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="inst-f">{t("footer")}</div>
    </section>
  );
}
