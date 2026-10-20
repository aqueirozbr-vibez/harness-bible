import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusBar } from "@/components/chrome/StatusBar";
import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import type { ResearchLogData } from "@/lib/db/researchLog";
import { formatDayMonth, formatMonthYear, formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";

interface ResearchLogProps {
  readonly locale: Locale;
  readonly data: Extract<ResearchLogData, { kind: "page" }>;
  readonly loadedMs: number;
}

/** The month's columns, in the table's order (43 § 7.2). */
/* `refused`, `valid` and `sent` since unit 74 (feature-specs/48 § 10.3): what a person's runs fill; the three after `sent` only the legacy runs do */
const COLUMNS = ["runs", "nothing", "refused", "failed", "invalid", "valid", "sent", "duplicate", "refuted", "proposed", "searches", "pageReads"] as const;

/**
 * The research log (feature-specs/43 § 7.2; unit 60d): what the researcher ran, found and proposed, month by month for
 * twelve months, and the proposals Improve refuted or a curator declined with what closed each, linking to its record.
 * Each table scrolls in a focusable region of its own on a phone, as the roster does. No asker is named anywhere: the
 * rows are the ledger's and the platform's. A curator reads it; there is no action on it — a curator who disagrees with a
 * refutation writes a suggestion.
 */
export function ResearchLog({ locale, data, loadedMs }: ResearchLogProps) {
  const t = useTranslations("improve.researchLog");
  const tn = useTranslations("improve.outcome.sensors.name");
  const tr = useTranslations("rubric");
  const tc = useTranslations("rubric.thresholds.class");
  const th = useTranslations("home.statusbar");
  const empty = data.months.every((month) => month.runs === 0) && data.refuted.length === 0;
  return (
    <>
      <main className="col research-log">
        <div className="col research-log-head">
          <span className="cap">{t("cap")}</span>
          <h1 className="h1">{t("title")}</h1>
          <p className="muted">{t("what")}</p>
          <Link className="xref" href={`/${locale}/improve/queue`}>
            {t("queue")}
          </Link>
        </div>
        {empty ? (
          <div className="empty research-log-empty">
            <span className="h4">{t("empty")}</span>
          </div>
        ) : (
          <>
            <section className="col research-log-months" aria-labelledby="research-log-months-title">
              <h2 className="h4" id="research-log-months-title">
                {t("months.title")}
              </h2>
              <div className="roster-scroll" role="region" aria-label={t("months.table")} tabIndex={0}>
                <table className="tbl research-log-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("months.month")}</th>
                      {COLUMNS.map((column) => (
                        <th key={column} scope="col" className="n">
                          {t(`months.${column}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.months.map((month) => (
                      <tr key={month.month}>
                        <th scope="row">{formatMonthYear(new Date(`${month.month}-01T00:00:00.000Z`), locale)}</th>
                        {COLUMNS.map((column) => (
                          <td key={column} className="n">
                            {month[column]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="col research-log-refuted" aria-labelledby="research-log-refuted-title">
              <h2 className="h4" id="research-log-refuted-title">
                {t("refuted.title")}
              </h2>
              {data.refuted.length === 0 ? (
                <p className="small muted">{t("refuted.none")}</p>
              ) : (
                <div className="roster-scroll" role="region" aria-label={t("refuted.table")} tabIndex={0}>
                  <table className="tbl research-log-table">
                    <thead>
                      <tr>
                        <th scope="col">{t("refuted.date")}</th>
                        <th scope="col">{t("refuted.id")}</th>
                        <th scope="col">{t("refuted.anchor")}</th>
                        <th scope="col">{t("refuted.class")}</th>
                        <th scope="col">{t("refuted.tier")}</th>
                        <th scope="col" className="n">
                          {t("refuted.score")}
                        </th>
                        <th scope="col">{t("refuted.by")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.refuted.map((line) => (
                        <tr key={line.id}>
                          <td className="m">{line.closedAt === null ? "—" : formatDayMonth(new Date(line.closedAt), locale)}</td>
                          <td className="m">
                            <Link className="xref" href={`/${locale}/improve/${line.id}/record`}>
                              {line.id}
                            </Link>
                          </td>
                          <td className="m">{line.anchor}</td>
                          <td>{tc(line.changeClass)}</td>
                          <td>{line.tier === null ? "—" : <EvidenceBadge tier={line.tier} label={tr("tiers.badge", { tier: line.tier, name: tr(`tiers.name.${line.tier}`) })} />}</td>
                          <td className="n">{line.score === null ? "—" : t("refuted.scoreLine", { score: line.score, floor: line.floorAt ?? "—", accept: line.acceptAt ?? "—" })}</td>
                          <td>{line.by === "sensor" ? t("refutedBy.sensor", { sensor: line.sensor === null ? "—" : tn(line.sensor) }) : t(`refutedBy.${line.by}`)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("statusbar", { release: data.release.id })}</span>
      </StatusBar>
    </>
  );
}
