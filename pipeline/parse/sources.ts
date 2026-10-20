import type { SourceTier } from "@/lib/schemas/domain";

import { ParseError } from "./chapterFile";
import { plainText } from "./markdown";
import type { Span } from "./sourceMap";

/*
 * Layer 9's table → source rows (feature-specs/04 § 6.4; links per feature-specs/10 § 4–5).
 *   | # | Claim or figure | Source | Tier | Verified | Link |
 * The sixth column is the book's link cell (a bare URL, `—` for none, a repository
 * path on derived rows); a markdown link, bare URL or DOI in the Source cell is the
 * fallback. Only http(s) targets pass; any other scheme fails the chapter.
 */

export interface ParsedSourceRow {
  readonly ordinal: number;
  readonly claim: string;
  readonly citation: string;
  readonly url: string | null;
  readonly doi: string | null;
  readonly tier: SourceTier;
  readonly tierText: string;
  readonly verifiedText: string;
  readonly verifiedAt: Date;
  readonly fastMoving: boolean;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** D6: a claim or citation about a price, deadline, model version or benchmark moves fast. */
const FAST_MOVING_RE = /\b(price|prices|pricing|per M tokens|per million tokens|deadline|applies from|annex|in force|benchmark|leaderboard|model version|GPT-\d|Claude \d|Gemini \d|o\d-|SWE-bench|τ-bench|tau-bench|AgentDojo|RouteLLM|GAIA)\b|\$\s?\d/i;

const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/;
const BARE_URL_RE = /https?:\/\/\S+/i;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s|)\]]+)/;
const DOI_URL_RE = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/.+)$/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
/** An empty link cell: nothing, or a dash. */
const NONE_CELL_RE = /^[—–-]?$/;

export function tierFromCell(cell: string): SourceTier {
  const t = cell.toLowerCase();
  if (t.includes("derived")) return "DERIVED";
  if (t.includes("illustrative") || t.includes("scenario")) return "ILLUSTRATIVE";
  if (t.includes("primary")) return "PRIMARY";
  if (t.includes("vendor")) return "VENDOR";
  if (t.includes("analyst")) return "ANALYST";
  if (t.includes("practitioner")) return "PRACTITIONER";
  return "OPEN";
}

/** `Sep 2026` → the registry's verify date when given, else the first of that month (UTC). */
export function verifiedDate(cell: string, registryDate: Date | null): Date {
  if (registryDate !== null) return registryDate;
  const m = /([A-Za-z]{3,})\.?\s+(\d{4})/.exec(cell);
  if (m === null) return registryDate ?? new Date(Date.UTC(1970, 0, 1));
  const month = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()] ?? 1;
  return new Date(Date.UTC(Number(m[2]), month - 1, 1));
}

/** A row's cells, trimmed, outer pipes dropped, with where each sits (`from` is the line's offset). */
function splitRow(line: string, from: number): { readonly cells: ReadonlyArray<string>; readonly spans: ReadonlyArray<Span> } {
  const body = line.trim();
  let start = line.length - line.trimStart().length;
  let end = start + body.length;
  if (body.startsWith("|")) start += 1;
  if (end > start && line[end - 1] === "|") end -= 1;
  const cells: string[] = [];
  const spans: Span[] = [];
  let at = start;
  for (const piece of line.slice(start, end).split("|")) {
    const cell = piece.trim();
    const cellFrom = at + piece.length - piece.trimStart().length;
    cells.push(cell);
    spans.push({ from: from + cellFrom, to: from + cellFrom + cell.length });
    at += piece.length + 1;
  }
  return { cells, spans };
}

/** The lines of `markdown` as `split(/\r?\n/)` gives them, with where each starts. */
function linesOf(markdown: string): ReadonlyArray<{ readonly text: string; readonly from: number }> {
  const lines: Array<{ text: string; from: number }> = [];
  let from = 0;
  for (const m of markdown.matchAll(/\r?\n/g)) {
    lines.push({ text: markdown.slice(from, m.index), from });
    from = m.index + m[0].length;
  }
  lines.push({ text: markdown.slice(from), from });
  return lines;
}

interface TableRow {
  readonly ordinal: number;
  readonly cells: ReadonlyArray<string>;
  readonly line: Span;
  readonly spans: ReadonlyArray<Span>;
}

