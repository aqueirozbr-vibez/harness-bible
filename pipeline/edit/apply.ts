import { occurrences } from "@/lib/improve/passage";
import { printedValue } from "@/lib/improve/value";
import { bodyVocabularyViolations } from "@/lib/schemas/chapter";
import type { AnchorKind, Proposal } from "@/lib/schemas/improve";

import { buildChapter, type BookFiles, type BuiltChapter, type ChapterPositions } from "../build";
import { ParseError } from "../parse/chapterFile";
import { isParameter, parseValue } from "../parse/figures";
import { deriveSource } from "../parse/lab";
import { liftFences, plainText } from "../parse/markdown";
import type { Span } from "../parse/sourceMap";
import { subHeadingsOf } from "../parse/versions";
import { prove, type Expectation, type Splice } from "./prove";

/*
 * A proposal applied to the book's source text, proved by re-parsing (feature-specs/33 § 4.1, § 14). The anchor is
 * located by the pipeline's own positions (§ 13), never by a search for its words; the change is one splice in the
 * chapter's file; the chapter is built again and its rows compared with the rows before (prove.ts). Pure: it reads and
 * returns text, and never touches a disk or a repository. What the file has no place for, or a function cannot do, is
 * refused as `manual`, for a curator's hand (spec 37 § 4.3) — Andre's answers of 2026-10-07.
 */

export const REFUSALS = ["manual", "unexpected-change", "does-not-parse", "not-found"] as const;
export type Refusal = (typeof REFUSALS)[number];

/** The anchor by its kind and id: a section `21.3`, a figure `F-21-07`, a source row `21.9 r4`. */
export interface EditAnchor {
  readonly kind: AnchorKind;
  readonly id: string;
}

/** A file the edit changed, by its path in the book's repository, whole before and after. */
export interface Touched {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

export type Applied = { readonly files: BookFiles; readonly touched: ReadonlyArray<Touched> } | { readonly refused: Refusal; readonly row: string; readonly detail: string };

/** `on`: the day a row is verified — the decision's day in a merge (37 § 4.1 step 2, which it wins over a proposal's `verifiedOn`), the run's in the lint sensor. A row added needs it. */
export interface ApplyOptions {
  readonly on?: Date;
}

type Planned = { readonly expect: Expectation } | { readonly refused: Refusal; readonly row: string; readonly detail: string };

function refuse(refused: Refusal, row: string, detail: string): { readonly refused: Refusal; readonly row: string; readonly detail: string } {
  return { refused, row, detail };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A Verified cell as the book writes one: `Sep 2026`. */
function monthOf(day: Date): string {
  return `${MONTHS[day.getUTCMonth()]} ${String(day.getUTCFullYear())}`;
}

function chapterOf(anchor: EditAnchor): number | null {
  const m = anchor.kind === "FIGURE" ? /^F-(\d{2})-\d+$/.exec(anchor.id) : anchor.kind === "SOURCE_ROW" ? /^(\d{2})\.9 r\d+$/.exec(anchor.id) : /^(\d{2})\.\d$/.exec(anchor.id);
  return m === null ? null : Number(m[1]);
}

/** The blank-line block of the file around `[from, to)`, inside the section's body: the paragraph an edit is in. */
function paragraphAround(text: string, body: Span, from: number, to: number): Span {
  const start = text.lastIndexOf("\n\n", from - 1);
  const end = text.indexOf("\n\n", to);
  return { from: Math.max(body.from, start < 0 ? body.from : start + 2), to: Math.min(body.to, end < 0 ? body.to : end) };
}

/** The line of the file that holds offset `at`. */
function lineAt(text: string, at: number): string {
  const end = text.indexOf("\n", at);
  return text.slice(text.lastIndexOf("\n", at - 1) + 1, end < 0 ? text.length : end);
}

const isTableLine = (line: string): boolean => line.trimStart().startsWith("|");

/** A link the Link cell reads back as written: the parser drops a bare URL's last `)`, `.`, `,`, `;` or `]`. */
function linkUnsafe(link: string | undefined): boolean {
  return link !== undefined && /[).,;\]]$/.test(link);
}

/** A table cell cannot hold a pipe or a line break: the row would be read as other cells. */
function cellUnsafe(values: ReadonlyArray<string | undefined>): boolean {
  return values.some((v) => v !== undefined && /[|\r\n]/.test(v));
}

