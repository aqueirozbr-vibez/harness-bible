# 07 · Bookmarks and notes — feature spec (reader marks + marks page)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screen: there is no dedicated screen in the UI package. The "Your marks" instrument on `docs/design/screens/Book-Paths.html` (with `png/Book-Paths.png`) fixes the vocabulary (`bookmarks`, `notes`, `latest note · 21.3`, `synced …`, `account`); the reader's actions rail on `Reader-Chapter.html` (`from this section`) fixes where the controls sit; the Improve screens fix the form vocabulary (`.field`, `.textarea`, `label` + counter `note · 137 of 400`). § 6 derives the rest from those and from `context/ui-context.md` (§ 8 instrument panel, § 9.1 buttons, § 9.2 forms, § 9.8 empty states, § 9.10 interaction states, § 12 keyboard map, § 13.4 glyphs). Governing context: `context/architecture.md` (§ 3.4 reader-state endpoints `PUT/DELETE /bookmarks/{sectionId}`, `PUT /notes/{sectionId}`, user, 60/min, idempotent PUTs; § 4 `Bookmark` and `Note` keyed by `userId`; § 7 account deletion removes notes and bookmarks), `context/code-standards.md` (server actions: zod first, session second, tenant context around every query; the URL holds view state; per-user pages are dynamic), `context/project-overview.md` (Capability: bookmarks and notes per account, synced across devices; Phase 1 gate: reader, search, paths, bookmarks and notes). PRD: marks belong to the account and follow the reader across devices and editions. TRD: one bookmark and one note per user and section.

Prerequisite specs: `03-reader-chapter.md` (the rail, `SectionActions`, `SectionHead`, the keyboard map), `04-content-domain-schema.md` § 9 (the shape of `Bookmark` and `Note`), `05-reader-paths.md` (migration `0002_accounts` with both tables, the tenant guard, the session seam, `YourMarks` and `marksOf`, the server-action pattern), `06-search.md` § 6.5 (the disabled `Save search` button).

Scope: tracker unit 20. The bookmark toggle and the note editor in the reader, the two lists behind the "Your marks" cells on a new marks page, the loaders and server actions behind them, the one schema change they need, and the keyboard keys. The `/api/v1/bookmarks` and `/api/v1/notes` handlers are unit 21 and call the same functions.

## 1. Purpose

A reader marks a place and writes a thought without leaving the section. The bookmark is one button in the section's actions rail: pressed means the section is kept; pressing again removes it. The note is a small editor under the same rail: one note per section, saved when the reader says so, shown again on every device. The marks page lists both: bookmarks in book order, notes newest first, each a link back to its section, each removable. Nothing here is a document tool: no tags, no colours, no rich text, no sharing.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| Migration `0002_accounts` (done): `Bookmark`, `Note`, the tenant guard with both models keyed by `userId` | the rows |
| Session seam (05, done): `getSession()`, `tenantOf(user)`, the development user | who owns the rows; SSO is unit 21 |
| Migration `0004_marks` (this spec, § 4.3) | one note per user and section, so `saveNote` is an upsert and the endpoint's `PUT` is idempotent |
| Reader (03, done): `SectionActions`, `SectionHead`, `ReaderChapter`, the rail rendered twice (rail and inline) | where the controls live |
| Paths page (05, done): `YourMarks`, `marksOf` | the cells that link to the lists; the counts |
| `Field`, `Button`, `InstrumentPanel`, `Empty`, `Notice`, `ErrorBox`, the `ResetPathDialog` pattern | the components the UI is composed from |

Build order: 20a migration `0004_marks` and `prisma generate` → 20b `lib/db/marks.ts` (reads and writes inside the tenant context) with integration tests and `lib/schemas/marks.ts` → 20c the reader half: `ChapterData.marks`, the three server actions, `MarkActions` and `NoteEditor` (client), keys `b` and `n`, the `SectionHead` indicator → 20d the marks page `/[lang]/marks` with its actions, `YourMarks` links → verification.

## 3. Routes and rendering

| Route | Behaviour |
|---|---|
| `/[lang]/ch/[n]/[section]` | unchanged route; signed in, the rail gains the bookmark button and the note editor for this section (§ 6.1, § 6.2); signed out, neither renders and the rail is as today |
| `/[lang]/marks` | the marks page: bookmarks and notes of the signed-in reader (§ 6.4); signed out, the sign-in `Notice` from the paths page in place of the lists (§ 7); RSC, dynamic (`export const dynamic = "force-dynamic"` with the one-line reason: every row is per user) |
| `/[lang]/marks#bookmarks`, `/[lang]/marks#notes` | the two instruments' anchors, linked from the "Your marks" cells |
| `/[lang]/marks?removed=21.3`, `?deleted=21.3` | after a remove or delete from the page: the row is gone and a one-line `Notice` says so (the action redirects here; the URL is the state, no client message) |

