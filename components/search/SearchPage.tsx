import { useTranslations } from "next-intl";

import { StatusBar } from "@/components/chrome/StatusBar";
import { HitList } from "@/components/search/HitList";
import { SearchFilters } from "@/components/search/SearchFilters";
import { SearchHead } from "@/components/search/SearchHead";
import { SearchRail } from "@/components/search/SearchRail";
import { formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { SearchData } from "@/lib/schemas/search";

interface SearchPageProps {
  readonly data: SearchData;
  readonly locale: Locale;
  readonly loadedMs: number;
}

/** Filters, results and the rail, then the status bar (feature-specs/06 § 6). */
export function SearchPage({ data, locale, loadedMs }: SearchPageProps) {
  const t = useTranslations("search");
  const th = useTranslations("home.statusbar");
  const hasQuery = data.filters.q.length > 0;
  return (
    <>
      <div className="search">
        <SearchFilters data={data} locale={locale} />
        <main className="search-main">
          <SearchHead data={data} locale={locale} />
          <HitList data={data} locale={locale} />
        </main>
        <SearchRail data={data} locale={locale} />
      </div>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{hasQuery ? t("statusbar.search", { q: data.filters.q }) : t("statusbar.plain")}</span>
        <span className="desktop-only">{th("lang", { lang: locale.toUpperCase(), src: data.sourceLang })}</span>
        <span className="desktop-only">{th("release", { id: data.release.id })}</span>
        {hasQuery ? <span>{t("statusbar.results", { count: data.count, ms: Math.round(data.timings.totalMs) })}</span> : null}
      </StatusBar>
    </>
  );
}
