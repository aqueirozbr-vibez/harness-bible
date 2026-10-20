import { describe, expect, it } from "vitest";

import { auditVerdict, DEV_EXCEPTIONS, type AuditException, type AuditReport } from "@/lib/security/audit";

/* npm audit --json's shape (report version 2), cut to what the gate reads */
const BRACES: AuditReport = {
  vulnerabilities: {
    braces: { severity: "high", via: [{ url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm", severity: "high" }] },
    micromatch: { severity: "high", via: ["braces"] },
    "eslint-config-next": { severity: "high", via: ["@next/eslint-plugin-next"] },
    katex: { severity: "moderate", via: [{ url: "https://github.com/advisories/GHSA-mod0-0000-0000", severity: "moderate" }] },
  },
};
const CLEAN: AuditReport = { vulnerabilities: {} };
const NEXT: AuditReport = { vulnerabilities: { next: { severity: "critical", via: [{ url: "https://github.com/advisories/GHSA-crit-0000-0000", severity: "critical" }] } } };
const EXCEPTION: AuditException = { advisory: "GHSA-vfj7-8cjw-p6xm", packageName: "braces", reason: "test", review: "2026-11-20" };

describe("the dependency gate (09 § 8.8)", () => {
  it("passes a clean production tree and a development advisory named with a review day still to come", () => {
    const verdict = auditVerdict(CLEAN, BRACES, "2026-10-20", [EXCEPTION]);
    expect(verdict).toMatchObject({ passed: true, failures: [] });
    expect(verdict.notes).toEqual(["development: braces high GHSA-vfj7-8cjw-p6xm excepted until 2026-11-20"]);
    expect(verdict.summary).toBe("audit:check · production 0 · development 1 excepted · 0 failing");
  });

  it("admits no exception in the production tree, and does not call the exception stale for it", () => {
    const verdict = auditVerdict(BRACES, BRACES, "2026-10-20", [EXCEPTION]);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toEqual(["production: braces high GHSA-vfj7-8cjw-p6xm (no exception applies to the production tree)"]);
    expect(verdict.notes).toEqual([]);
  });

  it("fails an advisory nobody named, and ignores moderate and low", () => {
    const verdict = auditVerdict(CLEAN, { vulnerabilities: { ...BRACES.vulnerabilities, ...NEXT.vulnerabilities } }, "2026-10-20", [EXCEPTION]);
    expect(verdict.failures).toEqual([expect.stringMatching(/^development: next critical GHSA-crit-0000-0000 \(fix it, or name it in DEV_EXCEPTIONS/)]);
  });

  it("fails an exception whose review day has come, and only from that day", () => {
    expect(auditVerdict(CLEAN, BRACES, "2026-11-19", [EXCEPTION]).passed).toBe(true);
    const due = auditVerdict(CLEAN, BRACES, "2026-11-20", [EXCEPTION]);
    expect(due.passed).toBe(false);
    expect(due.failures).toEqual(["development: braces GHSA-vfj7-8cjw-p6xm is excepted until 2026-11-20, which has come: look again, then renew or remove it"]);
  });

  it("matches an exception by advisory and package both", () => {
    expect(auditVerdict(CLEAN, BRACES, "2026-10-20", [{ ...EXCEPTION, packageName: "micromatch" }]).passed).toBe(false);
  });

  it("reports an exception that matches nothing any more, without failing", () => {
    const verdict = auditVerdict(CLEAN, CLEAN, "2026-10-20", [EXCEPTION]);
    expect(verdict.passed).toBe(true);
    expect(verdict.notes).toEqual(["DEV_EXCEPTIONS: braces GHSA-vfj7-8cjw-p6xm matches nothing any more; remove it"]);
  });

  it("fails when npm audit does not answer", () => {
    const verdict = auditVerdict({ error: { code: "ENOTFOUND", summary: "registry unreachable" } }, CLEAN, "2026-10-20", []);
    expect(verdict.failures).toEqual(["production: npm audit did not answer (ENOTFOUND: registry unreachable)"]);
  });

  it("gives npm 11's cause, from `message` when the error's fields are empty, and calls no exception stale", () => {
    const failed: AuditReport = { message: "request to https://registry.npmjs.org failed, reason: connect ECONNREFUSED", error: { summary: "", code: "" } };
    const verdict = auditVerdict(failed, failed, "2026-10-20", [EXCEPTION]);
    expect(verdict.failures).toEqual([
      "production: npm audit did not answer (no code: request to https://registry.npmjs.org failed, reason: connect ECONNREFUSED)",
      "the whole tree: npm audit did not answer (no code: request to https://registry.npmjs.org failed, reason: connect ECONNREFUSED)",
    ]);
    expect(verdict.notes).toEqual([]);
  });

  it("writes every exception with its reason and a review day", () => {
    for (const exception of DEV_EXCEPTIONS) {
      expect(exception.advisory).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
      expect(exception.reason.length).toBeGreaterThan(40);
      expect(exception.review).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
