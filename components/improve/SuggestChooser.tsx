import { useTranslations } from "next-intl";
import Link from "next/link";

import { StatusBar } from "@/components/chrome/StatusBar";
import { SuggestGateNotice } from "@/components/improve/SuggestGateNotice";
import { PART_ROMAN } from "@/components/reader/PartGrid";
import { Xref } from "@/components/ui/Xref";
import type { ChooserChapter, SuggestChooserData } from "@/lib/db/suggestChooser";
import { formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { suggestChooserHref } from "@/lib/improve/suggest";

interface SuggestChooserProps {
  readonly locale: Locale;
  readonly body: SuggestChooserData["body"];
  readonly loadedMs: number;
}

/**
 * The new-suggestion chooser (feature-specs/48 § 10.1, A11; unit 76; no screen draws it): Improve's `New suggestion`
 * from scratch, in two steps before today's step 1. The release's chapters under their parts' captions, each a link to
 * its sections (`NN · title · vX.Y.Z`); then a chapter's sections under `← chapters`, each a link to step 1 at that
 * section, where the person picks the section itself, one of its figures or a source row (spec 34 § 4). A person who
 * does not draft sees step 1's notice at the top in place of either list (`SuggestGateNotice`). Every choice is a link,
 * so the address says what is chosen, as step 1's do. Renders at every width, one column of rows under 768px.
 */
export function SuggestChooser({ locale, body, loadedMs }: SuggestChooserProps) {
  const t = useTranslations("improve.new");
  const tc = useTranslations("improve.home");
  const th = useTranslations("home.statusbar");
  return (
    <>
      <main className="improve-new">
        <div className="col improve-new-head">
          <span className="cap">{tc("cap")}</span>
          <h1 className="h1">{t("title")}</h1>
        </div>
        {body.kind === "gate" ? <SuggestGateNotice gate={body.gate} locale={locale} /> : null}
        {body.kind === "chapters" ? (
          <section className="col improve-new-choose" aria-labelledby="improve-new-chapters">
            <h2 className="h4" id="improve-new-chapters">
              {t("chapters")}
            </h2>
            {body.parts.map((part) => (
              <PartChapters key={part.key} partKey={part.key} chapters={part.chapters} />
            ))}
          </section>
        ) : null}
        {body.kind === "sections" ? (
          <section className="col improve-new-choose" aria-labelledby="improve-new-sections">
            <Xref href={suggestChooserHref(locale)} className="improve-new-back">
              {t("back")}
            </Xref>
            <div className="col improve-new-chapter">
              <h2 className="h4" id="improve-new-sections">
                {t("sections", { n: body.chapter.digits })}
              </h2>
              <p className="meta">
                {body.chapter.digits} · <span lang={body.contentLang}>{body.chapter.title}</span> · {body.chapter.version}
              </p>
            </div>
            <ol className="improve-new-list">
              {body.sections.map((section) => (
                <li key={section.id}>
                  <Link className="improve-new-row" href={section.href}>
                    <span className="meta">{section.id}</span> · <span className="improve-new-title" lang={body.contentLang}>{section.title}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </main>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{body.kind === "sections" ? t("statusbar", { n: body.chapter.digits }) : t("statusbarNone")}</span>
      </StatusBar>
    </>
  );
}

/** One part's chapters under its caption, the part's name as Book Home prints it (`part ii · harness engineering`). */
function PartChapters({ partKey, chapters }: { readonly partKey: keyof typeof PART_ROMAN; readonly chapters: ReadonlyArray<ChooserChapter> }) {
  const tp = useTranslations("home.part");
  const headingId = `improve-new-part-${partKey}`;
  return (
    <section className="col improve-new-part" aria-labelledby={headingId}>
      <h3 className="cap" id={headingId}>
        {tp("cap", { roman: PART_ROMAN[partKey], title: tp(`title.${partKey}`) })}
      </h3>
      <ol className="improve-new-list">
        {chapters.map((chapter) => (
          <li key={chapter.digits}>
            <Link className="improve-new-row" href={chapter.href}>
              <span className="meta">{chapter.digits}</span> · <span className="improve-new-title">{chapter.title}</span> · <span className="meta">{chapter.version}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
