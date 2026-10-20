# 03 · Reader Chapter — frontend spec

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for this screen: `docs/design/screens/Reader-Chapter.html` (desktop, 1440) and `docs/design/screens/Mobile-Reader-PT.html` (phone, 390, Portuguese), with their PNGs. Governing context: `context/ui-context.md` (§ 5 provenance marks, § 8 instrument panel, § 9.3 tables, § 9.5 code panes, § 9.8 chrome and peek, § 9.10 interaction states, § 10 layout, § 11 parity, § 12 keyboard map), `context/architecture.md` (§ 3.2 route map, § 4.2 data model, § 11 invariants 1–5), `context/code-standards.md`. PRD Capability 1: navigation by part, chapter and layer; every cross-reference opens in place or in a side panel; every derived number links to its derive line; every cited figure links to its source row; every illustrative figure is visibly labelled; each chapter shows version, verification date, VERIFY/REDTEAM status and a link to its history. TRD § 2.3 Reader components: outline resolver, section renderer (Mermaid, code, chips), cross-reference resolver (peek), derive-link resolver, edition switch.

Prerequisite spec: `02-book-home.md` (chrome, i18n, fixture pattern, tile links point here).

## 1. Purpose

The reading view for one section of one chapter at `/[lang]/ch/[n]/[section]`: the chapter's outline on the left, the section's prose with provenance on every figure in the middle, and the chapter's instrument on the right. Cross-references open a peek panel beside the text; derive chips open the derive script at the line; the section's figures are listed with their tiers; the actions for this section (run the lab, ask, suggest) sit in the rail. Everything rendered comes from the release rows.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| 02-book-home (done): chrome, i18n, `lib/i18n/format.ts`, fixture pattern, `getHomeData` | this page reuses the chrome and the loader shape |
| Unit 9 · `pipeline/parse/` | section bodies as pre-rendered HTML with the provenance vocabulary (§ 4.2); until it exists, a fixture for chapter 21 section 21.3 reproduces the screen (§ 11 D1) |
| Unit 12 · `lib/db/content.ts` | `getChapterVersion(n, lang)`, `getSection(id, lang)`, `getDeriveLink(figureId)` |
| Unit 18 · intercepting route `(.)ref/[id]` | the peek panel (§ 6.8); specified here, shippable as its own unit |
| Keyboard map hook (`lib/hooks/useKeyboardMap.ts`) | `j k [ ] g l a esc ?` (§ 9); new in this spec |

Reading-path progress in the outline needs the accounts domain; render it only when a session exists (§ 7).

## 3. Routes and rendering

| Route | Behaviour |
|---|---|
| `/[lang]/ch/[n]` | redirects to `/[lang]/ch/[n]/[n].1` (§ 11 D4); `n` is two digits, `00`–`40` |
| `/[lang]/ch/[n]/[section]` | the reader; `section` is a `SectionId` (`21.3`); a section that does not exist at the current release is a 404 |
| `/[lang]/ch/[n]/[section]/(.)ref/[id]` | intercepting route rendering the peek panel over the same page (unit 18); `id` is a `SectionId`, `ch{n}` or `lab{n}` |
| `/[lang]/ref/[id]` | the same target rendered in place (a hard navigation to the target section or lab) |

Rendering: React Server Component, static per release (`generateStaticParams` over every section of every chapter in the release once the database exists; dynamic against the fixture). Cached by release with tag `release:${id}` in unit 12. Client components: `Outline` progress meter (no), `CopyButton`, `PeekPanel` (dialog behaviour), `KeyboardMap`, `LangToggle`, `SearchBox`. The page file has no logic: parse params, call `getChapterData(locale, n, sectionId, userId)`, render.

Metadata: title `21.3 Worked numbers · Chapter 21 · The Harness Bible`; `alternates.languages`; `description` = the chapter standfirst.

Performance: chapter load under 1 s p95; RSC payload under 150 KB (TRD § 5.4). One query for chapter + sections + figures + source rows; the section body is pre-rendered HTML, never markdown parsed at request time (invariant, code-standards § Next.js).

## 4. Data contract

