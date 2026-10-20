"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";

import { PEEK_ANCHOR_ATTR } from "@/components/reader/ProseInteractions";
import { Cite } from "@/components/ui/Cite";
import { StatusMark } from "@/components/ui/StatusMark";
import type { RefusalView } from "@/lib/assistant/turns";

/*
 * A refusal is an answer of a different kind (feature-specs/17 § 3): it says why, with a code, and where the book
 * does cover the question, so the reader learns the scope instead of hitting a wall.
 *
 * Every word on the card is the catalogue's or the release's. The sentence is `assistant.refusal.<cause>`, never
 * the model's text (invariant 14); the pointers are the `final` event's, each a section id and its own title, and
 * each opens the peek beside the dock. A refusal read back from its row carries no pointers, so the covers block is
 * omitted rather than guessed.
 *
 * Since unit 72 a refused research run is this card too (feature-specs/48 § 11.5): where a pointer leads is the
 * caller's (`hrefOf`: the Assistant's `refHref`, or research's `researchRefHref`, which never opens the Assistant's
 * dock), and so is the footer's text where the card's own would be untrue — a research refusal is never `refused
 * after the answer`, it is refused before any search.
 */

interface RefusalCardProps {
  readonly refusal: RefusalView;
  /** Where a pointer opens: for the Assistant the peek beside a reader section, the reader itself from any other page. */
  readonly hrefOf: (sectionId: string) => string;
  /** The footer's code line in place of the card's own `before` or `after` (48 § 11.5). */
  readonly foot?: string;
  /** The footer's action, `Flag this refusal`, which spec 17 § 4 provides; absent until it does. */
  readonly action?: React.ReactNode;
}

export function RefusalCard({ refusal, hrefOf, foot, action }: RefusalCardProps) {
  const t = useTranslations("assistant.refusal");

  return (
    <section className="box-s refusal" aria-label={t("label")}>
      <div className="between rb refusal-head">
        <StatusMark tone="fail">{t("refused")}</StatusMark>
        <span className="meta">{t("causeLine", { cause: t(`cause.${refusal.cause}`) })}</span>
      </div>
      <div className="refusal-body">
        <p>{t(refusal.cause)}</p>
        {refusal.pointers.length === 0 ? null : (
          <div className="col refusal-covers">
            <span className="cap">{t("covers")}</span>
            {refusal.pointers.map((pointer) => (
              <Link
                key={pointer.sectionId}
                href={hrefOf(pointer.sectionId)}
                className="row refusal-pointer"
                onClick={(event) => {
                  /* The peek anchors to the link it came from and gives focus back on close (spec 03's mechanics). */
                  document.querySelectorAll(`[${PEEK_ANCHOR_ATTR}]`).forEach((element) => element.removeAttribute(PEEK_ANCHOR_ATTR));
                  event.currentTarget.setAttribute(PEEK_ANCHOR_ATTR, "");
                }}
              >
                <Cite>{pointer.sectionId}</Cite>
                <span className="small">{pointer.title}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
      <div className="inst-f refusal-foot">
        <span>{foot ?? (refusal.beforeRetrieval ? t("before", { code: refusal.code }) : t("after", { code: refusal.code }))}</span>
        {action}
      </div>
    </section>
  );
}
