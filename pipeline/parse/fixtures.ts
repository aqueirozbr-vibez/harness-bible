import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * Chapter 21 and its lab, copied from bible/ as the parser tests' corpus
 * (feature-specs/04 § 5, § 10). Test-only; the pipeline never reads this.
 */

export const FIXTURES_DIR = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

export function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

export const CH21_FILE = "ch21-control-plane.md";
export const CH21_LAB_DIR = fileURLToPath(new URL("./__fixtures__/ch21-control-plane/", import.meta.url));
