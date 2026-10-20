# 16 · Assistant dock — feature spec (the `@assistant` slot, Explain mode, the stream on screen)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screen: `docs/design/screens/Assistant-Answer.html` (desktop, 1440 × 1480) with `png/Assistant-Answer.png`: the reader with its outline rail condensed to 64px, the reading column narrowed with a `cited` band and the cited passages highlighted, the 520px dock on the right (`.dock`, `aria-label="Assistant, docked beside chapter 21"`) holding the header `ASSISTANT · grounded on release 2026.09 · guide v1.8` with two icon buttons (open full page, close), the mode radiogroup (`Explain`, `Compare`, `Walk a decision aid`, `Explain a lab run`, `Executive brief`) under `mode · not chat · answers from the book only`, the context line `context · ch21 v1.5.0 · 21.3 worked numbers` with `change context`, the conversation (`role="log"`) of turns (`you · 10:38` on `--bg-2` with a left rule; `assistant · explain · 10:38` with claims, `.cite` chips, `.derive` chips, `.nocover`, and the sensor verdicts box collapsed or expanded), the answer's action row (`Copy with citations`, `Flag this answer`, `Open Lab 21`, `5 citations · 4 figures`), the verdicts `dl` (five rows, `5 of 5 pass`), the record footer (`log asst-0921-1042-07 · logged per ch29`, `hash 8c21f04e9ab3 · prev 3f7a91c2d0e5`), the ask form (`ask about chapter 21`, `0 / 800`, the textarea with its placeholder, `language EN | PT`, `answers cite the EN edition`, `Ask`, `scope: book · labs · registries · cookbook map`), and the status bar `ch21 · 21.3 worked numbers · assistant docked · explain · EN · source EN · pinned release 2026.09 · first token 1.3 s`. `Assistant-Refusal-Walk.html` adds the four-column variant with the 232px log rail (spec 17). Governing context: `context/ui-context.md` § 9.8 (dock: left rule strong on `--bg`), § 10 (Reader + dock: outline condensed to 64px, reading column narrows, dock 520px; tablet: dock as an overlay; mobile: the sheet of spec 20), § 9.1 (one warm primary: `Ask`), § 9.2 (`.textarea`, `.counter`, `.select`), § 9.10 (hover and pressed forms), § 12 (accessibility), § 13.3 (`AssistantDock`, `Composer`, `AnswerStream`, `CitationChip`, `SensorVerdicts`, `FlagButton`: `.dock`, `.seg` mode radio, `role="log"`, `.cite .nocover`, verdicts `.tbl` with `.st`, `.field .textarea .counter .select`, `.btn-p`), § 13.6 (the caret is the only animation); `context/architecture.md` § 3.2 (`/[lang]/ch/[n]/[section]/@assistant`: a parallel slot, a client component with SSE, signed in; the dock beside the chapter or a full page), § 6.4 (citations and substitutions from the final event only); `context/code-standards.md` § Next.js (client leaf for SSE; `lib/hooks/useSse.ts`), § Styling; `context/project-overview.md` § Assistant and the user flow steps 5 and 6.

Prerequisite specs: `03-reader-chapter.md` (the reader grid, `SectionActions`' Ask, the keyboard map's `a` and `esc`, the peek slot as the pattern for a parallel slot), `13-assistant-agent.md` (`AnswerResult`, the verdict vocabulary), `15-conversations-api.md` (the endpoints and the SSE protocol the dock consumes).

Scope: tracker unit 30. The dock opened beside a section in Explain mode: its URL state, layout, header, mode strip (the other four modes present but routed to specs 18 and 19), context line, conversation with streaming and final rendering, verdicts, the answer's action row minus the flag (spec 17), the ask form, the reader's cited band and highlights, the status bar cells, the keys, tablet behaviour. Not here: the refusal card, the log rail and the full page (spec 17), the walk (18), compare, lab and brief rendering (19), the phone sheet (20).

## 1. Purpose

