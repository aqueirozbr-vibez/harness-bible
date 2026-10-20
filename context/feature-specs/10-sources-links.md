# 10 · Source links — feature spec (a link column in every chapter's Sources table)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screen: the UI package has no rendering of a layer-9 table (`Reader-Chapter.html` shows only the outline entry `21.9 Sources` and the in-prose chip `ven · 21.9 r4`). The table's vocabulary is the book's own header, `| # | Claim or figure | Source | Tier | Verified |`, rendered today by `components/reader/SourceRows.tsx` as `.tbl.source-rows` (feature-specs/03 § 6, built in unit 18). The inline-mark vocabulary is `context/ui-context.md` § 5.2 (`.derive` 18px cool outlined chip, `.xref` cool dotted), § 2.1 ("links are cool: every traversal uses `--ver`, never the warm action colour"), § 9.10 (traversal hover, table row with a link on `--sel`), § 13.4 (no icon library; glyphs, CSS squares and inline stroke SVG only), § 13.7 (no truncation, no icon fonts). Governing context: `context/architecture.md` § 4 (`SourceRow.url`, `SourceRow.doi`; content rows immutable per release, invariant 1), § 11.2 (a release is published from the book's Git tag; the book is the only source of content), `context/code-standards.md` (every external input validated at the boundary; no string literal in JSX; headers in `lib/security/headers.ts`), `context/project-overview.md` § Out of scope ("Editing content in the SaaS outside the improvement flow"; every content change is a pull request to the book repository).

Prerequisite specs: `03-reader-chapter.md` (`SourceRows`, `SourceRowView`, the layer-9 section), `04-content-domain-schema.md` § 6.4 (`pipeline/parse/sources.ts` already extracts a markdown link, a bare URL or a DOI from the Source cell into `url` and `doi`).

Scope: tracker unit 24. The improvement has two halves and only one is in this repository. **The book half**: every Sources row that cites a published source gains a link to that source on the web, written in the table's `Link` column in the convention of § 4. **The app half** (this spec): the pipeline validates the link, the loader exposes it, and the Sources table of every chapter gains a `link` column whose cell is a small tag reading `link` (or `doi`) that opens the source in a new tab. The citation text itself stays plain text.

State of the book when this spec was written (2026-09-23, morning): 0 of 407 source rows carried a URL or DOI. The book was updated the same day (`bible/.scripts/add_links.py` with `known_links.json`): every Sources table gained a sixth column, `Link`, holding a bare URL, `—` where there is nothing to open, a repository path on derived rows, or the text `needs fetch` where the script found no known URL. § 4 was amended to that format, with the Source-cell forms kept as fallbacks. That update briefly lacked `book/CHAPTER-MAP.md` (back in the next one, with a generated status section); the pipeline treats the map as optional and each chapter carries what its frontmatter says when it is absent (unit 24a).

## 1. Purpose

A reader who wants to check a claim should reach the cited document in one click from the row that cites it, without the row's text becoming a link (the citation is a bibliographic string, not a label) and without leaving the chapter. The tag is deliberately small and uniform: one word in the cool traversal colour, the same form as the `ƒ L38` derive chip, so the eye reads the table's text first and the affordance second. Rows that cite nothing on the web (derived figures, illustrative scenarios, open items) show no tag: an absent tag means "there is nothing to open", never "we forgot".

## 2. Dependencies and order

| Needs | Why |
|---|---|
| `pipeline/parse/sources.ts` (done): `[text](url)`, bare `https?://…` and `10.xxxx/…` DOIs already parsed into `url` and `doi` | the data path exists; it lacks validation and a report line |
| `SourceRow.url`, `SourceRow.doi` (migration `0001_content`, done) | the columns exist; no migration |
| `SourceRowView` (`lib/schemas/chapter.ts`, done) carries `url` and `doi` | the loader already passes them |
| `SourceRows` (unit 18) | the table that gains the column |
| The book: links in the `Link` column (§ 4), merged through the book's own process, then the release ingested | the only source of content (invariant 1, project-overview § Out of scope); this repository never writes a link |

