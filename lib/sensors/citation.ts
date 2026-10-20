import type { ResolvedClaim, SensorVerdict } from "@/lib/schemas/assistant";
import { NO_COVER, type Locale } from "@/lib/schemas/assistant";
import type { FigureId, SectionId } from "@/lib/schemas/ids";
import { quantitiesIn } from "@/lib/sensors/numbers";

/*
 * The citation sensor (feature-specs/13 § 7.1), pure. It answers one question per claim: is this sentence
 * actually supported by the place it cites? Three checks, in the order they are cheap:
 *
 *   the section was retrieved      — a claim citing a page the model was never shown is not a citation
 *   the figure is that section's,  — and the claim quotes its value **as the release prints it**
 *   or, with no figure, the claim shares a content term with the section's own text
 *
 * The third is deliberately coarse: it catches a sentence about a different subject, not a sentence that is subtly
 * wrong. The grader (§ 7.3) is the fine check, and the two are meant to be read together.
 *
 * A claim with no figure id may still carry a number, on two conditions (revised 2026-10-03 from a real lab answer
 * that lost three claims of eight: one for the name `Lab 21`, one for `300 tasks` quoted from the README, one for the
 * run's date). The number is not one of the cited section's figures — those carry their id, rule 3 — and the cited
 * section itself prints it: a count or a date quoted from the text is a quotation. A number the section does not
 * print is still the model's own. Names that contain digits (`Lab 21`, `21.3`, `Figure 3`) are not numbers at all,
 * as the pipeline's own figure extraction reads them (`lib/sensors/numbers.ts`).
 *
 * A failed claim is **substituted**, not deleted: its text becomes "the book does not cover this", its citation is
 * dropped, and `substituted` is true. The reader may already have seen the model's words stream past; the final
 * event carries the substituted claim and the client renders from the final event alone (architecture § 6.4), so
 * what stays on the screen is what this sensor passed.
 */

/** What the sensor needs to know about one figure of a retrieved section. */
export interface SensorFigure {
  readonly figureId: FigureId;
  /** The value exactly as the release prints it, which is what a claim must contain to have quoted it. */
  readonly valueText: string;
}

/** A retrieved section as the sensor reads it: its own plain text and its own figures. */
export interface SensorSection {
  readonly sectionId: SectionId;
  readonly text: string;
  readonly figures: ReadonlyArray<SensorFigure>;
}

/** A claim as the parser produced it. */
export interface SensorClaim {
  readonly text: string;
  readonly sectionId: SectionId;
  readonly figureId: FigureId | null;
}

export type CitationFailure =
  | "section-not-retrieved"
  | "figure-not-in-section"
  | "figure-not-found-at-cited-location"
  | "number-without-a-figure-id"
  | "number-not-in-the-cited-section"
  | "claim-does-not-appear-in-the-cited-section";

export interface CitationResult {
  readonly claims: ReadonlyArray<ResolvedClaim>;
  readonly verdict: SensorVerdict;
  /** Why each substituted claim was substituted, in the order of the claims, for the log and the span. */
  readonly failures: ReadonlyArray<{ readonly index: number; readonly failure: CitationFailure }>;
}

/** The thin space and the non-breaking space the book prints inside numbers; whitespace is not evidence. */
function normalise(text: string): string {
  return text.replace(/[   ]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The content terms of a text: words of three or more letters that are not stop words (D5). Deliberately crude and
 * language-agnostic — it is the coarse check, and a stemmer here would only make its failures harder to explain.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "are", "was", "were", "has", "have", "had", "not", "but", "its",
  "into", "than", "then", "when", "what", "which", "who", "how", "why", "can", "does", "did", "you", "your", "our",
  "per", "out", "over", "under", "about", "one", "two", "all", "any", "each", "more", "most", "some", "such", "only",
  "que", "com", "para", "uma", "dos", "das", "não", "nao", "por", "como", "mais", "este", "esta", "isso", "seu", "sua",
]);

