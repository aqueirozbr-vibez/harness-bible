import { useTranslations } from "next-intl";

import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import { formatFactor } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { ageOf, locationOf } from "@/lib/improve/evidenceView";
import { bandOf, computedRowsOf } from "@/lib/improve/scoreView";
import type { SuggestionView } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

interface QueueEvidenceProps {
  readonly locale: Locale;
  readonly view: SuggestionView;
}

const BAND_TEXT = { under: "text-fail", between: "text-warn", accepted: "queue-ok" } as const;

/**
 * The detail's Evidence (feature-specs/36 § 4; the Curator-Queue screen): the table of `# · item · tier · base · rel
 * · rec · ind · score`, a factor under one in the warning colour; the strongest-plus-corroboration line and the
 * score; and the band — under the floor, between, accepted — with the floor, the score and the acceptance marked.
 */
export function QueueEvidence({ locale, view }: QueueEvidenceProps) {
  const t = useTranslations("improve.queue.evidence");
  const te = useTranslations("improve.suggest.evidence");
  const tr = useTranslations("rubric");
  const { scoring, thresholds } = view;
  const rows = scoring === null ? [] : computedRowsOf(scoring, view.evidence);
  const strongest = rows.find((row) => row.kind === "strongest" || row.kind === "alone");
  const corroboration = rows.find((row) => row.kind === "corroboration");
  const score = scoring?.score ?? view.score;
  const band = score === null ? null : bandOf(score, thresholds);
  const factor = (value: number | null) => (value === null ? "—" : <span className={cn(value < 1 && "text-warn")}>{formatFactor(value, locale)}</span>);
  const at = (value: number): string => `${Math.max(0, Math.min(100, value))}%`;
  return (
    <section className="inst" aria-labelledby="queue-evidence-title">
      <div className="inst-h">
        <h2 className="t" id="queue-evidence-title">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{t("rubric", { version: view.rubricVersion })}</span>
        <span className="ts">{t("cap")}</span>
      </div>
      {view.evidence.length === 0 ? (
        <p className="inst-b small muted">{t("none")}</p>
      ) : (
        /* seven columns are wider than a phone: the table scrolls in a region of its own there, as the roster does (unit 60d's truncation run) */
        <div className="roster-scroll" role="region" aria-label={t("table")} tabIndex={0}>
        <table className="tbl queue-evidence">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t("item")}</th>
              <th scope="col">{t("tier")}</th>
              <th scope="col" className="n">
                {t("base")}
              </th>
              <th scope="col" className="n">
                {t("rel")}
              </th>
              <th scope="col" className="n">
                {t("rec")}
              </th>
              <th scope="col" className="n">
                {t("ind")}
              </th>
              <th scope="col" className="n">
                {t("score")}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.evidence.map((item) => {
              const age = item.ageDays === null ? null : ageOf(item.ageDays);
              return (
                <tr key={item.id}>
                  <td className="mono">{item.ordinal}</td>
                  <td className="queue-evidence-what">
                    {item.title ?? locationOf(item) ?? item.fileName ?? te(`kind.${item.kind}`)}
                    {age !== null ? (
                      <>
                        <br />
                        <span className="faint small">{te(`status.${age.unit === "day" ? "days" : age.unit === "month" ? "months" : "years"}`, { n: age.n })}</span>
                      </>
                    ) : null}
                  </td>
                  <td>{item.tier !== null ? <EvidenceBadge tier={item.tier} label={tr("tiers.badge", { tier: item.tier, name: tr(`tiers.name.${item.tier}`) })} /> : <span className="faint">{te("grading")}</span>}</td>
                  <td className="n">{item.baseScore ?? "—"}</td>
                  <td className="n">{factor(item.relevance)}</td>
                  <td className="n">{factor(item.recency)}</td>
                  <td className="n">{factor(item.independence)}</td>
                  <td className={cn("n", item.id === scoring?.strongestItemId && "queue-strongest")}>{item.adjustedScore ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
          {strongest !== undefined ? (
            <tfoot>
              <tr>
                <td colSpan={7}>{corroboration !== undefined && corroboration.kind === "corroboration" ? t("sumCorroborated", { strongest: strongest.score, bonus: corroboration.bonus, n: corroboration.ordinal, tier: corroboration.tier }) : t("sum", { strongest: strongest.score })}</td>
                <td className={cn("n queue-total", band !== null && BAND_TEXT[band])}>{score ?? "—"}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
        </div>
      )}
      {score !== null && thresholds.floorAt !== null && thresholds.acceptAt !== null ? (
        <div className="queue-band-wrap">
          {/* The band's three zones and its marks sit where the thresholds and the score put them: data-driven positions, inline. */}
          <div className="queue-band" role="img" aria-label={t("band", { score, floor: thresholds.floorAt, accept: thresholds.acceptAt })}>
            <i className="queue-band-under" style={{ width: at(thresholds.floorAt) }} />
            <i className="queue-band-between" style={{ left: at(thresholds.floorAt), width: at(thresholds.acceptAt - thresholds.floorAt) }} />
            <i className="queue-band-accepted" style={{ left: at(thresholds.acceptAt), width: at(100 - thresholds.acceptAt) }} />
            <span className="queue-band-tick" style={{ left: at(thresholds.floorAt) }} />
            <span className="queue-band-tick is-accept" style={{ left: at(thresholds.acceptAt) }} />
            <span className={cn("queue-band-score", band !== null && `is-${band}`)} style={{ left: at(score) }} />
          </div>
          <div className="meta queue-band-labels" aria-hidden="true">
            <span>0</span>
            <span>{t("floor", { floor: thresholds.floorAt })}</span>
            <span>{t("accept", { accept: thresholds.acceptAt })}</span>
            <span>100</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
