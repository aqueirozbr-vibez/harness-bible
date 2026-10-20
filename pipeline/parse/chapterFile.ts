import type { Layer } from "@/lib/schemas/domain";

import { parseFrontmatter, type Frontmatter } from "./frontmatter";
import type { Span } from "./sourceMap";

/*
 * A chapter file → its nine layers (feature-specs/04 § 6.1).
 * Pure: takes the file name and text, returns structure or throws ParseError.
 */

export class ParseError extends Error {
  readonly chapter: number | null;
  constructor(chapter: number | null, message: string) {
    super(chapter === null ? message : `chapter ${String(chapter).padStart(2, "0")}: ${message}`);
    this.name = "ParseError";
    this.chapter = chapter;
  }
}

/** The linter's layer names, in order; the parser accepts the same titles case-insensitively. */
export const LAYER_TITLES: ReadonlyArray<{ layer: Layer; titles: ReadonlyArray<string> }> = [
  { layer: "INTUITION", titles: ["Intuition"] },
  { layer: "MECHANISM", titles: ["Mechanism"] },
  { layer: "WORKED_NUMBERS", titles: ["Worked numbers"] },
  { layer: "MEASUREMENT", titles: ["Measurement"] },
  { layer: "FAILURE", titles: ["Failure"] },
  { layer: "FRONTIER", titles: ["The frontier", "Frontier"] },
  { layer: "INDUSTRIAL_APPLICATION", titles: ["Industrial application"] },
  { layer: "DECISION_AIDS", titles: ["Decision aids"] },
  { layer: "SOURCES", titles: ["Sources"] },
];

export interface ParsedLayer {
  readonly ordinal: number;
  readonly layer: Layer;
  readonly title: string;
  /** Markdown of the layer, without its `## NN.k` heading. */
  readonly markdown: string;
  /** Where the `## NN.k` line sits in the file; null in a prose-only chapter, which has none (feature-specs/33 § 4.1). */
  readonly heading: Span | null;
  /** Where `markdown` sits in the file; null for a layer the file does not hold (a prose-only chapter's Sources). */
  readonly body: Span | null;
}

/** Where the trimmed text of `text.slice(from, to)` sits; an empty one at `from`. */
function trimmedSpan(text: string, from: number, to: number): Span {
  const raw = text.slice(from, to);
  const trimmed = raw.trim();
  const start = trimmed.length === 0 ? from : from + raw.length - raw.trimStart().length;
  return { from: start, to: start + trimmed.length };
}

export interface ParsedChapter {
  readonly number: number;
  readonly slug: string;
  readonly title: string;
  readonly frontmatter: Frontmatter;
  readonly proseOnly: boolean;
  readonly layers: ReadonlyArray<ParsedLayer>;
}

const FILE_RE = /^ch(\d{2})-(.+)\.md$/;
const TITLE_RE = /^#\s+Chapter\s+(\d{2})\s+[—–-]+\s+(.+?)\s*$/m;
const LAYER_HEADING_RE = /^##\s+(\d{2})\.(\d)\s+(.+?)\s*$/gm;

function layerFor(title: string, ordinal: number): Layer | null {
  const entry = LAYER_TITLES[ordinal - 1];
  if (entry === undefined) return null;
  return entry.titles.some((t) => t.toLowerCase() === title.trim().toLowerCase()) ? entry.layer : null;
}

export function parseChapterFile(fileName: string, text: string): ParsedChapter {
  const file = FILE_RE.exec(fileName);
  if (file === null) throw new ParseError(null, `file name ${fileName} is not chNN-slug.md`);
  const number = Number(file[1]);
  const slug = file[2];

  const titleMatch = TITLE_RE.exec(text);
  if (titleMatch === null) throw new ParseError(number, "first line is not `# Chapter NN — Title`");
  if (Number(titleMatch[1]) !== number) throw new ParseError(number, `title says chapter ${titleMatch[1]}`);
  const title = titleMatch[2];

  const lines = text.split(/\r?\n/);
  const frontmatterLine = lines.find((l, i) => i > 0 && /^\*.*\*\s*$/.test(l.trim()));
  const frontmatter = parseFrontmatter(frontmatterLine ?? "");

  const headings = [...text.matchAll(LAYER_HEADING_RE)];
  if (headings.length === 0) {
    /* Part 0's prose-only chapter (spec § 11 D15): everything after the frontmatter is one Intuition section. */
    const start = frontmatterLine === undefined ? text.indexOf("\n") + 1 : text.indexOf(frontmatterLine) + frontmatterLine.length;
    const body = text.slice(start).trim();
    return {
      number,
      slug,
      title,
      frontmatter,
      proseOnly: true,
      layers: [
        { ordinal: 1, layer: "INTUITION", title: "Intuition", markdown: body, heading: null, body: trimmedSpan(text, start, text.length) },
        { ordinal: 9, layer: "SOURCES", title: "Sources", markdown: "", heading: null, body: null },
      ],
    };
  }

  const layers: ParsedLayer[] = [];
  headings.forEach((h, i) => {
    const chapterInHeading = Number(h[1]);
    const ordinal = Number(h[2]);
    const headingTitle = h[3];
    if (chapterInHeading !== number) throw new ParseError(number, `layer heading ${h[0].trim()} names another chapter`);
    const layer = layerFor(headingTitle, ordinal);
    if (layer === null) throw new ParseError(number, `layer ${ordinal} is titled "${headingTitle}", expected ${LAYER_TITLES[ordinal - 1]?.titles[0] ?? "?"}`);
    const at = h.index ?? 0;
    const from = at + h[0].length;
    const to = i + 1 < headings.length ? (headings[i + 1].index ?? text.length) : text.length;
    layers.push({ ordinal, layer, title: headingTitle.trim(), markdown: text.slice(from, to).trim(), heading: { from: at, to: at + h[0].trimEnd().length }, body: trimmedSpan(text, from, to) });
  });

  const ordinals = layers.map((l) => l.ordinal);
  for (let k = 1; k <= 9; k += 1) {
    if (ordinals[k - 1] !== k) {
      const missing = LAYER_TITLES[k - 1].titles[0];
      throw new ParseError(number, ordinals.includes(k) ? `layer ${k} ${missing} is out of order` : `missing layer heading: ${missing}`);
    }
  }
  if (layers.length !== 9) throw new ParseError(number, `${layers.length} layer headings, expected 9`);

  return { number, slug, title, frontmatter, proseOnly: false, layers };
}

/** First sentence of the Intuition layer (spec § 11 D16), or the chapter title when the layer is empty. */
export function standfirstOf(chapter: ParsedChapter): string {
  const intuition = chapter.layers.find((l) => l.layer === "INTUITION")?.markdown ?? "";
  const firstParagraph = intuition
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith("#") && !p.startsWith("|") && !p.startsWith("```"));
  if (firstParagraph === undefined) return chapter.title;
  const plain = firstParagraph.replace(/[*_`]/g, "").replace(/\s+/g, " ");
  const sentence = /^(.+?[.!?])(\s|$)/.exec(plain);
  return (sentence?.[1] ?? plain).trim();
}
