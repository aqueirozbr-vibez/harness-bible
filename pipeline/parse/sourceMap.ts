import type { Token, Tokens } from "marked";

import { finishProse, proseMarked, type ProseLeaf } from "./markdown";

/*
 * Where rendered prose came from (feature-specs/33 § 4.1): for each character of the HTML renderProse makes of a
 * markdown, its offset in that markdown, or -1 for markup the renderer wrote. marked keeps no positions, so the map
 * is made in three steps, each checked. Every token is placed by its `raw`, which must stand at that place character
 * for character. The markdown is rendered again by the same renderer with each leaf's HTML between markers. Each
 * leaf's HTML is aligned with its raw text, and a character is mapped only where the markdown holds the character it
 * renders. A token that cannot be placed or a leaf that cannot be aligned maps to -1, never to a guess, and a render
 * that differs from the build's maps nothing.
 */

/** A stretch of a file's text: `text.slice(from, to)`. */
export interface Span {
  readonly from: number;
  readonly to: number;
}

/** From an offset in a token's raw text to an offset in the markdown, or -1. */
type At = (offset: number) => number;

const OPEN = String.fromCharCode(0xe000);
const MID = String.fromCharCode(0xe001);
const CLOSE = String.fromCharCode(0xe002);

/** Place each token at its offset in `text`, in order; a token whose raw is not there stops the placing. */
function placeAll(tokens: ReadonlyArray<Token>, text: string, at: At, places: Map<object, At>): void {
  let cursor = 0;
  for (const token of tokens) {
    if (!text.startsWith(token.raw, cursor)) return;
    const start = cursor;
    place(token, (offset) => at(start + offset), places);
    cursor += token.raw.length;
  }
}

/** Line by line from `text` to `raw`, which marked wrote with a prefix on each line (`> `, a list item's indent): each line of `text` must end its line of `raw`. */
function byLine(text: string, raw: string, at: At): At {
  const textLines = text.split("\n");
  const rawLines = raw.split("\n");
  return (offset) => {
    let line = 0;
    let textStart = 0;
    let rawStart = 0;
    while (line < textLines.length - 1 && offset > textStart + textLines[line].length) {
      textStart += textLines[line].length + 1;
      rawStart += (rawLines[line]?.length ?? 0) + 1;
      line += 1;
    }
    const rawLine = rawLines[line];
    if (rawLine === undefined || !rawLine.endsWith(textLines[line])) return -1;
    return at(rawStart + rawLine.length - textLines[line].length + (offset - textStart));
  };
}

/**
 * Where a token's text stands in its raw, by its syntax, or -1: after `![` for an image; after the `[` or `<` of a link,
 * whose bare URL is its own text; between the delimiters of emphasis; at the start of a paragraph or a block's text.
 * Never found by searching: an image `![!](…)` holds its text at 0 as well as at 2.
 */
