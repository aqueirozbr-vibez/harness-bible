import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dateOf, decodeDocument, decodeEntities, declaredCharset, extractHtml } from "./html";

/*
 * The HTML extractor (feature-specs/32 § 4.3, § 13.3): a fixture page yields its title, its visible text in reading
 * order, its metadata date and its canonical URL; nothing a script, a style, a comment, a hidden element or an
 * svg holds is in the text; and the pieces — entities, dates, the declared charset — on their own.
 */

const ARTICLE = readFileSync(join(import.meta.dirname, "__fixtures__", "article.html"), "utf8");
const BASE = "https://provider-two.example/blog/retries?utm_source=social";

describe("extractHtml on the article fixture", () => {
  const page = extractHtml(ARTICLE, BASE);

  it("takes the title from <title>, decoded and collapsed, before og:title", () => {
    expect(page.title).toBe("Retries at eleven steps — Provider Two Engineering");
  });

  it("takes the publication date from article:published_time, as a day, over JSON-LD, the modified time and <time>", () => {
    expect(page.publishedOn).toBe("2026-07-14");
  });

  it("resolves the canonical link against the page's URL, before og:url", () => {
    expect(page.canonicalUrl).toBe("https://provider-two.example/blog/retries");
  });

  it("keeps the visible text in reading order with a line per block", () => {
    const lines = page.text.split("\n").filter((line) => line !== "");
    expect(lines.slice(0, 4)).toEqual(["Home Blog", "Retries at eleven steps", "By the platform team · 15 July 2026", "A retried write without an idempotency key is a second write. At eleven steps the chance that at least one step retries is 1 − 0.9511 ≈ 43 %."]);
    expect(lines).toContain("The fix is small: Idempotency-Key on every write, stored for 24 h, replayed on a repeat. Compare our plans.");
    expect(lines).toContain("Retry rate against steps"); // the image's alt text
    expect(lines).toContain("Figure 1. The retry rate against the number of steps.");
    expect(lines).toContain("Steps | Retry rate");
    expect(lines).toContain("11 | 43 %");
    expect(lines).toContain("- Keys on every write");
    expect(lines).toContain("- Replay, never re-run");
    expect(lines).toContain("POST /writes");
    expect(lines).toContain("Idempotency-Key: 7c3e…");
    expect(lines).toContain("Tags in text: 1 < 2 and a <b> written as entities; á combining; 😀 emoji; &unknownthing; kept.");
    expect(lines[lines.length - 1]).toBe("© 2026 Provider Two");
  });

  it("holds nothing of a script, a style, a comment, a hidden element, an svg, a textarea, a noscript or a template", () => {
    for (const marker of ["SCRIPT_TEXT_MUST_NOT_APPEAR", "SCRIPT_TAIL_MUST_NOT_APPEAR", "injected", "font-family", "markup", "HIDDEN_TEXT", "ARIA_HIDDEN", "SVG_TITLE", "SVG_TEXT", "TEXTAREA_MUST", "NOSCRIPT_MUST", "TEMPLATE_MUST", "analyticsToken", "schema.org"]) {
      expect(page.text, marker).not.toContain(marker);
    }
    expect(page.text).not.toContain("Pricing > plans"); // an attribute value is not text
  });
});

describe("extractHtml on fragments", () => {
  it("falls back to og:title and og:url, and to the JSON-LD date, when the direct forms are absent", () => {
    const page = extractHtml('<head><meta property="og:title" content=" Social  title "><meta property="og:url" content="https://a.example/p"><script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"Article","datePublished":"2026-05-02T08:00:00Z"}]}</script></head><body><p>x</p></body>');
    expect(page).toEqual({ title: "Social title", text: "x", publishedOn: "2026-05-02", canonicalUrl: "https://a.example/p" });
  });

  it("reads the named meta dates and a <time> element, the published one before a plain one", () => {
    expect(extractHtml('<meta name="DC.date.issued" content="2025-12-31">').publishedOn).toBe("2025-12-31");
    expect(extractHtml('<meta name="pubdate" content="March 5, 2026">').publishedOn).toBe("2026-03-05");
    expect(extractHtml('<time datetime="2026-01-02">a</time><time datetime="2026-01-01" pubdate>b</time>').publishedOn).toBe("2026-01-01");
    expect(extractHtml('<time datetime="2026-01-02">a</time><time itemprop="datePublished" datetime="2026-01-03">b</time>').publishedOn).toBe("2026-01-03");
  });

  it("answers null for a date it cannot read and for a page that states none", () => {
    expect(extractHtml('<meta property="article:published_time" content="yesterday">').publishedOn).toBeNull();
    expect(extractHtml("<p>No metadata here.</p>").publishedOn).toBeNull();
    expect(extractHtml('<meta property="article:modified_time" content="2026-09-01">').publishedOn).toBeNull();
  });

  it("ignores a canonical that is not an http(s) URL and a relative one without a base", () => {
    expect(extractHtml('<link rel="canonical" href="javascript:alert(1)">').canonicalUrl).toBeNull();
    expect(extractHtml('<link rel="canonical" href="/x">').canonicalUrl).toBeNull();
    expect(extractHtml('<link rel="alternate canonical" href="https://a.example/x">').canonicalUrl).toBe("https://a.example/x");
  });

  it("is lenient with a page that is not well formed", () => {
    expect(extractHtml("<p>open <b>bold <i>both</p><div>next").text).toBe("open bold both\nnext");
    expect(extractHtml('<a href="x>y" title=\'q>r\'>link</a> after').text).toBe("link after");
    expect(extractHtml("<script>never closed").text).toBe("");
    expect(extractHtml("<svg><title>t</title><text>never closed").text).toBe("");
    expect(extractHtml("<!-- never closed <p>x</p>").text).toBe("");
    expect(extractHtml("a < b and c <3 d").text).toBe("a < b and c <3 d");
    expect(extractHtml("<p>one<br>two<br/>three</p>").text).toBe("one\ntwo\nthree");
    expect(extractHtml("").text).toBe("");
    expect(extractHtml("<title></title><title>Second</title>").title).toBe("Second");
  });

  it("reads an uppercase page as a lowercase one", () => {
    const page = extractHtml('<HTML><HEAD><TITLE>Upper</TITLE><META NAME="date" CONTENT="2026-02-03"><SCRIPT>no()</SCRIPT></HEAD><BODY><P>Text</P></BODY></HTML>');
    expect(page).toEqual({ title: "Upper", text: "Text", publishedOn: "2026-02-03", canonicalUrl: null });
  });

  it("keeps a nested skipped element's close from ending the skip early", () => {
    expect(extractHtml("<div hidden>a<div>b</div>c</div>visible").text).toBe("visible");
    expect(extractHtml("<select><option>one</option><option>two</option></select> chosen").text).toBe("chosen");
  });
});

