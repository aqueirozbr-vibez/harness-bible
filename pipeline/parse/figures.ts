import type { SourceTier } from "@/lib/schemas/domain";

import { escapeHtml } from "./markdown";
import { CITE_SOURCE, MATH_SOURCE, NUM_SOURCE, SECTION_REF_SOURCE, SKIP_SOURCE } from "./patterns";

export { CITE_SOURCE, MATH_SOURCE, NUM_SOURCE, SECTION_REF_SOURCE, SKIP_SOURCE } from "./patterns";

/*
 * The provenance grammar (feature-specs/04 § 6.3, spec 03 D2), built on the
 * book linter's two regular expressions. It runs on rendered paragraph HTML:
 * text segments only, never inside tags, chips or links.
 *
 * Rules, per paragraph:
 *  - a tier parenthetical is one that matches CITE; its tier words are read in order;
 *  - a number takes the tier of the nearest parenthetical after it in the same
 *    sentence, else the nearest before it in the sentence, else the paragraph's
 *    last parenthetical, else the section default set by a declaration
 *    paragraph such as "All figures from `derive.py` (derived).";
 *  - a parenthetical with several tier words gives its last tier to the number
 *    just before it and its first tier to the others in the sentence;
 *  - DERIVED numbers are matched to derived.json; an unmatched one becomes OPEN
 *    and is reported, never silently linked.
 */

const TIER_WORD_RE = /\b(illustrative|vendor|primary|analyst|derived|open|practitioner|scenario)\b/gi;
/** Longer parentheticals are prose that happens to name a tier; they are not rewritten. */
const CHIP_MAX_LENGTH = 120;

export type FigureTier = SourceTier;

export interface TierTag {
  readonly tier: FigureTier;
  readonly scenario: boolean;
}

export interface DerivedValue {
  readonly key: string;
  readonly value: number;
}

export interface DeriveSource {
  readonly labId: string;
  readonly values: ReadonlyArray<DerivedValue>;
  /** Line number (1-based) of the assignment for a key in derive.py; null when unresolved. */
  readonly lineOf: (key: string) => number | null;
  readonly expressionOf: (key: string) => string | null;
}

export interface SourceRowRef {
  readonly id: string;
  readonly ordinal: number;
  readonly tokens: ReadonlyArray<string>;
}

export interface FigureLabels {
  readonly abbr: Record<FigureTier, string>;
  readonly label: Record<FigureTier, string>;
  readonly scenario: string;
  readonly deriveTitle: (line: number) => string;
  readonly deriveHref: (labId: string, line: number) => string;
}

export interface ExtractedFigure {
  readonly id: string;
  readonly ordinal: number;
  readonly label: string;
  readonly valueText: string;
  readonly value: number | null;
  readonly unit: string | null;
  readonly tier: FigureTier;
  readonly scenarioParam: boolean;
  readonly sourceRowId: string | null;
  readonly derive: { readonly labId: string; readonly filePath: string; readonly line: number; readonly key: string; readonly expression: string } | null;
}

export interface FigurePassResult {
  readonly html: string;
  readonly figures: ReadonlyArray<ExtractedFigure>;
  /** Where each figure's printed value sits in the paragraph's HTML given, in the order of `figures` (feature-specs/33 § 4.1). */
  readonly spans: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  /** Chapters named inside tier parentheticals ("(scenario, ch16)"); the chip keeps them as text. */
  readonly refs: ReadonlyArray<{ readonly targetKind: "chapter"; readonly targetId: string }>;
  readonly unlinked: ReadonlyArray<{ readonly label: string; readonly valueText: string; readonly candidates: ReadonlyArray<string> }>;
  readonly unmatchedSources: ReadonlyArray<string>;
  readonly untieredNumbers: number;
}

export interface FigurePassContext {
  readonly chapter: number;
  readonly startOrdinal: number;
  readonly sectionDefault: TierTag | null;
  readonly derive: DeriveSource | null;
  readonly sourceRows: ReadonlyArray<SourceRowRef>;
  readonly labels: FigureLabels;
}

const TIER_OF_WORD: Record<string, FigureTier> = {
  illustrative: "ILLUSTRATIVE",
  vendor: "VENDOR",
  primary: "PRIMARY",
  analyst: "ANALYST",
  derived: "DERIVED",
  open: "OPEN",
  practitioner: "PRACTITIONER",
  scenario: "ILLUSTRATIVE",
};

