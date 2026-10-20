# 17 · Refusals, the conversation log and flags — feature spec (the refusal card, the log rail, earlier conversations, flagging, export, the full page)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screen: `docs/design/screens/Assistant-Refusal-Walk.html` (desktop, 1440) with `png/Assistant-Refusal-Walk.png`: the four-column variant `64px · minmax(0, 1fr) · 232px · 520px` (condensed outline, reading column, the log rail `.rl` `aria-label="Conversation log"`, the dock); the log rail's header `LOG · ch37 · 4 turns`, one row per turn (`t1 · 10:31` with `pass`, the question, `explain · 3 citations`; `t3 · 10:38` with `refused` and a `--fail` inset bar, `scope · control-system operation`; `t4 · 10:40` with `step 2/4` in the running tone, `aria-current`, on `--bg-2` with an `--act` inset bar), the `verdict key` (`pass · all sensors`, `refused · scope`, `in progress`), `earlier conversations` (`ch21 · durable execution` · `18 Sep · 6 turns · 6 pass`), the footer `export JSONL` and the `.tex` fragment; the refusal turn in the dock: the user's question, then `section.box-s` with a 3px `--fail` inset bar, `aria-label="Refusal"`, the header row `refused` mark + `cause · scope · control-system operation`, the body sentence, `what the book does cover` with two rows of `.cite` chip + line (`35.2` What an agent may read, may write and must never touch.), the footer `R-SCOPE-OT · refused before retrieval` and the quiet button `Flag this refusal`; on `Assistant-Answer.html` the answer's `Flag this answer` button. Governing context: `context/ui-context.md` § 6 (status tones: fail for refused, run for in progress), § 9.1 (`.btn-q` quiet), § 9.8 (`.rl` rail), § 10 (Reader + dock: the 232px log rail in the four-column variant), § 13.3 (`ConversationLog` server, `FlagButton` client), § 13.7 (no truncation: the log's questions wrap); `context/architecture.md` § 3.2 (the dock beside the chapter or a full page), § 3.4 (`POST /assistant/messages/{id}/flag`, 10/min, 409 duplicate), § 4.3 (`export` records; JSONL with a signed trailer), § 6.2 (flags enter the grader's calibration set), § 7 (refusal cause in the answer's span); `context/project-overview.md` § Assistant (refusals carry a code and point to what the book covers; the conversation log rail with per-turn verdict, earlier conversations, JSONL export; Flag this answer and Flag this refusal feed calibration).

Prerequisite specs: `13-assistant-agent.md` (refusal causes, codes, pointers with titles), `14-ledger-core.md` (`exportJsonl`, `ledgerLine`), `15-conversations-api.md` (`GET` conversation, the flag endpoint, `listConversations`), `16-assistant-dock.md` (the dock, its URL state, the turn components).

Scope: tracker unit 31. The refusal card in the dock, the log rail and its rows, the verdict key, earlier conversations, flagging an answer or a refusal with a coded reason, the conversation's JSONL export, and the assistant's full page. Not here: the walk (18), the other modes' bodies (19), the phone sheet (20).

## 1. Purpose

A refusal is an answer of a different kind: it says why, with a code, and where the book does cover the question, so the reader learns the scope instead of hitting a wall. The log rail shows a conversation as a sequence of verdicts, one line per turn, so a reader sees at a glance which turns passed, which were refused and which is running, and can reach earlier conversations. Flags are the reader's one word back: a coded reason that enters the grader's calibration set. The export gives the reader the same records the ledger holds, signed.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| The dock and its turns (spec 16, unit 30) | the card and the rail render inside it |
| `AnswerResult.refusal` with pointers and titles (spec 13) and the `final` event (spec 15) | the card's content |
| `POST /assistant/messages/{id}/flag`, `GET /assistant/conversations/{id}`, `listConversations` (spec 15) | flags and the rail's data |
| `exportJsonl` with a `messages` scope (spec 14, extended here, § 6) | the export |

