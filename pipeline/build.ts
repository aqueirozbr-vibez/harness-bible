import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bodyVocabularyViolations } from "@/lib/schemas/chapter";
import type { Layer, SourceTier } from "@/lib/schemas/domain";

import { parseChapterFile, ParseError, standfirstOf, type ParsedChapter } from "./parse/chapterFile";
import { parseChapterMap, type Carries } from "./parse/chapterMap";
import { renderCodePane, type CodeBlockView } from "./parse/code";
import { declaredDefault, figurePass, sourceTokens, type DeriveSource, type ExtractedFigure, type FigureLabels, type TierTag } from "./parse/figures";
import { deriveSource, listLabFolders, parseLab, type ParsedLab } from "./parse/lab";
import { FENCE_PLACEHOLDER, liftFences, plainProse, plainText, renderProse, type Fence } from "./parse/markdown";
import { figureHtml, type MermaidRenderer } from "./parse/mermaid";
import { registryStatus } from "./parse/registry";
import { proseOrigins, type Span } from "./parse/sourceMap";
import { parseSourceRows, sourceRowSpans, type ParsedSourceRow } from "./parse/sources";
import { nextVersion, subHeadingsOf, type PreviousVersion } from "./parse/versions";
import { countWords } from "./parse/wordCount";
import { xrefPass, type CrossRef } from "./parse/xrefs";
import { contentHash, withoutRunTimestamp } from "./renderHash";
import type { ChapterReport } from "./report";

/*
 * Assemble one chapter's rows from the book files (feature-specs/04 § 6).
 * Pure apart from file reads in loadBook(); the database is touched only by ingest.ts.
 */

export const EN_LABELS: FigureLabels = {
  abbr: { PRIMARY: "pri", VENDOR: "ven", ANALYST: "anl", PRACTITIONER: "pra", ILLUSTRATIVE: "ill", DERIVED: "ƒ", OPEN: "opn" },
  label: { PRIMARY: "primary", VENDOR: "vendor", ANALYST: "analyst", PRACTITIONER: "practitioner", ILLUSTRATIVE: "illustrative", DERIVED: "derived", OPEN: "open" },
  scenario: "scenario",
  deriveTitle: (line) => `derive.py line ${line}`,
  deriveHref: (labId, line) => `/en/labs/${labId}/derive.py#L${line}`,
};

const FIGURE_LABELS = { figure: "Figure", rendered: "mermaid · rendered", alt: "alt text available", notRendered: "diagram could not be rendered at ingestion" };

export interface BookFiles {
  readonly chapters: ReadonlyArray<{ readonly fileName: string; readonly text: string; readonly part: string }>;
  readonly registry: ReadonlyMap<number, { readonly verify: string | null; readonly redteam: string | null }>;
  readonly labs: ReadonlyMap<number, ParsedLab>;
  readonly carries: ReadonlyMap<number, Carries>;
  /** False when the book has no `CHAPTER-MAP.md`; `carries` is then empty and the frontmatter decides. */
  readonly chapterMap: boolean;
  readonly allFiles: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}

export function loadBook(bookDir: string): BookFiles {
  const bookRoot = join(bookDir, "book");
  const chapters: Array<{ fileName: string; text: string; part: string }> = [];
  const allFiles: Array<{ path: string; content: string }> = [];
  for (const part of readdirSync(bookRoot).filter((d) => /^part\d$/.test(d))) {
    for (const f of readdirSync(join(bookRoot, part)).filter((f) => /^ch\d{2}-.*\.md$/.test(f))) {
      const text = readFileSync(join(bookRoot, part, f), "utf8");
      chapters.push({ fileName: f, text, part });
      allFiles.push({ path: `book/${part}/${f}`, content: text });
    }
  }
  const registry = new Map<number, { verify: string | null; redteam: string | null }>();
  const registryDir = join(bookRoot, "registry");
  for (const f of readdirSync(registryDir)) {
    const content = readFileSync(join(registryDir, f), "utf8");
    allFiles.push({ path: `book/registry/${f}`, content });
    const m = /^ch(\d{2})(-verify|-redteam)?\.md$/.exec(f);
    if (m === null) continue;
    const n = Number(m[1]);
    const entry = registry.get(n) ?? { verify: null, redteam: null };
    if (m[2] === "-verify") entry.verify = content;
    if (m[2] === "-redteam") entry.redteam = content;
    registry.set(n, entry);
  }
  const labs = new Map<number, ParsedLab>();
  for (const [n, folder] of listLabFolders(join(bookDir, "labs"))) {
    const lab = parseLab(folder);
    labs.set(n, lab);
    for (const f of lab.files) allFiles.push({ path: `labs/${lab.folder}/${f.path}`, content: f.content });
  }
  /* the chapter map is optional (a 2026-09-23 book update lacked it); without it every chapter carries what its frontmatter says (the `??` in buildChapter) */
  const mapFile = join(bookRoot, "CHAPTER-MAP.md");
  const mapText = existsSync(mapFile) ? readFileSync(mapFile, "utf8") : null;
  if (mapText !== null) allFiles.push({ path: "book/CHAPTER-MAP.md", content: mapText });
  return { chapters: chapters.sort((a, b) => a.fileName.localeCompare(b.fileName)), registry, labs, carries: mapText === null ? new Map() : parseChapterMap(mapText), chapterMap: mapText !== null, allFiles };
}

