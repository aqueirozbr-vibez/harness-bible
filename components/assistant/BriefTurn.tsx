"use client";

import { useTranslations } from "next-intl";

import { CitationChip } from "@/components/assistant/CitationChip";
import { NoCover } from "@/components/ui/NoCover";
import { StatusMark } from "@/components/ui/StatusMark";
import type { RefBase } from "@/lib/assistant/links";
import { bodyClaims, type AnswerView } from "@/lib/assistant/turns";

/*
 * An executive brief's body (feature-specs/19 § 6.3): the decision asked about as the caption, the stance Part III
 * takes as a mark with its condition, at most six numbered claims each with its chip, and the count of Part III
 * chapters cited. The count is computed here from the citations, never taken from the model (D1).
 */

interface BriefTurnProps {
  readonly answer: AnswerView;
  readonly basePath: RefBase;
}

const STANCE_TONE = { recommends: "ok", conditional: "warn", "leaves-open": "mute" } as const;
const STANCE_KEY = { recommends: "recommends", conditional: "conditional", "leaves-open": "leavesOpen" } as const;

export function BriefTurn({ answer, basePath }: BriefTurnProps) {
  const t = useTranslations("assistant.brief");
  const ta = useTranslations("assistant");
  const claims = bodyClaims(answer);
  const chaptersCited = new Set(answer.citations.map((citation) => citation.sectionId.slice(0, 2))).size;
  const brief = answer.brief;

  return (
    <div className="brief">
      {brief === null ? null : (
        <>
          <span className="cap">{t("cap", { decision: brief.decision })}</span>
          <div className="brief-stance">
            <StatusMark tone={STANCE_TONE[brief.stance]}>{t(STANCE_KEY[brief.stance])}</StatusMark>
            {brief.condition === null ? null : <span className="small">{brief.condition}</span>}
          </div>
        </>
      )}
      {/* No claims on a turn read back from its row: the 30 days took the words; the chips are gone with the claims' text, the verdicts stay. */}
      {claims.length === 0 && answer.claims === null ? (
        <p className="small">
          <span className="nocover purged">{ta("purged")}</span>
        </p>
      ) : null}
      <ol className="brief-claims">
        {claims.map((claim, index) => {
          const citation = claim.substituted ? undefined : answer.citations.find((candidate) => candidate.sectionId === claim.sectionId && (claim.figureId === null || candidate.figureId === claim.figureId));
          return (
            <li key={`${String(index)}-${claim.text.slice(0, 24)}`}>
              {claim.substituted ? <NoCover>{claim.text}</NoCover> : claim.text}
              {citation === undefined ? null : (
                <>
                  {" "}
                  <CitationChip citation={citation} basePath={basePath} label={citation.sectionId} />
                </>
              )}
            </li>
          );
        })}
      </ol>
      <p className="small muted">{t("from", { n: chaptersCited })}</p>
    </div>
  );
}
