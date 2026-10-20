import { useTranslations } from "next-intl";

import { PART_ROMAN } from "@/components/reader/PartGrid";
import type { CuratorDecisionForUser } from "@/lib/db/improve";
import { formatDate, formatDateTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { declinedBy, queueDeadlineOf, shortHash, type OutcomeVariant } from "@/lib/improve/outcomeView";
import type { Part } from "@/lib/schemas/improve";
import type { SuggestionView } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

interface OutcomeDecisionProps {
  readonly locale: Locale;
  readonly view: SuggestionView;
  readonly variant: OutcomeVariant;
  /** The `decided` record's hash and what the decision cost; null until something is decided. */
  readonly decided: { readonly hash: string; readonly tokens: number } | null;
  /** With a curator: the parts whose curators decide it (`with a curator · part iii`). */
  readonly parts: ReadonlyArray<Part>;
  /** Closed by a curator: the action and its coded reason, never the note (35 D4). */
  readonly curator: CuratorDecisionForUser | null;
}

/** A suggestion's parts as the strip prints a chapter's (`part iii`); P4 reads as P3, as the reader folds it (lib/db/content.ts). */
const ROMAN: Readonly<Record<Part, string>> = { ...PART_ROMAN, P4: PART_ROMAN.P3 };

/** The badge's colour by variant; the right column's compact form uses it too. */
export const OUTCOME_BADGE: Readonly<Record<OutcomeVariant, string>> = { withdrawing: "sb-mute", withdrawn: "sb-mute", progress: "sb-mute", budget: "sb-warn", declined: "sb-fail", requestMore: "sb-warn", requestMoreByRule: "sb-warn", curator: "sb-act", recommended: "sb-act", accepted: "sb-ok", checkFailed: "sb-warn", notProposed: "sb-mute", closed: "sb-mute" };
/* The box's colour by variant (ui-context § 9.9): neutral while under way and once closed. */
const TONE: Readonly<Record<OutcomeVariant, string | null>> = { withdrawing: null, withdrawn: null, progress: null, budget: "is-warn", declined: "is-fail", requestMore: "is-warn", requestMoreByRule: "is-warn", curator: "is-warn", recommended: null, accepted: "is-ok", checkFailed: "is-warn", notProposed: null, closed: null };

/**
 * The page's Decision, as the Improve-Adjudication screen draws it (feature-specs/35 § 4): the score as the big
 * number, the badge, `floor 25 · accept 70`, the mono line that says how it was decided, the sentence, and the
 * footer with who decided, its tokens and the `decided` record's short hash. Before a decision, the step the run is
 * at, or its wait at the budget cap. With a curator, the line names the parts and the queue's deadline (36 § 3.1);
 * closed by one, the coded reason, if the curator gave one.
 */
export function OutcomeDecision({ locale, view, variant, decided, parts, curator }: OutcomeDecisionProps) {
  const t = useTranslations("improve.outcome.decision");
  const tc = useTranslations("rubric.thresholds.class");
  const decision = view.adjudication;
  const score = decision?.score ?? view.score;
  const accept = decision?.acceptAt ?? view.thresholds.acceptAt;
  const floor = decision?.floorAt ?? view.thresholds.floorAt;
  const due = variant === "curator" || variant === "recommended" ? queueDeadlineOf(view) : null;
  const values = {
    score: score ?? 0,
    /* a class a curator always decides has no acceptance, and its lines leave it out (54b) */
    accept: accept ?? "none",
    floor: floor ?? 0,
    tier: decision?.sufficientTier ?? "A",
    sensor: decision?.failingSensor ?? "",
    date: view.budgetResetsAt === null ? "" : formatDate(new Date(view.budgetResetsAt), locale),
    parts: parts.length === 0 ? "—" : parts.map((part) => ROMAN[part]).join(", "),
    due: due === null ? "none" : formatDateTime(due, locale),
    code: curator?.overrideCode ?? "none",
  };
  const line =
    variant === "declined" && decision !== null
      ? t(`line.declined.${declinedBy(decision)}`, values)
      : variant === "progress"
        ? t(`line.progress.${view.state === "GRADED" || view.state === "SENSED" ? view.state : "SUBMITTED"}`)
        : variant === "accepted"
          ? t(`line.accepted.${view.state === "MERGED" || view.state === "MERGING" ? view.state : "DECIDED"}`, values)
          : /* a researcher's proposal the check closed after a curator's accept: closed, not returned (review of unit 60) */
            t(`line.${variant === "checkFailed" && view.state === "CLOSED" ? "checkFailedClosed" : variant}`, values);
  /* The router writes no decision row (33 § 6.1): a suggestion decided with no row was routed. */
  const by = decision !== null ? decision.decidedBy : view.outcome !== null ? "router" : null;
  return (
    <section className={cn("col outcome-decision", TONE[variant])} aria-labelledby="outcome-decision-title">
      <div className="inst-h">
        {/* focusable by script alone: where Withdraw sends focus once the page redraws without it (review of unit 63) */}
        <h2 className="t" id="outcome-decision-title" tabIndex={-1}>
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <span>{tc(view.changeClass)}</span>
        <span className="ts">{t("rubric", { version: decision?.rubricVersion ?? view.rubricVersion })}</span>
      </div>
      {/* Read out when the page redraws itself with a decision (code-standards: live regions for verdicts). */}
      <div className="col outcome-decision-body" aria-live="polite">
        <div className="row outcome-decision-head">
          <span className="bignum outcome-score">{score ?? "—"}</span>
          <div className="col outcome-decision-badge">
            <span className={cn("st-block", OUTCOME_BADGE[variant])}>{t(`badge.${variant === "accepted" && (view.state === "MERGED" || view.state === "MERGING") ? view.state : variant}`)}</span>
            <span className="meta">{accept !== null && floor !== null ? t("thresholds", values) : t("curatorAlways")}</span>
          </div>
        </div>
        <p className="mono outcome-line">{line}</p>
        <p className="small">{t(`say.${variant === "declined" && decision !== null ? `declined.${declinedBy(decision)}` : variant === "checkFailed" && view.state === "CLOSED" ? "checkFailedClosed" : variant}`, values)}</p>
      </div>
      <div className="inst-f">
        <span>{by === null ? t("footer.none") : by === "adjudicator" ? t("footer.adjudicator", { model: decision?.modelId ?? "", tokens: decided?.tokens ?? 0 }) : t(`footer.${by === "router" ? "router" : "rule"}`)}</span>
        {decided !== null ? <span className="tex">{t("record", { hash: shortHash(decided.hash) })}</span> : null}
      </div>
    </section>
  );
}
