import type { Turn } from "@/lib/assistant/turns";

/*
 * The open conversation's line in the assistant page's list, before the server has one for it (feature-specs/26
 * § 5). A conversation is created by its first question, and the list is the server's: until the turn ends and the
 * page refreshes, the conversation on screen has no row there. This builds that row from the dock's own turns, by
 * the rules `listConversations` counts with, so the row does not change when the server's replaces it.
 */

export interface ConversationLine {
  readonly id: string;
  readonly citedChapters: ReadonlyArray<number>;
  readonly lastMessageAt: string;
  readonly turns: number;
  readonly passCount: number;
  readonly refusedCount: number;
  readonly textPurged?: boolean;
}

/** `now` is the caller's clock: a conversation whose first question was just asked has no stored time yet. */
export function lineOfTurns(id: string, turns: ReadonlyArray<Turn>, now: string): ConversationLine {
  const answered = turns.flatMap((turn) => (turn.answer === null ? [] : [turn.answer]));
  const last = [...turns].reverse().find((turn) => turn.answer?.at !== null && turn.answer?.at !== undefined)?.answer?.at ?? [...turns].reverse().find((turn) => turn.question.at !== null)?.question.at ?? now;
  return {
    id,
    citedChapters: [...new Set(answered.flatMap((answer) => answer.citations.map((citation) => Number(citation.sectionId.slice(0, 2)))).filter((chapter) => Number.isInteger(chapter)))],
    lastMessageAt: last,
    /* A turn is an assistant row: a question still being answered is not one yet. */
    turns: answered.length,
    /* "pass" is every sensor PASS or NA, as the server counts it: an NA is a sensor that had nothing to check. */
    passCount: answered.filter((answer) => answer.refusal === null && answer.verdicts.every((verdict) => verdict.verdict === "PASS" || verdict.verdict === "NA")).length,
    refusedCount: answered.filter((answer) => answer.refusal !== null).length,
  };
}
