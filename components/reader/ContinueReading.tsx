import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { Meter } from "@/components/ui/Meter";
import { formatDayMonthTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { ContinueReading as ContinueReadingData } from "@/lib/schemas/home";
import { chapterOfSection } from "@/lib/schemas/ids";

interface ContinueReadingProps {
  /** null for a signed-in reader with no progress yet (spec § 7). */
  readonly data: ContinueReadingData | null;
  readonly locale: Locale;
}

/** The 460px "Continue reading" instrument (spec § 6.2). */
export function ContinueReading({ data, locale }: ContinueReadingProps) {
  const t = useTranslations("home.continue");

  if (data === null) {
    return (
      <InstrumentPanel label={t("label")} body="bare">
        <Empty
          caption={t("emptyCap")}
          action={
            <Button href={`/${locale}/paths`} size="sm">
              {t("choose")}
            </Button>
          }
          className="border-0"
        >
          <p className="ui">{t("empty")}</p>
        </Empty>
      </InstrumentPanel>
    );
  }

  const pathName = data.path === null ? null : t(`pathName.${data.path.key}`);

  return (
    <InstrumentPanel
      label={t("label")}
      meta={[{ key: "chapter", node: t("chapter", { n: chapterOfSection(data.sectionId), version: data.chapterVersion }) }]}
      timestamp={t("lastRead", { when: formatDayMonthTime(data.lastReadAt, locale) })}
    >
      <div className="col gap-s3">
        <div className="col" style={{ gap: 2 }}>
          <span className="cap">{t("cap")}</span>
          <div className="row" style={{ gap: 10 }}>
            <span className="meta">{data.sectionId}</span>
            <span className="h4">{data.sectionTitle}</span>
          </div>
          <span className="small muted">{t("layer", { chapter: data.chapterTitle, n: data.layer })}</span>
        </div>
        <div className="between gap-s4">
          {data.path !== null && pathName !== null ? (
            <div className="col grow" style={{ gap: 6 }}>
              <div className="between small">
                <span>{t("path", { name: pathName })}</span>
                <span className="meta">{t("of", { done: data.path.done, total: data.path.total })}</span>
              </div>
              <Meter value={data.path.done} max={data.path.total} label={t("meterLabel", { name: pathName })} />
            </div>
          ) : null}
          <Button variant="primary" href={data.href}>
            {t("resume", { section: data.sectionId })}
          </Button>
        </div>
      </div>
    </InstrumentPanel>
  );
}
