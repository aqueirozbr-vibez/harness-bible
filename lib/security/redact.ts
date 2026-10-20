import { SECRET_PATTERNS, type SecretKind } from "@/lib/security/secretPatterns";

/*
 * Finding and removing secrets in text (feature-specs/21 § 6.2; architecture § 9's secret-leakage row). Pure.
 *
 * `findSecrets` says where each one is and what kind, never what it was: a finding that printed its match would be
 * the leak it reports. `redactSecrets` returns the text with each match replaced by `[redacted:{kind}]` and the
 * kinds it replaced, one per match, so a caller can count them and say which without holding a value.
 *
 * Beside the shapes of the pattern table, a caller at run time may pass literal values to look for: the process's
 * own secrets (`lib/security/processSecrets.ts`), which have no shape a table could know and must never appear in a
 * line or a prompt whatever they look like. One of those is a `process-secret`, and it outranks a shape that would
 * also match it.
 */

export type RedactedKind = SecretKind | "process-secret";

export interface SecretFinding {
  readonly kind: RedactedKind;
  /** Where the match starts and ends in the text. */
  readonly start: number;
  readonly end: number;
  /** One-based, for a report a person reads: `guides/assistant/v1.12/prefix.md:14`. */
  readonly line: number;
}

/** Every secret in the text, in order, no two overlapping. */
export function findSecrets(text: string, literals: ReadonlyArray<string> = []): ReadonlyArray<SecretFinding> {
  const candidates: Array<{ kind: RedactedKind; start: number; end: number; rank: number }> = [];
  for (const literal of literals) {
    if (literal.length === 0) continue;
    for (let at = text.indexOf(literal); at !== -1; at = text.indexOf(literal, at + literal.length)) {
      candidates.push({ kind: "process-secret", start: at, end: at + literal.length, rank: -1 });
    }
  }
  SECRET_PATTERNS.forEach(({ kind, pattern }, rank) => {
    for (const match of text.matchAll(pattern)) candidates.push({ kind, start: match.index, end: match.index + match[0].length, rank });
  });
  candidates.sort((a, b) => a.start - b.start || a.rank - b.rank);

  const findings: SecretFinding[] = [];
  let covered = 0;
  let line = 1;
  let counted = 0;
  for (const candidate of candidates) {
    if (candidate.start < covered) continue;
    for (; counted < candidate.start; counted += 1) if (text.charCodeAt(counted) === 10) line += 1;
    findings.push({ kind: candidate.kind, start: candidate.start, end: candidate.end, line });
    covered = candidate.end;
  }
  return findings;
}

export interface Redaction {
  /** The text with every secret replaced; the same string when there was none. */
  readonly text: string;
  /** The kind of each secret replaced, in order: its length is how many there were. */
  readonly findings: ReadonlyArray<RedactedKind>;
}

export function redactionMark(kind: RedactedKind): string {
  return `[redacted:${kind}]`;
}

export function redactSecrets(text: string, literals: ReadonlyArray<string> = []): Redaction {
  const found = findSecrets(text, literals);
  if (found.length === 0) return { text, findings: [] };
  let out = "";
  let at = 0;
  for (const finding of found) {
    out += text.slice(at, finding.start) + redactionMark(finding.kind);
    at = finding.end;
  }
  return { text: out + text.slice(at), findings: found.map((finding) => finding.kind) };
}

const MARK = /\[redacted:[a-z-]+\]/g;

/**
 * The text without the marks, for what searches by the reader's words: a mark is three words the reader did not
 * write, and a search that requires every word of a question would require those too. The model is shown the marks;
 * retrieval is given the rest of the question.
 */
export function withoutRedactionMarks(text: string): string {
  return text.replace(MARK, " ").replace(/\s+/g, " ").trim();
}
