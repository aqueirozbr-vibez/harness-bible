import { describe, expect, it } from "vitest";

import { isLegalMove, mergesAfter } from "@/lib/schemas/improve";
import { DRY_RUN_FAILURE_REASONS, HAND_REFUSALS, MergeCheckSchema } from "@/lib/schemas/merge";
import { improveBranchOf } from "@/pipeline/git";
import { DRY_RUN_FAILURES } from "@/pipeline/check";
import { REFUSALS } from "@/pipeline/edit/apply";

import { branchWordsOf, changelogLineOf, checkedOf, commitSubjectOf, mergeStateOf, MOVED_PATH, releaseIdFor, returnPathOf, startPathOf, verdictOf, versionAfter, withChangelogLine } from "./merge";

/* The merge's rules (feature-specs/37 § 4, § 5; units 54b and 54c), pure. */

const legal = (path: ReadonlyArray<string>): boolean => path.slice(1).every((state, index) => isLegalMove(path[index] as never, state as never));

describe("the merge's rules (37 § 4)", () => {
  it("merges what a curator accepted, and a person's suggestion the adjudicator accepted; nothing else", () => {
    expect(mergesAfter("MERGING", "ACCEPT")).toBe(true);
    expect(mergesAfter("DECIDED", "ACCEPT")).toBe(true);
    expect(mergesAfter("DECIDED", "REQUEST_MORE")).toBe(false);
    expect(mergesAfter("CURATOR_QUEUE", "ACCEPT")).toBe(false);
    expect(mergesAfter("CLOSED", "DECLINE")).toBe(false);
    expect(startPathOf("MERGING", "ACCEPT")).toEqual([]);
    expect(startPathOf("DECIDED", "ACCEPT")).toEqual(["DECIDED", "MERGING"]);
    expect(startPathOf("DECIDED", "REQUEST_MORE")).toBeNull();
    expect(startPathOf("CURATOR_QUEUE", "CURATOR_REVIEW")).toBeNull();
  });

  it("names the branch from the class and the anchor, in the adapter's form and the ledger's", () => {
    expect(improveBranchOf("S-21-0016", branchWordsOf("CITED_FIGURE", "F-21-03"))).toBe("improve/S-21-0016-cited-figure-f-21-03");
    expect(improveBranchOf("S-36-0198", branchWordsOf("WORDING", "36.3"))).toBe("improve/S-36-0198-wording-36-3");
    expect(improveBranchOf("S-21-0016", branchWordsOf("CURATOR_ALWAYS", "21.9 r4"))).toBe("improve/S-21-0016-curator-always-21-9-r4");
    expect(commitSubjectOf("S-21-0016", "SET_VALUE", "F-21-03")).toBe("S-21-0016: set a value at F-21-03");
  });

  it("fails on either half, holds a change that could move a derived figure while its lab is not run, and passes a lab-free one, stated (D4)", () => {
    expect(verdictOf("FAIL", "NONE", "EDIT_TEXT", false)).toBe("FAILED");
    expect(verdictOf("PASS", "FAIL", "EDIT_TEXT", false)).toBe("FAILED");
    expect(verdictOf("PASS", "NOT_RUN", "EDIT_TEXT", false)).toBe("PASSED");
    expect(verdictOf("PASS", "NOT_RUN", "ADD_ROW", false)).toBe("PASSED");
    expect(verdictOf("PASS", "NOT_RUN", "EDIT_TEXT", true)).toBe("NOT_RUN");
    for (const kind of ["SET_VALUE", "EDIT_ROW", "RESTRUCTURE"] as const) expect(verdictOf("PASS", "NOT_RUN", kind, false), kind).toBe("NOT_RUN");
    expect(verdictOf("PASS", "NONE", "SET_VALUE", false)).toBe("PASSED");
    expect(verdictOf("PASS", "PASS", "RESTRUCTURE", true)).toBe("PASSED");
  });

  it("returns a failed check as a request for more — a person's to revise, a researcher's closed — and a moved anchor to a curator, along the table's moves", () => {
    expect(returnPathOf("HUMAN")).toEqual(["MERGING", "DECIDED"]);
    expect(returnPathOf("RESEARCHER")).toEqual(["MERGING", "DECIDED", "CLOSED"]);
    expect(MOVED_PATH).toEqual(["MERGING", "DECIDED", "CURATOR_QUEUE"]);
    for (const path of [returnPathOf("HUMAN"), returnPathOf("RESEARCHER"), MOVED_PATH, startPathOf("DECIDED", "ACCEPT") ?? []]) expect(legal(path), path.join(" → ")).toBe(true);
  });

  it("keeps the row's reasons in step with the pipeline's", () => {
    expect(HAND_REFUSALS.filter((refusal) => refusal !== "held")).toEqual([...REFUSALS]);
    expect([...DRY_RUN_FAILURE_REASONS]).toEqual([...DRY_RUN_FAILURES]);
  });

  it("reads a row's stages and refuses one of no form", () => {
    const at = "2026-10-09T12:00:00.000Z";
    expect(MergeCheckSchema.safeParse({ stage: "UNAVAILABLE", at, reason: "BOOK_REPO_DIR is not set" }).success).toBe(true);
    expect(MergeCheckSchema.safeParse({ stage: "MOVED", at, now: null }).success).toBe(true);
    expect(MergeCheckSchema.safeParse({ stage: "MANUAL", at, hand: { refusal: "manual", row: "21.4", detail: "a restructure is made by hand" }, missing: "COMMIT" }).success).toBe(true);
    expect(MergeCheckSchema.safeParse({ stage: "BRANCHED", at, sha: "a".repeat(40) }).success).toBe(true);
    expect(MergeCheckSchema.safeParse({ stage: "BRANCHED", at, sha: "main" }).success).toBe(false);
    expect(MergeCheckSchema.safeParse({ stage: "MERGED", at }).success).toBe(false);
  });

  it("says where a merge stands in a word, from its row (37 § 6), and the version a bump makes", () => {
    const at = "2026-10-09T12:00:00.000Z";
    const checked = (verdict: "PASSED" | "FAILED" | "NOT_RUN") => MergeCheckSchema.parse({ stage: "CHECKED", at, hand: null, sha: "a".repeat(40), main: "b".repeat(40), lint: "PASS", lab: "NONE", verdict, failure: null, chapters: [], treeHash: "c".repeat(40), bump: "patch", labId: null, touchesLab: false, labRun: null, diff: { text: "", truncated: false }, suite: { reproduced: 0, total: 0, failing: [] } });
    expect(mergeStateOf(null)).toBe("NONE");
    expect(mergeStateOf(checked("PASSED"))).toBe("READY");
    expect(mergeStateOf(checked("NOT_RUN"))).toBe("NOT_RUN");
    expect(mergeStateOf(checked("FAILED"))).toBe("FAILED");
    expect(mergeStateOf({ stage: "BRANCHED", at, sha: "a".repeat(40) })).toBe("CHECKING");
    expect(mergeStateOf({ stage: "MANUAL", at, hand: { refusal: "manual", row: "21.4", detail: "by hand" }, missing: "COMMIT" })).toBe("MANUAL");
    expect(mergeStateOf({ stage: "UNAVAILABLE", at, reason: "BOOK_REPO_DIR is not set" })).toBe("UNAVAILABLE");
    expect(mergeStateOf(MergeCheckSchema.parse({ stage: "ERROR", at, step: "prepare", code: "BOOK_REPO_GIT_FAILED", message: "git worktree failed" }))).toBe("ERROR");
    expect([versionAfter("v1.3.2", "patch"), versionAfter("v1.3.2", "minor"), versionAfter("v1.3.2", "major"), versionAfter("1.3", "patch")]).toEqual(["v1.3.3", "v1.4.0", "v2.0.0", "1.3"]);
  });
});

