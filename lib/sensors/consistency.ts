import type { JsonValue } from "@/lib/ledger/canonical";
import type { SourceTier } from "@/lib/schemas/domain";
import type { ChangeKind, Part, SuggestionSensor } from "@/lib/schemas/improve";
import type { Refusal } from "@/pipeline/edit/apply";

/*
 * The three consistency sensors of the suggestion workflow's step 5 (feature-specs/33 § 4.2): deterministic, each given
 * rows and never a database, each answering `{ sensor, result, detail, data }` as a `SuggestionSensorVerdict` row holds
 * it, like the intake's (31 § 5). They run after the floor and before the adjudicator (invariant 11): a `FAIL` declines
 * by rule, naming the sensor; a `WARN` never declines.
 */

export interface ConsistencyVerdict {
  readonly sensor: SuggestionSensor;
  readonly result: "PASS" | "FAIL" | "WARN" | "NA";
  readonly detail: string;
  readonly data: JsonValue;
}

function verdict(sensor: SuggestionSensor, result: ConsistencyVerdict["result"], detail: string, data: JsonValue = {}): ConsistencyVerdict {
  return { sensor, result, detail, data };
}

/* ---------------------------------------------------------------- DERIVE_CONSISTENCY */

export interface DeriveFacts {
  /** The anchored figure's id and tier; null when the anchor is not a figure. */
  readonly figure: { readonly id: string; readonly tier: SourceTier } | null;
  /** The value a `SET_VALUE` proposes, as printed; null for any other change. */
  readonly proposed: string | null;
  /** The suggestion's lab runs graded A: whether each changed the lab's `derive.py`, and what it printed for the figure. None in this build, which refuses a lab run as evidence until the IDE (32 § 3). */
  readonly labRuns: ReadonlyArray<{ readonly changedScript: boolean; readonly printed: string | null }>;
}

/** A derived figure changes only with its script (invariant 5): a tier A run that changed `derive.py` and printed the value proposed. */
export function deriveConsistencySensor(facts: DeriveFacts): ConsistencyVerdict {
  const sensor = "DERIVE_CONSISTENCY";
  if (facts.figure === null || facts.figure.tier !== "DERIVED") return verdict(sensor, "NA", "not a derived figure");
  const run = facts.labRuns.find((r) => r.changedScript && facts.proposed !== null && r.printed === facts.proposed);
  if (run !== undefined) return verdict(sensor, "PASS", `a tier A run changed derive.py and printed ${facts.proposed ?? ""}`, { figure: facts.figure.id });
  return verdict(sensor, "FAIL", `${facts.figure.id} is derived: it changes only with its script, and no tier A run changed derive.py${facts.proposed === null ? "" : ` and printed ${facts.proposed}`}`, { figure: facts.figure.id, labRuns: facts.labRuns.length });
}

/* ---------------------------------------------------------------- CROSS_CHAPTER */

/** Another place the anchor is read: a row's figure, the same figure printed in another chapter, a section that refers to it. */
export interface Reading {
  readonly anchor: string;
  readonly section: string;
  readonly part: Part;
  readonly rule: "row" | "figure" | "reference";
  /** A shared figure's other reading: whether the edit could set the value there too (not derived, the same unit). */
  readonly settable: boolean;
}

export interface CrossChapterFacts {
  readonly anchor: string;
  /** The suggestion's parts as they stand. */
  readonly parts: ReadonlyArray<Part>;
  /** Whether the proposal sets a value (`SET_VALUE`). */
  readonly setsValue: boolean;
  readonly readings: ReadonlyArray<Reading>;
}

/**
 * `PASS` when nothing else reads the anchor; `WARN` naming every other reading and the parts to add, so their curators
 * see it (`F-23-06 also at 37.4 — a change would need both`); `FAIL` only when a value set here would leave another
 * reading of the same figure that the edit cannot set to it — a derived reading, or one in another unit.
 */
export function crossChapterSensor(facts: CrossChapterFacts): ConsistencyVerdict {
  const sensor = "CROSS_CHAPTER";
  if (facts.readings.length === 0) return verdict(sensor, "PASS", `nothing else reads ${facts.anchor}`);
  const sections = [...new Set(facts.readings.map((r) => r.section))];
  const parts = [...new Set(facts.readings.map((r) => r.part))].filter((p) => !facts.parts.includes(p));
  const data = { readings: facts.readings.map((r) => ({ anchor: r.anchor, section: r.section, rule: r.rule })), parts };
  const stuck = facts.setsValue ? facts.readings.find((r) => r.rule === "figure" && !r.settable) : undefined;
  if (stuck !== undefined) return verdict(sensor, "FAIL", `${facts.anchor} is also ${stuck.anchor} at ${stuck.section}, which the edit cannot set to the value: the two would disagree`, data);
  return verdict(sensor, "WARN", `${facts.anchor} also at ${sections.join(", ")} — a change would need ${sections.length === 1 ? "both" : "all of them"}`, data);
}

/* ---------------------------------------------------------------- LINT */

export interface LintFacts {
  readonly changeKind: ChangeKind;
  /** `applyProposal`'s answer on the release's files (33 § 4.1); null when the files read are not the release's. */
  readonly applied: { readonly applied: true } | { readonly refused: Refusal; readonly row: string; readonly detail: string } | null;
}

/** The change applies: the chapter parses with it and nothing else moved. A change made by hand is not this sensor's (Andre, 2026-10-07, 33 § 14). */
export function lintSensor(facts: LintFacts): ConsistencyVerdict {
  const sensor = "LINT";
  if (facts.changeKind === "RESTRUCTURE") return verdict(sensor, "NA", "a restructure is made by hand");
  if (facts.applied === null) return verdict(sensor, "NA", "the files read are not the release's, so the change could not be applied");
  if ("refused" in facts.applied) {
    const { refused, row, detail } = facts.applied;
    if (refused === "manual") return verdict(sensor, "NA", `made by hand: ${row}, ${detail}`, { refused, row });
    return verdict(sensor, "FAIL", `${refused}: ${row}, ${detail}`, { refused, row });
  }
  return verdict(sensor, "PASS", "the chapter parses with the change and nothing else moved");
}

export interface ConsistencyFacts {
  readonly derive: DeriveFacts;
  readonly crossChapter: CrossChapterFacts;
  readonly lint: LintFacts;
}

/** The three, in the spec's order; the first failure is the one a decline names. */
export function consistencySensors(facts: ConsistencyFacts): ReadonlyArray<ConsistencyVerdict> {
  return [deriveConsistencySensor(facts.derive), crossChapterSensor(facts.crossChapter), lintSensor(facts.lint)];
}
