import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BOOK_REPO_IDENTITY, changedPaths, commitFiles, createImproveBranch, deleteImproveBranch, descendsFrom, diffRefs, fastForwardMain, improveBranchOf, listFilesAt, openBookRepo, readFileAt, releaseTagsOf, resolveRef, restartImproveBranch, tagRelease, withTreeAt, type BookRepo } from "./git";

/*
 * The book's repository through its adapter (feature-specs/37 § 3, § 12.1; unit 54a), against a repository the test
 * makes in a temporary folder from fixture chapters — the application never makes one. The operator's tree is left
 * dirty and on a detached HEAD, and stays exactly so through a branch, a commit, a fast-forward, a tag, a diff and a
 * deletion. An argument holding shell syntax is passed as written. Only `improve/*` branches and `release/*` tags are
 * written, by the product, with no person's name.
 */

const TIMEOUT = 60_000;
const OLD = "The retry cap is three.\n";
const NEW = "The retry cap is five.\n";
const AT = new Date("2026-10-09T12:00:00.000Z");

let root = "";
let repo: BookRepo;
let first = "";
const operator: { status: string; head: string } = { status: "", head: "" };

/** The test's own git, as an operator would run it: the machine's configuration left out, the operator as author. */
function sh(args: ReadonlyArray<string>, cwd: string = root): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, "no-user-config"), GIT_AUTHOR_NAME: "Operator", GIT_AUTHOR_EMAIL: "operator@example.invalid", GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: "operator@example.invalid" },
  }).trim();
}

const write = (path: string, content: string): void => {
  mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...path.split("/")), content, "utf8");
};

