import { useTranslations } from "next-intl";
import Link from "next/link";

import { QueueRailKappa } from "@/components/improve/QueueRailKappa";
import { QueueRailOverride } from "@/components/improve/QueueRailOverride";
import { QueueRailPrecision } from "@/components/improve/QueueRailPrecision";
import type { QueueCalibration } from "@/lib/db/queuePage";
import type { Locale } from "@/lib/i18n/routing";

interface QueueRailProps {
  readonly locale: Locale;
  readonly calibration: QueueCalibration;
}

/**
 * The calibration rail (feature-specs/36 § 6.4; unit 53d; the Curator-Queue screen's right column), this quarter's,
 * as `GET /curation/metrics` reads it: the override rate per criterion with its legend and scale; the adjudicator's κ
 * against the curators with its scale and sentence; adjudication precision with its rows and the public rubric's
 * link. Under the minimum a measure shows its counts and a dash; the screen's samples are never printed (§ 6.1).
 */
export function QueueRail({ locale, calibration }: QueueRailProps) {
  const t = useTranslations("improve.queue.rail");
  const { quarter, lines, minimum, rubric } = calibration;
  const label = t("quarter", { n: quarter.quarter.slice(-1), year: quarter.quarter.slice(0, 4) });
  return (
    <aside className="rl col queue-rail" aria-label={t("label")}>
      <QueueRailOverride locale={locale} quarter={label} reading={quarter.all.overrideRate} reviews={quarter.reviews} lines={lines} />
      <QueueRailKappa locale={locale} quarter={label} kappa={quarter.all.kappa} lines={lines} minimum={minimum} />
      <QueueRailPrecision locale={locale} quarter={label} precision={quarter.all.precision} lines={lines} rubric={rubric} />
      <p className="help">{t("minimum", { min: minimum })}</p>
      {/* the research log (43 § 7.2; unit 60d): what was refuted and declined, read beside the calibration it informs */}
      <Link className="xref" href={`/${locale}/improve/research`}>
        {t("researchLog")}
      </Link>
    </aside>
  );
}
