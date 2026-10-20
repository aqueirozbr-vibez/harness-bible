/*
 * The dependency gate (feature-specs/09 § 8.8): no high or critical advisory. The production tree (`npm audit
 * --omit=dev`) admits none, ever; it is what `dependencies` names, and that must hold everything the web tier and
 * the workers run, tsx included, the workers' runner, although their image installs the whole tree for the prisma
 * CLI. The whole tree admits only an advisory listed in DEV_EXCEPTIONS: one that no released version fixes, reached
 * only through a development tool that no running service loads, written down with its reason and the day it is
 * looked at again. On that day the exception fails the gate until it is renewed or removed, so none outlives its
 * reason unread; one that no longer matches anything is reported, to be removed.
 */

export interface AuditException {
  /** The advisory's GitHub id, the last segment of npm audit's `url`. */
  readonly advisory: string;
  readonly packageName: string;
  /** Why no version fixes it, and why it does not reach a request. */
  readonly reason: string;
  /** YYYY-MM-DD: from this day the exception fails the gate. */
  readonly review: string;
}

export const DEV_EXCEPTIONS: ReadonlyArray<AuditException> = [
  {
    advisory: "GHSA-vfj7-8cjw-p6xm",
    packageName: "braces",
    reason:
      "stack exhaustion on deeply nested brace patterns. Every released version is affected (3.0.3, of 2024-05-21, is the last) and the latest micromatch still depends on it. Reached only through eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch: the linter's globs over this repository's own files, never a pattern a request supplies (2026-10-20)",
    review: "2026-11-20",
  },
];

/** The parts of `npm audit --json` (report version 2) the gate reads. */
export interface AuditReport {
  /** npm 11 puts the cause of a failed audit here, beside an `error` whose fields may be empty. */
  readonly message?: string;
  readonly error?: { readonly code?: string; readonly summary?: string };
  readonly vulnerabilities?: Readonly<
    Record<
      string,
      {
        readonly severity: string;
        readonly via: ReadonlyArray<string | { readonly url?: string; readonly severity?: string }>;
      }
    >
  >;
}

const BLOCKING = new Set(["high", "critical"]);

/** A package's own high or critical advisories, by id; a package vulnerable only through another has none. */
function advisoriesOf(report: AuditReport): ReadonlyArray<{ readonly packageName: string; readonly severity: string; readonly advisory: string }> {
  const found: { packageName: string; severity: string; advisory: string }[] = [];
  for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via) {
      if (typeof via === "string" || via.severity === undefined || !BLOCKING.has(via.severity)) continue;
      found.push({ packageName, severity: via.severity, advisory: via.url?.split("/").at(-1) ?? "an advisory without an id" });
    }
  }
  return found.sort((a, b) => a.packageName.localeCompare(b.packageName) || a.advisory.localeCompare(b.advisory));
}

export interface AuditVerdict {
  readonly passed: boolean;
  /** What fails the gate, one line each. */
  readonly failures: ReadonlyArray<string>;
  /** What passes under an exception, and exceptions that match nothing. */
  readonly notes: ReadonlyArray<string>;
  readonly summary: string;
}

/** The gate, from the two reports and the day it runs (`today` as YYYY-MM-DD). */
export function auditVerdict(production: AuditReport, full: AuditReport, today: string, exceptions: ReadonlyArray<AuditException> = DEV_EXCEPTIONS): AuditVerdict {
  const failures: string[] = [];
  const notes: string[] = [];
  /* npm 11 may leave the error's fields empty and give the cause in `message` */
  const said = (text: string | undefined): string | undefined => (text === undefined || text.trim() === "" ? undefined : text.trim());
  for (const [name, report] of [["production", production], ["the whole tree", full]] as const) {
    if (report.error !== undefined) failures.push(`${name}: npm audit did not answer (${said(report.error.code) ?? "no code"}: ${said(report.error.summary) ?? said(report.message) ?? "no summary"})`);
  }
  const key = (advisory: string, packageName: string): string => `${advisory} ${packageName}`;
  const exceptionOf = (found: { readonly advisory: string; readonly packageName: string }): AuditException | undefined =>
    exceptions.find((candidate) => candidate.advisory === found.advisory && candidate.packageName === found.packageName);
  const matched = new Set<string>();
  const inProduction = advisoriesOf(production);
  for (const found of inProduction) {
    /* an exception that names it still matches, so it is not reported as stale, and still does not apply */
    if (exceptionOf(found) !== undefined) matched.add(key(found.advisory, found.packageName));
    failures.push(`production: ${found.packageName} ${found.severity} ${found.advisory} (no exception applies to the production tree)`);
  }
  let excepted = 0;
  for (const found of advisoriesOf(full)) {
    if (inProduction.some((p) => p.packageName === found.packageName && p.advisory === found.advisory)) continue;
    const exception = exceptionOf(found);
    if (exception === undefined) {
      failures.push(`development: ${found.packageName} ${found.severity} ${found.advisory} (fix it, or name it in DEV_EXCEPTIONS of lib/security/audit.ts with its reason and a review day)`);
      continue;
    }
    matched.add(key(exception.advisory, exception.packageName));
    if (today >= exception.review) {
      failures.push(`development: ${found.packageName} ${found.advisory} is excepted until ${exception.review}, which has come: look again, then renew or remove it`);
    } else {
      excepted += 1;
      notes.push(`development: ${found.packageName} ${found.severity} ${found.advisory} excepted until ${exception.review}`);
    }
  }
  /* an audit that did not answer says nothing about which exceptions still match */
  const answered = production.error === undefined && full.error === undefined;
  for (const exception of answered ? exceptions : []) {
    if (!matched.has(key(exception.advisory, exception.packageName))) notes.push(`DEV_EXCEPTIONS: ${exception.packageName} ${exception.advisory} matches nothing any more; remove it`);
  }
  return {
    passed: failures.length === 0,
    failures,
    notes,
    summary: `audit:check · production ${String(inProduction.length)} · development ${String(excepted)} excepted · ${String(failures.length)} failing`,
  };
}
