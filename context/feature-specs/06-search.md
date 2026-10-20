# 06 · Book Search — feature spec (frontend + search backend)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screen: `docs/design/screens/Book-Search.html` (desktop, 1440) with `png/Book-Search.png`. There is no phone screen; § 6.8 derives one. Governing context: `context/ui-context.md` (§ 5 provenance chips, § 8 instrument panel, § 9.6 loaders and meters, § 9.8 chrome, § 9.10 interaction states, § 13.4 glyphs), `context/architecture.md` (§ 1 hybrid index decision, § 3.2 route `/[lang]/search?q=&part=&layer=&tier=&age=&type=`, § 3.4 `GET /search` → `{count, ms, hits[]}`, § 4.1 search index row, § 5.4 "single SQL, filters as WHERE clauses, no re-rank on the search page", search < 500 ms), `context/code-standards.md` (raw SQL only in `lib/search/hybrid.ts`, listed in `lib/db/RAW_SQL.md`; the URL holds view state; search pages are dynamic), `context/project-overview.md` (Capability 1: search across chapter sections, lab READMEs and registry rows; filters by part, layer, source tier, verification age and type; sort by relevance, book order or recently verified; query-time instrument; "Ask about this" and "Open Lab" actions; Phase 1 gate: under 500 ms at p95 with the instrument showing the measured time). PRD: search < 500 ms; 99.5% availability for reading and search.

Prerequisite specs: `02-book-home.md` (chrome: the top-bar `SearchBox` already submits `GET /[lang]/search?q=`), `03-reader-chapter.md` (chips, status marks, the reader vocabulary), `04-content-domain-schema.md` (`Section.tsv`, `pg_trgm`, pgvector deferred to Phase 2, `RAW_SQL.md`), `05-reader-paths.md` (session seam; `Section.words`).

Scope: tracker unit 19. The search page, its loader, the one SQL statement behind it, the index columns it needs, and the seam where the vector rank joins in Phase 2. The `/api/v1/search` handler is unit 21 and calls the same function.

## 1. Purpose

One query box, one results list, one SQL statement. A reader types a term in the top bar and lands on `/[lang]/search?q=…`: chapter sections, lab READMEs and registry rows that match, ranked, with the matched words marked, each hit carrying the provenance the reader would see in the chapter (layer, tiers, version, verification age, staleness, lab verdict). Filters on the left narrow by part, layer, source tier, verification age and type and combine with AND; sort switches between relevance, book order and recently verified; the rail shows the index the query ran against and how long each stage took. Everything is in the URL, so a search is a link.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| 04 (done): release rows, `Section.tsv`, `pg_trgm`, the cached-loader pattern | the corpus and the index |
| Migration `0003_search` (this spec, § 4.3) | plain-text columns for headlines and two more generated `tsvector` columns (labs, rows); one re-ingest |
| Chrome (done): `SearchBox`, `TopBar`, `StatusBar`, `InstrumentPanel`, chips and marks | the page is composed from them |
| Session seam (05, done) | "Save search" and the account hint; nothing else is per user |
| pgvector (Phase 2) | the vector half of the rank; the SQL carries the seam and the instrument reports it absent (§ 5.2, D2) |

Build order: 19a migration + pipeline plain text + re-ingest → 19b `lib/search/filters.ts` (URL ↔ typed filters, zod) and `lib/search/hybrid.ts` (the SQL, the facet counts, the timings) with tests → 19c `lib/db/search.ts` loader and `lib/schemas/search.ts` → 19d the page and components → verification.

## 3. Routes and rendering

| Route | Behaviour |
|---|---|
| `/[lang]/search` | no `q`: the filters and an `Empty` inviting a term (§ 7); never an error |
| `/[lang]/search?q=idempotency` | results; `part`, `layer`, `tier`, `age`, `type` repeatable (`&layer=2&layer=3`); `sort` ∈ `relevance` (default), `book`, `verified`; `n` = number of hits shown (default 8, `Show 15 more` links to `n+15`, max 200) |
| unknown filter values | ignored, never a 400 (the URL is typed by hand); `q` longer than 200 characters is cut |

Rendering: RSC, dynamic (`export const dynamic = "force-dynamic"` with the one-line reason: the query is in the URL and results are per query). No client state: the filter sidebar is a `GET` form; a small client component submits it on change and the `Apply` button is the no-JS fallback (§ 6.2). Sort buttons and `Show 15 more` are links that keep the other parameters. `SearchBox` in the top bar shows the current `q` on this page (§ 6.9).

Metadata: `Results for {q} · The Harness Bible` (no `q`: `Search · The Harness Bible`); `robots: noindex` on result pages; `alternates.languages`.

Performance: one SQL statement for hits and facet counts (§ 5.2) plus the cached index summary; the page reports the SQL time and the total. Budget: SQL under 500 ms at p95 (the corpus is 362 sections, 34 READMEs and 407 rows, so tens of milliseconds are expected); the whole render under 1 s.

## 4. Data contract