/** The table's numbered rows after its `| # | Claim` header, with where each line and cell sits in `markdown`: the one walk both readers below use. */
function tableRows(markdown: string): ReadonlyArray<TableRow> {
  const lines = linesOf(markdown).filter((l) => l.text.trim().startsWith("|"));
  const headerIndex = lines.findIndex((l) => /\|\s*#\s*\|\s*Claim/i.test(l.text));
  if (headerIndex < 0) return [];
  const rows: TableRow[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const { cells, spans } = splitRow(line.text, line.from);
    if (cells.length < 5 || !/^\d+$/.test(cells[0])) continue;
    rows.push({ ordinal: Number(cells[0]), cells, line: { from: line.from, to: line.from + line.text.length }, spans });
  }
  return rows;
}

/** Punctuation a sentence leaves after a bare URL (`(https://x.y/z).`). */
const trimBareUrl = (token: string): string => token.replace(/[).,;\]]+$/, "");

/** The target parsed and restricted to http(s); anything else is a parse error naming the row. */
function validated(target: string, where: string, chapter: number | null): string {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new ParseError(chapter, `${where}: source link is not a valid URL: "${target}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ParseError(chapter, `${where}: source link must be http(s), got "${parsed.protocol}"`);
  }
  return target;
}

/**
 * The row's link (10 § 4): the Link cell first (a bare or markdown-linked URL; a dash,
 * an empty cell or a repository path is no link), then the Source cell's markdown link or
 * bare URL. The DOI comes from a doi.org target or a `10.xxxx/…` token in either cell.
 */
export function extractLink(linkCell: string | null, sourceCell: string, where: string, chapter: number | null = null): { readonly url: string | null; readonly doi: string | null } {
  let url: string | null = null;
  const cell = (linkCell ?? "").trim();
  if (!NONE_CELL_RE.test(cell)) {
    const target = MD_LINK_RE.exec(cell)?.[2] ?? cell;
    if (/^https?:\/\//i.test(target)) url = validated(trimBareUrl(target), where, chapter);
    else if (/^doi:/i.test(target)) {
      /* `doi:10.…` is a DOI, read below, not a scheme */
    } else if (SCHEME_RE.test(target)) throw new ParseError(chapter, `${where}: source link must be http(s), got "${SCHEME_RE.exec(target)?.[0] ?? target}"`);
    /* a repository path (labs/ch21-control-plane/derive.py) or free text is not a link */
  }
  if (url === null) {
    const target = MD_LINK_RE.exec(sourceCell)?.[2] ?? BARE_URL_RE.exec(sourceCell)?.[0] ?? null;
    if (target !== null) url = validated(trimBareUrl(target), where, chapter);
  }
  const fromUrl = url === null ? null : (DOI_URL_RE.exec(url)?.[1] ?? null);
  const doi = fromUrl ?? DOI_RE.exec(`${cell} ${sourceCell}`)?.[1] ?? null;
  return { url, doi };
}

/** Parse the sources table of a layer's markdown. Rows that are not `| n | … |` are ignored. */
export function parseSourceRows(markdown: string, registryDate: Date | null, overrides: ReadonlyMap<number, boolean> = new Map(), chapter: number | null = null): ReadonlyArray<ParsedSourceRow> {
  const rows: ParsedSourceRow[] = [];
  for (const { ordinal, cells } of tableRows(markdown)) {
    const where = `${chapter === null ? "" : `${String(chapter).padStart(2, "0")}.9 `}r${ordinal}`;
    const { url, doi } = extractLink(cells[5] ?? null, cells[2], where, chapter);
    const claim = plainText(cells[1]);
    const citation = plainText(cells[2]);
    const fastMoving = overrides.get(ordinal) ?? FAST_MOVING_RE.test(`${claim} ${citation}`);
    rows.push({
      ordinal,
      claim,
      citation,
      url,
      doi,
      tier: tierFromCell(cells[3]),
      tierText: cells[3],
      verifiedText: cells[4],
      verifiedAt: verifiedDate(cells[4], registryDate),
      fastMoving,
    });
  }
  return rows;
}

/** Where each row parseSourceRows reads sits in the layer's markdown: its line, and each cell trimmed (feature-specs/33 § 4.1). */
export function sourceRowSpans(markdown: string): ReadonlyArray<{ readonly ordinal: number; readonly line: Span; readonly cells: ReadonlyArray<Span> }> {
  return tableRows(markdown).map(({ ordinal, line, spans }) => ({ ordinal, line, cells: spans }));
}
