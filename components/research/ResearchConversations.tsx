"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { Fragment, useEffect, useId, useRef, useState } from "react";

import { DeleteConversation } from "@/components/assistant/DeleteConversation";
import { citedChaptersLabel } from "@/lib/assistant/label";
import { formatDayMonth, formatTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { runLinePartsOf } from "@/lib/research/runBlock";
import type { ResearchConversationLine } from "@/lib/research/summary";
import type { ResearchRunView } from "@/lib/schemas/api";
import { cn } from "@/lib/utils";

/*
 * The person's researches on the Research page (feature-specs/48 § 11.4; unit 72). The Assistant's tree is built on its
 * turn rows, so this list is a component of its own, in the same classes and the same shape (spec 26 § 5): `New
 * research`, then every research newest first, each labelled by the chapters of its runs' sections — never the
 * person's words (spec 23 D8) — with when it last ran, its runs, its findings that passed and how many of them were
 * drafted or sent where any was, whether it began from an Assistant answer and whether its words are gone; the open
 * one unfolded into its runs, each a link to its block in the column. The list is the server's; the open research's
 * runs are the column's own, live while one is under way, which is why the column renders this region and is handed
 * the list. Between 1000px and 1359px it is the overlay the column's header toggles.
 *
 * Since unit 73 the open research's block ends with its `Export JSONL`, where it has a record to export, and `Delete
 * research` (§ 11.8, § 11.10): the Assistant's `DeleteConversation`, with the research's endpoint and words, outside the
 * row's link, on the page only. A delete comes back to this page with `?deleted=<id>`: the head says so in a status
 * line, and `New research` takes the focus with that line as its description (spec 45 § 3.9). While the dialog is open
 * the overlay's backdrop stands back, so a click outside the dialog does not hide it with the overlay.
 */

interface ResearchConversationsProps {
  /** The listed researches, newest first; the open one is among them, or first when the server has no row for it yet. */
  readonly conversations: ReadonlyArray<ResearchConversationLine>;
  /** How many researches the person has, listed or not. */
  readonly total: number;
  readonly openId: string | null;
  readonly hrefOf: (id: string) => string;
  /** The page with no research open, ready for a question. */
  readonly newHref: string;
  /** The same page listing twenty more, or null when every research is listed. */
  readonly moreHref: string | null;
  /** The open research's runs, oldest first. */
  readonly runs: ReadonlyArray<ResearchRunView>;
  /** Scroll the column to a run's block and give it focus. */
  readonly onOpenRun: (runId: string) => void;
  readonly locale: Locale;
  readonly open: boolean;
  readonly onClose: () => void;
  /** The open research's export (§ 11.10); null where it has no record to export. */
  readonly exportHref: string | null;
  /** Where a deleted research leaves the person: this page without it, `?deleted=<id>` added (§ 11.8). */
  readonly doneHref: (id: string) => string;
  /** The page was reached by a delete (`?deleted=<id>`). */
  readonly deleted: boolean;
}

export function ResearchConversations({ conversations, total, openId, hrefOf, newHref, moreHref, runs, onOpenRun, locale, open, onClose, exportHref, doneHref, deleted }: ResearchConversationsProps) {
  const t = useTranslations("research.list");
  const tw = useTranslations("research.line.word");
  const tx = useTranslations("research.delete");
  const doneId = useId();
  const newRef = useRef<HTMLAnchorElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  /* after a delete, where the person goes next: a new research, the line saying what happened as its description (45 § 3.9) */
  useEffect(() => {
    if (deleted) newRef.current?.focus();
  }, [deleted]);

  return (
    <>
      <button type="button" className={cn("log-backdrop", open && "is-open")} aria-label={t("close")} onClick={dialogOpen ? undefined : onClose} />
      <nav className={cn("assistant-conversations", open && "is-open")} aria-label={t("label")}>
        <div className="inst-h log-head">
          <span className="t">{t("title")}</span>
          <span className="ts">{t("count", { n: total })}</span>
        </div>
        {deleted ? (
          <p id={doneId} className="small conversations-done" role="status">
            {tx("done")}
          </p>
        ) : null}
        <div className="conversations-new rb">
          <Link ref={newRef} href={newHref} className="btn btn-sm" aria-describedby={deleted ? doneId : undefined}>
            {t("new")}
          </Link>
        </div>
        {conversations.length === 0 ? (
          <p className="cap log-none conversations-none">{t("empty")}</p>
        ) : (
          <ol className="col conversations-tree">
            {conversations.map((conversation) => {
              const current = conversation.id === openId;
              /* The meta's parts (§ 19): the findings that passed, as a run's line counts them, and only where one was
                 used how many; each part kept whole and its `·` kept with it, so the 232px row breaks between parts and
                 never leaves a word, or a dot, alone on a line (unit 72's review). */
              const parts = [
                formatDayMonth(new Date(conversation.lastRunAt), locale),
                t("lineRuns", { runs: conversation.runs }),
                t("lineFindings", { f: conversation.findings }),
                ...(conversation.used > 0 ? [t("lineUsed", { u: conversation.used })] : []),
                ...(conversation.seeded ? [t("seeded")] : []),
                ...(conversation.textPurged ? [t("purged")] : []),
              ];
              return (
                <li key={conversation.id} className={cn("rb", current && "is-open")}>
                  <Link href={hrefOf(conversation.id)} className={cn("log-earlier-row", current && "is-current")} aria-current={current ? "page" : undefined}>
                    <span className="small">{citedChaptersLabel(conversation.chapters) ?? t("noSections")}</span>
                    <span className="meta">
                      {parts.map((part, index) => (
                        <Fragment key={index}>
                          {index === 0 ? null : " "}
                          <span className="research-meta-part">{index === parts.length - 1 ? part : `${part} ·`}</span>
                        </Fragment>
                      ))}
                    </span>
                  </Link>
                  {current ? (
                    <div className="conversations-open">
                      {runs.length > 0 ? (
                        <ol className="research-runs" aria-label={t("runs")}>
                          {runs.map((run) => {
                            const word = tw(runLinePartsOf(run).word);
                            const values = { n: run.ordinal, time: formatTime(new Date(run.createdAt)), word };
                            return (
                              <li key={run.id}>
                                <a
                                  href={`#run-${run.id}`}
                                  className="research-run-row"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    onOpenRun(run.id);
                                  }}
                                >
                                  {run.line.key === "done" ? t("runDone", { ...values, p: run.pages.length, f: run.findings.length }) : t("run", values)}
                                </a>
                              </li>
                            );
                          })}
                        </ol>
                      ) : null}
                      {/* never inside the row's link: a button there would be interactive content in interactive content */}
                      <div className="inst-f log-foot">
                        {exportHref === null ? (
                          <span />
                        ) : (
                          <a className="xref" href={exportHref} download>
                            {t("export")}
                          </a>
                        )}
                        <DeleteConversation
                          id={conversation.id}
                          chapters={citedChaptersLabel(conversation.chapters)}
                          exportHref={exportHref}
                          ledToProposal={false}
                          streaming={false}
                          doneHref={doneHref(conversation.id)}
                          onOpenChange={setDialogOpen}
                          endpoint={`/api/v1/research/conversations/${encodeURIComponent(conversation.id)}`}
                          namespace="research.delete"
                        />
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {moreHref === null ? null : (
          <div className="conversations-more rb">
            <Link href={moreHref} className="btn btn-sm">
              {t("more")}
            </Link>
          </div>
        )}
      </nav>
    </>
  );
}
