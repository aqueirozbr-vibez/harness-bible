import { useTranslations } from "next-intl";

import { MarkActions } from "@/components/reader/MarkActions";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import type { Locale } from "@/lib/i18n/routing";
import { suggestStartHref } from "@/lib/improve/suggest";
import type { ChapterData } from "@/lib/schemas/chapter";

import type { ToggleBookmarkAction } from "@/app/[lang]/ch/[n]/[section]/actions";

interface SectionActionsProps {
  readonly sectionId: string;
  readonly chapter: ChapterData["chapter"];
  readonly labHref: string | null;
  readonly askHref: string;
  readonly locale: Locale;
  /** The reader's marks on this section; null when signed out (feature-specs/07 § 6.1). */
  readonly marks?: ChapterData["marks"];
  readonly releaseId?: string;
  readonly toggleBookmark?: ToggleBookmarkAction;
  /** `rail` or `inline`: the rail renders twice. */
  readonly idPrefix?: string;
}

/** The actions from this section: bookmark, run the lab, ask, suggest (spec 03 § 6.9, 07 § 6.1). */
export function SectionActions({ sectionId, chapter, labHref, askHref, locale, marks = null, releaseId, toggleBookmark, idPrefix = "rail" }: SectionActionsProps) {
  const t = useTranslations("reader.actions");
  const suggestHref = suggestStartHref(locale, sectionId, "SECTION", sectionId);
  return (
    <section className="col actions-list" style={{ gap: 10 }}>
      <span className="cap">{t("cap")}</span>
      {marks !== null && toggleBookmark !== undefined && releaseId !== undefined ? (
        <MarkActions sectionId={sectionId} releaseId={releaseId} bookmarked={marks.bookmarked} toggle={toggleBookmark} idPrefix={idPrefix} />
      ) : null}
      {chapter.lab !== null && labHref !== null ? (
        <Button href={labHref}>
          <span>{t("run", { n: chapter.number })}</span>
          {chapter.lab.expectedRuntimeS !== null ? <span className="meta">{t("runtime", { min: Math.max(1, Math.round(chapter.lab.expectedRuntimeS / 60)) })}</span> : null}
        </Button>
      ) : null}
      <Button href={askHref}>
        <span>{t("ask", { id: sectionId })}</span>
        <Kbd>a</Kbd>
      </Button>
      <Button href={suggestHref}>
        <span>{t("suggest")}</span>
        <span className="meta">{t("anchor", { id: sectionId })}</span>
      </Button>
    </section>
  );
}
