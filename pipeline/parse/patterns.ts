/*
 * The provenance grammar's regular expressions as sources (feature-specs/04 § 6.3): the figures' pass builds on them,
 * and so do the gate's census, the sensors and the suggest form's check of a passage. A module of its own, with
 * nothing imported, so that a client island can read a number as the pipeline does without the markdown parser.
 */

/** Verbatim ports of `CITE` and `NUM` from bible/scripts/lint_chapter.py. */
export const CITE_SOURCE = String.raw`\([^()]*(?:\d{4}|illustrative|vendor|primary|analyst|derived|open|practitioner|scenario)[^()]*\)`;
export const NUM_SOURCE = String.raw`(?<![\w./-])\d[\d,]*(?:\.\d+)?\s?(?:%|×|x|ms|s|GB|KB|MB|TB|K|M|B|pp|tokens?|USD|\$)?(?![\w/-])`;
export const SKIP_SOURCE = String.raw`(Figure|Table|Lab|Layer|Chapter|Section|ch|Part|Equation|Eq\.)\s*\d+(\.\d+)?`;
/* The linter blanks any `d.d`; the pipeline blanks only real section references (two-digit
   chapter, layer 1–9, no unit after), so 99.5% and 2.0 stay figures. */
export const SECTION_REF_SOURCE = String.raw`\b\d{2}\.[1-9]\b(?!\s?(?:%|×|ms|GB|KB|MB|TB|pp|tokens?|USD)|\s?[xsKMB](?![A-Za-z]))`;
export const MATH_SOURCE = String.raw`\$[^$]*\$`;
