import { useTranslations } from "next-intl";
import Link from "next/link";

import { SignInNotice } from "@/components/auth/SignInNotice";
import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { formatDayMonthTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { PathsData } from "@/lib/schemas/paths";

interface YourMarksProps {
  readonly marks: PathsData["marks"];
  readonly locale: Locale;
}

/** Bookmark and note counts with the latest note (§ 6.2); the sign-in notice when signed out. */
export function YourMarks({ marks, locale }: YourMarksProps) {
  const t = useTranslations("paths");

  if (marks === null) {
    return <SignInNotice locale={locale} next={`/${locale}/paths`} className="paths-signin" />;
  }

  return (
    <InstrumentPanel
      label={t("marks.label")}
      meta={[{ key: "account", node: t("marks.meta") }]}
      timestamp={marks.syncedAt === null ? undefined : t("marks.synced", { when: formatDayMonthTime(marks.syncedAt, locale) })}
      body="bare"
      className="marks"
    >
      <div className="marks-grid" id="marks">
        <Link href={`/${locale}/marks#bookmarks`} className="rr marks-cell">
          <span className="mono marks-count">{marks.bookmarks}</span>
          <span className="cap">{t("marks.bookmarks")}</span>
        </Link>
        <Link href={`/${locale}/marks#notes`} className="rr marks-cell">
          <span className="mono marks-count">{marks.notes}</span>
          <span className="cap">{t("marks.notes")}</span>
        </Link>
        {marks.latest === null ? (
          <div className="marks-cell marks-latest">
            <span className="cap">{t("marks.notes")}</span>
            <span className="small muted">{t("marks.none")}</span>
          </div>
        ) : (
          <Link href={marks.latest.href} className="rr marks-cell marks-latest">
            <span className="cap">{t("marks.latest", { id: marks.latest.sectionId })}</span>
            <span className="small">{marks.latest.text}</span>
          </Link>
        )}
      </div>
    </InstrumentPanel>
  );
}
