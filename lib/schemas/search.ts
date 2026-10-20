import { z } from "zod";

import { SearchFiltersSchema } from "@/lib/search/filters";
import { LangSchema, SourceTierSchema } from "@/lib/schemas/domain";
import { ReleaseIdSchema, SourceRowIdSchema } from "@/lib/schemas/ids";

/*
 * Data contract for the search page (feature-specs/06 § 4). The loader's
 * output passes through here; dates coerce.
 */

/** Text with `<mark>` and nothing else: every other tag, attribute or entity is refused (§ 4.2). */
export function snippetViolations(html: string): ReadonlyArray<string> {
  const violations = new Set<string>();
  const stripped = html.replace(/<\/?mark>/g, "");
  if (/[<>]/.test(stripped)) violations.add("tag");
  for (const m of stripped.matchAll(/&[^;\s]*;?/g)) {
    if (!/^&(amp|lt|gt|quot|#39);$/.test(m[0])) violations.add(`entity ${m[0].slice(0, 10)}`);
  }
  return [...violations];
}

export const SnippetHtmlSchema = z.string().superRefine((html, ctx) => {
  const violations = snippetViolations(html);
  if (violations.length > 0) ctx.addIssue({ code: "custom", message: `snippet vocabulary: ${violations.join(", ")}` });
});

const HrefSchema = z.string().startsWith("/");

/** What the vector half of the rank did (feature-specs/12 § 5, § 6): the Query instrument's vector row reads it. */
export const VECTOR_STATES = ["ok", "indexing", "unavailable"] as const;
export type VectorState = (typeof VECTOR_STATES)[number];
const VerdictSchema = z.enum(["REPRODUCED", "NOT_REPRODUCED", "KILLED", "ERROR"]);

export const SearchHitSchema = z
  .object({
    kind: z.enum(["section", "lab", "row"]),
    id: z.string().min(1),
    label: z.string().min(1),
    title: z.string().min(1),
    chapter: z.number().int().min(0).max(40),
    chapterTitle: z.string().min(1),
    rowOrdinal: z.number().int().positive().nullable(),
    href: HrefSchema,
    snippet: SnippetHtmlSchema,
    layer: z.number().int().min(1).max(9).nullable(),
    tiers: z.array(z.union([SourceTierSchema, z.literal("SCENARIO")])).readonly(),
    version: z.string().nullable(),
    verifiedDays: z.number().int().nonnegative().nullable(),
    stale: z.object({ rowId: SourceRowIdSchema, days: z.number().int().min(91) }).readonly().nullable(),
    derive: z.object({ line: z.number().int().positive(), labId: z.string().min(1) }).readonly().nullable(),
    lab: z.object({ verdict: VerdictSchema, checkedAt: z.coerce.date().nullable() }).readonly().nullable(),
    rank: z.number(),
  })
  .readonly();

const FacetCountSchema = z.object({ value: z.string().min(1), count: z.number().int().nonnegative() }).readonly();

export const SearchDataSchema = z
  .object({
    release: z.object({ id: ReleaseIdSchema, gitSha: z.string().regex(/^[0-9a-f]{8,40}$/) }).readonly(),
    filters: SearchFiltersSchema,
    hits: z.array(SearchHitSchema).readonly(),
    count: z.number().int().nonnegative(),
    facets: z
      .object({
        part: z.array(FacetCountSchema).readonly(),
        layer: z.array(FacetCountSchema).readonly(),
        tier: z.array(FacetCountSchema).readonly(),
        age: z.array(FacetCountSchema).readonly(),
        type: z.array(FacetCountSchema).readonly(),
        labsWithoutLayer: z.number().int().nonnegative(),
      })
      .readonly(),
    terms: z.object({ query: z.array(z.string()).readonly(), matched: z.array(z.string()).readonly() }).readonly(),
    /** True when the query held only stop words: nothing was indexed for it (§ 7). */
    stopWordsOnly: z.boolean(),
    timings: z
      .object({
        parseMs: z.number().nonnegative(),
        lexicalMs: z.number().nonnegative(),
        vectorMs: z.number().nonnegative().nullable(),
        assembleMs: z.number().nonnegative(),
        totalMs: z.number().nonnegative(),
      })
      .readonly(),
    /**
     * `ok` with `timings.vectorMs`, `indexing` while the release holds no vectors at the pin, `unavailable` when
     * the query could not be embedded. The query-less page reports the index's readiness, since no query ran.
     */
    vector: z.enum(VECTOR_STATES),
    index: z
      .object({
        chapters: z.number().int().nonnegative(),
        sections: z.number().int().nonnegative(),
        labs: z.number().int().nonnegative(),
        rows: z.number().int().nonnegative(),
        builtAt: z.coerce.date(),
        hash: z.string().min(8),
        editions: z.enum(["EN", "EN_PT"]),
      })
      .readonly(),
    actions: z
      .object({
        askHref: HrefSchema.nullable(),
        lab: z.object({ id: z.string().min(1), href: HrefSchema, minutes: z.number().int().positive().nullable() }).readonly().nullable(),
      })
      .readonly(),
    signedIn: z.boolean(),
    sourceLang: LangSchema,
  })
  .readonly();

export type SearchData = z.infer<typeof SearchDataSchema>;
export type SearchDataInput = z.input<typeof SearchDataSchema>;
export type SearchHit = z.infer<typeof SearchHitSchema>;
