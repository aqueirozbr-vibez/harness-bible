import { getPrisma } from "@/lib/db/client";
import type { SearchFilters } from "@/lib/search/filters";

/*
 * The one search statement (feature-specs/06 § 5.2, 12 § 5), listed in lib/db/RAW_SQL.md.
 * Rank, headline and facet counts in one pass over the current release's
 * sections, lab READMEs and registry rows; every filter is a WHERE clause; the
 * release id is a hard filter on every source.
 *
 * Retrieval (12 § 7.2) runs the same statement over a narrower candidate set:
 * `scope` restricts every source to a list of chapters and to the chapters whose
 * VERIFY passed, upstream in `base` and in `vec`, so the fused set, the totals and
 * the facets are all of that scope and the vector half's fifty nearest are the
 * scope's own. The search page scopes nothing (`WHOLE_RELEASE`).
 *
 * The rank is reciprocal-rank fusion with k = 60 (12 D2): 1/(60 + lexical position)
 * plus 1/(60 + vector position), each half contributing only where it matched. The
 * vector half is the `vec` CTE over `Section.embedding <=> $embedding`, the release's
 * 50 nearest sections; a section it found that the lexical half did not enters `base`
 * too, which is how the reader's vocabulary reaches the book's. Labs and source rows
 * have no embedding in Phase 2 and keep their lexical rank alone. Without an
 * embedding the statement is the lexical one: `vec` is empty and the fused rank is
 * 1/(60 + lexical position), whose order is the lexical order.
 *
 * `vec` also runs only for a query that carries a lexeme (`numnode(q.tsq) > 0`, review
 * round 2, 2026-09-24): `websearch_to_tsquery('english', 'the of and')` is an EMPTY but
 * NOT NULL tsquery, so without that condition a stop-word-only query matched nothing
 * lexically and still took the 50 nearest sections of the release, which made 06 § 5.2's
 * "an empty or stop-word-only query yields zero hits" false and its `search.empty.stop`
 * state unreachable. Retrieval shares the statement, so a question with no surviving
 * lexeme has no candidates at all (12 § 7.2: the scope sensor refuses it first).
 */

export interface RawHit {
  readonly kind: "section" | "lab" | "row";
  readonly pk: string;
  readonly id: string;
  readonly layer: number | null;
  readonly title: string;
  readonly part: string;
  readonly chapter: number;
  readonly ctitle: string;
  readonly version: string;
  readonly verifiedAt: string | null;
  readonly verify: string;
  readonly lexical: number;
  readonly lab_verdict: string | null;
  readonly lab_checked: string | null;
  readonly lab_runtime: number | null;
  readonly row_ordinal: number | null;
  /** The fused rank, and each half's position in it: null where that half did not match (§ 5). */
  readonly rank: number;
  readonly lexical_pos: number | null;
  readonly vector_pos: number | null;
  readonly tiers: ReadonlyArray<string>;
  readonly stale_row: string | null;
  readonly stale_days: number | null;
  readonly derive_line: number | null;
  readonly derive_lab: string | null;
  readonly snippet: string;
}

export interface FacetRow {
  readonly value: string;
  readonly count: number;
}

export interface RawSearchResult {
  readonly total: number;
  readonly facets: { part: FacetRow[]; layer: FacetRow[]; tier: FacetRow[]; age: FacetRow[]; type: FacetRow[]; labsWithoutLayer: number };
  readonly tsq: string;
  readonly hits: RawHit[];
  /** The first section and lab in the full ordered result, for the rail's actions (§ 5.3). */
  readonly firstSection: { readonly id: string; readonly chapter: number } | null;
  readonly firstLab: { readonly id: string; readonly runtime: number | null } | null;
  readonly lexicalMs: number;
  /** The embedding call's time as the caller measured it, null when the vector half did not run (§ 5). */
  readonly vectorMs: number | null;
}

/** The query's vector and what it cost to get (lib/db/search.ts asks the workers for it). */
export interface QueryVector {
  readonly embedding: ReadonlyArray<number>;
  readonly ms: number;
}

