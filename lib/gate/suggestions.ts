import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPORTS_DIR } from "@/lib/gate/goldenRun";
import { CuratedItemSchema, CuratedLabelSchema, CuratedRunSchema, type CuratedItem, type CuratedLabel, type CuratedRun, type CuratedRunItem } from "@/lib/schemas/curated";

/*
 * The curated set's files as the Phase 4 gate reads them (feature-specs/39 § 3): the set at
 * golden/suggestions-<release>.jsonl (one item a line, `npm run gate:suggestions` writes it), the curators' labels at
 * golden/suggestions/labels/<release>.jsonl (one label a line, written by hand), and the runs at
 * pipeline/reports/suggestions-run-<release>-<grade>[-<stamp>].json (`npm run gate:suggestions:run` writes one). Each
 * is read strictly, as the Phase 2 labels are: a line the gate cannot read stops the read and names its line.
 */

export const SUGGESTIONS_DIR = join(process.cwd(), "golden");
export const CURATED_LABELS_DIR = join(SUGGESTIONS_DIR, "suggestions", "labels");
export const CURATED_EVIDENCE_DIR = join(SUGGESTIONS_DIR, "suggestions", "evidence");

export const CURATED_SET_FILE = (release: string): string => `golden/suggestions-${release}.jsonl`;
export const curatedLabelsFile = (release: string): string => `golden/suggestions/labels/${release}.jsonl`;

/** The command that runs the set through the real workflow and the real gateway: paid, so Andre's to start (39 D2). */
export const CURATED_RUN_COMMAND = "npm run gate:suggestions:run -- --real --principal <organisation id>";

/**
 * What a real run of the set would cost, about: each item grades its evidence on hb-small and, where it reaches the
 * adjudicator, asks hb-frontier once; the one paid adjudication of unit 50d cost $0.031, a grade a few cents at most.
 */
export const CURATED_ITEM_USD = 0.06;
export function curatedRunEstimateUsd(items: number): number {
  return items * CURATED_ITEM_USD;
}

function readLines<T>(path: string, name: string, parse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } }): ReadonlyArray<T> {
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      if (line.trim().length === 0) return [];
      const where = `${name}:${String(index + 1)}`;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`${where} is not JSON`);
      }
      const parsed = parse(value);
      if (!parsed.success) throw new Error(`${where} is not what the file holds: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      return [parsed.data];
    });
}

/** The release's set; null when nobody has generated it. */
export function readCuratedSet(release: string, dir: string = SUGGESTIONS_DIR): ReadonlyArray<CuratedItem> | null {
  const path = join(dir, `suggestions-${release}.jsonl`);
  if (!existsSync(path)) return null;
  return readLines(path, `suggestions-${release}.jsonl`, (value) => CuratedItemSchema.safeParse(value));
}

/** The release's labels; null when nobody has labelled yet. */
export function readCuratedLabels(release: string, dir: string = CURATED_LABELS_DIR): ReadonlyArray<CuratedLabel> | null {
  const path = join(dir, `${release}.jsonl`);
  if (!existsSync(path)) return null;
  return readLines(path, `${release}.jsonl`, (value) => CuratedLabelSchema.safeParse(value));
}

export function curatedRunFileName(release: string, grade: "stub" | "real", startedAt: Date): string {
  return grade === "stub" ? `suggestions-run-${release}-stub.json` : `suggestions-run-${release}-real-${startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`;
}

/** The newest run of the release, a real one before a stub one; null when none was made. */
export function readCuratedRun(release: string, dir: string = REPORTS_DIR): (CuratedRun & { readonly file: string; readonly real: boolean }) | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(`suggestions-run-${release}-`) && name.endsWith(".json"))
    .sort()
    .reverse();
  const pick = files.find((name) => name.includes("-real-")) ?? files[0];
  if (pick === undefined) return null;
  const parsed = CuratedRunSchema.safeParse(JSON.parse(readFileSync(join(dir, pick), "utf8")));
  if (!parsed.success) throw new Error(`${pick} is not a run of the set: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  return { ...parsed.data, file: pick, real: parsed.data.header.grade === "real" };
}

export type { CuratedRunItem };
