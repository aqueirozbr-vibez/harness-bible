import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusBar } from "@/components/chrome/StatusBar";
import { AnchorPicker } from "@/components/improve/AnchorPicker";
import { ContextStrip } from "@/components/improve/ContextStrip";
import { SuggestGateNotice } from "@/components/improve/SuggestGateNotice";
import { ErrorBox } from "@/components/ui/ErrorBox";
import type { StartBody, SuggestStartData } from "@/lib/db/suggestStart";
import { formatDate, formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";

export interface SuggestStartProps extends Pick<SuggestStartData, "back" | "strip" | "body" | "rubric"> {
  readonly locale: Locale;
  readonly chapterDigits: string;
  readonly loadedMs: number;
}

/**
 * Step 1 of the suggest form (feature-specs/34 § 4, § 7; unit 51b): the Improve-Suggest screen's left column on a
 * page of its own until the draft exists, under the chapter context strip. The states the step can meet are
 * notices in the column. It renders at every width, the column full width under 768px (Andre, 2026-10-07, 34 § 16:
 * a zoomed desktop is a narrow viewport, WCAG 1.4.10); the edit page's three columns keep the "desktop or tablet"
 * notice.
 */
export function SuggestStart({ locale, chapterDigits, back, strip, body, rubric, loadedMs }: SuggestStartProps) {
  const t = useTranslations("improve.suggest");
  const th = useTranslations("home.statusbar");
  const backHref = `/${locale}/ch/${back.slice(0, 2)}/${back}`;
  return (
    <>
      <div className="col suggest-page">
        {strip !== null ? <ContextStrip locale={locale} {...strip} /> : null}
        <main className="suggest-start">
          <section className="rr anchor-step" aria-label={t("anchorLabel")}>
            <div className="col anchor-step-head">
              <span className="cap">{t("step")}</span>
              <h1 className="h3">{t("title")}</h1>
              <p className="small muted">{t("intro")}</p>
            </div>
            <StepBody body={body} locale={locale} chapterDigits={chapterDigits} backHref={backHref} back={back} />
          </section>
        </main>
      </div>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{body.kind === "picker" ? t("statusbar.anchor", { n: chapterDigits, id: body.picker.anchor.id }) : t("statusbar.chapter", { n: chapterDigits })}</span>
        {rubric !== null ? <span className="desktop-only">{t("statusbar.rubric", { version: rubric.version, date: formatDate(rubric.publishedAt, locale) })}</span> : null}
      </StatusBar>
    </>
  );
}

interface StepBodyProps {
  readonly body: StartBody;
  readonly locale: Locale;
  readonly chapterDigits: string;
  readonly back: string;
  readonly backHref: string;
}

function StepBody({ body, locale, chapterDigits, back, backHref }: StepBodyProps) {
  const t = useTranslations("improve.suggest");
  if (body.kind === "picker") return <AnchorPicker {...body.picker} />;
  if (body.kind === "missing") {
    return (
      <ErrorBox
        title={t("notFound.title")}
        actions={
          <Link className="btn btn-sm" href={`/${locale}/ch/${chapterDigits}`}>
            {t("notFound.choose")}
          </Link>
        }
      >
        {body.anchor === "" ? t("notFound.empty", { n: chapterDigits }) : t("notFound.body", { id: body.anchor, n: chapterDigits, version: body.version ?? "" })}
      </ErrorBox>
    );
  }
  /* the gate's notice is shared with the new-suggestion chooser and a finding's block (48 § 10.1; unit 76) */
  return (
    <>
      <SuggestGateNotice gate={body.gate} locale={locale} />
      <Link className="btn btn-sm anchor-step-back" href={backHref}>
        {t("strip.back", { id: back })}
      </Link>
    </>
  );
}
