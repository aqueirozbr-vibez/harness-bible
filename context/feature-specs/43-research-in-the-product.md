# 43 · Research in the product — feature spec (how a run starts and how a reader sees one; the research line under an answer; the proposal and "Add my name"; the reader's proposals; the queue's researcher group; the research log; the record of a researcher's proposal)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: Andre's request of 2026-10-05 ("it displays the suggestion to the human"; "it is logged, but nothing chages or is proposed"), his answers A1, A2, A4 and A5, and his question of 2026-10-10 ("how do i start a research in the UI? the idea was that every answer from the assistant could trigger a research. we need the ux, ui and frontend to use the researcher"). No screen of the UI package shows any of this: the Assistant-Answer screen's rail has no Improve entry point, and the Curator-Queue screen has no researcher group. Everything here is composed from classes the product already has (`context/ui-context.md`), and every string is a candidate (§ 10).

Rewritten on 2026-10-10 against the frontend as built (the dock and its turn, the Improve pages and the queue, the account page, the catalogue and the two browser suites), after units 57 and 58 built the run and the researcher. What the first version left out is what Andre's question found: nothing said how a run starts — or that nothing starts it but an answer — and nothing said how to see one on a development machine.

Where the first version is cited by another spec (the strings as § 3, the account page as § 8, the log as § 6.2, the `verified` mark as § 7, the queue group as § 6, the verifications as § 11.5 and § 11.6): the strings are now § 10, the account page § 9, the log § 7.2, the `verified` mark § 8, the queue group § 7.1, and the verifications § 13.5 and § 13.6. The citing specs were updated with this rewrite.

Prerequisite specs: `16-assistant-dock.md`, `17-refusal-log-flags.md`, `24-assistant-dock-anywhere.md` and `26-assistant-page.md` (the dock, a turn, the verdicts box); `35` (the landing page, the outcome and record pages), `36` (the queue), `40` (the run), `41` (the researcher), `42` (what a finding becomes).

Scope: tracker unit 60 (60a to 60e). Not here: the researcher's gate and its Grafana dashboard (spec 44, unit 61).

## 1. Purpose

The product's first rule of interface is that it shows its machinery: versions, hashes, budgets, verdicts. A second agent working after every answer, sending a reader's question to a model and searching the web, is machinery a reader is entitled to see, and a proposal for the book is the one thing in the whole product the reader is asked to put their name to. This spec gives each a place, and keeps one line that must never blur: the answer is from the book; the proposal is not part of the answer.

## 2. Dependencies and order

60a needs only the run (unit 57) and may be built now. 60b needs proposals and endorsement (59b, 59d). 60c needs the landing page and 60b's reads. 60d needs the queue and 59c. 60e needs 59c. The development path of § 3.3 needs nothing to be built: it is configuration.

## 3. How a research run starts, and how to see one

**Amended by feature-specs/48 (unit 75, 2026-10-12), the switch-over.** Since unit 75 nothing starts a run but a person: an answer no longer hands its turn to research (48 § 9.2), so § 3.1's nine rules, § 3.2's `final` carrying `research` and § 3.3's "every answered turn … starts a run" describe the legacy runs alone. Every answered turn ends instead with `Start a research` (48 § 9.1, A6) — the "no button" of § 3.1 and the out-of-scope line of § 11 are reversed by Andre's A2 — a link to the Research page seeded from the answer, which spends nothing until Start. A2 also answers D5. The line and the panel of § 4 and § 5 stay for the legacy runs, read from their rows (48 § 9.3).

### 3.1 Nothing starts a run but an answer

There is no button. A2 chose every answered turn, deduplicated, never a refusal; "research this" on request is out of scope (spec 40 § 10), and D5 below is where that decision stands for Andre to change. A run starts by itself at the end of an answered turn (spec 40 § 6.1), after the answer is stored and before the dock receives the `final` event, when all of these hold (spec 40 § 5, in order):

1. research is configured on the server (a research principal and the engine's address);
2. the reader's switch is on (the account page's Preferences, built in unit 57: `account.prefs.research`);
3. the organisation's switch is on (an operator's command, spec 40 D5; no screen);
4. the turn was answered, not refused;
5. the answer cited at least one section;
6. research is not waiting for its monthly budget to reset;
7. the reader started fewer than 30 runs in the last 24 hours;
8. this question was not researched in the last 30 days;
9. at least one cited section was not researched in the last 30 days, or the answer said the book does not cover something (a gap).

The first rule that fails names the skip, so a turn under a standing budget mark reads `budget` whatever its sections. When one fails, the turn still gets a row saying why (`SKIPPED` with its reason), and the reader sees the reason as the research line's words (§ 4). The reader is never asked anything, and the answer streams exactly as it would without research (spec 40 § 1); what research adds to the turn is the hand-over after the answer is stored — the switches, the marks, the day's count, the row, the engine's start — which comes before the `final` event and outside the turn's own `totalMs` (spec 40 § 13 as amended; spec 44 R1 measures it), so the chips and verdicts arrive a moment later than they otherwise would, with the research line among them.

What the reader can do about a skipped run: switch research on (rule 2), wait for the month's reset (rule 6) or for tomorrow (rule 7), ask again after 30 days or about another section (rules 8 and 9). The line says which. Rules 1 and 3 are the operator's; the line says `not run` or `off for your organisation` and offers nothing.

### 3.2 What a reader sees, in order

The `final` event carries `research: { state, skip, runId }` (spec 40 § 6.1 step 4; `ResearchStartedSchema`). The line under the answer starts from it and, while the run is not over, follows the run through `GET /api/v1/assistant/messages/{id}/research` (§ 4.3): `queued` → `searching the web` → `checking with Improve` → `1 proposal for the book` or `nothing to propose`. A run takes tens of seconds to a few minutes; a run that waits for the budget may take until the month's reset, and the line says so and stops asking. When a proposal exists, the panel of § 5 opens under the line; when a curator later decides, the panel's "where it is" line changes the next time the reader looks (no notification; § 11).

### 3.3 In development: seeing a run on this machine

Nothing of research runs on a development machine until the operator configures it; until then every answer's line reads `research · not run` (spec 40 § 13: every turn is `SKIPPED · UNAVAILABLE`). The configuration is the production one on the stub gateway, and it is Andre's to do (tracker, Waiting on Andre, item 3):

1. the workflow engine up: the compose service `.env.example` names beside `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` (spec 28; `docker compose up -d`). With the two variables set and the engine down, the hand-over takes the run's row back and the line reads `not run` with no hint why: the engine is the first thing to check;
2. the research organisation: a row with the name `Research` and a token cap worth A14's US$ 20 at the frontier input price (`tokensOfUsd(20)`, lib/gateway/prices.ts), written by `npm run research:org -- --create` (unit 60a adds the flag to the script, which today only switches an organisation off and on; nothing else in `scripts/` creates an organisation, and a development organisation reused would carry its own cap, not the researcher's). The gate's fixture organisations are not for this;
3. its gateway key at the stub: `npm run gateway:key -- --org <organisationId>` with the stub running (`npm run dev` starts it, or `npm run gateway:stub`), which mints the key with that cap as its `max_budget`;
4. `RESEARCH_PRINCIPAL=org:<organisationId>` in `.env`;
5. the workers restarted (`npm run workers`), so they read the variable.

From then on every answered turn on the development server starts a run on the workers, and the stub answers the researcher's two calls with its default fixtures (spec 41 § 12): the planner finds something to research and writes a brief about the first cited section; the reader searches once, opens one fixture page and writes one finding anchored at that section — an `ADD_CLAIM` with the fixture's sentence, sourced to a fixture address. The run's line goes from `queued` to `checking with Improve` and, until unit 59 is built, to `nothing to propose`: a valid finding with nothing to submit it.

**Once unit 59 submits findings, the fixture's source is the problem**: a proposal's sources are opened again by the product's own fetcher (spec 42 § 4.2, D2), and `https://standards.example/…` does not exist, so the item is tier U, the claim scores under its floor, the suggestion is declined at intake and the line reads `nothing to propose` — the development path would demonstrate refutation and nothing else. D9 decides how the fixture pages reach the fetcher in development: a development-only fixture fetcher (the Improve harness already has one for its worked examples, `tests/fixtures/improve/harness.ts`), switched on by a workers' variable the production image refuses, answering the stub's fixture hosts with the stub's pages. With it, every answered turn in development ends with one proposal for the book, which is the demo path for every surface below: the line, the panel, `Add my name`, the landing page's list, the queue's group, the curator's decision, the record. Without it, the path demonstrates the run and its refutation, honestly worded.

