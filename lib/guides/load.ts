import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "@/pipeline/renderHash";

/*
 * The agent guides live in this repository under guides/<agent>/<version>/
 * (architecture § 6.1; decided 2026-09-23, previously "in the book repository").
 * A guide is the byte-stable prefix of every prompt of that agent, so the loader
 * normalises line endings (git may check the files out with CRLF) and returns a
 * hash the manifest pins; a changed byte without a version bump fails the test.
 */

export type Agent = "assistant" | "grader" | "adjudicator" | "researcher";

export interface GuideManifest {
  readonly agent: Agent;
  readonly version: string;
  /**
   * The prefix files in the order they are concatenated. Empty for an agent that is two calls with separate contexts
   * and so has no prefix of its own, only parts (the researcher, feature-specs/41 § 4): `loadGuide` refuses it.
   */
  readonly files: ReadonlyArray<string>;
  /** sha256 of the normalised prefix; the loader refuses a guide whose bytes disagree. */
  readonly sha256: string;
  /**
   * A named part of the same versioned guide, with its own files and its own hash: the grounding grader's rules
   * ship as `parts.grader` of the assistant's v1.8 (feature-specs/13 § 7.3). They are **not** concatenated into
   * `files`, because the assistant's prefix is byte-stable and cached, and a grader's rules in it would change the
   * bytes every reader pays for while telling the assistant how it will be judged.
   */
  readonly parts?: Readonly<Record<string, { readonly files: ReadonlyArray<string>; readonly sha256: string }>>;
}

export interface Guide {
  readonly agent: Agent;
  readonly version: string;
  /** The byte-stable prefix: the files joined by a blank line, LF line endings, one trailing LF. */
  readonly prefix: string;
  readonly sha256: string;
  /** Which part of the guide this is, when it is not the agent's own prefix (`"grader"`). */
  readonly part?: string;
}

export const GUIDES_DIR = join(process.cwd(), "guides");

export function normalise(text: string): string {
  return `${text.replace(/\r\n/g, "\n").replace(/\n+$/, "")}\n`;
}

export function joinPrefix(parts: ReadonlyArray<string>): string {
  return parts.map(normalise).join("\n");
}

export function readManifest(agent: Agent, version: string, dir = GUIDES_DIR): GuideManifest {
  return JSON.parse(readFileSync(join(dir, agent, version, "manifest.json"), "utf8")) as GuideManifest;
}

/** The guide's prefix and hash; throws when the bytes no longer match the manifest (a guide edit needs a new version). */
export function loadGuide(agent: Agent, version: string, dir = GUIDES_DIR): Guide {
  const manifest = readManifest(agent, version, dir);
  if (manifest.files.length === 0) throw new Error(`guide ${agent}/${version} has no prefix of its own: load one of its parts (${Object.keys(manifest.parts ?? {}).join(", ")})`);
  const prefix = joinPrefix(manifest.files.map((f) => readFileSync(join(dir, agent, version, f), "utf8")));
  const hash = sha256(prefix);
  if (hash !== manifest.sha256) {
    throw new Error(`guide ${agent}/${version} has changed (sha256 ${hash.slice(0, 12)}…, manifest ${manifest.sha256.slice(0, 12)}…): edit it as a new version`);
  }
  return { agent, version, prefix, sha256: hash };
}

/**
 * A named part of a versioned guide (§ 7.3), loaded and hash-checked exactly as the prefix is. The grader's rules
 * are `loadGuidePart("assistant", "v1.8", "grader")`: the same version, pinned the same way, kept out of the
 * assistant's own prefix so the cached bytes do not move.
 */
export function loadGuidePart(agent: Agent, version: string, part: string, dir = GUIDES_DIR): Guide {
  const manifest = readManifest(agent, version, dir);
  const entry = manifest.parts?.[part];
  if (entry === undefined) {
    throw new Error(`guide ${agent}/${version} has no part "${part}" (feature-specs/13 § 7.3)`);
  }
  const prefix = joinPrefix(entry.files.map((f) => readFileSync(join(dir, agent, version, f), "utf8")));
  const hash = sha256(prefix);
  if (hash !== entry.sha256) {
    throw new Error(`guide part ${agent}/${version}/${part} has changed (sha256 ${hash.slice(0, 12)}…, manifest ${entry.sha256.slice(0, 12)}…): edit it as a new version`);
  }
  return { agent, version, prefix, sha256: hash, part };
}
