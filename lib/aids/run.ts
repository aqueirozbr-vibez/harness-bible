import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { applyAid } from "./apply";
import type { Aid } from "./schema";

/*
 * Runs a decision aid: the lab's files copied into a scratch folder, the
 * patched derive.py written over the copy, the script run there with no
 * arguments and a wall-clock cap, results/derived.json read back. Two
 * runners: a local python subprocess (development), and the lab tier's
 * container (`dockerArgs`: no network, read-only root, capped) for the
 * walk in Phase 2; Firecracker is Phase 3. Since unit 54b the same runners
 * run a lab's derive.py as the book holds it, for a merge's check
 * (`runDerive`; feature-specs/37 § 4.4).
 */

export interface AidRunOptions {
  /** The lab folder holding derive.py (from the book checkout or a copy of the release's LabFile rows). */
  readonly labDir: string;
  /** `python`: a local subprocess (development without Docker). `docker`: the lab tier's container (below). `AID_RUNNER` in the environment. */
  readonly runner?: "python" | "docker";
  /** The interpreter for the `python` runner; `PYTHON_BIN` in the environment, default `python`. */
  readonly python?: string;
  /** The docker binary for the `docker` runner; `DOCKER_BIN`, default `docker`. */
  readonly docker?: string;
  /** The image for the `docker` runner; `AID_IMAGE`, default `python:3.12-slim`. */
  readonly image?: string;
  readonly timeoutMs?: number;
}

export interface AidRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly ms: number;
  readonly stdout: string;
  readonly stderr: string;
  /** results/derived.json as the patched script wrote it, or null when it did not. */
  readonly results: unknown;
}

/** The lab tier of architecture § 4.2 (`Lab.wallClockCapS 600`, `cpu 2`, `memoryGiB 4`). */
const DEFAULT_TIMEOUT_MS = 600_000;
const CONTAINER = { cpus: "2", memory: "4g", pids: "256" } as const;
const DEFAULT_IMAGE = "python:3.12-slim";
const SKIP = new Set(["results", "__pycache__"]);

/**
 * The host's user, where the host has one (not Windows): the scratch folder is that user's, mode 0700 from mkdtemp,
 * and the container's root, with every capability dropped, cannot read past that mode, so the container runs as the
 * folder's owner. Docker Desktop's file sharing has no such modes, which is why only a Linux host showed it (the
 * first CI run on a runner, 2026-10-20: "can't open file '/lab/derive.py': Permission denied").
 */
function hostUser(): string | null {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? null : `${String(uid)}:${String(gid)}`;
}

/**
 * The container the `docker` runner starts: no network, a read-only root, the scratch
 * folder as the only writable mount (results/derived.json lands there), a tmpfs /tmp,
 * the lab tier's cpu and memory caps, no user shell, and on a host with users the
 * scratch folder's owner as its user rather than root. Firecracker replaces it in Phase 3.
 */
export function dockerArgs(dir: string, script: string, image = DEFAULT_IMAGE, user: string | null = hostUser()): ReadonlyArray<string> {
  return ["run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp", "--cpus", CONTAINER.cpus, "--memory", CONTAINER.memory, "--pids-limit", CONTAINER.pids, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", ...(user === null ? [] : ["--user", user]), "-v", `${dir}:/lab`, "-w", "/lab", image, "python", script];
}

function copyLab(from: string, to: string): void {
  for (const name of readdirSync(from)) {
    if (SKIP.has(name)) continue;
    const source = join(from, name);
    const target = join(to, name);
    if (statSync(source).isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyLab(source, target);
    } else {
      writeFileSync(target, readFileSync(source));
    }
  }
}

export async function runAid(aid: Aid, values: Readonly<Record<string, number>>, options: AidRunOptions): Promise<AidRun> {
  const scriptPath = join(options.labDir, aid.script);
  if (!existsSync(scriptPath)) throw new Error(`aid ${aid.id}: ${scriptPath} does not exist`);
  return runIn(aid.script, applyAid(aid, readFileSync(scriptPath, "utf8"), values), `aid-${basename(aid.labId)}`, options);
}

/** A lab's script, its derive script as the book holds it (feature-specs/37 § 4.4 part 2; unit 54b): the chapter's check on a branch's tree, by the same runners, caps and container as a decision aid. */
export const DERIVE_SCRIPT = "derive.py";

export async function runDerive(options: AidRunOptions): Promise<AidRun> {
  const scriptPath = join(options.labDir, DERIVE_SCRIPT);
  if (!existsSync(scriptPath)) throw new Error(`${scriptPath} does not exist`);
  return runIn(DERIVE_SCRIPT, readFileSync(scriptPath, "utf8"), `derive-${basename(options.labDir)}`, options);
}

/** The lab copied into a scratch folder, `script` written there as `content`, run with no arguments under the runner's caps, and its results read back; the folder removed after. */
async function runIn(script: string, content: string, prefix: string, options: AidRunOptions): Promise<AidRun> {
  const dir = mkdtempSync(join(tmpdir(), `hb-${prefix}-`));
  try {
    copyLab(options.labDir, dir);
    mkdirSync(join(dir, "results"), { recursive: true });
    writeFileSync(join(dir, script), content, "utf8");
    const started = Date.now();
    const run = await new Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }>((resolve) => {
      /* a minimal environment: the interpreter, no secrets, no bytecode cache */
      const childEnv: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
      const [command, args] = options.runner === "docker" ? [options.docker ?? "docker", dockerArgs(dir, script, options.image)] : [options.python ?? "python", [script]];
      const child: ChildProcessWithoutNullStreams = spawn(command, args, { cwd: dir, env: childEnv, windowsHide: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (error: Error) => {
        clearTimeout(timer);
        resolve({ code: null, timedOut, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut, stdout, stderr });
      });
    });
    const resultsPath = join(dir, "results", "derived.json");
    let results: unknown = null;
    if (existsSync(resultsPath)) {
      try {
        results = JSON.parse(readFileSync(resultsPath, "utf8"));
      } catch {
        results = null;
      }
    }
    return { exitCode: run.code, timedOut: run.timedOut, ms: Date.now() - started, stdout: run.stdout, stderr: run.stderr, results };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
