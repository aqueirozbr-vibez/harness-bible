# 24 · Assistant 2.0, the dock anywhere — feature spec (the dock without a chapter, mounted once for every page, the `a` key everywhere, the mode pickers over the whole release)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting. This unit writes Next.js code: read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/parallel-routes.md` first (`AGENTS.md`).

Source of truth for the screen: the dock's anatomy is unchanged and stays with `docs/design/screens/Assistant-Answer.html` and `Assistant-Refusal-Walk.html` (specs 16 and 17). No screen of the package shows the dock outside the reader. Outside the reader this spec uses the form the dock already takes under 1000px (fixed, 520px, a backdrop that closes it), which unit 30 built and verified, so no new layout is invented.

Prerequisite specs: `23-assistant-book-scope.md` (unit 40: a conversation without a chapter, `CitationView.deriveLine`), `16-assistant-dock.md` (the dock, its URL state, its turns), `17-refusal-log-flags.md` (the log rail), `18-decision-aid-walk.md` and `19-assistant-modes.md` (the mode bodies and their context lines).

Scope: tracker unit 41. Where the dock mounts, what it needs to be given, what each mode's context line picks from, what its links point to, and the entry points (`a`, the reader's Ask button, the search page's Ask action). Not here: the server (23), the statistics (25), the `/assistant` page (26), the phone sheet (spec 20, skipped: under 768px the dock still does not render).

## 1. Purpose

