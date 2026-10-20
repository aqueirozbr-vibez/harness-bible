import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import { Loader } from "@/components/ui/Loader";
import { StatusMark } from "@/components/ui/StatusMark";
import { formatDate, formatFactor } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { ageOf, budgetResetOf, causeOf, fetchStateOf, locationOf, ruledOf, stageNumberOf, stakeOf, windowOf, type EvidenceRubric } from "@/lib/improve/evidenceView";
import type { EvidenceItemView } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

interface EvidenceItemProps {
  readonly item: EvidenceItemView;
  readonly locale: Locale;
  readonly rubric: EvidenceRubric;
  /** A remove, a cancel or a replace is out for this item: its button waits. */
  readonly busy: boolean;
  readonly onRemove: (item: EvidenceItemView) => void;
  /** An item that could not be opened or graded: removed, and its link or DOI offered again, or the upload's form opened. */
  readonly onReplace: (item: EvidenceItemView) => void;
}

/**
 * One evidence item as the Improve-Suggest screen draws it (feature-specs/34 § 5; 32 § 10). Graded: ordinal, kind, the
 * document's title, where it is and the stake and recency window its factors name, the tier badge with its name, the
 * score, the arithmetic, `opened · 200 · 12 days old` (`uploaded` for a file), `Remove`. Grading: dashed and busy, the
 * loader with its stage and what that stage does, `Cancel`. At the budget cap the Components screen's `budget cap
 * reached`, with the reset day and `Remove`, since nothing grades a draft's item again by itself (unit 51d's review).
 * Not opened: the Components screen's error form, `link could not be opened`, with `Replace evidence`; and in the same
 * form an item that opened but was graded `U` all the same — a file that is not the type it was sent as, a grader that
 * gave no tier — with why. The error forms are alerts, as the Components screen's are, so a failure is announced as it
 * lands. Every number is the view's.
 */