```ts
type HitKind = "section" | "lab" | "row";
type SortKey = "relevance" | "book" | "verified";
type AgeKey = "d30" | "d90" | "stale";

interface SearchFilters {
  readonly q: string;                                  // trimmed, ≤ 200 chars; "" means no query
  readonly part: ReadonlyArray<"P0" | "P1" | "P2" | "P3">;
  readonly layer: ReadonlyArray<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9>;
  readonly tier: ReadonlyArray<SourceTier>;
  readonly age: ReadonlyArray<AgeKey>;
  readonly type: ReadonlyArray<HitKind>;
  readonly sort: SortKey;
  readonly n: number;                                  // hits shown, 8 by default
}

interface SearchHit {
  readonly kind: HitKind;
  readonly id: string;                                 // "21.2" | "lab-21" | "21.9 r4"
  readonly label: string;                              // "21.2" | "Lab 21" | "21.9 r4"  (the mono column)
  readonly title: string;                              // layer title | README first heading | row claim (≤ 80 chars)
  readonly context: string;                            // "ch21 · Control plane and durable execution" | "Lab 21 · README" | "ch21 · Sources · row r4"
  readonly href: string;                               // section, lab readme, or the sources layer with #rK
  readonly snippet: SnippetHtml;                       // text with <mark> around matches only (§ 4.2)
  readonly layer: number | null;                       // 1..9; null for labs
  readonly tiers: ReadonlyArray<SourceTier | "SCENARIO">;   // distinct tiers of the section's figures, the row's tier, or DERIVED for a lab
  readonly version: string | null;                     // chapter version; null for a lab (it shows the CI time instead)
  readonly verifiedDays: number | null;                // days since the chapter's verify pass
  readonly stale: { readonly rowId: SourceRowId; readonly days: number } | null;   // oldest fast-moving row > 90 d among the section's cited rows
  readonly derive: { readonly line: number; readonly labId: string } | null;       // first derive link in the section
  readonly lab: { readonly verdict: Verdict; readonly checkedAt: Date | null } | null;   // labs only
  readonly rank: number;                               // for the relevance sort; not rendered
}

interface FacetCount { readonly value: string; readonly count: number; }

interface SearchData {
  readonly release: { id: ReleaseId; gitSha: string };
  readonly filters: SearchFilters;                     // as parsed, echoed to the form
  readonly hits: ReadonlyArray<SearchHit>;             // the first `n`
  readonly count: number;                              // all matches under the filters
  readonly facets: {                                   // counts per value, each group computed with the other groups applied (§ 5.3)
    readonly part: ReadonlyArray<FacetCount>; readonly layer: ReadonlyArray<FacetCount>; readonly tier: ReadonlyArray<FacetCount>;
    readonly age: ReadonlyArray<FacetCount>; readonly type: ReadonlyArray<FacetCount>;
    readonly labsWithoutLayer: number;                 // "Labs carry no layer · 4 results"
  };
  readonly terms: { readonly query: ReadonlyArray<string>; readonly matched: ReadonlyArray<string> };   // lexemes searched; distinct words the headlines marked, minus the query's own words
  readonly timings: { readonly parseMs: number; readonly lexicalMs: number; readonly vectorMs: number | null; readonly assembleMs: number; readonly totalMs: number };
  readonly index: { readonly chapters: number; readonly sections: number; readonly labs: number; readonly rows: number; readonly builtAt: Date; readonly hash: string; readonly editions: "EN" | "EN_PT" };
  readonly actions: { readonly askHref: string | null; readonly lab: { id: string; href: string; minutes: number | null } | null };
  readonly signedIn: boolean;
  readonly sourceLang: Lang;
}
```

`SearchDataSchema` (zod, `lib/schemas/search.ts`) validates the loader's output; dates coerce.

### 4.2 Snippet vocabulary

A snippet is text with `<mark>` and nothing else: `SnippetHtmlSchema` refuses any other tag, any attribute and any entity other than `&amp; &lt; &gt; &quot; &#39;`. The database produces the headline (`ts_headline` with `StartSel=<mark>, StopSel=</mark>` over the raw plain-text column); the loader escapes the whole headline and restores only the `<mark>` pairs (`markupSnippet`), so no book text is ever interpreted as markup and the index sees words rather than entities (refined during implementation, 2026-09-22). The page renders it with the one `dangerouslySetInnerHTML` of this unit, in `SearchSnippet`, after the schema check.

### 4.3 Schema changes (migration `0003_search`)

- `Section.textEn String @default("")`: the chapter title then the layer's prose as raw plain text (markdown marks, fences, tables' pipes and links dropped; the pipeline's `plainProse`), not escaped: the loader escapes headlines (§ 4.2). `Section.tsv` is regenerated from `titleEn || ' ' || textEn` (the migration drops and recreates the generated column and its GIN index; `lib/db/RAW_SQL.md` updated).
- `Lab.textEn String @default("")` (README as plain text) and `Lab.tsv tsvector` generated from it with a GIN index.
- `SourceRow.tsv tsvector` generated from `claim || ' ' || citation` with a GIN index.
- `Lab.title String @default("")`: the README's first heading without the `Lab NN —` prefix (the hit title).

The pipeline fills `textEn` and `title`; the release is re-ingested in development (empty the content tables first, tracker Session Notes). The `vector` extension, `Section.embedding` and the HNSW index stay in Phase 2 (04 D8).

## 5. Backend

### 5.1 Filters (`lib/search/filters.ts`, pure)

`parseSearchParams(searchParams: URLSearchParams): SearchFilters` — every value validated by zod, unknown values dropped, duplicates removed, `q` trimmed and cut at 200, `n` clamped to 1…200 and rounded to the default when absent. `toSearchParams(filters, overrides)` builds the links the page needs (a sort button, `Show 15 more`, `Clear all`, a removed filter) and omits defaults so URLs stay short. Both round-trip: `parse(toSearchParams(f))` equals `f`.

### 5.2 The one statement (`lib/search/hybrid.ts`)