The stub's other fixtures (the reader's `nothing`, `pause`, `injection`, `four`, `malformed`; the planner's `covered`, `not-about-the-book`, `personal`, `leak`, `malformed`) are chosen by request headers the browser cannot send; they are the suites' and the integration tests', not the dock's. The dedupe rules hold in development as in production: the second question about the same section within 30 days reads `skipped · these sections were researched today`, and a gap question runs again. The account page's switch shows the reader's `off` line. The organisation's `off for your organisation` line cannot be shown on this machine as the accounts stand: development accounts belong to no organisation, and `researchSwitches` answers `on` for a reader with none; `npm run research:org -- --organisation <id> --set off` is for an organisation whose members exist, and the demo of that line waits for one (D13).

## 4. The research line (60a)

### 4.1 Where

One line under each answered turn, the last child of `.turn-assistant` in `TurnBlock` (`components/assistant/TurnBlock.tsx`), after `SensorVerdicts` and outside the answer block (`.turn-body` / `AnswerBody`, `CompareTurn`, `LabTurn`, `BriefTurn`), and in the same place in `WalkTurn`, which renders a walk turn on its own and ends with its `SensorVerdicts` (a walk is an answer with citations, and so eligible): a new client component `ResearchLine` given the turn's `messageId`, the `research` the turn carries and the conversation's id. It renders for a turn whose `answer` is not null, whose `refusal` is null and whose `research` is present; a refusal has no line, and its absence needs no explanation (a refusal's `final` carries `SKIPPED · NOT_AN_ANSWER`, which the dock drops); a turn from before unit 57, or a stored `final` replayed without the field, has none either. It renders wherever the turn renders: in the dock on any page, and in the assistant page's column, which alone renders under 768px (`.assistant-page .dock`), so on a phone the line and the panel exist on the assistant page and nowhere else, and the reader's proposals are on the landing page (§ 6).

It is the mono status style the verdicts box's footer uses — `.inst-f`-like, 11px mono, `--ink-3`, wrapping — as its own `.research-line`: a `.st.st-plain` mark for its state (the product's lower-case status mark; ui-context § 6: a word and a shape, never colour alone) carrying the one word of the state — `queued`, `searching`, `checking`, `proposal`, `nothing`, `waiting`, `skipped`, `off`, `failed`, `not run` — in the hue of its kind (`.st-run` with the caret while the run is under way, which holds still under reduced motion; `.st-ok` for a proposal; `.st-warn` for `waiting`; `.st-mute` for everything else), then the rest of the line beside it as plain mono text with `·` separators, as the footer's lines are, never a spinner (ui-context § 9.6). A number where there is one.

**It never moves the answer.** The line and everything under it render outside the turn's answer block: no claim, citation chip or verdict changes when research finishes, and "Copy with citations" (`TurnActions`, `copyWithCitations`) copies the answer alone, which it does by construction, reading the claims and nothing else.

### 4.2 The words

Every state and skip of spec 40 § 3 has a line. The first version of this spec mapped some; this table maps all, and the two it had conflated — a turn skipped for the budget, which never runs, and a run waiting for the budget, which resumes — now read differently (D8).

| The run | Mark | The line (EN candidate) | Where the words come from |
|---|---|---|---|
| `QUEUED`, `PLANNING` | run | `research · queued` | state |
| `READING` | run | `research · searching the web` | state |
| `VALIDATING`, `SUBMITTING` | run | `research · checking with Improve` | state; after unit 59 `SUBMITTING` lasts while the proposals are graded and adjudicated |
| `DONE`, proposals | ok | `research · 1 proposal for the book` (plural by count) | the findings `PROPOSED`, by count |
| `DONE`, none | mute | `research · nothing to propose` | `DONE` with no `PROPOSED` finding; also `SKIPPED · NOTHING_TO_RESEARCH` (D2: refuted and nothing-found read alike) |
| `WAITING_BUDGET` | warn | `research · waiting for budget · resets 01 Nov` | the `budget` mark's `until` (spec 40 § 7.2); the line stops asking here (D1) |
| `SKIPPED · BUDGET` | mute | `research · skipped · the month's budget is spent · resets 01 Nov` | the `budget` mark's `until`; this turn is not researched (spec 40 D3) |
| `SKIPPED · DEDUPED` | mute | `research · skipped · these sections were researched 12 days ago` (`today` for 0) | the newest `section:<anchor>` mark among the cited sections; the number is the most recent research of any of them |
| `SKIPPED · SAME_QUESTION` | mute | `research · skipped · this question was researched 12 days ago` | the `question:<sha256>` mark |
| `SKIPPED · DAILY_LIMIT` | mute | `research · skipped · 30 runs today` | `RESEARCH_RUNS_PER_DAY` |
| `SKIPPED · NO_CITATION` | mute | `research · not run · nothing cited` | skip |
| `SKIPPED · OFF_USER` | mute | `research · off` with the link `switch on` to the account page's Preferences (`/[lang]/account#pref-research`); since unit 75 `research · off` alone, the switch being gone (48 § 9.3) | skip |
| `SKIPPED · OFF_ORGANISATION` | mute | `research · off for your organisation` (no link: there is no screen for it) | skip |
| `SKIPPED · TEXT_PURGED` | mute | `research · not run` | skip; a run the purge ended before it read |
| `SKIPPED · UNAVAILABLE` | mute | `research · not run` | skip: the engine or the rows did not take it |
| `FAILED` | mute | `research · failed` | state; the failure code is never shown. Its own word (D10): the reader may have watched the run search for a minute, and `not run` would be untrue |
| `SKIPPED · NOT_AN_ANSWER` | — | no line | a refusal |

The days are whole days from the mark's `at` to now, as the account page counts retention. The reset date and a decision's deadline are `formatDayMonth` (`01 Nov`, `12 Oct`; lib/i18n/format.ts): a day within the month ahead, no year, no time.

### 4.3 Where the state comes from