```ts
interface ChapterData {
  readonly release: { id: ReleaseId; gitSha: string };
  readonly chapter: {
    readonly number: ChapterNumber;
    readonly part: "P0" | "P1" | "P2" | "P3";
    readonly title: string;                  // in the requested edition
    readonly standfirst: string;             // one sentence under the title
    readonly version: string;                // "v1.5.0"
    readonly sourceLang: Lang;               // "EN"
    readonly editionLang: Lang;              // the edition actually rendered (§ 7, PT fallback)
    readonly verify: VerifyStatus;
    readonly redteam: VerifyStatus;
    readonly redteamOpen: number;
    readonly verifiedAt: Date | null;
    readonly contentHash: string;            // render check; first 8 shown as #c41e·07b2
    readonly words: number;
    readonly derivedFigures: { linked: number; total: number };
    readonly citedFigures: { total: number; fastMoving: number };
    readonly oldestCheckDays: number | null; // max age of any source row
    readonly historyCount: number;           // merged improvements; 0 until the ledger exists
    readonly lab: { id: string; verdict: "REPRODUCED" | "NOT_REPRODUCED" | "KILLED" | "ERROR"; lastRunAt: Date | null; lastRunBy: "ci" | "user"; expectedRuntimeS: number } | null;
  };
  readonly outline: {
    readonly partTitleKey: "P0" | "P1" | "P2" | "P3";
    readonly range: { from: ChapterNumber; to: ChapterNumber; count: number };
    readonly neighbours: ReadonlyArray<{ number: ChapterNumber; title: string; href: string }>; // the window shown: 2 before, this, 5 after (§ 6.1)
    readonly layers: ReadonlyArray<{ id: SectionId; ordinal: number; title: string; href: string }>; // the nine
  };
  readonly section: {
    readonly id: SectionId;
    readonly ordinal: number;                // 1..9
    readonly layer: Layer;                   // INTUITION … SOURCES
    readonly title: string;
    readonly bodyHtml: string;               // pre-rendered, sanitised, with the § 4.2 vocabulary
    readonly figures: ReadonlyArray<SectionFigure>;
    readonly sourceRows: ReadonlyArray<SourceRowView>;   // only for layer 9, or rows cited in this section
    readonly prev: { id: SectionId; href: string } | null;
    readonly next: { id: SectionId; href: string } | null;
    readonly codeBlocks: ReadonlyArray<CodeBlockView>;   // metadata for the panes in bodyHtml (§ 6.6)
  };
  readonly progress: { path: "executive" | "builder" | "foundations"; done: number; total: number } | null;
}

interface SectionFigure {
  readonly id: FigureId | null;            // null for scenario parameters shown as "scenario"
  readonly label: string;                  // "interrupted / day"
  readonly valueText: string;              // "86", "0.4%", "1 s" — formatted per edition by the pipeline
  readonly tier: SourceTier | "SCENARIO";
  readonly derive: { labId: string; filePath: string; line: number; key: string } | null;
  readonly sourceRowId: SourceRowId | null;
  readonly fastMoving: boolean;
  readonly ageDays: number | null;         // for cited fast-moving figures
}

interface SourceRowView {
  readonly id: SourceRowId;                // "21.9 r4"
  readonly ordinal: number;
  readonly citation: string;
  readonly url: string | null;
  readonly doi: string | null;
  readonly tier: SourceTier;
  readonly verifiedAt: Date;
  readonly fastMoving: boolean;
  readonly stale: boolean;                 // fastMoving && age > 90 d
}

interface CodeBlockView {
  readonly index: number;                  // order in bodyHtml
  readonly file: string | null;            // "lab-21/derive.py" when the block is lab code
  readonly lines: { from: number; to: number } | null;
  readonly language: string;               // "python", "text"
  readonly labHref: string | null;         // "Open in Labs" target when file !== null
}
```

Sources (TRD § 4.2): `ChapterVersion` for chapter fields; `Section` rows for outline layers and the body (`bodyEn`/`bodyPt`); `Figure` + `DeriveLink` + `SourceRow` for figures; `CrossReference` for peek targets; `Lab` for the lab block; `ReadingPathProgress` for `progress`. `words`, `derivedFigures`, `citedFigures`, `oldestCheckDays` are computed by the pipeline at ingestion and stored on `ChapterVersion` (§ 11 D3).

Loader: `getChapterData(locale, n, sectionId, userId): Promise<ChapterData>` in `lib/db/content.ts`. Fixture path (§ 11 D1): `lib/fixtures/chapter21.ts` with section 21.3 exactly as the screen, the other eight sections with their real titles and a body of one paragraph each taken from `bible/book/part2/ch21-…md`.

### 4.2 Section body vocabulary

`bodyHtml` is HTML the pipeline produced once at ingestion. The reader renders it inside `SectionBody` with `dangerouslySetInnerHTML` (the one permitted use, code-standards § React) after sanitisation with an allow-list of exactly these elements and classes:

| Element | Purpose |
|---|---|
| `<p>`, `<h3>`, `<ul>`, `<ol>`, `<li>`, `<em>`, `<strong>`, `<code>`, `<br>` | prose; `<h3>` for the chapter's own sub-headings inside a layer (chapter 21 has 25 of them in 21.2) |
| `<table class="tbl">` with `thead`, `tbody`, `th`, `td`, `td.n` | markdown tables (failure tables in layer 5, decision aids in layer 8) |
| `<span class="fig-ill">…</span>` | an illustrative figure in prose, followed by its chip |
| `<span class="fig-der">…</span>` | a derived figure in prose, followed by its derive chip |
| `<span class="chip t-pri|t-ven|t-anl|t-pra|t-ill|t-der|t-opn"><i>abbr</i> label</span>` | source-tier chip; `label` may be a locator `21.9 r4` |
| `<a class="derive" href="/[lang]/labs/lab-21/derive.py#L38" data-figure="F-21-03" title="derive.py line 38">ƒ L38</a>` | derive link |
| `<a class="xref" href="/[lang]/ref/21.9" data-ref="21.9">26.3</a>` | cross-reference; the peek intercepts it |
| `<a class="src" href="#r4" data-row="21.9 r4">r4</a>` | link to a source row of the same chapter |
| `<figure class="fig" data-figure="F-21-03">` with an inline `<svg>` (Mermaid rendered at ingestion), a `<figcaption>` and an `<img alt>`-equivalent text alternative | figures (§ 6.5) |
| `<div class="code" data-block="0">` with `.code-h`, `.code-b`, `.ln[data-n]`, `.k .s .c .fn`, `.hl` | code panes (§ 6.6); the reader injects the buttons |

