import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalise } from "@/lib/guides/load";
import { RubricSchema, RubricVersionSchema, type Rubric } from "@/lib/schemas/rubric";
import { sha256 } from "@/pipeline/renderHash";

/*
 * The published rubrics as files (feature-specs/30 § 5.1): rubric/<version>/rubric.json beside guides/, aids/ and
 * golden/ (D5: the application must not depend on the book for its own rules), each with a manifest.json pinning
 * the file's sha256 the way a guide's does. A version is never edited in place: a change is a new folder, a new
 * hash, a new row.
 *
 * This is the loader, not the arithmetic: lib/rubric/ is pure and reads none of this. What reads a rubric reads it
 * here, hash-checked, and gets the parsed file; `npm run rubric:publish` writes its row through lib/db/improve.ts.
 */

export const RUBRIC_DIR = join(process.cwd(), "rubric");

export interface RubricManifest {
  readonly version: string;
  /** The one file of a rubric; a list, as a guide's manifest has one. */
  readonly files: ReadonlyArray<string>;
  /** sha256 of the normalised file; the loader refuses a rubric whose bytes disagree. */
  readonly sha256: string;
}

export interface LoadedRubric {
  readonly rubric: Rubric;
  /** The hash the manifest pins and the row records: of the file's text with LF line endings and one trailing LF. */
  readonly sha256: string;
  readonly text: string;
}

export function readRubricManifest(version: string, dir = RUBRIC_DIR): RubricManifest {
  return JSON.parse(readFileSync(join(dir, version, "manifest.json"), "utf8")) as RubricManifest;
}

/** The file's text as it is hashed: the manifest's files, normalised and joined as a guide's prefix is. */
export function rubricText(version: string, dir = RUBRIC_DIR): string {
  const manifest = readRubricManifest(version, dir);
  return manifest.files.map((file) => normalise(readFileSync(join(dir, version, file), "utf8"))).join("\n");
}

/** Whether a rubric of that version is in the folder: a name of the form `v1.2` with a manifest. */
export function hasRubric(version: string, dir = RUBRIC_DIR): boolean {
  return RubricVersionSchema.safeParse(version).success && existsSync(join(dir, version, "manifest.json"));
}

/** Every version in the folder, in the order of their numbers. */
export function listRubricVersions(dir = RUBRIC_DIR): ReadonlyArray<string> {
  if (!existsSync(dir)) return [];
  const numbers = (version: string): [number, number] => {
    const [major = "0", minor = "0"] = version.slice(1).split(".");
    return [Number(major), Number(minor)];
  };
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && hasRubric(entry.name, dir))
    .map((entry) => entry.name)
    .sort((a, b) => numbers(a)[0] - numbers(b)[0] || numbers(a)[1] - numbers(b)[1]);
}

/**
 * The rubric, parsed and hash-checked. Throws when the bytes no longer match the manifest (an edit needs a new
 * version), when the file is not a rubric, or when it says it is another version than its folder.
 */
export function loadRubric(version: string, dir = RUBRIC_DIR): LoadedRubric {
  const manifest = readRubricManifest(version, dir);
  const text = rubricText(version, dir);
  const hash = sha256(text);
  if (hash !== manifest.sha256) {
    throw new Error(`rubric ${version} has changed (sha256 ${hash.slice(0, 12)}…, manifest ${manifest.sha256.slice(0, 12)}…): a rubric is never edited in place; make it a new version (feature-specs/30 § 5.1)`);
  }
  const parsed = RubricSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`rubric ${version} is not a rubric: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  if (parsed.data.version !== version) throw new Error(`rubric ${version} says it is ${parsed.data.version}`);
  return { rubric: parsed.data, sha256: hash, text };
}
