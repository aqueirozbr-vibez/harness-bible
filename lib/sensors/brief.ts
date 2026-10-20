import { BRIEF_WORDS_MAX, wordCount } from "@/lib/schemas/researcher";
import { findSecrets } from "@/lib/security/redact";

/*
 * The brief sensor (feature-specs/41 § 5.3; unit 58c), pure. The brief is the only text that crosses from the side of
 * the researcher that knows the question to the side that reads the web, so before the reader is called code checks
 * it: no secret by the patterns the product redacts with; no e-mail address, no URL, no long run of digits; at most
 * 200 words; every target one of the run's sections; and no run of five or more consecutive words of the question,
 * which is how a planner that copied the question instead of describing what to look for is caught. A failure names
 * the check and nothing of the text; the run ends FAILED · BRIEF and the planner is not asked again.
 *
 * Two readings changed for a person's research (feature-specs/48 § 5.3; unit 69b): `TARGET` holds a target to the
 * run's sections — the sections the planner was given, which for a legacy run are the sections its answer cited, so
 * the legacy reading is unchanged — and `QUESTION` holds the brief to every question the planner read, a follow-up's
 * earlier questions included, since each was the person's own words. The address patterns are exported for the
 * report sensor (lib/sensors/report.ts), so the one vocabulary for "an address" holds on both sides of the web.
 */

export const BRIEF_CHECKS = ["SECRET", "EMAIL", "URL", "DIGITS", "LENGTH", "TARGET", "QUESTION"] as const;
export type BriefCheck = (typeof BRIEF_CHECKS)[number];

/** The overlap that counts as the question itself: five consecutive words (41 § 5.3). */
export const QUESTION_RUN = 5;

/** Anything before an `@` and a host after it: the local part may be any script (`josé@…`). */
export const EMAIL = /[^\s@<>()[\]]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
/**
 * A scheme, `www.`, a host with a path, or a bare host under one of the common public suffixes (`acme.com`,
 * `intranet.acme.com.br`, `acme.io:8080`): the forms by which a brief would name an organisation or a system. A bare
 * host under another suffix (`node.js`, `v1.2`) passes, so the book's own vocabulary does not fail a run.
 */
export const URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|mil|int|io|ai|app|dev|co|br|uk|de|fr|es|it|nl|eu|us|ca|au|jp|cn|in|info|biz|me|tv|cloud|tech|site|online|xyz)(?:\.[a-z]{2})?(?::\d{2,5})?(?=[\s.,;:!?)]|$)/i;
/** Seven digits together, or nine with separators between them (a phone, a document number); a year or a figure passes. */
const LONG_DIGITS = /\d{7,}|\d(?:[ .()-]*\d){8,}/;

export interface BriefInput {
  readonly brief: string;
  readonly targets: ReadonlyArray<{ readonly section: string }>;
  /** The run's sections, the ones the planner was given: the only ones a target may name (a legacy run's are the sections its answer cited). */
  readonly sections: ReadonlyArray<string>;
  /** The question as the planner saw it. */
  readonly question: string;
  /** The earlier questions the planner read, a follow-up's (48 § 5.3); none for a first run or a legacy one. */
  readonly earlierQuestions?: ReadonlyArray<string>;
}

export type BriefVerdict = { readonly ok: true } | { readonly ok: false; readonly check: BriefCheck };

/** The words of a text as the overlap check compares them: composed (NFKC), invisible characters and soft hyphens dropped, lower-cased, punctuation dropped. */
export function wordsOf(text: string): ReadonlyArray<string> {
  return text
    .normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** Whether `text` holds `run` or more consecutive words of `source`. */
export function sharesRun(text: string, source: string, run: number = QUESTION_RUN): boolean {
  const words = wordsOf(text);
  const from = wordsOf(source);
  if (words.length < run || from.length < run) return false;
  const runs = new Set<string>();
  for (let i = 0; i + run <= from.length; i += 1) runs.add(from.slice(i, i + run).join(" "));
  for (let i = 0; i + run <= words.length; i += 1) if (runs.has(words.slice(i, i + run).join(" "))) return true;
  return false;
}

export function checkBrief(input: BriefInput): BriefVerdict {
  const { brief } = input;
  if (findSecrets(brief).length > 0) return { ok: false, check: "SECRET" };
  if (EMAIL.test(brief)) return { ok: false, check: "EMAIL" };
  if (URL.test(brief)) return { ok: false, check: "URL" };
  if (LONG_DIGITS.test(brief)) return { ok: false, check: "DIGITS" };
  if (wordCount(brief) > BRIEF_WORDS_MAX) return { ok: false, check: "LENGTH" };
  const sections = new Set(input.sections);
  if (input.targets.length === 0 || input.targets.some((target) => !sections.has(target.section))) return { ok: false, check: "TARGET" };
  if ([input.question, ...(input.earlierQuestions ?? [])].some((question) => sharesRun(brief, question))) return { ok: false, check: "QUESTION" };
  return { ok: true };
}
