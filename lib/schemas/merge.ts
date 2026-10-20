import { z } from "zod";

import { MERGE_CHECKS } from "@/lib/schemas/ledger";

/*
 * Where a merge stands, as its row says it (feature-specs/37 § 4; unit 54b): the `check` column of `Merge`, written by
 * the merge activities alone and read by the queue's "Ready to merge" group and the record's right rail. Five stages,
 * each with what a page needs to say it. The book's own text appears here (`MOVED`'s anchor as `main` has it), never a
 * person's.
 */

/**
 * Why a change is a curator's to make (§ 4.3): `applyProposal`'s refusals (pipeline/edit/apply.ts `REFUSALS`, which a
 * test holds this list to), and `held`, a branch already holding a person's commits, which the product never moves.
 */
export const HAND_REFUSALS = ["manual", "unexpected-change", "does-not-parse", "not-found", "held"] as const;

/** What a curator's branch still lacks before it is checked (§ 4.3): a commit; descent from `main`; a change to the anchored chapter; for a derived figure, to its derive file (invariant 5). */
export const MERGE_MISSING = ["COMMIT", "DESCENT", "CHAPTER", "DERIVE"] as const;

/** The dry run's failures (pipeline/check.ts `DRY_RUN_FAILURES`, held to it by the same test). */
export const DRY_RUN_FAILURE_REASONS = ["does-not-parse", "chapter-missing", "unlinked-derived", "unchanged"] as const;

/** The check's verdict (§ 4.5): passed, to the "Ready to merge" group; failed, returned as a request for more; the lab not run where it was needed, waiting with the reason. */
export const CHECK_VERDICTS = ["PASSED", "FAILED", "NOT_RUN"] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

const At = z.iso.datetime();
const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "a commit id");

const HandSchema = z.strictObject({ refusal: z.enum(HAND_REFUSALS), row: z.string().min(1).max(200), detail: z.string().max(1_000) });
export type MergeHand = z.infer<typeof HandSchema>;

/** How many characters of a lab run's output the row keeps, its end; the whole is in the store under the output key. */
export const LAB_OUTPUT_TAIL_CHARS = 8_000;
/** How many characters of the branch's diff the row keeps, for the queue's detail. */
export const MERGE_DIFF_CHARS = 64_000;

/**
 * The chapter's lab run on the branch (§ 4.4 part 2; unit 54b), by spec 18's runner: which runner, how long, how it
 * ended; why the lab was not run, or not held to the run, where it was not; the derived figures it no longer prints as
 * the branch states them, and the results that moved; the end of what it printed, and the key of the whole.
 */
export const LabRunSchema = z.strictObject({
  runner: z.enum(["python", "docker"]),
  ms: z.int().nonnegative(),
  exitCode: z.int().nullable(),
  timedOut: z.boolean(),
  reason: z.string().max(1_000).nullable(),
  figures: z.array(z.strictObject({ id: z.string(), label: z.string(), valueText: z.string(), key: z.string() })),
  /** Each as its JSON text, null where the branch's results or the run has none. */
  keys: z.array(z.strictObject({ key: z.string(), stated: z.string().nullable(), printed: z.string().nullable() })),
  tail: z.string().max(LAB_OUTPUT_TAIL_CHARS),
  outputKey: z.string().max(200).nullable(),
});
export type LabRun = z.infer<typeof LabRunSchema>;

