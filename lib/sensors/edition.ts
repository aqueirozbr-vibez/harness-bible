import type { Citation, Locale, SensorVerdict } from "@/lib/schemas/assistant";
import type { SectionId } from "@/lib/schemas/ids";

/*
 * The edition sensor (feature-specs/13 § 7.2), pure. Every citation must resolve in one edition at one version:
 * retrieval guarantees it, so a failure here is a defect in retrieval rather than in the model, and it is logged
 * with the trace id and named in the verdict.
 *
 * It also answers the reader's question, which is a different one: *which* edition am I being cited from? When the
 * answer's language is not the edition's, the result carries `citesEdition` and the dock says "cites the EN
 * edition", because a Portuguese answer quoting an English page should say so rather than let the reader assume
 * the book exists in their language (Reader D6: the PT editions do not exist yet).
 */

export interface EditionResult {
  readonly verdict: SensorVerdict;
  /** The edition every citation resolved in, for the turn's "cites the EN edition" line; null when there are none. */
  readonly citesEdition: "EN" | "PT" | null;
  /** True when the reader's language is not the edition's, which the dock shows and the observability unit counts. */
  readonly mismatch: boolean;
}

/** The reader's language is not the edition's: a Portuguese answer citing the English edition, or the reverse. */
export function editionMismatch(locale: Locale, edition: "EN" | "PT"): boolean {
  return (locale === "pt" && edition === "EN") || (locale === "en" && edition === "PT");
}

export function editionSensor(citations: ReadonlyArray<Citation>, locale: Locale, releaseVersionOf: (sectionId: SectionId) => string | null): EditionResult {
  if (citations.length === 0) {
    return { verdict: { sensor: "edition", verdict: "NA", detail: "no citations to resolve", data: { citations: 0 } }, citesEdition: null, mismatch: false };
  }

  const editions = new Set(citations.map((citation) => citation.editionLang));
  const wrongVersion = citations.filter((citation) => {
    const expected = releaseVersionOf(citation.sectionId);
    return expected !== null && expected !== citation.version;
  });

  const edition = citations[0]?.editionLang ?? "EN";
  const mismatch = editionMismatch(locale, edition);

  if (editions.size > 1 || wrongVersion.length > 0) {
    const named = editions.size > 1 ? `citations span ${[...editions].join(" and ")}` : `${wrongVersion[0]?.sectionId ?? ""} is not at the release's version`;
    return {
      verdict: { sensor: "edition", verdict: "FAIL", detail: named, data: { citations: citations.length, editions: editions.size, wrongVersion: wrongVersion.length } },
      citesEdition: edition,
      mismatch,
    };
  }

  const version = citations[0]?.version ?? "";
  return {
    verdict: {
      sensor: "edition",
      verdict: "PASS",
      detail: `${String(citations.length)} / ${String(citations.length)} citations resolve in ${edition} ${version}`,
      data: { citations: citations.length, edition, version, mismatch },
    },
    citesEdition: edition,
    mismatch,
  };
}
