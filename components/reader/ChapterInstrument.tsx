import { useTranslations } from "next-intl";
import Link from "next/link";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { StatusBlock } from "@/components/ui/StatusBlock";
import { StatusMark } from "@/components/ui/StatusMark";
import { formatDate, formatDayMonthTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { ChapterData } from "@/lib/schemas/chapter";
import type { StatusTone } from "@/lib/schemas/domain";
import { padChapter } from "@/lib/schemas/ids";

interface ChapterInstrumentProps {
  readonly chapter: ChapterData["chapter"];
  readonly locale: Locale;
  /**
   * One strip instead of the panel, for the reading column while the assistant dock is open (feature-specs/16 § 4):
   * the same header, then verify, redteam, the lab and the derived count in a row, and no readings — the column is
   * 520px narrower and the readings are a rail's work, not a strip's.
   */
  readonly condensed?: boolean;
}

const VERDICT_TONE: Record<NonNullable<ChapterData["chapter"]["lab"]>["verdict"], StatusTone> = {
  REPRODUCED: "ok",
  NOT_REPRODUCED: "fail",
  KILLED: "fail",
  ERROR: "fail",
};

/** The chapter's instrument: verify, redteam, lab, and the kv readings (spec § 6.7). */
export function ChapterInstrument({ chapter, locale, condensed = false }: ChapterInstrumentProps) {
  const t = useTranslations("reader.inst");
  const verifyTone: StatusTone = chapter.verify === "PASSED" ? "ok" : chapter.verify === "FAILED" ? "fail" : "mute";
  const redteamTone: StatusTone = chapter.redteamOpen > 0 ? "warn" : chapter.redteam === "PASSED" ? "ok" : chapter.redteam === "FAILED" ? "fail" : "mute";
  const statusWord = (s: ChapterData["chapter"]["verify"]) => (s === "PASSED" ? t("passed") : s === "FAILED" ? t("failed") : t("unverified"));
  const sha = chapter.contentHash.slice(0, 8);

  const verifyMark = <StatusMark tone={verifyTone}>{statusWord(chapter.verify)}</StatusMark>;
  const redteamMark = (
    <StatusMark tone={redteamTone}>{chapter.redteam === "PASSED" ? t("redteamOpen", { n: chapter.redteamOpen }) : statusWord(chapter.redteam)}</StatusMark>
  );
  const labMark =
    chapter.lab === null ? <StatusBlock tone="mute">{t("noLab")}</StatusBlock> : <StatusBlock tone={VERDICT_TONE[chapter.lab.verdict]}>{t(`verdict.${chapter.lab.verdict}`)}</StatusBlock>;

  if (condensed) {
    return (
      <InstrumentPanel
        label={t("label", { n: chapter.number })}
        ariaLabel={t("condensedLabel", { n: chapter.number })}
        meta={[{ key: "version", node: chapter.version }]}
        timestamp={chapter.verifiedAt === null ? undefined : t("verified", { date: formatDate(chapter.verifiedAt, locale) })}
        body="bare"
      >
        <div className="row inst-strip">
          <span className="row gap-s2">
            <span className="flabel">{t("verify")}</span>
            {verifyMark}
          </span>
          <span className="row gap-s2">
            <span className="flabel">{t("redteam")}</span>
            {redteamMark}
          </span>
          <span className="row gap-s2">
            <span className="flabel">{t("lab", { n: chapter.number })}</span>
            {labMark}
          </span>
          <span className="meta inst-strip-end">{t("derivedValue", { linked: chapter.derivedFigures.linked, total: chapter.derivedFigures.total })}</span>
        </div>
      </InstrumentPanel>
    );
  }

  return (
    <InstrumentPanel
      label={t("label", { n: chapter.number })}
      meta={[{ key: "version", node: chapter.version }]}
      timestamp={chapter.verifiedAt === null ? undefined : t("verified", { date: formatDate(chapter.verifiedAt, locale) })}
      footerClassName="justify-between"
      footer={
        <>
          {chapter.historyCount > 0 ? (
            <Link href={`/${locale}/ch/${padChapter(chapter.number)}/history`} className="xref">
              {t("history", { n: chapter.historyCount })}
            </Link>
          ) : (
            <span />
          )}
          <span className="tex">
            #{sha.slice(0, 4)}·{sha.slice(4, 8)}
          </span>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="between">
          <span className="flabel">{t("verify")}</span>
          {verifyMark}
        </div>
        <div className="between">
          <span className="flabel">{t("redteam")}</span>
          {redteamMark}
        </div>
        <div className="between">
          <span className="flabel">{t("lab", { n: chapter.number })}</span>
          {labMark}
        </div>
        <dl className="kv rt" style={{ paddingTop: 12, margin: 0 }}>
          {chapter.lab !== null && chapter.lab.lastRunAt !== null ? (
            <>
              <dt>{t("lastRun")}</dt>
              <dd>{t("lastRunValue", { by: chapter.lab.lastRunBy, when: formatDayMonthTime(chapter.lab.lastRunAt, locale) })}</dd>
            </>
          ) : null}
          <dt>{t("derived")}</dt>
          <dd>{t("derivedValue", { linked: chapter.derivedFigures.linked, total: chapter.derivedFigures.total })}</dd>
          <dt>{t("cited")}</dt>
          <dd>{t("citedValue", { total: chapter.citedFigures.total, fast: chapter.citedFigures.fastMoving })}</dd>
          {chapter.oldestCheckDays !== null ? (
            <>
              <dt>{t("oldest")}</dt>
              <dd>{t("oldestValue", { days: chapter.oldestCheckDays })}</dd>
            </>
          ) : null}
          <dt>{t("words")}</dt>
          <dd>{chapter.words.toLocaleString(locale === "pt" ? "pt-BR" : "en-GB")}</dd>
        </dl>
      </div>
    </InstrumentPanel>
  );
}
