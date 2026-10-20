import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runDerive, type AidRun } from "@/lib/aids/run";
import { getPrisma } from "@/lib/db/client";
import { adjudicatorAcceptsBetween, createDraft, createRevert, readCuratorAction, readMerge, readSuggestionAsService, revertOf, updateDraft, type CuratorActionForService, type ServiceCaller, type UserCaller } from "@/lib/db/improve";
import { env } from "@/lib/env";
import { EMBED_TARGET } from "@/lib/gateway/prices";
import type { AppendInput } from "@/lib/ledger/append";
import { stepKeyOf } from "@/lib/ledger/hash";
import { SuggestionIdSchema, type SuggestionId } from "@/lib/schemas/ids";
import type { AnchorKind, ChangeClass, ChangeKind, Proposal } from "@/lib/schemas/improve";
import { MergeCheckSchema, type MergeCheck } from "@/lib/schemas/merge";
import { buildChapter, loadBook, type BookFiles } from "@/pipeline/build";
import { anchorTextAt } from "@/pipeline/check";
import { openBookRepo, withTreeAt } from "@/pipeline/git";
import { CH21_FILE, CH21_LAB_DIR, fixture } from "@/pipeline/parse/fixtures";
import { runEmbedCarry, runIngestion, saidOf } from "@/pipeline/publish";
import { renderHash, sha256 } from "@/pipeline/renderHash";
import { mergeActivities, type MergeActivityDeps } from "@/workers/activities/merge";

/*
 * MergeWorkflow's activities against the database and a repository of the book (feature-specs/37 § 4, § 12; unit 54b),
 * the repository made by this suite in a temporary folder from a fixture chapter — the application never makes one —
 * and left by it, as the operator leaves theirs, on a detached HEAD and dirty, which nothing may mind.
 *
 * The chapter is the pipeline's chapter-21 fixture renumbered 94, a chapter no book has, so the suggestions' ids and
 * rows are this suite's own; its lab and registry sit beside it. Nothing here appends to the ledger: the record the
 * merge follows from is given to the activities, as their dependency, not read from the chain.
 *
 * A person's accepted wording change is branched from `main` with one commit of the product's and checked: the dry run
 * and the chapter's own lab, run by spec 18's runner as a local python (part 2), reproducing. A derived figure is the
 * curator's hand (invariant 5): the product verifies their branch until it changes the derive file, and then its lab
 * decides — results changed by hand that the script does not print fail, named; a script that prints them passes. A
 * runner that does not start, and a lab that does not run on `main` either, leave the lab not run; a lab that runs on
 * `main` alone fails.
 * `main` moved under the anchor sends the suggestion back to a curator. A change that unlinks a derived figure fails the
 * check and is returned as a request for more, its branch kept. With no repository, a merge waits with the reason and
 * writes no file. A curator's merge (unit 54c) goes to main with the changelog's line, is tagged and published into a
 * database of the suite's own, its unchanged sections' vectors carried, and recorded; `main` moved since the check is
 * checked again before anything is tagged; and a render hash that is not the check's publishes nothing. A curator's
 * revert (unit 54e) of a merged change goes through the door and the same steps, restores the text byte for byte,
 * bumps the version, names what it reverts, and puts the original in precision's numerator. Runs where DATABASE_URL
 * is set.
 */

const ready = env.DATABASE_URL !== undefined;
const TIMEOUT = 120_000;

const CHAPTER = 94;
const FILE = "ch94-control-plane.md";
const LAB_FOLDER = "ch94-control-plane";
const CHAPTER_PATH = `book/part2/${FILE}`;
const CHAPTER_VERSION = "00000000-0000-4000-8000-0000000054b0";
const CONTRIBUTOR = "00000000-0000-4000-8000-0000000054b1";
const CURATOR = "00000000-0000-4000-8000-0000000054b2";
const contributor: UserCaller = { kind: "user", userId: CONTRIBUTOR, role: "CONTRIBUTOR", parts: [] };
/** The curator of part II, as the revert's door read sees them (unit 54e). */
const curatorOfP2: UserCaller = { kind: "user", userId: CURATOR, role: "CURATOR", parts: ["P2"] };
const MERGE: ServiceCaller = { kind: "service", id: "service:merge" };
/** When the suggestion was accepted, which dates the product's commit (37 § 3), and when the step runs. */
const DECIDED_AT = new Date("2026-10-09T10:00:00.000Z");
const AT = new Date("2026-10-09T12:00:00.000Z");
const RECORD = "ab".repeat(32);
const RETRIES = "Retries are not optional at eleven steps.";

/** Chapter 21's fixture as chapter 94: its title and layer headings renumbered, its lab named for its new folder. */
const CH94 = fixture(CH21_FILE)
  .replace(/^# Chapter 21 —/m, "# Chapter 94 —")
  .replace(/^## 21\.(\d) /gm, "## 94.$1 ")
  .replace(/Lab 21\b/g, "Lab 94")
  .replace(/labs\/ch21-control-plane/g, `labs/${LAB_FOLDER}`);

/**
 * A second chapter (unit 54c), which no merge here changes: chapter 94 as chapter 93, with no lab of its own. Every
 * release re-inserts it at its version (04 § 6.10), which a key on the chapter and its version once refused.
 */
const CH93_PATH = "book/part2/ch93-checkpoints.md";
const CH93 = CH94.replace(/^# Chapter 94 —/m, "# Chapter 93 —")
  .replace(/^## 94\.(\d) /gm, "## 93.$1 ")
  .replace(/Lab 94\b/g, "Lab 93")
  .replace(new RegExp(`labs/${LAB_FOLDER}`, "g"), "labs/ch93-checkpoints");

let root = "";
let first = "";
let book: BookFiles;
const operator: { status: string; head: string } = { status: "", head: "" };

/** The suite's own git, as the operator and the curator run it: the machine's configuration left out, a person as author. */
function sh(args: ReadonlyArray<string>, cwd: string = root): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, "no-user-config"), GIT_AUTHOR_NAME: "Curator", GIT_AUTHOR_EMAIL: "curator@example.invalid", GIT_COMMITTER_NAME: "Curator", GIT_COMMITTER_EMAIL: "curator@example.invalid" },
  }).trim();
}

function write(base: string, path: string, content: string): void {
  mkdirSync(dirname(join(base, ...path.split("/"))), { recursive: true });
  writeFileSync(join(base, ...path.split("/")), content, "utf8");
}

/** A curator's commit on a suggestion's branch (§ 4.3), made as a person makes it: in a worktree of their own, outside the operator's tree. */
function curatorCommit(branch: string, files: Readonly<Record<string, string>>): string {
  const tree = join(mkdtempSync(join(tmpdir(), "hb-curator-")), "tree");
  sh(["worktree", "add", "--quiet", tree, branch]);
  try {
    for (const [path, content] of Object.entries(files)) write(tree, path, content);
    sh(["add", "-A"], tree);
    sh(["commit", "--quiet", "-m", "The curator's hand"], tree);
    return sh(["rev-parse", "HEAD"], tree);
  } finally {
    sh(["worktree", "remove", "--force", tree]);
  }
}

function figureByValue(valueText: string): { readonly id: string } {
  const built = buildChapter(book.chapters[0], book, { locale: "en", previous: new Map() });
  const found = built.sections.flatMap((section) => section.figures).find((figure) => figure.valueText === valueText);
  if (found === undefined) throw new Error(`no figure ${valueText} in chapter 94`);
  return found;
}

/** The record the merge follows from: the adjudicator's accept, or a curator's. */
const adjudicated: MergeActivityDeps["records"] = async () => [{ kind: "DECIDED", actor: "service:adjudicator", hash: RECORD, payload: { decision: "ACCEPT" } }];
const curated: MergeActivityDeps["records"] = async () => [{ kind: "CURATOR", actor: `user:${CURATOR}`, hash: RECORD, payload: { action: "ACCEPT" } }];

