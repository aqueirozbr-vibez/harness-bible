"use client";

import { useTranslations } from "next-intl";
import { Fragment, useState } from "react";

import { FlagButton } from "@/components/assistant/FlagButton";
import { ProposalPanel } from "@/components/assistant/ProposalPanel";
import { ResearchLine } from "@/components/assistant/ResearchLine";
import { SensorVerdicts } from "@/components/assistant/SensorVerdicts";
import { Button } from "@/components/ui/Button";
import { Cite } from "@/components/ui/Cite";
import { DeriveLink } from "@/components/ui/DeriveLink";
import { ErrorBox } from "@/components/ui/ErrorBox";
import { Loader } from "@/components/ui/Loader";
import { Meter } from "@/components/ui/Meter";
import { NoCover } from "@/components/ui/NoCover";
import type { Aid } from "@/lib/aids/schema";
import { refHref, type RefBase } from "@/lib/assistant/links";
import { seedsResearch, type Turn } from "@/lib/assistant/turns";
import { aidKey, explanationOf, formatHeadline, formatInput, formatShown, runProgress, runSeconds, stepState, summaryHeadline, type WalkStep } from "@/lib/assistant/walk";
import type { SseStep } from "@/lib/hooks/useSse";
import { formatDate, formatTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { researchPageHref } from "@/lib/research/links";
import { cn } from "@/lib/utils";

/*
 * A walk turn (feature-specs/18 § 5.2): the user line, then the walk instrument — the step strip, the inputs on step
 * 1, the run line and one step's result on the others, the footer with Back, Flag this step, Start a research (feature-
 * specs/48 § 9.1; unit 75) and Next. The steps are client state: every value arrived in `final` (or sits on the row),
 * so Back and Next change nothing on the server.
 *
 * Nothing here computes: the bars' widths, the headline and the percentages are the workers' (`lib/aids/present.ts`,
 * invariant 12), and the explanation is the sensor's — a withheld one shows the fixed sentence in the `.nocover` form
 * while the step's values stand (D2). While the script runs, the turn is the run line at 0% growing with the status
 * events, and nothing of the model's draft is shown (invariant 14).
 */

export interface WalkTurnExtras {
  readonly aids: ReadonlyArray<Aid>;
  readonly locale: Locale;
  readonly step: number;
  readonly onStep: (step: number) => void;
  /** `Edit inputs`: back to the form with these values; a new run is a new turn (§ 5.2). */
  readonly onEditInputs: (aidId: string, inputs: Readonly<Record<string, number>>) => void;
  /** The live turn's aid and typed inputs, before `final` has a result to show. */
  readonly live: { readonly id: string; readonly inputs: Readonly<Record<string, number>> } | null;
  /** The live turn's run that did not finish (§ 7). */
  readonly failed: { readonly exitCode: number | null; readonly timedOut: boolean; readonly ms: number } | null;
  readonly readOnly: boolean;
  /** The turn's number in the conversation, for its accessible name. */
  readonly index: number;
  /** Where the prices line's citation opens: the peek beside a reader section, the reader itself from any other page. */
  readonly basePath: RefBase;
}

interface WalkTurnProps {
  readonly turn: Turn;
  readonly current: boolean;
  readonly pending: { readonly step: SseStep | null } | null;
  readonly extras: WalkTurnExtras;
  readonly conversationId: string | null;
  readonly verdictsOpen: boolean;
  readonly onToggleVerdicts: () => void;
}

export function WalkTurn({ turn, current, pending, extras, conversationId, verdictsOpen, onToggleVerdicts }: WalkTurnProps) {
  const t = useTranslations("assistant.walk");
  const ta = useTranslations("aids");
  const td = useTranslations("assistant.dock");
  const { aids, locale, step, onStep, onEditInputs, live, failed, readOnly, index, basePath } = extras;
  const [collapsed, setCollapsed] = useState(false);

  const answer = turn.answer;
  const walk = answer?.walk ?? null;
  const aidId = walk?.aidId ?? live?.id ?? "";
  const aid = aids.find((candidate) => candidate.id === aidId) ?? null;
  const inputs = walk?.inputs ?? live?.inputs ?? {};
  const section = aid?.section ?? "";
  /* The aid names its lab; an aid this build no longer ships is named after its own section (`37.8-…` → `lab-37`). */
  const lab = aid?.labId ?? `lab-${aidId.slice(0, 2)}`;
  const askedAt = turn.question.at === null ? "" : formatTime(new Date(turn.question.at));

  /* The strip's steps: the result's when it has arrived, the aid's while it runs, so the strip has its length from the start. */
  const stepTitles: ReadonlyArray<{ readonly ordinal: number; readonly title: string }> =
    walk !== null
      ? walk.steps.map((entry) => ({ ordinal: entry.ordinal, title: aid === null ? entry.titleKey : ta(aidKey(aid, "steps", entry.titleKey)) }))
      : (aid?.steps ?? []).map((entry) => ({ ordinal: entry.ordinal, title: ta(aidKey(aid as Aid, "steps", entry.titleKey)) }));
  const of = stepTitles.length;
  const at = walk === null ? 1 : Math.min(Math.max(step, 1), Math.max(of, 1));
  const shownStep: WalkStep | null = walk === null ? null : (walk.steps[at - 1] ?? null);
  const title = stepTitles[at - 1]?.title ?? "";
  const running = pending !== null && walk === null && failed === null;
  const progress = runProgress(pending?.step ?? null, walk !== null || failed !== null);
  const runLine =
    walk !== null
      ? `100% · ${t("exit", { code: walk.run.exitCode === null ? "—" : String(walk.run.exitCode), s: runSeconds(walk.run.ms) })}`
      : failed !== null
        ? t("exit", { code: failed.exitCode === null ? "—" : String(failed.exitCode), s: runSeconds(failed.ms) })
        : `${String(progress.done * 10)}%`;

  const inputLabel = (key: string): string => {
    const input = aid?.inputs.find((candidate) => candidate.key === key);
    return input === undefined || aid === null ? key : ta(aidKey(aid, "inputs", input.labelKey));
  };

  return (
    <article id={`turn-${turn.key}`} tabIndex={-1} className={cn("turn turn-walk", current ? "turn-current" : "rt")} aria-label={t("turnLabel", { n: index, section })}>
      <div className="turn-you">
        <span className="cap">{t("you", { time: askedAt })}</span>
        <span className="cap">{section}</span>
      </div>

      {collapsed && walk !== null ? (
        <button type="button" className="rb walk-summary between" aria-label={t("reopen")} onClick={() => setCollapsed(false)}>
          <span className="cap">{t("walked", { n: of, headline: summaryHeadline(walk, locale) ?? "—" })}</span>
          <span className="mono verdicts-glyph" aria-hidden="true">
            ▸
          </span>
        </button>
      ) : (
        <section className="inst walk" aria-label={t("title", { section })}>
          <div className="inst-h">
            <span className="t">{t("title", { section })}</span>
            {aid === null ? null : (
              <>
                <span className="sep">·</span>
                <span>{ta(aidKey(aid, "title")).toLowerCase()}</span>
              </>
            )}
            <span className="ts">{t("step", { n: at, m: of })}</span>
          </div>

          <ol className="walk-steps" aria-label={t("stepsLabel")} style={{ gridTemplateColumns: `repeat(${String(Math.max(of, 1))}, minmax(0, 1fr))` }}>
            {stepTitles.map((entry, position) => {
              const n = position + 1;
              const state = stepState(n, at);
              return (
                <li key={entry.ordinal} className={`is-${state}`} aria-current={state === "now" ? "step" : undefined}>
                  <button type="button" disabled={walk === null} onClick={() => onStep(n)}>
                    <span className="meta">{state === "later" ? String(n) : `${String(n)} · ${t(state)}`}</span>
                    <span className="small">{entry.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="walk-body">
            {at === 1 || walk === null ? (
              <>
                <span className="cap">{t("inputs")}</span>
                <div className="walk-inputs">
                  {Object.entries(inputs).map(([key, value]) => {
                    const id = `turn-${turn.key}-${key}`;
                    return (
                      <div key={key} className="field">
                        <label htmlFor={id}>{inputLabel(key)}</label>
                        <input id={id} className="input mono" value={formatInput(value, locale)} readOnly />
                      </div>
                    );
                  })}
                </div>
                {walk !== null && current && !readOnly ? (
                  <div className="row">
                    <Button size="sm" variant="quiet" onClick={() => onEditInputs(aidId, inputs)}>
                      {t("editInputs")}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}

            {walk !== null && at === 1 ? null : (
              <div className={cn("walk-run", failed !== null && "is-failed")}>
                <Loader prefix={t("runLine", { lab })} progress={progress} width={progress.total}>
                  {runLine}
                </Loader>
              </div>
            )}

            {failed === null ? null : (
              <ErrorBox
                title={td("error.title")}
                actions={
                  readOnly ? undefined : (
                    <Button size="sm" onClick={() => onEditInputs(aidId, inputs)}>
                      {t("editInputs")}
                    </Button>
                  )
                }
              >
                {t("failed")}
              </ErrorBox>
            )}

            {walk !== null && shownStep !== null && at > 1 ? <StepResult walk={walk} step={shownStep} title={title} at={at} locale={locale} basePath={basePath} aid={aid} /> : null}
          </div>

          {walk === null ? null : (
            <div className="inst-f walk-foot">
              <Button size="sm" disabled={at <= 1} onClick={() => onStep(at - 1)}>
                {t("back")}
              </Button>
              {answer !== null && conversationId !== null ? (
                <FlagButton messageId={answer.messageId} conversationId={conversationId} kind="answer" flagged={answer.flag} label={t("flagStep")} title={t("flagStepTitle", { n: at, title })} />
              ) : null}
              {/* the walk is an answer with citations, so it seeds a research as any answer does (48 § 9.1) */}
              {answer !== null && conversationId !== null && seedsResearch(turn) ? (
                <Button size="sm" href={researchPageHref(locale, { from: answer.messageId })}>
                  {td("startResearch")}
                </Button>
              ) : null}
              <span className="grow" />
              {at < of ? (
                <Button size="sm" variant="primary" onClick={() => onStep(at + 1)}>
                  {t("next", { title: stepTitles[at]?.title ?? "" })}
                </Button>
              ) : (
                <Button size="sm" variant="primary" onClick={() => setCollapsed(true)}>
                  {t("finish")}
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      {answer !== null && answer.verdicts.length > 0 && !running ? <SensorVerdicts answer={answer} open={verdictsOpen} onToggle={onToggleVerdicts} /> : null}
      {/* a legacy run's research line (feature-specs/43 § 4; 48 § 9.3): a walk is an answer with citations, so it had one too, after its verdicts */}
      {answer !== null && answer.refusal === null && answer.research !== null && !running ? <ResearchLine research={answer.research} locale={locale} /> : null}
      {answer !== null && answer.refusal === null && answer.research !== null && !running
        ? answer.research.proposals.map((proposal) => <ProposalPanel key={proposal.suggestionId} proposal={proposal} context="answer" hrefOf={(sectionId) => refHref(basePath, sectionId)} locale={locale} />)
        : null}
    </article>
  );
}

interface StepResultProps {
  readonly walk: NonNullable<Turn["answer"]>["walk"] & object;
  readonly step: WalkStep;
  readonly title: string;
  readonly at: number;
  readonly locale: Locale;
  readonly basePath: RefBase;
  readonly aid: Aid | null;
}

/** One step's result (§ 5.2): the caption, the bars with their values printed, the headline beside the explanation, the prices line. */
function StepResult({ walk, step, title, at, locale, basePath, aid }: StepResultProps) {
  const t = useTranslations("assistant.walk");
  const tp = useTranslations("assistant");
  const ta = useTranslations("aids");
  const explanation = explanationOf(walk, step.ordinal);
  const barLabel = (labelKey: string): string => (aid === null ? labelKey : ta(aidKey(aid, "bars", labelKey)));

  return (
    <div className="walk-result">
      <span className="cap">{t("stepCap", { n: at, title })}</span>
      {step.bars.length === 0 ? null : (
        <div className="walk-bars">
          {step.bars.map((bar) => {
            const value = bar.shown === null ? "—" : formatShown(bar.shown, bar.unit, locale);
            return (
              <Fragment key={bar.labelKey}>
                <span className="small">{barLabel(bar.labelKey)}</span>
                <Meter value={bar.width} label={t("barLabel", { label: barLabel(bar.labelKey), value })} tone={bar.tone === "ver" ? "ver" : "ink"} />
                <span className="mono small">{value}</span>
              </Fragment>
            );
          })}
        </div>
      )}
      <div className="walk-headline">
        {step.headline === null ? null : <span className="midnum">{formatHeadline(step.headline, locale)}</span>}
        <div className="col gap-s2">
          {explanation === null && step.line === null ? null : (
            <p className="walk-explain">
              {explanation === null ? null : explanation.text.length === 0 ? (
                /* The explanation's words went with the 30 days, a withheld one's line with them; the script's values above stay (feature-specs/21 § 3.2). */
                <span className="nocover purged">{tp("purged")}</span>
              ) : explanation.withheld ? (
                <NoCover>{explanation.text}</NoCover>
              ) : (
                explanation.text
              )}
              {step.line === null ? null : (
                <>
                  {" "}
                  <DeriveLink line={step.line} title={t("deriveTitle", { line: step.line })} />
                </>
              )}
            </p>
          )}
          {step.pricesFrom === null && !walk.sameAsBook ? null : (
            <p className="small muted">
              {step.pricesFrom === null || walk.pricesVerifiedAt === null ? null : (
                <>
                  {t("prices", { date: formatDate(new Date(walk.pricesVerifiedAt), locale) })} <Cite href={refHref(basePath, step.pricesFrom)}>{step.pricesFrom}</Cite>.{" "}
                </>
              )}
              {walk.sameAsBook ? t("sameAsBook") : null}
            </p>
          )}
          {step.missing.length === 0 ? null : (
            <p className="small walk-missing">
              {t("missing")}: <span className="mono">{step.missing.join(", ")}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