export interface BuiltSection {
  readonly id: string;
  readonly layer: Layer;
  readonly ordinal: number;
  readonly titleEn: string;
  readonly markdownEn: string;
  readonly htmlEn: string;
  /** The linter's count over this layer alone (reading-time estimates). */
  readonly words: number;
  /** Chapter title and the layer's prose as escaped plain text (the search index, 06 D1/D3). */
  readonly textEn: string;
  readonly codeBlocks: ReadonlyArray<CodeBlockView>;
  readonly figures: ReadonlyArray<ExtractedFigure>;
  readonly xrefs: ReadonlyArray<CrossRef>;
  readonly mermaid: ReadonlyArray<{ readonly index: number; readonly definition: string; readonly figureId: string; readonly figureOrdinal: number; readonly fence: Fence }>;
}

export interface BuiltChapter {
  readonly number: number;
  readonly slug: string;
  readonly part: "P0" | "P1" | "P2" | "P3";
  readonly carries: Carries;
  readonly title: string;
  readonly standfirst: string;
  readonly version: string;
  readonly verifyStatus: "PASSED" | "UNVERIFIED";
  readonly redteamStatus: "PASSED" | "UNVERIFIED";
  readonly redteamOpen: number;
  readonly verifiedAt: Date | null;
  readonly words: number;
  readonly derivedLinked: number;
  readonly derivedTotal: number;
  readonly citedTotal: number;
  readonly citedFastMoving: number;
  readonly sections: ReadonlyArray<BuiltSection>;
  readonly sourceRows: ReadonlyArray<ParsedSourceRow>;
  readonly lab: ParsedLab | null;
  readonly contentHash: string;
  readonly report: ChapterReport;
  /** Where the rows sit in the file, when the build was asked for positions; null otherwise. */
  readonly positions: ChapterPositions | null;
}

/**
 * Where a chapter's rows sit in its file, as offsets into the text the build read (feature-specs/33 § 4.1): what a
 * proposal's edit locates its anchor by. Kept beside the rows, never in them, since the rows feed the content hash.
 */
export interface ChapterPositions {
  /** Each section's `## NN.k` line and its markdown; null where the file has none (a prose-only chapter). */
  readonly sections: ReadonlyArray<{ readonly id: string; readonly heading: Span | null; readonly body: Span | null }>;
  /** Each Sources row's line and its cells, trimmed, in the table's order. */
  readonly sourceRows: ReadonlyArray<{ readonly id: string; readonly line: Span; readonly cells: ReadonlyArray<Span> }>;
  /** Each figure's printed value; `at` null where the file does not hold it as one run of text, with why. */
  readonly figures: ReadonlyArray<FigurePosition>;
}

export interface FigurePosition {
  readonly id: string;
  readonly at: Span | null;
  readonly unlocated: string | null;
}

/** A figure's printed value in the file, from where the figure pass found it in the paragraph's HTML and where each character of that HTML came from. */
function locateFigure(text: string, figure: ExtractedFigure, fileOffset: ((htmlOffset: number) => number) | null, span: { readonly start: number; readonly end: number }): FigurePosition {
  if (fileOffset === null) return { id: figure.id, at: null, unlocated: "the section's prose has no source map" };
  const from = fileOffset(span.start);
  for (let k = span.start; k < span.end; k += 1) {
    if (from < 0 || fileOffset(k) !== from + (k - span.start)) return { id: figure.id, at: null, unlocated: "the printed value is not one run of the source" };
  }
  const at = { from, to: from + (span.end - span.start) };
  return text.slice(at.from, at.to) === figure.valueText ? { id: figure.id, at, unlocated: null } : { id: figure.id, at: null, unlocated: "the source differs from the printed value" };
}

