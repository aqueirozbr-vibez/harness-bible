import { useTranslations } from "next-intl";
import Link from "next/link";

import { BudgetInstrument } from "@/components/account/BudgetInstrument";
import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { Empty } from "@/components/ui/Empty";
import { Meter } from "@/components/ui/Meter";
import type { BudgetView } from "@/lib/budget/view";
import type { ReaderPanelStats } from "@/lib/db/assistantStats";
import { formatDate, formatMonthYear } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { formatValue, monthWindow } from "@/lib/metrics/assistant";
import { CITATION_RATE_FLOOR, FIRST_TOKEN_P95_MS, REFUSAL_RATE_CEILING } from "@/lib/metrics/dashboard";
import { cn } from "@/lib/utils";

/*
 * The reader's statistics (feature-specs/25 § 5): the assistant's observability series, counted from the reader's
 * own turns. A server component: the numbers are computed by `lib/metrics/reader.ts` from rows the tenant guard
 * filtered, and this file formats them. There is no chart library and none is needed — the forms are the product's
 * own (ui-context § 13.5): single numbers in a ruled grid, meters with their marks, one ruled table.
 *
 * It holds no number of its own. Each value is printed by `formatValue`, the way the script and the gate print it,
 * and the three thresholds are the alert rules' (`lib/metrics/dashboard.ts`): a reader sees the bar the product
 * holds itself to, not one made for this panel. Status is by word as well as by colour: a value on the wrong side
 * of its threshold says so in its caption.
 *
 * Nothing here ranks anyone, counts messages per session or measures time on a page (invariant 26).
 */

interface StatsPanelProps {
  readonly stats: ReaderPanelStats;
  readonly locale: Locale;
  readonly releaseId: string;
  /** The window control's two links: the page's own URL with `w` unset, and with `w=all`. */
  readonly hrefs: { readonly month: string; readonly all: string };
  /** Until when the reader's oldest text is kept (feature-specs/21 § 3.2); null when no text is on record. */
  readonly keptUntil: string | null;
  /** The account page's budget meter, unchanged: the reader's cost is what whoever pays for their calls has spent. */
  readonly budget: BudgetView;
}

interface CellProps {
  readonly name: string;
  readonly value: string;
  readonly basis: string;
  /** The threshold's caption, and the words that say the value is on the wrong side of it. */
  readonly threshold?: { readonly text: string; readonly crossed: string | null };
  /** A share's meter: the value and its mark, both in percent. */
  readonly meter?: { readonly value: number; readonly mark: number; readonly ok: boolean; readonly label: string };
}

function Cell({ name, value, basis, threshold, meter }: CellProps) {
  const crossed = threshold !== undefined && threshold.crossed !== null;
  return (
    <div className="stats-cell">
      <span className="cap">{name}</span>
      <span className="cellnum">{value}</span>
      <span className="cap faint">{basis}</span>
      {meter === undefined ? null : <Meter value={meter.value} label={meter.label} tone={crossed ? "fail" : "ink"} marks={[{ at: meter.mark, ok: meter.ok }]} />}
      {threshold === undefined ? null : (
        <span className={cn("cap", crossed && "text-fail")}>
          {threshold.text}
          {threshold.crossed === null ? null : ` · ${threshold.crossed}`}
        </span>
      )}
    </div>
  );
}