Metadata: `Bookmarks and notes · The Harness Bible` (candidate); `robots: noindex`; `alternates.languages`.

No API routes and no fetch: everything goes through server actions (§ 5.3). The reader page is already `force-dynamic` (05 § 6.9), so a fresh load shows the saved state; the actions revalidate nothing (the `recordSectionRead` lesson in 05 D8: a revalidation refreshes the open reader and records the view again).

Performance: the reader's marks add two indexed point reads per request (`Bookmark` and `Note` by `(userId, sectionId)`), inside the same tenant call as `getReaderProgress`; no cache (per user). The marks page reads all of the user's rows in two queries and joins them to the cached release content in memory; a reader with 500 marks stays under 100 ms.

## 4. Data contract

```ts
// lib/schemas/marks.ts
const NOTE_MAX = 2000;                                  // characters, after trim; D2

interface SectionMarks {                                // ChapterData.marks; null when signed out
  readonly bookmarked: boolean;
  readonly note: { readonly body: string; readonly updatedAt: Date } | null;
}

interface MarkRow {                                     // one bookmark or note on the marks page
  readonly sectionId: SectionId;
  readonly chapterNumber: number;
  readonly href: string;                                // /[lang]/ch/NN/NN.k
  /** Title in the edition, chapter title, layer ordinal; null when the section is not in the current release (D4). */
  readonly section: { readonly title: string; readonly chapterTitle: string; readonly ordinal: number } | null;
}

interface BookmarkRow extends MarkRow { readonly createdAt: Date }
interface NoteRow extends MarkRow { readonly body: string; readonly updatedAt: Date }

interface MarksData {
  readonly release: { readonly id: ReleaseId; readonly gitSha: string };
  readonly bookmarks: ReadonlyArray<BookmarkRow>;       // book order: chapter, then section ordinal (D3)
  readonly notes: ReadonlyArray<NoteRow>;               // updatedAt desc (D3)
  readonly syncedAt: Date | null;                       // as marksOf: the latest write across bookmarks, notes, progress
  readonly signedIn: boolean;
  readonly sourceLang: Lang;
}
```

`ChapterData` gains `marks: SectionMarks | null` next to `progress` (03 § 4, 05 § 6.9). `PathsData.marks` (05 § 4) is unchanged; its `latest` now also carries `href` so the cell links to the section.

Zod: `SectionMarksSchema`, `MarksDataSchema` (rows sorted as stated, checked by a refinement in tests, not at parse time), `NoteBodySchema = z.string().trim().max(NOTE_MAX)`; an empty body is allowed as input and means "delete" (§ 5.3).

### 4.1 Rules (pure, `lib/marks/rules.ts`)

- `normaliseNote(body)`: `\r\n` → `\n`, trim, collapse more than two blank lines into two; the result is what is stored and counted.
- `noteLength(body)`: code points after `normaliseNote` (the counter and the limit agree with the server).
- `orderBookmarks(rows)`, `orderNotes(rows)`: the two sorts of § 4, so the page and the tests share them.
- `excerpt(body, 90)`: the paths page's latest-note truncation moves here from `marksOf` (same behaviour: whitespace collapsed, cut at a word boundary, `…`).

### 4.2 Schema change (migration `0004_marks`)

```prisma
model Note {
  …
  @@unique([userId, sectionId])   // one note per user and section (D1); @@index([userId, updatedAt]) stays
}
```

SQL, hand-written as in 06 § 4.3 (`prisma migrate dev` hangs on this machine): `CREATE UNIQUE INDEX "Note_userId_sectionId_key" ON "Note"("userId", "sectionId");`. The development database has no notes, so no backfill; the migration is still guarded for other environments: the same file first deletes all but the newest note per `(userId, sectionId)` with a `DELETE … USING` on `ROW_NUMBER()`, so it applies on any data. `RAW_SQL.md` lists it.

`Bookmark` is unchanged (`@@unique([userId, sectionId])` exists). Neither table references `Section` by foreign key: marks survive a re-ingest and a release change (04 D19 surrogate ids; the anchor is the stable name), and a mark on a section that left the book shows as "not in release" (§ 7) instead of vanishing.

## 5. Backend

### 5.1 Loaders (`lib/db/marks.ts`)

| Function | Reads | Returns |
|---|---|---|
| `sectionMarksOf(user, sectionId)` | `Bookmark` and `Note` by `(userId, sectionId)` inside `withTenant(tenantOf(user))` | `SectionMarks` |
| `getMarksData(locale, user)` | all of the user's bookmarks and notes (two queries) inside the tenant context; then the cached release content (`loadMarkContent`: every chapter's editions plus `sections { anchor, ordinal, titleEn, titlePt }`, `cached("mark-content")`, tag `release:current`) | `MarksData`; `bookmarks` and `notes` empty and `signedIn: false` when `user` is null |
| `marksOf(user)` (05, moved here from `reader-state.ts`) | unchanged counts and latest note, now with `href` and the excerpt from `lib/marks/rules.ts` | `PathsData.marks` |

