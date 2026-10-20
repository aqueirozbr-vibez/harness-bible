import { useTranslations } from "next-intl";

import { PART_ROMAN } from "@/components/reader/PartGrid";
import { StatusBlock } from "@/components/ui/StatusBlock";
import { StatusMark } from "@/components/ui/StatusMark";
import { Xref } from "@/components/ui/Xref";
import type { StartStrip } from "@/lib/db/suggestStart";
import type { Locale } from "@/lib/i18n/routing";

export type ContextStripProps = StartStrip & {
  readonly locale: Locale;
  /**
   * The suggestion's id, which the strip ends with: on the edit page with `draft · not submitted` (34 § 5) or, revising
   * a suggestion, `revision · not submitted` (31 § 6.5); on its own page alone (35 § 4).
   */
  readonly suggestion?: { readonly id: string; readonly mark: "draft" | "revision" | null };
};

/**
 * The chapter context strip (feature-specs/34 § 4, § 5; the Improve-Suggest screen's strip): the way back to the
 * section, the chapter it was opened from, what the change is anchored to and its stale mark, and on the edit page
 * the draft's id and `draft · not submitted`. The titles are the edition's, marked with its language where the
 * page's is another (WCAG 3.1.2).
 */
export function ContextStrip({ locale, back, chapter, contentLang, anchor, staleDays, suggestion }: ContextStripProps) {
  const t = useTranslations("improve.suggest.strip");
  return (
    <div className="improve-strip rb band">
      <Xref href={`/${locale}/ch/${back.slice(0, 2)}/${back}`}>{t("back", { id: back })}</Xref>
      <span className="cap">{t("openedFrom")}</span>
      <span className="meta">
        {t("chapterNumber", { n: chapter.digits })} · <span lang={contentLang}>{chapter.title}</span> · {chapter.version} · {t("part", { roman: PART_ROMAN[chapter.part] })}
      </span>
      <span className="faint">/</span>
      <span className="meta">
        {anchor.section.id} <span lang={contentLang}>{anchor.section.title}</span>
        {anchor.item !== null ? <> · {t(anchor.kind === "FIGURE" ? "figure" : "row", { item: anchor.item })}</> : null}
      </span>
      {staleDays !== null ? <StatusMark tone="warn">{t("stale", { days: staleDays })}</StatusMark> : null}
      {suggestion !== undefined ? (
        <span className="row improve-strip-draft">
          <span className="cap">{t("suggestion")}</span>
          <span className="meta improve-strip-id">{suggestion.id}</span>
          {suggestion.mark !== null ? <StatusBlock tone="mute">{t(suggestion.mark)}</StatusBlock> : null}
        </span>
      ) : null}
    </div>
  );
}