export function EvidenceItem({ item, locale, rubric, busy, onRemove, onReplace }: EvidenceItemProps) {
  const t = useTranslations("improve.suggest.evidence");
  const tr = useTranslations("rubric");
  const n = item.ordinal;
  const fetched = fetchStateOf(item.fetchStatus);
  const location = locationOf(item);
  /* An upload is called by its file's name, which only the list and the curator read (34 § 25). */
  const title = item.title ?? location ?? (item.kind === "UPLOAD" ? (item.fileName ?? t("uploadTitle")) : t(`kind.${item.kind}`));
  /* How an item that opened says so: a link with the status it answered, a file as uploaded. */
  const opened = (status: string) => (item.kind === "UPLOAD" ? t("status.uploaded") : t("status.opened", { status }));
  const head = (badge: ReactNode, score: ReactNode, note: string | null) => (
    <div className="row evidence-head">
      <span className="meta faint evidence-ordinal">{String(n).padStart(2, "0")}</span>
      <span className="label evidence-kind">{t(`kind.${item.kind}`)}</span>
      <div className="grow col evidence-what">
        <span className="small evidence-title">{title}</span>
        {(item.title !== null && location !== null) || note !== null ? <span className="tex evidence-where">{[item.title !== null ? location : null, note].filter((part) => part !== null).join(" · ")}</span> : null}
      </div>
      {badge}
      {score}
    </div>
  );
  const remove = (label: string, text: string) => (
    <button type="button" className="btn btn-sm btn-q" aria-label={label} disabled={busy} onClick={() => onRemove(item)}>
      {text}
    </button>
  );

  if (item.state === "PENDING" || item.tier === null) {
    const reset = budgetResetOf(item.reason);
    const stage = item.stage === null ? 1 : stageNumberOf(item.stage);
    const doing = fetched !== null && fetched.kind === "opened" ? `${opened(fetched.status)} · ${t(`doing.${stage}`)}` : t(`doing.${stage}`);
    return (
      <li className="box evidence-item is-pending" aria-busy={reset === null}>
        {head(
          <span className="ev evidence-tier-pending" role="img" aria-label={t("tierPending")}>
            ·
          </span>,
          <span className="score faint evidence-score" aria-hidden="true">
            —
          </span>,
          null,
        )}
        {reset !== null ? (
          <div className="error col gap-s2 evidence-wait" role="alert">
            <div className="between">
              <StatusMark tone="fail">{t("budget.title")}</StatusMark>
              <span className="meta faint">{t("budget.source")}</span>
            </div>
            <p className="small">{t("budget.body", { date: formatDate(new Date(`${reset}T00:00:00Z`), locale) })}</p>
            <div className="row">{remove(t("removeLabel", { n }), t("remove"))}</div>
          </div>
        ) : (
          <div className="row evidence-foot">
            <Loader prefix={t("grading")} progress={{ done: stage, total: 3 }} className="evidence-loader">
              {t("stage", { n: stage })}
            </Loader>
            <span className="cap">{doing}</span>
            <span className="grow" />
            {remove(t("cancelLabel", { n }), t("cancel"))}
          </div>
        )}
      </li>
    );
  }

  const badge = <EvidenceBadge tier={item.tier} label={tr("tiers.badge", { tier: item.tier, name: tr(`tiers.name.${item.tier}`) })} />;
  /* The Components screen's error form: what failed, where the item points, why in words, and `Replace evidence`. */
  const failed = (heading: string, why: string) => (
    <li className="evidence-item evidence-failed">
      <div className="error col gap-s2" role="alert">
        <div className="between">
          <StatusMark tone="fail">{heading}</StatusMark>
          {badge}
        </div>
        <span className="tex evidence-where">{location ?? title}</span>
        <p className="small">{why}</p>
        <div className="row">
          <button type="button" className="btn btn-sm" aria-label={t("replaceLabel", { n })} disabled={busy} onClick={() => onReplace(item)}>
            {t("unreachable.replace")}
          </button>
        </div>
      </div>
    </li>
  );

  if (fetched !== null && fetched.kind === "unreachable" && item.tier === "U") {
    const cause = causeOf(fetched.cause);
    return failed(t("unreachable.title"), cause.kind === "status" ? t("unreachable.status", { n, status: cause.status }) : t("unreachable.cause", { n, why: t(`unreachable.why.${cause.kind === "network" ? cause.cause : "guard"}`) }));
  }
  /* Opened, or uploaded, and `U` all the same: by intake rules (the file's type, its size, its text) or for want of a tier from the grader. */
  if (item.tier === "U" && (fetched === null || fetched.kind === "opened")) {
    return failed(t("ruled.title"), t("ruled.body", { n, why: t(`ruled.why.${ruledOf(item.reason)}`) }));
  }

  const stake = stakeOf(item.independence, rubric.independence);
  const window = windowOf(item.recency, rubric.recency);
  /* An item with no date takes the older factor where recency applies (30 § 3.4, D3): said as such, beside the status's `no date`. */
  const older = item.ageDays === null ? t("undatedOlder") : t("older");
  const note = [stake === null ? null : t(`stake.${stake}`), window === null ? null : window.kind === "older" ? older : window.days === 365 ? tr("adjustments.recency.withinYear") : tr("adjustments.recency.withinDays", { n: window.days })].filter((part) => part !== null).join(" · ");
  const factor = (value: number | null) => (value === null ? null : <span className={cn(value < 1 && "evidence-low")}>{formatFactor(value, locale)}</span>);
  const math =
    item.baseScore !== null && item.relevance !== null && item.recency !== null && item.independence !== null && item.adjustedScore !== null ? (
      <span className="mono evidence-math">
        {item.baseScore} × {factor(item.relevance)} × {factor(item.recency)} × {factor(item.independence)} = {item.adjustedScore}
      </span>
    ) : fetched !== null && fetched.kind === "unsupported" ? (
      <span className="small evidence-math">{t("unsupported", { type: fetched.type === "unknown" ? t("noType") : fetched.type })}</span>
    ) : fetched !== null && fetched.kind === "notSupplied" ? (
      <span className="small evidence-math">{t("notSupplied")}</span>
    ) : null;
  const age = item.ageDays === null ? null : ageOf(item.ageDays);
  const how = fetched === null || fetched.kind !== "opened" ? null : opened(fetched.status);
  const status = [how, age === null ? (how === null ? null : t("status.undated")) : t(`status.${age.unit === "day" ? "days" : age.unit === "month" ? "months" : "years"}`, { n: age.n })].filter((part) => part !== null).join(" · ");
  return (
    <li className="box evidence-item">
      {head(
        badge,
        <span className="score evidence-score">{item.adjustedScore ?? 0}</span>,
        note === "" ? null : note,
      )}
      <div className="row evidence-foot">
        {math}
        <span className="grow" />
        {status !== "" ? <StatusMark tone={item.recency !== null && item.recency < 1 ? "warn" : "ok"}>{status}</StatusMark> : null}
        {remove(t("removeLabel", { n }), t("remove"))}
      </div>
    </li>
  );
}