function shifted(span: Span, by: number): Span {
  return { from: span.from + by, to: span.to + by };
}

function partOf(chapter: ParsedChapter, folder: string): BuiltChapter["part"] {
  if (chapter.frontmatter.part !== null) return chapter.frontmatter.part;
  const n = Number(/part(\d)/.exec(folder)?.[1] ?? "1");
  return (["P0", "P1", "P2", "P3"] as const)[Math.min(3, n)];
}

const CITED: ReadonlySet<SourceTier> = new Set(["PRIMARY", "VENDOR", "ANALYST", "PRACTITIONER"]);

interface BuildOptions {
  readonly locale: "en";
  readonly previous: ReadonlyMap<number, PreviousVersion>;
  /** Also report where each section, source row and figure sits in the file (feature-specs/33 § 4.1); ingestion does not ask. */
  readonly positions?: boolean;
}

/** Build a chapter's rows. Mermaid SVGs are rendered afterwards by `attachMermaid`. */
export function buildChapter(file: { fileName: string; text: string; part: string }, book: BookFiles, opts: BuildOptions): BuiltChapter {
  const parsed = parseChapterFile(file.fileName, file.text);
  const n = parsed.number;
  const reg = book.registry.get(n) ?? { verify: null, redteam: null };
  const status = registryStatus(reg.verify, reg.redteam);
  const lab = book.labs.get(n) ?? null;
  const derive: DeriveSource | null = lab === null ? null : deriveSource(lab);
  const labFiles = lab === null ? [] : lab.files.map((f) => ({ path: f.path, content: f.content }));
  const warnings: string[] = [];

  const sourcesLayer = parsed.layers.find((l) => l.layer === "SOURCES");
  const sourceRows = sourcesLayer === undefined ? [] : parseSourceRows(sourcesLayer.markdown, status.verifiedAt, new Map(), n);
  const rowRefs = sourceRows.map((r) => ({ id: `${String(n).padStart(2, "0")}.9 r${r.ordinal}`, ordinal: r.ordinal, tokens: sourceTokens(r.citation) }));

  const located = opts.positions === true;
  const figurePositions: FigurePosition[] = [];
  let figureOrdinal = 1;
  let mermaidOrdinal = 1;
  const allFigures: ExtractedFigure[] = [];
  const unlinkedAll: ChapterReport["unlinked"][number][] = [];
  const unmatchedSources = new Set<string>();
  let untiered = 0;
  let codeBlocks = 0;
  let labBlocks = 0;
  let mermaidCount = 0;

  const sections: BuiltSection[] = parsed.layers.map((layer) => {
    const id = `${String(n).padStart(2, "0")}.${layer.ordinal}`;
    /* the chapter title leads the indexed text so a title term finds every layer (06 D1) */
    const textEn = `${parsed.title} · ${plainProse(layer.markdown)}`;
    if (layer.layer === "SOURCES") {
      return { id, layer: layer.layer, ordinal: layer.ordinal, titleEn: layer.title, markdownEn: layer.markdown, htmlEn: "", words: countWords(layer.markdown).total, textEn, codeBlocks: [], figures: [], xrefs: [], mermaid: [] };
    }
    const lifted = liftFences(layer.markdown);
    let html = renderProse(lifted.markdown);
    /* positions: each character of the prose back through the renderer and the lifted fences to the file */
    const origins = located && !parsed.proseOnly ? proseOrigins(lifted.markdown, html) : null;
    const fileOffset = (htmlOffset: number): number => {
      const inLifted = origins?.[htmlOffset] ?? -1;
      const inLayer = inLifted < 0 ? -1 : lifted.origin(inLifted);
      return inLayer < 0 || layer.body === null ? -1 : layer.body.from + inLayer;
    };

    /* figures: paragraph by paragraph, with the section default from a declaration paragraph */
    const sectionFigures: ExtractedFigure[] = [];
    const citeRefs: CrossRef[] = [];
    let sectionDefault: TierTag | null = null;
    if (!parsed.proseOnly) {
      html = html.replace(/<p>([\s\S]*?)<\/p>/g, (_m, inner: string, offset: number) => {
        const text = plainText(inner.replace(/<[^>]+>/g, ""));
        const declared = declaredDefault(text);
        if (declared !== null && sectionDefault === null) sectionDefault = declared;
        const result = figurePass(inner, { chapter: n, startOrdinal: figureOrdinal, sectionDefault, derive, sourceRows: rowRefs, labels: EN_LABELS });
        if (located) {
          const innerAt = offset + "<p>".length;
          result.figures.forEach((figure, i) => figurePositions.push(locateFigure(file.text, figure, origins === null ? null : (k) => fileOffset(innerAt + k), result.spans[i])));
        }
        figureOrdinal += result.figures.length;
        sectionFigures.push(...result.figures);
        citeRefs.push(...result.refs);
        unlinkedAll.push(...result.unlinked.map((u) => ({ section: id, ...u })));
        result.unmatchedSources.forEach((s) => unmatchedSources.add(s));
        untiered += result.untieredNumbers;
        return `<p>${result.html}</p>`;
      });
    }

    /* cross-references: the prose's, plus chapters named inside tier parentheticals */
    const xr = xrefPass(html, opts.locale, n);
    html = xr.html;
    const refs = new Map<string, CrossRef>();
    for (const r of [...xr.refs, ...citeRefs]) refs.set(`${r.targetKind}:${r.targetId}`, r);

    /* code panes and mermaid figures */
    const views: CodeBlockView[] = [];
    const mermaid: Array<BuiltSection["mermaid"][number]> = [];
    const deriveLines = new Set(sectionFigures.flatMap((f) => (f.derive === null ? [] : [f.derive.line])));
    for (const fence of lifted.fences) {
      const placeholder = `<p>${FENCE_PLACEHOLDER(fence.index)}</p>`;
      if (fence.lang === "mermaid") {
        const figureId = `F-${String(n).padStart(2, "0")}-M${String(mermaidOrdinal).padStart(2, "0")}`;
        mermaid.push({ index: fence.index, definition: fence.text, figureId, figureOrdinal: mermaidOrdinal, fence });
        mermaidOrdinal += 1;
        mermaidCount += 1;
        html = html.replace(placeholder, `@@MERMAID_${figureId}@@`);
      } else {
        const pane = renderCodePane(fence, { locale: opts.locale, labId: lab?.id ?? null, labFiles, highlightLines: deriveLines });
        views.push(pane.view);
        codeBlocks += 1;
        if (pane.view.file !== null) labBlocks += 1;
        html = html.replace(placeholder, pane.html);
      }
    }
    allFigures.push(...sectionFigures);
    return { id, layer: layer.layer, ordinal: layer.ordinal, titleEn: layer.title, markdownEn: layer.markdown, htmlEn: html, words: countWords(layer.markdown).total, textEn, codeBlocks: views, figures: sectionFigures, xrefs: [...refs.values()], mermaid };
  });

  /* the linter counts the whole file, title and frontmatter included */
  const words = countWords(file.text).total;
  const derivedTotal = allFigures.filter((f) => f.tier === "DERIVED").length + unlinkedAll.length;
  const derivedLinked = allFigures.filter((f) => f.tier === "DERIVED").length;
  const fastRows = new Set(sourceRows.filter((r) => r.fastMoving).map((r) => `${String(n).padStart(2, "0")}.9 r${r.ordinal}`));
  const cited = allFigures.filter((f) => CITED.has(f.tier));
  const citedFastMoving = cited.filter((f) => f.sourceRowId !== null && fastRows.has(f.sourceRowId)).length;
  /* source links (feature-specs/10 § 5.2): citable rows are the four cited tiers; the gap is the book's work list, never an error */
  const citableRows = sourceRows.filter((r) => CITED.has(r.tier));
  const sourceRowsLinked = citableRows.filter((r) => r.url !== null || r.doi !== null).length;
  if (untiered > 0) warnings.push(`${untiered} number(s) without a tier tag`);
  if (unmatchedSources.size > 0) warnings.push(`${unmatchedSources.size} cited parenthetical(s) not matched to a source row`);
  if (sourceRowsLinked < citableRows.length) warnings.push(`${citableRows.length - sourceRowsLinked} citable source row(s) without a link`);
  if (lab === null && parsed.frontmatter.lab !== null) warnings.push(`frontmatter names Lab ${parsed.frontmatter.lab} but no labs/ch${String(n).padStart(2, "0")}-* folder exists`);

  const hashInput = {
    title: parsed.title,
    sections: sections.map((s) => ({ id: s.id, layer: s.layer, title: s.titleEn, markdown: s.markdownEn, html: s.htmlEn, code: s.codeBlocks, figures: s.figures, xrefs: s.xrefs, mermaid: s.mermaid.map((m) => m.definition) })),
    sourceRows,
    lab: lab === null ? null : { id: lab.id, files: lab.files.map((f) => ({ path: f.path, sha256: f.sha256 })), derived: withoutRunTimestamp(lab.derived), verdict: lab.ciVerdict },
    status,
  };
  const hash = contentHash(hashInput);
  const version = nextVersion(
    { title: parsed.title, layerTitles: parsed.layers.map((l) => l.title), subHeadings: parsed.layers.flatMap((l) => subHeadingsOf(l.markdown)), contentHash: hash },
    opts.previous.get(n) ?? null,
  );
  const figuresByTier: Record<string, number> = {};
  for (const f of allFigures) figuresByTier[f.tier] = (figuresByTier[f.tier] ?? 0) + 1;
  const sourcesBody = sourcesLayer?.body ?? null;
  const positions: ChapterPositions | null = located
    ? {
        sections: parsed.layers.map((l) => ({ id: `${String(n).padStart(2, "0")}.${l.ordinal}`, heading: l.heading, body: l.body })),
        sourceRows:
          sourcesLayer === undefined || sourcesBody === null
            ? []
            : sourceRowSpans(sourcesLayer.markdown).map((r) => ({ id: `${String(n).padStart(2, "0")}.9 r${r.ordinal}`, line: shifted(r.line, sourcesBody.from), cells: r.cells.map((c) => shifted(c, sourcesBody.from)) })),
        figures: figurePositions,
      }
    : null;

  return {
    number: n,
    slug: parsed.slug,
    part: partOf(parsed, file.part),
    carries: book.carries.get(n) ?? (lab === null ? (parsed.proseOnly ? "PROSE" : "INSTRUMENT") : "LAB"),
    title: parsed.title,
    standfirst: standfirstOf(parsed),
    version,
    verifyStatus: status.verifyStatus,
    redteamStatus: status.redteamStatus,
    redteamOpen: status.redteamOpen,
    verifiedAt: status.verifiedAt,
    words,
    derivedLinked,
    derivedTotal,
    citedTotal: cited.length,
    citedFastMoving,
    sections,
    sourceRows,
    lab,
    contentHash: hash,
    report: {
      chapter: n,
      title: parsed.title,
      stub: words < 800,
      words,
      sections: sections.length,
      figuresByTier,
      derivedLinked,
      derivedTotal,
      unlinked: unlinkedAll,
      untieredNumbers: untiered,
      sourceRows: sourceRows.length,
      sourceRowsCitable: citableRows.length,
      sourceRowsLinked,
      unmatchedSources: [...unmatchedSources],
      crossReferences: sections.reduce((a, s) => a + s.xrefs.length, 0),
      codeBlocks,
      labBlocks,
      mermaidFigures: mermaidCount,
      mermaidFailed: 0,
      lab: lab === null ? null : { id: lab.id, verdict: lab.ciVerdict, checkedAt: lab.ciCheckedAt?.toISOString() ?? null },
      verify: status.verifyStatus,
      redteam: status.redteamStatus,
      redteamOpen: status.redteamOpen,
      version,
      contentHash: hash,
      warnings,
    },
    positions,
  };
}

