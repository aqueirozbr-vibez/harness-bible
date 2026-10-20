import { describe, expect, it } from "vitest";

import { renderProse } from "./markdown";
import { proseOrigins } from "./sourceMap";

/** Where `needle`, found in the rendered prose (the `nth` time), came from in the markdown: one run, or null. */
function sourceOf(markdown: string, needle: string, nth = 0): string | null {
  const html = renderProse(markdown);
  const origins = proseOrigins(markdown, html);
  if (origins === null) throw new Error("no source map");
  let at = -1;
  for (let k = 0; k <= nth; k += 1) at = html.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`${needle} is not in ${html}`);
  const from = origins[at];
  for (let k = 0; k < needle.length; k += 1) if (from < 0 || origins[at + k] !== from + k) return null;
  return `${String(from)}:${markdown.slice(from, from + needle.length)}`;
}

describe("proseOrigins", () => {
  it("maps text back through the entities marked writes", () => {
    const md = "The supervisor's approval & the 45% (illustrative) rate.";
    expect(renderProse(md)).toContain("supervisor&#39;s approval &amp; the 45%");
    expect(sourceOf(md, "45%")).toBe(`${String(md.indexOf("45%"))}:45%`);
    expect(sourceOf(md, "approval")).toBe(`${String(md.indexOf("approval"))}:approval`);
  });

  it("maps inside emphasis, strong, inline code, an escape and a link's text", () => {
    const md = "A **12 s** wait, *7%* more, `retry = 3` here, \\*not em\\* 5 items, [docs 2026](https://x.example/2026) said 9.";
    expect(sourceOf(md, "12 s")).toBe(`${String(md.indexOf("12 s"))}:12 s`);
    expect(sourceOf(md, "7%")).toBe(`${String(md.indexOf("7%"))}:7%`);
    expect(sourceOf(md, "3")).toBe(`${String(md.indexOf("= 3") + 2)}:3`);
    expect(sourceOf(md, "5 items")).toBe(`${String(md.indexOf("5 items"))}:5 items`);
    /* the link's text maps to the text; its target, rendered first as the href, to nothing */
    expect(sourceOf(md, "2026", 1)).toBe(`${String(md.indexOf("2026"))}:2026`);
    expect(sourceOf(md, "2026", 0)).toBeNull();
    expect(sourceOf(md, "said 9")).toBe(`${String(md.indexOf("said 9"))}:said 9`);
  });

  it("places a token's text where its syntax puts it, never where a search would find it first", () => {
    /* the alt text `!` stands in `![!](…)` at 0 as well as at 2 */
    const md = "See ![!](x.png) and ![2 4](y.png) and [docs](https://x.example/) 6.";
    expect(sourceOf(md, "!")).toBe(`${String(md.indexOf("[!") + 1)}:!`);
    expect(sourceOf(md, "2 4")).toBe(`${String(md.indexOf("2 4"))}:2 4`);
    expect(sourceOf(md, "docs", 0)).toBe(`${String(md.indexOf("docs"))}:docs`);
  });

  it("maps a numeric character reference to the reference, and raw HTML, which the renderer escapes", () => {
    const md = "caf&#233; at 4, then <b>7</b> more.";
    expect(renderProse(md)).toContain("café at 4, then &lt;b&gt;7&lt;/b&gt; more.");
    expect(sourceOf(md, "é")).toBe(`${String(md.indexOf("&#233;"))}:&`);
    expect(sourceOf(md, "4")).toBe(`${String(md.indexOf("4"))}:4`);
    expect(sourceOf(md, "7")).toBe(`${String(md.indexOf("7"))}:7`);
  });

  it("maps the lines of a blockquote and of a loose list through their prefixes", () => {
    const quote = "Intro 1.\n\n> First line 3,\n> second line 4.\n\nAfter 8.";
    expect(sourceOf(quote, "3")).toBe(`${String(quote.indexOf("3"))}:3`);
    expect(sourceOf(quote, "4")).toBe(`${String(quote.indexOf("4"))}:4`);
    expect(sourceOf(quote, "8")).toBe(`${String(quote.indexOf("8"))}:8`);
    const list = "- item one is 5\n\n- item two is 6\n  and goes on 7\n";
    expect(renderProse(list)).toContain("<li><p>item one is 5</p>");
    expect(sourceOf(list, "5")).toBe(`${String(list.indexOf("5"))}:5`);
    expect(sourceOf(list, "7")).toBe(`${String(list.indexOf("7"))}:7`);
  });

  it("counts a CRLF file's line breaks as marked does and maps to the file as it is", () => {
    const md = "First 1.\r\n\r\nSecond 2.\r\n";
    expect(sourceOf(md, "2")).toBe(`${String(md.indexOf("2"))}:2`);
  });

  it("maps the renderer's own markup to nothing", () => {
    const md = "A *b* c.";
    const html = renderProse(md);
    const origins = proseOrigins(md, html);
    expect(html).toBe("<p>A <em>b</em> c.</p>");
    expect([...(origins ?? [])].slice(0, 3)).toEqual([-1, -1, -1]);
    expect(origins?.[html.indexOf("<em>")]).toBe(-1);
  });

  it("maps nothing when the render differs from the build's, or the render holds a marker character, written or decoded", () => {
    expect(proseOrigins("A 1.", "<p>A 2.</p>")).toBeNull();
    const marker = `A ${String.fromCharCode(0xe000)} 1.`;
    expect(proseOrigins(marker, renderProse(marker))).toBeNull();
    /* found by the review of part 1: marked decodes `&#xE002;` to a marker, which shifted every later origin onto another figure */
    const decoded = "Marks a&#xE002;*b&#xE002;* here.\n\nThe ratio went 5 5 (vendor).";
    expect(proseOrigins(decoded, renderProse(decoded))).toBeNull();
    const inCell = "| a |\n|---|\n| x&#57344; |\n\nText 5.";
    expect(proseOrigins(inCell, renderProse(inCell))).toBeNull();
  });

  it("maps a paragraph of any length, and an image's alt text only where its syntax puts it", () => {
    const long = `${"word ".repeat(40000)}and 7.`;
    expect(proseOrigins(long, renderProse(long))?.length).toBe(renderProse(long).length);
    /* marked drops the escapes of `\[` in alt text, so the alt no longer stands in its raw: nothing is mapped, not the title's `40%` */
    const escaped = 'See ![a \\[2\\] at 40%](x.png "a [2] at 40%") here.';
    expect(sourceOf(escaped, "40%")).toBeNull();
  });
});
