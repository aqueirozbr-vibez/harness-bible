# 26 · Assistant 2.0, the assistant page — feature spec (one page with three regions: the conversations, the dock, the statistics)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screen: none in `docs/design/screens/`: the package shows the dock beside a chapter (`Assistant-Answer.html`, `Assistant-Refusal-Walk.html`) and no page of the assistant's own. The three regions are each an existing thing at its existing width: the log rail (232px, spec 17 § 5), the dock (spec 16) and an instrument rail (330px, one of the four fixed rail widths of ui-context § 10: 64, 232, 330, 520). The page is their composition, built from `context/ui-context.md`; nothing in it is a new component kind.

Prerequisite specs: `23-assistant-book-scope.md` (unit 40: `ConversationSummary.citedChapters`), `24-assistant-dock-anywhere.md` (unit 41: the dock without a chapter, `AskShortcut`), `25-assistant-stats.md` (unit 42: `readerStats`, `StatsPanel`), `17-refusal-log-flags.md` (the log rail, the export, the page this one replaces).

Scope: tracker unit 43. `/[lang]/assistant` as one page holding the reader's conversations, the dock and the statistics; its URL state; its layout from 1440px down to a phone; the redirect from the old conversation URL. Not here: anything the three regions do inside themselves, which is specs 16 to 19, 24 and 25.

## 1. Purpose

Andre, 2026-10-04: "the assistant sub page should contain 3 things: the conversations, the assistant dock and a dashboard of the observability stats".

Today `/[lang]/assistant` is a list and `/[lang]/assistant/[conversationId]` is a second page with one conversation's log and the dock; the list sends the reader to a chapter to ask, and there are no statistics anywhere. After this unit there is one page. On the left, every conversation the reader has had, with the open one unfolded into its turns. In the middle, the dock, ready to take a question about the book without opening a chapter first. On the right, the reader's statistics, which move when an answer lands.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| Unit 41 (spec 24) | the dock that needs no chapter; `variant="page"` |
| Unit 42 (spec 25) | `StatsPanel`, `readerStats` |
| `listConversations` with `citedChapters`, `conversationStats` (spec 23 § 7.2) | the left region |
| `ConversationLog` and its rows, the export link, the verdict key (spec 17) | the open conversation's turns |

Build order: 43a the route, its URL state and the three-column grid with the regions in place at 1440 → 43b the conversations region (the tree, paging, `New conversation`, the redirect from the old URL) → 43c the widths below 1360px (the region switch), the refresh after an answer, the status bar, the browser passes and the context files.

## 3. The route and its URL (43a)

One page, `app/[lang]/assistant/page.tsx`, rendered per request.

| Parameter | Values | Meaning |
|---|---|---|
| `ask` | absent, or a conversation's id | the open conversation, with the same meaning the dock gives it on every other page (spec 16 D1). Absent is the empty dock, ready for a first question |
| `w` | `month` (default), `all` | the statistics window (spec 25 D2) |
| `n` | 20 (default) to 200, in steps of 20 | how many conversations the left region lists (the constants the list page already has) |
| `view` | absent, `conversations`, `stats` | under 1360px, which region is in front (§ 6) |

