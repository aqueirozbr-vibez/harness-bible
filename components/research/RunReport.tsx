"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

import { Cite } from "@/components/ui/Cite";
import { researchRefHref, runPageId, type ResearchRefBase } from "@/lib/research/links";
import { reportPiecesOf } from "@/lib/research/runBlock";
import type { ResearchRunView } from "@/lib/schemas/api";

/*
 * A run's report (feature-specs/48 § 5.7, § 11.3; unit 72): the paragraphs the report sensor passed, as plain text and
 * never as markup, under the line that says what it is — `report · from the web, not from the book · not checked by
 * Improve` — since it is the researcher's, not the book's (invariant 31). A section it cites is a `Cite` chip into the
 * reader by `researchRefHref`, and a page it cites is `[n]`, a link to that page's row of this run's list
 * (`run-<runId>-page-<n>`), so no address the writer wrote is ever a link. The container is rendered from the run
 * block's first render, empty and `aria-live="off"`, and filled when the run has a report: the end is announced once,
 * by the line, and the report is reached by its heading (§ 20).
 */

interface RunReportProps {
  readonly run: ResearchRunView;
  readonly refBase: ResearchRefBase;
}

export function RunReport({ run, refBase }: RunReportProps) {
  const t = useTranslations("research.report");
  const headId = useId();
  const report = run.report;
  const pages = new Set(run.pages.map((page) => page.n));
  const pageLink = (n: number) => (
    <a key={`page-${String(n)}`} className="run-ref" href={`#${runPageId(run.id, n)}`}>
      [{n}]
    </a>
  );
  return (
    <div className="run-report" aria-live="off">
      {report === null ? null : (
        <section className="col run-report-body" aria-labelledby={headId}>
          <h3 id={headId} className="cap run-report-cap">
            {t("cap")}
          </h3>
          {report.paragraphs.map((paragraph) => {
            const { pieces, trailing } = reportPiecesOf(paragraph, pages);
            return (
              /* a report is immutable once written, so its text is the paragraph's own key */
              <p key={paragraph.text} lang={run.language}>
                {pieces.map((piece, index) => (piece.kind === "page" ? pageLink(piece.n) : <span key={`text-${String(index)}`}>{piece.text}</span>))}
                {trailing.map((n) => (
                  <span key={`trailing-${String(n)}`}> {pageLink(n)}</span>
                ))}
                {paragraph.sections.map((section) => (
                  <span key={`section-${section}`}>
                    {" "}
                    <Cite href={researchRefHref(refBase, section)}>{section}</Cite>
                  </span>
                ))}
              </p>
            );
          })}
        </section>
      )}
    </div>
  );
}
