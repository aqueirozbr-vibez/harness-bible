import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { joinPrefix, loadGuide, loadGuidePart, normalise, readManifest } from "./load";

describe("guides", () => {
  it("normalises line endings so the prefix is byte-stable across checkouts", () => {
    expect(normalise("a\r\nb\r\n\r\n")).toBe("a\nb\n");
    expect(joinPrefix(["one\r\n", "two"])).toBe("one\n\ntwo\n");
  });

  it("loads the assistant guide v1.8 and its hash matches the manifest", () => {
    const guide = loadGuide("assistant", "v1.8");
    const manifest = readManifest("assistant", "v1.8");
    expect(guide.sha256).toBe(manifest.sha256);
    expect(guide.prefix).toContain("# Harness Bible assistant · guide v1.8");
    expect(guide.prefix).toContain("# Citation rules · assistant guide v1.8");
    expect(guide.prefix).toContain("the book does not cover this");
    for (const cause of ["R-SCOPE", "R-SCOPE-OT", "R-RECOMPUTE", "R-UNVERIFIED"]) expect(guide.prefix).toContain(cause);
    expect(guide.prefix.includes("\r")).toBe(false);
  });

  it("loads v1.13, which differs from v1.12 in its titles and in the one sentence that spoke of the reader's position", () => {
    /* Assistant 2.0 (feature-specs/23 § 6): a conversation has no chapter, so mode 1 no longer answers "about the
       current section or chapter". An edit is a new version; the old one still loads by its own hash. */
    const before = loadGuide("assistant", "v1.12");
    const after = loadGuide("assistant", "v1.13");
    expect(after.sha256).toBe(readManifest("assistant", "v1.13").sha256);
    expect(after.sha256).not.toBe(before.sha256);

    const was = before.prefix.split("\n");
    const is = after.prefix.split("\n");
    expect(is).toHaveLength(was.length);
    const changed = is.flatMap((line, index) => (line === was[index] ? [] : [line]));
    expect(changed).toEqual([
      "# Harness Bible assistant · guide v1.13",
      "1. **Explain.** Answer a question about anything the book covers, from the retrieved sections. Every claim cites the section it comes from.",
      "# Citation rules · assistant guide v1.13",
    ]);
    expect(after.prefix).not.toContain("current section");

    const grader = loadGuidePart("assistant", "v1.13", "grader");
    const graderBefore = loadGuidePart("assistant", "v1.12", "grader");
    expect(grader.prefix.split("\n").slice(1)).toEqual(graderBefore.prefix.split("\n").slice(1));
  });

  /* Unit 58b (feature-specs/41 § 4): the researcher is two calls with separate contexts, so its guide is two parts and
     no prefix; the reader's part never mentions that a question exists. */
  it("loads the researcher's two parts by their own hashes, and refuses the guide as a prefix of its own", () => {
    const planner = loadGuidePart("researcher", "v1.0", "planner");
    const reader = loadGuidePart("researcher", "v1.0", "reader");
    const manifest = readManifest("researcher", "v1.0");
    expect(planner.sha256).toBe(manifest.parts?.planner.sha256);
    expect(reader.sha256).toBe(manifest.parts?.reader.sha256);
    expect(planner.sha256).not.toBe(reader.sha256);
    expect(planner.prefix.startsWith("# The researcher's planner")).toBe(true);
    expect(reader.prefix.startsWith("# The researcher's reader")).toBe(true);
    expect(planner.prefix).toContain("five or more consecutive words");
    expect(reader.prefix).not.toMatch(/question/i);
    expect(reader.prefix).not.toMatch(/\bask/i);
    expect(reader.prefix).toContain("`G` Opinion");
    expect(() => loadGuide("researcher", "v1.0")).toThrow(/no prefix of its own: load one of its parts \(planner, reader\)/);
    expect(() => loadGuidePart("researcher", "v1.0", "critic")).toThrow(/has no part "critic"/);
  });

  /* Unit 69a (feature-specs/48 § 5.3, § 5.4, § 5.6): a person's research is three calls with separate contexts, so
     version 2 is three parts and no prefix; the reader's part still never mentions that a question exists, the
     planner's has no COVERED, and the writer's holds the report to its limits. Version 1 still loads by its own hashes. */
  it("loads the researcher's version 2 three parts by their own hashes, each opening with the heading the stub recognises", () => {
    const manifest = readManifest("researcher", "v2.0");
    const parts = { planner: loadGuidePart("researcher", "v2.0", "planner"), reader: loadGuidePart("researcher", "v2.0", "reader"), writer: loadGuidePart("researcher", "v2.0", "writer") };
    for (const [name, part] of Object.entries(parts)) {
      expect(part.sha256).toBe(manifest.parts?.[name]?.sha256);
      expect(part.prefix.startsWith(`# The researcher's ${name} — guide v2.0\n`)).toBe(true);
      expect(part.prefix.includes("\r")).toBe(false);
    }
    expect(new Set(Object.values(parts).map((part) => part.sha256)).size).toBe(3);
    expect(Object.keys(manifest.parts ?? {})).toEqual(["planner", "reader", "writer"]);
    expect(parts.planner.prefix).not.toContain("COVERED");
    expect(parts.planner.prefix).toContain("five or more consecutive words of any question you were shown");
    expect(parts.reader.prefix).not.toMatch(/question/i);
    expect(parts.reader.prefix).not.toMatch(/\bask/i);
    expect(parts.reader.prefix).toContain('"says": "at most 60 words"');
    expect(parts.writer.prefix).toContain("At most 8 paragraphs and 600 words in all");
    expect(parts.writer.prefix).toContain("Never compute a figure");
    expect(() => loadGuide("researcher", "v2.0")).toThrow(/no prefix of its own: load one of its parts \(planner, reader, writer\)/);
    expect(loadGuidePart("researcher", "v1.0", "reader").sha256).toBe(readManifest("researcher", "v1.0").parts?.reader.sha256);
  });

  it("refuses a guide whose bytes no longer match its manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-guide-"));
    const version = join(dir, "assistant", "v9.9");
    writeFileSync(join(dir, "manifest.json"), "{}");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a temp tree needs mkdir; node:fs is imported above
    require("node:fs").mkdirSync(version, { recursive: true });
    writeFileSync(join(version, "guide.md"), "edited\n");
    writeFileSync(join(version, "manifest.json"), JSON.stringify({ agent: "assistant", version: "v9.9", files: ["guide.md"], sha256: "0".repeat(64) }));
    expect(() => loadGuide("assistant", "v9.9", dir)).toThrow(/has changed/);
  });
});
