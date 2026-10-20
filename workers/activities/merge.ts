import { join } from "node:path";

import { ApplicationFailure } from "@temporalio/activity";
import { z } from "zod";

import { runDerive, type AidRun } from "@/lib/aids/run";

import { currentChapterVersion } from "@/lib/db/anchors";
import type { LedgerRecord } from "@/lib/db/generated/client";
import { currentParts, moveAlong, readCuratorAction, readMerge, readSuggestionAsService, revertOf, writeMerge, writeMergeCheck, writeMergeDone, writeMergeRelease, type CuratorActionForService, type MergeRow, type ServiceCaller, type SuggestionForService } from "@/lib/db/improve";
import { view } from "@/lib/db/ledger";
import { chapterVersionIn, releaseIds, releaseOf, type ReleaseRow } from "@/lib/db/releases";
import { currentRelease } from "@/lib/db/shared";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { endorserOf } from "@/lib/improve/endorsement";
import { branchWordsOf, CHANGELOG_PATH, changelogLineOf, checkedOf, commitSubjectOf, MOVED_PATH, releaseIdFor, returnPathOf, startPathOf, verdictOf, versionAfter, withChangelogLine } from "@/lib/improve/merge";
import type { AppendInput } from "@/lib/ledger/append";
import { stepKeyOf } from "@/lib/ledger/hash";
import { revertSubjectOf } from "@/lib/improve/revert";
import { ProposalSchema, type Part, type Proposal } from "@/lib/schemas/improve";
import { CuratorPayloadSchema, MergedPayloadSchema } from "@/lib/schemas/ledger";
import { LAB_OUTPUT_TAIL_CHARS, MERGE_DIFF_CHARS, MergeCheckSchema, type LabRun, type MERGE_MISSING, type MergeCheck, type MergeHand } from "@/lib/schemas/merge";
import { mergeOutputKey } from "@/lib/schemas/storage";
import { objectStore } from "@/lib/storage";
import { loadBook, type BookFiles } from "@/pipeline/build";
import { anchorTextAt, chapterPathOf, deriveFileOf, dryRun, labPathOf, reproductionOf } from "@/pipeline/check";
import { applyProposal, type EditAnchor } from "@/pipeline/edit/apply";
import { changedPaths, commitFiles, createImproveBranch, deleteImproveBranch, descendsFrom, diffRefs, fastForwardMain, improveBranchOf, openBookRepo, readFileAt, releaseTagsOf, resolveRef, restartImproveBranch, tagRelease, withTreeAt, type BookRepo } from "@/pipeline/git";
import { carriedOf, INGEST_CONFLICT, INGEST_HASH_DIFFERS, runEmbedCarry, runIngestion, saidOf, type CarryInput, type IngestionInput, type ProcessRun } from "@/pipeline/publish";
import { renderHash, sha256 } from "@/pipeline/renderHash";

import type { MergeActivities, MergeLeft } from "../workflows/activities";
import { appendOnce } from "./ledger";

/*
 * MergeWorkflow's activities (feature-specs/37 § 4, § 5; units 54b and 54c), as `service:merge`, and with
 * pipeline/git.ts the only code that writes the book's repository (§ 3, the lint rule's `BOOK_REPO_WRITER`). Each is
 * idempotent on the merge's row and the repository, so the engine may run it again.
 *
 * Preparing (§ 4.1 to § 4.3) moves a person's accept on to `MERGING`, opens the repository — unavailable, it says so on
 * the row and waits — and reads the book at `main` in a worktree of the adapter's. The anchor must still read what the
 * suggestion recorded; otherwise the suggestion goes back to a curator, `main`'s text on the row. The proposal is then
 * applied as the lint sensor applied it, dated by the decision, at every reading of a shared figure the cross-chapter
 * sensor named; and the branch is made from `main`, a branch of the product's own commits from an earlier pass starting
 * over. What `applyProposal` refuses — a restructure, a derived figure (invariant 5), whatever it cannot place — and a
 * branch that already holds a person's commits are the curator's hand: the branch is left for them. Otherwise one commit
 * of the product's, with the trailers of § 3, and no person's name (D2).
 *
 * Checking (§ 4.3, § 4.4) holds a curator's branch to what the product can verify — a commit, descent from `main`, a
 * change to the anchored chapter and, for a derived figure, to its derive file — then runs the pipeline's dry run on the
 * branch's tree against `main`'s, and the chapter's own derive script there by spec 18's runner (part 2): what it
 * prints is held to the derived figures the branch states, and a figure it no longer prints fails the check, named. A
 * lab that does not run on the branch is run on `main`: there too, it could not be run here, which D4 lets through only
 * for a change that cannot move a derived figure; on `main` alone, the change broke it. The IDE, built last, brings
 * nothing this needs. The diff, the run's output's end and the key of the whole are the row's, with the result.
 *
 * A failed check returns the suggestion as a request for more (§ 4.5), the branch kept for the curator.
 *
 * A step that fails says so on the merge's row, which way it failed, before it is thrown on for the engine's attempts:
 * a page then shows a merge waiting on a failure, not the stage before it (unit 54b's live run). A first preparation
 * that fails before the row exists has nowhere to say it; its run waits for a recheck all the same.
 *
 * A curator's merge (§ 5; unit 54c): their action recorded as a `curator` record, by its step key, with no calibration
 * event (a merge decides nothing the adjudicator did). Then `main`: a curator never merges an unchecked tree, so
 * anything but the tree checked — `main` or the branch moved since, or a check that no longer passed — is checked again
 * before anything is tagged. The release's id is D1's (`2026.10`, then `2026.10.2`; Andre, 2026-10-09), the chapter's
 * version the book's rule (04 D4), which the ingestion applies; the changelog's line is committed on the branch, `main`
 * moved to it by a fast-forward from where the check found it, and the release tagged. The tag is ingested by the
 * pipeline as its own process, under `PIPELINE=1`, with the render hash the check computed for that tree as the one it
 * must find (invariant 2): a mismatch publishes nothing, and the merge waits on it. The ingestion publishes the release
 * (architecture § 10); the reader's data cache shows it within its minute. The unchanged sections keep their vectors,
 * carried by the embedding job's own process under `EMBED=1`; the changed ones wait for `npm run embed:release`, read
 * lexically until then. Last, the `merged` record on the chapter's new version, and the suggestion `MERGED`, where the
 * monthly sample and a revert find it (33 § 6.5); the branch, which `main` now holds, is deleted. A failed step of the
 * merge keeps the check it came after beside its error, which the steps still to run read.
 *
 * A revert (§ 8; unit 54e) is a suggestion of a curator's own, merging from the start, whose merge is told the
 * curator's `REVERT` action — written on the suggestion it undoes — and merges once its check passes. Its `curator`
 * record is the action's on the revert itself, written before it prepares, since its commit follows from that record;
 * its `merged` record names what it reverts; and a failed check leaves it merging, for the curator's hand: nobody is
 * there to revise it.
 */

