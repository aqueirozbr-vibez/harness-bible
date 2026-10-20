# 05 · Reading Paths — feature spec (frontend + reader state backend)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screen: `docs/design/screens/Book-Paths.html` (desktop, 1440) with `png/Book-Paths.png`. There is no phone screen for this page; § 6.7 derives one from Mobile-Reader-PT. Governing context: `context/ui-context.md` (§ 8 instrument panel, § 9.10 interaction states, § 13.4 glyphs: `■ □ ◧` read state, `├─ └─` tree, `✢` taxonomy node), `context/architecture.md` (§ 3.2 route map: `/[lang]/paths`, `/[lang]/paths/[path]`; § 3.4 reader-state endpoints; § 4.1 reader state lives in PostgreSQL via server actions), `context/code-standards.md` (server actions, hooks, env), `context/project-overview.md` (Capability 1: three reading paths, per-account progress, minute estimates at 230 words per minute, resume buttons; Phase 1 gate: "resuming from another device lands on the same section"). PRD personas: Executive, Builder, Foundations. TRD § 4.2: `ReadingPathProgress { userId, path, lastSectionId, completed, @@unique([userId, path]) }`; `GET /paths`, `PUT /paths/{path}/progress`.

Prerequisite specs: `02-book-home.md` (Continue reading instrument, § 6.2 and D2), `03-reader-chapter.md` (outline reading-path block, § 6.1), `04-content-domain-schema.md` (§ 4 tenant guard, § 9 accounts migration shape).

Scope: tracker unit 20's reading-path half, plus the accounts migration it needs and a development session seam so the pages can be built and verified before SSO (unit 21). Bookmarks and notes get their own spec (`06-bookmarks-notes.md`); this page only reads their counts (§ 6.2).

## 1. Purpose

