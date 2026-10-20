# 02 · Book Home — frontend spec

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for this screen: `docs/design/screens/Book-Home.html` and `docs/design/png/Book-Home.png`. Governing context: `context/ui-context.md` (§ 6 status states, § 8 instrument panel, § 9.6 meters and loaders, § 9.8 chrome, § 10 layout), `context/architecture.md` (§ 3.2 route map, § 4.2 data model), `context/code-standards.md` (Next.js, React components, Styling). PRD: Capability 1, "Each chapter shows its version, last verification date, VERIFY/REDTEAM status." TRD § 2.3: Book-Home is a Reader (Capability 1) screen.

## 1. Purpose

The book's front page at `/[lang]`. It shows the pinned release, a live verification dashboard over the whole corpus, where the signed-in reader left off, and every chapter as a tile grouped by part with its version, days since verify, VERIFY and REDTEAM status, and lab state. Every number on the page comes from the release rows; nothing is typed in.

## 2. Dependencies and order

Build after these units from `context/progress-tracker.md` Next Up:

| Needs | Why |
|---|---|
| Unit 4 · `app/layout.tsx` | fonts, `data-theme`, `lang` |
| Unit 12 · `lib/db/content.ts` | `getCurrentRelease()`, `getChapterCards(lang)`; see § 4 for the loader this page needs |
| Unit 14 · `components/chrome/` | `TopBar`, `StatusBar`, `LangToggle`, `SearchBox`, `InstrumentPanel` |
| Unit 15 · `app/[lang]/layout.tsx` + next-intl | every string on this page is a message key |

Continue reading (§ 6.2) also needs the accounts domain (`User`, `ReadingPathProgress`, session). It is specified here and gated: render it only when the data exists; ship the page without it first.

## 3. Route and rendering

| | Value |
|---|---|
| Route | `app/[lang]/page.tsx` |
| Rendering | React Server Component, cached by release: `"use cache"` / `unstable_cache` keyed by `releaseId`, tag `release:${id}` |
| Auth | any; Continue reading section requires a session |
| Client components | none, except `LangToggle` and `SearchBox` from chrome |
| Metadata | title `The Harness Bible · release 2026.09` (EN) / `A Bíblia do Harness · release 2026.09` (PT, candidate); `alternates.languages` for `en` and `pt` |
| Performance budget | chapter-load class: under 1 s p95, RSC payload under 150 KB (TRD § 5.4). The grid is 41 tiles of small data; one query |

The page file has no logic: read `lang`, call `getHomeData(lang)`, render `<BookHome data={…} />` inside the chrome.

## 4. Data contract

One loader, one query, returns everything the page renders. Define the DTO in `lib/schemas/domain.ts` (or `lib/schemas/home.ts` if it grows) as zod schemas with inferred types; the loader in `lib/db/content.ts` maps rows to it.

```ts
interface HomeData {
  readonly release: {
    readonly id: ReleaseId;            // "2026.09"
    readonly gitSha: string;           // full; the UI shows the first 8
    readonly publishedAt: Date;
    readonly nightlyCheckAt: Date | null; // last lab-suite CI run for this release
  };
  readonly status: {
    readonly chapters: number;         // 41
    readonly verifyPassed: number;     // 41
    readonly labs: number;             // 35
    readonly labsReproduced: number;   // 34
    readonly labsDiverging: ReadonlyArray<{ chapter: ChapterNumber; since: Date }>;
    readonly stale: ReadonlyArray<{ chapter: ChapterNumber; days: number }>;   // > 90 d
    readonly redteamOpen: ReadonlyArray<{ chapter: ChapterNumber; count: number }>;
  };
  readonly parts: ReadonlyArray<HomePart>;
  readonly continueReading: ContinueReading | null;
  readonly sourceLang: Lang;           // for the status bar cell "EN · source EN"
}

interface HomePart {
  readonly key: "P0" | "P1" | "P2" | "P3";
  readonly chapters: ReadonlyArray<HomeChapterTile>;
  readonly labCount: number;
  readonly curators: ReadonlyArray<string>;    // display names; empty until the roster exists
  readonly glance: { verifyPassed: number; labsReproduced: number; stale: ReadonlyArray<{ chapter: ChapterNumber; days: number; what: string }> } | null;
}

interface HomeChapterTile {
  readonly number: ChapterNumber;      // 0..40, rendered zero-padded "00".."40"
  readonly title: string;              // in the requested lang
  readonly version: string;            // "v1.5.0"
  readonly daysSinceVerify: number | null;
  readonly verify: "PASSED" | "FAILED" | "UNVERIFIED";
  readonly redteam: "PASSED" | "FAILED" | "UNVERIFIED";
  readonly redteamOpen: number;        // > 0 → warn R and "N open" chip
  readonly lab:
    | { kind: "reproduced" }
    | { kind: "not_reproduced"; since: Date }
    | { kind: "no_lab"; carries: "prose" | "instrument" };
  readonly staleDays: number | null;   // max age of fast-moving source rows when > 90, else null
  readonly current: { sectionId: SectionId } | null;   // the reader's current chapter, from progress
  readonly href: string;               // `/${lang}/ch/${number}`
}

interface ContinueReading {
  readonly sectionId: SectionId;       // "21.3"
  readonly sectionTitle: string;       // "Worked numbers"
  readonly chapterTitle: string;       // "Control plane and durable execution"
  readonly chapterVersion: string;     // "v1.5.0"
  readonly layer: number;              // 3
  readonly lastReadAt: Date;
  readonly path: { key: "executive" | "builder" | "foundations"; done: number; total: number } | null;
  readonly href: string;               // `/${lang}/ch/21/21.3`
}
```

