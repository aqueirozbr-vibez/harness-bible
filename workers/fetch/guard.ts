import { isIP } from "node:net";

/*
 * The guard of the evidence fetcher (feature-specs/32 § 4.1): pure, tested without a network. It answers two
 * questions and nothing else — may this URL be asked for, and may these addresses be connected to — so that the
 * one way out of the deployment (fetch.ts) reads as resolve, check, connect, and a redirect is a URL that comes
 * back to the first question. What is refused: anything but `https` on 443, credentials in the URL, an address
 * written as a literal, a name of the deployment's own (APP_URL, the gateway, the workers, the engine, the store,
 * the database, the policy engine, the identity provider), a single-label name as compose gives its services, a
 * name under the suffixes that never leave a network, and every address that is not public — loopback, private,
 * link-local (the cloud metadata address lives there), carrier-grade NAT, multicast, unspecified, the reserved and
 * documentation blocks, and the IPv6 equivalents with the tunnelled and mapped forms checked for the IPv4 address
 * they carry. One refused address among several refuses the host: a name that answers a public address to one
 * resolver and a private one to another is the attack, not an edge case.
 *
 * The reasons are the words of `fetchStatus` (`unreachable:<reason>`, feature-specs/32 § 4.4), held to the ledger's
 * `FetchStatusSchema` by fetch.test.ts: lowercase letters, digits and underscores.
 */

export const GUARD_REASONS = [
  "url", // not a URL at all
  "scheme",
  "port",
  "credentials",
  "address_literal",
  "single_label",
  "internal_name",
  "own_host",
  "no_address",
  "invalid_address",
  "unspecified",
  "loopback",
  "private",
  "link_local",
  "carrier_grade_nat",
  "multicast",
  "broadcast",
  "reserved",
  "documentation",
  "benchmarking",
  "unique_local",
  "site_local",
  "discard",
  "teredo",
  "orchid",
] as const;

export type GuardReason = (typeof GUARD_REASONS)[number];

export type Guarded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: GuardReason };

const refused = (reason: GuardReason): Guarded<never> => ({ ok: false, reason });

/** Names under these suffixes never leave a network: the loopback name, mDNS, the private-use TLDs and the reverse zones. */
const INTERNAL_SUFFIXES: ReadonlyArray<string> = ["localhost", "local", "internal", "localdomain", "arpa"];

/**
 * The URL as the fetcher may ask for it: `https` on its own port, no credentials, a host name with a dot that is
 * not an address, not one of the deployment's own and not under an internal suffix. The fragment is dropped, as a
 * browser drops it; everything else is kept as the URL parser normalised it.
 */
export function checkUrl(raw: string, own: ReadonlySet<string>): Guarded<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refused("url");
  }
  if (url.protocol !== "https:") return refused("scheme");
  /* The parser drops the protocol's own port, so any port left is another one. */
  if (url.port !== "") return refused("port");
  if (url.username !== "" || url.password !== "") return refused("credentials");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return refused("url");
  /* An IPv6 literal keeps its brackets in `hostname`; a decimal, octal or hex IPv4 form is normalised to dotted by the parser. */
  if (host.startsWith("[") || isIP(host) !== 0) return refused("address_literal");
  if (own.has(host)) return refused("own_host");
  if (!host.includes(".")) return refused("single_label");
  if (INTERNAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return refused("internal_name");
  url.hash = "";
  return { ok: true, value: url };
}

type Bytes = ReadonlyArray<number>;

interface Range {
  readonly prefix: Bytes;
  readonly bits: number;
  readonly reason: GuardReason;
}

const v4 = (a: number, b: number, c: number, d: number, bits: number, reason: GuardReason): Range => ({ prefix: [a, b, c, d], bits, reason });

/** IPv4, in the order the first match decides (the broadcast address sits inside the reserved /4). */
const IPV4_RANGES: ReadonlyArray<Range> = [
  v4(255, 255, 255, 255, 32, "broadcast"),
  v4(0, 0, 0, 0, 8, "unspecified"),
  v4(10, 0, 0, 0, 8, "private"),
  v4(100, 64, 0, 0, 10, "carrier_grade_nat"),
  v4(127, 0, 0, 0, 8, "loopback"),
  v4(169, 254, 0, 0, 16, "link_local"),
  v4(172, 16, 0, 0, 12, "private"),
  v4(192, 0, 0, 0, 24, "reserved"), // IETF protocol assignments, DS-Lite among them
  v4(192, 0, 2, 0, 24, "documentation"),
  v4(192, 88, 99, 0, 24, "reserved"), // the 6to4 relay anycast, deprecated
  v4(192, 168, 0, 0, 16, "private"),
  v4(198, 18, 0, 0, 15, "benchmarking"),
  v4(198, 51, 100, 0, 24, "documentation"),
  v4(203, 0, 113, 0, 24, "documentation"),
  v4(224, 0, 0, 0, 4, "multicast"),
  v4(240, 0, 0, 0, 4, "reserved"),
];

function v6(groups: ReadonlyArray<number>, bits: number, reason: GuardReason): Range {
  const prefix: number[] = [];
  for (const group of groups) prefix.push(group >> 8, group & 0xff);
  while (prefix.length < 16) prefix.push(0);
  return { prefix, bits, reason };
}

