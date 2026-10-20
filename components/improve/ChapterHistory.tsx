import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusBar } from "@/components/chrome/StatusBar";
import { PART_ROMAN } from "@/components/reader/PartGrid";
import { StatusMark } from "@/components/ui/StatusMark";
import type { ChapterHistoryData } from "@/lib/db/chapterHistory";
import { formatDate, formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { hashLine } from "@/lib/ledger/display";
import type { HistoryPerson, HistoryRow, MergedHistoryRow } from "@/lib/schemas/history";
import { cn } from "@/lib/utils";

interface ChapterHistoryProps {
  readonly locale: Locale;
  readonly data: Extract<ChapterHistoryData, { readonly kind: "page" }>;
  /** Whether a session is there: the export is the signed-in's (37 § 19). */
  readonly signedIn: boolean;
  readonly loadedMs: number;
}

/** A person as the page prints them: the name, or the ledger's pseudonym where no name may be shown. */
const whoOf = (person: HistoryPerson | null): string | null => (person === null ? null : (person.name ?? person.pseudonym));

/** The row's class cell: the kind's word, with the curator's and the research marks (37 § 7). */
function classWordsOf(row: MergedHistoryRow, t: ReturnType<typeof useTranslations<"improve.history">>): string {
  const base = row.reverts !== null ? t("class.revert") : t(`class.${row.changeKind}`);
  const marks = [row.changeClass === "CURATOR_ALWAYS" || row.override !== null || row.inspection ? t("class.curator") : null, row.research ? t("class.research") : null].filter((mark) => mark !== null);
  return [base, ...marks].join(" · ");
}

/**
 * A chapter's improvement history (feature-specs/37 § 7; unit 54d; the Chapter-History screen): the header with the
 * chapter's version, its verification and its lab's state; the stat strip; the version ledger, newest first, each row
 * with the change in the book's own words, its evidence, the people who made it and its record; and the rail — the
 * credit list, alphabetical and never a ranking (invariant 26), what changed by layer, and the chain check made on
 * this request. Public; the export is the signed-in's. The book's own text is marked with the edition's language.
 */
export function ChapterHistory({ locale, data, signedIn, loadedMs }: ChapterHistoryProps) {
  const t = useTranslations("improve.history");
  const tc = useTranslations("reader.inst");
  const tp = useTranslations("home.part");
  const th = useTranslations("home.statusbar");
  const { chapter, release, history } = data;
  const digits = String(chapter.number).padStart(2, "0");
  const contentLang = chapter.editionLang === "PT" ? "pt" : "en";
  const roman = PART_ROMAN[chapter.part];
  const verified = chapter.verifiedAt === null ? null : formatDate(chapter.verifiedAt, locale);
  const headerLine = verified === null ? chapter.version : t("verified", { version: chapter.version, date: verified });
  const changed = history.layers.filter((layer) => layer.changes.length > 0 || layer.reverted > 0);
  const evidenceOf = (row: MergedHistoryRow) =>
    row.evidence === null ? (
      <span className="faint mono">—</span>
    ) : (
      <>
        <span className="row history-evidence">
          <span className={`ev ev-${row.evidence.tier.toLowerCase()}`}>{row.evidence.tier}</span>
          <span className="score">{row.evidence.score}</span>
        </span>
        {row.inspection ? <span className="meta faint">{t("inspection")}</span> : null}
      </>
    );
  const summaryOf = (row: HistoryRow) => {
    if (row.kind === "editorial") return t(row.lab === null ? "editorial.summaryNoLab" : "editorial.summary", { layers: row.sections, verify: tc(row.verify === "PASSED" ? "passed" : row.verify === "FAILED" ? "failed" : "unverified"), lab: row.lab === null ? "" : tc(`verdict.${row.lab}`) });
    const { summary } = row;
    return (
      <>
        {row.reverts !== null ? <span>{t("revertOf", { id: row.reverts })} </span> : null}
        {summary.before !== null && summary.after !== null ? (
          <span lang={contentLang}>
            <span className="history-before">{summary.before}</span> → <span className="history-after">{summary.after}</span>
          </span>
        ) : summary.after !== null ? (
          <span lang={contentLang}>{summary.after}</span>
        ) : summary.quote !== "" ? (
          <span lang={contentLang} className="faint">
            {summary.quote}
          </span>
        ) : null}
        {row.override !== null ? (
          <>
            <br />
            <StatusMark tone="warn">{t("overrideMark", { code: row.override.code })}</StatusMark>
          </>
        ) : null}
        {row.reverted !== null ? (
          <>
            <br />
            <StatusMark tone="fail">{row.reverted.version === null ? t("revertedMarkNoVersion") : t("revertedMark", { version: row.reverted.version })}</StatusMark>
          </>
        ) : null}
      </>
    );
  };
  return (
    <>
      <div className="history-page">
        <main className="col history">
          <div className="col history-head">
            <div className="row history-head-caps">
              <Link className="cap" href={`/${locale}/ch/${digits}/${digits}.1`}>
                {t("chapterCap", { n: digits, part: tp("cap", { roman, title: tp(`title.${chapter.part}`) }) })}
              </Link>
              <span className="cap">·</span>
              <span className="cap">{t("cap")}</span>
            </div>
            <div className="between history-title-row">
              <h1 className="h1" lang={contentLang}>
                {chapter.title}
              </h1>
              <div className="row history-head-marks">
                <span className="meta">{headerLine}</span>
                {chapter.lab !== null ? <span className={cn("st-block", chapter.lab.verdict === "REPRODUCED" ? "sb-ok" : "sb-warn")}>{t("labMark", { id: chapter.lab.id.replace(/^lab-/, ""), verdict: tc(`verdict.${chapter.lab.verdict}`) })}</span> : null}
              </div>
            </div>
            <p className="muted">{t("lede")}</p>
          </div>
          <div className="rt-s rb history-strip">
            <div className="col rr history-stat">
              <span className="cap">{t("stats.versions")}</span>
              <span className="midnum">{history.stats.versions}</span>
              <span className="meta">{history.stats.from === null ? history.stats.to : `${history.stats.from} → ${history.stats.to}`}</span>
            </div>
            <div className="col rr history-stat">
              <span className="cap">{t("stats.contributed")}</span>
              <span className="midnum">{history.stats.contributed}</span>
              <span className="meta">{t("stats.inText")}</span>
            </div>
            <div className="col rr history-stat">
              <span className="cap">{t("stats.overrides")}</span>
              <span className="midnum">{history.stats.overrides.count}</span>
              <span className="meta">{history.stats.overrides.latest === null ? t("stats.none") : `${history.stats.overrides.latest.code} · ${history.stats.overrides.latest.version}`}</span>
            </div>
            <div className="col rr history-stat">
              <span className="cap">{t("stats.reverted")}</span>
              <span className="midnum">{history.stats.reverted}</span>
              <span className="meta">{history.stats.reverted === 0 ? t("stats.none") : t("stats.inPrecision")}</span>
            </div>
            <div className="col history-stat">
              <span className="cap">{t("stats.rule")}</span>
              <span className="small">
                <span className="mono">patch</span> {t("stats.patch")}
                <br />
                <span className="mono">minor</span> {t("stats.minor")}
                <br />
                <span className="mono">major</span> {t("stats.major")}
              </span>
            </div>
          </div>
          <section className="inst" aria-labelledby="history-ledger-title">
            <div className="inst-h">
              <h2 className="t" id="history-ledger-title">
                {t("ledger.title")}
              </h2>
              <span className="sep">·</span>
              <span>{t("ledger.chapter", { n: digits })}</span>
              <span className="sep">·</span>
              <span>{t("ledger.order")}</span>
              <span className="ts">{history.chain.headHash === null ? t("ledger.noHead") : t("ledger.head", { head: hashLine(history.chain.headHash) })}</span>
            </div>
            <div className="scroll">
              <table className="tbl history-table">
                <thead>
                  <tr>
                    <th scope="col">{t("ledger.columns.version")}</th>
                    <th scope="col">{t("ledger.columns.date")}</th>
                    <th scope="col">{t("ledger.columns.class")}</th>
                    <th scope="col">{t("ledger.columns.anchor")}</th>
                    <th scope="col">{t("ledger.columns.summary")}</th>
                    <th scope="col">{t("ledger.columns.evidence")}</th>
                    <th scope="col">{t("ledger.columns.people")}</th>
                    <th scope="col">{t("ledger.columns.record")}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.map((row) => (
                    <tr key={`${row.release}-${row.version}`} className={cn(row.kind === "merged" && row.reverted !== null && "history-row-reverted")}>
                      <td>
                        <span className="mono">{row.version}</span>
                        <br />
                        <span className={cn("meta", row.bump === "patch" && "faint")}>{row.bump}</span>
                      </td>
                      <td className="meta">{formatDate(new Date(row.at), locale)}</td>
                      <td className="small">{row.kind === "editorial" ? t("class.release") : classWordsOf(row, t)}</td>
                      <td className="mono">{row.kind === "editorial" ? `${digits}.1–${digits}.${String(row.sections)}` : row.anchor.id}</td>
                      <td className="small history-summary">{summaryOf(row)}</td>
                      <td>{row.kind === "editorial" ? <span className="faint mono">—</span> : evidenceOf(row)}</td>
                      <td className="small">
                        {row.kind === "editorial" ? t("editorial.who") : (whoOf(row.contributor) ?? <span className="faint">—</span>)}
                        {row.kind !== "editorial" && row.contributor?.verified === true ? <span className="faint"> · {t("verifiedPerson")}</span> : null}
                        <br />
                        <span className="faint">{row.kind === "editorial" ? "—" : (whoOf(row.curator) ?? "—")}</span>
                      </td>
                      <td>
                        {row.kind === "editorial" ? (
                          <>
                            <span className="mono">{t("editorial.release", { id: row.release })}</span>
                            <br />
                            <span className="hash">—</span>
                          </>
                        ) : (
                          <>
                            <Link className="xref" href={`/${locale}/improve/${row.suggestionId}/record`}>
                              {row.suggestionId}
                            </Link>
                            <br />
                            <span className="hash">{row.record === null ? "—" : hashLine(row.record.hash)}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="inst-f history-foot">
              <span>{t("ledger.foot")}</span>
              {signedIn ? (
                /* A plain anchor, not a `Link`: following this one records an export (37 § 7). */
                <a className="xref" href={`/api/v1/chapters/${digits}/history/export`} download>
                  {t("ledger.export")}
                </a>
              ) : (
                <span className="muted">{t("ledger.exportSignedOut")}</span>
              )}
            </div>
          </section>
        </main>
        <aside className="col rl history-rail" aria-label={t("rail.label")}>
          <section className="inst" aria-labelledby="history-credit-title">
            <div className="inst-h">
              <h2 className="t" id="history-credit-title">
                {t("rail.credit.title")}
              </h2>
              <span className="sep">·</span>
              <span>{t("ledger.chapter", { n: digits })}</span>
              <span className="ts">{t("rail.credit.order")}</span>
            </div>
            {history.credit.length === 0 ? (
              <p className="inst-b small muted">{t("rail.credit.none")}</p>
            ) : (
              <ul className="col history-credit">
                {history.credit.map((entry, index) => (
                  <li key={entry.person.name ?? entry.person.pseudonym ?? String(index)} className={cn("between", index < history.credit.length - 1 && "rb")}>
                    <span className="small">
                      {whoOf(entry.person)}
                      {entry.person.verified ? <span className="faint"> · {t("verifiedPerson")}</span> : null}
                    </span>
                    <span className="meta">
                      {t("rail.credit.accepted", { n: entry.accepted })}
                      {entry.reverted > 0 ? <span className="faint"> · {t("rail.credit.reverted", { n: entry.reverted })}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="rt history-credit-foot">
              <p className="small">{t("rail.credit.agent")}</p>
              <p className="small muted">{t("rail.credit.note")}</p>
            </div>
          </section>
          <section className="inst" aria-labelledby="history-layers-title">
            <div className="inst-h">
              <h2 className="t" id="history-layers-title">
                {t("rail.layers.title")}
              </h2>
              <span className="ts">{t("rail.layers.since", { version: history.stats.from ?? history.stats.to })}</span>
            </div>
            <div className="inst-b">
              <ul className="tree history-tree">
                <li>
                  <span className="glyph">✢</span> {digits} <span lang={contentLang}>{chapter.title}</span> <span className="faint">· {history.version}</span>
                </li>
                {history.layers.map((layer, index) => {
                  const last = index === history.layers.length - 1;
                  const quiet = layer.changes.length === 0 && layer.reverted === 0;
                  const words = layer.changes.map((change) => t(`rail.layers.kind.${change.kind}`, { n: change.count })).join(", ");
                  return (
                    <li key={layer.section} className={cn(quiet && "faint")}>
                      <span className="faint">{last ? "└─" : "├─"}</span> {quiet ? "✢" : <span className="glyph">✢</span>} {layer.section} {layer.title.toLowerCase()}{" "}
                      {quiet ? (
                        <span>· 0</span>
                      ) : (
                        <span className={cn(layer.reverted > 0 || layer.overrides > 0 ? undefined : "faint")}>
                          · {words}
                          {layer.reverted > 0 ? `, ${t("rail.layers.reverted", { n: layer.reverted })}` : null}
                          {layer.overrides > 0 ? <span className="history-override"> · {t("rail.layers.override", { n: layer.overrides })}</span> : null}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="inst-f">
              <span>{changed.length === 0 ? t("rail.layers.footNone") : t("rail.layers.foot")}</span>
            </div>
          </section>
          <div className="col rt history-chain">
            <span className="cap">{t("rail.chain.title")}</span>
            <StatusMark tone={!history.chain.ok ? "fail" : history.chain.records === 0 ? "mute" : "ok"} className="history-chain-line">
              {!history.chain.ok ? t("rail.chain.broken", { seq: history.chain.firstBreak?.seq ?? 0, field: history.chain.firstBreak?.field ?? "" }) : history.chain.records === 0 ? t("rail.chain.empty") : t("rail.chain.ok", { n: history.chain.records })}
            </StatusMark>
            {history.chain.headHash !== null ? <span className="tex">{t("rail.chain.head", { head: hashLine(history.chain.headHash) })}</span> : null}
          </div>
        </aside>
      </div>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("statusbar.where", { n: digits })}</span>
        <span>{headerLine}</span>
        <span>{t("statusbar.release", { id: release.id })}</span>
      </StatusBar>
    </>
  );
}
