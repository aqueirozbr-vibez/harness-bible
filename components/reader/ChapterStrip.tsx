import { useTranslations } from "next-intl";

import { StatusBlock } from "@/components/ui/StatusBlock";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { ChapterData } from "@/lib/schemas/chapter";
import type { StatusTone } from "@/lib/schemas/domain";

interface ChapterStripProps {
  readonly chapter: ChapterData["chapter"];
  readonly locale: Locale;
}

const VERDICT_TONE: Record<NonNullable<ChapterData["chapter"]["lab"]>["verdict"], StatusTone> = {
  REPRODUCED: "ok",
  NOT_REPRODUCED: "fail",
  KILLED: "fail",
  ERROR: "fail",
};

/** Phone-only: the chapter instrument compressed to one strip (spec § 6.10). */
export function ChapterStrip({ chapter, locale }: ChapterStripProps) {
  const t = useTranslations("reader");
  return (
    <section className="rb-s chapter-strip phone-only" aria-label={t("mobile.stripLabel", { n: chapter.number })}>
      <span className="label" style={{ color: "var(--ink)" }}>
        {t("mobile.strip", { n: chapter.number })}
      </span>
      <span className="meta">{chapter.version}</span>
      {chapter.verifiedAt !== null ? <span className="meta">{t("inst.verified", { date: formatDate(chapter.verifiedAt, locale) })}</span> : null}
      {chapter.lab !== null ? (
        <span className="row" style={{ gap: 6 }}>
          <span className="meta">Lab {chapter.number}</span>
          <StatusBlock tone={VERDICT_TONE[chapter.lab.verdict]}>{t(`inst.verdict.${chapter.lab.verdict}`)}</StatusBlock>
        </span>
      ) : null}
    </section>
  );
}
