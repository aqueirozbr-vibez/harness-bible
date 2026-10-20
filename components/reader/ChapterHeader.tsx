import { useTranslations } from "next-intl";

import { PART_ROMAN } from "@/components/reader/PartGrid";
import type { Locale } from "@/lib/i18n/routing";
import type { ChapterData } from "@/lib/schemas/chapter";

interface ChapterHeaderProps {
  readonly chapter: ChapterData["chapter"];
  readonly locale: Locale;
  /** The requested edition's body is missing; the source-language body is shown (spec § 7). */
  readonly pending: boolean;
}

/** Chapter caption, title and standfirst (spec § 6.2). */
export function ChapterHeader({ chapter, locale, pending }: ChapterHeaderProps) {
  const t = useTranslations("reader.header");
  const edition = locale.toUpperCase();
  const src = chapter.sourceLang.toLowerCase();
  return (
    <div className="col desktop-only" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <span className="cap">{t("cap", { n: chapter.number, roman: PART_ROMAN[chapter.part] })}</span>
        <span className="cap">·</span>
        <span className="cap">{pending ? t("sourcePending", { src, edition: edition.toLowerCase() }) : t("source", { src, edition: edition.toLowerCase() })}</span>
      </div>
      <h1 className="h1 reader-title">{chapter.title}</h1>
      <p className="muted standfirst">{chapter.standfirst}</p>
    </div>
  );
}
