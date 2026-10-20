"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

import { ChangeTable } from "@/components/improve/ChangeTable";
import { FindingAction } from "@/components/research/FindingAction";
import { Cite } from "@/components/ui/Cite";
import type { Locale } from "@/lib/i18n/routing";
import type { FindingRole } from "@/lib/research/findingAction";
import { researchRefHref, type ResearchRefBase } from "@/lib/research/links";
import type { ResearchFindingView } from "@/lib/schemas/api";

/*
 * A finding that passed the code's checks (feature-specs/48 § 11.3, § 16, A7; unit 72): `finding 1 of 2 · a proposed
 * change to the book`, numbered among the ones that passed and never by the reader's ordinal; its anchor as a chip
 * into the reader, with the section's title and the class a submission would be given; the change before and after
 * (the outcome page's `ChangeTable`); the hosts of its sources; and the researcher's note, said to be written from the
 * pages it read. A finding the checks rejected is never sent to the page, nor their number.
 *
 * Under it, since unit 74, `FindingAction`: the button of the person's role — `Draft it in Improve` or `Send to Improve`
 * — with its help, the throttle notice in its place, a send's failures' lines and its follow after a 202; what became of
 * a finding already used, its outcome's line (§ 8.1), a draft's with `Open draft` and a proposal's with its panel; and
 * for a finding whose run's words are gone, that line alone (§ 11.3): an unused one says its text was removed after 30
 * days.
 */

interface FindingCardProps {
  readonly finding: ResearchFindingView;
  /** How many findings of the run passed the checks. */
  readonly of: number;
  readonly refBase: ResearchRefBase;
  /** The language the run read the book in: the anchored text and the change are that edition's. */
  readonly contentLang: "en" | "pt";
  /** The run it came from, which a send's follow reads. */
  readonly runId: string;
  /** Who the person is to it: they draft, the throttle pauses them, or they send (§ 8.1). */
  readonly role: FindingRole;
  readonly locale: Locale;
}

export function FindingCard({ finding, of, refBase, contentLang, runId, role, locale }: FindingCardProps) {
  const t = useTranslations("research.findings");
  const tc = useTranslations("rubric.thresholds.class");
  const headId = useId();
  const anchor = finding.textPurged ? null : finding.anchor;
  return (
    <section className="finding" aria-labelledby={headId} data-finding={finding.id}>
      <h3 id={headId} className="cap finding-cap">
        {t("cap", { i: finding.n, n: of })}
      </h3>
      {anchor === null ? null : (
        <div className="col finding-body">
          <div className="row finding-anchor">
            {anchor.section === null ? <span className="meta">{anchor.id}</span> : <Cite href={researchRefHref(refBase, anchor.section)}>{anchor.id}</Cite>}
            {anchor.title === null ? null : (
              <span className="small" lang={contentLang}>
                {anchor.title}
              </span>
            )}
            {finding.changeClass === null ? null : <span className="small muted">{tc(finding.changeClass)}</span>}
          </div>
          {finding.change === null ? null : <ChangeTable before={finding.change.before} after={finding.change.after} contentLang={contentLang} />}
          {finding.sources === null || finding.sources.length === 0 ? null : (
            <div className="col finding-sources">
              <span className="cap">{t("sources")}</span>
              <ul>
                {finding.sources.map((source) => (
                  <li key={source.url} className="small">
                    {source.host}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {finding.note === null ? null : (
            <div className="col finding-note">
              <span className="cap">{t("note")}</span>
              <p className="small" lang={contentLang}>
                {finding.note}
              </p>
              <p className="help">{t("noteFrom")}</p>
            </div>
          )}
          <p className="help">{t("checks")}</p>
        </div>
      )}
      <FindingAction finding={finding} runId={runId} role={role} locale={locale} refBase={refBase} />
    </section>
  );
}
