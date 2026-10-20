import type { ChangeClass, ChangeKind, Decision, SuggestionOrigin, SuggestionState } from "@/lib/schemas/improve";
import type { MERGE_CHECKS } from "@/lib/schemas/ledger";
import type { BranchCheck, CheckVerdict, MergeCheck, MergeState } from "@/lib/schemas/merge";

/*
 * The merge's rules (feature-specs/37 § 4; unit 54b), pure: where a merge starts, the words of its branch and its
 * commit, the verdict of the chapter's check from its two halves, and where a suggestion goes when the check fails or
 * `main` moved under its anchor. Whether a decision leaves a suggestion to merge at all is `mergesAfter`
 * (lib/schemas/improve.ts), which the workflow reads.
 */

/** The moves a merge makes as it starts: none from `MERGING`; `DECIDED → MERGING` for a person's accept; null for a suggestion that is no merge's. */
export function startPathOf(state: SuggestionState, outcome: Decision | null): ReadonlyArray<SuggestionState> | null {
  if (state === "MERGING") return [];
  return state === "DECIDED" && outcome === "ACCEPT" ? ["DECIDED", "MERGING"] : null;
}

/** `cited figure F-21-03`: the class and the anchor, which the adapter makes the branch's slug of (§ 4.2: `improve/S-21-0016-cited-figure-f-21-03`). */
export function branchWordsOf(changeClass: ChangeClass, anchorId: string): string {
  return `${changeClass.replace(/_/g, " ")} ${anchorId}`;
}

const KIND_WORDS: Readonly<Record<ChangeKind, string>> = { EDIT_TEXT: "edit the text", SET_VALUE: "set a value", EDIT_ROW: "edit a source row", ADD_CLAIM: "add a claim", ADD_ROW: "add a source row", RESTRUCTURE: "restructure" };

/** A merge's commit subject (§ 4.2), one line of the book's own words: `S-21-0016: set a value at F-21-03`. */
export function commitSubjectOf(suggestionId: string, kind: ChangeKind, anchorId: string): string {
  return `${suggestionId}: ${KIND_WORDS[kind]} at ${anchorId}`;
}

/** The kinds that cannot change a derived figure (D4): a check of one passes with its lab not run, and says so. */
export const LAB_FREE_KINDS: ReadonlyArray<ChangeKind> = ["EDIT_TEXT", "ADD_CLAIM", "ADD_ROW"];

/**
 * The check's verdict (§ 4.4, § 4.5, D4): a half that failed fails it. A lab not run holds it back where the change
 * could move a derived figure — a kind that is not lab-free, or a branch that changed the lab — and passes it, stated,
 * where it could not. A chapter with no lab has nothing to reproduce.
 */
export function verdictOf(lint: (typeof MERGE_CHECKS)[number], lab: (typeof MERGE_CHECKS)[number], kind: ChangeKind, touchesLab: boolean): CheckVerdict {
  if (lint === "FAIL" || lab === "FAIL") return "FAILED";
  if (lab === "NOT_RUN" && (touchesLab || !LAB_FREE_KINDS.includes(kind))) return "NOT_RUN";
  return "PASSED";
}

/**
 * Where a failed check returns a suggestion (§ 4.5): as a request for more, a person's to revise; a researcher's closed,
 * nobody being there to add evidence (29 § 3.1). A curator's revert (§ 8; unit 54e) has nobody to revise it and nowhere
 * to go: it stays merging, waiting for the curator's hand and `Re-run check`.
 */
export function returnPathOf(origin: SuggestionOrigin): ReadonlyArray<SuggestionState> {
  if (origin === "CURATOR") return [];
  return origin === "HUMAN" ? ["MERGING", "DECIDED"] : ["MERGING", "DECIDED", "CLOSED"];
}

/** Where `main` having moved under the anchor sends a suggestion (§ 4.1 step 1): back to a curator, with the two texts. */
export const MOVED_PATH: ReadonlyArray<SuggestionState> = ["MERGING", "DECIDED", "CURATOR_QUEUE"];

