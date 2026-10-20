import { useTranslations } from "next-intl";

import { OUTCOME_BADGE } from "@/components/improve/OutcomeDecision";
import type { OutcomeVariant } from "@/lib/improve/outcomeView";
import type { SuggestionView } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

interface RecordDecisionProps {
  readonly view: SuggestionView;
  readonly variant: OutcomeVariant;
}

const TONE: Readonly<Record<OutcomeVariant, string | null>> = { withdrawing: null, withdrawn: null, progress: null, budget: "is-warn", declined: "is-fail", requestMore: "is-warn", requestMoreByRule: "is-warn", curator: "is-warn", recommended: null, accepted: "is-ok", checkFailed: "is-warn", notProposed: null, closed: null };

/**
 * The record's Decision (feature-specs/35 § 5; the Improve-Record screen): the score against the acceptance, the
 * outcome's badge, the floor and whether every sensor passed, in its outcome's colour. Under way, no decision: a
 * revision keeps the earlier attempt's row until its own (33 § 6.4).
 */
export function RecordDecision({ view, variant }: RecordDecisionProps) {
  const t = useTranslations("improve.record.decision");
  const tb = useTranslations("improve.outcome.decision.badge");
  const tn = useTranslations("improve.outcome.sensors.name");
  const underWay = variant === "progress" || variant === "budget";
  const decision = underWay ? null : view.adjudication;
  const score = decision?.score ?? view.score;
  const accept = decision?.acceptAt ?? view.thresholds.acceptAt;
  const floor = decision?.floorAt ?? view.thresholds.floorAt;
  const failed = view.sensors.find((verdict) => verdict.result === "FAIL") ?? null;
  const sensors = view.sensors.length === 0 ? null : failed === null ? t("sensorsPass") : t("sensorFailed", { sensor: tn(failed.sensor) });
  return (
    <section className={cn("inst record-decision", TONE[variant])} aria-labelledby="record-decision-title">
      <div className="inst-h">
        <h2 className="t" id="record-decision-title">
          {t("title")}
        </h2>
        <span className="ts">{t("rubric", { version: decision?.rubricVersion ?? view.rubricVersion })}</span>
      </div>
      <div className="inst-b col record-panel-body">
        <div className="row record-score-row">
          <span className="midnum record-score">{score ?? "—"}</span>
          {score !== null && accept !== null ? <span className="meta">{t(score >= accept ? "reached" : "under", { accept })}</span> : null}
        </div>
        <span className={cn("st-block record-badge", OUTCOME_BADGE[variant])}>{tb(variant === "accepted" && (view.state === "MERGED" || view.state === "MERGING") ? view.state : variant)}</span>
        <span className="meta">{[floor === null ? null : t("floor", { floor }), sensors].filter((part) => part !== null).join(" · ")}</span>
      </div>
    </section>
  );
}