Where each field comes from (TRD § 4.2):

| Field | Source |
|---|---|
| `release.*` | `Release` current row; `nightlyCheckAt` from the latest CI result for the release (see § 11, D1) |
| `status.chapters`, `verifyPassed` | count of `ChapterVersion` in the release; count with `verifyStatus = PASSED` |
| `status.labs`, `labsReproduced`, `labsDiverging` | `Lab` rows in the release and their CI verdict (§ 11, D1) |
| `status.stale`, `tile.staleDays` | per chapter, max `now − SourceRow.verifiedAt` over rows with `fastMoving = true`; include when > 90 |
| `status.redteamOpen`, `tile.redteamOpen` | `ChapterVersion.redteamOpen` |
| `tile.verify`, `tile.redteam` | `ChapterVersion.verifyStatus`, `redteamStatus` |
| `tile.daysSinceVerify` | `now − ChapterVersion.verifiedAt` in whole days |
| `tile.lab.no_lab.carries` | chapter map: ch00 is prose; ch33, 34, 36, 38, 39 carry an instrument (`CHAPTER-MAP.md` "— (instrument)" in the scope tables; the map is optional since 2026-09-23, the frontmatter deciding when it is absent) |
| `part.curators` | curator roster (accounts domain; empty array until then) |
| `continueReading` | `ReadingPathProgress` for the session user (§ 11, D2) |

Loader contract: `getHomeData(lang: Lang, userId: string | null): Promise<HomeData>` in `lib/db/content.ts`. Until unit 7 (schema) and unit 10 (seed) exist, the loader may return a typed fixture that reproduces the screen's values exactly (§ 11, D3); the page must not know which.

## 5. Layout

Desktop frame 1440. Chrome from unit 14: `.topbar` (48px) above, `.statusbar` (28px) below. Main: `padding: 28px 40px 32px`, column, `gap: 24px` (`--s5`).

```
┌ topbar ─────────────────────────────────────────────────────────────┐
│ ✢ Harness Bible interactive │ Book* Assistant Labs Improve │ search /  release · sha │ EN PT · Account │
├──────────────────────────────────────────────────────────────────────┤
│ hero (1fr)                                  │ Continue reading (460) │
│ cap · h1 · blurb                            │ instrument             │
├──────────────────────────────────────────────────────────────────────┤
│ part 0 · why now                     1 chapter · prose · curators …  │
│ ┌──┬────────────────────────────────────────────────────────────────┐│
│ │00│ part iv · labs and appendices (span 8, band)                   ││
│ └──┴────────────────────────────────────────────────────────────────┘│
│ part i · foundations …               15 chapters · 15 labs · …       │
│ 9-column tile grid, 15 tiles + glance cell (span 3)                  │
│ part ii · harness engineering        18 chapters · 17 labs · …       │
│ 9-column tile grid, 18 tiles (two rows)                              │
│ part iii · industrial application    7 chapters · 3 labs · …         │
│ 9-column tile grid, 7 tiles + glance cell (span 2)                   │
├──────────────────────────────────────────────────────────────────────┤
│ Legend instrument (since 2026-10-12; feature-specs/47 § 5)            │
│ eight rows, four abreast                                              │
├──────────────────────────────────────────────────────────────────────┤
│ book home · 41 chapters │ EN · source EN │ pinned release 2026.09 │ verify 41/41 · labs 34/35 │        loaded 0.38 s │
└──────────────────────────────────────────────────────────────────────┘
```

