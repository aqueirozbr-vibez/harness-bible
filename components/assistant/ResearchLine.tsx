"use client";

import { useTranslations } from "next-intl";

import { StatusMark } from "@/components/ui/StatusMark";
import { formatDayMonth } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import { researchLineOf, type ResearchLineKey } from "@/lib/research/view";
import type { ResearchView } from "@/lib/schemas/api";

/*
 * The research line under an answer (feature-specs/43 § 4; unit 60a): one line, the last child of the turn, in the mono
 * status style the verdicts box's footer uses — `research ·` then the state's word as a lower-case status mark (`.st
 * .st-plain`, a word and a shape, never colour alone; the running states carry the caret, still under reduced motion)
 * and, where the state has one, the rest of the line after another `·`: the days since the sections were researched,
 * the budget's reset, the day's count. It renders outside the answer block and changes nothing in it; it has no live
 * role of its own, because the dock's log is one, and is atomic so a change is read whole. A refusal has no line, and a
 * turn whose research is absent (from before research, or a stored `final` replayed without it) has none either.
 *
 * Since unit 75 (feature-specs/48 § 9.3) it is a legacy run's alone: no answer hands its turn to research, so a new turn
 * has no line, and an `off` line reads `off` with no `switch on`, since the account page's switch is gone.
 */

interface ResearchLineProps {
  readonly research: ResearchView;
  readonly locale: Locale;
}

/** The keys whose line has a second part after the word. */
const DETAILED: ReadonlySet<ResearchLineKey> = new Set(["waiting", "budget", "deduped", "sameQuestion", "dailyLimit", "noCitation"]);

export function ResearchLine({ research, locale }: ResearchLineProps) {
  const t = useTranslations("assistant.research");
  const line = researchLineOf(research);
  if (line.key === "none") return null;
  const date = line.resetsAt === null ? "" : formatDayMonth(line.resetsAt, locale);
  const values = { n: line.n ?? 0, days: line.days ?? 0, date };
  return (
    <div className="inst-f research-line" aria-atomic="true" data-research={line.key}>
      <span className="research-label">{t("label")}</span>
      <span className="sep" aria-hidden="true">
        ·
      </span>
      <StatusMark tone={line.tone} caret={line.tone === "run"} className="st-plain">
        {t(`word.${line.key}`, values)}
      </StatusMark>
      {DETAILED.has(line.key) ? (
        <>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span>{t(`detail.${line.key}`, values)}</span>
        </>
      ) : null}
    </div>
  );
}
