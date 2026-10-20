import { useTranslations } from "next-intl";

import { StatusMark } from "@/components/ui/StatusMark";
import { formatDate, formatDateTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { mergeStateOf, versionAfter } from "@/lib/improve/merge";
import { hashLine } from "@/lib/ledger/display";
import type { ChainCheck } from "@/lib/ledger/verify";
import type { SuggestionView } from "@/lib/schemas/suggestions";
import { cn } from "@/lib/utils";

interface RecordRailProps {
  readonly locale: Locale;
  readonly chapterDigits: string;
  readonly chapter: number;
  /** The chapter's version the suggestion is read at. */
  readonly version: string;
  /** Its merge, once one began (spec 37 § 6; unit 54b). */
  readonly merge: SuggestionView["merge"];
  /** Who merged it, as the record names them; null before a curator merged (unit 54c). */
  readonly mergedBy: string | null;
  /** A row's id where the suggestion is anchored to a source row; null for a section or a figure. */
  readonly sourceRow: string | null;
  /** That row's verification date before the merge and after it, once merged (unit 54c). */
  readonly sourceRowDates: { readonly before: Date | null; readonly after: Date | null } | null;
  /** How the contributor appears to this reader: their name, or the ledger's pseudonym; null for a revert, which has none (37 § 8). For a researcher's proposal, its endorser, or null. */
  readonly contributor: string | null;
  /** A researcher's proposal (43 § 8): credited to its endorser, or to nobody, never to the agent. */
  readonly research?: boolean;
  readonly chain: ChainCheck;
  readonly checkedAt: Date;
  /** `GET /api/v1/suggestions/{id}/record/export`: the signed JSONL, which the export records; null for a reader the export is not for (the public record, 35 D2). */
  readonly exportHref: string | null;
}

/**
 * The record's rail (feature-specs/35 § 5; the Improve-Record screen): Version, Lab gate, Source row and Credit,
 * which the merge fills (spec 37) and which before it say what is known, `not merged`; and Chain integrity, checked on
 * this request — `chain verified · 6 records · head 3c07e9a14b52` and `6 / 6 links match`, or the first break and
 * where it is. Since unit 54b a merge under way fills Version (the version the branch makes, `patch`, its branch and
 * commit; merged by, at 54c) and Lab gate (the chapter's lab or none, the lint, the book's suite with its meter, and
 * the sentence for a failure elsewhere that is not this change's), as its last check read them.
 */
export function RecordRail({ locale, chapterDigits, chapter, version, merge, mergedBy, sourceRow, sourceRowDates, contributor, research = false, chain, checkedAt, exportHref }: RecordRailProps) {
  const t = useTranslations("improve.record.rail");
  const tm = useTranslations("improve.queue.merge");
  const ts = useTranslations("improve.queue.mergeState");
  const head = chain.headHash === null ? null : hashLine(chain.headHash);
  const check = merge?.check ?? null;
  const checked = check?.stage === "CHECKED" ? check : null;
  const versionTo = merge === null ? null : (merge.versionTo ?? (checked?.bump == null ? null : versionAfter(merge.versionFrom, checked.bump)));
  const unrelated = checked === null ? [] : checked.suite.failing.filter((number) => number !== chapter);
  return (
    <aside className="col rl record-rail" aria-label={t("label")}>
      <section className="inst" aria-labelledby="record-version-title">
        <div className="inst-h">
          <h2 className="t" id="record-version-title">
            {t("version.title")}
          </h2>
          <span className="sep">·</span>
          <span>{t("version.chapter", { n: chapterDigits })}</span>
          <span className="ts">{merge === null ? t("notMerged") : ts(mergeStateOf(check, merge))}</span>
        </div>
        {merge === null ? (
          <div className="inst-b col record-rail-body">
            <span className="mono record-version">{version}</span>
            <p className="help">{t("version.pending")}</p>
          </div>
        ) : (
          <div className="inst-b col record-rail-body">
            <div className="row record-version-row">
              <span className={cn("mono", versionTo === null ? "record-version" : "faint record-version-from")}>{merge.versionFrom}</span>
              {versionTo !== null ? (
                <>
                  <span className="mono faint" aria-hidden="true">
                    →
                  </span>
                  <span className="midnum record-version-to">{versionTo}</span>
                  {checked?.bump != null ? <span className="st-block sb-mute record-version-bump">{checked.bump}</span> : null}
                </>
              ) : null}
            </div>
            <p className="help">{t("version.rule")}</p>
            <dl className="kv record-rail-kv">
              <dt>{tm("branch")}</dt>
              <dd className="mono record-rail-branch">{merge.branch}</dd>
              <dt>{tm("commit")}</dt>
              <dd className="mono">{merge.commitSha === null ? tm("noCommit") : merge.commitSha.slice(0, 7)}</dd>
              {merge.releaseTo !== null ? (
                <>
                  <dt>{t("version.release")}</dt>
                  <dd className="mono">{merge.releaseTo}</dd>
                </>
              ) : null}
              <dt>{t("version.mergedBy")}</dt>
              <dd>{merge.mergedAt === null || mergedBy === null ? t("version.notYet") : mergedBy}</dd>
              {merge.revertedBy !== null ? (
                <>
                  <dt>{t("version.revertedBy")}</dt>
                  <dd className="mono">{merge.revertedBy}</dd>
                </>
              ) : null}
            </dl>
          </div>
        )}
      </section>
      <section className="inst" aria-labelledby="record-gate-title">
        <div className="inst-h">
          <h2 className="t" id="record-gate-title">
            {t("gate.title")}
          </h2>
          <span className="ts">{t("gate.cap")}</span>
        </div>
        {checked === null ? (
          <p className="inst-b help">{merge === null ? t("gate.pending") : t("gate.unchecked")}</p>
        ) : (
          <div className="inst-b col record-rail-body">
            <div className="between">
              <span className="flabel">{t("gate.lab", { n: chapterDigits })}</span>
              <StatusMark tone={checked.lab === "PASS" ? "ok" : checked.lab === "FAIL" ? "fail" : checked.lab === "NOT_RUN" ? "warn" : "mute"}>{checked.labId === null ? tm(`labResult.${checked.lab}`) : `${tm(`labResult.${checked.lab}`)} · ${checked.labId}`}</StatusMark>
            </div>
            <div className="between">
              <span className="flabel">{tm("lint")}</span>
              <StatusMark tone={checked.lint === "PASS" ? "ok" : "fail"}>{tm(`lintResult.${checked.lint}`)}</StatusMark>
            </div>
            <div className="between">
              <span className="flabel">{t("gate.suite")}</span>
              <span className="meta">{tm("reproduce", { n: checked.suite.reproduced, total: checked.suite.total })}</span>
            </div>
            {checked.suite.total > 0 ? (
              <div className={cn("meter", unrelated.length === 0 ? "ver" : "warn")} role="meter" aria-label={t("gate.suite")} aria-valuemin={0} aria-valuemax={checked.suite.total} aria-valuenow={checked.suite.reproduced}>
                <i style={{ width: `${String((100 * checked.suite.reproduced) / checked.suite.total)}%` }} />
              </div>
            ) : null}
            {unrelated.length > 0 ? <p className="help">{tm("unrelated", { n: unrelated.length, labs: unrelated.join(", ") })}</p> : null}
          </div>
        )}
      </section>
      {sourceRow !== null ? (
        <section className="inst" aria-labelledby="record-row-title">
          <div className="inst-h">
            <h2 className="t" id="record-row-title">
              {t("row.title", { id: sourceRow })}
            </h2>
            <span className="ts">{t("row.cap")}</span>
          </div>
          {sourceRowDates === null ? (
            <p className="inst-b help">{t("row.pending")}</p>
          ) : (
            <dl className="inst-b kv record-rail-kv">
              <dt>{t("row.before")}</dt>
              <dd>{sourceRowDates.before === null ? "—" : formatDate(sourceRowDates.before, locale)}</dd>
              <dt>{t("row.after")}</dt>
              <dd>{sourceRowDates.after === null ? "—" : formatDate(sourceRowDates.after, locale)}</dd>
              <dt>{t("row.age")}</dt>
              <dd>{sourceRowDates.after === null ? "—" : t("row.days", { n: Math.max(0, Math.floor((checkedAt.getTime() - sourceRowDates.after.getTime()) / 86_400_000)) })}</dd>
            </dl>
          )}
        </section>
      ) : null}
      <section className="inst" aria-labelledby="record-credit-title">
        <div className="inst-h">
          <h2 className="t" id="record-credit-title">
            {t("credit.title")}
          </h2>
        </div>
        <p className="inst-b small">{contributor === null ? t(research ? "credit.research" : "credit.nobody") : t(merge?.mergedAt != null ? "credit.merged" : "credit.pending", { who: contributor })}</p>
      </section>
      <section className="inst" aria-labelledby="record-chain-title">
        <div className="inst-h">
          <h2 className="t" id="record-chain-title">
            {t("chain.title")}
          </h2>
          <span className="ts">{t("chain.checked", { at: formatDateTime(checkedAt, locale) })}</span>
        </div>
        <div className="inst-b col record-rail-body">
          {/* No record yet is nothing verified: the mute mark, and no count of links (the 52c review). */}
          {!chain.ok ? (
            <StatusMark tone="fail" className="record-chain-line">
              {t("chain.broken", { seq: chain.firstBreak?.seq ?? 0, field: chain.firstBreak?.field ?? "" })}
            </StatusMark>
          ) : head === null ? (
            <StatusMark tone="mute" className="record-chain-line">
              {t("chain.empty")}
            </StatusMark>
          ) : (
            <StatusMark tone="ok" className="record-chain-line">
              {t("chain.verified", { n: chain.records, head })}
            </StatusMark>
          )}
          {!chain.ok ? <span className="loader">{t("chain.stopped")}</span> : head !== null ? <span className="loader">{t("chain.links", { n: chain.records })}</span> : null}
        </div>
      </section>
      {chain.records > 0 && exportHref !== null ? (
        <div className="col record-export">
          {/* A plain anchor, not a `Link`: a prefetched link is followed, and following this one records an export (35 § 5). */}
          <a className="btn btn-lg record-export-button" href={exportHref} download>
            {t("export.button")}
          </a>
          <span className="meta faint">{t("export.meta", { n: chain.records + 1 })}</span>
        </div>
      ) : null}
    </aside>
  );
}
