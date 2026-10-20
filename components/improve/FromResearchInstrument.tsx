import { useTranslations } from "next-intl";
import Link from "next/link";

import { sourcesNotAmong } from "@/lib/research/submission";

interface FromResearchInstrumentProps {
  /** The researcher's note, never the contributor's rationale. */
  readonly note: string;
  /** The run's language, which the note is written in. */
  readonly contentLang: "en" | "pt";
  /** The run on the Research page, under the page's locale. */
  readonly runHref: string;
  /** The finding's `https` sources, each once. */
  readonly sources: ReadonlyArray<{ readonly url: string; readonly host: string }>;
  /** The draft's items as the rail last drew them: what the sources are read against. */
  readonly items: ReadonlyArray<{ readonly url: string | null }>;
}

/**
 * The edit page's `from your research` (feature-specs/48 § 8.2; unit 74), on the rail of a draft made from a research
 * finding while it is a draft and the run's text lasts: the researcher's note with the sentence that it is not the
 * contributor's rationale — the adjudicator reads only what they write, so the note was never copied into it (spec 42
 * § 3) — a link back to the run, and the finding's sources not among the draft's evidence, as links out, under `{n}
 * sources of the finding are not among your evidence: add them as links`. They are read against the draft's items as
 * the rail draws them, so a grading whose start failed and an item the contributor removed are listed alike, after a
 * reload too, and one added from here leaves the list at the next read.
 */
export function FromResearchInstrument({ note, contentLang, runHref, sources, items }: FromResearchInstrumentProps) {
  const t = useTranslations("research.edit");
  const tf = useTranslations("research.findings");
  const tp = useTranslations("research.pages");
  const notAdded = sourcesNotAmong(sources, items);
  return (
    <section className="inst from-research" aria-labelledby="from-research-title">
      <div className="inst-h">
        <h2 className="t" id="from-research-title">
          {t("cap")}
        </h2>
      </div>
      <div className="inst-b col from-research-body">
        <span className="cap">{tf("note")}</span>
        <p className="small" lang={contentLang}>
          {note}
        </p>
        <p className="help">{t("note")}</p>
        <Link href={runHref} className="xref">
          {t("open")}
        </Link>
        {notAdded.length === 0 ? null : (
          <div className="col from-research-sources">
            <p className="small">{t("notAdded", { n: notAdded.length })}</p>
            <ul>
              {notAdded.map((source) => (
                <li key={source.url} className="small">
                  <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="xref">
                    {source.url}
                    <span className="sr-only"> {tp("newTab")}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