**The book status instrument was the last thing on the page, below the parts** (Andre, 2026-10-06): a deliberate difference from `Book-Home.png`, which puts it between the hero and the parts. **Since 2026-10-12 it is on Book management** (`/[lang]/account/book`, for curators and organisation admins; feature-specs/47), and the home's last instrument is its legend, which explains the grid's marks (§ 6.4). The hero's blurb and the status bar keep the home's counts.

Grid rules:
- Hero row: `grid-template-columns: minmax(0,1fr) 460px; gap: 48px; align-items: end`.
- Book status cells: `grid-template-columns: 330px repeat(3, minmax(0,1fr))` since 2026-10-12, when the instrument moved to Book management without its 480px legend cell (feature-specs/47); cells separated by `.rr`; no gap.
- Part grid: `<ol>` with `grid-template-columns: repeat(9, minmax(0,1fr))`, `border-top: 1.5px solid var(--rule-strong)`, `border-left: 1px solid var(--rule)`; every cell has `border-right` and `border-bottom` 1px `--rule`. Tiles tile edge to edge with no gap (ui-context § 8).
- Glance and appendix cells: `background: var(--bg-2)`, `padding: 14px 16px`; span 8 (part 0), 3 (part I), 2 (part III); part II has none (18 tiles fill two rows exactly).
- Responsive (§ 11, D4): 9 columns at ≥ 1000px; 5 at 768–999; 3 below 768. Glance cells span the remainder of their row. Hero becomes one column below 1000; Book status cells wrap to two rows below 1000 and one column below 640. Nothing truncates; part header metas wrap.

## 6. Components

All under `components/reader/` (TRD § 2.3 puts Book-Home in the Reader capability). Server components, named exports, props typed from § 4. Class names below are hb.css names from `globals.css`; the tile classes in § 6.4 are new and go into `globals.css` `@layer components` and `ui-context.md` § 9 in the same unit.

### 6.1 `HomeHero`

- `.cap`: `the book · release {id} · pinned`
- `.h1`: `The Harness Bible`
- blurb: `.muted`, 17/26, max-width 700: `{chapters} chapters in four parts. Every chapter has nine layers, a version and a verification record. {labs} chapters have a lab that CI reproduces each night.` Numbers from `status`.

### 6.2 `ContinueReading` (instrument, 460px)

Rendered only when `data.continueReading !== null`. When null and the user is signed in, render the empty state in § 7. When signed out, render nothing and let the hero take the full row.

- `.inst-h`: `.t` `Continue reading` · `ch{n} {version}` · `.ts` `last read {dd MMM HH:mm}`
- `.inst-b` (column, gap 12): `.cap` `continue reading`; row: `.meta` `{sectionId}` + `.h4` `{sectionTitle}`; `.small.muted` `{chapterTitle} · layer {layer} of 9`
- then `.between`: left column with `.between.small` `{Path name} path` / `.meta` `{done} of {total}` and a `Meter` (`value=done max=total`, label localised); right: `Button variant="primary" href` `Resume at {sectionId}`
- Path row omitted when `path === null`.

### 6.3 `BookStatus` (instrument, full width)

On Book management since 2026-10-12, with four cells: the fifth, the legend, stayed on the home (feature-specs/47 § 3.2, D7).

- `.inst-h`: `.t` `Book status` · `release {id}` · `sha {gitSha[0..8]}` · `.ts` `nightly check {dd MMM yyyy HH:mm}` (omit the `.ts` when `nightlyCheckAt` is null)
- Four cells (five until 2026-10-12, the legend the fifth):
  1. `.bignum` `{verifyPassed}/{chapters}` + `.cap` `chapters pass verify` (padding 20 24)
  2. mono 24/28 `{labsReproduced}/{labs}` + `.cap` `labs reproduce` + `.meta` in `--fail`: `Lab {n} diverges since {dd MMM}` for each diverging lab (one line each; omit when none)
  3. mono 24/28 `{stale.length}` + `.cap` `chapters stale > 90 d` + `.meta` in `--warn`: `ch{n} {days} d` joined by ` · ` (omit when none)
  4. mono 24/28 `{release.id}` + `.cap` `release · pinned` + `.meta`: `{count} redteam finding(s) open · ch{n}` (omit when none)
