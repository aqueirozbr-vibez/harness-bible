import { useTranslations } from "next-intl";
import Link from "next/link";

import type { Locale } from "@/lib/i18n/routing";
import { activeFilterCount, DEFAULT_N, searchHref, SORT_KEYS } from "@/lib/search/filters";
import type { SearchData } from "@/lib/schemas/search";

interface SearchHeadProps {
  readonly data: SearchData;
  readonly locale: Locale;
}

/** Caption, title with the query, sort links, summary line and the filters note (feature-specs/06 § 6.3). */
export function SearchHead({ data, locale }: SearchHeadProps) {
  const t = useTranslations("search");
  const f = data.filters;
  const hasQuery = f.q.length > 0;
  const active = activeFilterCount(f);
  const ms = Math.round(data.timings.totalMs);

  return (
    <div className="col search-head">
      <span className="cap">{t(locale === "pt" ? "capPending" : "cap", { id: data.release.id })}</span>
      <div className="between search-title-row">
        <h1 className="h2">
          {hasQuery ? (
            <>
              <span className="muted">{t("title")}</span> {f.q}
            </>
          ) : (
            t("titleEmpty")
          )}
        </h1>
        {hasQuery ? (
          <div className="seg-links" role="group" aria-label={t("sort.label")}>
            {SORT_KEYS.map((key) => (
              <Link key={key} href={searchHref(locale, f, { sort: key, n: DEFAULT_N })} aria-current={f.sort === key ? "true" : undefined}>
                {t(`sort.${key}`)}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
      {hasQuery ? (
        <div className="row search-summary">
          <span className="meta">{t("summary", { count: data.count, ms })}</span>
          {data.terms.matched.length > 0 ? (
            <>
              <span className="cap">·</span>
              <span className="cap">{t("also", { terms: data.terms.matched.join(", ") })}</span>
            </>
          ) : null}
        </div>
      ) : null}
      {hasQuery && data.count > 0 ? (
        <div className="empty filters-note">
          <span className="glyph">✢</span>
          {active === 0 ? (
            <span className="small muted">{t("note.none")}</span>
          ) : (
            <span className="small muted">
              {t("note.some", { k: active, count: data.count })}{" "}
              <Link href={searchHref(locale, { ...f, part: [], layer: [], tier: [], age: [], type: [] })} className="xref">
                {t("note.clear")}
              </Link>
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
