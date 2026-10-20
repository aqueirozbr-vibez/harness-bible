import { describe, expect, it } from "vitest";

import { allowedEmail, deviceOf, displayNameFor, hashToken, managesBook, resolveUser, safeNext, sessionExpiry, shortId, shouldExtend, shouldTouch } from "./rules";

describe("safeNext", () => {
  it("accepts locale-prefixed paths and refuses everything else", () => {
    expect(safeNext("/pt/ch/21/21.3", "en")).toBe("/pt/ch/21/21.3");
    expect(safeNext("/en", "pt")).toBe("/en");
    expect(safeNext("/en/search?q=a#x", "en")).toBe("/en/search?q=a#x");
    expect(safeNext("//evil.example", "en")).toBe("/en");
    expect(safeNext("https://evil.example/en/", "pt")).toBe("/pt");
    expect(safeNext("/api/v1/auth/dev", "en")).toBe("/en");
    expect(safeNext("/english", "en")).toBe("/en");
    expect(safeNext("/en\\evil", "en")).toBe("/en");
    expect(safeNext("/en/a b", "en")).toBe("/en");
    expect(safeNext(null, "pt")).toBe("/pt");
    expect(safeNext("", "en")).toBe("/en");
  });
});

describe("allowedEmail", () => {
  it("matches e-mails and domains, empty allows all", () => {
    expect(allowedEmail("a@x.io", "")).toBe(true);
    expect(allowedEmail("a@x.io", "@x.io, b@y.io")).toBe(true);
    expect(allowedEmail("B@Y.IO", "@x.io, b@y.io")).toBe(true);
    expect(allowedEmail("c@z.io", "@x.io, b@y.io")).toBe(false);
    expect(allowedEmail("a@xx.io", "@x.io")).toBe(false);
  });
});

describe("deviceOf", () => {
  it("summarises eight user agents", () => {
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("edgeWindows");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("chromeWindows");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("firefoxWindows");
    expect(deviceOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15")).toBe("safariMac");
    expect(deviceOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("chromeMac");
    expect(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1")).toBe("safariIphone");
    expect(deviceOf("Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1")).toBe("safariIpad");
    expect(deviceOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")).toBe("chromeAndroid");
    expect(deviceOf("curl/8.0")).toBe("unknown");
    expect(deviceOf(null)).toBe("unknown");
  });
});

describe("session timing", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  it("touches hourly and extends daily", () => {
    expect(shouldTouch(new Date("2026-09-22T11:30:00Z"), now)).toBe(false);
    expect(shouldTouch(new Date("2026-09-22T10:59:00Z"), now)).toBe(true);
    expect(shouldExtend(sessionExpiry(now), now)).toBe(false);
    expect(shouldExtend(new Date("2026-10-21T11:00:00Z"), now)).toBe(true);
    expect(sessionExpiry(now).toISOString()).toBe("2026-10-22T12:00:00.000Z");
  });
  it("hashes tokens deterministically", () => {
    expect(hashToken("abc")).toHaveLength(64);
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});

describe("resolveUser", () => {
  const ok = { emailVerified: true, email: "a@x.io", allowList: "" };
  it("covers the five branches", () => {
    expect(resolveUser({ ...ok, emailVerified: false }, { bySub: null, byEmail: null })).toEqual({ action: "refuse", reason: "email" });
    expect(resolveUser(ok, { bySub: { id: "u1", deleted: false }, byEmail: null })).toEqual({ action: "sign-in", userId: "u1" });
    expect(resolveUser(ok, { bySub: { id: "u1", deleted: true }, byEmail: null })).toEqual({ action: "refuse", reason: "deleted" });
    expect(resolveUser(ok, { bySub: null, byEmail: { id: "u2", deleted: false } })).toEqual({ action: "adopt", userId: "u2" });
    expect(resolveUser(ok, { bySub: null, byEmail: { id: "u2", deleted: true } })).toEqual({ action: "refuse", reason: "deleted" });
    expect(resolveUser({ ...ok, allowList: "@y.io" }, { bySub: null, byEmail: null })).toEqual({ action: "refuse", reason: "not-invited" });
    expect(resolveUser(ok, { bySub: null, byEmail: null })).toEqual({ action: "create" });
    expect(resolveUser({ ...ok, allowList: "@y.io" }, { bySub: null, byEmail: { id: "u2", deleted: false } })).toEqual({ action: "adopt", userId: "u2" });
  });
});

describe("names and ids", () => {
  it("derives display names and short ids", () => {
    expect(displayNameFor(" Andre ", "a@x.io")).toBe("Andre");
    expect(displayNameFor(null, "andre.p@x.io")).toBe("andre.p");
    expect(displayNameFor("x".repeat(80), "a@x.io")).toHaveLength(60);
    expect(shortId("00000000-0000-4000-8000-000000000001")).toBe("0000·0000");
    expect(shortId("a1b2c3d4-e5f6-4000-8000-000000000001")).toBe("a1b2·c3d4");
  });
});

describe("managesBook (feature-specs/47 D1)", () => {
  it("opens Book management to curators and organisation admins, and to no other role", () => {
    expect(managesBook("CURATOR")).toBe(true);
    expect(managesBook("ORG_ADMIN")).toBe(true);
    expect(managesBook("READER")).toBe(false);
    expect(managesBook("BUILDER")).toBe(false);
    expect(managesBook("CONTRIBUTOR")).toBe(false);
  });
});
