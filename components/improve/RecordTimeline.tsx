import { useTranslations } from "next-intl";

import { PART_ROMAN } from "@/components/reader/PartGrid";
import { formatDateTime, formatFactor } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { RecordEntry } from "@/lib/improve/record";
import { ledgerLine } from "@/lib/ledger/display";

interface RecordTimelineProps {
  readonly locale: Locale;
  readonly entries: ReadonlyArray<RecordEntry>;
  /** The chapter, which a merge's line names: `ch36 v1.3.2 → v1.3.3`. */
  readonly chapterDigits: string;
}

/**
 * The record (feature-specs/35 § 5; the Improve-Record screen): one entry a record, in chain order — when, the title,
 * who acted, what the record says, and `prev … · hash …` in the 12-character form, the last marked `head`. A person
 * is named as the loader allowed, or by the pseudonym the ledger holds; an agent as what it is, and no edit is
 * attributed to one (invariant 27). Every fact is the payload's: no sentence a person or a model wrote is in one.
 */
export function RecordTimeline({ locale, entries, chapterDigits }: RecordTimelineProps) {
  const t = useTranslations("improve.record.timeline");
  const tc = useTranslations("rubric.thresholds.class");
  const ts = useTranslations("improve.outcome.sensors");
  const tq = useTranslations("improve.outcome.reasons.name");

  const titleOf = (entry: RecordEntry): string => {
    const { facts } = entry;
    switch (facts.kind) {
      case "SUBMITTED":
        return facts.attempt <= 1 ? t("title.SUBMITTED") : t("title.RESUBMITTED", { n: facts.attempt });
      case "DECIDED":
        return t(`title.DECIDED.${facts.decision}`);
      case "CURATOR":
        return t(`title.CURATOR.${facts.action}`);
      case "ENDORSED":
        return t(facts.withdrawn ? "title.WITHDRAWN" : "title.ENDORSED");
      case "UNREADABLE":
        return t("title.UNREADABLE", { seq: entry.seq });
      default:
        return t(`title.${facts.kind}`);
    }
  };

  const bodyOf = (entry: RecordEntry): string => {
    const { facts } = entry;
    switch (facts.kind) {
      case "SUBMITTED":
        return t("body.SUBMITTED", { anchor: facts.anchor, class: tc(facts.changeClass), items: facts.items, words: facts.words });
      case "GRADED":
        return [
          ...facts.items.map((item) =>
            item.relevance === null || item.recency === null || item.independence === null
              ? t("body.GRADED_ITEM_BARE", { n: item.ordinal, tier: item.tier, adjusted: item.adjusted })
              : t("body.GRADED_ITEM", { n: item.ordinal, tier: item.tier, base: item.base, relevance: formatFactor(item.relevance, locale), recency: formatFactor(item.recency, locale), independence: formatFactor(item.independence, locale), adjusted: item.adjusted }),
          ),
          t("body.GRADED_SCORE", { score: facts.score }),
        ].join(" ");
      case "SENSORS":
        return t("body.SENSORS", { verdicts: facts.verdicts.map((verdict) => `${ts(`name.${verdict.sensor}`)} ${ts(`result.${verdict.result}`)}`).join(" · ") });
      case "DECIDED":
        if (facts.decision === "DECLINE") return facts.failingSensor !== null ? t("body.DECIDED.sensor", { sensor: ts(`name.${facts.failingSensor}`) }) : facts.decidedBy === "adjudicator" ? t("body.DECIDED.declinedByAdjudicator", { score: facts.score }) : t("body.DECIDED.declinedByRule", { score: facts.score, floor: facts.floorAt ?? 0 });
        if (facts.decision === "ACCEPT") return t("body.DECIDED.ACCEPT", { score: facts.score, accept: facts.acceptAt ?? 0, criteria: facts.criteria });
        if (facts.decision === "REQUEST_MORE") return t("body.DECIDED.REQUEST_MORE", { score: facts.score, accept: facts.acceptAt ?? 0 });
        return t("body.DECIDED.CURATOR_REVIEW", { score: facts.score });
      case "CURATOR": {
        const code = facts.overrideCode === null ? "none" : facts.overrideCode;
        const criterion = facts.criterion === null ? "none" : tq(facts.criterion);
        return [t(`body.CURATOR.${facts.action}`, { code, criterion }), facts.noted ? t("body.CURATOR.noted") : null].filter((part) => part !== null).join(" ");
      }
      case "MERGED":
        return [facts.reverts === null ? null : t("body.REVERTS", { id: facts.reverts }), t("body.MERGED", { bump: t(`bump.${facts.bump}`), from: facts.versionFrom, to: facts.versionTo, lint: facts.lint, lab: facts.lab })].filter((part) => part !== null).join(" ");
      case "ENDORSED":
        return t(facts.withdrawn ? "body.WITHDRAWN" : "body.ENDORSED");
      case "RETRACTED":
        /* from where its workflow waited for a person (45 § 5.1): declined at intake, asked for more, or a curator's queue */
        return t("body.RETRACTED", { where: facts.from === "INTAKE_DECLINED" ? "intake" : facts.outcome === "REQUEST_MORE" ? "more" : "queue" });
      case "EXPORT":
        return t("body.EXPORT", { records: facts.records });
      case "UNREADABLE":
        return t("body.UNREADABLE");
    }
  };

  const actorOf = (entry: RecordEntry): string => {
    const { facts, actor } = entry;
    if (facts.kind === "MERGED") return t("actor.merged", { n: chapterDigits, from: facts.versionFrom, to: facts.versionTo });
    if (actor.kind === "person") {
      /* `user:` and the first eight of its id: the ledger's pseudonym, as short as stays distinct on one page. */
      const who = actor.name ?? actor.pseudonym.slice(0, "user:".length + 8);
      if (facts.kind === "SUBMITTED" && facts.verified === true) return t("actor.verified", { who });
      if (facts.kind === "CURATOR") return t("actor.curator", { who, part: facts.part === "P4" ? PART_ROMAN.P3 : PART_ROMAN[facts.part] });
      return who;
    }
    switch (facts.kind) {
      case "GRADED":
        return t("actor.grader", { model: facts.gradedBy ?? "—", rubric: facts.rubricVersion });
      case "SENSORS":
        return t("actor.sensors", { n: facts.verdicts.length });
      case "DECIDED":
        return facts.decidedBy === "adjudicator" ? t("actor.adjudicator", { guide: facts.guide ?? "—", rubric: facts.rubricVersion }) : t(facts.decidedBy === "router" ? "actor.router" : "actor.rules", { rubric: facts.rubricVersion });
      default:
        return actor.service;
    }
  };

  return (
    <section className="inst" aria-labelledby="record-timeline-title">
      <div className="inst-h">
        <h2 className="t" id="record-timeline-title">
          {t("title.record")}
        </h2>
        <span className="sep">·</span>
        <span>{t("cap")}</span>
        <span className="ts">{t("count", { n: entries.length })}</span>
      </div>
      {entries.length === 0 ? (
        <p className="inst-b small muted">{t("empty")}</p>
      ) : (
        <div className="record-timeline-body">
          <ol className="tl">
            {entries.map((entry) => {
              const line = ledgerLine({ seq: entry.seq, kind: entry.kind, hash: entry.hash, prevHash: entry.prevHash, createdAt: entry.at });
              return (
                <li key={entry.seq} className="tl-i">
                  <span className="tl-t">{formatDateTime(entry.at, locale)}</span>
                  <span className="tl-m" aria-hidden="true">
                    <i className={entry.marker ?? undefined} />
                  </span>
                  <div className="tl-b col record-entry">
                    <div className="between record-entry-head">
                      <h3 className="small record-entry-title">{titleOf(entry)}</h3>
                      <span className="meta">{actorOf(entry)}</span>
                    </div>
                    <p className="small muted">{bodyOf(entry)}</p>
                    <span className="hash">
                      {t("hash", { prev: line.prevShort, hash: line.short })}
                      {entry.head ? ` · ${t("head")}` : null}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <div className="inst-f">
        <span>{t("footer")}</span>
      </div>
    </section>
  );
}
