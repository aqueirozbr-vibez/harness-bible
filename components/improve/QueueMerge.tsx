import { useTranslations } from "next-intl";

import { OutcomeRefresh } from "@/components/improve/OutcomeRefresh";
import { QueueMergeButton } from "@/components/improve/QueueMergeButton";
import { QueueRecheck } from "@/components/improve/QueueRecheck";
import { StatusMark } from "@/components/ui/StatusMark";
import { formatDateTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { mergeStateOf, versionAfter } from "@/lib/improve/merge";
import { refreshKeyOf } from "@/lib/improve/outcomeView";
import type { StatusTone } from "@/lib/schemas/domain";
import { mergesAfter } from "@/lib/schemas/improve";
import type { MergeState } from "@/lib/schemas/merge";
import type { SuggestionView } from "@/lib/schemas/suggestions";

interface QueueMergeProps {
  readonly locale: Locale;
  readonly view: SuggestionView;
  /** The curator may have the merge check again: it is accepted, and not their own. */
  readonly mayRecheck: boolean;
}

const TONE: Readonly<Record<MergeState, StatusTone>> = { READY: "ok", CHECKING: "run", MANUAL: "warn", NOT_RUN: "warn", UNAVAILABLE: "mute", FAILED: "fail", ERROR: "fail", NONE: "mute", MERGING: "run", MERGED: "ok", MOVED: "warn" };

/** How long a check under way, or a merge about to begin, is read again for; and a curator's merge under way, whose ingestion renders the whole book. */
const CHECKING_READ_MS = 600_000;
const BEGINNING_READ_MS = 60_000;
const MERGING_READ_MS = 1_800_000;

/**
 * A porcelain word diff as the page draws it: a file's header and a hunk's on lines of their own, then the text with
 * what was removed struck and what was added marked, run by run, and the file's own line ends where `~` says.
 */
function wordDiff(text: string): ReadonlyArray<React.ReactNode> {
  const out: React.ReactNode[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++ ") || line.startsWith("--- ") || line === "+++" || line === "---") {
      out.push(
        <span key={index} className="diff-meta">
          {line}
          {"\n"}
        </span>,
      );
    } else if (line.startsWith("@@")) {
      out.push(
        <span key={index} className="diff-hunk">
          {line}
          {"\n"}
        </span>,
      );
    } else if (line.startsWith("~")) {
      out.push("\n");
    } else if (line.startsWith("-")) {
      out.push(
        <del key={index} className="diff-del">
          {line.slice(1)}
        </del>,
      );
    } else if (line.startsWith("+")) {
      out.push(
        <ins key={index} className="diff-add">
          {line.slice(1)}
        </ins>,
      );
    } else {
      out.push(line.slice(1));
    }
  });
  return out;
}

/**
 * An accepted suggestion's merge in the queue's detail (feature-specs/37 § 6; unit 54b): where it stands, in a word and
 * a sentence; the version it will become, its branch and commit; the chapter's lint and lab, with the book's suite and
 * the sentence for a failure elsewhere that is not this change's (§ 4.4); why it is made by hand and what the branch
 * still lacks (§ 4.3); what the dry run or the lab found; the branch against `main`, and the end of what the lab
 * printed; and `Re-run check`. The texts of the book, the repository's and the pipeline's are English, and say so.
 * A check under way, or a merge about to begin, is read again until it has moved. Since unit 54c: `Merge` once the
 * check passed, for a curator whose suggestion it is not; the release a merge makes; and a merge under way, read again
 * until it is merged.
 */