The dock lets a reader ask about the section they are reading without leaving it, and shows them, beside the text, an answer whose every claim is a chip they can open and whose verdicts they can expand. It is plainly not a chat: the mode strip says what the assistant does, the context line says what it is reading, the scope line says what it will refuse, and the verdicts say what was checked. The stream shows words as they come, then replaces them with the checked answer, so what is on screen at the end is what the sensors passed.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| The reader (spec 03, done): `ReaderChapter`, `Outline`, the `.reader` grid, `askHref`, the keyboard map | the dock is a variant of the reader page |
| The four endpoints and the SSE protocol (spec 15, unit 29) | the dock creates conversations, posts messages, reads the stream |
| `lib/ledger/display.ts` `ledgerLine` (spec 14) | the record footer |
| Message keys under `assistant.*` (spec 13 § 10 adds the refusal and verdict strings; this spec adds the dock's) | no literal strings in JSX |

Build order: 30a the URL state and the slot (`@assistant/page.tsx`, `default.tsx`, the reader grid variant, the condensed outline, `askHref` fixed) → 30b the dock shell, header, mode strip, context line, ask form (`Composer`), the empty and signed-out states → 30c `useSse`, `AnswerStream`, the turn components, `CitationChip`, `SensorVerdicts`, the record footer, `Copy with citations` → 30d the cited band and the reader highlights, the status bar cells, keys, tablet overlay → verification.

## 3. Routes and URL state (30a)

| URL | Behaviour |
|---|---|
| `/[lang]/ch/[n]/[section]` | the reader as today; the `@assistant` slot renders `default.tsx` (nothing) |
| `/[lang]/ch/[n]/[section]?ask=1` | the dock open on this section with no conversation yet (the empty state); the reader grid switches to the dock variant |
| `/[lang]/ch/[n]/[section]?ask=<conversationId>` | the dock open on that conversation (its turns from `GET /assistant/conversations/{id}`); a foreign or unknown id shows the empty state and drops the parameter |
| `/[lang]/ch/[n]/[section]/ref/[id]` with `?ask=…` | the peek opens over the reader as today; the dock stays (both slots render) |

The slot is `app/[lang]/ch/[n]/[section]/@assistant/page.tsx` (a server component reading `searchParams.ask` and the session, rendering the client `AssistantDock` with the conversation's initial data) and `default.tsx` (null). The dock's open state is the URL (shareable, back-button friendly, survives a reload); `esc` and the close button remove `ask` with `router.replace` (D1). `askHref` becomes `?ask=1` on the current section (`SectionActions`, `BottomActionBar`, the keyboard map's `a`); the literal `@assistant` path it points at today is not a URL a slot answers to. Signed out, `?ask=1` renders the dock frame with the sign-in `Notice` (the paths and marks pattern) and the form disabled; the endpoints require a session anyway. Navigating to another section keeps `ask` (the dock follows the reader; the context line updates; the conversation stays the same rows: a conversation is pinned to a release, not a section). Rendering: the section page stays `force-dynamic`; the slot is dynamic too.

## 4. Layout (30a, 30d)

The reader grid gains a variant class when the dock is open: `.reader.reader-dock { grid-template-columns: 64px minmax(0, 1fr) 520px; }` with the right rail (`.reader-rail`) hidden and its instruments reachable in the reading column's inline rail (as under 1000px today), the outline condensed to `.outline-condensed` (64px: an expand button with `aria-expanded="false"` that reopens the three-column reader by dropping `ask`, D2; the part label; the chapter numbers as 44px mono links with the current one 64px tall carrying `.3`, `aria-current="page"`; `path 7/14` at the bottom), and the reading column with padding `32px 48px 40px` and its instrument condensed to one strip (the `Chapter 21 · v1.5.0 · verified 12 Sep 2026` header, `verify · redteam · lab 21 · 14 / 14 derived linked` in a row). Under 1000px the dock is an overlay: `position: fixed; right: 0; top: 48px; bottom: 28px; width: min(520px, 100vw)` over the single reading column, with a backdrop that closes it; under 768px spec 20's sheet replaces it (this spec renders nothing there and the `Perguntar` bar button opens the sheet).

The dock itself: `.dock` (left rule strong, `--bg`), a flex column of header (`.inst-h` with `.t` `Assistant`, the two seps, the two `.iconbtn` at the right), the mode block (`.rb`, padding 14 20), the log (`flex: 1 1 auto; overflow: auto`, padding 16 20, gap 18), the form (`.rt-s`, padding 14 20 16). Class names for the new pieces go into `globals.css` and ui-context § 9.9 in one unit (rules § 3.4): `.reader-dock`, `.outline-condensed`, `.dock-modes`, `.dock-context`, `.turn`, `.turn-you`, `.turn-assistant`, `.turn-head`, `.turn-actions`, `.verdicts`, `.verdicts-toggle`, `.verdicts-grid`, `.verdicts-foot`, `.dock-ask`, `.cited-band`, `.cited-passage`, `.answer-pending`.

## 5. Components (`components/assistant/`)

### 5.1 `AssistantDock` (client shell)

Props: `locale`, `chapter` (number, version, title), `section` (id, title, layer ordinal), `signedIn`, `initial: ConversationView | null`, `labHref | null`, `strings` come from `useTranslations("assistant")`. Holds the conversation state (turns, the pending turn, the stream status), the selected mode (Explain in this spec; the other four radios are present and enabled, and selecting one switches the composer's label and routes the post's `mode`; their result rendering is specs 18 and 19; until those land the radios for walk, lab and brief are rendered `disabled` with the `help` text `phase 2 · soon`? No: D3 says render them enabled and let the endpoint answer, since the flow handles every mode generically and the rendering falls back to claims), the language (`EN | PT`, defaulting to the locale), and the context (chapter and section from the URL; `change context` is a link to the current section's page without `ask`, D4).

### 5.2 Header

`.inst-h`: `Assistant` · `grounded on release {id}` · `guide {version}` (from the last answer's `meta`, else the current guide version passed by the server); the two icon buttons: open full page (`/[lang]/assistant/{conversationId}`, spec 17; disabled until a conversation exists) and close (`aria-label="Close assistant"`, drops `ask`).

### 5.3 Mode strip and context

`role="radiogroup" aria-label="Assistant mode"`, five `.btn.btn-sm[role=radio]` with `aria-checked`; the checked one in the pressed form (ink fill, § 9.10). Above it `mode` and `not chat · answers from the book only` as `.cap`. Below, `.meta` `context · ch21 v1.0.0 · 21.3 worked numbers` and the `change context` `.xref`.

### 5.4 The log and the turns

`<div role="log" aria-label="Conversation" aria-live="polite">`: one `article.turn` per turn (`aria-label` "Earlier turn" / "Current turn"). The user block (`.turn-you`: `.cap` `you · 10:42`, the text as `.ui` for the current turn, `.small` for earlier ones). The assistant block (`.turn-assistant`, padding-left 12): `.turn-head` `assistant · explain · 10:42` and, at the right, `en · cites en edition v1.0.0` when the edition differs from the answer language or always as the screen shows (always); then the answer body, then `.turn-actions`, then the verdicts.

While streaming, the assistant block shows `.answer-pending`: the tokens as one paragraph of plain text with the running `.caret` at the end (`.loader`-style, the only animation), the status line under the head reading `retrieving · drafting · checking · grading · repairing` as the `status` events arrive (`.cap`). Nothing in the pending block is a chip or a link. On `final`, the pending block is replaced by the answer body: one `<p>` per claim group (claims joined in order; consecutive claims citing the same section form a paragraph), each claim followed by its `CitationChip`, a substituted claim rendered as `NoCover` (`the book does not cover this`) with no chip, figures quoted in claims wrapped as `.fig-der.mono` when the citation carries a `figureId` with a derive line (the chip `ƒ L45` after it, `DeriveLink` opening the reader's code pane as spec 03 does). The final body is the row's view from the `final` event, never the streamed text (invariant 14; the test asserts the DOM after `final` contains no text that is not in the event).

### 5.5 `CitationChip`

`Cite` (the primitive) with the section id (`21.3`) or `Lab 21 · README` for a lab citation; `href` to the peek route (`…/ref/21.3`) so a click opens the peek beside the dock and `esc` returns focus to the chip (spec 03's mechanics, `data-peek-anchor`). A citation with a `figureId` adds `data-figure` so the reader can highlight it (§ 7).

### 5.6 `.turn-actions`

`Copy with citations` (`Button` sm; copies the claims as text with `[21.3]` after each claim and the substituted sentence verbatim, then `StatusNote` `copied` in the status bar as the reader's Copy does), `Flag this answer` (spec 17; rendered here as the button with the flag posted by spec 17's `FlagButton`), `Open Lab NN` (a `Button` link to the lab when the chapter has one), and `.cap` `5 citations · 4 figures` at the right (distinct citations; citations with a figure id).

### 5.7 `SensorVerdicts`

A `section.box.verdicts` with the toggle button (`aria-expanded`, `aria-controls`; `▾`/`▸` glyphs, the `label` `sensor verdicts`, at the right `StatusMark` `5 of 5 pass` in `ok`, or `4 of 5 pass` in `warn` when a verdict is WARN, `fail` when one is FAIL, `mute` when NA), the `dl.verdicts-grid` (`112px minmax(0,1fr) auto`; `dt.mono` sensor names `citation sensor · scope sensor · grader · edition · latency`, `dd` the detail line from the row (`4 / 4 figures found at cited location`, `in corpus · 1 claim out of scope, replaced`, `grounded 0.94 · isolated context`, `5 / 5 citations resolve in EN v1.0.0`, `first token 1.3 s · complete 4.6 s`), `dd` the `StatusMark` `pass` / `warn` / `fail` / `info` (latency is `info`, `mute` tone)), and `.inst-f.verdicts-foot`: `log {traceId} · logged per ch29` and `.hash` `hash {short} · prev {prevShort}` from `ledgerLine`. The current turn's box opens expanded; earlier turns' boxes collapsed with the summary `grounded 0.97 · 4 of 4 pass` on the toggle. The expanded state is local (not URL).

### 5.8 `Composer` (the ask form)

`form.dock-ask` `aria-label="Ask the assistant"`: `Field` with `flabel` `ask about chapter 21` (or `ask about 21.3` when a section is the context; D5 keeps the screen's chapter wording), the `.counter` `0 / 800` live, the `.textarea` (min-height 64, placeholder `Ask about the book, its labs or its registries.`), a row with `language` `.select.mono` `EN | PT`, `.help` `answers cite the EN edition`, the grow, and `Button` primary `Ask` (the one warm action of the screen; disabled while a turn streams or when the text is empty or over 800 characters; the counter goes `.is-over` past 800 as the note editor does), then `.tex` `scope: book · labs · registries · cookbook map`. `ctrl/⌘+enter` submits; `esc` inside the field blurs it (the marks pattern); `enter` alone inserts a newline (a question may run several lines).

Submitting: with no conversation, `POST /assistant/conversations` (chapter, section, locale) then the message; with one, the message alone; the `Idempotency-Key` is a UUID minted per submit attempt and reused on a retry of the same text; the hook reads the stream. Errors: 402 renders the budget sentence in an `ErrorBox` inside the log (with the reset date), 429 `Retry-After` as the reader's rate message, 503 the unavailable sentence with `Retry`, 409 `TURN_IN_PROGRESS` refreshes the conversation. No toast, no modal.

### 5.9 `useSse` (`lib/hooks/useSse.ts`)

`useSse(post: () => Promise<Response>)` returns `{ start, status, tokens, final, error, abort }`: `fetch` with the body, reads `response.body` through a `TextDecoder`, splits SSE frames (`event:`, `data:`, blank line), ignores comment lines, dispatches by event name; `abort` cancels the reader (the turn stays open server side until the flow ends; the client then refreshes). No `EventSource` (the request is a POST with a body and headers). Reconnect: on a network error after `meta`, the hook fetches the conversation and shows the row's state.

## 6. Empty, signed-out and error states

| State | Rendering |
|---|---|
| Dock open, no conversation | the log holds `Empty` with `.cap` `assistant`, the line `Ask about 21.3 and the answer cites the book.`, no action (the form below is the action) |
| Signed out | the log holds the sign-in `Notice` (`SignInNotice`) linking to `/login?next=<this url>`; the form is disabled |
| Streaming | `.answer-pending` with the caret and the status line; `Ask` disabled; the status bar cell `assistant docked · explain · answering` |
| Final answer | the body, actions, verdicts; the status bar's last cell `first token 1.3 s` |
| Refusal | spec 17's card in place of the body (this spec renders the cause sentence and code as a `Notice` until 17 lands) |
| Budget, unavailable, rate limit | `ErrorBox` in the log with the catalogue sentence and `Retry` where retrying can help |
| Conversation on a superseded release | the form disabled with the `help` `this conversation is pinned to release {id}; start a new one` and a `Button` `New conversation` (drops the id, keeps `ask=1`) |

## 7. The reader's cited band and highlights (30d)

When the open conversation's last answer cites sections, the reading column shows, under the section head, the `.cited-band` (`StatusMark` `cited` ok tone, the `.small` line `Two passages in 21.3 are cited in the open answer. They are highlighted below.` with the count) when the current section is among the citations, and the cited passages are highlighted: each `[data-figure]` span the answer's citations name gets `.cited-passage` on its paragraph (a left 2px `--ver` rule and `--ver-bg`), and a section cited without a figure id highlights nothing but shows the band (D6: the screen underlines whole sentences; sentence boundaries are not in the HTML, so the paragraph is the unit). The band and highlights come from the `final` event's citations through a small client component (`CitedPassages`) that sets classes on the server-rendered prose and removes them when the dock closes; they never alter the prose's text.

## 8. Status bar and keys

Cells: `ch21 · 21.3 worked numbers` · `assistant docked · explain` (`· answering` while streaming) · `EN · source EN` · `pinned release 2026.09` · trailing `first token 1.3 s` (the last answer's `firstTokenMs`; `—` before the first answer). Keys: `a` opens the dock (adds `ask=1`) and focuses the textarea; `esc` with the dock focused and no peek open closes it (drops `ask`), with the peek open closes the peek first (the reader's existing order: panel, then dock); `?` map lists `a ask about this section` as today; `j`/`k`/`[`/`]` keep working with the dock open and keep `ask`.

## 9. Strings (`assistant.dock.*`, EN / PT candidates)

`title` Assistant / Assistente; `grounded` grounded on release {id} / baseado na release {id}; `guide` guide {version}; `openFull` Open assistant full page / Abrir o assistente em página inteira; `close` Close assistant / Fechar o assistente; `modeCap` mode / modo; `notChat` not chat · answers from the book only / não é chat · responde só com o livro; modes `Explain · Compare · Walk a decision aid · Explain a lab run · Executive brief` / `Explicar · Comparar · Percorrer um auxílio de decisão · Explicar uma execução de lab · Resumo executivo`; `context` context · {chapter} · {section} / contexto · …; `changeContext` change context / mudar contexto; `you` you · {time} / você · {time}; `assistantTurn` assistant · {mode} · {time}; `cites` {lang} · cites {edition} edition {version} / {lang} · cita a edição {edition} {version}; `copy` Copy with citations / Copiar com citações; `copied` copied / copiado; `openLab` Open Lab {n} / Abrir o Lab {n}; `counts` {c} citations · {f} figures / {c} citações · {f} figuras; `verdicts` sensor verdicts / veredictos dos sensores; `pass` {n} of {m} pass / {n} de {m} ok; the five sensor names; `log` log {trace} · logged per ch29 / registro {trace} · registrado por ch29; `hash` hash {h} · prev {p}; `ask` ask about chapter {n} / perguntar sobre o capítulo {n}; `placeholder` Ask about the book, its labs or its registries. / Pergunte sobre o livro, seus labs ou seus registros.; `language` language / idioma; `citesHelp` answers cite the {edition} edition / as respostas citam a edição {edition}; `submit` Ask / Perguntar; `scope` scope: book · labs · registries · cookbook map / escopo: livro · labs · registros · mapa do cookbook; `empty` Ask about {section} and the answer cites the book. / Pergunte sobre {section} e a resposta cita o livro.; `pinned` this conversation is pinned to release {id}; start a new one / esta conversa está fixada na release {id}; comece outra; `newConversation` New conversation / Nova conversa; `answering` answering / respondendo; `statusDocked` assistant docked · {mode} / assistente acoplado · {mode}; `firstToken` first token {s} s / primeiro token {s} s; `cited` cited / citado; `citedLine` {n, plural, one {One passage} other {# passages}} in {section} are cited in the open answer. They are highlighted below. / … Every PT string is a candidate for review (tracker's open item).

## 10. Keyboard, accessibility

- The dock is an `aside` with `aria-label`; the log `role="log" aria-live="polite"` so a screen reader hears the final answer once, not every token (the pending block is `aria-hidden` while streaming, D7).
- Radios are real buttons with `role="radio"` and arrow-key movement inside the group; the checked one is announced.
- Focus: `a` moves focus to the textarea; closing returns focus to the element that opened the dock (the Ask link or the previous focus); the peek's own focus return is unchanged.
- Verdict toggles are buttons with `aria-expanded` and `aria-controls`; the `dl` is the accessible table.
- Chips are links (the peek route); `NoCover` is text; status by word and mark, never colour alone; targets 24px desktop, 44px on the tablet overlay's close.
- Contrast: `--ver` on `--ver-bg` (band), `--ink-3` mono labels: the same pairs the reader already passes with axe.

## 11. Out of scope

- The refusal card, `FlagButton`'s post, the log rail, earlier conversations, JSONL export, the full page (spec 17); the walk form and steps (18); compare, lab and brief bodies (19); the phone sheet (20).
- Streaming markdown: the answer is claims, not markdown; nothing is parsed on the client.
- Persisting the draft question across reloads (no; the URL holds the conversation, not the draft).

## 12. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | The dock's open state | A the `ask` search parameter on the section URL / B a route segment `…/[section]/ask` with an intercept like the peek | **A**: the slot renders for the section URL whatever the query, the dock follows `j`/`k` navigation, back and reload behave, and no second page for hard loads is needed |
| D2 | The condensed outline's expand button | A drops `ask` (closes the dock) / B expands the rail over the dock | **A**: the screen's three-column reader is the expanded state; two rails and a dock do not fit 1440 |
| D3 | The four other mode radios before specs 18 and 19 | A enabled, results rendered as claims / B disabled with a `soon` note | **A**: the flow answers every mode; a disabled control that the screen shows enabled would be a deliberate difference to remove later |
| D4 | `change context` | A a link to the section page without `ask` (pick a section, then `a`) / B a picker inside the dock | **A** in this unit; B if the pilot asks |
| D5 | The ask label | `ask about chapter 21` as the screen | **keep** the screen's wording even with a section context; the context line names the section |
| D6 | Highlight unit in the prose | A the paragraph holding a cited figure / B sentence underlines | **A**: sentences are not marked in the stored HTML; a paragraph rule is exact and cheap; recorded as a deliberate difference from the PNG |
| D7 | Screen-reader behaviour while streaming | A pending block `aria-hidden`, final body announced once / B announce tokens | **A**: token-by-token announcement is unusable; the status line stays readable |

## 13. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Routes: `/en/ch/21/21.3` unchanged (the slot renders nothing; the `.reader` grid is three columns); `?ask=1` renders the dock, the condensed outline (64px, `aria-current` on 21 with `.3`), the narrowed column, the condensed chapter strip; `?ask=<foreign id>` renders the empty state and the URL loses the parameter; signed out, the dock shows the sign-in notice and a disabled form; `esc` and the close button return to the three-column reader; `a` opens it and focuses the textarea; `j` keeps `ask` and updates the context line.
2. Streaming (stub gateway, workers up): typing a figure question from the golden set and pressing `Ask` shows `you · hh:mm`, the status line stepping `retrieving · drafting · checking · grading`, tokens with the caret, `Ask` disabled, the status bar `· answering`; on `final` the body holds the claims with `Cite` chips (`21.3`) and, where the stub cites a figure, the `.fig-der` and `ƒ L…` chip; a stub-substituted claim renders `NoCover`; the action row reads `n citations · m figures`; the verdicts box is expanded with five rows and `5 of 5 pass` (or `4 of 5 pass` in warn with a substitution); the footer shows `log <trace>` and a 12-hex `hash` and `prev`; the status bar's last cell shows the first-token time; the DOM after `final` contains no streamed text that is not in the final event (assert by diffing the pending text against the event's claims).
3. Chips and highlights: clicking `21.3` opens the peek beside the dock; `esc` closes the peek and returns focus to the chip; the reading column shows the `cited` band with the passage count and the paragraphs of cited figures carry `.cited-passage`; closing the dock removes both.
4. Turns: a second question renders the first turn with its verdicts collapsed (`grounded 0.97 · n of n pass`), the current one expanded; `Copy with citations` puts the claims with `[21.3]` markers on the clipboard and the status bar shows `copied`; a reload with `?ask=<id>` renders both turns from the `GET`.
5. Errors: `x-hb-stub-fail` on the workers' path produces the `ErrorBox` with `Retry`; the stub's budget error produces the budget sentence with the reset date and no retry; the 21st ask in a minute shows the rate sentence; a conversation on a superseded release (the release switched in the database) shows the pinned notice and `New conversation`.
6. Layout: 1440 matches `Assistant-Answer.png` in structure and vocabulary (list the deliberate differences: paragraph highlights, the real release and version strings, the trace id format, no `Open Lab 21` when the chapter has no lab); at 1000 to 1200 nothing overflows; at 900 the dock is an overlay with a backdrop that closes it; at 390 the dock does not render (the sheet is spec 20).
7. PT: `/pt/ch/21/21.3?ask=1` with every string from the catalogue, `cita a edição EN v1.0.0`, no overflow at 1440 and in the 900 overlay.
8. axe: zero WCAG 2.2 AA violations with the dock open, streaming, and with the final answer and verdicts expanded, in EN and PT; the log is `aria-live="polite"` and announces the final body once.
9. Token grep clean; the new classes in `globals.css` and ui-context § 9.9; message parity; the caret is the only animation (reduced motion stops it).
10. Invariant check: 14 (no chip, no `NoCover` and no citation count before `final`; the pending block is text), 23 (every network call goes to `/api/v1`, none to the workers or the gateway from the browser).
