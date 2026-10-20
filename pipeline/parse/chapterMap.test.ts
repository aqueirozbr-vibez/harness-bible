import { describe, expect, it } from "vitest";

import { parseChapterMap } from "./chapterMap";

const MAP = [
  "# Chapter map",
  "",
  "## Part 0 — Why now (prose only, no labs)",
  "",
  "| Ch | Title | Scope | Beats | Words |",
  "|---|---|---|---|---|",
  "| 00 | The heuristic becomes the algorithm | prose | Nielsen | 3,000–4,000 |",
  "",
  "## Part I — Foundations",
  "",
  "| Ch | Title | Scope | Lab | Beats | Words |",
  "|---|---|---|---|---|---|",
  "| 01 | Tokens | scope | Lab 01: train a tokenizer | Huyen | 7–9K |",
  "",
  "## Part III — Industrial",
  "",
  "| Ch | Title | Scope | Lab | Beats | Words |",
  "|---|---|---|---|---|---|",
  "| 33 | Failure catalogue | scope | — (instrument instead) | — | 6–8K |",
  "| 35 | OT/IT | scope | Lab 35: zones | IEC | 7–9K |",
  "",
  "## Notes",
  "",
  "| 99 | not a chapter row | x | Lab 99 | y | z |",
  "",
  "<!-- STATUS (generated; do not edit by hand) -->",
  "## Status — 2026-09-23",
  "",
  "| Ch | Title | Drafted | Words | Lab | Registry | Verify |",
  "|---|---|---|---|---|---|---|",
  "| 00 | The heuristic becomes the algorithm | y | 3205 | none (by row) | y | y |",
  "| 33 | Failure catalogue | y | 7221 | REPRODUCED | y | y |",
  "| 35 | OT/IT | — | — | — | y | — |",
].join("\n");

describe("parseChapterMap", () => {
  it("reads the scope tables under Part headings and ignores other headings and the generated status section", () => {
    const map = parseChapterMap(MAP);
    expect(map.get(0)).toBe("PROSE");
    expect(map.get(1)).toBe("LAB");
    expect(map.get(33)).toBe("INSTRUMENT");
    expect(map.get(35)).toBe("LAB");
    expect(map.has(99)).toBe(false);
    expect(map.size).toBe(4);
  });

  it("returns an empty map for a file without Part tables", () => {
    expect(parseChapterMap("# Nothing here\n\n| 01 | x | y | Lab 01 | z |\n").size).toBe(0);
  });
});
