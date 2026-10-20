import { useTranslations } from "next-intl";
import Link from "next/link";

import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { DeriveLink } from "@/components/ui/DeriveLink";
import { Empty } from "@/components/ui/Empty";
import { StatusBlock } from "@/components/ui/StatusBlock";
import { StatusMark } from "@/components/ui/StatusMark";
import { formatDayMonthTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { activeFilterCount, MAX_N, MORE_N, searchHref } from "@/lib/search/filters";
import { SourceTierSchema, type SourceTier } from "@/lib/schemas/domain";
import { SnippetHtmlSchema, type SearchData, type SearchHit } from "@/lib/schemas/search";
import { cn } from "@/lib/utils";

const TIER_ORDER: ReadonlyArray<SourceTier | "SCENARIO"> = [...SourceTierSchema.options, "SCENARIO"];

/** The one `dangerouslySetInnerHTML` of this unit: text with `<mark>` only, checked by the schema (feature-specs/06 § 4.2). */
function SearchSnippet({ snippet }: { readonly snippet: string }) {
  const html = SnippetHtmlSchema.parse(snippet);
  return <p className="hit-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function HitRow({ hit, locale }: { readonly hit: SearchHit; readonly locale: Locale }) {
  const t = useTranslations("search");
  const tl = useTranslations("reader.layer");
  const ta = useTranslations("reader.tier.abbr");
  const pad = String(hit.chapter).padStart(2, "0");
  const context =
    hit.kind === "lab" ? t("hit.labContext", { n: pad }) : hit.kind === "row" ? t("hit.rowContext", { n: pad, k: hit.rowOrdinal ?? 0 }) : t("hit.context", { n: pad, title: hit.chapterTitle });
  const layerCap = hit.kind === "lab" ? t("hit.noLayer") : hit.layer === 9 ? t("hit.sources") : t("hit.layer", { n: hit.layer ?? 0, name: tl(String(hit.layer ?? 1)).toLowerCase() });
  const tiers = TIER_ORDER.filter((tier) => hit.tiers.includes(tier));

  return (
    <li className="rb hit">
      <div className="between hit-head">
        <div className="row hit-lead">
          <span className="mono hit-label">{hit.label}</span>
          <Link href={hit.href} className="h4 hit-title">
            {hit.title}
          </Link>
          <span className="small faint hit-context">{context}</span>
        </div>
        <span className="label faint hit-kind">{t(`kind.${hit.kind}`)}</span>
      </div>
      <SearchSnippet snippet={hit.snippet} />
      <div className="row hit-meta">
        <span className="cap text-ink-2">{layerCap}</span>
        {tiers.map((tier) => (
          <Chip key={tier} tier={tier === "SCENARIO" ? "ILLUSTRATIVE" : tier} abbr={ta(tier === "SCENARIO" ? "ILLUSTRATIVE" : tier)}>
            {" "}
            {t(`tier.${tier}`)}
          </Chip>
        ))}
        {hit.kind === "lab" && hit.lab !== null ? (
          <span className="meta">{hit.lab.checkedAt === null ? "ci" : t("hit.ci", { when: formatDayMonthTime(hit.lab.checkedAt, locale) })}</span>
        ) : hit.kind === "row" ? (
          <span className="meta">{t("hit.rowChecked")}</span>
        ) : (
          <span className="meta">{hit.version}</span>
        )}
        {hit.verifiedDays === null ? <StatusMark tone="mute">{t("hit.unverified")}</StatusMark> : <StatusMark tone="ok">{t("hit.verified", { d: hit.verifiedDays })}</StatusMark>}
        {hit.lab !== null ? (
          hit.lab.verdict === "REPRODUCED" ? (
            <StatusMark tone="ok">{t("hit.reproduced")}</StatusMark>
          ) : (
            <StatusMark tone="fail">{t("hit.notReproduced")}</StatusMark>
          )
        ) : null}
        {hit.derive !== null ? <DeriveLink line={hit.derive.line} href={`/${locale}/labs/${hit.derive.labId}/derive.py#L${hit.derive.line}`} title={t("hit.deriveTitle", { line: hit.derive.line })} /> : null}
        {hit.stale !== null ? (
          <StatusBlock tone="warn" className="sb-sm">
            {t("hit.stale", { row: hit.stale.rowId, d: hit.stale.days })}
          </StatusBlock>
        ) : null}
      </div>
    </li>
  );
}

interface HitListProps {
  readonly data: SearchData;
  readonly locale: Locale;
}

/** The results, or the empty state that fits (feature-specs/06 § 6.4, § 7). */
export function HitList({ data, locale }: HitListProps) {
  const t = useTranslations("search");
  const f = data.filters;
  const hasQuery = f.q.length > 0;
  const active = activeFilterCount(f);

  if (!hasQuery) {
    return (
      <Empty caption={t("empty.cap")}>
        <p className="ui">{t("empty.prompt")}</p>
      </Empty>
    );
  }
  if (data.count === 0) {
    if (active > 0) {
      return (
        <Empty caption={t("empty.cap")} action={<Button size="sm" href={searchHref(locale, { ...f, part: [], layer: [], tier: [], age: [], type: [] })}>{t("note.clear")}</Button>}>
          <p className="ui">{t("empty.filtered")}</p>
        </Empty>
      );
    }
    return (
      <Empty caption={t("empty.cap")}>
        <p className="ui">{t("empty.none", { q: f.q, id: data.release.id })}</p>
        <p className="small muted">{data.stopWordsOnly ? t("empty.stop") : t("empty.hint")}</p>
      </Empty>
    );
  }

  const shown = data.hits.length;
  return (
    <>
      <ol className="rt-s hit-list" aria-label={t("list.label")}>
        {data.hits.map((hit) => (
          <HitRow key={`${hit.kind}:${hit.id}`} hit={hit} locale={locale} />
        ))}
      </ol>
      <div className={cn("between", "hit-foot")}>
        <span className="meta">{t("list.showing", { shown, count: data.count })}</span>
        {shown < data.count && f.n < MAX_N ? <Button href={searchHref(locale, f, { n: Math.min(MAX_N, f.n + MORE_N) })}>{t("list.more", { n: MORE_N })}</Button> : null}
      </div>
    </>
  );
}
