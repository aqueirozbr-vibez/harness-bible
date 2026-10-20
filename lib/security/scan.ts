import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { findSecrets, type RedactedKind } from "@/lib/security/redact";

/*
 * The scan of what a model reads (feature-specs/21 § 6.1; architecture § 5.7, invariant 9): the prompt templates,
 * the code that assembles a prompt, and the data a model or its tests are given. gitleaks covers the repository as
 * a whole; this covers the one place where a secret would not only be committed but sent, and its only acceptable
 * count is zero.
 */

/** Relative to the application's root. A folder that does not exist is a finding of its own kind: nothing was scanned. */
export const SCAN_ROOTS = ["guides", "workers/agents", "lib/sensors", "aids", "golden"] as const;

export interface FileFinding {
  /** The file, with forward slashes, relative to the root that was scanned from. */
  readonly file: string;
  readonly line: number;
  readonly kind: RedactedKind;
}

export interface ScanResult {
  readonly files: number;
  readonly findings: ReadonlyArray<FileFinding>;
  /** Roots that were asked for and are not there. */
  readonly missing: ReadonlyArray<string>;
}

function filesUnder(base: string, folder: string): ReadonlyArray<string> {
  return readdirSync(join(base, folder))
    .sort()
    .flatMap((entry) => {
      const path = `${folder}/${entry}`;
      return statSync(join(base, path)).isDirectory() ? filesUnder(base, path) : [path];
    });
}

/** Scans every file under the roots. The result names files, lines and kinds, and holds no match. */
export function scanForSecrets(base: string, roots: ReadonlyArray<string> = SCAN_ROOTS): ScanResult {
  const missing: string[] = [];
  const findings: FileFinding[] = [];
  let files = 0;
  for (const root of roots) {
    let paths: ReadonlyArray<string>;
    try {
      paths = filesUnder(base, root);
    } catch {
      missing.push(root);
      continue;
    }
    for (const file of paths) {
      files += 1;
      for (const finding of findSecrets(readFileSync(join(base, file), "utf8"))) findings.push({ file, line: finding.line, kind: finding.kind });
    }
  }
  return { files, findings, missing };
}

/** The report, one line per finding and the summary last: `secrets:scan · 41 files · 0 findings`. */
export function reportOf(result: ScanResult): ReadonlyArray<string> {
  return [
    ...result.missing.map((root) => `${root}: not found, nothing was scanned there`),
    ...result.findings.map((finding) => `${finding.file}:${String(finding.line)} · ${finding.kind}`),
    `secrets:scan · ${String(result.files)} files · ${String(result.findings.length)} ${result.findings.length === 1 ? "finding" : "findings"}`,
  ];
}

/** Zero findings and every root present: the only result CI accepts. */
export function clean(result: ScanResult): boolean {
  return result.findings.length === 0 && result.missing.length === 0;
}
