"use client";

import { useTranslations } from "next-intl";

import { citedChaptersLabel } from "@/lib/assistant/label";
import Link from "next/link";
import { useRef, type KeyboardEvent } from "react";

import { StatusMark } from "@/components/ui/StatusMark";
import { hashFragment, logMarkOf, type Turn } from "@/lib/assistant/turns";
import { formatDayMonth, formatTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { cn } from "@/lib/utils";

/*
 * The conversation as a sequence of verdicts (feature-specs/17 § 5): one row per turn, so a reader sees at a glance
 * which turns passed, which were refused and which is running, and can reach earlier conversations.
 *
 * It is a client component fed by the dock's own turns rather than a server render of the rows, because the dock
 * keeps its turns in client state after a `replaceState` (spec 16 § 5.8): a server rail would stop agreeing with the
 * dock the moment a question was asked. The earlier conversations are server data and arrive as props.
 */

export interface EarlierConversation {
  readonly id: string;
  /** The chapters its answers cite, in order of first citation: its label (feature-specs/23 D8). */
  readonly citedChapters: ReadonlyArray<number>;
  readonly lastMessageAt: string;
  readonly turns: number;
  readonly passCount: number;
  readonly refusedCount: number;
  /** Every word of the conversation is gone after 30 days; its row says so (feature-specs/21 § 3.2). */
  readonly textPurged?: boolean;
}

/** Where a walk turn's strip stands (feature-specs/18 § 5.2), from the dock, which owns the step. */
export interface WalkRow {
  readonly aidId: string;
  readonly step: number;
  readonly of: number;
  readonly runMs: number | null;
}

interface ConversationLogProps {
  readonly turns: ReadonlyArray<Turn>;
  /** The streaming turn's key, whose row reads `answering`. */
  readonly liveKey: string | null;
  readonly locale: Locale;
  /** Which turns' verdict boxes are open: a row's `aria-expanded` mirrors its box (§ 5.2). */
  readonly openVerdicts: ReadonlySet<string>;
  /** Scroll the dock to the turn and open its verdicts. */
  readonly onOpenTurn: (key: string) => void;
  readonly earlier: ReadonlyArray<EarlierConversation>;
  /** Where an earlier conversation opens: the page the reader is on with `?ask=<id>`, or the assistant's own page. */
  readonly earlierHref: (id: string) => string;
  /** The `export JSONL` link (§ 6); null until the endpoint exists. */
  readonly exportHref: string | null;
  /** Below 1360px the rail is an overlay the dock's header toggles (§ 5.1). */
  readonly open: boolean;
  readonly onClose: () => void;
  /** Outside the reader no page reserves the rail a column: it is the toggled overlay at every width (feature-specs/24 § 5.6). */
  readonly over?: boolean;
  /** The walk turns' strips by turn key: their rows read `step 2/4` and `walk · derive run 1` (feature-specs/18 § 5.2). */
  readonly walkRows?: Readonly<Record<string, WalkRow>>;
}

interface LogTurnsProps {
  readonly turns: ReadonlyArray<Turn>;
  /** The streaming turn's key, whose row reads `answering`. */
  readonly liveKey: string | null;
  /** Which turns' verdict boxes are open: a row's `aria-expanded` mirrors its box (§ 5.2). */
  readonly openVerdicts: ReadonlySet<string>;
  /** Scroll the dock to the turn and open its verdicts. */
  readonly onOpenTurn: (key: string) => void;
  /** The walk turns' strips by turn key: their rows read `step 2/4` and `walk · derive run 1` (feature-specs/18 § 5.2). */
  readonly walkRows?: Readonly<Record<string, WalkRow>>;
}

/** One row per turn of the open conversation (§ 5.2): the rail's list, and the unfolded conversation of the assistant page's tree. */
export function LogTurns({ turns, liveKey, openVerdicts, onOpenTurn, walkRows = {} }: LogTurnsProps) {
  const t = useTranslations("assistant.log");
  const tr = useTranslations("assistant.refusal");
  const tw = useTranslations("assistant.walk");
  const tm = useTranslations("assistant.mode");
  const tp = useTranslations("assistant");
  const listRef = useRef<HTMLOListElement>(null);

  /** Arrow keys move between rows; the `ol` stays a list and the buttons are the focusables (§ 9). */
  const onKey = (event: KeyboardEvent<HTMLOListElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };

  return (
    <ol className="col log-turns" ref={listRef} onKeyDown={onKey}>
      {turns.map((turn, index) => {
        const mark = logMarkOf(turn, turn.key === liveKey);
        const expanded = openVerdicts.has(turn.key);
        const current = index === turns.length - 1;
        const time = turn.question.at === null ? "" : formatTime(new Date(turn.question.at));
        /* A walk's row says where its strip stands and which run of the conversation it is (18 § 5.2). */
        const walk = walkRows[turn.key];
        const runIndex = walk === undefined ? 0 : turns.slice(0, index + 1).filter((candidate) => walkRows[candidate.key] !== undefined).length;
        const markWord =
          walk !== undefined ? tw("logStep", { n: walk.step, m: walk.of }) : mark.kind === "pass" ? t("pass") : mark.kind === "refused" ? t("refused") : mark.kind === "answering" ? t("answering") : t("failed");
        const derive = turn.answer?.verdicts.find((verdict) => verdict.sensor === "derive");
        const tone = walk === undefined ? mark.tone : turn.key === liveKey ? "run" : derive === undefined ? mark.tone : derive.verdict === "PASS" ? "ok" : derive.verdict === "WARN" ? "warn" : "mute";
        const caption =
          walk !== undefined
            ? tw("logRun", { mode: tw("modeShort"), k: runIndex })
            : mark.kind === "pass"
              ? (turn.mode.toLowerCase() === "brief"
                  ? t("claims", { mode: tm("short.brief"), n: turn.answer?.claims?.length ?? turn.answer?.citations.length ?? 0 })
                  : t("citations", { mode: tm(`short.${turn.mode.toLowerCase()}`), n: turn.answer?.citations.length ?? 0 })) + (mark.replaced > 0 ? ` · ${t("replaced", { n: mark.replaced })}` : "")
              : mark.kind === "refused"
                ? tr(`cause.${mark.cause}`)
                : mark.kind === "answering"
                  ? t("answering")
                  : t("failed");
        return (
          <li key={turn.key} className={cn("rb log-turn", current && "is-current", mark.kind === "refused" && "is-refused")}>
            <button type="button" aria-expanded={expanded} aria-current={current ? "true" : undefined} aria-label={t("rowLabel", { n: index + 1, mark: markWord })} onClick={() => onOpenTurn(turn.key)}>
              <span className="between log-turn-head">
                <span className="meta">{t("turn", { n: index + 1, time })}</span>
                <StatusMark tone={tone}>{markWord}</StatusMark>
              </span>
              <span className="small">{turn.question.text ?? (turn.question.at === null ? "" : tp("purgedShort"))}</span>
              <span className="cap">
                {caption}
                {turn.answer?.flag === null || turn.answer?.flag === undefined ? "" : ` ${t("flagged")}`}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** What a row's mark means (§ 5.2). */
export function LogKey() {
  const t = useTranslations("assistant.log");
  return (
    <div className="col log-key">
      <span className="cap">{t("key")}</span>
      <StatusMark tone="ok">{t("keyPass")}</StatusMark>
      <StatusMark tone="fail">{t("keyRefused")}</StatusMark>
      <StatusMark tone="run">{t("keyRunning")}</StatusMark>
    </div>
  );
}

export function ConversationLog({ turns, liveKey, locale, openVerdicts, onOpenTurn, earlier, earlierHref, exportHref, open, onClose, over = false, walkRows = {} }: ConversationLogProps) {
  const t = useTranslations("assistant.log");
  const tp = useTranslations("assistant");
  const lastHash = [...turns].reverse().find((turn) => turn.answer?.ledger !== null && turn.answer?.ledger !== undefined)?.answer?.ledger?.hash ?? null;

  return (
    <>
      <button type="button" className={cn("log-backdrop", open && "is-open", over && "is-over")} aria-label={t("close")} onClick={onClose} />
      <aside className={cn("rl conversation-log", open && "is-open", over && "is-over")} aria-label={t("label")}>
        <div className="inst-h log-head">
          <span className="t">{t("title")}</span>
          <span className="ts">{t("turns", { n: turns.length })}</span>
        </div>
        <LogTurns turns={turns} liveKey={liveKey} openVerdicts={openVerdicts} onOpenTurn={onOpenTurn} walkRows={walkRows} />
        <LogKey />
        <div className="col rt log-earlier">
          <span className="cap log-earlier-cap">{t("earlier")}</span>
          {earlier.length === 0 ? (
            <span className="cap log-none">{t("none")}</span>
          ) : (
            earlier.map((conversation) => (
              <Link key={conversation.id} href={earlierHref(conversation.id)} className="rb log-earlier-row">
                <span className="small">{citedChaptersLabel(conversation.citedChapters) ?? t("noCitations")}</span>
                <span className="meta">
                  {t("earlierLine", { date: formatDayMonth(new Date(conversation.lastMessageAt), locale), turns: conversation.turns, pass: conversation.passCount })}
                  {conversation.refusedCount > 0 ? t("earlierRefused", { n: conversation.refusedCount }) : ""}
                  {conversation.textPurged === true ? ` · ${tp("purgedShort")}` : ""}
                </span>
              </Link>
            ))
          )}
        </div>
        <div className="inst-f log-foot">
          {exportHref === null ? <span /> : <a className="xref" href={exportHref} download>{t("export")}</a>}
          {lastHash === null ? null : <span className="tex">{hashFragment(lastHash)}</span>}
        </div>
      </aside>
    </>
  );
}