/** Render every mermaid block of the built chapters and substitute the figures into the HTML. */
export async function attachMermaid(chapters: ReadonlyArray<BuiltChapter>, renderer: MermaidRenderer | null): Promise<ReadonlyArray<BuiltChapter>> {
  const out: BuiltChapter[] = [];
  for (const chapter of chapters) {
    let failed = 0;
    const sections: BuiltSection[] = [];
    for (const section of chapter.sections) {
      let html = section.htmlEn;
      if (section.mermaid.length > 0) {
        const svgs = renderer === null ? section.mermaid.map(() => null) : await renderer.render(section.mermaid.map((m) => m.definition));
        section.mermaid.forEach((m, i) => {
          if (svgs[i] === null) failed += 1;
          html = html.replace(`@@MERMAID_${m.figureId}@@`, figureHtml(m.fence, svgs[i], chapter.number, m.figureOrdinal, m.figureId, FIGURE_LABELS));
        });
      }
      const violations = bodyVocabularyViolations(html);
      if (violations.length > 0) throw new ParseError(chapter.number, `section ${section.id} renders outside the reader vocabulary: ${violations.join(", ")}`);
      sections.push({ ...section, htmlEn: html });
    }
    out.push({ ...chapter, sections, report: { ...chapter.report, mermaidFailed: failed } });
  }
  return out;
}
