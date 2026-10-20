import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

import type { DeriveSource } from "./figures";

/*
 * A labs/chNN-<slug> folder → Lab, LabFile, derived values, CI verdict (feature-specs/04 § 6.8).
 * The verdict rule follows bible/scripts/status.py: a run.txt that says
 * REPRODUCED or "written" counts as reproduced.
 */

export interface LabFiles {
  readonly path: string;
  readonly sha256: string;
  readonly content: string;
}

export interface ParsedLab {
  readonly id: string;
  readonly folder: string;
  readonly chapter: number;
  readonly readmeMarkdown: string;
  readonly expectedRuntimeS: number | null;
  readonly declaresModelCalls: boolean;
  readonly files: ReadonlyArray<LabFiles>;
  readonly derived: Record<string, unknown>;
  readonly ciVerdict: "REPRODUCED" | "NOT_REPRODUCED" | null;
  readonly ciCheckedAt: Date | null;
  readonly runTail: string | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "__pycache__" || entry === "results" || entry.endsWith(".pyc")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else out.push(relative(root, full).replace(/\\/g, "/"));
  }
}

/** Every `labs/chNN-*` folder keyed by chapter number. */
export function listLabFolders(labsDir: string): ReadonlyMap<number, string> {
  const map = new Map<number, string>();
  for (const entry of readdirSync(labsDir)) {
    const m = /^ch(\d{2})-/.exec(entry);
    if (m !== null && statSync(join(labsDir, entry)).isDirectory()) map.set(Number(m[1]), join(labsDir, entry));
  }
  return map;
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function parseLab(folderPath: string): ParsedLab {
  const folder = basename(folderPath);
  const chapter = Number(/^ch(\d{2})/.exec(folder)?.[1] ?? "0");
  const paths: string[] = [];
  walk(folderPath, folderPath, paths);
  const files = paths.sort().map((p) => {
    const content = readFileSync(join(folderPath, p), "utf8");
    return { path: p, sha256: sha256(content), content };
  });
  const readme = readIfExists(join(folderPath, "README.md")) ?? "";
  const derivedText = readIfExists(join(folderPath, "results", "derived.json"));
  let derived: Record<string, unknown> = {};
  if (derivedText !== null) {
    try {
      derived = JSON.parse(derivedText) as Record<string, unknown>;
    } catch {
      derived = {};
    }
  }
  const runText = readIfExists(join(folderPath, "results", "run.txt"));
  const runTail = runText === null ? null : (runText.split(/\r?\n/).filter((l) => l.trim().length > 0).pop() ?? null);
  const ciVerdict: ParsedLab["ciVerdict"] = runTail === null ? null : /REPRODUCED|written/.test(runTail) ? "REPRODUCED" : "NOT_REPRODUCED";
  const runJson = readIfExists(join(folderPath, "results", "run.json"));
  let ciCheckedAt: Date | null = null;
  if (runJson !== null) {
    try {
      const ts = (JSON.parse(runJson) as { timestamp?: string }).timestamp;
      if (ts !== undefined) ciCheckedAt = new Date(ts);
    } catch {
      ciCheckedAt = null;
    }
  }
  const runtime = /~\s*(\d+)\s*min/i.exec(readme);
  const seconds = /(\d+)\s*seconds/i.exec(readme);
  return {
    id: `lab-${String(chapter).padStart(2, "0")}`,
    folder,
    chapter,
    readmeMarkdown: readme,
    expectedRuntimeS: runtime !== null ? Number(runtime[1]) * 60 : seconds !== null ? Number(seconds[1]) : null,
    declaresModelCalls: /model call|API key/i.test(readme),
    files,
    derived,
    ciVerdict,
    ciCheckedAt,
    runTail,
  };
}

/** The derive.py side of figure matching: numeric values and their assignment lines. */
export function deriveSource(lab: ParsedLab): DeriveSource | null {
  const derivePy = lab.files.find((f) => f.path === "derive.py");
  /* numbers, plus the elements of numeric lists as key[i] (a backoff schedule is one key holding six figures) */
  const values = Object.entries(lab.derived).flatMap(([key, value]): Array<{ key: string; value: number }> => {
    if (typeof value === "number") return [{ key, value }];
    if (Array.isArray(value)) return value.flatMap((v, i) => (typeof v === "number" ? [{ key: `${key}[${i}]`, value: v }] : []));
    return [];
  });
  if (derivePy === undefined || values.length === 0) return null;
  const lines = derivePy.content.split(/\r?\n/);
  const cache = new Map<string, number | null>();
  const lineOf = (rawKey: string): number | null => {
    const key = rawKey.replace(/\[\d+\]$/, "");
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let found: number | null = null;
    const exact = lines.findIndex((l) => l.includes(`"${key}"`) || l.includes(`'${key}'`));
    if (exact >= 0) found = exact + 1;
    else {
      /* f-string keys: out[f"p_no_failure_13calls_f{f}"] matches p_no_failure_13calls_f0.02 */
      for (let i = 0; i < lines.length; i += 1) {
        const m = /out\[f?["']([^"']+)["']\]/.exec(lines[i]);
        if (m === null) continue;
        const pattern = new RegExp("^" + m[1].replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "{" ? "{" : c === "}" ? "}" : `\\${c}`)).replace(/\{[^}]*\}/g, ".*") + "$");
        if (pattern.test(key)) {
          found = i + 1;
          break;
        }
      }
    }
    cache.set(key, found);
    return found;
  };
  return {
    labId: lab.id,
    values,
    lineOf,
    expressionOf: (key) => {
      const line = lineOf(key);
      return line === null ? null : lines[line - 1].trim();
    },
  };
}
