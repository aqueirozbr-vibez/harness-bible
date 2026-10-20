import { useTranslations } from "next-intl";

import { EvidenceStatus } from "@/components/improve/EvidenceStatus";
import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import { formatFactor } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { locationOf } from "@/lib/improve/evidenceView";
import type { SuggestionView } from "@/lib/schemas/suggestions";

interface RecordEvidenceProps {
  readonly locale: Locale;
  readonly evidence: SuggestionView["evidence"];
}

/**
 * The record's Evidence (feature-specs/35 § 5; the Improve-Record screen): each item with its tier, what it is, its
 * arithmetic and how it was read, as the suggestion's own page shows them.
 */
export function RecordEvidence({ locale, evidence }: RecordEvidenceProps) {
  const t = useTranslations("improve.record.evidence");
  const te = useTranslations("improve.suggest.evidence");
  const tr = useTranslations("rubric");
  return (
    <section className="inst" aria-labelledby="record-evidence-title">
      <div className="inst-h">
        <h2 className="t" id="record-evidence-title">
          {t("title")}
        </h2>
        <span className="ts">{t("count", { n: evidence.length })}</span>
      </div>
      {evidence.length === 0 ? (
        <p className="inst-b small muted">{t("none")}</p>
      ) : (
        <ul className="inst-b col record-items">
          {evidence.map((item) => (
            <li key={item.id} className="col record-item">
              <div className="row record-item-head">
                {item.tier !== null ? <EvidenceBadge tier={item.tier} label={tr("tiers.badge", { tier: item.tier, name: tr(`tiers.name.${item.tier}`) })} /> : <span className="ev evidence-tier-pending" role="img" aria-label={te("tierPending")}>·</span>}
                <span className="small record-item-what">{item.title ?? locationOf(item) ?? item.fileName ?? te(`kind.${item.kind}`)}</span>
              </div>
              {item.baseScore !== null && item.relevance !== null && item.recency !== null && item.independence !== null && item.adjustedScore !== null ? (
                <span className="mono outcome-evidence-math">
                  {item.baseScore} × {formatFactor(item.relevance, locale)} × {formatFactor(item.recency, locale)} × {formatFactor(item.independence, locale)} = {item.adjustedScore}
                </span>
              ) : null}
              <EvidenceStatus item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
