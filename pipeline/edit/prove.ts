import type { BuiltChapter } from "../build";
import type { ExtractedFigure } from "../parse/figures";
import type { Span } from "../parse/sourceMap";
import type { ParsedSourceRow } from "../parse/sources";

/*
 * The proof of an edit (feature-specs/33 § 4.1, § 14): the chapter built again from the edited file must differ from the
 * chapter before only where the edit allows, as Andre decided on 2026-10-07. Figures are matched by their place in the
 * file, so an id the edit shifted is not a difference (a figure's id is its ordinal in the chapter); a label may change
 * in the paragraph the edit is in, and the standfirst with an edit in the first layer; no figure changes the row it
 * reads, except that a row added may take figures no row read before. Anything else names the row that moved.
 */

/** A splice of the chapter's file: `[from, to)` replaced by `text`. */
export interface Splice {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** What an edit is allowed to change, and what its anchor must read after it. */
export interface Expectation {
  readonly splice: Splice;
  /** The section whose text the edit is in: its markdown, HTML, words, code, references and diagrams may change. */
  readonly section: string;
  /** The paragraph of the file the edit is in, before it: its figures' labels may change. */
  readonly paragraph: Span;
  /** A figure may appear inside the text the edit wrote (a claim added, a passage reworded). */
  readonly newFigures: boolean;
  /** The figure a value was set on, and what it must read. */
  readonly figure: { readonly id: string; readonly valueText: string; readonly value: number } | null;
  /** The row edited or added, and what it must read. */
  readonly row: { readonly id: string; readonly ordinal: number; readonly added: boolean; readonly reads: Partial<Pick<ParsedSourceRow, "claim" | "citation" | "url" | "doi" | "tier" | "verifiedText">> } | null;
}

export interface Moved {
  readonly row: string;
  readonly detail: string;
  /** The change is a curator's, not a fault: a value set on a figure whose tier follows its value under a derived tag. */
  readonly manual?: true;
}

interface Placed {
  readonly figure: ExtractedFigure;
  readonly at: Span;
}

/** Each figure with its place in the file; the build's positions must have placed every one (the caller checks). */
function placed(chapter: BuiltChapter): ReadonlyArray<Placed> {
  const at = new Map((chapter.positions?.figures ?? []).map((p) => [p.id, p.at]));
  return chapter.sections.flatMap((s) => s.figures.flatMap((figure) => {
    const span = at.get(figure.id);
    return span === undefined || span === null ? [] : [{ figure, at: span }];
  }));
}

/** A section's HTML as its chips and the rest, figure ids taken out: an id the edit shifted is not a difference. */
function chipsOf(html: string): { readonly chips: ReadonlyArray<string>; readonly rest: string } {
  const chips: string[] = [];
  const rest = html.replace(/ data-figure="[^"]*"/g, "").replace(/<span class="chip [^"]*">[\s\S]*?<\/span>/g, (chip) => {
    chips.push(chip);
    return "<chip>";
  });
  return { chips, rest };
}

const ROW_ID = /^\d{2}\.9 r\d+$/;

/** What a chip names after its tier, `21.9 r1`, `ch16`, or null. */
function locatorOf(chip: string): string | null {
  return / · ([^<]*)<\/span>$/.exec(chip)?.[1] ?? null;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

const ROW_FIELDS = ["claim", "citation", "url", "doi", "tier", "tierText", "verifiedText", "fastMoving"] as const;

/** Null when the chapter after the edit differs from the chapter before only as `expect` allows; otherwise the first row that moved. */
export function prove(before: BuiltChapter, after: BuiltChapter, expect: Expectation): Moved | null {
  if (after.title !== before.title) return { row: `ch${String(before.number).padStart(2, "0")}`, detail: "the chapter's title changed" };
  const first = before.sections[0]?.id;
  if (after.standfirst !== before.standfirst && expect.section !== first) return { row: first ?? "?", detail: "the standfirst changed, by an edit outside the first layer" };

  /* sections other than the edit's: as they were, but for the ids and chip rows the figures' own checks allow */
  for (const [i, section] of before.sections.entries()) {
    const now = after.sections[i];
    if (now === undefined || now.id !== section.id || now.titleEn !== section.titleEn || now.layer !== section.layer) return { row: section.id, detail: "the chapter's sections changed" };
    if (section.id === expect.section) continue;
    if (now.markdownEn !== section.markdownEn || now.words !== section.words || now.textEn !== section.textEn) return { row: section.id, detail: "its text changed" };
    const was = chipsOf(section.htmlEn);
    const is = chipsOf(now.htmlEn);
    if (is.rest !== was.rest || is.chips.length !== was.chips.length) return { row: section.id, detail: "its rendered text changed" };
    for (const [k, chip] of was.chips.entries()) {
      /* a chip names the row its parenthetical reads; only a row added may take one that named no row */
      const took = expect.row !== null && expect.row.added && locatorOf(is.chips[k]) === expect.row.id && !ROW_ID.test(locatorOf(chip) ?? "") && is.chips[k].startsWith(chip.replace(/( · [^<]*)?<\/span>$/, ""));
      if (is.chips[k] !== chip && !took) return { row: section.id, detail: `a source chip names ${locatorOf(is.chips[k]) ?? "no row"} instead of ${locatorOf(chip) ?? "no row"}` };
    }
    if (json(now.codeBlocks) !== json(section.codeBlocks) || json(now.xrefs) !== json(section.xrefs) || json(now.mermaid.map((m) => m.definition)) !== json(section.mermaid.map((m) => m.definition))) return { row: section.id, detail: "its code, references or diagrams changed" };
  }

  /* figures, matched by their place in the file across the splice */
  const { splice } = expect;
  const shift = splice.text.length - (splice.to - splice.from);
  const written: Span = { from: splice.from, to: splice.from + splice.text.length };
  const afterAt = new Map(placed(after).map((p) => [`${String(p.at.from)}:${String(p.at.to)}`, p.figure]));
  const matched = new Set<ExtractedFigure>();
  for (const { figure, at } of placed(before)) {
    const through = at.from < splice.to && at.to > splice.from;
    const target = expect.figure !== null && expect.figure.id === figure.id;
    if (through && !target) return { row: figure.id, detail: "the edit runs through it" };
    const span = target ? written : at.to <= splice.from ? at : { from: at.from + shift, to: at.to + shift };
    const now = afterAt.get(`${String(span.from)}:${String(span.to)}`);
    /* a value the grammar does not read where it stands (`66.1` reads as a section reference) has no automatic form */
    if (now === undefined) return target ? { row: figure.id, detail: "the new value is not read as a figure where it stands", manual: true } : { row: figure.id, detail: "the figure is no longer read" };
    matched.add(now);
    const inParagraph = at.from >= expect.paragraph.from && at.to <= expect.paragraph.to;
    if (!inParagraph && now.label !== figure.label) return { row: figure.id, detail: "its label changed outside the edited paragraph" };
    if (now.tier !== figure.tier || now.scenarioParam !== figure.scenarioParam || json(now.derive) !== json(figure.derive)) {
      /* under a derived tag a number's tier is whether derive.py prints it (a scenario parameter, an unlinked figure): its value changes with the script */
      if (target) return { row: figure.id, detail: "its tier follows its value under a derived tag, so it changes with the lab's script (invariant 5)", manual: true };
      return { row: figure.id, detail: "its tier or derive link changed" };
    }
    const tookNewRow = expect.row !== null && expect.row.added && figure.sourceRowId === null && now.sourceRowId === expect.row.id;
    if (now.sourceRowId !== figure.sourceRowId && !tookNewRow) return { row: figure.id, detail: `it reads ${now.sourceRowId ?? "no row"} instead of ${figure.sourceRowId ?? "no row"}` };
    if (target) {
      if (now.valueText !== expect.figure?.valueText || now.value !== expect.figure.value || now.unit !== figure.unit) return { row: figure.id, detail: `it reads ${now.valueText}, not ${expect.figure?.valueText ?? "?"}` };
    } else if (now.valueText !== figure.valueText || now.value !== figure.value || now.unit !== figure.unit) return { row: figure.id, detail: "its value changed" };
  }
  for (const { figure, at } of placed(after)) {
    if (matched.has(figure)) continue;
    if (!(expect.newFigures && at.from >= written.from && at.to <= written.to)) return { row: figure.id, detail: "a figure the edit did not write" };
  }

  /* source rows, matched by their number */
  const sources = `${String(before.number).padStart(2, "0")}.9`;
  const rowsAfter = new Map(after.sourceRows.map((r) => [r.ordinal, r]));
  const { row: expected } = expect;
  if (after.sourceRows.length !== before.sourceRows.length + (expected?.added === true ? 1 : 0)) return { row: sources, detail: "the source rows changed in number" };
  for (const row of before.sourceRows) {
    const id = `${sources} r${String(row.ordinal)}`;
    const now = rowsAfter.get(row.ordinal);
    if (now === undefined) return { row: id, detail: "the row is no longer read" };
    const edited = expected !== null && !expected.added && expected.ordinal === row.ordinal ? expected.reads : null;
    const linked = edited !== null && ("url" in edited || "doi" in edited);
    for (const field of ROW_FIELDS) {
      /* the edited row: what the edit names is checked below; what follows from it (url and doi together, fastMoving) may change */
      if (edited !== null && (field in edited || field === "fastMoving" || (linked && (field === "url" || field === "doi")))) continue;
      if (now[field] !== row[field]) return { row: id, detail: `its ${field} changed` };
    }
    if (edited === null && now.verifiedAt.getTime() !== row.verifiedAt.getTime()) return { row: id, detail: "its verification date changed" };
  }
  if (expected !== null) {
    const now = rowsAfter.get(expected.ordinal);
    if (now === undefined) return { row: expected.id, detail: "the row is not read" };
    for (const field of ROW_FIELDS) {
      if (!(field in expected.reads) || field === "fastMoving" || field === "tierText") continue;
      const want = expected.reads[field];
      if (now[field] !== want) return { row: expected.id, detail: `its ${field} reads ${String(now[field])}, not ${String(want)}` };
    }
  }
  return null;
}
