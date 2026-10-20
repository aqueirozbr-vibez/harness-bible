import "dotenv/config";

import { openDoi, type DoiOutcome } from "@/workers/fetch/doi";
import { fetchEvidence, type FetchOutcome } from "@/workers/fetch/fetch";

/*
 * npm run fetch:check -- <url> (feature-specs/32 § 4): the fetcher by hand, as the workers run it — the guard, the
 * resolution, the pinned connection, the limits — on one URL, with what it made of the page printed as facts and
 * never as the page itself: the outcome, the status, where it ended, the type, the size and hash of the body, and
 * for HTML the title, the date, the canonical URL and the length of the text. The smoke test of the fetcher on a
 * fresh machine, and the way to see what a contributor's link will be graded from.
 *
 * npm run fetch:check -- --doi <doi> (§ 6; unit 49c): the same for a DOI, opened both ways — the landing page as
 * above, and the record read by content negotiation, printed as its fields.
 */

function usage(message: string): never {
  console.error(`${message}\nusage: npm run fetch:check -- <https-url> | --doi <doi>`);
  process.exit(1);
}

function summary(outcome: FetchOutcome): Record<string, unknown> {
  const common = { outcome: outcome.outcome, fetchStatus: outcome.fetchStatus, url: outcome.url, redirects: outcome.redirects, fetchedAt: outcome.fetchedAt.toISOString() };
  if (outcome.outcome === "unreachable") return { ...common, cause: outcome.cause, at: outcome.at };
  if (outcome.outcome === "unsupported") return { ...common, finalUrl: outcome.finalUrl, contentType: outcome.contentType };
  const { document } = outcome;
  const opened = { ...common, finalUrl: outcome.finalUrl, contentType: outcome.contentType, bytes: outcome.bytes, sha256: outcome.sha256 };
  if (document.kind === "html") return { ...opened, title: document.title, publishedOn: document.publishedOn, canonicalUrl: document.canonicalUrl, textChars: document.text.length };
  if (document.kind === "text") return { ...opened, mediaType: document.mediaType, textChars: document.text.length };
  return { ...opened, mediaType: document.mediaType, kept: "bytes" };
}

function doiSummary(outcome: DoiOutcome): Record<string, unknown> {
  if (outcome.outcome === "invalid") return { outcome: outcome.outcome, doi: outcome.doi, fetchStatus: outcome.fetchStatus };
  return { outcome: outcome.outcome, doi: outcome.doi, url: outcome.url, ...(outcome.outcome === "resolved" ? { publishedOn: outcome.publishedOn } : {}), metadata: outcome.metadata, landing: summary(outcome.landing) };
}

const [first, second] = process.argv.slice(2);
if (first === undefined) usage("name the URL to fetch, or --doi and a DOI");
if (first === "--doi" ? process.argv.length > 4 || second === undefined : process.argv.length > 3) usage("one URL, or one DOI after --doi, at a time");

const run: Promise<{ readonly opened: boolean; readonly report: Record<string, unknown> }> =
  first === "--doi"
    ? openDoi(second ?? "").then((outcome) => ({ opened: outcome.outcome === "resolved", report: doiSummary(outcome) }))
    : fetchEvidence(first).then((outcome) => ({ opened: outcome.outcome === "opened", report: summary(outcome) }));

run
  .then(({ opened, report }) => {
    console.log(JSON.stringify(report, null, 2));
    if (!opened) process.exitCode = 1;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  });