function textAt(type: string, raw: string, text: string): number {
  const at = type === "image" ? 2 : type === "link" ? (raw === text ? 0 : 1) : type === "strong" || type === "em" || type === "del" ? (raw.length - text.length) / 2 : type === "heading" ? raw.length - raw.replace(/^ {0,3}#{1,6}[ \t]*/, "").length : 0;
  return Number.isInteger(at) && raw.startsWith(text, at) ? at : -1;
}

function place(token: Token, at: At, places: Map<object, At>): void {
  switch (token.type) {
    case "text":
      if ((token as Tokens.Text).tokens === undefined) {
        places.set(token, at);
        return;
      }
      break;
    case "escape":
    case "codespan":
    case "html":
    case "image":
      places.set(token, at);
      return;
    case "list":
      placeAll((token as Tokens.List).items, token.raw, at, places);
      return;
    case "list_item":
    case "blockquote": {
      const { text, raw, tokens } = token as Tokens.ListItem | Tokens.Blockquote;
      placeAll(tokens, text, byLine(text, raw, at), places);
      return;
    }
    case "table":
      /* cells render as table cells, and the figure grammar reads paragraphs only */
      return;
  }
  /* a token whose children are lexed from its text, which stands in its raw: a paragraph, a heading, strong, em, del, a link, a block's text */
  const parent = token as { readonly type: string; readonly raw: string; readonly text?: unknown; readonly tokens?: ReadonlyArray<Token> };
  if (typeof parent.text !== "string" || parent.tokens === undefined) return;
  const from = textAt(parent.type, parent.raw, parent.text);
  if (from >= 0) placeAll(parent.tokens, parent.text, (offset) => at(from + offset), places);
}

const ENTITY = /&(?:amp|lt|gt|quot|#39);/y;
const ENTITY_CHAR: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const REFERENCE = /&#(?:(\d{1,7})|[xX]([0-9a-fA-F]{1,6}));/y;

/** The character a numeric reference stands for, as marked decodes it. */
function referenced(match: RegExpExecArray): string {
  const code = match[1] === undefined ? Number.parseInt(match[2], 16) : Number.parseInt(match[1], 10);
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? String.fromCharCode(0xfffd) : String.fromCodePoint(code);
}

/**
 * For each character of `html`, the offset in `raw` (counted from `start`) of the character it renders, or -1. marked
 * writes `&` `<` `>` `"` `'` as entities, decodes a numeric reference to its character and turns a line break in
 * inline code into a space; anything else parts the two, and the rest maps to -1.
 */
function align(html: string, raw: string, start: number): number[] {
  const offsets: number[] = [];
  let i = 0;
  let j = start;
  while (i < html.length && j < raw.length) {
    ENTITY.lastIndex = i;
    const entity = ENTITY.exec(html)?.[0];
    REFERENCE.lastIndex = j;
    const reference = REFERENCE.exec(raw);
    let width: number;
    let step: number;
    if (entity !== undefined && !raw.startsWith(entity, j) && raw[j] === ENTITY_CHAR[entity]) {
      width = entity.length;
      step = 1;
    } else if (reference !== null) {
      const char = referenced(reference);
      const shown = html.startsWith(char, i) ? char : entity !== undefined && ENTITY_CHAR[entity] === char ? entity : null;
      if (shown === null) break;
      width = shown.length;
      step = reference[0].length;
    } else if (html[i] === raw[j] || (html[i] === " " && raw[j] === "\n")) {
      width = 1;
      step = 1;
    } else break;
    for (let k = 0; k < width; k += 1) offsets.push(j);
    i += width;
    j += step;
  }
  while (offsets.length < html.length) offsets.push(-1);
  return offsets;
}

/** Each character of a leaf's HTML mapped to the markdown, where the markdown holds the raw character it renders. */
function originsOf(token: ProseLeaf, html: string, at: At, markdown: string): number[] {
  const { raw } = token;
  let inner = html;
  let before = 0;
  let start = 0;
  if (token.type === "codespan") {
    before = "<code>".length;
    inner = html.slice(before, html.length - "</code>".length);
    const ticks = /^`+/.exec(raw)?.[0].length ?? 0;
    /* marked drops one space at each end of inline code that has both */
    start = ticks + (raw.length - 2 * ticks - token.text.length === 2 ? 1 : 0);
  } else if (token.type === "escape") start = 1;
  else if (token.type === "image") start = textAt("image", raw, token.text);
  const origins = new Array<number>(html.length).fill(-1);
  if (start < 0) return origins;
  align(inner, raw, start).forEach((k, i) => {
    if (k < 0) return;
    const offset = at(k);
    if (offset >= 0 && markdown[offset] === raw[k]) origins[before + i] = offset;
  });
  return origins;
}

/**
 * For each character of `expected`, which is renderProse(markdown), its offset in `markdown`, or -1 for markup the
 * renderer wrote. Null when the render holds a marker character, written or as a numeric reference marked decodes,
 * or the marked render does not reproduce `expected`.
 */
export function proseOrigins(markdown: string, expected: string): Int32Array | null {
  /* a marker in the render itself, `&#xE002;` decoded to one, would be read as the hook's */
  if ([OPEN, MID, CLOSE].some((marker) => expected.includes(marker))) return null;
  const places = new Map<object, At>();
  const leaves: number[][] = [];
  const marked = proseMarked((token, html) => {
    const at = places.get(token);
    if (at === undefined) return html;
    leaves.push(originsOf(token, html, at, markdown));
    return `${OPEN}${String(leaves.length - 1)}${MID}${html}${CLOSE}`;
  });

  /* marked reads `\r\n` and `\r` as `\n` before anything else; its tokens are in that text */
  const unnormalised: number[] = [];
  for (let i = 0; i < markdown.length; i += 1) if (!(markdown[i] === "\r" && markdown[i + 1] === "\n")) unnormalised.push(i);
  const tokens = marked.lexer(markdown);
  placeAll(tokens, markdown.replace(/\r\n|\r/g, "\n"), (offset) => unnormalised[offset] ?? -1, places);

  const rendered = marked.parser(tokens);
  let stripped = "";
  const origins: number[] = [];
  for (let i = 0; i < rendered.length; ) {
    if (rendered[i] !== OPEN) {
      stripped += rendered[i];
      origins.push(-1);
      i += 1;
      continue;
    }
    /* a leaf is read by its own length, and its close must stand where that length ends */
    const mid = rendered.indexOf(MID, i);
    const index = rendered.slice(i + 1, mid);
    const leaf = mid > i && /^\d+$/.test(index) ? leaves[Number(index)] : undefined;
    const close = leaf === undefined ? -1 : mid + 1 + leaf.length;
    if (leaf === undefined || rendered[close] !== CLOSE) return null;
    stripped += rendered.slice(mid + 1, close);
    for (const origin of leaf) origins.push(origin);
    i = close + 1;
  }

  const finished = finishProse(stripped);
  if (finished !== expected) return null;
  /* finishProse only removes whitespace, so each character kept is the next of its kind */
  const carried = new Int32Array(finished.length);
  let k = 0;
  for (let i = 0; i < finished.length; i += 1) {
    while (k < stripped.length && stripped[k] !== finished[i]) k += 1;
    carried[i] = origins[k] ?? -1;
    k += 1;
  }
  return carried;
}
