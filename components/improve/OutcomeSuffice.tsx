import { useTranslations } from "next-intl";

import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import type { SufficientView, SuggestionView } from "@/lib/schemas/suggestions";

interface OutcomeSufficeProps {
  readonly view: SuggestionView;
}

/**
 * The page's What would suffice (feature-specs/35 § 4): one more item of each tier `wouldSuffice` names, as the edit
 * page words it, with the score it would make; or the one tier a rule named. Absent once nothing more is needed.
 */
export function OutcomeSuffice({ view }: OutcomeSufficeProps) {
  const t = useTranslations("improve.outcome.suffice");
  const ts = useTranslations("improve.suggest.prediction.suffice");
  const tr = useTranslations("rubric");
  const sufficient: ReadonlyArray<SufficientView> = view.scoring?.wouldSuffice ?? [];
  const named = view.adjudication?.sufficientTier ?? null;
  if (sufficient.length === 0 && named === null) return null;
  const accept = view.adjudication?.acceptAt ?? view.thresholds.acceptAt;
  return (
    <section className="inst" aria-labelledby="outcome-suffice-title">
      <div className="inst-h">
        <h2 className="t" id="outcome-suffice-title">
          {t("title")}
        </h2>
        {accept !== null ? <span className="ts">{t("accept", { n: accept })}</span> : null}
      </div>
      <div className="inst-b col outcome-suffice">
        {sufficient.length > 0 ? (
          sufficient.map((one) => (
            <div key={`${one.tier}-${one.by}`} className="row outcome-suffice-row">
              <EvidenceBadge tier={one.tier} label={tr("tiers.badge", { tier: one.tier, name: tr(`tiers.name.${one.tier}`) })} />
              <div className="grow col">
                <span className="small">{ts(one.by, { tier: one.tier }) + (one.withinDays === null ? "" : ts("within", { days: one.withinDays }))}</span>
                <span className="help">{t(`how.${one.by}`, { adjusted: one.adjusted, bonus: one.bonus })}</span>
              </div>
              <span className="score">{one.score}</span>
            </div>
          ))
        ) : named !== null ? (
          <div className="row outcome-suffice-row">
            <EvidenceBadge tier={named} label={tr("tiers.badge", { tier: named, name: tr(`tiers.name.${named}`) })} />
            <span className="small grow">{t("named", { tier: named })}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