`getChapterData(locale, chapter, sectionId, user)` calls `sectionMarksOf` next to `getReaderProgress` and passes `marks` into the schema. Nothing in `Section` or `ChapterVersion` changes.

### 5.2 Writes (`lib/db/marks.ts`)

| Function | Effect |
|---|---|
| `setBookmarkFor(user, sectionId, on)` | `on`: `upsert` on `userId_sectionId` (a repeat is a no-op, so the endpoint's `PUT` is idempotent); `off`: `deleteMany` (a repeat deletes nothing). Returns the resulting `bookmarked`. |
| `saveNoteFor(user, sectionId, body)` | body after `normaliseNote`; empty → `deleteMany` and returns `null`; otherwise `upsert` on `userId_sectionId` with `{ body }` and returns `{ body, updatedAt }`. Length over `NOTE_MAX` throws `NOTE_TOO_LONG` (the action turns it into an error result; the editor stops it earlier). |
| `deleteNoteFor(user, sectionId)` | `deleteMany`; returns whether a row went. |

Every write validates the section against the current release first (`sectionExists(sectionId)` from the cached content; unknown → `UNKNOWN_SECTION`), so a hand-typed id cannot create rows. Writes on a section that later leaves the release are still allowed to delete (the marks page must be able to clean up), so the existence check applies to `on` and to a non-empty save only.

All queries run inside `withTenant(tenantOf(user), …)` and rely on the guard's injected `userId`; `where: { sectionId }` never names the user (04 § 4). The `/api/v1` handlers of unit 21 wrap these same functions.

### 5.3 Server actions

Reader (`app/[lang]/ch/[n]/[section]/actions.ts`, beside `recordSectionRead`; same pattern: `"use server"`, zod first, `getSession()` second, `ActionResult<T>`; no redirect, no revalidation):

| Action | Input | Result |
|---|---|---|
| `toggleBookmark({ sectionId, on })` | `SectionId`, boolean | `{ bookmarked }` |
| `saveNote({ sectionId, body })` | `SectionId`, `NoteBodySchema` | `{ note: { body, updatedAt } \| null }` (`null` when the body was empty and the row went) |
| `deleteNote({ sectionId })` | `SectionId` | `{ deleted }` |

Error codes: `INVALID_INPUT`, `NO_SESSION`, `UNKNOWN_SECTION`, `NOTE_TOO_LONG`, `MARK_WRITE_FAILED`. Messages say what would pass (`a note is at most 2000 characters`).

Marks page (`app/[lang]/marks/actions.ts`; form actions like `startPath`/`resetPath`: `FormData` in, zod, session, `redirect`):

| Action | Form fields | Effect |
|---|---|---|
| `removeBookmark` | `sectionId`, `locale` | `setBookmarkFor(user, id, false)`; redirect to `/[lang]/marks?removed={id}#bookmarks` |
| `deleteNoteFromList` | `sectionId`, `locale` | `deleteNoteFor`; redirect to `/[lang]/marks?deleted={id}#notes` |

A failed form action redirects with `?error=remove` / `?error=delete` and the page renders an `ErrorBox` (the paths page pattern). A signed-out submit redirects to `/[lang]/marks` (the page then shows the sign-in notice).

Rate limit (60/min in the TRD) is the handler pipeline's job in unit 21; the actions carry none. The editor cannot exceed it by hand (one save per click).

## 6. Layout and components

Components in `components/reader/` (reader half) and `components/marks/` (page). Server unless marked.

### 6.1 `MarkActions` (client) in the actions rail

The `from this section` list (`SectionActions`) gains, when `marks !== null`, a first row before `Run Lab`:

```
from this section
┌──────────────────────────────────────┐
│ Bookmark this section            [b] │   ← unpressed: default button
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│ ■ Bookmarked · remove            [b] │   ← pressed: aria-pressed, --ver ink, ver-bg wash
└──────────────────────────────────────┘
```

A `Button` (`type="button"`, `aria-pressed`, class `.rail-btn.mark-btn`, `.is-on` when bookmarked) with the label `Bookmark this section` / `Bookmarked · remove` and `Kbd` `b`. The glyph before the pressed label is the 8px status square of `.st` (`.st.ok`), never a pictogram (ui-context § 13.4). Click → `startTransition(toggleBookmark({ sectionId, on: !bookmarked }))` with optimistic state; on an error result the state reverts and a `.help.err` line under the button shows the message for 6 s (`role="status"`). While the transition is pending the button is `aria-busy` and keeps its label (no spinner; 100 ms is the usual time).

The rail is rendered twice (`.reader-rail` and `.reader-rail-inline`, one hidden by CSS per breakpoint). `MarkActions` and `NoteEditor` therefore take an `idPrefix` (`rail` / `inline`) for their ids and `aria-*` references; the two instances keep independent state until the next navigation, and the keyboard keys (§ 9) act on the visible one (`offsetParent !== null`).

### 6.2 `NoteEditor` (client) under the actions rail

```
┌ note · 21.3 ───────────────────  142 / 2000 ┐
│ ┌──────────────────────────────────────────┐ │
│ │ Check key scope for batched writes       │ │   .textarea, 4 rows, resize vertical
│ │ before Lab 21.                           │ │
│ └──────────────────────────────────────────┘ │
│ saved 21 Sep 08:02              [Delete note] [Save note] │
└──────────────────────────────────────────────┘
```

A `section.col.note-editor` (`aria-labelledby` its `.cap`): `Field` with label `note · {sectionId}` and counter `{n} / 2000` (`n` from `noteLength`; the counter turns `--warn` at 1900 and `--fail` above 2000 while the `Save note` button disables), a `.textarea` (`rows=4`, `spellCheck`, `maxLength` not set so the counter can show the overflow), then a `.between` footer: the status `.meta` (`aria-live="polite"`) reading `saved {day-month time}` after a save or when a note exists and is unchanged, `unsaved changes` when the text differs from the saved body, `saving` during the transition, `not saved · {message}` in `--fail` after an error, `no note yet` (candidate) when empty and nothing saved; and the buttons `Delete note` (`Button variant="quiet" size="sm"`, shown only when a note exists; confirm dialog § 6.3) and `Save note` (`Button size="sm"`, disabled when unchanged or over the limit).

Saving: click or `ctrl+enter` / `⌘+enter` inside the textarea → `saveNote({ sectionId, body })`; the returned `note` becomes the saved state (an empty body that clears an existing note returns `null` and the editor reads `note deleted` (candidate) then `no note yet`). No autosave, no draft in `localStorage` (D5): leaving the page with unsaved changes asks nothing, but `beforeunload` is not hooked either; the reader is told by the status line, which is what a careful colleague would accept in a note field this small.

The editor is always rendered, also when no note exists (one textarea is not clutter, and a reader should not have to find an "add note" control first); the textarea starts empty with the label above it and no placeholder (ui-context § 9.2: never placeholder-only).

### 6.3 `DeleteNoteDialog` (client)

The confirm dialog for `Delete note` follows `ResetPathDialog` (05 § 6.5) and is built by generalising it: `components/ui/ConfirmDialog.tsx` (`title`, `body`, `cancel`, `confirm`, `onConfirm`, focus trapped and returned, `esc` cancels, `.peek.dialog-box`) with `ResetPathDialog` becoming a thin wrapper over it. In the reader the confirm calls `deleteNote` and clears the editor; on the marks page it submits `deleteNoteFromList`. Text: `Delete the note on {id}?` / `The text is deleted. The bookmark, if any, is kept.` (candidate), `Cancel`, destructive `Delete`.

### 6.4 `MarksPage` (`/[lang]/marks`)

Desktop (1440): `main.marks-page` with the paths page's `28px 40px 32px` padding and 24px gaps; a head row (`.cap` `your marks · account · synced {when}`, `h1.h1` `Bookmarks and notes`, `.muted` blurb `Marks belong to your account and follow you across devices and editions.` (candidate)); then two instruments in a `repeat(2, minmax(0,1fr))` grid; then the status bar.

```
┌ topbar ──────────────────────────────────────────────────────────────────────┐
│ your marks · account · synced 21 Sep 08:02                                   │
│ Bookmarks and notes                                                          │
│ ┌ BOOKMARKS · 12 · book order ─────────┐ ┌ NOTES · 9 · newest first ───────┐ │
│ │ 07.2  Mechanism            ch07 ·  … │ │ 21.3  Worked numbers   21 Sep   │ │
│ │       layer 2         [Remove]       │ │       Check key scope for …     │ │
│ │ 16.1  Framing              ch16 ·  … │ │       [Open] [Delete]           │ │
│ │ …                                    │ │ …                               │ │
│ └ ✢ 12 of 12 shown ────────────────────┘ └ ✢ 9 of 9 shown ─────────────────┘ │
└ statusbar: your marks · 12 bookmarks · 9 notes | EN · source EN | pinned release | loaded ┘
```

- `BookmarkList` (`InstrumentPanel` label `Bookmarks` · meta `{n}` · timestamp `book order`, `id="bookmarks"`, body `bare`): `ol.rt` (`aria-label` `Bookmarks`), each row `li.mark-row` (`padding: 10px 16px`, column, gap 4px): head `.row` baseline with `.mono.mark-id` (`21.3`, 13px, `min-width: 44px`, `--ink-2`), `a.small` title (600, to `href`), `.small.faint` `ch{n} · {chapterTitle}`; meta `.between`: `.cap` `layer {ordinal} · {name}` (reuses `reader.layer.*`) and a `form` posting `removeBookmark` with `Button variant="quiet" size="sm"` `Remove`. Not in the release: title reads the id alone, the cap reads `not in release {id}` in `--warn` (D4). Footer `.inst-f` `{n} of {n} shown` (no paging in this unit: a reader who keeps more than 200 bookmarks is a decision for later, D6).
- `NoteList` (`InstrumentPanel` label `Notes` · meta `{n}` · timestamp `newest first`, `id="notes"`): rows as above with `.meta` `{day-month time}` on the right of the head; body `p.small.note-body` (`white-space: pre-wrap`, `max-width: 60ch`, full text, no truncation); actions `.row`: `Button size="sm" href` `Open` (to the section; the editor is there) and `Delete` (quiet, `DeleteNoteDialog` submitting `deleteNoteFromList`).
- Empty: `Empty` caption `bookmarks` / `notes`: `No bookmarks yet.` + `.muted` `Press b in any section, or use Bookmark this section in the rail.` (candidate); `No notes yet.` + `.muted` `The note field sits under the actions of every section.` (candidate).
- After `?removed=` / `?deleted=`: a `Notice` above the grid: `Bookmark on {id} removed.` / `Note on {id} deleted.` (candidate); `?error=`: `ErrorBox` `The mark was not changed` (candidate) with the code's line.

### 6.5 Hooks into existing screens

- **`YourMarks`** (05 § 6.2): the two count cells link to `/[lang]/marks#bookmarks` and `/[lang]/marks#notes`; the latest-note cell becomes a `.rr` link to `marks.latest.href`; the `Empty` text stays.
- **`SectionHead`** (03 § 6.3): when `marks?.bookmarked`, a `.meta.mark-flag` `■ bookmarked` (candidate; `--ver`) after the layer cap, so the state is visible without the rail. Read only.
- **`Outline`** (03 § 6.1): unchanged (bookmark glyphs on every layer row would need nine more reads per request for a marginal gain; D7).
- **`SearchRail`** (06 § 6.5): `Save search` stays disabled; its title changes from `arrives with bookmarks` to `not in this release` (candidate). Saved searches have no TRD model and are out of scope (§ 10, D8).
- **`KeyboardMap`**: two rows when `signedIn`: `b` `bookmark this section`, `n` `write a note` (§ 9); the page passes `signedIn`.
- **Top bar**: no new item. The page is reached from `YourMarks` and from the status line of the editor (`saved …` is not a link; the `Open` links are on the page). D9 offers a `Marks` link under the account item later, with unit 21's account menu.

### 6.6 Responsive

- `< 1200px`: `.marks-lists` is one column (bookmarks, then notes).
- `768–999px` (tablet): the rail moves into the reading column, so the editor sits in `.reader-rail-inline` under the actions, the textarea full width, buttons 44px tall (`btn-sm` is 28px: the phone rule of ui-context § 9.1 applies via `.note-editor .btn { min-height: 44px }` under 768px).
- `< 768px` (phone): padding 16px; `.mark-row` head wraps (id, title, then context on its own line); the note list's `Open` and `Delete` stay on one row. Both rails are hidden here (03 § 6.10), so neither `MarkActions` nor `NoteEditor` renders in the reader: since 2026-09-24 the bookmark is the middle cell of the phone `BottomActionBar` (03 § 6.10; Andre's answer 6, “agree, add the button”), which calls the same action and carries the same states as § 6.1, and the note editor is still not on the phone — the half of the question that was not answered. No horizontal overflow at 390 or at 320.