`searchRelease(releaseId, filters, locale): Promise<{ hits, count, facets, terms, timings }>` runs one `$queryRaw` (listed in `RAW_SQL.md`: reason "one SQL for search under 500 ms; rank, headline and facet counts in one pass"; tenant argument "content rows only, release id as a hard filter"). Shape:

```sql
WITH q AS (SELECT websearch_to_tsquery('english', $q) AS tsq),
sections AS (  -- one row per matching section of the current release, with the chapter fields the hit shows
  SELECT 'section' AS kind, s.anchor AS id, s.ordinal AS layer, s."titleEn" AS title, s."textEn" AS text, c.part, cv."chapterNumber", cv.version, cv."verifiedAt", cv."verifyStatus",
         ts_rank_cd(s.tsv, q.tsq) AS lexical, s.tsv
  FROM "Section" s JOIN "ChapterVersion" cv ON cv.id = s."chapterVersionId" JOIN "Chapter" c ON c.number = cv."chapterNumber", q
  WHERE cv."releaseId" = $release AND s.tsv @@ q.tsq),
labs AS ( … 'lab', l.anchor, NULL AS layer, l.title, l."textEn", part, chapterNumber, version, verifiedAt, ci verdict … WHERE l.tsv @@ q.tsq ),
rows AS ( … 'row', r.anchor, 9 AS layer, r.claim, r.claim || ' — ' || r.citation, … r.tier, r."verifiedAt", r."fastMoving" … WHERE r.tsv @@ q.tsq ),
hits AS (SELECT * FROM sections UNION ALL SELECT * FROM labs UNION ALL SELECT * FROM rows),
enriched AS (  -- tiers, stale row, first derive line, per hit (lateral subqueries; sections only)
  SELECT h.*, (SELECT array_agg(DISTINCT CASE WHEN f."scenarioParam" THEN 'SCENARIO' ELSE f.tier::text END) FROM "Figure" f JOIN "Section" s2 ON s2.id = f."sectionId" WHERE s2.anchor = h.id AND …) AS tiers,
         (SELECT … oldest fast-moving cited row older than 90 d …) AS stale_row, (SELECT … stale days …) AS stale_days,
         (SELECT min(d.line) …) AS derive_line, (SELECT d."labId" …) AS derive_lab
  FROM hits h),
filtered AS (SELECT * FROM enriched WHERE (part filter) AND (layer filter) AND (tier filter: tiers && $tiers) AND (age filter) AND (kind filter)),
ranked AS (SELECT *, ts_headline('english', text, (SELECT tsq FROM q), 'StartSel=<mark>, StopSel=</mark>, MaxFragments=1, MaxWords=40, MinWords=20, ShortWord=3') AS snippet,
           lexical AS rank   -- Phase 2: (1/(60+lexical_pos) + 1/(60+vector_pos)) reciprocal-rank fusion with the pgvector cosine CTE (D2)
           FROM filtered)
SELECT (SELECT count(*) FROM filtered) AS total,
       (SELECT json_agg(json_build_object('group','part','value',part,'count',c)) FROM (SELECT part, count(*) c FROM enriched WHERE (all filters except part) GROUP BY part) x) AS facet_part,
       … facet_layer, facet_tier (unnest(tiers)), facet_age, facet_type, labs_without_layer …,
       (SELECT json_agg(r ORDER BY (CASE $sort WHEN 'relevance' THEN rank END) DESC NULLS LAST, (CASE $sort WHEN 'verified' THEN "verifiedAt" END) DESC NULLS LAST, "chapterNumber", layer, id LIMIT $n) FROM ranked r) AS hits;
```

Rules the statement enforces:

- `websearch_to_tsquery` parses whatever the reader typed (quotes, `-word`, `or`) without ever throwing; an empty or stop-word-only query yields zero hits and the page says so (§ 7). The statement enforces the rule rather than asserting it: such a query is an EMPTY but NOT NULL tsquery, so `vec` is gated on `q.tsq IS NOT NULL AND numnode(q.tsq) > 0` and the vector half does not run for it (review round 2, 2026-09-24, `12-retrieval.md` § 5; before the gate a stop-word query returned the release's 50 nearest sections and `search.empty.stop` was unreachable).
- The release id is a hard filter on every source; there is no cross-release result.
- Facet counts for a group are computed with every other group's filters applied (so a value's count is what choosing it yields); the selected group's own values keep their counts.
- Verification age: `d30` = chapter `verifiedAt` within 30 days, `d90` = within 90 days (includes `d30`), `stale` = the hit cites a fast-moving source row older than 90 days (sections and rows; a lab is never stale).
- Type: `section`, `lab`, `row`; a layer filter drops labs (they carry none) and the sidebar says how many (`facets.labsWithoutLayer`).
- Tier filter: a section matches when any of its figures carries the tier; a row by its own tier; a lab by `DERIVED`.
- Sort: relevance by `ts_rank_cd` (Phase 2: the fused rank); book order by chapter, layer, id; recently verified by the chapter's `verifiedAt` then book order.
- `ts_headline` marks stems of the query terms; `terms.matched` is the set of distinct marked words across the returned snippets minus the query's own words (the screen's "also matched idempotent, idempotence"); `terms.query` is the lexemes of `tsq` (`SELECT tsvector_to_array(…)`-free: derive from `websearch_to_tsquery` text form).
- The vector half is a second CTE over `Section.embedding <=> $embedding` limited to the top 50, fused by reciprocal rank. Built 2026-09-23, unit 26b (`12-retrieval.md` § 5): the seam became the `vec` CTE, `searchRelease` takes the query's vector, and `timings.vectorMs` is null only when that half did not run.
- Those 50 enter unconditionally: there is no distance floor, so for a query that does carry a lexeme the count on a vector-ready page is a **fused** count, up to 50 sections wider than the lexical one, and the widest of them matched nothing the reader typed (amended review round 2, 2026-09-24). A floor is a measurement on a real embedder, which this machine has none of, so it is an Open Question on the provider decision (`12-retrieval.md` § 5) and not a number invented here.

