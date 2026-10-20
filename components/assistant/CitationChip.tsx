"use client";

import { Cite } from "@/components/ui/Cite";
import { PEEK_ANCHOR_ATTR } from "@/components/reader/ProseInteractions";
import { refHref, type RefBase } from "@/lib/assistant/links";
import type { CitationView } from "@/lib/assistant/turns";

/*
 * One citation, as a chip the reader can open (feature-specs/16 § 5.5). Beside a reader section the href is the peek
 * route, so a click opens the panel beside the dock exactly as a cross-reference in the prose does, and the chip marks
 * itself as the peek's anchor so `esc` returns focus here (spec 03's mechanics). On any other page there is no peek:
 * the chip opens the reader at the cited section, with the conversation docked beside it (feature-specs/24 § 5.5).
 *
 * `data-figure` carries the figure the citation names, which is what the reading column highlights (§ 7).
 */

interface CitationChipProps {
  readonly citation: CitationView;
  /** Where a reference opens: the peek beside a reader section, the reader itself from any other page. */
  readonly basePath: RefBase;
  /** `Lab 21 · README` for a lab citation, which arrives with the lab mode of feature-specs/19. */
  readonly label: string;
}

/** A citation whose section id is a lab's anchor (`lab21`) rather than a section's (`21.3`). */
export function isLabCitation(sectionId: string): boolean {
  return /^lab\d{2}$/.test(sectionId);
}

export function CitationChip({ citation, basePath, label }: CitationChipProps) {
  return (
    <Cite
      href={refHref(basePath, citation.sectionId)}
      figureId={citation.figureId}
      onClick={(event) => {
        /* One anchor at a time: the peek reads it to place itself and to give focus back on close. */
        document.querySelectorAll(`[${PEEK_ANCHOR_ATTR}]`).forEach((element) => element.removeAttribute(PEEK_ANCHOR_ATTR));
        event.currentTarget.setAttribute(PEEK_ANCHOR_ATTR, "");
      }}
    >
      {label}
    </Cite>
  );
}