/** IPv6 blocks refused outright; the forms that carry an IPv4 address are handled by `embeddedIPv4` first. */
const IPV6_RANGES: ReadonlyArray<Range> = [
  v6([0, 0, 0, 0, 0, 0, 0, 0], 128, "unspecified"),
  v6([0, 0, 0, 0, 0, 0, 0, 1], 128, "loopback"),
  v6([0x64, 0xff9b, 1], 48, "reserved"), // local-use NAT64
  v6([0x100], 64, "discard"),
  v6([0x2001, 0], 32, "teredo"), // a tunnel whose client address is obfuscated: it cannot be checked, so it is refused
  v6([0x2001, 0x10], 28, "orchid"),
  v6([0x2001, 0x20], 28, "orchid"),
  v6([0x2001, 0xdb8], 32, "documentation"),
  v6([0x3fff], 20, "documentation"),
  v6([0x5f00], 16, "reserved"), // segment routing
  v6([0xfc00], 7, "unique_local"),
  v6([0xfe80], 10, "link_local"),
  v6([0xfec0], 10, "site_local"),
  v6([0xff00], 8, "multicast"),
];

function inRange(address: Bytes, range: Range): boolean {
  const whole = range.bits >> 3;
  for (let index = 0; index < whole; index++) if (address[index] !== range.prefix[index]) return false;
  const rest = range.bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((address[whole] ?? 0) & mask) === ((range.prefix[whole] ?? 0) & mask);
}

function parseIPv4(address: string): Bytes | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

/** The sixteen bytes of an IPv6 address, with `::` expanded and a dotted IPv4 tail taken as its last four. */
function parseIPv6(address: string): Bytes | null {
  const bare = address.split("%")[0] ?? ""; // a zone id names an interface; the address is what is checked
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (text: string): number[] | null => {
    if (text === "") return [];
    const words: number[] = [];
    const pieces = text.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (index === pieces.length - 1 && piece.includes(".")) {
        const tail = parseIPv4(piece);
        if (tail === null) return null;
        words.push(((tail[0] ?? 0) << 8) | (tail[1] ?? 0), ((tail[2] ?? 0) << 8) | (tail[3] ?? 0));
      } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
        words.push(parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return words;
  };
  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const words = [...head, ...new Array<number>(missing).fill(0), ...tail];
  const bytes: number[] = [];
  for (const word of words) bytes.push(word >> 8, word & 0xff);
  return bytes;
}

interface Embedded {
  readonly address: Bytes;
  /** The mapped, NAT64 and 6to4 forms reach their IPv4 address; the deprecated compatible form reaches nothing. */
  readonly routable: boolean;
}

/** The IPv4 address an IPv6 one carries, when it is a mapped, compatible, NAT64 or 6to4 form; the check is then that address's. */
function embeddedIPv4(bytes: Bytes): Embedded | null {
  const zeroTo = (end: number): boolean => bytes.slice(0, end).every((byte) => byte === 0);
  if (zeroTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) return { address: bytes.slice(12), routable: true }; // ::ffff:a.b.c.d
  if (zeroTo(12) && !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && (bytes[15] ?? 0) <= 1)) return { address: bytes.slice(12), routable: false }; // ::a.b.c.d
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((byte) => byte === 0)) return { address: bytes.slice(12), routable: true }; // 64:ff9b::a.b.c.d
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return { address: bytes.slice(2, 6), routable: true }; // 2002:abcd:ef01::/48
  return null;
}

function classifyIPv4(bytes: Bytes): GuardReason | null {
  for (const range of IPV4_RANGES) if (inRange(bytes, range)) return range.reason;
  return null;
}

/** The reason an address may not be connected to, or null when it is public. */
export function checkAddress(address: string): GuardReason | null {
  const family = isIP(address.split("%")[0] ?? "");
  if (family === 4) {
    const bytes = parseIPv4(address);
    return bytes === null ? "invalid_address" : classifyIPv4(bytes);
  }
  if (family === 6) {
    const bytes = parseIPv6(address);
    if (bytes === null) return "invalid_address";
    const embedded = embeddedIPv4(bytes);
    if (embedded !== null) return classifyIPv4(embedded.address) ?? (embedded.routable ? null : "reserved");
    for (const range of IPV6_RANGES) if (inRange(bytes, range)) return range.reason;
    return null;
  }
  return "invalid_address";
}

/** Every address a host resolved to must be public, and there must be at least one. */
export function checkAddresses(addresses: ReadonlyArray<string>): Guarded<ReadonlyArray<string>> {
  if (addresses.length === 0) return refused("no_address");
  for (const address of addresses) {
    const reason = checkAddress(address);
    if (reason !== null) return refused(reason);
  }
  return { ok: true, value: addresses };
}

/**
 * The deployment's own host names from the values that name them (URLs, or `host:port` as the engine's address is
 * written), lowercased, without brackets; a value that does not parse names nothing. These are refused by name
 * whatever they resolve to (§ 4.1).
 */
export function ownHostsOf(values: ReadonlyArray<string | undefined>): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const value of values) {
    if (value === undefined || value === "") continue;
    const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `tcp://${value}`;
    try {
      const host = new URL(text).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
      if (host !== "") hosts.add(host);
    } catch {
      /* not a host */
    }
  }
  return hosts;
}

/**
 * A redirect's target as a URL to put through `checkUrl` again, or null when the header is not one. A target on
 * `http:` is asked for on `https:` instead, same host, same path: resolvers and short links still hop through plain
 * HTTP on their way to a page (doi.org does), and the fetcher never speaks it; a host that does not serve TLS is
 * then `unreachable` at the connection, which is the truth of it. The port written for plain HTTP is dropped with
 * the scheme; any other port stays and is refused next.
 */
export function redirectTarget(from: URL, location: string | undefined): string | null {
  if (location === undefined || location.trim() === "") return null;
  try {
    const target = new URL(location.trim(), from);
    if (target.protocol === "http:") {
      if (target.port === "" || target.port === "80") target.port = "";
      target.protocol = "https:";
    }
    return target.href;
  } catch {
    return null;
  }
}