`app/[lang]/assistant/[conversationId]/page.tsx` becomes a redirect to `/{locale}/assistant?ask=<id>`, so the links already written (the dock header's `Open assistant full page`, anything a reader saved) keep working (D1).

Why `ask` and not the path: the first question creates the conversation while its answer streams. The dock records the new id with `history.replaceState` and refreshes when the turn ends (as built, `AssistantDock.tsx`). On one route that refresh re-renders the same page and the dock keeps its state. Across two routes it would mount a different page under a dock that is still showing an answer.

A foreign or unknown id is the empty dock and the parameter is dropped, as on every other page. Signed out, the page is the top bar and the sign-in notice returning to the same URL, as today.

## 4. The three regions at 1360px and wider (43a)

```
TopBar   current="assistant"
main.assistant-page[aria-label="Assistant"]            grid: 232px · minmax(0, 1fr) · 330px; each region scrolls on its own
  nav.assistant-conversations[aria-label="Your conversations"]     § 5
  AssistantDock variant="page"                                     its content column at most 680px wide (the reading measure), centred
  StatsPanel                                                       spec 25 § 5, with the budget meter under it
StatusBar   "assistant · {n} conversations" · "release {id}"                 (the two cells the list page has today)
```

- The dock in its `page` variant has no backdrop, no close button and no `esc` (there is nothing behind it), as spec 17 § 7 built it. Its `Open beside the chapter` button is removed: a conversation has no chapter to return to. Citation chips and refusal pointers lead to the reader at the cited section with the dock beside it and the same conversation open (spec 24 § 5.5).
- `a` focuses the ask box (`AskShortcut`, spec 24 § 6.1).
- The middle column is `minmax(0, 1fr)`: at 1440px it is 878px, and the dock's turns sit in a 680px column inside it. The 520px of the docked form is a rail's width; here the dock is the page's main column.

## 5. The conversations region (43b)

One tree: the reader's conversations, newest first, the open one unfolded into its turns.

```
nav.assistant-conversations
  .inst-h        .t "conversations"                 .ts "{n} conversations"
  a.btn          "New conversation"                 → /{locale}/assistant   (keeps `w`)
  ol
    li           a.row → ?ask=<id>                  aria-current="page" on the open one, with the act bar the log's current row has
                   .cap    "18 Sep · 6 turns · 6 pass · 1 refused"          (the existing `assistant.log.earlierLine` and `earlierRefused`)
                   label   "ch21 · ch20 · ch09"                             (`citedChapters`; spec 23 D8)
                           or "no citations" when it has none, and the existing `assistant.purgedShort` mark once its text is purged
                 the open conversation only:
                   ol.log-turns   the turn rows of spec 17 § 5.2, unchanged: "t1 · 10:31 · pass", the question, "explain · 3 citations"
                   a              "export JSONL"                            (spec 17 § 6, unchanged)
  a              "Show 20 more"                     → the same URL with `n` raised   (existing `assistant.page.more`)
  .log-key       the verdict key                    (spec 17 § 5.2, unchanged)
```

- The list is the server's (`listConversations(user, { limit: n })`). The open conversation's turn rows are the dock's own turns, live while an answer streams, which is how the log is fed today (architecture decision of 2026-10-03, `ConversationLog`): the dock renders the region and is handed the list.
- A conversation is labelled by the chapters its answers cite, never by the reader's words (spec 15's rule, kept by spec 23 D8). The questions themselves are in the open conversation's turn rows, where they already are.
- An open conversation that is older than the listed `n` is shown at the top of the list, so the open row always exists.
- With no conversation yet the list is one `Empty` block (§ 8) and the dock beside it is ready.
- The region replaces two things: the list page's `ConversationsList` and the rail's "earlier conversations" block on this page. In the dock beside a chapter the log rail keeps its own shape (the open conversation's turns, then five earlier ones), with each earlier row now linking to `?ask=<id>` on the page the reader is on instead of to a chapter.

## 6. Narrower than 1360px (43c)

| Width | Layout |
|---|---|
| ≥ 1360px | three columns (§ 4) |
| 1000–1359px | two columns, `minmax(0, 1fr) · 330px`: the dock and the statistics. The conversations open over the page from the dock header's log toggle, as the log rail does at this width today |
| < 1000px | one column, and a region switch above it: `nav.seg` with three links, `Assistant` (no `view`), `Conversations` (`view=conversations`), `Statistics` (`view=stats`); the current one `aria-current="page"` |
| < 768px | the same one column and switch. The dock's `page` variant is already displayed under 768px (`globals.css`), unlike the docked form; whether it is usable at 390px is checked in the browser pass, and if it is not, the `Assistant` view shows the existing notice and the other two views stay (D4) |

The breakpoints are the three the dock and the log rail already use (1360, 1000, 768). The switch is links and URL state, so the server renders the region asked for and nothing is hidden by script.

## 7. What moves when an answer lands (43c)

The dock already calls `router.refresh()` when a turn ends. On this page that refresh re-renders the server's parts: the conversations' counts and labels, the status bar's count and `StatsPanel`. Nothing polls and nothing new is fetched by the client. During a stream the statistics show the state before the turn.

## 8. Strings (EN and PT candidates; Andre's to confirm)

| Key | EN | PT |
|---|---|---|
| `assistant.page.conversationsTitle` (new) | conversations | conversas |
| `assistant.page.noCitations` (new) | no citations | sem citações |
| `assistant.page.empty` | No conversations yet. Ask your first question. | Nenhuma conversa ainda. Faça sua primeira pergunta. |
| `assistant.page.viewLabel` (new) | Assistant page regions | Regiões da página do assistente |
| `assistant.page.viewDock` (new) | Assistant | Assistente |
| `assistant.page.viewConversations` (new) | Conversations | Conversas |
| `assistant.page.viewStats` (new) | Statistics | Estatísticas |
| `assistant.page.beside` ("Open beside the chapter") | removed | removed |
| `assistant.page.statusConversation` ("assistant · {label}") | removed; the status cell is the existing `statusList` | removed |

Kept as they are: `assistant.page.title`, `metaTitle`, `listLabel` ("Your conversations"), `conversations`, `more`, `statusList`; `assistant.dock.newConversation`; `assistant.log.*`; `assistant.purgedShort`.

## 9. Keyboard, accessibility

- Three landmarks with names: `nav` "Your conversations", the dock's `aside` "Assistant", the panel's `aside` "Assistant statistics". The page has one `h1`, the existing `assistant.page.title`, visually hidden if the layout has no place for it.
- Tab order follows the reading order: conversations, dock, statistics. `a` moves focus to the ask box from anywhere on the page.
- The open conversation is `aria-current="page"`; the open turn keeps `aria-current="true"` inside it, as the log does today.
- The region switch is a `nav` of links, named by `assistant.page.viewLabel`.
- Nothing truncates: a long list of cited chapters wraps; ids may break anywhere (ui-context § 11).
- Each region scrolls on its own at 1360px and wider, and each is reachable and scrollable by keyboard (a scrolling region is focusable).

## 10. Out of scope

- Renaming a conversation. Deleting one is feature-specs/45's (unit 62): `Delete conversation` in the open conversation's block (§ 3.9).
- Searching conversations.
- Every reader's statistics, an organisation's view (spec 25 D1).
- The phone sheet of spec 20.
- A second conversation open at once.

## 11. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | The open conversation in the URL | A `?ask=<id>` on `/assistant`, the old path redirecting / B keep `/assistant/[conversationId]` as a second page | **A**: it is the state the dock already keeps on every other page, and the first question's answer keeps streaming while the URL gains its id (§ 3) |
| D2 | The left region | A one tree: every conversation, the open one unfolded into its turns / B two blocks: the open conversation's log, then a list of the others | **A**: "the conversations" is one thing to the reader, and a tree is one of the three forms the product draws structure in (ui-context § 13.5: trees, ruled tables, single big numbers) |
| D3 | `/assistant` with no `ask` | A the empty dock, ready for a question / B the reader's latest conversation | **A**: a page that opens ready to ask is the point of the feature; the latest conversation is the first row beside it |
| D4 | Under 768px | A one column with the region switch, the dock included if the browser pass finds it usable / B conversations and statistics only, and the notice in place of the dock | **A**, falling back to B on what the browser pass shows. The modal sheet of spec 20 stays skipped either way |
| D5 | The dock's width as the main column | A the reading measure, 680px, centred / B 520px, as docked | **A**: answers are prose, and 680px is the measure the reader sets prose in |
| D6 | Which rail gives way first under 1360px | A the conversations, behind the log toggle / B the statistics | **A**: the toggle and its overlay exist already, and the statistics are the region that changes while the reader asks |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. `/en/assistant` signed in at 1440: three regions, the widths of § 4, each scrolling on its own; the dock empty and focused by `a`; the statistics for this month.
2. A first question asked there: the answer streams without the page reloading, the URL gains `?ask=<id>` while it does, and when it ends the new conversation is the first row, unfolded, with its turn; the status bar's count and the statistics' denominators each rise by one.
3. A row of another conversation opens it (`aria-current` moves, its turns unfold, the dock shows it); `New conversation` empties the dock and keeps `w`; `Show 20 more` lists forty.
4. `/en/assistant/<id>` redirects to `/en/assistant?ask=<id>`; a foreign id shows the empty dock with the parameter dropped; signed out, the notice returns to the same URL after sign-in.
5. A conversation whose text was purged shows its mark and its cited chapters, and its turns show the purged line they show today; `export JSONL` downloads the open conversation and `verifyExport` passes.
6. A citation chip opens `/en/ch/21/21.3?ask=<id>` with the dock beside the text and the same conversation; `Open assistant full page` there returns to this page with it.
7. `w=all` changes the statistics and nothing else; the conversation and the list stay.
8. Layout at 1440, 1360, 1200, 1000, 900 and 390: the columns of § 6, the log toggle at 1200, the region switch under 1000, nothing overflowing; the finding at 390 for D4 recorded.
9. PT at 1440, 1200 and 900: every string from the catalogue, nothing truncated.
10. axe: zero WCAG 2.2 AA violations on the page empty, with a conversation open, during a stream, in each `view` under 1000px, EN and PT.
11. Token grep clean; new classes (`.assistant-conversations`, the grid's variants) in `globals.css` and ui-context § 9.9; message parity; removed keys gone; `ConversationsList.tsx` deleted if nothing imports it.
12. Invariants: 14 (the dock is the same component; nothing renders model text outside `final`), 24 (every read through the guard), 26 (the list counts turns per conversation as the rail has since spec 17, and ranks nothing). Context files amended in this unit: architecture § 3.2 (the route map: `/assistant` as a page of three regions, the redirect); the overview's Assistant features ("or full page" becomes the page of three regions); ui-context § 10 (the page's grid and its breakpoints).

## 13. As built (unit 43, 2026-10-04)

Built as 43a to 43c and verified per § 12. Where the build differs from the sections above, this section is later.

**§ 7 was wrong about the dock, and the build makes it true.** The dock did not call `router.refresh()` when a turn ended: it did so only when the server answered that another turn was still open. It now does, on this page alone, after a `final`: that is what moves the list, the status bar's count and the statistics.

**One dock, one conversation at a time: `AssistantDock` is a wrapper with a key.** The refresh above, and every link of the tree, changes the server's `conversationId` under a dock that keeps its turns in client state. Two cases look alike and must not be confused. When the id has become the conversation this dock opened itself, the URL has only caught up: the turns on screen stay, with what only the `final` event carries (a refusal's pointers). When it has become another conversation, or none, the reader has moved on and the dock starts again from the server's rows. The wrapper tracks which and changes the session's key only in the second case. Before this, a dock on one page had no second conversation to move to; the dock beside a chapter gains the same correctness for its earlier-conversations links.

