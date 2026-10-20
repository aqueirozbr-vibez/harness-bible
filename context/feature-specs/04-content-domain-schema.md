# 04 · Content domain schema — Phase 1 backend spec

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Scope: the Prisma-based backend that Phase 1 (Reader) needs: the content domain of the database, the Prisma client with its guards, the content pipeline that turns the book's markdown into release rows, the render hash, the seed, and the loaders that replace the fixtures behind Book Home and the chapter reader. It covers tracker units 7, 8, 9, 10, 11 and 12. Accounts and reader state (Bookmark, Note, ReadingPathProgress) are specified in § 9 as the following migration; auth itself is unit 21.

Governing context: `context/architecture.md` § 1 (PostgreSQL via Prisma, pgvector + tsvector), § 4 (storage model, data model, content pipeline, retention), § 11 invariants 1–5, 24, 30; `context/code-standards.md` § Data and Storage; TRD § 4.2 (the Prisma schema this spec extends), § 4.5 (content pipeline), § 5.4 (performance budgets), § 11 (testing, environments, release procedure). Consumers: `feature-specs/02-book-home.md` § 4 (`HomeData`), `feature-specs/03-reader-chapter.md` § 4 (`ChapterData`, `PeekData`, § 4.2 body vocabulary).

Source material the pipeline reads: `bible/book/part{0..3}/chNN-*.md` (41 chapters, nine `## NN.k` layers each, at least two ```` ```mermaid ```` blocks, a Layer 9 table `| # | Claim or figure | Source | Tier | Verified |`), `bible/book/registry/chNN.md`, `chNN-verify.md`, `chNN-redteam.md`, `bible/labs/chNN-*/` (`README.md`, `derive.py`, `run.py`, `results/derived.json`, `results/run.json`, `results/run.txt` ending in `Lab NN: REPRODUCED`), `bible/book/CHAPTER-MAP.md`, `bible/scripts/lint_chapter.py` (the tier grammar: a number in prose must share its line with a parenthetical containing a year or one of `illustrative`, `vendor`, `primary`, `analyst`, `derived`, `open`, `practitioner`, `scenario`).

## 1. Purpose

Make the release the source of truth. After this unit, `DATABASE_URL` points at a PostgreSQL database holding one pinned release ingested from `bible/`, the pages read from it through one query each, the fixtures are gone, and a re-run of ingestion for the same source produces the same rows and the same render hash. Nothing in the app can write to a content table.

## 2. Environment and toolchain

| Item | Value |
|---|---|
| Database | PostgreSQL 16 with extensions `vector` (pgvector) and `pg_trgm` |
| Dev database | `docker compose up db` from `docker-compose.yml` at the repo root, image `pgvector/pgvector:pg16`, port 5432, database `harness_bible`, a `.env.example` with `DATABASE_URL=postgresql://hb:hb@localhost:5432/harness_bible` (§ 11 D8) |
| Prisma | `prisma` and `@prisma/client` (architecture § 1); schema at `prisma/schema.prisma`; migrations forward-only, one per PR, `prisma migrate dev` locally and `prisma migrate deploy` elsewhere |
| Pipeline runner | `tsx` (dev dependency) for `npm run ingest` and `prisma db seed` (§ 11 D10) |
| Markdown | `marked` with a custom renderer that emits only the reader vocabulary (§ 11 D7) |
| Mermaid | `mermaid` rendered to SVG at ingestion inside a Playwright page on the installed Edge (§ 11 D7); no browser at request time |
| Tests | Vitest for the parser; Testcontainers (`@testcontainers/postgresql`) for migrations, ingestion and loaders |

Environment variables (all through `lib/env.ts`): `DATABASE_URL`; `BOOK_DIR` (path to `bible/`, default `../bible`); `RELEASE_ID` (`2026.09`); `RENDER_HASH_EXPECTED` (optional, CI's value); `PIPELINE=1` (set only by the ingest process; enables content writes, § 5).

## 3. Prisma schema — content domain

TRD § 4.2 is the base. Differences from the TRD are marked **(+)** and each has a row in § 11.

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL"); extensions = [vector, pg_trgm] }

enum Part { P0 P1 P2 P3 P4 }
enum Layer { INTUITION MECHANISM WORKED_NUMBERS MEASUREMENT FAILURE FRONTIER INDUSTRIAL_APPLICATION DECISION_AIDS SOURCES }
enum SourceTier { PRIMARY VENDOR ANALYST PRACTITIONER ILLUSTRATIVE DERIVED OPEN }
enum Lang { EN PT }
enum VerifyStatus { PASSED FAILED UNVERIFIED }
enum Verdict { REPRODUCED NOT_REPRODUCED KILLED ERROR }
enum EditionStatus { PARITY PENDING }                       // (+) D12

model Release {
  id          String   @id                                  // "2026.09"
  gitSha      String   @unique                              // git sha, or tree hash while the book has no tags (D13)
  renderHash  String                                        // sha256 of ordered row hashes; must equal CI's
  isCurrent   Boolean  @default(false)                      // (+) D9: exactly one true, enforced by a partial unique index
  publishedAt DateTime
  ingestedAt  DateTime @default(now())
  chapters    ChapterVersion[]
}

model Chapter { number Int @id; part Part; slug String @unique; versions ChapterVersion[] }

model ChapterVersion {
  id             String   @id @default(uuid())
  chapterNumber  Int;     chapter Chapter @relation(fields: [chapterNumber], references: [number])
  releaseId      String;  release Release @relation(fields: [releaseId], references: [id])
  version        String                                     // semver (D4)
  sourceLang     Lang     @default(EN)
  verifyStatus   VerifyStatus
  redteamStatus  VerifyStatus
  redteamOpen    Int      @default(0)
  verifiedAt     DateTime?
  contentHash    String                                     // sha256 of this chapter's rows
  words          Int                                        // (+) D3, linter rule: prose + tables, code and math excluded
  derivedLinked  Int                                        // (+) D3
  derivedTotal   Int                                        // (+) D3
  citedTotal     Int                                        // (+) D3
  citedFastMoving Int                                       // (+) D3
  sections   Section[]; editions Edition[]; lab Lab?; sourceRows SourceRow[]; xrefs CrossReference[]
  // @@unique([chapterNumber, version]): dropped 2026-10-10 (unit 54c; migration 20261009190000): every release
  // re-inserts an unchanged chapter at its version (§ 6.10, invariant 1), which that key refused at the second release
  @@unique([chapterNumber, releaseId])
  @@index([releaseId])
}

model Edition {                                              // chapter-level text per language (D12)
  id               String @id @default(uuid())
  chapterVersionId String; chapterVersion ChapterVersion @relation(fields: [chapterVersionId], references: [id])
  lang             Lang
  status           EditionStatus                            // PENDING when no PT source exists yet
  title            String
  standfirst       String
  @@unique([chapterVersionId, lang])
}

model Section {
  id               String @id                                // "21.3"
  chapterVersionId String; chapterVersion ChapterVersion @relation(fields: [chapterVersionId], references: [id])
  layer            Layer
  ordinal          Int                                       // 1..9
  titleEn          String; titlePt String?                   // PT null while pending
  markdownEn       String; markdownPt String?                // (+) D11: the source, for anchors and diffs
  htmlEn           String; htmlPt String?                    // rendered once, reader vocabulary only (spec 03 § 4.2)
  codeBlocks       Json                                      // (+) CodeBlockView[] metadata for the panes in html
  tsv              Unsupported("tsvector")?                  // generated in the migration from titleEn || markdownEn
  embedding        Unsupported("vector(1024)")?              // filled in Phase 2 (gateway); null in Phase 1
  figures Figure[]; xrefsFrom CrossReference[]
  @@unique([chapterVersionId, ordinal])
  @@index([chapterVersionId, layer])
}

model Figure {
  id            String  @id                                  // "F-21-03", numbered in document order per chapter
  sectionId     String; section Section @relation(fields: [sectionId], references: [id])
  ordinal       Int                                          // order within the chapter
  label         String                                       // "interrupted / day" (D2: the sentence's head phrase)
  valueText     String                                       // as written in the EN source: "86", "0.4%", "1 s"
  value         Decimal?                                     // numeric part when parseable
  unit          String?
  tier          SourceTier
  fastMoving    Boolean @default(false)                      // D6
  scenarioParam Boolean @default(false)                      // "(scenario)" figures; curator-only class later
  sourceRowId   String?; sourceRow SourceRow? @relation(fields: [sourceRowId], references: [id])
  derive        DeriveLink?
  @@index([tier, fastMoving])
}

model DeriveLink {
  figureId   String @id; figure Figure @relation(fields: [figureId], references: [id])
  labId      String
  filePath   String @default("derive.py")
  line       Int                                             // line of the `out["key"] = …` assignment
  key        String                                          // derived.json key
  expression String                                          // the source line, trimmed
}

model SourceRow {
  id               String @id                                // "21.9 r4"
  chapterVersionId String; chapterVersion ChapterVersion @relation(fields: [chapterVersionId], references: [id])
  ordinal          Int
  claim            String                                    // (+) the table's "Claim or figure" column
  citation         String                                    // the "Source" column
  url              String?; doi String?
  tier             SourceTier
  verifiedAt       DateTime
  fastMoving       Boolean @default(false)                   // D6
  figures          Figure[]
  @@unique([chapterVersionId, ordinal])
  @@index([verifiedAt])
}

model CrossReference {
  id               String @id @default(uuid())
  chapterVersionId String; chapterVersion ChapterVersion @relation(fields: [chapterVersionId], references: [id])
  fromSectionId    String; from Section @relation(fields: [fromSectionId], references: [id])
  targetKind       String                                    // "section" | "chapter" | "lab" | "sourceRow"
  targetId         String                                    // "26.3" | "ch31" | "lab21" | "21.9 r4"
  @@index([targetId])
}

model Lab {
  id               String  @id                               // "lab-21"
  chapterVersionId String  @unique; chapterVersion ChapterVersion @relation(fields: [chapterVersionId], references: [id])
  folder           String                                    // "ch21-control-plane"
  readme           String                                    // README.md, rendered to reader vocabulary
  expectedRuntimeS Int?
  wallClockCapS    Int     @default(600)
  cpu              Int     @default(2)
  memoryGiB        Int     @default(4)
  declaresModelCalls Boolean @default(false)
  egressExtra      String[]
  ciVerdict        Verdict?                                  // (+) Book Home D1
  ciCheckedAt      DateTime?                                 // (+) from results/run.json timestamp
  ciDivergedSince  DateTime?                                 // (+) first check at which the verdict stopped being REPRODUCED
  derived          Json                                      // results/derived.json as ingested
  files            LabFile[]
}

model LabFile {
  id         String @id @default(uuid())
  labId      String; lab Lab @relation(fields: [labId], references: [id])
  path       String                                          // "derive.py"
  sha256     String
  content    String                                          // (+) Phase 1 keeps text in the row; object storage arrives with Phase 3
  @@unique([labId, path])
}
```

Migration `0001_content` also creates, in raw SQL appended to the migration: `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;` the generated column `tsv` as `to_tsvector('english', coalesce("titleEn",'') || ' ' || coalesce("markdownEn",''))` with a GIN index; an HNSW index on `embedding` (`vector_cosine_ops`); and `CREATE UNIQUE INDEX release_one_current ON "Release" ("isCurrent") WHERE "isCurrent"` (D9).

Rules the schema enforces (TRD § 4.2 table, kept): a `DERIVED` figure has a `DeriveLink` (checked by the pipeline before insert and by a `CHECK`-equivalent integration test); figures hang off `Section`, never `Edition`, so both editions render the same rows; `Release.renderHash` is compared to CI's value before `isCurrent` is set.

## 4. Prisma client and guards (unit 8)

`lib/db/client.ts` exports one `prisma` instance built with `$extends`:

1. **Tenant filter.** For every model that has an `organisationId` column (none in the content domain; `User`, `Seat`, `BudgetLedger`, … in § 9 and later), every `findMany`, `findFirst`, `update`, `delete`, `count` and `aggregate` gets `where: { organisationId }` injected from an `AsyncLocalStorage` tenant context set by the request handler; a query on such a model with no context throws `AppError("NO_TENANT")`. Content models are exempt by an explicit allow-list, not by absence of the column.
2. **Content is read-only in the app.** `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany` on `Release`, `Chapter`, `ChapterVersion`, `Edition`, `Section`, `Figure`, `DeriveLink`, `SourceRow`, `CrossReference`, `Lab`, `LabFile` throw `AppError("CONTENT_READ_ONLY")` unless `env.PIPELINE === "1"`, which only the ingest process sets (invariant 3). Even the pipeline never updates or deletes a content row; it inserts a new release or aborts (§ 6.7).
3. **Raw SQL** is allowed only in `lib/search/hybrid.ts` (unit 19) and the render-hash query; both are listed in `lib/db/RAW_SQL.md` with the reason and the tenant argument.

`lib/db/RAW_SQL.md` is created in this unit with the two entries.

## 5. Pipeline layout (units 9 and 11)

```
pipeline/
  ingest.ts              CLI: --book ../bible --release 2026.09 [--only 21,28,37] [--dry-run] [--expect-hash <sha>]
  parse/
    chapterFile.ts       read chNN-*.md → { number, part, title, frontmatter, layers[] }
    frontmatter.ts       line 3: *Part II · Word budget … · Lab 21 · Verified as of September 2026 · Derived figures from …*
    markdown.ts          marked renderer restricted to the reader vocabulary; tables → .tbl; fences → .code; ```mermaid → figure
    sourceMap.ts         rendered prose → its markdown, character by character: where a figure's value sits in the file (positions, § 6.12)
    figures.ts           the tier grammar (D2): numbers + parentheticals → Figure rows, chips, fig-* spans, derive links
    sources.ts           Layer 9 table → SourceRow rows; matches parenthetical source names to rows for chip locators
    xrefs.ts             (chNN), chNN, Lab NN, NN.k, NN.9 rK → CrossReference rows and a.xref / a.src links
    code.ts              code panes with line numbers, lab-file detection, highlighted derive lines
    mermaid.ts           mermaid source → inline SVG with token colours, <title>/<desc> from the caption line
    wordCount.ts         the linter's count: prose + tables, code and math excluded
    lab.ts               labs/chNN-*/ → Lab, LabFile, derived.json keys, run.txt verdict, run.json timestamp
    registry.ts          registry/chNN-verify.md and -redteam.md → verify/redteam status and dates
    versions.ts          chapter version per release (D4)
  renderHash.ts          sha256 over ordered row hashes (§ 6.6)
  report.ts              the ingestion report: per chapter, figures linked/unlinked, unmatched sources, warnings
```

Every module is pure (input strings → output objects) except `ingest.ts`, `lab.ts` (reads files) and `mermaid.ts` (drives a browser). Every pure module has a Vitest test against chapter 21, and the golden test compares the parsed 21.3 against the markup the chapter-21 fixture carries today (`lib/fixtures/chapter21.ts` → moved to `pipeline/parse/__fixtures__/21.3.html`).

## 6. Pipeline behaviour

### 6.1 Chapter file → layers

- The file's first line `# Chapter NN — Title` gives number and EN title. Line 3, in italics, gives the part, the lab (`Lab 21`), the verification month (`Verified as of September 2026`) and the derive path.
- Layers are split on `^## NN\.k Title$` in order; the nine headings must be present and in the linter's order (`Intuition, Mechanism, Worked numbers, Measurement, Failure, The frontier, Industrial application, Decision aids, Sources`); a chapter missing a layer fails ingestion with the layer named (Part 0's prose-only chapter is the exception: it ingests as one `INTUITION` section plus an empty `SOURCES` section and no figures grammar, § 11 D15).
- Sub-headings `### …` inside a layer become `<h3>` in that section's body (spec 03 D5).
- The chapter standfirst is the first sentence of 21.1 (up to the first full stop) unless a `> ` blockquote precedes 21.1; it goes to `Edition.standfirst` (§ 11 D16).

### 6.2 Prose → HTML

`marked` with a renderer that emits only spec 03 § 4.2: paragraphs, `<h3>`, lists, `<em>`, `<strong>`, `<code>`, `<br>`, tables as `<table class="tbl">` with `td.n` on numeric cells, fenced code as `.code` panes (§ 6.5), mermaid fences as figures (§ 6.6). Raw HTML in the markdown is escaped, never passed through. The result is run through `bodyVocabularyViolations` from `lib/schemas/chapter.ts`; a violation aborts the chapter with the offending tag or class named.

### 6.3 Figures and provenance (D2)

Applied per paragraph of prose (not tables, not code, not headings), using the linter's two regexes verbatim (`CITE` and `NUM` from `lint_chapter.py`, ported to `pipeline/parse/figures.ts` with a test that pins them to the Python source):

1. Find every tier parenthetical `(…)` matching `CITE`. Its tier is the first tier word it contains, mapped: `primary` → PRIMARY, `vendor` → VENDOR, `analyst` → ANALYST, `practitioner` → PRACTITIONER, `illustrative` → ILLUSTRATIVE, `derived` → DERIVED, `open` → OPEN, `scenario` → ILLUSTRATIVE with `scenarioParam = true`; a parenthetical with only a year and no tier word → PRIMARY (the linter accepts a year as a citation). `(illustrative rate; arithmetic derived)` yields two tiers: the number immediately before it is DERIVED and the rate it names is ILLUSTRATIVE; the rule is "last tier word wins for the preceding number, earlier tier words attach to earlier numbers in the same sentence".
2. Every `NUM` match in the sentence that ends with that parenthetical becomes a `Figure` with that tier, unless the linter would skip it (`Figure|Table|Lab|Layer|Chapter|Section|ch|Part` prefixes and `NN.k` section refs). `label` is the noun phrase around the number: the words from the previous punctuation or verb up to the number, trimmed to at most six words; `valueText` is the matched token; `value`/`unit` are parsed from it (`0.4%` → 0.4 / `%`; `1 s` → 1 / `s`; `2,000` → 2000; `$0.30` → 0.30 / `USD`).
3. `DERIVED` figures are matched to `results/derived.json`: a key whose value, printed at the figure's precision, equals `value` (percentages compared as fractions as well: `77%` matches `0.769`; `45%` matches `0.455`). Ambiguity (two keys) is resolved by preferring a key whose name shares a word with the label, else reported. The matched key's assignment line in `derive.py` (`out["key"] =`) gives `DeriveLink.line`; `expression` is that line trimmed. An unmatched derived figure is inserted without a `DeriveLink`? No: a `DERIVED` figure must have a link (schema rule). It is inserted as `OPEN` with `report.unlinked[]` carrying chapter, section, label and value, and `derivedTotal` counts it while `derivedLinked` does not. The chapter still ingests; the report shows the gap and the Book Home instrument shows `13 / 14 linked`.
4. In the HTML, each figure's token is wrapped: `<span class="fig-der" data-figure="F-21-03">117 duplicate side effects a day</span>` for DERIVED (the wrap extends over the label words that follow the number when the number starts the phrase, as the screen shows), `<span class="fig-ill" data-figure="…">0.4% per step</span>` for ILLUSTRATIVE, `<span data-figure="…">1 s</span>` for cited tiers. The parenthetical is replaced by a chip: `<span class="chip t-ven"><i>ven</i> vendor · 21.9 r1</span>` when § 6.4 matched it to a source row, else `<span class="chip t-ven"><i>ven</i> vendor</span>`; DERIVED figures get `<a class="derive" href="/{lang}/labs/lab-21/derive.py#L47" data-figure="F-21-03" data-line="47" title="derive.py line 47">ƒ L47</a>` instead of a chip. Chip abbreviations and labels are localised at render (`ilu ilustrativo`, `ven fornecedor`, `derive.py linha 47`) from `messages/*.json` keys `reader.tier.abbr.*` and a new `pipeline.tierLabel.*`, so `htmlPt` differs from `htmlEn` only in those strings and the PT prose when it exists.
5. `citedTotal` counts figures with tier PRIMARY/VENDOR/ANALYST/PRACTITIONER; `citedFastMoving` those with `fastMoving`.

### 6.4 Sources (Layer 9)

The table `| # | Claim or figure | Source | Tier | Verified |` → one `SourceRow` per row: `ordinal` from `#`, `claim`, `citation` from Source, `tier` from the Tier cell (`illustrative / scenario` → ILLUSTRATIVE; `derived` → DERIVED; `open` → OPEN), `verifiedAt` from the Verified cell parsed as a month (`Sep 2026` → the date in the chapter's `-verify.md` heading when present, else the first of that month), `url`/`doi` from a markdown link in the Source cell when present. A parenthetical in prose whose text contains a distinctive word of a row's Source (`Temporal`, `Stripe`, `Garcia-Molina`, `HumanLayer`, `Anthropic`) is matched to that row for the chip locator and the figure's `sourceRowId`; no match leaves both empty and adds a report line. Layer 9's `htmlEn` is empty; the reader renders the rows.

### 6.5 Code panes

Fenced code becomes `<div class="code" data-block="k" id="code-k">` with a `.code-h` (file name when known, else the language), `.code-b` of `.ln[data-n]` lines, three-hue syntax classes (`.k` keywords, `.s` strings and numbers, `.c` comments, `.fn` definitions) for Python and none for `text`, and a `<template data-raw>` with the raw text. A block is a lab file when its first line is a comment naming a path under `labs/` or when the layer heading above it is `### Reference implementation`; then `CodeBlockView.file` and `labHref` are set and the block's lines are matched against the lab file to number them from the real line; lines that a `DeriveLink` in the same section points at get `.hl`. Other blocks number from 1.

### 6.6 Mermaid figures

Each ```` ```mermaid ```` block becomes `<figure class="fig box" data-figure="F-NN-k">` with the `.inst-h` header `Figure NN.j · mermaid · rendered · alt text available`, an inline `<svg role="img" aria-labelledby>` produced by `mermaid.render` in a Playwright page with a theme whose colours are the tokens (`var(--ink)`, `var(--bg)`, `var(--ver)`, `var(--fail)`, `var(--warn)`, `var(--rule)`; fonts `var(--mono)`), a `<title>` from the figure number, a `<desc>` and a `sr-only` paragraph from the caption line (the italic line that follows the block, when present, else the first node labels joined), and a `figcaption`. Figure numbers `NN.j` run per chapter in document order. The SVG's `<style>` block is removed; only presentation attributes remain, so the vocabulary validator passes it.

### 6.7 Release, hashes, idempotency

- `gitSha`: `git -C $BOOK_DIR rev-parse HEAD` when the book is a git repository; otherwise a tree hash: sha256 over `path\n sha256(content)` of every file under `book/` and `labs/` (excluding `__pycache__`), sorted by path, prefixed `tree-` in the report and stored as its 40 hex characters (D13).
- `contentHash` per chapter: sha256 of the canonical JSON (RFC 8785, reuse `lib/ledger/canonical.ts` when it exists, else a local implementation with the same rules) of the chapter's rows in a fixed order: version, editions, sections (id, layer, titles, markdown, html, codeBlocks), figures, derive links, source rows, cross-references, lab metadata and lab file hashes.
- `renderHash`: sha256 over the chapters' `contentHash` values in chapter order, then the release id.
- Not in either hash (2026-09-23): the `timestamp` key of `results/derived.json` and `run.json`'s timestamp. The book's `update_map.py` re-runs every lab and rewrites both on each run; a release whose values are unchanged keeps its hash (`withoutRunTimestamp` in `pipeline/renderHash.ts`). `Lab.ciCheckedAt` still records the run.
- Idempotency: if a `Release` with the same `gitSha` exists and its `renderHash` equals the recomputed one, ingestion is a no-op that prints the hash; if the `renderHash` differs (the pipeline changed), ingestion aborts with both hashes, because content rows are immutable per release (invariant 1): a new release id is required.
- `--expect-hash` (or `RENDER_HASH_EXPECTED`): when given and different, the transaction rolls back and the exit code is 2. When equal, or not given in dev, the release is inserted and `isCurrent` is switched in the same transaction (the previous current release keeps its rows).
- The whole ingestion is one transaction; a parse failure in any chapter rolls it back.
- After a successful switch the app's data cache is revalidated by tag `release:<id>` (a `POST /api/v1/internal/revalidate` with a shared secret arrives with unit 21; until then, restart the server).

### 6.8 Labs

`labs/chNN-*/`: `README.md` → `Lab.readme` (rendered); `derive.py`, `run.py` and every other file except `__pycache__` and `results/` → `LabFile` rows with sha256 and content; `results/derived.json` → `Lab.derived`; `results/run.txt`'s last line `Lab NN: REPRODUCED` → `ciVerdict = REPRODUCED`, any other last line → `NOT_REPRODUCED`, missing results → `ciVerdict = null`; `results/run.json.timestamp` → `ciCheckedAt`; `ciDivergedSince` is carried over from the previous release's row when the verdict is still not REPRODUCED, else set to `ciCheckedAt` when it flips, else null. `expectedRuntimeS` from a README phrase `~ N min` or `N seconds` when present (chapter 21's README says "CPU, seconds" → null). `declaresModelCalls` true when the README contains `model call` or `API key` (D17). Chapters without a lab folder (00, 33, 34, 36, 38, 39) get `lab = null`; the chapter map's "— (instrument)" rows are how the reader distinguishes `no lab · prose` from `no lab · instrument` (a `Chapter.carries` column, `PROSE | INSTRUMENT | LAB`, filled from the scope tables of `CHAPTER-MAP.md` under its `## Part …` headings; the map is optional since 2026-09-23 (it was absent from one book update), in which case a chapter carries `LAB` when its frontmatter names a lab, `PROSE` when it is prose-only, else `INSTRUMENT`; the map's generated status section (`<!-- STATUS (generated…) -->`, added by the book's `update_map.py` the same day) is ignored by the parser; existing `Chapter` rows are never updated by a re-ingest, **(+)**).

### 6.9 Registry → verification

`registry/chNN-verify.md` present → `verifyStatus = PASSED`, `verifiedAt` from the date in its heading `(21 Sep 2026, …)`; absent → `UNVERIFIED`. `registry/chNN-redteam.md` present → `redteamStatus = PASSED`; absent → `UNVERIFIED`. `redteamOpen` = the count of lines in the redteam file matching `^\|.*\b(OPEN|open)\b.*\|$` in a table whose header contains `Status`, else 0 (D5). `FAILED` is never produced by the pipeline; it is reserved for the CI webhook.

### 6.10 Versions (D4)

`CHAPTER-MAP.md` and `CHANGELOG.md` carry no semver. The first ingested release assigns `v1.0.0` to every chapter. Later releases: `patch` bump when only `htmlEn`/`markdownEn` or source rows changed within a section, `minor` when a section's set of sub-headings changed, `major` when a layer's title or the chapter title changed; computed by diffing against the previous current release. This is the book's rule from the PRD (patch for wording and figures, minor for new sections, major for structure) applied mechanically until the improvement flow (Phase 4) sets versions from merges.

### 6.11 Report

`ingest` prints and writes `pipeline/reports/<release>.json`: per chapter, words, figures by tier, `derivedLinked/derivedTotal`, unlinked derived figures (section, label, value, candidates), source rows, unmatched parentheticals, cross-references with unresolved targets, code blocks, mermaid figures, lab verdict, verify/redteam; then the release's `renderHash`, `gitSha`, and timing. The report is the artefact reviewers read; CI archives it.

### 6.12 Positions (unit 50b, part 1, 2026-10-07)

`buildChapter` with `positions: true` also returns where each section, Sources row and figure sits in the chapter file, for the edit that applies a suggestion (feature-specs/33 § 4.1, § 13). Positions sit beside the rows and never in them, since the rows feed `contentHash`; ingestion does not ask for them. A figure's place is read through the renderer by `sourceMap.ts`, never by searching the file for its value, and a place that cannot be mapped exactly is null with its reason.

## 7. Seed (unit 10)

`prisma/seed.ts` runs `ingest --only 21,28,37 --release 2026.09` against `BOOK_DIR`. That is the fixture release the TRD names (chapters 21, 28, 37 and their labs). `npm run db:reset` = `prisma migrate reset` (drops, migrates, seeds) for development only.

## 8. Loaders (unit 12)

`lib/db/content.ts` replaces the fixture branches. Every loader takes the current release once and reads with one query per page (TRD § 5.4). Dates cross the cache boundary as ISO strings, so `HomeDataSchema` and `ChapterDataSchema` change `z.date()` to `z.coerce.date()` (D18) and the loaders return parsed DTOs.

| Function | Query | Notes |
|---|---|---|
| `getCurrentRelease()` | `Release` where `isCurrent` | cached with tag `release:current` |
| `getHomeData(locale, userId)` | `ChapterVersion` of the release with `chapter`, `lab` (verdict, `ciCheckedAt`, `ciDivergedSince`), `editions` (title for the locale, falling back to EN), aggregates of `SourceRow.verifiedAt` per chapter (`max age where fastMoving`), `redteamOpen`; grouped into parts with counts; `continueReading` from `ReadingPathProgress` (§ 9) when `userId` is set | `nightlyCheckAt = max(Lab.ciCheckedAt)`; `daysSinceVerify` and stale days computed in SQL from `now()`; curators empty until the roster exists |
| `getChapterCards(locale)` | the same rows as cards | for `GET /chapters` (unit 21) |
| `getChapterData(locale, n, sectionId, userId)` | `ChapterVersion` + its `Section` by id + all nine `Section` ids/titles + `Figure` with `DeriveLink` and `SourceRow` for the section + `SourceRow` for layer 9 + `Lab` + neighbours (`ChapterVersion` numbers/titles in the same part within the window) + progress | `editionLang` = PT when `Edition.status = PARITY` and `htmlPt` is not null, else EN with `pending` (spec 03 D6); `codeBlocks` from the section's JSON |
| `getPeek(locale, id)` | section: the target `Section`'s first `<p>` of `htmlEn/htmlPt`, its chapter title and version, layer, `verifiedAt`; chapter: title + standfirst; lab: `Lab.readme` first paragraph | null when not in the release |
| `getSection(id, locale)`, `getDeriveLink(figureId)` | as the API needs them | unit 21 |

Cache: each loader is wrapped in `unstable_cache` (or `"use cache"` once `cacheComponents` is enabled) keyed by `[name, releaseId, locale, …]` with tags `release:<id>`; `revalidateTag` runs after a switch. With the database present, `generateStaticParams` in `app/[lang]/(home)` and `app/[lang]/ch/[n]/[section]` enumerate every locale and section of the current release, and the build reports `○` for those routes (the tracker's open note on `/[lang]` rendering dynamic is resolved here or the cause is written down).

Fixtures: `lib/fixtures/home.ts` and `lib/fixtures/chapter21.ts` are deleted; the 21.3 body markup moves to `pipeline/parse/__fixtures__/21.3.html` as the parser's golden expectation (D14). `getHomeData` and friends throw `AppError("NO_DATABASE")` when `DATABASE_URL` is unset.

## 9. Next migration: accounts and reader state (for units 20 and 21, specified here so the tenant guard is built for them)

```prisma
enum Role { READER BUILDER CONTRIBUTOR CURATOR ORG_ADMIN }
enum Residency { BR_SAO_PAULO }
model Organisation { id String @id @default(uuid()); name String; seatLimit Int; residency Residency @default(BR_SAO_PAULO); ssoIssuer String?; tokenCap BigInt; ideMinutesCap Int; createdAt DateTime @default(now()); users User[]; seats Seat[] }
model User { id String @id @default(uuid()); organisationId String?; organisation Organisation? @relation(…); email String @unique; displayName String; role Role @default(READER); identityVerified Boolean @default(false); provenanceConsentAt DateTime?; locale String @default("pt-BR"); throttledUntil DateTime?; deletedAt DateTime?; sessions Session[]; bookmarks Bookmark[]; notes Note[]; progress ReadingPathProgress[]; @@index([organisationId, role]) }
model Seat { … as TRD … }
model Session { … as TRD … }
model Bookmark { id String @id @default(uuid()); userId String; sectionId String; createdAt DateTime @default(now()); @@unique([userId, sectionId]) }
model Note { id String @id @default(uuid()); userId String; sectionId String; body String; updatedAt DateTime @updatedAt }
model ReadingPathProgress { id String @id @default(uuid()); userId String; path String; lastSectionId String; completed Int; updatedAt DateTime @updatedAt; @@unique([userId, path]) }   // updatedAt is Book Home D2
```

`Bookmark`, `Note` and `ReadingPathProgress` are user-scoped (the tenant filter keys them by `userId` through the session, and by the user's `organisationId` for admin queries). Migration `0002_accounts`. Not part of this unit's deliverable; its shape is fixed here so § 4's guard and § 8's `continueReading` query need no rework.

## 10. Tests and CI

| Level | What | Gate |
|---|---|---|
| Unit (Vitest, `pipeline/parse/*.test.ts`) | `chapterFile` splits chapter 21 into nine layers with the right titles; `frontmatter` reads Part II / Lab 21 / September 2026; `figures` on 21.3 yields the fixture's figures (labels, values, tiers, derive keys `expected_redo_fraction_no_checkpoint` ↔ 45%, `backoff_total_worst_s` ↔ 61) and on 21.1 the `(scenario, ch16)` parenthetical; the ported `CITE`/`NUM` regexes match the Python ones on a shared corpus of 30 lines; `sources` yields the ten rows with the right tiers; `xrefs` finds `ch16`, `ch22`, `Lab 21`, `26.3`, `21.9 r4`; `markdown` rejects raw HTML and passes `bodyVocabularyViolations`; `wordCount` equals the linter's count for chapter 21 (run the Python linter once, pin the number); `code` numbers the derive.py block from line 36; `renderHash` is stable across two runs and changes when one character of one section changes | 100% of `figures.ts` branches |
| Integration (Testcontainers) | migrations apply on a fresh `pgvector/pgvector:pg16`; `ingest --only 21,28,37` inserts 3 chapter versions, 27 sections, the figures and source rows, 3 labs; re-ingest is a no-op with the same hash; `--expect-hash wrong` rolls back; `getHomeData("en", null)` and `getChapterData("en", 21, "21.3", null)` return DTOs that pass their schemas and reproduce the fixture's counts where the source agrees (6 figures in 21.3, 10 source rows in 21.9, 3 labs reproducing); the content guard throws on `prisma.section.update` outside the pipeline; the tenant guard throws on `prisma.user.findMany` without context | green on every PR |
| Golden | `pipeline/parse/__fixtures__/21.3.html` equals the parser's output for 21.3 modulo whitespace | green |
| End to end | the Book Home and Reader Playwright checks from specs 02 and 03 rerun against the seeded database | no regression |
| CI | `docker compose up db` service in the workflow; `prisma migrate deploy`; `npm run ingest -- --only 21,28,37 --expect-hash $RENDER_HASH_EXPECTED`; tests | build fails on hash mismatch |

## 11. Decisions this spec needs

| # | Decision | Recommendation |
|---|---|---|
| D1 | Lab CI verdict columns (Book Home D1). | `ciVerdict`, `ciCheckedAt`, `ciDivergedSince` on `Lab`, filled from `results/run.txt` and `run.json` at ingestion and by `POST /webhooks/ci` later. **Material; recommended as above.** |
| D2 | Provenance grammar (spec 03 D2). | § 6.3, built on the linter's own regexes so the book and the pipeline agree by construction; unmatched derived figures become `OPEN` and are reported, never silently linked. **Material.** |
| D3 | Chapter counts as columns. | `words`, `derivedLinked`, `derivedTotal`, `citedTotal`, `citedFastMoving` on `ChapterVersion`, computed at ingestion; `oldestCheckDays` at read. **Material.** |
| D4 | Chapter versions: the book carries no semver. | `v1.0.0` for every chapter at the first release, mechanical bumps between releases per § 6.10 until Phase 4 sets versions from merges. **Material: the Book Home tiles will show `v1.0.0 · 0 d` for every chapter after ingestion, not the mockup's spread.** |
| D5 | `redteamOpen` from the registry. | Count `OPEN` rows in a status table when the redteam file has one; else 0. The pilot report's "open MAJOR items" are not machine-readable today; ask the book to add a status table. Routine, stated. |
| D6 | `fastMoving` for figures and source rows. | True when the claim or the sentence contains a price, deadline, model version or benchmark term (`price`, `\$`, `per M tokens`, `deadline`, `applies from`, `Annex`, a model id pattern, a benchmark name from `SOURCES.md`); plus an override file `pipeline/overrides/fast-moving.json` listing `NN.9 rK` ids to force either way. **Material: the 90-day stale rule depends on it.** |
| D7 | Markdown and Mermaid libraries. | `marked` (MIT, no dependencies) with a restricted renderer; `mermaid` (MIT) rendered in Playwright on the installed Edge at ingestion only. Both are pipeline-only dependencies; neither ships to the browser. **Material (new dependencies).** |
| D8 | Dev database. | `docker-compose.yml` with `pgvector/pgvector:pg16`; Docker availability on Andre's machine is unknown — if absent, a local PostgreSQL 16 with the pgvector extension installed. **Material (environment).** |
| D9 | The current release pointer. | `Release.isCurrent` with a partial unique index, switched in the ingestion transaction. Routine. |
| D10 | Pipeline runner. | `tsx` as a dev dependency for `npm run ingest` and `prisma db seed`. Routine. |
| D11 | Store markdown and HTML per section. | Both: markdown is the anchor text suggestions quote and the diff base for version bumps; HTML is what the reader serves. Routine. |
| D12 | `Edition` shape. | Chapter-level `title`, `standfirst`, `status` per language; section text stays on `Section` (`titlePt`, `markdownPt`, `htmlPt` nullable). Routine. |
| D13 | `gitSha` without a git repository. | Tree hash of `book/` and `labs/` until the book repo has tags. Routine. |
| D14 | Fixtures after ingestion. | Delete both fixtures; keep 21.3's markup as the parser golden. The pages then show the real book's state. Routine. |
| D15 | Part 0 prose-only chapter. | One `INTUITION` section holding the whole text, empty `SOURCES`, no figure grammar (the linter's `--prose` mode). Routine. |
| D16 | Standfirst source. | First sentence of 21.1 unless a blockquote precedes it. The screens' standfirst for chapter 21 is not in the chapter file; after ingestion the header shows the first sentence of Intuition. Routine, stated. |
| D17 | `declaresModelCalls` detection. | README contains `model call` or `API key`. Routine; Phase 3 replaces it with a README field. |
| D18 | Dates across the cache. | `z.coerce.date()` in the DTO schemas. Routine. |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. `prisma migrate dev` on a fresh database creates the extensions, the generated `tsv` column, the GIN and HNSW indexes and the partial unique index; `prisma migrate deploy` on the same database is a no-op.
2. `npm run ingest -- --only 21,28,37 --release 2026.09 --dry-run` prints the report with no database writes; without `--dry-run` it inserts the release and sets `isCurrent`; a second run prints `no-op` with the same `renderHash`.
3. The report for chapter 21 lists nine sections, the figures per tier, `derivedLinked/derivedTotal` with any unlinked figure named, 10 source rows, the cross-references, 2+ mermaid figures, code blocks with the derive.py block numbered from its real line, lab `REPRODUCED` with `ciCheckedAt` from `run.json`, verify and redteam PASSED with the registry date.
4. `npm run ingest` (all 41 chapters) succeeds or names the chapters that fail the layer or vocabulary checks; the Part III stubs (34, 35, 36, 38, 39, 40) are expected to fail the nine-layer rule today and are listed, not silently skipped.
5. With `DATABASE_URL` set: `/en` renders from the database (Book status counts equal `SELECT` counts; tiles show `v1.0.0`; Lab 23's state comes from its `run.txt`); `/en/ch/21/21.3` renders the parsed section with its figures, chips, derive links, figure SVGs and code panes; the Playwright checks from specs 02 and 03 pass except the items the tracker lists as fixture-only (the mockup's versions, days and stale rows).
6. `curl` the RSC payload of `/en/ch/21/21.3`: under 150 KB; server render under 1 s locally.
7. `prisma.section.update(...)` from a route handler throws `CONTENT_READ_ONLY`; the same call inside `ingest` with `PIPELINE=1` is refused too, because the pipeline only inserts.
8. The token grep, tsc, lint, `npm test`, integration tests and `npm run build` pass; `git status` shows only `prisma/`, `pipeline/`, `lib/db/`, `lib/schemas/{home,chapter}.ts` (coerce), `lib/env.ts`, the deleted fixtures and their moved golden, `docker-compose.yml`, `.env.example`, `package.json` scripts and dependencies, tests, `context/architecture.md` § 4 (if a column or rule changed), and the tracker.