const MERGE: ServiceCaller = { kind: "service", id: "service:merge" };

type MergeMissing = (typeof MERGE_MISSING)[number];

export interface MergeActivityDeps {
  /** The book's repository, or `BOOK_REPO_UNAVAILABLE`. */
  readonly repo: () => Promise<BookRepo>;
  /** The release the reader is pinned to: what `main` holds, and what the merge starts from. */
  readonly releaseId: () => Promise<string>;
  readonly chapterVersion: (chapterNumber: number) => Promise<{ readonly id: string; readonly version: string } | null>;
  /** The suggestion's records, in the chain's order. */
  readonly records: (suggestionId: string) => Promise<ReadonlyArray<Pick<LedgerRecord, "kind" | "actor" | "hash" | "payload">>>;
  /** A lab's derive script run as the book holds it, by spec 18's runner (`AID_RUNNER`: the lab tier's container, or a local python): the folder's own. */
  readonly runLab: (labDir: string) => Promise<AidRun & { readonly runner: "python" | "docker" }>;
  /** Where a run's whole output is kept, by key; null where it cannot be. */
  readonly keep: (key: ReturnType<typeof mergeOutputKey>, output: string) => Promise<string | null>;
  readonly now: () => Date;
  /** A curator's action as the decision endpoint wrote it (§ 5; unit 54c). */
  readonly action: (actionId: string) => Promise<CuratorActionForService | null>;
  /** A curator's parts when they acted (29 § 6.1): a `curator` record names one. */
  readonly partsOf: (curatorId: string, at: Date) => Promise<ReadonlyArray<Part>>;
  /** A record appended once, under its step key (./ledger.ts): what a suite records instead. */
  readonly append: (input: AppendInput & { readonly suggestionId: string }, stepKey: string) => Promise<{ readonly seq: number }>;
  /** The releases' ids (D1), a release by its id, and a chapter's version in one (lib/db/releases.ts). */
  readonly releases: () => Promise<ReadonlyArray<string>>;
  readonly releaseOf: (id: string) => Promise<ReleaseRow | null>;
  readonly chapterVersionIn: (releaseId: string, chapterNumber: number) => Promise<{ readonly id: string; readonly version: string } | null>;
  /** The pipeline's ingestion of a tag's tree, and the embedding job's carry: each its own process (pipeline/publish.ts). */
  readonly ingest: (input: IngestionInput) => Promise<ProcessRun>;
  readonly carry: (input: CarryInput) => Promise<ProcessRun>;
  /** The suggestion a revert undoes (37 § 8; unit 54e); null for a suggestion that is no revert. */
  readonly revertOf: (suggestionId: string) => Promise<string | null>;
}

export const defaultMergeDeps = (): MergeActivityDeps => ({
  repo: () => openBookRepo(),
  releaseId: async () => (await currentRelease()).id,
  chapterVersion: currentChapterVersion,
  records: (suggestionId) => view({ suggestionId }),
  runLab: async (labDir) => ({ runner: env.AID_RUNNER, ...(await runDerive({ labDir, runner: env.AID_RUNNER, python: env.PYTHON_BIN, docker: env.DOCKER_BIN, image: env.AID_IMAGE })) }),
  keep: async (key, output) => {
    await objectStore().put(key, Buffer.from(output, "utf8"), "text/plain; charset=utf-8");
    return key;
  },
  now: () => new Date(),
  action: (actionId) => readCuratorAction(MERGE, actionId),
  partsOf: (curatorId, at) => currentParts(curatorId, at),
  append: (input, stepKey) => appendOnce(input, stepKey),
  releases: releaseIds,
  releaseOf,
  chapterVersionIn,
  ingest: runIngestion,
  carry: runEmbedCarry,
  revertOf: (suggestionId) => revertOf(MERGE, suggestionId),
});

