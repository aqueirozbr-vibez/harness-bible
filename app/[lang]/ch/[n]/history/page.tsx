import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { TopBar } from "@/components/chrome/TopBar";
import { ChapterHistory } from "@/components/improve/ChapterHistory";
import { getSession } from "@/lib/auth/session";
import { getChapterHistory } from "@/lib/db/chapterHistory";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";

/*
 * A chapter's improvement history (feature-specs/37 § 7; unit 54d; the Chapter-History screen): public, rendered per
 * request, since the chain is checked on each. The reader's chapter instrument links here with the number of rows.
 */
export const dynamic = "force-dynamic";

interface ChapterHistoryRouteProps {
  readonly params: Promise<{ lang: string; n: string }>;
}

const CHAPTER = /^\d{2}$/;

export async function generateMetadata({ params }: ChapterHistoryRouteProps): Promise<Metadata> {
  const { lang, n } = await params;
  const locale = LocaleSchema.parse(lang);
  const t = await getTranslations({ locale, namespace: "improve.history" });
  return { title: t("metaTitle", { n }), alternates: { languages: { en: `/en/ch/${n}/history`, pt: `/pt/ch/${n}/history` } } };
}

export default async function ChapterHistoryRoute({ params }: ChapterHistoryRouteProps) {
  const { lang, n } = await params;
  const locale = LocaleSchema.parse(lang);
  if (!CHAPTER.test(n)) notFound();
  setRequestLocale(locale);
  const user = await getSession();
  const { result, ms: loadedMs } = await timed(() => getChapterHistory(locale, Number(n)));
  if (result.kind === "missing") notFound();
  return (
    <>
      <TopBar locale={locale} current="improve" release={{ id: result.release.id, sha: result.release.gitSha }} session={user} nextPath={`/${locale}/ch/${n}/history`} compact />
      <ChapterHistory locale={locale} data={result} signedIn={user !== null} loadedMs={loadedMs} />
    </>
  );
}