- `.inst-f` (`justify-content: space-between`): `Loader` string `verify {20 blocks} {pct}% · {a}/{b}   lab ci {20 blocks} {pct}% · {c}/{d}` using `█░` glyphs, 20 blocks, percentage rounded to whole; right `.tex`: `#{sha[0..4]}·{sha[4..8]}`. Do not render the base64 stub from the mockup; it is chrome texture with no data behind it.

`Loader` needs a `glyphs` prop (`"▮▯"` default, `"█░"`) and a `width` for the block count. Extend the primitive in this unit; it is ours to edit.

### 6.4 `BookStatusLegend`

Since 2026-10-12 `HomeLegend`, the home's last instrument (`legend`), its rows four abreast (feature-specs/47 § 5).

Static, localised, one row per mark (min-height 22, label column 118px):

| Mark | Text |
|---|---|
| `StatusMark ok` `V` | VERIFY passed |
| `StatusMark ok` `R` | REDTEAM passed |
| `StatusMark warn` `R` | REDTEAM finding open |
| `StatusBlock warn` small `stale n d` | fast-moving figure checked > 90 d ago |
| `StatusMark ok` `reproduced` | lab matches the chapter in CI |
| `StatusMark fail` `not reproduced` | lab diverges from the chapter |
| `StatusMark mute` `no lab` (no uppercase) | chapter carries an instrument |
| `.meta` `v1.5.0 · 9 d` | version · days since verify |

The small `stale n d` block is `.st-block.sb-warn` at height 20, padding 0 6, font 10.5: add class `.sb-sm` for it.

### 6.5 `PartGrid`

Per part: `.between` header with `.cap` `part {roman} · {part title}` and `.meta.faint` `{n} chapter(s) · {labs} lab(s) · curators {names}` (curators segment omitted when the array is empty; part 0 says `1 chapter · prose`), then the `<ol>` grid of `ChapterTile`s and, where § 5 says, a `GlanceCell`. `aria-label` on the section equals the header text.

Part titles: `why now`, `foundations of language models`, `harness engineering`, `industrial application`. Roman numerals: `0`, `i`, `ii`, `iii` (lowercase, as the screen).

### 6.6 `ChapterTile` (`<li class="tile">`)

Structure, top to bottom, `gap: 8px`, `padding: 12px 12px 14px`:
1. `.between` (align start): mono 22/24 zero-padded number (`.tile-n`); right slot for one chip: `stale {days} d` (`StatusBlock warn` + `.sb-sm`) when `staleDays !== null`, else `{redteamOpen} open` when `redteamOpen > 0`, else the current marker `.cap` in `--act` `reading {sectionId}` when `current !== null`.
2. title link `<a href>` 13/18 weight 500 `min-height: 54px` (three lines reserved so tiles align); `aria-current="true"` when current.
3. `.between`: `.meta` `{version} · {days} d`; row of two marks: `StatusMark` `V` (ok when `verify = PASSED`, mute otherwise, `title`/`aria-label` "VERIFY passed" / "VERIFY not passed") and `R` (ok when `redteam = PASSED` and `redteamOpen = 0`; warn when `redteamOpen > 0` with label "REDTEAM: {n} finding(s) open"; mute otherwise).
4. lab line: `StatusMark ok` `reproduced`; or column of `StatusMark fail` `not reproduced` + `.meta` in `--fail` `Lab {n} · since {dd MMM}`; or `StatusMark mute` `no lab · prose` / `no lab · instrument` with `text-transform: none` (class `.st-plain`).

Tile modifier classes (new in `globals.css`):

| Class | Rule | When |
|---|---|---|
| `.tile` | the cell borders, padding, column layout above | always |
| `.tile-cur` | `background: var(--surface); box-shadow: inset 0 -2px 0 var(--ink)` | `current !== null` |
| `.tile-stale` | `box-shadow: inset 0 3px 0 var(--warn)` | `staleDays !== null` |
| `.tile-fail` | `box-shadow: inset 3px 0 0 var(--fail)` | `lab.kind = "not_reproduced"` |
| `.tile-glance` | `background: var(--bg-2); padding: 14px 16px` | glance and appendix cells |
| `.st-plain` | `text-transform: none; letter-spacing: 0; white-space: normal; align-items: baseline` | "no lab" marks |
| `.sb-sm` | `height: 20px; padding: 0 6px; font-size: 10.5px` | small warn blocks in tiles and legend |