Build order: 24a the pipeline half (§ 5: the Link column and the fallbacks with validation and tests, the ingest report's per-chapter `sourceRowsLinked / sourceRowsCitable` line, the `link` field on `SourceRowView`) → 24b the reader half (§ 6: the column, the tag, the strings, the class, ui-context § 9.9) → verification (§ 12) on the re-ingested book.

## 3. Routes and rendering

No new route. `/[lang]/ch/[n]/[n].9` renders the Sources table with the column (§ 6). Sections other than layer 9 render no source table today (`ReaderChapter` renders `SourceRows` only for `SOURCES`), and that stays. The search page's row hits (`kind: "row"`, spec 06) link to `#rN` in the chapter and gain nothing here. Still RSC, still the release cache: the link is a column of an immutable row.

Performance: no extra query; two fields already selected. The tag adds under 80 bytes per row to the RSC payload (10 to 20 rows per chapter).

## 4. The book convention (the half outside this repository)

Written here so the book's authors and the pipeline agree; it changes only with this spec.

1. **The book's format (amended 2026-09-23 to what the book did).** The `NN.9 Sources` table has a sixth column, `| # | Claim or figure | Source | Tier | Verified | Link |`. The **Link** cell holds the canonical URL of the cited document as a bare URL (`https://docs.temporal.io/`), a doi.org URL for a paper (`https://doi.org/10.1145/38713.38742`), `—` where there is nothing to open (illustrative, open, cross-reference rows), the repository path of the chapter's script on derived rows (`labs/ch21-control-plane/derive.py`), or free text such as `needs fetch` where the book has not found the URL yet. A markdown link `[text](https://…)` in the cell is read the same as a bare URL.
2. **Fallbacks.** Without a Link cell, or with an empty one, the pipeline reads the **Source** cell: a markdown link `[citation](https://…)`, a bare URL, or a DOI as `doi:10.1145/38713.38742` or the bare `10.1145/38713.38742`. A DOI is resolved through `https://doi.org/`; a doi.org URL is also recorded as the row's DOI. When both a URL and a DOI exist the URL wins and the DOI is kept as data.
3. One link per row: the Link cell first, then the first link in the Source cell; anything further is ignored (D2). A cell that names two sources (`Google SRE book, "Handling Overload"; AWS Architecture Blog on jitter`) should be split into two rows by the book.
4. Rows of tier `derived`, `illustrative` / `scenario` and `open` carry no web link (the derived row's repository path is not a link: the `ƒ` chips already open the script). A link on such a row is not an error; it renders like any other.
5. Only `http:` and `https:` targets are accepted. A cell whose value is a URL with another scheme (`javascript:`, `data:`, `ftp:`) or a malformed URL fails ingestion for that chapter with a named error (§ 5.1), because such a target in a content row would reach every reader. `—`, empty, `needs fetch`, a repository path and any other text without a scheme are simply "no link".
6. The pipeline reports, per chapter, how many citable rows (tiers primary / vendor / analyst / practitioner) carry a link (§ 5.2). That report is the list the book works from; nothing in this repository fills a link in.

Adding links changes each chapter's `contentHash` and the release's `renderHash`, so the book's links arrive as a new release id (feature-specs/04 § 6.7), never as an edit of `2026.09`.

## 5. Backend (24a)

### 5.1 Validation (`pipeline/parse/sources.ts`)

`parseSourceRows` keeps its extraction and adds the boundary check that today is missing:

- `url`: the first markdown link's target, else the first bare `https?://` token; parsed with `new URL()`; the protocol must be `http:` or `https:`; otherwise a `ParseError` names the chapter, the row and the target (`ch21 21.9 r3: source link must be http(s), got "javascript:"`), and ingestion of that chapter fails (or the chapter is skipped under `--skip-invalid`, like any other parse error). Trailing punctuation from the cell (`)`, `.`, `,`, `;`) is stripped from a bare URL.
- `doi`: the first `10.\d{4,9}/…` token, with a leading `doi:` or `https://doi.org/` prefix removed, kept as written otherwise (DOIs are case-insensitive; the resolver does not care).
- `citation`: unchanged (`plainText` already reduces `[text](url)` to `text`).

Unit tests (`sources.test.ts`): the three accepted forms, the link-wins-over-DOI rule, the first-of-two rule, the stripped trailing `)`, `doi:` and `https://doi.org/` prefixes, and the refusal of `javascript:`, `data:`, `ftp:` and a malformed URL.

### 5.2 The ingest report (`pipeline/report.ts`, `pipeline/build.ts`)

Per chapter: `sourceRowsCitable` (rows whose tier is primary, vendor, analyst or practitioner) and `sourceRowsLinked` (those with a `url` or `doi`); the release line adds `sources linked N/M` where M is the citable total. A chapter with `linked < citable` gets the warning `K citable source row(s) without a link` beside the existing ones. Informational: it never fails ingestion (the book decides when a row is linkable; some sources are books or private documents).

### 5.3 Data contract (`lib/schemas/chapter.ts`, `lib/db/content.ts`)

```ts
// SourceRowView gains one derived field; url and doi stay as stored
readonly link: { readonly href: string; readonly kind: "url" | "doi" } | null;
```

The loader computes it: `url` → `{ href: url, kind: "url" }`; else `doi` → `{ href: `https://doi.org/${doi}`, kind: "doi" }`; else `null`. The schema validates `href` with `z.url()` plus a refinement that the protocol is `http:` or `https:` (the same rule twice, at ingestion and at the loader's exit, code-standards § Validation: a row inserted by hand or by an older pipeline still cannot reach the page with a bad target). `url` on the view keeps `z.string().nullable()` as today; `link.href` is the validated one and the only one a component reads.

`ChapterData` also gains, on the layer-9 section only, `hasSourceLinks: boolean` (true when any row's `link` is not null), so the table knows whether to render the column at all (§ 6.4, D4). No change to `ChapterVersion` counters (`citedTotal` and friends stay as they are).

## 6. Layout and components (24b)

### 6.1 The column

`SourceRows` renders, when `hasSourceLinks` is true, a sixth column between `source` and `tier`:

```
#     claim or figure                       source                                  link   tier   verified
r4    Sagas and compensation                Garcia-Molina & Salem, "Sagas," …      [link] pri    Sep 2026
r8    Compounding failure rates; …          labs/ch21-control-plane/derive.py              ƒ      Sep 2026
r10   Resume correctness and duplicate …    None found                                     opn    Sep 2026
```

Header `link` in the table's mono lowercase header style like the others. The cell holds the tag or nothing. The column is as narrow as the tag (`white-space: nowrap`, no fixed width: the PT header is also `link`).

The citation cell loses today's behaviour of wrapping the whole citation in `a.xref` when a URL exists: the citation is plain text in every case, and the link lives in its column (the user's ask, and ui-context § 5.2: `.xref` is a cross-reference into the book, not an outbound link).

### 6.2 The tag (`.src-link`)

```html
<a class="src-link" href="https://…" target="_blank" rel="noopener noreferrer"
   aria-label="Open the source of row r4 in a new tab: Garcia-Molina & Salem, "Sagas," SIGMOD 1987">link</a>
```

- The visible text is the word `link` for `kind: "url"` and `doi` for `kind: "doi"` (D3): a word, not a glyph. ui-context § 13.4 has no outbound-link glyph, and a word localises, reads aloud and needs no explanation.
- Form: the `.derive` chip's form in the traversal colour, 18px tall, 1px `--ver` border, `--ver` text, mono 10.5px, `vertical-align: 2px`, no underline; hover and focus fill with `--ver-bg` (ui-context § 9.10, the same rule as `.derive:hover`). The row hover on `--sel` comes for free (`.tbl tbody tr:has(a):hover td`).
- `target="_blank"` with `rel="noopener noreferrer"` (D5): the reader keeps their place in the chapter, the opened page gets no `window.opener`, and `Referrer-Policy: strict-origin-when-cross-origin` (spec 09 § 7.2) already limits what it learns. The accessible name says "in a new tab" because the visible tag does not.
- The tag is the only anchor in the row, so the row's `:has(a)` hover applies exactly to linked rows.

### 6.3 Class (`globals.css` `@layer components`, then ui-context § 9.9)

One class, in the reader-chapter block:

```css
.src-link { display: inline-flex; align-items: center; height: 18px; padding: 0 5px; border: 1px solid var(--ver); color: var(--ver); font-family: var(--mono); font-size: 10.5px; vertical-align: 2px; white-space: nowrap; text-decoration: none; }
```

plus `.src-link:hover, .src-link:focus-visible { background: var(--ver-bg); }` beside the `.derive:hover` rule of § 9.10. Touch: the `pointer: coarse` block lifts only buttons and segments to 44px today; inline chips (`.derive`, `.xref`) are not in it, and the tag follows the same convention as `.derive` (an 18px inline target inside a 9px-padded table cell, the row being the practical touch area). WCAG 2.5.8's 24px minimum is met by the cell; the 44px touch rule is a reader-wide question for the inline marks, recorded in Open Questions rather than solved for one tag.

### 6.4 Empty and partial states

- No row of the chapter has a link (every chapter today): the column is not rendered; the table is exactly today's five columns. The ingest report, not the page, carries the gap (D4).
- Some rows have links: the column renders; unlinked cells are empty, with no dash and no placeholder. A derived row's `ƒ` stays in the tier column as today.
- A row whose stored `url` fails the loader's validation (should not happen after 24a; possible with hand-inserted rows): `link` is `null`, the cell is empty, and the loader logs one line naming the row (code-standards: a defect is logged, not rendered).

### 6.5 Responsive

Nothing new: the table sits in `.scroll` at `max-width: 680` and scrolls horizontally on phones; the tag adds one narrow column. At 390px the header row still shows `#`, `claim or figure`, `source`, `link` before the scroll. At 1440px the column adds roughly 48px to the table.

### 6.6 Status bar

Unchanged.

## 7. States

| State | Rendering |
|---|---|
| Linked row (url) | tag `link`; row hover `--sel`; tag hover and focus `--ver-bg`; focus ring per base layer |
| Linked row (doi) | tag `doi`; same behaviour; `href` is `https://doi.org/<doi>` |
| Unlinked row in a chapter with links | empty cell |
| Chapter without links | no column |
| Invalid stored target | empty cell, one server log line |

## 8. Strings (`messages/en.json` and `pt.json`, `reader.sources.*`)

| Key | EN | PT |
|---|---|---|
| `reader.sources.link` | `link` (the column header and the url tag) | `link` *(candidate: the loanword is the everyday pt-BR term; `ligação` would be Portugal usage)* |
| `reader.sources.doi` | `doi` | `doi` |
| `reader.sources.linkLabel` | `Open the source of row r{ordinal} in a new tab: {citation}` | `Abrir a fonte da linha r{ordinal} em uma nova aba: {citation}` *(candidate)* |

No other string changes. The PT strings are marked candidate per the tracker's open item on PT review; the PT truncation rule (30 % longer) is satisfied trivially by the header (`link` = `link`, a fixed-width tag) and by `linkLabel` being an accessible name, not a laid-out label.

## 9. Keyboard, accessibility

- The tag is a real anchor: `Tab` reaches it in table order, `Enter` opens the source in a new tab, the focus ring is the base layer's 2px `--focus`.
- `aria-label` carries the citation and "in a new tab"; the visible text alone (`link`) would be an ambiguous link name under WCAG 2.4.4, and rows repeat it.
- Contrast: `--ver` on `--surface` and on `--ver-bg` are both above 4.5:1 (ui-context § 2, the `.derive` chip already passes axe).
- No keyboard-map key: the tag is not a reader action.

## 10. Out of scope for this unit

- Filling links in: the book's process (§ 4), never this repository, never a model, never a web search at ingestion.
- Link checking (a fetch that verifies the target answers 200) and archived copies: the book's VERIFY pass owns source freshness; the Phase 4 evidence fetcher owns link grading (`U` on a 404, ui-context Components.html).
- Links in the search page's row hits, in peeks of a source row, and in the in-prose `21.9 r4` chips: all stay as they are (they point at the row; the row carries the tag).
- A `SOURCES.md`-keyed registry of canonical URLs joined at ingestion (D1, rejected below).
- An external-link glyph (`↗`) as the tag (D3, rejected).

## 11. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | Where a link lives | A the row's Source cell in the book, parsed as today / B a canonical URL per source key in the book's `SOURCES.md`, joined at ingestion / C a registry file in this repository | **A**: the parser exists, the link sits beside the citation it belongs to, and no join by fuzzy source key is needed; C would put content outside the book (project-overview § Out of scope, invariant 1) |
| D2 | A cell with two sources | A first link wins, the book splits the row / B render two tags | **A**: one row, one source, one tag; two tags in one cell would need a second accessible name and the book's own rule is one source per row |
| D3 | The tag's form | A the word `link` / `doi` in the `.derive` chip form / B a glyph `↗` / C an inline 12px stroke SVG icon | **A**: § 13.4 has no outbound-link glyph, a word localises and is its own accessible text; B and C add a pictogram the guide does not have and still need `aria-label` |
| D4 | A chapter with no linked rows | A hide the column / B render it empty | **A**: 41 empty columns until the book catches up would read as a defect; the ingest report shows the gap to the people who can close it |
| D5 | Open in the same tab or a new one | A new tab, `noopener noreferrer` / B same tab | **A**: the reader keeps their place (the peek principle) and the outbound page gets no opener |
| D6 | DOI resolution | A `https://doi.org/<doi>` computed in the loader / B the book writes the full URL | **A**: the resolver is the DOI system's own; the book keeps the short, stable form; a full URL in the cell still wins (§ 4.2) |
| D7 | Column position | A between `source` and `tier` / B last | **A**: the tag belongs to the citation it opens; `tier` and `verified` describe the claim's standing, not the document |

All seven were built as recommended on 2026-09-23. D1 was settled by the book itself the same day: the links live in the book, in a sixth `Link` column rather than inside the Source cell (§ 4 amended; the Source-cell forms remain as fallbacks). Andre to confirm D2–D7.

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

Written before the book carried links; run on 2026-09-23 against the re-ingested book instead (the results are in the tracker's Completed entry for unit 24). The scratch-copy procedure below stays for a book state without links: copy `bible/` to a folder outside the repositories, edit `ch21`'s 21.9 rows, ingest that copy under a test release id, reset afterwards. Never edit `bible/` itself (rules § 2.7).

1. `sources.test.ts`: every case of § 5.1 passes; a `javascript:` target throws a `ParseError` naming `21.9 r3`.
2. `npm run ingest -- --dry-run` on the scratch copy prints `sources linked 3/7` for chapter 21 and the warning `4 citable source row(s) without a link`; on the real book it prints `0/N` for every chapter and no error.
3. `/en/ch/21/21.9` on the scratch release: six columns, header `link`; r1 shows the tag `link` with `href="https://docs.temporal.io/…"`, r4 shows `doi` with `href="https://doi.org/10.1145/38713.38742"`, r5 shows `link` with the trailing `)` stripped; r2, r3, r6, r7 empty cells; r8 (derived) empty cell with `ƒ` in the tier column; r9, r10 empty cells; the citation text of every row is plain (no `a.xref` in the table).
4. Every tag has `target="_blank"`, `rel="noopener noreferrer"` and an `aria-label` that contains the citation and "new tab"; `Tab` reaches the tags in row order; `Enter` opens a new tab and the chapter page keeps its scroll position.
5. Hover on a linked row fills the row with `--sel` and the tag with `--ver-bg`; an unlinked row does not change.
6. `/en/ch/21/21.9` on release `2026.09` (no links): five columns, byte-identical to before the unit except for the removed `a.xref` wrap, which had no effect on this release.
7. `/pt/ch/21/21.9` on the scratch release: header `link`, tags `link` and `doi`, `aria-label` in PT; no overflow at 390px and 1440px.
8. axe: zero WCAG 2.2 AA violations on `/en/ch/21/21.9` and `/pt/ch/21/21.9` with the column.
9. Token grep clean; the one new class and its hover rule are in `globals.css` and ui-context § 9.9; message parity holds.
10. Invariant check: no write to a content table outside `PIPELINE=1` (grep); `bible/` unchanged (`git status` in the book checkout, if it is a repository, or a file diff against the copy).
