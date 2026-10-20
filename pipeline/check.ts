import { figureText, rowText, sectionText } from "@/lib/improve/anchorText";

import { attachMermaid, buildChapter, type BookFiles, type BuiltChapter } from "./build";
import type { EditAnchor } from "./edit/apply";
import { ParseError } from "./parse/chapterFile";
import { bumpOf, subHeadingsOf, type Bump, type VersionInput } from "./parse/versions";
import type { ChapterReport } from "./report";
import { treeHash } from "./renderHash";

/*
 * The chapter's check, the pipeline's half (feature-specs/37 § 4.4 part 1; unit 54b), and an anchor read again from the
 * book's files (§ 4.1 step 1). Pure: it takes the book's files as the content pipeline reads them (`loadBook`), from
 * wherever a merge wrote a ref's tree out, and touches no disk, repository or database.
 *
 * The dry run builds every chapter of the tree as ingestion builds it, its diagrams checked against the reader's
 * vocabulary with no renderer, and fails on a chapter that does not parse and on a derived figure the change unlinked:
 * a figure whose text no longer matches its derive link becomes one. The book's own unlinked figures — four hundred
 * and more in 2026.09, the pipeline's work list — are not the change's, so the changed chapter is held to `main`'s
 * count in each section. The render hash of a release depends on the id the merge gives it (D1), so the check keeps
 * each chapter's content hash, from which 54c computes the release's for that id and compares it with ingestion's.
 */

const BUILD = { locale: "en", previous: new Map() } as const;

type Unlinked = ChapterReport["unlinked"][number];

/** A chapter's file among the book's files, by its number. */
function fileOf(book: BookFiles, chapterNumber: number): BookFiles["chapters"][number] | null {
  return book.chapters.find((file) => Number(/^ch(\d{2})-/.exec(file.fileName)?.[1]) === chapterNumber) ?? null;
}

/** The chapter's file as the repository names it: `book/part3/ch36-….md`; null when the book has none. */
export function chapterPathOf(book: BookFiles, chapterNumber: number): string | null {
  const file = fileOf(book, chapterNumber);
  return file === null ? null : `book/${file.part}/${file.fileName}`;
}

/** The chapter's lab folder as the repository names it, `labs/ch36-…`; null when it has no lab. */
export function labPathOf(book: BookFiles, chapterNumber: number): string | null {
  const lab = book.labs.get(chapterNumber);
  return lab === undefined ? null : `labs/${lab.folder}`;
}

/** The chapter built as ingestion builds it, or null when the book has none or it does not parse. */
function builtOf(book: BookFiles, chapterNumber: number): BuiltChapter | null {
  const file = fileOf(book, chapterNumber);
  if (file === null) return null;
  try {
    return buildChapter(file, book, BUILD);
  } catch (error) {
    if (error instanceof ParseError) return null;
    throw error;
  }
}

/** What the anchor says in a built chapter, composed as the draft recorded it; null when the chapter has no such anchor. */
export function anchorTextOf(chapter: BuiltChapter, anchor: EditAnchor): string | null {
  if (anchor.kind === "SECTION") {
    const section = chapter.sections.find((candidate) => candidate.id === anchor.id);
    return section === undefined ? null : sectionText(section);
  }
  if (anchor.kind === "FIGURE") {
    const figure = chapter.sections.flatMap((section) => section.figures).find((candidate) => candidate.id === anchor.id);
    return figure === undefined ? null : figureText(figure);
  }
  const ordinal = Number(/ r(\d+)$/.exec(anchor.id)?.[1]);
  const row = chapter.sourceRows.find((candidate) => candidate.ordinal === ordinal);
  return row === undefined ? null : rowText(row);
}

/** The file a derived figure's link names, as the repository does (`labs/ch21-…/derive.py`; invariant 5); null when the figure is no linked derived figure. */
export function deriveFileOf(book: BookFiles, chapterNumber: number, figureId: string): string | null {
  const figure = builtOf(book, chapterNumber)?.sections.flatMap((section) => section.figures).find((candidate) => candidate.id === figureId);
  const lab = book.labs.get(chapterNumber);
  return figure?.derive == null || lab === undefined ? null : `labs/${lab.folder}/${figure.derive.filePath}`;
}