- **Seed**: the `final` event's `research`. `answerOfFinal` (`lib/assistant/turns.ts`) copies it onto `AnswerView.research` (today it drops it).
- **Follow**: while the state is `QUEUED`, `PLANNING`, `READING`, `VALIDATING` or `SUBMITTING`, the line asks `GET /api/v1/assistant/messages/{id}/research` every 5 s (D1) and stops at `DONE`, `SKIPPED`, `FAILED` or `WAITING_BUDGET`, when the dock closes, when the turn's conversation is left, while the document is hidden, and after ten minutes of asking (the audit export panel's own bound), the line keeping its last words. Only the newest unfinished turn of a conversation asks: an older turn still unfinished is read when the newest one's answer comes back, by the same endpoint, so five open turns are not five polls against the reader's sixty reads a minute (D14). The pattern is `EvidenceList`'s 2 s poll: visibility-aware, honouring `Retry-After` on a 429; a 401, 403 or 404 stops the poll and leaves the line as it was; a 5xx or a network failure is retried at the next tick, up to the ten minutes.
- **Reload**: a turn read back from its row carries the run as the conversation's view carries it — `MessageViewSchema.research` is the whole `ResearchView` (state, skip, days, resetsAt, proposals), built by the same presenter as the endpoint's answer from the message's `researchRun`, its findings and the marks — so a reload shows the same line and the same panel without asking, and follows a run still under way.
- **The endpoint** (`lib/api/endpoints/assistant.ts`, the message's owner by the policy's existing `read` on `message`; `READ_RATE`, 60 a minute) answers from the asker's own rows and the platform's marks, inside the asker's tenant context: the run by `messageId`; `days` from the marks; `resetsAt` from the `budget` mark; and `proposals`, each the `ProposalView` of § 5.3, found through the asker's own `ResearchFinding` rows with outcome `PROPOSED` — the one direction in which that link may be followed (spec 40 § 3). Response: `{ state, skip, days, resetsAt, proposals }`, `ResearchViewSchema` in `lib/schemas/api.ts`, with no field that could hold the question, the brief or a finding's text other than the proposal's own (which is the suggestion's, public to its asker).
- **Announcement**: the dock's log is already a polite live region (`.dock-log[role="log"][aria-live="polite"]`), so the line carries no live role of its own — a nested status region would announce every change twice — and is `aria-atomic`, so the whole line is read when its text changes; its text changes at most once per state, never on every poll, so a screen reader hears `research · searching the web` once and `research · 1 proposal for the book` once (§ 13.8; D15).

## 5. The proposal (60b)

### 5.1 The panel

When a run has a proposal, a panel under the research line, an instrument of the kind every rail uses (`.inst › .inst-h · .inst-b · .inst-f`, ui-context § 8), labelled so it cannot be read as the answer:

- **Header** (`.inst-h`): `proposal for the book` · the suggestion id · `not part of the answer`, the last as a `.cap` that wraps whole.
- **The change** (`.inst-b`): the anchor as a link to its section (the `CitationChip` form), the class as the suggest form names it, and the book's text before and after in the form the fixed proposal takes on the edit page — `ProposalFixed`'s before/after table — reused as it is: `EDIT_TEXT` as before and after, `ADD_CLAIM` as the sentence and where it goes, `SET_VALUE` as the value before and after with its unit, a row as its fields, `RESTRUCTURE` as its description. No word diff: that is the merge's own view of a branch (`QueueMerge`).
- **What it rests on**: each source's host, tier badge (`.ev .ev-*`) and adjusted score, in the evidence list's own row form, and the line `Improve · score 85 · accept at 70`, or `curator always · no score decides · safety statement` with the reason the class gives, in the words the outcome page uses for them.
- **The researcher's note**, under the cap `researcher's note`, in prose, with the sentence `written by the researcher from the pages it read; the adjudicator did not read it` (spec 42 D1).
- **Where it is**: `with a curator · parts ii, iii · decision by 12 Oct` (`CURATOR_QUEUE`; the parts as the outcome line lists them, the group's deadline by `formatDayMonth`), `being merged` (`MERGING`), `accepted · in v1.3.3` (`MERGED`, the release's chapter version), `declined by a curator` (`CLOSED` by a curator's decline), `not merged · the chapter's check failed` (`CLOSED` by a failed check after a curator's accept, spec 37 § 4.5: the merge's return path for a researcher's suggestion closes it rather than asking for more).
- **Footer** (`.inst-f`): the actions. `Add my name`, which opens the consent and a confirm control inline (not a dialog: the panel is already a disclosure under the answer): the suggest form's consent sentence (`improve.suggest.submit.consent`, "Keep my name with this change, for its provenance.") as a `.check` with its box, under it one more sentence this panel owns — `Curators and the chapter's history will see your name beside this proposal; your question stays yours` (D11) — and the button `Add my name`, a `.btn` (the view's one warm primary stays the composer's Ask), disabled with the `.help` `tick the box to add your name` until the box is ticked; once endorsed, `Remove my name` until the merge, and after it the panel's "where it is" says `accepted · in v1.3.3 · with your name`; `View record`, a link to the record page.
- **Keyboard and focus**: the disclosure opens with focus on its box; `Esc` inside it closes the disclosure alone and returns focus to `Add my name` (the dock's own `Esc`, which closes the dock outside the page variant, does not fire from inside it); when the request succeeds, focus moves to the button that replaced the one pressed (`Remove my name`, or `Add my name` again), which is in the same place; the panel's header is a heading of the turn's level so the dock's outline reads `proposal for the book`.
- **Failure states**: a 503 (the engine did not take the `endorsed` signal; the endpoint fails closed and writes nothing) and a 5xx read `could not add your name · try again later` on the status bar; a 409 after the merge turns the control into the `with your name`/no-name reading; a 429 shows the status bar's rate line; a 422 `CONSENT_REQUIRED` cannot happen from this panel, which sends only with the box ticked. The panel never shows a failure inside the answer block.
- **On a phone** (the assistant page under 768px, § 4.1): the instrument spans the column; the sources are rows, one per line (host, badge, score); the before/after table stacks its two cells; the footer wraps its box, its sentence and its two actions whole (ui-context § 11, no truncation), with 44px targets under `pointer: coarse`.

`Add my name` is a button that names its result, as the voice rules ask. It is offered to any signed-in asker (A5), with no identity verification, and to nobody else, because nobody else is shown the proposal. The consent written is the same `provenanceConsentAt` the suggest form writes (spec 42 § 6). The request is `POST /api/v1/proposals/{suggestionId}/endorse` with `{ consent: true }`; withdrawing is `DELETE` of the same, offered until the merge (spec 42 D4). Both answer `EndorsementSchema`, `{ suggestionId, endorsed: { byMe: true, at } | null }` (built in unit 59d, spec 42 § 11.7), which is the panel's `endorsed` field.

**Reading the record.** The asker is not the suggestion's owner (it has none), so spec 29's read rule would refuse them. The policy already models the asker: the `endorse` rule is on the kind `proposal` with the asker as its `owner` (`policies/hb/improve.rego`), and the read is the same model — `read` on `proposal` by its owner (D7) — where `ownerId` is set by the endpoint from the asker's own `ResearchFinding` with that `suggestionId`, the direction in which that link may be followed, and by nothing else. The record page and the outcome page gain the audience `asker` beside `own`, `curator` and `public`: the asker sees everything a curator will weigh — the change, the evidence, the criteria, the decision — with people as pseudonyms, as the public reads them, their own name where they endorsed, and no export (D12). Nothing on either page says who else asked anything.

### 5.2 What the panel never shows

The question, the brief, the reader's own name beside anything, refuted findings, the run's spend. A proposal a curator declined stays visible to its asker with `declined by a curator` and the record link; a refuted finding (spec 42 § 5) is never a panel: the line reads `nothing to propose` (D2).

### 5.3 `ProposalView`

One shape for the panel, the landing page's list (§ 6) and the research endpoint, `ProposalViewSchema` in `lib/schemas/api.ts`: `{ suggestionId, anchor: { kind, id, section, title }, changeKind, changeClass, curatorReason, proposal, sources: [{ host, tier, adjusted }], score, acceptAt, floorAt, note, where: { state, part, decisionBy, releaseVersion, declinedBy }, endorsed: { byMe, at } | null, recordHref }`. It is built by one presenter, `lib/improve/proposalView.ts`, from the door's read for the asker (`readProposalsForAsker(caller)` in `lib/db/improve.ts`, which takes the asker's finding ids and never joins back to a run or a message) and the endorsement row.

## 6. The reader's proposals (60c)

On `/[lang]/improve` (spec 35 § 3), for any signed-in reader who has one, a section **Proposals from your questions** between the page's heading and whatever the role shows next: a `.tbl` newest first with the id (a link to the record), the anchor, the state in words (the `where` line of § 5.1), and `with your name` where endorsed. No question is shown beside a proposal, here or anywhere: the page lists what was proposed, not what was asked. A reader with none sees no section and no empty state; a reader whose conversation was purged, or deleted, still sees the proposal, because the finding's link to the suggestion survives both (spec 40 § 8.3; feature-specs/45 § 3.6) and holds no text; since unit 62i the list offers `Remove my name` beside "with your name", the panel under the answer having gone with a deleted conversation.

The data is `getImproveHome`'s for any signed-in role, through `readProposalsForAsker`; the row is `ProposalView` reduced to the list's cells. The table joins the truncation suite as a state of the `improve-home` screen.

## 7. The curator's side (60d)

### 7.1 In the queue

- The group **Researcher proposals** (spec 36 § 3.1): `QUEUE_GROUPS` gains `researcher`, `GROUP_DEADLINE_HOURS` 168 (7 days, A15), `groupOf` takes the suggestion's origin and files an origin-`RESEARCHER` item whose decision is the adjudicator's recommendation there; a curator-always finding sits in its reason's own group with the mark `research` on its class line. `QueueItemSchema` and the queue's row carry `origin`.
- **The detail** differs from a person's suggestion in what it must: `origin · research` in place of the contributor's line; `endorsed by <name>` (from the `ENDORSED` records, a withdrawal counted) or `not endorsed`; the researcher's note under its cap, with the sentence that the adjudicator did not read it; the adjudication headed `recommended` instead of `accepted` (a new variant of `variantOf`, used by the outcome and record pages too); and the decision control with two segments, `Accept` (its own word for a researcher's — today's accept segment reads `Accept on inspection`, which a recommendation is not) and `Decline` — `QueueDecision` takes the origin and drops `Keep · request more`, and the decision endpoint refuses `KEEP_REQUEST_MORE` for a researcher's suggestion with 422 `NOT_FOR_RESEARCH`, since nobody would revise it (spec 42 § 3); the decision path's branch that would have closed a kept researcher's suggestion as a request for more (`lib/improve/decision.ts`) goes with it, being unreachable (D16).
- Nothing in the detail says who asked or what they asked. An endorser's name is there because they put it there. The detail's markup is held to the canary (§ 13.6).

### 7.2 The research log

`/[lang]/improve/research`, role `CURATOR`, linked from the queue page's header beside the calibration rail and from the landing page's curator block: what Andre asked to be logged, readable. It is built from the ledger and the platform's suggestion rows only, so it cannot show an asker.

- **By month** (`.tbl`), the last twelve months: runs (a run here is a `RESEARCH` record, which exists for every run that reached the planner — a turn skipped before any workflow is not in the log, and the account of those is the dashboard's, spec 44), runs that planned nothing, runs whose planner failed, findings by outcome (invalid, duplicate, refuted, proposed), searches and page reads, from the `RESEARCH` records read with the ledger's existing `select` by kind and window (`kinds: ["RESEARCH"]`, unit 55b); what is new is the grouping by month in `lib/improve/researchLog.ts`, pure.
- **Refuted and declined findings**, newest first, the same twelve months: date, id, anchor, class, the strongest tier, the score against the floor and the accept, and what refuted it (`floor`, a sensor by name, `adjudicator · request more`, `adjudicator · decline`, `curator`, `check` for a merge the chapter's check returned), each linking to its record. These are suggestions of origin `RESEARCHER` in `CLOSED` — an intake decline passes through `INTAKE_DECLINED` to `CLOSED` for a researcher's, so `CLOSED` is where every refuted one rests — read across all parts by a curator (D6): a curator's read of a closed researcher suggestion, in the list and on its record and outcome pages, is not bounded by their parts, because the list is the log and the log is one.
- **Empty and small**: a month with nothing is a row of zeros; a log with nothing reads `no research yet` in an `.empty`; under 768px each table scrolls in its own focusable region, as the roster does (`.roster-scroll`).

A curator reading this list is how a refuted finding that should not have been refuted gets noticed. There is no action on it: a curator who disagrees writes a suggestion.

Amended by feature-specs/48 § 10.3 (unit 74, 2026-10-12): a person's run's `RESEARCH` record holds only `INVALID` and `VALID` findings, since what a person later does with one is the draft's or the researcher proposal's own record, so the month table counts three more — `refused` (the records that planned `refused`), `valid` (the findings `VALID` in the records) and `sent` (the month's `SUBMITTED` records of `service:researcher`, read by the same `select` by kind). `duplicate`, `refuted` and `proposed` keep reading the records, which only the legacy runs fill. Nothing in the log names who asked or who sent.

## 8. The record and the outcome of a researcher's proposal (60e)

The record page (`/[lang]/improve/[id]/record`, spec 35 § 6) and the outcome page (`/[lang]/improve/[id]`) have no researcher branch today: the record's header would print the `submitted` record's actor as the contributor, and the outcome page would badge a recommendation `Accepted`. This unit gives both their words: the header's contributor cell reads `origin · research` (the `noContributor` string, worded today for a revert, gains its researcher form); the `submitted` record's actor `service:researcher` is shown as such; the `recommended` variant (§ 7.1) on the decision; the rail's Credit instrument reads `credit · none · research` until an endorsement, then `credit · <name>` as for a person, with `verified` beside a verified identity and nothing beside an unverified one; `endorsed by <name>` from the `ENDORSED` records, a withdrawal counted, or nothing; and the audience `asker` (D7, D12) for the reader from whose run it came — both pages open to them, people as pseudonyms, their own name where they endorsed, no export. Chapter-History: spec 37 § 7 and spec 42 § 7 define the `research` mark and the contributor cell; this spec adds only the detail of A5's consequence: in the credit list and the ledger rows, a name whose identity was verified carries `verified`; an endorser who was not verified carries nothing. The list stays alphabetical.

## 9. The account page

Built in unit 57 (spec 40 § 13), named here for the whole: the Preferences instrument's `research of my questions` segmented control with its note (`account.prefs.research`, `researchOn`, `researchOff`, `researchNote`), and the Retention instrument's line (`account.retention.research`, `researchValue`). The research line's `switch on` link lands on `#pref-research`. Nothing is added here; the first version of this spec proposed other keys for the same strings, which the build superseded.