`timings`: `parseMs` (filters and the query text), `lexicalMs` (the statement), `vectorMs` (the embedding call, null when the vector half did not run, `SearchData.vector` saying why), `assembleMs` (mapping rows to hits, schema parse), `totalMs`. Measured with `lib/db/timing.ts`.

### 5.3 Loader (`lib/db/search.ts`)

`getSearchData(locale, filters, user)`: `requireDatabase()`; the current release; `searchRelease(...)` when `q` is non-empty, else empty hits with facets all zero; the index summary from a cached loader (`cached("search-index")`: counts of sections, labs, rows for the release, `ingestedAt`, `renderHash`); `actions.askHref` = `/[lang]/ch/{n}/{section}/@assistant?q={q}` of the first section hit (404 until Phase 2; the button renders, as the reader's does), `actions.lab` = the first lab hit's `/[lang]/labs/{id}` and its README runtime; hrefs localised like the reader's (`/en/` → `/pt/`). PT: the corpus is EN until PT editions exist; the page says `EN · source EN` and the header cap adds `PT edition pending` on the PT route (D4).

## 6. Layout and components

Desktop grid from the screen (1440): `296px minmax(0, 1fr) 320px`; the filters aside has `padding: 24px 24px 24px 28px` and a right rule; main `28px 40px 32px`; the rail `24px 24px 24px 20px` with a left rule.

```
┌ topbar (search box shows the query) ───────────────────────────────────────────────┐
│ Filters  [Clear all] │ search · chapters, labs, registries · release   │ INDEX · 2026.09  │
│ part / layer / tier  │ Results for idempotency   [Relevance|Book|Ver.] │ QUERY · 312 ms   │
│ age / type           │ 23 results · 312 ms · also matched …            │ from this search │
│ (counts per value)   │ ✢ No filters applied …                          │ marks legend     │
│                      │ 21.2 Mechanism  ch21 · …        CHAPTER SECTION │                  │
│                      │     …snippet with <mark>…                       │                  │
│                      │     layer 2 · mechanism  pri  ven  v1.5.0  ■ 9 d│                  │
│                      │ showing 8 of 23                  [Show 15 more] │                  │
└ statusbar: search · idempotency | EN · source EN | pinned release | 23 results · 312 ms | loaded ┘
```

Components in `components/search/`. Server unless marked.

### 6.1 `SearchPage`

Composes the three columns and the status bar; takes `SearchData`, `locale`, `loadedMs`.

### 6.2 `SearchFilters` (aside, `role="search"` form)

`<form method="get" action="/[lang]/search">` with a hidden `q`, hidden `sort`, and five `fieldset.rt` groups (`legend.cap`: `part`, `layer`, `source tier`, `verification age`, `type`). Each value is an `li.between` (`min-height: 28px`) with `label.check` (checkbox + text) and `span.counter` (the facet count). A value with count 0 is disabled and coloured `--ink-3`. Layer rows carry the ordinal in `.mono.faint` 11px, `min-width: 18px`; tier rows carry the chip (`Chip` with abbreviation and word); age rows read `≤ 30 d`, `≤ 90 d`, `> 90 d · stale figure` (the last in `--warn`); type rows read `Chapter section`, `Lab`, `Registry row`. Under the layer group: `.help` `Labs carry no layer · {n} results` when `labsWithoutLayer > 0`. Header: `.h4` `Filters` and a quiet `Clear all` (`Button variant="quiet" size="sm"`, a link to the query alone; disabled when nothing is set); `.help` `No filters set. Each group narrows the results; groups combine with AND.` or `{k} filters set` (candidate). `AutoSubmit` (client, § 6.7) submits on change; an `Apply` button (`Button size="sm"`) sits at the bottom for no-JS and is hidden by CSS once JS ran (`.js .filters-apply { display: none }`; the client sets `document.documentElement.classList.add("js")` on mount).

### 6.3 `SearchHead`

`.cap` `search · chapters, labs, registries · release {id}`; `.between` with `h1.h2` `<span class="muted">Results for</span> {q}` and `Seg` (`role="group"` `Sort results`: `Relevance`, `Book order`, `Recently verified`, each a link with `aria-pressed`); `.row` `.meta` `{count} results · {ms} ms` · `.cap` `also matched {terms}` (omitted when empty). A `.empty` inline row (`✢` + `.small.muted` `No filters applied. Showing every match. Pick a layer or a source tier on the left to narrow the list.`) when no filter is set and there are results; when filters are set it reads `{k} filters · {count} of {all} matches` (candidate) with a `Clear all` link.

### 6.4 `HitList` and `SearchHit`

`ol.rt-s` (`aria-label` `Search results`); each hit `li.rb` (`padding: 14px 0 16px`, column, gap 6px):

- head `.between` baseline: `.row` `.mono` label 13px `min-width: 72px` `--ink-2` (`21.2`, `Lab 21`, `21.9 r4`), `a.h4` title (`href`), `.small.faint` context; right `.label.faint` kind (`chapter section`, `lab · readme`, `registry row`);
- `SearchSnippet`: `p` 14/22, `padding-left: 82px`, `max-width: 820px`, the marked snippet (`mark` styled by `.hit mark`: `--sel` background, `box-shadow: 0 1px 0 var(--ver)`, `padding: 0 2px`, colour inherited);
- meta `.row` (gap 10px, `padding-left: 82px`, wrap): `.cap` `layer {n} · {name}` or `lab · no layer` or `layer 9 · sources`; the tier chips (`Chip`, in the fixed tier order, `scenario` as `ill`); `.meta` version, or `ci {day-month time}` for a lab, or `row checked` for a row; `StatusMark ok` `verified {d} d` (mute `unverified` when the chapter is not verified); a lab's `StatusMark` `reproduced` / fail `not reproduced`; `DeriveLink` `ƒ L{line}` when `derive` (a link to the lab file line); `StatusBlock warn sb-sm` `stale · {rowId} {days} d` when `stale`.

Footer `.between`: `.meta` `showing {shown} of {count}` and `Button` `Show 15 more` (a link to `n + 15`) while `shown < count`.

### 6.5 `SearchRail`

- `InstrumentPanel` `Index` · `{release}` · `built {day-month time}`: `dl.kv` `chapters` `{n} · {sections} sections`, `labs` `{n} readmes`, `registry rows` `{n}`, `edition` `EN` / `EN · PT at parity`; footer `index hash` / `.tex` `#{hash8 as 4·4}`.
- `InstrumentPanel` `Query` · `{total} ms` · timestamp `under 500 ms target` (or `over 500 ms target` in `--warn` when not): a `Loader`-style block (`.loader`, mono, four rows `parse`, `lexical`, `vector`, `assemble`, each `█░` bar scaled to the longest stage over 20 cells and the ms right-aligned; `vector` reads `— · indexing` or `— · unavailable` when `vectorMs` is null, by `SearchData.vector`, and read `— · phase 2` until unit 26b); `.rt` `terms` with `.meta` the query lexemes joined by ` · ` and `.meta.faint` `{count} results`.
- `from this search`: `Button` `Ask about {q}` with `Kbd` `a` (link to `askHref`; omitted when no section hit), `Button` `Open Lab {n}` with `.meta` `~ {min} min` (omitted when no lab hit), `Button` `Save search` with `.meta` `account`, disabled with `title` `arrives with bookmarks` (candidate; spec 07).
- `marks` legend: `StatusBlock warn sb-sm` `stale` + `.muted` `a cited figure in the section is > 90 d old`; `mark` `term` + `.muted` `matched text`.

### 6.6 Status bar

`search · {q}` | `{lang} · source {sourceLang}` | `pinned release {id}` | `{count} results · {ms} ms` | `loaded {s} s`. Without `q`: `search` alone in the first cell and no results cell.

### 6.7 `AutoSubmit` (client)

Mounts inside the filters form; on any `change` event submits the form (`form.requestSubmit()`); adds the `js` class to `<html>` on mount so the `Apply` button hides. Nothing else is client-side: no fetch, no state.

### 6.8 Responsive

- `< 1200px`: the rail moves below the results (`grid-template-columns: 296px minmax(0, 1fr)`; the rail spans both columns as a two-column `dl`).
- `< 1000px`: filters become a `<details>` above the results (`summary` `Filters · {k} set`), the grid is one column; the results keep their 82px snippet indent.
- `< 768px` (phone): padding 16px; the hit head wraps (label, then title, then context on its own line); the snippet indent drops to 0; the compact top bar of spec 03 with the search field visible (the compact bar hides the nav but on this page keeps `.topbar-mid`; new modifier `topbar-search`); the status bar keeps `search · {q}`, `{count} results` and `loaded`. No horizontal overflow at 390.

### 6.9 Chrome hooks

`SearchBox` gains an optional `value` prop so the top bar shows the current query on this page; the reader's `/` shortcut already focuses it. The status bar cells reuse `home.statusbar.*`.

### 6.10 New composition classes (`globals.css`, then ui-context § 9.9)

| Class | Rule | Used by |
|---|---|---|
| `.search` | `display: grid; grid-template-columns: 296px minmax(0, 1fr) 320px; min-height: 0; flex: 1 1 auto` | page |
| `.search-filters` | `padding: 24px 24px 24px 28px; display: flex; flex-direction: column; gap: 14px; min-width: 0` | aside |
| `.search-main` | `padding: 28px 40px 32px; display: flex; flex-direction: column; gap: 16px; min-width: 0` | main |
| `.search-rail` | `padding: 24px 24px 24px 20px; display: flex; flex-direction: column; gap: 18px; min-width: 0` | rail |
| `.filter-group` | the `fieldset.rt` reset: `border-left: 0; border-right: 0; border-bottom: 0; margin: 0; padding: 14px 0 0; display: flex; flex-direction: column; gap: 4px` | groups |
| `.filter-row` | `min-height: 28px` on `.between`; `.filter-off { color: var(--ink-3) }` | values |
| `.filter-ordinal` | `font-size: 11px; min-width: 18px` | layer rows |
| `.filters-apply` | shown until `.js` is on `<html>` | no-JS fallback |
| `.hit` | `padding: 14px 0 16px; display: flex; flex-direction: column; gap: 6px` | result |
| `.hit-label` | `font-size: 13px; min-width: 72px; color: var(--ink-2)` | mono column |
| `.hit-body`, `.hit-meta` | `padding-left: 82px`; body `font-size: 14px; line-height: 22px; max-width: 820px`; meta `gap: 10px; flex-wrap: wrap` | snippet and meta |
| `.hit mark` | `background: var(--sel); color: inherit; box-shadow: 0 1px 0 var(--ver); padding: 0 2px` | matched text |
| `.filters-note` | the inline `.empty` row: `padding: 12px 16px; flex-direction: row; align-items: center; gap: 12px` | note above the list |
| `.query-bars` | the four-row mono block, `white-space: pre` | query instrument |

## 7. States

| State | Render |
|---|---|
| No `q` | head `h1` `Search the book` (candidate), `Empty` caption `search` line `Type a term: a concept, a chapter number, a lab, a source.` (candidate); filters rendered with counts over the whole release (a query-less facet pass) and disabled; rail shows the index; status bar `search` |
| Query with zero matches | `Empty` `No match for "{q}" in release {id}.` (candidate) and `.muted` `Try a shorter word; the index stems English words, so "idempotent" also finds "idempotency".` (candidate); filters disabled; `count 0`. Reachable only when the vector half did not run for the query (amended review round 2, 2026-09-24): with it on, a query that carries a lexeme the lexical half did not match still returns the release's 50 nearest sections, because the 50 have no distance floor (§ 5.2). Today that is a signed-out reader with no `GATEWAY_ANONYMOUS_PRINCIPAL` configured (12 § 6, unit 37c), a release that is `indexing`, or the workers `unavailable`; the state stays in the catalogue rather than being dropped, because those are the page's normal lexical-only cases |
| Query of stop words only (`the of`) | as zero matches, with `Those words are not indexed.` (candidate). Reachable for every reader, vector-ready or not: the statement does not run the vector half for a query with no lexeme (§ 5.2), so `count` is 0 while `stopWordsOnly` is true |
| Filters remove every hit | list `Empty` `No match under these filters.` with the `Clear all` link; counts still show what each value would yield |
| Chapter unverified | hit's mark reads `unverified` (mute); still listed |
| Lab not reproduced | `StatusMark fail` `not reproduced` on the lab hit |
| Stale cited row | the `stale · rK d` block; the `> 90 d · stale figure` age facet counts it |
| Over the time target | Query instrument timestamp `over 500 ms target` in `--warn`; nothing else changes |
| PT route | corpus EN; header cap `search · … · release {id} · PT edition pending` (candidate); hrefs `/pt/`; status `PT · source EN` |
| Loading | `loading.tsx`: chrome + `Loader` `searching` (candidate) |
| Error | `error.tsx`: `ErrorBox` `Search did not run` (candidate), trace id, Retry |

## 8. Strings

Keys under `search.*`; chips reuse `reader.tier.abbr` and the tier words; layer names reuse `reader.layer.*`; part titles reuse `home.part.title.*`. PT values marked *candidate* need Andre's confirmation.

| Key | EN | PT |
|---|---|---|
| `search.metaTitle` · `.metaTitleEmpty` | Results for {q} · The Harness Bible · Search · The Harness Bible | Resultados para {q} · The Harness Bible · Pesquisa · The Harness Bible *(candidate)* |
| `search.cap` · `.capPending` | search · chapters, labs, registries · release {id} · … · PT edition pending | pesquisa · capítulos, labs, registros · release {id} · … · edição PT pendente *(candidate)* |
| `search.title` · `.titleEmpty` | Results for · Search the book | Resultados para · Pesquisar no livro *(candidate)* |
| `search.summary` · `.also` | {count, plural, one {# result} other {# results}} · {ms} ms · also matched {terms} | {count, plural, one {# resultado} other {# resultados}} · {ms} ms · também encontrou {terms} *(candidate)* |
| `search.sort.label` · `.relevance` · `.book` · `.verified` | Sort results · Relevance · Book order · Recently verified | Ordenar resultados · Relevância · Ordem do livro · Verificados recentemente *(candidate)* |
| `search.note.none` · `.some` · `.clear` | No filters applied. Showing every match. Pick a layer or a source tier on the left to narrow the list. · {k, plural, one {# filter} other {# filters}} · {count} of {all} matches · Clear all | Nenhum filtro aplicado. Mostrando todas as correspondências. Escolha uma camada ou um nível de fonte à esquerda para reduzir a lista. · {k, plural, one {# filtro} other {# filtros}} · {count} de {all} correspondências · Limpar tudo *(candidate)* |
| `search.filters.title` · `.help` · `.helpSet` · `.apply` · `.clear` · `.summary` | Filters · No filters set. Each group narrows the results; groups combine with AND. · {k} set · Apply · Clear all · Filters · {k} set | Filtros · Nenhum filtro definido. Cada grupo reduz os resultados; os grupos se combinam com E. · {k} definidos · Aplicar · Limpar tudo · Filtros · {k} definidos *(candidate)* |
| `search.group.part` · `.layer` · `.tier` · `.age` · `.type` | part · layer · source tier · verification age · type | parte · camada · nível da fonte · idade da verificação · tipo *(candidate)* |
| `search.part.P0` … `.P3` | Part 0 · why now · Part I · foundations · Part II · harness engineering · Part III · industrial application | Parte 0 · por que agora · Parte I · fundamentos · Parte II · engenharia de harness · Parte III · aplicação industrial *(candidate)* |
| `search.labsNoLayer` | Labs carry no layer · {n, plural, one {# result} other {# results}} | Labs não têm camada · {n, plural, one {# resultado} other {# resultados}} *(candidate)* |
| `search.age.d30` · `.d90` · `.stale` | ≤ 30 d · ≤ 90 d · > 90 d · stale figure | ≤ 30 d · ≤ 90 d · > 90 d · figura desatualizada *(candidate)* |
| `search.type.section` · `.lab` · `.row` | Chapter section · Lab · Registry row | Seção de capítulo · Lab · Linha de registro *(candidate)* |
| `search.kind.section` · `.lab` · `.row` | chapter section · lab · readme · registry row | seção de capítulo · lab · readme · linha de registro *(candidate)* |
| `search.hit.layer` · `.noLayer` · `.sources` · `.context` · `.labContext` · `.rowContext` | layer {n} · {name} · lab · no layer · layer 9 · sources · ch{n} · {title} · Lab {n} · README · ch{n} · Sources · row r{k} | camada {n} · {name} · lab · sem camada · camada 9 · fontes · cap. {n} · {title} · Lab {n} · README · cap. {n} · Fontes · linha r{k} *(candidate)* |
| `search.hit.verified` · `.unverified` · `.ci` · `.rowChecked` · `.stale` · `.reproduced` · `.notReproduced` | verified {d} d · unverified · ci {when} · row checked · stale · {row} {d} d · reproduced · not reproduced | verificado {d} d · não verificado · ci {when} · linha verificada · desatualizado · {row} {d} d · reproduzido · não reproduzido *(candidate)* |
| `search.list.label` · `.showing` · `.more` | Search results · showing {shown} of {count} · Show {n} more | Resultados da pesquisa · mostrando {shown} de {count} · Mostrar mais {n} *(candidate)* |
| `search.index.label` · `.built` · `.chapters` · `.chaptersValue` · `.labs` · `.labsValue` · `.rows` · `.edition` · `.editionEn` · `.editionParity` · `.hash` | Index · built {when} · chapters · {n} · {sections} sections · labs · {n} readmes · registry rows · edition · EN · EN · PT at parity · index hash | Índice · construído {when} · capítulos · {n} · {sections} seções · labs · {n} readmes · linhas de registro · edição · EN · EN · PT em paridade · hash do índice *(candidate)* |
| `search.query.label` · `.under` · `.over` · `.parse` · `.lexical` · `.vector` · `.vectorIndexing` · `.vectorUnavailable` · `.assemble` · `.terms` · `.results` | Query · under 500 ms target · over 500 ms target · parse · lexical · vector · — · indexing · — · unavailable · assemble · terms · {count} results | Consulta · abaixo da meta de 500 ms · acima da meta de 500 ms · análise · léxico · vetor · — · indexando · — · indisponível · montagem · termos · {count} resultados *(candidate)* *(`.vectorSoon`, `— · phase 2`, was replaced by the two rows in unit 26b, `12-retrieval.md` § 6)* |
| `search.actions.cap` · `.ask` · `.lab` · `.labTime` · `.save` · `.saveMeta` · `.saveSoon` | from this search · Ask about {q} · Open Lab {n} · ~ {min} min · Save search · account · arrives with bookmarks | a partir desta pesquisa · Perguntar sobre {q} · Abrir Lab {n} · ~ {min} min · Salvar pesquisa · conta · chega com os favoritos *(candidate)* |
| `search.marks.cap` · `.stale` · `.staleText` · `.term` · `.termText` | marks · stale · a cited figure in the section is > 90 d old · term · matched text | marcas · desatualizado · uma figura citada na seção tem mais de 90 d · termo · texto encontrado *(candidate)* |
| `search.empty.cap` · `.prompt` · `.none` · `.hint` · `.stop` · `.filtered` | search · Type a term: a concept, a chapter number, a lab, a source. · No match for "{q}" in release {id}. · Try a shorter word; the index stems English words, so "idempotent" also finds "idempotency". · Those words are not indexed. · No match under these filters. | pesquisa · Digite um termo: um conceito, um número de capítulo, um lab, uma fonte. · Nada encontrado para "{q}" na release {id}. · Tente uma palavra mais curta; o índice reduz palavras em inglês à raiz, então "idempotent" também encontra "idempotency". · Essas palavras não são indexadas. · Nada encontrado com estes filtros. *(candidate)* |
| `search.statusbar.search` · `.results` · `.plain` | search · {q} · {count} results · {ms} ms · search | pesquisa · {q} · {count} resultados · {ms} ms · pesquisa *(candidate)* |
| `search.loading` · `search.error.title` · `.body` · `.retry` | searching · Search did not run · Trace {traceId}. Retry, or reload the page. · Retry | pesquisando · A pesquisa não rodou · Rastreio {traceId}. Tente novamente ou recarregue a página. · Tentar novamente *(candidate)* |

`tests/messages.test.ts` parity applies.

## 9. Keyboard, accessibility

- The filters form is `role="search"` with `aria-label` `Filters`; each group a `fieldset` with a `legend`; disabled values stay in the DOM with `disabled` and their count.
- Sort is a `role="group"` of links with `aria-pressed`; `Show 15 more` is a link; hits are an ordered list whose titles are the links.
- `mark` carries no colour meaning alone: the legend explains it, and the `box-shadow` rule keeps it visible in high-contrast modes.
- The global map applies: `/` focuses the top-bar search (already showing the query), `?` opens the map; `a` on this page follows `Ask about` when it exists (the page passes its own `ask` target to `KeyboardMap`, others null).
- axe AA zero violations on `/en/search?q=idempotency` and `/pt/search?q=idempotency` (run once `@axe-core/playwright` is added as a dev dependency; D5).

## 10. Out of scope for this unit

- pgvector, embeddings, the fused rank and the `vector` timing (Phase 2; the seam is in § 5.2).
- `GET /api/v1/search` (unit 21, the handler pipeline).
- Saved searches (needs accounts; with bookmarks, spec 07).
- The assistant target of `Ask about` (Phase 2); the button links and 404s, as the reader's does.
- PT corpus and PT stemming (no PT editions yet; D4).
- Search inside code blocks and figure values; searching by figure id (`F-21-03`) beyond plain text match.

## 11. Decisions this spec needs

| # | Decision | Recommendation |
|---|---|---|
| D1 | What the index covers. | Sections (prose as plain text), lab READMEs, registry rows (`claim` + `citation`), all of the current release, English stemming. Chapter titles are part of the section text so a title term finds every layer. Routine. |
| D2 | Rank without pgvector. | `ts_rank_cd` alone now; the SQL carries the vector CTE and the reciprocal-rank fusion as a documented comment, `timings.vectorMs` null and the instrument row reads `— · phase 2`. **Material: the TRD's hybrid rank is deferred with pgvector (04 D8); the page and contract do not change when it lands.** |
| D3 | Plain-text columns. | `Section.textEn`, `Lab.textEn`, `Lab.title` filled at ingestion; `tsv` regenerated from the plain text so headlines and ranks ignore markdown marks. **Material (schema, re-ingest).** |
| D4 | PT route. | EN corpus with a `PT edition pending` cap until PT editions exist; then `textPt`/`tsvPt` with `portuguese` stemming and a `lang` argument. Routine, stated. |
| D5 | Accessibility checks. | Add `@axe-core/playwright` as a dev dependency in this unit and run it in the verification script; earlier units recorded axe as not run. Routine (one dev dependency). |
| D6 | Facet count semantics. | Counts per group with the other groups applied (what choosing the value yields), in the same statement. Routine, stated. |
| D7 | Filters as a GET form with auto-submit. | No client state; the URL is the state (code-standards); `Apply` for no-JS. Routine. |
| D8 | Result page size. | 8 first, then 15 more per click via `n`, capped at 200, as the screen. Routine. |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Migration `0003_search` applies; re-ingest fills `textEn` for 362 sections and 34 labs and `Lab.title`; `Section.tsv`, `Lab.tsv`, `SourceRow.tsv` have GIN indexes; `RAW_SQL.md` lists the search statement.
2. tsc, lint, `npm test` (filters parse and round-trip; `SnippetHtmlSchema` accepts `<mark>` only; hybrid: `websearch_to_tsquery` never throws on `"`, `(`, `-`, `or`, an empty string; integration: `idempotency` returns section, lab and row hits with ch21 among them, `terms.matched` includes a stem variant, every snippet passes the schema, facet counts sum consistently, each filter narrows, the three sorts order as specified, `n` pages, 20 varied queries all under 500 ms of SQL time on this machine), `npm run build`, token grep.
3. `/en/search` (no `q`) renders the prompt, the filters with release-wide counts, the index instrument; `/en/search?q=idempotency` renders the head with count and ms, the `also matched` cap, the note, hits with label, title link, context, marked snippet, layer cap, chips, version, verified mark; `Lab 21` as a lab hit with `ci` time and `reproduced`; a `21.9 rK` row hit with `row checked`; `showing 8 of {count}` and `Show 15 more` → `n=23`.
4. Filters: tick `layer 2` → the URL gains `layer=2`, the list narrows, the counts of the other groups update, the layer help line names the labs dropped; `Clear all` returns to the query alone; the `Apply` button is hidden when JS runs and submits when it does not (Playwright with JS disabled).
5. Sort: `Book order` puts the lowest chapter first; `Recently verified` orders by verify date; `aria-pressed` follows the URL.
6. Empty states, checked as both readers, since the vector half changes one of them (amended review round 2, 2026-09-24): `q=zzzzqq` shows the no-match `Empty` for a reader whose vector half did not run (signed out with no `GATEWAY_ANONYMOUS_PRINCIPAL` configured — unit 37c, 2026-09-24, spec 12 § 6 — or `indexing`, or `unavailable`) and, for a reader on a vector-ready release, the 50 nearest sections with a fused count and no `<mark>` (§ 5.2, § 7); `q=the` shows the stop-word note with `0 results` for **both** readers; a filter set that removes everything shows the filtered `Empty` with `Clear all`.
7. The Query instrument shows four rows with `vector — · phase 2` (unit 19; since unit 26b the row is `vector · N ms`, `— · indexing` or `— · unavailable`), the total equals the status-bar ms, and the timestamp reads `under 500 ms target`.
8. Compare `/en/search?q=idempotency` with `png/Book-Search.png`; list deliberate differences (real counts and snippets; no PT terms line; `Save search` disabled; `vector` row absent by design).
9. `/pt/search?q=idempotency` at 390: no overflow, the compact top bar with the search field, PT strings, hits readable; at 1440 PT nothing truncates.
10. axe on `/en/search?q=idempotency` and `/pt/search?q=idempotency`: zero AA violations (D5).
11. Keyboard: `/` focuses the top-bar field with the query selected; `a` follows `Ask about` when present.
12. `git status` shows only: `prisma/schema.prisma` + `prisma/migrations/0003_search`, `pipeline/build.ts` + `ingest.ts` (plain text and lab title), `lib/search/{filters,hybrid}.ts`, `lib/db/search.ts`, `lib/db/RAW_SQL.md`, `lib/schemas/search.ts`, `app/[lang]/search/**`, `components/search/*`, `components/chrome/SearchBox.tsx` (value) and `TopBar.tsx` (search modifier), `components/chrome/KeyboardMap` (ask target only if a prop is missing), `globals.css` (§ 6.10), `ui-context.md` § 9.9, `architecture.md` § 4.1 (columns) if changed, `messages/*`, `package.json` (axe), tests, and the tracker.