Build order: 31a the refusal card (`RefusalCard`) and the refusal turn in the log → 31b `FlagButton` with the reason dialog, the flagged state, the `assistant.rego` `flag` action already in 15 → 31c the log rail (`ConversationLog` server component with the client row behaviour), the four-column grid, the verdict key, earlier conversations, the rail toggle under 1360px → 31d the export endpoint and link, the full page `/[lang]/assistant/[conversationId]` → verification.

## 3. The refusal card (31a)

Rendered in place of the answer body when a turn's `final` (or the row) has `kind: "refusal"`:

```
section.box-s.refusal[aria-label="Refusal"]   (3px --fail inset bar)
  .between.rb   StatusMark fail "refused"   ·   .meta "cause · scope · control-system operation"
  body          <p>{assistant.refusal.<cause>}</p>                       (the catalogue sentence, never the model's text)
                .cap "what the book does cover"
                a.row × n   Cite {sectionId}   .small {section title}      (the pointers; each a link to the peek route)
  .inst-f       "{code} · refused before retrieval"  |  "{code} · refused after the answer"       Button quiet sm "Flag this refusal"
```

The cause line's second half is the cause's short label (`assistant.refusal.cause.<cause>`: `scope · out of scope`, `scope · control-system operation`, `scope · recomputation request`, `scope · unverified chapter`). `beforeRetrieval` decides the footer's wording; a refusal produced after a whole-output parse failure or a provider refusal (spec 13 § 6) reads `refused after the answer` and its verdicts box (spec 16 § 5.7) shows the `grader · NA` row. No pointers: the `what the book does cover` block is omitted (an `R-UNVERIFIED` refusal has none). The turn's `.turn-head` reads `assistant · {mode} · {time}` as for an answer; the log row's mark reads `refused`. The card has no `Copy with citations` and no citation count.

The refusal's ledger line: a refusal is an `ANSWER` record too (spec 14 § 6: `refusal { cause, beforeRetrieval }`), so the card's verdicts box carries `hash · prev` like an answer; the box is collapsed by default on a refusal (one row of interest: `scope · <cause>`), D1.

## 4. Flags (31b)

`FlagButton` (client): `Flag this answer` (the answer's action row) or `Flag this refusal` (the card's footer). A click opens `ConfirmDialog` titled `Flag this answer?` / `Flag this refusal?` with a `.select` of the coded reasons for that kind (spec 15 § 5.4: answer → `wrong citation`, `missing citation`, `wrong number`, `should have refused`, `other`; refusal → `should not have refused`, `other`), the body line `The flag enters the grader's calibration set with this answer's verdicts. No text is sent.`, cancel and the confirm `Flag`. On confirm: `POST /assistant/messages/{id}/flag`; on 201 the button becomes the disabled `flagged · wrong citation` (`.cap` form, the reason's label) and the log row gains a `flag` glyph (`⚑`? no: § 13.4 has no flag glyph; the row's `.cap` line gains ` · flagged`, D2); on 409 the same as 201 with the stored reason from the `GET`; on 429 the rate sentence; on 401 the sign-in notice. The flag is per user per message: a reload shows the flagged state from the `GET`. No free text anywhere (D3 of spec 15).

The calibration set is a query, not a table (spec 22): every flagged message with its verdicts, `grounded`, citations and the reason. As built (unit 36c-3, 2026-10-04): `lib/db/calibration.ts` `calibrationSet()`, whose rows hold no text and nothing that says who flagged; the Phase 2 gate looks a flagged answer up in it (22 § 3, P2.6a).

## 5. The log rail (31c)

### 5.1 When it renders

