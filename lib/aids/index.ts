import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { AidSchema, type Aid } from "./schema";

/* The aids shipped with the application: one JSON file per aid under aids/. */

export const AIDS_DIR = join(process.cwd(), "aids");

export function loadAids(dir = AIDS_DIR): ReadonlyArray<Aid> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => AidSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))));
}

export function findAid(id: string, dir = AIDS_DIR): Aid | null {
  return loadAids(dir).find((a) => a.id === id) ?? null;
}

/** The aids of one chapter, for the dock's picker (feature-specs/18 § 5.1): none, one or several. */
export function listAidsFor(chapter: number, dir = AIDS_DIR): ReadonlyArray<Aid> {
  return loadAids(dir).filter((a) => a.chapter === chapter);
}

/** The chapters that have an aid, ascending: what the picker's empty state names (18 § 7). */
export function aidChapters(dir = AIDS_DIR): ReadonlyArray<number> {
  return [...new Set(loadAids(dir).map((a) => a.chapter))].sort((a, b) => a - b);
}
