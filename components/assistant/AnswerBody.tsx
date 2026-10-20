"use client";

import { useTranslations } from "next-intl";
import { Fragment } from "react";

import { CitationChip, isLabCitation } from "@/components/assistant/CitationChip";
import { DeriveLink } from "@/components/ui/DeriveLink";
import { NoCover } from "@/components/ui/NoCover";
import type { RefBase } from "@/lib/assistant/links";
import { claimGroups, deriveLineOf, splitAroundValue, type AnswerView, type CitationView, type ClaimView } from "@/lib/assistant/turns";

/*
 * The answer as the `final` event gave it (feature-specs/16 § 5.4). Every paragraph, every chip and every framed
 * number here comes from that event: nothing is carried over from the streamed draft, and nothing is composed from
 * the row (invariant 14).
 *
 * A claim the citation sensor replaced renders as `NoCover` with no chip, because a substitution is not a citable
 * claim; a figure the claim quotes is framed as `.fig-der` and, when the release's own figure carries a derive line,
 * followed by the `ƒ L45` chip that opens the code pane.
 */

interface AnswerBodyProps {
  readonly answer: AnswerView;
  /** Where a chip opens: the peek beside a reader section, the reader itself from any other page. */
  readonly basePath: RefBase;
}

function citationFor(claim: ClaimView, citations: ReadonlyArray<CitationView>): CitationView | null {
  if (claim.sectionId === null || claim.substituted) return null;
  return citations.find((citation) => citation.sectionId === claim.sectionId && (claim.figureId === null || citation.figureId === claim.figureId)) ?? null;
}

export function AnswerBody({ answer, basePath }: AnswerBodyProps) {
  const t = useTranslations("assistant.dock");
  const ta = useTranslations("assistant");
  const tl = useTranslations("assistant.log");
  /* A turn read back from its row: its text is the claims already joined, so the chips follow the paragraph rather
     than each sentence (§ 5.4). The citations are the row's own, and every one of them still opens its section. */
  if (answer.claims === null) {
    /* A row with no words is one of two things: an answered turn whose text the 30 days took — it has its ledger
       line, and its chips, verdicts and record stay (feature-specs/21 § 3.2) — or a turn that failed, which has none. */
    const purged = answer.text === null && answer.ledger !== null;
    return (
      <p className={answer.text === null && !purged ? "small muted" : undefined}>
        {answer.text === null ? purged ? <span className="nocover purged">{ta("purged")}</span> : tl("failed") : answer.text}
        {answer.citations.map((citation) => (
          <Fragment key={`${citation.sectionId}-${citation.figureId ?? "none"}`}>
            {" "}
            <CitationChip citation={citation} basePath={basePath} label={isLabCitation(citation.sectionId) ? t("labCitation", { n: citation.sectionId.slice(3) }) : citation.sectionId} />
          </Fragment>
        ))}
      </p>
    );
  }

  return (
    <>
      {claimGroups(answer.claims).map((group, index) => {
        const citation = citationFor(group.claims[0] ?? { text: "", sectionId: null, figureId: null, valueText: null, substituted: false }, answer.citations);
        return (
          <p key={`${String(index)}-${group.sectionId ?? "none"}`}>
            {group.claims.map((claim, position) => (
              <Fragment key={`${String(position)}-${claim.text.slice(0, 24)}`}>
                {position > 0 ? " " : null}
                <ClaimText claim={claim} deriveLine={deriveLineOf(answer, claim.figureId)} />
              </Fragment>
            ))}
            {citation === null ? null : (
              <>
                {" "}
                <CitationChip citation={citation} basePath={basePath} label={isLabCitation(citation.sectionId) ? t("labCitation", { n: citation.sectionId.slice(3) }) : citation.sectionId} />
              </>
            )}
          </p>
        );
      })}
    </>
  );
}

function ClaimText({ claim, deriveLine }: { readonly claim: ClaimView; readonly deriveLine: number | null }) {
  if (claim.substituted) return <NoCover>{claim.text}</NoCover>;
  const split = splitAroundValue(claim.text, claim.valueText);
  if (split === null) return <>{claim.text}</>;
  return (
    <>
      {split.before}
      <span className="fig-der mono">{split.value}</span>
      {deriveLine === null ? null : (
        <>
          {" "}
          <DeriveLink line={deriveLine} />
        </>
      )}
      {split.after}
    </>
  );
}
