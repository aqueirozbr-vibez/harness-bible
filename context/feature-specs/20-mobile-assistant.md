# 20 · Mobile assistant sheet — feature spec (the phone variant of the dock: sheet, mode picker, turns at 390, input row, gestures)

> **Status: skipped on 2026-10-03 (Andre's decision). Not built.** Under 768px the dock does not render and the reading column shows a notice; the spec stands as written for whenever the sheet is wanted.

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screen: `docs/design/screens/Mobile-Assistant.html` (phone, 390 × 844) with `png/Mobile-Assistant.png`: the `.hb` frame on `--bg-3` with the chapter line behind the sheet (36px, `aria-hidden`, `✢ ch21 · 21.3 worked numbers · v1.5.0` in `--ink-3`); the full-height sheet `section[role="dialog"][aria-modal="true"][aria-label="Assistant, opened from chapter 21"]` on `--bg` with a 1.5px strong top rule; the grab handle (14px row, a 36 × 3 bar in `--rule-2`); the 48px header (`.rb-s`, mono 11 `--ink-2`: `ASSISTANT` uppercase 500 in `--ink` · `release 2026.09` · `guide v1.8`, `.grow`, a 44 × 44 close button `aria-label="Close assistant and return to 21.3"`); the mode row (`.rb`, padding 4 4 4 16: `.cap` `mode · explain` over `.meta` `context · ch21 v1.5.0 · 21.3`, and a 44px `Change mode` button `aria-haspopup="listbox"`); the conversation (`role="log" aria-label="Conversation"`, padding 14 16, gap 12: the user block on `--bg-2` with a 2px `--rule-2` left rule, `.cap` `you · 10:42`, `.small` question; the assistant turn `.between` `assistant · 10:42` / `cites en v1.5.0`, body at 14/22 with `.cite` chips, `.fig-der.mono` figures, `.nocover`); the two-column 44px button grid (`Flag this answer`, `Copy with citations`); the collapsed verdicts bar (a full-width 44px button `aria-expanded="false" aria-label="Sensor verdicts, collapsed"`: `▸ sensor verdicts` left, `grounded 0.94` and `.st.st-ok 5 of 5 pass` right); the input form (`.rt-s`, padding 10 16 12: a 44px `.input` `Ask about chapter 21` with a 44px `Ask` `.btn-p`; below, a 44px `EN` `.btn-q` mono `aria-label="Answer language: English. Change language"` and `.help` `answers cite the EN edition`); no top nav, no status bar. Governing context: `context/ui-context.md` § 9.8 (the peek and the phone `.sheet`), § 11 breakpoints (< 768px: only the chapter reader and the assistant sheet render; no top nav or status bar), § 12 semantics (`role="dialog"`, `role="log"`, live regions), the Mobile assistant row of the screen table; `context/architecture.md` § 3.3 (`@assistant` renders on mobile; `@lab` and `@improve` show a notice); `context/project-overview.md` § Assistant (mobile renders it as a modal sheet), § Out of scope (no native apps: responsive pages); `03-reader-chapter.md` § 6.10 (the phone reader: compact top bar, `BottomActionBar` whose primary `Ask about {id}` opens the assistant sheet, 60px targets), `16-assistant-dock.md` (the dock and its `?ask=` state, `AssistantDock` and its children; at 390 the dock does not render), `17-refusal-log-flags.md` (refusal card, `FlagButton` and its dialog, the full page), `18-decision-aid-walk.md` (the walk turn), `19-assistant-modes.md` (contexts and bodies).

Prerequisite specs: 16, 17, 18, 19 (the sheet is a variant of everything they build).

Scope: tracker unit 34. The assistant under 768px: the sheet shell over the phone reader, its URL state and focus behaviour, the mode picker and the per-mode context on a phone, every turn kind at phone width (answer, refusal, walk, compare, lab, brief), the verdicts bar, the input row and the language button, close by button, `esc`, back and swipe-down, and the full page at phone width. Not here: anything new in the flow or the API (nothing changes server side), the lab and improve slots (a notice, already in place).

## 1. Purpose

On a phone the reader reaches the assistant from the bottom bar of the chapter and gets the same assistant, not a lesser one: the same modes, the same chips, the same verdicts and the same refusals, laid out for one column and a thumb. The sheet is modal because the phone has no room for the chapter beside it; the chapter line above the handle says where the reader will land on close, and closing returns them there with focus where it was.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| `AssistantDock` and its children (spec 16), the refusal card and `FlagButton` (17), `WalkTurn` (18), the three bodies (19) | the sheet renders the same components with a `variant` |
| The phone reader (`BottomActionBar`, `.phone-only`, the 767px media block) | the entry point and the frame |
| The `?ask=` URL state (16 D1) | the sheet's open state, back-button behaviour |

Build order: 34a the sheet shell (`variant: "sheet"` on `AssistantDock`, `.sheet-assistant` geometry and the pre-hydration CSS, the chapter line, the handle, the header, scroll lock and `inert` on the reader, focus trap and return) → 34b the mode picker listbox and the per-mode context rows at phone width (compare's chapter select, the aid picker, lab's empty state) → 34c the turns at 390 (answer, refusal, walk, compare, lab, brief), the button grid, the verdicts bar → 34d the input row, the language button, the gestures (`esc`, back, swipe-down), the full page at phone width, strings, verification.

## 3. One component, two variants (34a)

`AssistantDock` gains `variant: "dock" | "sheet"` (D1). The slot page renders it once; the client hook `useMediaQuery("(max-width: 767px)")` sets the variant after hydration, defaulting to `dock` on the server. Before hydration the CSS already gives the panel the sheet's geometry under 768px (`.dock` inside the 767px media block becomes `position: fixed; inset: 36px 0 0 0; height: calc(100dvh - 36px)`), so the reader sees no jump: only the attributes and the header's wording switch when the variant lands (`aside[aria-label]` → `section[role="dialog"][aria-modal="true"]`, the close label, the mode row replacing the radiogroup). Children receive `variant` through context and adapt their layout (§ 5), never their data.

Sheet chrome (`components/assistant/SheetChrome.tsx`, rendered only in the sheet variant):

- `.sheet-behind`: the 36px chapter line above the sheet, `aria-hidden`, `✢` glyph and `.meta` `ch21 · 21.3 worked numbers · v1.5.0` from the chapter and section props; it is text, not a button (the close button and the handle are the ways back).
- `.sheet-handle`: the 14px row with the 36 × 3 bar; the swipe target (§ 7).
- `.sheet-head`: 48px, the mono line `Assistant · release {id} · guide {version}` and the 44px close (`Close assistant and return to {section}`).
- `.sheet-mode`: the `.cap` `mode · {mode}` over `.meta` `context · …` (spec 19's per-mode context text) and the 44px `Change mode` button (§ 4).

While the sheet is open: `document.body` gets `overflow: hidden`, the reader's `main`, top bar and bottom bar get `inert`, focus moves to the close button (the first control, so a screen reader hears the dialog label and then the way out), `tab` cycles inside the sheet, and closing removes `ask` from the URL (`router.replace`, as the dock) and returns focus to the bottom bar's `Ask about {id}` button (or the element that had focus). The top bar and status bar are absent under 768px already; the sheet adds none.

## 4. The mode picker and contexts (34b)

The five radios do not fit a 390px row without wrapping into three lines, so the sheet uses the screen's `Change mode` button (D4): it opens `.sheet.sheet-modes` (the existing phone sheet class, fixed bottom, `role="listbox" aria-label="Choose a mode"`, `aria-activedescendant`) with five 44px options `role="option" aria-selected` (`Explain · Compare · Walk a decision aid · Explain a lab run · Executive brief`, each with a one-line `.help`: `answers about the section you are reading`, `two chapters side by side`, `runs the chapter's script at your inputs`, `the lab's README and last run`, `Part III in six claims`). Choosing closes the listbox, sets the mode (the same state the dock's radios set) and returns focus to `Change mode`, whose `.cap` now reads the mode. Arrow keys move, `enter` chooses, `esc` closes without change.

Per-mode context under 768px, in the mode row's second line and, when a choice is needed, a row above the input:

- compare: `.meta` `context · ch37 ↔ ch15`; a 44px `.select` `compare with · chapter` above the input (spec 19 § 3), full width; `swap` beside it.
- walk: the aid picker `.seg` (44px segments) and the inputs form replace the input row: one column of `.field`s, 44px inputs, a full-width `Run at these inputs`.
- lab: `.meta` `context · Lab 21 · REPRODUCED · 23 Sep 2026`; no lab: the `Empty` in the log and the input disabled (spec 19 § 7).
- brief: `.meta` `context · Part III · from ch37`.

`change context` is not shown on the phone: the context is the section the reader came from, changed by closing and reading elsewhere (D5).

## 5. Turns at 390 (34c)

Every turn keeps its component and data; the layout rules under 768px (`variant === "sheet"` and the media block):

| Turn | Phone layout |
|---|---|
| user | the screen's block: `--bg-2`, 2px left rule, `.cap` `you · 10:42`, the question at `.small` |
| answer (explain) | `.between` head (`assistant · 10:42` / `cites en v1.5.0`), body at 14/22, chips inline as on the desktop; the action row becomes the two-column 44px grid (`Flag this answer`, `Copy with citations`); the record footer (`log {trace}`, `hash`) stays as one `.meta` line that wraps |
| verdicts | the collapsed 44px bar (`▸ sensor verdicts · grounded 0.94 · 5 of 5 pass`); expanding renders the same `dl` grid below it in one column (sensor · verdict · detail stacked), `▾` while open; a walk turn's first row is `derive output matched` as on the desktop |
| refusal (17) | the card at full width; the `what the book does cover` links as 44px rows; `Flag this refusal` full width |
| walk (18) | the step strip as a single row of four 44px cells showing the ordinal and mark (`1 · done`, `2 · now`) with the current step's title beneath the strip (the other titles are in the tree of the reading column on desktop only); inputs one column; the bars and headline as on desktop (the `.midnum` above the sentence, not beside it); the run line unchanged; the footer as a two-column grid `Back` / `Next: …` with `Flag this step` on its own row |
| compare (19) | the two sides stacked in order, each under its `.cap`; the open-point notice after both |
| lab (19) | the `.kv` in one column; the figures table in `.scroll`; the claims; `Open Lab 21` disabled with `labs open in Phase 3` (labs are desktop and tablet only anyway, § 11) |
| brief (19) | unchanged: the caption, stance and numbered claims already fit one column |
| streaming | the pending block at 14/22 with the caret; the status line (`answering · 0.8 s`) under the log as `.meta`; the `Ask` button disabled |
| errors | the composer's error box full width above the input (`ASSISTANT_UNAVAILABLE`, 402 with the reset date, 409 `RELEASE_CHANGED` with the `new conversation` action) |

The log scrolls inside the sheet (`flex: 1 1 auto; overflow: auto; overscroll-behavior: contain`) and pins to the bottom on a new turn (as the dock). The cited band and the passage highlights in the reading column do not apply on the phone: the chapter is behind the sheet (a chip still opens the peek route, which on phones is the `.sheet` peek of spec 03 stacked above the assistant, `z-index` above, and closing it returns focus to the chip, D3 of spec 03 unchanged).

## 6. The input row and the language button (34d)

The form (`.rt-s`, padding 10 16 12): a 44px single-line `Composer` field (`textarea` with `rows=1` that grows to three lines and then scrolls, D2, so a long question is still readable; the `0 / 800` counter appears as `.help` only from 600 characters, replacing the `answers cite…` line) and the 44px `Ask` primary; the second row holds the 44px `EN` / `PT` language button (mono, `aria-label="Answer language: English. Change language"`, a tap toggles the answer language as the dock's language select does, `aria-live` announces the new language) and the `.help` `answers cite the {edition} edition`. `enter` submits, `shift+enter` breaks a line. The field keeps the dock's 800-character cap and the same 400 `TEXT_TOO_LONG` handling.

Keyboard on screen: the sheet is `100dvh` based and the form is `flex: none` at the bottom, so the input stays above the on-screen keyboard; `padding-bottom: env(safe-area-inset-bottom)` on the form. A focused field scrolls into view without moving the header.

## 7. Closing: button, `esc`, back, swipe (34d)

- The close button and `esc` remove `ask` and return focus (§ 3).
- The browser's back button removes `ask` because the open state is the URL (16 D1); the popstate closes the sheet and the reader is where it was.
- Swipe-down: a pointer drag that starts on the handle (or the header) and moves ≥ 80px down within 600 ms closes the sheet (D3: the handle only, never the log, so scrolling the conversation cannot close it); while dragging the sheet follows the finger up to 120px (`transform`, no transition: the finger is the motion, § 13.6 forbids decorative animation; `prefers-reduced-motion` keeps the follow, since it is direct manipulation). Releasing under the threshold snaps back with no animation.
- The mode listbox, the flag dialog and the peek close first with `esc` when they are open; `esc` reaches the sheet only when nothing is stacked above it.

## 8. The full page at phone width

`/[lang]/assistant` (spec 17's list) renders its rows as 60px rows at full width; `/[lang]/assistant/[conversationId]` renders the conversation inline as the page (no dialog: there is nothing behind it) with the sheet's header wording (`Assistant · release · guide`), the conversation and, since a superseded release is read-only, no input (the `new conversation` link leads to the current chapter). The log rail's per-turn verdicts (17) are, on the phone, the verdicts bar of each turn; `export JSONL` is a link under the conversation.

## 9. States

| State | Rendering |
|---|---|
| Signed out | the sheet opens with the sign-in notice (16 § 8) and the input disabled; the close still works |
| Empty conversation | the empty state's text (16) above the input; the mode row shows `explain` |
| Mode listbox open | the listbox above the sheet with a backdrop; the sheet `inert` beneath |
| Walk running | the run line at 0% then the steps; the strip's current cell in `--act` |
| Refused | the card; the log has no rail on phones, so the turn's card is the record |
| Release changed (409) | the error box and the `new conversation` action; the input disabled |
| Landscape (844 × 390) | the same layout; the log gets the remaining height; nothing hidden |
| ≥ 768px | the dock (spec 16); resizing across 768 switches the variant live without losing the conversation state |

## 10. Strings (`assistant.sheet.*`; the rest reuse `assistant.*`; PT candidates)

`label` Assistant, opened from chapter {n} / Assistente, aberto do capítulo {n}; `behind` ch{n} · {section} · {version}; `head` Assistant · release {id} · guide {version} / Assistente · release {id} · guia {version}; `close` Close assistant and return to {section} / Fechar o assistente e voltar a {section}; `modeCap` mode · {mode} / modo · {mode}; `changeMode` Change mode / Mudar modo; `pickMode` Choose a mode / Escolha um modo; `modeHelp.explain` answers about the section you are reading / responde sobre a seção que você está lendo; `modeHelp.compare` two chapters side by side / dois capítulos lado a lado; `modeHelp.walk` runs the chapter's script at your inputs / executa o script do capítulo com suas entradas; `modeHelp.lab` the lab's README and last run / o README do lab e a última execução; `modeHelp.brief` Part III in six claims / a Parte III em seis afirmações; `verdictsCollapsed` Sensor verdicts, collapsed / Veredictos dos sensores, recolhidos; `verdictsExpanded` Sensor verdicts, expanded / …, expandidos; `grounded` grounded {score} / fundamentação {score}; `language` Answer language: {lang}. Change language / Idioma da resposta: {lang}. Mudar idioma; `citesHelp` answers cite the {edition} edition / as respostas citam a edição {edition}; `placeholder` Ask about chapter {n} / Perguntar sobre o capítulo {n}; `answering` answering · {s} s / respondendo · {s} s; `swipeHint` (visually hidden on the handle) Drag down to close / Arraste para baixo para fechar.

## 11. Keyboard, accessibility

- The sheet is `role="dialog" aria-modal="true"` with `aria-label`; the reader behind is `inert`; focus is trapped and returned; `esc` closes (when nothing is stacked above).
- Every target is ≥ 44px: the close, `Change mode`, the options, the two action buttons, the verdicts bar, the input, `Ask`, the language button, the walk's cells and buttons, the refusal's links.
- The log is `role="log" aria-live="polite"`; the pending block is `aria-hidden` while streaming (16 D7); the final answer is announced once.
- The verdicts bar is a button with `aria-expanded` and `aria-controls`; the collapsed label says `collapsed`.
- The language button announces its state in its label; the change is announced by a live region.
- The handle has a visually hidden hint; swipe is never the only way to close.
- Contrast pairs are the dock's; the `--bg-3` frame behind the sheet is chrome, not content.
- Zoom to 200% and 320px wide: one column, no horizontal scroll, the two-column button grid becomes one column below 360px.

## 12. Out of scope

- Native gestures beyond swipe-down on the handle (no swipe between modes or turns).
- Offline, push, install prompts (no service worker, per the overview).
- The lab and improve slots on phones (the notice is in place; Phase 3 and 4 keep it).
- A reading column beside the sheet on tablets: at 768–999 the dock overlay of spec 16 stands.

## 13. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | How the sheet relates to the dock | A one component with a `variant` from a media query, pre-hydration geometry in CSS / B a separate `AssistantSheet` component tree | **A**: one conversation state, one set of turn components; the sheet is a layout and a dialog wrapper, not a second assistant |
| D2 | The input field | A `textarea` `rows=1` growing to three / B the screen's single-line `input` | **A**: the screen's `input` is the look at rest; a question of 800 characters must stay readable while typed; the counter appears late so the rest matches the screen |
| D3 | Swipe-down | A the handle and header only, 80px in 600 ms, finger-follow up to 120px / B anywhere on the sheet | **A**: the log scrolls; a swipe that closes from the log would lose answers |
| D4 | The mode control | A `Change mode` opening a listbox sheet, as the screen / B the five radios wrapping | **A**: three wrapped rows push the conversation down; the screen's button keeps the mode readable in one line |
| D5 | `change context` on the phone | A absent: the context is where the reader came from / B a section picker sheet | **A** in Phase 2; the compare chapter select and the aid picker are the two contexts the phone needs and both are in § 4 |

## 14. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Routes: `/en/ch/21/21.3` at 390 × 844 shows the phone reader; the bottom bar's `Ask about 21.3` sets `?ask=1` and the sheet opens as `role="dialog" aria-modal="true"` with the label `Assistant, opened from chapter 21`, the chapter line behind reads `ch21 · 21.3 worked numbers · v1.5.0`, focus is on the close button; the reader is `inert`; close, `esc` and `history.back()` each remove `ask` and return focus to the bottom bar button; a direct load of `?ask=1` at 390 opens the sheet without a layout jump (the pre-hydration geometry: the panel's bounding box equals the hydrated one).
2. Mode picker: `Change mode` opens the listbox with five 44px options and their help lines; arrows move, `enter` chooses `Compare`, the row reads `mode · compare`, the chapter select appears above the input; `esc` closes without change; walk shows the aid picker and the one-column inputs; lab on ch05 shows the `Empty` and a disabled input.
3. Turns (stub gateway): an explain answer streams into the pending block, then the final body with chips, the two-column button grid and the collapsed verdicts bar `grounded {score} · 5 of 5 pass`; expanding shows the six-column `dl` stacked; a refusal renders the card with 44px links; a walk on 37.8 renders the four-cell strip, one-column inputs, the run line and the step result with the `.midnum` above the sentence; `Back` / `Next` as a grid; compare stacks its sides; lab's table scrolls in `.scroll` without page overflow; a brief renders its list.
4. Input: `enter` submits, `shift+enter` breaks a line; the field grows to three lines then scrolls; at 600 characters the counter replaces the help line; the language button toggles `EN` → `PT`, its label and the help line update, the next post carries `locale: "pt"`.
5. Gestures: a pointer drag of 100px down on the handle within 400 ms closes the sheet; the same drag on the log scrolls it and does not close; a 40px drag snaps back; with `prefers-reduced-motion: reduce` the follow still tracks the pointer and no transition runs.
6. Chip and peek: tapping `21.3` opens the phone peek sheet above the assistant; `esc` closes the peek first, a second `esc` closes the assistant; focus returns to the chip, then to the bottom bar.
7. Full page: `/en/assistant` at 390 lists conversations as 60px rows; a conversation page renders inline with no dialog, the header wording, the turns, `export JSONL`, no input on a superseded release.
8. Layout: 390 × 844 matches `Mobile-Assistant.png` in structure and vocabulary (deliberate differences listed: the real release and version strings, the trace footer line, `fig-der` figures only when the answer quotes a figure with a derive link, the counter's late appearance); 360 × 640 and 320 wide at 200% zoom with no horizontal scroll and the button grid in one column; landscape 844 × 390 with the log taking the remaining height; every interactive target ≥ 44 × 44 (an automated audit over the sheet's `button, a, input, textarea, select, [role=option]`); resizing 390 → 1024 with a conversation open keeps the turns and switches to the dock, and back.
9. PT: `/pt/ch/21/21.3?ask=1` at 390 with every string from the catalogue and `as respostas citam a edição EN`; no overflow.
10. axe: zero WCAG 2.2 AA violations on the sheet open (empty, answered, refused, walk step, mode listbox open, peek stacked), EN and PT.
11. Token grep clean; new classes (`.sheet-assistant`, `.sheet-behind`, `.sheet-handle`, `.sheet-head`, `.sheet-mode`, `.sheet-modes`, `.sheet-actions`, `.verdicts-bar`, `.sheet-ask`, `.walk-strip-phone`) in `globals.css` and ui-context § 9.9; message parity; ui-context's screen table row for Mobile assistant marked built.
12. Invariant check: 14 (the sheet renders citations and substitutions from `final` only, as the dock), and no server-side change (the API contract tests of specs 15–19 are untouched and still pass).
