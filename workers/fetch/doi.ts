import { doiUrl, normaliseDoi } from "@/lib/improve/doi";

import { defaultFetchDeps, fetchEvidence, type FetchDeps, type Opened, type Unreachable, type Unsupported } from "./fetch";
import { dateOf } from "./html";

/*
 * A DOI opened two ways through the fetcher (feature-specs/32 § 6): the resolver's redirect from `https://doi.org/<doi>`
 * to the publisher's landing page, whose text is what is graded — for a paywalled paper its abstract, which is what
 * the contributor's reader would see — and the public metadata record for the DOI, asked of the same URL by DOI
 * content negotiation (`Accept: application/vnd.citationstyles.csl+json`; Andre, 2026-10-06: "pick the most accepted
 * option" — it is the DOI system's own, honoured by Crossref, DataCite and mEDRA through the one host the DOI
 * names, with no second API and no key). The record is read as JSON into a few typed fields and is data for code,
 * never a document for a model. The date comes from the record when it has one, else from the landing page's own
 * metadata; a record a registration agency does not serve (doi.org then redirects to the page as for any request)
 * leaves `metadata` null and takes nothing from the landing page. A DOI that does not resolve is `unreachable`,
 * as a link is; one that is not a DOI by form is `invalid` before anything is asked. The two fetches run together,
 * each under the fetcher's own limits.
 */

export const DOI_METADATA_ACCEPT = "application/vnd.citationstyles.csl+json";

export interface DoiMetadata {
  readonly title: string | null;
  /** The record's own `type`: `journal-article`, `book-chapter`, `dataset`, `report`… */
  readonly type: string | null;
  /** `YYYY-MM-DD`; a record that gives a year, or a year and a month, is taken as the first day of it. */
  readonly publishedOn: string | null;
  readonly publisher: string | null;
  readonly containerTitle: string | null;
  /** Where the record says the DOI resolves. */
  readonly url: string | null;
  /** The URL the record was served from (the agency's). */
  readonly source: string;
}

interface Resolved {
  readonly outcome: "resolved";
  readonly doi: string;
  readonly url: string;
  readonly landing: Opened;
  readonly metadata: DoiMetadata | null;
  /** The record's date, else the landing page's own; null when neither states one. */
  readonly publishedOn: string | null;
  readonly fetchedAt: Date;
}

interface NotOpened {
  readonly outcome: "unreachable" | "unsupported";
  readonly doi: string;
  readonly url: string;
  readonly landing: Unreachable | Unsupported;
  readonly metadata: DoiMetadata | null;
  readonly fetchedAt: Date;
}

interface Invalid {
  readonly outcome: "invalid";
  /** As it was given. */
  readonly doi: string;
  readonly fetchStatus: "unreachable:doi_form";
}

export type DoiOutcome = Resolved | NotOpened | Invalid;

type Json = Record<string, unknown>;

const firstString = (value: unknown): string | null => {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : null;
};

/** A CSL date: `{ "date-parts": [[y, m, d]] }`, or `{ raw }`; a year or a year and a month alone is its first day. */
function cslDate(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Json;
  const parts = Array.isArray(record["date-parts"]) ? (record["date-parts"][0] as unknown) : undefined;
  if (Array.isArray(parts) && parts.length > 0 && parts.every((part) => typeof part === "number" || typeof part === "string")) {
    const [year, month = 1, day = 1] = parts.map(Number);
    if (year === undefined || !Number.isInteger(year)) return null;
    return dateOf(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  return typeof record["raw"] === "string" ? dateOf(record["raw"]) : null;
}

/** The fields the product keeps of a CSL JSON record; null when the text is not a record. */
export function parseCslRecord(text: string, source: string): DoiMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Json;
  const url = firstString(record["URL"]);
  return {
    title: firstString(record["title"]),
    type: firstString(record["type"]),
    publishedOn: cslDate(record["issued"]) ?? cslDate(record["published-online"]) ?? cslDate(record["published-print"]) ?? cslDate(record["published"]),
    publisher: firstString(record["publisher"]),
    containerTitle: firstString(record["container-title"]),
    url: url !== null && /^https?:\/\//i.test(url) ? url : null,
    source,
  };
}

/** § 6 end to end for one DOI as a person wrote it. */
export async function openDoi(input: string, deps: FetchDeps = defaultFetchDeps()): Promise<DoiOutcome> {
  const doi = normaliseDoi(input);
  if (doi === null) return { outcome: "invalid", doi: input, fetchStatus: "unreachable:doi_form" };
  const url = doiUrl(doi);
  const [landing, record] = await Promise.all([fetchEvidence(url, deps), fetchEvidence(url, deps, { accept: DOI_METADATA_ACCEPT })]);
  const metadata = record.outcome === "opened" && record.document.kind === "json" ? parseCslRecord(record.document.text, record.finalUrl) : null;
  if (landing.outcome !== "opened") return { outcome: landing.outcome, doi, url, landing, metadata, fetchedAt: landing.fetchedAt };
  const pageDate = landing.document.kind === "html" ? landing.document.publishedOn : null;
  return { outcome: "resolved", doi, url, landing, metadata, publishedOn: metadata?.publishedOn ?? pageDate, fetchedAt: landing.fetchedAt };
}