A tile can be both stale and current, or fail and current; the classes combine. The inset bars are hard bars, permitted by ui-context § 4.4.

### 6.7 `GlanceCell`

`.cap` `part {roman} · at a glance` then `.meta` lines: `{verifyPassed}/{n} verify · {labsReproduced}/{labs} labs reproduce` and, when stale is non-empty, `{count} stale · ch{n} {what} {days} d` (e.g. `ch15 price rows 97 d`; `what` is the localised name of the stale row group, from the loader). The part 0 cell is the appendix note instead: `.cap` `part iv · labs and appendices`, `.meta` `{labs} labs · each with README, environment file, data and a script that prints the reproduced number`, `.meta` `appendices A glossary · B source registry · C data tables · D replication logs · E toolkit`.

### 6.8 Status bar cells (via chrome `StatusBar`)

`book home · {chapters} chapters` | `{lang} · source {sourceLang}` | `pinned release {id}` | `verify {a}/{b} · labs {c}/{d}` | right-aligned `loaded {s} s` where `s` is the server render time of this request to two decimals, measured in the page around the loader call.

## 7. States

| State | Render |
|---|---|
| Signed out | Hero full width; no Continue reading instrument |
| Signed in, no progress | Continue reading instrument with an `Empty` body: caption `reading paths`, line `No reading yet.` (candidate), action `Button href="/[lang]/paths"` `Choose a path` (candidate) |
| Signed in, progress, no path | Instrument without the path row |
| No diverging labs | Cell 2 has no fail line; loader shows 100% |
| No stale chapters | Cell 3 shows `0` and no warn line; no tile carries `.tile-stale`; glance cells omit the stale line |
| No redteam findings | Cell 4 has no meta line |
| `nightlyCheckAt` null | Instrument header has no `.ts`; loader footer still renders from counts |
| Part with zero labs | header says `0 labs`; never hide the segment |
| Curators unknown | header omits `· curators …` |
| Loading | `app/[lang]/loading.tsx` renders the chrome and a `Loader` `loading release {id}` with no percentage (no skeleton, no spinner) |
| Error | `app/[lang]/error.tsx` renders `ErrorBox` title `Home did not load` (candidate) with the `traceId` and a Retry button |

## 8. Strings

Every string is a message key under `home.*` in `messages/en.json` and `messages/pt.json`. EN values are the screen's. PT values marked *candidate* need Andre's confirmation before the PT snapshot is accepted; the others are taken from the UI package's PT screen.

