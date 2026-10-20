import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { StatusBlock } from "@/components/ui/StatusBlock";
import { SEARCH_TARGET_MS } from "@/lib/db/search";
import { formatDayMonthTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { SearchData } from "@/lib/schemas/search";

/* Eight cells: with the label before it and the milliseconds after, a row then fits the rail at its narrowest (320px),
   where sixteen pushed the number out of sight. The block glyphs come from a fallback font and are wider than the mono's. */
const BAR_CELLS = 8;

function bar(ms: number, longest: number): string {
  const filled = longest <= 0 ? 0 : Math.max(0, Math.min(BAR_CELLS, Math.round((ms / longest) * BAR_CELLS)));
  return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

interface SearchRailProps {
  readonly data: SearchData;
  readonly locale: Locale;
}

/** Index and Query instruments, the actions and the marks legend (feature-specs/06 § 6.5). */
export function SearchRail({ data, locale }: SearchRailProps) {
  const t = useTranslations("search");
  const { timings, index } = data;
  const total = Math.round(timings.totalMs);
  const stages: ReadonlyArray<{ key: "parse" | "lexical" | "vector" | "assemble"; ms: number | null }> = [
    { key: "parse", ms: timings.parseMs },
    { key: "lexical", ms: timings.lexicalMs },
    { key: "vector", ms: timings.vectorMs },
    { key: "assemble", ms: timings.assembleMs },
  ];
  const longest = Math.max(...stages.map((s) => s.ms ?? 0), 1);
  const width = Math.max(...stages.map((s) => t(`query.${s.key}`).length));
  /* Only the vector stage can be absent: `indexing` while the release holds no vectors, `unavailable` when the
     query could not be embedded (feature-specs/12 § 5, § 6). */
  const lines = stages.map((s) => {
    const label = t(`query.${s.key}`).padEnd(width + 2);
    if (s.ms !== null) return `${label}${bar(s.ms, longest)} ${String(Math.round(s.ms)).padStart(4)} ms`;
    return `${label}${data.vector === "indexing" ? t("query.vectorIndexing") : t("query.vectorUnavailable")}`;
  });
  const hash = index.hash.slice(0, 8);
  const hasQuery = data.filters.q.length > 0;

  return (
    <aside className="search-rail rl" aria-label={t("query.label")}>
      <InstrumentPanel
        label={t("index.label")}
        meta={[{ key: "release", node: index.hash === "" ? data.release.id : data.release.id }]}
        timestamp={t("index.built", { when: formatDayMonthTime(index.builtAt, locale) })}
        footer={
          <>
            <span>{t("index.hash")}</span>
            <span className="tex">
              #{hash.slice(0, 4)}·{hash.slice(4, 8)}
            </span>
          </>
        }
        footerClassName="between"
      >
        <dl className="kv">
          <dt>{t("index.chapters")}</dt>
          <dd>{t("index.chaptersValue", { n: index.chapters, sections: index.sections })}</dd>
          <dt>{t("index.labs")}</dt>
          <dd>{t("index.labsValue", { n: index.labs })}</dd>
          <dt>{t("index.rows")}</dt>
          <dd>{index.rows.toLocaleString(locale === "pt" ? "pt-BR" : "en-GB")}</dd>
          <dt>{t("index.edition")}</dt>
          <dd>{index.editions === "EN_PT" ? t("index.editionParity") : t("index.editionEn")}</dd>
        </dl>
      </InstrumentPanel>

      {hasQuery ? (
        <InstrumentPanel
          label={t("query.label")}
          meta={[{ key: "ms", node: t("query.ms", { ms: total }) }]}
          timestamp={<span className={total > SEARCH_TARGET_MS ? "text-warn" : undefined}>{total > SEARCH_TARGET_MS ? t("query.over") : t("query.under")}</span>}
        >
          <div className="col gap-s3">
            {/* It scrolls sideways when a language's stage names are long, so it takes keyboard focus (WCAG 2.1.1). */}
            <pre className="loader query-bars" role="status" tabIndex={0}>
              {lines.join("\n")}
            </pre>
            <div className="rt col query-terms">
              <span className="cap">{t("query.terms")}</span>
              <span className="meta">{data.terms.query.length > 0 ? data.terms.query.join(" · ") : "—"}</span>
              <span className="meta faint">{t("query.results", { count: data.count })}</span>
            </div>
          </div>
        </InstrumentPanel>
      ) : null}

      {hasQuery ? (
        <section className="col gap-s3">
          <span className="cap">{t("actions.cap")}</span>
          {data.actions.askHref !== null ? (
            <Button href={data.actions.askHref} className="rail-btn">
              <span>{t("actions.ask", { q: data.filters.q })}</span>
              <Kbd>a</Kbd>
            </Button>
          ) : null}
          {data.actions.lab !== null ? (
            <Button href={data.actions.lab.href} className="rail-btn">
              <span>{t("actions.lab", { n: data.actions.lab.id.replace(/^lab-/, "") })}</span>
              {data.actions.lab.minutes !== null ? <span className="meta">{t("actions.labTime", { min: data.actions.lab.minutes })}</span> : null}
            </Button>
          ) : null}
          <Button disabled className="rail-btn" title={t("actions.saveSoon")}>
            <span>{t("actions.save")}</span>
            <span className="meta">{t("actions.saveMeta")}</span>
          </Button>
        </section>
      ) : null}

      <div className="rt col marks-legend">
        <span className="cap">{t("marks.cap")}</span>
        <div className="row small">
          <StatusBlock tone="warn" className="sb-sm">
            {t("marks.stale")}
          </StatusBlock>
          <span className="muted">{t("marks.staleText")}</span>
        </div>
        <div className="row small hit">
          <mark>{t("marks.term")}</mark>
          <span className="muted">{t("marks.termText")}</span>
        </div>
      </div>
    </aside>
  );
}
