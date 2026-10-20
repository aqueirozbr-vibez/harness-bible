import type { Metadata } from "next";
import { listAidsFor } from "@/lib/aids/index";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { KeyboardMap } from "@/components/chrome/KeyboardMap";
import { TopBar } from "@/components/chrome/TopBar";
import { ReaderChapter } from "@/components/reader/ReaderChapter";
import { withDraft } from "@/lib/assistant/links";
import { getSession } from "@/lib/auth/session";
import { getChapterData } from "@/lib/db/content";
import { timed } from "@/lib/db/timing";
import { LocaleSchema, type Locale } from "@/lib/i18n/routing";
import { chapterStartHref, padChapter, parseChapterNumber } from "@/lib/schemas/ids";

import { deleteNote, recordSectionRead, saveNote, toggleBookmark } from "./actions";

/* Per-user progress sits in the outline, so the page renders per request; the content itself is cached per release (feature-specs/05 § 6.9). */
export const dynamic = "force-dynamic";

interface SectionPageProps {
  readonly params: Promise<{ lang: string; n: string; section: string }>;
  /** `ask` opens the assistant dock; the slot beside this page renders it (feature-specs/16 § 3). */
  readonly searchParams: Promise<Record<string, string | ReadonlyArray<string> | undefined>>;
}

function parseRoute(lang: string, n: string, section: string): { locale: Locale; chapter: number } {
  const locale = LocaleSchema.parse(lang);
  if (!/^\d{2}$/.test(n) || !/^\d{2}\.[1-9]$/.test(section) || section.slice(0, 2) !== n) {
    notFound();
  }
  return { locale, chapter: Number(n) };
}

export async function generateMetadata({ params }: SectionPageProps): Promise<Metadata> {
  const { lang, n, section } = await params;
  const { locale, chapter } = parseRoute(lang, n, section);
  const data = await getChapterData(locale, chapter, section, null);
  if (data === null) return {};
  const t = await getTranslations({ locale, namespace: "reader" });
  return {
    title: t("metaTitle", { section: data.section.id, title: data.section.title, n: chapter }),
    description: data.chapter.standfirst,
    alternates: { languages: { en: `/en/ch/${n}/${section}`, pt: `/pt/ch/${n}/${section}` } },
  };
}

export default async function SectionPage({ params, searchParams }: SectionPageProps) {
  const [{ lang, n, section }, query] = await Promise.all([params, searchParams]);
  const { locale, chapter } = parseRoute(lang, n, section);
  setRequestLocale(locale);

  const user = await getSession();
  const { result: data, ms: loadedMs } = await timed(() => getChapterData(locale, chapter, section, user));
  if (data === null) {
    notFound();
  }

  const ta = await getTranslations({ locale, namespace: "assistant.dock" });
  const number = parseChapterNumber(chapter);
  /* `[` and `]` go to the neighbouring chapter's first layer by its own address, not through the chapter's redirect. */
  const prevChapter = chapter > 0 ? chapterStartHref(locale, parseChapterNumber(chapter - 1)) : null;
  const nextChapter = chapter < 40 ? chapterStartHref(locale, parseChapterNumber(chapter + 1)) : null;
  const labHref = data.chapter.lab === null ? null : `/${locale}/ch/${padChapter(number)}/@lab`;
  const nextPath = `/${locale}/ch/${n}/${section}`;
  /* `?ask=1` is the dock's open state, not a path (spec 16 § 3, D1). `Ask about 21.3` also brings the section, as
     text in the ask box: the assistant reads no position (feature-specs/23 D2), so what the reader means is written
     where they can see it and change it (24 § 6.2). */
  const askHref = withDraft(nextPath, ta("draftAbout", { id: section }));
  const dockOpen = typeof query.ask === "string" && query.ask.length > 0;

  return (
    <>
      <TopBar locale={locale} current="book" release={{ id: data.release.id, sha: data.release.gitSha }} session={user} nextPath={nextPath} compact />
      <ReaderChapter
        data={data}
        locale={locale}
        signedIn={user !== null}
        loadedMs={loadedMs}
        labHref={labHref}
        askHref={askHref}
        nextPath={nextPath}
        dockOpen={dockOpen}
        aids={dockOpen ? listAidsFor(number) : []}
        recordRead={recordSectionRead}
        markActions={{ toggleBookmark, saveNote, deleteNote }}
      />
      <KeyboardMap
        signedIn={user !== null}
        targets={{
          next: data.section.next?.href ?? null,
          prev: data.section.prev?.href ?? null,
          nextChapter,
          prevChapter,
          lab: labHref,
        }}
      />
    </>
  );
}
