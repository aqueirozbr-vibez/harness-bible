import { useTranslations } from "next-intl";
import Link from "next/link";

import type { Locale } from "@/lib/i18n/routing";
import type { ChapterData } from "@/lib/schemas/chapter";
import { padChapter } from "@/lib/schemas/ids";

interface SourceLangBandProps {
  readonly chapter: ChapterData["chapter"];
  readonly locale: Locale;
  readonly pending: boolean;
}

/** Phone-only source-language marker above the chapter (spec § 6.10); shown when the edition is not the source. */
export function SourceLangBand({ chapter, locale, pending }: SourceLangBandProps) {
  const t = useTranslations("reader.header");
  const src = chapter.sourceLang;
  if (src.toLowerCase() === locale) return null;
  const original = `/${src.toLowerCase()}/ch/${padChapter(chapter.number)}`;
  return (
    <div className="band rb band-source phone-only">
      <span className="cap">{pending ? t("sourcePending", { src, edition: locale.toUpperCase() }) : t("source", { src, edition: locale.toUpperCase() })}</span>
      <Link href={original} className="xref" lang={src === "EN" ? "en" : "pt-BR"}>
        {t("original", { src })}
      </Link>
    </div>
  );
}