const CITED: ReadonlySet<FigureTier> = new Set(["PRIMARY", "VENDOR", "ANALYST", "PRACTITIONER"]);

/** Tier words of a parenthetical, in order; a bare year counts as primary. */
export function tiersOf(parenthetical: string): ReadonlyArray<TierTag> {
  const words = [...parenthetical.matchAll(TIER_WORD_RE)].map((m) => m[1].toLowerCase());
  if (words.length === 0) return /\d{4}/.test(parenthetical) ? [{ tier: "PRIMARY", scenario: false }] : [];
  return words.map((w) => ({ tier: TIER_OF_WORD[w], scenario: w === "scenario" }));
}

/** A paragraph that only declares a tier ("All figures from `derive.py` (derived).") sets the section default. */
export function declaredDefault(paragraphText: string): TierTag | null {
  const cite = new RegExp(CITE_SOURCE, "i").exec(paragraphText);
  if (cite === null) return null;
  const withoutCite = paragraphText.replace(cite[0], "");
  if (new RegExp(NUM_SOURCE).test(withoutCite)) return null;
  if (!/^all figures/i.test(paragraphText.trim())) return null;
  const tiers = tiersOf(cite[0]);
  return tiers.length === 0 ? null : tiers[tiers.length - 1];
}

/** `0.4%` → 0.4 / `%`; `1 s` → 1 / `s`; `2,000` → 2000; `$0.30` → 0.30 / `USD`. */
export function parseValue(token: string): { value: number | null; unit: string | null } {
  const t = token.trim();
  const currency = /^\$?\s*([\d,]*\.?\d+)\s*(USD|\$)?$/.exec(t);
  if (t.startsWith("$") || /USD|\$$/.test(t)) {
    const n = currency === null ? null : Number(currency[1].replace(/,/g, ""));
    return { value: n !== null && Number.isFinite(n) ? n : null, unit: "USD" };
  }
  const m = /^([\d,]*\.?\d+)\s?(%|×|x|ms|s|GB|KB|MB|TB|K|M|B|pp|tokens?)?$/.exec(t);
  if (m === null) return { value: null, unit: null };
  const n = Number(m[1].replace(/,/g, ""));
  return { value: Number.isFinite(n) ? n : null, unit: m[2] ?? null };
}

function blank(text: string, re: RegExp): string {
  return text.replace(re, (m) => " ".repeat(m.length));
}

/** Text with every tag and entity (`&#39;`) replaced by spaces of the same length; positions are preserved. */
function maskTags(html: string): string {
  return blank(blank(html, /<[^>]*>/g), /&#?\w+;/g);
}

/** Positions of the text that are inside a chip, derive link or xref, so numbers there are left alone. */
function maskProtectedSpans(html: string, masked: string): string {
  let out = masked;
  const re = /<(span|a)\b[^>]*class="(?:chip|derive|xref|src|fig-[a-z]+)[^"]*"[^>]*>[\s\S]*?<\/\1>/g;
  for (const m of html.matchAll(re)) {
    const start = m.index ?? 0;
    out = out.slice(0, start) + " ".repeat(m[0].length) + out.slice(start + m[0].length);
  }
  return out;
}

function sentenceBounds(text: string, at: number): { readonly from: number; readonly to: number } {
  const boundaries = [...text.matchAll(/[.!?;:]\s/g)].map((m) => (m.index ?? 0) + 1);
  let from = 0;
  let to = text.length;
  for (const b of boundaries) {
    if (b <= at) from = b;
    else {
      to = b;
      break;
    }
  }
  return { from, to };
}

