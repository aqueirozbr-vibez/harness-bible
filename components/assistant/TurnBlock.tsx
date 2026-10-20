"use client";

import { useTranslations } from "next-intl";

import { AnswerBody } from "@/components/assistant/AnswerBody";
import { BriefTurn } from "@/components/assistant/BriefTurn";
import { CompareTurn } from "@/components/assistant/CompareTurn";
import { LabTurn } from "@/components/assistant/LabTurn";
import { FlagButton } from "@/components/assistant/FlagButton";
import { ProposalPanel } from "@/components/assistant/ProposalPanel";
import { RefusalCard } from "@/components/assistant/RefusalCard";
import { ResearchLine } from "@/components/assistant/ResearchLine";
import { SensorVerdicts } from "@/components/assistant/SensorVerdicts";
import { TurnActions } from "@/components/assistant/TurnActions";
import { WalkTurn, type WalkTurnExtras } from "@/components/assistant/WalkTurn";
import { refHref, type RefBase } from "@/lib/assistant/links";
import { seedsResearch, type Turn } from "@/lib/assistant/turns";
import { formatTime } from "@/lib/i18n/format";
import type { SseStep } from "@/lib/hooks/useSse";
import type { Locale } from "@/lib/i18n/routing";
import { researchPageHref } from "@/lib/research/links";
import { cn } from "@/lib/utils";

/*
 * One turn in the dock's log (feature-specs/16 § 5.4): the reader's question on `--bg-2` with a left rule, then the
 * assistant's block.
 *
 * While the draft streams, the block is `.answer-pending`: the tokens as one paragraph of plain text with the
 * caret, and the step line under the head. Nothing in it is a chip, a link or a number in a frame, and it is
 * `aria-hidden` (D7), because what the sensors have passed is not known yet. On `final` the pending text is replaced
 * by the answer's own claims — never kept beside them (invariant 14).
 *
 * A walk turn (feature-specs/18 § 5.2) is `WalkTurn` instead: the strip, the run line and the step's values. A walk
 * the flow refused, or one that failed before a result, renders as any other turn does.
 *
 * Every answered turn whose words are held offers `Start a research` in its action row (feature-specs/48 § 9.1; unit
 * 75), whatever its mode. The research line and the proposals under an answer are a legacy run's alone (§ 9.3): no
 * turn has been handed to research since unit 75, so a new turn has neither.
 */

interface TurnBlockProps {
  readonly turn: Turn;
  /** The newest turn: its question renders at reading size and its verdicts open expanded (§ 5.7). */
  readonly current: boolean;
  /** Set while this turn is streaming: the step the flow is on and the draft so far. */
  readonly pending: { readonly step: SseStep | null; readonly tokens: string } | null;
  /** Where a chip opens: the peek beside a reader section, the reader itself from any other page (feature-specs/24 § 5.5). */
  readonly basePath: RefBase;
  /** The conversation on screen; null until the first turn opens one. */
  readonly conversationId: string | null;
  /** The verdicts box's state, owned by the dock so the log rail can open it (17 § 5.2). */
  readonly verdictsOpen: boolean;
  readonly onToggleVerdicts: () => void;
  /** What a walk turn needs beyond the turn: the aids, the strip's step and its callbacks (feature-specs/18 § 5.2). */
  readonly walk?: WalkTurnExtras;
  /** The release's chapters, for a compare's side captions (feature-specs/19 § 6.1). */
  readonly chapters?: ReadonlyArray<{ readonly number: number; readonly title: string }>;
  readonly locale: Locale;
}

