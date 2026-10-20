import { describe, expect, it } from "vitest";

import { GUARD_REASONS, checkAddress, checkAddresses, checkUrl, ownHostsOf, redirectTarget, type GuardReason } from "./guard";

/*
 * The fetcher's guard without a network (feature-specs/32 § 4.1, § 13.1): every refused range in IPv4 and IPv6,
 * the forms of IPv6 that carry an IPv4 address, a host with one public and one private address, and each refusal
 * of the URL itself — the scheme, a port, credentials, an address literal, a single label, an internal suffix and
 * every one of the deployment's own hosts.
 */

const OWN = ownHostsOf(["http://localhost:3000", "http://gateway:4000", "http://workers:4002", "temporal:7233", "http://127.0.0.1:8181", "postgresql://hb:hb@db:5432/harness_bible", "http://keycloak:8080/realms/hb", undefined, "", "not a url at all"]);

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";

describe("checkUrl", () => {
  it("accepts an https URL on its own port, with its fragment dropped and nothing else changed", () => {
    const checked = checkUrl("https://Provider-Two.example/pricing?plan=team#top", OWN);
    expect(checked).toMatchObject({ ok: true });
    if (checked.ok) expect(checked.value.href).toBe("https://provider-two.example/pricing?plan=team");
    expect(checkUrl("https://provider-two.example:443/", OWN)).toMatchObject({ ok: true });
  });

  it.each<[string, GuardReason]>([
    ["not a url", "url"],
    ["https://", "url"],
    ["http://provider-two.example/pricing", "scheme"],
    ["ftp://provider-two.example/pricing", "scheme"],
    ["file:///etc/hosts", "scheme"],
    ["https://provider-two.example:8443/pricing", "port"],
    ["https://provider-two.example:80/pricing", "port"],
    ["https://user:secret@provider-two.example/pricing", "credentials"],
    ["https://user@provider-two.example/pricing", "credentials"],
    ["https://93.184.216.34/pricing", "address_literal"],
    ["https://[2606:2800:21f:cb07::1]/pricing", "address_literal"],
    ["https://[::1]/", "address_literal"],
    ["https://2130706433/", "address_literal"], // 127.0.0.1 written as a number
    ["https://0x7f000001/", "address_literal"],
    ["https://0177.0.0.1/", "address_literal"],
    ["https://embeddings/health", "single_label"], // a compose service the own set does not name
    ["https://intranet/", "single_label"],
    ["https://localhost/", "own_host"],
    ["https://localhost./", "own_host"],
    ["https://LOCALHOST:443/api", "own_host"],
    ["https://workers/", "own_host"],
    ["https://db/", "own_host"],
    ["https://keycloak/realms/hb", "own_host"],
    ["https://127.0.0.1/", "address_literal"],
    ["https://api.localhost/", "internal_name"],
    ["https://printer.local/", "internal_name"],
    ["https://metadata.internal/", "internal_name"],
    ["https://1.0.0.127.in-addr.arpa/", "internal_name"],
  ])("refuses %s as %s", (url, reason) => {
    expect(checkUrl(url, OWN)).toEqual({ ok: false, reason });
  });

  it("refuses each of the deployment's own hosts by name, whatever they resolve to", () => {
    expect([...OWN].sort()).toEqual(["127.0.0.1", "db", "gateway", "keycloak", "localhost", "temporal", "workers"]);
    for (const host of OWN) expect(checkUrl(`https://${host}/`, OWN).ok, host).toBe(false);
  });
});