**Amended by feature-specs/48 (unit 75, 2026-10-12):** the Preferences control, its action and its four keys are removed with `assistant.research.switchOn` (48 § 9.4, § 19 "Removed"); the Retention line reads `research conversations` · `text 30 days, or until you delete them`.

## 10. Strings

Namespaces `assistant.research.*`, `improve.proposal.*`, `improve.home.proposals.*`, `improve.researchLog.*`, and the queue's additions under `improve.queue.*`. All are candidates, EN and PT, written in the units' reports and marked in the catalogue (rules § 4.6). Every key lands in both catalogues (tests/messages.test.ts). The ones a reader meets first, as proposed:

| Key | EN | PT |
|---|---|---|
| `assistant.research.queued` | research · queued | pesquisa · na fila |
| `assistant.research.reading` | research · searching the web | pesquisa · buscando na web |
| `assistant.research.checking` | research · checking with Improve | pesquisa · verificando com o Melhorar |
| `assistant.research.proposals` | research · {n, plural, one {# proposal} other {# proposals}} for the book | pesquisa · {n, plural, one {# proposta} other {# propostas}} para o livro |
| `assistant.research.nothing` | research · nothing to propose | pesquisa · nada a propor |
| `assistant.research.waiting` | research · waiting for budget · resets {date} | pesquisa · aguardando orçamento · reinicia em {date} |
| `assistant.research.budget` | research · skipped · the month's budget is spent · resets {date} | pesquisa · pulada · o orçamento do mês acabou · reinicia em {date} |
| `assistant.research.deduped` | research · skipped · these sections were researched {days, plural, =0 {today} one {# day ago} other {# days ago}} | pesquisa · pulada · estas seções foram pesquisadas {days, plural, =0 {hoje} one {há # dia} other {há # dias}} |
| `assistant.research.sameQuestion` | research · skipped · this question was researched {days, plural, =0 {today} one {# day ago} other {# days ago}} | pesquisa · pulada · esta pergunta foi pesquisada {days, plural, =0 {hoje} one {há # dia} other {há # dias}} |
| `assistant.research.dailyLimit` | research · skipped · {n} runs today | pesquisa · pulada · {n} pesquisas hoje |
| `assistant.research.noCitation` | research · not run · nothing cited | pesquisa · não feita · nada citado |
| `assistant.research.off` | research · off | pesquisa · desligada |
| `assistant.research.switchOn` | switch on | ligar |
| `assistant.research.offOrganisation` | research · off for your organisation | pesquisa · desligada para a sua organização |
| `assistant.research.notRun` | research · not run | pesquisa · não feita |
| `improve.proposal.header` | proposal for the book | proposta para o livro |
| `improve.proposal.notAnswer` | not part of the answer | não faz parte da resposta |
| `improve.proposal.note` | researcher's note | nota do pesquisador |
| `improve.proposal.noteUnread` | written by the researcher from the pages it read; the adjudicator did not read it | escrita pelo pesquisador a partir das páginas que leu; o adjudicador não a leu |
| `improve.proposal.where.queue` | with a curator · part {part} · decision by {date} | com um curador · parte {part} · decisão até {date} |
| `improve.proposal.where.merging` | being merged | sendo incorporada |
| `improve.proposal.where.merged` | accepted · in {version} | aceita · em {version} |
| `improve.proposal.where.declined` | declined by a curator | recusada por um curador |
| `improve.proposal.where.notMerged` | not merged · the chapter's check failed | não incorporada · a verificação do capítulo falhou |
| `improve.proposal.score` | Improve · score {score} · accept at {acceptAt} | Melhorar · pontuação {score} · aceita a partir de {acceptAt} |
| `improve.proposal.curatorAlways` | curator always · no score decides · {reason} | sempre um curador · nenhuma pontuação decide · {reason} |
| `improve.proposal.consentMore` | Curators and the chapter's history will see your name beside this proposal; your question stays yours. | Curadores e o histórico do capítulo verão seu nome ao lado desta proposta; sua pergunta continua sendo sua. |
| `improve.proposal.consentHelp` | tick the box to add your name | marque a caixa para adicionar seu nome |
| `improve.proposal.failed` | could not add your name · try again later | não foi possível adicionar seu nome · tente de novo mais tarde |
| `assistant.research.failed` | research · failed | pesquisa · falhou |
| `assistant.research.unavailable` | research · could not be read · trying again | pesquisa · não foi possível ler · tentando de novo |
| `improve.proposal.withName` | with your name | com o seu nome |
| `improve.proposal.endorse` | Add my name | Adicionar meu nome |
| `improve.proposal.unendorse` | Remove my name | Remover meu nome |
| `improve.proposal.record` | View record | Ver registro |
| `improve.home.proposals.title` | Proposals from your questions | Propostas a partir das suas perguntas |
| `improve.queue.group.researcher` | Researcher proposals | Propostas do pesquisador |
| `improve.queue.origin.research` | origin · research | origem · pesquisa |
| `improve.queue.endorsedBy` | endorsed by {name} | endossada por {name} |
| `improve.queue.notEndorsed` | not endorsed | sem endosso |
| `improve.queue.decision.action.ACCEPT_RESEARCH` | Accept | Aceitar |
| `improve.outcome.decision.badge.recommended` | Recommended | Recomendada |
| `improve.record.noContributor.research` | origin · research · no contributor | origem · pesquisa · sem colaborador |
| `improve.record.rail.credit.research` | credit · none · research | crédito · nenhum · pesquisa |
| `improve.record.endorsedBy` | endorsed by {name} | endossada por {name} |
| `improve.researchLog.title` | Research log | Registro de pesquisa |
| `improve.researchLog.month.*` | runs · planned nothing · planner failed · invalid · duplicate · refuted · proposed · searches · page reads | pesquisas · nada a pesquisar · planejador falhou · inválidas · duplicadas · refutadas · propostas · buscas · páginas lidas |
| `improve.researchLog.refutedBy.*` | floor · {sensor} · adjudicator · request more · adjudicator · decline · curator · check | piso · {sensor} · adjudicador · mais evidências · adjudicador · recusa · curador · verificação |
| `improve.researchLog.empty` | no research yet | nenhuma pesquisa ainda |

"Improve" in PT is the top bar's own word (`chrome.nav.improve`, "Melhorar"). The pages and the dock's new states join the truncation suite.

## 11. Out of scope

- Research on request, a button or a command (A2; D5 holds the question). Since 2026-10-12 in scope: feature-specs/48, Andre's A2 and A6, built in units 68 to 75.
- Research figures in the assistant page's statistics panel; the operator's series are spec 44's.
- Any indication in the reader (the chapter page) that a section has open proposals.
- The asker seeing refuted findings, or the planner's brief.
- A notification when a curator decides; the proposal's line changes when the reader next looks.
- A screen for the organisation's switch (spec 40 D5).

## 12. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | How often the line asks for the run's state, and where it stops | every 5 s until `DONE`, `SKIPPED`, `FAILED` or `WAITING_BUDGET` | a run takes tens of seconds to minutes; the suggest form's 2 s is for a grading that takes seconds; a wait for the budget lasts until the month's reset, which no poll should follow. A number: Andre's to confirm |
| D2 | One wording for "nothing found" and "found and refuted" | yes | his rule: what Improve refutes is not shown; two wordings would show it. Amended for a person's research by feature-specs/48 D3 (unit 74, 2026-10-12): a finding the person sent and Improve refuted reads `sent · not proposed`, with no record link; a legacy run's refuted finding is still never shown |
| D3 | The asker reads the record of their proposal | yes | they are asked to sign it; they should be able to see everything a curator will weigh |
| D4 | The research log shows no asker even to curators | yes | A4 |
| D5 | A reader may start a run by hand (`Research this answer`) on a turn that was skipped or not run | **not now** | A2 chose every answered turn and never on request; the two caps (30 a day, US$ 20 a month) are sized for that; a button would spend the budget on the questions readers find interesting rather than on the ones the dedupe rules choose. If Andre wants it, it is one action on the research line for `DEDUPED`, `SAME_QUESTION` and `NO_CITATION` only, counted against the same limits, and a spec 40 amendment |
| D6 | The research log's list of refuted findings reads across all parts | yes | the log is one; a curator reads it as a curator, not as a part's |
| D7 | The asker's read of the record is a resource field (`askerId`) rather than a new resource kind | yes | the suggestion stays the resource; one field says whose research it came from, set by the door through the asker's own finding and by nothing else |
| D8 | `SKIPPED · BUDGET` and `WAITING_BUDGET` read differently | yes | one never runs this turn, the other resumes; one wording would promise what the first does not do |
| D9 | How the stub's fixture pages reach the product's fetcher in development | a development-only fixture fetcher, switched on by a workers' variable the production image refuses to start with | spec 42 D2 has the product open every source itself, and `standards.example` does not exist; without this the development path refutes every finding and no surface below can be seen on this machine. Tooling, built with unit 59b; Andre's to confirm |
| D10 | `FAILED` has its own line | `research · failed`, the code never shown | the reader may have watched the run search for a minute; `not run` would be untrue (spec 40 § 9 named `failed`) |
| D11 | The consent for `Add my name` says what it means | the suggest form's sentence plus one of this panel's | endorsing puts the asker's name where curators and the chapter's history read it, which A4 otherwise keeps from them; consent to that should name it |
| D12 | The asker reaches the outcome page as well as the record, with people as pseudonyms and no export | yes | the two pages share one read rule, and the asker is neither the owner nor a curator |
| D13 | The organisation's `off` line is demonstrated when a reader belongs to an organisation | wait | development accounts have none, and no command attaches one; the line is tested in the unit's suite with a fixture organisation |
| D14 | Which turns poll | the newest unfinished turn of the conversation, which reads the older ones with it | sixty reads a minute per reader (`READ_RATE`) is twelve turns at 5 s; one poll keeps every line honest |
| D15 | Which live region announces the line | the dock's log, the line `aria-atomic` and with no role of its own | two nested live regions would announce every change twice |
| D16 | `KEEP_REQUEST_MORE` on a researcher's suggestion | refused with 422, and the decision path's unreachable branch removed | nobody would revise it (spec 42 § 3); a hand-sent keep is a mistake, not a decline |
| D17 | Where the `research` browser flow lives | its own suite, `tests/research/` and `npm run test:research`, run by hand against a development server whose gateway is the stub, with the engine, the workers and `RESEARCH_PRINCIPAL`; not in `tests/e2e/` nor in the Phase 1 gate's parts | it asks a question, needs the whole stack, and leaves rows behind (a researcher's suggestion, a curator's decision, the suite reader's consent) that the e2e suite's rule forbids; it clears its own section's marks before asking so it can run twice |

## 13. Verification (in addition to `ai-workflow-rules.md` § 7)

On the stub, with research configured as § 3.3 and the stub's default fixtures.

1. An answered turn shows the line moving from `queued` to a final state without a reload; a refusal shows none; with the reader's switch off the line reads `off` with its link; with the organisation's switch off, `off for your organisation`; with research unconfigured, `not run`.
2. While and after the run, the turn's answer block is byte-identical in the DOM to the same turn with research unconfigured; "Copy with citations" yields the same text.
3. A run with a proposal shows the panel with `not part of the answer`; `Add my name` asks for consent inline, records the endorsement, and turns into `Remove my name`; a reload shows the same state; after a merge the control is gone and the line reads `with your name`.
4. The record link opens for the asker and is not-found for another reader and for an asker of another run.
5. A run whose finding Improve refutes reads `nothing to propose`, shows no panel, and the landing page lists nothing for it.
6. The queue shows the proposal in its group with `origin · research` and no asker; the detail's markup — and the record page's — contains neither the asker's id, name nor e-mail address nor any five consecutive words of the question (the canary of spec 41 § 11.3, carried to the page); the decision control has two segments, and `KEEP_REQUEST_MORE` sent by hand is refused.
7. The research log lists the refuted finding with what refuted it, and its month totals equal a count of the `RESEARCH` records, planned-failed runs included.
8. Zero axe violations on the dock with a proposal open, the landing page, the queue's detail and the log, in EN and PT at 1440; the status line is announced politely once per change, not on every poll (a test counts the live region's text changes against the states the run passed through).
9. (Never built as a browser flow: the stub refuted every finding without a fixture fetcher. Since unit 75, `tests/research/` is the road of research on request, a suite of the database and the engine's test server — feature-specs/48 § 35.) A Playwright flow `research` in a suite of its own (D17): ask, wait for the proposal, add a name, and as the curator accept it. It asks a question, so it runs only against a server whose gateway is the stub and refuses to start otherwise: the rule that no browser suite reaches a real model stands (code-standards § Testing); it clears the marks of its own section first, so a second run is not deduplicated.
10. The second question about the same section within the day reads `skipped · these sections were researched today`; a gap question runs again; the thirty-first run of a day reads `skipped · 30 runs today` — the last in the integration suite, which seeds the day's thirty rows, not by hand.
11. The truncation suite renders the dock with the line in each of its states and with the panel open, the landing page with proposals, the queue's detail of a researcher's proposal and the log, in PT at 1440 and 390 (the dock's states on the page variant only), and finds nothing elided. The rows these screens need come from the development seed: `npm run improve:seed` (unit 50g) gains a research seed — one conversation of the demo reader with answered turns whose runs stand in each state the line can show, one proposal in the queue's researcher group with a `PROPOSED` finding for that reader, and one refuted finding for the log — written on the seed's harness with no model asked. The suite's who-loop, which today runs the screens for the signed-out, the demo and the contributor accounts and silently skips a `curator: true` screen, runs the curator's too (a defect found while writing this spec; the queue's detail and the log would otherwise pass unrendered).

## 14. Units

| Unit | What | Needs |
|---|---|---|
| 60a | the research line (§ 4): `ResearchLine`, `AnswerView.research`, `MessageViewSchema.research`, the endpoint without `proposals`, the strings, the poll; `npm run research:org -- --create` (§ 3.3) | 57 |
| 60b | the proposal panel (§ 5): `ProposalView`, `readProposalsForAsker`, the asker's read rule (D7), `Add my name` / `Remove my name` on spec 42's endpoints; the research seed (§ 13.11) | 59b, 59d, 60a |
| 60c | the reader's proposals on the landing page (§ 6) | 60b |
| 60d | the queue's researcher group, the detail's words and two segments, the research log (§ 7) | 59c, 53b |
| 60e | the record and outcome pages of a researcher's proposal, the audience `asker` (§ 8) | 59c, 60b |

The development path of § 3.3 is configuration, not a unit; it is Andre's (tracker, Waiting on Andre, item 3) and the demo for every unit above, once D9's fixture fetcher exists (unit 59b).

## 15. As built (unit 60a: the research line under an answer, 2026-10-10)

- **The line**: `components/assistant/ResearchLine.tsx`, the last child of `.turn-assistant` in `TurnBlock` after `SensorVerdicts`, and in the same place in `WalkTurn` once the walk is not running; rendered for an answer whose `research` is present and whose `refusal` is null, never on a refusal or a turn without the field. The footer's style (`.inst-f`) as `.research-line` (`app/globals.css`): `research ·`, the state's word as `StatusMark` with `.st-plain` — the lower-case mark — in its hue (`run` with the caret, `ok`, `warn`, `mute`), then the detail after another `·` where the state has one, and `switch on` to `/[lang]/account#pref-research` for `off`. `aria-atomic`, no live role of its own (D15); `data-research` names the key for the suites.
- **The words**: `lib/research/view.ts` `researchLineOf` maps every state and skip of spec 40 § 3 to a key of § 4.2 — `queued`, `reading`, `checking`, `proposals`, `nothing`, `waiting`, `budget`, `deduped`, `sameQuestion`, `dailyLimit`, `noCitation`, `off`, `offOrganisation`, `notRun`, `failed`, and `none` for a refusal's run — with its hue, whether it is followed, and the numbers its words take; the catalogue holds `assistant.research.label`, `word.<key>`, `detail.<key>` and `switchOn`, EN and PT, the ICU plurals with `=0 {today}`; the reset by `formatDayMonth`.
- **Where the state comes from**: `ResearchStartedSchema` (the `final` event) gains `days` and `resetsAt`, computed by the hand-over from the marks it already read, so a skipped turn's line is whole from the event; `answerOfFinal` copies it onto `AnswerView.research` (`researchViewOfStarted`, no proposal yet); `MessageViewSchema.research` is the whole `ResearchView` (`lib/schemas/api.ts`: state, skip, days, resetsAt, proposals — the last as `{ suggestionId }` until 60b widens it), read by `getConversation` through `readResearchViews` (the runs inside the asker's context, the marks in one query), so a reload shows the same line. `GET /api/v1/assistant/messages/{id}/research` (`messageResearch`; the owner's `read` on `message`, `READ_RATE`; 404 for a message with no run or not the caller's) answers `readResearchView`. The dock follows runs with `useResearchFollow` (`lib/hooks/useResearchFollow.ts`): every 5 s for the newest three turns still under way (D14, as a bound of three rather than one, since a reader rarely has two), stopping at an end, after ten minutes, on a 401/403/404, waiting a 429's `Retry-After`, retrying a 5xx at the next tick, not reading a hidden document.
- **The research organisation**: `npm run research:org -- --create [--tokens-per-minute <n>]` (`ensureResearchOrganisation`) writes `Research` once, with `tokensOfUsd(20)` as its cap, no seats, no IDE minutes, 100,000 tokens a minute unless said, one audit row (`research_org_created`), and prints the two steps that follow (§ 3.3).
- Verified: `lib/research/view.test.ts` (7: every state and skip has a line, the days from the newest section's mark and the question's, the reset from the budget mark, the seed), `workers/research/afterTurn.test.ts` (the days and the reset on the event), `tests/integration/research-rows.test.ts` (the view of a message, another reader's none, the conversation's read carrying it), `lib/assistant` and the API's contract suites, the full suite, lint, build, `npm run api:openapi`. Live on the development server, whose gateway is the real one, so no question was asked: a conversation of the development reader whose answered turn has a run row (`SKIPPED · UNAVAILABLE`, research being unconfigured here) shows `research · not run` / `pesquisa · não feita` under its verdicts box, outside the answer block, on the assistant page at 1440 and 390 and in the dock on a section page; axe clean, no horizontal overflow.

Not exercised live: a run under way (no research principal on this machine): the follow's poll ran against its unit and the endpoint's contract alone; the truncation suite's rows for the line's states wait for the research seed (60b, § 13.11).

## 16. As built (unit 60b: the proposal under the answer, 2026-10-10)

Built in three parts: the data (part 1), the panel and `Add my name` (part 2), the research seed (part 3).

### 16.1 Part 1: the proposal's view

- **`ProposalViewSchema`** (`lib/schemas/api.ts`) is § 5.3's shape with three differences: the change is carried as `change: { before, after }`, the two cells the edit page's fixed table shows, computed by `changeOf` on the server, rather than the raw `proposal`; `contentLang` says the edition the anchored text and the change are in; `where` is `{ state, parts, decisionBy, version, closedBy }` (`closedBy` `curator` or `check`, read from the outcome a curator's decline or the check's return leaves). `floorAt` is not carried: the panel's line names the accept line alone. `recordHref` comes with the record's audience `asker` (60e): until then the asker's link would be a not-found page.
- **The door's read** (`readProposalsForAsker(caller, ids)`, `lib/db/improve.ts`) answers the suggestions by the ids the asker's own findings gave, of origin `RESEARCHER` only, as a service reads them (no owner) with what hangs from them, one statement at a time as the door's other reads; the endorse endpoints take `ProposalPlace`, its id, state, outcome and workflow.
- **The presenter** (`lib/improve/proposalView.ts` `proposalViewOf`, pure): the anchor's own id (the figure's or the row's where it is one), its section and the section's title; the queue's deadline from the decision that queued it (`groupOf`, `deadlineOf`: the inspection group's seven days today, the researcher group's in 60d); the merged version; the asker's name from their own row.
- **The research view** (`lib/db/research.ts`) carries each `PROPOSED` finding's whole view: `readResearchView` and `readResearchViews` read the suggestions through the door once per request, the asker's endorsement rows in their context, and the section titles in the suggestion's edition (`sectionTitleOf`). The proposals are listed whatever the run's state, so a proposal that reached the queue shows while another of the run's still decides.
- Verified: `lib/improve/proposalView.test.ts` (4), `lib/research/view.test.ts`, and `tests/integration/research-run.test.ts`, whose DONE case reads the view of the proposal the run made: the anchor and its title, the source as graded, the score at the accept line, with a curator and by when, no name after it was taken back.

### 16.2 Part 2: the panel

- **`ProposalPanel`** (`components/assistant/ProposalPanel.tsx`) renders under the research line for each proposal the view carries, in `TurnBlock` and `WalkTurn`, keyed by its id, its endorsement and its state so a view read again remounts it. An instrument (`.inst.proposal-panel`): the header an `h3` reading `proposal for the book · <id> · not part of the answer`; the body the anchor as a `Cite` to its section (`<id> · <title>`) with the class as the Rubric page names it (`rubric.thresholds.class.*`), the change in `ChangeTable` (split out of the edit page's `ProposalFixed`, which now uses it), `what it rests on` with each source's host, `EvidenceBadge` and adjusted score, the line `Improve · score 85 · accept at 85` or `curator always · no score decides · <reason>`, the researcher's note with its sentence, and where it is; the footer the actions.
- **`Add my name`** opens the consent inline: the suggest form's sentence (`improve.suggest.submit.consent`) as a `.check`, D11's sentence under it, the confirm `Add my name` disabled with its `.help` until the box is ticked; the consent's prose in the body's face, not the footer's mono. Once named, `Remove my name`. A 409 removes the control (the proposal is past taking names); a 429 and any other failure are said in the footer (`role="status"`), never in the answer block. Focus: the box on opening; `Esc` inside the consent closes it alone (its `keydown` stops there, so the dock's `Esc` never sees it) and returns focus to `Add my name`; after a press that lands, the button that replaced the one pressed. The record's link waits for 60e.
- **Styles** (`app/globals.css`, `.proposal-*`): the panel a turn's instrument; the change table's cells stacked under 768px; 44px targets under `pointer: coarse`.
- **Strings** `improve.proposal.*`, EN and PT, as § 10 proposes, with three more: `sources` (`what it rests on`), `scoreOnly` (a score with no accept line) and `rate`.
- Verified live on the development server with the research seed (part 3), in Chromium: EN at 1440 and PT at 390 — the fifteen lines, the panel's whole text, no element wider than its box, focus on the box when the consent opens, the confirm disabled until ticked, `Esc` closing the consent and leaving the dock open with focus on `Add my name`, axe clean (WCAG 2.2 AA tags) with the consent open, and the seed's proposal answering 409, after which the control is gone.

### 16.3 Part 3: the research seed

- **`npm run research:seed`** (`scripts/research-seed.ts`; a script of its own rather than a part of `improve:seed`, which it does not slow): a conversation of `demo@harness-bible.local` with thirteen turns whose runs are rows in the state their line shows — queued, searching, checking, nothing to propose, failed, and the skips off, off for the organisation, nothing cited, the two dedupes, the day's limit, nothing to research, not run — then two real runs: one whose source the stub grades G, declined at the floor (`REFUTED`, for the research log of 60d), and the newest, whose source grades B, recommended into the curator queue (`PROPOSED`). No model is asked. No platform mark is written, since a section's, a question's or the budget's mark would stop real research on the machine: the two budget lines are not seeded, and a skip's days read `today`. Run again, it replaces its conversation and the suggestions its runs made; it writes where the conversation is to `pipeline/reports/research-seed.json`.
- **The runs are the seed's own** and end with it, as the improve seed's: the proposal has no running workflow, so `Add my name` answers 409. A proposal a reader can name is one a real run made (§ 3.3).
- **The harness** (`tests/fixtures/research/harness.ts`): the stub with its minted key, the gateway double, the fixture fetcher, the run's and the suggestion's activities, a turn handed over in a conversation, the children settled, a reader's research cleared; shared by the seed and the end-to-end suite, which now uses it. `tests/workflows/environmentOf.ts` builds the test environment around a server and a bundle without vitest, for a script.
- **The truncation suite** gains the screen `assistant-research`, the seed's conversation with the proposal's consent open, in PT at 1440 and 390; it is recorded as not rendered, naming the seed, where the seed has not been run. Run on 2026-10-10 with the padded catalogue: 707 labels at 1440 and 375 at 390, none truncated, every other screen as before.

## 17. As built (unit 60c: the reader's proposals, 2026-10-10)

- **The data**: `readProposalsOfAsker(user)` (`lib/db/research.ts`) answers the suggestions the reader's `PROPOSED` findings name, of every run, newest first, as the panel's `ProposalView` (one read through the door for them all); `getImproveHome` carries them as `proposals` for any signed-in role, so a reader who is not a contributor sees them too. A refuted finding is no proposal of theirs here or anywhere.
- **The section** (`ImproveHome`): `Proposals from your questions` right under the page's heading, before the queue and the reader's own suggestions: a `.tbl` with the id, the anchor (its id and its section's title in the suggestion's edition), where it stands — the same words as the panel, now one component, `ProposalWhere` (`components/improve/ProposalWhere.tsx`) — and `with your name` or a dash. No question beside it. A reader with none sees no section and no empty state. The id is text until the record has the asker's audience (60e), which makes it the record's link.
- **Styles**: `.improve-home-proposals td:first-child` keeps an id whole on a phone.
- **Strings** `improve.home.proposals.*` (title, the four columns, `with your name`), EN and PT.
- Verified: `tests/integration/research-run.test.ts` (the proposal in the asker's list, the refuted one not); live in Chromium as the demo reader with the research seed, EN at 1440 and PT at 390, axe clean and nothing overflowing; the truncation suite's new screen `improve-home-proposals` (the demo account's landing page): 45 labels at 1440 and 32 at 390, none truncated.
- **Found on the way**: the research seed and the end-to-end suite cited the same two sections with the same stub claim, so whichever ran second made a `DUPLICATE` of the other's proposal, and the suite's cleanup then removed the suggestion its `DUPLICATE` finding named — the seed's. The cleanup (`clearResearchOf`) now removes only the suggestions a reader's own findings made (`SUBMITTED`, `PROPOSED`, `REFUTED`), never one a `DUPLICATE` names, and the seed cites the third and fourth mechanism sections.

## 18. As built (unit 60d: the curator's side, 2026-10-11)

### 18.1 In the queue

- **The group** `researcher` ("Researcher proposals", 168 hours) sits before the inspections in `QUEUE_GROUPS`; `groupOf` takes the suggestion's origin and files a researcher's proposal there — the adjudicator's recommendation and its failure alike — and a curator-always one by its reason. `QueueRow` and `QueueItem` carry `origin`; the list's class line adds `research` to a researcher's.
- **The variant** `recommended` (`variantOf`, `lib/improve/outcomeView.ts`): a researcher's proposal the adjudicator accepted, in the queue. Its badge is `Recommended` in the curator's hue, its box neutral, its line the score, the accept, `recommended · with a curator`, the parts and the deadline, its sentence that a researcher's proposal is merged only on a curator's accept. The outcome and record pages use the same variant; what they show the asker is 60e's.
- **The detail** (`QueueDetail`, `getQueuePage`): `origin · research` and `endorsed by <name>` or `not endorsed` in place of the contributor's line, the endorser read from the records alone (`endorserOf`) and named by the name they put there; the researcher's note under its cap with the sentence that the adjudicator did not read it. Nothing of who asked.
- **The decision**: two segments, `Accept` (`ACCEPT_RESEARCH`) and `Decline`, as unit 59e left them.

### 18.2 The research log

- **`/[lang]/improve/research`** (`app/[lang]/improve/research/page.tsx`, `lib/db/researchLog.ts`, `components/improve/ResearchLog.tsx`), a curator's, the not-found page for anyone else; linked from the queue's calibration rail and the landing page's curator block.
- **By month** (`lib/improve/researchLog.ts`, pure): twelve months newest first from the `RESEARCH` records read with the ledger's `select` by kind and window — runs, planned nothing, planner failed, the findings by outcome (invalid, duplicate, refuted, proposed), searches, page reads; a month with nothing a row of zeros. A finding still `SUBMITTED` when its run's record was written (a wait that ran out) is counted in no column.
- **Refuted and declined**: the researcher's suggestions closed in the twelve months, across every part (`closedResearchProposals`, a curator's alone; D6), newest first: when, the id linking to its record, the anchor, the class, the strongest tier, the score against the floor and the accept, and what closed it — `floor`, a sensor by name, `rule · request more` (a reading § 7.2 did not list, for the rules' request for more on a researcher's), `adjudicator · request more`, `adjudicator · decline`, `curator`, `check`. The record a link opens is still bounded by the curator's parts until 60e reads a closed researcher proposal across them.
- **Empty and small**: `no research yet` where there is nothing at all; each table in a focusable `.roster-scroll` region on a phone.

### 18.3 Verification

- `lib/improve/researchLog.test.ts` (3), `lib/improve/queue.test.ts`, `lib/improve/outcomeView.test.ts`, `lib/api/endpoints/curation.test.ts` (the researcher group, its deadline and origin).
- Live in Chromium as a curator, on the research seed's proposal and refuted finding: the queue's group and class line, the detail's badge, origin line, note and two segments, axe clean; the log in EN at 1440 and PT at 390, axe clean, a reader answered not found.
- **The truncation suite now runs the curator's screens** (§ 13.11), which it had skipped without a word, with the new `research-log` screen: 202 labels at both widths, none truncated. Running them found two defects of the queue's page at 390, both fixed: its evidence table, seven columns, now scrolls in its own region; and a status bar cell now wraps on a phone rather than widen the page (`.statusbar > *` under 768px). The last run measured every screen it rendered clean; the contributor's draft screens were not rendered on it, the layout contributor's twenty drafts of the day having been spent by the day's earlier runs, all of which had passed them.

## 19. As built (unit 60e: the record and the outcome of a researcher's proposal, 2026-10-11)

- **The asker's read** (D7, D12): `readAskerProposal` (`lib/api/endpoints/suggestions.ts`) reads the suggestion a `PROPOSED` finding of the reader's own names, through the door's read for the asker, with no owner; `readAskerProposalView` as the page draws it, nobody's own, the merge's operator words left out. The record's loader gives it the audience `asker` — people by the ledger's pseudonym but for the reader's own name where they put it, no export, the link to the outcome page — and the outcome's loader draws its page, the parts its decision waits on read from the same row. Another reader finds neither page (404) and neither does the JSON record.
- **A curator's read of a closed researcher proposal** across parts (D6): `readClosedResearchProposal` (the door, a curator's alone) and `readClosedResearchView`; the record's and the outcome's loaders take it after the curator's own read, as the audience `curator`. The JSON record's endpoint says `closed: true` to the policy, whose new rule lets any curator read a researcher's suggestion that is (`policies/hb/improve.rego`, tested: 74 of 74).
- **The JSON record** (`GET /api/v1/suggestions/{id}/record`) reads the same four ways in order — the person's own read, the closed proposal, the asker's, the merged — and the asker's resource is the proposal with them as its owner, which `read` on `proposal` allows (unit 59d). The export stays the owner's and the curator's.
- **The record's header** reads `origin · research · no contributor` and, where a name stands on it, `endorsed by <name>` with `identity verified` beside a verified one and nothing beside the others; the `submitted` record's actor is the researcher, shown as a service. The rail's credit for a researcher's proposal is its endorser's, merged or pending, or the sentence that nobody is named until the reader who asked puts their name to it.
- **The decision** reads `Recommended` on both pages (60d's variant).
- **Chapter-History**: a person carries `verified`; the credit list and a row's contributor cell say `verified` beside a verified name and nothing beside the others, so an endorser who never verified an identity reads as a name alone.
- **The record's link**: the panel's footer gains `View record`; the landing page's id becomes the record's link.
- Verified: `lib/api/endpoints/record.test.ts` (the asker's resource, the closed proposal's `closed`, a stranger's 404), `policies/tests/improve_test.rego`, `lib/improve/history.test.ts` (the marks), `tests/integration/research-run.test.ts` (the record's and the outcome's loaders as the asker — the audience, the variant — and as a stranger: not found); live in Chromium as the demo reader on the research seed's proposal: the record (the header, no export, the research credit) and the outcome page (`Recommended`) both axe clean, the JSON record 200, and another reader answered 404 on all three.

## 20. The review (unit 60, 2026-10-11)

One review of the unit (60a to 60e): three lenses — privacy and authorization; the data and its failure modes; the UI, accessibility and the two languages — raised twenty-four findings. A skeptic each judged the fourteen most severe: twelve confirmed, nine distinct, and two refuted. The ten left unjudged by the review's cap were judged by the builder; nine are real and fixed with the rest, and one is recorded as a limit. Fixed in one commit:

| # | Finding | Fix |
|---|---|---|
| 1 | The record's timeline named a reader who had taken their name back, beside both `endorsed` records, to the part's curators and, once merged, to anyone (high) | an `endorsed` record whose reader's name no longer stands reads by the ledger's pseudonym (`lib/db/improveRecord.ts`), as the header, the queue and the history already did (42 D4) |
| 2 | The outcome page said a curator closed a researcher's proposal that the rules, the adjudicator or the chapter's check closed (medium) | a researcher's proposal closed on a request for more is `notProposed` (`Not proposed`), or `checkFailed` in a closed form where the check closed it after a curator's accept (`lib/improve/outcomeView.ts`, the two sentences in EN and PT) |
| 3 | The record offered its export to a curator reading a closed proposal across parts (D6), which the export's endpoint answers 404 (low) | `mayExport`: the export is its owner's and its parts' curators', as § 19 says; the page offers it to no one else |
| 4 | A 409 on `Add my name` removed the focused control in silence and left the line stale (low) | the footer says `this proposal no longer takes names` (with `· with your name` where it stands) and the focus goes to `View record` |
| 5 | A poll that brought a newer view remounted the panel and dropped the focus (low) | the panel is keyed by its proposal alone and takes a newer view as it comes |
| 6 | A removal answered 404 (the name gone from another tab) read as a passing failure, for ever (low) | read as removed |
| 7 | The research seed's answers claimed ledger record #1, so exporting the seed's conversation would have handed the demo reader the chain's first record (low) | the seed's answers carry no ledger record |
| 8 | `research:seed` took any conversation of the demo reader that began with its question for its own, and could delete a real run's suggestions (low) | its conversations are found by the seed's trace, and only the suggestions of runs under it go |
| 9 | The line's follow kept asking for a turn answered 401, 403 or 404, and its timer ran on with nothing to ask (low) | a stopped turn is asked no more; the timer stops with the last one |
| 10 | A failed `Remove my name` said `could not add your name` (low; the builder's) | `could not remove your name · try again later` |
| 11 | The panel's failure was a live region inside the dock's log (low; the builder's) | none of its own: the log announces it (D15) |
| 12 | A curator's accept of a researcher's proposal read `accepted on inspection` once recorded (low; the builder's) | `accepted`, as its segment says (§ 7.1) |
| 13 | The log's `closed by` printed a sensor's code (low; the builder's) | its name, as the record names it |
| 14 | The panel's section title carried no language, and the panel's and the log's tier badges no name (low; the builder's) | the title in its edition's `lang`; the badges' `Evidence tier B, Primary published` |
| 15 | The log's two tables and the queue's evidence table were regions named as their sections, two landmarks of one name (low; the builder's) | each region its own name: `Runs by month, table`, and so on |
| 16 | A `final` from workers older than the web has neither of the line's numbers, and the line drew an invalid date (low; the builder's) | none is read as none |
| 17 | The asker's `decision by` counted from the adjudication, not from when the proposal last entered the queue, which a merge sent back moves (low; the builder's) | from the suggestion's own time, as the queue counts it; the outcome page's deadline likewise |

The limit: the research log and the reader's proposals read each row's parts one statement at a time (`partsOf`, by design: it runs inside transactions too), six statements a row. That is nothing at this machine's numbers; at a year of research the log wants one query of its own.

Refuted: the timeline's `Decided · accept` for the adjudicator's accept of a researcher's proposal is spec 35 § 5's title for that record, and the Decision box beside it says `Recommended`; and the consent's sentence is in a screen reader's path, the node after the box and announced by the log.

Verified: `lib/improve/outcomeView.test.ts` (the closed variants, the deadline), `lib/improve/proposalView.test.ts`, `lib/research/view.test.ts`, `tests/integration/research-run.test.ts` (the record of the proposal whose name was taken back, as a curator of its part reads it: both `endorsed` entries by pseudonym, the name nowhere, the export theirs and not the asker's); live in Chromium on the seed's proposal, EN at 1440 and PT at 390: the 409's sentence and the focus on `View record`, the title's `lang`, the badge's name, no live region in the panel, axe clean; the research log as a curator: the regions' names, the sensor's name, axe clean, a reader refused.