const failure = (message: string, code: string): ApplicationFailure => ApplicationFailure.nonRetryable(message, code);

async function read(suggestionId: string): Promise<SuggestionForService> {
  const row = await readSuggestionAsService(MERGE, suggestionId);
  if (row === null) throw failure(`${suggestionId}: no such suggestion`, "SUGGESTION_MISSING");
  return row;
}

/** The repository, or null where it cannot be opened (§ 3): its words for the row. */
async function opened(deps: MergeActivityDeps): Promise<{ readonly repo: BookRepo } | { readonly unavailable: string }> {
  try {
    return { repo: await deps.repo() };
  } catch (error: unknown) {
    if (error instanceof AppError && error.code === "BOOK_REPO_UNAVAILABLE") return { unavailable: error.message };
    throw error;
  }
}

/** The book's files at a commit, read from a worktree of the adapter's, removed after. */
function bookAt(repo: BookRepo, sha: string): Promise<BookFiles> {
  return withTreeAt(repo, sha, async (dir) => loadBook(dir));
}

const anchorIdOf = (anchor: NonNullable<SuggestionForService["anchor"]>): string => anchor.figureAnchor ?? anchor.sourceRowAnchor ?? anchor.sectionAnchor;

const SharedReadingsSchema = z.object({ readings: z.array(z.object({ anchor: z.string(), rule: z.string() })) });

/** A shared figure's other readings (§ 4.1 step 3): where the cross-chapter sensor warned that a value set here is printed elsewhere too. */
function sharedReadingsOf(row: SuggestionForService, proposal: Proposal): ReadonlyArray<EditAnchor> {
  if (proposal.kind !== "SET_VALUE") return [];
  const warned = row.sensorVerdicts.find((verdict) => verdict.sensor === "CROSS_CHAPTER" && verdict.result === "WARN");
  const parsed = SharedReadingsSchema.safeParse(warned?.data);
  return parsed.success ? parsed.data.readings.filter((reading) => reading.rule === "figure").map((reading) => ({ kind: "FIGURE" as const, id: reading.anchor })) : [];
}

/**
 * The record the merge follows from (§ 3's trailers): the newest accept, a curator's `curator` record or the
 * adjudicator's `decided` one, with who made it as the ledger names them. A revert (§ 8) follows from the curator's
 * `REVERT` record, on the suggestion it undoes, which the revert's merge writes before it commits.
 */
function acceptedBy(records: ReadonlyArray<Pick<LedgerRecord, "kind" | "actor" | "hash" | "payload">>): { readonly key: "Curator" | "Adjudicator"; readonly actor: string; readonly hash: string } | null {
  for (const record of [...records].reverse()) {
    const payload = record.payload as { readonly action?: unknown; readonly decision?: unknown } | null;
    if (record.kind === "CURATOR" && (payload?.action === "ACCEPT" || payload?.action === "REVERT")) return { key: "Curator", actor: record.actor, hash: record.hash };
    if (record.kind === "DECIDED" && payload?.decision === "ACCEPT") return { key: "Adjudicator", actor: record.actor, hash: record.hash };
  }
  return null;
}

/** A run that ended, with results to read: anything else did not run (a crash, a cap, no results). */
const ran = (run: AidRun): run is AidRun & { readonly results: Record<string, unknown> } => run.exitCode === 0 && !run.timedOut && run.results !== null && typeof run.results === "object" && !Array.isArray(run.results);

/** The first line a run's failure said, for the row's reason. */
function firstLineOf(run: AidRun): string {
  const said = `${run.stderr}\n${run.stdout}`.split("\n").map((line) => line.trim()).find((line) => line !== "");
  return run.timedOut ? "it ran past the lab tier's cap" : (said ?? `it exited ${String(run.exitCode)}`).slice(0, 300);
}

/**
 * The lab half (§ 4.4 part 2): the branch's lab run, its output kept, and held to what the branch states. A run that
 * did not start is the runner's, not the change's: not run. One that started and did not end with results is run again
 * on `main`: failing there too, it cannot be run here (not run); there alone, the change broke it (failed).
 */
async function labHalf(deps: MergeActivityDeps, repo: BookRepo, branchDir: string, branch: BookFiles, chapterNumber: number, folder: string, main: string, outputKey: ReturnType<typeof mergeOutputKey>): Promise<{ readonly lab: "PASS" | "FAIL" | "NOT_RUN"; readonly labRun: LabRun }> {
  const run = await deps.runLab(join(branchDir, "labs", folder));
  const output = `${run.stdout}${run.stderr === "" ? "" : `\n--- stderr ---\n${run.stderr}`}`;
  const kept = await deps.keep(outputKey, output).catch(() => null);
  const base: LabRun = { runner: run.runner, ms: run.ms, exitCode: run.exitCode, timedOut: run.timedOut, reason: null, figures: [], keys: [], tail: output.slice(-LAB_OUTPUT_TAIL_CHARS), outputKey: kept };
  if (run.exitCode === null && !run.timedOut) return { lab: "NOT_RUN", labRun: { ...base, reason: `the runner did not start: ${firstLineOf(run)}` } };
  if (!ran(run)) {
    const onMain = await withTreeAt(repo, main, (dir) => deps.runLab(join(dir, "labs", folder)));
    if (!ran(onMain)) return { lab: "NOT_RUN", labRun: { ...base, reason: `the lab does not run here, on main either: ${firstLineOf(onMain)}` } };
    return { lab: "FAIL", labRun: { ...base, reason: `the lab runs on main and not on the branch: ${firstLineOf(run)}` } };
  }
  const reproduction = reproductionOf(branch, chapterNumber, run.results);
  const keys = reproduction.keys.map((entry) => ({ key: entry.key, stated: entry.stated === null ? null : JSON.stringify(entry.stated), printed: entry.printed === null ? null : JSON.stringify(entry.printed) }));
  return { lab: reproduction.figures.length === 0 ? "PASS" : "FAIL", labRun: { ...base, figures: [...reproduction.figures], keys } };
}

