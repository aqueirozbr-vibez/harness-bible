import { useTranslations } from "next-intl";

import type { Locale } from "@/lib/i18n/routing";
import { gradingOrdinalsOf, predictionKeyOf, type PredictionKey } from "@/lib/improve/scoreView";
import type { EvidenceItemView, SufficientView, SuggestionScoring } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

interface PredictionInstrumentProps {
  readonly locale: Locale;
  /** Null until an item is graded: nothing can be predicted yet. */
  readonly scoring: SuggestionScoring | null;
  readonly items: ReadonlyArray<EvidenceItemView>;
}

const BADGE: Readonly<Record<PredictionKey, string>> = { ACCEPT: "sb-ok", REQUEST_MORE: "sb-warn", REQUEST_MORE_BY_RULE: "sb-warn", DECLINE: "sb-fail", CURATOR: "sb-act" };

/**
 * The right column's Predicted outcome, as the Improve-Suggest screen draws it (feature-specs/34 § 6): the badge
 * (`request more · short by 4`, `accept`, `decline · under the floor`, `curator always · no score decides`), its
 * sentence, the `would suffice` box from the read's `wouldSuffice`, and while an item grades the footer that says the
 * prediction will change. What it says is the read's `predict`; it decides nothing (30 § 4.4).
 */
export function PredictionInstrument({ locale, scoring, items }: PredictionInstrumentProps) {
  const t = useTranslations("improve.suggest.prediction");
  const grading = gradingOrdinalsOf(items);
  const key = scoring === null ? null : predictionKeyOf(scoring.prediction);
  const prediction = scoring?.prediction ?? null;
  const within = (sufficient: SufficientView, short: boolean) => (sufficient.withinDays === null ? "" : t(short ? "suffice.withinShort" : "suffice.within", { days: sufficient.withinDays }));
  const phrase = (sufficient: SufficientView) => t(`suffice.${sufficient.by}`, { tier: sufficient.tier }) + within(sufficient, false);
  const meta = (sufficient: SufficientView) => {
    const name = `${sufficient.tier}${within(sufficient, true)}`;
    if (sufficient.by === "ALONE") return t("suffice.metaAlone", { name, score: sufficient.score });
    if (sufficient.by === "CORROBORATING") return t("suffice.metaCorroborating", { name, strongest: sufficient.score - sufficient.bonus, bonus: sufficient.bonus, score: sufficient.score });
    return t(sufficient.by === "CORROBORATED" ? "suffice.metaStrongest" : "suffice.metaTwo", { name, adjusted: sufficient.adjusted, bonus: sufficient.bonus, score: sufficient.score });
  };
  const sufficient = scoring?.wouldSuffice ?? [];
  const list = sufficient.map(phrase).join(t("suffice.or"));
  return (
    <section className="inst" aria-labelledby="prediction-title">
      <div className="inst-h">
        <h2 className="t" id="prediction-title">
          {t("title")}
        </h2>
        <span className="ts">{t("when")}</span>
      </div>
      <div className="inst-b col prediction-body">
        {key === null || prediction === null ? (
          <p className="small muted">{t("say.none")}</p>
        ) : (
          <>
            <span className={cn("st-block prediction-badge", BADGE[key])}>{t(`badge.${key}`, { n: prediction.shortBy ?? 0, tier: prediction.namedTier ?? "A" })}</span>
            <p className="small">{t(`say.${key}`, { accept: prediction.acceptAt ?? 0, floor: prediction.floorAt ?? 0, tier: prediction.namedTier ?? "A" })}</p>
            {sufficient.length > 0 ? (
              <div className="col prediction-suffice">
                <span className="cap">{t("suffice.title")}</span>
                <p className="small">{`${list.charAt(0).toLocaleUpperCase(locale)}${list.slice(1)}.`}</p>
                <span className="meta faint">{sufficient.map(meta).join(" · ")}</span>
              </div>
            ) : null}
          </>
        )}
      </div>
      {grading.length > 0 ? (
        <div className="inst-f">
          <span>{t("grading", { count: grading.length, items: grading.join(", ") })}</span>
        </div>
      ) : null}
    </section>
  );
}
