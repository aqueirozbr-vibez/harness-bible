"use client";

import { useTranslations } from "next-intl";

import { CitationChip } from "@/components/assistant/CitationChip";
import { NoCover } from "@/components/ui/NoCover";
import { Notice } from "@/components/ui/Notice";
import type { RefBase } from "@/lib/assistant/links";
import { bodyClaims, type AnswerView, type ClaimView } from "@/lib/assistant/turns";

/*
 * A compare's body (feature-specs/19 § 6.1): the two chapters' claims side by side, each under its chapter's caption
 * and each with its chip, and, when the model named one, the point the book leaves open as a notice — the model's
 * summary, with no chip, after the mode sensor has verified both sides are cited. The sides are computed here from
 * the claims' chapters (D1); a side with nothing surviving shows the substitution sentence once.
 */

interface CompareTurnProps {
  readonly answer: AnswerView;
  readonly basePath: RefBase;
  /** The release's chapters, for the captions' titles. */
  readonly chapters: ReadonlyArray<{ readonly number: number; readonly title: string }>;
}

function chapterOf(sectionId: string): number {
  return Number(sectionId.slice(0, 2));
}

export function CompareTurn({ answer, basePath, chapters }: CompareTurnProps) {
  const t = useTranslations("assistant.compare");
  const ta = useTranslations("assistant");
  const claims = bodyClaims(answer);
  const surviving = claims.filter((claim) => !claim.substituted);
  /* The sides in order of first citation; the mode sensor keeps a third chapter out, so there are at most two. */
  const sides: number[] = [];
  for (const claim of surviving) {
    const chapter = chapterOf(claim.sectionId ?? "");
    if (!sides.includes(chapter)) sides.push(chapter);
  }
  /* A replaced claim stays where it was said, as in explain; one from outside the pair has no side and shows once, below. */
  const replaced = claims.filter((claim) => claim.substituted);
  const strays = replaced.filter((claim) => !sides.includes(chapterOf(claim.sectionId ?? "")));
  const titleOf = (chapter: number): string => chapters.find((candidate) => candidate.number === chapter)?.title.toLowerCase() ?? "";

  const chip = (claim: ClaimView) => {
    const citation = answer.citations.find((candidate) => candidate.sectionId === claim.sectionId && (claim.figureId === null || candidate.figureId === claim.figureId));
    return citation === undefined ? null : <CitationChip citation={citation} basePath={basePath} label={citation.sectionId} />;
  };

  return (
    <div className="compare">
      {sides.length === 0 ? (
        <div className="compare-side">
          {replaced[0] === undefined ? <span className="nocover purged">{ta("purged")}</span> : <NoCover>{replaced[0].text}</NoCover>}
        </div>
      ) : (
        sides.map((chapter) => (
          <div key={chapter} className="compare-side">
            <span className="cap">{titleOf(chapter) === "" ? t("sideBare", { n: String(chapter).padStart(2, "0") }) : t("side", { n: String(chapter).padStart(2, "0"), title: titleOf(chapter) })}</span>
            <ol className="claims">
              {claims
                .filter((claim) => chapterOf(claim.sectionId ?? "") === chapter)
                .map((claim, index) => (
                  <li key={`${String(index)}-${claim.text.slice(0, 24)}`}>
                    {claim.substituted ? (
                      <NoCover>{claim.text}</NoCover>
                    ) : (
                      <>
                        {claim.text} {chip(claim)}
                      </>
                    )}
                  </li>
                ))}
            </ol>
          </div>
        ))
      )}
      {sides.length > 0 && strays.length > 0 ? (
        <div className="compare-side">
          <span className="cap">{t("noSide")}</span>
          <NoCover>{strays[0]?.text ?? ""}</NoCover>
        </div>
      ) : null}
      {answer.compare?.openPoint === null || answer.compare?.openPoint === undefined ? null : (
        <div className="compare-open">
          <Notice title={t("openTitle")}>{t("open", { point: answer.compare.openPoint })}</Notice>
        </div>
      )}
    </div>
  );
}
