import { describe, expect, it } from "vitest";

import type { SessionUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { serviceSubject, subjectOf, type PolicyAction, type PolicyResource, type PolicySubject } from "@/lib/policy/input";
import { authorize } from "@/lib/policy/opa";

/*
 * Improve's rules as the product asks them (feature-specs/29 § 6.2, § 10.6, § 10.7): a subject made of a session
 * by `subjectOf`, a resource made in the input's own schema, sent by `authorize` to the OPA sidecar this machine
 * runs. Every rule and every refusal is tested in Rego beside the rules (policies/tests/improve_test.rego); what
 * this holds is the seam those tests cannot see: that the names the code sends are the names the rules read. A
 * rule that reads a field the code spells differently never fires, and would refuse everybody in silence.
 *
 * The sidecar serves the bundle it was started with: after a change to policies/, restart it.
 */

const hasPolicy = env.OPA_URL !== undefined;

const person = (id: string, role: SessionUser["role"], identityVerified: boolean, parts: SessionUser["parts"] = [], organisationId: string | null = null): SessionUser => ({ id, organisationId, role, displayName: "of the policy suite", locale: "en", identityVerified, parts, sessionId: null });

const contributor = person("u-contributor", "CONTRIBUTOR", true);
const curatorOfPartThree = person("u-curator-p3", "CURATOR", true, ["P3"], "org-a");
const curatorOfPartOne = person("u-curator-p1", "CURATOR", true, ["P1"]);
const reader = person("u-reader", "READER", false);

const suggestion: PolicyResource = { kind: "suggestion", id: "S-15-0377", ownerId: "u-contributor", parts: ["P3"], changeClass: "CITED_FIGURE", origin: "HUMAN" };
const curation: PolicyResource = { ...suggestion, kind: "curation" };
const researched: PolicyResource = { kind: "curation", id: "S-21-0044", ownerId: null, parts: ["P3"], changeClass: "CITED_FIGURE", origin: "RESEARCHER" };

const silent = { log: () => undefined };
const allowed = async (subject: PolicySubject, action: PolicyAction, resource: PolicyResource): Promise<boolean> => (await authorize(subject, action, resource, {}, silent)).allow;

describe.skipIf(!hasPolicy)("Improve's rules, asked by the product's own client of the sidecar", () => {
  it("serves the bundle that has them: a rule only this unit wrote answers", async () => {
    expect(await allowed(subjectOf(reader), "endorse", { kind: "proposal", id: "S-21-0044", ownerId: "u-reader" }), "restart the OPA sidecar: it is serving a bundle from before policies/hb/improve.rego").toBe(true);
  });

  it("lets a verified contributor start a suggestion and submit their own, and an unverified one neither", async () => {
    expect(await allowed(subjectOf(contributor), "create", { kind: "suggestion", id: null })).toBe(true);
    expect(await allowed(subjectOf(contributor), "submit", suggestion)).toBe(true);
    const unverified = person("u-contributor", "CONTRIBUTOR", false);
    expect(await allowed(subjectOf(unverified), "create", { kind: "suggestion", id: null })).toBe(false);
    expect(await allowed(subjectOf(unverified), "submit", suggestion)).toBe(false);
    expect(await allowed(subjectOf(reader), "create", { kind: "suggestion", id: null })).toBe(false);
  });

  it("lets a curator read and decide what reaches one of their parts, whatever organisation they are of, and nothing else", async () => {
    expect(await allowed(subjectOf(curatorOfPartThree), "read", suggestion)).toBe(true);
    expect(await allowed(subjectOf(curatorOfPartThree), "decide", curation)).toBe(true);
    expect(await allowed(subjectOf(curatorOfPartThree), "decide", { ...curation, changeClass: "CURATOR_ALWAYS" })).toBe(true);
    expect(await allowed(subjectOf(curatorOfPartThree), "write", suggestion)).toBe(false);
    expect(await allowed(subjectOf(curatorOfPartOne), "read", suggestion)).toBe(false);
    expect(await allowed(subjectOf(curatorOfPartOne), "decide", curation)).toBe(false);
    expect(await allowed(subjectOf(person("u-contributor", "CURATOR", true, ["P3"])), "decide", curation)).toBe(false);
    expect(await allowed(subjectOf(contributor), "decide", curation)).toBe(false);
  });

  it("lets the adjudicator decide a person's suggestion of an automatic class, and only recommend on a researcher's", async () => {
    const adjudicator = serviceSubject("service:adjudicator");
    expect(await allowed(adjudicator, "decide", curation)).toBe(true);
    expect(await allowed(adjudicator, "decide", { ...curation, changeClass: "CURATOR_ALWAYS" })).toBe(false);
    expect(await allowed(adjudicator, "decide", researched)).toBe(false);
    expect(await allowed(adjudicator, "recommend", researched)).toBe(true);
    expect(await allowed(adjudicator, "recommend", { ...researched, changeClass: "CURATOR_ALWAYS" })).toBe(false);
    expect(await allowed(adjudicator, "read", { kind: "user", id: "u-contributor" })).toBe(false);
  });

  it("lets the researcher submit its own proposal and no person's suggestion, and a reader endorse the proposal that is theirs", async () => {
    const researcher = serviceSubject("service:researcher");
    expect(await allowed(researcher, "submit", { ...researched, kind: "suggestion" })).toBe(true);
    expect(await allowed(researcher, "submit", suggestion)).toBe(false);
    expect(await allowed(subjectOf(reader), "endorse", { kind: "proposal", id: "S-21-0044", ownerId: "u-reader" })).toBe(true);
    expect(await allowed(subjectOf(reader), "endorse", { kind: "proposal", id: "S-21-0044", ownerId: "u-contributor" })).toBe(false);
  });

  it("still keeps one organisation's rows from another's reader, which the platform's kinds are no way around", async () => {
    const memberOfA = person("u-member", "READER", false, [], "org-a");
    expect(await allowed(subjectOf(memberOfA), "read", { kind: "note", id: "21.3", ownerId: "u-member", organisationId: "org-b" })).toBe(false);
    expect(await allowed(subjectOf(memberOfA), "read", { ...suggestion, organisationId: "org-a" })).toBe(false);
  });
});
