"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useId } from "react";

import { assistantPageHref } from "@/lib/assistant/links";
import { formatDayMonth } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";

/*
 * Where a seeded research comes from (feature-specs/48 § 11.3, A6; unit 72): an instrument whose header reads `from
 * the Assistant · answer of 12 Oct · cites 21.3 · 21.4` with a link to that answer's conversation. Before Start
 * (`?from=`) its body says what the research reads and that nothing is spent until Start, and offers to start from
 * scratch instead, which drops `from`; the composer holds the answer's question, editable. Once the research exists the
 * card stands above its first question, its header alone; and where the answer was deleted since, it says so (§ 9.5).
 */

/** The seed as the card shows it: the answer's conversation, when it was answered and what it cited; or gone. */
export type SeedCardData = { readonly kind: "answer"; readonly conversationId: string; readonly answeredAt: string; readonly cited: ReadonlyArray<string> } | { readonly kind: "deleted" };

interface SeedCardProps {
  readonly seed: SeedCardData;
  readonly locale: Locale;
  /** Before Start: the page without `from`, which `Start from scratch instead` leads to; null once the research exists. */
  readonly scratchHref: string | null;
}

export function SeedCard({ seed, locale, scratchHref }: SeedCardProps) {
  const t = useTranslations("research.seed");
  /* the region is named by what its header says, never by the link beside it (unit 72's review) */
  const headId = useId();
  return (
    <section className="inst seed-card" aria-labelledby={headId}>
      <div className="inst-h">
        {seed.kind === "deleted" ? (
          <span id={headId}>{t("deleted")}</span>
        ) : (
          <>
            <span id={headId}>{seed.cited.length === 0 ? t("capNone", { date: formatDayMonth(new Date(seed.answeredAt), locale) }) : t("cap", { date: formatDayMonth(new Date(seed.answeredAt), locale), sections: seed.cited.join(" · ") })}</span>
            <span className="ts">
              <Link className="xref" href={assistantPageHref(locale, { ask: seed.conversationId })}>
                {t("open")}
              </Link>
            </span>
          </>
        )}
      </div>
      {scratchHref === null ? null : (
        <div className="inst-b col seed-card-body">
          <p className="small">{t("body")}</p>
          <Link className="btn btn-sm seed-card-scratch" href={scratchHref}>
            {t("scratch")}
          </Link>
        </div>
      )}
    </section>
  );
}
