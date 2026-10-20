"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { DeleteDraft } from "@/components/improve/DeleteDraft";
import { FromResearchInstrument } from "@/components/improve/FromResearchInstrument";
import { IdentityInstrument } from "@/components/improve/IdentityInstrument";
import { PredictionInstrument } from "@/components/improve/PredictionInstrument";
import { ScoreInstrument } from "@/components/improve/ScoreInstrument";
import { SubmitPanel } from "@/components/improve/SubmitPanel";
import { onDraftView } from "@/lib/hooks/draftView";
import type { Locale } from "@/lib/i18n/routing";
import type { SubmitFacts } from "@/lib/improve/scoreView";
import type { EvidenceItemView, SuggestionScoring, SuggestionView } from "@/lib/schemas/suggestions";

interface ScoreColumnProps {
  readonly id: string;
  readonly locale: Locale;
  readonly rubricVersion: string;
  /** As the page loaded: the score and prediction (null until an item is graded), the thresholds, the items. */
  readonly scoring: SuggestionScoring | null;
  readonly thresholds: SuggestionView["thresholds"];
  readonly items: ReadonlyArray<EvidenceItemView>;
  readonly identity: { readonly name: string; readonly verified: boolean };
  readonly submit: SubmitFacts;
  /** The saved rationale's words. */
  readonly words: number;
  /** A revision's Submit (31 § 6.5), which says so. */
  readonly revision: boolean;
  /** A draft made from a research finding, while its run's text lasts (feature-specs/48 § 8.2): the note, the run, the sources. */
  readonly research: { readonly note: string; readonly contentLang: "en" | "pt"; readonly runHref: string; readonly sources: ReadonlyArray<{ readonly url: string; readonly host: string }> } | null;
}

/**
 * The edit page's right column, the live score (feature-specs/34 § 6; unit 51e; the Improve-Suggest screen): the Score
 * and Predicted outcome instruments, the Identity, and Submit. It draws the draft as the page loaded it, then every
 * fresh view another island has — the evidence list's reads, a save's answer — so that its numbers change without a
 * reload and are always the server's. Since unit 74 a draft made from a research finding has `from your research` at its
 * head (feature-specs/48 § 8.2), its sources read against the items as drawn.
 */
export function ScoreColumn({ id, locale, rubricVersion, scoring, thresholds, items, identity, submit, words, revision, research }: ScoreColumnProps) {
  const t = useTranslations("improve.suggest.score");
  const [drawn, setDrawn] = useState<{ readonly scoring: SuggestionScoring | null; readonly thresholds: SuggestionView["thresholds"]; readonly items: ReadonlyArray<EvidenceItemView>; readonly at: Date | null }>({ scoring, thresholds, items, at: null });

  useEffect(() => onDraftView((view) => setDrawn({ scoring: view.scoring, thresholds: view.thresholds, items: view.evidence, at: new Date() })), []);

  return (
    <aside className="rl col score-column desktop-only" aria-label={t("label")}>
      {research === null ? null : <FromResearchInstrument note={research.note} contentLang={research.contentLang} runHref={research.runHref} sources={research.sources} items={drawn.items} />}
      <ScoreInstrument rubricVersion={rubricVersion} scoring={drawn.scoring} thresholds={drawn.thresholds} items={drawn.items} at={drawn.at} />
      <PredictionInstrument locale={locale} scoring={drawn.scoring} items={drawn.items} />
      <IdentityInstrument name={identity.name} verified={identity.verified} />
      <SubmitPanel id={id} locale={locale} submit={submit} words={words} revision={revision} />
      {/* a revision is not a draft (45 § 4): it is withdrawn from its outcome page, not deleted */}
      {revision ? null : <DeleteDraft id={id} locale={locale} />}
    </aside>
  );
}
