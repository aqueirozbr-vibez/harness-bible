import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

/*
 * The book's repository (feature-specs/37 § 3; unit 54a), and the one code that writes to it. The `git` executable
 * through `execFile` with an argument array — no shell, no dependency — so an argument is passed exactly as written,
 * whatever it holds. It writes `improve/*` branches only, tags `release/*` only, and moves `main` only by a
 * fast-forward to an `improve/*` branch (54c). It never initialises, clones or deletes a repository, and never
 * writes `BOOK_DIR`: making the repository is the operator's act (§ 3).
 *
 * It works in worktrees of its own, under the repository's git directory, so the operator's checked-out tree is never
 * touched nor required to be clean; and it runs git with neither the system's nor the user's configuration, so no
 * line-ending conversion, signing prompt or credential helper of the machine changes what it writes. Commits and tags
 * are the product's own, with trailers naming the suggestion and the record; no contributor's name is ever written
 * into the repository (D2): credit lives on the history page, where consent governs it.
 *
 * Imported by the merge activities alone (a lint rule; § 3, "the write key").
 */

/** The product's identity in the repository: its commits and tags are its own, never a person's (D2). */
export const BOOK_REPO_IDENTITY = { name: "Harness Bible", email: "improve@harness-bible.local" } as const;

export interface BookRepo {
  /** The repository's top folder: the operator's checked-out tree, never written. */
  readonly dir: string;
  /** Its git directory, under which the adapter's worktrees live. */
  readonly gitDir: string;
}

const MAX_OUTPUT = 64 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
/** A suggestion's branch (§ 4.2): `improve/S-36-0198-<slug>`, the slug lower-case ASCII words. */
const IMPROVE_BRANCH = /^improve\/S-\d{2}-\d{4}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
/** A release's id (D1): the month's, with a serial from the month's second (`2026.10`, `2026.10.2`). */
const RELEASE_ID = /^\d{4}\.(?:0[1-9]|1[0-2])(?:\.[2-9]|\.[1-9]\d+)?$/;
/** A ref the adapter reads: a branch, a tag or a commit, never anything an option could hide in. */
const READABLE_REF = /^(?:[0-9a-f]{40}|main|improve\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*|release\/[0-9.]+)$/;
/** A trailer's key, as git writes them: `Suggestion`, `Rubric-Version`. */
const TRAILER_KEY = /^[A-Z][A-Za-z]*(?:-[A-Z][A-Za-z]*)*$/;

interface GitOptions {
  readonly cwd?: string;
  /** When the step happened: the commit's and the tag's own date, so a step run again writes the same objects. */
  readonly at?: Date;
  /** Exit codes that answer a question rather than fail it: `merge-base --is-ancestor`, `diff --quiet`. */
  readonly answers?: ReadonlyArray<number>;
}

interface GitResult {
  readonly code: number;
  readonly stdout: string;
}

/**
 * git, as the adapter runs it. The child's environment is made here, not inherited (the aid runner does the same,
 * lib/aids/run.ts): the path to find git, Windows' own root, and the settings that keep the machine out — no system
 * configuration, a global one that does not exist, no prompt, the C locale for output the adapter parses, and the
 * product as author and committer. Long paths are on: a worktree of the adapter's sits deep under the git directory,
 * and on Windows a book's file there passed the 260 characters git otherwise refuses (unit 54b's live run); elsewhere
 * the setting is nothing.
 */
function runGit(repoDir: string, gitDir: string | null, args: ReadonlyArray<string>, options: GitOptions = {}): Promise<GitResult> {
  const at = options.at?.toISOString();
  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    /* A file that is never made: git reads no user configuration from it. */
    GIT_CONFIG_GLOBAL: join(gitDir ?? repoDir, "hb-no-user-config"),
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_AUTHOR_NAME: BOOK_REPO_IDENTITY.name,
    GIT_AUTHOR_EMAIL: BOOK_REPO_IDENTITY.email,
    GIT_COMMITTER_NAME: BOOK_REPO_IDENTITY.name,
    GIT_COMMITTER_EMAIL: BOOK_REPO_IDENTITY.email,
    ...(at === undefined ? {} : { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }),
  };
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-c", "core.longpaths=true", ...args], { cwd: options.cwd ?? repoDir, env: childEnv, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      if (code === 0 || (options.answers ?? []).includes(code)) {
        resolvePromise({ code, stdout });
        return;
      }
      /* Git's own words for the operator, never a file's content: the first lines of what it said. */
      const said = (stderr || (error?.message ?? "")).split("\n").filter((line) => line.trim() !== "").slice(0, 3).join(" / ");
      reject(new AppError("BOOK_REPO_GIT_FAILED", `git ${args[0] ?? ""} failed in the book's repository: ${said}`));
    });
  });
}

