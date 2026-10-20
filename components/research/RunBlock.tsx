"use client";

import { useTranslations } from "next-intl";

import { FlagButton } from "@/components/assistant/FlagButton";
import { RefusalCard } from "@/components/assistant/RefusalCard";
import { STATUS_EVENT } from "@/components/chrome/StatusNote";
import { FindingCard } from "@/components/research/FindingCard";
import { RunLine } from "@/components/research/RunLine";
import { RunPages } from "@/components/research/RunPages";
import { RunReport } from "@/components/research/RunReport";
import { RunSteps } from "@/components/research/RunSteps";
import { Button } from "@/components/ui/Button";
import { formatDuration, formatTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { FindingRole } from "@/lib/research/findingAction";
import { researchRefHref, type ResearchRefBase } from "@/lib/research/links";
import { copyReportOf, runUnderWay } from "@/lib/research/runBlock";
import { ResearchRunViewSchema, type ResearchRunView } from "@/lib/schemas/api";

/*
 * One run of a research in the column's log (feature-specs/48 § 11.3, § 20; unit 72): an `article` labelled `research
 * {n}`, the person's question in the Assistant's `.turn-you` form, then the run — its time and how long it took, its
 * line, its steps, its report, the pages it read and the findings that passed, and its cost.
 *
 * The report, the pages and the findings are containers from the first render, empty and `aria-live="off"`, filled
 * when the run has them; so is the steps list, and the cost row: what the log announces of a run is its question and
 * its line, whose words change once a state. A refused run is the Assistant's refusal card in place of the body, its
 * pointers into the reader by `researchRefHref` and its footer `refused before any search`. A run that failed, stopped
 * or went stale shows its line and what it has; its failure's code is never shown (spec 43 D10). A run whose words the
 * 30 days took keeps its line from the counts its row keeps, its question reads that its words were removed, and each
 * finding is its outcome's line alone (§ 11.3, § 17.1).
 *
 * Since unit 73 the action row (§ 11.3, § 11.7, § 11.9): a run that ended `DONE` with a report offers `Copy report` — its
 * paragraphs with their markers and the pages they cite, the status bar saying `copied` as `Copy with citations` does —
 * and `Flag this report`; a refused run's card carries the refusal's quiet `Flag` in its footer. Both flags are the
 * Assistant's `FlagButton` with the run's endpoint and research's words, a 409 read back from the run's own view, and
 * the flag the view already carries shown as it stands. The row is `aria-live="off"`, so its buttons arriving with the
 * end are not read out.
 */

/** The flag that stands on a run, read again from its view after a 409 (§ 11.7, § 18). */
async function standingFlagOf(runId: string): Promise<string | null> {
  const view = await fetch(`/api/v1/research/runs/${encodeURIComponent(runId)}`, { headers: { accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const parsed = ResearchRunViewSchema.safeParse(view);
  return parsed.success ? (parsed.data.flag?.reason ?? null) : null;
}

interface RunBlockProps {
  readonly run: ResearchRunView;
  readonly refBase: ResearchRefBase;
  readonly locale: Locale;
  /** The page stopped following this run at its bound with the run still under way (§ 6). */
  readonly lost: boolean;
  /** Who the person is to a finding: its button by role (§ 8.1; unit 74). */
  readonly findingRole: FindingRole;
}

export function RunBlock({ run, refBase, locale, lost, findingRole }: RunBlockProps) {
  const t = useTranslations("research");
  const underWay = runUnderWay(run) && !lost;
  const startedAt = new Date(run.createdAt);
  const time = formatTime(startedAt);
  const ended = run.finishedAt !== null;
  /* the cost once the run has ended, where it reached anything that costs (a refusal by rule never did) */
  const spent = !underWay && run.refusal === null && (run.usage.costUsd !== null || run.usage.searches > 0 || run.usage.pagesOpened > 0);
  /* a run that ended with a report: what Copy report copies and Flag this report labels (§ 11.7, § 11.9) */
  const reported = run.state === "DONE" && run.report !== null;
  const flag = (kind: "report" | "refusal", quiet: boolean) => (
    <FlagButton
      kind={kind}
      quiet={quiet}
      namespace="research.flag"
      endpoint={`/api/v1/research/runs/${encodeURIComponent(run.id)}/flag`}
      readBack={() => standingFlagOf(run.id)}
      flagged={run.flag === null ? null : { reason: run.flag.reason }}
    />
  );
  return (
    <article id={`run-${run.id}`} tabIndex={-1} className="run" aria-label={t("run.label", { n: run.ordinal })} data-run={run.id}>
      <div className="turn-you">
        <span className="cap">{t("run.you", { time })}</span>
        {run.question === null ? (
          <p className="small">
            <span className="nocover purged">{t("run.purged")}</span>
          </p>
        ) : (
          <p className="ui" lang={run.language}>
            {run.question}
          </p>
        )}
      </div>
      <div className="run-body">
        {/* its duration arrives with the end, which the line announces: the caption is not read out a second time */}
        <span className="cap" aria-live="off">
          {ended && run.finishedAt !== null ? t("run.cap", { time, duration: formatDuration(new Date(run.finishedAt).getTime() - startedAt.getTime()) }) : t("run.capStarted", { time })}
        </span>
        <RunLine run={run} locale={locale} lost={lost} />
        {run.refusal !== null ? (
          <RefusalCard refusal={run.refusal} hrefOf={(sectionId) => researchRefHref(refBase, sectionId)} foot={t("refusal.foot", { code: run.refusal.code })} action={run.state === "REFUSED" ? flag("refusal", true) : undefined} />
        ) : (
          <>
            <RunSteps runId={run.id} steps={run.steps} underWay={underWay} />
            <RunReport run={run} refBase={refBase} />
            <RunPages run={run} />
            <div className="run-findings" aria-live="off">
              {run.findings.map((finding) => (
                <FindingCard key={finding.id} finding={finding} of={run.findings.length} refBase={refBase} contentLang={run.language} runId={run.id} role={findingRole} locale={locale} />
              ))}
            </div>
            <div className="row run-actions" aria-live="off">
              {reported ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(copyReportOf(run))
                        .then(() => window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: t("actions.copied") })))
                        .catch(() => undefined);
                    }}
                  >
                    {t("actions.copy")}
                  </Button>
                  {flag("report", false)}
                </>
              ) : null}
              {spent ? <span className="meta">{t("actions.cost", { cost: run.usage.costUsd ?? "—", s: run.usage.searches, p: run.usage.pagesOpened })}</span> : null}
            </div>
          </>
        )}
      </div>
    </article>
  );
}