describe("decodeEntities", () => {
  it("decodes the named, decimal and hex forms and leaves an unknown name as written", () => {
    expect(decodeEntities("&amp;&lt;&gt;&quot;&apos;&nbsp;&mdash;&eacute;&Ccedil;")).toBe("&<>\"' —éÇ");
    expect(decodeEntities("&#65;&#x41;&#x1F600;&#128512;")).toBe("AA😀😀");
    expect(decodeEntities("&bogus; &amp &#; &#xZZ;")).toBe("&bogus; &amp &#; &#xZZ;");
    expect(decodeEntities("&#0;&#xD800;&#x110000;")).toBe("���");
    expect(decodeEntities("plain")).toBe("plain");
  });
});

describe("dateOf", () => {
  it.each<[string, string | null]>([
    ["2026-07-14", "2026-07-14"],
    ["2026-07-14T09:30:00-03:00", "2026-07-14"], // the day as the page wrote it, not shifted to UTC
    ["2026-07-14 09:30", "2026-07-14"],
    [" 2026-02-29 ", null], // not a leap year
    ["2024-02-29", "2024-02-29"],
    ["2026-13-01", null],
    ["14 July 2026", "2026-07-14"],
    ["July 14, 2026 10:00 GMT", "2026-07-14"],
    ["Tue, 14 Jul 2026 09:30:00 GMT", "2026-07-14"],
    ["1899-12-31", null],
    ["3000-01-01", null],
    ["yesterday", null],
    ["", null],
    ["20260714", null],
  ])("%s → %s", (value, expected) => {
    expect(dateOf(value)).toBe(expected);
  });
});

describe("declaredCharset", () => {
  it("reads the meta charset, the http-equiv form and an XML declaration from the first kilobyte", () => {
    expect(declaredCharset(Buffer.from('<!doctype html><html><head><meta charset="ISO-8859-1"><title>x</title>'))).toBe("iso-8859-1");
    expect(declaredCharset(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">'))).toBe("windows-1252");
    expect(declaredCharset(Buffer.from('<?xml version="1.0" encoding="UTF-16"?><html/>'))).toBe("utf-16");
    expect(declaredCharset(Buffer.from("<html><head><title>x</title></head></html>"))).toBeNull();
    expect(declaredCharset(Buffer.from(`${" ".repeat(1100)}<meta charset="utf-8">`))).toBeNull();
  });
});

describe("decodeDocument", () => {
  const latin = Buffer.from("Preço", "latin1");
  const declared = Buffer.concat([Buffer.from('<meta charset="iso-8859-1">'), latin]);

  it("reads the response's charset first, then for HTML the page's declaration, then UTF-8", () => {
    expect(decodeDocument(latin, "iso-8859-1", false)).toBe("Preço");
    expect(decodeDocument(declared, null, true)).toBe('<meta charset="iso-8859-1">Preço');
    expect(decodeDocument(Buffer.from("Preço", "utf8"), null, true)).toBe("Preço");
    /* A text's body is not read for a declaration. */
    expect(decodeDocument(declared, null, false)).toBe('<meta charset="iso-8859-1">Pre�o');
  });

  it("passes over a label the decoder does not know for the next one, not straight to UTF-8", () => {
    for (const label of ["latin-1", "utf8mb4", "binary"]) expect(decodeDocument(declared, label, true), label).toBe('<meta charset="iso-8859-1">Preço');
    expect(decodeDocument(latin, "latin-1", false)).toBe("Pre�o");
  });

  it("reads a byte order mark before any label, and leaves it out of the text", () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Preço", "utf8")]);
    expect(decodeDocument(utf8, "iso-8859-1", true)).toBe("Preço");
    expect(decodeDocument(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Preço", "utf16le")]), null, false)).toBe("Preço");
    const be = Buffer.from("Preço", "utf16le").swap16();
    expect(decodeDocument(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), "utf-8", false)).toBe("Preço");
  });
});