const git = (repo: BookRepo, args: ReadonlyArray<string>, options: GitOptions = {}): Promise<GitResult> => runGit(repo.dir, repo.gitDir, args, options);

/**
 * The book's repository, as `BOOK_REPO_DIR` names it (or the folder given), checked to be a Git repository with a
 * `main`. Unset, or anything else, is `BOOK_REPO_UNAVAILABLE`: no merge is possible, and nothing else in Improve
 * depends on it (§ 3).
 */
export async function openBookRepo(dir: string | undefined = env.BOOK_REPO_DIR): Promise<BookRepo> {
  if (dir === undefined || dir.trim() === "") throw new AppError("BOOK_REPO_UNAVAILABLE", "BOOK_REPO_DIR is not set: no accepted change can be merged until the operator names the book's repository (feature-specs/37 § 3).");
  const root = resolve(dir);
  if (!existsSync(root)) throw new AppError("BOOK_REPO_UNAVAILABLE", `BOOK_REPO_DIR names ${root}, which does not exist (feature-specs/37 § 3).`);
  let gitDir: string;
  try {
    /* The platform's own form of the path: git prints forward slashes on Windows too. */
    gitDir = resolve((await runGit(root, null, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim());
  } catch {
    throw new AppError("BOOK_REPO_UNAVAILABLE", `BOOK_REPO_DIR names ${root}, which is not a Git repository (feature-specs/37 § 3).`);
  }
  const repo: BookRepo = { dir: root, gitDir };
  if ((await resolveRef(repo, "main")) === null) throw new AppError("BOOK_REPO_UNAVAILABLE", `the book's repository at ${root} has no branch main (feature-specs/37 § 3).`);
  return repo;
}

function requireRef(ref: string): void {
  if (!READABLE_REF.test(ref)) throw new AppError("BOOK_REPO_REF_INVALID", `${JSON.stringify(ref)} is not a ref the adapter reads: main, improve/*, release/* or a commit id.`);
}

function requireImproveBranch(branch: string): void {
  if (!IMPROVE_BRANCH.test(branch)) throw new AppError("BOOK_REPO_REF_INVALID", `${JSON.stringify(branch)} is not a suggestion's branch: the adapter writes improve/S-NN-NNNN-<slug> only (feature-specs/37 § 3).`);
}

/** A path inside the repository, as git names it: relative, forward slashes, no `..`, nothing hidden at its start. */
function requirePath(path: string): void {
  const parts = path.split("/");
  if (path === "" || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path) || path.startsWith("/") || parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("-")) || parts[0] === ".git") {
    throw new AppError("BOOK_REPO_PATH_INVALID", `${JSON.stringify(path)} is not a path inside the book's repository.`);
  }
}

/** The commit a ref names, or null when it names none. */
export async function resolveRef(repo: BookRepo, ref: string): Promise<string | null> {
  requireRef(ref);
  const qualified = SHA.test(ref) ? ref : ref === "main" || ref.startsWith("improve/") ? `refs/heads/${ref}` : `refs/tags/${ref}`;
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", `${qualified}^{commit}`], { answers: [1] });
  const sha = result.stdout.trim();
  return result.code === 0 && SHA.test(sha) ? sha : null;
}

async function requireCommit(repo: BookRepo, ref: string): Promise<string> {
  const sha = await resolveRef(repo, ref);
  if (sha === null) throw new AppError("BOOK_REPO_REF_MISSING", `the book's repository has no ${ref}.`);
  return sha;
}

/** A file's text at a ref, or null when the ref has no such file (§ 4.1: the chapter's files at `main`). */
export async function readFileAt(repo: BookRepo, ref: string, path: string): Promise<string | null> {
  requirePath(path);
  const sha = await requireCommit(repo, ref);
  const listed = await git(repo, ["ls-tree", "--name-only", sha, "--", path]);
  if (listed.stdout.trim() !== path) return null;
  return (await git(repo, ["cat-file", "blob", `${sha}:${path}`])).stdout;
}

