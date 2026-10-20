import { describe, expect, it } from "vitest";

import { xrefPass } from "./xrefs";

describe("xrefPass", () => {
  it("links chapters, sections, labs and source rows and records each reference once", () => {
    const out = xrefPass("<p>See ch16 and ch16 again, 26.3, Lab 21; rows 21.9 r4 and 22.9 r1.</p>", "en", 21);
    expect(out.refs).toEqual([
      { targetKind: "chapter", targetId: "ch16" },
      { targetKind: "section", targetId: "26.3" },
      { targetKind: "lab", targetId: "lab21" },
      { targetKind: "sourceRow", targetId: "21.9 r4" },
      { targetKind: "sourceRow", targetId: "22.9 r1" },
    ]);
    expect(out.html).toContain('<a class="xref" href="/en/ref/ch16" data-ref="ch16">ch16</a>');
    expect(out.html).toContain('<a class="xref" href="/en/ref/26.3" data-ref="26.3">26.3</a>');
    expect(out.html).toContain('<a class="xref" href="/en/ref/lab21" data-ref="lab21">Lab 21</a>');
    expect(out.html).toContain('<a class="src" href="#r4" data-row="21.9 r4">21.9 r4</a>');
    expect(out.html).toContain('<a class="xref" href="/en/ref/22.9" data-ref="22.9">22.9 r1</a>');
  });

  it("leaves text inside chips, links, code and figures alone", () => {
    const html = '<p><span class="chip t-ven"><i>ven</i> vendor · 21.9 r1</span> <a class="derive" href="/x">ƒ L38</a> <div class="code"><span class="ln">ch16</span></div></p>';
    const out = xrefPass(html, "en", 21);
    expect(out.html).toBe(html);
    expect(out.refs).toEqual([]);
  });

  it("ignores numbers that are not chapters of the book", () => {
    const out = xrefPass("<p>ch99 and 99.1 and Lab 77.</p>", "pt", 21);
    expect(out.refs).toEqual([]);
    expect(out.html).toBe("<p>ch99 and 99.1 and Lab 77.</p>");
  });
});
