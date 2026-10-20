import { useTranslations } from "next-intl";
import Link from "next/link";

import { OUTCOME_BADGE } from "@/components/improve/OutcomeDecision";
import { OutcomeRefresh } from "@/components/improve/OutcomeRefresh";
import { QueueAdjudication } from "@/components/improve/QueueAdjudication";
import { QueueChange } from "@/components/improve/QueueChange";
import { QueueDecided } from "@/components/improve/QueueDecided";
import { QueueDecision } from "@/components/improve/QueueDecision";
import { QueueEvidence } from "@/components/improve/QueueEvidence";
import { QueueMerge } from "@/components/improve/QueueMerge";
import { QueueSeedRevealed } from "@/components/improve/QueueSeedRevealed";
import { RevertPanel } from "@/components/improve/RevertPanel";
import { partRoman } from "@/components/improve/QueueList";
import { StatusMark } from "@/components/ui/StatusMark";
import type { QueueSelection } from "@/lib/db/queuePage";
import { formatDateTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { refreshKeyOf } from "@/lib/improve/outcomeView";
import { mergesAfter } from "@/lib/schemas/improve";
import { cn } from "@/lib/utils";

interface QueueDetailProps {
  readonly locale: Locale;
  readonly selected: QueueSelection;
  /** The curator reading, and their parts: the decision panel's header. */
  readonly curator: string;
  readonly parts: string;
}

/** How long a decision being recorded is read again for: the workflow records within seconds (36 § 5.1). */
const RECORDING_READ_MS = 60_000;

/**
 * The selected suggestion (feature-specs/36 § 4; the Curator-Queue screen's middle column): its chapter and version;
 * its id, its state's badge, when it was submitted and by whom — the curator sees the contributor's name, the
 * adjudicator never does; the routing sentence (which parts and their curators, that the first curator to decide
 * decides a shared item, the anchor's age when stale); Change; Evidence; Adjudication; then the decision (53c): the
 * panel while the suggestion waits in the queue and is not the curator's own, and once a curator has decided, who,
 * when and the record — read again while the workflow records it. A seed (53e) shows as the suggestion it is of, the
 * panel until it is decided and then its reveal; it has no links to a page or a record, which would show the answer.
 * A researcher's proposal (43 § 7.1; unit 60d) says `origin · research` and whose name stands on it in place of the
 * contributor's line, and shows the researcher's note with the sentence that the adjudicator did not read it; nothing
 * of who asked. An accepted suggestion shows its merge (54b): where it stands, the check, the diff, and `Re-run check` for a curator
 * whose suggestion it is not; once its check passed, `Merge` too (54c). A sampled item (36 § 7.2; 54e) shows the
 * month's verdict once given — stands, or reverted — and until then the panel that gives it, for a curator whose
 * suggestion it is not.
 */
export function QueueDetail({ locale, selected, curator, parts: curatorParts }: QueueDetailProps) {
  const t = useTranslations("improve.queue.detail");
  const tb = useTranslations("improve.outcome.decision.badge");
  const tp = useTranslations("improve.proposal");
  const { view, variant, context, contributor, research, routing, decided, seed, sample } = selected;
  /* a contributor's withdrawal standing takes it out of the queue to decide (45 § 5.2; review of unit 63): its badge says Withdrawing */
  const deciding = view.state === "CURATOR_QUEUE" && view.withdrawnAt === null && !view.own && decided?.open !== true && (seed === null || seed.decided === null);
  const { strip } = context.page;
  const who =
    research !== null
      ? `${t("origin")} · ${research.endorser === null ? t("notEndorsed") : t("endorsedBy", { name: research.endorser })}`
      : contributor === null
        ? null
        : contributor.name !== null
          ? t(contributor.verified ? "byNameVerified" : "byName", { name: contributor.name })
          : t(contributor.verified ? "verifiedContributor" : "contributor");
  const parts = routing.map((entry) => (entry.curators.length === 0 ? t("partNone", { part: partRoman(entry.part) }) : t("partBy", { part: partRoman(entry.part), curators: entry.curators.length > 2 ? t("andOthers", { first: entry.curators.slice(0, 2).join(", "), n: entry.curators.length - 2 }) : entry.curators.join(", ") })));
  return (
    <main className="col queue-detail" aria-labelledby="queue-detail-title">
      <div className="col queue-detail-head">
        <span className="cap">
          {t("chapter", { n: strip.chapter.digits })} <span lang={strip.contentLang}>{strip.chapter.title}</span> · {strip.anchor.section.id} <span lang={strip.contentLang}>{strip.anchor.section.title}</span> · {strip.chapter.version}
        </span>
        <div className="between queue-detail-id">
          <div className="row queue-detail-id-row">
            <h2 className="midnum queue-detail-title" id="queue-detail-title">
              {view.id}
            </h2>
            <span className={cn("st-block", OUTCOME_BADGE[variant])}>{tb(variant === "accepted" && (view.state === "MERGED" || view.state === "MERGING") ? view.state : variant)}</span>
          </div>
          <span className="meta">
            {view.submittedAt !== null ? t("submitted", { at: formatDateTime(new Date(view.submittedAt), locale) }) : null}
            {who !== null ? ` · ${who}` : null}
          </span>
        </div>
        <p className="muted small">
          {t("routed", { parts: parts.join("; ") })}
          {routing.length > 1 ? ` ${t("shared")}` : null}
          {strip.staleDays !== null ? ` ${t("stale", { days: strip.staleDays })}` : null}
        </p>
      </div>
      <QueueChange view={view} />
      {research !== null && research.note !== null ? (
        <section className="col queue-research-note" aria-labelledby="queue-research-note-title">
          <h3 className="cap" id="queue-research-note-title">
            {tp("note")}
          </h3>
          <p className="small" lang={context.page.strip.contentLang}>
            {research.note}
          </p>
          <p className="help">{tp("noteUnread")}</p>
        </section>
      ) : null}
      <QueueEvidence locale={locale} view={view} />
      <QueueAdjudication locale={locale} view={view} />
      {decided !== null && (view.state !== "CURATOR_QUEUE" || decided.open) ? <QueueDecided locale={locale} decided={decided} origin={view.origin} /> : null}
      {decided !== null && decided.record === null ? <OutcomeRefresh id={view.id} drawn={refreshKeyOf(view)} forMs={RECORDING_READ_MS} /> : null}
      {seed !== null && seed.decided !== null ? <QueueSeedRevealed decided={seed.decided} /> : null}
      {sample !== null && sample.verdict !== null ? (
        <p className="small queue-sample-verdict">
          <StatusMark tone={sample.verdict.action === "REVERT" ? "fail" : "ok"}>{t(sample.verdict.action === "REVERT" ? "sample.reverted" : "sample.stands")}</StatusMark>{" "}
          {t("sample.by", { who: sample.verdict.by ?? t("sample.someone"), at: formatDateTime(new Date(sample.verdict.at), locale) })}
          {sample.verdict.revertId !== null ? (
            <>
              {" · "}
              <Link className="xref" href={`/${locale}/improve/${sample.verdict.revertId}/record`}>
                {sample.verdict.revertId}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {sample !== null && sample.verdict === null && !view.own ? <RevertPanel key={view.id} locale={locale} suggestionId={view.id} curator={curator} sampled href={`/${locale}/improve/queue?s=${view.id}`} /> : null}
      {seed === null && (view.merge !== null || mergesAfter(view.state, view.outcome)) ? <QueueMerge key={view.id} locale={locale} view={view} mayRecheck={!view.own && mergesAfter(view.state, view.outcome)} /> : null}
      {deciding ? (
        <QueueDecision
          key={view.id}
          suggestionId={view.id}
          origin={view.origin}
          changeClass={view.changeClass}
          standing={view.outcome}
          adjudicated={view.adjudication?.decidedBy === "adjudicator" && view.adjudication.decision !== "CURATOR_REVIEW"}
          curator={curator}
          parts={curatorParts}
          href={`/${locale}/improve/queue?s=${view.id}`}
        />
      ) : null}
      {seed === null ? (
        <div className="row queue-detail-actions">
          <Link className="btn btn-sm" href={`/${locale}/improve/${view.id}`}>
            {t("open")}
          </Link>
          <Link className="btn btn-sm btn-q" href={`/${locale}/improve/${view.id}/record`}>
            {t("record")}
          </Link>
        </div>
      ) : null}
    </main>
  );
}
