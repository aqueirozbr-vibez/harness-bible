import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusBar } from "@/components/chrome/StatusBar";
import { ContextStrip } from "@/components/improve/ContextStrip";
import { OutcomeAnchor } from "@/components/improve/OutcomeAnchor";
import { OutcomeDecision } from "@/components/improve/OutcomeDecision";
import { OutcomeOther } from "@/components/improve/OutcomeOther";
import { OutcomeReasons } from "@/components/improve/OutcomeReasons";
import { OutcomeRefresh } from "@/components/improve/OutcomeRefresh";
import { OutcomeRequest } from "@/components/improve/OutcomeRequest";
import { OutcomeSaw } from "@/components/improve/OutcomeSaw";
import { OutcomeSensors } from "@/components/improve/OutcomeSensors";
import { OutcomeSuffice } from "@/components/improve/OutcomeSuffice";
import { OutcomeThrottle } from "@/components/improve/OutcomeThrottle";
import { OutcomeWithdraw } from "@/components/improve/OutcomeWithdraw";
import { QueueMerge } from "@/components/improve/QueueMerge";
import type { ImproveOutcomeData } from "@/lib/db/improveOutcome";
import { formatDateTime, formatSeconds, formatTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { anchorTitleOf, throttleNoteOf } from "@/lib/improve/outcomeView";
import { mergesAfter, takesRevision, takesWithdrawal } from "@/lib/schemas/improve";
import { cn } from "@/lib/utils";

interface ImproveOutcomeProps {
  readonly locale: Locale;
  readonly id: string;
  readonly data: Extract<ImproveOutcomeData, { readonly kind: "page" }>;
  readonly loadedMs: number;
}

/** How long a page that waits on its owner reads itself again: a revision just sent is taken up in a moment. */
const REVISION_WATCH_MS = 60_000;

/**
 * A suggestion's own page, the adjudication page (feature-specs/35 § 4; unit 52b; the Improve-Adjudication screen):
 * the context strip; the header with when it was submitted and decided, the anchor as the title; Decision beside the
 * Anchor; a derived figure's request; Reasons; Sensors beside What would suffice; the actions. Which of § 4's variants
 * it is decides the badge, the lines and the primary action: `Revise with new evidence` where the suggestion takes a
 * revision. In progress, the page reads itself again until something is decided. For the owner, the right column:
 * their most recent other open suggestion, the throttle rule with their own count, and what the adjudicator saw.
 * Accepted, its merge (spec 37 § 6; unit 54b): where it stands, the chapter's check and the branch against `main`;
 * returned by a failed check, what the check found beside the request for more (§ 4.5).
 */
export function ImproveOutcome({ locale, id, data, loadedMs }: ImproveOutcomeProps) {
  const t = useTranslations("improve.outcome");
  const th = useTranslations("home.statusbar");
  const { view, variant, refreshKey, context, decided, parts, curator, own, withdrawAgain } = data;
  const { strip, chapterDigits } = context.page;
  const back = `/${locale}/ch/${strip.back.slice(0, 2)}/${strip.back}`;
  const { kind: titleKind, ...titleValues } = anchorTitleOf(view.anchor, context.sectionTitle);
  /* The heading's words are the page's; the book's text in it is marked with its own language: a section's title is the edition's, a figure's label and a row's claim the anchor's English (the 52c review). */
  const title = t.rich(`title.${titleKind}`, { ...titleValues, book: (chunks) => <span lang={titleKind === "SECTION" ? context.contentLang : "en"}>{chunks}</span> });
  const decidedAt = view.adjudication?.decidedAt ?? view.decidedAt;
  /* a withdrawal asked for is handled before any revision (45 § 5.3), so the page no longer invites one */
  const revisable = view.own && view.withdrawnAt === null && takesRevision(view.state, view.outcome);
  /* a person's own, where its workflow waits for a person, and no withdrawal already asked for (45 § 5.1) — or one asked for
     that has stood unrecorded too long, which Withdraw sends again (review of unit 63) */
  const withdrawable = view.own && view.origin === "HUMAN" && (view.withdrawnAt === null || withdrawAgain) && takesWithdrawal(view.state, view.outcome);
  const decision = view.adjudication;
  return (
    <>
      <div className="col suggest-page">
        <ContextStrip locale={locale} {...strip} suggestion={{ id, mark: null }} />
        <div className={cn("outcome-page", own !== null && "has-aside")}>
          <main className="outcome">
            {variant === "progress" || variant === "budget" || variant === "withdrawing" ? <OutcomeRefresh id={id} drawn={refreshKey} /> : revisable ? <OutcomeRefresh id={id} drawn={refreshKey} forMs={REVISION_WATCH_MS} /> : null}
            <div className="col outcome-head">
              <div className="row outcome-head-caps">
                <span className="cap">{t("cap", { id })}</span>
                {view.submittedAt !== null ? (
                  <>
                    <span className="cap">·</span>
                    <span className="cap">
                      {t("submitted", { at: formatDateTime(new Date(view.submittedAt), locale) })}
                      {/* the time alone where it was decided the day it was submitted (UTC, as both print), else the date too */}
                      {decidedAt !== null ? ` · ${t("decided", { at: decidedAt.slice(0, 10) === view.submittedAt.slice(0, 10) ? formatTime(new Date(decidedAt)) : formatDateTime(new Date(decidedAt), locale) })}` : null}
                    </span>
                  </>
                ) : null}
              </div>
              <h1 className="h2">{title}</h1>
            </div>
            <div className="outcome-top">
              <OutcomeDecision locale={locale} view={view} variant={variant} decided={decided} parts={parts} curator={curator} />
              <OutcomeAnchor locale={locale} view={view} version={context.version} />
            </div>
            {variant === "requestMoreByRule" ? <OutcomeRequest chapterDigits={chapterDigits} tier={decision?.sufficientTier ?? "A"} /> : null}
            {view.merge !== null || mergesAfter(view.state, view.outcome) ? <QueueMerge locale={locale} view={view} mayRecheck={false} /> : null}
            <OutcomeReasons adjudication={decision} />
            <div className="outcome-pair">
              <OutcomeSensors sensors={view.sensors} />
              <OutcomeSuffice view={view} />
            </div>
            <div className="row outcome-actions">
              {revisable ? (
                <Link className="btn btn-p" href={`/${locale}/improve/${id}/edit`}>
                  {t("actions.revise")}
                </Link>
              ) : null}
              <Link className={variant === "accepted" ? "btn btn-p" : "btn"} href={`/${locale}/improve/${id}/record`}>
                {t("actions.record")}
              </Link>
              <Link className="btn btn-q" href={back}>
                {t("actions.back", { id: strip.back })}
              </Link>
              {withdrawable ? <OutcomeWithdraw id={id} /> : null}
              <span className="grow" />
              <span className="meta faint">{t("actions.override")}</span>
            </div>
          </main>
          {own !== null ? (
            <aside className="col outcome-aside" aria-label={t("aside")}>
              {own.other !== null ? <OutcomeOther locale={locale} other={own.other} /> : null}
              <OutcomeThrottle id={id} throttle={own.throttle} note={throttleNoteOf(view)} />
              {decision !== null && decision.decidedBy === "adjudicator" && decision.guideVersion !== null ? <OutcomeSaw guide={decision.guideVersion} rubric={decision.rubricVersion} /> : null}
            </aside>
          ) : null}
        </div>
      </div>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("statusbar", { n: chapterDigits, id })}</span>
      </StatusBar>
    </>
  );
}
