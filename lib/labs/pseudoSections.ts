import { formatDate } from "@/lib/i18n/format";
import { LabResultSchema, type LabModeResult } from "@/lib/schemas/assistant";

import type { CheckedFigure } from "./checkedFigures";

/*
 * What retrieval adds for lab mode (feature-specs/19 § 4): two pseudo-sections built from the `Lab` row and the
 * chapter's checked figures, as text the model reads beside the chapter's own lab section. Pure: the workers load
 * the rows and hand them here.
 *
 *   lab:{labId}:readme    the facts line, then the README's plain text
 *   lab:{labId}:lastRun   `last run: REPRODUCED · CI · 23 Sep 2026` and one line per checked figure
 *
 * Both cite as the chapter's lab section (`NN.4`): the claim grammar names sections, so the README and the run are
 * read under their own ids and cited through the section that is about the lab. In Phase 2 the last run is CI's
 * (D2: `ciVerdict`, `ciCheckedAt`, `derived`); Phase 3's `LabRun` replaces it with the reader's own.
 */

export type PseudoKind = "readme" | "lastRun";

export interface LabFacts {
  readonly labId: string;
  /** The chapter's number, which is the lab's. */
  readonly number: number;
  readonly title: string;
  readonly expectedRuntimeS: number | null;
  readonly declaresModelCalls: boolean;
  readonly egressExtra: ReadonlyArray<string>;
  /** CI's verdict: REPRODUCED, NOT_REPRODUCED, KILLED, ERROR; null when CI never ran. */
  readonly ciVerdict: string | null;
  /** ISO-8601, or null when CI never ran. */
  readonly ciCheckedAt: string | null;
  readonly figures: ReadonlyArray<CheckedFigure>;
}

export function pseudoId(labId: string, kind: PseudoKind): string {
  return `lab:${labId}:${kind}`;
}

export function labNumberText(number: number): string {
  return String(number).padStart(2, "0");
}

/** `2 m`, `2 m 48 s`, `45 s` (ui-context § 13.5); `not declared` when the lab states none. */
export function runtimeText(seconds: number | null): string {
  if (seconds === null) return "not declared";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${String(rest)} s`;
  return rest === 0 ? `${String(minutes)} m` : `${String(minutes)} m ${String(rest)} s`;
}

/** `Lab 21 · expected runtime 2 m · model calls: none · egress: none` */
export function factsLine(facts: LabFacts): string {
  const egress = facts.egressExtra.length === 0 ? "none" : facts.egressExtra.join(", ");
  return `Lab ${labNumberText(facts.number)} · expected runtime ${runtimeText(facts.expectedRuntimeS)} · model calls: ${facts.declaresModelCalls ? "declared" : "none"} · egress: ${egress}`;
}

export function readmeText(facts: LabFacts, textEn: string): string {
  return `${factsLine(facts)}\n\n${textEn.trim()}`;
}

/** `last run: REPRODUCED · CI · 23 Sep 2026`, or `last run: none` when CI never ran. */
export function lastRunLine(facts: LabFacts): string {
  if (facts.ciVerdict === null) return "last run: none";
  const date = facts.ciCheckedAt === null ? "" : ` · ${formatDate(new Date(facts.ciCheckedAt), "en")}`;
  return `last run: ${facts.ciVerdict} · CI${date}`;
}

/** `p_no_failure_13calls_f0.02 · chapter 77% · last run 0.769 · match` */
export function figureLine(figure: CheckedFigure): string {
  return `${figure.figureId} ${figure.key} · chapter ${figure.chapterValue} · last run ${figure.runValue === null ? "—" : String(figure.runValue)} · ${figure.verdict}`;
}

export function lastRunText(facts: LabFacts): string {
  return [lastRunLine(facts), ...facts.figures.map(figureLine)].join("\n");
}

/**
 * What a lab turn's `final` event carries and its row stores (spec 19 § 6.2): the model's result, when it had one,
 * and the run as the workers computed it, so the screen and the model saw one thing.
 */
export function labModeResultOf(modelResult: unknown, facts: LabFacts): LabModeResult {
  const parsed = LabResultSchema.safeParse(modelResult);
  return {
    reproduces: parsed.success ? parsed.data.reproduces : "",
    divergingMeans: parsed.success ? parsed.data.divergingMeans : null,
    lab: {
      labId: facts.labId,
      number: facts.number,
      title: facts.title,
      verdict: facts.ciVerdict,
      checkedAt: facts.ciCheckedAt,
      expectedRuntimeS: facts.expectedRuntimeS,
      declaresModelCalls: facts.declaresModelCalls,
      figures: facts.figures.map((figure) => ({
        figureId: figure.figureId,
        sectionId: figure.sectionId,
        label: figure.label,
        key: figure.key,
        chapterValue: figure.chapterValue,
        runValue: figure.runValue,
        verdict: figure.verdict,
        line: figure.line,
      })),
    },
  };
}
