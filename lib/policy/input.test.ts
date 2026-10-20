import { describe, expect, it } from "vitest";

import type { SessionUser } from "@/lib/auth/session";

import { ANONYMOUS, PolicyActionSchema, PolicyInputSchema, PolicyResourceSchema, PolicySubjectSchema, ResourceKindSchema, serviceSubject, subjectOf } from "./input";

/*
 * What the policy is told (feature-specs/09 § 5.1; feature-specs/29 § 6.1, § 10.7). The subject is the session's:
 * since unit 46d that includes whether the person is verified and, for a curator, the roster's parts. A resource
 * can say a suggestion's parts, class and origin, which policies/hb/improve.rego reads.
 */

const reader: SessionUser = { id: "u-reader", organisationId: null, role: "READER", displayName: "A reader", locale: "en-GB", identityVerified: false, parts: [], sessionId: "s1" };
const curator: SessionUser = { id: "u-curator", organisationId: "org-a", role: "CURATOR", displayName: "A curator", locale: "pt-BR", identityVerified: true, parts: ["P1", "P3"], sessionId: "s2" };

describe("subjectOf", () => {
  it("is anonymous without a session: no role, not verified, no part", () => {
    expect(subjectOf(null)).toEqual(ANONYMOUS);
    expect(ANONYMOUS).toEqual({ kind: "anonymous", id: null, role: null, organisationId: null, verified: false, parts: [], sessionId: null });
  });

  it("says a verified person is verified, and gives a curator's parts", () => {
    expect(subjectOf(curator)).toEqual({ kind: "user", id: "u-curator", role: "CURATOR", organisationId: "org-a", verified: true, parts: ["P1", "P3"], sessionId: "s2" });
    expect(subjectOf(reader)).toEqual({ kind: "user", id: "u-reader", role: "READER", organisationId: null, verified: false, parts: [], sessionId: "s1" });
  });

  it("carries nothing else of the person: no name, no locale", () => {
    expect(Object.keys(subjectOf(curator)).sort()).toEqual(["id", "kind", "organisationId", "parts", "role", "sessionId", "verified"]);
    expect(JSON.stringify(subjectOf(curator))).not.toContain("A curator");
  });

  it("is a subject the input's schema accepts", () => {
    expect(PolicySubjectSchema.safeParse(subjectOf(curator)).success).toBe(true);
    expect(PolicySubjectSchema.safeParse({ ...subjectOf(curator), parts: ["P9"] }).success).toBe(false);
    const { parts: _parts, ...withoutParts } = subjectOf(curator);
    expect(_parts).toEqual(["P1", "P3"]);
    expect(PolicySubjectSchema.safeParse(withoutParts).success).toBe(false);
  });
});

describe("serviceSubject", () => {
  it("is an agent by name: no role, no organisation, no part, never verified", () => {
    expect(serviceSubject("service:adjudicator")).toEqual({ kind: "service", id: "service:adjudicator", role: null, organisationId: null, verified: false, parts: [], sessionId: null });
    expect(PolicySubjectSchema.safeParse(serviceSubject("service:researcher")).success).toBe(true);
  });
});

describe("the input's vocabulary for Improve (feature-specs/29 § 6.2)", () => {
  it("names the two verbs and the kind the rules add", () => {
    for (const action of ["recommend", "endorse", "submit", "decide", "create"]) expect(PolicyActionSchema.safeParse(action).success, action).toBe(true);
    for (const kind of ["suggestion", "curation", "proposal"]) expect(ResourceKindSchema.safeParse(kind).success, kind).toBe(true);
    expect(PolicyActionSchema.safeParse("merge").success).toBe(false);
  });

  it("lets a resource say a suggestion's parts, class and origin, each in the product's own words", () => {
    const suggestion = { kind: "curation", id: "S-15-0377", ownerId: "u-contributor", parts: ["P1", "P3"], changeClass: "CITED_FIGURE", origin: "HUMAN" };
    expect(PolicyResourceSchema.parse(suggestion)).toEqual(suggestion);
    expect(PolicyResourceSchema.safeParse({ ...suggestion, changeClass: "FIGURE" }).success).toBe(false);
    /* CURATOR is a revert's origin since unit 54e */
    expect(PolicyResourceSchema.safeParse({ ...suggestion, origin: "CURATOR" }).success).toBe(true);
    expect(PolicyResourceSchema.safeParse({ ...suggestion, origin: "EDITOR" }).success).toBe(false);
    expect(PolicyResourceSchema.safeParse({ ...suggestion, parts: ["Part III"] }).success).toBe(false);
    expect(PolicyResourceSchema.safeParse({ kind: "note", id: "21.3", ownerId: "u-reader" }).success).toBe(true);
  });

  it("makes a whole input of a subject, an action, a resource and a context", () => {
    const input = { subject: subjectOf(curator), action: "decide", resource: { kind: "curation", id: "S-15-0377", parts: ["P3"], changeClass: "CURATOR_ALWAYS", origin: "HUMAN" }, context: { releaseId: "2026.09", traceId: "t", method: "POST", path: "/api/v1/curation/S-15-0377/decision", now: "2026-10-05T12:00:00.000Z" } };
    expect(PolicyInputSchema.safeParse(input).success).toBe(true);
  });
});