| Key | EN | PT |
|---|---|---|
| `home.cap` | the book · release {id} · pinned | o livro · release {id} · fixada *(candidate)* |
| `home.title` | The Harness Bible | The Harness Bible |
| `home.blurb` | {chapters} chapters in four parts. Every chapter has nine layers, a version and a verification record. {labs} chapters have a lab that CI reproduces each night. | {chapters} capítulos em quatro partes. Cada capítulo tem nove camadas, uma versão e um registo de verificação. {labs} capítulos têm um lab que o CI reproduz todas as noites. *(candidate)* |
| `home.continue.label` | Continue reading | Continuar a leitura *(candidate)* |
| `home.continue.lastRead` | last read {when} | última leitura {when} *(candidate)* |
| `home.continue.layer` | {chapter} · layer {n} of 9 | {chapter} · camada {n} de 9 |
| `home.continue.path` | {name} path | trilha {name} *(candidate)* |
| `home.continue.of` | {done} of {total} | {done} de {total} |
| `home.continue.resume` | Resume at {section} | Retomar em {section} *(candidate)* |
| `home.continue.empty` | No reading yet. | Nenhuma leitura ainda. *(candidate)* |
| `home.continue.choose` | Choose a path | Escolher uma trilha *(candidate)* |
| `home.status.label` | Book status | Estado do livro *(candidate)* |
| `home.status.nightly` | nightly check {when} | verificação noturna {when} *(candidate)* |
| `home.status.verify` | chapters pass verify | capítulos passam no verify *(candidate)* |
| `home.status.labs` | labs reproduce | labs reproduzem *(candidate)* |
| `home.status.diverges` | Lab {n} diverges since {when} | Lab {n} diverge desde {when} *(candidate)* |
| `home.status.stale` | chapters stale > 90 d | capítulos desatualizados > 90 d *(candidate)* |
| `home.status.release` | release · pinned | release · fixada *(candidate)* |
| `home.status.redteam` | {count, plural, one {# redteam finding open} other {# redteam findings open}} · ch{n} | {count, plural, one {# achado de redteam aberto} other {# achados de redteam abertos}} · ch{n} *(candidate)* |
| `home.legend.*` | the eight legend texts in § 6.4 | *(candidates; `reproduzido`, `não reproduzido`, `verificado` from the PT screen)* |
| `home.part.header` | {count, plural, one {# chapter} other {# chapters}} · {labs, plural, one {# lab} other {# labs}} | {count, plural, one {# capítulo} other {# capítulos}} · {labs, plural, one {# lab} other {# labs}} |
| `home.part.curators` | curators {names} | curadores {names} *(candidate)* |
| `home.part.p0` … `p3` | why now · foundations of language models · harness engineering · industrial application | por que agora · fundamentos de modelos de linguagem · engenharia de harness · aplicação industrial *(candidate; "engenharia de harness" from the PT screen)* |
| `home.tile.stale` | stale {days} d | desatualizado {days} d *(candidate)* |
| `home.tile.open` | {n} open | {n} aberto *(candidate)* |
| `home.tile.reading` | reading {section} | lendo {section} *(candidate)* |
| `home.tile.verifyPassed` / `verifyNot` | VERIFY passed / VERIFY not passed | VERIFY aprovado / VERIFY não aprovado *(candidate)* |
| `home.tile.redteamPassed` / `redteamOpen` | REDTEAM passed / REDTEAM: {n} finding(s) open | REDTEAM aprovado / REDTEAM: {n} achado(s) aberto(s) *(candidate)* |
| `home.tile.reproduced` | reproduced | reproduzido |
| `home.tile.notReproduced` | not reproduced | não reproduzido |
| `home.tile.since` | Lab {n} · since {when} | Lab {n} · desde {when} *(candidate)* |
| `home.tile.noLabProse` / `noLabInstrument` | no lab · prose / no lab · instrument | sem lab · prosa / sem lab · instrumento *(candidate)* |
| `home.glance.label` | part {roman} · at a glance | parte {roman} · em resumo *(candidate)* |
| `home.glance.counts` | {v}/{n} verify · {r}/{l} labs reproduce | {v}/{n} verify · {r}/{l} labs reproduzem *(candidate)* |
| `home.glance.stale` | {count} stale · ch{n} {what} {days} d | {count} desatualizado · ch{n} {what} {days} d *(candidate)* |
| `home.appendix.*` | the three part-iv lines in § 6.7 | *(candidates)* |
| `home.statusbar.*` | book home · {n} chapters / {lang} · source {src} / pinned release {id} / verify {a}/{b} · labs {c}/{d} / loaded {s} s | *(candidates; ids, versions and numbers unchanged)* |

Formats: dates through `lib/i18n/format.ts` (`20 Sep 21:14` / `20 set 21:14`; `21 Sep 2026 06:00` / `21 set 2026 06:00`). Ids, versions, shas, `V`, `R`, `Lab 23`, `ch15` never localise. PT strings are longer; the 460px instrument and the 330px cell are sized for them, and tiles reserve three title lines.

## 9. Accessibility and keyboard

- Landmarks: `<main>`; each part is a `<section aria-label>`; instruments are `<section aria-label="Continue reading">` and `"legend"` (`"Book status"` until 2026-10-12, feature-specs/47); the tile grid is an `<ol>` so chapter order is announced.
- Every `V`/`R` mark carries `aria-label` with the full text; the legend is the visible expansion.
- The current tile's link has `aria-current="true"`; the top-nav `Book` link has `aria-current="page"`.
- Meter has `role="meter"` with the path name in its label.
- Loader strings have `role="status"`.
- All state shows a word and a form: stale = ochre chip and a top bar; not reproduced = red word and a left bar; current = surface fill, bottom bar and the `reading` caption. Colour is never alone.
- Keyboard: `/` focuses search (chrome); `?` opens the map; tiles are plain links in DOM order. No single-key shortcut is bound on this page beyond the global map.
- Contrast: all text on `--bg`, `--bg-2` or `--surface` at the token ratios; the `--fail` and `--warn` meta lines are on `--bg` (6.50 / 5.75 light).
- Touch: tile links are at least 44px tall on coarse pointers (the 54px title reserve covers it).

## 10. Out of scope for this unit

- Search behaviour (the box submits to `/[lang]/search`, built in unit 19).
- Reading paths page, bookmarks, notes (unit 20).
- Account link target (Phase 4 admin) and sign-in flow (unit 21); until then the link points at `/[lang]/account` and that route 404s.
- The `Assistant`, `Labs`, `Improve` nav targets (later phases; render as links to their routes, which do not exist yet).
- Theme switch UI (lives in Account settings).
- Any chapter that is not in the release: the grid shows only ingested chapters; 41 tiles appear only when the book is at 41/41.

## 11. Decisions this spec needs

Handle each under `ai-workflow-rules.md` § 4. D1 and D2 are material; D3 and D4 are routine with a stated recommendation.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Where the lab CI verdict per chapter is stored. The TRD's `ChapterCard` response includes a lab verdict, and `POST /webhooks/ci` delivers `{sha, labResults[]}`, but `Lab` has no verdict columns. | Add `ciVerdict: Verdict`, `ciCheckedAt: DateTime`, `ciDivergedSince: DateTime?` to `Lab` in the schema unit (unit 7), written by the pipeline at ingestion from the release's CI artefact and by the CI webhook thereafter. `Release.nightlyCheckAt` derives from `max(Lab.ciCheckedAt)`. **Material: confirm before unit 7.** |
| D2 | Continue reading needs a last-read timestamp; `ReadingPathProgress` has `lastSectionId` and `completed` but no time. | Add `updatedAt DateTime @updatedAt` to `ReadingPathProgress` in the accounts schema unit; "last read" is that timestamp of the most recently updated path. **Material: confirm with the accounts schema unit.** |
| D3 | Fixture data path before the database exists. | `lib/fixtures/home.ts` exporting a `HomeData` object that reproduces `Book-Home.html` exactly (release 2026.09, sha `7f3a9c1e…`, the 41 tiles with their versions and days, Lab 23 since 15 Sep, ch15 97 d, ch36 94 d, ch30 1 open). `getHomeData` returns it when `DATABASE_URL` is unset in `lib/env.ts`. Delete the fixture in unit 12 once the seed exists. |
| D4 | Responsive columns below 1000px (no mobile Home in the UI package). | 9 / 5 / 3 columns at ≥ 1000 / 768–999 / < 768 as in § 5. Record as a deliberate difference in the tracker. |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. `npx tsc --noEmit`, `npm run lint`, `npm run build` pass; `HomeData` parses through its zod schema with the fixture and with seeded rows.
2. Open `/en` and `/pt`. Compare with `png/Book-Home.png`: hero, the two instruments, four part sections, 41 tiles, glance cells, status bar cells. List every deliberate difference (D4, omitted base64 stub, omitted curators until roster, the book status at the foot of the page since 2026-10-06).
3. Confirm the counts on the page equal the loader's data (no hand-typed number anywhere: grep the components for digits outside class names and format strings).
4. Confirm the special tiles render their classes and marks: ch15 and ch36 `.tile-stale` with `stale 97 d` / `stale 94 d`; ch23 `.tile-fail` with `not reproduced` and `Lab 23 · since 15 Sep`; ch30 warn `R` and `1 open`; ch21 `.tile-cur`, `reading 21.3`, `aria-current`; ch00, 33, 34, 36, 38, 39 `no lab`.
5. Toggle PT: nothing truncates at 1440 and at 390; the 460px instrument and the 330px cell hold their strings; status bar cells wrap rather than clip.
6. Signed-out render has no Continue reading; a fixture with `continueReading: null` and a session renders the empty state.
7. axe on `/en` and `/pt`: zero WCAG 2.2 AA violations; every `V`/`R` mark has an accessible name; the tile list is an ordered list.
8. Dark theme (`data-theme="dark"`): the fail and warn meta lines and the inset bars use the dark tokens; no hard-coded colour in any new file (token grep).
9. RSC payload for `/en` under 150 KB; server render time shown in the status bar is under 1 s locally against the fixture.
10. `git status` shows only: `app/[lang]/page.tsx`, `app/[lang]/loading.tsx`, `app/[lang]/error.tsx`, `components/reader/*`, the `Loader` extension, `globals.css` (tile classes), `ui-context.md` § 9 (tile classes), `messages/{en,pt}.json`, `lib/schemas/*`, `lib/db/content.ts` or `lib/fixtures/home.ts`, tests, and the tracker.
