import type { SourceTier } from "@/lib/schemas/domain";
import type { AnchorKind, Part } from "@/lib/schemas/improve";
import type { Reading } from "@/lib/sensors/consistency";

/*
 * Where an anchor is read besides itself: the three rules of the cross-chapter sensor (feature-specs/33 § 4.2), fixed
 * from what each found on release 2026.09 (§ 15). A source row is read by the figures bound to it (rule 1: 124 of 407
 * rows, 41 of them from two sections or more). A figure is the same figure as one in another chapter when either's
 * own tier parenthetical names the other's chapter and both print the same value (rule 2: 11 such pairs; the same id
 * elsewhere finds none, since an id carries its chapter, and the same value and label across chapters, 43 groups, is
 * mostly chance, `2%`). A section or a row is read by the sections that refer to it (rule 3: 147 sections referred
 * to, 42 references from another chapter; no row is referred to; a mention of a whole chapter, 1,175 of them, is not
 * a reading of any anchor in it). Pure: the step's activity reads the release's rows and calls these.
 */

export interface ReleaseFigure {
  readonly id: string;
  readonly chapter: number;
  readonly section: string;
  readonly part: Part;
  readonly valueText: string;
  readonly tier: SourceTier;
  /** The row it reads (`21.9 r9`), or null. */
  readonly sourceRow: string | null;
  /** The chapters its own tier parenthetical names (`(scenario, ch16)` names 16), as `chipChapters` reads them. */
  readonly names: ReadonlyArray<number>;
}

/** A cross-reference: the section it is in, and the section (`21.3`) or row (`21.9 r4`) it points at. */
export interface ReleaseReference {
  readonly from: string;
  readonly part: Part;
  readonly target: string;
}

/**
 * The chapters each figure's chip names, from a section's rendered HTML: the chip that follows a figure in its own
 * sentence is the parenthetical that gave it its tier (04 § 6.3), whatever figures stand between (`17:42` is two). A
 * figure whose sentence has no chip after it took its tier from elsewhere, and names nothing here.
 */
export function chipChapters(html: string): ReadonlyMap<string, ReadonlyArray<number>> {
  const found = new Map<string, ReadonlyArray<number>>();
  for (const m of html.matchAll(/data-figure="([^"]+)"/g)) {
    if (found.has(m[1])) continue;
    const rest = html.slice((m.index ?? 0) + m[0].length);
    const chip = /<span class="chip [^"]*">([\s\S]*?)<\/span>/.exec(rest);
    const before = chip === null ? "" : rest.slice(0, chip.index);
    /* a sentence ends where the figure grammar ends one, and a paragraph at its close */
    const ownSentence = chip !== null && !before.includes("</p>") && !/[.!?;:]\s/.test(before.replace(/<[^>]*>/g, ""));
    found.set(m[1], ownSentence ? [...chip[1].matchAll(/\bch(\d{2})\b/g)].map((x) => Number(x[1])) : []);
  }
  return found;
}

/** Rule 1: the sections whose figures read the row, one reading for each section. */
export function rowReadings(row: string, figures: ReadonlyArray<ReleaseFigure>): ReadonlyArray<Reading> {
  const bySection = new Map<string, ReleaseFigure>();
  for (const figure of figures) if (figure.sourceRow === row && !bySection.has(figure.section)) bySection.set(figure.section, figure);
  return [...bySection.values()].map((f) => ({ anchor: f.id, section: f.section, part: f.part, rule: "row", settable: true }));
}

/**
 * Rule 2: the figure printed in another chapter — one names the other's chapter, both print the same value, and the
 * chapter named prints it once: where it prints it more often (six `8`s in chapter 4) which is meant cannot be read,
 * and none is counted. A derived reading cannot be set to a value.
 */
export function sharedFigureReadings(figure: ReleaseFigure, figures: ReadonlyArray<ReleaseFigure>): ReadonlyArray<Reading> {
  const once = (chapter: number): boolean => figures.filter((f) => f.chapter === chapter && f.valueText === figure.valueText).length === 1;
  return figures
    .filter((other) => other.chapter !== figure.chapter && other.valueText === figure.valueText && ((figure.names.includes(other.chapter) && once(other.chapter)) || (other.names.includes(figure.chapter) && once(figure.chapter))))
    .map((other) => ({ anchor: other.id, section: other.section, part: other.part, rule: "figure", settable: other.tier !== "DERIVED" }));
}

/** Rule 3: the other sections that refer to the anchor, one reading for each. */
export function referenceReadings(target: string, home: string, references: ReadonlyArray<ReleaseReference>): ReadonlyArray<Reading> {
  const bySection = new Map<string, ReleaseReference>();
  for (const r of references) if (r.target === target && r.from !== home && !bySection.has(r.from)) bySection.set(r.from, r);
  return [...bySection.values()].map((r) => ({ anchor: r.from, section: r.from, part: r.part, rule: "reference", settable: true }));
}

/** Every reading of an anchor under the three rules: a row by its figures and references, a figure by its other chapter, a section by its references. */
export function readingsOf(anchor: { readonly kind: AnchorKind; readonly id: string }, figures: ReadonlyArray<ReleaseFigure>, references: ReadonlyArray<ReleaseReference>): ReadonlyArray<Reading> {
  if (anchor.kind === "SOURCE_ROW") return [...rowReadings(anchor.id, figures), ...referenceReadings(anchor.id, `${anchor.id.slice(0, 2)}.9`, references)];
  if (anchor.kind === "SECTION") return referenceReadings(anchor.id, anchor.id, references);
  const figure = figures.find((f) => f.id === anchor.id);
  return figure === undefined ? [] : sharedFigureReadings(figure, figures);
}