export function QueueMerge({ locale, view, mayRecheck }: QueueMergeProps) {
  const t = useTranslations("improve.queue.merge");
  const ts = useTranslations("improve.queue.mergeState");
  const { merge } = view;
  const check = merge?.check ?? null;
  const state = mergeStateOf(check, merge);
  const checked = check?.stage === "CHECKED" ? check : null;
  const hand = check?.stage === "MANUAL" || check?.stage === "CHECKED" ? check.hand : null;
  /* the version it will become once a check has read the branch: before, the bump is the merge's guess */
  const bump = checked?.bump ?? null;
  const versionTo = merge === null || bump === null ? null : (merge.versionTo ?? versionAfter(merge.versionFrom, bump));
  const unrelated = checked === null ? [] : checked.suite.failing.filter((chapter) => chapter !== view.chapter);
  const labRun = checked?.labRun ?? null;
  const drawn = refreshKeyOf(view);
  return (
    <section className="inst queue-merge" aria-labelledby="queue-merge-title">
      <div className="inst-h">
        <h2 className="t" id="queue-merge-title">
          {t("title")}
        </h2>
        <span className="sep">·</span>
        <StatusMark tone={TONE[state]}>{ts(state)}</StatusMark>
        {check !== null ? <span className="ts">{formatDateTime(new Date(check.at), locale)}</span> : null}
      </div>
      <div className="inst-b col queue-merge-body">
        <p className="small">{t(state === "FAILED" && view.origin === "CURATOR" ? "said.FAILED_REVERT" : `said.${state}`, { release: merge?.releaseTo ?? "" })}</p>
        {check?.stage === "MOVED" ? <p className="small">{check.now === null ? t("movedGone") : t("movedNow", { text: check.now })}</p> : null}
        {merge !== null ? (
          <dl className="kv queue-merge-kv">
            <dt>{t("version")}</dt>
            <dd className="mono">
              {merge.versionFrom}
              {versionTo !== null && versionTo !== merge.versionFrom ? ` → ${versionTo}` : null}
              {bump !== null ? ` · ${bump}` : null}
            </dd>
            <dt>{t("branch")}</dt>
            <dd className="mono queue-merge-branch">{merge.branch}</dd>
            <dt>{t("commit")}</dt>
            <dd className="mono">{merge.commitSha === null ? t("noCommit") : merge.commitSha.slice(0, 12)}</dd>
            {merge.releaseTo !== null ? (
              <>
                <dt>{t("release")}</dt>
                <dd className="mono">{merge.releaseTo}</dd>
              </>
            ) : null}
            {checked !== null ? (
              <>
                <dt>{t("lint")}</dt>
                <dd>
                  <StatusMark tone={checked.lint === "PASS" ? "ok" : "fail"}>{t(`lintResult.${checked.lint}`)}</StatusMark>
                </dd>
                <dt>{t("lab")}</dt>
                <dd>
                  <StatusMark tone={checked.lab === "PASS" ? "ok" : checked.lab === "FAIL" ? "fail" : checked.lab === "NOT_RUN" ? "warn" : "mute"}>{t(`labResult.${checked.lab}`)}</StatusMark>
                  {checked.labId !== null ? <span className="mono"> · {checked.labId}</span> : null}
                </dd>
                <dt>{t("suite")}</dt>
                <dd>{t("reproduce", { n: checked.suite.reproduced, total: checked.suite.total })}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {hand !== null ? (
          <p className="small">
            {t("hand")}:{" "}
            <span lang="en">
              {hand.row} · {hand.detail}
            </span>
          </p>
        ) : null}
        {check?.stage === "MANUAL" && check.missing !== null ? <p className="small queue-merge-missing">{t(`missing.${check.missing}`)}</p> : null}
        {/* the operator's words reach a curator only (the view's own rule): another reader has the state's sentence */}
        {check?.stage === "UNAVAILABLE" && check.reason !== "" ? (
          <p className="small muted" lang="en">
            {check.reason}
          </p>
        ) : null}
        {check?.stage === "ERROR" ? (
          <p className="small muted">
            {t(`step.${check.step}`)}:{" "}
            <span className="mono" lang="en">
              {check.message === "" ? check.code : `${check.code} · ${check.message}`}
            </span>
          </p>
        ) : null}
        {checked?.failure != null ? (
          <p className="small">
            {t(`failure.${checked.failure.reason}`)}:{" "}
            <span className="mono" lang="en">
              {checked.failure.detail}
            </span>
          </p>
        ) : null}
        {labRun?.reason != null ? (
          <p className="small">
            {t("labReason")}:{" "}
            <span lang="en">{labRun.reason}</span>
          </p>
        ) : null}
        {labRun !== null && labRun.figures.length > 0 ? (
          <div className="col queue-merge-list">
            <span className="flabel">{t("figures")}</span>
            <ul className="col small">
              {labRun.figures.map((figure) => (
                <li key={figure.id} className="mono">
                  {t("figure", { id: figure.id, value: figure.valueText, key: figure.key })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {labRun !== null && labRun.keys.length > 0 && checked?.lab === "FAIL" ? (
          <div className="col queue-merge-list">
            <span className="flabel">{t("keys")}</span>
            <ul className="col small">
              {labRun.keys.map((entry) => (
                <li key={entry.key} className="mono">
                  {t("key", { key: entry.key, stated: entry.stated ?? t("absent"), printed: entry.printed ?? t("absent") })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {unrelated.length > 0 ? <p className="small muted">{t("unrelated", { n: unrelated.length, labs: unrelated.join(", ") })}</p> : null}
        {checked !== null && checked.diff.text !== "" ? (
          <details className="queue-merge-details" open={checked.diff.text.length < 4_000}>
            <summary className="flabel">
              {t("diff")}
              {checked.diff.truncated ? ` · ${t("truncated", { n: checked.diff.text.length })}` : null}
            </summary>
            <pre className="queue-merge-diff" tabIndex={0} lang="en">
              {wordDiff(checked.diff.text)}
            </pre>
          </details>
        ) : null}
        {labRun !== null && labRun.tail !== "" && checked?.lab !== "PASS" ? (
          <details className="queue-merge-details">
            <summary className="flabel">{t("output")}</summary>
            <pre className="queue-merge-output" tabIndex={0} lang="en">
              {labRun.tail}
            </pre>
          </details>
        ) : null}
      </div>
      {mayRecheck && state !== "MERGING" && state !== "MERGED" ? (
        <div className="inst-f queue-merge-foot">
          {state === "READY" ? <QueueMergeButton suggestionId={view.id} drawn={drawn} /> : null}
          <QueueRecheck suggestionId={view.id} drawn={drawn} />
        </div>
      ) : null}
      {state === "CHECKING" ? <OutcomeRefresh id={view.id} drawn={drawn} forMs={CHECKING_READ_MS} /> : state === "MERGING" ? <OutcomeRefresh id={view.id} drawn={drawn} forMs={MERGING_READ_MS} /> : state === "NONE" && mergesAfter(view.state, view.outcome) ? <OutcomeRefresh id={view.id} drawn={drawn} forMs={BEGINNING_READ_MS} /> : null}
    </section>
  );
}
