/*
 * What the fetcher makes of an HTML page (feature-specs/32 § 4.3): the title, the visible text in reading order,
 * the publication date the page's own metadata states, and the canonical URL. Nothing else of the page is kept.
 *
 * This is a tokenizer of the unit's own, not a DOM: the repository has no HTML parser (the content pipeline renders
 * markdown with `marked` and parses none), and the one module that handles a stranger's bytes is better served by
 * two hundred lines it owns than by a dependency it must trust. It walks the text once: a start tag is read with
 * its attributes (quotes respected), the raw-text elements — script, style, textarea, title and their kin — jump to
 * their closing tag so that nothing they hold reaches the text, the elements that do not render (svg, math, iframe,
 * object, select, template, anything `hidden` or `aria-hidden`) are skipped to their matching close, and every
 * other text node is collapsed as a browser collapses whitespace, with a line break at each block boundary. The
 * head's `title`, `meta`, `link` and `time` elements and the JSON-LD blocks are read for the three facts beside
 * the text. A page that is not well formed yields what a lenient reading of it gives, never an error.
 */

export interface HtmlDocument {
  readonly title: string | null;
  readonly text: string;
  /** `YYYY-MM-DD`, from the page's own metadata; null when it states none. */
  readonly publishedOn: string | null;
  readonly canonicalUrl: string | null;
}

/** Elements whose content is text for the parser and never for the reader, up to their own closing tag. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "template", "xmp", "noembed", "noframes", "iframe"]);

/** Elements that render nothing readable, skipped with their whole subtree. */
const SKIPPED = new Set(["svg", "math", "object", "embed", "applet", "select", "datalist", "canvas", "audio", "video", "map"]);

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "html", "legend", "li", "main", "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "tfoot", "thead", "tr", "ul",
]);

const CELL = new Set(["td", "th"]);

/** The named character references a page's prose meets; the numeric forms cover the rest, and an unknown name is left as written. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷", micro: "µ", middot: "·", bull: "•", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", dagger: "†", Dagger: "‡", permil: "‰", prime: "′", Prime: "″", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", minus: "−", le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞", frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", shy: "", zwj: "‍", zwnj: "‌", ensp: " ", emsp: " ", thinsp: " ",
  aacute: "á", agrave: "à", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç", eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", iacute: "í", igrave: "ì", icirc: "î", iuml: "ï", ntilde: "ñ", oacute: "ó", ograve: "ò", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø", uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü", yacute: "ý", szlig: "ß",
  Aacute: "Á", Agrave: "À", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Ccedil: "Ç", Eacute: "É", Egrave: "È", Ecirc: "Ê", Iacute: "Í", Ntilde: "Ñ", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Uacute: "Ú", Uuml: "Ü",
};

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z][a-z0-9]{1,31}));/gi, (whole, _kind: string, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
    if (name !== undefined) return ENTITIES[name] ?? whole;
    const code = hex !== undefined ? parseInt(hex, 16) : Number(decimal);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
    return String.fromCodePoint(code);
  });
}

type Attributes = ReadonlyMap<string, string>;

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(text: string): Attributes {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    if (!attributes.has(name)) attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

/** The index just past the `>` that ends a start tag whose name ends at `from`, with quoted attribute values stepped over. */
function endOfStartTag(html: string, from: number): number {
  let index = from;
  while (index < html.length) {
    const char = html[index];
    if (char === ">") return index + 1;
    if (char === '"' || char === "'") {
      const close = html.indexOf(char, index + 1);
      if (close === -1) return html.length;
      index = close + 1;
      continue;
    }
    index++;
  }
  return html.length;
}

/** The index of the closing tag of a raw-text element, or the end of the text when it never closes. */
function endOfRawText(html: string, name: string, from: number): { readonly contentEnd: number; readonly next: number } {
  const close = new RegExp(`</${name}\\s*>`, "ig");
  close.lastIndex = from;
  const match = close.exec(html);
  return match === null ? { contentEnd: html.length, next: html.length } : { contentEnd: match.index, next: match.index + match[0].length };
}