### 6.7 Status bar

Marks page: `your marks · {b} bookmarks · {n} notes` | `{lang} · source {sourceLang}` | `pinned release {id}` | `loaded {s} s`. Reader: unchanged.

### 6.8 New composition classes (`globals.css`, then ui-context § 9.9)

| Class | Rule | Used by |
|---|---|---|
| `.mark-btn.is-on` | `color: var(--ver); background: var(--ver-bg); border-color: var(--ver)`; the `.st` square before the label | bookmark button |
| `.mark-flag` | `color: var(--ver); margin-left: 8px` | section head indicator |
| `.note-editor` | `display: flex; flex-direction: column; gap: 8px; padding-top: 14px; border-top: 1px solid var(--rule)` | reader rail |
| `.note-editor .textarea` | `min-height: 96px; font-size: 14px; line-height: 22px` (inherits `.textarea`) | editor |
| `.note-status` | `.meta` with `.is-dirty { color: var(--ink-2) } .is-error { color: var(--fail) }` | status line |
| `.counter.is-near` / `.is-over` | `color: var(--warn)` / `color: var(--fail)` | counter |
| `.marks-page` | `padding: 28px 40px 32px; display: flex; flex-direction: column; gap: 24px` | page |
| `.marks-lists` | `display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 24px; align-items: start` | two instruments |
| `.mark-row` | `padding: 10px 16px; display: flex; flex-direction: column; gap: 4px` + `.rt` rule between rows | list rows |
| `.mark-id` | `font-size: 13px; min-width: 44px; color: var(--ink-2)` | mono column |
| `.note-body` | `white-space: pre-wrap; max-width: 60ch; overflow-wrap: anywhere` | note text |

