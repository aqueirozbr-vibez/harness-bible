import { SectionIdSchema, type SectionId } from "@/lib/schemas/ids";

/*
 * What a question names (feature-specs/23 § 4): the sections, chapters and labs written in its own text. Since
 * Assistant 2.0 a conversation has no chapter, so this is the only place a question's subject is read from: the
 * unverified rule judges the chapters named here, and retrieval always includes the sections named here.
 *
 * Pure, no I/O, EN and PT. Whether an id exists in the release is the caller's check, not this function's.
 *
 * Two tiers, because a bare `37.8` may be a section or a number:
 *
 *   named   introduced by a cue word — "section 21.3", "seção 21.3", "§ 21.3", "chapter 34", "capítulo 34",
 *           "ch34", "cap. 34", "Lab 23". It counts for the unverified rule and for retrieval.
 *   bare    a section id standing alone — "In 21.3, how often…". It counts for retrieval only and never refuses,
 *           so a number that happens to look like a section of an unverified chapter costs nothing. A bare id
 *           written as a quantity ("37.8 %", "20.4–38.2%", "$37.8") is not read at all.
 *
 * Calibrated against `golden/assistant/2026.09.jsonl`: every explain question that expects an answer names the
 * section or chapter it was generated from, and all twelve unverified-chapter questions name their chapter with a
 * cue word. `references.test.ts` runs the whole set on every change.
 */

export interface QuestionReferences {
  /** Section ids introduced by a cue word, in order of appearance: "section 21.3", "seção 21.3", "§ 21.3". */
  readonly namedSections: ReadonlyArray<SectionId>;
  /** Chapter numbers introduced by a cue word: "chapter 34", "capítulo 34", "ch34", "ch. 34", "cap. 34". */
  readonly namedChapters: ReadonlyArray<number>;
  /** Lab numbers: "lab 23", "Lab 23". */
  readonly namedLabs: ReadonlyArray<number>;
  /** Section ids that stand alone in the text ("In 21.3, how often…"), without a cue word. */
  readonly bareSections: ReadonlyArray<SectionId>;
}

export const NO_REFERENCES: QuestionReferences = { namedSections: [], namedChapters: [], namedLabs: [], bareSections: [] };

const LAST_CHAPTER = 40;

/** Two digits, a dot, a layer from 1 to 9, and neither part of a longer number: not `1,021.3`, `237.60` or `21.35`. */
const SECTION = /(?<![\d.,])(\d{2})\.([1-9])(?!\d)/g;

/**
 * A bare id in a numeric setting is a number and not a section: "37.8 %", "20.4–38.2%", "$37.8", "37.8×". The golden
 * set quotes such figures inside its questions ("PagedAttention; 20.4–38.2% prior…"), and a number read as a section
 * changes what retrieval searches. An id after a cue word is a section whatever follows it.
 */
const NUMERIC_AFTER = /^(?:\s?%|[–-]\d|\s?×|x\b)/;
const NUMERIC_BEFORE = /(?:[$€]|\d[–-])$/;

/** The words that introduce a section, immediately before its id. */
const SECTION_CUE = /(?:\bsections?|\bse(?:c|ç|cç)(?:a|ã)o|\bse(?:c|ç|cç)(?:o|õ)es|§)\s*$/i;

/**
 * A chapter cue and the numbers after it: "chapter 34", "chapters 19 and 17", "capítulos 19 e 17", "ch34", "ch. 34",
 * "cap. 34". `cap` counts only with its dot, because "the cap 35 %" is a budget and not a chapter. The number is not
 * the head of a section id or of a longer figure, so "chapter 21.3" names a section and "ch 2,000" names nothing.
 * Only a plural cue takes a list: "chapter 21 and 35 retries" names chapter 21 alone.
 */
const CHAPTER = /\b(chapters?|cap[ií]tulos?|ch\.?|cap\.)\s*(\d{1,2}(?![\d%])(?![.,]\d)(?:\s*(?:,|and|e|&)\s*\d{1,2}(?![\d%])(?![.,]\d))*)/gi;

const LAB = /\blab[\s-]?(\d{1,2})(?![\d%])(?![.,]\d)/gi;

function unique<T>(values: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...new Set(values)];
}

function chapterOf(text: string): number | null {
  const chapter = Number(text);
  return Number.isInteger(chapter) && chapter >= 0 && chapter <= LAST_CHAPTER ? chapter : null;
}

/** The references a question makes to the book by number (feature-specs/23 § 4). */
export function referencesOf(question: string): QuestionReferences {
  const named: SectionId[] = [];
  const bare: SectionId[] = [];
  for (const match of question.matchAll(SECTION)) {
    if (chapterOf(match[1] ?? "") === null) continue;
    const id = SectionIdSchema.parse(match[0]);
    const before = question.slice(0, match.index);
    if (SECTION_CUE.test(before)) named.push(id);
    else if (!NUMERIC_BEFORE.test(before) && !NUMERIC_AFTER.test(question.slice(match.index + match[0].length))) bare.push(id);
  }

  const chapters: number[] = [];
  for (const match of question.matchAll(CHAPTER)) {
    const listed = (match[2] ?? "").match(/\d{1,2}/g) ?? [];
    for (const digits of /s$/i.test(match[1] ?? "") ? listed : listed.slice(0, 1)) {
      const chapter = chapterOf(digits);
      if (chapter !== null) chapters.push(chapter);
    }
  }

  const labs: number[] = [];
  for (const match of question.matchAll(LAB)) {
    const lab = chapterOf(match[1] ?? "");
    if (lab !== null) labs.push(lab);
  }

  const namedSections = unique(named);
  return {
    namedSections,
    namedChapters: unique(chapters),
    namedLabs: unique(labs),
    bareSections: unique(bare).filter((id) => !namedSections.includes(id)),
  };
}

/** Every chapter a question names with a cue word: its named sections' chapters, its chapters and its labs. */
export function namedChaptersOf(references: QuestionReferences): ReadonlyArray<number> {
  return unique([...references.namedSections.map((id) => Number(id.slice(0, 2))), ...references.namedChapters, ...references.namedLabs]);
}
