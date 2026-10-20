import { useTranslations } from "next-intl";
import Link from "next/link";

import { PART_ROMAN } from "@/components/reader/PartGrid";
import { EvidenceBadge } from "@/components/ui/EvidenceBadge";
import { StatusMark } from "@/components/ui/StatusMark";
import { formatTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { spanOf } from "@/lib/improve/queue";
import type { CurationQueue, QueueItem } from "@/lib/schemas/curation";
import type { Part } from "@/lib/schemas/improve";
import { cn } from "@/lib/utils";

interface QueueListProps {
  readonly locale: Locale;
  readonly queue: CurationQueue;
  /** The suggestion the detail shows. */
  readonly selectedId: string | null;
  /** The curator, as the queue's cap names them. */
  readonly curator: string;
}

/** A part as the strip prints a chapter's (`part iii`); P4 reads as P3, as the reader folds it. */
export const partRoman = (part: Part): string => (part === "P4" ? PART_ROMAN.P3 : PART_ROMAN[part]);

/**
 * The queue (feature-specs/36 § 3, § 4; the Curator-Queue screen's left column): whose queue and which parts, `Routed
 * by change class` with how many are open, the marks, and the table — each group under its title with its count, each
 * item's id (the link that selects it, stretched over its row so that a click anywhere on the row selects it; Andre,
 * 2026-10-11: the rows looked clickable and were not), anchor and class line, strongest tier, score, age and time
 * left, the last in the warning colour inside a day and the failure colour with a minus sign once past. Then what the
 * curator decided today, a seed revealed there with its answer and whether it matched, and the legend once one is
 * (36 § 7.1). Ages and time left are measured against the answer's own clock.
 */
export function QueueList({ locale, queue, selectedId, curator }: QueueListProps) {
  const t = useTranslations("improve.queue");
  const tr = useTranslations("rubric");
  const th = useTranslations("improve.history.class");
  const now = new Date(queue.now).getTime();
  const open = queue.groups.reduce((sum, group) => sum + group.items.length, 0);
  const seeds = queue.decidedToday.filter((decided) => decided.seed !== null).length;
  const span = (ms: number): string => {
    const { past, unit, n } = spanOf(ms);
    return t(past ? `span.past.${unit}` : `span.${unit}`, { n });
  };
  /* a researcher's proposal reads `research`; a contributor's draft from a finding `from research`, provenance beside their credit (48 § 8.6) */
  const classLine = (item: QueueItem): string => [item.curatorReason !== null ? t(`reason.${item.curatorReason}`) : t(`class.${item.changeClass}`), item.origin === "RESEARCHER" ? t("research") : item.fromResearch ? th("fromResearch") : null, item.shared ? t("shared") : null, item.merge !== null ? t(`mergeState.${item.merge}`) : null].filter((part) => part !== null).join(" · ");
  return (
    <aside className="rr col queue-list" aria-labelledby="queue-title">
      <div className="col queue-head">
        <span className="cap">{t("cap", { who: curator, parts: queue.parts.length === 0 ? "—" : [...new Set(queue.parts.map(partRoman))].join(", ") })}</span>
        <div className="between">
          <h1 className="h3" id="queue-title">
            {t("title")}
          </h1>
          <span className="meta">{t("open", { n: open })}</span>
        </div>
        <div className="row queue-marks">
          <StatusMark tone="fail">{t("marks.overdue", { n: queue.marks.overdue })}</StatusMark>
          <StatusMark tone="warn">{t("marks.dueSoon", { n: queue.marks.dueSoon })}</StatusMark>
          <StatusMark tone="mute">{t("marks.inSla", { n: queue.marks.inSla })}</StatusMark>
        </div>
      </div>
      {queue.parts.length === 0 ? (
        <p className="small muted">{t("noParts")}</p>
      ) : open === 0 ? (
        <p className="small muted">{t("empty")}</p>
      ) : (
        <table className="tbl queue-table">
          <thead>
            <tr>
              <th scope="col">{t("col.id")}</th>
              <th scope="col">{t("col.anchor")}</th>
              <th scope="col">{t("col.tier")}</th>
              <th scope="col" className="n">
                {t("col.score")}
              </th>
              <th scope="col" className="n">
                {t("col.age")}
              </th>
              <th scope="col" className="n">
                {t("col.sla")}
              </th>
            </tr>
          </thead>
          {queue.groups.map((group) => (
            <tbody key={group.group}>
              <tr className="queue-group">
                <th scope="rowgroup" colSpan={6}>
                  <div className="between">
                    <span className="label">{t(`group.${group.group}`)}</span>
                    <span className="meta">{t(group.group === "sampled" ? "sampledCount" : "groupCount", { n: group.items.length })}</span>
                  </div>
                </th>
              </tr>
              {group.items.map((item) => {
                const left = item.deadline === null ? null : new Date(item.deadline).getTime() - now;
                const selected = item.id === selectedId;
                return (
                  <tr key={item.id} className={cn("queue-item", selected && "is-selected")}>
                    <td>
                      <Link className="mono queue-id" href={`/${locale}/improve/queue?s=${encodeURIComponent(item.id)}`} aria-current={selected ? "true" : undefined}>
                        {item.id}
                      </Link>
                    </td>
                    <td>
                      <span className="mono queue-anchor">{item.anchor.id}</span>
                      <br />
                      <span className="faint small">{classLine(item)}</span>
                    </td>
                    <td>{item.tier !== null ? <EvidenceBadge tier={item.tier} label={tr("tiers.badge", { tier: item.tier, name: tr(`tiers.name.${item.tier}`) })} /> : "—"}</td>
                    <td className="n">{item.score ?? "—"}</td>
                    <td className="n">{item.submittedAt === null ? "—" : span(now - new Date(item.submittedAt).getTime())}</td>
                    <td className={cn("n", left !== null && left < 0 && "text-fail", left !== null && left >= 0 && left < 86_400_000 && "text-warn")}>{left === null ? "—" : span(left)}</td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      )}
      {queue.decidedToday.length > 0 ? (
        <section className="col queue-decided" aria-labelledby="queue-decided-title">
          <div className="between">
            <h2 className="label" id="queue-decided-title">
              {t("group.decided")}
            </h2>
            <span className="meta">{t(seeds > 0 ? "seedsRevealed" : "groupCount", { n: queue.decidedToday.length })}</span>
          </div>
          <ul className="col queue-decided-list">
            {queue.decidedToday.map((decided) => (
              <li key={`${decided.id}:${decided.decidedAt}`} className="col small queue-decided-item">
                <div className="between">
                  <Link className="mono" href={`/${locale}/improve/queue?s=${encodeURIComponent(decided.id)}`}>
                    {decided.id}
                  </Link>
                  <span>{decided.seed === null ? t(`action.${decided.action}`) : t("seed.knownAnswer", { action: t(`action.${decided.action}`), answer: t(`action.${decided.seed.answer}`) })}</span>
                  <span className="meta">{formatTime(new Date(decided.decidedAt))}</span>
                </div>
                {decided.seed !== null ? (
                  <div className="between">
                    <span className="seed-chip">{t("seed.chip")}</span>
                    <StatusMark tone={decided.seed.matched ? "ok" : "warn"}>{t(decided.seed.matched ? "seed.match" : "seed.diverged")}</StatusMark>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {/* The legend, once a seed is revealed (36 § 7.1; the screen's legend). */}
          {seeds > 0 ? (
            <p className="row small muted queue-legend">
              <span className="seed-chip">{t("seed.chip")}</span>
              <span>{t("seed.legend")}</span>
            </p>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}
