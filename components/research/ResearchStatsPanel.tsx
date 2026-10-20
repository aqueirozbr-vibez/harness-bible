import { useTranslations } from "next-intl";
import Link from "next/link";

import { BudgetInstrument } from "@/components/account/BudgetInstrument";
import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { Empty } from "@/components/ui/Empty";
import type { BudgetView } from "@/lib/budget/view";
import { formatDate, formatMonthYear } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { monthWindow } from "@/lib/metrics/assistant";
import { usdText, type ResearchStats } from "@/lib/research/stats";

/*
 * The person's research statistics (feature-specs/48 § 11.6, A9; unit 73): the Research page's third region, the
 * Assistant page's statistics in form (spec 25 § 5) — a window control, single numbers in a ruled grid, each with the
 * line that breaks it down — and research in them. A server component: `lib/research/stats.ts` counted every number
 * from the person's own rows, which the tenant guard filtered, and this file words them. A cell with nothing reads `—`.
 *
 * Five cells: the runs and how they ended — runs, not researches, which the list counts (review of unit 73); what they
 * cost, in all and per run charged; the sources they read; the findings that passed the checks, were turned into
 * improvements and were accepted; the reports and refusals flagged, a rule's refusal's among them, so a window whose
 * only run is a flagged rule's refusal shows the cells rather than the empty line.
 * Under them the line that says until when research text is kept, from the oldest held, as the Assistant's statistics
 * say theirs; then the account's budget meter, with its `research` row, unchanged: research is spent from the same
 * budget as everything else the person does.
 *
 * Nothing here ranks anyone or measures time on a page (invariant 26).
 */

interface ResearchStatsPanelProps {
  readonly stats: ResearchStats;
  readonly window: { readonly kind: "month"; readonly month: string } | { readonly kind: "all" };
  readonly locale: Locale;
  /** The window control's two links: the page's own URL with `w` unset, and with `w=all`. */
  readonly hrefs: { readonly month: string; readonly all: string };
  /** Until when the oldest research text held is kept (§ 17.1); null when none is held. */
  readonly keptUntil: string | null;
  readonly budget: BudgetView;
}

interface CellProps {
  readonly name: string;
  readonly value: string;
  /** What the number is made of, a part a row; none where the number says it all. */
  readonly parts?: ReadonlyArray<string>;
}

function Cell({ name, value, parts = [] }: CellProps) {
  return (
    <div className="stats-cell">
      <span className="cap">{name}</span>
      <span className="cellnum">{value}</span>
      {parts.length === 0 ? null : (
        /* one part to a row: in a cell some 117px wide, a run-on line parts a count from its word ("2 / refused") */
        <span className="cap faint col">
          {parts.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </span>
      )}
    </div>
  );
}

const NONE = "—";

/** A line of § 19's, `3 done · 2 refused · …`, as its parts: the catalogue writes it as one sentence, the cell a part a row. */
function partsOf(line: string): ReadonlyArray<string> {
  return line.split(" · ");
}

export function ResearchStatsPanel({ stats, window, locale, hrefs, keptUntil, budget }: ResearchStatsPanelProps) {
  const t = useTranslations("research.stats");
  const tw = useTranslations("assistant.stats");
  const windowLabel = window.kind === "all" ? tw("all") : formatMonthYear(monthWindow(window.month).from, locale);
  const { cost, sources, findings } = stats;

  return (
    <aside className="stats col" aria-label={t("title")}>
      <InstrumentPanel label={t("title")} timestamp={windowLabel} body="bare">
        <nav className="stats-window rb" aria-label={tw("windowLabel")}>
          <div className="seg-links">
            <Link href={hrefs.month} aria-current={window.kind === "month" ? "page" : undefined}>
              {tw("month")}
            </Link>
            <Link href={hrefs.all} aria-current={window.kind === "all" ? "page" : undefined}>
              {tw("all")}
            </Link>
          </div>
        </nav>

        {stats.runs === 0 && stats.flagged === 0 ? (
          <div className="inst-b">
            <Empty caption={t("title")}>{t("empty")}</Empty>
          </div>
        ) : (
          <div className="stats-grid">
            <Cell name={t("runs")} value={String(stats.runs)} parts={partsOf(t("ends", stats.ends))} />
            <Cell name={t("cost")} value={cost.total === null ? NONE : t("usd", { cost: usdText(cost.total) })} parts={cost.perRun === null ? [] : [t("perRun", { cost: usdText(cost.perRun) })]} />
            <Cell name={t("sources")} value={String(sources.opened)} parts={[t("searches", { n: sources.searches }), t("pagesOpened", { n: sources.opened }), sources.seen === null ? t("pagesSeenNone") : t("pagesSeen", { n: sources.seen })]} />
            <Cell name={t("findings")} value={String(findings.passed)} parts={partsOf(t("findingsLine", findings))} />
            <Cell name={t("flagged")} value={String(stats.flagged)} />
          </div>
        )}

        {keptUntil === null ? null : (
          <div className="inst-b rt">
            <p className="small">{t("keptUntil", { date: formatDate(new Date(keptUntil), locale) })}</p>
          </div>
        )}
      </InstrumentPanel>
      <BudgetInstrument budget={budget} locale={locale} />
    </aside>
  );
}
