import { describe, expect, it } from "vitest";

import { employerDomainOf, PUBLIC_MAIL_PROVIDERS, registrableDomain, stakeOf } from "./independence";

/*
 * Independence by code (feature-specs/32 § 7.4, § 13.6): a contributor at provider-two.example citing
 * provider-two.example/pricing is `employer`; the same page from another contributor is what the grader said; a
 * public mail address names no employer; a researcher's suggestion never takes `employer`.
 */

describe("registrableDomain", () => {
  it.each<[string, string | null]>([
    ["provider-two.example", "provider-two.example"],
    ["docs.provider-two.example", "provider-two.example"],
    ["WWW.Provider-Two.Example.", "provider-two.example"],
    ["www.ibm.com.br", "ibm.com.br"],
    ["ibm.com.br", "ibm.com.br"],
    ["com.br", null],
    ["news.bbc.co.uk", "bbc.co.uk"],
    ["example.com.au", "example.com.au"],
    ["localhost", null],
    ["93.184.216.34", null],
    ["", null],
    ["a..b", null],
  ])("%s → %s", (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });
});

describe("employerDomainOf", () => {
  it("is the address's registrable domain, unless the address is at a public mail provider or is not an address", () => {
    expect(employerDomainOf("ana@provider-two.example")).toBe("provider-two.example");
    expect(employerDomainOf("ana@mail.Provider-Two.example")).toBe("provider-two.example");
    expect(employerDomainOf("ana@engenharia.example.com.br")).toBe("example.com.br");
    for (const provider of ["gmail.com", "outlook.com", "uol.com.br", "proton.me", "yahoo.com.br"]) expect(employerDomainOf(`ana@${provider}`), provider).toBeNull();
    expect(employerDomainOf("ana@mail.gmail.com")).toBeNull();
    expect(employerDomainOf(null)).toBeNull();
    expect(employerDomainOf("not an address")).toBeNull();
    expect(employerDomainOf("@provider-two.example")).toBeNull();
    expect(employerDomainOf("ana@")).toBeNull();
    expect(PUBLIC_MAIL_PROVIDERS.size).toBeGreaterThan(20);
    for (const provider of PUBLIC_MAIL_PROVIDERS) expect(provider).toBe(provider.toLowerCase());
  });
});

describe("stakeOf", () => {
  it("is employer when the contributor's verified address is at the publisher's domain, whatever the grader said", () => {
    expect(stakeOf({ graderStake: "vendor", publisherHost: "provider-two.example", contributorEmail: "ana@provider-two.example" })).toBe("employer");
    expect(stakeOf({ graderStake: "none", publisherHost: "docs.provider-two.example", contributorEmail: "ana@mail.provider-two.example" })).toBe("employer");
  });

  it("is what the grader said for anyone else, for a public mail address, for an upload and for a researcher's suggestion", () => {
    expect(stakeOf({ graderStake: "vendor", publisherHost: "provider-two.example", contributorEmail: "ana@provider-one.example" })).toBe("vendor");
    expect(stakeOf({ graderStake: "none", publisherHost: "provider-two.example", contributorEmail: "ana@provider-one.example" })).toBe("none");
    expect(stakeOf({ graderStake: "vendor", publisherHost: "gmail.com", contributorEmail: "ana@gmail.com" })).toBe("vendor");
    expect(stakeOf({ graderStake: "none", publisherHost: null, contributorEmail: "ana@provider-two.example" })).toBe("none");
    expect(stakeOf({ graderStake: "vendor", publisherHost: "provider-two.example", contributorEmail: null })).toBe("vendor");
  });
});