"I can ask any question at any point." After unit 40 the server no longer cares where a question is asked from; the dock still exists only at `/[lang]/ch/[n]/[section]` and still asks for a chapter and a section as props. This unit makes the dock the same thing on every page: opened with `a`, holding one conversation about the book, closing back to the page it was opened on. In the reader it keeps its place beside the text. Everywhere else it lies over the right edge of the page.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| Unit 40 (spec 23) | `POST /assistant/conversations` without a chapter; `MessagePostSchema.context` reduced to the mode's picks; `deriveLine` on a citation |
| The dock and its turns (specs 16–19) | the component being changed |
| `lib/aids/index.ts` (`findAid`, the aids' own `chapter` and `section`), the release's labs and chapters | the pickers |

Build order: 41a the mount (the trial of D1 first, then the slot, `AssistantMount`, `getDockCatalogue`, the old slot removed) → 41b the dock without a chapter (props, header, context line and picker per mode, ask label, empty state, chips, strings) → 41c the entry points (`AskShortcut`, the Ask buttons and their draft, the search action) → 41d verification in the browser, the context files.

## 3. The mount (41a)

### 3.1 One slot for every page

```
app/[lang]/layout.tsx                      takes `assistant` beside `children`, renders it after them inside the intl provider
app/[lang]/@assistant/page.tsx             matches /[lang]
app/[lang]/@assistant/[...rest]/page.tsx   matches every other path (the catch-all slot of the Next docs)
app/[lang]/@assistant/default.tsx          null
```

Both pages render `AssistantMount` (`components/assistant/AssistantMount.tsx`, an async server component) with the locale, the path and the search parameters. The slot under `app/[lang]/ch/[n]/[section]/@assistant/` is deleted and `SectionLayout` loses its `assistant` prop. The locale layout already reads the request's headers (the CSP nonce), so every route under `[lang]` is rendered per request today and the slot changes no route's caching.

**41a starts with a trial (D1).** Before anything is built on the slot, a slot page that prints its path is checked by hard load and by client navigation on: `/en`, `/en/ch/21/21.3`, the same with the peek open (the `(.)ref/[id]` intercept inside `@peek`), `/en/search?q=cache`, `/en/paths`, a path's own page, `/en/marks`, `/en/account`, `/en/ref/21.3` and a path that is a 404. If any of them loses the slot or breaks the peek, the fallback is option B of D1: each page renders `AssistantMount` itself, as each already renders `TopBar` and `StatusBar`.

### 3.2 What the mount renders

| Route | `ask` absent | `ask` present |
|---|---|---|
| `/[lang]/login`, `/[lang]/logout` | nothing | nothing |
| `/[lang]/assistant` (and the old `/[lang]/assistant/[id]`, a redirect after unit 43) | `AskShortcut` | `AskShortcut` (the page has its own dock and reads `ask` itself, spec 26) |
| every other route | `AskShortcut` | `AskShortcut` and `AssistantDock` |

### 3.3 What the mount loads

In parallel, and only when it renders the dock: the session; the conversation when `ask` is a UUID (`getConversation`, the reader's own or absent); the reader's newest conversations for the log (`listConversations`); and `getDockCatalogue(locale)`, new in `lib/db/content.ts`, which replaces `getDockContext(locale, chapter, sectionId)`:

```ts
interface DockCatalogue {
  readonly releaseId: string;
  /** The edition answers cite: the one retrieval reads (EN until the PT editions exist). */
  readonly editionLang: string;
  readonly verified: number;                              // chapters that passed VERIFY in this release
  readonly total: number;
  readonly chapters: ReadonlyArray<DockChapterOption>;    // number, title, version, verified
  readonly labs: ReadonlyArray<DockLab & { readonly chapter: number }>;
}
```

The aids come from `lib/aids/index.ts`, all of them, each with its chapter and section. A conversation pinned to a superseded release is read-only, as today.

## 4. URL state

Unchanged from spec 16 D1, and now valid on every route: `?ask=1` is the dock with no conversation, `?ask=<uuid>` is that conversation, a foreign or unknown id is the empty dock and the parameter is corrected. One parameter is new: `draft`, the text the ask box opens with (§ 6.2). Closing the dock goes to the same URL without `ask` and `draft`.

Links the dock itself renders carry the current `ask`, so following a citation keeps the conversation open (§ 5.5). The page's own links behave as they do today.

## 5. The dock without a chapter (41b)

### 5.1 Props

`AssistantDock` loses `chapter`, `section`, `derives`, `labHref`, `part`, `lab` and the context chapter's `aids`. It gains `catalogue` (§ 3.3), `aids` (all), `basePath` (the open page's path) and `readerSection` (the section id when the open page is a reader section, else null: it decides only where a chip opens, § 5.5). `variant: "dock" | "page"` stays. `ensureConversation` posts `{ locale }`.

### 5.2 Header and landmark

`aside.dock[aria-label]` reads `assistant.dock.title` ("Assistant"); the key `assistant.dock.label` ("Assistant, docked beside chapter {n}") is removed. The header's `grounded on release {id}` and `guide {version}` are unchanged.

### 5.3 The context line and its picker, per mode

| Mode | Context line | Picker | Ask label |
|---|---|---|---|
| explain | `context · the book · 34 of 41 chapters verified` (new, § 8; the two numbers are the release's) | none, and no `change context` | `ask about the book` (new) |
| compare | `context · ch19 v… · ch17 v…` (existing `assistant.compare.context`) | two selects over the release's chapters, unverified ones disabled and marked `unverified`; `swap` stays | existing `assistant.compare.label` |
| walk | the aid's section and title, as the walk form prints today | `decision aid` select over every aid of the release (`21.8 · …`, `37.8 · …`), then the aid's inputs | the form's own (`Run at these inputs`) |
| lab | existing `assistant.lab.context` / `contextNoRun` | a select over every lab of the release | existing `assistant.lab.label` |
| brief | existing `assistant.brief.contextOutside` (`context · Part III · ch34–40`), always | none | existing `assistant.brief.label` |

Compare today pairs "this chapter" with one picked chapter; it becomes two picks, and until both are made the ask box is disabled with the existing help line. `assistant.walk.noAid` and `assistant.lab.noLab` ("This chapter has no …") and `assistant.brief.context` ("from ch{n}") are removed with the states they described. A pick lasts for the conversation's next turns until changed; it is client state, as `compareWith` is today.

### 5.4 Empty state and ask box

The empty state's sentence and the ask label lose their section and chapter (§ 8). The placeholder ("Ask about the book, its labs or its registries."), the counter, the language control and `Ask` are unchanged. When the URL carries `draft`, the box opens holding that text with the caret at its end; the dock drops `draft` from the URL on the first keystroke or on submit.

### 5.5 Chips, pointers and the derive mark

- A citation chip or a refusal pointer to section `S`:
  - on a reader section page: `${basePath}/ref/S?ask=<ask>`, the peek, as today;
  - anywhere else: `/{locale}/ch/NN/S?ask=<ask>`, the reader at the cited section with the dock beside it. The reader's `cited` band (spec 16 § 4) then highlights what the open answer cites there, with no new code: it already compares the open answer's citations with the section on screen.
- The `ƒ L45` mark on a claim reads `citation.deriveLine` (spec 23 § 7.3) instead of the open section's figures, so it shows for a figure of any chapter.
- `Open Lab NN` shows on a lab turn, for the lab that turn picked (D6).

### 5.6 Where it lies

| Page | ≥ 1000px | 768–999px | < 768px |
|---|---|---|---|
| reader section | a column, the reader grid narrowed (spec 16 § 4, unchanged) | over the page with a backdrop (unchanged) | not rendered; the notice (unchanged, its sentence in § 8) |
| every other page | over the right 520px with a backdrop | the same | the same notice |

Outside the reader the page's layout does not change (D3). The log rail's toggle in the dock header (`Log · n turns`) opens the rail over the page at every width outside the reader, as it does under 1360px in the reader. The rail's header loses the chapter: it reads the existing `assistant.log.toggle`.

## 6. Entry points (41c)

### 6.1 `a`

`AskShortcut` (`components/assistant/AskShortcut.tsx`, client) owns the key on every page: with a dock on the page it focuses the ask box; without one it pushes the current URL with `ask=1`. The guards are `useKeyboardMap`'s (no modifier, not while typing in a field), lifted to a shared function. `useKeyboardMap` loses the `ask` action and `KeyTargets.ask`, so the key has one owner. The keyboard help's line for `a` changes (§ 8).

### 6.2 The Ask buttons and `draft`

| Button | Today | After |
|---|---|---|
| the reader's `Ask about 21.3` (`SectionActions`, `BottomActionBar`) | `?ask=1` on the section | `?ask=1&draft=…` with the draft `About 21.3: ` from the catalogue (§ 8), so the section the reader means is in the question, visible and editable, and § 4 of spec 23 reads it there (D2) |
| the search page's `Ask about {q}` (`lib/db/search.ts`) | a link to `/{locale}/ch/NN/NN.k/@assistant?q=…`, which does not resolve | `/{locale}/search?q=…&ask=1&draft=<q>`: the dock over the results, holding the query |
| the top bar's `assistant` | `/{locale}/assistant` | unchanged |
| the dock header's `Open assistant full page` | `/{locale}/assistant/<id>` | unchanged in this unit; with no conversation yet, `/{locale}/assistant`. Unit 43 makes it `/{locale}/assistant?ask=<id>` (spec 26 D1) |

`draft` is at most 800 characters, the question's own cap; a longer value is cut by the server before it reaches the box, and it is never sent anywhere but the box.

## 7. States

Signed out: the sign-in notice, returning to the same URL with `ask` (unchanged; the notice's sentence is still the open question of unit 30). Empty. A conversation. A conversation pinned to an earlier release: read-only, `New conversation`. A foreign id: the empty dock. A release with no decision aid, or with no lab: the walk and lab modes show the existing `Empty` block with the new sentences of § 8. Under 768px: the notice.

## 8. Strings (EN and PT candidates; Andre's to confirm)

| Key | EN | PT |
|---|---|---|
| `assistant.dock.label` | removed | removed |
| `assistant.dock.contextBook` (new) | context · the book · {verified} of {total} chapters verified | contexto · o livro · {verified} de {total} capítulos verificados |
| `assistant.dock.ask` | ask about the book | perguntar sobre o livro |
| `assistant.dock.empty` | Ask about anything in the book and the answer cites it. | Pergunte sobre qualquer parte do livro e a resposta a cita. |
| `assistant.dock.draftAbout` (new; ends with a space) | `About {id}: ` | `Sobre {id}: ` |
| `assistant.dock.phoneBody` | Open this page on a tablet or a desktop to ask the assistant. Reading, bookmarks and notes work here. | Abra esta página em um tablet ou desktop para perguntar ao assistente. Leitura, favoritos e notas funcionam aqui. |
| `assistant.compare.first` (new) | compare · chapter | comparar · capítulo |
| `assistant.walk.none` (new) | This release has no decision aid yet. | Esta release ainda não tem auxílio de decisão. |
| `assistant.lab.noLabs` (new) | This release has no lab yet. | Esta release ainda não tem lab. |
| `reader.keys.ask` | ask the assistant | perguntar ao assistente |
| `assistant.walk.noAid`, `assistant.lab.noLab`, `assistant.brief.context`, `assistant.dock.context`, `assistant.dock.changeContext` | removed | removed |

`Ask about {id}` on the reader's buttons and `Ask about {q}` on the search page keep their words: with the draft they are still true.

## 9. Keyboard, accessibility

- `a` opens the dock or focuses its ask box, on every page; `esc` closes it and returns focus to where it was when `a` was pressed, or to the control that opened it.
- Outside the reader the dock is the overlay of spec 16 § 8: the backdrop is a button named by `assistant.dock.close`, and focus enters the ask box on open.
- The two compare selects and the aid and lab selects each have a visible label; a disabled chapter says why in its text (`unverified`), never by colour alone.
- Nothing truncates: a long lab or aid title wraps in its select's row and in the context line (ui-context § 11).
- Target sizes are spec 16 § 8's, unchanged.

## 10. Out of scope

- The dock under 768px (spec 20, skipped by Andre on 2026-10-03).
- A dock that stays open across the page's own links (D5 keeps today's rule: `ask` lives in the URL).
- The `/assistant` page's layout (spec 26).
- A hidden reading-position hint (spec 23 D2).

## 11. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | How the dock reaches every page | A one `@assistant` slot at `app/[lang]` with a catch-all, tried first (§ 3.1) / B each page renders `AssistantMount`, as each renders its own `TopBar` / C a client host that fetches through the API | **A**, with B as the fallback if the trial fails: one mount, loaded in parallel with the page. C needs a new endpoint for the catalogue and moves loading to the browser |
| D2 | The reader's `Ask about 21.3` | A open the dock with the draft `About 21.3: ` / B open the bare dock and rename the button | **A**: the button stays true, the section is in the question where the reader sees it, and the assistant still has no hidden position |
| D3 | The dock outside the reader | A over the page with a backdrop, at every width / B a column that narrows each page | **A**: no page's layout changes, and it is the form already built for narrow screens |
| D4 | A citation chip outside the reader | A the reader at the cited section, dock beside it / B the standalone `/ref/[id]` page | **A**: the reader is where a citation is checked, and the cited passages are highlighted there |
| D5 | `?ask=1` | A the empty dock, as today / B reopen the reader's latest conversation | **A**: the latest conversation is one row away in the log |
| D6 | `Open Lab NN` on an answer | A on a lab turn, for its lab / B on any answer whose citations sit in one chapter that has a lab | **A**: it follows from what the reader picked, not from a rule about citations |
| D7 | Whether 41a and 41c are built | A build them / B keep the dock on reader sections only and rely on `/assistant` for every other page | **A**, reading "at any point" as "on any page". 41b is needed either way: the dock must stop asking for a chapter |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. The trial of § 3.1, each route by hard load and by client navigation, recorded in the tracker.
2. `a` on each route of § 3.2 opens the dock (or focuses the page's dock on `/assistant`); `esc` closes it and the URL is the one before; `a` inside a text field types an `a`.
3. A question asked from `/en`, from `/en/search?q=cache` and from `/en/ch/21/21.3` in three fresh conversations returns the same citations (stub gateway).
4. From `/en/marks`, a chip to `21.3` opens `/en/ch/21/21.3?ask=<id>` with the dock docked, the same conversation, and the `cited` band on; in the reader the same chip opens the peek and `esc` returns focus to the chip.
5. Compare: two selects, an unverified chapter disabled and marked, the ask box disabled until both are picked, `swap`. Walk: chapter 21's aid picked from `/en` runs and walks. Lab: any lab picked from `/en/paths`. Brief from anywhere reads `context · Part III · ch34–40`.
6. `Ask about 21.3` opens the dock holding `About 21.3: `; the answer cites 21.3. The search page's `Ask about cache` opens the dock over the results holding `cache`; the old `@assistant` URL is gone from `lib/db/search.ts`.
7. A claim citing a derived figure of a chapter other than the open one shows its `ƒ L` mark.
8. Layout at 1440, 1200, 1000 and 900 on the reader and on `/en/marks`; under 768 the notice. PT at 1440 and 900, every string from the catalogue, nothing overflowing.
9. axe: zero WCAG 2.2 AA violations with the dock open on the home page, the search page and a reader section, each mode's picker open, EN and PT.
10. Token grep clean; message parity; removed keys gone from both catalogues; no file under `app/[lang]/ch/[n]/[section]/@assistant/`.
11. Context files amended in this unit: architecture § 3.2 (the route map and its sentence "parallel route slots rendered beside a chapter", now a slot of the locale layout); the overview's core flow step 5 and the Assistant features' first line; ui-context § 9.9 and § 10 (the dock outside the reader).

## 13. As built (unit 41, 2026-10-04)

Built as 41a to 41d and verified per § 12. Where the build differs from the sections above, this section is later.

**The trial of § 3.1 passed, so D1 is option A.** A slot page that printed its path was checked before anything was built on it. By hard load it rendered, with its search parameters, on `/en`, `/en/ch/21/21.3`, `/en/search?q=cache`, `/en/paths`, `/en/marks`, `/en/account`, `/en/assistant`, `/en/ref/21.3` (which redirects to the reader) and `/pt/marks`; a path that does not exist stayed a 404 with the slot rendered. By client navigation it followed the top bar. With the dock open on a section and a cross-reference clicked, the peek opened at `/en/ch/21/21.3/ref/ch22`, the slot kept what it had rendered for the section, and the text typed in the ask box was still there after `esc`. So there is one slot, the section's own is deleted, and chips beside a reader section link to the peek route without `ask`, exactly as before (§ 5.5 said they would carry it; they do not need to).

**The pickers start where the reader is.** Beside a reader section the walk's aid, the lab and compare's first chapter start on that chapter's own, where it has one and it is verified. It is a start the reader sees in the picker and may change; nothing of it is sent unless picked, and outside the reader the pickers start empty (walk on the first aid). This is the same idea as D2's draft: position as a visible default, never as hidden state.

**Strings.** As § 8, with two additions the lab picker needed: `assistant.lab.choose` ("choose a lab" / "escolha um lab") for the select's empty option, and the select's label is the existing `assistant.lab.kvLab`. The walk's context line is the existing `assistant.walk.title` ("Walk · 21.8"), and the form's picker labels each aid `21.8 · <title>`. Compare with no pair, and lab with no lab, show the explain line (`context · the book · …`) until the pick is made. `assistant.page.beside` is removed here and not in unit 43, because the dock's page variant lost its "Open beside the chapter" button in this unit.

**`Open assistant full page` is always offered**, and leads to `/assistant` when there is no conversation yet (§ 6.2).

**`AskShortcut` in a walk.** With the dock open in walk mode there is no ask box; `a` then focuses the walk form's first field instead of opening a second, empty dock, which is what the keyboard map did before this unit.

**Closing keeps the page's own parameters.** `closeHref` is the page's URL without `ask` and `draft` (`pageHref`), so closing the dock on `/en/search?q=cache&ask=1` returns to `/en/search?q=cache`, and every link the dock builds from it uses `withAsk` rather than appending `?ask=`. The search page's Ask link is the page's own URL (`searchHref`), so it keeps the filters as well as the query.

**Under 768px outside the reader** the page says so with `.dock-phone`: the notice and a close link in a strip at the foot of the page. The reader keeps its own notice in the reading column.

**A defect of unit 31 found and fixed here.** The peek looked for its anchor among `a.xref` and `a.cite` only. A refusal's pointer is a row (`a.refusal-pointer`), so a peek opened from one had no anchor: `esc` replaced the URL with the bare section, the peek stayed on screen, and focus went nowhere. `PeekPanel` now takes whichever link marked itself (`a[data-peek-anchor]`). After the fix: `esc` goes back to `?ask=<id>`, the peek closes, the dock keeps its turn and focus returns to the pointer.

**Verified in the browser** (Playwright and axe, signed in, 57 checks, all passing; every turn asked was one the rules refuse, so no model was called): `a` opens the dock and focuses the ask box on the home page, search, paths, marks, the account and a reader section, and `esc` returns each to the URL it had; `a` in a field types an `a`; the request that opens a conversation is `{"locale":"en"}` and a turn's body is `{"text":…,"mode":"explain"}`, identical from `/en/marks` and from `/en/ch/21/21.3`; a pointer on `/en/marks` links to `/en/ch/35/35.2?ask=<id>` and the reader opens there with the same conversation docked; the pickers as § 5.3 (seven unverified chapters listed, disabled and marked; two aids; 34 labs); both drafts; layouts with no horizontal overflow at 1440, 1200, 1000 and 900 on the marks page and the reader, the notice at 390; PT at 1440 and 900; axe with zero WCAG 2.2 AA violations on eight states in EN and PT.

**Not verified in the browser:** § 12.3's "returns the same citations" and § 12.7's derive mark need an answer, which needs a model. The first is held by the request bodies being identical and by `planOf` reading no position (unit 40); the second by `deriveLineOf`'s unit case. A real turn is Andre's to pay for.