/** Spec 18's runner as a local python, as this machine has one: the lab's own derive script, run as the book holds it. */
const python: MergeActivityDeps["runLab"] = async (labDir) => ({ runner: "python", ...(await runDerive({ labDir, runner: "python", python: env.PYTHON_BIN })) });
/** What the runs printed, by the output key. */
const kept = new Map<string, string>();

/** A step a case never reaches: the curator's merge's, outside its cases. */
const unreached = (step: string) => async (): Promise<never> => {
  throw new Error(`${step} is not this case's`);
};

function depsOf(over: Partial<MergeActivityDeps> = {}): MergeActivityDeps {
  return {
    repo: () => openBookRepo(root),
    releaseId: async () => "2026.09",
    chapterVersion: async () => ({ id: CHAPTER_VERSION, version: "v1.0.0" }),
    records: adjudicated,
    runLab: python,
    keep: async (key, output) => {
      kept.set(key, output);
      return key;
    },
    now: () => AT,
    action: unreached("action"),
    partsOf: unreached("partsOf"),
    append: unreached("append"),
    releases: unreached("releases"),
    releaseOf: unreached("releaseOf"),
    chapterVersionIn: unreached("chapterVersionIn"),
    ingest: unreached("ingest"),
    carry: unreached("carry"),
    revertOf: async () => null,
    ...over,
  };
}

/** A run that ends as given, wherever it is asked to run. */
const ended = (run: Partial<AidRun>): AidRun & { readonly runner: "docker" } => ({ runner: "docker", exitCode: 0, timedOut: false, ms: 5, stdout: "", stderr: "", results: null, ...run });

interface Accepted {
  readonly changeKind: ChangeKind;
  readonly changeClass: ChangeClass;
  readonly anchor: { readonly kind: AnchorKind; readonly sectionAnchor: string; readonly figureAnchor: string | null };
  readonly proposal: Proposal;
  /** The hash the draft recorded, when it is not what the anchor reads at `main`: `main` moved since. */
  readonly recorded?: string;
  /** `MERGING` for a curator's accept; `DECIDED` for the adjudicator's of a person's suggestion. */
  readonly state?: "DECIDED" | "MERGING";
}

/** A person's suggestion, accepted: drafted through the door with its anchor as the release reads it, then moved as a decision moves it. */
async function accepted(input: Accepted): Promise<SuggestionId> {
  const anchorId = input.anchor.figureAnchor ?? input.anchor.sectionAnchor;
  const text = anchorTextAt(book, CHAPTER, { kind: input.anchor.kind, id: anchorId }) ?? "";
  const made = await createDraft(contributor, {
    chapterNumber: CHAPTER,
    chapterVersionId: CHAPTER_VERSION,
    releaseId: "2026.09",
    parts: ["P2"],
    changeKind: input.changeKind,
    changeClass: input.changeClass,
    curatorReason: null,
    locale: "EN",
    rubricVersionId: "v1.2",
    anchor: { kind: input.anchor.kind, sectionAnchor: input.anchor.sectionAnchor, figureAnchor: input.anchor.figureAnchor, sourceRowAnchor: null, currentText: text, contentSha256: input.recorded ?? sha256(text), existsAtVersion: true },
  });
  const id = SuggestionIdSchema.parse(made.id);
  await updateDraft(contributor, id, { proposal: { proposal: input.proposal, proposalKey: sha256(`the key of ${id}`), changeClass: input.changeClass, curatorReason: null }, rationale: "The suite's rationale." });
  await getPrisma().$executeRawUnsafe(`UPDATE "Suggestion" SET "state" = '${input.state ?? "DECIDED"}', "outcome" = 'ACCEPT', "submittedAt" = '2026-10-09T09:00:00Z', "decidedAt" = '${DECIDED_AT.toISOString()}' WHERE "id" = '${id}'`);
  return id;
}

async function checkOf(id: string): Promise<MergeCheck> {
  return MergeCheckSchema.parse((await readMerge(MERGE, id))?.check);
}