## 7. States

| State | Render |
|---|---|
| Signed out, reader | no `MarkActions`, no `NoteEditor`, no `mark-flag`; keys `b` and `n` do nothing; the map omits their rows |
| Signed in, section unmarked | `Bookmark this section`; editor empty with `no note yet`; `Save note` disabled |
| Signed in, bookmarked with a note | `Bookmarked · remove` pressed; `■ bookmarked` in the head; editor filled, `saved {when}` |
| Editing | `unsaved changes`; `Save note` enabled; counter live |
| Over the limit | counter `2 041 / 2000` in `--fail`; `Save note` disabled; status `2000 characters at most` (candidate) |
| Save or toggle fails | reader: the state reverts (bookmark) or stays dirty (note) and the message shows; the next attempt retries. Page: `?error=` → `ErrorBox` |
| Mark on a section not in the current release | list row with the id alone and `not in release {id}`; `Remove` / `Delete` still work; the row links nowhere (no `href`) |
| Signed out, `/marks` | head, the sign-in `Notice` (05 § 7) in place of the grid, status bar without the counts |
| Signed in, nothing marked | both `Empty` states; `synced` omitted |
| After remove or delete | the `Notice` line; the count in the instrument's meta is the new one |
| Loading | none: the reader's `loading.tsx` rules apply as before; `/marks` has no `loading.tsx` (05's lesson: it masked the 404 and broke no-JS) |
| Error | `app/[lang]/marks/error.tsx` as in 02 § 7 |