/** The files under a folder at a ref, as paths from the repository's top, sorted. */
export async function listFilesAt(repo: BookRepo, ref: string, folder: string): Promise<ReadonlyArray<string>> {
  requirePath(folder);
  const sha = await requireCommit(repo, ref);
  return (await git(repo, ["ls-tree", "-r", "--name-only", sha, "--", folder])).stdout.split("\n").filter((line) => line !== "").sort();
}

/** `improve/S-36-0198-<slug>`: a suggestion's branch, its slug lower-case ASCII from the words given, at most six of them. */
export function improveBranchOf(suggestionId: string, words: string): string {
  const slug = words
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
    .slice(0, 6)
    .join("-");
  const branch = slug === "" ? `improve/${suggestionId}` : `improve/${suggestionId}-${slug}`;
  requireImproveBranch(branch);
  return branch;
}

/** A suggestion's branch from `main`'s tip, made without checking anything out; the branch already there is the one (a step run again). */
export async function createImproveBranch(repo: BookRepo, branch: string): Promise<{ readonly branch: string; readonly sha: string; readonly created: boolean }> {
  requireImproveBranch(branch);
  const there = await resolveRef(repo, branch);
  if (there !== null) return { branch, sha: there, created: false };
  const main = await requireCommit(repo, "main");
  await git(repo, ["branch", "--no-track", branch, main]);
  return { branch, sha: main, created: true };
}

/**
 * A suggestion's branch back at `main`'s tip (unit 54b), when every commit it has that `main` lacks is the product's:
 * those the merge makes again on `main` as it is (§ 4.1, § 5 step 2), and a branch kept from an earlier attempt starts
 * over. A commit of anyone else — the curator's hand (§ 4.3) — is never moved: the branch is `kept` as it is.
 */
export async function restartImproveBranch(repo: BookRepo, branch: string): Promise<{ readonly sha: string; readonly kept: boolean }> {
  requireImproveBranch(branch);
  const tip = await requireCommit(repo, branch);
  const main = await requireCommit(repo, "main");
  if (tip === main) return { sha: main, kept: false };
  const people = (await git(repo, ["log", "--format=%ae%n%ce", `${main}..${tip}`])).stdout.split("\n").filter((line) => line !== "");
  if (people.some((email) => email !== BOOK_REPO_IDENTITY.email)) return { sha: tip, kept: true };
  await git(repo, ["update-ref", "-m", `harness-bible: ${branch} restarted from main`, `refs/heads/${branch}`, main, tip]);
  return { sha: main, kept: false };
}

/** Whether `ref` descends from `ancestor`: holds it in its history, or is it (§ 4.3: a curator's branch descends from `main`). */
export async function descendsFrom(repo: BookRepo, ref: string, ancestor: string): Promise<boolean> {
  const [a, b] = [await requireCommit(repo, ancestor), await requireCommit(repo, ref)];
  return (await git(repo, ["merge-base", "--is-ancestor", a, b], { answers: [1] })).code === 0;
}

