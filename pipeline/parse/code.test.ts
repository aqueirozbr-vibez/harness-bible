import { describe, expect, it } from "vitest";

import { locateInLab, renderCodePane } from "./code";
import { CH21_LAB_DIR } from "./fixtures";
import { parseLab } from "./lab";

const lab = parseLab(CH21_LAB_DIR);
const labFiles = lab.files.map((f) => ({ path: f.path, content: f.content }));
const derivePy = lab.files.find((f) => f.path === "derive.py")?.content ?? "";
const block = derivePy.split("\n").slice(13, 17).join("\n");

describe("code panes", () => {
  it("finds a block inside a lab file by its first lines", () => {
    expect(locateInLab(block, labFiles)).toEqual({ path: "derive.py", line: 14 });
    expect(locateInLab("nothing like this\nat all", labFiles)).toBeNull();
  });

  it("numbers a lab block from its real line and highlights derive lines", () => {
    const pane = renderCodePane({ index: 0, lang: "python", text: block, caption: null, heading: null }, { locale: "en", labId: "lab-21", labFiles, highlightLines: new Set([14]) });
    expect(pane.view).toEqual({ index: 0, file: "lab-21/derive.py", lines: { from: 14, to: 17 }, language: "python", labHref: "/en/labs/lab-21/derive.py#L14" });
    expect(pane.html).toContain('<div class="code" data-block="0" id="code-0">');
    expect(pane.html).toContain("lab-21/derive.py");
    expect(pane.html).toContain('<span class="ln hl" data-n="14" id="ln-0-14">');
    expect(pane.html).toContain('<span class="ln" data-n="17" id="ln-0-17">');
    expect(pane.html).toContain("<template data-raw>");
    expect(pane.html).toContain('<span class="c"># E[(k-1)]/steps</span>');
  });

  it("numbers a free-standing block from 1 with no lab link", () => {
    const pane = renderCodePane({ index: 2, lang: "python", text: 'def f():\n    return "x"', caption: null, heading: null }, { locale: "pt", labId: "lab-21", labFiles, highlightLines: new Set() });
    expect(pane.view).toEqual({ index: 2, file: null, lines: null, language: "python", labHref: null });
    expect(pane.html).toContain('<span class="k">def</span> <span class="fn">f</span>');
    expect(pane.html).toContain('<span class="s">&quot;x&quot;</span>');
  });
});
