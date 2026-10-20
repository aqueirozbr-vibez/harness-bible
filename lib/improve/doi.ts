import { DoiSchema } from "@/lib/schemas/ledger";

/*
 * A DOI as a person writes it, brought to its bare form (feature-specs/32 § 6): `10.1038/171737a0` from
 * `https://doi.org/10.1038/171737a0`, `http://dx.doi.org/…`, `doi:10.1038/171737a0`, `DOI: 10.1038/171737a0` or
 * the bare form itself, with the resolver, the label and any whitespace removed and the letters lowercased — DOI
 * names are case-insensitive by the handbook, so the lowercase form is the one the product keeps and compares.
 * What remains must read as `DoiSchema` has it (`10.`, a registrant, a slash, a suffix); anything else is null,
 * and the endpoint that takes a DOI (49e) refuses it by form before the fetcher is asked.
 */

const RESOLVERS = /^https?:\/\/(?:dx\.)?doi\.org\//i;
const LABEL = /^doi:\s*/i;

export function normaliseDoi(input: string): string | null {
  let text = input.trim().replace(RESOLVERS, "").replace(LABEL, "").trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    return null;
  }
  const doi = text.toLowerCase();
  return DoiSchema.safeParse(doi).success ? doi : null;
}

/** The DOI's resolver URL, the one URL every DOI has: the suffix percent-encoded as doi.org expects it. */
export function doiUrl(doi: string): string {
  const [prefix, ...rest] = doi.split("/");
  return `https://doi.org/${prefix ?? ""}/${rest.map((segment) => encodeURIComponent(segment)).join("/")}`;
}
