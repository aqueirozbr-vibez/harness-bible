import { describe, expect, it } from "vitest";

import { EMBED_TARGET } from "@/lib/gateway/prices";

import { anonymousPrincipal, principalOf, vectorPlan } from "./search";

/*
 * The pure parts of the search loader's vector half (feature-specs/12 § 6): who pays for the query embedding and
 * whether it is made at all. The wiring to the workers is tests/integration/search.test.ts.
 */

const ORG = { id: "u-1", organisationId: "org-1", role: "READER" as const, displayName: "A", locale: "en", identityVerified: false, parts: [], sessionId: null };
const status = (sections: number, embedded: number) => ({ sections, embedded, model: EMBED_TARGET });

describe("the query embedding's principal", () => {
  it("is the reader's organisation, or the reader on an individual account", () => {
    expect(principalOf(ORG, null)).toEqual({ organisationId: "org-1" });
    expect(principalOf({ ...ORG, organisationId: null }, null)).toEqual({ userId: "u-1" });
    /* A configured anonymous payer never displaces a reader who has one of their own. */
    expect(principalOf(ORG, { organisationId: "org-anon" })).toEqual({ organisationId: "org-1" });
  });

  it("is the configured principal for a signed-out reader, and none while the variable is unset", () => {
    expect(principalOf(null, { organisationId: "org-anon" })).toEqual({ organisationId: "org-anon" });
    expect(principalOf(null, { userId: "u-anon" })).toEqual({ userId: "u-anon" });
    expect(principalOf(null, null)).toBeNull();
  });
});

describe("the configured anonymous principal", () => {
  it("reads GATEWAY_ANONYMOUS_PRINCIPAL in the form GATEWAY_CHECK_PRINCIPAL uses", () => {
    expect(anonymousPrincipal("org:org-anon")).toEqual({ organisationId: "org-anon" });
    expect(anonymousPrincipal("user:u-anon")).toEqual({ userId: "u-anon" });
  });

  it("is none while the variable is unset, and none for a value in neither form", () => {
    expect(anonymousPrincipal(undefined)).toBeNull();
    expect(anonymousPrincipal("org:")).toBeNull();
    expect(anonymousPrincipal("org-anon")).toBeNull();
  });
});

describe("what the vector half can do before anything is spent", () => {
  it("embeds the query on a vector-ready release for a reader with a principal", () => {
    expect(vectorPlan(status(362, 362), "idempotency", { organisationId: "org-1" })).toEqual({ embed: { organisationId: "org-1" } });
  });

  it("reports indexing while a section of the release has no vector at the pin", () => {
    expect(vectorPlan(status(362, 361), "idempotency", { organisationId: "org-1" })).toEqual({ state: "indexing" });
    expect(vectorPlan(status(0, 0), "idempotency", { organisationId: "org-1" })).toEqual({ state: "indexing" });
  });

  it("makes no call for a page without a query, and says the index is ready", () => {
    expect(vectorPlan(status(362, 362), "", { organisationId: "org-1" })).toEqual({ state: "ok" });
    expect(vectorPlan(status(362, 361), "", null)).toEqual({ state: "indexing" });
  });

  /* Andre's answer of 2026-09-24: the vector half is "for everyone", which the configured payer makes possible. */
  it("embeds a signed-out reader's query on the configured principal, and stays lexical while the variable is unset", () => {
    const configured = { organisationId: "org-anon" };
    expect(vectorPlan(status(362, 362), "idempotency", principalOf(null, configured))).toEqual({ embed: configured });
    expect(vectorPlan(status(362, 362), "idempotency", principalOf(null, null))).toEqual({ state: "unavailable" });
    expect(vectorPlan(status(362, 362), "idempotency", principalOf(ORG, configured))).toEqual({ embed: { organisationId: "org-1" } });
  });
});
