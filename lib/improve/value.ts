/*
 * A figure's value as a value's edit reads and writes it (feature-specs/34 § 5; 31 § 4): the number the book prints,
 * in the form a proposal writes a decimal; a new number printed in the figure's own shape, as the merge prints it
 * (pipeline/edit/apply.ts); and the change from the one to the other, which the form shows beside the two.
 *
 * Pure, and small enough for a client island: the form echoes what the person types with the same printer the
 * merge uses.
 */

/** A printed value: an optional `$`, the number with its grouping commas, and whatever the book prints after it. */
const PRINTED = /^(\$?\s?)([\d,]*\.?\d+)(.*)$/;

/** A decimal as a proposal writes one (`DecimalTextSchema`, lib/schemas/improve.ts): `0.25`, `-3`, `1450`. */
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** The number a printed value holds, as a proposal writes a decimal: `$0.30` → `0.30`, `7,500 tokens` → `7500`, `45%` → `45`; null where it holds none. */
export function decimalOfPrinted(valueText: string): string | null {
  const m = PRINTED.exec(valueText.trim());
  return m === null ? null : m[2].replace(/,/g, "");
}

/**
 * A figure's printed value with its number set to `after`, in its own shape: `45%` → `50%`, `1 s` → `2 s`, `$0.05` →
 * `$0.07`, `7,500` → `8,000`, `02` → `05`. Grouping follows the book, which writes four digits and more with commas,
 * unless this figure was printed without them. Null where the value is not printed as a number, or `after` is
 * negative, which no figure of the book prints.
 */
export function printedValue(valueText: string, after: string): string | null {
  const m = PRINTED.exec(valueText);
  if (m === null || after.startsWith("-")) return null;
  const [whole, fraction] = after.split(".");
  const old = m[2].split(".")[0];
  const padded = old.startsWith("0") && old.length > 1 ? whole.padStart(old.length, "0") : whole;
  const group = old.includes(",") || (padded.length >= 4 && old.replace(/,/g, "").length < 4);
  const grouped = group ? padded.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : padded;
  return `${m[1]}${grouped}${fraction === undefined ? "" : `.${fraction}`}${m[3]}`;
}

/** Whether a field's text is a decimal a proposal takes, once trimmed. */
export function isDecimal(text: string): boolean {
  return DECIMAL.test(text.trim());
}

/** The change from one decimal to another in percent of the first: `0.30` → `0.25` is about −16.67. Null where the first is zero or either is not a decimal. */
export function percentChange(before: string, after: string): number | null {
  if (!isDecimal(before) || !isDecimal(after)) return null;
  const from = Number(before.trim());
  if (from === 0) return null;
  return ((Number(after.trim()) - from) / Math.abs(from)) * 100;
}
