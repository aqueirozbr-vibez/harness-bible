import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { Meter } from "@/components/ui/Meter";
import { Xref } from "@/components/ui/Xref";
import type { BudgetConsumer, BudgetView } from "@/lib/budget/view";
import { formatDayMonth, formatMillions, formatMonthYear, formatPercent } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { cn } from "@/lib/utils";

/*
 * The model budget meter (feature-specs/21 § 4.2; the Account-Admin screen's `Model budget` instrument): how much
 * of the month's cap is used, when the cap lands at this pace, and who used it. Every signed-in user reads it on
 * their own account page; the admin's `Change cap` arrives in Phase 4.
 *
 * Nothing is computed here: `budgetView` built every number from the rows the gateway's calls wrote (invariants 12
 * and 17), and this component formats them. The page never calls the gateway (invariant 6).
 */

/** The chapter that explains the gateway and its hard caps. */
const GATEWAY_CHAPTER = 23;

const NOTE_KEY: Record<Exclude<BudgetConsumer, "assistant" | "grading" | "adjudication">, string> = { research: "researchNote", retrieval: "retrievalNote", labs: "labsNote" };

/** The rows a reader who never contributed has nothing in, which read faint at zero: the labs until Phase 3 adds theirs, grading and adjudication (38 § 2), and research until the person's first run spends (feature-specs/48 § 7.1). */
const FAINT_AT_ZERO: ReadonlySet<BudgetConsumer> = new Set(["labs", "grading", "adjudication", "research"]);

interface BudgetInstrumentProps {
  readonly budget: BudgetView;
  readonly locale: Locale;
}

export function BudgetInstrument({ budget, locale }: BudgetInstrumentProps) {
  const t = useTranslations("account.budget");
  const used = formatMillions(budget.used, locale);
  const cap = budget.cap === null ? null : formatMillions(budget.cap, locale);
  const reset = formatDayMonth(new Date(budget.resetsAt), locale);
  const atCap = budget.state === "atcap";

  const notice =
    budget.state === "nocap"
      ? null
      : budget.state === "empty"
        ? t("nothing")
        : atCap
          ? t("atCap", { reset })
          : budget.capDate === null
            ? t("noProjection")
            : t("projection", { perDay: formatMillions(budget.perDay, locale, 3), date: formatDayMonth(new Date(budget.capDate), locale) });

  return (
    <section id="budget" className="col" style={{ scrollMarginTop: 16 }}>
      <InstrumentPanel
        label={t("title")}
        meta={[
          {
            key: "gateway",
            node: (
              <>
                {t("gateway")} <Xref href={`/${locale}/ch/${String(GATEWAY_CHAPTER)}`}>{t("chapter", { n: GATEWAY_CHAPTER })}</Xref>
              </>
            ),
          },
        ]}
        timestamp={t("resets", { date: reset })}
        className="account-inst budget-inst"
        footer={<span>{t("footer")}</span>}
      >
        <div className="col gap-s3">
          <span className="cap">{t("used", { month: formatMonthYear(new Date(budget.monthStart), locale) })}</span>
          <div className="budget-head">
            <span className="bignum">{budget.percent === null ? used : `${formatPercent(budget.percent, locale)}%`}</span>
            <span className="meta">{cap === null ? t("tokens") : t("of", { used, cap })}</span>
          </div>
          <div className="col gap-s1">
            {budget.cap === null ? (
              /* No cap, no scale: the frame stays so the instrument keeps its shape, and it measures nothing. */
              <div className="meter budget-meter" aria-hidden="true" />
            ) : (
              <Meter
                className="budget-meter"
                value={Math.min(budget.used, budget.cap)}
                max={budget.cap}
                tone={atCap ? "fail" : "ink"}
                label={t("meterLabel", { used, cap: cap ?? "" })}
                marks={[{ at: budget.cap }]}
              />
            )}
            <div className="between meta budget-scale">
              <span className="faint">0</span>
              {budget.left === null || cap === null ? (
                <span className="faint">{t("noCap")}</span>
              ) : (
                <>
                  <span className="faint">{t("left", { left: formatMillions(budget.left, locale) })}</span>
                  <span className="text-fail">{t("cap", { cap })}</span>
                </>
              )}
            </div>
          </div>
          {notice === null ? null : (
            <p className={cn("small budget-notice", atCap ? "error text-fail" : "notice")} role={atCap ? "status" : undefined}>
              {notice}
            </p>
          )}
          <table className="tbl budget-breakdown">
            <caption className="cap">{t("breakdown")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("consumer")}</th>
                <th scope="col" className="n">
                  {t("tokens")}
                </th>
                <th scope="col" className="n">
                  {t("share")}
                </th>
              </tr>
            </thead>
            <tbody>
              {budget.rows.map((row) => {
                /* A row with nothing in it reads faint: in Phase 2 the labs make no model calls (Phase 3 adds them by lab), and a reader who never contributed has no grading and no adjudication. */
                const faint = FAINT_AT_ZERO.has(row.consumer) && row.tokens === 0;
                /* What the row served, beside it (the screen's `· 1,206 answers`): the answers for the assistant, the suggestions for Improve's two rows (38 § 2). */
                const served = row.consumer === "assistant" ? t("answers", { n: budget.answers }) : row.consumer === "grading" || row.consumer === "adjudication" ? t("suggestions", { n: budget.suggestions[row.consumer] }) : t(NOTE_KEY[row.consumer]);
                return (
                  <tr key={row.consumer}>
                    <td className={cn(faint && "faint")}>
                      {t(row.consumer)}{" "}
                      <span className="faint small">· {served}</span>
                    </td>
                    <td className={cn("n", faint && "faint")}>{formatMillions(row.tokens, locale)}</td>
                    <td className={cn("n", faint && "faint")}>{row.share === null ? "—" : `${formatPercent(row.share, locale)}%`}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>{t("total")}</td>
                <td className="n">{used}</td>
                <td className="n">{budget.share === null ? "—" : `${formatPercent(budget.share, locale)}%`}</td>
              </tr>
            </tfoot>
          </table>
          <p className="meta faint budget-unit">{t("unit")}</p>
        </div>
      </InstrumentPanel>
    </section>
  );
}