Anything else is stripped. Chip abbreviations and labels are localised by the pipeline per edition (`ill illustrative` / `ilu ilustrativo`, `ven vendor` / `ven fornecedor`, `derive.py line 38` / `derive.py linha 38`), so `bodyHtml` differs per edition while figure values are identical (invariant 4).

## 5. Layout

Desktop: chrome above and below; the body is a grid `280px minmax(0,1fr) 344px`, `min-height: 0`.

```
┌ topbar (Book current) ──────────────────────────────────────────────────────┐
│ outline 280      │ reading column                          │ rail 344         │
│ part · range     │ cap: chapter 21 · part ii · source EN   │ Chapter 21 inst  │
│ chapters 19–26   │ h1 title (max 720)                      │  verify/redteam  │
│  21 ▸ nine layers│ standfirst (max 680)                    │  lab · kv list   │
│ reading path     │ ── 21.3 / Worked numbers   layer 3 of 9 │ Figures in 21.3  │
│ keys             │ prose (680) with chips                  │ from this section│
│                  │ figure · code pane                      │ render check     │
│                  │        [peek panel, 380, floats here]   │                  │
├ statusbar: ch21 · 21.3 worked numbers │ EN · source EN │ pinned release │ loaded 0.41 s ┤
```

- Outline `aside.rr`: `padding: 20px 20px 20px 24px`, column, gap 18.
- Reading `main`: `padding: 36px 56px 40px 64px`, column, gap 28, `position: relative` (peek anchor). Prose and figures `max-width: 680px`; h1 `max-width: 720px`.
- Rail `aside.rl`: `padding: 24px 24px 24px 20px`, column, gap 18.
- Section head: `.rt-s` top rule, `padding-top: 18px`; `.between` with `.meta` id + `.h2` title, and `.cap` `layer N of 9`.
- Responsive: ≥ 1000 three columns; 768–999 two columns (outline 240 + reading; the rail's instruments move below the prose in the reading column, in the same order); < 768 the phone layout (§ 6.10): compact top bar, source-language band, one-strip chapter instrument, prose at 16/27, bottom action bar; the outline becomes the `Sumário` sheet. Nothing truncates; the outline's chapter titles wrap.

## 6. Components

All under `components/reader/` unless stated. Server components except where marked. Class names are hb.css names in `globals.css`; new composition classes are listed in § 6.11 and go into `globals.css` and `ui-context.md` § 9.9 in the same unit.

### 6.1 `Outline` (aside)

- `.cap` `part {roman} · {part title}`; `.between` `.h4` `Chapters {from}–{to}` / `.meta` `{count}`.
- `ul.outline` of `neighbours`: each `li > a` with `.n` number and title; the current chapter's link has `aria-current="page"` and expands a nested `ul.col.rl` (margin `4px 0 8px 12px`, padding-left 12) of the nine layers, each `a` with `.n` `21.1` and the layer title; the current section has `aria-current="location"`. The window is the two chapters before and the five after within the part (clamped at the part's edges); the whole part is one scroll away via the Book Home link in the brand.
- `.rt` block `reading path`: `.between.small` `{Path}` / `.meta` `{done} of {total}` and a `Meter`; rendered only when `progress !== null`.
- `.rt` block `keys`: three rows of `Kbd` pairs: `j` `k` next / previous section; `g` `l` open lab; `a` ask about this section.

### 6.2 `ChapterHeader`

`.row` of two `.cap`s separated by `·`: `chapter {n} · part {roman}` and `source language {src} · {edition} edition at parity` (or the fallback text of § 7 when the edition is not at parity); `.h1` title; `.muted` standfirst at 17/26.

### 6.3 `SectionHead`

`.between` inside the `.rt-s` section: `.row` with `.meta` `{id}` and `.h2` `{title}`; right `.cap` `layer {ordinal} of 9`.

### 6.4 `SectionBody`

Renders `bodyHtml` inside `div.prose`. After hydration, `CodeBlockActions` (client) injects the Copy and Open in Labs buttons into each `.code-h` (§ 6.6) and `PeekTrigger` (client) intercepts clicks on `a.xref` to open the peek without a full navigation (§ 6.8). Nothing else touches the HTML.

