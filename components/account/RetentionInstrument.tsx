import { useTranslations } from "next-intl";

import { DeleteAccountDialog } from "@/components/account/DeleteAccountDialog";
import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";

import { requestDeletion } from "@/app/[lang]/account/actions";

export interface RetentionStats {
  readonly conversations: number;
  /** The oldest unpurged message's date plus the 30 days, ISO-8601; null when no text is kept. */
  readonly keptUntil: string | null;
}

interface RetentionInstrumentProps {
  readonly locale: Locale;
  readonly stats: RetentionStats;
}

/**
 * The LGPD retention rows and the deletion request (feature-specs/08 § 6.3), with the reader's own evidence under
 * them (feature-specs/21 § 3.2): how many conversations they have and until when the oldest text is kept.
 */
export function RetentionInstrument({ locale, stats }: RetentionInstrumentProps) {
  const t = useTranslations("account.retention");
  return (
    <section id="retention" className="col" style={{ scrollMarginTop: 16 }}>
      <InstrumentPanel label={t("label")} meta={[{ key: "law", node: t("meta") }]} timestamp={t("policy")} className="account-inst">
        <div className="col gap-s3">
          <dl className="kv">
            <dt>{t("conversations")}</dt>
            <dd>{t("conversationsValue")}</dd>
            <dt>{t("thereafter")}</dt>
            <dd>{t("thereafterValue")}</dd>
            <dt>{t("identity")}</dt>
            <dd>{t("identityValue")}</dd>
            <dt>{t("runs")}</dt>
            <dd>{t("runsValue")}</dd>
            {/* what research keeps (feature-specs/48 § 9.4, § 17.1; unit 75): a person's research conversations, their text 30 days or until deleted */}
            <dt>{t("research")}</dt>
            <dd>{t("researchValue")}</dd>
          </dl>
          <span className="meta">
            {stats.conversations === 0 ? t("none") : stats.keptUntil === null ? t("statsPurged", { n: stats.conversations }) : t("stats", { n: stats.conversations, date: formatDate(new Date(stats.keptUntil), locale) })}
          </span>
          <div className="between" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <p className="small muted" style={{ margin: 0, maxWidth: "36ch" }}>
              {t("note")}
            </p>
            <DeleteAccountDialog locale={locale} action={requestDeletion} />
          </div>
        </div>
      </InstrumentPanel>
    </section>
  );
}