/** What the anchor says in the book's files; null when its chapter is not there, does not parse, or has no such anchor. */
export function anchorTextAt(book: BookFiles, chapterNumber: number, anchor: EditAnchor): string | null {
  const chapter = builtOf(book, chapterNumber);
  return chapter === null ? null : anchorTextOf(chapter, anchor);
}

function versionOf(chapter: BuiltChapter): VersionInput {
  return { title: chapter.title, layerTitles: chapter.sections.map((section) => section.titleEn), subHeadings: chapter.sections.flatMap((section) => subHeadingsOf(section.markdownEn)), contentHash: chapter.contentHash };
}

/**
 * The derived figures the change unlinked: in each section, those past the count `main` has there, named by their
 * label and value where those are new. A label the edit moved leaves the count as it was, and is no new figure.
 */
function newlyUnlinked(before: ReadonlyArray<Unlinked>, after: ReadonlyArray<Unlinked>): ReadonlyArray<Unlinked> {
  const keyOf = (figure: Unlinked): string => `${figure.section}|${figure.label}|${figure.valueText}`;
  const known = new Set(before.map(keyOf));
  const unlinked: Unlinked[] = [];
  for (const section of new Set(after.map((figure) => figure.section))) {
    const had = before.filter((figure) => figure.section === section).length;
    const now = after.filter((figure) => figure.section === section);
    if (now.length <= had) continue;
    const fresh = now.filter((figure) => !known.has(keyOf(figure)));
    unlinked.push(...(fresh.length > 0 ? fresh : now.slice(had)));
  }
  return unlinked;
}

export const DRY_RUN_FAILURES = ["does-not-parse", "chapter-missing", "unlinked-derived", "unchanged"] as const;
export type DryRunFailure = (typeof DRY_RUN_FAILURES)[number];

/** The book's suite as the tree's own results state it, which is what a release of the tree holds (`Lab.ciVerdict`). */
export interface Suite {
  readonly reproduced: number;
  readonly total: number;
  /** The chapters whose lab did not reproduce, or has no verdict. */
  readonly failing: ReadonlyArray<number>;
}

export interface DryRun {
  /** The pipeline's half (`MERGE_CHECKS`): the tree builds, and the change unlinked no derived figure. */
  readonly lint: "PASS" | "FAIL";
  readonly failure: { readonly reason: DryRunFailure; readonly detail: string } | null;
  /** Each chapter's content hash, in chapter order; empty when the tree does not build. */
  readonly chapters: ReadonlyArray<{ readonly number: number; readonly hash: string }>;
  /** The tree's hash, as ingestion computes a release's `gitSha` today. */
  readonly treeHash: string;
  /** The changed chapter's bump against `main` by the book's rule; null when its content did not change, or `main` does not build it. */
  readonly bump: Bump | null;
  /** The changed chapter's lab, which the second half runs; null when it has none, or none with a derive script. */
  readonly lab: { readonly id: string; readonly folder: string } | null;
  readonly suite: Suite;
}

function suiteOf(book: BookFiles): Suite {
  const labs = [...book.labs.entries()].sort(([a], [b]) => a - b);
  const failing = labs.filter(([, lab]) => lab.ciVerdict !== "REPRODUCED").map(([number]) => number);
  return { reproduced: labs.length - failing.length, total: labs.length, failing };
}

/** The chapter's lab when it has a derive script to run (§ 4.4 part 2): a lab without one prints no derived figure, and has nothing to reproduce. */
export function derivedLabOf(book: BookFiles, chapterNumber: number): { readonly id: string; readonly folder: string } | null {
  const lab = book.labs.get(chapterNumber);
  return lab === undefined || !lab.files.some((file) => file.path === "derive.py") ? null : { id: lab.id, folder: lab.folder };
}

/** What a lab's run printed against what the branch states (§ 4.4 part 2): the derived figures it no longer prints as the branch does, and the results that changed. */
export interface Reproduction {
  readonly figures: ReadonlyArray<{ readonly id: string; readonly label: string; readonly valueText: string; readonly key: string }>;
  readonly keys: ReadonlyArray<{ readonly key: string; readonly stated: unknown; readonly printed: unknown }>;
}

