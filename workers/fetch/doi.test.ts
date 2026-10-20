import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DOI_METADATA_ACCEPT, openDoi, parseCslRecord } from "./doi";
import { ACCEPT, FETCH_LIMITS, type FetchDeps } from "./fetch";
import { ownHostsOf } from "./guard";
import { transportOf } from "./transport";

/*
 * A DOI opened two ways on a local server that plays the resolver, the agency and the publisher by `Host`
 * (feature-specs/32 § 6): the landing page through the resolver's redirect, the CSL record through content
 * negotiation at the same URL; the record's date over the page's; a registration agency that serves no record; a
 * paywall's 403 as `unreachable`; a DOI that resolves to a PDF; a record that is not JSON; a DOI that is not one.
 * The two requests carry different `Accept` headers and the same user agent, and neither carries a cookie.
 */

const PUBLIC_V4 = "93.184.216.34";
const HOSTS: Readonly<Record<string, ReadonlyArray<string>>> = { "doi.org": [PUBLIC_V4], "data.agency.example": [PUBLIC_V4], "publisher.example": [PUBLIC_V4] };

const RECORD = { DOI: "10.1000/182", type: "journal-article", title: ["Retries at eleven steps"], "container-title": ["Journal of Harness Engineering"], publisher: "Provider Two Press", issued: { "date-parts": [[2026, 7, 14]] }, "published-online": { "date-parts": [[2026, 7, 1]] }, URL: "https://publisher.example/article/182", author: [{ family: "Doe", given: "J." }] };
const LANDING = '<html><head><title>Retries at eleven steps | Journal</title><meta property="article:published_time" content="2026-07-20"></head><body><h1>Retries at eleven steps</h1><p>Abstract: a retried write without a key is a second write.</p></body></html>';

interface Seen {
  readonly host: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
}
const seen: Seen[] = [];
let server: Server;
let port = 0;

function serve(server: Server): void {
  server.on("request", (req, res) => {
    const host = req.headers.host ?? "";
    const path = req.url ?? "/";
    seen.push({ host, path, headers: req.headers });
    const wantsRecord = (req.headers.accept ?? "").includes("csl+json");
    const redirect = (to: string, status = 302): void => {
      res.writeHead(status, { location: to, "set-cookie": "doi=abc" });
      res.end();
    };
    if (host === "doi.org") {
      /* The resolver: a record asked for goes to the agency; anything else goes to the publisher. */
      const RESOLVES: Readonly<Record<string, { readonly record: string | null; readonly page: string }>> = {
        "/10.1000/182": { record: "https://data.agency.example/10.1000%2F182", page: "https://publisher.example/article/182" },
        "/10.1000/nometa": { record: null, page: "https://publisher.example/article/nometa" },
        "/10.1000/paywall": { record: "https://data.agency.example/10.1000%2Fpaywall", page: "https://publisher.example/article/paywall" },
        "/10.1000/pdf": { record: "https://data.agency.example/10.1000%2Fpdf", page: "https://publisher.example/paper.pdf" },
        "/10.1000/badjson": { record: "https://data.agency.example/10.1000%2Fbadjson", page: "https://publisher.example/article/182" },
        "/10.1000/year": { record: "https://data.agency.example/10.1000%2Fyear", page: "https://publisher.example/article/nometa" },
      };
      const resolves = RESOLVES[path];
      if (resolves === undefined) {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<p>DOI not found</p>");
      } else if (wantsRecord && resolves.record !== null) {
        redirect(resolves.record, 303);
      } else {
        redirect(resolves.page);
      }
    } else if (host === "data.agency.example") {
      if (path === "/10.1000%2F182" || path === "/10.1000%2Fpaywall" || path === "/10.1000%2Fpdf") {
        res.writeHead(200, { "content-type": "application/vnd.citationstyles.csl+json; charset=utf-8" });
        res.end(JSON.stringify(RECORD));
      } else if (path === "/10.1000%2Fyear") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...RECORD, issued: { "date-parts": [[2025]] }, "published-online": undefined, title: "A year alone", "container-title": undefined }));
      } else if (path === "/10.1000%2Fbadjson") {
        res.writeHead(200, { "content-type": "application/vnd.citationstyles.csl+json" });
        res.end("{ not json");
      } else {
        res.writeHead(404);
        res.end();
      }
    } else if (host === "publisher.example") {
      if (path === "/article/182") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(LANDING);
      } else if (path === "/article/nometa") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<html><head><title>No record</title><meta name="date" content="2026-03-03"></head><body><p>text</p></body></html>');
      } else if (path === "/article/paywall") {
        res.writeHead(403, { "content-type": "text/html" });
        res.end("<p>subscribe</p>");
      } else if (path === "/paper.pdf") {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(Buffer.from("%PDF-1.4\n%%EOF\n"));
      } else {
        res.writeHead(404);
        res.end();
      }
    } else {
      res.writeHead(421);
      res.end();
    }
  });
}

