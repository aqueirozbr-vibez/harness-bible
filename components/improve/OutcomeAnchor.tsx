import { useTranslations } from "next-intl";

import { EvidenceStatus } from "@/components/improve/EvidenceStatus";
import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import { formatFactor } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { locationOf } from "@/lib/improve/evidenceView";
import { changeOf } from "@/lib/improve/outcomeView";
import type { SuggestionView } from "@/lib/schemas/suggestions";

interface OutcomeAnchorProps {
  readonly locale: Locale;
  readonly view: SuggestionView;
  /** The chapter's version the anchor is read at. */
  readonly version: string;
}

/**
 * The page's Anchor (feature-specs/35 § 4; the screen's anchored text, before and after): the anchored text quoted, the
 * change as `before · current` and `after · proposed`, and the evidence as graded so far, each item with its tier
 * badge, where it is, its arithmetic and how it was opened. The anchored text, the before and the after are the book's
 * English, which the anchor holds whichever edition the page serves, and are marked so (the 52c review).
 */
export function OutcomeAnchor({ locale, view, version }: OutcomeAnchorProps) {
  const t = useTranslations("improve.outcome.anchor");
  const te = useTranslations("improve.suggest.evidence");
  const tr = useTranslations("rubric");
  const change = changeOf(view);
  /* A figure's id does not name its section; a row's does (`15.9 r1`), and a section is its own. */
  const where = view.anchor.kind === "FIGURE" ? `${view.anchor.section} ${view.anchor.id}` : view.anchor.id;
  return (
    <section className="inst outcome-anchor" aria-labelledby="outcome-anchor-title">
      <div className="inst-h">
        <h2 className="t" id="outcome-anchor-title">
          {t("title", { where })}
        </h2>
        <span className="sep">·</span>
        <span>{version}</span>
        <span className="ts">{t(view.anchor.existsAtVersion ? "exists" : "changed")}</span>
      </div>
      <div className="inst-b col outcome-anchor-body">
        <blockquote className="outcome-quote" lang="en">
          <p>{change.quote}</p>
        </blockquote>
        {change.after !== null ? (
          <table className="tbl outcome-change">
            <tbody>
              {change.before !== null ? (
                <tr>
                  <th scope="row" className="meta">
                    {t("before")}
                  </th>
                  <td lang="en">{change.before}</td>
                </tr>
              ) : null}
              <tr className="row-new">
                <th scope="row" className="meta">
                  {t("after")}
                </th>
                <td className="d-new" lang="en">
                  {change.after}
                </td>
              </tr>
            </tbody>
          </table>
        ) : null}
        {view.evidence.length === 0 ? (
          <p className="small muted">{t("noEvidence")}</p>
        ) : (
          <ul className="col outcome-evidence" aria-label={t("evidence")}>
            {view.evidence.map((item) => (
              <li key={item.id} className="row outcome-evidence-item">
                {item.tier !== null ? <EvidenceBadge tier={item.tier} label={tr("tiers.badge", { tier: item.tier, name: tr(`tiers.name.${item.tier}`) })} /> : <span className="ev evidence-tier-pending" role="img" aria-label={te("tierPending")}>·</span>}
                <div className="grow col outcome-evidence-what">
                  <span className="small">{item.title ?? locationOf(item) ?? item.fileName ?? te(`kind.${item.kind}`)}</span>
                  {item.baseScore !== null && item.relevance !== null && item.recency !== null && item.independence !== null && item.adjustedScore !== null ? (
                    <span className="mono outcome-evidence-math">
                      {item.baseScore} × {formatFactor(item.relevance, locale)} × {formatFactor(item.recency, locale)} × {formatFactor(item.independence, locale)} = {item.adjustedScore}
                    </span>
                  ) : null}
                </div>
                <EvidenceStatus item={item} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
