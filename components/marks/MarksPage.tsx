import { useTranslations } from "next-intl";

import { SignInNotice } from "@/components/auth/SignInNotice";
import { StatusBar } from "@/components/chrome/StatusBar";
import { BookmarkList } from "@/components/marks/BookmarkList";
import { NoteList } from "@/components/marks/NoteList";
import { ErrorBox } from "@/components/ui/ErrorBox";
import { Notice } from "@/components/ui/Notice";
import { formatDayMonthTime, formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { MarksData } from "@/lib/schemas/marks";

export type MarksActionError = "session" | "remove" | "delete";

interface MarksPageProps {
  readonly data: MarksData;
  readonly locale: Locale;
  readonly loadedMs: number;
  readonly error?: MarksActionError;
  /** Section id of the mark the last action removed or deleted (from the URL). */
  readonly removed?: string;
  readonly deleted?: string;
  readonly removeAction: (formData: FormData) => Promise<void>;
  readonly deleteAction: (formData: FormData) => Promise<void>;
}

/** The marks page: head, the outcome line, two instruments, status bar (feature-specs/07 § 6.4). */
export function MarksPage({ data, locale, loadedMs, error, removed, deleted, removeAction, deleteAction }: MarksPageProps) {
  const t = useTranslations("marks");
  const th = useTranslations("home.statusbar");

  return (
    <>
      <main className="marks-page">
        <div className="col" style={{ gap: 8 }}>
          <span className="cap">{data.syncedAt === null ? t("cap") : t("capSynced", { when: formatDayMonthTime(data.syncedAt, locale) })}</span>
          <h1 className="h1">{t("title")}</h1>
          <p className="muted paths-blurb">{t("blurb")}</p>
        </div>
        {error !== undefined ? <ErrorBox title={t("error.title")}>{t(`error.${error}`)}</ErrorBox> : null}
        {error === undefined && removed !== undefined ? <Notice title={t("notice.title")}>{t("notice.removed", { id: removed })}</Notice> : null}
        {error === undefined && deleted !== undefined ? <Notice title={t("notice.title")}>{t("notice.deleted", { id: deleted })}</Notice> : null}
        {data.signedIn ? (
          <div className="marks-lists">
            <BookmarkList rows={data.bookmarks} releaseId={data.release.id} locale={locale} action={removeAction} />
            <NoteList rows={data.notes} releaseId={data.release.id} locale={locale} action={deleteAction} />
          </div>
        ) : (
          <SignInNotice locale={locale} next={`/${locale}/marks`} className="paths-signin" />
        )}
      </main>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{data.signedIn ? t("statusbar.counts", { b: data.bookmarks.length, n: data.notes.length }) : t("statusbar.plain")}</span>
        <span className="desktop-only">{th("lang", { lang: locale.toUpperCase(), src: data.sourceLang })}</span>
        <span className="desktop-only">{th("release", { id: data.release.id })}</span>
      </StatusBar>
    </>
  );
}
