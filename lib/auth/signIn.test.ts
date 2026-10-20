import { describe, expect, it } from "vitest";

import { devRoleHref, signInHref } from "./signIn";

describe("the sign-in link (feature-specs/08 § 6.1)", () => {
  it("is the locale's login page when there is nowhere to return to", () => {
    expect(signInHref("en")).toBe("/en/login");
    expect(signInHref("pt")).toBe("/pt/login");
  });

  it("carries the return path encoded, so a section id's dot and the slashes survive", () => {
    expect(signInHref("en", "/en/ch/21/21.3")).toBe("/en/login?next=%2Fen%2Fch%2F21%2F21.3");
    expect(signInHref("pt", "/pt/account")).toBe("/pt/login?next=%2Fpt%2Faccount");
  });

  it("encodes a path a reader's query could carry, so it cannot open a second parameter", () => {
    expect(signInHref("en", "/en/search?q=a&layer=2")).toBe("/en/login?next=%2Fen%2Fsearch%3Fq%3Da%26layer%3D2");
  });
});

describe("a segment of the account page's role switch (feature-specs/29 § 16)", () => {
  it("is the development sign-in as that account in that role, back to the account page in the reader's language, which says what was switched", () => {
    expect(devRoleHref("dev@harness-bible.local", "CURATOR", "en")).toBe("/api/v1/auth/dev?email=dev%40harness-bible.local&role=CURATOR&verified=true&next=%2Fen%2Faccount%3Fswitched%3DCURATOR");
    expect(devRoleHref("dev@harness-bible.local", "READER", "pt")).toBe("/api/v1/auth/dev?email=dev%40harness-bible.local&role=READER&next=%2Fpt%2Faccount%3Fswitched%3DREADER");
  });

  it("encodes the e-mail, so one with a plus or an ampersand names the same account and opens no second parameter", () => {
    const href = devRoleHref("a+b&role=ORG_ADMIN@harness-bible.local", "READER", "en");
    const query = new URL(href, "http://localhost").searchParams;
    expect(query.get("email")).toBe("a+b&role=ORG_ADMIN@harness-bible.local");
    expect(query.getAll("role")).toEqual(["READER"]);
  });

  it("verifies a contributor and a curator, whose actions need it, and leaves the other roles' verification as the account has it", () => {
    const verified = (role: Parameters<typeof devRoleHref>[1]) => new URL(devRoleHref("dev@harness-bible.local", role, "en"), "http://localhost").searchParams.get("verified");
    expect([verified("CONTRIBUTOR"), verified("CURATOR")]).toEqual(["true", "true"]);
    expect([verified("READER"), verified("BUILDER"), verified("ORG_ADMIN")]).toEqual([null, null, null]);
  });
});