const deps = (): FetchDeps => ({
  resolve: async (hostname) => {
    const addresses = HOSTS[hostname];
    if (addresses === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return addresses;
  },
  transport: transportOf(httpRequest, { host: "127.0.0.1", port }),
  own: ownHostsOf(["http://localhost:3000"]),
  userAgent: "Harness-Bible-Evidence/0.1 (+http://localhost:3000)",
  limits: { ...FETCH_LIMITS, deadlineMs: 5_000 },
  now: () => new Date("2026-10-06T12:00:00Z"),
});

beforeAll(async () => {
  server = createServer();
  serve(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("openDoi", () => {
  it("opens the landing page through the resolver and reads the record through content negotiation at the same URL, the record's date first", async () => {
    const before = seen.length;
    const outcome = await openDoi("https://doi.org/10.1000/182", deps());
    expect(outcome.outcome).toBe("resolved");
    if (outcome.outcome !== "resolved") return;
    expect(outcome.doi).toBe("10.1000/182");
    expect(outcome.url).toBe("https://doi.org/10.1000/182");
    expect(outcome.landing).toMatchObject({ outcome: "opened", finalUrl: "https://publisher.example/article/182", redirects: 1, contentType: "text/html" });
    if (outcome.landing.document.kind === "html") {
      expect(outcome.landing.document.title).toBe("Retries at eleven steps | Journal");
      expect(outcome.landing.document.text).toContain("Abstract: a retried write");
      expect(outcome.landing.document.publishedOn).toBe("2026-07-20");
    }
    expect(outcome.metadata).toEqual({ title: "Retries at eleven steps", type: "journal-article", publishedOn: "2026-07-14", publisher: "Provider Two Press", containerTitle: "Journal of Harness Engineering", url: "https://publisher.example/article/182", source: "https://data.agency.example/10.1000%2F182" });
    expect(outcome.publishedOn).toBe("2026-07-14"); // the record's, over the page's 2026-07-20
    expect(outcome.fetchedAt).toEqual(new Date("2026-10-06T12:00:00Z"));

    const requests = seen.slice(before);
    expect(requests.map((request) => `${request.host}${request.path}`).sort()).toEqual(["data.agency.example/10.1000%2F182", "doi.org/10.1000/182", "doi.org/10.1000/182", "publisher.example/article/182"]);
    const toResolver = requests.filter((request) => request.host === "doi.org").map((request) => request.headers.accept).sort();
    expect(toResolver).toEqual([ACCEPT, DOI_METADATA_ACCEPT].sort());
    expect(requests.find((request) => request.host === "data.agency.example")?.headers.accept).toBe(DOI_METADATA_ACCEPT); // the Accept rides the redirect
    expect(requests.find((request) => request.host === "publisher.example")?.headers.accept).toBe(ACCEPT);
    for (const request of requests) {
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers["user-agent"]).toBe("Harness-Bible-Evidence/0.1 (+http://localhost:3000)");
    }
  });

  it("takes a DOI in any of its written forms", async () => {
    for (const written of ["10.1000/182", "doi:10.1000/182", "DOI: 10.1000/182", "http://dx.doi.org/10.1000/182"]) {
      const outcome = await openDoi(written, deps());
      expect(outcome.outcome, written).toBe("resolved");
      expect(outcome.doi).toBe("10.1000/182");
    }
  });

  it("leaves the metadata null when the agency serves no record, and takes the page's own date", async () => {
    const outcome = await openDoi("10.1000/nometa", deps());
    expect(outcome.outcome).toBe("resolved");
    if (outcome.outcome !== "resolved") return;
    expect(outcome.metadata).toBeNull();
    expect(outcome.publishedOn).toBe("2026-03-03");
    expect(outcome.landing.finalUrl).toBe("https://publisher.example/article/nometa");
  });

  it("takes a year alone as its first day, and a plain application/json record", async () => {
    const outcome = await openDoi("10.1000/year", deps());
    expect(outcome.outcome).toBe("resolved");
    if (outcome.outcome !== "resolved") return;
    expect(outcome.metadata).toMatchObject({ title: "A year alone", publishedOn: "2025-01-01", containerTitle: null });
    expect(outcome.publishedOn).toBe("2025-01-01");
  });

  it("is unreachable when the landing page cannot be opened, with the record kept beside the refusal", async () => {
    const outcome = await openDoi("10.1000/paywall", deps());
    expect(outcome.outcome).toBe("unreachable");
    if (outcome.outcome !== "unreachable") return;
    expect(outcome.landing).toMatchObject({ fetchStatus: "unreachable:403", at: "https://publisher.example/article/paywall" });
    expect(outcome.metadata).toMatchObject({ title: "Retries at eleven steps", publishedOn: "2026-07-14" });
  });

  it("is unreachable:404 for a DOI the resolver does not know, with no record", async () => {
    const outcome = await openDoi("10.1000/unknown", deps());
    expect(outcome).toMatchObject({ outcome: "unreachable", doi: "10.1000/unknown", metadata: null, landing: { fetchStatus: "unreachable:404", at: "https://doi.org/10.1000/unknown" } });
  });

  it("keeps a DOI that resolves to a PDF as bytes for unit 49f", async () => {
    const outcome = await openDoi("10.1000/pdf", deps());
    expect(outcome.outcome).toBe("resolved");
    if (outcome.outcome !== "resolved") return;
    expect(outcome.landing).toMatchObject({ contentType: "application/pdf", document: { kind: "bytes", mediaType: "application/pdf" } });
    expect(outcome.publishedOn).toBe("2026-07-14"); // the record's; a PDF has no page date
  });

  it("leaves the metadata null when the record is not JSON", async () => {
    const outcome = await openDoi("10.1000/badjson", deps());
    expect(outcome.outcome).toBe("resolved");
    if (outcome.outcome === "resolved") expect(outcome.metadata).toBeNull();
  });

  it("refuses a DOI that is not one by form before anything is asked", async () => {
    const before = seen.length;
    for (const input of ["", "not a doi", "11.1000/182", "https://example.com/10.1000/182"]) {
      expect(await openDoi(input, deps()), input).toEqual({ outcome: "invalid", doi: input, fetchStatus: "unreachable:doi_form" });
    }
    expect(seen.length).toBe(before);
  });

  it("answers a JSON page as unsupported for a plain link: JSON is opened only when asked for", async () => {
    const { fetchEvidence } = await import("./fetch");
    expect(await fetchEvidence("https://data.agency.example/10.1000%2F182", deps())).toMatchObject({ outcome: "unsupported", fetchStatus: "unsupported:application/vnd.citationstyles.csl+json" });
    expect(await fetchEvidence("https://data.agency.example/10.1000%2F182", deps(), { accept: DOI_METADATA_ACCEPT })).toMatchObject({ outcome: "opened", document: { kind: "json" } });
  });
});

describe("parseCslRecord", () => {
  it("reads the fields the product keeps and nothing else", () => {
    const parsed = parseCslRecord(JSON.stringify(RECORD), "https://data.agency.example/x");
    expect(parsed).toEqual({ title: "Retries at eleven steps", type: "journal-article", publishedOn: "2026-07-14", publisher: "Provider Two Press", containerTitle: "Journal of Harness Engineering", url: "https://publisher.example/article/182", source: "https://data.agency.example/x" });
    expect(Object.keys(parsed ?? {})).not.toContain("author");
  });

  it("falls through the dates in order, reads a raw date, takes a month alone as its first day, and answers null for what is not a record", () => {
    expect(parseCslRecord(JSON.stringify({ "published-print": { "date-parts": [[2024, 2]] } }), "s")?.publishedOn).toBe("2024-02-01");
    expect(parseCslRecord(JSON.stringify({ issued: { raw: "14 July 2026" } }), "s")?.publishedOn).toBe("2026-07-14");
    expect(parseCslRecord(JSON.stringify({ issued: { "date-parts": [["2026", "7", "14"]] } }), "s")?.publishedOn).toBe("2026-07-14");
    expect(parseCslRecord(JSON.stringify({ issued: { "date-parts": [[]] } }), "s")?.publishedOn).toBeNull();
    expect(parseCslRecord(JSON.stringify({ issued: { "date-parts": [[2026, 13]] } }), "s")?.publishedOn).toBeNull();
    expect(parseCslRecord(JSON.stringify({ title: "", URL: "javascript:alert(1)", type: 7 }), "s")).toEqual({ title: null, type: null, publishedOn: null, publisher: null, containerTitle: null, url: null, source: "s" });
    expect(parseCslRecord("[]", "s")).toBeNull();
    expect(parseCslRecord("null", "s")).toBeNull();
    expect(parseCslRecord("nonsense", "s")).toBeNull();
  });
});