### 6.5 `MermaidFigure` (inside the body)

`figure.fig.box` with `background: var(--surface)`, `max-width: 680px`; header `.inst-h` with `.t` `Figure {n}.{k}` · `mermaid · rendered` · `.ts` `alt text available`; the SVG from the release, token colours only; `figcaption.small.muted.rt` at `padding: 10px 14px`. The text alternative (numbers and source tier) is in the SVG `<title>`/`<desc>` and mirrored in a visually hidden `<p>` (`sr-only`).

### 6.6 `CodeBlock` (inside the body) and `CodeBlockActions` (client)

`.code` with `.code-h`: file name, `.faint` `· lines {from}–{to} · python 3.12` (language from the block), a `.grow`, then the injected `Button size="sm" variant="quiet"` `Copy` (aria-label "Copy code"; copies the raw text stored in a `<template>` the pipeline emits) and, when `file !== null`, `Button size="sm" href={labHref}` `Open in Labs`. `.code-b` with `.ln[data-n]`; lines referenced by a derive chip carry `.hl`. Copy shows `copied` in the status bar line for 3 s (a status line, not a toast; ui-context § 11).

### 6.7 `ChapterInstrument` (rail)

`InstrumentPanel` label `Chapter {n}` · `{version}` · `.ts` `verified {date}`:
- `.between` `.flabel` `verify` / `StatusMark` `passed` (ok) or `failed` (fail) or `unverified` (mute);
- `.between` `.flabel` `redteam` / `StatusMark` `passed · {open} open` (ok when 0 open, warn when > 0);
- `.between` `.flabel` `lab {n}` / `StatusBlock` `reproduced` | `not reproduced` | `killed` | `no lab` (mute);
- `dl.kv.rt` (padding-top 12): `last lab run` `{ci|user} · {dd MMM HH:mm}`; `derived figures` `{linked} / {total} linked`; `cited figures` `{total} · {fastMoving} fast-moving`; `oldest check` `{days} days`; `words` `{n, number}`;
- footer: `Xref` `improvement history · {historyCount}` → `/[lang]/ch/{n}/history` (renders only when `historyCount > 0` or the history route exists), right `.tex` `#{hash[0..4]}·{hash[4..8]}`.

### 6.8 `PeekPanel` (client dialog; route in unit 18)

`div.peek` `role="dialog"` `aria-label="Peek: section 26.3"`, width 380, absolutely positioned in the reading column: `left` = the xref's left clamped so the panel stays inside the column, `top` = the xref's bottom + 8. Header `.inst-h`: `.t` `Peek · {id}` · `{version}` · `.ts` `Kbd esc`. Body (padding 14 16, gap 10): `.cap` `{chapter title} · {layer}`; the target section's first paragraph as `.small` at 20px line-height (from `getSection`, `bodyHtml` trimmed to the first `<p>`, chips kept); `StatusMark ok` `verified {date}`. Footer `.inst-f` `justify-between`: `Xref` `open in place` (navigates to the target section) and `Xref` `open side by side` (out of scope for this unit; render disabled with `aria-disabled` and the tooltip candidate "arrives with the assistant dock", § 10).

Behaviour: opens on click of any `a.xref` (or Enter on it); `esc` closes; clicking outside closes; focus moves to the panel on open and returns to the link on close; only one peek at a time; a peek for `lab21` shows the lab README's first paragraph and `open in place` targets the lab. The intercepting route makes the URL `/[lang]/ch/21/21.3/ref/26.3` shareable and back-button friendly.

### 6.9 `FiguresTable`, `SectionActions`, `RenderCheck` (rail)

- `FiguresTable`: `InstrumentPanel` label `Figures in {id}` · `.ts` `{count}`, body bare: `table.tbl` at 12.5px with columns `figure` | `value` (`.n`) | `tier`; tier cell is a `Chip` (abbr only, `ƒ der` for derived) or `.meta` `scenario`; a fast-moving cited row older than 90 d shows `StatusBlock warn .sb-sm` `stale {days} d` after the chip. Rows link: clicking a row scrolls to and briefly highlights the figure in prose (`.fig-*` gets `.sel` background for 1.5 s; no animation).
- `SectionActions`: `.cap` `from this section`; three full-width `Button`s with `justify-content: space-between`: `Run Lab {n}` + `.meta` `~ {runtime} min` (href `/[lang]/ch/{n}/@lab`, or omitted when `lab === null`); `Ask about {id}` + `Kbd a` (href `/[lang]/ch/{n}/{id}/@assistant`); `Suggest a change` + `.meta` `anchor {id}` (href `/[lang]/ch/{n}/@improve/new?anchor={id}`). The targets 404 until their phases; the buttons render anyway (02 § 10 pattern).
- `RenderCheck`: `.rt` block `.cap` `render check`; `.meta` `content hash matches release {id}` (or `.meta.text-fail` `content hash differs from release {id}` when the loader reports a mismatch); no base64 stub.