async function clear(): Promise<void> {
  const prisma = getPrisma();
  /* The suite's suggestions back to draft so that they can go, a move nothing of the product makes; their merges go with them. */
  await prisma.$executeRawUnsafe(`UPDATE "Suggestion" SET "state" = 'DRAFT' WHERE "chapterNumber" = ${String(CHAPTER)}`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Suggestion" WHERE "chapterNumber" = ${String(CHAPTER)}`);
  await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" IN ('${CONTRIBUTOR}', '${CURATOR}')`);
}

describe.skipIf(!ready)("MergeWorkflow's activities, against the database and a repository of the book", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "hb-merge-repo-"));
    write(root, CHAPTER_PATH, CH94);
    write(root, "book/registry/ch94-verify.md", fixture("ch21-verify.md"));
    write(root, "book/registry/ch94-redteam.md", fixture("ch21-redteam.md"));
    cpSync(CH21_LAB_DIR, join(root, "labs", LAB_FOLDER), { recursive: true });
    sh(["init", "--quiet", "-b", "main"]);
    sh(["add", "-A"]);
    sh(["commit", "--quiet", "-m", "The book at release 2026.09"]);
    sh(["tag", "-a", "release/2026.09", "-m", "release 2026.09"]);
    first = sh(["rev-parse", "HEAD"]);
    book = loadBook(root);
    /* The operator's tree as the session notes leave it: detached, and here with notes of theirs, which nothing may mind. */
    sh(["checkout", "--quiet", "--detach"]);
    write(root, "notes.txt", "the operator's notes\n");
    operator.status = sh(["status", "--porcelain"]);
    operator.head = sh(["rev-parse", "HEAD"]);

    await clear();
    await getPrisma().$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "displayName", "role", "identityVerified", "provenanceConsentAt") VALUES ('${CONTRIBUTOR}', 'merge-suite-a@harness-bible.local', 'Contributor of the merge suite', 'CONTRIBUTOR', true, '2026-10-06T12:00:00Z'), ('${CURATOR}', 'merge-suite-b@harness-bible.local', 'Curator of the merge suite', 'CURATOR', true, NULL)`,
    );
  }, TIMEOUT);

  afterAll(async () => {
    if (ready) await clear();
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it(
    "branches a person's accepted wording change from main, one commit of the product's with § 3's trailers, and checks it: the dry run and the chapter's lab run by the runner, reproducing; a patch",
    async () => {
      const activities = mergeActivities(depsOf());
      const id = await accepted({ changeKind: "EDIT_TEXT", changeClass: "WORDING", anchor: { kind: "SECTION", sectionAnchor: "94.3", figureAnchor: null }, proposal: { kind: "EDIT_TEXT", before: RETRIES, after: "Retries are required at eleven steps." } });
      expect(await activities.prepareMerge(id)).toEqual({ outcome: "BRANCHED" });
      const branch = `improve/${id}-wording-94-3`;
      const tip = sh(["rev-parse", branch]);
      expect(await readMerge(MERGE, id)).toMatchObject({ branch, commitSha: tip, versionFrom: "v1.0.0", releaseFrom: "2026.09", versionTo: null, mergedAt: null });
      expect(await checkOf(id)).toEqual({ stage: "BRANCHED", at: AT.toISOString(), sha: tip });
      expect((await readSuggestionAsService(MERGE, id))?.state).toBe("MERGING");
      /* one commit on main, the product's, dated by the accept, with the trailers and no person's name (D2) */
      expect(sh(["rev-parse", `${tip}~1`])).toBe(first);
      expect(sh(["log", "-1", "--format=%an <%ae>|%cn <%ce>|%aI", tip])).toBe("Harness Bible <improve@harness-bible.local>|Harness Bible <improve@harness-bible.local>|2026-10-09T10:00:00Z");
      expect(sh(["log", "-1", "--format=%B", tip])).toBe([`${id}: edit the text at 94.3`, "", `Suggestion: ${id}`, "Rubric-Version: v1.2", "Adjudicator: service:adjudicator", `Record: ${RECORD}`].join("\n"));
      expect(sh(["diff", "--name-only", first, tip])).toBe(CHAPTER_PATH);
      expect(sh(["show", `${tip}:${CHAPTER_PATH}`])).toContain("Retries are required at eleven steps.");
      expect(sh(["rev-parse", "main"])).toBe(first);
      /* a step run again makes the same commit */
      expect(await activities.prepareMerge(id)).toEqual({ outcome: "BRANCHED" });
      expect(sh(["rev-parse", branch])).toBe(tip);

      expect(await activities.checkMerge(id)).toEqual({ verdict: "PASSED" });
      const check = await checkOf(id);
      expect(check).toMatchObject({ stage: "CHECKED", hand: null, sha: tip, main: first, lint: "PASS", lab: "PASS", verdict: "PASSED", failure: null, bump: "patch", labId: "lab-94", touchesLab: false, suite: { reproduced: 1, total: 1, failing: [] } });
      if (check.stage !== "CHECKED") throw new Error("not checked");
      expect(check.chapters.map((chapter) => chapter.number)).toEqual([94]);
      /* the lab's run: the runner's, ended, nothing moved but its timestamp, its whole output kept under its key */
      expect(check.labRun).toMatchObject({ runner: "python", exitCode: 0, timedOut: false, reason: null, figures: [], keys: [], outputKey: `merges/${id}/${tip}.log` });
      expect(kept.get(`merges/${id}/${tip}.log`)).toContain("p_no_failure_13calls_f0.02 0.769");
      expect(check.labRun?.tail).toContain("p_no_failure_13calls_f0.02 0.769");
      /* the diff, for the queue's detail */
      expect(check.diff.truncated).toBe(false);
      expect(check.diff.text).toContain(`+++ b/${CHAPTER_PATH}`);
      /* by words: the paragraph is one line, and the change is the run of it that moved */
      expect(check.diff.text.split("\n")).toEqual(expect.arrayContaining(["-not optional", "+required"]));
      expect(await readMerge(MERGE, id)).toMatchObject({ commitSha: tip, bump: "patch" });
    },
    TIMEOUT,
  );

  it(
    "leaves a derived figure to the curator's hand (invariant 5): an empty branch, what it still lacks, then its lab decides — results changed by hand fail, named; a script that prints them passes; their branch is never moved",
    async () => {
      const activities = mergeActivities(depsOf({ records: curated }));
      const figure = figureByValue("77%");
      const id = await accepted({ changeKind: "SET_VALUE", changeClass: "DERIVED_FIGURE", anchor: { kind: "FIGURE", sectionAnchor: "94.3", figureAnchor: figure.id }, proposal: { kind: "SET_VALUE", after: "78", unit: "%" }, state: "MERGING" });
      expect(await activities.prepareMerge(id)).toEqual({ outcome: "MANUAL" });
      const branch = (await readMerge(MERGE, id))?.branch ?? "";
      expect(branch).toBe(`improve/${id}-derived-figure-${figure.id.toLowerCase()}`);
      expect(await checkOf(id)).toMatchObject({ stage: "MANUAL", hand: { refusal: "manual", row: figure.id }, missing: "COMMIT" });
      expect(sh(["rev-parse", branch])).toBe(first);
      expect((await readMerge(MERGE, id))?.commitSha).toBeNull();
      expect(await activities.checkMerge(id)).toEqual({ verdict: "MANUAL" });
      expect(await checkOf(id)).toMatchObject({ stage: "MANUAL", missing: "COMMIT" });

      /* the curator's commit: the figure's text, but not its script */
      curatorCommit(branch, { [CHAPTER_PATH]: CH94.replace("only 77% of the time", "only 78% of the time") });
      expect(await activities.checkMerge(id)).toEqual({ verdict: "MANUAL" });
      expect(await checkOf(id)).toMatchObject({ stage: "MANUAL", missing: "DERIVE" });

      /* the results changed by hand and a comment in the script: the dry run passes, and the lab, run, prints what the script computes */
      const lab = join(root, "labs", LAB_FOLDER);
      const script = readFileSync(join(lab, "derive.py"), "utf8");
      const handResults = curatorCommit(branch, {
        [`labs/${LAB_FOLDER}/derive.py`]: `${script}\n# 2 % per call now prints 78 %\n`,
        [`labs/${LAB_FOLDER}/results/derived.json`]: readFileSync(join(lab, "results", "derived.json"), "utf8").replace('"p_no_failure_13calls_f0.02": 0.769', '"p_no_failure_13calls_f0.02": 0.78'),
      });
      expect(await activities.checkMerge(id)).toEqual({ verdict: "FAILED" });
      const failed = await checkOf(id);
      expect(failed).toMatchObject({ stage: "CHECKED", hand: { refusal: "manual", row: figure.id }, sha: handResults, main: first, lint: "PASS", lab: "FAIL", verdict: "FAILED", touchesLab: true });
      expect(failed.stage === "CHECKED" ? failed.labRun : null).toMatchObject({ exitCode: 0, figures: [{ id: figure.id, valueText: "78%", key: "p_no_failure_13calls_f0.02" }], keys: [{ key: "p_no_failure_13calls_f0.02", stated: "0.78", printed: "0.769" }] });

      /* the script that prints it: the lab reproduces the branch, and the change passes */
      const theirs = curatorCommit(branch, { [`labs/${LAB_FOLDER}/derive.py`]: script.replace('json.dump(out, open("results/derived.json","w"), indent=2)', 'out["p_no_failure_13calls_f0.02"] = 0.78\njson.dump(out, open("results/derived.json","w"), indent=2)') });
      expect(await activities.checkMerge(id)).toEqual({ verdict: "PASSED" });
      expect(await checkOf(id)).toMatchObject({ stage: "CHECKED", hand: { refusal: "manual", row: figure.id }, sha: theirs, lint: "PASS", lab: "PASS", verdict: "PASSED", touchesLab: true, bump: "patch" });
      expect((await readMerge(MERGE, id))?.commitSha).toBe(theirs);

      /* prepared again — a recheck — the curator's branch stays as they left it */
      expect(await activities.prepareMerge(id)).toEqual({ outcome: "MANUAL" });
      expect(sh(["rev-parse", branch])).toBe(theirs);
      expect(await activities.checkMerge(id)).toEqual({ verdict: "PASSED" });
    },
    TIMEOUT,
  );

  it(
    "sends the suggestion back to a curator when main moved under its anchor, main's text on the row and no branch made (§ 4.1 step 1)",
    async () => {
      const activities = mergeActivities(depsOf());
      const id = await accepted({ changeKind: "EDIT_TEXT", changeClass: "WORDING", anchor: { kind: "SECTION", sectionAnchor: "94.3", figureAnchor: null }, proposal: { kind: "EDIT_TEXT", before: RETRIES, after: "Retries are required at eleven steps." }, recorded: sha256("the section as the draft once read it") });
      expect(await activities.prepareMerge(id)).toEqual({ outcome: "MOVED", state: "CURATOR_QUEUE", decision: "CURATOR_REVIEW" });
      const row = await readSuggestionAsService(MERGE, id);
      expect(row).toMatchObject({ state: "CURATOR_QUEUE", outcome: "CURATOR_REVIEW", decidedAt: AT });
      expect(await checkOf(id)).toEqual({ stage: "MOVED", at: AT.toISOString(), now: anchorTextAt(book, CHAPTER, { kind: "SECTION", id: "94.3" }) });
      expect(sh(["branch", "--list", `improve/${id}*`])).toBe("");
      /* a step run again finds the suggestion where it sent it */
      expect(await activities.prepareMerge(id)).toEqual({ outcome: "NOT_MERGING", state: "CURATOR_QUEUE", decision: "CURATOR_REVIEW" });
    },
    TIMEOUT,
  );

  it(
    "fails a check whose change unlinks a derived figure, naming it, and returns the suggestion as a request for more, the branch kept (§ 4.4, § 4.5)",
    async () => {
      const activities = mergeActivities(depsOf());
      const id = await accepted({ changeKind: "ADD_CLAIM", changeClass: "NEW_CLAIM", anchor: { kind: "SECTION", sectionAnchor: "94.3", figureAnchor: null }, proposal: { kind: "ADD_CLAIM", text: "With four retries the task completes 63.2% of the time.", placeAfter: RETRIES, fastMoving: false } });
      expect(await activities.prepareMerge(id)).toEqual({ outcome: "BRANCHED" });
      expect(await activities.checkMerge(id)).toEqual({ verdict: "FAILED" });
      const check = await checkOf(id);
      expect(check).toMatchObject({ stage: "CHECKED", lint: "FAIL", verdict: "FAILED", failure: { reason: "unlinked-derived" }, chapters: [] });
      expect(check.stage === "CHECKED" ? check.failure?.detail : "").toContain("63.2%");

      expect(await activities.returnMerge(id)).toEqual({ state: "DECIDED", decision: "REQUEST_MORE" });
      expect(await readSuggestionAsService(MERGE, id)).toMatchObject({ state: "DECIDED", outcome: "REQUEST_MORE", decidedAt: AT });
      expect(sh(["branch", "--list", `improve/${id}*`])).not.toBe("");
      /* a step run again finds the move made */
      expect(await activities.returnMerge(id)).toEqual({ state: "DECIDED", decision: "REQUEST_MORE" });
      expect(await activities.checkMerge(id)).toEqual({ verdict: "NOT_MERGING", state: "DECIDED", decision: "REQUEST_MORE" });
    },
    TIMEOUT,
  );

  it(
    "leaves the lab not run where the runner does not start, or the lab does not run on main either — a lab-free change passing, stated (D4); fails it where it runs on main alone (§ 4.4); a step that fails says so on the row",
    async () => {
      const id = await accepted({ changeKind: "EDIT_TEXT", changeClass: "WORDING", anchor: { kind: "SECTION", sectionAnchor: "94.3", figureAnchor: null }, proposal: { kind: "EDIT_TEXT", before: RETRIES, after: "Retries are required at eleven steps." } });
      expect(await mergeActivities(depsOf()).prepareMerge(id)).toEqual({ outcome: "BRANCHED" });
      const labRunOf = async (): Promise<unknown> => {
        const check = await checkOf(id);
        return check.stage === "CHECKED" ? { lab: check.lab, verdict: check.verdict, reason: check.labRun?.reason } : check.stage;
      };

      /* no runner here: not the change's, so not run; a wording change cannot move a derived figure, and passes, saying so (D4) */
      const absent = mergeActivities(depsOf({ runLab: async () => ended({ exitCode: null, stderr: "spawn docker ENOENT" }) }));
      expect(await absent.checkMerge(id)).toEqual({ verdict: "PASSED" });
      expect(await labRunOf()).toEqual({ lab: "NOT_RUN", verdict: "PASSED", reason: "the runner did not start: spawn docker ENOENT" });

      /* a lab that does not run on main either cannot be run here */
      const broken = mergeActivities(depsOf({ runLab: async () => ended({ exitCode: 1, stderr: "ModuleNotFoundError: No module named 'numpy'" }) }));
      expect(await broken.checkMerge(id)).toEqual({ verdict: "PASSED" });
      expect(await labRunOf()).toEqual({ lab: "NOT_RUN", verdict: "PASSED", reason: "the lab does not run here, on main either: ModuleNotFoundError: No module named 'numpy'" });

      /* one that runs on main and not on the branch: the change broke it, whatever its kind */
      const tip = sh(["rev-parse", `improve/${id}-wording-94-3`]);
      /* the tree a run is in is told by the commit its worktree holds */
      const branchOnly = mergeActivities(depsOf({ runLab: async (labDir) => (sh(["rev-parse", "HEAD"], labDir) === tip ? ended({ exitCode: 1, stderr: "Traceback: KeyError" }) : python(labDir)) }));
      expect(await branchOnly.checkMerge(id)).toEqual({ verdict: "FAILED" });
      expect(await labRunOf()).toEqual({ lab: "FAIL", verdict: "FAILED", reason: "the lab runs on main and not on the branch: Traceback: KeyError" });

      /* a step that fails says so on the row, then is thrown on for the engine's attempts; a pass that works writes over it */
      const fallen = mergeActivities(depsOf({ runLab: async () => Promise.reject(new Error(["the runner fell over", "at its second line"].join("\n"))) }));
      await expect(fallen.checkMerge(id)).rejects.toThrow("the runner fell over");
      expect(await checkOf(id)).toEqual({ stage: "ERROR", at: AT.toISOString(), step: "check", code: "Error", message: "the runner fell over" });
      expect(await mergeActivities(depsOf()).checkMerge(id)).toEqual({ verdict: "PASSED" });
      expect((await checkOf(id)).stage).toBe("CHECKED");
    },
    TIMEOUT,
  );

  it(
    "waits with the reason when there is no repository, its suggestion in MERGING, and writes no file anywhere (§ 12.10)",
    async () => {
      const activities = mergeActivities(depsOf({ repo: () => openBookRepo(undefined) }));
      const id = await accepted({ changeKind: "EDIT_TEXT", changeClass: "WORDING", anchor: { kind: "SECTION", sectionAnchor: "94.3", figureAnchor: null }, proposal: { kind: "EDIT_TEXT", before: RETRIES, after: "Retries are required at eleven steps." } });
      const refs = sh(["for-each-ref", "--format=%(refname) %(objectname)"]);
      expect(await activities.prepareMerge(id)).toEqual({ outcome: "UNAVAILABLE" });
      expect(await readSuggestionAsService(MERGE, id)).toMatchObject({ state: "MERGING" });
      expect(await readMerge(MERGE, id)).toMatchObject({ commitSha: null });
      const check = await checkOf(id);
      expect(check).toMatchObject({ stage: "UNAVAILABLE" });
      expect(check.stage === "UNAVAILABLE" ? check.reason : "").toContain("BOOK_REPO_DIR is not set");
      expect(await activities.checkMerge(id)).toEqual({ verdict: "UNAVAILABLE" });
      expect(sh(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refs);
    },
    TIMEOUT,
  );

  describe("a curator's merge, published into the suite's own database (37 § 5; unit 54c)", () => {
    /*
     * What a merge publishes goes to a database of this suite's own, made and migrated here, given the fixture's release
     * 2026.09 as the operator tagged it, its sections' vectors as the embedding job leaves them, and dropped after: the
     * development database's current release never moves for a test. The suggestions, their merges and the repository
     * are the suite's as above; the curator's merges are made as the endpoint makes them, and the records the merge
     * writes are kept here by their step keys, not appended.
     */
    const SCRATCH = `hb_merge_suite_${String(process.pid)}`;
    const scratchUrl = (): string => {
      const url = new URL(env.DATABASE_URL ?? "postgresql://localhost/none");
      url.pathname = `/${SCRATCH}`;
      return url.toString();
    };
    const reports = mkdtempSync(join(tmpdir(), "hb-merge-reports-"));
    /* the merge of 94.4, which the revert's case undoes */
    let merged94 = "" as SuggestionId;
    /* the commit of main the suite's database's release 2026.09 is: the fixture with its second chapter */
    let based = "";
    const appended: Array<{ readonly input: AppendInput; readonly stepKey: string }> = [];
    const actions = new Map<string, CuratorActionForService>();

    async function scratch<T>(fn: (client: Client) => Promise<T>, database: string = scratchUrl()): Promise<T> {
      const client = new Client({ connectionString: database });
      await client.connect();
      try {
        return await fn(client);
      } finally {
        await client.end();
      }
    }

    const current = (): Promise<{ readonly id: string }> => scratch(async (client) => (await client.query<{ id: string }>(`SELECT id FROM "Release" WHERE "isCurrent"`)).rows[0] ?? { id: "none" });
    const releasesNow = (): Promise<ReadonlyArray<{ readonly id: string; readonly gitSha: string; readonly renderHash: string; readonly isCurrent: boolean }>> => scratch(async (client) => (await client.query(`SELECT id, "gitSha", "renderHash", "isCurrent" FROM "Release" ORDER BY id`)).rows);
    const sectionsOf = (releaseId: string): Promise<ReadonlyArray<{ readonly anchor: string; readonly ready: boolean; readonly markdown: string }>> =>
      scratch(async (client) => (await client.query(`SELECT s.anchor, s.embedding IS NOT NULL AS ready, s."markdownEn" AS markdown FROM "Section" s JOIN "ChapterVersion" cv ON cv.id = s."chapterVersionId" WHERE cv."releaseId" = $1 ORDER BY s.ordinal`, [releaseId])).rows);

    /** The chain as the merge reads it: the contributor's submission, the adjudicator's accept, and what the merge recorded. */
    const chain: MergeActivityDeps["records"] = async (suggestionId) => [
      { kind: "SUBMITTED", actor: `user:${CONTRIBUTOR}`, hash: "cd".repeat(32), payload: {} },
      { kind: "DECIDED", actor: "service:adjudicator", hash: RECORD, payload: { decision: "ACCEPT" } },
      ...appended.filter((entry) => entry.input.suggestionId === suggestionId).map((entry) => ({ kind: entry.input.kind, actor: entry.input.actor, hash: "ef".repeat(32), payload: entry.input.payload as never })),
    ];

    /** The merge's own reads and processes on the suite's database; the release and the chapter's version it starts from are that database's current. */
    function merging(over: Partial<MergeActivityDeps> = {}): MergeActivityDeps {
      return depsOf({
        releaseId: async () => (await current()).id,
        chapterVersion: (chapterNumber) => scratch(async (client) => (await client.query(`SELECT cv.id, cv.version FROM "ChapterVersion" cv JOIN "Release" r ON r.id = cv."releaseId" WHERE r."isCurrent" AND cv."chapterNumber" = $1`, [chapterNumber])).rows[0] ?? null),
        records: chain,
        /* a merge's action is the suite's own; a revert's is the door's, on the suggestion it undoes (unit 54e) */
        action: async (actionId) => actions.get(actionId) ?? (await readCuratorAction({ kind: "service", id: "service:merge" }, actionId)),
        revertOf: (suggestionId) => revertOf(MERGE, suggestionId),
        partsOf: async () => ["P2"],
        append: async (input, stepKey) => {
          appended.push({ input, stepKey });
          return { seq: appended.length };
        },
        releases: () => scratch(async (client) => (await client.query<{ id: string }>(`SELECT id FROM "Release"`)).rows.map((row) => row.id)),
        releaseOf: (id) => scratch(async (client) => (await client.query(`SELECT id, "gitSha", "renderHash", "isCurrent" FROM "Release" WHERE id = $1`, [id])).rows[0] ?? null),
        chapterVersionIn: (releaseId, chapterNumber) => scratch(async (client) => (await client.query(`SELECT id, version FROM "ChapterVersion" WHERE "releaseId" = $1 AND "chapterNumber" = $2`, [releaseId, chapterNumber])).rows[0] ?? null),
        ingest: (input) => runIngestion({ ...input, mermaid: false, reportDir: reports, databaseUrl: scratchUrl() }),
        carry: (input) => runEmbedCarry({ ...input, databaseUrl: scratchUrl() }),
        ...over,
      });
    }

    /** A curator's merge of a suggestion, as the endpoint writes one once its check passed. */
    function merged(suggestionId: string): string {
      const id = randomUUID();
      actions.set(id, { id, suggestionId, curatorId: CURATOR, action: "MERGE", overrideCode: null, criterion: null, noteSha256: null, seeded: false, seedMatched: null, queueWaitMs: 0, createdAt: AT });
      return id;
    }

    /** An accepted wording change of a section's sentence, prepared and checked: passed. */
    async function passedChange(activities: ReturnType<typeof mergeActivities>, section: string, before: string, after: string): Promise<{ readonly id: SuggestionId; readonly check: Extract<MergeCheck, { stage: "CHECKED" }> }> {
      const id = await accepted({ changeKind: "EDIT_TEXT", changeClass: "WORDING", anchor: { kind: "SECTION", sectionAnchor: section, figureAnchor: null }, proposal: { kind: "EDIT_TEXT", before, after } });
      expect(await activities.prepareMerge(id)).toEqual({ outcome: "BRANCHED" });
      expect(await activities.checkMerge(id)).toEqual({ verdict: "PASSED" });
      const check = await checkOf(id);
      if (check.stage !== "CHECKED") throw new Error("not checked");
      return { id, check };
    }

    beforeAll(async () => {
      await scratch((client) => client.query(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`), env.DATABASE_URL);
      await scratch((client) => client.query(`CREATE DATABASE "${SCRATCH}"`), env.DATABASE_URL);
      execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: scratchUrl() }, stdio: "pipe" });
      /* a second chapter on main, the operator's commit, made in a worktree of theirs */
      const tree = join(mkdtempSync(join(tmpdir(), "hb-operator-")), "tree");
      sh(["worktree", "add", "--quiet", tree, "main"]);
      write(tree, CH93_PATH, CH93);
      write(tree, "book/registry/ch93-verify.md", fixture("ch21-verify.md"));
      write(tree, "book/registry/ch93-redteam.md", fixture("ch21-redteam.md"));
      sh(["add", "-A"], tree);
      sh(["commit", "--quiet", "-m", "Chapter 93"], tree);
      sh(["worktree", "remove", "--force", tree]);
      based = sh(["rev-parse", "main"]);
      /* release 2026.09: that tree, ingested as the operator ingests */
      const baseTree = join(mkdtempSync(join(tmpdir(), "hb-base-")), "tree");
      sh(["worktree", "add", "--quiet", "--detach", baseTree, based]);
      try {
        const baseBook = loadBook(baseTree);
        const hashes = baseBook.chapters.map((file) => {
          const built = buildChapter(file, baseBook, { locale: "en", previous: new Map() });
          return { number: built.number, hash: built.contentHash };
        });
        expect(hashes.map((entry) => entry.number).sort()).toEqual([93, CHAPTER]);
        const base = await runIngestion({ bookDir: baseTree, releaseId: "2026.09", expectHash: renderHash(hashes, "2026.09"), gitSha: based, mermaid: false, reportDir: reports, databaseUrl: scratchUrl() });
        if (base.exitCode !== 0) throw new Error(`the fixture's release did not ingest: ${saidOf(base)}`);
      } finally {
        sh(["worktree", "remove", "--force", baseTree]);
      }
      /* its sections' vectors, as the embedding job would have left them */
      await scratch((client) => client.query(`UPDATE "Section" s SET embedding = array_fill(0.5::real, ARRAY[1024])::vector, "embeddingModel" = $1, "embeddedAt" = now() FROM "ChapterVersion" cv WHERE cv.id = s."chapterVersionId" AND cv."releaseId" = '2026.09'`, [EMBED_TARGET]));
    }, 300_000);

    afterAll(async () => {
      if (env.DATABASE_URL !== undefined) await scratch((client) => client.query(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`), env.DATABASE_URL);
      rmSync(reports, { recursive: true, force: true });
    });

    it(
      "merges a checked branch: the curator's merge recorded, the changelog's line, main fast-forwarded and tagged 2026.10, the tag ingested with the check's render hash, the unchanged sections' vectors carried, the merged record; MERGED",
      async () => {
        const activities = mergeActivities(merging());
        const { id, check } = await passedChange(activities, "94.3", RETRIES, "Retries are required at eleven steps.");
        const workflowId = `merge:${id}`;
        const branch = `improve/${id}-wording-94-3`;

        /* § 5: the curator's merge, recorded once under this workflow's step key; another suggestion's action is none of it */
        const action = merged(id);
        expect(await activities.recordMergeAction(id, workflowId, action)).toEqual({ recorded: true });
        expect(await activities.recordMergeAction(id, workflowId, action)).toEqual({ recorded: true });
        const curator = appended.filter((entry) => entry.input.suggestionId === id && entry.input.kind === "CURATOR");
        expect(curator).toHaveLength(1);
        expect(curator[0]).toMatchObject({ stepKey: stepKeyOf(workflowId, `curator:${action}`), input: { actor: `user:${CURATOR}`, chapterVersionId: CHAPTER_VERSION, payload: { action: "MERGE", overrideCode: null, criterion: null, noteSha256: null, seeded: false, part: "P2" } } });
        expect(await activities.recordMergeAction(id, workflowId, merged("S-94-9999"))).toEqual({ recorded: false });

        /* § 5 steps 1 to 3: the changelog's line on the branch, main moved to it from where the check found it, the tag */
        expect(await activities.mergeMain(id)).toEqual({ outcome: "TAGGED", releaseId: "2026.10" });
        const tagged = sh(["rev-parse", "main"]);
        expect(sh(["rev-parse", "release/2026.10^{commit}"])).toBe(tagged);
        expect(sh(["rev-parse", `${tagged}~1`])).toBe(check.sha);
        expect(check.main).toBe(based);
        expect(sh(["diff", "--name-only", check.sha, tagged])).toBe("book/CHANGELOG.md");
        expect(sh(["show", `${tagged}:book/CHANGELOG.md`])).toBe(`# Changelog\n\n- ch94 v1.0.1, release 2026.10: edit the text at 94.3 (${id}).`);
        expect(sh(["log", "-1", "--format=%an <%ae>|%B", tagged])).toBe([`Harness Bible <improve@harness-bible.local>|${id}: the changelog's line for 2026.10`, "", `Suggestion: ${id}`, "Release: 2026.10"].join("\n"));
        expect(await readMerge(MERGE, id)).toMatchObject({ releaseTo: "2026.10", versionTo: "v1.0.1", mergedAt: null });
        /* a step run again moves nothing and tags nothing twice */
        expect(await activities.mergeMain(id)).toEqual({ outcome: "TAGGED", releaseId: "2026.10" });
        expect(sh(["rev-parse", "main"])).toBe(tagged);
        expect(sh(["tag", "--list", "release/*"]).split("\n")).toEqual(["release/2026.09", "release/2026.10"]);

        /* § 5 steps 4 to 6: published under the check's render hash and current; every section but the changed one ready */
        const published = await activities.publishMerge(id);
        const sections = await sectionsOf("2026.10");
        expect(published).toEqual({ releaseId: "2026.10", carried: sections.length - 1 });
        expect(sections.filter((section) => !section.ready).map((section) => section.anchor)).toEqual(["94.3"]);
        expect(sections.find((section) => section.anchor === "94.3")?.markdown).toContain("Retries are required at eleven steps.");
        /* the chapter no merge changed is in the release too, at its version (04 § 6.10; unit 54c's dropped key) */
        expect(await merging().chapterVersionIn("2026.10", 93)).toMatchObject({ version: "v1.0.0" });
        expect(sections.filter((section) => section.anchor.startsWith("93.")).length).toBeGreaterThan(0);
        expect(await releasesNow()).toEqual([
          { id: "2026.09", gitSha: based, renderHash: expect.any(String), isCurrent: false },
          { id: "2026.10", gitSha: tagged, renderHash: renderHash(check.chapters, "2026.10"), isCurrent: true },
        ]);
        /* a step run again publishes nothing twice */
        expect((await activities.publishMerge(id)).releaseId).toBe("2026.10");
        expect(await releasesNow()).toHaveLength(2);

        /* § 5 step 7: the merged record on the chapter's new version, the row done, MERGED, the branch deleted */
        expect(await activities.recordMerged(id, workflowId, action)).toEqual({ state: "MERGED", decision: "ACCEPT" });
        const version = await merging().chapterVersionIn("2026.10", CHAPTER);
        expect(version?.version).toBe("v1.0.1");
        const record = appended.filter((entry) => entry.input.suggestionId === id && entry.input.kind === "MERGED");
        expect(record).toHaveLength(1);
        expect(record[0]).toMatchObject({
          stepKey: stepKeyOf(workflowId, "merged"),
          input: {
            actor: "service:merge",
            chapterVersionId: version?.id,
            payload: { branch, commitSha: tagged, versionFrom: "v1.0.0", versionTo: "v1.0.1", bump: "patch", releaseFrom: "2026.09", releaseTo: "2026.10", renderHash: renderHash(check.chapters, "2026.10"), check: { lab: "PASS", lint: "PASS" }, contributor: `user:${CONTRIBUTOR}`, endorsedBy: null, mergedBy: `user:${CURATOR}`, reverts: null },
          },
        });
        expect(await readMerge(MERGE, id)).toMatchObject({ commitSha: tagged, versionTo: "v1.0.1", releaseTo: "2026.10", mergedAt: AT });
        expect((await checkOf(id)).stage).toBe("CHECKED");
        /* the decision's time is the decision's: a merge moves the suggestion and nothing else */
        expect(await readSuggestionAsService(MERGE, id)).toMatchObject({ state: "MERGED", outcome: "ACCEPT", decidedAt: DECIDED_AT });
        expect(sh(["branch", "--list", branch])).toBe("");
        expect(await activities.recordMerged(id, workflowId, action)).toEqual({ state: "MERGED", decision: "ACCEPT" });
        expect(appended.filter((entry) => entry.input.suggestionId === id && entry.input.kind === "MERGED")).toHaveLength(1);
      },
      300_000,
    );

    it(
      "checks again where main moved since the check, tagging nothing; checked on the new main, merges as the month's second release, 2026.10.2 (§ 5 step 2, D1)",
      async () => {
        const activities = mergeActivities(merging());
        const { id } = await passedChange(activities, "94.2", "A workflow does no I/O of its own.", "A workflow performs no I/O of its own.");
        const workflowId = `merge:${id}`;
        const action = merged(id);
        expect(await activities.recordMergeAction(id, workflowId, action)).toEqual({ recorded: true });

        /* an editor's commit on main, made as a person makes one, in a worktree of their own */
        const tree = join(mkdtempSync(join(tmpdir(), "hb-editor-")), "tree");
        sh(["worktree", "add", "--quiet", tree, "main"]);
        write(tree, "notes/editor.md", "An editor's note.\n");
        sh(["add", "-A"], tree);
        sh(["commit", "--quiet", "-m", "An editor's note"], tree);
        sh(["worktree", "remove", "--force", tree]);
        const moved = sh(["rev-parse", "main"]);
        const tags = sh(["tag", "--list", "release/*"]);

        expect(await activities.mergeMain(id)).toEqual({ outcome: "AGAIN" });
        expect(sh(["rev-parse", "main"])).toBe(moved);
        expect(sh(["tag", "--list", "release/*"])).toBe(tags);
        expect(await readMerge(MERGE, id)).toMatchObject({ releaseTo: null });

        /* the workflow prepares and checks again on the new main, the curator's merge standing */
        expect(await activities.prepareMerge(id)).toEqual({ outcome: "BRANCHED" });
        expect(await activities.checkMerge(id)).toEqual({ verdict: "PASSED" });
        expect(await checkOf(id)).toMatchObject({ stage: "CHECKED", main: moved });
        expect(await activities.recordMergeAction(id, workflowId, action)).toEqual({ recorded: true });
        expect(await activities.mergeMain(id)).toEqual({ outcome: "TAGGED", releaseId: "2026.10.2" });
        expect(sh(["show", "main:book/CHANGELOG.md"]).split("\n").at(-1)).toBe(`- ch94 v1.0.2, release 2026.10.2: edit the text at 94.2 (${id}).`);
        expect((await activities.publishMerge(id)).releaseId).toBe("2026.10.2");
        /* the vectors carry from the release it started from: 94.3 still waits for the job, as it did there, and 94.2 changed */
        expect((await sectionsOf("2026.10.2")).filter((section) => !section.ready).map((section) => section.anchor)).toEqual(["94.2", "94.3"]);
        expect(await activities.recordMerged(id, workflowId, action)).toEqual({ state: "MERGED", decision: "ACCEPT" });
        expect(appended.filter((entry) => entry.input.suggestionId === id && entry.input.kind === "MERGED")[0]?.input.payload).toMatchObject({ versionFrom: "v1.0.1", versionTo: "v1.0.2", releaseFrom: "2026.10", releaseTo: "2026.10.2" });
        expect((await releasesNow()).filter((release) => release.isCurrent).map((release) => release.id)).toEqual(["2026.10.2"]);
      },
      300_000,
    );

    it(
      "publishes nothing where the ingestion's render hash is not the check's; the merge's row says so beside the check it kept, and the step goes on from it (§ 5 step 4, invariant 2)",
      async () => {
        const activities = mergeActivities(merging());
        const { id, check } = await passedChange(activities, "94.4", "A rising retry rate on one tool is that tool's problem, not the agent's.", "A rising retry rate on one tool is that tool's problem, never the agent's.");
        merged94 = id;
        const workflowId = `merge:${id}`;
        const action = merged(id);
        expect(await activities.recordMergeAction(id, workflowId, action)).toEqual({ recorded: true });
        expect(await activities.mergeMain(id)).toEqual({ outcome: "TAGGED", releaseId: "2026.10.3" });

        /* a double whose hash differs, as a pipeline changed under the check would make it */
        const differs = mergeActivities(merging({ ingest: (input) => runIngestion({ ...input, expectHash: "0".repeat(64), mermaid: false, reportDir: reports, databaseUrl: scratchUrl() }) }));
        await expect(differs.publishMerge(id)).rejects.toMatchObject({ type: "RENDER_HASH_MISMATCH" });
        const failed = await checkOf(id);
        expect(failed).toMatchObject({ stage: "ERROR", step: "merge", code: "RENDER_HASH_MISMATCH", checked: { stage: "CHECKED", sha: check.sha } });
        expect((await releasesNow()).map((release) => release.id)).toEqual(["2026.09", "2026.10", "2026.10.2"]);
        expect((await releasesNow()).filter((release) => release.isCurrent).map((release) => release.id)).toEqual(["2026.10.2"]);

        /* a recheck's publish goes on from the check the error kept, and the record puts the check back */
        expect((await activities.publishMerge(id)).releaseId).toBe("2026.10.3");
        expect(await activities.recordMerged(id, workflowId, action)).toEqual({ state: "MERGED", decision: "ACCEPT" });
        expect(await checkOf(id)).toMatchObject({ stage: "CHECKED", sha: check.sha });
      },
      300_000,
    );

    it(
      "reverts a merged change (§ 8; unit 54e): the curator's action on the original, the revert merging from the start with the exchanged edit, the same steps, the text restored byte for byte, the version bumped, the merged record naming what it reverts; and the original in precision's numerator",
      async () => {
        /* the original: the merge of 94.4 above, whose text main holds now, accepted by the adjudicator as its records say */
        const originalId = merged94;
        expect(originalId).not.toBe("");
        await getPrisma().$executeRawUnsafe(`INSERT INTO "Adjudication" ("suggestionId", "decision", "decidedBy", "score", "acceptAt", "floorAt", "rubricVersionId", "decidedAt", "traceId") VALUES ('${originalId}', 'ACCEPT', 'adjudicator', 80, 70, 25, 'v1.2', '${DECIDED_AT.toISOString()}', '${"f".repeat(32)}')`);
        const accepts = () => adjudicatorAcceptsBetween(curatorOfP2, new Date("2026-10-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z")).then((rows) => rows.filter((row) => row.reverted));
        expect(await accepts()).toHaveLength(0);
        const before = sh(["show", `release/2026.09:${CHAPTER_PATH}`]);
        const changed = sh(["show", `main:${CHAPTER_PATH}`]);
        expect(changed).toContain("never the agent's.");
        expect(before).toContain("not the agent's.");
        const originalRow = await readSuggestionAsService(MERGE, originalId);
        if (originalRow?.anchor == null) throw new Error("the original has no anchor");

        /* the curator's revert through the door: the exchanged edit on the anchor as the release reads it now, the action with its note, the original's merge naming the revert */
        const repo = await openBookRepo(root);
        const nowText = await withTreeAt(repo, "main", async (dir) => anchorTextAt(loadBook(dir), CHAPTER, { kind: "SECTION", id: "94.4" }));
        const revertInput = { originalId, note: "The tool's problem is sometimes the agent's.", releaseId: "2026.10.3", chapterVersionId: (await merging().chapterVersionIn("2026.10.3", CHAPTER))?.id ?? "", proposal: { kind: "EDIT_TEXT" as const, before: "A rising retry rate on one tool is that tool's problem, never the agent's.", after: "A rising retry rate on one tool is that tool's problem, not the agent's." }, proposalKey: sha256(`revert of ${originalId}`), changeKind: "EDIT_TEXT" as const, anchor: { ...originalRow.anchor, currentText: nowText ?? "", contentSha256: sha256(nowText ?? "") } };
        /* two reverts of the same change at the same moment, two presses or two curators (unit 54's review): one is written, the other's rows are rolled back, and the original names the one */
        const race = await Promise.all([createRevert(curatorOfP2, revertInput, AT), createRevert(curatorOfP2, { ...revertInput, note: "the same, a moment later" }, AT)]);
        const winners = race.filter((outcome) => outcome.written);
        expect(winners).toHaveLength(1);
        const written = winners[0];
        if (written === undefined || !written.written) throw new Error("the revert was not written");
        expect(await getPrisma().curatorAction.count({ where: { suggestionId: originalId, action: "REVERT" } })).toBe(1);
        const revertId = SuggestionIdSchema.parse(written.revertId);
        const { actionId } = written;
        expect(await readMerge(MERGE, originalId)).toMatchObject({ revertedBy: revertId });
        expect(await readSuggestionAsService(MERGE, revertId)).toMatchObject({ origin: "CURATOR", state: "MERGING", outcome: "ACCEPT", changeKind: "EDIT_TEXT", parts: ["P2"] });
        expect(await revertOf(MERGE, revertId)).toBe(originalId);
        /* once: a second revert of the same change is refused, and nobody's own or another part's */
        expect(await createRevert(curatorOfP2, { originalId, note: "again", releaseId: "2026.10.3", chapterVersionId: "x", proposal: { kind: "RESTRUCTURE", description: "x" }, proposalKey: "k", changeKind: "RESTRUCTURE", anchor: originalRow.anchor }, AT)).toEqual({ written: false });
        expect(await createRevert({ ...curatorOfP2, parts: ["P1"] }, { originalId, note: "again", releaseId: "2026.10.3", chapterVersionId: "x", proposal: { kind: "RESTRUCTURE", description: "x" }, proposalKey: "k", changeKind: "RESTRUCTURE", anchor: originalRow.anchor }, AT)).toEqual({ written: false });
        /* the original is in precision's numerator from the action on (36 § 6.1) */
        expect(await accepts()).toHaveLength(1);

        /* the merge in the other direction: the revert's commit follows from the curator's REVERT record on it, recorded before it prepares, and taken again once the check passed */
        const workflowId = `merge:${revertId}`;
        const revert = mergeActivities(merging({ records: async (suggestionId) => (suggestionId === revertId ? appended.filter((entry) => entry.input.suggestionId === revertId).map((entry) => ({ kind: entry.input.kind, actor: entry.input.actor, hash: "ef".repeat(32), payload: entry.input.payload as never })) : chain(suggestionId)) }));
        expect(await revert.recordMergeAction(revertId, workflowId, actionId)).toEqual({ recorded: true });
        expect(await revert.prepareMerge(revertId)).toEqual({ outcome: "BRANCHED" });
        expect(await revert.checkMerge(revertId)).toEqual({ verdict: "PASSED" });
        expect(await revert.recordMergeAction(revertId, workflowId, actionId)).toEqual({ recorded: true });
        const curator = appended.filter((entry) => entry.input.suggestionId === revertId && entry.input.kind === "CURATOR");
        expect(curator).toHaveLength(1);
        expect(curator[0]?.input).toMatchObject({ actor: `user:${CURATOR}`, payload: { action: "REVERT", origin: "CURATOR", noteSha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
        const tip = sh(["rev-parse", `improve/${revertId}-wording-94-4`]);
        expect(sh(["log", "-1", "--format=%s", tip])).toBe(`${revertId}: revert ${originalId} at 94.4`);
        expect(sh(["log", "-1", "--format=%B", tip])).toContain(`Reverts: ${originalId}`);
        expect(await revert.mergeMain(revertId)).toEqual({ outcome: "TAGGED", releaseId: "2026.10.4" });
        expect((await revert.publishMerge(revertId)).releaseId).toBe("2026.10.4");
        expect(await revert.recordMerged(revertId, workflowId, actionId)).toEqual({ state: "MERGED", decision: "ACCEPT" });

        /* the text restored byte for byte, the version bumped, the record naming what it reverts, the original's merge naming the revert */
        const restoredLine = sh(["show", `main:${CHAPTER_PATH}`]).split("\n").find((line) => line.includes("A rising retry rate"));
        expect(restoredLine).toBe(before.split("\n").find((line) => line.includes("A rising retry rate")));
        expect(await merging().chapterVersionIn("2026.10.4", CHAPTER)).toMatchObject({ version: "v1.0.4" });
        const record = appended.filter((entry) => entry.input.suggestionId === revertId && entry.input.kind === "MERGED");
        expect(record[0]?.input.payload).toMatchObject({ reverts: originalId, contributor: null, mergedBy: `user:${CURATOR}`, versionFrom: "v1.0.3", versionTo: "v1.0.4", releaseFrom: "2026.10.3", releaseTo: "2026.10.4" });
        expect(await readSuggestionAsService(MERGE, revertId)).toMatchObject({ state: "MERGED" });
        expect(await readMerge(MERGE, originalId)).toMatchObject({ revertedBy: revertId });
      },
      300_000,
    );

    it(
      "merges a researcher's proposal on a curator's accept alone (invariant 32): refused on the adjudicator's recommendation; accepted with a reader's name on it, it is merged, released and recorded with no contributor and the reader as its endorser (42 § 10.8; unit 61b)",
      async () => {
        const ENDORSER = "00000000-0000-4000-8000-0000000054b3";
        const id = await accepted({ changeKind: "EDIT_TEXT", changeClass: "WORDING", anchor: { kind: "SECTION", sectionAnchor: "94.1", figureAnchor: null }, proposal: { kind: "EDIT_TEXT", before: "The mechanism is old.", after: "The mechanism is not new." }, state: "MERGING" });
        /* a researcher's proposal: no contributor (the migration's check), its records the researcher's, the adjudicator's recommendation, a reader's name */
        await getPrisma().$executeRawUnsafe(`UPDATE "Suggestion" SET "origin" = 'RESEARCHER', "userId" = NULL WHERE "id" = '${id}'`);
        const recommended: Awaited<ReturnType<MergeActivityDeps["records"]>> = [
          { kind: "SUBMITTED", actor: "service:researcher", hash: "cd".repeat(32), payload: {} },
          { kind: "DECIDED", actor: "service:adjudicator", hash: RECORD, payload: { decision: "ACCEPT" } },
          { kind: "ENDORSED", actor: `user:${ENDORSER}`, hash: "aa".repeat(32), payload: { stepKey: "ab".repeat(32), consentAt: "2026-10-09T11:00:00.000Z", withdrawn: false } as never },
        ];
        const own = (suggestionId: string): Awaited<ReturnType<MergeActivityDeps["records"]>> => appended.filter((entry) => entry.input.suggestionId === suggestionId).map((entry) => ({ kind: entry.input.kind, actor: entry.input.actor, hash: "ef".repeat(32), payload: entry.input.payload as never }));

        /* the adjudicator's recommendation alone is no accept: nothing is committed */
        const recommendedOnly = mergeActivities(merging({ records: async (suggestionId) => [...recommended, ...own(suggestionId)] }));
        await expect(recommendedOnly.prepareMerge(id)).rejects.toMatchObject({ type: "NO_CURATOR_ACCEPT" });
        expect(sh(["log", "-1", "--format=%H", `improve/${id}-wording-94-1`])).toBe(sh(["rev-parse", "main"]));

        /* the curator's accept: the commit follows from it, and the road goes on to a release */
        const activities = mergeActivities(merging({ records: async (suggestionId) => [...recommended, { kind: "CURATOR", actor: `user:${CURATOR}`, hash: "bb".repeat(32), payload: { action: "ACCEPT" } as never }, ...own(suggestionId)] }));
        expect(await activities.prepareMerge(id)).toEqual({ outcome: "BRANCHED" });
        const tip = sh(["rev-parse", `improve/${id}-wording-94-1`]);
        expect(sh(["log", "-1", "--format=%B", tip])).toContain(`Curator: user:${CURATOR}`);
        expect(await activities.checkMerge(id)).toEqual({ verdict: "PASSED" });
        const workflowId = `merge:${id}`;
        const action = merged(id);
        expect(await activities.recordMergeAction(id, workflowId, action)).toEqual({ recorded: true });
        const tagged = await activities.mergeMain(id);
        expect(tagged.outcome).toBe("TAGGED");
        const release = (await activities.publishMerge(id)).releaseId;
        expect((await releasesNow()).find((row) => row.isCurrent)?.id).toBe(release);
        expect(await activities.recordMerged(id, workflowId, action)).toEqual({ state: "MERGED", decision: "ACCEPT" });
        expect(sh(["show", `main:${CHAPTER_PATH}`])).toContain("The mechanism is not new.");
        /* the merged record: no contributor, the reader who put their name to it, the curator who merged it; the history credits that name and marks the change research (lib/improve/history.test.ts) */
        const record = appended.filter((entry) => entry.input.suggestionId === id && entry.input.kind === "MERGED");
        expect(record).toHaveLength(1);
        expect(record[0]?.input.payload).toMatchObject({ origin: "RESEARCHER", contributor: null, endorsedBy: `user:${ENDORSER}`, mergedBy: `user:${CURATOR}`, releaseTo: release });
        expect(await readSuggestionAsService(MERGE, id)).toMatchObject({ origin: "RESEARCHER", state: "MERGED" });
      },
      300_000,
    );
  });

  it("leaves the operator's tree as it was: the same HEAD, their notes, and no worktree but theirs", () => {
    expect(sh(["status", "--porcelain"])).toBe(operator.status);
    expect(sh(["rev-parse", "HEAD"])).toBe(operator.head);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("the operator's notes\n");
    expect(sh(["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length).toBe(1);
    const own = join(root, ".git", "hb-worktrees");
    expect(existsSync(own) ? readdirSync(own) : []).toEqual([]);
  });
});
