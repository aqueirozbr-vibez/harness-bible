import { REPORT_WORDS_MAX, wordCount, type Report, type ReportDropRule, type ReportParagraph } from "@/lib/schemas/researcher";
import { findSecrets } from "@/lib/security/redact";
import { EMAIL, URL } from "@/lib/sensors/brief";
import { aboutOperatingEquipment } from "@/lib/sensors/scope";

/*
 * The report sensor (feature-specs/48 § 5.7; unit 69d), pure. The writer is the one call that holds a person's
 * question and text the web shaped at once, and the report is the one free prose the product writes from it, so before
 * anyone reads it code checks it paragraph by paragraph. The writer's output was parsed strictly before it gets here
 * (`WriterOutputSchema`: at most eight paragraphs, each with its sections and pages); a paragraph is then dropped by
 * the first of these rules that holds, in `REPORT_DROP_RULES`' order:
 *
 *   SECTION       it cites a section that is neither a target nor a valid finding's section;
 *   PAGE          it cites a page that is not a numbered page with a note — in its `pages` or as an `[n]` in its text,
 *                 since the page renders every `[n]` as a link to the run's page row and none may point nowhere;
 *   NO_REFERENCE  it cites nothing at all;
 *   ADDRESS       its text holds an e-mail address or a URL, by the brief sensor's own patterns: a page is cited by its
 *                 number, so no address the writer wrote is ever shown, let alone as a link;
 *   SECRET        its text holds a secret by the patterns the product redacts with;
 *   OT            its text is about operating plant equipment, by the scope sensor's one vocabulary for it
 *                 (`aboutOperatingEquipment`, which Improve's class detection reads too): the plant-equipment boundary
 *                 is a rule on the question and a sensor on the one prose written from the web;
 *   WORDS         it falls past the 600th word of the report as kept: the words are counted over the paragraphs that
 *                 passed, and the paragraph that would cross the limit is dropped with every one after it.
 *
 * What is dropped is counted by rule and never shown or stored as text. A report with nothing left is a failure: the
 * run ends FAILED · WRITER_FAILED with its pages and findings, and the counts say why.
 */

export interface ReportInput {
  /** The writer's paragraphs as the strict parse read them, in its order. */
  readonly paragraphs: ReadonlyArray<ReportParagraph>;
  /** The sections a paragraph may cite: the run's targets and the valid findings' sections. */
  readonly sections: ReadonlyArray<string>;
  /** The pages a paragraph may cite: the numbers, in the run's page list (`found.read`), of the pages whose note passed (`found.says`). */
  readonly pages: ReadonlyArray<number>;
}

export type ReportDropped = Report["dropped"];

export type ReportVerdict = { readonly ok: true; readonly report: Report } | { readonly ok: false; readonly dropped: ReportDropped };

/** An `[n]` in a paragraph's text: a page reference as the page renders it. */
const PAGE_MARKER = /\[(\d+)\]/g;

/** Every page a paragraph cites: its `pages`, and each `[n]` of its text. */
export function pagesCitedBy(paragraph: Pick<ReportParagraph, "text" | "pages">): ReadonlyArray<number> {
  return [...new Set([...paragraph.pages, ...[...paragraph.text.matchAll(PAGE_MARKER)].map((match) => Number(match[1]))])];
}

/** The first rule but WORDS that drops the paragraph, or null when it passes them; WORDS is the report's to decide, over what it kept. */
export function ruleOf(paragraph: ReportParagraph, sections: ReadonlySet<string>, pages: ReadonlySet<number>): Exclude<ReportDropRule, "WORDS"> | null {
  const cited = pagesCitedBy(paragraph);
  if (paragraph.sections.some((section) => !sections.has(section))) return "SECTION";
  if (cited.some((page) => !pages.has(page))) return "PAGE";
  if (paragraph.sections.length === 0 && cited.length === 0) return "NO_REFERENCE";
  if (EMAIL.test(paragraph.text) || URL.test(paragraph.text)) return "ADDRESS";
  if (findSecrets(paragraph.text).length > 0) return "SECRET";
  if (aboutOperatingEquipment(paragraph.text)) return "OT";
  return null;
}

export function checkReport(input: ReportInput): ReportVerdict {
  const sections = new Set(input.sections);
  const pages = new Set(input.pages);
  const kept: ReportParagraph[] = [];
  const dropped: Partial<Record<ReportDropRule, number>> = {};
  let words = 0;
  let full = false;
  for (const paragraph of input.paragraphs) {
    const length = wordCount(paragraph.text);
    let rule: ReportDropRule | null = ruleOf(paragraph, sections, pages);
    if (rule === null && (full || words + length > REPORT_WORDS_MAX)) {
      rule = "WORDS";
      full = true;
    }
    if (rule !== null) {
      dropped[rule] = (dropped[rule] ?? 0) + 1;
      continue;
    }
    words += length;
    kept.push(paragraph);
  }
  if (kept.length === 0) return { ok: false, dropped };
  return { ok: true, report: { paragraphs: kept, dropped } };
}
