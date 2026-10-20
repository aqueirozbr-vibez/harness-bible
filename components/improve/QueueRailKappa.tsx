import { useTranslations } from "next-intl";

import { StatusMark } from "@/components/ui/StatusMark";
import { formatFactor, formatKappa } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { CalibrationReading, CurationMetrics } from "@/lib/schemas/curation";
import type { StatusTone } from "@/lib/schemas/domain";

interface QueueRailKappaProps {
  readonly locale: Locale;
  readonly quarter: string;
  readonly kappa: CalibrationReading["kappa"];
  readonly lines: CurationMetrics["lines"];
  readonly minimum: number;
}

/** The bar's scale, the screen's: κ from 0.5 to 0.8; a value outside it stops at the end. */
const LOW = 0.5;
const HIGH = 0.8;
const at = (value: number): string => `${String(Math.min(Math.max((value - LOW) / (HIGH - LOW), 0), 1) * 100)}%`;

type Zone = "none" | "retire" | "below" | "gate";
const TONE: Readonly<Record<Zone, StatusTone>> = { none: "mute", retire: "fail", below: "warn", gate: "ok" };

/**
 * The adjudicator's κ against the curators (36 § 6.4; the Curator-Queue screen): the value, where it stands — under
 * the retirement floor, below the gate, at it — the scale with both lines, how many items both decided and agreed on,
 * and the sentence. Under the minimum, a dash and the count.
 */
export function QueueRailKappa({ locale, quarter, kappa, lines, minimum }: QueueRailKappaProps) {
  const t = useTranslations("improve.queue.rail.kappa");
  const zone: Zone = kappa.value === null ? "none" : kappa.value < lines.kappaRetire ? "retire" : kappa.value < lines.kappaGate ? "below" : "gate";
  return (
    <section className="inst" aria-labelledby="queue-rail-kappa">
      <div className="inst-h">
        <h2 className="t" id="queue-rail-kappa">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{t("cap")}</span>
        <span className="ts">{quarter}</span>
      </div>
      <div className="inst-b col queue-rail-body">
        <div className="between queue-rail-reading">
          <span className="midnum">{kappa.value === null ? "—" : formatKappa(kappa.value, locale)}</span>
          <StatusMark tone={TONE[zone]}>{t(`status.${zone}`)}</StatusMark>
        </div>
        <div className="queue-rail-bar" aria-hidden="true">
          <i className="queue-rail-zone" style={{ width: at(lines.kappaRetire) }} />
          {kappa.value !== null ? <i style={{ width: at(kappa.value) }} /> : null}
          <span className="queue-rail-tick is-review" style={{ left: at(lines.kappaRetire) }} />
          <span className="queue-rail-tick" style={{ left: at(lines.kappaGate) }} />
        </div>
        <div className="meta queue-rail-scale" aria-hidden="true">
          <span>{formatFactor(LOW, locale)}</span>
          <span className="is-at" style={{ left: at(lines.kappaRetire) }}>
            {t("retire", { value: formatFactor(lines.kappaRetire, locale) })}
          </span>
          <span className="is-at" style={{ left: at(lines.kappaGate) }}>
            {t("gate", { value: formatFactor(lines.kappaGate, locale) })}
          </span>
          <span>{formatFactor(HIGH, locale)}</span>
        </div>
        <span className="meta">{t("counts", { agreed: kappa.agreed, pairs: kappa.pairs })}</span>
        <p className="small muted">{t(`say.${zone}`, { min: minimum, retire: formatFactor(lines.kappaRetire, locale), gate: formatFactor(lines.kappaGate, locale) })}</p>
      </div>
    </section>
  );
}