/** The paths `to` changes against `from`, sorted (§ 4.3: whether a curator's branch touches the anchored chapter, and its lab). */
export async function changedPaths(repo: BookRepo, from: string, to: string): Promise<ReadonlyArray<string>> {
  const [a, b] = [await requireCommit(repo, from), await requireCommit(repo, to)];
  /* NUL-separated, so that git quotes no name */
  return (await git(repo, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", a, b])).stdout.split("\0").filter((path) => path !== "").sort();
}

/** The adapter's worktrees: under the git directory, never inside the operator's tree. */
function worktreePath(repo: BookRepo, name: string): string {
  return join(repo.gitDir, "hb-worktrees", name);
}

/**
 * A worktree of the adapter's own for `fn`, removed after, whatever `fn` does. One left by a step that died is
 * removed first. `checkout` is what it holds: a branch, to commit on, or a commit, detached, to read.
 */
async function withWorktree<T>(repo: BookRepo, name: string, checkout: { readonly branch: string } | { readonly detached: string }, fn: (dir: string) => Promise<T>): Promise<T> {
  const path = worktreePath(repo, name);
  await git(repo, ["worktree", "prune"]);
  if (existsSync(path)) await git(repo, ["worktree", "remove", "--force", path]);
  mkdirSync(dirname(path), { recursive: true });
  await git(repo, "branch" in checkout ? ["worktree", "add", path, checkout.branch] : ["worktree", "add", "--detach", path, checkout.detached]);
  try {
    return await fn(path);
  } finally {
    await git(repo, ["worktree", "remove", "--force", path]);
  }
}

/** The tree at a ref, written out in a worktree of the adapter's own for `fn` to read — the chapter's check, an ingestion — and removed after. */
export async function withTreeAt<T>(repo: BookRepo, ref: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const sha = await requireCommit(repo, ref);
  /* short, and the process's and the moment's own, so that two reads at once never meet */
  return withWorktree(repo, `t-${sha.slice(0, 8)}-${process.pid.toString(36)}${Date.now().toString(36)}`, { detached: sha }, fn);
}

export interface FileWrite {
  /** From the repository's top, forward slashes. */
  readonly path: string;
  readonly content: string;
}

export interface CommitMessage {
  /** One line. */
  readonly subject: string;
  readonly body: string | null;
  /** `Suggestion`, `Rubric-Version`, `Curator`, `Record`: each value one line (§ 3). */
  readonly trailers: Readonly<Record<string, string>>;
}

function messageOf(message: CommitMessage): string {
  const oneLine = (value: string): boolean => value.trim() !== "" && !/[\r\n]/.test(value);
  if (!oneLine(message.subject)) throw new AppError("BOOK_REPO_MESSAGE_INVALID", "a commit's subject is one line, not empty.");
  for (const [key, value] of Object.entries(message.trailers)) {
    if (!TRAILER_KEY.test(key) || !oneLine(value)) throw new AppError("BOOK_REPO_MESSAGE_INVALID", `the trailer ${JSON.stringify(key)} is not a one-line trailer.`);
  }
  const trailers = Object.entries(message.trailers).map(([key, value]) => `${key}: ${value}`);
  return [message.subject, ...(message.body === null || message.body.trim() === "" ? [] : ["", message.body.trim()]), ...(trailers.length === 0 ? [] : ["", ...trailers])].join("\n");
}

/**
 * The files written on a suggestion's branch and committed by the product, in a worktree of the adapter's own. When
 * the branch already holds them as given — a step run again — nothing is committed and its tip is the answer.
 */
export async function commitFiles(repo: BookRepo, branch: string, files: ReadonlyArray<FileWrite>, message: CommitMessage, at: Date): Promise<{ readonly sha: string; readonly committed: boolean }> {
  requireImproveBranch(branch);
  if (files.length === 0) throw new AppError("BOOK_REPO_PATH_INVALID", "a commit writes at least one file.");
  for (const file of files) requirePath(file.path);
  const text = messageOf(message);
  await requireCommit(repo, branch);
  return withWorktree(repo, branch.replace(/\//g, "-"), { branch }, async (tree) => {
    for (const file of files) {
      const target = join(tree, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
    }
    await git(repo, ["add", "--", ...files.map((file) => file.path)], { cwd: tree });
    const unchanged = (await git(repo, ["diff", "--cached", "--quiet"], { cwd: tree, answers: [1] })).code === 0;
    if (!unchanged) await git(repo, ["commit", "--quiet", "-m", text], { cwd: tree, at });
    return { sha: await requireCommit(repo, branch), committed: !unchanged };
  });
}

/**
 * `main` moved to a suggestion's branch (54c): a fast-forward only, from the `main` the caller saw. Refused when
 * `main` has moved since (`BOOK_REPO_MAIN_MOVED`: the merge goes back to its check, § 5 step 2), when the branch does
 * not descend from it, and when the operator has `main` checked out, whose tree a moved `main` would leave behind.
 * Moved already to that branch — a step run again — is the same answer.
 */
export async function fastForwardMain(repo: BookRepo, branch: string, expectedMain: string): Promise<{ readonly from: string; readonly to: string }> {
  requireImproveBranch(branch);
  if (!SHA.test(expectedMain)) throw new AppError("BOOK_REPO_REF_INVALID", "the main a fast-forward starts from is a commit id.");
  const to = await requireCommit(repo, branch);
  const from = await requireCommit(repo, "main");
  if (from === to) return { from: expectedMain, to };
  if (from !== expectedMain) throw new AppError("BOOK_REPO_MAIN_MOVED", `main is ${from.slice(0, 12)}, not ${expectedMain.slice(0, 12)}: the branch is checked again on the new main before it merges (feature-specs/37 § 5).`);
  const worktrees = (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
  if (worktrees.split("\n").includes("branch refs/heads/main")) throw new AppError("BOOK_REPO_MAIN_CHECKED_OUT", "main is checked out in the book's repository, whose tree a fast-forward would leave behind: check out a detached HEAD there (git checkout --detach) and merge again.");
  if ((await git(repo, ["merge-base", "--is-ancestor", from, to], { answers: [1] })).code !== 0) throw new AppError("BOOK_REPO_NOT_FAST_FORWARD", `${branch} does not descend from main: it is checked again on main before it merges.`);
  await git(repo, ["update-ref", "-m", `harness-bible: fast-forward main to ${branch}`, "refs/heads/main", to, from]);
  return { from, to };
}

/** `release/<id>` on a commit, annotated by the product (§ 3: a release is a tag). The tag already there on that commit is the one; on another, refused. */
export async function tagRelease(repo: BookRepo, releaseId: string, sha: string, at: Date): Promise<{ readonly tag: string; readonly sha: string; readonly created: boolean }> {
  if (!RELEASE_ID.test(releaseId)) throw new AppError("BOOK_REPO_REF_INVALID", `${JSON.stringify(releaseId)} is not a release id: 2026.10, or 2026.10.2 from a month's second (feature-specs/37 D1).`);
  if (!SHA.test(sha)) throw new AppError("BOOK_REPO_REF_INVALID", "a release tags a commit id.");
  await requireCommit(repo, sha);
  const tag = `release/${releaseId}`;
  const there = await resolveRef(repo, tag);
  if (there === sha) return { tag, sha, created: false };
  if (there !== null) throw new AppError("BOOK_REPO_TAG_TAKEN", `${tag} already tags ${there.slice(0, 12)}, not ${sha.slice(0, 12)}.`);
  await git(repo, ["tag", "--annotate", "--message", `release ${releaseId}`, tag, sha], { at });
  return { tag, sha, created: true };
}

/**
 * What `to` changes against `from`, as a unified diff, optionally only under some paths (§ 6: a branch against `main`).
 * By words, git's porcelain word diff: a book's paragraph is one line, and a change inside it is a few words of it
 * (unit 54b) — each run of context, removal or addition on a line of its own, marked ` `, `-` or `+`, and `~` where
 * the file's line ends.
 */
export async function diffRefs(repo: BookRepo, from: string, to: string, paths: ReadonlyArray<string> = [], options: { readonly words?: boolean } = {}): Promise<string> {
  for (const path of paths) requirePath(path);
  const [a, b] = [await requireCommit(repo, from), await requireCommit(repo, to)];
  return (await git(repo, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", ...(options.words === true ? ["--word-diff=porcelain"] : []), a, b, "--", ...paths])).stdout;
}

/** The releases the repository has tagged, by id, each with its commit (D1: an id a merge must not take). */
export async function releaseTagsOf(repo: BookRepo): Promise<ReadonlyMap<string, string>> {
  const listed = (await git(repo, ["for-each-ref", "--format=%(refname:strip=2) %(*objectname) %(objectname)", "refs/tags/release/"])).stdout;
  const tags = new Map<string, string>();
  for (const line of listed.split("\n")) {
    const [name, peeled, own] = line.trim().split(" ");
    const sha = peeled !== undefined && SHA.test(peeled) ? peeled : own;
    if (name !== undefined && name.startsWith("release/") && sha !== undefined && SHA.test(sha)) tags.set(name.slice("release/".length), sha);
  }
  return tags;
}

/** A suggestion's branch deleted once `main` holds it (§ 3); a branch `main` does not hold is refused, and one already gone is nothing to do. */
export async function deleteImproveBranch(repo: BookRepo, branch: string): Promise<boolean> {
  requireImproveBranch(branch);
  const tip = await resolveRef(repo, branch);
  if (tip === null) return false;
  const main = await requireCommit(repo, "main");
  if ((await git(repo, ["merge-base", "--is-ancestor", tip, main], { answers: [1] })).code !== 0) throw new AppError("BOOK_REPO_NOT_MERGED", `${branch} is not in main: only a merged branch is deleted.`);
  await git(repo, ["worktree", "prune"]);
  const path = worktreePath(repo, branch.replace(/\//g, "-"));
  if (existsSync(path)) await git(repo, ["worktree", "remove", "--force", path]);
  await git(repo, ["branch", "--delete", "--force", branch]);
  return true;
}
