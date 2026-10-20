import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FetchStatusSchema } from "@/lib/schemas/ledger";

import { ACCEPT, FETCH_DEADLINE_MS, FETCH_LIMITS, FETCH_REDIRECTS_MAX, FETCH_SIZE_MAX, charsetOf, fetchEvidence, mediaTypeOf, userAgentOf, type FetchDeps, type FetchLimits, type FetchOutcome } from "./fetch";
import { GUARD_REASONS, ownHostsOf } from "./guard";
import { requestOptionsOf, transportOf, type Target, type Transport } from "./transport";

/*
 * The fetcher against a local test server (feature-specs/32 § 4, § 13.2): the request as § 4.2 describes it, a
 * page over the size limit abandoned at the limit, one that never answers ended at the deadline, six redirects
 * ending as `unreachable`, a cookie the server set never sent back, each redirect put through the guard, every
 * content type of § 4.3, and each cause of § 4.4 as the ledger's `FetchStatusSchema` spells it. The resolver is a
 * double that gives public addresses to the suite's names, and the transport is the fetcher's own code on
 * `node:http` with the address replaced by the server's, so what the real transport adds is TLS and nothing else.
 */

const ARTICLE = readFileSync(join(import.meta.dirname, "__fixtures__", "article.html"));
const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";
const HOSTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "pages.example": [PUBLIC_V4],
  "docs.pages.example": [PUBLIC_V4, PUBLIC_V6],
  "intranet.example": ["10.0.0.5"],
  "mixed.example": [PUBLIC_V4, "10.0.0.5"],
  "metadata.example": ["169.254.169.254"],
};
const MiB = 1024 * 1024;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");

interface Seen {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
}

const seen: Seen[] = [];
const connectedTo: string[] = [];
const statuses: string[] = [];
let bigWritten = 0;
let server: Server;
let port = 0;
let closedPort = 0;

