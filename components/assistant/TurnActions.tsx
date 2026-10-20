"use client";

import { useTranslations } from "next-intl";

import { FlagButton } from "@/components/assistant/FlagButton";
import { Button } from "@/components/ui/Button";
import { citationCounts, copyWithCitations, type AnswerView } from "@/lib/assistant/turns";
import { STATUS_EVENT } from "@/components/chrome/StatusNote";

/*
 * The answer's action row (feature-specs/16 § 5.6). `Copy with citations` puts on the clipboard what was on screen,
 * markers and substitution included, and says so in the status bar as the reader's own Copy does.
 *
 * `Flag this answer` is spec 17's `FlagButton`: a coded reason into the grader's calibration set, no text.
 *
 * `Start a research` (feature-specs/48 § 9.1, A6; unit 75) follows it: a link to the Research page seeded from this
 * answer, `?from=<messageId>`, which prefills a new research and writes nothing — nothing is spent until the reader
 * presses Start there. A link, since it opens a page and starts nothing.
 */

interface TurnActionsProps {
  readonly answer: AnswerView;
  /** The conversation the answer belongs to, for the flag's 409 read-back; null only while a turn has no row. */
  readonly conversationId: string | null;
  /** The lab a lab turn picked (feature-specs/24 § 5.5, D6): the one answer that offers `Open Lab NN`. Null on every other turn. */
  readonly lab: { readonly number: number; readonly href: string } | null;
  /** The Research page seeded from this answer (48 § 9.1); null where the turn offers no research (`seedsResearch`) or the reader has no conversation. */
  readonly research: string | null;
}

export function TurnActions({ answer, conversationId, lab, research }: TurnActionsProps) {
  const t = useTranslations("assistant.dock");
  const counts = citationCounts(answer.citations);

  return (
    <div className="row turn-actions">
      <Button
        size="sm"
        onClick={() => {
          void navigator.clipboard
            .writeText(copyWithCitations(answer))
            .then(() => window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: t("copied") })))
            .catch(() => undefined);
        }}
      >
        {t("copy")}
      </Button>
      {conversationId === null ? null : <FlagButton messageId={answer.messageId} conversationId={conversationId} kind="answer" flagged={answer.flag} />}
      {research === null ? null : (
        <Button size="sm" href={research}>
          {t("startResearch")}
        </Button>
      )}
      {lab === null ? null : (
        <Button size="sm" href={lab.href}>
          {t("openLab", { n: lab.number })}
        </Button>
      )}
      <span className="cap turn-counts">{t("counts", { c: counts.citations, f: counts.figures })}</span>
    </div>
  );
}