## 8. Strings

Keys under `reader.marks.*` (reader half), `reader.keys.*` (two rows) and `marks.*` (page). Layer names reuse `reader.layer.*`; the sign-in notice reuses `paths.signIn.*`; the status-bar cells reuse `home.statusbar.*`. PT values marked *candidate* need Andre's confirmation.

| Key | EN | PT |
|---|---|---|
| `reader.marks.bookmark` · `.bookmarked` · `.bookmarkLabel` | Bookmark this section · Bookmarked · remove · Bookmark section {id} | Marcar esta seção · Marcada · remover · Marcar a seção {id} *(candidate)* |
| `reader.marks.flag` | bookmarked | marcada *(candidate)* |
| `reader.marks.noteLabel` · `.counter` · `.editorLabel` | note · {id} · {n} / {max} · Note on section {id} | nota · {id} · {n} / {max} · Nota na seção {id} *(candidate)* |
| `reader.marks.status.none` · `.saved` · `.dirty` · `.saving` · `.deleted` · `.error` · `.tooLong` | no note yet · saved {when} · unsaved changes · saving · note deleted · not saved · {message} · {max} characters at most | ainda sem nota · salva {when} · alterações não salvas · salvando · nota apagada · não salva · {message} · no máximo {max} caracteres *(candidate)* |
| `reader.marks.save` · `.delete` | Save note · Delete note | Salvar nota · Apagar nota *(candidate)* |
| `reader.marks.confirm.title` · `.body` · `.cancel` · `.confirm` | Delete the note on {id}? · The text is deleted. The bookmark, if any, is kept. · Cancel · Delete | Apagar a nota em {id}? · O texto é apagado. A marcação, se houver, é mantida. · Cancelar · Apagar *(candidate)* |
| `reader.marks.error.unknownSection` · `.noSession` · `.failed` | {id} is not in release {release} · sign in to keep marks · the mark was not saved | {id} não está na release {release} · entre para manter as marcas · a marca não foi salva *(candidate)* |
| `reader.keys.bookmark` · `.note` | bookmark this section · write a note | marcar esta seção · escrever uma nota *(candidate)* |
| `search.actions.saveSoon` (changed) | not in this release | não nesta release *(candidate)* |
| `marks.metaTitle` · `.cap` · `.capSynced` · `.title` · `.blurb` | Bookmarks and notes · The Harness Bible · your marks · account · your marks · account · synced {when} · Bookmarks and notes · Marks belong to your account and follow you across devices and editions. | Favoritos e notas · The Harness Bible · suas marcas · conta · suas marcas · conta · sincronizado {when} · Favoritos e notas · As marcas pertencem à sua conta e acompanham você entre dispositivos e edições. *(candidate)* |
| `marks.bookmarks.label` · `.order` · `.list` · `.remove` · `.shown` | Bookmarks · book order · Bookmarks · Remove · {n} of {n} shown | Favoritos · ordem do livro · Favoritos · Remover · {n} de {n} exibidos *(candidate)* |
| `marks.notes.label` · `.order` · `.list` · `.open` · `.delete` · `.shown` | Notes · newest first · Notes · Open · Delete · {n} of {n} shown | Notas · mais recentes primeiro · Notas · Abrir · Apagar · {n} de {n} exibidas *(candidate)* |
| `marks.row.context` · `.layer` · `.gone` | ch{n} · {title} · layer {n} · {name} · not in release {id} | cap. {n} · {title} · camada {n} · {name} · não está na release {id} *(candidate)* |
| `marks.empty.bookmarks` · `.bookmarksHint` · `.notes` · `.notesHint` | No bookmarks yet. · Press b in any section, or use Bookmark this section in the rail. · No notes yet. · The note field sits under the actions of every section. | Nenhum favorito ainda. · Pressione b em qualquer seção ou use Marcar esta seção na barra lateral. · Nenhuma nota ainda. · O campo de nota fica abaixo das ações de cada seção. *(candidate)* |
| `marks.notice.removed` · `.deleted` | Bookmark on {id} removed. · Note on {id} deleted. | Favorito em {id} removido. · Nota em {id} apagada. *(candidate)* |
| `marks.error.title` · `.remove` · `.delete` · `.session` | The mark was not changed · The bookmark was not removed. Retry. · The note was not deleted. Retry. · Sign in to change marks. | A marca não foi alterada · O favorito não foi removido. Tente novamente. · A nota não foi apagada. Tente novamente. · Entre para alterar marcas. *(candidate)* |
| `marks.statusbar.counts` | your marks · {b, plural, one {# bookmark} other {# bookmarks}} · {n, plural, one {# note} other {# notes}} | suas marcas · {b, plural, one {# favorito} other {# favoritos}} · {n, plural, one {# nota} other {# notas}} *(candidate)* |

`paths.marks.*` is unchanged. `tests/messages.test.ts` parity applies.

## 9. Keyboard, accessibility

- `b` toggles the bookmark of the current section; `n` focuses the note textarea of the visible editor (scrolling it into view). Both go through `resolveKeyAction` (new actions `bookmark` and `note`; `KeyTargets` gains `bookmark: (() => void) | null` and `note: (() => void) | null`, set by a small client bridge in `ReaderChapter` that `MarkActions`/`NoteEditor` register with through a context, `null` when signed out). Like every other key they never fire with a modifier, in a field, or when the viewer turned shortcuts off; `esc` inside the textarea blurs it (so `j`/`k` work again) without discarding text.
- The bookmark button is a real `button` with `aria-pressed` and a visible label change (no colour-only state); `aria-busy` while pending.
- The editor's textarea has a visible `label`, `aria-describedby` the counter and the status line; the status line is `aria-live="polite"`; the counter changes are announced only when they cross 1900 (the `Field` counter is already live: to avoid announcing every keystroke the counter's `aria-live` is switched off and the crossing is announced through the status line).
- The confirm dialog: `role="dialog"`, `aria-modal`, focus trapped and returned, `esc` cancels (the `ResetPathDialog` behaviour, now in `ConfirmDialog`).
- Lists are `ol` inside labelled instruments; row actions are buttons in forms (work without JavaScript); `Open` is a link.
- axe AA zero violations on `/en/ch/21/21.3` (signed in, with a note), `/en/marks` and `/pt/marks`.

## 10. Out of scope for this unit

- Saved searches (no TRD model; D8), tags, colours, highlights of text ranges, rich text, markdown rendering of notes (shown as plain text), sharing or exporting marks.
- `PUT/DELETE /api/v1/bookmarks/{sectionId}`, `PUT /api/v1/notes/{sectionId}` and the 60/min limit (unit 21).
- Paging or search inside the marks page (D6); sorting options beyond the two fixed orders.
- Bookmark glyphs in the outline (D7) and a top-bar link to the page (D9).
- Notes on labs, figures or registry rows (marks are per section, as the models say).
- Account deletion cascade (architecture § 7; unit 21 or later).

## 11. Decisions this spec needs

| # | Decision | Recommendation |
|---|---|---|
| D1 | One note per user and section. | Yes: the TRD's `PUT /notes/{sectionId}` is idempotent and the instrument says `latest note · 21.3`; migration `0004_marks` adds the unique index. **Material (schema).** |
| D2 | Note length limit. | 2000 characters after normalisation (five short paragraphs); the counter and the server agree via `noteLength`. Routine, stated. |
| D3 | List orders. | Bookmarks in book order (they are places), notes newest first (they are writing). Routine, stated. |
| D4 | Marks on sections that leave the release. | Keep the rows; show `not in release {id}` and allow removal. No cascade and no foreign key (the anchor is the stable name). Routine, stated. |
| D5 | Autosave. | No: explicit `Save note` and `ctrl+enter`; the status line says `unsaved changes`. Autosave would write on every pause and fight the 60/min limit of the endpoint. Routine, stated. |
| D6 | Paging on the marks page. | None; everything renders. Revisit when a reader passes 200 marks. Routine. |
| D7 | Bookmark glyphs in the outline. | Not now; nine extra reads per request for a marginal signal; the section head carries the flag. Routine. |
| D8 | `Save search`. | Stays disabled; title `not in this release`; a `SavedSearch` model would be a TRD addition. **Material only in that spec 06 said "arrives with bookmarks"; this spec retracts that.** |
| D9 | How the page is reached. | From `YourMarks` on `/paths` and the `Open` links; a `Marks` entry in the account menu arrives with unit 21. Routine. |
| D10 | Where the writes live. | `lib/db/marks.ts` with `marksOf` moved there from `reader-state.ts`; the actions stay beside the pages that call them. Routine. |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Migration `0004_marks` applies on the development database and on one seeded with two notes on the same `(userId, sectionId)` (the older goes); `RAW_SQL.md` lists it; `prisma generate` exposes `userId_sectionId` on `Note`.
2. tsc, lint, `npm test` (rules: `normaliseNote`, `noteLength` on code points and CRLF, `excerpt` at 90, both orders; integration under the tenant: toggle on twice leaves one row, off twice leaves none, `saveNoteFor` upserts and returns `updatedAt`, empty body deletes, 2001 characters throws `NOTE_TOO_LONG`, unknown section throws `UNKNOWN_SECTION`, `getMarksData` sorts as stated and marks a bookmark on `99.9` as not in the release; a query outside the tenant context throws `NO_TENANT`; messages parity), `npm run build`, token grep.
3. `/en/ch/21/21.3` signed in as the development user: the rail shows `Bookmark this section` with `b`; click → `Bookmarked · remove` pressed, `■ bookmarked` in the head after reload, the `Bookmark` row exists; click again → gone.
4. Type 30 characters in the note field: counter `30 / 2000`, `unsaved changes`, `Save note` enabled; `ctrl+enter` → `saved {when}`, the `Note` row holds the normalised body; reload shows it; `Delete note` → dialog → the row is gone and the field empty.
5. Paste 2001 characters: counter in `--fail`, `Save note` disabled, status `2000 characters at most`.
6. `b` toggles and `n` focuses the field; neither fires inside the field; `esc` leaves the field; the map (`?`) lists both rows when signed in and neither when signed out.
7. `/en/paths`: `YourMarks` counts `1` / `1`, the cells link to `/en/marks#bookmarks` / `#notes`, the latest-note cell links to `/en/ch/21/21.3`.
8. `/en/marks`: both instruments with the rows (id, title, context, layer cap; note body in full with the time), `Remove` → `?removed=21.3` and the notice, `Delete` → dialog → `?deleted=21.3`; both `Empty` states after; signed out (`DEV_SESSION_USER_ID` unset) → the sign-in notice.
9. A bookmark inserted by SQL on `99.9`: the row reads `99.9` and `not in release 2026.09`, `Remove` works.
10. With JavaScript off: `Remove` and `Delete` forms on the page submit and redirect; in the reader the bookmark button and the editor are client components and do nothing without JavaScript, which is accepted and recorded in the tracker (the reader's other actions are links; the marks page is the no-JS way to remove marks).
11. `/pt/marks` and `/pt/ch/21/21.3` at 390: no overflow, the editor full width under the inline rail, 44px buttons; at 1440 PT nothing truncates.
12. axe on `/en/ch/21/21.3` (signed in, with a note), `/en/marks`, `/pt/marks`: zero AA violations.
13. `git status` shows only: `prisma/schema.prisma` + `prisma/migrations/…_marks`, `lib/db/RAW_SQL.md`, `lib/db/marks.ts`, `lib/db/reader-state.ts` (`marksOf` moved out), `lib/db/content.ts` (`marks`), `lib/marks/rules.ts`, `lib/schemas/{marks,chapter,paths}.ts`, `lib/hooks/useKeyboardMap.ts`, `app/[lang]/ch/[n]/[section]/{actions,page}.tsx`, `app/[lang]/marks/**`, `components/reader/{MarkActions,NoteEditor,SectionActions,SectionHead,ReaderChapter}.tsx`, `components/marks/*`, `components/ui/ConfirmDialog.tsx`, `components/paths/{ResetPathDialog,YourMarks}.tsx`, `components/chrome/KeyboardMap.tsx`, `components/search/SearchRail.tsx` (title only), `globals.css` (§ 6.8), `ui-context.md` § 9.9, `architecture.md` § 3.2 (the `/[lang]/marks` route) and § 4 (the unique index), `messages/*`, tests, and the tracker.
