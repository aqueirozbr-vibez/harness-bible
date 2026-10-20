/*
 * Chapter versions between releases (feature-specs/04 § 6.10, D4). The book
 * carries no semver; the first release is v1.0.0 and later releases bump
 * mechanically until the improvement flow sets versions from merges.
 */

export interface VersionInput {
  readonly title: string;
  readonly layerTitles: ReadonlyArray<string>;
  readonly subHeadings: ReadonlyArray<string>;
  readonly contentHash: string;
}

export interface PreviousVersion extends VersionInput {
  readonly version: string;
}

export type Bump = "patch" | "minor" | "major";

/**
 * The book's rule between two builds of a chapter (D4): a changed title or layer title is major, changed sub-headings
 * minor, any other change patch; null when the content did not change. A merge's check reads it ahead of the release
 * that will apply it (feature-specs/37 § 5 step 1).
 */
export function bumpOf(previous: VersionInput, current: VersionInput): Bump | null {
  if (previous.contentHash === current.contentHash) return null;
  if (previous.title !== current.title || previous.layerTitles.join("|") !== current.layerTitles.join("|")) return "major";
  return previous.subHeadings.join("|") === current.subHeadings.join("|") ? "patch" : "minor";
}

export function nextVersion(current: VersionInput, previous: PreviousVersion | null): string {
  if (previous === null) return "v1.0.0";
  const bump = bumpOf(previous, current);
  if (bump === null) return previous.version;
  const [major, minor, patch] = previous.version.replace(/^v/, "").split(".").map(Number);
  if (bump === "major") return `v${major + 1}.0.0`;
  return bump === "minor" ? `v${major}.${minor + 1}.0` : `v${major}.${minor}.${patch + 1}`;
}

export function subHeadingsOf(markdown: string): ReadonlyArray<string> {
  return [...markdown.matchAll(/^###\s+(.+?)\s*$/gm)].map((m) => m[1]);
}