/** Two results as one: equal JSON, or numbers within a part in a billion (a script run again on another machine). */
function sameResult(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b || Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameResult(value, b[index]));
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A lab's fresh results held to the chapter the branch states (§ 4.4 part 2): the chapter built again with the printed
 * results in place of the branch's own, by the figure pass's own matching; a derived figure linked before and not now,
 * or to another key, is one the lab no longer reproduces. The results whose value moved are named beside them, the
 * run's `timestamp` apart.
 */
export function reproductionOf(branch: BookFiles, chapterNumber: number, printed: Readonly<Record<string, unknown>>): Reproduction {
  const lab = branch.labs.get(chapterNumber);
  const stated = builtOf(branch, chapterNumber);
  if (lab === undefined || stated === null) return { figures: [], keys: [] };
  const rerun = builtOf({ ...branch, labs: new Map([...branch.labs, [chapterNumber, { ...lab, derived: { ...printed } }]]) }, chapterNumber);
  const derivedOf = (chapter: BuiltChapter | null): ReadonlyMap<string, string> =>
    new Map((chapter?.sections ?? []).flatMap((section) => section.figures).flatMap((figure) => (figure.derive === null ? [] : [[figure.id, figure.derive.key] as const])));
  const now = derivedOf(rerun);
  const figures = stated.sections
    .flatMap((section) => section.figures)
    .flatMap((figure) => (figure.derive === null || now.get(figure.id) === figure.derive.key ? [] : [{ id: figure.id, label: figure.label, valueText: figure.valueText, key: figure.derive.key }]));
  const keys = [...new Set([...Object.keys(lab.derived), ...Object.keys(printed)])]
    .filter((key) => key !== "timestamp" && !sameResult(lab.derived[key], printed[key]))
    .sort()
    .map((key) => ({ key, stated: lab.derived[key] ?? null, printed: printed[key] ?? null }));
  return { figures, keys };
}

/** The dry run of § 4.4 part 1 over a branch's tree, its changed chapter held to `main`'s. */
export async function dryRun(branch: BookFiles, main: BookFiles, chapterNumber: number): Promise<DryRun> {
  const base = { treeHash: treeHash(branch.allFiles), lab: derivedLabOf(branch, chapterNumber), suite: suiteOf(branch) };
  const failed = (reason: DryRunFailure, detail: string): DryRun => ({ ...base, lint: "FAIL", failure: { reason, detail }, chapters: [], bump: null });

  const chapters: BuiltChapter[] = [];
  for (const file of branch.chapters) {
    try {
      chapters.push(buildChapter(file, branch, BUILD));
    } catch (error) {
      if (error instanceof ParseError) return failed("does-not-parse", `${file.fileName}: ${error.message}`);
      throw error;
    }
  }
  try {
    await attachMermaid(chapters, null);
  } catch (error) {
    if (error instanceof ParseError) return failed("does-not-parse", error.message);
    throw error;
  }
  const changed = chapters.find((chapter) => chapter.number === chapterNumber);
  if (changed === undefined) return failed("chapter-missing", `the tree has no chapter ${String(chapterNumber)}`);
  const before = builtOf(main, chapterNumber);
  const unlinked = newlyUnlinked(before?.report.unlinked ?? [], changed.report.unlinked);
  if (unlinked.length > 0) return failed("unlinked-derived", unlinked.map((figure) => `${figure.section} "${figure.label}" ${figure.valueText}`).join("; "));
  /* A branch whose chapter reads as main's has nothing to merge and no version to bump (unit 54's review): a check that passed it would merge nothing, again and again. */
  if (before !== null && before.contentHash === changed.contentHash) return failed("unchanged", `chapter ${String(chapterNumber)} reads on the branch as it reads on main: the change leaves it as it is`);
  return {
    ...base,
    lint: "PASS",
    failure: null,
    chapters: chapters.map((chapter) => ({ number: chapter.number, hash: chapter.contentHash })).sort((a, b) => a.number - b.number),
    bump: before === null ? null : bumpOf(versionOf(before), versionOf(changed)),
  };
}