describe("the curator's merge (37 § 5; unit 54c)", () => {
  const at = "2026-10-09T12:00:00.000Z";

  it("gives a release the merge's month, UTC, and from the month's second a serial: the first no release and no tag holds (D1)", () => {
    expect(releaseIdFor(new Date("2026-10-09T12:00:00.000Z"), new Set(["2026.09"]))).toBe("2026.10");
    expect(releaseIdFor(new Date("2026-10-09T12:00:00.000Z"), new Set(["2026.09", "2026.10"]))).toBe("2026.10.2");
    expect(releaseIdFor(new Date("2026-10-09T12:00:00.000Z"), new Set(["2026.10", "2026.10.2", "2026.10.3"]))).toBe("2026.10.4");
    /* a gap left by an id taken out of order is taken first */
    expect(releaseIdFor(new Date("2026-10-31T23:30:00.000Z"), new Set(["2026.10", "2026.10.3"]))).toBe("2026.10.2");
    /* midnight UTC is the month's, wherever the machine is */
    expect(releaseIdFor(new Date("2026-11-01T00:00:00.000Z"), new Set(["2026.10"]))).toBe("2026.11");
    expect(releaseIdFor(new Date("2027-01-05T00:00:00.000Z"), new Set())).toBe("2027.01");
  });

  it("writes the changelog's line with the chapter, the version, the release, what changed where and the suggestion; no person's name", () => {
    expect(changelogLineOf({ chapter: 21, versionTo: "v1.0.1", releaseId: "2026.10", kind: "EDIT_TEXT", anchorId: "21.3", suggestionId: "S-21-1759" })).toBe("- ch21 v1.0.1, release 2026.10: edit the text at 21.3 (S-21-1759).");
    expect(changelogLineOf({ chapter: 5, versionTo: "v2.0.0", releaseId: "2026.10.2", kind: "SET_VALUE", anchorId: "F-05-02", suggestionId: "S-05-0001" })).toBe("- ch05 v2.0.0, release 2026.10.2: set a value at F-05-02 (S-05-0001).");
  });

  it("appends the line after the changelog's last, in its own line ends, once; makes the file where there is none", () => {
    const line = "- ch21 v1.0.1, release 2026.10: edit the text at 21.3 (S-21-1759).";
    expect(withChangelogLine("# Changelog\n\n- ch00 drafted.\n", line)).toBe(`# Changelog\n\n- ch00 drafted.\n${line}\n`);
    expect(withChangelogLine("# Changelog\n\n- ch00 drafted.\n\n\n", line)).toBe(`# Changelog\n\n- ch00 drafted.\n${line}\n`);
    expect(withChangelogLine("# Changelog\r\n\r\n- ch00 drafted.\r\n", line)).toBe(`# Changelog\r\n\r\n- ch00 drafted.\r\n${line}\r\n`);
    const once = withChangelogLine("# Changelog\n\n- ch00 drafted.\n", line);
    expect(withChangelogLine(once, line)).toBe(once);
    expect(withChangelogLine(null, line)).toBe(`# Changelog\n\n${line}\n`);
  });

  it("reads the check a merge goes by: the row's, or the one a failed step of the merge kept beside its error", () => {
    const checked = MergeCheckSchema.parse({ stage: "CHECKED", at, hand: null, sha: "a".repeat(40), main: "b".repeat(40), lint: "PASS", lab: "PASS", verdict: "PASSED", failure: null, chapters: [{ number: 21, hash: "c".repeat(64) }], treeHash: "d".repeat(40), bump: "patch", labId: "lab-21", touchesLab: false, labRun: null, diff: { text: "", truncated: false }, suite: { reproduced: 34, total: 34, failing: [] } });
    if (checked.stage !== "CHECKED") throw new Error("not checked");
    expect(checkedOf(checked)).toBe(checked);
    const failed = MergeCheckSchema.parse({ stage: "ERROR", at, step: "merge", code: "RENDER_HASH_MISMATCH", message: "release 2026.10's render hash is not the check's", checked });
    expect(checkedOf(failed)).toEqual(checked);
    expect(mergeStateOf(failed)).toBe("ERROR");
    expect(checkedOf(MergeCheckSchema.parse({ stage: "ERROR", at, step: "prepare", code: "BOOK_REPO_GIT_FAILED", message: "git worktree failed" }))).toBeNull();
    expect(checkedOf({ stage: "BRANCHED", at, sha: "a".repeat(40) })).toBeNull();
    expect(checkedOf(null)).toBeNull();
  });

  it("says a passed check's merge is under way once its release is set aside, and merged once it has merged, whatever its check", () => {
    const checked = MergeCheckSchema.parse({ stage: "CHECKED", at, hand: null, sha: "a".repeat(40), main: "b".repeat(40), lint: "PASS", lab: "PASS", verdict: "PASSED", failure: null, chapters: [], treeHash: "d".repeat(40), bump: "patch", labId: null, touchesLab: false, labRun: null, diff: { text: "", truncated: false }, suite: { reproduced: 0, total: 0, failing: [] } });
    expect(mergeStateOf(checked, { releaseTo: null, mergedAt: null })).toBe("READY");
    expect(mergeStateOf(checked, { releaseTo: "2026.10", mergedAt: null })).toBe("MERGING");
    expect(mergeStateOf(checked, { releaseTo: "2026.10", mergedAt: at })).toBe("MERGED");
    expect(mergeStateOf(checked, { releaseTo: "2026.10", mergedAt: new Date(at) })).toBe("MERGED");
    /* a failed step of the merge is the step's, its release set aside or not */
    expect(mergeStateOf(MergeCheckSchema.parse({ stage: "ERROR", at, step: "merge", code: "RENDER_HASH_MISMATCH", message: "the hash differs", checked }), { releaseTo: "2026.10", mergedAt: null })).toBe("ERROR");
  });
});