**The open conversation always has a row.** A conversation created by its first question has no row in the server's list until the turn ends; its line is built from the turns on screen by the rules the server counts with (`lineOfTurns`, `lib/assistant/summary.ts`) and stands first, where the server will put it. One older than the listed `n` is prepended by the page from the conversation itself.

**The URL state is one pure function** (`assistantPageHref` and `assistantPageStateOf`, `lib/assistant/links.ts`): each parameter is left out at its default, so `/en/assistant` is the plain page, and anything the page does not know reads as the default.

**§ 4, the status bar** has the two cells the list page had (the count, the release). **§ 5** as specified; the `export JSONL` link stands under the open conversation's turns, and the verdict key at the foot of the region. `assistant.page.noCitations` of § 8 is `assistant.log.noCitations` (unit 40); `assistant.page.cap` and `statusConversation` are removed, and `beside` went in unit 41. `ConversationsList.tsx` is deleted, and the log's `column` mode with it.

**D4 is option A.** At 390px the page is one column with the region switch; the dock is displayed, its ask box takes text, `Ask` is reachable, nothing overflows and axe finds nothing. So a reader on a phone can ask the assistant from its own page, although the dock still does not render over other pages there and the modal sheet of spec 20 stays skipped.

**The statistics panel in a browser (spec 25 § 10.4 to § 10.8, deferred to this unit).** On the development database, as `demo@harness-bible.local`, all time: citation rate 55.6 % (10 / 18 answers), refusal rate 33.3 % (11 / 33 turns), first-token p95 8623 ms (n = 16), grounded p50 1.00 with p10 0.75 (n = 13), flag rate 3.0 % (1 / 33). A count made directly in the database for that reader gives the same seven numbers. (Spec 25 § 10.4 said to compare with `npm run assistant:metrics`; that script counts every reader, and the development database has several, so the count was made per reader in SQL instead.) Three thresholds are crossed on that account and each says so in words (`below floor`, `above ceiling`, `over limit`); the refusal meter carries the `.fail` fill and its accessible name includes `ceiling 20.0 %`. A fresh account shows the empty block and the budget meter. In PT the grid stays two to a row and nothing is clipped. Two faults were found by looking at the screenshots and fixed: the panel's header did not fit one line of a 330px rail (it now wraps, as the dock's does when narrow), and a share in the refusals table broke between its figure and its unit.