export function contentTerms(text: string): ReadonlySet<string> {
  const terms = new Set<string>();
  for (const match of normalise(text).matchAll(/[\p{L}]{3,}/gu)) {
    const term = match[0];
    if (!STOP_WORDS.has(term)) terms.add(term);
  }
  return terms;
}

/** A number standing where a figure would (the pipeline's own grammar, names set aside), so the two agree on what a figure looks like. */
export function quotesANumber(text: string): boolean {
  return quantitiesIn(text).length > 0;
}

function checkOne(claim: SensorClaim, sections: ReadonlyMap<SectionId, SensorSection>): CitationFailure | null {
  const section = sections.get(claim.sectionId);
  if (section === undefined) return "section-not-retrieved";

  if (claim.figureId !== null) {
    const figure = section.figures.find((candidate) => candidate.figureId === claim.figureId);
    if (figure === undefined) return "figure-not-in-section";
    /* Quoted as printed: the digits, the unit and the separators the release chose. A claim that rounds or
       reformats a figure has not quoted it, and rounding is exactly how a wrong number gets past a reader. */
    return normalise(claim.text).includes(normalise(figure.valueText)) ? null : "figure-not-found-at-cited-location";
  }

  /* No figure id. A number that is one of this section's figures must carry that figure's id (the guide's numbers
     rule); any other number must be one the section itself prints, or it is not a quotation. */
  const quoted = quantitiesIn(claim.text);
  if (quoted.length > 0) {
    const figureValues = section.figures.flatMap((figure) => quantitiesIn(figure.valueText).map((quantity) => quantity.value));
    const printed = quantitiesIn(section.text).map((quantity) => quantity.value);
    for (const quantity of quoted) {
      if (figureValues.includes(quantity.value)) return "number-without-a-figure-id";
      if (!printed.includes(quantity.value)) return "number-not-in-the-cited-section";
    }
  }

  const claimTerms = contentTerms(claim.text);
  const sectionTerms = contentTerms(section.text);
  for (const term of claimTerms) if (sectionTerms.has(term)) return null;
  return "claim-does-not-appear-in-the-cited-section";
}

/**
 * Check every claim and substitute the ones that fail. `locale` decides the sentence the reader sees, because the
 * substitution is the assistant speaking, not the book.
 */
export function citationSensor(
  claims: ReadonlyArray<SensorClaim>,
  sections: ReadonlyArray<SensorSection>,
  locale: Locale,
): CitationResult {
  const byId = new Map(sections.map((section) => [section.sectionId, section]));
  const failures: { index: number; failure: CitationFailure }[] = [];

  const resolved: ResolvedClaim[] = claims.map((claim, index) => {
    const failure = checkOne(claim, byId);
    if (failure === null) {
      const figure = claim.figureId === null ? null : (byId.get(claim.sectionId)?.figures.find((candidate) => candidate.figureId === claim.figureId) ?? null);
      return { text: claim.text, sectionId: claim.sectionId, figureId: claim.figureId, valueText: figure?.valueText ?? null, found: true, substituted: false };
    }
    failures.push({ index, failure });
    return { text: NO_COVER[locale], sectionId: claim.sectionId, figureId: null, valueText: null, found: false, substituted: true };
  });

  const total = claims.length;
  const withFigures = claims.filter((claim) => claim.figureId !== null).length;
  const figuresFound = resolved.filter((claim, index) => claims[index]?.figureId !== null && !claim.substituted).length;
  const substituted = failures.length;

  const verdict: SensorVerdict = {
    sensor: "citation",
    verdict: total === 0 ? "NA" : substituted === 0 ? "PASS" : substituted === total ? "FAIL" : "WARN",
    detail:
      total === 0
        ? "no claims to check"
        : `${String(figuresFound)} / ${String(withFigures)} figures found at cited location` + (substituted === 0 ? "" : `, ${String(substituted)} claim${substituted === 1 ? "" : "s"} replaced`),
    data: { claims: total, withFigures, figuresFound, substituted },
  };

  return { claims: resolved, verdict, failures };
}
