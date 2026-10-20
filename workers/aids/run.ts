import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { runAid, type AidRun } from "@/lib/aids/run";
import type { Aid } from "@/lib/aids/schema";
import { aidResultFor, type AidRunResult } from "@/lib/aids/turn";
import { getPrisma } from "@/lib/db/client";
import { withSystem } from "@/lib/db/tenant";
import { AppError } from "@/lib/errors";

/*
 * The walk's run, inside the workers (feature-specs/18 § 4). The script that runs is the release's own: the lab's
 * `LabFile` rows are written into a scratch folder and `runAid` runs the patched `derive.py` there, in the lab
 * tier's container with no network (D1; invariant 20). Nothing of the book checkout is read, because staging has
 * none. What comes back is the run as it happened and the values shaped for the turn (`lib/aids/turn.ts`), with the
 * verification date of the source rows that price the aid's steps.
 *
 * It runs in the workers alone: it reads content tables, spawns a process, and its result reaches the model.
 */

export interface AidTurnOptions {
  /** `docker` (the lab tier) by default; `python` only on a machine without Docker (`AID_RUNNER`). */
  readonly runner?: "python" | "docker";
  readonly python?: string;
  readonly docker?: string;
  readonly image?: string;
}

export interface AidTurnRun {
  readonly run: AidRun;
  readonly result: AidRunResult;
}

interface LabFiles {
  readonly wallClockCapS: number;
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}

async function labOf(releaseId: string, labId: string): Promise<LabFiles | null> {
  return withSystem(async () =>
    getPrisma().lab.findFirst({
      where: { anchor: labId, chapterVersion: { releaseId } },
      select: { wallClockCapS: true, files: { select: { path: true, content: true }, orderBy: { path: "asc" } } },
    }),
  );
}

/** The latest verification date among the source rows of the chapters the aid's steps price from; null when none. */
async function pricesVerifiedAt(releaseId: string, chapters: ReadonlyArray<number>): Promise<Date | null> {
  if (chapters.length === 0) return null;
  const latest = await withSystem(async () =>
    getPrisma().sourceRow.aggregate({ _max: { verifiedAt: true }, where: { chapterVersion: { releaseId, chapterNumber: { in: [...chapters] } } } }),
  );
  return latest._max.verifiedAt;
}

/** The release's files on disk, under `dir` and nowhere else: a row's path is a relative path inside the lab folder. */
export function materialise(files: ReadonlyArray<{ readonly path: string; readonly content: string }>, dir: string): void {
  for (const file of files) {
    const relative = normalize(file.path);
    if (isAbsolute(relative) || relative.startsWith("..") || relative.includes(`${"."}${"."}/`) || relative.includes(`${"."}${"."}\\`)) {
      throw new AppError("INTERNAL", `lab file path ${file.path} is not inside the lab folder`);
    }
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
}

/** The chapters whose source rows price the aid: the chapter part of every step's `pricesFrom` section. */
export function priceChapters(aid: Aid): ReadonlyArray<number> {
  return [...new Set(aid.steps.flatMap((step) => (step.pricesFrom === null ? [] : [Number(step.pricesFrom.split(".")[0])])))];
}

export async function runAidForTurn(aid: Aid, inputs: Readonly<Record<string, number>>, releaseId: string, options: AidTurnOptions): Promise<AidTurnRun> {
  const lab = await labOf(releaseId, aid.labId);
  if (lab === null) throw new AppError("NOT_FOUND", `release ${releaseId} has no ${aid.labId}: the walk runs the release's pinned files (feature-specs/18 D1)`);

  const dir = mkdtempSync(join(tmpdir(), `hb-lab-${aid.labId}-`));
  let run: AidRun;
  try {
    materialise(lab.files, dir);
    run = await runAid(aid, inputs, {
      labDir: dir,
      runner: options.runner ?? "docker",
      python: options.python,
      docker: options.docker,
      image: options.image,
      timeoutMs: lab.wallClockCapS * 1000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const verified = await pricesVerifiedAt(releaseId, priceChapters(aid));
  return { run, result: aidResultFor(aid, inputs, run, verified) };
}
