import { execFile } from "node:child_process";

/*
 * The release procedure's two processes as a merge runs them (feature-specs/37 § 5 steps 4 to 6; unit 54c; architecture
 * § 10): the pipeline's ingestion of a tag of the book's repository, under `PIPELINE=1`, and the embedding job's carry
 * of the vectors an unchanged section keeps, under `EMBED=1` (Andre's answer of 2026-10-09). Each is its own process
 * with its flag set for it alone, as `npm run ingest` and `npm run embed:release` run, so the worker that starts them
 * writes no content table itself (invariant 3). They run from the application's folder, where the workers run, with
 * tsx's loader, as the npm scripts do.
 */

export interface ProcessRun {
  /** Null when it was stopped: at its cap, or by a signal. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

const MAX_OUTPUT = 16 * 1024 * 1024;

function runScript(script: string, args: ReadonlyArray<string>, flags: Readonly<Record<string, string>>, timeoutMs: number): Promise<ProcessRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", script, ...args], { cwd: process.cwd(), env: { ...process.env, ...flags }, maxBuffer: MAX_OUTPUT, timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ exitCode, timedOut: error !== null && error.killed === true, stdout, stderr, ms: Date.now() - started });
    });
  });
}

/** The ingestion's answers (pipeline/ingest.ts): 0 published, or the release already there with the same hash; 2 the render hash differed from the check's and nothing was written; 3 the id or the commit is another release's. */
export const INGEST_HASH_DIFFERS = 2;
export const INGEST_CONFLICT = 3;

/**
 * The ingestion's cap. It builds every chapter and renders its diagrams in a headless browser, then writes the release
 * in one transaction that may take ten minutes (pipeline/ingest.ts): twenty minutes holds both.
 */
export const INGEST_TIMEOUT_MS = 20 * 60_000;
/** The carry is one statement over two releases' sections: five minutes is a hundred times what it takes here. */
export const CARRY_TIMEOUT_MS = 5 * 60_000;

export interface IngestionInput {
  /** A worktree of the tag: the files the release is made of. */
  readonly bookDir: string;
  readonly releaseId: string;
  /** The render hash the merge's check computed for this tree, under this id (invariant 2). */
  readonly expectHash: string;
  /** The tagged commit, which is the release's `gitSha` (37 § 3). */
  readonly gitSha: string;
  /** False to leave the diagrams unrendered, as a suite does; rendered otherwise. */
  readonly mermaid?: boolean;
  /** Where its report goes; `pipeline/reports` otherwise. */
  readonly reportDir?: string;
  /** The database it writes, where it is not the process's own: a suite's (unit 54c). */
  readonly databaseUrl?: string;
}

export function runIngestion(input: IngestionInput): Promise<ProcessRun> {
  const args = ["--book", input.bookDir, "--release", input.releaseId, "--expect-hash", input.expectHash, "--git-sha", input.gitSha, ...(input.mermaid === false ? ["--no-mermaid"] : []), ...(input.reportDir === undefined ? [] : ["--report-dir", input.reportDir])];
  return runScript("pipeline/ingest.ts", args, { PIPELINE: "1", ...(input.databaseUrl === undefined ? {} : { DATABASE_URL: input.databaseUrl }) }, INGEST_TIMEOUT_MS);
}

export interface CarryInput {
  readonly releaseId: string;
  /** The release the merge started from, whose vectors an unchanged section keeps. */
  readonly from: string;
  readonly databaseUrl?: string;
}

export function runEmbedCarry(input: CarryInput): Promise<ProcessRun> {
  return runScript("scripts/embed-release.ts", ["--release", input.releaseId, "--carry-from", input.from], { EMBED: "1", ...(input.databaseUrl === undefined ? {} : { DATABASE_URL: input.databaseUrl }) }, CARRY_TIMEOUT_MS);
}

/** How many sections the carry filled, from its one line of JSON; null where it did not say. */
export function carriedOf(run: ProcessRun): number | null {
  if (run.exitCode !== 0) return null;
  for (const line of run.stdout.split("\n").reverse()) {
    try {
      const said = JSON.parse(line) as { readonly carried?: unknown };
      if (typeof said.carried === "number") return said.carried;
    } catch {
      /* not the line */
    }
  }
  return null;
}

/** What a process said of how it ended, for the merge's row: its last word on its error stream, or else on its output; one line, never a file's content. */
export function saidOf(run: ProcessRun): string {
  if (run.timedOut) return "it ran past its cap";
  const linesOf = (text: string): ReadonlyArray<string> =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  return (linesOf(run.stderr).at(-1) ?? linesOf(run.stdout).at(-1) ?? `it exited ${String(run.exitCode)}`).slice(0, 300);
}