**Verified in the browser** (Playwright and axe, 58 checks, all passing, run twice; the one turn asked each run was one the rules refuse, so no model was called): the three regions at 232, 680 inside 878, and 330 at 1440, each scrolling on its own; `a` focusing the ask box; a first question answered without the document reloading while the URL gains `?ask=<id>`, then the new conversation first in the list and unfolded, the count and the statistics' denominator each one higher, and the refusal's pointers still on its card after the refresh; another row opening its conversation; `New conversation` keeping `w`; `Show 20 more`; the redirect from the old address; a foreign id dropped; a pointer leading to the reader with the conversation and the reader's dock leading back; `w=all` changing the statistics alone; three columns at 1360, two at 1200 and 1000 with the conversations opening from the toggle and closing on the backdrop, one column and the switch at 900 and 390; no horizontal overflow at any of them; PT at 1440, 1200 and 900; signed out, the notice returning to the same URL; axe with zero WCAG 2.2 AA violations on ten states, EN and PT.

**Not verified:** § 12.5. A purged conversation's row was not looked at, because purging the development database's text is not done on this machine before a demonstration (the row's mark is the string the list has shown since unit 35); and the export was not downloaded and verified again (the link is unit 31's, unchanged). Anything that needs an answer rather than a refusal, as in units 40 and 41: no model was called.