function plan(text: string, chapter: BuiltChapter, positions: ChapterPositions, anchor: EditAnchor, proposal: Proposal, options: ApplyOptions): Planned {
  const pad = String(chapter.number).padStart(2, "0");
  const sources = `${pad}.9`;
  const sectionAt = (id: string) => positions.sections.find((s) => s.id === id) ?? null;
  const expectFor = (splice: Splice, section: string, paragraph: Span, rest: Partial<Pick<Expectation, "newFigures" | "figure" | "row">> = {}): Planned => ({ expect: { splice, section, paragraph, newFigures: rest.newFigures ?? false, figure: rest.figure ?? null, row: rest.row ?? null } });

  switch (proposal.kind) {
    case "RESTRUCTURE":
      return refuse("manual", anchor.id, "a restructure is made by hand (spec 37 § 4.3)");

    case "EDIT_TEXT":
    case "ADD_CLAIM": {
      const body = anchor.kind === "SECTION" ? (sectionAt(anchor.id)?.body ?? null) : null;
      if (body === null) return refuse("not-found", anchor.id, "no such section in the file");
      if (anchor.id === sources) return refuse("manual", anchor.id, "the Sources table is changed by a row's edit or a row added");
      const markdown = text.slice(body.from, body.to);
      if (proposal.kind === "EDIT_TEXT") {
        if (occurrences(markdown, proposal.before) !== 1) return refuse("not-found", anchor.id, "the passage is not in the section once");
        const from = body.from + markdown.indexOf(proposal.before);
        const to = from + proposal.before.length;
        if (isTableLine(lineAt(text, from)) && /[|\r\n]/.test(proposal.after)) return refuse("manual", anchor.id, "a table cell cannot hold a pipe or a line break");
        return expectFor({ from, to, text: proposal.after }, anchor.id, paragraphAround(text, body, from, to), { newFigures: true });
      }
      if (/[\r\n]/.test(proposal.text)) return refuse("manual", anchor.id, "a claim is one paragraph's text");
      if (proposal.placeAfter === "end") {
        /* not a heading, a list, a quote, a table, a fence, a link definition, or an italic line a fence above would take for its caption */
        if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|\[[^\]]*\]:)/.test(proposal.text) || /^[*_][^*_].*[*_]$/.test(proposal.text.trim())) return refuse("manual", anchor.id, "a claim placed at the end must read as a paragraph");
        return expectFor({ from: body.to, to: body.to, text: `\n\n${proposal.text}` }, anchor.id, { from: body.to, to: body.to }, { newFigures: true });
      }
      if (occurrences(markdown, proposal.placeAfter) !== 1) return refuse("not-found", anchor.id, "the passage to place the claim after is not in the section once");
      if (!/[.!?]["'”’)*_]*$/.test(proposal.placeAfter.trimEnd())) return refuse("manual", anchor.id, "the claim would be placed in the middle of a sentence");
      let at = body.from + markdown.indexOf(proposal.placeAfter) + proposal.placeAfter.trimEnd().length;
      /* a reader quotes what they see: step over the closing marks the file has after it, a bold run-in's `**`, a quote, a parenthesis */
      while (at < body.to && /[*_"”’)]/.test(text[at])) at += 1;
      if (at < body.to && !/\s/.test(text[at])) return refuse("manual", anchor.id, "the passage ends inside a word, inline code or a link");
      if (isTableLine(lineAt(text, at))) return refuse("manual", anchor.id, "a claim joins a paragraph, not a table row");
      return expectFor({ from: at, to: at, text: ` ${proposal.text}` }, anchor.id, paragraphAround(text, body, at, at), { newFigures: true });
    }

    case "SET_VALUE": {
      const figure = anchor.kind === "FIGURE" ? (chapter.sections.flatMap((s) => s.figures).find((f) => f.id === anchor.id) ?? null) : null;
      const at = positions.figures.find((f) => f.id === anchor.id)?.at ?? null;
      const section = chapter.sections.find((s) => s.figures.some((f) => f.id === anchor.id))?.id ?? null;
      const body = section === null ? null : (sectionAt(section)?.body ?? null);
      if (figure === null || section === null || body === null) return refuse("not-found", anchor.id, "no such figure in the file");
      if (figure.tier === "DERIVED") return refuse("manual", anchor.id, "a derived figure changes with its script (invariant 5)");
      const derive = chapter.lab === null ? null : deriveSource(chapter.lab);
      if (figure.scenarioParam && derive !== null && isParameter(figure.value, figure.unit, derive)) return refuse("manual", anchor.id, "a scenario parameter of the lab changes with its script (invariant 5)");
      if (figure.tier === "OPEN" && chapter.report.unlinked.some((u) => u.section === section && u.label === figure.label && u.valueText === figure.valueText)) return refuse("manual", anchor.id, "a derived figure the lab does not print changes with its script (invariant 5)");
      if (at === null) return refuse("manual", anchor.id, "the figure has no proven place in the file");
      /* the grammar can read a piece of a longer number: `128` of `128,000-token`, `000` of `4,000` */
      if (/\d$|\d[.,]$/.test(text.slice(Math.max(0, at.from - 2), at.from)) || /^\d|^[.,]\d/.test(text.slice(at.to, at.to + 2))) return refuse("manual", anchor.id, "the figure is part of a longer number");
      if (proposal.unit !== parseValue(figure.valueText).unit) return refuse("manual", anchor.id, "a unit changed is a change of wording");
      const valueText = printedValue(figure.valueText, proposal.after);
      if (valueText === null) return refuse("manual", anchor.id, "the value cannot be printed as the figure is");
      return expectFor({ from: at.from, to: at.to, text: valueText }, section, paragraphAround(text, body, at.from, at.to), { figure: { id: figure.id, valueText, value: Number(proposal.after) } });
    }

    case "EDIT_ROW": {
      const row = anchor.kind === "SOURCE_ROW" ? (positions.sourceRows.find((r) => r.id === anchor.id) ?? null) : null;
      const ordinal = Number(/ r(\d+)$/.exec(anchor.id)?.[1]);
      if (row === null) return refuse("not-found", anchor.id, "no such row in the file");
      if (proposal.value !== undefined) return refuse("manual", anchor.id, "the Sources table has no column for a row's value");
      if (cellUnsafe([proposal.claim, proposal.citation, proposal.url, proposal.doi])) return refuse("manual", anchor.id, "a table cell cannot hold a pipe or a line break");
      const link = proposal.url ?? (proposal.doi === undefined ? undefined : `https://doi.org/${proposal.doi}`);
      if (proposal.url !== undefined && proposal.doi !== undefined && !proposal.url.endsWith(proposal.doi)) return refuse("manual", anchor.id, "a row has one link: a URL and another DOI do not fit it");
      if (link !== undefined && row.cells.length < 6) return refuse("manual", anchor.id, "the table has no Link column");
      if (linkUnsafe(link)) return refuse("manual", anchor.id, "the Link cell drops a URL's last `)`, `.`, `,`, `;` or `]`");
      /* the decision's day wins: the merge sets the row's verification date to it (37 § 4.1 step 2) */
      const verified = options.on !== undefined ? monthOf(options.on) : proposal.verifiedOn === undefined ? undefined : monthOf(new Date(`${proposal.verifiedOn}T00:00:00Z`));
      /* cells written from the last to the first, so the earlier spans hold */
      const writes: Array<[number, string | undefined]> = [[5, link], [4, verified], [2, proposal.citation], [1, proposal.claim]];
      let line = text.slice(row.line.from, row.line.to);
      for (const [cell, value] of writes) {
        if (value === undefined) continue;
        const span = row.cells[cell];
        line = line.slice(0, span.from - row.line.from) + value + line.slice(span.to - row.line.from);
      }
      const reads: NonNullable<Expectation["row"]>["reads"] = {
        ...(proposal.claim === undefined ? {} : { claim: plainText(proposal.claim) }),
        ...(proposal.citation === undefined ? {} : { citation: plainText(proposal.citation) }),
        ...(link === undefined ? {} : { url: link }),
        ...(proposal.doi === undefined ? {} : { doi: proposal.doi }),
        ...(verified === undefined ? {} : { verifiedText: verified }),
      };
      return expectFor({ from: row.line.from, to: row.line.to, text: line }, sources, row.line, { row: { id: anchor.id, ordinal, added: false, reads } });
    }

    case "ADD_ROW": {
      if (anchor.kind !== "SECTION" || sectionAt(anchor.id) === null) return refuse("not-found", anchor.id, "no such section in the file");
      const last = positions.sourceRows.at(-1);
      if (last === undefined) return refuse("manual", sources, "the chapter has no Sources row to add one after");
      if (typeof proposal.tier !== "string") return refuse("manual", sources, "a new tier is the curator's (30 § 4.2 rule 4)");
      if (options.on === undefined) return refuse("manual", sources, "a row added needs the day it was verified");
      if (cellUnsafe([proposal.claim, proposal.citation, proposal.url, proposal.doi])) return refuse("manual", sources, "a table cell cannot hold a pipe or a line break");
      if (proposal.url !== undefined && proposal.doi !== undefined && !proposal.url.endsWith(proposal.doi)) return refuse("manual", sources, "a row has one link: a URL and another DOI do not fit it");
      const link = proposal.url ?? (proposal.doi === undefined ? undefined : `https://doi.org/${proposal.doi}`);
      if (link !== undefined && last.cells.length < 6) return refuse("manual", sources, "the table has no Link column");
      if (linkUnsafe(link)) return refuse("manual", sources, "the Link cell drops a URL's last `)`, `.`, `,`, `;` or `]`");
      const ordinal = Math.max(...chapter.sourceRows.map((r) => r.ordinal)) + 1;
      const cells = [String(ordinal), proposal.claim, proposal.citation, proposal.tier.toLowerCase(), monthOf(options.on), ...(last.cells.length >= 6 ? [link ?? "—"] : [])];
      const id = `${sources} r${String(ordinal)}`;
      return expectFor({ from: last.line.to, to: last.line.to, text: `\n| ${cells.join(" | ")} |` }, sources, last.line, {
        row: { id, ordinal, added: true, reads: { claim: plainText(proposal.claim), citation: plainText(proposal.citation), tier: proposal.tier, verifiedText: monthOf(options.on), ...(link === undefined ? {} : { url: link }), ...(proposal.doi === undefined ? {} : { doi: proposal.doi }) } },
      });
    }
  }
}

function build(file: BookFiles["chapters"][number], book: BookFiles): BuiltChapter {
  return buildChapter(file, book, { locale: "en", previous: new Map(), positions: true });
}

/** The first figure the build could not place in the file, if any: an edit cannot be proved over it. */
function unplaced(chapter: BuiltChapter): string | null {
  return chapter.positions?.figures.find((f) => f.at === null)?.id ?? null;
}

/**
 * The proposal applied to the chapter's file among the book's files, as the content pipeline reads them (`loadBook`),
 * with the files it touched; or the refusal, naming the row and why.
 */
export function applyProposal(files: BookFiles, anchor: EditAnchor, proposal: Proposal, options: ApplyOptions = {}): Applied {
  const number = chapterOf(anchor);
  const file = number === null ? undefined : files.chapters.find((c) => Number(/^ch(\d{2})-/.exec(c.fileName)?.[1]) === number);
  if (file === undefined) return refuse("not-found", anchor.id, "no chapter file for the anchor");
  const path = `book/${file.part}/${file.fileName}`;

  let before: BuiltChapter;
  try {
    before = build(file, files);
  } catch (error) {
    if (error instanceof ParseError) return refuse("does-not-parse", anchor.id, `the chapter does not parse before the edit: ${error.message}`);
    throw error;
  }
  const positions = before.positions;
  if (positions === null) throw new Error("the build returned no positions");
  const planned = plan(file.text, before, positions, anchor, proposal, options);
  if ("refused" in planned) return planned;
  const lost = unplaced(before);
  if (lost !== null) return refuse("manual", lost, "a figure of the chapter has no proven place in the file, so the edit cannot be proved");

  const { splice } = planned.expect;
  const text = file.text.slice(0, splice.from) + splice.text + file.text.slice(splice.to);
  const edited = { ...file, text };
  const book: BookFiles = { ...files, chapters: files.chapters.map((c) => (c === file ? edited : c)), allFiles: files.allFiles.map((f) => (f.path === path ? { ...f, content: text } : f)) };
  let after: BuiltChapter;
  try {
    after = build(edited, book);
  } catch (error) {
    if (error instanceof ParseError) return refuse("does-not-parse", anchor.id, error.message);
    throw error;
  }
  for (const section of after.sections) {
    const violations = bodyVocabularyViolations(section.htmlEn);
    if (violations.length > 0) return refuse("does-not-parse", section.id, `renders outside the reader vocabulary: ${violations.join(", ")}`);
  }
  const lostAfter = unplaced(after);
  if (lostAfter !== null) return refuse("manual", lostAfter, "a figure of the edited chapter has no proven place in the file, so the edit cannot be proved");
  /* code, a diagram, a caption and a sub-heading are not prose: an edit that reaches one is made by hand */
  const was = before.sections.find((s) => s.id === planned.expect.section)?.markdownEn ?? "";
  const is = after.sections.find((s) => s.id === planned.expect.section)?.markdownEn ?? "";
  const shapeOf = (markdown: string): string => JSON.stringify([liftFences(markdown).fences.map((f) => [f.lang, f.text, f.caption]), subHeadingsOf(markdown)]);
  if (shapeOf(was) !== shapeOf(is)) return refuse("manual", planned.expect.section, "the edit reaches code, a diagram, a caption or a sub-heading, which are changed by hand");
  const moved = prove(before, after, planned.expect);
  if (moved !== null) return refuse(moved.manual === true ? "manual" : "unexpected-change", moved.row, moved.detail);
  return { files: book, touched: [{ path, before: file.text, after: text }] };
}