/** The index past the close tag that matches an element to be skipped, counting nested elements of the same name. */
function endOfSkipped(html: string, name: string, from: number): number {
  const tags = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>`, "ig");
  tags.lastIndex = from;
  let depth = 1;
  for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return html.length;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ");

/* A metadata date the page states, by how directly it states it: the lowest rank wins when several are present. */
const DATE_KEYS: Readonly<Record<string, number>> = {
  "article:published_time": 1,
  datepublished: 3,
  date: 4, "dc.date": 4, "dc.date.issued": 4, "dcterms.created": 4, "dcterms.date": 4, "dcterms.issued": 4, pubdate: 4, publishdate: 4, "publish-date": 4, publish_date: 4, publication_date: 4, "publication-date": 4, "article.published": 4, "sailthru.date": 4, "parsely-pub-date": 4, citation_publication_date: 4, citation_date: 4, "og:article:published_time": 4,
};
const JSON_LD_RANK = 2;
const TIME_PUBDATE_RANK = 5;
const TIME_RANK = 6;

/** `YYYY-MM-DD` from a date the page wrote, in ISO form or anything `Date.parse` reads; null when it is not a plausible date. */
export function dateOf(value: string): string | null {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(text);
  const [year, month, day] = iso === null ? fromParsed(text) : [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  if (year === undefined || month === undefined || day === undefined) return null;
  if (year < 1900 || year > 2999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function fromParsed(text: string): [number, number, number] | [] {
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return [];
  const date = new Date(ms);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

/** `datePublished` anywhere in a JSON-LD block's objects, its graph included, three levels deep. */
function datePublishedOf(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  const walk = (node: unknown, depth: number): string | null => {
    if (depth > 3 || node === null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found !== null) return found;
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    if (typeof record["datePublished"] === "string") return record["datePublished"];
    return walk(record["@graph"], depth + 1) ?? walk(record["mainEntity"], depth + 1);
  };
  return walk(parsed, 0);
}

function absoluteOf(href: string, base: string | undefined): string | null {
  try {
    const url = base === undefined ? new URL(href) : new URL(href, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

interface Facts {
  title: string | null;
  ogTitle: string | null;
  canonical: string | null;
  ogUrl: string | null;
  date: { readonly rank: number; readonly value: string } | null;
}

/**
 * The page's title, text, date and canonical URL. `base` is the URL the page was fetched from, which a relative
 * canonical link is resolved against.
 */
export function extractHtml(html: string, base?: string): HtmlDocument {
  const out: string[] = [];
  const facts: Facts = { title: null, ogTitle: null, canonical: null, ogUrl: null, date: null };
  let preDepth = 0;

  const noteDate = (rank: number, value: string | null | undefined): void => {
    if (value === undefined || value === null) return;
    const day = dateOf(value);
    if (day !== null && (facts.date === null || rank < facts.date.rank)) facts.date = { rank, value: day };
  };
  const emitBreak = (): void => {
    if (out.length > 0 && out[out.length - 1] !== "\n") out.push("\n");
  };
  const emitText = (raw: string): void => {
    const decoded = decodeEntities(raw);
    out.push(preDepth > 0 ? decoded : collapse(decoded));
  };

  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      emitText(html.slice(index));
      break;
    }
    if (open > index) emitText(html.slice(index, open));
    const next = html[open + 1] ?? "";

    if (next === "!" || next === "?") {
      /* A comment, a doctype, a CDATA section or a processing instruction: nothing of it is text. */
      if (html.startsWith("<!--", open)) {
        const close = html.indexOf("-->", open + 4);
        index = close === -1 ? html.length : close + 3;
      } else {
        const close = html.indexOf(">", open);
        index = close === -1 ? html.length : close + 1;
      }
      continue;
    }

    if (next === "/") {
      const close = html.indexOf(">", open);
      if (close === -1) break;
      const name = (/^<\/([a-zA-Z][^\s/>]*)/.exec(html.slice(open, Math.min(close, open + 64)))?.[1] ?? "").toLowerCase();
      if (BLOCK.has(name)) emitBreak();
      if (name === "pre" && preDepth > 0) preDepth--;
      if (CELL.has(name)) out.push(" | ");
      index = close + 1;
      continue;
    }

    const nameMatch = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(open, open + 64));
    if (nameMatch === null) {
      /* A `<` that begins no tag is text. */
      emitText("<");
      index = open + 1;
      continue;
    }
    const name = (nameMatch[1] ?? "").toLowerCase();
    const afterName = open + nameMatch[0].length;
    const tagEnd = endOfStartTag(html, afterName);
    const inside = html.slice(afterName, Math.max(afterName, tagEnd - 1));
    const selfClosing = /\/\s*$/.test(inside);
    const attributes = parseAttributes(selfClosing ? inside.replace(/\/\s*$/, "") : inside);
    index = tagEnd;

    if (RAW_TEXT.has(name)) {
      const { contentEnd, next: after } = endOfRawText(html, name, tagEnd);
      const content = html.slice(tagEnd, contentEnd);
      if (name === "title" && facts.title === null) {
        const text = collapse(decodeEntities(content)).trim();
        if (text !== "") facts.title = text;
      }
      if (name === "script" && (attributes.get("type") ?? "").toLowerCase().includes("ld+json")) noteDate(JSON_LD_RANK, datePublishedOf(content));
      index = after;
      continue;
    }

    if (name === "meta") {
      const key = (attributes.get("property") ?? attributes.get("name") ?? attributes.get("itemprop") ?? "").toLowerCase();
      const content = attributes.get("content");
      if (content !== undefined) {
        const rank = DATE_KEYS[key];
        if (rank !== undefined) noteDate(rank, content);
        if (key === "og:title" && facts.ogTitle === null && collapse(content).trim() !== "") facts.ogTitle = collapse(content).trim();
        if (key === "og:url" && facts.ogUrl === null) facts.ogUrl = absoluteOf(content.trim(), base);
      }
      continue;
    }

    if (name === "link") {
      const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
      const href = attributes.get("href");
      if (rel.includes("canonical") && href !== undefined && facts.canonical === null) facts.canonical = absoluteOf(href.trim(), base);
      continue;
    }

    if (name === "time") {
      const value = attributes.get("datetime");
      const published = attributes.has("pubdate") || (attributes.get("itemprop") ?? "").toLowerCase() === "datepublished";
      noteDate(published ? TIME_PUBDATE_RANK : TIME_RANK, value);
    }

    const hidden = attributes.has("hidden") || (attributes.get("aria-hidden") ?? "").toLowerCase() === "true";
    if ((SKIPPED.has(name) || hidden) && !VOID.has(name) && !selfClosing) {
      index = endOfSkipped(html, name, tagEnd);
      if (BLOCK.has(name)) emitBreak();
      continue;
    }

    if (name === "br") {
      out.push("\n");
      continue;
    }
    if (BLOCK.has(name)) emitBreak();
    if (name === "pre") preDepth++;
    if (name === "li") out.push("- ");
    if (name === "img") {
      const alt = collapse(attributes.get("alt") ?? "").trim();
      if (alt !== "") out.push(` ${alt} `);
    }
  }

  const text = out
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").replace(/^(?:\s*\|\s*)+/, "").replace(/(?:\s*\|\s*)+$/, "").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title: facts.title ?? facts.ogTitle, text, publishedOn: facts.date === null ? null : facts.date.value, canonicalUrl: facts.canonical ?? facts.ogUrl };
}

/**
 * The charset a page declares in its first kilobyte, for a response whose `Content-Type` named none: the `meta`
 * charset, the `http-equiv` form, or an XML declaration's encoding. Null when it declares none.
 */
export function declaredCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head) ?? /<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_:.-]+)["']/i.exec(head);
  return meta === null ? null : (meta[1] ?? "").toLowerCase();
}

/**
 * A page's bytes as text, in § 4.3's order — the response's charset, then for HTML the one its first kilobyte
 * declares, then UTF-8 — with a byte order mark before them all, as a browser reads one, and each label taken only
 * when the decoder knows it: a response that names `latin-1` (no such label) is read by the page's own declaration,
 * not as UTF-8. The fetcher reads a page with it and the grading activity reads the stored source with it, so the
 * text graded is the text the fetcher saw (unit 49f).
 */
export function decodeDocument(bytes: Uint8Array, charset: string | null, html: boolean): string {
  for (const label of [byteOrderMarkOf(bytes), charset, html ? declaredCharset(bytes) : null]) {
    const decoder = label === null ? null : decoderOf(label);
    if (decoder !== null) return decoder.decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function decoderOf(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

function byteOrderMarkOf(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return null;
}