At ≥ 1360px with the dock open and a conversation with at least one turn, the reader grid is `.reader-dock.reader-dock-log { grid-template-columns: 64px minmax(0, 1fr) 232px 520px }` (D4: below 1360px the reading column would fall under 480px; the screen's 1440 frame leaves 624). Below 1360px, or with no turns, the rail is folded into the dock header as a toggle button `Log · 4 turns` (`aria-expanded`) that opens the rail as an overlay to the left of the dock (232px, the same content, a backdrop closes it). Under 1000px the dock itself is an overlay (spec 16) and the rail is only ever the header toggle.

### 5.2 Content (`ConversationLog`, a server component with a client `LogRow`)

```
aside.rl.conversation-log[aria-label="Conversation log"]
  .inst-h        .t "Log" · "ch37"        .ts "4 turns"
  ol.log-turns   li.rb.log-turn × n
                   button[aria-expanded][aria-current?]  (min-height 64, padding 10 14, text-align left)
                     .between   .meta "t3 · 10:38"   StatusMark {pass | refused | step 2/4 | failed}
                     .small     the question (wrapped, never truncated)
                     .cap       "{mode} · {n} citations" | "scope · control-system operation" | "walk · derive run 1" | "unavailable"
  .log-key       .cap "verdict key"   StatusMark ok "pass · all sensors"   fail "refused · scope"   run "in progress"
  .log-earlier   .cap "earlier conversations"   a.rb × ≤ 5   .small "ch21 · durable execution"   .meta "18 Sep · 6 turns · 6 pass"
  .inst-f        a.xref "export JSONL"   .tex "#5b0e·a4c1"
```

Row marks: `pass` (ok) when every verdict is PASS or NA and no substitution; `pass` in warn tone with the `.cap` `1 claim replaced` when a substitution happened; `refused` (fail) with the cause label; `step 2/4` (run) for an open walk turn (spec 18); `answering` (run) for the streaming turn; `failed` (mute) for a failed turn (spec 15 § 6.3). The current turn has `aria-current="true"`, `--bg-2` and the `--act` inset bar; a refused turn the `--fail` inset bar. A click scrolls the dock's log to that turn (`scrollIntoView`, the turn gets `tabindex="-1"` and focus) and expands its verdicts; `aria-expanded` mirrors the verdicts box. Rows are in turn order, `t{n}` numbering the user turns.

The `.tex` fragment is the last record's short hash halves (`#5b0e·a4c1` = the first four and the next four hex of the conversation's latest `ledgerHash`), the chrome texture of ui-context § 13.5, never a link.

