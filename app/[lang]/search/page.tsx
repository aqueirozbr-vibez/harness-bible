import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { KeyboardMap } from "@/components/chrome/KeyboardMap";
import { TopBar } from "@/components/chrome/TopBar";
import { SearchPage } from "@/components/search/SearchPage";
import { getSession } from "@/lib/auth/session";
import { getSearchData } from "@/lib/db/search";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";
import { parseSearchParams } from "@/lib/search/filters";

/* The query is in the URL and every result set is per query: rendered on demand (feature-specs/06 § 3). */
export const dynamic = "force-dynamic";

interface SearchRouteProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params, searchParams }: SearchRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const filters = parseSearchParams(await searchParams);
  const t = await getTranslations({ locale, namespace: "search" });
  const query = filters.q.length > 0 ? `?q=${encodeURIComponent(filters.q)}` : "";
  return {
    title: filters.q.length > 0 ? t("metaTitle", { q: filters.q }) : t("metaTitleEmpty"),
    robots: filters.q.length > 0 ? { index: false } : undefined,
    alternates: { languages: { en: `/en/search${query}`, pt: `/pt/search${query}` } },
  };
}

export default async function SearchRoute({ params, searchParams }: SearchRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const raw = await searchParams;
  const { result: filters, ms: parseMs } = await timed(async () => parseSearchParams(raw));
  const user = await getSession();
  const { result: data, ms: loadedMs } = await timed(() => getSearchData(locale, filters, user, parseMs));
  return (
    <>
      <TopBar locale={locale} current="book" release={{ id: data.release.id, sha: data.release.gitSha }} session={user} nextPath={`/${locale}/search`} compact searchOnPhone query={filters.q} />
      <SearchPage data={data} locale={locale} loadedMs={loadedMs} />
      <KeyboardMap targets={{ next: null, prev: null, nextChapter: null, prevChapter: null, lab: data.actions.lab?.href ?? null }} />
    </>
  );
}
