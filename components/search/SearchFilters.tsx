import { useTranslations } from "next-intl";

import { AutoSubmit } from "@/components/search/AutoSubmit";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import type { Locale } from "@/lib/i18n/routing";
import { activeFilterCount, AGE_KEYS, HIT_KINDS, LAYER_KEYS, PART_KEYS, searchHref, type SearchFilters as Filters } from "@/lib/search/filters";
import { SourceTierSchema } from "@/lib/schemas/domain";
import type { SearchData } from "@/lib/schemas/search";
import { cn } from "@/lib/utils";

interface SearchFiltersProps {
  readonly data: SearchData;
  readonly locale: Locale;
}

interface RowProps {
  readonly name: string;
  readonly value: string;
  readonly checked: boolean;
  readonly count: number;
  readonly enabled: boolean;
  readonly children: React.ReactNode;
  readonly className?: string;
}

function FilterRow({ name, value, checked, count, enabled, children, className }: RowProps) {
  const off = !checked && (count === 0 || !enabled);
  return (
    <li className={cn("between filter-row", off && "filter-off")}>
      <label className={cn("check", className)}>
        <input type="checkbox" name={name} value={value} defaultChecked={checked} disabled={off} />
        {children}
      </label>
      <span className="counter">{count}</span>
    </li>
  );
}

/** The filters aside: a GET form; counts per value from the facets (feature-specs/06 § 6.2). */
export function SearchFilters({ data, locale }: SearchFiltersProps) {
  const t = useTranslations("search");
  const tl = useTranslations("reader.layer");
  const ta = useTranslations("reader.tier.abbr");
  const f: Filters = data.filters;
  const active = activeFilterCount(f);
  const enabled = f.q.length > 0;
  const countOf = (group: keyof SearchData["facets"], value: string): number => {
    const list = data.facets[group];
    return Array.isArray(list) ? (list.find((c) => c.value === value)?.count ?? 0) : 0;
  };
  const clearHref = searchHref(locale, { ...f, part: [], layer: [], tier: [], age: [], type: [] });

  return (
    <aside className="search-filters rr">
      <form method="get" action={`/${locale}/search`} role="search" aria-label={t("filters.label")} className="col search-filters-form">
        <input type="hidden" name="q" value={f.q} />
        {f.sort !== "relevance" ? <input type="hidden" name="sort" value={f.sort} /> : null}
        <AutoSubmit />
        <div className="between">
          <span className="h4">{t("filters.title")}</span>
          {active > 0 ? (
            <Button variant="quiet" size="sm" href={clearHref}>
              {t("filters.clear")}
            </Button>
          ) : (
            <Button variant="quiet" size="sm" disabled>
              {t("filters.clear")}
            </Button>
          )}
        </div>
        <p className="help">{active === 0 ? t("filters.help") : t("filters.helpSet", { k: active })}</p>

        <fieldset className="rt filter-group">
          <legend className="cap">{t("group.part")}</legend>
          <ul className="col">
            {PART_KEYS.map((p) => (
              <FilterRow key={p} name="part" value={p} checked={f.part.includes(p)} count={countOf("part", p)} enabled={enabled}>
                {t(`part.${p}`)}
              </FilterRow>
            ))}
          </ul>
        </fieldset>

        <fieldset className="rt filter-group">
          <legend className="cap">{t("group.layer")}</legend>
          <ul className="col">
            {LAYER_KEYS.map((l) => (
              <FilterRow key={l} name="layer" value={String(l)} checked={f.layer.includes(l)} count={countOf("layer", String(l))} enabled={enabled}>
                <span className="mono faint filter-ordinal">{l}</span>
                {tl(String(l))}
              </FilterRow>
            ))}
          </ul>
          {data.facets.labsWithoutLayer > 0 ? <span className="help">{t("labsNoLayer", { n: data.facets.labsWithoutLayer })}</span> : null}
        </fieldset>

        <fieldset className="rt filter-group">
          <legend className="cap">{t("group.tier")}</legend>
          <ul className="col">
            {SourceTierSchema.options.map((tier) => (
              <FilterRow key={tier} name="tier" value={tier} checked={f.tier.includes(tier)} count={countOf("tier", tier)} enabled={enabled}>
                <Chip tier={tier} abbr={ta(tier)}>
                  {" "}
                  {t(`tier.${tier}`)}
                </Chip>
              </FilterRow>
            ))}
          </ul>
        </fieldset>

        <fieldset className="rt filter-group">
          <legend className="cap">{t("group.age")}</legend>
          <ul className="col">
            {AGE_KEYS.map((a) => (
              <FilterRow key={a} name="age" value={a} checked={f.age.includes(a)} count={countOf("age", a)} enabled={enabled}>
                <span className={a === "stale" ? "text-warn" : undefined}>{t(`age.${a}`)}</span>
              </FilterRow>
            ))}
          </ul>
        </fieldset>

        <fieldset className="rt filter-group">
          <legend className="cap">{t("group.type")}</legend>
          <ul className="col">
            {HIT_KINDS.map((k) => (
              <FilterRow key={k} name="type" value={k} checked={f.type.includes(k)} count={countOf("type", k)} enabled={enabled}>
                {t(`type.${k}`)}
              </FilterRow>
            ))}
          </ul>
        </fieldset>

        <div className="filters-apply">
          <Button type="submit" size="sm">
            {t("filters.apply")}
          </Button>
        </div>
      </form>
    </aside>
  );
}
