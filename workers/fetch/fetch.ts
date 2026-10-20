import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import type { Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { env } from "@/lib/env";

import { checkAddresses, checkUrl, ownHostsOf, redirectTarget, type GuardReason } from "./guard";
import { decodeDocument, extractHtml, type HtmlDocument } from "./html";
import { httpsTransport, type Transport, type TransportResponse } from "./transport";

/*
 * The one function that leaves the deployment for a URL a stranger chose (feature-specs/32 § 4; architecture § 2.2,
 * invariant 34): `fetchEvidence`. It runs in the workers alone — lint keeps `workers/fetch/` out of the web tier —
 * and it is read as resolve, check, connect: the URL through the guard, the name resolved, every address checked,
 * the socket opened to the address that was checked with the name as SNI and `Host` (transport.ts), and a redirect
 * taken back to the first step, at most FETCH_REDIRECTS_MAX times. The request carries no cookie, no credential
 * and no referrer, a fixed `User-Agent` that names the product and where it comes from, and `Accept` for the types
 * § 4.3 opens; the body is read as a stream and abandoned at FETCH_SIZE_MAX, and the whole fetch — every redirect
 * and the body — is under FETCH_DEADLINE_MS. Nothing a page asks for is fetched: no script, no image, no frame.
 *
 * What comes back is one of three outcomes, each carrying the `fetchStatus` the evidence row stores (§ 4.4):
 * `opened:200` with the document (HTML to its title, text, date and canonical URL; plain text and markdown as
 * they are; PDF, PNG and JPEG as bytes for unit 49f), `unsupported:<type>` for a type § 4.3 does not open, and
 * `unreachable:<cause>` for everything else — a status, a refusal of the guard by its reason, the deadline, the
 * size, too many redirects, a connection or certificate failure. The function never throws for anything the
 * network or the page did; a throw is a defect of this code.
 *
 * The three numbers are Andre's (feature-specs/32 D1, decided 2026-10-06 on the recommendation): 20 s, 5 MB and
 * 5 redirects. The deadline is the product's own for a call that includes someone else's network
 * (`/gateway/check`, feature-specs/11 § 7.2); 5 MB is far above an article's HTML and under what the store and the
 * grader should carry; five redirects covers a DOI's chain.
 */

/** D1: the whole fetch, redirects and body included. */
export const FETCH_DEADLINE_MS = 20_000;
/** D1: the body after its content encoding is undone; 5 MB, 1024 to the kilobyte as the gates count. */
export const FETCH_SIZE_MAX = 5 * 1024 * 1024;
/** D1: redirects followed; the one after is `unreachable:redirects`. */
export const FETCH_REDIRECTS_MAX = 5;

export interface FetchLimits {
  readonly deadlineMs: number;
  readonly sizeMax: number;
  readonly redirectsMax: number;
}

export const FETCH_LIMITS: FetchLimits = { deadlineMs: FETCH_DEADLINE_MS, sizeMax: FETCH_SIZE_MAX, redirectsMax: FETCH_REDIRECTS_MAX };

/** The types § 4.3 opens, and nothing else: a server that honours `Accept` answers 406 to a page of another type. */
export const ACCEPT = "text/html, application/xhtml+xml, text/plain, text/markdown, application/pdf, image/png, image/jpeg";

/** Names the product and where it comes from, so a publisher can tell what opened their page (§ 4.2). */
export function userAgentOf(appUrl: string): string {
  return `Harness-Bible-Evidence/0.1 (+${appUrl})`;
}

export type TextMediaType = "text/plain" | "text/markdown";
export type BytesMediaType = "application/pdf" | "image/png" | "image/jpeg";

export type Document =
  | ({ readonly kind: "html" } & HtmlDocument)
  | { readonly kind: "text"; readonly mediaType: TextMediaType; readonly text: string }
  | { readonly kind: "bytes"; readonly mediaType: BytesMediaType; readonly bytes: Buffer }
  /** Only when the caller asked for JSON (`FetchOptions.accept`): a metadata record, never a page. */
  | { readonly kind: "json"; readonly mediaType: string; readonly text: string };

/**
 * What a caller may vary per fetch: the `Accept` it sends. A caller that asks for a JSON type — the DOI opener
 * asking doi.org for a CSL record (doi.ts) — is answered JSON as a `json` document; without it a JSON response is
 * `unsupported:<type>`, as § 4.3 has it for a page.
 */
export interface FetchOptions {
  readonly accept?: string;
}

const JSON_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json$/;

const OPENED: Readonly<Record<string, Document["kind"]>> = {
  "text/html": "html",
  "application/xhtml+xml": "html",
  "text/plain": "text",
  "text/markdown": "text",
  "application/pdf": "bytes",
  "image/png": "bytes",
  "image/jpeg": "bytes",
};

export type NetworkCause = "dns" | "connect" | "tls" | "reset" | "timeout" | "size" | "redirects" | "redirect_target" | "encoding";
export type FetchCause = GuardReason | NetworkCause | `${number}`;

interface Common {
  /** As it was asked for. */
  readonly url: string;
  readonly fetchedAt: Date;
  readonly redirects: number;
}

export interface Opened extends Common {
  readonly outcome: "opened";
  readonly fetchStatus: "opened:200";
  readonly finalUrl: string;
  readonly contentType: string;
  /** The charset the response's `Content-Type` named, lowercased; null when it named none (the source is stored with it, unit 49f). */
  readonly charset: string | null;
  /** Of the body as stored and hashed: after the content encoding, before any character decoding. */
  readonly bytes: number;
  readonly sha256: string;
  /** The body itself, for the item's `source` object (32 § 5); at most FETCH_SIZE_MAX. */
  readonly body: Buffer;
  readonly document: Document;
}

export interface Unsupported extends Common {
  readonly outcome: "unsupported";
  readonly fetchStatus: `unsupported:${string}`;
  readonly finalUrl: string;
  readonly contentType: string | null;
}

export interface Unreachable extends Common {
  readonly outcome: "unreachable";
  readonly fetchStatus: `unreachable:${string}`;
  readonly cause: FetchCause;
  /** The URL at which it failed: the last of a redirect chain. */
  readonly at: string;
}

export type FetchOutcome = Opened | Unsupported | Unreachable;

export interface FetchDeps {
  /** Every address the name resolves to; rejects when it resolves to none. */
  readonly resolve: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly transport: Transport;
  /** The deployment's own host names (guard.ts `ownHostsOf`). */
  readonly own: ReadonlySet<string>;
  readonly userAgent: string;
  readonly limits: FetchLimits;
  readonly now: () => Date;
}

export function defaultFetchDeps(): FetchDeps {
  return {
    resolve: async (hostname) => (await dns.lookup(hostname, { all: true, order: "ipv4first" })).map((entry) => entry.address),
    transport: httpsTransport,
    own: ownHostsOf([env.APP_URL, env.GATEWAY_URL, env.WORKERS_URL, env.TEMPORAL_ADDRESS, env.OPA_URL, env.DATABASE_URL, env.KEYCLOAK_ISSUER]),
    userAgent: userAgentOf(env.APP_URL),
    limits: FETCH_LIMITS,
    now: () => new Date(),
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const headerOf = (value: string | ReadonlyArray<string> | undefined): string | undefined => (Array.isArray(value) ? value[0] : (value as string | undefined));

const TOKEN = String.raw`[a-z0-9][a-z0-9!#$&^_.+-]*`;
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}$`);

/** The media type of a `Content-Type`, lowercased and without its parameters; null when the header is absent or not one. */
export function mediaTypeOf(contentType: string | undefined): string | null {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return MEDIA_TYPE.test(type) ? type : null;
}

/** The charset parameter of a `Content-Type`, lowercased; null when it names none. */
export function charsetOf(contentType: string | undefined): string | null {
  const match = /;\s*charset\s*=\s*"?([a-z0-9_:.-]+)"?/i.exec(contentType ?? "");
  return match === null ? null : (match[1] ?? "").toLowerCase();
}

/** The type as `fetchStatus` carries it (`unsupported:<type>`): the ledger's pattern allows letters, digits, `.`, `+`, `/` and `-`. */
const statusTypeOf = (mediaType: string | null): string => (mediaType ?? "unknown").replace(/[^a-z0-9.+/-]/g, "-");

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly cause: FetchCause };

function causeOf(error: unknown, signal: AbortSignal): NetworkCause {
  if (signal.aborted) return "timeout";
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (/CERT|TLS|SSL|EPROTO|HOSTNAME_MISMATCH|UNABLE_TO|SELF_SIGNED|DEPTH_ZERO/.test(code)) return "tls";
  if (code === "ECONNRESET" || code === "EPIPE") return "reset";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  return "connect";
}

/** The checked addresses in order until one answers; a certificate failure or the deadline ends the attempts at once. */
async function connect(transport: Transport, url: URL, addresses: ReadonlyArray<string>, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<Attempt<TransportResponse>> {
  let cause: FetchCause = "connect";
  for (const address of addresses) {
    if (signal.aborted) return { ok: false, cause: "timeout" };
    try {
      return { ok: true, value: await transport.request({ url, address, headers }, signal) };
    } catch (error: unknown) {
      cause = causeOf(error, signal);
      if (cause === "timeout" || cause === "tls") return { ok: false, cause };
    }
  }
  return { ok: false, cause };
}

const DECODERS: Readonly<Record<string, (() => Transform) | null>> = { identity: null, "": null, gzip: createGunzip, "x-gzip": createGunzip, deflate: createInflate, br: createBrotliDecompress };

function through(source: Readable, transform: Transform): Readable {
  source.on("error", (error: Error) => transform.destroy(error));
  return source.pipe(transform);
}

/** The body as a stream, decoded from its content encoding and abandoned the moment it passes the size limit. */
async function readBody(response: TransportResponse, sizeMax: number, signal: AbortSignal): Promise<Attempt<Buffer>> {
  const declared = Number(headerOf(response.headers["content-length"]));
  if (Number.isFinite(declared) && declared > sizeMax) {
    response.body.destroy();
    return { ok: false, cause: "size" };
  }
  const encoding = (headerOf(response.headers["content-encoding"]) ?? "").trim().toLowerCase();
  const decoder = DECODERS[encoding];
  if (decoder === undefined) {
    response.body.destroy();
    return { ok: false, cause: "encoding" };
  }
  const stream = decoder === null ? response.body : through(response.body, decoder());
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > sizeMax) {
        response.body.destroy();
        return { ok: false, cause: "size" };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, cause: signal.aborted ? "timeout" : decoder === null ? "reset" : "encoding" };
  }
  return { ok: true, value: Buffer.concat(chunks) };
}

function documentOf(kind: Document["kind"], mediaType: string, bytes: Buffer, charset: string | null, finalUrl: string): Document {
  if (kind === "bytes") return { kind, mediaType: mediaType as BytesMediaType, bytes };
  const text = decodeDocument(bytes, charset, kind === "html");
  if (kind === "html") return { kind, ...extractHtml(text, finalUrl) };
  if (kind === "json") return { kind, mediaType, text };
  return { kind, mediaType: mediaType as TextMediaType, text };
}

/** The one way out: § 4 end to end. */
export async function fetchEvidence(raw: string, deps: FetchDeps = defaultFetchDeps(), options: FetchOptions = {}): Promise<FetchOutcome> {
  const fetchedAt = deps.now();
  const accept = options.accept ?? ACCEPT;
  const kindOf = (mediaType: string): Document["kind"] | undefined => OPENED[mediaType] ?? (options.accept !== undefined && JSON_TYPE.test(mediaType) ? "json" : undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.limits.deadlineMs);
  const common = (redirects: number): Common => ({ url: raw, fetchedAt, redirects });
  const unreachable = (cause: FetchCause, at: string, redirects: number): Unreachable => ({ outcome: "unreachable", fetchStatus: `unreachable:${cause}`, cause, at, ...common(redirects) });
  const headers = { "user-agent": deps.userAgent, accept, "accept-encoding": "gzip, deflate, br", connection: "close" };
  try {
    let current = raw;
    for (let redirects = 0; ; redirects++) {
      const checked = checkUrl(current, deps.own);
      if (!checked.ok) return unreachable(checked.reason, current, redirects);
      const url = checked.value;

      let addresses: ReadonlyArray<string>;
      try {
        addresses = await deps.resolve(url.hostname);
      } catch {
        return unreachable("dns", url.href, redirects);
      }
      const guarded = checkAddresses(addresses);
      if (!guarded.ok) return unreachable(guarded.reason, url.href, redirects);

      const connected = await connect(deps.transport, url, guarded.value, headers, controller.signal);
      if (!connected.ok) return unreachable(connected.cause, url.href, redirects);
      const response = connected.value;

      if (REDIRECTS.has(response.status)) {
        response.body.destroy();
        if (redirects >= deps.limits.redirectsMax) return unreachable("redirects", url.href, redirects);
        const target = redirectTarget(url, headerOf(response.headers.location));
        if (target === null) return unreachable("redirect_target", url.href, redirects);
        current = target;
        continue;
      }
      if (response.status !== 200) {
        response.body.destroy();
        return unreachable(`${response.status}`, url.href, redirects);
      }

      const contentType = headerOf(response.headers["content-type"]);
      const mediaType = mediaTypeOf(contentType);
      const kind = mediaType === null ? undefined : kindOf(mediaType);
      if (mediaType === null || kind === undefined) {
        response.body.destroy();
        return { outcome: "unsupported", fetchStatus: `unsupported:${statusTypeOf(mediaType)}`, finalUrl: url.href, contentType: mediaType, ...common(redirects) };
      }

      const body = await readBody(response, deps.limits.sizeMax, controller.signal);
      if (!body.ok) return unreachable(body.cause, url.href, redirects);
      return {
        outcome: "opened",
        fetchStatus: "opened:200",
        finalUrl: url.href,
        contentType: mediaType,
        charset: charsetOf(contentType),
        bytes: body.value.length,
        sha256: createHash("sha256").update(body.value).digest("hex"),
        body: body.value,
        document: documentOf(kind, mediaType, body.value, charsetOf(contentType), url.href),
        ...common(redirects),
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