Earlier conversations: `listConversations(user, { limit: 5 })` minus the current one, newest first, each linking to `/[lang]/ch/{NN}/{section or NN.1}?ask={id}` (the conversation's chapter and its context section); `18 Sep · 6 turns · 6 pass` counts assistant turns and those marked pass; a conversation with a refusal reads `5 pass · 1 refused`. None: the block reads `no earlier conversations` in `.cap`.

## 6. Export (31d)

`export JSONL` links to `GET /api/v1/assistant/conversations/{id}/export` (a fifth endpoint on the pipeline, `auth: "session"`, owner, 10/min, D5): the response is `application/x-ndjson` with `content-disposition: attachment; filename="hb-conversation-{id}.jsonl"`, produced by spec 14's `exportJsonl` with a new scope `{ kind: "messages", ids: [...] }` (the conversation's assistant messages' `ledgerSeq`s), each line the canonical `ANSWER` record with its predecessor, then the signed trailer. The export appends an `EXPORT` record (spec 14 § 5.2) with `scope.kind: "messages"`, actor the user's pseudonymous id. A conversation with no ledger records (all turns failed) answers 404 `NOTHING_TO_EXPORT`. The file verifies with `verifyExport` and the public key; the reader gets exactly what the ledger holds, which is hashes, citations and verdicts, never the text (the text is theirs already, on screen).

## 7. The full page (31d)

`/[lang]/assistant/[conversationId]` (architecture § 3.2: "or full page"): the app shell with the log rail and the dock side by side, centred, no reader; the dock's header shows a `Open beside the chapter` icon button instead of `Open full page`, linking to the conversation's section with `?ask=`. Reached from the dock's header button (spec 16 § 5.2) and from `/[lang]/assistant` (`nav` `Assistant`): a list page of the user's conversations (the earlier-conversations rows at full width, newest first, paged by 20 with `Show 20 more` as the search page pages; the empty state `No conversations yet. Open a chapter and press a.`) with `.statusbar` cells `assistant · {n} conversations`. Signed out, both pages show the sign-in notice. The list is the only place a conversation is found once its chapter has been left; nothing is deleted (spec 15 § 10) until its reader deletes it, since unit 62i from the assistant's page (feature-specs/45 § 3.9).

## 8. Strings (`assistant.refusal.*` from spec 13; `assistant.log.*`, `assistant.flag.*`, `assistant.page.*` here; PT candidates)

`log.title` Log; `log.turns` {n} turns / {n} turnos; `log.turn` t{n} · {time}; `log.citations` {mode} · {n} citations / {mode} · {n} citações; `log.replaced` {n} claim replaced; `log.key` verdict key / legenda; `log.keyPass` pass · all sensors / ok · todos os sensores; `log.keyRefused` refused · scope / recusado · escopo; `log.keyRunning` in progress / em andamento; `log.failed` unavailable / indisponível; `log.earlier` earlier conversations / conversas anteriores; `log.earlierLine` {date} · {turns} turns · {pass} pass; `log.earlierRefused` · {n} refused; `log.none` no earlier conversations / sem conversas anteriores; `log.export` export JSONL / exportar JSONL; `log.toggle` Log · {n} turns; `refusal.covers` what the book does cover / o que o livro cobre; `refusal.before` {code} · refused before retrieval / {code} · recusado antes da busca; `refusal.after` {code} · refused after the answer; `refusal.flag` Flag this refusal / Sinalizar esta recusa; `flag.answer` Flag this answer / Sinalizar esta resposta; `flag.title.answer` Flag this answer? ; `flag.title.refusal` Flag this refusal?; `flag.body` The flag enters the grader's calibration set with this answer's verdicts. No text is sent. / …; `flag.reason` reason / motivo; `flag.reasons.*` wrong citation · missing citation · wrong number · should have refused · should not have refused · other / citação errada · citação ausente · número errado · deveria ter recusado · não deveria ter recusado · outro; `flag.confirm` Flag / Sinalizar; `flag.flagged` flagged · {reason} / sinalizado · {reason}; `page.title` Assistant · The Harness Bible; `page.conversations` {n} conversations; `page.empty` No conversations yet. Open a chapter and press a. / Nenhuma conversa ainda. Abra um capítulo e pressione a.; `page.more` Show 20 more / Mostrar mais 20; `page.beside` Open beside the chapter / Abrir ao lado do capítulo.

## 9. Keyboard, accessibility

- The card is a `section` with `aria-label="Refusal"`; the mark says `refused` in words; the pointers are links with the section title as their text (a chip alone would be an ambiguous link name).
- Log rows are buttons with `aria-expanded` and `aria-current`; arrow keys move between rows (`role="list"` semantics kept: the `ol` stays a list, the buttons are the focusables); `Enter` scrolls and focuses the turn.
- The flag dialog is `ConfirmDialog` (focus trapped, `esc` cancels, focus returns to the flag button); the `.select` has its `label`.
- Status by word and tone; the inset bars are decoration beside the mark, never the only signal.
- The export link is a real anchor with `download`; the JSONL is not rendered.

## 10. Out of scope

- Editing or withdrawing a flag; curator-side review of flags (Phase 4 calibration screens).
- Sharing a conversation. Deleting one is feature-specs/45's (unit 62).
- The walk's log row detail beyond `step n/m` (spec 18); mode-specific rows (spec 19).

## 11. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | The refusal's verdicts box | A collapsed by default, one meaningful row / B expanded like an answer | **A**: a refusal has no citations to verify; the cause is on the card |
| D2 | Marking a flagged turn in the log | A ` · flagged` in the row's `.cap` / B a glyph | **A**: § 13.4 has no flag glyph and words carry it |
| D3 | The earlier-conversations link target | A the conversation's chapter and context section with `?ask=` / B the full page | **A**: the conversation was about a section; the reader lands where it was asked, with the text beside it |
| D4 | When the rail is a column | A at ≥ 1360px / B always at ≥ 1000px | **A**: below 1360 the reading column would drop under 480px with the 232px rail; the header toggle opens it as an overlay elsewhere |
| D5 | The export as a fifth assistant endpoint | A `GET …/{id}/export` on the pipeline / B a server action streaming a file | **A**: a download is a GET with headers, rate-limited and policed like the rest, and documented in OpenAPI |
| D6 | Deleting conversations | not built; unit 62 | **decided** (Andre, 2026-10-11): a reader deletes a conversation with its rows (feature-specs/45 D1); until 2026-10-11, deferred, as account deletion was to cover it |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Refusal (stub gateway): asking an OT question from the golden set renders the card with `refused`, `cause · scope · control-system operation`, the catalogue sentence, `what the book does cover` with `35.2` and `28.1` and their titles as links that open the peek, the footer `R-SCOPE-OT · refused before retrieval` and `Flag this refusal`; no tokens streamed; the log row reads `refused` with the `--fail` bar and `scope · control-system operation`; an `R-UNVERIFIED` question (chapter 34) renders the card without the covers block; a stub parse double failure renders `refused after the answer` with the `grader · NA` row in the collapsed box.
2. Flags: `Flag this answer` opens the dialog focused on the select with the five answer reasons; confirm posts and the button reads `flagged · wrong citation`; a reload shows the same; a second attempt is not offered (button disabled); `Flag this refusal` offers the two refusal reasons; `esc` cancels and returns focus; the row's `.cap` gains ` · flagged`.
3. Rail at 1440: four columns, the header `Log · ch21 · n turns`, rows in order with `t1 · hh:mm`, marks `pass` / `refused` / `answering` during a stream, the current row `aria-current` with the act bar; clicking `t1` scrolls the dock to that turn and expands its verdicts; the verdict key; earlier conversations from another chapter linking to `?ask=<id>` on that chapter's section, with `18 Sep · 6 turns · 6 pass` counts matching the `GET`; `no earlier conversations` on a fresh account; the `.tex` fragment equals the last `ledgerHash`'s first eight hex split `#xxxx·xxxx`.
4. Rail at 1200: the grid is three columns, the dock header shows `Log · n turns`, the toggle opens the overlay with the same content and the backdrop closes it; at 900 the dock is an overlay and the toggle still works.
5. Export: the link downloads `hb-conversation-<id>.jsonl`; the file has one line per assistant turn plus the trailer; `verifyExport` with `infra/ledger/export-public.pem` passes; an `EXPORT` record with `scope.kind: "messages"` was appended; a conversation with only failed turns answers 404; a foreign id 404; the 11th export in a minute 429.
6. Full page: `/en/assistant/<id>` renders the rail and the dock without the reader, `Open beside the chapter` returns to the section with `?ask=`; `/en/assistant` lists conversations newest first, pages by 20, shows the empty state on a fresh account; signed out both show the sign-in notice; status bar cells as specified.
7. PT at 1440 and in the 1200 overlay: all strings from the catalogue, no overflow; a long question wraps in the rail (no truncation).
8. axe: zero WCAG 2.2 AA violations on the refusal state, the rail, the flag dialog open, the full page and the list, EN and PT.
9. Token grep clean; classes (`.reader-dock-log`, `.conversation-log`, `.log-turns`, `.log-turn`, `.log-key`, `.log-earlier`, `.refusal`) in `globals.css` and ui-context § 9.9; message parity; `openapi.json` gains the export operation.
10. Invariant check: 14 (the card renders the catalogue sentence and the final event's pointers, never model text), 18 (the export holds hashes and metadata only), 23 (the export endpoint through the pipeline; OPA down denies it).