/**
 * The candidate set the statement is restricted to (12 § 7.2): the mode's chapters, and whether an unverified
 * chapter may appear at all. Retrieval names one; the search page searches the whole release, unverified chapters
 * included, because a reader may read what the assistant may not cite.
 */
export interface SearchScope {
  /** Chapter numbers the hits may come from; empty is the whole release. */
  readonly chapters: ReadonlyArray<number>;
  /** True keeps only chapters whose VERIFY passed (§ 7.2: the assistant never sees an unverified chapter). */
  readonly verifiedOnly: boolean;
}

export const WHOLE_RELEASE: SearchScope = { chapters: [], verifiedOnly: false };

interface StatementRow {
  readonly total: number;
  readonly facet_part: FacetRow[] | null;
  readonly facet_layer: FacetRow[] | null;
  readonly facet_tier: FacetRow[] | null;
  readonly facet_age: FacetRow[] | null;
  readonly facet_type: FacetRow[] | null;
  readonly labs_without_layer: number;
  readonly tsq: string;
  readonly first_section: { id: string; chapter: number } | null;
  readonly first_lab: { id: string; runtime: number | null } | null;
  readonly hits: RawHit[] | null;
}

const HEADLINE_OPTIONS = "StartSel=<mark>, StopSel=</mark>, MaxFragments=1, MaxWords=40, MinWords=20, ShortWord=3, FragmentDelimiter=…";

/**
 * Run the statement. `limit` 0 gives counts and facets only (the query-less page); `vector` null runs the
 * lexical half alone, which is what the page does when the release is not vector-ready or the workers did not
 * answer in time (12 § 6, D6).
 */
