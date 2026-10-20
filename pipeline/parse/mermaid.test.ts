import { describe, expect, it } from "vitest";

import { bodyVocabularyViolations } from "@/lib/schemas/chapter";

import { cleanSvg, figureHtml } from "./mermaid";

const RAW = '<svg id="m0" width="400" height="80" viewBox="0 0 400 80" style="max-width: 400px;" aria-roledescription="flowchart-v2"><style>#m0 .node rect { fill: #fff; }</style><defs><filter id="f"><feDropShadow dx="1"/></filter><linearGradient id="g"><stop offset="0"/></linearGradient><marker id="arrow"><path d="M0,0"/></marker></defs><g class="root"><g class="nodes"><g class="node default" style="fill:red" filter="url(#f)" onclick="x()"><rect fill="url(#g)" rx="0"/><text class="nodeLabel">A</text></g></g><g class="edgePaths"><path class="flowchart-link" marker-end="url(#arrow)"/></g><a href="x"><text>link</text></a><foreignObject><div>html</div></foreignObject></g></svg>';

describe("cleanSvg", () => {
  it("strips styles, effects, handlers, links and foreign content and adds the accessible names", () => {
    const svg = cleanSvg(RAW, "t1", "d1", "Figure 21.1", "A to B");
    expect(svg).not.toContain("<style");
    expect(svg).not.toContain("<filter");
    expect(svg).not.toContain("<linearGradient");
    expect(svg).not.toContain("<foreignObject");
    expect(svg).not.toContain("onclick");
    expect(svg).not.toContain('style="');
    expect(svg).not.toContain('filter="');
    expect(svg).not.toContain("url(#g)");
    expect(svg).not.toContain("<a ");
    expect(svg).toContain("<text>link</text>");
    expect(svg).toContain('<svg id="m0" viewBox="0 0 400 80" width="100%" role="img" aria-labelledby="t1 d1"><title id="t1">Figure 21.1</title><desc id="d1">A to B</desc>');
    expect(svg).toContain('<marker id="arrow"><path d="M0,0"/></marker>');
    expect(svg).toContain('class="node default"');
  });
});

describe("figureHtml", () => {
  const fence = { index: 0, lang: "mermaid", text: "flowchart LR\n  A[start] --> B[end]", caption: "Figure 21.1 · start to end.", heading: null };
  const labels = { figure: "Figure", rendered: "mermaid · rendered", alt: "alt text available", notRendered: "diagram could not be rendered at ingestion" };

  it("wraps a rendered diagram in the figure frame, inside the vocabulary", () => {
    const html = figureHtml(fence, RAW, 21, 1, "F-21-M01", labels);
    expect(html.startsWith('<figure class="fig box" data-figure="F-21-M01"><div class="inst-h"><span class="t">Figure 21.1</span>')).toBe(true);
    expect(html).toContain('<figcaption class="small muted rt">Figure 21.1 · start to end.</figcaption>');
    expect(html).toContain('<p class="sr-only">Figure 21.1 · start to end.</p>');
    expect(bodyVocabularyViolations(html)).toEqual([]);
  });

  it("carries a placeholder when rendering failed and describes the diagram from its labels", () => {
    const html = figureHtml({ ...fence, caption: null }, null, 21, 2, "F-21-M02", labels);
    expect(html).toContain('<p class="small muted">diagram could not be rendered at ingestion</p>');
    expect(html).toContain('<p class="sr-only">start → end</p>');
    expect(html).not.toContain("<figcaption");
  });
});
