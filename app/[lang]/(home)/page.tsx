import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { TopBar } from "@/components/chrome/TopBar";
import { BookHome } from "@/components/reader/BookHome";
import { getSession } from "@/lib/auth/session";
import { getHomeData } from "@/lib/db/content";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";

interface HomePageProps {
  readonly params: Promise<{ lang: string }>;
}

export async function generateMetadata({ params }: HomePageProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "home" });
  const data = await getHomeData(locale, null);
  return {
    title: t("metaTitle", { id: data.release.id }),
    alternates: { languages: { en: "/en", pt: "/pt" } },
  };
}

export default async function HomePage({ params }: HomePageProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);

  const user = await getSession();
  const { result: data, ms: loadedMs } = await timed(() => getHomeData(locale, user));

  return (
    <>
      <TopBar locale={locale} current="book" release={{ id: data.release.id, sha: data.release.gitSha }} session={user} nextPath={`/${locale}`} />
      <BookHome data={data} locale={locale} signedIn={user !== null} loadedMs={loadedMs} />
    </>
  );
}
