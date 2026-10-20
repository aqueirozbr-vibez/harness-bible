import { describe, expect, it } from "vitest";

import { parseChapterFile, ParseError, standfirstOf } from "./chapterFile";
import { CH21_FILE, fixture } from "./fixtures";

const ch21 = fixture(CH21_FILE);

describe("parseChapterFile", () => {
  it("splits chapter 21 into its nine layers in the linter's order", () => {
    const parsed = parseChapterFile(CH21_FILE, ch21);
    expect(parsed.number).toBe(21);
    expect(parsed.slug).toBe("control-plane");
    expect(parsed.title).toBe("Control plane and durable execution");
    expect(parsed.proseOnly).toBe(false);
    expect(parsed.layers.map((l) => l.title)).toEqual(["Intuition", "Mechanism", "Worked numbers", "Measurement", "Failure", "The frontier", "Industrial application", "Decision aids", "Sources"]);
    expect(parsed.layers.map((l) => l.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(parsed.layers[2].layer).toBe("WORKED_NUMBERS");
    expect(parsed.layers[2].markdown.startsWith("All figures from `derive.py` (derived).")).toBe(true);
  });

  it("knows where each layer's heading and markdown sit in the file (feature-specs/33 § 4.1)", () => {
    const parsed = parseChapterFile(CH21_FILE, ch21);
    for (const layer of parsed.layers) {
      expect(layer.body).not.toBeNull();
      expect(ch21.slice(layer.body?.from, layer.body?.to)).toBe(layer.markdown);
      expect(ch21.slice(layer.heading?.from, layer.heading?.to)).toBe(`## 21.${String(layer.ordinal)} ${layer.title}`);
    }
    /* an empty layer sits just after its heading */
    const empty = parseChapterFile(CH21_FILE, ch21.replace(/(## 21\.6 The frontier\n)[\s\S]*?(?=## 21\.7)/, "$1\n"));
    const frontier = empty.layers[5];
    expect(frontier.markdown).toBe("");
    expect(frontier.body?.from).toBe(frontier.body?.to);
    expect(frontier.body?.from).toBeGreaterThanOrEqual(frontier.heading?.to ?? Infinity);
    expect(frontier.body?.from).toBeLessThan(empty.layers[6].heading?.from ?? -1);
  });

  it("reads the frontmatter line", () => {
    const { frontmatter } = parseChapterFile(CH21_FILE, ch21);
    expect(frontmatter.part).toBe("P2");
    expect(frontmatter.lab).toBe(21);
    expect(frontmatter.verifiedAsOf).toEqual({ year: 2026, month: 9 });
    expect(frontmatter.derivePath).toBe("labs/ch21-control-plane/derive.py");
  });

  it("takes the standfirst from the first sentence of Intuition (D16)", () => {
    const standfirst = standfirstOf(parseChapterFile(CH21_FILE, ch21));
    expect(standfirst.startsWith("The maintenance agent reaches step eight")).toBe(true);
    expect(standfirst.endsWith(".")).toBe(true);
  });

  it("names a missing layer", () => {
    const withoutFailure = ch21.replace(/^## 21\.5 Failure$/m, "## 21.5 Failures");
    expect(() => parseChapterFile(CH21_FILE, withoutFailure)).toThrow(ParseError);
    expect(() => parseChapterFile(CH21_FILE, withoutFailure)).toThrow(/layer 5 is titled "Failures", expected Failure/);
    const missing = ch21.replace(/^## 21\.5 Failure$\n/m, "");
    expect(() => parseChapterFile(CH21_FILE, missing)).toThrow(/missing layer heading: Failure/);
  });

  it("ingests a prose-only chapter as Intuition plus an empty Sources layer (D15)", () => {
    const text = "# Chapter 00 — The heuristic becomes the algorithm\n\n*Part 0 · No lab · Verified as of September 2026*\n\nA paragraph of prose. Another sentence.\n\n*Sources: none.*\n";
    const parsed = parseChapterFile("ch00-heuristic.md", text);
    expect(parsed.proseOnly).toBe(true);
    expect(parsed.layers.map((l) => l.layer)).toEqual(["INTUITION", "SOURCES"]);
    expect(parsed.layers[0].markdown.startsWith("A paragraph of prose.")).toBe(true);
    expect(parsed.frontmatter.noLab).toBe(true);
    expect(standfirstOf(parsed)).toBe("A paragraph of prose.");
    /* no headings to find; the Sources layer is not in the file */
    expect(text.slice(parsed.layers[0].body?.from, parsed.layers[0].body?.to)).toBe(parsed.layers[0].markdown);
    expect(parsed.layers.map((l) => l.heading)).toEqual([null, null]);
    expect(parsed.layers[1].body).toBeNull();
  });

  it("rejects a file whose title names another chapter", () => {
    expect(() => parseChapterFile("ch22-x.md", ch21)).toThrow(/title says chapter 21/);
  });
});
