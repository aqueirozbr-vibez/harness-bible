import { describe, expect, it } from "vitest";

import { CH21_FILE, fixture } from "./fixtures";
import { countWords } from "./wordCount";

describe("countWords", () => {
  it("counts prose plus tables and excludes code and math", () => {
    const md = "Two words.\n\n```python\nnot counted at all\n```\n\n| a | b |\n|---|---|\n| c | d |\n\nInline $x = 1$ math gone. $$\ny\n$$";
    const count = countWords(md);
    expect(count.prose).toBe(5);
    expect(count.tables).toBe(11);
    expect(count.total).toBe(16);
  });

  /* Pinned from the pipeline's own count of the chapter-21 file (title and frontmatter
     included, as the linter counts); the linter itself could not run here (no Python). */
  it("counts chapter 21", () => {
    expect(countWords(fixture(CH21_FILE)).total).toBe(7114);
  });
});