describe("checkAddress, IPv4", () => {
  it.each<[string, GuardReason | null]>([
    [PUBLIC_V4, null],
    ["8.8.8.8", null],
    ["1.1.1.1", null],
    ["200.160.2.3", null], // registro.br
    ["0.0.0.0", "unspecified"],
    ["0.255.255.255", "unspecified"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.254", "private"],
    ["172.32.0.1", null],
    ["172.15.255.255", null],
    ["192.168.1.1", "private"],
    ["192.167.255.255", null],
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback"],
    ["169.254.169.254", "link_local"], // the cloud metadata address
    ["169.254.0.1", "link_local"],
    ["169.253.255.255", null],
    ["100.64.0.1", "carrier_grade_nat"],
    ["100.127.255.255", "carrier_grade_nat"],
    ["100.128.0.1", null],
    ["100.63.255.255", null],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.254", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["192.0.0.1", "reserved"],
    ["192.0.0.170", "reserved"],
    ["192.0.2.44", "documentation"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["192.88.99.1", "reserved"],
    ["198.18.0.1", "benchmarking"],
    ["198.19.255.255", "benchmarking"],
    ["198.20.0.1", null],
    ["256.1.1.1", "invalid_address"],
    ["1.2.3", "invalid_address"],
    ["", "invalid_address"],
    ["pages.example", "invalid_address"],
  ])("%s → %s", (address, reason) => {
    expect(checkAddress(address)).toBe(reason);
  });
});

describe("checkAddress, IPv6", () => {
  it.each<[string, GuardReason | null]>([
    [PUBLIC_V6, null],
    ["2001:4860:4860::8888", null],
    ["2800:3f0:4001:80a::200e", null], // a Brazilian prefix
    ["::", "unspecified"],
    ["0:0:0:0:0:0:0:0", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["fe80::1", "link_local"],
    ["fe80::1%eth0", "link_local"],
    ["febf:ffff::1", "link_local"],
    ["fec0::1", "site_local"],
    ["fc00::1", "unique_local"],
    ["fd12:3456:789a::1", "unique_local"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "unique_local"],
    ["ff02::1", "multicast"],
    ["ff00::", "multicast"],
    ["100::1", "discard"],
    ["100::ffff:ffff:ffff:ffff", "discard"],
    ["2001::1", "teredo"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "teredo"],
    ["2001:10::1", "orchid"],
    ["2001:1f::1", "orchid"],
    ["2001:20::1", "orchid"],
    ["2001:2f::1", "orchid"],
    ["2001:30::1", null],
    ["2001:db8::1", "documentation"],
    ["2001:db8:ffff::1", "documentation"],
    ["3fff::1", "documentation"],
    ["5f00::1", "reserved"],
    ["64:ff9b:1::1", "reserved"],
    ["::ffff:127.0.0.1", "loopback"], // mapped: the IPv4 address decides
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:169.254.169.254", "link_local"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:93.184.216.34", null],
    ["::ffff:5db8:d822", null],
    ["::10.0.0.1", "private"], // compatible, deprecated: refused even for a public address
    ["::93.184.216.34", "reserved"],
    ["64:ff9b::10.0.0.1", "private"], // NAT64
    ["64:ff9b::127.0.0.1", "loopback"],
    ["64:ff9b::93.184.216.34", null],
    ["2002:7f00:1::1", "loopback"], // 6to4 of 127.0.0.1
    ["2002:a00:1::1", "private"],
    ["2002:a9fe:a9fe::1", "link_local"],
    ["2002:5db8:d822::1", null],
    ["2001:db8::g", "invalid_address"],
    ["1:2:3:4:5:6:7:8:9", "invalid_address"],
    ["1::2::3", "invalid_address"],
    ["::ffff:300.1.1.1", "invalid_address"],
  ])("%s → %s", (address, reason) => {
    expect(checkAddress(address)).toBe(reason);
  });
});

describe("checkAddresses", () => {
  it("passes a host whose every address is public", () => {
    expect(checkAddresses([PUBLIC_V4, PUBLIC_V6])).toEqual({ ok: true, value: [PUBLIC_V4, PUBLIC_V6] });
  });

  it("refuses a host that resolves to one public and one private address, naming the private one's class", () => {
    expect(checkAddresses([PUBLIC_V4, "10.0.0.5"])).toEqual({ ok: false, reason: "private" });
    expect(checkAddresses(["10.0.0.5", PUBLIC_V4])).toEqual({ ok: false, reason: "private" });
    expect(checkAddresses([PUBLIC_V6, "::1"])).toEqual({ ok: false, reason: "loopback" });
  });

  it("refuses a host that resolves to nothing", () => {
    expect(checkAddresses([])).toEqual({ ok: false, reason: "no_address" });
  });
});

describe("redirectTarget", () => {
  const from = new URL("https://provider-two.example/docs/pricing");

  it("resolves a relative or absolute Location against the page it came from", () => {
    expect(redirectTarget(from, "/pricing")).toBe("https://provider-two.example/pricing");
    expect(redirectTarget(from, "v2")).toBe("https://provider-two.example/docs/v2");
    expect(redirectTarget(from, " https://docs.provider-two.example/pricing ")).toBe("https://docs.provider-two.example/pricing");
  });

  it("asks for an http target on https, same host and path, with plain HTTP's port dropped and any other kept for checkUrl to refuse", () => {
    expect(redirectTarget(from, "http://www.doi.org/hb.html")).toBe("https://www.doi.org/hb.html");
    expect(redirectTarget(from, "http://pages.example:80/page?x=1")).toBe("https://pages.example/page?x=1");
    expect(redirectTarget(from, "http://pages.example:8080/page")).toBe("https://pages.example:8080/page");
    expect(redirectTarget(from, "http://10.0.0.5/")).toBe("https://10.0.0.5/"); // checkUrl refuses the literal next
    expect(redirectTarget(from, "ftp://pages.example/file")).toBe("ftp://pages.example/file"); // only http is upgraded; checkUrl refuses the rest
  });

  it("answers null to a missing or empty header", () => {
    expect(redirectTarget(from, undefined)).toBeNull();
    expect(redirectTarget(from, "  ")).toBeNull();
    expect(redirectTarget(from, "https://")).toBeNull();
  });
});

describe("the reasons", () => {
  it("are words of fetchStatus: lowercase letters, digits and underscores", () => {
    for (const reason of GUARD_REASONS) expect(reason).toMatch(/^[a-z0-9_]+$/);
    expect(new Set(GUARD_REASONS).size).toBe(GUARD_REASONS.length);
  });
});