/**
 * Where a merge stands, in a word (37 § 6): from its row's check, or `NONE` where no merge has begun. A moved anchor's
 * merge is over: its suggestion is a curator's again. Its row says the rest (unit 54c): merged once it has `mergedAt`;
 * a passed check whose release is set aside is a curator's merge under way.
 */
export function mergeStateOf(check: MergeCheck | null, merge: { readonly releaseTo: string | null; readonly mergedAt: unknown } | null = null): MergeState {
  if (merge !== null && merge.mergedAt !== null) return "MERGED";
  if (check === null) return "NONE";
  switch (check.stage) {
    case "UNAVAILABLE":
      return "UNAVAILABLE";
    case "ERROR":
      return "ERROR";
    case "MANUAL":
      return "MANUAL";
    case "BRANCHED":
      return "CHECKING";
    case "MOVED":
      return "MOVED";
    case "CHECKED":
      if (check.verdict === "PASSED") return merge !== null && merge.releaseTo !== null ? "MERGING" : "READY";
      return check.verdict === "NOT_RUN" ? "NOT_RUN" : "FAILED";
  }
}

/**
 * The id of the release a merge makes (D1; Andre's answer of 2026-10-09): the merge's year and month, UTC, and from the
 * month's second release on a serial — `2026.10`, then `2026.10.2` — the first that no release and no tag holds.
 */
export function releaseIdFor(at: Date, taken: ReadonlySet<string>): string {
  const month = `${String(at.getUTCFullYear())}.${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
  if (!taken.has(month)) return month;
  for (let serial = 2; ; serial += 1) {
    const id = `${month}.${String(serial)}`;
    if (!taken.has(id)) return id;
  }
}

/** The book's changelog (§ 5 step 1): the one file a merge writes besides its change, committed on the branch just before `main` moves to it. */
export const CHANGELOG_PATH = "book/CHANGELOG.md";

/**
 * A merge's line in the book's changelog (§ 5 step 1; Andre's answer of 2026-10-09): the chapter, the version it makes,
 * the release, what changed where, and the suggestion — `- ch21 v1.0.1, release 2026.10: edit the text at 21.3
 * (S-21-1759).` No person's name (D2): credit is the history page's, where consent governs it.
 */
export function changelogLineOf(input: { readonly chapter: number; readonly versionTo: string; readonly releaseId: string; readonly kind: ChangeKind; readonly anchorId: string; readonly suggestionId: string }): string {
  return `- ch${String(input.chapter).padStart(2, "0")} ${input.versionTo}, release ${input.releaseId}: ${KIND_WORDS[input.kind]} at ${input.anchorId} (${input.suggestionId}).`;
}

/** The changelog with a merge's line after its last, in the file's own line ends; as it was where it has the line already (a step run again). */
export function withChangelogLine(content: string | null, line: string): string {
  if (content === null || content.trim() === "") return `# Changelog\n\n${line}\n`;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  if (content.split(/\r?\n/).includes(line)) return content;
  return `${content.replace(/(?:\r?\n)+$/, "")}${eol}${line}${eol}`;
}

/** The check a merge goes by (§ 5): the row's, or the one a failed step of the curator's merge kept beside its error; null before a check, or after another stage. */
export function checkedOf(check: MergeCheck | null): BranchCheck | null {
  if (check === null) return null;
  if (check.stage === "CHECKED") return check;
  return check.stage === "ERROR" ? (check.checked ?? null) : null;
}

/** The version a bump makes of another (`v1.3.2`, patch → `v1.3.3`), as the pipeline's rule counts (04 D4); the version itself where it is of no form. */
export function versionAfter(version: string, bump: "patch" | "minor" | "major"): string {
  const parts = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (parts === null) return version;
  const [major, minor, patch] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (bump === "major") return `v${String(major + 1)}.0.0`;
  return bump === "minor" ? `v${String(major)}.${String(minor + 1)}.0` : `v${String(major)}.${String(minor)}.${String(patch + 1)}`;
}
