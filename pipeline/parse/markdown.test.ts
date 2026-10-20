import { describe, expect, it } from "vitest";

import { bodyVocabularyViolations } from "@/lib/schemas/chapter";

import { escapeHtml, liftFences, plainText, renderProse } from "./markdown";

describe("liftFences", () => {
  it("replaces fences by placeholders and keeps caption and heading", () => {
    const md = "### Replay\n\nText.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n*Figure 21.1 · a caption.*\n\n```python\nx = 1\n```\nMore.";
    const { markdown, fences } = liftFences(md);
    expect(fences).toHaveLength(2);
    expect(fences[0]).toMatchObject({ index: 0, lang: "mermaid", text: "flowchart LR\n  A --> B", caption: "Figure 21.1 · a caption.", heading: "Replay" });
    expect(fences[1]).toMatchObject({ index: 1, lang: "python", text: "x = 1", caption: null });
    expect(markdown).toContain("@@FENCE_0@@");
    expect(markdown).toContain("@@FENCE_1@@");
    expect(markdown).not.toContain("```");
    expect(markdown).not.toContain("a caption");
    expect(markdown).toContain("More.");
  });

  it("knows where each character of its output came from: the input's, or none for a placeholder (feature-specs/33 § 4.1)", () => {
    const md = "### Replay\n\nText 1.\n\n```mermaid\nflowchart LR\n```\n\n*Figure 21.1 · a caption.*\n\nAfter 2.\n\n```python\nx = 1\n```\nMore 3.";
    const lifted = liftFences(md);
    for (const word of ["Text 1.", "After 2.", "More 3."]) {
      const at = lifted.markdown.indexOf(word);
      expect(lifted.origin(at), word).toBe(md.indexOf(word));
      expect(lifted.origin(at + word.length - 1), word).toBe(md.indexOf(word) + word.length - 1);
    }
    expect(lifted.origin(lifted.markdown.indexOf("@@FENCE_0@@"))).toBe(-1);
    /* every character it maps holds the same character in the input */
    for (let k = 0; k < lifted.markdown.length; k += 1) {
      const origin = lifted.origin(k);
      if (origin >= 0) expect(md[origin]).toBe(lifted.markdown[k]);
    }
  });
});

describe("renderProse", () => {
  it("renders prose, headings, emphasis and tables in the reader vocabulary", () => {
    const html = renderProse("### Sub\n\nA *word* and **bold** and `code`.\n\n| a | b |\n|---|---|\n| x | 12% |\n");
    expect(html).toContain("<h3>Sub</h3>");
    expect(html).toContain("<p>A <em>word</em> and <strong>bold</strong> and <code>code</code>.</p>");
    expect(html).toContain('<table class="tbl"><thead><tr><th>a</th><th>b</th></tr></thead>');
    expect(html).toContain('<td>x</td><td class="n">12%</td>');
    expect(bodyVocabularyViolations(html)).toEqual([]);
  });

  it("escapes raw HTML instead of passing it through", () => {
    const html = renderProse('Before <script>alert(1)</script> after <a onclick="x()">y</a>.');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(bodyVocabularyViolations(html)).toEqual([]);
  });

  it("renders links as source links and drops images and rules", () => {
    const html = renderProse("See [docs](https://example.org/x).\n\n---\n\n![alt](img.png)");
    expect(html).toContain('<a class="src" href="https://example.org/x">docs</a>');
    expect(html).not.toContain("<hr");
    expect(html).not.toContain("<img");
    expect(html).toContain("alt");
  });

  it("escapes and flattens text", () => {
    expect(escapeHtml('a<b>&"c"')).toBe("a&lt;b&gt;&amp;&quot;c&quot;");
    expect(plainText("**bold** `code` [link](http://x) _it_")).toBe("bold code link it");
  });
});