/** The check of § 4.4, on a commit of the branch against a commit of `main`. */
const CheckedSchema = z.strictObject({
  stage: z.literal("CHECKED"),
  at: At,
  /** Why it was made by hand, when it was. */
  hand: HandSchema.nullable(),
  sha: CommitShaSchema,
  main: CommitShaSchema,
  lint: z.enum(MERGE_CHECKS),
  lab: z.enum(MERGE_CHECKS),
  verdict: z.enum(CHECK_VERDICTS),
  failure: z.strictObject({ reason: z.enum(DRY_RUN_FAILURE_REASONS), detail: z.string().max(10_000) }).nullable(),
  /** Each chapter's content hash: the render hash of a release of this tree, for the id the merge gives it (54c). */
  chapters: z.array(z.strictObject({ number: z.int().nonnegative(), hash: z.string().regex(/^[0-9a-f]{64}$/) })),
  treeHash: z.string().regex(/^[0-9a-f]{40}$/),
  bump: z.enum(["patch", "minor", "major"]).nullable(),
  /** The changed chapter's lab, or null where it has none. */
  labId: z.string().nullable(),
  /** Whether the branch changed the chapter's lab: a lab not run then holds any change back (D4). */
  touchesLab: z.boolean(),
  /** The lab's run (part 2); null where none was made: no lab with a derive script, or a dry run that failed first. */
  labRun: LabRunSchema.nullable(),
  /** The branch against `main`, as git's porcelain word diff, its first `MERGE_DIFF_CHARS` characters (§ 6: the queue's detail). */
  diff: z.strictObject({ text: z.string().max(MERGE_DIFF_CHARS), truncated: z.boolean() }),
  /** The book's suite as the tree's results state it: an unrelated failure is beside the result, and blocks nothing (§ 4.4). */
  suite: z.strictObject({ reproduced: z.int().nonnegative(), total: z.int().nonnegative(), failing: z.array(z.int().nonnegative()) }),
});
export type BranchCheck = z.infer<typeof CheckedSchema>;

export const MergeCheckSchema = z.discriminatedUnion("stage", [
  /** The repository could not be opened (§ 3): the operator's to set, in its words. */
  z.strictObject({ stage: z.literal("UNAVAILABLE"), at: At, reason: z.string().max(1_000) }),
  /** `main` moved under the anchor (§ 4.1 step 1): the suggestion went back to the curator; what the anchor says at `main`, null where `main` has none. */
  z.strictObject({ stage: z.literal("MOVED"), at: At, now: z.string().nullable() }),
  /** A curator's hand (§ 4.3): why, and what the branch still lacks; null while the check has yet to look. */
  z.strictObject({ stage: z.literal("MANUAL"), at: At, hand: HandSchema, missing: z.enum(MERGE_MISSING).nullable() }),
  /** The product's commit on the branch (§ 4.2), to be checked. */
  z.strictObject({ stage: z.literal("BRANCHED"), at: At, sha: CommitShaSchema }),
  /**
   * A step that failed, its attempts not yet spent or spent (unit 54b's live run): which, its code and its first words —
   * git's, the runner's or the database's, never a file's content. The run waits for a recheck once they are spent. A
   * step of the curator's merge (unit 54c) keeps the check it came after, which the steps still to run read.
   */
  z.strictObject({ stage: z.literal("ERROR"), at: At, step: z.enum(["prepare", "check", "merge"]), code: z.string().max(100), message: z.string().max(1_000), checked: CheckedSchema.optional() }),
  CheckedSchema,
]);
export type MergeCheck = z.infer<typeof MergeCheckSchema>;

/**
 * A merge as a suggestion's view carries it (unit 54b): the branch, the versions and releases, when it merged, and
 * where it stands. Read by the suggestion's owner and its curators; nothing in it names a person.
 */
export const MergeViewSchema = z.strictObject({
  branch: z.string(),
  commitSha: z.string().nullable(),
  versionFrom: z.string(),
  versionTo: z.string().nullable(),
  bump: z.enum(["patch", "minor", "major"]),
  releaseFrom: z.string(),
  releaseTo: z.string().nullable(),
  mergedAt: z.iso.datetime().nullable(),
  /** The suggestion that reverts this one (37 § 8; unit 54e), from the revert's decision on. */
  revertedBy: z.string().nullable(),
  check: MergeCheckSchema.nullable(),
});
export type MergeView = z.infer<typeof MergeViewSchema>;

/**
 * Where an accepted suggestion's merge stands, in a word, as the queue files it (37 § 6; 36 § 3.1): ready to merge; or
 * waiting — on a check under way, a curator's commit, a lab not run, the repository, a failed check's return, a step
 * that failed — or on nothing at all where no merge has begun (an accept from before unit 54b). Since unit 54c, a
 * curator's merge under way, its release set aside; and merged.
 */
export const MERGE_STATES = ["READY", "CHECKING", "MANUAL", "NOT_RUN", "UNAVAILABLE", "FAILED", "ERROR", "NONE", "MERGING", "MERGED", "MOVED"] as const;
export const MergeStateSchema = z.enum(MERGE_STATES);
export type MergeState = z.infer<typeof MergeStateSchema>;