### 6.10 Phone layout (< 768 px), from Mobile-Reader-PT

- Compact `.topbar`: brand only (no `interactive`, `aria-label` "Harness Bible, home"), `.grow`, the `LangToggle` at 44px targets.
- `SourceLangBand`: `.band.rb` (padding 8 16, wrap): `.cap` `source language: {src} · {edition} edition at parity` and `Xref` `see original in {src}` (only when edition ≠ source).
- `ChapterStrip`: `.rb-s` (padding 10 16, wrap, gap 6 12) `aria-label="Chapter {n} instrument"`: `.label` `Ch. {n}`, `.meta` `{version}`, `.meta` `verified {date}`, `.row` `.meta` `Lab {n}` + `StatusBlock` verdict.
- Header at padding 20 16 0: `.cap` `chapter {n} · part {roman} · {part title}`, `h1.h2`, `.muted` standfirst at 15/23.
- Section at margin 20 16 0, `.rt-s`, padding-top 14: head with `.h3` title; `.prose` at 16/27.
- `BottomActionBar` (`nav.rt-s.action-bar.action-bar-three`, three-column grid, `flex: none`): `Sumário`-style button (`aria-haspopup="dialog"`) with `.ui` label and `.cap` `{id} of {n}.9`, opens the outline as a sheet; the bookmark cell (below); primary button (`--act` fill) `Ask about {id}` with `.mono` 11px `answers cite the {edition} edition`, opens the assistant sheet (later phase; 404 route until then). Every cell min-height 60, and each wraps its label rather than truncating it (the bar is 101px tall at 320px in PT).
- The bookmark cell (added 2026-09-24 on Andre's answer “agree, add the button”) is the phone's only way to mark a section, because the rail that carries `MarkActions` is hidden here. Signed in it is a `button.mark-btn` with `aria-pressed`, `aria-label` `reader.marks.bookmarkLabel`, the labels `reader.marks.bookmark` / `.bookmarked` and the `.mark-square` before the pressed one, so the state is a word and a mark, never colour; it calls the same `toggleBookmark` server action as the rail, optimistically, confirms from the result and reverts on a failure with the message in the cell's second line (`role="status"`, cleared after 6 s) — feature-specs/07 § 5.3, § 6.1. That message is a sibling of the button inside the cell, never a child of it: inside the button it would join the accessible name the `aria-label` fixes, and no `aria-describedby` could reach it, so the button points at it by id while it is shown, as `MarkActions` does (review of unit 37, 2026-09-24). Signed out it is a link to `/[lang]/login?next=` labelled `reader.marks.bookmark` with `.cap` `reader.marks.error.noSession`, so the cell leads to sign-in rather than failing. Key `b` reaches the visible control through the bridge of 07 § 9, which under 768px is this one. The note editor stays off the phone: the answer covered the button alone (tracker, Open Questions).
- No rail; the instrument values are reachable from the strip; the figures table is omitted on phones (screen decision, recorded).

### 6.11 New composition classes

| Class | Rule |
|---|---|
| `.reader` | `display: grid; grid-template-columns: 280px minmax(0,1fr) 344px; min-height: 0; flex: 1 1 auto` |
| `.reader-outline` | `padding: 20px 20px 20px 24px; display: flex; flex-direction: column; gap: 18px` |
| `.reader-main` | `padding: 36px 56px 40px 64px; display: flex; flex-direction: column; gap: 28px; position: relative` |
| `.reader-rail` | `padding: 24px 24px 24px 20px; display: flex; flex-direction: column; gap: 18px` |
| `.reader-title` | `max-width: 720px` |
| `.standfirst` | `font-size: 17px; line-height: 26px; max-width: 680px` |
| `.section-head` | `.between; max-width: 680px` |
| `.fig` | figure frame per § 6.5 |
| `.peek-float` | `position: absolute; width: 380px` |
| `.actions-list .btn` | `justify-content: space-between; width: 100%` |
| `.band-source`, `.chapter-strip`, `.action-bar`, `.action-bar-primary` | phone pieces per § 6.10 |
| `.outline-layers` | the nested layer list: `margin: 4px 0 8px 12px; padding-left: 12px; border-left: 1px solid var(--rule)` |
| `@media (max-width: 999px)` | `.reader { grid-template-columns: 240px minmax(0,1fr) }`; `.reader-rail { grid-column: 2; border-left: 0; padding-left: 64px }` |
| `@media (max-width: 767px)` | `.reader { grid-template-columns: minmax(0,1fr) }`; outline and rail hidden; phone pieces shown |

## 7. States

| State | Render |
|---|---|
| Section not found at the release | 404 (`notFound()`); the `[lang]` not-found page (new, minimal: `Empty` with `Section {id} is not in release {release}` candidate and a link to the chapter's first section) |
| Chapter unverified (`verify !== PASSED`) | instrument shows `unverified` (mute); a `Notice` above the prose: `Unverified` / `This chapter changed after its last verification run. Figures may not match the labs.` (candidate) |
| Redteam findings open | `redteam` row `passed · {n} open` in warn |
| No lab | `lab` row `no lab` (mute); `Run Lab` button omitted; `last lab run` row omitted |
| Lab not reproduced | `StatusBlock fail` `not reproduced`; `last lab run` shows the failing run |
| Stale cited figure in this section | the figures table row carries `stale {days} d`; a `Notice` under the section head: `Stale > 90 d` / `{k} figure(s) in this section were last checked more than 90 days ago. They still show; treat them as dated.` (candidate) |
| Requested edition not at parity (PT body missing) | render the source-language body; header cap says `source language en · pt edition pending` (candidate) and the phone band shows `see original in EN`; status bar `PT · source EN` (§ 11 D6) |
| Signed out | no reading-path block in the outline |
| First / last section | `prev` / `next` null: `k` / `j` do nothing; `[` `]` still move chapters |
| Peek target unavailable (id not in release) | the peek shows `Empty` `Not in this release.` (candidate) and only `esc` |
| Loading | `loading.tsx`: chrome + `Loader` `loading chapter {n}` (candidate) |
| Error | `error.tsx` as in 02 § 7 |

## 8. Strings

Keys under `reader.*` in `messages/en.json` and `pt.json`. PT values marked *candidate* need confirmation; the rest come from Mobile-Reader-PT.html.

| Key | EN | PT |
|---|---|---|
| `reader.metaTitle` | {section} {title} · Chapter {n} · The Harness Bible | {section} {title} · Capítulo {n} · The Harness Bible *(candidate)* |
| `reader.outline.label` | Book outline | Sumário do livro *(candidate)* |
| `reader.outline.range` | Chapters {from}–{to} | Capítulos {from}–{to} *(candidate)* |
| `reader.outline.path` | reading path | trilha de leitura *(candidate)* |
| `reader.outline.keys` | keys | teclas *(candidate)* |
| `reader.keys.section` | next / previous section | seção seguinte / anterior *(candidate)* |
| `reader.keys.lab` | open lab | abrir lab *(candidate)* |
| `reader.keys.ask` | ask about this section | perguntar sobre esta seção *(candidate)* |
| `reader.header.cap` | chapter {n} · part {roman} | capítulo {n} · parte {roman} |
| `reader.header.source` | source language {src} · {edition} edition at parity | idioma de origem: {src} · edição {edition} em paridade |
| `reader.header.sourcePending` | source language {src} · {edition} edition pending | idioma de origem: {src} · edição {edition} pendente *(candidate)* |
| `reader.header.original` | see original in {src} | ver original em {src} |
| `reader.section.layer` | layer {n} of 9 | camada {n} de 9 |
| `reader.layer.1` … `9` | Intuition · Mechanism · Worked numbers · Measurement · Failure · Frontier · Industrial application · Decision aids · Sources | Intuição · Mecanismo · Números resolvidos · Medição · Falha · Fronteira · Aplicação industrial · Auxílios de decisão · Fontes *(candidates except "Números resolvidos")* |
| `reader.figure.label` | Figure {id} | Figura {id} *(candidate)* |
| `reader.figure.rendered` | mermaid · rendered | mermaid · renderizado *(candidate)* |
| `reader.figure.alt` | alt text available | texto alternativo disponível *(candidate)* |
| `reader.code.copy` / `copyLabel` / `copied` | Copy / Copy code / copied | Copiar / Copiar código / copiado *(candidate)* |
| `reader.code.open` | Open in Labs | Abrir no Labs *(candidate)* |
| `reader.code.lines` | · lines {from}–{to} · {lang} | · linhas {from}–{to} · {lang} *(candidate)* |
| `reader.inst.label` | Chapter {n} | Capítulo {n} *(candidate; strip uses "Cap. {n}")* |
| `reader.inst.verified` | verified {date} | verificado {date} |
| `reader.inst.verify` / `redteam` / `lab` | verify / redteam / lab {n} | verify / redteam / lab {n} |
| `reader.inst.passed` / `failed` / `unverified` | passed / failed / unverified | aprovado / reprovado / não verificado *(candidate)* |
| `reader.inst.redteamOpen` | passed · {n} open | aprovado · {n} em aberto *(candidate)* |
| `reader.inst.lastRun` / `lastRunValue` | last lab run / {by} · {when} | última execução do lab / {by} · {when} *(candidate)* |
| `reader.inst.derived` / `derivedValue` | derived figures / {linked} / {total} linked | figuras derivadas / {linked} / {total} vinculadas *(candidate)* |
| `reader.inst.cited` / `citedValue` | cited figures / {total} · {fast} fast-moving | figuras citadas / {total} · {fast} voláteis *(candidate)* |
| `reader.inst.oldest` / `oldestValue` | oldest check / {days} days | verificação mais antiga / {days} dias *(candidate)* |
| `reader.inst.words` | words | palavras *(candidate)* |
| `reader.inst.history` | improvement history · {n} | histórico de melhorias · {n} *(candidate)* |
| `reader.figures.label` | Figures in {id} | Figuras em {id} *(candidate)* |
| `reader.figures.figure` / `value` / `tier` / `scenario` | figure / value / tier / scenario | figura / valor / nível / cenário *(candidate)* |
| `reader.actions.cap` | from this section | a partir desta seção *(candidate)* |
| `reader.actions.run` / `runtime` | Run Lab {n} / ~ {min} min | Executar Lab {n} / ~ {min} min *(candidate)* |
| `reader.actions.ask` | Ask about {id} | Perguntar sobre {id} |
| `reader.actions.suggest` / `anchor` | Suggest a change / anchor {id} | Sugerir uma alteração / âncora {id} *(candidate)* |
| `reader.render.cap` / `ok` / `bad` | render check / content hash matches release {id} / content hash differs from release {id} | verificação de renderização / hash do conteúdo confere com a release {id} / hash do conteúdo difere da release {id} *(candidate)* |
| `reader.peek.label` / `title` / `open` / `side` / `esc` | Peek: section {id} / Peek · {id} / open in place / open side by side / esc | Espiar: seção {id} / Espiar · {id} / abrir aqui / abrir lado a lado / esc *(candidate)* |
| `reader.mobile.toc` / `tocSub` | Contents / {id} of {n}.9 | Sumário / {id} de {n}.9 |
| `reader.mobile.ask` / `askSub` | Ask about {id} / answers cite the {edition} edition | Perguntar sobre {id} / respostas citam a edição {edition} |
| `reader.mobile.strip` / `stripLabel` | Ch. {n} / Chapter {n} instrument | Cap. {n} / Instrumento do capítulo {n} |
| `reader.statusbar.section` | ch{n} · {id} {title, lowercase} | cap. {n} · {id} {title, lowercase} *(candidate)* |
| `reader.notice.*`, `reader.notFound.*`, `reader.loading` | per § 7 | *(candidates)* |

Chapter titles, standfirsts and section bodies are content, not messages; they come from the edition rows (`Plano de controle e execução durável`, `Números resolvidos` are in the PT screen and will be in the PT edition).

## 9. Keyboard, accessibility

Keyboard map (ui-context § 12), implemented once in `lib/hooks/useKeyboardMap.ts` and mounted by `components/chrome/KeyboardMap.tsx` (client) with the page's targets as props:

| Key | Action |
|---|---|
| `j` / `k` | navigate to `section.next` / `section.prev` |
| `[` / `]` | previous / next chapter's first section |
| `g` then `l` | open the lab (`Run Lab` href) |
| `a` | open the assistant for this section |
| `/` | focus the search field |
| `esc` | close the peek (or the phone sheets) |
| `?` | open the keyboard map dialog (a `.peek`-styled dialog listing the table above) |

Shortcuts are ignored while focus is in an input, textarea, select or contenteditable, and can be disabled by a stored preference (`localStorage` `hb.keys = "off"`, read in try/catch; the setting UI lives in Account).

Accessibility: `aside[aria-label]` for outline and rail; `main` for the reading column; `aria-current="page"` on the outline chapter, `"location"` on the section; `h1` chapter, `h2` section, `h3` sub-headings from the body; the peek is `role="dialog"` with focus trap and return; code regions carry `aria-label` naming file and range; every SVG figure has a text alternative giving its numbers and tier; the figures table has `caption`-equivalent labelling through the instrument label; every chip's abbreviation is expanded by its label or `title`; contrast and targets per ui-context § 12.

## 10. Out of scope for this unit

- The assistant dock, the lab slot and the suggest form (`@assistant`, `@lab`, `@improve` parallel routes; later phases). Their buttons render and 404.
- "Open side by side" in the peek (needs the dock layout).
- Bookmarks and notes UI (unit 20).
- Search (unit 19).
- Chapter history page (Phase 4); the link renders only when there is history.
- Real Mermaid rendering and code highlighting at ingestion (unit 9); the fixture carries pre-rendered markup.
- Reading-path progress writes (unit 20); the outline only reads it.

## 11. Decisions this spec needs

| # | Decision | Recommendation |
|---|---|---|
| D1 | Fixture before the pipeline. | `lib/fixtures/chapter21.ts`: section 21.3 as the screen (body HTML with chips, the figure, the code pane, six figures, the peek text for 26.3), the other eight sections with their real titles from `bible/book/part2/ch21-…md` and one paragraph each, the chapter fields from the screen (`v1.5.0`, verified 12 Sep 2026, lab reproduced, 14/14, 9 · 2, 41 days, 9,180 words, hash `c41e07b2…`). Served while `DATABASE_URL` is unset. Routine. |
| D2 | **Provenance in the real chapters.** The markdown marks tiers with parentheticals — `(Temporal documentation, vendor, verified Sep 2026)`, `(illustrative)`, `(derived)`, `(scenario)` — and `derive.py` prints keyed values (`p_no_failure_f0.02 0.769`), not line-numbered figures. The screen's `ƒ L38` chips and per-figure rows must be produced by the parser. | Unit 9 maps: a number immediately before a tier parenthetical becomes `Figure` + `.fig-*` + chip; a `(derived)` figure is matched to a `derive.py` key by value and the chip's line is the line of that key's assignment; `(scenario)` figures get `scenarioParam = true` and the `scenario` tier label; unmatched derived figures are reported by the parser, never silently unlinked. **Material: confirm before unit 9.** The reader is unaffected: it consumes the § 4.2 vocabulary. |
| D3 | Chapter-level counts (`words`, `derivedFigures`, `citedFigures`, `oldestCheckDays`) are not columns in the TRD schema. | Compute at ingestion and store on `ChapterVersion` (`words Int`, `derivedLinked Int`, `derivedTotal Int`, `citedTotal Int`, `citedFastMoving Int`); `oldestCheckDays` derives from `SourceRow.verifiedAt` at read time. **Material: confirm with unit 7.** |
| D4 | What `/[lang]/ch/[n]` shows. | Redirect to `[n].1` (Intuition). The Book Home tiles already link to `/[lang]/ch/[n]`. Routine. |
| D5 | Sub-headings inside a layer (chapter 21 has 25 `###` in 21.2). | Rendered as `h3` in the body; the outline lists only the nine layers, as the screen does. Routine. |
| D6 | PT edition missing. | Serve the EN body on the PT route with the `pending` cap and band (§ 7); figures identical by construction. Ties to the open question "Portuguese edition lag"; the tracker records it. **Material: Andre confirms this is acceptable for pilot accounts.** |
| D7 | Neighbour window in the outline. | Two chapters before and five after within the part, as the screen (19–26 around 21). Routine. |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. tsc, lint, `npm test` (ChapterData fixture parses; keyboard hook unit test for the ignore-in-field rule), `npm run build` pass; token grep clean.
2. `/en/ch/21` redirects to `/en/ch/21/21.1`; `/en/ch/21/21.3` and `/pt/ch/21/21.3` render 200; `/en/ch/21/21.0` and `/en/ch/99/99.1` return 404.
3. Compare `/en/ch/21/21.3` with `png/Reader-Chapter.png`: outline window 19–26 with 21 expanded and 21.3 current; header caps, title, standfirst; section head; three prose paragraphs with `fig-ill`, `fig-der`, `derive` chips, `ven` chip `21.9 r4`, three `xref`s; Figure 21.3; the derive.py pane lines 36–47 with lines 38, 41, 47 highlighted and both buttons; the instrument with its six kv rows; the figures table with six rows and the right tiers; the three action buttons; the render check; status bar cells. List deliberate differences (no peek open by default; no reading path when signed out; no base64 stub; `open side by side` disabled).
4. Click `26.3` in the prose: the URL becomes `/en/ch/21/21.3/ref/26.3`, the peek renders beside the link with `Peek · 26.3 · v1.4.2`, its caption, first paragraph and `verified 04 Sep 2026`; `esc` closes it and focus returns to the link; browser back closes it; `/en/ref/26.3` navigates in place.
5. Click `ƒ L38`: the derive pane scrolls into view with line 38 highlighted (same page); `Open in Labs` links to the lab route.
6. Keyboard: `j` moves to 21.4, `k` back to 21.3, `]` to 22.1, `[` to 20.1, `a` opens the assistant route, `g` `l` the lab route; none fire while the search field is focused; `?` opens the map; `esc` closes it.
7. `/pt/ch/21/21.3` at 390px with Playwright: compact top bar, source band with `ver original em EN` when the PT body is absent, the chapter strip, section head `21.3 Números resolvidos` / `camada 3 de 9` (from the fixture's PT rows), 16/27 prose, the two-button action bar at 60px; document width 390. At 1440 PT: nothing truncates.
8. Copy on the code pane places the raw code in the clipboard (Playwright `clipboard-read` permission) and the status bar shows `copied` for 3 s.
9. Figures table rows scroll to and highlight their figure in the prose.
10. axe on `/en/ch/21/21.3` and `/pt/ch/21/21.3`, with the peek open: zero AA violations; the dialog traps and returns focus.
11. RSC payload under 150 KB; `loaded` time in the status bar; the instrument's numbers equal the loader's data (grep components for digits outside class names and format strings).
12. `git status` shows only: `app/[lang]/ch/**`, `app/[lang]/ref/**`, `app/[lang]/not-found.tsx`, `components/reader/*`, `components/chrome/KeyboardMap.tsx`, `lib/hooks/useKeyboardMap.ts`, `lib/schemas/chapter.ts`, `lib/fixtures/chapter21.ts`, `lib/db/content.ts`, `globals.css` (§ 6.11), `ui-context.md` § 9.9, `messages/*`, tests, and the tracker.
