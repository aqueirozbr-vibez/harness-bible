import { z } from "zod";

import { LangSchema, LayerSchema, SourceTierSchema, VerifyStatusSchema } from "@/lib/schemas/domain";
import { ChapterNumberSchema, FigureIdSchema, ReleaseIdSchema, SectionIdSchema, SourceRowIdSchema } from "@/lib/schemas/ids";
import { SectionMarksSchema } from "@/lib/schemas/marks";

/*
 * Data contract for the chapter reader (feature-specs/03-reader-chapter.md Â§ 4)
 * and the peek panel (Â§ 6.8).
 */

/* â”€â”€ section body vocabulary (spec Â§ 4.2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   bodyHtml is produced once by the pipeline. The reader never rewrites it; it
   refuses anything outside this allow-list so the contract cannot drift. */

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "p", "h3", "ul", "ol", "li", "em", "strong", "code", "br", "i",
  "table", "thead", "tbody", "tr", "th", "td",
  "span", "a", "figure", "figcaption", "div", "template",
  "svg", "g", "rect", "path", "line", "polyline", "polygon", "circle", "ellipse", "text", "tspan", "title", "desc", "marker", "defs", "symbol", "use", "clippath",
]);

const ALLOWED_CLASSES: ReadonlySet<string> = new Set([
  "tbl", "n", "m",
  "fig-ill", "fig-der",
  "chip", "t-pri", "t-ven", "t-anl", "t-pra", "t-ill", "t-der", "t-opn",
  "derive", "xref", "src",
  "fig", "box",
  "code", "code-h", "code-b", "ln", "hl", "hl-f", "hl-a", "k", "s", "c", "fn",
  "inst-h", "t", "sep", "ts", "faint", "muted", "small", "rt", "grow", "mono", "meta", "cap", "sr-only",
]);

/**
 * Tags and classes in `html` that the reader vocabulary does not allow. Empty means valid.
 * Classes inside `<svg>â€¦</svg>` are Mermaid's own (`node`, `edgePath`, â€¦) and are
 * styled by `globals.css`; they are not checked. Tags inside SVG still are.
 */
export function bodyVocabularyViolations(html: string): ReadonlyArray<string> {
  const violations = new Set<string>();
  for (const match of html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)) {
    const tag = match[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) violations.add(`<${tag}>`);
  }
  const outsideSvg = html.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  for (const match of outsideSvg.matchAll(/class="([^"]*)"/g)) {
    for (const cls of match[1].split(/\s+/).filter((c) => c.length > 0)) {
      if (!ALLOWED_CLASSES.has(cls)) violations.add(`.${cls}`);
    }
  }
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) violations.add("on* handler");
  if (/javascript:/i.test(html)) violations.add("javascript: url");
  if (/<style\b/i.test(html)) violations.add("<style>");
  return [...violations];
}

export const BodyHtmlSchema = z.string().superRefine((html, ctx) => {
  const violations = bodyVocabularyViolations(html);
  if (violations.length > 0) {
    ctx.addIssue({ code: "custom", message: `body vocabulary: ${violations.join(", ")}` });
  }
});

/* â”€â”€ chapter data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const VersionSchema = z.string().regex(/^v\d+\.\d+\.\d+$/);
const HrefSchema = z.string().startsWith("/");
const PartKeySchema = z.enum(["P0", "P1", "P2", "P3"]);

export const SectionFigureSchema = z
  .object({
    id: FigureIdSchema.nullable(),
    label: z.string().min(1),
    valueText: z.string().min(1),
    tier: z.union([SourceTierSchema, z.literal("SCENARIO")]),
    derive: z.object({ labId: z.string().min(1), filePath: z.string().min(1), line: z.number().int().positive(), key: z.string().min(1) }).readonly().nullable(),
    sourceRowId: SourceRowIdSchema.nullable(),
    fastMoving: z.boolean(),
    ageDays: z.number().int().nonnegative().nullable(),
  })
  .readonly();

const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);
const DOI_RESOLVER_RE = /^https?:\/\/(?:dx\.)?doi\.org\//i;

function isHttp(href: string): boolean {
  try {
    return HTTP_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/** The document a source row opens (feature-specs/10 § 5.3): validated twice, at ingestion and here. */
export const SourceLinkSchema = z
  .object({
    href: z.url().refine(isHttp, "source link must be http(s)"),
    kind: z.enum(["url", "doi"]),
  })
  .readonly();
export type SourceLink = z.infer<typeof SourceLinkSchema>;

/** The stored URL, else the DOI through doi.org; null when neither exists or the URL is not http(s). A doi.org target reads as `doi`. */
export function sourceLinkOf(url: string | null, doi: string | null): SourceLink | null {
  const href = url ?? (doi === null ? null : `https://doi.org/${doi}`);
  if (href === null || !isHttp(href)) return null;
  return { href, kind: DOI_RESOLVER_RE.test(href) ? "doi" : "url" };
}

export const SourceRowViewSchema = z
  .object({
    id: SourceRowIdSchema,
    ordinal: z.number().int().positive(),
    claim: z.string().nullable(),
    citation: z.string().min(1),
    url: z.string().nullable(),
    doi: z.string().nullable(),
    link: SourceLinkSchema.nullable(),
    tier: SourceTierSchema,
    verifiedAt: z.coerce.date(),
    fastMoving: z.boolean(),
    stale: z.boolean(),
  })
  .readonly();