/** The row's check, or null where it has none of a known form. */
function checkOfRow(merge: MergeRow | null): MergeCheck | null {
  const parsed = MergeCheckSchema.safeParse(merge?.check);
  return parsed.success ? parsed.data : null;
}

/**
 * A step's failure on the merge's row (an `ERROR` stage), then thrown on; where the row cannot take it, the failure
 * alone. A step of the curator's merge (unit 54c) keeps beside it the check it came after, which the steps still to run
 * read when the merge goes on.
 */
async function noting<T>(deps: MergeActivityDeps, suggestionId: string, step: "prepare" | "check" | "merge", body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error: unknown) {
    const code = error instanceof AppError ? error.code : error instanceof ApplicationFailure ? (error.type ?? "FAILURE") : error instanceof Error ? error.name : "FAILURE";
    const message = ((error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "").slice(0, 500);
    const checked = step === "merge" ? checkedOf(checkOfRow(await readMerge(MERGE, suggestionId).catch(() => null))) : null;
    await writeMergeCheck(MERGE, suggestionId, { stage: "ERROR", at: deps.now().toISOString(), step, code, message, ...(checked === null ? {} : { checked }) }).catch(() => false);
    throw error;
  }
}

/** Why a change was made by hand, as the row last said it; null for the product's own. */
function handOf(check: unknown): MergeHand | null {
  const parsed = MergeCheckSchema.safeParse(check);
  return parsed.success && (parsed.data.stage === "MANUAL" || parsed.data.stage === "CHECKED") ? parsed.data.hand : null;
}