export function StatsPanel({ stats, locale, releaseId, hrefs, keptUntil, budget }: StatsPanelProps) {
  const t = useTranslations("assistant.stats");
  const tr = useTranslations("assistant.refusal");
  const share = (value: number | null): string => formatValue("share", value);

  const citation = stats.citationRate;
  const refusal = stats.refusalRate;
  const firstToken = stats.firstTokenP95;
  const floor = share(CITATION_RATE_FLOOR);
  const ceiling = share(REFUSAL_RATE_CEILING);
  const limit = formatValue("ms", FIRST_TOKEN_P95_MS);
  const belowFloor = citation.value !== null && citation.value < CITATION_RATE_FLOOR;
  const aboveCeiling = refusal.value !== null && refusal.value > REFUSAL_RATE_CEILING;
  const overLimit = firstToken.value !== null && firstToken.value > FIRST_TOKEN_P95_MS;
  const causeLabel = (cause: string): string => (tr.has(`cause.${cause}`) ? tr(`cause.${cause}`) : cause);

  const windowLabel = stats.window.kind === "all" ? t("all") : formatMonthYear(monthWindow(stats.window.month).from, locale);

  return (
    <aside className="stats col" aria-label={t("label")}>
      <InstrumentPanel label={t("title")} meta={[{ key: "yours", node: t("yours") }]} timestamp={windowLabel} body="bare" footer={<span>{t("foot", { id: releaseId })}</span>} ariaLabel={t("title")}>
        <nav className="stats-window rb" aria-label={t("windowLabel")}>
          <div className="seg-links">
            <Link href={hrefs.month} aria-current={stats.window.kind === "month" ? "page" : undefined}>
              {t("month")}
            </Link>
            <Link href={hrefs.all} aria-current={stats.window.kind === "all" ? "page" : undefined}>
              {t("all")}
            </Link>
          </div>
        </nav>

        {stats.turns === 0 ? (
          <div className="inst-b">
            <Empty caption={t("title")}>{t("empty")}</Empty>
          </div>
        ) : (
          <>
            <div className="stats-grid">
              <Cell
                name={t("citationRate")}
                value={share(citation.value)}
                basis={t("ofAnswers", { n: citation.n, d: citation.d })}
                threshold={{ text: t("floor", { value: floor }), crossed: belowFloor ? t("belowFloor") : null }}
                meter={{ value: (citation.value ?? 0) * 100, mark: CITATION_RATE_FLOOR * 100, ok: true, label: t("meterLabel", { name: t("citationRate"), value: share(citation.value), mark: t("floor", { value: floor }) }) }}
              />
              <Cell
                name={t("refusalRate")}
                value={share(refusal.value)}
                basis={t("ofTurns", { n: refusal.n, d: refusal.d })}
                threshold={{ text: t("ceiling", { value: ceiling }), crossed: aboveCeiling ? t("aboveCeiling") : null }}
                meter={{ value: (refusal.value ?? 0) * 100, mark: REFUSAL_RATE_CEILING * 100, ok: false, label: t("meterLabel", { name: t("refusalRate"), value: share(refusal.value), mark: t("ceiling", { value: ceiling }) }) }}
              />
              <Cell
                name={t("firstToken")}
                value={formatValue("ms", firstToken.value)}
                basis={t("samples", { n: firstToken.samples })}
                threshold={{ text: t("limit", { value: limit }), crossed: overLimit ? t("overLimit") : null }}
              />
              <Cell name={t("grounded")} value={formatValue("score", stats.grounded.p50)} basis={t("groundedBasis", { p10: formatValue("score", stats.grounded.p10), n: stats.grounded.samples })} />
              <Cell name={t("flagRate")} value={share(stats.flagRate.value)} basis={t("ofTurns", { n: stats.flagRate.n, d: stats.flagRate.d })} />
              <Cell name={t("cacheShare")} value={share(stats.cacheReadShare.value)} basis={stats.payer === "organisation" ? t("payerOrg") : t("payerYou")} />
            </div>

            {stats.refusalsByCause.length === 0 ? null : (
              <div className="inst-b rt">
                <table className="tbl stats-causes">
                  <caption className="cap">{t("byCause")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("thCause")}</th>
                      <th scope="col" className="n">
                        {t("thTurns")}
                      </th>
                      <th scope="col" className="n">
                        {t("thShare")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.refusalsByCause.map((line) => (
                      <tr key={line.cause}>
                        <td>{causeLabel(line.cause)}</td>
                        <td className="n">{line.n}</td>
                        <td className="n">{share(line.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="inst-b rt">
              <dl className="kv">
                <dt>{t("edition")}</dt>
                <dd>{stats.editionMismatch.length === 0 ? "-" : stats.editionMismatch.map((line) => `${String(line.n)} / ${String(line.d)} · ${line.locale}`).join(" · ")}</dd>
                <dt>{t("purged")}</dt>
                <dd>{t("purgedValue", { n: stats.purged })}</dd>
                <dt>{t("keptUntil")}</dt>
                <dd>{keptUntil === null ? "-" : formatDate(new Date(keptUntil), locale)}</dd>
              </dl>
            </div>
          </>
        )}
      </InstrumentPanel>
      <BudgetInstrument budget={budget} locale={locale} />
    </aside>
  );
}