export async function searchRelease(releaseId: string, filters: SearchFilters, limit: number, vector: QueryVector | null, scope: SearchScope = WHOLE_RELEASE): Promise<RawSearchResult> {
  const prisma = getPrisma();
  const q = filters.q;
  const parts = [...filters.part];
  const layers = [...filters.layer];
  const tiers = [...filters.tier];
  const ages = [...filters.age];
  const kinds = [...filters.type];
  const sort = filters.sort;
  const chapters = [...scope.chapters];
  const verifiedOnly = scope.verifiedOnly;
  /* pgvector's input form; null leaves `vec` empty, because NULL::vector is a valid value no row can be near. */
  const embedding = vector === null ? null : `[${vector.embedding.join(",")}]`;
  const started = performance.now();

  const rows = await prisma.$queryRaw<StatementRow[]>`
WITH q AS (
  SELECT CASE WHEN ${q} = '' THEN NULL ELSE websearch_to_tsquery('english', ${q}) END AS tsq,
         (${embedding}::text)::vector AS vq
),
vec AS (
  SELECT s.id AS pk, (row_number() OVER (ORDER BY s.embedding <=> q.vq))::int AS vpos
  FROM "Section" s
  JOIN "ChapterVersion" cv ON cv.id = s."chapterVersionId", q
  WHERE q.vq IS NOT NULL AND q.tsq IS NOT NULL AND numnode(q.tsq) > 0
    AND cv."releaseId" = ${releaseId} AND s.embedding IS NOT NULL
    AND (cardinality(${chapters}::int[]) = 0 OR cv."chapterNumber" = ANY(${chapters}::int[]))
    AND (${verifiedOnly}::boolean IS NOT TRUE OR cv."verifyStatus"::text = 'PASSED')
  ORDER BY s.embedding <=> q.vq
  LIMIT 50
),
base AS (
  SELECT 'section'::text AS kind, s.id AS pk, s.anchor AS id, s.ordinal AS layer, s."titleEn" AS title, s."textEn" AS text,
         c.part::text AS part, cv."chapterNumber" AS chapter, cv.version, cv."verifiedAt", cv."verifyStatus"::text AS verify,
         CASE WHEN q.tsq IS NULL THEN 0::real ELSE ts_rank_cd(s.tsv, q.tsq) END AS lexical,
         NULL::text AS lab_verdict, NULL::timestamptz AS lab_checked, NULL::int AS lab_runtime, NULL::int AS row_ordinal, NULL::text AS row_tier
  FROM "Section" s
  JOIN "ChapterVersion" cv ON cv.id = s."chapterVersionId"
  JOIN "Chapter" c ON c.number = cv."chapterNumber", q
  WHERE cv."releaseId" = ${releaseId} AND (q.tsq IS NULL OR s.tsv @@ q.tsq OR s.id IN (SELECT pk FROM vec))
    AND (cardinality(${chapters}::int[]) = 0 OR cv."chapterNumber" = ANY(${chapters}::int[]))
    AND (${verifiedOnly}::boolean IS NOT TRUE OR cv."verifyStatus"::text = 'PASSED')
  UNION ALL
  SELECT 'lab', l.id, l.anchor, NULL, l.title, l."textEn",
         c.part::text, cv."chapterNumber", cv.version, cv."verifiedAt", cv."verifyStatus"::text,
         CASE WHEN q.tsq IS NULL THEN 0::real ELSE ts_rank_cd(l.tsv, q.tsq) END,
         l."ciVerdict"::text, l."ciCheckedAt", l."expectedRuntimeS", NULL, NULL
  FROM "Lab" l
  JOIN "ChapterVersion" cv ON cv.id = l."chapterVersionId"
  JOIN "Chapter" c ON c.number = cv."chapterNumber", q
  WHERE cv."releaseId" = ${releaseId} AND (q.tsq IS NULL OR l.tsv @@ q.tsq)
    AND (cardinality(${chapters}::int[]) = 0 OR cv."chapterNumber" = ANY(${chapters}::int[]))
    AND (${verifiedOnly}::boolean IS NOT TRUE OR cv."verifyStatus"::text = 'PASSED')
  UNION ALL
  SELECT 'row', r.id, r.anchor, 9, r.claim, r.claim || ' — ' || r.citation,
         c.part::text, cv."chapterNumber", cv.version, cv."verifiedAt", cv."verifyStatus"::text,
         CASE WHEN q.tsq IS NULL THEN 0::real ELSE ts_rank_cd(r.tsv, q.tsq) END,
         NULL, NULL, NULL, r.ordinal, r.tier::text
  FROM "SourceRow" r
  JOIN "ChapterVersion" cv ON cv.id = r."chapterVersionId"
  JOIN "Chapter" c ON c.number = cv."chapterNumber", q
  WHERE cv."releaseId" = ${releaseId} AND (q.tsq IS NULL OR r.tsv @@ q.tsq)
    AND (cardinality(${chapters}::int[]) = 0 OR cv."chapterNumber" = ANY(${chapters}::int[]))
    AND (${verifiedOnly}::boolean IS NOT TRUE OR cv."verifyStatus"::text = 'PASSED')
),
lex AS (
  SELECT pk, (row_number() OVER (ORDER BY lexical DESC, chapter, layer NULLS LAST, kind, id))::int AS lpos
  FROM base WHERE lexical > 0
),
fused AS (
  SELECT b.*, l.lpos AS lexical_pos, v.vpos AS vector_pos,
         (COALESCE(1.0 / (60 + l.lpos), 0) + COALESCE(1.0 / (60 + v.vpos), 0))::float8 AS rank
  FROM base b
  LEFT JOIN lex l ON l.pk = b.pk
  LEFT JOIN vec v ON v.pk = b.pk
),
enriched AS (
  SELECT b.*,
    (SELECT e.title FROM "Edition" e JOIN "ChapterVersion" cv2 ON cv2.id = e."chapterVersionId"
      WHERE cv2."releaseId" = ${releaseId} AND cv2."chapterNumber" = b.chapter AND e.lang = 'EN' LIMIT 1) AS ctitle,
    CASE b.kind
      WHEN 'section' THEN COALESCE((SELECT array_agg(DISTINCT CASE WHEN f."scenarioParam" THEN 'ILLUSTRATIVE' ELSE f.tier::text END) FROM "Figure" f WHERE f."sectionId" = b.pk), ARRAY[]::text[])
      WHEN 'lab' THEN ARRAY['DERIVED']::text[]
      ELSE ARRAY[b.row_tier]::text[]
    END AS tiers,
    CASE b.kind
      WHEN 'section' THEN (SELECT sr.anchor FROM "Figure" f JOIN "SourceRow" sr ON sr.id = f."sourceRowId"
                            WHERE f."sectionId" = b.pk AND sr."fastMoving" AND sr."verifiedAt" < now() - interval '90 days'
                            ORDER BY sr."verifiedAt" LIMIT 1)
      WHEN 'row' THEN (SELECT sr.anchor FROM "SourceRow" sr WHERE sr.id = b.pk AND sr."fastMoving" AND sr."verifiedAt" < now() - interval '90 days')
      ELSE NULL
    END AS stale_row,
    CASE b.kind
      WHEN 'section' THEN (SELECT EXTRACT(day FROM now() - sr."verifiedAt")::int FROM "Figure" f JOIN "SourceRow" sr ON sr.id = f."sourceRowId"
                            WHERE f."sectionId" = b.pk AND sr."fastMoving" AND sr."verifiedAt" < now() - interval '90 days'
                            ORDER BY sr."verifiedAt" LIMIT 1)
      WHEN 'row' THEN (SELECT EXTRACT(day FROM now() - sr."verifiedAt")::int FROM "SourceRow" sr WHERE sr.id = b.pk AND sr."fastMoving" AND sr."verifiedAt" < now() - interval '90 days')
      ELSE NULL
    END AS stale_days,
    CASE b.kind WHEN 'section' THEN (SELECT d.line FROM "DeriveLink" d JOIN "Figure" f ON f.id = d."figureId" WHERE f."sectionId" = b.pk ORDER BY f.ordinal LIMIT 1) END AS derive_line,
    CASE b.kind WHEN 'section' THEN (SELECT d."labId" FROM "DeriveLink" d JOIN "Figure" f ON f.id = d."figureId" WHERE f."sectionId" = b.pk ORDER BY f.ordinal LIMIT 1) END AS derive_lab
  FROM fused b
),
flagged AS (
  SELECT e.*,
    (e."verifiedAt" IS NOT NULL AND e."verifiedAt" >= now() - interval '30 days') AS age30,
    (e."verifiedAt" IS NOT NULL AND e."verifiedAt" >= now() - interval '90 days') AS age90,
    (e.stale_row IS NOT NULL) AS stale,
    (cardinality(${parts}::text[]) = 0 OR e.part = ANY(${parts}::text[])) AS f_part,
    (cardinality(${layers}::int[]) = 0 OR e.layer = ANY(${layers}::int[])) AS f_layer,
    (cardinality(${tiers}::text[]) = 0 OR e.tiers && ${tiers}::text[]) AS f_tier,
    (cardinality(${ages}::text[]) = 0
      OR ('d30' = ANY(${ages}::text[]) AND e."verifiedAt" IS NOT NULL AND e."verifiedAt" >= now() - interval '30 days')
      OR ('d90' = ANY(${ages}::text[]) AND e."verifiedAt" IS NOT NULL AND e."verifiedAt" >= now() - interval '90 days')
      OR ('stale' = ANY(${ages}::text[]) AND e.stale_row IS NOT NULL)) AS f_age,
    (cardinality(${kinds}::text[]) = 0 OR e.kind = ANY(${kinds}::text[])) AS f_type
  FROM enriched e
),
filtered AS (SELECT * FROM flagged WHERE f_part AND f_layer AND f_tier AND f_age AND f_type),
ordered AS (
  SELECT f.*, row_number() OVER (
    ORDER BY CASE WHEN ${sort} = 'relevance' THEN f.rank END DESC NULLS LAST,
             CASE WHEN ${sort} = 'verified' THEN f."verifiedAt" END DESC NULLS LAST,
             f.chapter, f.layer NULLS LAST, f.kind, f.id) AS ord
  FROM filtered f
),
page AS (
  SELECT o.kind, o.pk, o.id, o.layer, o.title, o.part, o.chapter, o.ctitle, o.version, o."verifiedAt", o.verify, o.lexical,
         o.rank, o.lexical_pos, o.vector_pos,
         o.lab_verdict, o.lab_checked, o.lab_runtime, o.row_ordinal, o.tiers, o.stale_row, o.stale_days, o.derive_line, o.derive_lab, o.ord,
         CASE WHEN q.tsq IS NULL THEN left(o.text, 240) ELSE ts_headline('english', o.text, q.tsq, ${HEADLINE_OPTIONS}) END AS snippet
  FROM ordered o, q
  WHERE o.ord <= ${limit}
)
SELECT
  (SELECT count(*)::int FROM filtered) AS total,
  (SELECT json_agg(json_build_object('value', part, 'count', c)) FROM (SELECT part, count(*)::int AS c FROM flagged WHERE f_layer AND f_tier AND f_age AND f_type GROUP BY part) x) AS facet_part,
  (SELECT json_agg(json_build_object('value', layer::text, 'count', c)) FROM (SELECT layer, count(*)::int AS c FROM flagged WHERE f_part AND f_tier AND f_age AND f_type AND layer IS NOT NULL GROUP BY layer) x) AS facet_layer,
  (SELECT count(*)::int FROM flagged WHERE f_part AND f_tier AND f_age AND f_type AND layer IS NULL) AS labs_without_layer,
  (SELECT json_agg(json_build_object('value', t, 'count', c)) FROM (SELECT t, count(*)::int AS c FROM flagged, unnest(tiers) AS t WHERE f_part AND f_layer AND f_age AND f_type GROUP BY t) x) AS facet_tier,
  (SELECT json_build_array(
      json_build_object('value', 'd30', 'count', count(*) FILTER (WHERE age30)::int),
      json_build_object('value', 'd90', 'count', count(*) FILTER (WHERE age90)::int),
      json_build_object('value', 'stale', 'count', count(*) FILTER (WHERE stale)::int))
    FROM flagged WHERE f_part AND f_layer AND f_tier AND f_type) AS facet_age,
  (SELECT json_agg(json_build_object('value', kind, 'count', c)) FROM (SELECT kind, count(*)::int AS c FROM flagged WHERE f_part AND f_layer AND f_tier AND f_age GROUP BY kind) x) AS facet_type,
  (SELECT COALESCE(tsq::text, '') FROM q) AS tsq,
  (SELECT json_build_object('id', o.id, 'chapter', o.chapter) FROM ordered o WHERE o.kind = 'section' ORDER BY o.ord LIMIT 1) AS first_section,
  (SELECT json_build_object('id', o.id, 'runtime', o.lab_runtime) FROM ordered o WHERE o.kind = 'lab' ORDER BY o.ord LIMIT 1) AS first_lab,
  (SELECT json_agg(row_to_json(p) ORDER BY p.ord) FROM page p) AS hits`;

  const lexicalMs = performance.now() - started;
  const row = rows[0];
  return {
    total: row?.total ?? 0,
    facets: {
      part: row?.facet_part ?? [],
      layer: row?.facet_layer ?? [],
      tier: row?.facet_tier ?? [],
      age: row?.facet_age ?? [],
      type: row?.facet_type ?? [],
      labsWithoutLayer: row?.labs_without_layer ?? 0,
    },
    tsq: row?.tsq ?? "",
    hits: row?.hits ?? [],
    firstSection: row?.first_section ?? null,
    firstLab: row?.first_lab ?? null,
    lexicalMs,
    vectorMs: vector === null ? null : vector.ms,
  };
}

/**
 * A headline from the database as snippet HTML: the raw text escaped, then the
 * `<mark>` pairs ts_headline inserted restored (feature-specs/06 § 4.2).
 */
export function markupSnippet(headline: string): string {
  return headline
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

/** Lexemes of a tsquery's text form: `'idempot' & 'key'` → `["idempot", "key"]`. */
export function lexemesOf(tsq: string): ReadonlyArray<string> {
  return [...tsq.matchAll(/'((?:[^']|'')+)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

/** Distinct words the headlines marked, lowercased, minus the query's own words. */
export function matchedTerms(snippets: ReadonlyArray<string>, query: string): ReadonlyArray<string> {
  const own = new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0));
  const found = new Set<string>();
  for (const s of snippets) {
    for (const m of s.matchAll(/<mark>([^<]+)<\/mark>/g)) {
      const word = m[1].toLowerCase();
      if (!own.has(word)) found.add(word);
    }
  }
  return [...found].sort();
}