export function mergeActivities(deps: MergeActivityDeps = defaultMergeDeps()): MergeActivities {
  const steps: MergeActivities = {
    async prepareMerge(suggestionId) {
      const row = await read(suggestionId);
      const start = startPathOf(row.state, row.outcome);
      if (start === null) return { outcome: "NOT_MERGING", state: row.state, decision: row.outcome };
      if (start.length > 0) {
        const moved = await moveAlong(MERGE, suggestionId, start);
        if (moved.state !== "MERGING") return { outcome: "NOT_MERGING", state: moved.state ?? row.state, decision: row.outcome };
      }
      const { anchor } = row;
      if (anchor === null) throw failure(`${suggestionId}: no anchor`, "NO_ANCHOR");
      const proposal = ProposalSchema.safeParse(row.proposal);
      if (!proposal.success) throw failure(`${suggestionId}: no proposal of the schema's form`, "NO_PROPOSAL");
      const version = await deps.chapterVersion(row.chapterNumber);
      if (version === null) throw failure(`${suggestionId}: chapter ${String(row.chapterNumber)} is not in the release`, "NO_CHAPTER_VERSION");
      const anchorId = anchorIdOf(anchor);
      const now = deps.now();
      const at = now.toISOString();
      const previous = await readMerge(MERGE, suggestionId);
      const base = { branch: improveBranchOf(suggestionId, branchWordsOf(row.changeClass, anchorId)), versionFrom: version.version, bump: previous?.bump ?? "patch", releaseFrom: await deps.releaseId() };
      const write = (commitSha: string | null, check: MergeCheck): Promise<void> => writeMerge(MERGE, suggestionId, { ...base, commitSha, check });

      const repository = await opened(deps);
      if ("unavailable" in repository) {
        await write(null, { stage: "UNAVAILABLE", at, reason: repository.unavailable });
        return { outcome: "UNAVAILABLE" };
      }
      const { repo } = repository;
      const main = await resolveRef(repo, "main");
      if (main === null) throw failure("the book's repository has no main", "BOOK_REPO_UNAVAILABLE");
      const book = await bookAt(repo, main);

      /* § 4.1 step 1: the anchor still reads what the suggestion recorded */
      const target: EditAnchor = { kind: anchor.kind, id: anchorId };
      const text = anchorTextAt(book, row.chapterNumber, target);
      if (text === null || sha256(text) !== anchor.contentSha256) {
        await write(null, { stage: "MOVED", at, now: text });
        /* a revert has no queue to go back to (§ 8): it stays merging, the two texts on its row, for the curator's commit and Re-run check (unit 54's review) */
        if (row.origin === "CURATOR") return { outcome: "MOVED", state: "MERGING", decision: row.outcome };
        const moved = await moveAlong(MERGE, suggestionId, MOVED_PATH, { outcome: "CURATOR_REVIEW", decidedAt: now });
        if (moved.state !== "CURATOR_QUEUE") throw failure(`${suggestionId}: ${moved.state ?? "gone"}, not CURATOR_QUEUE, where a moved anchor sends it`, "NOT_MOVED");
        return { outcome: "MOVED", state: "CURATOR_QUEUE", decision: "CURATOR_REVIEW" };
      }

      /* § 4.1 steps 2 to 4: applied, dated by the decision, at every reading of a shared figure */
      const on = row.decidedAt ?? now;
      let files = book;
      const touched = new Map<string, string>();
      let hand: MergeHand | null = null;
      for (const reading of [target, ...sharedReadingsOf(row, proposal.data)]) {
        const applied = applyProposal(files, reading, proposal.data, { on });
        if ("refused" in applied) {
          hand = { refusal: applied.refused, row: applied.row, detail: applied.detail };
          break;
        }
        files = applied.files;
        for (const file of applied.touched) touched.set(file.path, file.after);
      }

      /* § 4.2: the branch from main, made again where it holds only the product's commits; a person's are never moved */
      await createImproveBranch(repo, base.branch);
      const restarted = await restartImproveBranch(repo, base.branch);
      if (hand === null && restarted.kept) hand = { refusal: "held", row: base.branch, detail: "the branch holds a person's commits, which the product never moves" };
      if (hand !== null) {
        await write(null, { stage: "MANUAL", at, hand, missing: restarted.kept ? null : "COMMIT" });
        return { outcome: "MANUAL" };
      }
      /* a revert's commit follows from the curator's REVERT record, which its merge writes on the revert before it prepares (§ 8) */
      const reverted = row.origin === "CURATOR" ? await deps.revertOf(suggestionId) : null;
      const accepted = acceptedBy(await deps.records(suggestionId));
      if (accepted === null) throw failure(`${suggestionId}: no record of its accept`, "NO_ACCEPT_RECORD");
      /* a researcher's proposal is merged on a curator's accept and on nothing else (invariant 32): the adjudicator's
         recommendation is not one, whatever path reached here (feature-specs/44 R6; unit 61b) */
      if (row.origin === "RESEARCHER" && accepted.key !== "Curator") throw failure(`${suggestionId}: a researcher's proposal has no curator's accept`, "NO_CURATOR_ACCEPT");
      const committed = await commitFiles(
        repo,
        base.branch,
        [...touched].map(([path, content]) => ({ path, content })),
        { subject: reverted === null ? commitSubjectOf(suggestionId, row.changeKind, anchorId) : revertSubjectOf(suggestionId, reverted, anchorId), body: null, trailers: { Suggestion: suggestionId, "Rubric-Version": row.rubricVersionId, [accepted.key]: accepted.actor, Record: accepted.hash, ...(reverted === null ? {} : { Reverts: reverted }) } },
        on,
      );
      await write(committed.sha, { stage: "BRANCHED", at, sha: committed.sha });
      return { outcome: "BRANCHED" };
    },

    async checkMerge(suggestionId) {
      const row = await read(suggestionId);
      if (row.state !== "MERGING") return { verdict: "NOT_MERGING", state: row.state, decision: row.outcome };
      const merge = await readMerge(MERGE, suggestionId);
      if (merge === null) throw failure(`${suggestionId}: no merge to check`, "NO_MERGE");
      const hand = handOf(merge.check);
      const at = deps.now().toISOString();
      const write = (check: MergeCheck, patch: { readonly bump?: string; readonly commitSha?: string } = {}): Promise<boolean> => writeMergeCheck(MERGE, suggestionId, check, patch);

      const repository = await opened(deps);
      if ("unavailable" in repository) {
        await write({ stage: "UNAVAILABLE", at, reason: repository.unavailable });
        return { verdict: "UNAVAILABLE" };
      }
      const { repo } = repository;
      const main = await resolveRef(repo, "main");
      const tip = await resolveRef(repo, merge.branch);
      if (main === null) throw failure("the book's repository has no main", "BOOK_REPO_UNAVAILABLE");
      if (tip === null) throw failure(`${merge.branch} is not in the book's repository: a recheck makes it again`, "BRANCH_MISSING");
      const mainBook = await bookAt(repo, main);
      const changed = await changedPaths(repo, main, tip);
      const labPath = labPathOf(mainBook, row.chapterNumber);
      const touchesLab = labPath !== null && changed.some((path) => path.startsWith(`${labPath}/`));

      /* § 4.3: what the product verifies of a curator's branch — a commit, descent from main, the anchored chapter changed, and a derived figure's derive file (invariant 5) */
      const missingOf = async (): Promise<MergeMissing | null> => {
        if (tip === main) return "COMMIT";
        if (!(await descendsFrom(repo, tip, main))) return "DESCENT";
        const chapterPath = chapterPathOf(mainBook, row.chapterNumber);
        if (chapterPath !== null && !changed.includes(chapterPath)) return "CHAPTER";
        if (row.changeClass !== "DERIVED_FIGURE") return null;
        const figure = row.anchor?.figureAnchor ?? null;
        const deriveFile = figure === null ? null : deriveFileOf(mainBook, row.chapterNumber, figure);
        return (deriveFile === null ? touchesLab : changed.includes(deriveFile)) ? null : "DERIVE";
      };
      if (hand !== null) {
        const missing = await missingOf();
        if (missing !== null) {
          await write({ stage: "MANUAL", at, hand, missing });
          return { verdict: "MANUAL" };
        }
      }

      /* § 4.4: the dry run, its changed chapter held to main's; then the chapter's lab, where it has a derive script and the dry run passed */
      const checked = await withTreeAt(repo, tip, async (dir) => {
        const branch = loadBook(dir);
        const run = await dryRun(branch, mainBook, row.chapterNumber);
        const half = run.lab === null || run.lint === "FAIL" ? null : await labHalf(deps, repo, dir, branch, row.chapterNumber, run.lab.folder, main, mergeOutputKey(suggestionId, tip));
        return { run, half };
      });
      const { run, half } = checked;
      const lab = half?.lab ?? (run.lab === null ? "NONE" : "NOT_RUN");
      /* D4 for a revert by the original's kind: a hand-made revert is a RESTRUCTURE in form, and must not wait for a lab the change it undoes merged without (unit 54's review) */
      const reverted = row.origin === "CURATOR" ? await deps.revertOf(suggestionId) : null;
      const kind = reverted === null ? row.changeKind : (await read(reverted)).changeKind;
      const verdict = verdictOf(run.lint, lab, kind, touchesLab);
      const diff = await diffRefs(repo, main, tip, [], { words: true });
      await write(
        {
          stage: "CHECKED",
          at,
          hand,
          sha: tip,
          main,
          lint: run.lint,
          lab,
          verdict,
          failure: run.failure,
          chapters: [...run.chapters],
          treeHash: run.treeHash,
          bump: run.bump,
          labId: run.lab?.id ?? null,
          touchesLab,
          labRun: half?.labRun ?? null,
          diff: { text: diff.slice(0, MERGE_DIFF_CHARS), truncated: diff.length > MERGE_DIFF_CHARS },
          suite: { ...run.suite, failing: [...run.suite.failing] },
        },
        { commitSha: tip, ...(run.bump === null ? {} : { bump: run.bump }) },
      );
      return { verdict };
    },

    async returnMerge(suggestionId): Promise<MergeLeft> {
      const row = await read(suggestionId);
      /* a step run again finds the move made */
      if (row.state !== "MERGING") return { state: row.state, decision: row.outcome };
      const path = returnPathOf(row.origin);
      /* a revert has nowhere to go (§ 8): it stays merging, for the curator's hand */
      if (path.length === 0) return { state: "MERGING", decision: row.outcome };
      const to = path.at(-1) ?? "DECIDED";
      const now = deps.now();
      const moved = await moveAlong(MERGE, suggestionId, path, { outcome: "REQUEST_MORE", decidedAt: now, ...(to === "CLOSED" ? { closedAt: now } : {}) });
      if (moved.state !== to) throw failure(`${suggestionId}: ${moved.state ?? "gone"}, not ${to}, where a failed check returns it`, "NOT_MOVED");
      return { state: to, decision: "REQUEST_MORE" };
    },

    async recordMergeAction(suggestionId, workflowId, actionId) {
      const action = await deps.action(actionId);
      if (action === null || action.curatorId === null || action.seeded) return { recorded: false };
      /* a curator's merge of this suggestion, or their revert, written on the suggestion this one undoes (§ 8); a seed's decision is never signalled (36 § 7.1) */
      const revert = action.action === "REVERT" && action.suggestionId !== suggestionId && (await deps.revertOf(suggestionId)) === action.suggestionId;
      if (!revert && (action.suggestionId !== suggestionId || action.action !== "MERGE")) return { recorded: false };
      const stepKey = stepKeyOf(workflowId, `curator:${actionId}`);
      /* recorded before: a step run again, or a merge checked again since (§ 5 step 2) */
      if ((await deps.records(suggestionId)).some((record) => record.kind === "CURATOR" && (record.payload as { readonly stepKey?: unknown } | null)?.stepKey === stepKey)) return { recorded: true };
      const row = await read(suggestionId);
      const merge = await readMerge(MERGE, suggestionId);
      const check = checkOfRow(merge);
      /* an action of this check: the suggestion merging, its check passed, the action made since — a revert's action is its own, recorded before its merge prepares, since its commit follows from the record (§ 8) */
      if (row.state !== "MERGING") return { recorded: false };
      if (!revert && (merge === null || merge.mergedAt !== null || check?.stage !== "CHECKED" || check.verdict !== "PASSED" || action.createdAt < new Date(check.at))) return { recorded: false };
      /* the part the curator's roster met when they merged (29 § 6.1): the record names one */
      const rostered = await deps.partsOf(action.curatorId, action.createdAt);
      const part = row.parts.find((candidate) => rostered.includes(candidate)) ?? row.parts[0];
      if (part === undefined) throw failure(`${suggestionId}: no part`, "NO_PART");
      const payload = CuratorPayloadSchema.parse({ stepKey, rubricVersion: row.rubricVersionId, origin: row.origin, action: revert ? "REVERT" : "MERGE", overrideCode: null, criterion: null, noteSha256: action.noteSha256, seeded: false, seedMatched: null, queueWaitMs: action.queueWaitMs, part });
      await deps.append({ kind: "CURATOR", actor: `user:${action.curatorId}`, suggestionId, chapterVersionId: row.chapterVersionId, payload }, stepKey);
      return { recorded: true };
    },

    async mergeMain(suggestionId) {
      const row = await read(suggestionId);
      const merge = await readMerge(MERGE, suggestionId);
      const check = checkedOf(checkOfRow(merge));
      /* § 5 step 2: a curator never merges an unchecked tree; anything but a passed check is checked again */
      if (row.state !== "MERGING" || merge === null || check === null || check.verdict !== "PASSED") return { outcome: "AGAIN" };
      /* a passed check with no bump is a tree that reads as main's, which the dry run now fails; a row that still says so is not checked again for ever (unit 54's review) */
      if (check.bump === null) throw failure(`${suggestionId}: the checked tree leaves the chapter as it is, so there is no version to bump`, "NO_BUMP");
      const { anchor } = row;
      if (anchor === null) throw failure(`${suggestionId}: no anchor`, "NO_ANCHOR");
      const repo = await deps.repo();
      const main = await resolveRef(repo, "main");
      const tip = await resolveRef(repo, merge.branch);
      if (main === null) throw failure("the book's repository has no main", "BOOK_REPO_UNAVAILABLE");
      if (tip === null) return { outcome: "AGAIN" };
      /* the tree checked: its commit, or it with the changelog's line after it (a step run again) */
      const since = tip === check.sha ? [] : (await descendsFrom(repo, tip, check.sha)) ? await changedPaths(repo, check.sha, tip) : null;
      if (since === null || since.some((path) => path !== CHANGELOG_PATH)) return { outcome: "AGAIN" };
      /* main where the check found it, or moved to the branch already (a step run again) */
      if (main !== check.main && main !== tip) return { outcome: "AGAIN" };

      /*
       * § 5 steps 1 and 3: the chapter's version by the book's rule (04 D4), which the ingestion applies, and the
       * release's id (D1): the one this merge set aside while no release and no tag but this tree's holds it — a step run
       * again — else the first its month has free.
       */
      const now = deps.now();
      /* the release the branch was prepared against is still the current one; moved under it (a publish landed since), the versions are read again (unit 54's review) */
      if ((await deps.releaseId()) !== merge.releaseFrom) return { outcome: "AGAIN" };
      const versionTo = versionAfter(merge.versionFrom, check.bump);
      const [released, tags] = await Promise.all([deps.releases(), releaseTagsOf(repo)]);
      const kept = merge.releaseTo;
      const keptRelease = kept === null ? null : await deps.releaseOf(kept);
      const ours = kept !== null && (keptRelease === null || keptRelease.gitSha === tip) && (tags.get(kept) ?? tip) === tip;
      const releaseId = ours ? kept : releaseIdFor(now, new Set([...released, ...tags.keys()]));
      await writeMergeRelease(MERGE, suggestionId, { releaseTo: releaseId, versionTo });

      let head = tip;
      if (main !== tip) {
        /* § 5 step 1: the book's changelog gains its line, a commit of the product's on the branch */
        const line = changelogLineOf({ chapter: row.chapterNumber, versionTo, releaseId, kind: row.changeKind, anchorId: anchorIdOf(anchor), suggestionId });
        const before = await readFileAt(repo, tip, CHANGELOG_PATH);
        const after = withChangelogLine(before, line);
        if (after !== before) head = (await commitFiles(repo, merge.branch, [{ path: CHANGELOG_PATH, content: after }], { subject: `${suggestionId}: the changelog's line for ${releaseId}`, body: null, trailers: { Suggestion: suggestionId, Release: releaseId } }, now)).sha;
        /* § 5 step 2: main moved to the branch, from where the check found it; moved since, it is checked again */
        try {
          await fastForwardMain(repo, merge.branch, check.main);
        } catch (error: unknown) {
          if (error instanceof AppError && (error.code === "BOOK_REPO_MAIN_MOVED" || error.code === "BOOK_REPO_NOT_FAST_FORWARD")) return { outcome: "AGAIN" };
          throw error;
        }
      }
      /* § 5 step 3: every merge is a release, and a release is a tag (§ 3) */
      await tagRelease(repo, releaseId, head, now);
      return { outcome: "TAGGED", releaseId };
    },

    async publishMerge(suggestionId) {
      const merge = await readMerge(MERGE, suggestionId);
      const check = checkedOf(checkOfRow(merge));
      if (merge === null || merge.releaseTo === null || check === null) throw failure(`${suggestionId}: no release to publish`, "NO_RELEASE");
      const releaseId = merge.releaseTo;
      const repo = await deps.repo();
      const tagged = await resolveRef(repo, `release/${releaseId}`);
      if (tagged === null) throw failure(`release/${releaseId} is not in the book's repository`, "TAG_MISSING");
      /* invariant 2: published only where the pipeline's render hash is the one the check computed for this tree, under this id */
      const expectHash = renderHash(check.chapters, releaseId);
      const published = await deps.releaseOf(releaseId);
      if (published === null) {
        const run = await withTreeAt(repo, tagged, (dir) => deps.ingest({ bookDir: dir, releaseId, expectHash, gitSha: tagged }));
        if (run.exitCode === INGEST_HASH_DIFFERS) throw failure(`release ${releaseId}'s render hash is not the check's, and nothing was published: ${saidOf(run)}`, "RENDER_HASH_MISMATCH");
        if (run.exitCode === INGEST_CONFLICT) throw failure(`release ${releaseId}: ${saidOf(run)}`, "RELEASE_CONFLICT");
        if (run.exitCode !== 0) throw failure(`the ingestion of release ${releaseId} did not publish it: ${saidOf(run)}`, "INGEST_FAILED");
      } else if (published.gitSha !== tagged || published.renderHash !== expectHash) {
        throw failure(`release ${releaseId} is another tree's, ${published.gitSha.slice(0, 12)}`, "RELEASE_CONFLICT");
      }
      /* § 5 step 6: the unchanged sections keep their vectors; the changed wait for the embedding job (Andre, 2026-10-09) */
      const carried = await deps.carry({ releaseId, from: merge.releaseFrom }).then(carriedOf, () => null);
      return { releaseId, carried };
    },

    async recordMerged(suggestionId, workflowId, actionId) {
      const row = await read(suggestionId);
      /* a step run again finds the move made */
      if (row.state === "MERGED") return { state: "MERGED", decision: row.outcome };
      if (row.state !== "MERGING") throw failure(`${suggestionId}: ${row.state}, not MERGING`, "NOT_MERGING");
      const merge = await readMerge(MERGE, suggestionId);
      const check = checkedOf(checkOfRow(merge));
      if (merge === null || merge.releaseTo === null || check === null || check.bump === null) throw failure(`${suggestionId}: no release to record`, "NO_RELEASE");
      const releaseId = merge.releaseTo;
      const action = await deps.action(actionId);
      const reverted = row.origin === "CURATOR" ? await deps.revertOf(suggestionId) : null;
      const theirs = action !== null && action.curatorId !== null && ((action.action === "MERGE" && action.suggestionId === suggestionId) || (action.action === "REVERT" && reverted !== null && action.suggestionId === reverted));
      if (action === null || !theirs || action.curatorId === null) throw failure(`${suggestionId}: no curator's merge ${actionId}`, "NO_MERGE_ACTION");
      const version = await deps.chapterVersionIn(releaseId, row.chapterNumber);
      if (version === null) throw failure(`release ${releaseId} has no chapter ${String(row.chapterNumber)}: it is not published`, "NOT_PUBLISHED");
      const repo = await deps.repo();
      const tagged = await resolveRef(repo, `release/${releaseId}`);
      if (tagged === null) throw failure(`release/${releaseId} is not in the book's repository`, "TAG_MISSING");
      /* the people as the chain names them (29 § 5): who submitted it, who endorsed a researcher's, who merged it */
      const records = await deps.records(suggestionId);
      const personOf = (kind: "SUBMITTED"): string | null => {
        const actor = records.find((record) => record.kind === kind)?.actor ?? null;
        return actor !== null && actor.startsWith("user:") ? actor : null;
      };
      const stepKey = stepKeyOf(workflowId, "merged");
      const payload = MergedPayloadSchema.parse({
        stepKey,
        rubricVersion: row.rubricVersionId,
        origin: row.origin,
        branch: merge.branch,
        commitSha: tagged,
        versionFrom: merge.versionFrom,
        versionTo: version.version,
        bump: check.bump,
        releaseFrom: merge.releaseFrom,
        releaseTo: releaseId,
        renderHash: renderHash(check.chapters, releaseId),
        check: { lab: check.lab, lint: check.lint },
        contributor: personOf("SUBMITTED"),
        /* the name that stands at the merge (42 § 6, D4): the latest endorsement, unless it was taken back */
        endorsedBy: endorserOf(records),
        mergedBy: `user:${action.curatorId}`,
        reverts: reverted,
      });
      await deps.append({ kind: "MERGED", actor: "service:merge", suggestionId, chapterVersionId: version.id, payload }, stepKey);
      /* the merge's row done, its check as it was where a failed step had kept it beside its error */
      await writeMergeCheck(MERGE, suggestionId, check);
      await writeMergeDone(MERGE, suggestionId, { commitSha: tagged, versionTo: version.version, mergedAt: deps.now() });
      const moved = await moveAlong(MERGE, suggestionId, ["MERGING", "MERGED"]);
      if (moved.state !== "MERGED") throw failure(`${suggestionId}: ${moved.state ?? "gone"}, not MERGED, where its merge leaves it`, "NOT_MOVED");
      /* § 3: a merged branch is deleted, main holding it; one left behind costs nothing */
      await deleteImproveBranch(repo, merge.branch).catch(() => false);
      return { state: "MERGED", decision: row.outcome };
    },
  };
  return {
    prepareMerge: (suggestionId) => noting(deps, suggestionId, "prepare", () => steps.prepareMerge(suggestionId)),
    checkMerge: (suggestionId) => noting(deps, suggestionId, "check", () => steps.checkMerge(suggestionId)),
    returnMerge: (suggestionId) => steps.returnMerge(suggestionId),
    recordMergeAction: (suggestionId, workflowId, actionId) => steps.recordMergeAction(suggestionId, workflowId, actionId),
    mergeMain: (suggestionId) => noting(deps, suggestionId, "merge", () => steps.mergeMain(suggestionId)),
    publishMerge: (suggestionId) => noting(deps, suggestionId, "merge", () => steps.publishMerge(suggestionId)),
    recordMerged: (suggestionId, workflowId, actionId) => noting(deps, suggestionId, "merge", () => steps.recordMerged(suggestionId, workflowId, actionId)),
  };
}

export const mergeActivitiesDefault: MergeActivities = mergeActivities();
