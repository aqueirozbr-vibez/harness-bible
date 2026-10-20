import { Marked, Renderer, type Tokens } from "marked";

/*
 * Markdown → the reader vocabulary (feature-specs/04 § 6.2; spec 03 § 4.2).
 * Fenced code and mermaid blocks are lifted out first and rendered by
 * code.ts and mermaid.ts; this module renders prose, lists and tables only.
 * Raw HTML in the source is escaped, never passed through.
 */

export interface Fence {
  readonly index: number;
  readonly lang: string;
  readonly text: string;
  /** Italic line that follows the fence, when present: the figure caption. */
  readonly caption: string | null;
  /** The nearest `###` heading above the fence, for lab-file detection. */
  readonly heading: string | null;
}

export interface LiftedMarkdown {
  readonly markdown: string;
  readonly fences: ReadonlyArray<Fence>;
  /** Where a character of `markdown` came from in the input: its offset there, or -1 for a placeholder (feature-specs/33 § 4.1). */
  readonly origin: (offset: number) => number;
}

export const FENCE_PLACEHOLDER = (index: number): string => `@@FENCE_${index}@@`;

const FENCE_RE = /^```([\w-]*)[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

/** A stretch of an output copied from its input: `out` and `src` are where it starts in each. */
interface Run {
  readonly out: number;
  readonly src: number;
  readonly length: number;
}

/** The runs once the output's `[at, at + length)` is removed. */
function cut(runs: ReadonlyArray<Run>, at: number, length: number): Run[] {
  const end = at + length;
  const next: Run[] = [];
  for (const run of runs) {
    const runEnd = run.out + run.length;
    if (runEnd <= at) next.push(run);
    else if (run.out >= end) next.push({ ...run, out: run.out - length });
    else {
      if (run.out < at) next.push({ out: run.out, src: run.src, length: at - run.out });
      if (runEnd > end) next.push({ out: at, src: run.src + (end - run.out), length: runEnd - end });
    }
  }
  return next;
}

/** Replace every fenced block by a placeholder paragraph and collect the blocks. */
export function liftFences(markdown: string): LiftedMarkdown {
  const fences: Fence[] = [];
  let lastHeading: string | null = null;
  const lines = markdown.split("\n");
  const headingAt: Array<string | null> = [];
  for (const line of lines) {
    const h = /^###\s+(.+?)\s*$/.exec(line);
    if (h !== null) lastHeading = h[1];
    headingAt.push(lastHeading);
  }
  const lineOfOffset = (offset: number): number => markdown.slice(0, offset).split("\n").length - 1;
  /* what the output copies from the input, for positions (feature-specs/33 § 4.1) */
  let runs: Run[] = [];
  let copied = 0;
  let written = 0;

  const out = markdown.replace(FENCE_RE, (match, lang: string, body: string, offset: number) => {
    const index = fences.length;
    const endLine = lineOfOffset(offset + match.length);
    let caption: string | null = null;
    for (let i = endLine + 1; i < Math.min(lines.length, endLine + 4); i += 1) {
      const candidate = lines[i].trim();
      if (candidate.length === 0) continue;
      if (/^\*[^*].*\*$/.test(candidate)) caption = candidate.replace(/^\*|\*$/g, "").trim();
      break;
    }
    fences.push({ index, lang: lang.toLowerCase(), text: body.replace(/\n$/, ""), caption, heading: headingAt[lineOfOffset(offset)] ?? null });
    const placeholder = `\n${FENCE_PLACEHOLDER(index)}\n`;
    runs.push({ out: written, src: copied, length: offset - copied });
    written += offset - copied + placeholder.length;
    copied = offset + match.length;
    return placeholder;
  });
  runs.push({ out: written, src: copied, length: markdown.length - copied });
  /* the caption line becomes the figure's <figcaption>; it is not also a paragraph */
  let markdownOut = out;
  for (const fence of fences) {
    if (fence.caption === null) continue;
    const escaped = fence.caption.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    markdownOut = markdownOut.replace(new RegExp(`(${FENCE_PLACEHOLDER(fence.index)}\\n)\\s*\\*${escaped}\\*[ \\t]*(?:\\n|$)`), (match: string, kept: string, at: number) => {
      runs = cut(runs, at + kept.length, match.length - kept.length);
      return kept;
    });
  }
  const origin = (offset: number): number => {
    const run = runs.find((r) => offset >= r.out && offset < r.out + r.length);
    return run === undefined ? -1 : run.src + (offset - run.out);
  };
  return { markdown: markdownOut, fences, origin };
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const NUMERIC_CELL = /^\s*[-+]?[\d,.]+\s?(%|×|x|ms|s|d|GB|KB|MB|TB|K|M|B|pp|h|min)?\s*$/;

/** A token whose HTML is text from the source: plain text, an escaped character, inline code, raw HTML (escaped here), an image's alt text. */
export type ProseLeaf = Tokens.Text | Tokens.Escape | Tokens.Codespan | Tokens.HTML | Tokens.Tag | Tokens.Image;

/**
 * The reader-vocabulary renderer. `leaf` is given each leaf's HTML and returns what to emit: the HTML itself for the
 * build, the HTML between markers when positions are asked for (sourceMap.ts).
 */
export function proseMarked(leaf: (token: ProseLeaf, html: string) => string = (_token, html) => html): Marked {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      heading({ tokens }: Tokens.Heading) {
        return `<h3>${this.parser.parseInline(tokens)}</h3>\n`;
      },
      paragraph({ tokens }: Tokens.Paragraph) {
        return `<p>${this.parser.parseInline(tokens)}</p>\n`;
      },
      text(token: Tokens.Text | Tokens.Escape) {
        /* a block's text holds inline tokens, which are the leaves */
        return "tokens" in token && token.tokens !== undefined ? this.parser.parseInline(token.tokens) : leaf(token, Renderer.prototype.text.call(this, token));
      },
      codespan(token: Tokens.Codespan) {
        return leaf(token, Renderer.prototype.codespan.call(this, token));
      },
      html(token: Tokens.HTML | Tokens.Tag) {
        return leaf(token, escapeHtml(token.text));
      },
      hr() {
        return "";
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        return `<p><em>${this.parser.parse(tokens).replace(/<\/?p>/g, "").trim()}</em></p>\n`;
      },
      code({ text }: Tokens.Code) {
        /* Indented code (no fence) is rare in the book; render it as a plain code pane. */
        return `<div class="code"><div class="code-b">${text
          .split("\n")
          .map((l, i) => `<span class="ln" data-n="${i + 1}">${escapeHtml(l)}</span>`)
          .join("")}</div></div>\n`;
      },
      table({ header, rows }: Tokens.Table) {
        const th = header.map((cell) => `<th>${this.parser.parseInline(cell.tokens)}</th>`).join("");
        const body = rows
          .map((row) => `<tr>${row.map((cell) => `<td${NUMERIC_CELL.test(cell.text) ? ' class="n"' : ""}>${this.parser.parseInline(cell.tokens)}</td>`).join("")}</tr>`)
          .join("\n");
        return `<table class="tbl"><thead><tr>${th}</tr></thead><tbody>\n${body}\n</tbody></table>\n`;
      },
      link({ href, tokens }: Tokens.Link) {
        return `<a class="src" href="${escapeHtml(href)}">${this.parser.parseInline(tokens)}</a>`;
      },
      image(token: Tokens.Image) {
        return leaf(token, escapeHtml(token.text));
      },
      del({ tokens }: Tokens.Del) {
        return this.parser.parseInline(tokens);
      },
      checkbox() {
        return "";
      },
    },
  });
  return marked;
}

const MARKED = proseMarked();

/** Render prose markdown (fences already lifted) to the reader vocabulary. */
export function renderProse(markdown: string): string {
  const html = MARKED.parse(markdown, { async: false }) as string;
  return finishProse(html);
}

/** What renderProse does to marked's output: blank lines collapsed, the ends trimmed. */
export function finishProse(html: string): string {
  return html.replace(/\n{2,}/g, "\n").trim();
}

/**
 * A layer or README as plain prose for the search index (feature-specs/06 § 4.3):
 * fences dropped, headings and list markers stripped, table pipes turned into
 * separators, inline marks and links reduced to their text. Stored raw (not
 * escaped) so the index sees words, not entities; the search loader escapes
 * the headline it renders.
 */
export function plainProse(markdown: string): string {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, " ");
  const lines = withoutFences.split(/\r?\n/).map((line) => {
    if (/^\s*\|?\s*:?-{2,}/.test(line)) return "";
    return line
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .replace(/\s*\|\s*/g, " · ");
  });
  const text = lines.join("\n").replace(/\n{2,}/g, "\n");
  return plainText(text).replace(/\s*\n\s*/g, " ");
}

/** The first `#` heading of a markdown file, without a `Lab NN —` prefix; empty when there is none. */
export function firstHeading(markdown: string): string {
  const heading = /^#\s+(.+?)\s*$/m.exec(markdown)?.[1] ?? "";
  return plainText(heading.replace(/^Lab\s+\d{2}\s*[—–-]+\s*/i, ""));
}

/** Plain text of a markdown fragment: emphasis and code marks dropped, links reduced to their text. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