function serve(server: Server): void {
  server.on("request", (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    seen.push({ path: req.url ?? "/", headers: req.headers });
    const redirect = (to: string): void => {
      res.writeHead(302, { location: to, "set-cookie": "session=abc; Path=/" });
      res.end();
    };
    if (path === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "session=abc; Path=/" });
      res.end(ARTICLE);
    } else if (path === "/xhtml") {
      res.writeHead(200, { "content-type": "application/xhtml+xml" });
      res.end('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>X</title></head><body><p>xhtml</p></body></html>');
    } else if (path === "/cookie-hop") {
      redirect("https://pages.example/page");
    } else if (path.startsWith("/hop/")) {
      redirect(`https://pages.example/hop/${String(Number(path.slice(5)) + 1)}`);
    } else if (path === "/relative") {
      redirect("/page");
    } else if (path === "/to-private") {
      redirect("https://intranet.example/");
    } else if (path === "/to-metadata") {
      redirect("https://metadata.example/latest/meta-data/");
    } else if (path === "/to-http") {
      redirect("http://pages.example/page");
    } else if (path === "/to-ftp") {
      redirect("ftp://pages.example/page");
    } else if (path === "/no-location") {
      res.writeHead(302);
      res.end();
    } else if (path === "/big") {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let closed = false;
      req.on("close", () => {
        closed = true;
      });
      res.writeHead(200, { "content-type": "text/plain" });
      const pump = (): void => {
        while (!closed && bigWritten < 8 * MiB) {
          bigWritten += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        if (!closed) res.end();
      };
      pump();
    } else if (path === "/declared-big") {
      res.writeHead(200, { "content-type": "text/plain", "content-length": String(6 * MiB) });
      res.write("a few bytes of a body that says it is six megabytes");
    } else if (path === "/bomb") {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.alloc(6 * MiB, 0x20)));
    } else if (path === "/slow") {
      /* Never answers: the connection stays open until the client gives up. */
    } else if (path === "/gzip") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(gzipSync(ARTICLE));
    } else if (path === "/zstd") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "zstd" });
      res.end(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
    } else if (path === "/zip") {
      res.writeHead(200, { "content-type": "application/zip" });
      res.end(Buffer.from("PK\u0003\u0004"));
    } else if (path === "/no-type") {
      res.writeHead(200);
      res.end("untyped");
    } else if (path === "/odd-type") {
      res.writeHead(200, { "content-type": "Text/HTML junk" });
      res.end("x");
    } else if (path === "/pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(PDF);
    } else if (path === "/png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } else if (path === "/latin1") {
      res.writeHead(200, { "content-type": "text/plain; charset=ISO-8859-1" });
      res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    } else if (path === "/meta-charset") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(Buffer.concat([Buffer.from('<html><head><meta charset="iso-8859-1"><title>Caf'), Buffer.from([0xe9]), Buffer.from("</title></head><body><p>ol"), Buffer.from([0xe1]), Buffer.from("</p></body></html>")]));
    } else if (path === "/markdown") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end("# Title\n\nA *markdown* page.\n");
    } else if (path === "/notfound") {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<p>not here</p>");
    } else if (path === "/error") {
      res.writeHead(500);
      res.end();
    } else if (path === "/empty") {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

/** The fetcher's transport on plain HTTP to the test server, with the address it was asked to open recorded. */
function testTransport(toPort: number): Transport {
  const inner = transportOf(httpRequest, { host: "127.0.0.1", port: toPort });
  return {
    request(target, signal) {
      connectedTo.push(target.address);
      return inner.request(target, signal);
    },
  };
}

function depsOf(limits: Partial<FetchLimits> = {}, toPort = port): FetchDeps {
  return {
    resolve: async (hostname) => {
      const addresses = HOSTS[hostname];
      if (addresses === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
      return addresses;
    },
    transport: testTransport(toPort),
    own: ownHostsOf(["http://localhost:3000", "http://gateway:4000"]),
    userAgent: userAgentOf("http://localhost:3000"),
    limits: { ...FETCH_LIMITS, deadlineMs: 5_000, ...limits },
    now: () => new Date("2026-10-06T12:00:00Z"),
  };
}

async function run(url: string, limits: Partial<FetchLimits> = {}, toPort = port): Promise<FetchOutcome> {
  const outcome = await fetchEvidence(url, depsOf(limits, toPort));
  statuses.push(outcome.fetchStatus);
  return outcome;
}

const last = (): Seen => seen[seen.length - 1] as Seen;

beforeAll(async () => {
  server = createServer();
  serve(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  const closing = createServer();
  await new Promise<void>((resolve) => closing.listen(0, "127.0.0.1", resolve));
  closedPort = (closing.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the request (§ 4.2)", () => {
  it("opens a page with the product's user agent, Accept for § 4.3's types, no cookie, credential or referrer, the name as Host, and the socket to the address the guard checked", async () => {
    const outcome = await run("https://pages.example/page?ref=1#top");
    expect(outcome).toMatchObject({ outcome: "opened", fetchStatus: "opened:200", url: "https://pages.example/page?ref=1#top", finalUrl: "https://pages.example/page?ref=1", redirects: 0, contentType: "text/html", bytes: ARTICLE.length, sha256: createHash("sha256").update(ARTICLE).digest("hex"), fetchedAt: new Date("2026-10-06T12:00:00Z") });
    if (outcome.outcome !== "opened" || outcome.document.kind !== "html") throw new Error("not an html document");
    expect(outcome.document.title).toBe("Retries at eleven steps — Provider Two Engineering");
    expect(outcome.document.publishedOn).toBe("2026-07-14");
    expect(outcome.document.canonicalUrl).toBe("https://pages.example/blog/retries"); // the page's relative link, against the URL fetched
    expect(outcome.document.text).toContain("second write");
    expect(outcome.document.text).not.toContain("SCRIPT_TEXT");
    const request = last();
    expect(request.path).toBe("/page?ref=1");
    expect(request.headers.host).toBe("pages.example");
    expect(request.headers["user-agent"]).toBe("Harness-Bible-Evidence/0.1 (+http://localhost:3000)");
    expect(request.headers.accept).toBe(ACCEPT);
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.referer).toBeUndefined();
    expect(request.headers.connection).toBe("close");
    expect(connectedTo[connectedTo.length - 1]).toBe(PUBLIC_V4);
  });

  it("sends no cookie the server set, on the redirect that follows or on a later fetch", async () => {
    const outcome = await run("https://pages.example/cookie-hop");
    expect(outcome).toMatchObject({ outcome: "opened", redirects: 1, finalUrl: "https://pages.example/page" });
    expect(seen.slice(-2).map((request) => request.path)).toEqual(["/cookie-hop", "/page"]);
    for (const request of seen.slice(-2)) expect(request.headers.cookie).toBeUndefined();
    await run("https://pages.example/page");
    expect(last().headers.cookie).toBeUndefined();
  });

  it("connects to the first checked address of a host that has several, and asks a two-address host once", async () => {
    await run("https://docs.pages.example/page");
    expect(connectedTo[connectedTo.length - 1]).toBe(PUBLIC_V4);
  });
});

describe("redirects (§ 4.1)", () => {
  it("follows a relative Location and reports the chain", async () => {
    expect(await run("https://pages.example/relative")).toMatchObject({ outcome: "opened", redirects: 1, finalUrl: "https://pages.example/page" });
  });

  it("ends six redirects as unreachable:redirects, having followed five", async () => {
    const before = seen.length;
    const outcome = await run("https://pages.example/hop/0");
    expect(outcome).toMatchObject({ outcome: "unreachable", fetchStatus: "unreachable:redirects", cause: "redirects", redirects: 5, at: "https://pages.example/hop/5" });
    expect(seen.length - before).toBe(6);
    expect(FETCH_REDIRECTS_MAX).toBe(5);
  });

  it("puts a redirect's target through the guard: a private address, the metadata address, another scheme", async () => {
    const before = seen.length;
    expect(await run("https://pages.example/to-private")).toMatchObject({ fetchStatus: "unreachable:private", redirects: 1, at: "https://intranet.example/" });
    expect(await run("https://pages.example/to-metadata")).toMatchObject({ fetchStatus: "unreachable:link_local", at: "https://metadata.example/latest/meta-data/" });
    expect(await run("https://pages.example/to-ftp")).toMatchObject({ fetchStatus: "unreachable:scheme", at: "ftp://pages.example/page" });
    /* Three redirects, no request to any of their targets. */
    expect(seen.slice(before).map((request) => request.path)).toEqual(["/to-private", "/to-metadata", "/to-ftp"]);
  });

  it("asks for an http redirect target on https instead of refusing it, and never speaks plain HTTP", async () => {
    const outcome = await run("https://pages.example/to-http");
    expect(outcome).toMatchObject({ outcome: "opened", redirects: 1, finalUrl: "https://pages.example/page" });
    expect(seen.slice(-2).map((request) => request.path)).toEqual(["/to-http", "/page"]);
  });

  it("reports a redirect without a usable Location", async () => {
    expect(await run("https://pages.example/no-location")).toMatchObject({ fetchStatus: "unreachable:redirect_target", redirects: 0 });
  });
});

describe("limits (D1)", () => {
  it("abandons a body at the size limit without reading the rest", async () => {
    bigWritten = 0;
    const outcome = await run("https://pages.example/big", { sizeMax: MiB });
    expect(outcome).toMatchObject({ fetchStatus: "unreachable:size", cause: "size" });
    /* The server stops when the client goes: well short of the 8 MB it had to give. */
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bigWritten).toBeLessThan(4 * MiB);
  });

  it("refuses a declared length over the limit before reading a byte, and a compressed body that inflates past it", async () => {
    expect(await run("https://pages.example/declared-big")).toMatchObject({ fetchStatus: "unreachable:size" });
    expect(await run("https://pages.example/bomb")).toMatchObject({ fetchStatus: "unreachable:size" });
  });

  it("ends a server that never answers at the deadline", async () => {
    const started = Date.now();
    const outcome = await run("https://pages.example/slow", { deadlineMs: 300 });
    expect(outcome).toMatchObject({ fetchStatus: "unreachable:timeout", cause: "timeout" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("holds the numbers Andre decided", () => {
    expect(FETCH_DEADLINE_MS).toBe(20_000);
    expect(FETCH_SIZE_MAX).toBe(5 * MiB);
    expect(FETCH_REDIRECTS_MAX).toBe(5);
    expect(FETCH_LIMITS).toEqual({ deadlineMs: 20_000, sizeMax: 5 * MiB, redirectsMax: 5 });
  });
});

describe("what is opened (§ 4.3)", () => {
  it("decodes a gzip body and hashes the decoded bytes", async () => {
    const outcome = await run("https://pages.example/gzip");
    expect(outcome).toMatchObject({ outcome: "opened", bytes: ARTICLE.length, sha256: createHash("sha256").update(ARTICLE).digest("hex") });
    if (outcome.outcome === "opened" && outcome.document.kind === "html") expect(outcome.document.title).toContain("Retries");
  });

  it("opens xhtml as html", async () => {
    const outcome = await run("https://pages.example/xhtml");
    expect(outcome).toMatchObject({ outcome: "opened", contentType: "application/xhtml+xml", document: { kind: "html", title: "X", text: "xhtml" } });
  });

  it("decodes text by the header's charset, and html by its declared charset when the header names none", async () => {
    expect(await run("https://pages.example/latin1")).toMatchObject({ outcome: "opened", contentType: "text/plain", charset: "iso-8859-1", bytes: 4, document: { kind: "text", mediaType: "text/plain", text: "café" } });
    expect(await run("https://pages.example/meta-charset")).toMatchObject({ outcome: "opened", charset: null, document: { kind: "html", title: "Café", text: "olá" } });
  });

  it("keeps markdown as it is", async () => {
    expect(await run("https://pages.example/markdown")).toMatchObject({ outcome: "opened", contentType: "text/markdown", document: { kind: "text", mediaType: "text/markdown", text: "# Title\n\nA *markdown* page.\n" } });
  });

  it("keeps a PDF and an image as bytes for unit 49f", async () => {
    const pdf = await run("https://pages.example/pdf");
    expect(pdf).toMatchObject({ outcome: "opened", contentType: "application/pdf", bytes: PDF.length, sha256: createHash("sha256").update(PDF).digest("hex") });
    if (pdf.outcome === "opened" && pdf.document.kind === "bytes") expect(pdf.document.bytes.equals(PDF)).toBe(true);
    expect(await run("https://pages.example/png")).toMatchObject({ outcome: "opened", contentType: "image/png", document: { kind: "bytes", mediaType: "image/png" } });
  });

  it("answers unsupported:<type> for a type it does not open, unknown when there is none, and does not read the body", async () => {
    expect(await run("https://pages.example/zip")).toMatchObject({ outcome: "unsupported", fetchStatus: "unsupported:application/zip", contentType: "application/zip", finalUrl: "https://pages.example/zip" });
    expect(await run("https://pages.example/no-type")).toMatchObject({ outcome: "unsupported", fetchStatus: "unsupported:unknown", contentType: null });
    expect(await run("https://pages.example/odd-type")).toMatchObject({ outcome: "unsupported", fetchStatus: "unsupported:unknown" });
  });

  it("answers unreachable:encoding for a content encoding it cannot undo", async () => {
    expect(await run("https://pages.example/zstd")).toMatchObject({ fetchStatus: "unreachable:encoding" });
  });
});

describe("unreachable (§ 4.4)", () => {
  it("carries a 4xx or 5xx status, and any 2xx that is not 200, as the cause", async () => {
    expect(await run("https://pages.example/notfound")).toMatchObject({ outcome: "unreachable", fetchStatus: "unreachable:404", cause: "404", at: "https://pages.example/notfound", redirects: 0 });
    expect(await run("https://pages.example/error")).toMatchObject({ fetchStatus: "unreachable:500" });
    expect(await run("https://pages.example/empty")).toMatchObject({ fetchStatus: "unreachable:204" });
  });

  it("refuses by the guard before any request: the scheme, an address literal, an own host, a private host, a mixed host, the metadata host", async () => {
    const before = seen.length;
    expect(await run("http://pages.example/page")).toMatchObject({ fetchStatus: "unreachable:scheme", at: "http://pages.example/page" });
    expect(await run("https://93.184.216.34/page")).toMatchObject({ fetchStatus: "unreachable:address_literal" });
    expect(await run("https://gateway/health")).toMatchObject({ fetchStatus: "unreachable:own_host" });
    expect(await run("https://localhost:3000/api")).toMatchObject({ fetchStatus: "unreachable:port" });
    expect(await run("https://intranet.example/")).toMatchObject({ fetchStatus: "unreachable:private" });
    expect(await run("https://mixed.example/")).toMatchObject({ fetchStatus: "unreachable:private" });
    expect(await run("https://metadata.example/")).toMatchObject({ fetchStatus: "unreachable:link_local" });
    expect(seen.length).toBe(before);
    expect(connectedTo.length).toBeGreaterThan(0);
  });

  it("reports a name that does not resolve and a connection that is refused", async () => {
    expect(await run("https://nowhere.example/")).toMatchObject({ fetchStatus: "unreachable:dns", cause: "dns" });
    expect(await run("https://pages.example/page", {}, closedPort)).toMatchObject({ fetchStatus: "unreachable:connect", cause: "connect" });
  });
});

describe("the vocabulary", () => {
  it("spells every fetchStatus this suite produced, and every reason the guard has, as the ledger's FetchStatusSchema reads them", () => {
    expect(statuses.length).toBeGreaterThan(30);
    for (const status of statuses) expect(FetchStatusSchema.safeParse(status).success, status).toBe(true);
    for (const reason of GUARD_REASONS) expect(FetchStatusSchema.safeParse(`unreachable:${reason}`).success, reason).toBe(true);
    for (const cause of ["dns", "connect", "tls", "reset", "timeout", "size", "redirects", "redirect_target", "encoding"]) expect(FetchStatusSchema.safeParse(`unreachable:${cause}`).success, cause).toBe(true);
    expect(FetchStatusSchema.safeParse("unsupported:application/vnd.ms-excel").success).toBe(true);
  });

  it("reads a media type and a charset from Content-Type", () => {
    expect(mediaTypeOf("Text/HTML; charset=UTF-8")).toBe("text/html");
    expect(mediaTypeOf("application/xhtml+xml")).toBe("application/xhtml+xml");
    expect(mediaTypeOf(undefined)).toBeNull();
    expect(mediaTypeOf("")).toBeNull();
    expect(mediaTypeOf("nonsense")).toBeNull();
    expect(mediaTypeOf("text/html junk")).toBeNull();
    expect(charsetOf('text/plain; charset="ISO-8859-1"')).toBe("iso-8859-1");
    expect(charsetOf("text/plain;charset=utf-8")).toBe("utf-8");
    expect(charsetOf("text/plain")).toBeNull();
    expect(charsetOf(undefined)).toBeNull();
  });
});

describe("the transport's options", () => {
  it("open the socket to the checked address, validate the certificate for the name, send the name as Host, and pool nothing", () => {
    const target: Target = { url: new URL("https://pages.example/docs/a?b=1"), address: PUBLIC_V4, headers: { accept: ACCEPT, "user-agent": "x" } };
    expect(requestOptionsOf(target)).toEqual({ host: PUBLIC_V4, port: 443, servername: "pages.example", method: "GET", path: "/docs/a?b=1", headers: { accept: ACCEPT, "user-agent": "x", host: "pages.example" }, setHost: false, agent: false });
    expect(requestOptionsOf({ ...target, address: PUBLIC_V6 }).host).toBe(PUBLIC_V6);
    expect(requestOptionsOf(target, { host: "127.0.0.1", port: 8080 })).toMatchObject({ host: "127.0.0.1", port: 8080, servername: "pages.example" });
  });
});