function labelAround(text: string, start: number, end: number): { readonly label: string; readonly extendTo: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const beforeClause = before.split(/[.;:,(]/).pop() ?? "";
  const beforeWords = beforeClause.trim().split(/\s+/).filter((w) => w.length > 0);
  const afterClause = (after.split(/[.;:,)]/)[0] ?? "").trim();
  const afterWords = afterClause.split(/\s+/).filter((w) => w.length > 0 && !/^\d/.test(w));
  const numberStartsPhrase = beforeWords.length === 0;
  const words = numberStartsPhrase ? afterWords.slice(0, 6) : beforeWords.slice(-6);
  let extendTo = end;
  if (numberStartsPhrase && afterWords.length > 0) {
    const m = /^\s*((?:[^\s.;:,)]+\s*){1,6}?)(?=[.;:,)]|\s\d|$)/.exec(after);
    if (m !== null) extendTo = end + m[0].length;
  }
  const label = words.join(" ").toLowerCase().replace(/[*_`]/g, "").trim();
  return { label: label.length > 0 ? label : "figure", extendTo };
}

/**
 * Match a printed number to derived.json. A printed value is precise to half its
 * last digit ("45%" covers 44.5–45.5; "75,000" covers 74,500–75,500), so 0.455
 * matches 45% and 75075 matches 75,000. Ties go to the closest value, then to a
 * key sharing a word with the label, then with the paragraph.
 */
function matchDerived(token: string, value: number | null, unit: string | null, label: string, paragraph: string, derive: DeriveSource): { key: string | null; candidates: string[] } {
  if (value === null) return { key: null, candidates: [] };
  const digits = token.replace(/[^\d.]/g, "");
  const fraction = digits.split(".")[1]?.length ?? 0;
  const trailingZeros = fraction > 0 || value < 1000 ? 0 : (/0+$/.exec(digits)?.[0].length ?? 0);
  const tolerance = 0.5 * 10 ** (trailingZeros - fraction) + Math.abs(value) * 1e-6;
  /* a percentage matches a fraction (0.455 ↔ 45%), or a raw value only when the key says it is a percentage */
  const distance = (c: DerivedValue): number => {
    if (unit === "%") return Math.min(Math.abs(value - c.value * 100), /pct|percent/i.test(c.key) ? Math.abs(value - c.value) : Infinity);
    const scaled = unit === "K" ? c.value / 1000 : unit === "M" ? c.value / 1e6 : c.value;
    return Math.min(Math.abs(value - c.value), Math.abs(value - scaled));
  };
  const candidates = derive.values.filter((c) => distance(c) <= tolerance);
  if (candidates.length === 0) return { key: null, candidates: [] };
  const keys = candidates.map((c) => c.key);
  if (candidates.length === 1) return { key: keys[0], candidates: keys };
  const best = Math.min(...candidates.map(distance));
  const closest = candidates.filter((c) => distance(c) <= best + Math.abs(value) * 1e-9);
  if (closest.length === 1) return { key: closest[0].key, candidates: keys };
  const wordsOf = (text: string) => new Set(text.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const prefer = (words: ReadonlySet<string>) => closest.find((c) => c.key.split(/[_\W]+/).some((w) => w.length > 2 && words.has(w.toLowerCase())));
  const preferred = prefer(wordsOf(label)) ?? prefer(wordsOf(paragraph));
  return { key: preferred?.key ?? null, candidates: keys };
}

/** A number that appears as a parameter inside a derived key's name: `f0.05` for 5%, `2pct` for 2%, `13calls` for 13. */
export function isParameter(value: number | null, unit: string | null, derive: DeriveSource): boolean {
  if (value === null) return false;
  const forms = unit === "%" ? [String(value / 100), `${value}pct`, `${value}percent`] : [String(value)];
  return derive.values.some(({ key }) => forms.some((f) => new RegExp(`(^|[_a-z])${f.replace(".", "\\.")}(?=$|[_a-z])`, "i").test(key)));
}

function sourceRowFor(parenthetical: string, rows: ReadonlyArray<SourceRowRef>): SourceRowRef | null {
  const lower = parenthetical.toLowerCase();
  return rows.find((row) => row.tokens.some((t) => lower.includes(t))) ?? null;
}

function chipHtml(tag: TierTag, locator: string | null, labels: FigureLabels): string {
  const tier = tag.tier;
  const cls = { PRIMARY: "t-pri", VENDOR: "t-ven", ANALYST: "t-anl", PRACTITIONER: "t-pra", ILLUSTRATIVE: "t-ill", DERIVED: "t-der", OPEN: "t-opn" }[tier];
  const word = tag.scenario ? labels.scenario : labels.label[tier];
  const text = locator === null ? word : `${word} · ${locator}`;
  return `<span class="chip ${cls}"><i>${escapeHtml(labels.abbr[tier])}</i> ${escapeHtml(text)}</span>`;
}

interface Cite {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly tiers: ReadonlyArray<TierTag>;
  readonly row: SourceRowRef | null;
}

/**
 * Run the grammar over one paragraph's inner HTML. Returns the rewritten HTML
 * and the figures it found. `ctx.startOrdinal` numbers figures across the chapter.
 */
export function figurePass(paragraphHtml: string, ctx: FigurePassContext): FigurePassResult {
  const html = paragraphHtml;
  const textOnly = maskProtectedSpans(html, maskTags(html));
  const cites: Cite[] = [...textOnly.matchAll(new RegExp(CITE_SOURCE, "gi"))].map((m) => {
    const text = html.slice(m.index ?? 0, (m.index ?? 0) + m[0].length);
    return { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, text, tiers: tiersOf(text), row: sourceRowFor(text, ctx.sourceRows) };
  }).filter((c) => c.tiers.length > 0);

  let numberText = textOnly;
  for (const c of cites) numberText = numberText.slice(0, c.start) + " ".repeat(c.end - c.start) + numberText.slice(c.end);
  numberText = blank(numberText, new RegExp(SKIP_SOURCE, "g"));
  numberText = blank(numberText, new RegExp(SECTION_REF_SOURCE, "g"));
  numberText = blank(numberText, new RegExp(MATH_SOURCE, "g"));

  /* NUM keeps a trailing comma ("1, 2, 4"); the figure is the digits before it */
  const numbers = [...numberText.matchAll(new RegExp(NUM_SOURCE, "g"))].map((m) => {
    const token = m[0].trimEnd().replace(/,+$/, "");
    return { start: m.index ?? 0, end: (m.index ?? 0) + token.length, token };
  });

  const figures: ExtractedFigure[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const unlinked: Array<{ label: string; valueText: string; candidates: ReadonlyArray<string> }> = [];
  const unmatchedSources = new Set<string>();
  let untiered = 0;
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const deriveChipsAfter = new Map<number, string>(); // number end → chip html
  let ordinal = ctx.startOrdinal;

  const tierForNumber = (pos: number): { tag: TierTag; cite: Cite | null } | null => {
    const { from, to } = sentenceBounds(textOnly, pos);
    const inSentence = cites.filter((c) => c.start >= from && c.start < to);
    const following = inSentence.find((c) => c.start > pos);
    const preceding = [...inSentence].reverse().find((c) => c.end <= pos);
    const chosen = following ?? preceding ?? null;
    if (chosen !== null) {
      const numbersBefore = numbers.filter((n) => n.start >= from && n.start < chosen.start);
      const isLastBefore = numbersBefore.length > 0 && numbersBefore[numbersBefore.length - 1].start === pos;
      const tag = chosen.tiers.length > 1 && chosen === following ? (isLastBefore ? chosen.tiers[chosen.tiers.length - 1] : chosen.tiers[0]) : chosen.tiers[chosen.tiers.length - 1];
      return { tag, cite: chosen };
    }
    /* no parenthetical in the sentence: the section's declaration wins over the paragraph's last parenthetical */
    if (ctx.sectionDefault !== null) return { tag: ctx.sectionDefault, cite: null };
    if (cites.length > 0) {
      const last = cites[cites.length - 1];
      return { tag: last.tiers[last.tiers.length - 1], cite: last };
    }
    return null;
  };

  for (const n of numbers) {
    const resolved = tierForNumber(n.start);
    if (resolved === null) {
      untiered += 1;
      continue;
    }
    const { tag, cite } = resolved;
    const { label, extendTo } = labelAround(textOnly, n.start, n.end);
    const { value, unit } = parseValue(n.token);
    const id = `F-${String(ctx.chapter).padStart(2, "0")}-${String(ordinal).padStart(2, "0")}`;
    let tier = tag.tier;
    let scenario = tag.scenario;
    let derive: ExtractedFigure["derive"] = null;
    if (tier === "DERIVED") {
      const match = ctx.derive === null ? { key: null, candidates: [] } : matchDerived(n.token, value, unit, label, textOnly, ctx.derive);
      const line = match.key === null || ctx.derive === null ? null : ctx.derive.lineOf(match.key);
      if (match.key !== null && line !== null && ctx.derive !== null) {
        derive = { labId: ctx.derive.labId, filePath: "derive.py", line, key: match.key, expression: ctx.derive.expressionOf(match.key) ?? "" };
      } else if (ctx.derive !== null && cite === null && isParameter(value, unit, ctx.derive)) {
        /* "at 5%" under a derived declaration: an input derive.py names in a key (f0.05, 2pct), not an output */
        tier = "ILLUSTRATIVE";
        scenario = true;
      } else {
        /* "(illustrative rate; arithmetic derived)": a number the lab does not produce keeps the parenthetical's other tier */
        const fallback = cite?.tiers.find((t) => t.tier !== "DERIVED") ?? null;
        if (fallback !== null) {
          tier = fallback.tier;
          scenario = fallback.scenario;
        } else {
          tier = "OPEN";
          unlinked.push({ label, valueText: n.token, candidates: match.candidates });
        }
      }
    }
    const sourceRowId = cite?.row?.id ?? null;
    figures.push({ id, ordinal, label, valueText: n.token, value, unit, tier, scenarioParam: scenario, sourceRowId, derive });
    spans.push({ start: n.start, end: n.end });
    ordinal += 1;

    const wrapEnd = tier === "DERIVED" || tier === "ILLUSTRATIVE" || tier === "OPEN" ? extendTo : n.end;
    const cls = tier === "DERIVED" ? ' class="fig-der"' : tier === "ILLUSTRATIVE" ? ' class="fig-ill"' : "";
    const inner = html.slice(n.start, wrapEnd);
    let replacement = `<span${cls} data-figure="${id}">${inner}</span>`;
    if (derive !== null) {
      replacement += ` <a class="derive" href="${ctx.labels.deriveHref(derive.labId, derive.line)}" data-figure="${id}" data-line="${derive.line}" title="${escapeHtml(ctx.labels.deriveTitle(derive.line))}">ƒ L${derive.line}</a>`;
    } else if (tier === "OPEN" && tag.tier === "DERIVED") {
      replacement += ` ${chipHtml({ tier: "OPEN", scenario: false }, null, ctx.labels)}`;
    }
    edits.push({ start: n.start, end: wrapEnd, replacement });
    if (cite !== null && (tag.tier === "DERIVED" || tag.tier === "ILLUSTRATIVE")) deriveChipsAfter.set(cite.start, "");
  }

  const refs = new Map<string, { targetKind: "chapter"; targetId: string }>();
  for (const c of cites) {
    const lastTier = c.tiers[c.tiers.length - 1];
    const derivedOnly = c.tiers.every((t) => t.tier === "DERIVED");
    const chapterRefs = [...c.text.matchAll(/\bch(\d{2})\b/g)].map((m) => `ch${m[1]}`);
    for (const id of chapterRefs) refs.set(id, { targetKind: "chapter", targetId: id });
    if (derivedOnly && deriveChipsAfter.has(c.start)) {
      /* the parenthetical is replaced by the derive links already placed after each figure */
      edits.push({ start: c.start, end: c.end, replacement: "" });
      continue;
    }
    if (CITED.has(lastTier.tier) && c.row === null) unmatchedSources.add(c.text);
    /* a parenthetical that is itself prose (sentences, or long) keeps its text; only a tag becomes a chip */
    if (c.text.length > CHIP_MAX_LENGTH || /\.\s+[A-Z]/.test(c.text)) continue;
    /* locator: the chapters the author named, else the matched source row, else a reference-like remainder */
    let locator: string | null = chapterRefs.length > 0 ? chapterRefs.join(", ") : c.row === null ? null : c.row.id;
    if (locator === null) {
      const rest = c.text.slice(1, -1).replace(TIER_WORD_RE, "").replace(/verified\s+[A-Za-z]+\s+\d{4}/i, "").replace(/[,;\s]+/g, " ").trim();
      locator = rest.length > 0 && rest.length <= 40 && /[A-Z0-9]/.test(rest) ? rest : null;
    }
    edits.push({ start: c.start, end: c.end, replacement: chipHtml(lastTier, locator, ctx.labels) });
  }

  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    if (e.start < cursor) continue; // overlapping edit (a number inside a wrapped phrase); the first wins
    out += html.slice(cursor, e.start) + e.replacement;
    cursor = e.end;
  }
  out += html.slice(cursor);
  out = out.replace(/\s+([.,;:])/g, "$1").replace(/  +/g, " ");

  return { html: out, figures, spans, refs: [...refs.values()], unlinked, unmatchedSources: [...unmatchedSources], untieredNumbers: untiered };
}

/** Tokens of a source row's citation that identify it in a parenthetical: capitalised or long distinctive words. */
export function sourceTokens(citation: string): ReadonlyArray<string> {
  const stop = new Set(["documentation", "docs", "book", "blog", "guide", "report", "paper", "the", "and", "for", "with", "official", "page", "note", "notes", "post", "posts", "api", "specification", "spec"]);
  return citation
    .replace(/[`"“”(),.;:]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 5 && !stop.has(w.toLowerCase()) && /^[A-Za-z][\w-]*$/.test(w))
    .map((w) => w.toLowerCase());
}