describe("the book's repository through pipeline/git.ts (37 § 3, § 12.1)", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "hb-book-repo-"));
    sh(["init", "--quiet", "-b", "main"]);
    write("book/36/36.3.md", `# 36.3 Worked numbers\n\n${OLD}`);
    write("book/12/12.1.md", "# 12.1 Agents\n\nA chapter the merge never touches.\n");
    write("labs/36/derive.py", "print('cap', 3)\n");
    sh(["add", "-A"]);
    sh(["commit", "--quiet", "-m", "The book at release 2026.09"]);
    sh(["tag", "-a", "release/2026.09", "-m", "release 2026.09"]);
    first = sh(["rev-parse", "HEAD"]);
    /* The operator's tree as the session notes leave it: detached, and here dirty too, which nothing may mind. */
    sh(["checkout", "--quiet", "--detach"]);
    write("book/12/12.1.md", "# 12.1 Agents\n\nThe operator's own edit, not committed.\n");
    write("notes.txt", "the operator's notes\n");
    operator.status = sh(["status", "--porcelain"]);
    operator.head = sh(["rev-parse", "HEAD"]);
    repo = await openBookRepo(root);
  }, TIMEOUT);

  afterAll(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it("is unavailable without BOOK_REPO_DIR, or where it names no repository", async () => {
    await expect(openBookRepo(undefined)).rejects.toMatchObject({ code: "BOOK_REPO_UNAVAILABLE" });
    await expect(openBookRepo("  ")).rejects.toMatchObject({ code: "BOOK_REPO_UNAVAILABLE" });
    await expect(openBookRepo(join(root, "does-not-exist"))).rejects.toMatchObject({ code: "BOOK_REPO_UNAVAILABLE" });
    const plain = mkdtempSync(join(tmpdir(), "hb-not-a-repo-"));
    try {
      await expect(openBookRepo(plain)).rejects.toMatchObject({ code: "BOOK_REPO_UNAVAILABLE" });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    expect(repo.dir).toBe(root);
  }, TIMEOUT);

  it("reads a file and a folder at a ref, and nothing a ref or a path could hide an option in", async () => {
    expect(await readFileAt(repo, "main", "book/36/36.3.md")).toBe(`# 36.3 Worked numbers\n\n${OLD}`);
    expect(await readFileAt(repo, "release/2026.09", "book/36/36.3.md")).toBe(`# 36.3 Worked numbers\n\n${OLD}`);
    expect(await readFileAt(repo, "main", "book/36/36.9.md")).toBeNull();
    expect(await listFilesAt(repo, "main", "book")).toEqual(["book/12/12.1.md", "book/36/36.3.md"]);
    expect(await resolveRef(repo, "main")).toBe(first);
    expect(await resolveRef(repo, "improve/S-36-0001")).toBeNull();
    for (const ref of ["--output=x", "main;rm -rf /", "HEAD", "refs/heads/main", "main..release/2026.09"]) await expect(readFileAt(repo, ref, "book/36/36.3.md"), ref).rejects.toMatchObject({ code: "BOOK_REPO_REF_INVALID" });
    for (const path of ["../outside.md", "/etc/passwd", "C:/Windows/win.ini", "book\\36\\36.3.md", "-p", ".git/config", "book//36.3.md"]) await expect(readFileAt(repo, "main", path), path).rejects.toMatchObject({ code: "BOOK_REPO_PATH_INVALID" });
  }, TIMEOUT);

  it("makes a suggestion's branch from main once, named from the words given, and no other branch", async () => {
    expect(improveBranchOf("S-36-0198", "Cited figure: the price · v1.3, déjà vu")).toBe("improve/S-36-0198-cited-figure-the-price-v1-3");
    expect(improveBranchOf("S-36-0198", "··")).toBe("improve/S-36-0198");
    expect(await createImproveBranch(repo, "improve/S-36-0198-retry-cap")).toEqual({ branch: "improve/S-36-0198-retry-cap", sha: first, created: true });
    expect(await createImproveBranch(repo, "improve/S-36-0198-retry-cap")).toEqual({ branch: "improve/S-36-0198-retry-cap", sha: first, created: false });
    for (const branch of ["main", "release/2026.10", "feature/x", "improve/S-36-0198;rm -rf /", "improve/../main", "improve/S-36-0198-Upper"]) await expect(createImproveBranch(repo, branch), branch).rejects.toMatchObject({ code: "BOOK_REPO_REF_INVALID" });
  }, TIMEOUT);

  it("commits files as the product, with its trailers and no person's name, and writes nothing twice", async () => {
    const branch = "improve/S-36-0198-retry-cap";
    const message = { subject: "S-36-0198: the retry cap", body: "A cited figure, accepted.", trailers: { Suggestion: "S-36-0198", "Rubric-Version": "v1.2", Curator: "user:33333333-3333-4333-8333-333333333333", Record: "9f14c02ad6e1" } };
    const done = await commitFiles(repo, branch, [{ path: "book/36/36.3.md", content: `# 36.3 Worked numbers\n\n${NEW}` }], message, AT);
    expect(done.committed).toBe(true);
    expect(await resolveRef(repo, branch)).toBe(done.sha);
    expect(sh(["log", "-1", "--format=%an <%ae>|%cn <%ce>|%aI", done.sha])).toBe(`${BOOK_REPO_IDENTITY.name} <${BOOK_REPO_IDENTITY.email}>|${BOOK_REPO_IDENTITY.name} <${BOOK_REPO_IDENTITY.email}>|2026-10-09T12:00:00Z`);
    expect(sh(["log", "-1", "--format=%B", done.sha])).toBe(["S-36-0198: the retry cap", "", "A cited figure, accepted.", "", "Suggestion: S-36-0198", "Rubric-Version: v1.2", "Curator: user:33333333-3333-4333-8333-333333333333", "Record: 9f14c02ad6e1"].join("\n"));
    expect(await readFileAt(repo, branch, "book/36/36.3.md")).toBe(`# 36.3 Worked numbers\n\n${NEW}`);
    /* a step run again: the branch holds the files already */
    expect(await commitFiles(repo, branch, [{ path: "book/36/36.3.md", content: `# 36.3 Worked numbers\n\n${NEW}` }], message, AT)).toEqual({ sha: done.sha, committed: false });
    await expect(commitFiles(repo, branch, [{ path: "book/36/36.3.md", content: "x" }], { ...message, subject: "two\nlines" }, AT)).rejects.toMatchObject({ code: "BOOK_REPO_MESSAGE_INVALID" });
    await expect(commitFiles(repo, branch, [{ path: "book/36/36.3.md", content: "x" }], { ...message, trailers: { "Co-authored-by": "x" } }, AT)).rejects.toMatchObject({ code: "BOOK_REPO_MESSAGE_INVALID" });
  }, TIMEOUT);

  it("passes an argument holding shell syntax as written", async () => {
    const branch = "improve/S-36-0199-shell";
    await createImproveBranch(repo, branch);
    const hostile = "$(touch HACKED) `touch HACKED2`; echo pwned > PWNED && rm -rf ./book\n";
    const subject = `"; touch HACKED3; echo " $(id) & del /q *`;
    const done = await commitFiles(repo, branch, [{ path: "book/36/notes $(whoami) & x.md", content: hostile }], { subject, body: null, trailers: { Suggestion: "S-36-0199", Record: "$(touch HACKED4)" } }, AT);
    expect(done.committed).toBe(true);
    expect(await readFileAt(repo, branch, "book/36/notes $(whoami) & x.md")).toBe(hostile);
    expect(sh(["log", "-1", "--format=%s", done.sha])).toBe(subject);
    for (const name of ["HACKED", "HACKED2", "HACKED3", "HACKED4", "PWNED"]) {
      expect(existsSync(join(root, name)), name).toBe(false);
      expect(existsSync(join(process.cwd(), name)), name).toBe(false);
    }
    expect(existsSync(join(root, "book", "36", "36.3.md"))).toBe(true);
  }, TIMEOUT);

  it("fast-forwards main to a branch only from the main the caller saw, never past a moved main, never under a checked-out main", async () => {
    const branch = "improve/S-36-0198-retry-cap";
    const tip = (await resolveRef(repo, branch)) ?? "";
    await expect(fastForwardMain(repo, branch, "0".repeat(40))).rejects.toMatchObject({ code: "BOOK_REPO_MAIN_MOVED" });
    /* the operator's tree on main: moving it would leave their checkout behind */
    sh(["checkout", "--quiet", "main"]);
    await expect(fastForwardMain(repo, branch, first)).rejects.toMatchObject({ code: "BOOK_REPO_MAIN_CHECKED_OUT" });
    sh(["checkout", "--quiet", "--detach"]);
    expect(await fastForwardMain(repo, branch, first)).toEqual({ from: first, to: tip });
    expect(await resolveRef(repo, "main")).toBe(tip);
    /* a step run again */
    expect(await fastForwardMain(repo, branch, first)).toEqual({ from: first, to: tip });
    /* a branch from the old main does not descend from the new one */
    await expect(fastForwardMain(repo, "improve/S-36-0199-shell", tip)).rejects.toMatchObject({ code: "BOOK_REPO_NOT_FAST_FORWARD" });
    await expect(fastForwardMain(repo, "main", first)).rejects.toMatchObject({ code: "BOOK_REPO_REF_INVALID" });
  }, TIMEOUT);

  it("tags a release by the product once, and refuses its tag on another commit or an id of no form", async () => {
    const main = (await resolveRef(repo, "main")) ?? "";
    expect(await tagRelease(repo, "2026.10", main, AT)).toEqual({ tag: "release/2026.10", sha: main, created: true });
    expect(await tagRelease(repo, "2026.10", main, AT)).toEqual({ tag: "release/2026.10", sha: main, created: false });
    expect(sh(["for-each-ref", "--format=%(taggername) %(taggeremail)|%(contents:subject)", "refs/tags/release/2026.10"])).toBe(`${BOOK_REPO_IDENTITY.name} <${BOOK_REPO_IDENTITY.email}>|release 2026.10`);
    expect(await resolveRef(repo, "release/2026.10")).toBe(main);
    await expect(tagRelease(repo, "2026.10", first, AT)).rejects.toMatchObject({ code: "BOOK_REPO_TAG_TAKEN" });
    for (const id of ["2026.13", "v1.2", "2026.10.1", "2026.10;rm", "2026.1"]) await expect(tagRelease(repo, id, main, AT), id).rejects.toMatchObject({ code: "BOOK_REPO_REF_INVALID" });
    expect((await tagRelease(repo, "2026.10.2", main, AT)).created).toBe(true);
    /* the ids taken, each with the commit it tags: the operator's and the product's (unit 54c, D1) */
    expect(Object.fromEntries(await releaseTagsOf(repo))).toEqual({ "2026.09": first, "2026.10": main, "2026.10.2": main });
  }, TIMEOUT);

  it("diffs two refs, under the paths asked", async () => {
    const diff = await diffRefs(repo, "release/2026.09", "main", ["book/36"]);
    expect(diff).toContain(`-${OLD.trim()}`);
    expect(diff).toContain(`+${NEW.trim()}`);
    expect(diff).not.toContain("12.1");
    expect(await diffRefs(repo, "main", "main")).toBe("");
    /* by words: the run that changed, on lines of its own */
    const words = await diffRefs(repo, "release/2026.09", "main", ["book/36"], { words: true });
    expect(words).toContain("-three.");
    expect(words).toContain("+five.");
    expect(words).toContain(" The retry cap is ");
  }, TIMEOUT);

  it("reads a tree whose files lie past Windows' 260 characters in the adapter's worktree (unit 54b's live run)", async () => {
    /* git's own folder for a worktree has a limit of its own, so the depth is the file's name: past 260 in the worktree */
    const deep = join(mkdtempSync(join(tmpdir(), "hb-long-")), "a".repeat(40));
    mkdirSync(deep, { recursive: true });
    const name = `book/part1/${"c".repeat(150)}.md`;
    const long = (args: ReadonlyArray<string>): string => sh(["-c", "core.longpaths=true", ...args], deep);
    try {
      long(["init", "--quiet", "-b", "main"]);
      mkdirSync(join(deep, "book", "part1"), { recursive: true });
      writeFileSync(join(deep, ...name.split("/")), "a chapter whose path is long\n", "utf8");
      long(["add", "-A"]);
      long(["commit", "--quiet", "-m", "a long path"]);
      const repository = await openBookRepo(deep);
      const seen = await withTreeAt(repository, "main", async (dir) => ({ text: readFileSync(join(dir, ...name.split("/")), "utf8"), length: join(dir, ...name.split("/")).length }));
      expect(seen.text).toBe("a chapter whose path is long\n");
      expect(seen.length).toBeGreaterThan(260);
    } finally {
      rmSync(dirname(deep), { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("reads a ref's tree in a worktree of its own, removed after", async () => {
    const seen = await withTreeAt(repo, "release/2026.09", async (dir) => ({ text: readFileSync(join(dir, "book", "36", "36.3.md"), "utf8"), inside: dir.startsWith(repo.gitDir) }));
    expect(seen).toEqual({ text: `# 36.3 Worked numbers\n\n${OLD}`, inside: true });
  }, TIMEOUT);

  it("deletes a merged branch, and no other", async () => {
    expect(await deleteImproveBranch(repo, "improve/S-36-0198-retry-cap")).toBe(true);
    expect(await resolveRef(repo, "improve/S-36-0198-retry-cap")).toBeNull();
    expect(await deleteImproveBranch(repo, "improve/S-36-0198-retry-cap")).toBe(false);
    await expect(deleteImproveBranch(repo, "improve/S-36-0199-shell")).rejects.toMatchObject({ code: "BOOK_REPO_NOT_MERGED" });
  }, TIMEOUT);

  it("restarts a branch of the product's own commits at main, keeps one holding a person's, and says what descends and what a branch changed (unit 54b)", async () => {
    const main = (await resolveRef(repo, "main")) ?? "";
    /* the product's commit on a branch from an older main: made again on main as it is */
    const old = "improve/S-36-0199-shell";
    expect(await descendsFrom(repo, old, "main")).toBe(false);
    expect(await descendsFrom(repo, old, first)).toBe(true);
    expect(await changedPaths(repo, first, old)).toEqual(["book/36/notes $(whoami) & x.md"]);
    expect(await restartImproveBranch(repo, old)).toEqual({ sha: main, kept: false });
    expect(await resolveRef(repo, old)).toBe(main);
    expect(await restartImproveBranch(repo, old)).toEqual({ sha: main, kept: false });
    /* a curator's commit, made without a checkout: the product never moves it */
    const hand = "improve/S-36-0200-restructure";
    await createImproveBranch(repo, hand);
    const theirs = sh(["commit-tree", `${main}^{tree}`, "-p", main, "-m", "The curator's hand"]);
    sh(["update-ref", `refs/heads/${hand}`, theirs]);
    expect(await restartImproveBranch(repo, hand)).toEqual({ sha: theirs, kept: true });
    expect(await resolveRef(repo, hand)).toBe(theirs);
    expect(await descendsFrom(repo, hand, "main")).toBe(true);
    expect(await changedPaths(repo, "main", hand)).toEqual([]);
    await expect(restartImproveBranch(repo, "main")).rejects.toMatchObject({ code: "BOOK_REPO_REF_INVALID" });
  }, TIMEOUT);

  it("leaves the operator's tree as it was: the same HEAD, the same changes, its notes, and no worktree of the adapter's", () => {
    expect(sh(["status", "--porcelain"])).toBe(operator.status);
    expect(sh(["rev-parse", "HEAD"])).toBe(operator.head);
    expect(readFileSync(join(root, "book", "12", "12.1.md"), "utf8")).toBe("# 12.1 Agents\n\nThe operator's own edit, not committed.\n");
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("the operator's notes\n");
    expect(sh(["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length).toBe(1);
    const own = join(repo.gitDir, "hb-worktrees");
    expect(existsSync(own) ? readdirSync(own) : []).toEqual([]);
  });
});
