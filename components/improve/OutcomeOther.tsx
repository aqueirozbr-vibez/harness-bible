import { useTranslations } from "next-intl";
import Link from "next/link";

import { OUTCOME_BADGE } from "@/components/improve/OutcomeDecision";
import { OutcomeRequest } from "@/components/improve/OutcomeRequest";
import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import { Meter } from "@/components/ui/Meter";
import type { OtherOpen } from "@/lib/db/improveOutcome";
import { formatDateTime, formatFactor } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { locationOf } from "@/lib/improve/evidenceView";
import { changeOf, variantOf } from "@/lib/improve/outcomeView";
import { bandOf } from "@/lib/improve/scoreView";
import { cn } from "@/lib/utils";

interface OutcomeOtherProps {
  readonly locale: Locale;
  readonly other: OtherOpen;
}

const METER_TONE = { under: "fail", between: "warn", accepted: "ver" } as const;

/**
 * `also yours · open` (feature-specs/35 § 4; the screen's right column for `S-22-0356`): the owner's most recent other
 * open suggestion, compact — its id linked to its own page and its badge; its chapter and where it is anchored, with
 * when it was decided; the anchor's text and the change; the score against the acceptance with its strongest item;
 * and, asked for more by rule, the request.
 */
export function OutcomeOther({ locale, other }: OutcomeOtherProps) {
  const t = useTranslations("improve.outcome.other");
  const tb = useTranslations("improve.outcome.decision.badge");
  const ta = useTranslations("improve.outcome.anchor");
  const tc = useTranslations("rubric.thresholds.class");
  const tr = useTranslations("rubric");
  const te = useTranslations("improve.suggest.evidence");
  const { view, context } = other;
  const variant = variantOf(view);
  const underWay = variant === "progress" || variant === "budget";
  const decision = underWay ? null : view.adjudication;
  const change = changeOf(view);
  const score = decision?.score ?? view.scoring?.score ?? view.score;
  const accept = decision?.acceptAt ?? view.thresholds.acceptAt;
  const floor = decision?.floorAt ?? view.thresholds.floorAt;
  const band = score === null ? null : bandOf(score, { ...view.thresholds, acceptAt: accept, floorAt: floor });
  const strongest = view.evidence.find((item) => item.id === view.scoring?.strongestItemId) ?? null;
  const { strip } = context.page;
  const where = view.anchor.kind === "FIGURE" ? `${view.anchor.section} ${view.anchor.id}` : view.anchor.id;
  const when = decision !== null ? t("decided", { at: formatDateTime(new Date(decision.decidedAt), locale) }) : view.submittedAt !== null ? t("submitted", { at: formatDateTime(new Date(view.submittedAt), locale) }) : null;
  return (
    <section className="col outcome-other" aria-labelledby="outcome-other-title">
      <div className="col outcome-other-head">
        <span className="cap">{t("cap")}</span>
        <div className="between">
          <h2 className="h4" id="outcome-other-title">
            <Link className="xref" href={`/${locale}/improve/${view.id}`}>
              {view.id}
            </Link>
          </h2>
          <span className={cn("st-block", OUTCOME_BADGE[variant])}>{tb(variant === "accepted" && (view.state === "MERGED" || view.state === "MERGING") ? view.state : variant)}</span>
        </div>
        <span className="meta">
          {t("chapter", { n: strip.chapter.digits })} · <span lang={context.contentLang}>{strip.chapter.title}</span> · {strip.chapter.version}
        </span>
        <span className="meta faint">
          {view.anchor.section} <span lang={context.contentLang}>{context.sectionTitle}</span>
          {when !== null ? ` · ${when}` : null}
        </span>
      </div>
      <section className="inst" aria-labelledby="outcome-other-anchor">
        <div className="inst-h">
          <h3 className="t" id="outcome-other-anchor">
            {ta("title", { where })}
          </h3>
          <span className="ts">{tc(view.changeClass)}</span>
        </div>
        <div className="inst-b col outcome-other-body">
          <p className="small outcome-other-quote" lang={context.contentLang}>
            {change.quote}
          </p>
          {view.proposal?.kind === "SET_VALUE" && change.before !== null && change.after !== null ? (
            <div className="row outcome-other-change">
              <span className="mono outcome-other-was">{change.before}</span>
              <span className="faint mono" aria-hidden="true">
                →
              </span>
              <span className="mono d-new outcome-other-now">{change.after}</span>
            </div>
          ) : change.after !== null ? (
            <p className="small d-new outcome-other-after">{change.after}</p>
          ) : null}
        </div>
      </section>
      {score !== null ? (
        <section className="inst" aria-labelledby="outcome-other-score">
          <div className="inst-h">
            <h3 className="t" id="outcome-other-score">
              {t("score")}
            </h3>
            <span className="sep">·</span>
            <span>{t("rubric", { version: decision?.rubricVersion ?? view.rubricVersion })}</span>
            {accept !== null ? <span className="ts">{variant === "requestMoreByRule" && decision !== null && decision.sufficientTier !== null ? t("acceptTier", { accept, tier: decision.sufficientTier }) : t("accept", { accept })}</span> : null}
          </div>
          <div className="inst-b col outcome-other-body">
            <div className="row outcome-other-score">
              <span className={cn("midnum", band !== null && `is-${band}`)}>{score}</span>
              {accept !== null ? <span className="meta">{t(score >= accept ? "reached" : "under", { accept })}</span> : null}
            </div>
            {/* No meter where no threshold decides the class; a derived figure's floor is its acceptance (100 and 100): one tick, the acceptance's. */}
            {accept !== null ? <Meter value={score} label={t("meter", { score, accept })} tone={band === null ? "ink" : METER_TONE[band]} marks={[...(floor !== null && floor !== accept ? [{ at: floor }] : []), { at: accept, ok: true }]} /> : null}
            {strongest !== null && strongest.tier !== null ? (
              <div className="row outcome-other-item">
                <EvidenceBadge tier={strongest.tier} label={tr("tiers.badge", { tier: strongest.tier, name: tr(`tiers.name.${strongest.tier}`) })} />
                <div className="grow col outcome-evidence-what">
                  <span className="small">{strongest.title ?? locationOf(strongest) ?? strongest.fileName ?? te(`kind.${strongest.kind}`)}</span>
                  {strongest.baseScore !== null && strongest.relevance !== null && strongest.recency !== null && strongest.independence !== null && strongest.adjustedScore !== null ? (
                    <span className="mono outcome-evidence-math">
                      {strongest.baseScore} × {formatFactor(strongest.relevance, locale)} × {formatFactor(strongest.recency, locale)} × {formatFactor(strongest.independence, locale)} = {strongest.adjustedScore}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      {variant === "requestMoreByRule" ? <OutcomeRequest chapterDigits={strip.chapter.digits} tier={decision?.sufficientTier ?? "A"} /> : null}
    </section>
  );
}
