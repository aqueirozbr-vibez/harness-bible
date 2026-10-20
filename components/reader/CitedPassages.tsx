"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { StatusMark } from "@/components/ui/StatusMark";
import { CITED_EVENT, type CitedDetail } from "@/lib/hooks/citedPassages";

/*
 * The reading column's side of an open answer (feature-specs/16 § 7): the `cited` band under the section head when
 * this section is among the citations, and a left rule on the paragraphs that print the figures they name.
 *
 * The classes go on the server-rendered prose and come off when the dock closes; the prose's own text is never
 * touched. The unit is the paragraph, not the sentence (D6): the screen underlines sentences, and sentence
 * boundaries are not in the stored HTML, so a paragraph rule is the exact thing this can say.
 */

const PASSAGE_CLASS = "cited-passage";

interface CitedPassagesProps {
  readonly sectionId: string;
}

export function CitedPassages({ sectionId }: CitedPassagesProps) {
  const t = useTranslations("assistant.dock");
  const [count, setCount] = useState(0);

  useEffect(() => {
    const clear = (): void => {
      document.querySelectorAll(`.${PASSAGE_CLASS}`).forEach((element) => element.classList.remove(PASSAGE_CLASS));
    };

    const onCited = (event: Event): void => {
      const detail = (event as CustomEvent<CitedDetail>).detail;
      clear();
      const here = detail.citations.filter((citation) => citation.sectionId === sectionId);
      if (here.length === 0) {
        setCount(0);
        return;
      }
      /* A citation with no figure id highlights nothing: it cites the section, and the band says so (§ 7). */
      let marked = 0;
      for (const citation of here) {
        if (citation.figureId === null) continue;
        const figure = document.querySelector<HTMLElement>(`.prose [data-figure="${citation.figureId}"]`);
        const paragraph = figure?.closest("p");
        if (paragraph !== null && paragraph !== undefined && !paragraph.classList.contains(PASSAGE_CLASS)) {
          paragraph.classList.add(PASSAGE_CLASS);
          marked += 1;
        }
      }
      setCount(marked > 0 ? marked : here.length);
    };

    window.addEventListener(CITED_EVENT, onCited);
    return () => {
      window.removeEventListener(CITED_EVENT, onCited);
      clear();
    };
  }, [sectionId]);

  if (count === 0) return null;

  return (
    <div className="row cited-band">
      <StatusMark tone="ok">{t("cited")}</StatusMark>
      <span className="small cited-line">{t("citedLine", { n: count, section: sectionId })}</span>
    </div>
  );
}