Three curated sequences through the book, each with a fixed order, grouped stops, a minute estimate per stop, and per-account progress that follows the reader across devices and editions. The page at `/[lang]/paths` shows the three paths side by side with the reader's progress and a Start or Resume action; `/[lang]/paths/[path]` shows one path in full. The reader page records progress as sections are read; Book Home's Continue reading and the reader outline's reading-path block read the same rows.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| 04 (done): release rows, `getPrisma()`, the content guard | stop titles, word counts, stale and lab state come from `ChapterVersion`, `Section`, `SourceRow`, `Lab` |
| Migration `0002_accounts` (this spec, § 4.1; shape from 04 § 9) | `User`, `Organisation`, `Seat`, `Session`, `Bookmark`, `Note`, `ReadingPathProgress`; the tenant guard's first real models |
| `Section.words` (this spec, § 4.1) | minute estimates for section stops (Executive's `N.8` stop); one pipeline change and a re-ingest |
| Development session seam `lib/auth/session.ts` (this spec, § 5) | `getSession()` returns a user before Auth.js exists (unit 21) so progress can be written and verified now |
| Unit 19 search | none; independent |

Build order inside the unit: 20a migration + `Section.words` + re-ingest → 20b path definitions and pure progress functions with tests → 20c loaders and server actions → 20d the two pages → 20e reader progress recording, Book Home Continue reading and the outline block wired to real rows → verification.

## 3. Routes and rendering

| Route | Behaviour |
|---|---|
| `/[lang]/paths` | the three paths; RSC; progress is per user so the page is dynamic (`export const dynamic = "force-dynamic"` is not needed: reading the session cookie makes it dynamic). Signed out: the paths render with no progress and a `Sign in to keep progress` note (§ 7, D5) |
| `/[lang]/paths/[path]` | one path, full width; `path` ∈ `executive`, `builder`, `foundations`; any other value 404 |
| `POST` server actions in `app/[lang]/paths/actions.ts` | `startPath`, `resetPath` (§ 5.3) |
| `POST` server action in `app/[lang]/ch/[n]/[section]/actions.ts` | `recordSectionRead` (§ 5.3), called by the reader's progress hook |

Metadata: `Reading paths · The Harness Bible`; `/paths/builder` → `Builder path · The Harness Bible`; `alternates.languages`.

Performance: two queries per page (path content for the release, cached with tag `release:current`; the user's progress rows, uncached) and one render. Progress writes are idempotent and never block navigation (§ 5.3).

## 4. Data contract

```ts
type PathKey = "executive" | "builder" | "foundations";

/** A stop is one chapter, or a named set of sections (Executive's "decision aids · layer 8"). */
interface PathStop {
  readonly id: string;                          // "ch34" | "decision-aids-8"
  readonly kind: "chapter" | "sections";
  readonly label: string;                       // "34" | "N.8"
  readonly title: string;                       // chapter title in the edition, or the stop's own title
  readonly href: string;                        // first section of the stop in the locale
  readonly sections: ReadonlyArray<SectionId>;  // every section that counts towards "read"
  readonly minutes: number;                     // ceil(words / 230), words summed over `sections`
  readonly state: "unread" | "in_progress" | "read";
  readonly at: SectionId | null;                // the last section read inside this stop when in_progress
  readonly stale: { days: number } | null;      // the chapter has a fast-moving row older than 90 d
  readonly lab: { id: string; verdict: Verdict } | null;   // shown only when not REPRODUCED
}

interface PathGroup { readonly title: string; readonly stops: ReadonlyArray<PathStop>; }

interface PathView {
  readonly key: PathKey;
  readonly version: string;                     // "v1.1" — the definition's version
  readonly name: string;                        // localised: Executive · Builder · Foundations
  readonly audience: string;                    // "who it is for"
  readonly primaryUse: string;
  readonly mustHave: string;
  readonly stopNoun: "stops" | "chapters";      // Executive counts stops, the others chapters
  readonly groups: ReadonlyArray<PathGroup>;
  readonly total: number;                       // stops
  readonly done: number;                        // stops in state read
  readonly minutes: number;                     // sum of stop minutes
  readonly minutesLeft: number;                 // sum over stops not read
  readonly resume: { sectionId: SectionId; href: string } | null;   // lastSectionId when started
  readonly startedAt: Date | null;
  readonly updatedAt: Date | null;
}

interface PathsData {
  readonly release: { id: ReleaseId; gitSha: string };
  readonly paths: ReadonlyArray<PathView>;      // always three, in this order: executive, builder, foundations
  readonly marks: { bookmarks: number; notes: number; latest: { sectionId: SectionId; text: string; at: Date } | null; syncedAt: Date | null } | null;   // null when signed out
  readonly active: { key: PathKey; done: number; total: number; resume: SectionId } | null;   // the most recently updated started path; feeds the status bar
  readonly signedIn: boolean;
  readonly sourceLang: Lang;
}
```

`PathsDataSchema` (zod, `lib/schemas/paths.ts`) validates the loader's output like `HomeDataSchema` does; dates coerce (04 D18).

### 4.1 Schema changes (migration `0002_accounts`)

The accounts models exactly as `04-content-domain-schema.md` § 9 lists them, with these additions:

```prisma
model ReadingPathProgress {
  id             String   @id @default(uuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id])
  path           String                       // PathKey
  pathVersion    String                       // definition version the progress was recorded against (D3)
  lastSectionId  String                       // anchor, "21.3"
  completed      Int                          // TRD field: count of read stops, kept in sync with completedStops
  completedStops String[]                     // stop ids in state read (D2)
  startedAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt          // Book Home D2: "last read"
  @@unique([userId, path])
}
```

`Section` gains `words Int @default(0)`, filled by the pipeline from `countWords(markdown)` per layer (the chapter total stays the linter's whole-file count). Migration `0002_accounts` adds the column; the release is re-ingested in development (empty the content tables first; tracker Session Notes describe the two commands).

`Bookmark` and `Note` come in the same migration so the "Your marks" instrument has rows to count; their UI is spec 06.

Tenant guard (04 § 4): `TENANT_MODELS` gains `Bookmark`, `Note`, `ReadingPathProgress`, `Session` keyed by `userId`, and `User`, `Seat` keyed by `organisationId`. `withTenant({ userId, organisationId })` is set by the page or action from the session. A query on these models outside a tenant context throws `NO_TENANT`, as designed.

### 4.2 Path definitions

The three sequences are content, versioned with the book, but the book carries none today (D1). They live in `lib/paths/definitions.ts` as typed data, validated by a zod schema, until `bible/book/paths/*.json` exists; the loader reads the same shape from either place.

```ts
interface PathDefinition {
  readonly key: PathKey;
  readonly version: string;
  readonly groups: ReadonlyArray<{ readonly title: MessageKey; readonly stops: ReadonlyArray<StopDefinition> }>;
}
type StopDefinition =
  | { readonly kind: "chapter"; readonly chapter: ChapterNumber }
  | { readonly kind: "sections"; readonly id: string; readonly title: MessageKey; readonly label: string; readonly sections: ReadonlyArray<SectionId> };
```

From the screen:

| Path | Version | Groups → stops |
|---|---|---|
| Executive (8 stops) | v1.1 | why now → 00 · choose and pay for it → 34, 37, 38 · comply → 36 · plan and prove → 39, 40 · decision aids · layer 8 → `N.8` = 21.8, 23.8, 28.8, 31.8 |
| Builder (14 chapters) | v1.2 | framing and guides → 16, 17, 18 · context and knowledge → 19, 20 · execution → 21, 22, 23, 25 · verification and control → 26, 27, 28, 29, 31 |
| Foundations (15 chapters) | v1.0 | text as numbers → 01, 02 · architecture → 03, 04, 05, 06 · training → 07, 08, 09 · serving → 10, 11 · measuring and failing → 12, 13, 14 · cost → 15 |

Audience, primary use and must-have texts are the screen's, as message keys (§ 8). A definition test asserts every stop's chapter or section exists in the current release (`pipeline` fixture in unit tests; the database in the integration test).

### 4.3 Progress rules (pure functions in `lib/paths/progress.ts`)

- A chapter stop is **read** when its layer 9 section (`NN.9`) has been read, or the reader marked the stop read (a later spec adds the control); **in progress** when any of its sections is the path's `lastSectionId` or has been read; otherwise **unread**. A sections stop is read when every listed section has been read.
- "Read" for a section means `recordSectionRead` ran for it while the path was active (§ 5.3). Read sections are derived from `completedStops` plus `lastSectionId`; no per-section table (D2 keeps the row small).
- `completed = completedStops.length`; `done`, `minutesLeft` and `resume` derive from the stop states. `resume` is `lastSectionId` when the path has a row, else null.
- The **active path** for a section view is the started path whose stops contain the section, most recently updated first; a section in no started path records nothing. Starting a path sets `lastSectionId` to its first section.
- Minutes: `ceil(words / 230)` per stop; a chapter stop sums its nine sections. Labs are extra and not counted (footer line).
- Definition version: progress recorded against an older `pathVersion` is kept; stops whose ids are no longer in the definition are ignored when counting (D3).

## 5. Backend: session seam, loaders, actions

### 5.1 Session seam (`lib/auth/session.ts`)

```ts
interface SessionUser { readonly id: string; readonly organisationId: string | null; readonly role: Role; readonly displayName: string; readonly locale: string }
export async function getSession(): Promise<SessionUser | null>
```

Until unit 21, `getSession()` returns the development user when `DEV_SESSION_USER_ID` is set and `NODE_ENV !== "production"` (under `NODE_ENV=production` the variable is ignored: `next build` runs with that value on the development machine, so refusing it in the env schema would break every local build), else null. The seed creates that user (`dev@harness-bible.local`, role READER, no organisation) so `npm run db:seed` gives a working signed-in state. Unit 21 replaces the body with Auth.js and deletes the variable; every caller is unchanged (D4).

### 5.2 Loaders (`lib/db/reader-state.ts`)

| Function | Query | Notes |
|---|---|---|
| `getPathsData(locale, user)` | release + the chapters, sections (anchor, ordinal, words), lab verdicts and oldest fast-moving row per chapter in the definitions' stops, cached by release; then the user's three `ReadingPathProgress` rows, `Bookmark` and `Note` counts and the latest note | assembles `PathsData`; `marks` and progress null/empty when `user` is null |
| `getPathView(locale, user, key)` | the same for one path | `/paths/[path]` |
| `getContinueReading(locale, user)` | the most recently updated `ReadingPathProgress` row + its section and chapter titles | replaces the `null` in `getHomeData` (02 § 6.2); `path.done/total` from § 4.3 |
| `getReaderProgress(user, chapter)` | the active path for the chapter, if any | fills `ChapterData.progress` (03 § 4) |

All run inside `withTenant` from the session; content reads stay on the cached, tenant-free path.

### 5.3 Server actions

Per code-standards § Next.js: `"use server"`, zod first, a discriminated result, never throw to the client. OPA is unit 21; until then the action checks `getSession()` and ownership by construction (the row is looked up by `userId`).

| Action | Input | Effect |
|---|---|---|
| `startPath({ path })` | `PathKey` | upsert the user's row with `lastSectionId` = first stop's first section, `pathVersion` = definition version, empty `completedStops`; redirect to that section |
| `resetPath({ path })` | `PathKey` | delete the row (confirm dialog in the UI, § 6.4) |
| `recordSectionRead({ sectionId })` | `SectionId` | for the active path (§ 4.3): set `lastSectionId`, add the stop to `completedStops` when the rules say read, bump `completed`; no active path → `{ ok: true, data: { recorded: false } }` |

`recordSectionRead` is called by `useReadingProgress` (`lib/hooks/useReadingProgress.ts`, client) from the reader page: once per section view, after 15 s on the page or when the reader navigates to the next section (`j`, next link), whichever first; via `navigator.sendBeacon` to a route handler is not allowed (no API routes yet), so the hook calls the action and ignores its result. Signed-out readers never call it (the hook is not rendered).

The `/api/v1/paths` endpoints (`GET /paths`, `PUT /paths/{path}/progress`) arrive with the handler pipeline in unit 21 and call the same `lib/paths` and `lib/db/reader-state` functions.

## 6. Layout and components

Desktop grid from the screen (1440): `main` padding `28px 40px 32px`, gap 24px; a header row `minmax(0,1fr) 520px` with the hero left and the "Your marks" instrument right, aligned to the bottom; then three instruments in `repeat(3, minmax(0,1fr))` with 24px gaps, stretched to equal height; then the status bar.

```
┌ topbar ───────────────────────────────────────────────────────────────────┐
│ reading paths · release 2026.09          ┌ YOUR MARKS · account  synced ┐ │
│ Three ways through the book              │ 12 bookmarks │ 9 notes │ …   │ │
│ Each path is a curated sequence…         └───────────────────────────────┘ │
│ ┌ PATH · EXECUTIVE ┐ ┌ PATH · BUILDER ──┐ ┌ PATH · FOUNDATIONS ┐           │
│ │ who / use / must │ │ …                │ │ …                  │           │
│ │ your progress ▬▬ │ │ 7 of 14 · left   │ │ 3 of 15 · left     │           │
│ │ ✢ why now        │ │ ✢ framing…       │ │ ✢ text as numbers  │           │
│ │  └─ □ 00 title   │ │  ├─ ■ 16 title   │ │  ├─ ■ 01 title     │           │
│ │ … footer: Start  │ │ … Resume at 21.3 │ │ … Resume at 02.1   │           │
│ └──────────────────┘ └──────────────────┘ └────────────────────┘           │
└ statusbar: reading paths · 3 | EN · source EN | pinned release | builder 7 of 14 · resume 21.3 | loaded ┘
```

Components live in `components/paths/`. Server components unless marked.

### 6.1 `PathsHero`

`.cap` `reading paths · release {id}`, `.h1` `Three ways through the book`, `.muted` blurb at 17/26 with `max-width: 700px`.

### 6.2 `YourMarks` (instrument)

`InstrumentPanel` label `Your marks` · meta `account` · timestamp `synced {day-month time}` (`syncedAt` = the latest `updatedAt` across the user's bookmarks, notes and progress; omitted when null). Body: a `120px 120px minmax(0,1fr)` grid. Cells 1 and 2 are `.rr` links (bookmarks and notes lists arrive with spec 06; until then they link to `/[lang]/paths#marks` and read `0`): `.mono` 24/28 count over `.cap` `bookmarks` / `notes`. Cell 3: `.cap` `latest note · {sectionId}` and `.small` note text truncated to 90 characters at a word boundary by the loader, or `Empty` `No notes yet.` (candidate). Signed out: the instrument is replaced by a `Notice` `Sign in to keep progress` / `Reading paths work without an account; progress and marks need one.` (candidate) with the Account link.

### 6.3 `PathInstrument`

`InstrumentPanel` label `Path · {Name}` · `{version}` · `{total} {stopNoun}` · timestamp `{h} h {m} min` (total minutes). Body (`.inst-b`, column, gap 16px, `flex: 1`):

1. `dl.kv` with `grid-template-columns: 92px 1fr`: `who it is for`, `primary use`, `must have`; `dd` left-aligned in `--sans` 13px (new class `.kv-prose`, § 6.6).
2. `.rt` block: `.between` `.flabel` `your progress` / `.meta` `{done} of {total} · {left} left` (`left` formatted `4 h 14 min` or `26 min`); `Meter` (`.meter.ver`) `done/total`.
3. `PathSequence` (§ 6.4).

Footer (`.inst-f`, `space-between`, `min-height: 56px`): `reading time at 230 words/min · labs extra` and the action button: `Start path` (`Button`, a form posting `startPath`) when no row; `Resume at {sectionId}` (`Button variant="primary"` when this is the active path, default otherwise) linking to `resume.href`; signed out: `Start path` links to the first stop without a form. A path with every stop read shows `Read again` (candidate) which links to the first stop and a quiet `Reset` (opens the confirm, § 6.5).

### 6.4 `PathSequence` and `StopRow`

An `ol.rt` (`aria-label` `{Name} sequence`). Each group is a heading row: `.glyph` `✢` then `.cap` group title in `--ink-2`, `min-height: 26px`, `padding-top: 6px`. Each stop is a `StopRow`:

- tree glyph `.mono.faint` 12.5px, `padding-left: 18px`: `├─` for all but the group's last stop, `└─` for the last;
- read state glyph `.mono` 11px, width 14px, with `aria-label`: `□` unread (`--ink-3`), `■` read (`--ver`), `◧` in progress (`--act`);
- label `.mono` 12px, `min-width: 34px`, `--ink-2`: `00`…`40` or `N.8`;
- title link `.grow.small` to `href`: `--ink` 400 when unread, `--ink-2` 400 when read, `--ink` 600 when in progress, followed by `.meta` in `--act` `· at {sectionId}` when in progress; a `StatusBlock warn sb-sm` `stale {days} d` after the title when `stale`; a `StatusMark fail` `lab {n}` when `lab` is present;
- `.meta` minutes, `white-space: nowrap`.

The in-progress row has `background: var(--act-bg)` across the row (`.stop-current`). Rows are 26px min-height, `padding: 3px 6px 3px 0`. Hover follows ui-context § 9.10 (title link turns `--ver` with the dotted underline; the row itself is not a link).

### 6.5 `ResetPathDialog` (client)

`role="dialog"` from the `Reset` quiet button: `Reset the {Name} path?` / `Progress for this path is deleted. Bookmarks and notes are kept.` (candidate), `Cancel` and destructive `Reset`, focus trapped and returned, `esc` cancels. The confirm submits `resetPath`.

### 6.6 New composition classes (`globals.css`, then ui-context § 9.9)

| Class | Rule | Used by |
|---|---|---|
| `.paths` | `padding: 28px 40px 32px; display: flex; flex-direction: column; gap: 24px` | page |
| `.paths-head` | `display: grid; grid-template-columns: minmax(0,1fr) 520px; gap: 48px; align-items: end` | hero + marks |
| `.paths-grid` | `display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 24px; align-items: stretch` | three instruments |
| `.marks-grid` | `display: grid; grid-template-columns: 120px 120px minmax(0,1fr)` | YourMarks body |
| `.marks-cell` | `padding: 12px 16px; display: flex; flex-direction: column; gap: 2px` | count cells |
| `.kv-prose dd` | `text-align: left; font-family: var(--sans); font-size: 13px` | the who/use/must rows |
| `.sequence li` | `display: flex; align-items: baseline; gap: 8px; min-height: 26px` | stop rows |
| `.stop-current` | `background: var(--act-bg)` | in-progress row |
| `.tree` | `font-size: 12.5px; padding-left: 18px; color: var(--ink-3)` | `├─ └─` |
| `.read-state` | `font-size: 11px; width: 14px` plus `.is-read { color: var(--ver) } .is-progress { color: var(--act) }` | state glyph |

### 6.7 Responsive

- `< 1200px`: `.paths-grid` becomes one column; instruments keep their full sequences.
- `< 1000px`: `.paths-head` stacks (hero, then marks).
- `< 768px` (phone): padding `16px`; the top bar is the compact one from spec 03; sequences render in full (a reader scrolls); the footer stacks its line over its button; the status bar keeps three cells (`reading paths · 3`, the active path cell, `loaded`). No horizontal overflow at 390.

### 6.8 Status bar

`reading paths · 3` | `{lang} · source {sourceLang}` | `pinned release {id}` | `{path} {done} of {total} · resume {sectionId}` (omitted when `active` is null) | `loaded {s} s`.

### 6.9 Hooks into existing screens

- **Book Home** (02 § 6.2): `continueReading` comes from `getContinueReading`; the signed-in-no-progress state renders the `Choose a path` `Empty` linking here. `getHomeData` keeps its signature; the page passes the session user.
- **Reader** (03 § 6.1): `ChapterData.progress` comes from `getReaderProgress`; the outline block renders when non-null; `useReadingProgress` mounts in `ReaderChapter` when `signedIn`.
- **Top bar**: no new item; the paths page is reached from Book Home's hero link `Reading paths` (new `.cap` link under the blurb, candidate) and from Continue reading.

## 7. States

| State | Render |
|---|---|
| Signed out | paths with all stops `□`, no progress block, `Start path` links; `YourMarks` replaced by the sign-in `Notice`; status bar without the path cell |
| Signed in, no path started | as above with `YourMarks` (zeros, `No notes yet.`); every footer `Start path` |
| Path started, nothing read | `0 of n · {total} left`; first stop `◧` with `· at NN.1`; `Resume at NN.1` |
| Path complete | `n of n · 0 min left`; meter full; footer `Read again` + `Reset` |
| Stop chapter stale or lab failing | the row's `stale {d} d` block or `lab {n}` mark, from the release rows (not progress) |
| Definition version newer than the row's `pathVersion` | progress still counts (D3); a `.meta` line under the progress block: `path updated to {version}; stops you read still count` (candidate) |
| Unknown `[path]` | 404 |
| Loading | `loading.tsx`: chrome + `Loader` `loading reading paths` (candidate) |
| Error | `error.tsx` as in 02 § 7 |
| Action failure (`recordSectionRead`) | silent; the next view retries. `startPath`/`resetPath` failure: `ErrorBox` inline in the footer with the message |

## 8. Strings

Keys under `paths.*`; `home.continue.pathName.*` already exists and is reused for names. PT values marked *candidate* need Andre's confirmation.

| Key | EN | PT |
|---|---|---|
| `paths.metaTitle` | Reading paths · The Harness Bible | Trilhas de leitura · The Harness Bible *(candidate)* |
| `paths.metaTitleOne` | {name} path · The Harness Bible | Trilha {name} · The Harness Bible *(candidate)* |
| `paths.cap` | reading paths · release {id} | trilhas de leitura · release {id} *(candidate)* |
| `paths.title` | Three ways through the book | Três caminhos pelo livro *(candidate)* |
| `paths.blurb` | Each path is a curated sequence of chapters in a fixed order. Progress is kept per account and follows you across devices and editions. | Cada trilha é uma sequência curada de capítulos em ordem fixa. O progresso fica na conta e acompanha você entre dispositivos e edições. *(candidate)* |
| `paths.marks.label` · `.meta` · `.synced` | Your marks · account · synced {when} | Suas marcas · conta · sincronizado {when} *(candidate)* |
| `paths.marks.bookmarks` · `.notes` · `.latest` · `.none` | bookmarks · notes · latest note · {id} · No notes yet. | favoritos · notas · última nota · {id} · Nenhuma nota ainda. *(candidate)* |
| `paths.signIn.title` · `.body` | Sign in to keep progress · Reading paths work without an account; progress and marks need one. | Entre para guardar o progresso · As trilhas funcionam sem conta; progresso e marcas precisam de uma. *(candidate)* |
| `paths.path.label` | Path · {name} | Trilha · {name} *(candidate)* |
| `paths.path.stops` · `.chapters` | {n} stops · {n} chapters | {n} paradas · {n} capítulos *(candidate)* |
| `paths.path.who` · `.use` · `.must` | who it is for · primary use · must have | para quem · uso principal · precisa ter *(candidate)* |
| `paths.path.progress` · `.of` · `.left` | your progress · {done} of {total} · {time} left | seu progresso · {done} de {total} · faltam {time} *(candidate)* |
| `paths.path.time` | {h} h {m} min / {m} min | {h} h {m} min / {m} min |
| `paths.path.footer` | reading time at 230 words/min · labs extra | tempo de leitura a 230 palavras/min · labs à parte *(candidate)* |
| `paths.path.start` · `.resume` · `.again` · `.reset` | Start path · Resume at {id} · Read again · Reset | Começar trilha · Retomar em {id} · Ler de novo · Redefinir *(candidate)* |
| `paths.path.at` | · at {id} | · em {id} *(candidate)* |
| `paths.path.updated` | path updated to {version}; stops you read still count | trilha atualizada para {version}; as paradas lidas continuam valendo *(candidate)* |
| `paths.state.unread` · `.progress` · `.read` | not read · in progress · read | não lido · em andamento · lido *(candidate)* |
| `paths.reset.title` · `.body` · `.cancel` · `.confirm` | Reset the {name} path? · Progress for this path is deleted. Bookmarks and notes are kept. · Cancel · Reset | Redefinir a trilha {name}? · O progresso desta trilha é apagado. Favoritos e notas são mantidos. · Cancelar · Redefinir *(candidate)* |
| `paths.status.count` · `.active` | reading paths · {n} · {path} {done} of {total} · resume {id} | trilhas de leitura · {n} · {path} {done} de {total} · retomar {id} *(candidate)* |
| `paths.groups.*` | why now · choose and pay for it · comply · plan and prove · decision aids · layer 8 · framing and guides · context and knowledge · execution · verification and control · text as numbers · architecture · training · serving · measuring and failing · cost | por que agora · escolher e pagar · cumprir · planejar e provar · apoios à decisão · camada 8 · enquadramento e guias · contexto e conhecimento · execução · verificação e controle · texto como números · arquitetura · treinamento · serving · medir e falhar · custo *(candidate)* |
| `paths.stops.decisionAids` | Decision aids from 21, 23, 28 and 31 | Apoios à decisão dos capítulos 21, 23, 28 e 31 *(candidate)* |
| `paths.executive.who` · `.use` · `.must` | CTO, CDO or operations VP at an industrial company. · Part III, decision aids and the economics chapters; a brief from the assistant. · Fast navigation to decision aids; exportable summaries with citations. | *(candidate translations)* |
| `paths.builder.who` · `.use` · `.must` | Harness or platform engineer. · Part II with labs open; runs, edits, re-runs; copies reference implementations. · Browser IDE with the lab's full environment; diff against the chapter's numbers. | *(candidate)* |
| `paths.foundations.who` · `.use` · `.must` | Builders and executives who need the model underneath the harness. · Part I in order; each chapter's worked numbers before its lab. · Derived figures linked to derive.py; labs that run on a laptop. | *(candidate)* |
| `home.pathsLink` | Reading paths | Trilhas de leitura *(candidate)* |

`tests/messages.test.ts` parity applies.

## 9. Keyboard, accessibility

- Every stop title is a link; the read-state glyph carries `aria-label`; each sequence is an `ol` with `aria-label`; the instruments are `section` with `aria-label` `{Name} path`.
- The progress meter is the existing `Meter` (`role="meter"`, label `{Name} path progress`).
- `Start path` is a `<form>` with a submit button; `Resume` is a link. The reset dialog traps and returns focus.
- The global keyboard map (spec 03 § 9) applies: `/` focuses search, `?` opens the map; no page-specific keys.
- axe AA zero violations on `/en/paths` and `/pt/paths`, signed in and out.

## 10. Out of scope for this unit

- Bookmark and note creation, lists and editing (spec 06); this page only counts them.
- Auth.js, SSO, seats, the `/api/v1/paths` handlers (unit 21); the development session stands in.
- Marking a stop read by hand and per-section read receipts (later; the rules in § 4.3 leave room).
- Path definitions in the book repository (D1); curator-editable paths (Phase 4).
- Reading-time personalisation (the 230 wpm constant is the PRD's).

## 11. Decisions this spec needs

| # | Decision | Recommendation |
|---|---|---|
| D1 | Where path definitions live. The book has none; the screen's sequences are the only source. | `lib/paths/definitions.ts` now, in the shape § 4.2 gives, with a loader that can read `bible/book/paths/*.json` when the book adds them; the version field belongs to the definition. **Material: the book should own these; Andre to confirm the three sequences from the screen are the intended ones.** |
| D2 | The TRD row (`lastSectionId`, `completed`) cannot show the screen's per-stop read states (Builder has 22 and 25 read with 23 unread). | Add `completedStops String[]` and keep `completed` in sync; no per-section table. **Material (schema).** |
| D3 | A path's sequence changes between releases. | `pathVersion` on the row; stops read under an older version still count; ids no longer in the definition are ignored. Routine, stated. |
| D4 | Building a signed-in feature before authentication exists. | `lib/auth/session.ts` with `getSession()`; a development user from `DEV_SESSION_USER_ID` (refused in production) created by the seed; unit 21 swaps the body for Auth.js. **Material: confirm the seam; the alternative is to build unit 21 first and delay this page.** |
| D5 | The route table marks `/paths` as signed-in only. | Render the paths for everyone (they are book content), gate progress and marks on the session. The route table row changes to "any; progress signed in". **Material: deviates from architecture § 3.2.** |
| D6 | Minute estimates need per-section word counts for the `N.8` stop. | `Section.words` filled at ingestion; chapter stops sum sections. Routine (one column, re-ingest in dev). |
| D7 | When a section counts as read. | On the reader page after 15 s or on moving to the next section, for the active path only; a chapter stop is read at its layer 9. Routine, stated; refine with usage data. |
| D8 | Progress recording without API routes. | A server action called from a client hook; `sendBeacon` waits for the handler pipeline. Routine. |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. `prisma migrate deploy` applies `0002_accounts` on the development database; `tsc`, lint, `npm test` (definitions validate against the fixture release; progress rules: unread → in progress → read for chapter and section stops, minutes and `left`, active-path selection, version tolerance), `npm run build`, token grep.
2. Re-ingest fills `Section.words` for all 362 sections; chapter 21's sections sum to within 1% of the chapter's word count minus title and frontmatter.
3. Signed out: `/en/paths` 200 with three instruments, every stop `□`, `Start path` links to `NN.1`, the sign-in `Notice`, status bar without the path cell; `/en/paths/nope` 404.
4. Signed in as the development user with no progress: `YourMarks` shows `0` / `0` / `No notes yet.`; submit `Start path` on Builder: redirected to `/en/ch/16/16.1`; the row exists with `lastSectionId = "16.1"`, `completed = 0`.
5. Read 16.1 → 16.9 (each view calls `recordSectionRead` after 15 s or on `j`): the Builder instrument shows `1 of 14`, stop 16 `■`, stop 17 `◧ · at 17.1` after moving on; Book Home's Continue reading shows `Builder path 1 of 14` and `Resume at 17.1`; the reader outline shows the block on chapter 17 and not on chapter 03.
6. Open `/en/ch/21/21.3` while Builder is active: the row's `lastSectionId` becomes `21.3`; `/en/paths` shows `Resume at 21.3` in the primary button and the status bar cell `builder 1 of 14 · resume 21.3`.
7. Reset Builder through the dialog: the row is gone; the instrument returns to `Start path`; bookmarks and notes untouched.
8. Compare `/en/paths` with `png/Book-Paths.png` at 1440: head row, marks grid, three instruments with the kv rows, progress blocks, grouped sequences with tree glyphs and read states, footers and buttons; list deliberate differences (real word counts give different minutes; the screen's 12 bookmarks and 9 notes are not in the seed; `stale` and `lab 23` marks depend on the release).
9. `/pt/paths` at 390 with Playwright: no horizontal overflow, PT strings, sequences readable; at 1440 PT nothing truncates.
10. axe on `/en/paths` and `/en/paths/builder`, signed in and out: zero AA violations; the reset dialog traps focus.
11. Tenant guard: `prisma.readingPathProgress.findMany()` outside `withTenant` throws `NO_TENANT`; inside it returns only the session user's rows (two seeded users in the integration test).
12. `git status` shows only: `prisma/schema.prisma` + `prisma/migrations/0002_accounts`, `prisma/seed.ts`, `pipeline/build.ts` + `ingest.ts` (`Section.words`), `lib/auth/session.ts`, `lib/env.ts`, `lib/db/client.ts` (tenant models), `lib/db/reader-state.ts`, `lib/db/content.ts` (Continue reading and progress wiring), `lib/paths/*`, `lib/schemas/paths.ts`, `lib/hooks/useReadingProgress.ts`, `app/[lang]/paths/**`, `app/[lang]/ch/[n]/[section]/actions.ts`, `components/paths/*`, `components/reader/ReaderChapter.tsx` (hook mount), `components/reader/HomeHero.tsx` (paths link), `globals.css` (§ 6.6), `ui-context.md` § 9.9, `architecture.md` § 3.2 (D5) and § 4.2, `messages/*`, tests, and the tracker.
