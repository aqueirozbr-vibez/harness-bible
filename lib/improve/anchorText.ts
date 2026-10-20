/*
 * What an anchor says, as one text (feature-specs/31 § 3; 37 § 4.1 step 1): a section's source markdown, a figure's
 * label and value with its unit, a source row's claim and citation. A draft records the sha256 of this text against the
 * release's rows (lib/db/anchors.ts), and a merge reads it again from the book's files at `main` (pipeline/check.ts):
 * one composition, so that the two hashes agree exactly when the text does.
 */

export function sectionText(section: { readonly markdownEn: string }): string {
  return section.markdownEn;
}

export function figureText(figure: { readonly label: string; readonly valueText: string; readonly unit: string | null }): string {
  return `${figure.label} · ${figure.valueText}${figure.unit === null ? "" : ` ${figure.unit}`}`;
}

export function rowText(row: { readonly claim: string; readonly citation: string }): string {
  return `${row.claim} — ${row.citation}`;
}
