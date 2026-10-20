import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusBar } from "@/components/chrome/StatusBar";
import { ContextStrip } from "@/components/improve/ContextStrip";
import { RecordChange } from "@/components/improve/RecordChange";
import { RecordDecision } from "@/components/improve/RecordDecision";
import { RecordEvidence } from "@/components/improve/RecordEvidence";
import { RecordRail } from "@/components/improve/RecordRail";
import { RecordTimeline } from "@/components/improve/RecordTimeline";
import { RevertPanel } from "@/components/improve/RevertPanel";
import type { ImproveRecordData } from "@/lib/db/improveRecord";
import { formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { anchorTitleOf } from "@/lib/improve/outcomeView";
import { hashLine } from "@/lib/ledger/display";

interface ImproveRecordProps {
  readonly locale: Locale;
  readonly id: string;
  readonly data: Extract<ImproveRecordData, { readonly kind: "page" }>;
  /** The viewer's name, for the revert panel's header (unit 54e); null signed out. */
  readonly curator: string | null;
  readonly loadedMs: number;
}

/**
 * A suggestion's record (feature-specs/35 § 5; unit 52c, part 1; the Improve-Record screen): the context strip; the
 * header with the contributor, as this reader may see them, and whether their identity was verified; Change, Decision
 * and Evidence; the hash-chained record; and the rail — what a merge fills, and the chain checked on this request.
 */
export function ImproveRecord({ locale, id, data, curator, loadedMs }: ImproveRecordProps) {
  const t = useTranslations("improve.record");
  const to = useTranslations("improve.outcome");
  const th = useTranslations("home.statusbar");
  const { view, variant, context, entries, chain, contributor, checkedAt } = data;
  const { strip, chapterDigits } = context.page;
  const back = `/${locale}/ch/${strip.back.slice(0, 2)}/${strip.back}`;
  const { kind: titleKind, ...titleValues } = anchorTitleOf(view.anchor, context.sectionTitle);
  /* `user:` and the first eight of its id, where the reader may not see the name (35 § 5); a revert has no contributor (37 § 8). */
  const who = contributor.name ?? (contributor.pseudonym === null ? null : contributor.pseudonym.slice(0, "user:".length + 8));
  return (
    <>
      <div className="col suggest-page">
        <ContextStrip locale={locale} {...strip} suggestion={{ id, mark: null }} />
        <div className="record-page">
          <main className="record">
            <div className="col record-head">
              <div className="row record-head-caps">
                <span className="cap">{t("cap", { id })}</span>
                <span className="cap">·</span>
                <span className="cap">
                  {data.research !== null ? (
                    /* a researcher's proposal (43 § 8): its origin, and whose name stands on it — verified marked, nothing beside an unverified one */
                    <>
                      {t("researchOrigin")}
                      {data.research.endorser !== null ? ` · ${t("endorsedBy", { name: data.research.endorser.name ?? data.research.endorser.pseudonym.slice(0, "user:".length + 8) })}${data.research.endorser.verified ? ` · ${t("verified")}` : ""}` : null}
                    </>
                  ) : (
                    <>
                      {who === null ? t("noContributor") : t("contributor", { who })}
                      {contributor.verified !== null ? ` · ${t(contributor.verified ? "verified" : "unverified")}` : null}
                    </>
                  )}
                </span>
              </div>
              {/* The heading's words are the page's; the book's text in it is marked with its own language (the 52c review). */}
              <h1 className="h2">{to.rich(`title.${titleKind}`, { ...titleValues, book: (chunks) => <span lang={titleKind === "SECTION" ? context.contentLang : "en"}>{chunks}</span> })}</h1>
            </div>
            <div className="record-panels">
              <RecordChange view={view} version={context.version} />
              <RecordDecision view={view} variant={variant} />
              <RecordEvidence locale={locale} evidence={view.evidence} />
            </div>
            <RecordTimeline locale={locale} entries={entries} chapterDigits={chapterDigits} />
            {data.mayRevert && curator !== null ? <RevertPanel locale={locale} suggestionId={id} curator={curator} sampled={false} href="" /> : null}
            <div className="row record-actions">
              {data.audience === "public" ? null : (
                <Link className="btn" href={`/${locale}/improve/${id}`}>
                  {t("actions.outcome")}
                </Link>
              )}
              <Link className="btn btn-q" href={back}>
                {to("actions.back", { id: strip.back })}
              </Link>
            </div>
          </main>
          <RecordRail locale={locale} chapterDigits={chapterDigits} chapter={view.chapter} version={context.version} merge={view.merge} mergedBy={data.mergedBy} sourceRow={view.anchor.kind === "SOURCE_ROW" ? view.anchor.id : null} sourceRowDates={data.sourceRow} contributor={data.research !== null ? (data.research.endorser === null ? null : (data.research.endorser.name ?? data.research.endorser.pseudonym.slice(0, "user:".length + 8))) : who} research={data.research !== null} chain={chain} checkedAt={checkedAt} exportHref={data.mayExport ? `/api/v1/suggestions/${id}/record/export` : null} />
        </div>
      </div>
      <StatusBar trailing={chain.headHash === null ? th("loaded", { s: formatSeconds(loadedMs) }) : t("statusbar.head", { head: hashLine(chain.headHash) })}>
        <span>{t("statusbar.where", { n: chapterDigits, anchor: view.anchor.id, id })}</span>
      </StatusBar>
    </>
  );
}
