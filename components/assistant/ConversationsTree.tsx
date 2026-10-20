"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { LogKey, LogTurns, type EarlierConversation, type WalkRow } from "@/components/assistant/ConversationLog";
import { DeleteConversation } from "@/components/assistant/DeleteConversation";
import { citedChaptersLabel } from "@/lib/assistant/label";
import type { Turn } from "@/lib/assistant/turns";
import { formatDayMonth } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { cn } from "@/lib/utils";

/*
 * The conversations of the assistant's page (feature-specs/26 § 5): one tree. Every conversation the reader has
 * had, newest first, and the open one unfolded into its turns — the same rows the log rail shows beside a chapter,
 * because it is the same log. The list is the server's; the open conversation's turns are the dock's own, live while
 * an answer streams, which is why the dock renders this region and is handed the list.
 *
 * A conversation is labelled by the chapters its answers cite, never by the reader's words (feature-specs/23 D8); the
 * questions are in the open conversation's rows, where they have always been.
 *
 * Since unit 62i the open conversation's block ends with its export and `Delete conversation`, whether or not it has
 * turns (feature-specs/45 § 3.9). A delete returns to this page with `?deleted=<id>`: the head then says so, and
 * `New conversation` takes focus with that line as its description. While its dialog is open the overlay's backdrop
 * stands back, so a click outside the dialog does not hide it with the overlay (review of unit 62).
 */

interface ConversationsTreeProps {
  /** The listed conversations, newest first; the open one is among them, or first when the server has no row for it yet. */
  readonly conversations: ReadonlyArray<EarlierConversation>;
  /** How many conversations the reader has, listed or not. */
  readonly total: number;
  readonly openId: string | null;
  readonly hrefOf: (id: string) => string;
  /** The page with no conversation open: the dock ready for a first question. */
  readonly newHref: string;
  /** The same page listing twenty more, or null when every conversation is listed. */
  readonly moreHref: string | null;
  /** The open conversation's `export JSONL` (feature-specs/17 § 6); null until it has an answer to export. */
  readonly exportHref: string | null;
  readonly turns: ReadonlyArray<Turn>;
  readonly liveKey: string | null;
  readonly openVerdicts: ReadonlySet<string>;
  readonly onOpenTurn: (key: string) => void;
  readonly walkRows: Readonly<Record<string, WalkRow>>;
  readonly locale: Locale;
  /** Between 1000px and 1359px the region is an overlay the dock's header toggles, as the log rail is beside a chapter (§ 6). */
  readonly open: boolean;
  readonly onClose: () => void;
  /** An answer streams: the open conversation's delete waits for it (45 § 3.9). */
  readonly streaming: boolean;
  /** An answer of the open conversation led to a proposal, which its delete leaves under Improve (45 § 3.6). */
  readonly ledToProposal: boolean;
  /** Where a deleted conversation leaves the reader: this page without it, `?deleted=<id>` added. */
  readonly doneHref: (id: string) => string;
  /** The page was reached by a delete (`?deleted=<id>`). */
  readonly deleted: boolean;
}

export function ConversationsTree({ conversations, total, openId, hrefOf, newHref, moreHref, exportHref, turns, liveKey, openVerdicts, onOpenTurn, walkRows, locale, open, onClose, streaming, ledToProposal, doneHref, deleted }: ConversationsTreeProps) {
  const t = useTranslations("assistant.page");
  const tl = useTranslations("assistant.log");
  const td = useTranslations("assistant.dock");
  const ta = useTranslations("assistant");
  const tx = useTranslations("assistant.delete");
  const doneId = useId();
  const newRef = useRef<HTMLAnchorElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  /* after a delete, where the reader goes next: a new conversation, the line saying what happened as its description (45 § 3.9) */
  useEffect(() => {
    if (deleted) newRef.current?.focus();
  }, [deleted]);

  return (
    <>
      <button type="button" className={cn("log-backdrop", open && "is-open")} aria-label={tl("close")} onClick={dialogOpen ? undefined : onClose} />
      <nav className={cn("assistant-conversations", open && "is-open")} aria-label={t("listLabel")}>
        <div className="inst-h log-head">
          <span className="t">{t("conversationsTitle")}</span>
          <span className="ts">{t("conversations", { n: total })}</span>
        </div>
        {deleted ? (
          <p id={doneId} className="small conversations-done" role="status">
            {tx("done")}
          </p>
        ) : null}
        <div className="conversations-new rb">
          <Link ref={newRef} href={newHref} className="btn btn-sm" aria-describedby={deleted ? doneId : undefined}>
            {td("newConversation")}
          </Link>
        </div>
        {conversations.length === 0 ? (
          <p className="cap log-none conversations-none">{t("empty")}</p>
        ) : (
          <ol className="col conversations-tree">
            {conversations.map((conversation) => {
              const current = conversation.id === openId;
              return (
                <li key={conversation.id} className={cn("rb", current && "is-open")}>
                  <Link href={hrefOf(conversation.id)} className={cn("log-earlier-row", current && "is-current")} aria-current={current ? "page" : undefined}>
                    <span className="small">{citedChaptersLabel(conversation.citedChapters) ?? tl("noCitations")}</span>
                    <span className="meta">
                      {tl("earlierLine", { date: formatDayMonth(new Date(conversation.lastMessageAt), locale), turns: conversation.turns, pass: conversation.passCount })}
                      {conversation.refusedCount > 0 ? tl("earlierRefused", { n: conversation.refusedCount }) : ""}
                      {conversation.textPurged === true ? ` · ${ta("purgedShort")}` : ""}
                    </span>
                  </Link>
                  {current ? (
                    <div className="conversations-open">
                      {turns.length > 0 ? <LogTurns turns={turns} liveKey={liveKey} openVerdicts={openVerdicts} onOpenTurn={onOpenTurn} walkRows={walkRows} /> : null}
                      {/* never inside the row's link: a button there would be interactive content in interactive content */}
                      <div className="inst-f log-foot">
                        {exportHref === null ? <span /> : (
                          <a className="xref" href={exportHref} download>
                            {tl("export")}
                          </a>
                        )}
                        <DeleteConversation id={conversation.id} chapters={citedChaptersLabel(conversation.citedChapters)} exportHref={exportHref} ledToProposal={ledToProposal} streaming={streaming} doneHref={doneHref(conversation.id)} onOpenChange={setDialogOpen} />
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
        <LogKey />
      </nav>
    </>
  );
}