export function TurnBlock({ turn, current, pending, basePath, conversationId, verdictsOpen, onToggleVerdicts, walk, chapters = [], locale }: TurnBlockProps) {
  const t = useTranslations("assistant.dock");
  const ta = useTranslations("assistant");
  const answer = turn.answer;
  const mode = turn.mode.toLowerCase();
  const purged = answer !== null && answer.claims === null && answer.text === null && answer.ledger !== null;

  const walking = turn.mode.toLowerCase() === "walk" && walk !== undefined && (answer === null ? walk.live !== null : answer.walk !== null);
  if (walking && walk !== undefined) {
    return <WalkTurn turn={turn} current={current} pending={pending === null ? null : { step: pending.step }} extras={walk} conversationId={conversationId} verdictsOpen={verdictsOpen} onToggleVerdicts={onToggleVerdicts} />;
  }

  const askedAt = turn.question.at === null ? null : formatTime(new Date(turn.question.at));
  const answeredAt = answer?.at === null || answer?.at === undefined ? askedAt : formatTime(new Date(answer.at));

  return (
    <article id={`turn-${turn.key}`} tabIndex={-1} className={cn("turn", current ? "turn-current" : "rt")} aria-label={current ? t("currentTurn") : t("earlierTurn")}>
      {turn.question.text === null ? (
        /* A question read back from its row with no words: the 30 days took them (feature-specs/21 § 3.2). */
        turn.question.at === null ? null : (
          <div className="turn-you">
            <span className="cap">{t("you", { time: askedAt ?? "" })}</span>
            <p className="small">
              <span className="nocover purged">{ta("purged")}</span>
            </p>
          </div>
        )
      ) : (
        <div className="turn-you">
          <span className="cap">{t("you", { time: askedAt ?? "" })}</span>
          <p className={current ? "ui" : "small"}>{turn.question.text}</p>
        </div>
      )}

      <div className="turn-assistant">
        <div className="between">
          <span className="cap">{t("assistantTurn", { mode: t(`mode.${turn.mode.toLowerCase()}`).toLowerCase(), time: answeredAt ?? "" })}</span>
          {answer?.citesEdition === null || answer?.citesEdition === undefined ? null : (
            <span className="cap">{t("cites", { lang: answer.citesEdition.toLowerCase(), edition: answer.citesEdition.toLowerCase(), version: answer.citations[0]?.version ?? "" })}</span>
          )}
        </div>

        {pending === null ? null : (
          <>
            {pending.step === null ? null : <span className="cap">{t(`step.${pending.step}`)}</span>}
            <p className="answer-pending caret" aria-hidden="true">
              {pending.tokens}
            </p>
          </>
        )}

        {answer === null ? null : (
          <>
            {answer.refusal === null ? (
              <>
                {/* The three shaped modes have bodies of their own (feature-specs/19 § 6); explain's is the claims. */}
                {/* A compare or a brief whose words the 30 days took has no claims to lay out: it renders as any purged
                    answer does, the line and its chips (feature-specs/21 § 3.2). A lab keeps its table, which is the run's. */}
                {mode === "compare" && !purged ? (
                  <CompareTurn answer={answer} basePath={basePath} chapters={chapters} />
                ) : mode === "lab" ? (
                  <LabTurn answer={answer} basePath={basePath} locale={locale} />
                ) : mode === "brief" && !purged ? (
                  <BriefTurn answer={answer} basePath={basePath} />
                ) : (
                  <div className="turn-body">
                    <AnswerBody answer={answer} basePath={basePath} />
                  </div>
                )}
                {/* `Open Lab NN` belongs to a lab turn, for the lab it picked: no other answer stands beside a chapter whose lab it could offer (D6). */}
                <TurnActions
                  answer={answer}
                  conversationId={conversationId}
                  lab={answer.lab === null ? null : { number: answer.lab.lab.number, href: `/${locale}/ch/${String(answer.lab.lab.number).padStart(2, "0")}/@lab` }}
                  research={conversationId !== null && seedsResearch(turn) ? researchPageHref(locale, { from: answer.messageId }) : null}
                />
              </>
            ) : (
              /* A refusal is an answer of a different kind: the card in place of the body, no copy and no count (17 § 3). */
              <RefusalCard
                refusal={answer.refusal}
                hrefOf={(sectionId) => refHref(basePath, sectionId)}
                action={conversationId === null ? undefined : <FlagButton messageId={answer.messageId} conversationId={conversationId} kind="refusal" flagged={answer.flag} quiet />}
              />
            )}
            {answer.verdicts.length === 0 ? null : <SensorVerdicts answer={answer} open={verdictsOpen} onToggle={onToggleVerdicts} />}
            {/* a legacy run's research line (feature-specs/43 § 4; 48 § 9.3): outside the answer block, never on a refusal; under it each proposal the run made (§ 5) */}
            {answer.refusal === null && answer.research !== null ? <ResearchLine research={answer.research} locale={locale} /> : null}
            {answer.refusal === null && answer.research !== null
              ? answer.research.proposals.map((proposal) => <ProposalPanel key={proposal.suggestionId} proposal={proposal} context="answer" hrefOf={(sectionId) => refHref(basePath, sectionId)} locale={locale} />)
              : null}
          </>
        )}
      </div>
    </article>
  );
}