export const CodeBlockViewSchema = z
  .object({
    index: z.number().int().nonnegative(),
    file: z.string().nullable(),
    lines: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }).readonly().nullable(),
    language: z.string().min(1),
    labHref: HrefSchema.nullable(),
  })
  .readonly();

export const ChapterDataSchema = z
  .object({
    release: z.object({ id: ReleaseIdSchema, gitSha: z.string().regex(/^[0-9a-f]{8,40}$/) }).readonly(),
    chapter: z
      .object({
        number: ChapterNumberSchema,
        part: PartKeySchema,
        title: z.string().min(1),
        standfirst: z.string().min(1),
        version: VersionSchema,
        sourceLang: LangSchema,
        editionLang: LangSchema,
        verify: VerifyStatusSchema,
        redteam: VerifyStatusSchema,
        redteamOpen: z.number().int().nonnegative(),
        verifiedAt: z.coerce.date().nullable(),
        contentHash: z.string().regex(/^[0-9a-f]{8,64}$/),
        words: z.number().int().nonnegative(),
        derivedFigures: z.object({ linked: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).readonly(),
        citedFigures: z.object({ total: z.number().int().nonnegative(), fastMoving: z.number().int().nonnegative() }).readonly(),
        oldestCheckDays: z.number().int().nonnegative().nullable(),
        historyCount: z.number().int().nonnegative(),
        lab: z
          .object({
            id: z.string().min(1),
            verdict: z.enum(["REPRODUCED", "NOT_REPRODUCED", "KILLED", "ERROR"]),
            lastRunAt: z.coerce.date().nullable(),
            lastRunBy: z.enum(["ci", "user"]),
            /** Null when the README states no runtime. */
            expectedRuntimeS: z.number().int().positive().nullable(),
          })
          .readonly()
          .nullable(),
      })
      .readonly(),
    outline: z
      .object({
        partTitleKey: PartKeySchema,
        range: z.object({ from: ChapterNumberSchema, to: ChapterNumberSchema, count: z.number().int().positive() }).readonly(),
        neighbours: z.array(z.object({ number: ChapterNumberSchema, title: z.string().min(1), href: HrefSchema }).readonly()).min(1).readonly(),
        /** Nine layers, or two for the Part 0 prose-only chapter (feature-specs/04 § 11 D15). */
        layers: z.array(z.object({ id: SectionIdSchema, ordinal: z.number().int().min(1).max(9), title: z.string().min(1), href: HrefSchema }).readonly()).min(1).max(9).readonly(),
      })
      .readonly(),
    section: z
      .object({
        id: SectionIdSchema,
        ordinal: z.number().int().min(1).max(9),
        layer: LayerSchema,
        title: z.string().min(1),
        bodyHtml: BodyHtmlSchema,
        figures: z.array(SectionFigureSchema).readonly(),
        sourceRows: z.array(SourceRowViewSchema).readonly(),
        /** True when any row has a link: the Sources table renders its link column only then (feature-specs/10 D4). */
        hasSourceLinks: z.boolean(),
        prev: z.object({ id: SectionIdSchema, href: HrefSchema }).readonly().nullable(),
        next: z.object({ id: SectionIdSchema, href: HrefSchema }).readonly().nullable(),
        codeBlocks: z.array(CodeBlockViewSchema).readonly(),
      })
      .readonly(),
    progress: z
      .object({ path: z.enum(["executive", "builder", "foundations"]), done: z.number().int().nonnegative(), total: z.number().int().positive() })
      .readonly()
      .nullable(),
    /** The reader's bookmark and note on this section (feature-specs/07 § 4); null when signed out. */
    marks: SectionMarksSchema.nullable(),
  })
  .readonly();

export type ChapterData = z.infer<typeof ChapterDataSchema>;
export type ChapterDataInput = z.input<typeof ChapterDataSchema>;
export type SectionFigure = z.infer<typeof SectionFigureSchema>;
export type SourceRowView = z.infer<typeof SourceRowViewSchema>;
export type CodeBlockView = z.infer<typeof CodeBlockViewSchema>;

/* â”€â”€ peek â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export const PeekDataSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["section", "chapter", "lab"]),
    title: z.string().min(1),
    caption: z.string().min(1),
    version: VersionSchema,
    bodyHtml: BodyHtmlSchema,
    verifiedAt: z.coerce.date().nullable(),
    openHref: HrefSchema,
  })
  .readonly();

export type PeekData = z.infer<typeof PeekDataSchema>;
export type PeekDataInput = z.input<typeof PeekDataSchema>;

/** `"26.3"` â†’ section, `"ch31"` â†’ chapter, `"lab21"` â†’ lab; null when the id is none of these. */
export function classifyRef(id: string): { kind: "section"; sectionId: string } | { kind: "chapter"; chapter: number } | { kind: "lab"; chapter: number } | null {
  if (/^\d{2}\.[1-9]$/.test(id)) return { kind: "section", sectionId: id };
  const ch = /^ch(\d{2})$/.exec(id);
  if (ch !== null) return { kind: "chapter", chapter: Number(ch[1]) };
  const lab = /^lab(\d{2})$/.exec(id);
  if (lab !== null) return { kind: "lab", chapter: Number(lab[1]) };
  return null;
}
