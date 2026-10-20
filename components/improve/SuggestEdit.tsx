import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusBar } from "@/components/chrome/StatusBar";
import { AnchorChanged } from "@/components/improve/AnchorChanged";
import { AnchoredText } from "@/components/improve/AnchoredText";
import { ClassPanel } from "@/components/improve/ClassPanel";
import { ClaimEditor } from "@/components/improve/ClaimEditor";
import { ContextStrip } from "@/components/improve/ContextStrip";
import { EvidenceList } from "@/components/improve/EvidenceList";
import { NewRowEditor } from "@/components/improve/NewRowEditor";
import { ProposalFixed } from "@/components/improve/ProposalFixed";
import { RationaleStep } from "@/components/improve/RationaleStep";
import { RestructureEditor } from "@/components/improve/RestructureEditor";
import { RowEditor } from "@/components/improve/RowEditor";
import { SaveStatus } from "@/components/improve/SaveStatus";
import { ScoreColumn } from "@/components/improve/ScoreColumn";
import { SubmitProblem } from "@/components/improve/SubmitProblem";
import { TextEditor } from "@/components/improve/TextEditor";
import { ValueEditor } from "@/components/improve/ValueEditor";
import { Notice } from "@/components/ui/Notice";
import type { SuggestEditData, SuggestEditForm } from "@/lib/db/suggestEdit";
import { formatDate, formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { countWords } from "@/lib/improve/words";

export interface SuggestEditProps {
  readonly locale: Locale;
  readonly id: string;
  readonly data: Extract<SuggestEditData, { readonly kind: "page" }>;
  readonly loadedMs: number;
}

/**
 * The suggest form's edit page (feature-specs/34 § 5, § 7; unit 51c; the Improve-Suggest screen): the context strip
 * with the draft's id, then the anchor column — the anchored text, read-only now, and the Change class panel — and
 * the form — step 2, the proposed change by its kind; step 3, the evidence (51d); step 4, the rationale (51e) — and the
 * right column, the live score and the submission (51e). A refusal of the submission shows beside the field it
 * concerns. An identity not verified gets its notice and no form, and an anchor the release has changed its notice
 * above the form (34 § 7). Under 768px the page is the "desktop or tablet" notice (34 § 16): three columns do not fit
 * there.
 */
export function SuggestEdit({ locale, id, data, loadedMs }: SuggestEditProps) {
  const t = useTranslations("improve.suggest");
  const tr = useTranslations("account.role");
  const th = useTranslations("home.statusbar");
  const { strip, body, rubric, chapterDigits, anchorId } = data;
  const revision = body.kind === "form" && body.form.revision;
  const backHref = `/${locale}/ch/${strip.back.slice(0, 2)}/${strip.back}`;
  const chooseHref = `/${locale}/ch/${chapterDigits}/improve/new?anchor=${encodeURIComponent(anchorId)}`;
  const back = (
    <Link className="xref" href={backHref}>
      {t("strip.back", { id: strip.back })}
    </Link>
  );
  return (
    <>
      <div className="col suggest-page">
        <h1 className="sr-only">{t(revision ? "edit.revisionTitle" : "edit.title", { id })}</h1>
        <ContextStrip locale={locale} {...strip} suggestion={{ id, mark: revision ? "revision" : "draft" }} />
        {body.kind === "role" || body.kind === "unverified" ? (
          <main className="suggest-start">
            <div className="rr anchor-step">
              {body.kind === "role" ? <Notice title={t("role.title")}>{t("role.body", { role: tr(body.role) })}</Notice> : <Notice title={t("unverified.title")}>{t("unverified.body")}</Notice>}
              <Link className="btn btn-sm anchor-step-back" href={backHref}>
                {t("strip.back", { id: strip.back })}
              </Link>
            </div>
          </main>
        ) : (
          <div className="suggest-edit">
            <aside className="rr anchor-step desktop-only" aria-label={t("anchorLabel")}>
              <div className="col anchor-step-head">
                <span className="cap">{t("step")}</span>
                <h2 className="h3">{t("title")}</h2>
                <p className="small muted">{t("edit.anchorFixed")}</p>
              </div>
              <AnchoredText home={body.form.home} contentLang={body.form.contentLang} version={body.form.version} anchor={body.form.anchor} />
              <ClassPanel draftClass={body.form.draftClass} rubricVersion={body.form.rubricVersion} />
              <SubmitProblem
                codes="INTAKE_ANCHOR_EXISTS"
                action={
                  <Link className="btn btn-sm" href={chooseHref}>
                    {t("submit.chooseAnchor")}
                  </Link>
                }
              />
            </aside>
            <main className="edit-form">
              {/* Under 768px the page is this notice, the Notice's form with a heading in it (34 § 4, § 16). */}
              <div className="col phone-only">
                <div className="notice col gap-s2">
                  <h2 className="label text-warn">{t("phone.title")}</h2>
                  <div className="ui">
                    {t("phone.body")} {back}
                  </div>
                </div>
              </div>
              {body.form.anchorChanged !== null ? <AnchorChanged was={body.form.anchorChanged.was} now={body.form.anchorChanged.now} chooseHref={chooseHref} contentLang={body.form.contentLang} /> : null}
              <ProposedChange locale={locale} form={body.form} />
              <SubmitProblem codes="INTAKE_SCHEMA" />
              <EvidenceList id={body.form.id} locale={locale} evidence={body.form.evidence} />
              <SubmitProblem codes="INTAKE_EVIDENCE_PARSES" />
              <RationaleStep id={body.form.id} rationale={body.form.rationale} />
              <SubmitProblem codes="INTAKE_RATIONALE_LENGTH" />
            </main>
            <ScoreColumn
              id={body.form.id}
              locale={locale}
              rubricVersion={body.form.rubricVersion}
              scoring={body.form.score.scoring}
              thresholds={body.form.score.thresholds}
              items={body.form.evidence.items}
              identity={body.form.identity}
              submit={body.form.submit}
              words={countWords(body.form.rationale ?? "")}
              revision={body.form.revision}
              research={body.form.research}
            />
          </div>
        )}
      </div>
      <StatusBar trailing={<SaveStatus loaded={th("loaded", { s: formatSeconds(loadedMs) })} />}>
        <span>{t(revision ? "edit.revisionStatusbar" : "edit.statusbar", { n: chapterDigits, anchor: anchorId, id })}</span>
        {rubric !== null ? <span className="desktop-only">{t("statusbar.rubric", { version: rubric.version, date: formatDate(rubric.publishedAt, locale) })}</span> : null}
        {body.kind === "form" ? <span className="desktop-only">{t("edit.grader")}</span> : null}
      </StatusBar>
    </>
  );
}

/**
 * Step 2 (34 § 5): the proposal by its kind, each editor saving through the autosave. An editor needs what the release
 * still has of its anchor; an anchor gone from it is the state 51e shows, and until then step 2 is its heading. In a
 * revision the change is fixed, and shown as submitted (31 § 6.5).
 */
function ProposedChange({ locale, form }: { readonly locale: Locale; readonly form: SuggestEditForm }) {
  const t = useTranslations("improve.suggest.edit");
  const tr = useTranslations("research.edit");
  return (
    <section className="col rt-s edit-step desktop-only" aria-labelledby="edit-step-2">
      <div className="between">
        <div className="row edit-step-title">
          <span className="meta">2</span>
          <h2 className="h4" id="edit-step-2">
            {t("proposed")}
          </h2>
        </div>
        <span className="cap">{t(`kindCap.${form.changeKind}`)}</span>
      </div>
      {/* a draft from a research finding: the proposal is the researcher's work until the contributor makes it theirs (feature-specs/48 § 8.2, § 8.6) */}
      {form.prefilled ? <p className="help edit-prefilled">{tr("prefilled")}</p> : null}
      {form.revision ? (
        <ProposalFixed text={form.anchor.text} contentLang={form.contentLang} proposal={form.proposal} />
      ) : (
        <>
          {form.changeKind === "SET_VALUE" && form.value !== null ? <ValueEditor id={form.id} locale={locale} value={form.value} proposal={form.proposal} /> : null}
          {form.changeKind === "EDIT_TEXT" && form.section !== null ? <TextEditor id={form.id} sectionId={form.home.id} version={form.version} section={form.section} proposal={form.proposal} /> : null}
          {form.changeKind === "ADD_CLAIM" && form.section !== null ? <ClaimEditor id={form.id} sectionId={form.home.id} version={form.version} section={form.section} proposal={form.proposal} /> : null}
          {form.changeKind === "RESTRUCTURE" ? <RestructureEditor id={form.id} proposal={form.proposal} /> : null}
          {form.changeKind === "EDIT_ROW" && form.row !== null ? <RowEditor id={form.id} locale={locale} row={form.row} proposal={form.proposal} /> : null}
          {form.changeKind === "ADD_ROW" ? <NewRowEditor id={form.id} proposal={form.proposal} /> : null}
        </>
      )}
    </section>
  );
}
