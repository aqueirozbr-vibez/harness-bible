import { createHash } from "node:crypto";

/*
 * Deterministic hashes (feature-specs/04 § 6.7). Canonical JSON: object keys
 * sorted recursively, no whitespace, Dates as ISO strings.
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function contentHash(rows: unknown): string {
  return sha256(canonicalJson(rows));
}

/** sha256 over the chapters' content hashes in chapter order, then the release id. */
/**
 * `results/derived.json` without the `timestamp` the lab runner writes on every run:
 * the content hash covers the derived values, not when they were last recomputed
 * (the book's `update_map.py` re-runs every lab, and a release whose figures are
 * unchanged must keep its hash).
 */
export function withoutRunTimestamp(derived: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...derived };
  delete rest.timestamp;
  return rest;
}

export function renderHash(chapterHashes: ReadonlyArray<{ readonly number: number; readonly hash: string }>, releaseId: string): string {
  const ordered = [...chapterHashes].sort((a, b) => a.number - b.number).map((c) => c.hash);
  return sha256([...ordered, releaseId].join("\n"));
}

/** Tree hash of a set of files: sha256 over `path\nsha256(content)` lines sorted by path (D13). */
export function treeHash(files: ReadonlyArray<{ readonly path: string; readonly content: string }>): string {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}\n${sha256(f.content)}`);
  return sha256(lines.join("\n")).slice(0, 40);
}
