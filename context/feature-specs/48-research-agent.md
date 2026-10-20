# 48 · The research agent — feature spec (research on request, as conversations with reports; its own page and dock; a report from the web with the pages it read; findings turned into improvements one at a time, by role; Improve started from scratch or from a research)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: Andre's stories of 2026-10-12 and his twelve answers the same day, A1 to A12, each binding (§ 1, § 2). Where they change a rule another document states, this spec says which and the unit that amends it (§ 21). Two of those changes are to architecture invariants, 31 and 33, by Andre's A1 (§ 2), and a third, invariant 27, follows from his A4 (§ 8.6). Under rules § 1.5 that is reported here, not resolved silently. **Andre answered its five decisions on 2026-10-12, each on the recommendation (§ 24).**

Prerequisite specs:

- `40-research-run.md` (the run, its rows, its budget, its privacy), `41-researcher-agent.md` (the gateway's web tools, the guide, the planner, the reader, the validation), `42-research-proposals.md` (a finding as a suggestion; endorsement), `43-research-in-the-product.md` (the research line, the proposal panel, the asker's proposals, the research log) and `44-researcher-gate.md` (the gate and the series). All five are built (units 57 to 61).
- `26-assistant-page.md` (the three-column page this one is modelled on), `24-assistant-dock-anywhere.md` (the dock on every page, the slot, the `a` key), `25-assistant-stats.md` (the statistics panel), `17-refusal-log-flags.md` (coded flags, the conversation's export), `21-assistant-retention-observability.md` (the purge, redaction).
- `45-deleting-and-withdrawing.md` § 3 (the conversation's delete, its door, its research rows, `ERASED`, the sweep).
- `34-improve-suggest-screen.md` § 4 and `35-adjudication-and-record.md` § 3 (how a suggestion starts; the Improve landing page), `31` (the draft, its door), `32` (evidence and `GradeEvidenceWorkflow`), `38` § 2 and § 3 (the budget meter by consumer; the audit pack).

Spec 46 (deleting an account) is decided and is built after this spec's units (its § 13, "Order"). It relies on the research hand-over this spec removes, so § 21 amends it, and unit 70 builds into the new workflow what spec 46 needs of it (§ 5.1).

Scope: tracker units 68 to 77, in Andre's lean shape, one review a unit (§ 25), and a later unit 78 that removes the automatic research once nothing of it still runs. Units 65 and 66 are spec 46's; unit 67 was Book management.

Before this spec was written, four read-only maps of the code were made (the research run today; research in the product's UI; the Assistant's harness and frontend; how an Improve suggestion starts), and the design below was read against the code it depends on. Three reviewers then checked the draft against the code, each from one side (data, product, safety). They raised 54 findings, three of high severity, and every one is answered in the text (§ 27). File and line references are to the code as of 2026-10-12.

## 1. Purpose

Andre's stories, as he wrote them:

- As a Harness Bible user (any role), I want to be able to use the research agent at will.
- The research agent should be dettached from the Assistant, with its own subpage and all the harness, frontend, and features of the Assistant Agent, but for research
- The Harness Bible workflow should be the following:
  1. I ask a question to the Assistant, at the end of the answer should be a button to suggest starting a Research
  2. In the Research agent I can start a research from scratch or from a conversation with the assistant.
  3. At the end of a research should be a button to suggest transforming the result of the research in Improvements
  4. The Improve feature should enable improvements from scratch or from the results of researches

Today a research run starts by itself at the end of every answered turn (`researchAfterTurn`, `workers/answer/turn.ts:270`). It runs on the platform's budget, and the reader sees one line about it. When Improve accepts a finding, the reader also sees a proposal under the answer. Nothing starts a run but an answer, and the reader cannot read the research itself.

After this spec, research is something a person does: a conversation of their own on its own page, `/[lang]/research`, and in a dock on every page. They ask a question, from scratch or from an answer of the Assistant. They watch each step as it happens. They get a report written from the web pages the research read, with every one of those pages, and at most three proposed changes to the book. They decide, one finding at a time, which ones become improvements.

## 2. Andre's decisions (2026-10-12)

| # | Question | Answer |
|---|---|---|
| A1 | What is "a research" | **A conversation with reports**: like the Assistant — you ask, it searches the web and streams back a written report with its sources, plus up to 3 proposed changes to the book (findings); follow-ups in the same research, each follow-up another run |
| A2 | Today's automatic research after every assistant answer | **Replaced by the button**: nothing runs on its own any more; the answer ends with a "Start a research" button; the account page's research on/off switch goes away |
| A3 | Who pays (~US$ 0.60 a run on the real provider) | **The user's own budget**, like an Assistant turn: their organisation's or their individual cap, a "Research" row on their budget meter |
| A4 | What "Turn into improvements" does | **Both, by role**: a contributor (verified) gets an editable draft of their own in Improve (anchor, change, source links prefilled); anyone else submits the finding as a researcher proposal (today's path: no owner, the curators decide, they may add their name) |
| A5 | From scratch, what the user gives | **A question; the agent finds the sections itself** with the Assistant's book retrieval, researches the web around them and anchors findings there; a question with nothing to do with the book is refused, as the Assistant refuses |
| A6 | The "Start a research" button under an Assistant answer | **Prefills, you press Start**: opens the Research page with a new research seeded from that answer (its question, the answer and the sections it cited); the question is editable; nothing is spent until Start |
| A7 | What the user sees of a research's work | **The report, every web page it read, and the findings that passed the checks**; findings the checks rejected stay hidden |
| A8 | Researches a user may start a day | **30 a day, as today** |
| A9 | The Assistant's features on the Research page (a conversations list, delete, 30-day text retention, EN/PT and the phone layout come by default) | **All four extras: live progress** (each step as it happens: planning, each search, each page read, checking), **flag a report** (coded reasons, as answers), **a stats view** (runs, cost, findings proposed and accepted, sources read), **a Research dock on every page**, as the Assistant's |
| A10 | The header | **Book · Assistant · Research · Improve · Labs**, at `/[lang]/research` |
| A11 | Improve from scratch | **A "New suggestion" button on the Improve page**: choose a chapter, then a section, then today's anchor step (the section, one of its figures or a source row) |
| A12 | Turning a research into improvements | **One button per finding**: send only the ones you agree with; a contributor gets a draft, anyone else submits a researcher proposal |

Implied by story 4 and A11/A12: the Improve landing page also offers starting from a research's results, meaning a person's researches and the findings of theirs not yet turned into improvements.

What follows from them, on this spec's reading:

- **A1 amends invariant 31.** Invariant 31 reads: "The researcher never answers a reader. … what research finds reaches a reader only as a proposal that the improvement process accepted". A report written from the web, shown to the person who asked, is the researcher answering them. The invariant becomes: *the researcher never changes an answer of the Assistant, and nothing it writes is presented as the book. Its report is shown only to the person who asked, on the Research page and dock, labelled as read from the web and not checked by Improve. A finding reaches the book only through the improvement process.* The project overview's "not a general AI chat product" line stays true, because A5 keeps the research about the book.
- **A1 also amends invariant 33.** A report that answers the person's question must be written by a call that holds the question. The reader holds the web tools, and it must not hold the question (§ 5.4). So a third call, the **writer**, follows the reader. It reads the question and what the reader wrote about each page, holds no tool, and writes only to the person who asked. Invariant 33 becomes: *the planner reads the person's question and never anything the web wrote; the reader reads the web and never the question; the writer reads the question and the reader's notes on the pages, holds no tool, and its output is checked in code and shown only to the asker. The only text that crosses from the question's side to the web's side is the brief, after the brief sensor.*
- **A1, "streams back".** The run's steps reach the page as they happen (A9's live progress, § 6). The report itself appears whole, once the report sensor has passed it (§ 5.7). This is the rule that makes the Assistant render citations only from its `final` event (invariant 14): text that code has not checked is never shown as if it were.
- **A1, follow-ups.** A research is a conversation. Each question is one run, and a run starts only when the conversation's last run has ended. The planner of a follow-up reads the earlier questions and briefs, and its writer reads the earlier questions and reports (§ 5.3, § 5.6).
- **A2.** `researchAfterTurn` leaves the turn. Nothing writes a `ResearchRun` for an answer any more, and the `final` event stops carrying `research`. Legacy runs keep their line and proposal panel under their answers, read-only (§ 9). The account page's switch goes. The organisation's switch is D2.
- **A3 reverses spec 40 A6 and spec 38 § 2** ("research is never on a reader's meter"). The planner, the reader, the writer and the retrieval of a run are charged to the person's own principal. The account meter gains a `research` row. What is left of the platform's research principal is Improve's vetting of the findings people send as researcher proposals (§ 7).
- **A4, who is a contributor.** The rule is the draft door's own: the role `CONTRIBUTOR` or `CURATOR` (the ladder, `policies/hb/roles.rego`; `suggestGate`, `lib/improve/suggest.ts:90`) **and** a verified identity (`policies/hb/improve.rego:37-42`). An unverified contributor, a reader, a builder and an organisation admin are "anyone else" and send a researcher proposal (§ 8). A verified contributor under Improve's throttle neither drafts nor sends while it lasts (§ 8.1).
- **A5.** The refusal has three parts. Two are the Assistant's own rules, applied by the start endpoint before anything is spent: the plant-equipment rule (`R-SCOPE-OT`) and the unverified-chapter rule (`R-UNVERIFIED`). The second applies because the Assistant's retrieval, which A5 names, searches verified chapters only (`planOf`'s `verifiedOnly`, `lib/search/retrieve.ts:147`), and a seed's citations are verified by construction. So research reads only verified chapters, as the Assistant does, and a question about an unverified one is told so before it is paid for. The third part is the planner's own judgement, which already names `NOT_ABOUT_THE_BOOK` and `PERSONAL` (`lib/schemas/researcher.ts:14`). The recompute rule does not apply, because research computes nothing (§ 5.2).
- **A6.** The seed is read, not copied. The first run of a seeded research reads the answer's claims, its uncovered sentences and its cited sections from the Assistant's rows when it plans (§ 5.3), as today's planner does. A `?from=<messageId>` link writes nothing, so nothing is spent until Start.
- **A7.** `INVALID` findings and their reasons stay hidden from the client, as today, and so does their number: the checking step shows no count, and the findings that passed are numbered 1 to n in the view (§ 6, § 16). The brief stays the run's working text and is never shown either, since A7 does not list it. The steps show each search query and each page (A9).
- **A8.** `RESEARCH_RUNS_PER_DAY = 30` (`lib/schemas/research.ts:44`) is counted by `runsStartedSince`: the rows with a workflow in the last 24 hours, leaving out the runs that spent nothing (`SKIPPED · BUDGET`, `SKIPPED · UNAVAILABLE`). A run refused by rule at the start has no workflow and is not counted either.
- **A9.** The extras are § 6 (live progress), § 11.7 (flags), § 11.6 (stats) and § 12 (the dock). Delete, retention, EN/PT and the phone layout come from the Assistant's page, and so does the conversation's signed export, which story 2's "all the … features of the Assistant Agent" covers (§ 11.10).
- **A10.** `TopBar`'s `NavKey` gains `research` (`components/chrome/TopBar.tsx:10`).
- **A11 and story 4** are § 10.
- **A12.** Each finding is used once: drafted or sent, never both, never twice (§ 8).

## 3. The road, in one picture

```
Assistant answer ── "Start a research" ──► /[lang]/research?from=<messageId>   (prefilled, editable, nothing spent)
                                                     │  Start
/[lang]/research (or the Research dock) ── question ─┤
                                                     ▼
POST /research/conversations/{id}/runs ─► ResearchRun QUEUED ─► ResearchRunWorkflow  research:<runId>  (the person's principal)
   ▲ 402 / 403 / 409 / 429 at start          plan:   sections (the seed's, retrieval's) → planner → brief sensor
   │ REFUSED by rule, nothing spent          read:   reader + web search + web fetch → findings, notes   (steps written live)
   │                                         check:  findings and notes in code → VALID / INVALID
   │                                         write:  writer → report sensor → report
   │                                         end:    DONE | REFUSED | FAILED · code | SKIPPED · code; one RESEARCH record
   └── the page polls GET /research/runs/{id} every 2 s while it runs
                                                     │
            each VALID finding, one button ─────────┤
              verified contributor ──► POST /research/findings/{id}/draft   ─► their own DRAFT in Improve, items graded
              anyone else          ──► POST /research/findings/{id}/propose ─► SendFindingWorkflow  finding:<id> ─► researcher proposal
Improve: "New suggestion" (/[lang]/improve/new: chapter → section → step 1) · "From a research" (unused findings)
```

## 4. Data

### 4.1 Why a model of its own, and why the run row is reused

A research conversation is its own model, `ResearchConversation`, not a kind on `Conversation`:

- A research turn shares nothing with an Assistant `Message`. One holds a question, live steps, a report, pages and findings. The other holds citations, verdicts, a mode and a ledger line.
- `Message.mode` is a required `AssistantMode`.
- A kind column would need a filter in about twelve readers: `listConversations`, `conversationStats`, `getConversation`, `openTurn`, `readerStats`, the eight `lib/metrics/sql/*.sql` statements, the calibration set and the purge.

A run of a research conversation reuses `ResearchRun`, keyed by its own id. The run's findings (`ResearchFinding`), the sweep, the `RESEARCH` record, the research log and the series are already keyed by the run. New columns say which conversation a run belongs to, and a legacy row keeps its `messageId`.

### 4.2 The migration (68a; additive and relaxing, invariant 30)

```prisma
enum ResearchState   { … WRITING REFUSED }          // added: the writer's step; a refusal (an end state, § 5.2)
enum FindingOutcome  { … VALID DRAFTED }             // added: passed the checks and unused; made the asker's own draft

/// A person's research: a conversation of runs (feature-specs/48 § 4). The asker's own row, under the tenant filter by userId.
model ResearchConversation {
  id             String        @id @default(uuid())
  userId         String
  user           User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  organisationId String?
  /// The language the conversation was opened in; each run carries the language its question was asked in.
  locale         Lang
  /// The Assistant answer it was started from (A6): the asker's own ASSISTANT message id, read inside their tenant.
  /// No foreign key, so the Assistant's delete (45 § 3.3) never reaches a research; null from scratch.
  seedMessageId  String?
  createdAt      DateTime      @default(now())
  lastRunAt      DateTime      @default(now())
  /// Set once every run's text was purged (§ 17.1).
  textPurgedAt   DateTime?
  runs           ResearchRun[]

  @@index([userId, lastRunAt])
}

model ResearchRun {                              // added columns only
  conversationId String?                         // its conversation; null for a legacy run and for one detached by a delete (§ 17.2)
  conversation   ResearchConversation? @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  ordinal        Int?                            // 1, 2, … within its conversation
  question       String?                         // the person's question as stored: redacted, ≤ 800 characters; purged at 30 days
  targetAnchors  String[] @default([])           // the planner's targets: the sections the reader is given (§ 5.3)
  steps          Json?                           // live progress (ResearchStepsSchema, § 6); purged with the text
  report         Json?                           // the writer's paragraphs (ReportSchema, § 5.7); purged with the text
  refusal        String?                         // the refusal's cause, an enum value: R-SCOPE | R-SCOPE-OT | R-UNVERIFIED | R-PERSONAL
  budgetResetsAt DateTime?                       // the gateway's reset, when a call of this run met the person's cap (§ 7.2)
  writingAt      DateTime?                       // when writeReport called the writer: its ledger rows are the run's hb-frontier rows from here (§ 15)
  flagReason     String?                         // a coded reason (FLAG_REASONS), the person's own label (§ 11.7)
  flaggedAt      DateTime?

  @@unique([conversationId, ordinal])
}

model ResearchFinding {                          // added columns only
  failure String?                                // the code a send to Improve failed with (§ 8.4); never text
  sentAt  DateTime?                              // when sendFinding made its suggestion (§ 8.4); since unit 74's review the month's sends are counted in `ResearchSendMonth` (§ 8.3, D5)
}

model Suggestion {                               // added column only
  fromResearch Boolean @default(false)           // drafted from a research finding (§ 8.6): provenance, never credit
}
```

Also by hand in the migration:

- a `CHECK ("messageId" IS NULL OR "conversationId" IS NULL)`;
- `User.researchConversations` on the relation side;
- `ResearchConversation` joining the tenant filter's models by `userId` in `lib/db/client.ts`, as `ResearchRun` and `ResearchFinding` did (spec 40 § 13).

The research views change in a migration of their own, in unit 70 (§ 11.7, § 21).

What the existing columns mean on a run of a research conversation:

| Column | On a run a person started |
|---|---|
| `messageId` | always null |
| `sectionAnchors` | the sections the planner was given: the seed answer's cited sections and retrieval's, at most ten (§ 5.3) |
| `gap` | the seed answer replaced at least one claim (`Message.substituted > 0`); false from scratch and on a follow-up |
| `questionSha256` | the sha256 of the normalised question (lower-cased, whitespace collapsed), as legacy runs have it. `normalisedQuestion` moves in unit 70 from `lib/research/eligibility.ts` to `lib/research/question.ts`. The `RESEARCH` record carries this same hash (§ 15) |
| `locale` | the language the question was asked in (the composer's `EN`/`PT`) |
| `brief`, `briefSha256`, `searches`, `pageReads` | as today |
| `found` | as today, with new members: the reader's notes, then the notes that passed, and the pages read (§ 5.4, § 5.5) |
| `workflowId` | `research:<runId>`, written in the insert; `ResearchWorkflowIdSchema`'s pattern already admits it (`lib/schemas/workflows.ts:208`) |

### 4.3 Legacy columns and legacy rows

- **The automatic runs' rows** stay readable as they are. The line and the proposal panel under their answers keep reading them (§ 9.3), and the purge, the sweep and the research log keep reading them. From unit 75 nothing creates one. A legacy run still in flight finishes on the legacy `ResearchWorkflow`, unchanged, which stays registered until unit 78 (§ 25).
- **`ResearchRun.messageId @unique`** stays for the legacy rows.
- **`ResearchMark`** gets no new row from unit 75: research on request is not deduplicated across people (§ 5.1). Its rows still give a legacy line its "researched 12 days ago".
- **`User.researchEnabled`** is read by nothing from unit 75. It is dropped in a later release, after the code stopped reading it (code-standards § Data). Spec 46's use of it, to stop research while a deletion request stands, moves to the start endpoint's check 4 (§ 5.2, § 21). **`Organisation.researchEnabled`** is D2.
- **`Message.uncovered` and `Message.retrievedSections`** are still written by every turn. The first run of a seeded research reads `uncovered` (§ 5.3).

## 5. The run

### 5.1 `ResearchRunWorkflow`

A new workflow, `ResearchRunWorkflow`, under `research:<runId>` on the `hb-research` queue. Its argument is `{ runId, userId }`, both ids (invariant 35).

The legacy `ResearchWorkflow` is not edited. Its running histories (runs asleep at the cap, runs waiting up to 40 days for their suggestions) replay its code whenever the workers restart (code-standards § Workers), so a change to it would need a patch for each change. Two workflows side by side need none.

| # | Activity | Timeout | What it does | It ends the run as |
|---|---|---|---|---|
| 1 | `loadRun` | 2 min × 3 | reads the row inside the asker's tenant; redacts the question again with the workers' own secrets and writes it back where that changed it (§ 5.2); writes `PLANNING` and its step | `SKIPPED · TEXT_PURGED` when the text is gone (a delete, § 17.2) |
| 2 | `planRun` | 10 min × 1, heartbeat 60 s | the sections (§ 5.3), the planner, the brief sensor; stores the brief, the targets and the `SECTIONS` step | `REFUSED · <cause>`, `SKIPPED · BUDGET` (§ 7.2), `SKIPPED · UNAVAILABLE`, `FAILED · PLANNER_FAILED`, `FAILED · BRIEF_<CHECK>` |
| 3 | `readRun` | 35 min × 1, heartbeat 60 s | the reader with the two web tools, its steps written as each block arrives (§ 6), `found` stored | `FAILED · BUDGET`, `FAILED · READER_FAILED` |
| 4 | `validateRun` | 2 min × 3 | each finding checked in code (spec 41 § 7, against the targets); each page's note checked; `VALID`/`INVALID` rows | — |
| 5 | `writeReport` | 5 min × 1, heartbeat 60 s | `writingAt`, then the writer and the report sensor (§ 5.6, § 5.7) | `FAILED · BUDGET`, `FAILED · RATE_LIMIT`, `FAILED · WRITER_FAILED` |
| 6 | `concludeRun` | 2 min × 3 | the end state first, then the `RESEARCH` record once (§ 15), then the `research.run` line, as `concludeResearch` orders them (`workers/activities/research.ts:153-172`) | `DONE` |

- **No signal, one query.** The workflow takes no signal. Its one query is `stage`, as the legacy workflow's.
- **No waits but one.** It never sleeps on the budget and never waits on suggestions, since sending a finding is a later act of its own (§ 8). Its one timer is the writer's wait at the key's rate limit (§ 5.6).
- **Each agent once.** The planner, the reader and the writer each get one attempt (invariant 15).
- **Heartbeats.** `planRun`, `readRun` and `writeReport` heartbeat: `readRun` from each block the stream completes (§ 6) and from a 20 s timer during each request, the other two from the timer. A worker lost to a restart or a deploy then fails the step within a minute, and the run ends `FAILED` with what it has, instead of the page showing frozen steps for up to 35 minutes.
- **The worst case.** `loadRun` 6 minutes with its retries, `planRun` 10, `readRun` 35, `validateRun` 6, `writeReport` 5 + 65 s + 5, `concludeRun` 6: about 74 minutes and seconds of backoff. The workflow is started with a `workflowExecutionTimeout` of **90 minutes**: `WorkflowDefinition` gains an optional `executionTimeout` (`lib/schemas/workflows.ts:218`), which `sdkEngine`'s `start` passes on (`lib/workflows/client.ts:171-175`). A workflow stuck in a loop of workflow-task failures, which the SDK retries without end, is closed by the engine at 90 minutes, and the start endpoint then ends its row (§ 5.2 check 3).
- **An end is always written.** The workflow's body runs in a `try`:
  - a **cancellation** (spec 46's erasure, step 5) is caught, and the run is concluded in a scope the cancellation does not reach (`CancellationScope.nonCancellable`): `SKIPPED · TEXT_PURGED` where its text is gone, since the erasure deletes the account's research conversations first, and `FAILED · CANCELLED` otherwise, each with its `RESEARCH` record as any end;
  - **any other failure that escapes** (`concludeRun`'s three attempts spent, a defect) calls `abandonRun` (2 min × 3: a conditional update to `FAILED · INTERNAL`, no record) and then rethrows.
  The workflow is new, so neither needs `patched()`: a patch guards a change to code that has running histories (code-standards § Workers).
- **What a failure keeps.** A later step's failure keeps what earlier steps stored: a run whose writer failed still shows its pages and its findings (A3's "ends with what it has"; § 7.2).
- **Text purged mid-run.** A run that meets `TEXT_PURGED` from any step ends `SKIPPED · TEXT_PURGED`, as the legacy run does. Every write of text is guarded by `textPurgedAt`, as `writeResearchState` guards the brief (`lib/db/research.ts:440-449`). The same guard covers `steps`, `report` and `found`.
- **Deploy order.** Unit 70 registers the workflow in `workers/workflows/index.ts` and its entry in `WORKFLOWS`. The workers are deployed before unit 71's start endpoint.

### 5.2 Before anything runs: the start endpoint's checks

The start endpoint (§ 13) decides what can be decided for free, in this order. Each is a status code, since nothing has started:

1. the question is 1 to 800 characters (`QUESTION_MAX`; 400 `TEXT_TOO_LONG`);
2. the conversation is the caller's (404);
3. **no run of the conversation is under way** (409 `RESEARCH_IN_PROGRESS`). "Under way" means a state not in `ENDED_STATES` (`lib/db/research.ts:432`), which gains `REFUSED` in unit 70; a reader of that list would otherwise hold a refused run as running. Where the newest run is under way, the endpoint asks the engine (`workflowRunning`, `lib/workflows/client.ts:267-282`):
   - running: 409;
   - not running (never started because the web tier died between the insert and the start; terminated; closed by its 90 minutes): the row is ended `FAILED · ABANDONED` by a conditional update on the state the start read, and the start goes on. A `QUEUED` row younger than a minute may be another start whose engine call has not arrived, and is answered 409 and left alone; a conditional update that changed nothing is 409 too (review of unit 71, § 31);
   - the engine unreachable: 503 `RESEARCH_UNAVAILABLE`.
   This read and its engine call come before the transaction below, so no lock is held across a call to the engine;
4. **no deletion request stands for the account** (`User.deletionRequestedAt`, read in the same system read as the organisation's switch; 403 `ACCOUNT_DELETION_REQUESTED`). Spec 46 § 3.2 stops research while a request stands by having the hand-over answer `OFF_USER`; the hand-over is gone (§ 9.2), so this is where that guard lives now (§ 21);
5. the organisation's switch (D2; 403 `RESEARCH_OFF_ORGANISATION`);
6. the caller's latest run did not meet the cap before a reset still ahead (402 `BUDGET_EXCEEDED`, § 7.2);
7. fewer than 30 counted runs in 24 hours (429 `RESEARCH_DAILY_LIMIT`, with the instant the oldest leaves the window);
8. the engine is configured (503 `RESEARCH_UNAVAILABLE`).

Then it **redacts** the question with the process's secret patterns, as the Assistant's turn does (`redactSecrets(text, processSecrets())`, `workers/answer/turn.ts:115`; both live in `lib/security/`). The web tier's `processSecrets()` is not the workers': the gateway's master key is registered in the workers alone (`workers/main.ts:63`, `lib/security/processSecrets.ts:15-21`). So `loadRun` redacts the stored question again, in the workers, before any prompt is built, and writes the result back where it changed (§ 5.1).

Then it applies **the Assistant's two free rules**, from `lib/sensors/scope.ts`:

- **the plant-equipment rule**: `scopeRules`'s `ot-verb-object` and `ot-tag` rules alone, as a small export, `otRule(question)`, added in unit 71;
- **the unverified-chapter rule**: a question that names a chapter which has not passed verification in the current release (`referencesOf`, and `chaptersPassed`, which moves in unit 71 from `workers/answer/run.ts:329` to `lib/db/content.ts`; the check `chaptersVerifiedFor` makes, `run.ts:318-327`, for an explain question with no context).

The outcomes:

- **A question either rule refuses** is a run written `REFUSED · R-SCOPE-OT` or `REFUSED · R-UNVERIFIED`, with no workflow. Nothing is spent and the run is not counted. The person sees the Assistant's refusal card for it, with the Assistant's pointers (`OT_POINTERS` for the first; none for the second, as the Assistant gives none).
- **Otherwise** one transaction: the conversation's row locked `FOR UPDATE` (registered in `RAW_SQL.md`, as the delete's lock is); check 3's row and check 7's count read again under the lock; the next ordinal; the run inserted `QUEUED` with its `workflowId`. A `P2002` on `(conversationId, ordinal)`, which a racing start could still meet, is answered 409 `RESEARCH_IN_PROGRESS`. After the commit the workflow is started.
- **A refused start** takes the row back to `SKIPPED · UNAVAILABLE` and answers 503, as the hand-over does today (spec 41 § 13). The row keeps its `workflowId`, and `runsStartedSince` leaves it out (§ 7.2).

The lock is the conversation's, so two starts in two conversations at the person's thirtieth run can both pass check 7. The count is then at most one over (§ 22).

### 5.3 The plan

**The run's sections** (`sectionAnchors`), at most ten:

- **The first run of a seeded research**: the seed answer's cited sections, read from its `Citation` rows inside the asker's tenant, then retrieval's for the question as stored, together at most ten. The person may have edited the question toward another part of the book (A6), and the seed's sections alone would plan that question against the wrong part.
- **From scratch**: the Assistant's retrieval, `retrieve()` of `lib/search/retrieve.ts`, in `explain` mode with no context, on the person's principal. Its set is the run's: the eight re-ranked sections and the sections the question names, at most ten (`retrieve.ts:170-175`, `:283-287`). Its calls carry the run's id as their `ref`: `RetrieveRequest` gains an optional `ref`, and today every call writes `ref: null` (`retrieve.ts:242`). Retrieval searches verified chapters only (`retrieve.ts:147`), which is why the start applies the unverified-chapter rule (§ 5.2).
- **A follow-up**: retrieval for its question, with the previous run's targets placed first where retrieval did not return them, at most ten.

**Retrieval's refusals** degrade to the lexical order, as they do for the Assistant (`isHalfRefused`, `retrieve.ts:221-223`, `:250-256`, `:271-277`): a spent budget, an unreachable gateway or a refused request leaves the fused order. Retrieval is shared with the Assistant and does not change. The planner's refusal is the one that ends a run at the cap (§ 7.2).

**The planner** (`workers/agents/researcher/v2/planner.ts`; guide `guides/researcher/v2.0`, part `planner`; row `researchPlanner`, `hb-small`, 1,024 tokens, 30 s, no retry, no tool, as today). Its typed input is everything it may read and nothing else:

| Slot | What |
|---|---|
| 1 | the planner part of the guide, cached |
| 2 | the language (`en`/`pt`) and nothing else of the asker |
| 3 | the run's sections, at most ten, with their figures and source rows (`render.ts`, unchanged) |
| 4 | a seeded first run only: the seed answer's claims with their citations, and its uncovered sentences |
| 5 | a follow-up only: the conversation's earlier runs' questions and briefs, the last six, oldest first (the Assistant's own bound, `CONVERSATION_TURNS = 6`, `workers/agents/assistant/assemble.ts:83`) |
| 6 | the question |

It never reads who asked, an earlier run's report, or anything from the web. A report is written from what the reader wrote of pages, so a planner that read one would be reading the web at one remove (invariant 33).

Its output:

```ts
| { research: false, reason: "NOT_ABOUT_THE_BOOK" | "PERSONAL" }
| { research: true, brief: string /* English, ≤ 200 words */, targets: [{ section, intent: "UPDATE" | "GAP" | "CONTRADICTION" }] /* 1 to 3 */ }
```

- **`COVERED` goes.** A person asked for research and pays for it. "The book covers this" is something the report can say after looking.
- **Refusals.** `NOT_ABOUT_THE_BOOK` ends the run `REFUSED · R-SCOPE`, with the run's first two sections as the card's pointers, as the Assistant points at the nearest sections the book does cover. `PERSONAL` ends it `REFUSED · R-PERSONAL`, a cause of research alone: the question is about the person's own system or organisation, which the web must not be asked about.
- **A call the gateway refused before the provider saw it** (`GatewayUnavailableError`: no key for the person's principal, as for an individual account until spec 11 D5's numbers exist; the gateway unreachable; the key's rate limit) ends the run `SKIPPED · UNAVAILABLE`. Nothing was spent and it is not counted. A provider's failure or an output that does not parse is `FAILED · PLANNER_FAILED`, as today.
- **At most three targets**, the findings' own limit (spec 27 A13): a target with no finding to show is a section the reader reads for nothing.

**The brief sensor** (`lib/sensors/brief.ts`) keeps all seven checks, with two readings that change:

- `TARGET`: every target is among the run's sections, not "a section the answer cited".
- `QUESTION`: no five consecutive words of the question, **or of any earlier question the planner read**.

A person writing a research question deliberately does not make the question public. It may name their organisation or their system, and the reader, which holds a tool that issues searches, must not hold it (invariant 33; the canary of spec 41 § 11.3). A brief that copies the question fails the run `FAILED · BRIEF_QUESTION` after one small call (about US$ 0.013, spec 41 § 12). The research series count those failures (§ 25, unit 75). If they are frequent, the remedy is a guide version, not a weaker sensor.

### 5.4 The read

**The reader** (`v2/reader.ts`; part `reader`; row `researchReader`, unchanged: `hb-frontier`, streamed, 16,000 tokens, medium effort, 600 s a request, no retry, at most two continuations; web search and web fetch, 10 uses each). Its input is as today, with one change: it is given the **targets' sections** (at most three), not every section of the run. Spec 41 § 12 recorded "a `targets` column is the change" for when that was needed. Retrieval's ten sections would cost a frontier prompt to read for nothing.

Its output gains the pages' notes, under a name of their own, since `found.pages` is already the tools' list of addresses (`lib/schemas/researcher.ts:68-75`):

```ts
{ findings: [ /* as today, spec 41 § 6.2; at most 3 kept */ ],
  notes:    [{ url: string, says: string /* ≤ 60 words: what this page says that bears on the brief */ }] }
```

`ReaderOutputSchema` is strict on `{ findings }` today (`researcher.ts:60`). Version 2 is a schema of its own, `ReaderOutputV2Schema`, strict on both members; the legacy reader keeps the first.

What the step stores in `found` (`ResearchFoundSchema`, additive members):

- `findings` and `pages`, as today: `pages` stays every `https` address the tools saw, which `SOURCE_NOT_SEEN` is decided against (`workers/research/validate.ts:33`);
- `notes`: the reader's notes as it wrote them, until `validateRun` replaces them (§ 5.5);
- `read`: every page the turn saw, in order of appearance, as `{ url, title | null, opened: boolean, search: number | null }` (`opened`: the fetch opened it; `search`: the search whose results held it). `lib/gateway/tools.ts` gains a fetch result's title where the block carries one.

**The counts survive a failure.** A turn that fails after its first request was charged for what it searched. `callModelTurn` (`lib/gateway/turn.ts:83-93`) today rethrows a continuation's `BudgetExceededError` or `GatewayUnavailableError` and drops the counts it holds. It gains them on the error it throws (`searches`, `fetches`), and `readRun` writes them with `writeResearchCounts` before it ends the run, as the read step already does for a reader's own failure (`workers/research/read.ts:81-85`).

### 5.5 The check

`validateRun` checks the findings by spec 41 § 7, unchanged (`lib/research/validate.ts`), except for one reading: `ANCHOR` is "in a section the reader was given", which is now the targets. It writes **a row for every finding**: `INVALID` with its reason, as today, or `VALID`. A `VALID` row gives the finding its own id for the endpoints (§ 8) and the view (§ 16). Today a valid finding is only an ordinal in `found.valid`.

Each page note is kept only when all three hold:

- its address is among the pages the turn saw (`found.pages`);
- it is at most 60 words;
- it passes the secret patterns.

The notes kept are stored as `found.says`, and `found.notes` is removed in the same write. A note that fails is dropped and counted (`found.notesDropped`).

### 5.6 The write

**The writer** (`v2/writer.ts`; part `writer`; a new row `researchWriter` on `hb-frontier`, unstreamed, 16,000 tokens, medium effort, 120 s, no retry, purpose `research`, named by `GatewayCall.row` beside the reader's row on the same alias as the evidence grader's two rows are, `lib/gateway/policy.ts`; D1). It holds **no tool**. `writeReport` writes `writingAt` before it calls it (§ 15).

Its typed input:

| Slot | What |
|---|---|
| 1 | the writer part of the guide, cached |
| 2 | the language to write in |
| 3 | the question |
| 4 | a follow-up only: the earlier runs' questions and reports, the last six |
| 5 | the targets' sections |
| 6 | the valid findings: the anchor, the change kind, the change as `changeOf` computes its before and after (`lib/improve/outcomeView.ts:112`), the note, fenced |
| 7 | the pages with notes (`found.says`), numbered as the run's page list numbers them (§ 16), each note fenced as untrusted text |

It never reads who asked, the brief, or a page itself.

Its output:

```ts
{ paragraphs: [{ text: string, sections: SectionId[], pages: number[] }] }   // ≤ 8 paragraphs, ≤ 600 words in all (D1)
```

The guide tells it to:

- write in the run's language;
- quote what the pages say, never compute a figure;
- give no instruction to act on plant equipment (the report sensor holds it to that, § 5.7);
- say plainly when the pages say nothing the book does not;
- cite at least one page or section in every paragraph;
- write no address in its text: a page is cited by its number.

**At the key's rate limit.** The writer is called right after a reader's request that reported up to some 300,000 tokens against the key's `tpm_limit` (§ 7.1), so the gateway may refuse it `429` (`GatewayUnavailableError`, cause `rate_limit`). Such a call never reached the provider, so it is not the agent's one attempt. `writeReport` says so, the workflow sleeps 65 seconds (a timer) and calls it once more, and a second refusal ends the run `FAILED · RATE_LIMIT` with what it has.

### 5.7 The report sensor (`lib/sensors/report.ts`, pure)

The writer's output is parsed strictly and then checked paragraph by paragraph. A paragraph is dropped when any of these holds:

- a section reference is not among the targets and the valid findings' sections;
- a page reference is not a numbered page with a note;
- it has no reference;
- its text holds an address (the brief sensor's `EMAIL` and `URL` patterns);
- its text holds a secret (`findSecrets`);
- its text is about operating plant equipment (`aboutOperatingEquipment`, `lib/sensors/scope.ts:88`), the product's one vocabulary for it, which Improve's class detection reads too (`lib/rubric/changeClass.ts:70`). The report is the one free prose the product writes from web-derived text, so the OT boundary is a sensor on the output as well as a rule on the question;
- it falls past the 600th word.

Dropped paragraphs are counted in `report.dropped`, by rule. If none is left, the run ends `FAILED · WRITER_FAILED`, with its pages and findings shown. The report is stored as `ReportSchema` and reaches the client whole. Its paragraphs are rendered as plain text, never as markup. A section reference renders as the reader's `Cite` chip, and a page reference as a link to the page's row in the list (`#run-<runId>-page-<n>`, § 11.3), so no address the writer wrote is ever a link.

### 5.8 Lines, spans and the stub

- **Lines.** `lib/telemetry/lines.ts` gains `research.write` beside `research.plan`, `research.read` and `research.run`, with counts and the outcome and never a word (spec 44 § 4).
- **The stub.** `infra/gateway/stub/research.ts` gains the writer's request, recognised by the writer part's heading on `hb-frontier` with no tool. It answers with `x-hb-stub-write`: `report` (the default), `nothing`, `malformed`, `address` (a paragraph with a URL), `unknown-page` and `ot` (a paragraph telling the reader to bypass an interlock). The reader's fixtures gain their pages' notes. `npm run secrets:scan` covers `v2/`.

## 6. Live progress

**What a step is.** The run records its steps on its own row as they happen, in `steps`. That is an array, `ResearchStepsSchema` in `lib/schemas/researcher.ts`; it holds model and web text, so it does not live in `research.ts`, which the engine's schemas import. Each step is `{ seq, kind, at, … }`:

| Kind | Written when | Carries |
|---|---|---|
| `PLANNING` | `loadRun` hands the run to the planner | — |
| `SECTIONS` | the brief passes its sensor | the targets' ids |
| `SEARCH` | a `server_tool_use` block of web search completes, then its result block arrives | the query; then the number of results |
| `PAGE` | a `server_tool_use` block of web fetch completes, then its result block arrives | the address asked; then the address opened and its title, or `unreachable` |
| `CHECKING` | the validation starts | — (the number of findings checked is not shown, A7) |
| `WRITING` | the writer is called | — |

**How the reader's steps are caught.** The reader's turn is one streamed request per continuation (`lib/gateway/turn.ts`). `callModelTurn` gains an optional `onBlock(block)` callback, fed by the SDK stream's `contentBlock` event, which fires as each content block completes, before `finalMessage()`. A step is never part of the workflow's history: the activity writes the row (invariant 35).

- **One queue of writes.** The SDK's listeners are synchronous and not awaited (`lib/gateway/turn.ts:61-70` is where the stream is), and a search's step is written twice, milliseconds apart: appended when its `server_tool_use` block completes, and completed when its result arrives. So `readRun` keeps one promise chain: each block's write is appended to it in order, and the chain is awaited before `readRun` stores `found`.
- **Each write one statement.** An append (`"steps" = coalesce("steps", '[]') || $step`) or the update of one step by its index (`jsonb_set`), each guarded by `"textPurgedAt" IS NULL`. Both are raw, since the client cannot say either, and are registered in `lib/db/RAW_SQL.md`. No read-modify-write of the array.
- **A step that fails to write** is logged and never fails the read. `onBlock` also heartbeats (§ 5.1).
- **Progress, not evidence.** The final turn's blocks, read with `toolBlocksOf` as today, remain the only source for `found.pages` and `SOURCE_NOT_SEEN`.

**How a step reaches the page: a poll, not SSE.**

- The run is a Temporal workflow. The engine pushes nothing to the web tier, and the web tier reaches it only through `lib/workflows/client.ts`.
- An SSE route would hold a connection for the whole run, up to 90 minutes (§ 5.1). It would still read the rows to know what to send, and it would need its own reconnection.
- The product's existing transport for a workflow's progress is a subsequent GET (code-standards § API Routes; architecture § 6.4): the evidence list's 2 s, the outcome page's 2 s, the research line's 5 s.

So the page asks `GET /api/v1/research/runs/{id}` every **2 s** while the run is under way. That is the interval Andre set for the evidence list on 2026-10-08 (spec 34 D2, `EVIDENCE_POLL_MS`), because a step is seconds apart. 30 a minute stays inside the endpoint's 60.

The hook is `lib/hooks/useRunFollow.ts`, the pattern of `useResearchFollow`:

- it stops at an end state;
- it pauses while the document is hidden;
- it stops on 401, 403 or 404, and says it lost the run as the 90 minutes do (unit 72's review);
- it waits a 429's `Retry-After`;
- it retries a 5xx at the next tick;
- it gives up after 90 minutes, the workflow's own bound, with the line `still under way · reload to follow`.

The same hook follows a finding after a send (§ 8.3).

**A run nothing will move.** Only the newest run of a conversation can be under way (§ 5.2). A run still under way 90 minutes after it was created has no workflow left to move it: the view marks it `stale`, its line reads `research · stopped · no answer from the engine`, and the composer is enabled again. The next Start ends its row `FAILED · ABANDONED` (§ 5.2 check 3).

## 7. Money

### 7.1 Whose budget

The planner, the reader, the writer and retrieval's embed and re-rank are charged to the person's principal: their organisation's, or their own for an individual account. That is the principal the Assistant's turn uses (`lib/api/endpoints/assistant.ts:217`). The activities read it from the run's `organisationId` and `userId`.

- **The kinds.** The model calls are kind `RESEARCH` (purpose `research`). Retrieval's calls are `EMBED` and `RERANK`, as the Assistant's are, with the run's id as `ref`.
- **The meter.** `lib/budget/view.ts`'s `consumerOf` maps `RESEARCH` to a new consumer `research`, where it returns null today (`:27`). `CONSUMERS` gains it (`:44`), so the row shows at zero too (`:128-131`): it joins `FAINT_AT_ZERO` and reads faint until the person's research spends. Beside it, `NOTE_KEY` gains `research: "researchNote"` (`components/account/BudgetInstrument.tsx:23`), `planner, reader and writer of your researches`; retrieval's share of a run shows in the retrieval row, as the Assistant's does. The strings are unit 68's (§ 19).
- **The Assistant's statistics.** `readerStats`'s cache-read share stops counting research's frontier calls by reading its rows by kind (`ASSISTANT`, `GRADING`), not by alias alone (`lib/db/assistantStats.ts`). Until now those calls were on another principal.

**The key's rate.** The person's key carries the principal's `tpm_limit` (`workers/keys.ts:70-76`). For organisations and individuals alike that number is owed (spec 11 D4 and D5, deferred by Andre on 2026-09-24 until paid accounts exist; tracker Open Questions), and it was asked for with Assistant turns in mind. The research key these runs used had 100,000 tokens a minute (`scripts/research-org.ts:26`). A reader's request is far larger: the second real run reported 311,000 cache-read tokens in a turn of 1 min 42 s (spec 41 § 12). Three consequences, stated in § 22:

- the writer called right after can be refused 429; § 5.6 waits that out once;
- a paused turn's continuation can meet the same refusal and end `FAILED · READER_FAILED`, with its counts;
- the organisation's own Assistant turns can be refused for the rest of that minute.

The numbers Andre owes must now cover a reader's request. Unit 70 adds that to the tracker's Open Questions entry. Until spec 11 D5's numbers exist an individual account has no key, so its run ends `SKIPPED · UNAVAILABLE` at the planner (§ 5.3), as its Assistant turn is refused today.

### 7.2 At the cap

The gateway refuses (invariant 7), and no application code counts tokens.

- **Retrieval refused.** It degrades to the lexical order and the run goes on (§ 5.3).
- **The planner refused.** The run ends `SKIPPED · BUDGET`, and `budgetResetsAt` takes the reset `BudgetExceededError` carries. No model answered. Retrieval's embed and re-rank may have been charged, a fraction of a cent. The run had a workflow, but a run that spent nothing on a model is not counted toward the 30: `runsStartedSince` leaves out `SKIPPED · BUDGET`, and `SKIPPED · UNAVAILABLE` likewise (§ 5.2, § 5.3).
- **402 at start.** The start endpoint answers `402 BUDGET_EXCEEDED { resetsAt }` while the caller's latest run carries a `budgetResetsAt` still ahead. That is the gateway's own refusal remembered on the person's row, as the research key's refusal was remembered in the platform's `budget` mark (spec 40 § 7.2). In an organisation, a colleague's refusal is not visible across the tenant filter, so the first start after it meets the planner's refusal once.
- **A later call refused.** The reader's request or a continuation, or the writer. The run ends `FAILED · BUDGET` with what it has: the steps and pages already read, the counts of what the provider charged (§ 5.4), the findings when the reader had answered, never a report. The reset is on the row, and the line reads `stopped · your budget ran out · resets 01 Nov`.
- **No wait for the reset.** A run never sleeps on the budget, as a legacy run does (spec 40 § 7.2): the person can start again after the reset.

### 7.3 What is left of the platform's research principal

`RESEARCH_PRINCIPAL` keeps three jobs:

- grading and adjudicating the findings people **send** as researcher proposals. A researcher proposal has no owner, and the link from it to its asker runs one way, from the asker's row (invariant 35). Charging the asker would make the suggestion's workflow know who asked. So Improve's vetting of it stays the platform's, as spec 42 § 3 has it.
- the legacy runs still in flight.
- `npm run research:check`.

The planner, the reader and the writer of a new run are never charged to it. Its cap (US$ 20, spec 27 A14) now bounds Improve's work on sent findings, and it is shared by everyone who sends one:

- A sent finding costs the grading of each of its sources and one frontier adjudication, about US$ 0.10 to 0.15, so the cap buys some 150 sends a month.
- Twenty sends a day a person would let one person spend it in about a week. D5 bounds a person's sends by the month.
- While it is spent, every person's sent findings wait at Improve until the reset (`markBudgetWait`), and their blocks read `sent · being checked by Improve`.
- The exposure is smaller than today's: today one person's thirty automatic runs a day spend the same principal on the planner and the reader too.

A machine without `RESEARCH_PRINCIPAL` can still research, which today it cannot (every turn reads `research · not run`). It cannot send a finding as a researcher proposal (§ 8.3).

## 8. Turning a finding into an improvement

### 8.1 One button a finding, by role

Under each `VALID` finding the run block shows one button:

- **`Draft it in Improve`** for a verified `CONTRIBUTOR` or `CURATOR`, with the help line `grades its sources on your model budget`, since the press starts one paid grading per source (§ 8.2);
- **`Send to Improve`** for anyone else.

The person sees the button of their role and no other. A verified contributor under Improve's throttle (`suggestGate`, `lib/improve/suggest.ts:90`; 30 days, `lib/improve/throttle.ts:8`) sees the step 1 throttle notice in place of the button: the policy refuses them `Send to Improve`, since they draft, and the draft door refuses a throttled contributor. A pause as long as the finding's text lasts can let a finding expire unused; that is the throttle's own consequence, stated in § 22, and not bypassed by sending it on the platform's budget. A finding used once is marked and offers neither again.

| Finding | The run block shows |
|---|---|
| `VALID` | the button of the role, or the throttle notice |
| after a `202` to a send, until the follow sees it move | `sending to Improve` (the client's own state, § 8.3) |
| `DRAFTED` (`suggestionId` the draft) | `drafted · S-21-0042` and `Open draft`, which goes to the edit page while it is a draft and to its own page after |
| `SUBMITTED` with its suggestion | `sent · being checked by Improve` |
| `PROPOSED` | `sent · proposed`, then the proposal panel of spec 43 § 5 (where it stands, `Add my name`, `View record`) |
| `REFUTED` | `sent · not proposed` (D3) |
| `DUPLICATE` | `already proposed as S-21-0042` where that suggestion is the person's to see, `already proposed in Improve` otherwise (§ 8.5) |
| `VALID`, failure `RESEARCH_UNCONFIGURED` | `could not be sent here · research proposals are not configured`; the button again, disabled while the web tier sees no research principal |
| `VALID`, failure `NO_RUBRIC` | `could not be sent · Improve has no rubric in force · try again later`; the button again |
| `VALID`, failure `ANCHOR_UNKNOWN` | `research.findings.anchorGone`; no button |
| `VALID`, failure `PARSE` | `could not be sent · start a new research to look again`; no button |
| `VALID`, failure `TEXT_PURGED`, or its run's text purged | `This finding's text was removed after 30 days.`; no button |
| `VALID`, failure `SENDS_LIMIT` (the month's thirty taken by the time the send's transaction ran, § 8.4; review of unit 74) | `30 findings sent this month · the next on {date}`, the reset of the month the page is read in; the button again, since a press after the reset goes through and one before it is answered 429 with the reset. To someone who drafts now, nothing: the thirty do not count drafts |
| a finding of a run whose text was purged, used before | its outcome's line alone (§ 11.3) |

### 8.2 The contributor's draft

`POST /api/v1/research/findings/{id}/draft` (§ 13) runs in this order:

1. **The pipeline's gates.** The role `CONTRIBUTOR`. The policy's existing `create` on `suggestion` (verified). Drafts a day: 20, in the bucket of `POST /api/v1/suggestions` (`rateLimit.bucket`), so the cap counts drafts whatever door made them. An `Idempotency-Key`.
2. **The throttle**, as the create endpoint refuses it (`SUGGESTION_THROTTLED`).
3. **The finding**, read inside the caller's tenant:
   - another's or none: 404;
   - not `VALID`: 409 `FINDING_USED` with its use and suggestion;
   - its run's text purged: 409 `FINDING_PURGED`.
4. **The anchor**, resolved again at the current release (`resolveAnchor`). Gone: 422 `ANCHOR_UNKNOWN`. That is the anchor's drift since the run, and the person can start a new research.
5. **The class and the key**: the class by `classOf` and the key by `proposalKeyOf`, as `submissionOf` computes them for a researcher's (`workers/research/submit.ts:60-85`). That function moves to `lib/research/submission.ts` so the web tier and the workers share it.
6. **No duplicate.** No live suggestion has the same key: the door gains `liveSuggestionWithKey(caller, key)`, an id or null, for any origin in any state but `DRAFT` (spec 42 § 4.3's rule, applied to a person's draft from a finding). Otherwise 409 `PROPOSAL_DUPLICATE { suggestionId }`, the id null where it is not the caller's to see (§ 8.5).
7. **One transaction.** `claimFindingForDraft` in `lib/db/research.ts` runs the door's `createDraftFromFinding(caller, input, tx)` in the asker's own transaction, as `submitFinding` runs `createFromResearch` (`lib/db/research.ts:471`). The finding moves from `VALID` to `DRAFTED`, a conditional update, so two presses cannot both pass. The draft is created as `createDraft` makes one, with the proposal, its key, its class and `fromResearch` true (§ 8.6), and one `LINK` evidence item, `PENDING`, for each of the first ten distinct `https` sources (`ITEMS_PER_SUGGESTION_MAX`). The finding names the draft.
8. **Each item graded on its own.** After the commit, each item's `GradeEvidenceWorkflow` is started, as `POST /suggestions/{id}/evidence` starts one (`lib/api/endpoints/evidence.ts:116-123`), on the contributor's principal like any item they add. A start that fails removes its item, as that endpoint does.
9. **The answer**: `201 { suggestionId, href, items }`, and the page goes to the edit page. The answer holds no address, so its stored copy holds none either (§ 17.2).

**The rationale is left empty.** The researcher's note is not copied into it: spec 42 § 3 and D1 keep a note written under the influence of web pages from the adjudicator, and the adjudicator reads a person's rationale (`workers/activities/suggestion.ts:431`). The edit page's rail shows an instrument of its own, `from your research`:

- the note, with the sentence `written by the researcher from the pages it read; it is not your rationale — the adjudicator reads only what you write`, and a link back to the run;
- **the finding's sources not among your evidence**: its `https` sources whose address is among none of the draft's items, as links, under `{n} sources of the finding are not among your evidence: add them as links`. That covers a grading start that failed and an item the contributor removed alike, and it survives a reload, because it is read, not remembered.

Both come from `noteOfDraft(user, suggestionId)` in `lib/db/research.ts`: the caller's own `DRAFTED` finding that names the draft, inside their tenant, never through the improvement door, which reaches no research run (rules § 5). The instrument shows while the suggestion is a draft and the run's text lasts.

The proposal editor carries a line of its own while the draft is from a finding: `prefilled by the researcher from the pages it read · read it before you submit` (§ 8.6).

The draft is then the contributor's own, written, revised, submitted, credited and withdrawn as any draft. Invariant 25 applies as to any; invariant 27 and the curator's control are § 8.6.

### 8.3 Anyone else's researcher proposal

`POST /api/v1/research/findings/{id}/propose` (§ 13), for any role:

1. **The pipeline's gates.** An `Idempotency-Key`. 20 a day in its own bucket, the shape of a person's submissions (`SUBMISSIONS_A_DAY`). The policy's `submit` on `finding` (§ 14), which refuses a verified contributor, who drafts.
2. **The finding**, read in the caller's tenant: 404 when it is another's or there is none, 409 `FINDING_USED`, 409 `FINDING_PURGED`.
3. **Research proposals configured.** The web tier reads only whether `RESEARCH_PRINCIPAL` is set, as it reads whether `TEMPORAL_ADDRESS` is (§ 5.2 check 8). Unset: 503 `RESEARCH_UNAVAILABLE`, and the page renders the button disabled with the unconfigured line. `lib/env.ts`'s comment, "Read by the workers alone", is amended: the workers read its value, the web tier its presence.
4. **The anchor and the key**, as § 8.2 steps 4 to 6: 422 `ANCHOR_UNKNOWN`, 409 `PROPOSAL_DUPLICATE`.
5. **The month's sends** (D5): fewer than 30 in the caller's row of `ResearchSendMonth` for the calendar month in UTC (`2026-10`; none is none), else 429 `RESEARCH_SENDS_LIMIT { resetsAt }`, the first instant of the next month. The row counts the findings that became a suggestion — a duplicate made none and is not one — and is the person's own, under the tenant filter, which no delete of a finding or a research reaches; the account's delete takes it by the cascade. This read is a fast check, so the common case is refused before a workflow starts; what holds under a burst of presses is the send's transaction, which takes the place atomically (§ 8.4). (As unit 74 built it, the count was the person's findings with a `sentAt` in the month: rows the person's own deletes and the sweep remove, and a `sentAt` written only after the press, so a burst all read the old count. Review of unit 74.)
6. **A failure cleared.** A `failure` an earlier send left is cleared, a conditional update on `VALID`, before the start, so a quick new failure is not erased after it.
7. **The start.** `SendFindingWorkflow` is started under `finding:<findingId>`. Nothing is claimed first: the finding stays `VALID` until `sendFinding` makes the suggestion in one transaction (§ 8.4), so no crash between two writes can leave a finding claimed with nothing behind it. A second press while the workflow runs is handed the same run (`USE_EXISTING`, `lib/workflows/client.ts:174`). The engine refusing: 503 `WORKFLOWS_UNAVAILABLE`, and nothing changed.
8. **The answer**: `202 { findingId, use: "SENDING" }`.

The press opens the shared `ConfirmDialog` first: a submission is a record and is not taken back. Its words are in § 19.

**After the 202.** The run's own poll has stopped, since the run ended long before. The block shows `sending to Improve` and follows the run with `useRunFollow`'s rules (§ 6) until the finding is `SUBMITTED`, `DUPLICATE`, or `VALID` with a failure, for at most a minute, after which it reads `reload to follow`. The Improve landing's row does the same (§ 10.2). A reload in the seconds before `sendFinding` commits shows the button again; a press then is answered `202` by the running workflow and changes nothing.

### 8.4 `SendFindingWorkflow`

`SendFindingWorkflow({ findingId, userId })`, queue `hb-research`, ids only:

1. **`sendFinding`** (2 min × 3), as `service:researcher`, inside the asker's tenant. Every way it can end is defined:
   - **the finding gone** (the research's run swept, or the account erased): the workflow ends, writing nothing;
   - **not `VALID`**: `SUBMITTED` with its suggestion is an earlier attempt's, and the workflow goes on to step 2 with it; anything else ends it;
   - **`found` null** (the research was deleted or purged since the press): `failure = TEXT_PURGED`, and it ends;
   - **no principal** (a deployment whose workers and web tier disagree): `failure = RESEARCH_UNCONFIGURED`;
   - **no rubric in force** (`NO_RUBRIC`, as `workers/research/submit.ts:90-91` refuses it today): `failure = NO_RUBRIC`;
   - **the finding does not parse** (`ReaderFindingSchema`; possible only across a schema change, since the validation parsed it): `failure = PARSE`;
   - **the anchor gone**, a release published between the press and the step: `failure = ANCHOR_UNKNOWN`;
   - **otherwise one transaction**: the finding's conditional move from `VALID` to `SUBMITTED` with its `sentAt`, `submissionOf`, then `createFromResearch`, a place taken in the month's thirty, and the row naming the new suggestion, or `DUPLICATE` with the one it doubles, which takes no place. That is today's `submitFinding` (`lib/db/research.ts:471`), keyed by the finding's id instead of the run's ordinal. A conditional move that finds the finding no longer `VALID` reads it again and goes on as above.
   - **the month's thirty taken** by the time that transaction runs (review of unit 74): the place is taken in the person's row of `ResearchSendMonth` for the month of the step's instant, in UTC, by one statement that inserts it at one or adds one only while it is under thirty and answers the count it wrote (`INSERT … ON CONFLICT DO UPDATE … WHERE "count" < 30 RETURNING`, lib/db/RAW_SQL.md). A second send of the person's waits on the row's lock and then reads the first's count. No count answered: the transaction is rolled back, the suggestion and its serial with it, nothing is made, and `failure = SENDS_LIMIT`. So a burst of presses at twenty-nine makes exactly one more suggestion, whatever the endpoint's earlier read said.
   Each failure leaves the finding `VALID` with its code, and the block says what it means (§ 8.1).
2. **The child.** `SuggestionWorkflow` starts as a child under `suggestion:<id>`, `ParentClosePolicy.ABANDON`, as `ResearchWorkflow` starts it (`workers/workflows/research.ts:127-131`).
3. **The outcome**, asked as `nextOutcomesWaitMs` paces it, for at most `OUTCOMES_FOR_MS` (40 days), with `outcomeOfState` (`workers/research/outcomes.ts:24`). Those move in unit 74, unchanged, to `workers/research/pace.ts`, which both workflows import and unit 78 keeps (§ 25). The finding becomes `PROPOSED` or `REFUTED`.
   - A finding gone while it waits ends the workflow; its child runs on.
   - A `REFUTED` finding whose run was detached (`runId` null, § 17.2) is deleted in the same step: it is no proposal of the asker's to keep (spec 45 § 3.6 keeps the `PROPOSED` ones).
   - A cancellation (spec 46's erasure) ends it; nothing is owed, since the workflow writes no record.

The suggestion is spec 42's researcher proposal in every respect: origin `RESEARCHER`, no owner, the note as its rationale and kept from the adjudicator, the sources opened again by the product's fetcher, graded and adjudicated on the research principal, recommended and never decided by the adjudicator (invariant 32).

The person who sent it is the asker: `askerOfProposal` reads their `PROPOSED` finding (`lib/db/research.ts:225`), so `Add my name` and the record's `asker` audience work for them unchanged. It appears under **Improve · Proposals from your questions**.

The workflow writes no ledger record of its own. The suggestion's `submitted` record (actor `service:researcher`) is the record of the sending, and the asker's name joins the ledger only by an endorsement (invariant 35).

### 8.5 Duplicates

**What the person is told.** A duplicate may be another contributor's suggestion that is submitted and not merged, which is not public. So the id of the suggestion a finding doubles reaches the person only when it is the caller's own, one they are the asker of (their `PROPOSED` finding names it), or merged; otherwise the block reads `already proposed in Improve`, with no id and no link. `duplicateVisibleTo(user, suggestionId)` in `lib/db/research.ts` asks the door whether the suggestion is the caller's own or merged (`suggestionVisibleTo`), and adds its own asker check. The `409 PROPOSAL_DUPLICATE` answer carries the id under the same rule, else null. A legacy `DUPLICATE` row was never shown (spec 43 D2), and this keeps that for anything not the person's.

**A draft checked again at its submission.** A contributor's draft from a finding is checked against live keys when it is created (§ 8.2 step 6). A finding sent later with the same key passes `createFromResearch`, which ignores drafts (`lib/db/improve.ts:986`). So `POST /suggestions/{id}/submit` checks a draft with `fromResearch` against `liveSuggestionWithKey` again, at its current key, which an edit may have changed, and answers 409 `PROPOSAL_DUPLICATE` under the same rule. A person's ordinary draft keeps today's behaviour: two people's drafts of one change are adjudicated each on its own (spec 42 § 4.3's rule is about the researcher).

### 8.6 What a draft from a finding is (invariants 27 and 32)

A finding a contributor drafts becomes a `HUMAN` suggestion of theirs (A4): theirs to edit, submit and withdraw, credited to them, and decided as any person's is. The adjudicator may decide it, since invariant 32 governs origin `RESEARCHER`. Today's controls on a web-steered proposal were the researcher's: an adjudicator that never sees the page or the note, then a curator (architecture § 9's row "A web page steers the researcher"). On this path they are the contributor, verified and accountable, and the adjudicator, as for any text a contributor brings from the web by hand. Three things keep that honest:

- **The label.** The edit page marks the prefilled proposal as the researcher's work (§ 8.2), so it never reads as the person's own until they make it so.
- **Provenance.** `Suggestion.fromResearch` (§ 4.2), set by `createDraftFromFinding` alone. The chapter's history shows its `research` mark beside the contributor's credit (`lib/improve/history.ts:150` reads `origin === "RESEARCHER" || fromResearch`; `components/improve/ChapterHistory.tsx:28`), and the queue's class line reads `from research`. The adjudicator is not told: it judges evidence, and the note stays from it. The column names no finding and no asker (invariant 35).
- **The duplicate check at submission** (§ 8.5).

Invariant 27, architecture § 6.1's last paragraph and the threat-model row are amended in unit 74 to say this (§ 21). Invariant 27 becomes: *No edit is attributed to the agent; contributors are credited in the chapter's improvement history. A researcher's proposal is credited to the reader who added their name, if one did, and to nobody otherwise; a contributor's draft from a finding is credited to the contributor. In both, the history's `research` mark is provenance, not credit.*

## 9. The Assistant's side

### 9.1 `Start a research`

Every answered turn ends with a link button, `Start a research`, to `/[lang]/research?from=<messageId>`. It sits in `TurnActions` (`components/assistant/TurnActions.tsx`) after `Flag this answer`, and in a walk turn's footer beside `Flag this step` (`WalkTurn.tsx:204`).

- "Answered" means a turn with an answer whose refusal is null.
- It shows to a signed-in reader, and only while the turn's text is held: a purged turn has no question to seed.
- It is a link, because A6 opens the page and starts nothing.
- It shows on every mode. A walk, a compare, a lab and a brief are answers with citations. An answer with no citation seeds a question the research plans from scratch (§ 5.3).

### 9.2 `researchAfterTurn` goes

In unit 75:

- `workers/answer/turn.ts` stops calling `researchAfterTurn`, so the `final` event carries no `research`. `SseFinalSchema.research` stays optional, since stored finals of earlier turns hold one (`lib/schemas/api.ts:252`).
- `workers/research/afterTurn.ts` and `lib/research/eligibility.ts` are deleted with their tests, and so are the `ResearchMark` writers `writeRunMarks` and `removeRunMarks`. What else of `eligibility.ts` is still read moved before: `normalisedQuestion` to `lib/research/question.ts` in unit 70 (`turn.ts:13` and the new run use it), and the `ResearchMarkRow` type to `lib/research/view.ts` in unit 70 (`lib/research/view.ts:1`, `lib/db/research.ts:9` and `workers/gate/researchTurns.ts:9` import it).
- The researcher's gate's own turns (`workers/gate/researchTurns.ts`) are rewritten (§ 25, unit 75).
- The answer is unchanged. The real golden run (tracker, Waiting on Andre, item 6) no longer hands its answers to research.

### 9.3 The research line and the proposal panel

Both stay for the legacy runs, read from their rows as today (spec 43 § 4, § 5). They render only where a turn has a run: every turn from before unit 75 that was handed over. `useResearchFollow` stays for a legacy run still under way.

- The `off` line loses its `switch on` link, since the switch is gone (`ResearchLine.tsx:52`; `researchLineOf` stops setting `switchable`).
- The line's words are unchanged. A new turn has no line.

### 9.4 The switches

- **The account page's switch goes**: `pref-research` in `PreferencesInstrument`, the action `updateResearch` (`app/[lang]/account/actions.ts:86-93`), `setUserResearch`, and the keys `account.prefs.research*`.
- **The Retention instrument's research line** now says what research keeps (§ 19).
- **The organisation's switch** is D2. If kept, it is read by the start endpoint (§ 5.2 check 5), set by the same command (`npm run research:org -- --set`), and its words change from "research of its members' answered questions" to "research by its members".

### 9.5 The Assistant's delete

The delete dialog's research sentence (`assistant.delete.body`, spec 45 § 6) gains what is now true:

- a legacy run still running stops at its next step, unless it has already sent a finding to Improve (spec 45 § 6's words, kept);
- a research the person started from one of the conversation's answers is a conversation of its own on the Research page, and is not deleted with it, since its seed has no foreign key (§ 4.2).

The research reads its seed only while it plans. A seed deleted before then ends that run `SKIPPED · TEXT_PURGED`, and its card reads `from an answer that was deleted`.

## 10. Improve's starts

### 10.1 `/[lang]/improve/new` (A11)

A chooser in two steps, then today's step 1.

| Address | Shows |
|---|---|
| `/[lang]/improve/new` | the release's chapters, by part, each `NN · title · vX.Y.Z`, a link to `?ch=NN` |
| `/[lang]/improve/new?ch=NN` | the chapter's nine sections (`NN.1` … `NN.9`, the outline's layers, with their titles), each a link to today's step 1, `/[lang]/ch/NN/improve/new?anchor=NN.k`; above them `← chapters` |
| `/[lang]/ch/NN/improve/new?anchor=…` | step 1, unchanged: the section, one of its figures, or a source row (spec 34 § 4) |

- **Shared with step 1:** signed out, sign-in with `next`; and `suggestGate`'s notices for a role that does not draft, an unverified identity and the throttle. Those notices are taken out of `SuggestStart`'s `StepBody` into `SuggestGateNotice`, which both pages render. On the chooser a person who does not draft sees the notice at the top, in place of the chapter list, so nobody walks two steps to learn they cannot draft.
- **The loader**, `lib/db/suggestChooser.ts`, reads the release's chapters as the dock's catalogue does (`getDockCatalogue`, `lib/db/content.ts:424`) and a chapter's outline as the reader does (`getChapterData`, `:298`). Nothing is stored. (As built, the chapters come from Book Home's cached loader, `getHomeData`, which groups them by part where the catalogue has no part; every chapter of the release, verified or not; § 36.)
- **Page.** RSC per request, `noindex`, at every width. Step 1 renders at every width too (spec 34 § 16).
- **Chrome.** The top bar's current is `improve`. The status bar reads `new suggestion · chapter 21` or `new suggestion`.
- **Elsewhere.** The reader's `Suggest a change` (`SectionActions.tsx`) still goes straight to step 1.

### 10.2 The landing page (`/[lang]/improve`, spec 35 § 3)

- **`New suggestion`**, a `Button` to `/[lang]/improve/new` in the head beside the rubric's link, for every visitor, as A11 asks: the chooser says to a reader, a builder, an organisation admin, an unverified or a throttled contributor why they cannot draft (§ 10.1), and a signed-out visitor goes to sign-in. The help line under **Your suggestions** becomes "Use New suggestion, or Suggest a change on a section of the book". It now reads "open a section and use Suggest a change" (`messages/en.json:1269`).
- **`From a research`**, a section for any signed-in person with unused findings, right under the heading, before **Proposals from your questions**. Its `.tbl` lists each `VALID` finding whose run's text is held, newest first, with four columns:
  - the research: its label (§ 11.4) and the run's day, a link to `/[lang]/research?research=<conversationId>#run-<runId>`;
  - the anchor's id and its section's title;
  - the change kind;
  - the finding's button by role, or its line (§ 8.1), and after a send the same follow (§ 8.3).

  Under the table: `findings are kept with their research for 30 days`. A throttled contributor sees the throttle notice once above the table and no buttons.
- **The head's anchor link** `From a research` (`#from-research`) shows where the section does. A person with no unused finding sees neither the section nor the link.
- **The data**, `unusedFindingsOf(user)` in `lib/db/research.ts`, inside the person's tenant, is added to `getImproveHome`.

### 10.3 The research log (`/[lang]/improve/research`, spec 43 § 7)

The month table is built from the `RESEARCH` records (`researchMonthsOf`, `lib/improve/researchLog.ts:37`). A new run's record holds only `INVALID` and `VALID` findings (§ 15), so the table changes in unit 74:

- **Three columns added**:
  - `refused`: the records that planned `"refused"`;
  - `valid`: the findings `VALID` in the records;
  - `sent`: the month's `SUBMITTED` records of origin `RESEARCHER`, read by the same `select` by kind (`lib/db/researchLog.ts:28`).
- **`duplicate`, `refuted` and `proposed`** keep reading the records, which only legacy runs fill. They read the legacy runs still finishing, then zero. A sent finding's fate shows in the list **Refuted and declined**, which reads the researcher suggestions closed in the month, and in the queue.
- Nothing in it names who asked or who sent: a researcher proposal's records are `service:researcher`'s.
- Strings: `improve.researchLog.months.refused`, `valid`, `sent` (§ 19).

## 11. The Research page (`/[lang]/research`)

### 11.1 The route and its URL

`app/[lang]/research/page.tsx`, RSC, per request (`force-dynamic`, as the Assistant's page). `lib/research/links.ts` holds `researchPageHref`, `researchPageStateOf` and `researchRefHref` (§ 11.3), the pattern of `lib/assistant/links.ts`, with each parameter left out at its default.

| Parameter | Values | Meaning |
|---|---|---|
| `research` | absent, `1`, or a conversation's id | the open research. Absent and `1` are the empty column, ready for a question. On every other page the same parameter is the Research dock's (§ 12), as `ask` is the Assistant's |
| `from` | an Assistant message's id | the seed (A6): the composer prefilled with its question, and the seed card. Only with no open research |
| `w` | `month` (default), `all` | the statistics' window |
| `n` | 20 (default) to 200, in steps of 20 | how many conversations are listed (`CONVERSATIONS_PAGE`, `CONVERSATIONS_MAX`) |
| `view` | absent, `conversations`, `stats` | under 1000px, which region is in front |
| `deleted` | a conversation's id | reached by a delete (§ 11.8) |

A foreign or unknown id is the empty column with the parameter dropped. A `from` that is not the caller's answered turn with its text held is dropped, with a notice (§ 18).

**Signed out**, the page is the top bar and the sign-in notice returning to the same URL, as the Assistant's page.

### 11.2 Layout at each width

```
TopBar  current="research"
main.assistant-page.research-page[aria-label="Research"]   232px · minmax(0, 1fr) · 330px; each region scrolls on its own
  nav.assistant-conversations[aria-label="Your researches"]         § 11.4
  ResearchDock variant="page"                                       § 11.3: the column, its content at most 680px, centred
  aside.assistant-stats  ResearchStatsPanel + the budget meter      § 11.6
StatusBar  "research · {n} conversations" · "{k} of 30 today" · "release {id}"
```

| Width | Layout |
|---|---|
| ≥ 1360px | three columns, as above |
| 1000–1359px | two columns, the research column and the statistics; the conversations open over the page from the column header's toggle |
| < 1000px | one column, with the region switch `nav.assistant-views` (`Research`, `Conversations`, `Statistics`) |
| < 768px | the same one column and switch. The research column renders and is usable at 390px, as the Assistant's page is (spec 26 D4, option A). The dock elsewhere does not render (§ 12) |

The page reuses the Assistant page's layout classes as they are: `.assistant-page` and its `[data-view]`, `.assistant-conversations`, `.assistant-stats`, `.assistant-views`. Each describes a region of a three-column page, not the agent. `.research-page` is the one modifier, and it only sets the column's frame line (§ 11.3). The column keeps `.dock`, which the page's layout rules read, with `data-dock="research"` (§ 12).

### 11.3 The column (`ResearchDock`, `variant="page"`)

```
.inst-h   Research · reads the web · release 2026.09 · guide researcher v2.0          [conversations · 7]
.cap      not part of the book · from the web · checked by code, not by Improve
.dock-log[role="log"][aria-live="polite"]
  article.run#run-<id>  (one per run, oldest first; aria-label "research {n}")
    .turn-you      cap "you · 10:31"   the question
    .run-body
      cap   "research · 10:31 · 2 min 14 s"
      .research-line  research · reading the web                        (aria-atomic; its words change once a state)
      ol.run-steps[aria-live="off"]   caption "steps · 3 searches · 4 pages" · planning · sections 21.3, 21.4 · search "…" · 6 results · read stripe.com · Idempotent requests · …
      .run-report[aria-live="off"]    the paragraphs; a section as a Cite chip, a page as [3]; header "report · from the web, not from the book"
      .inst.run-pages[aria-live="off"] "pages read · 23 · 4 opened"   ol: 1 docs.stripe.com · Idempotent requests · opened  …
      .run-findings[aria-live="off"]  .finding (×≤3) "finding 1 of 2 · a proposed change to the book"   anchor chip · class · ChangeTable · sources (hosts)
                      · the researcher's note (cap, and "written from the pages it read")   · the button by role, or its line (§ 8.1)
      .row.run-actions   Copy report · Flag this report · cost US$ 0.61 · 3 searches · 4 pages opened
  [the seed card, before the first question of a seeded research]
  [Empty: "Ask what the book should know from outside it"]
form.dock-ask  Composer namespace="research.composer": Research question · EN/PT · help · Start
```

- **The run's line** is the existing `.research-line` form, an `.inst-f` mono line with a `.st.st-plain` mark. Its words are § 18's, and they change once a state: the counts that grow during the read are in the steps' caption, not in the line (§ 20).
- **The steps** are a compact ordered list under the line, open while the run is under way and folded into `steps · 14` when it ends.
- **The report, the pages and the findings** are rendered as empty containers from the run block's first render, `aria-live="off"`, and filled when the run has them, so a screen reader is not read twenty-three page rows at the end (§ 20).
- **The pages** are numbered as the report cites them. Each row is a link, in a new tab, with `rel="noopener noreferrer nofollow"` and `referrerpolicy="no-referrer"`, and it reads the host, the title (or the address where there is none), `opened` or `in search 2`, and the visually hidden `opens in a new tab`. The row's id is `run-<runId>-page-<n>`: every run of a conversation is one log and numbers its pages from 1, so an id of the page number alone would repeat in any research with a follow-up and send run 2's `[3]` to run 1's page.
- **Links into the book.** A section in a research (a report's chip, a finding's anchor, a refusal's pointer) links through `researchRefHref`: on the Research page `/[lang]/ch/NN/NN.k`, with no dock parameter; in the Research dock `/[lang]/ch/NN/NN.k?research=<id>`, so the dock stays open there; any other id `/[lang]/ref/<id>`. The Assistant's `refHref` adds `?ask=` (`lib/assistant/links.ts:18-24`) and would open the Assistant's dock on a research's link.
- **A refused run** is the Assistant's `RefusalCard` in place of the body (§ 11.5).
- **A run that failed or stopped** shows its line, its steps, and what it has (§ 7.2). A failure's code is never shown (spec 43 D10).
- **A stale run** (§ 6) reads `research · stopped · no answer from the engine`, with what it has.
- **A run whose text was purged** (§ 17.1) keeps its line, from the counts the row keeps (`research · done · 2 findings · 4 pages opened`, the pages read no longer known), and its `you · {time}` row reads `its words were removed after 30 days`. It has no question, no steps, no report and no pages, and each finding is its outcome's line alone (`sent · proposed`, `drafted · S-21-0042`, and for one never used, the purged sentence).
- **The composer** is disabled while signed out, at the day's limit (`30 researches today · the next at 14:05`), at the remembered cap (`your budget is spent · resets 01 Nov`), with the organisation's switch off, and when research is unavailable (the engine unconfigured). **While a run of the conversation is under way** it is not disabled but busy: the field stays focusable and read-only, and only `Start` is disabled, with `a research is under way in this conversation`. The `Composer` disables its own textarea when disabled (`components/assistant/Composer.tsx:106`), and a disabled field loses the focus that § 20 keeps there.
- **Starting a run.** The first Start creates the conversation (`POST /research/conversations`, with `seedMessageId` when seeded) and puts its id on the URL by `replaceState`, as the Assistant's dock does (`AssistantDock.tsx:285-307`). It then posts the run with an `Idempotency-Key` kept across retries of one body, and refreshes the router once the run is under way, so the list and the statistics move.
- **The seed card** (`?from=`) is an `.inst`. It reads `from the Assistant · answer of 12 Oct · cites 21.3 · 21.4`, with a link to that conversation, the line `This research reads the answer and the sections it cited. Nothing is spent until you press Start.`, and the link `Start from scratch instead`, which drops `from`. The composer holds the answer's question, editable.
- **The empty column** names both starts: the composer, and `From an answer: under any answer in the Assistant, press Start a research`, with a link to `/[lang]/assistant`. The button is where an answer is read, and a second picker of answers here would repeat the Assistant's own conversations tree.

### 11.4 The conversations (`ResearchConversations`, new)

The Assistant's `ConversationsTree` is built on the Assistant's turn rows (`LogTurns` of `Turn`, its verdict key, its delete), so the research list is a component of its own. It uses the same classes and the same shape (spec 26 § 5).

```
nav.assistant-conversations
  .inst-h          .t "researches"                       .ts "{n} researches"
  a.btn            "New research"                         → /{locale}/research (keeps `w`)
  ol
    li  a.row → ?research=<id>                            aria-current on the open one
          label   "ch21 · ch20"  or "no sections"         (the chapters of its runs' sections; never the person's words: spec 23 D8)
          .meta   "12 Oct · 3 runs · 4 findings · 2 used · from an answer · text removed"
                  (the findings that passed, as a run's line counts them; `· {u} used` only when one was; each part whole)
        the open one only:
          ol      "r1 · 10:31 · done · 4 pages · 2 findings"   → #run-<id>
          .inst-f  Delete research
  a "Show 20 more"
```

`listResearchConversations(user, { limit })` and `researchConversationCounts(user)` are in `lib/db/research.ts`. A conversation created by its first question stands first, built from the column's own runs until the server lists it, as `lineOfTurns` does for the Assistant (`lib/assistant/summary.ts`).

### 11.5 Reused through props, and new

| Component | How |
|---|---|
| `Composer` | reused, with a `namespace` prop (`assistant.dock` or `research.composer`) and a `busy` prop (the field read-only, the submit disabled, § 11.3). The label, placeholder, submit, help, scope line, counter, language label and form label are the namespace's, and § 19 gives `research.composer` every key the component reads (`formLabel`, `ask`, `counter`, `placeholder`, `language`, `citesHelp`, `submit`, `scope`). `QUESTION_MAX` is the same 800 |
| `FlagButton` | reused, with `endpoint`, `readBack` and `namespace` props, the Assistant's own by default. Its `REASONS` gain a kind `report`, the answer's list (A9, "as answers"); its title is `title.<kind>` of the namespace and its body the namespace's `body`. `research.flag` holds every key (§ 19): today the dialog body says the flag enters the grader's calibration set (`assistant.flag.body`), which research does not have (§ 11.7) |
| `DeleteConversation` | reused, with `endpoint` and `namespace` props; `research.delete` holds every key it reads (`trigger`, `title`, `titleNone`, `body`, `export`, `cancel`, `confirm`, `failed`, `network`). `exportHref` is the research's export (§ 11.10). `streaming` and `settling` are never shown: the research delete never answers 409 (§ 17.2) |
| `RefusalCard` | reused, with two props: `hrefOf(sectionId)` in place of `basePath`, given `researchRefHref` (§ 11.3), and `foot`, the footer's text, `{code} · refused before any search`: the card's own `after` reads `refused after the answer`, which no research refusal is. The view's refusal is a `RefusalView` (`lib/assistant/turns.ts:61-66`: cause, code, pointers with their titles, `beforeRetrieval`). `R-SCOPE`, `R-SCOPE-OT` and `R-UNVERIFIED` keep the Assistant's words; `R-PERSONAL` gains `assistant.refusal.R-PERSONAL` and `assistant.refusal.cause.R-PERSONAL`, the two keys the card reads (`RefusalCard.tsx:36-39`) |
| `ProposalPanel` | reused under a sent finding that is `PROPOSED`, with a `context` prop, `answer` or `report`, for its header's `not part of the answer` / `not part of the report`, and `hrefOf` as the card's |
| `ChangeTable`, `Cite`, `CitationChip`, `EvidenceBadge`, `StatusMark`, `InstrumentPanel`, `ConfirmDialog`, `SignInNotice`, `ErrorBox`, `Empty`, `Button`, `BudgetInstrument` | as they are; a `CitationChip` in a research is given `researchRefHref` |
| `ResearchDock` (`variant` `page` or `dock`), `RunBlock`, `RunSteps`, `RunReport`, `RunPages`, `FindingCard`, `FindingAction`, `SeedCard`, `ResearchConversations`, `ResearchStatsPanel`, `ResearchMount`, `ResearchShortcut`, `StartResearch` | new, in `components/research/` (the folder map of code-standards gains it) |

Why `AssistantDock` is not made configurable: about seven of its ten parts of state are the modes' (the aid, the pair, the lab, the walk's steps and errors, the mode radio). None of them is research's, and a config object would thread a branch for research through each. The leaf components carry the seams that matter, and the shell is about 150 lines of a new component (code-standards: prefer deletion to abstraction; the third caller earns it).

### 11.6 The statistics (`ResearchStatsPanel`, A9)

`researchStats(user, window)` in `lib/db/researchStats.ts` reads the person's own rows inside their tenant. A cell with nothing reads `—`.

| Cell | Read from |
|---|---|
| `runs` · by end: done · refused · stopped · failed | the person's runs in their researches started in the window, with a workflow — runs, not researches, which the list counts (as built, § 33) |
| `cost` · total, and per run | the `BudgetLedger` rows whose `ref` is one of those runs (kinds `RESEARCH`, `EMBED`, `RERANK`), read inside the principal's context as the meter reads them; per run over the runs charged anything |
| `sources read` · searches · pages opened · pages seen | the runs' counts and the length of `found.read`, read in SQL |
| `findings` · passed the checks · turned into improvements · accepted | `VALID` and later outcomes; `DRAFTED` and sent; of those, the ones whose suggestion is `MERGED` (the drafts by the owner's own read, the sent ones by the door's read for the asker) |
| `flagged reports` | every run in their researches started in the window with a flag, a rule's refusal, which has no workflow, included |

Under the cells:

- the account's budget meter, with its new `research` row (§ 7.1);
- the retention line `research text is kept until {date}`, from the oldest held run, as the Assistant's statistics give it (`keptUntil`).

The window is the calendar month in UTC or all time. The page's refresh after a run ends moves the cells. Nothing else polls but the run's follow and a sent finding's (§ 6, § 8.3).

### 11.7 Flags (A9)

`Flag this report` sits on a run that ended `DONE` with a report. A refused run's card carries the refusal's quiet `Flag` instead.

- **Reasons.** The answer's list (`wrong_citation`, `missing_citation`, `wrong_number`, `should_refuse`, `other`; `FLAG_REASONS`, `lib/schemas/api.ts:221`), with research's labels for the first two: `a source does not say this` and `a statement has no source`. A refusal's list is `should_not_refuse`, `other`.
- **One flag a run**, and a second is 409 `FLAG_DUPLICATE`, read back from the run's view. No text.
- **Where it is read.** The flag lands on the run's own columns, and the person's statistics read it. `npm run research:metrics` and the dashboard read only views (`scripts/research-metrics.ts:10-14`; the dashboard's role has no grant on `ResearchRun`, which names who asked), so unit 70's migration adds a view `ResearchFlag`: the flag's day and reason, no person and no run id. It is granted to the dashboard's role in `infra/observability/init.sql`, and read by a statement of its own, `lib/metrics/sql/research/flags.sql`, as the month's flagged reports by reason.
- **No grader.** Research has no grader to calibrate, so a flag here is a quality label for the operator, not a calibration item. The dialog says so (`research.flag.body`, § 19).

### 11.8 Delete (spec 45 § 3, adapted)

- **The control.** `Delete research` is a quiet `btn btn-sm` in the open conversation's block of the list, never inside the row's link, and on the page only. It is not in the dock, for spec 45 § 10's reason: the dock's window-level `Esc`.
- **The dialog.** The shared `ConfirmDialog`. Its title names the chapters, as the row's label does. Its body says what goes and what stays (§ 19), and `Export JSONL first` links to the research's export (§ 11.10), as the Assistant's dialog does.
- **Enabled while a run is under way.** The delete detaches it (§ 17.2), so there is nothing to settle and no 409.
- **On 200 or 404** the page goes to `/[lang]/research?deleted=<id>`. The column's head shows a `role=status` line and focus moves to `New research`. Between 1000 and 1359px the list's overlay opens to show the line (spec 45 § 3.9, § 28).
- **Otherwise** an `ErrorBox` says what failed and the trace.

### 11.9 Copy report

`Copy report` puts the report's paragraphs with their `[n]` markers and the numbered list of the pages they cite on the clipboard. The status bar says `copied`, as `Copy with citations` does.

### 11.10 Export

`GET /api/v1/research/conversations/{id}/export` is the Assistant's conversation export for a research (`lib/api/endpoints/assistant.ts:312-370`; spec 17 § 6):

- **What it holds.** The conversation's `RESEARCH` records, signed, as JSONL: the records the ledger holds, never the words, which are the person's on screen and which `Copy report` carries. The Assistant's export is records alone too.
- **How they are found.** Each run with a workflow, by its record's step key (`researchRecordAt`). None: `NOTHING_TO_EXPORT`, as the Assistant's, which the catalogue answers 404 (as built, § 33).
- **The record of it.** An `EXPORT` record by the person, scope `{ kind: "research", id }`. `EXPORT_SCOPE_KINDS` gains `research` (`lib/schemas/ledger.ts:131`) in unit 68.
- **Its limits.** `EXPORT_RATE`, 10 a minute. No key, no export (`LEDGER_EXPORT_KEY`), as the Assistant's.
- **Where it is offered.** The delete dialog's `Export JSONL first`, and the list's open block beside `Delete research`.

## 12. The Research dock and the header

**The header (A10).** `NAV` becomes `book`, `assistant`, `research` (`/research`), `improve`, `labs` (`TopBar.tsx:12-18`), and `chrome.nav.research` is `Research` / `Pesquisa`. The research page sets `current="research"`.

**The dock on every page (A9).**

- **The slot.** The `@assistant` slot's two pages (`app/[lang]/@assistant/page.tsx`, `[...rest]/page.tsx`) render `ResearchMount` beside `AssistantMount`. The slot keeps its name, since renaming it would move every file of the slot for no behaviour. Architecture § 3.2's row says it holds both docks.
- **Whose parameter is whose.** Three parameters are a dock's on some paths and a page's own state on others:

  | Parameter | A dock's | A page's own |
  |---|---|---|
  | `ask`, with `draft` | the Assistant dock's, on every path but `/assistant` | `/assistant`'s open conversation (`app/[lang]/assistant/page.tsx`) |
  | `research` | the Research dock's, on every path but `/research` | `/research`'s open research (§ 11.1) |
  | `from` | never a dock's | `/research`'s seed; step 1's and `/rubric`'s way back (`app/[lang]/ch/[n]/improve/new/page.tsx:40`, `app/[lang]/rubric/page.tsx:39`) |

- **The rules that follow.**
  - Opening the Research dock (`r`, or a link) drops `ask` and `draft` unless the path is `/assistant`, and touches nothing else. On `/assistant` it opens over the page, and the page keeps its conversation.
  - Opening the Assistant dock (`a`) drops `research` unless the path is `/research`. On `/research` it opens over the page, and the page keeps its research. `AskShortcut` already drops `ask` and `draft` before it adds `ask=1` (`AskShortcut.tsx:51-53`); it gains the `research` rule.
  - No key drops `from`.
  - One dock at a time: `ResearchMount` renders its dock only when the Assistant's dock is not open, which means `ask` is absent or the path is `/assistant`, where `ask` is the page's (`AssistantMount.tsx:46`). A hand-made URL with both dock parameters shows the Assistant's.
- **Not on its own page.** On `/research`, which holds its own column, and on sign-in and sign-out, `ResearchMount` renders the key alone, as `AssistantMount` does on `/assistant`.
- **The key** is `r` (D4). `resolveKeyAction` gains `research`, with the keyboard map's guards: no modifier, not while typing, not after `g` (`lib/hooks/useKeyboardMap.ts`). `ResearchShortcut` is `AskShortcut`'s pattern. With a Research dock or the Research page's column on the page, `r` focuses its question; otherwise it opens the dock where the person is.
- **Each key finds its own dock.** Both docks and the Research page's column keep the class `.dock` and gain `data-dock="assistant"` or `data-dock="research"`. `AskShortcut` today finds any `.dock` and focuses its `.dock-textarea` (`AskShortcut.tsx:46-50`), so from the moment the Research page's column carries `.dock` (unit 72), `a` there would write into the research composer. The attribute and `AskShortcut`'s query `.dock[data-dock="assistant"]` therefore ship in unit 72 with the page, not with the dock. `a` with the research dock open opens the Assistant's in its place, and `r` likewise.
- **The help dialog's rows** gain `r · research` (`components/chrome/KeyboardMap.tsx:33`), with the key `reader.keys.research`.
- **The form.** `ResearchDock variant="dock"` is the overlay form at every width from 768px, beside a reader section too. The reader's grid makes room for the Assistant because its answers highlight the passages they cite (`dispatchCited`). Research does not, and an overlay leaves the reader's grid as it is.
- **What it holds.** The open research's runs, the composer, the header's `Open the Research page` (`?research=<id>` there) and close. `Esc` closes it, as the Assistant's dock (`AssistantDock.tsx:244-255`). There is no list of earlier researches: the page holds the list.
- **Under 768px** it does not render, and `.dock-phone` says so with a link to the Research page, as `AssistantMount` does (`:101-110`).
- **Signed out** it shows the sign-in notice with the form disabled.

## 13. The API

All under `/api/v1/research`. Every endpoint has the pipeline's session check, same-origin check on writes, rate limit, policy and tenant context. Every one is registered in `ALL_ENDPOINTS` and in the OpenAPI document, with a contract test. Bodies and answers are zod schemas in `lib/schemas/api.ts`, under the names below.

| Endpoint | Body | Answers | Errors | Rate | Idempotency |
|---|---|---|---|---|---|
| `POST /research/conversations` | `{ locale, seedMessageId? }` | `201 ResearchConversationSchema { id, locale, seed, createdAt }` | 422 `SEED_INVALID` (not the caller's answered, unpurged `ASSISTANT` message; another's reads as invalid, never as existing) | 30/min (`CREATE_RATE`) | none, as the Assistant's create |
| `GET /research/conversations/{id}` | — | `200 ResearchConversationViewSchema` (its runs' views) | 404 | 60/min (`READ_RATE`) | — |
| `POST /research/conversations/{id}/runs` | `{ question, language }` | `202 { runId, state }`, `state` `QUEUED` or `REFUSED`; no text in the answer, so a stored response holds none | 400 `TEXT_TOO_LONG`, 404, 409 `RESEARCH_IN_PROGRESS`, 403 `ACCOUNT_DELETION_REQUESTED`, 403 `RESEARCH_OFF_ORGANISATION` (D2), 402 `BUDGET_EXCEEDED { resetsAt }`, 429 `RESEARCH_DAILY_LIMIT { resetsAt }`, 503 `RESEARCH_UNAVAILABLE` | 20/min (`ASK_RATE`: one run is several model calls) | `Idempotency-Key` required; the stored first answer replayed for 24 h |
| `GET /research/runs/{id}` | — | `200 ResearchRunViewSchema` (§ 16) | 404 | 60/min | — |
| `POST /research/runs/{id}/flag` | `{ kind: "report" \| "refusal", reason }` | `200 { runId, kind, reason, at }` | 404; 409 `FLAG_DUPLICATE`; 422 `UNPROCESSABLE` (a run with no report or refusal, or a kind that contradicts the run) | 10/min (`FLAG_RATE`) | none: a second flag is a 409 |
| `DELETE /research/conversations/{id}` | — | `200 { id, deleted: true, ledgerSeq }` | 404 | 30/min, its own bucket (as spec 45 D7) | none: idempotent by construction |
| `GET /research/conversations/{id}/export` | — | `200` signed JSONL (§ 11.10) | 404; `NOTHING_TO_EXPORT` (the catalogue's 404, § 33) | 10/min (`EXPORT_RATE`) | — |
| `POST /research/findings/{id}/draft` | `{ locale }` | `201 { suggestionId, href, items }` | 403 `ROLE_REQUIRED` and the policy's, 404, 409 `FINDING_USED`, 409 `FINDING_PURGED`, 409 `PROPOSAL_DUPLICATE { suggestionId \| null }`, 422 `ANCHOR_UNKNOWN`, 429 `SUGGESTION_THROTTLED` | 20/day, the bucket of `POST /api/v1/suggestions` | `Idempotency-Key` required |
| `POST /research/findings/{id}/propose` | `{}` | `202 { findingId, use: "SENDING" }` | 403 (a verified contributor, the policy), 404, 409 `FINDING_USED`, 409 `FINDING_PURGED`, 409 `PROPOSAL_DUPLICATE { suggestionId \| null }`, 422 `ANCHOR_UNKNOWN`, 429 `RESEARCH_SENDS_LIMIT { resetsAt }` (D5), 503 `RESEARCH_UNAVAILABLE` (proposals not configured), 503 `WORKFLOWS_UNAVAILABLE` | 20/day, its own bucket | `Idempotency-Key` required |

- **New codes in `lib/api/errors.ts`:** `RESEARCH_IN_PROGRESS` 409, `ACCOUNT_DELETION_REQUESTED` 403, `RESEARCH_OFF_ORGANISATION` 403, `RESEARCH_DAILY_LIMIT` 429, `RESEARCH_UNAVAILABLE` 503, `SEED_INVALID` 422, `FINDING_USED` 409, `FINDING_PURGED` 409, `PROPOSAL_DUPLICATE` 409, `RESEARCH_SENDS_LIMIT` 429 (D5). Each has a message in the person's language naming the fix, under `api.errors` (§ 19).
- **The draft answers no 503.** A grading that fails to start removes its item and the draft stands (§ 8.2 step 8).
- **Unchanged:** `GET /api/v1/assistant/messages/{id}/research` (legacy runs) and the endorse endpoints (spec 42 § 6). The latter now also serve a sent finding's asker.

## 14. The policy (`policies/hb/research.rego`, with `policies/tests/research_test.rego`)

`ResourceKindSchema` gains `research` (a conversation or one of its runs: the asker's own rows) and `finding` (`lib/policy/input.ts`). The resources are built with `ownResource`, so the owner is the caller by construction, and the tenant filter makes another's row absent: a 404, never a 403 (spec 15's rule).

```rego
# A person opens a research of their own.
permitted if { input.resource.kind == "research"; input.action == "create"; input.subject.kind == "user" }

# Its owner reads it, starts a run in it, flags a run of it, exports it and deletes it; nobody else.
permitted if {
  input.resource.kind == "research"
  input.action in {"read", "list", "ask", "write", "export", "delete"}
  input.subject.kind == "user"
  input.resource.ownerId == input.subject.id
}

# Its owner sends a finding as a researcher's proposal, unless they draft (A4): a verified contributor or curator.
permitted if {
  input.resource.kind == "finding"
  input.action == "submit"
  input.subject.kind == "user"
  input.resource.ownerId == input.subject.id
  not drafts_findings
}
drafts_findings if { has_role("CONTRIBUTOR"); verified }

# No service identity reads or writes either kind (invariant 13).
agent_denied if { is_service; input.resource.kind in {"research", "finding"} }
```

**The draft path** asks the existing `create` on `suggestion` (contributor and verified, `improve.rego:37-42`). The finding's ownership is the tenant filter's.

**Deny cases tested:**

- `research`: another person; anonymous; a service; an organisation admin on a member's research.
- `finding`: a verified contributor's `submit`; a verified curator's; another person's; a service.

The sidecar is restarted after `opa test policies`.

## 15. The ledger

**`RESEARCH`, one a run** that reached the planner, written by `concludeRun` once by its step key, `stepKeyOf("research:<runId>", "research:1")`. A run refused by rule at start has none, as a turn skipped before any workflow had none. What a person's run's record names now:

- **Actor:** `user:<id>`, the person who started it, as the `ANSWER` record's actor is the reader (`workers/answer/turn.ts:233`). The person asked for this research and paid for it, so the record is theirs, as an answer's is. `RECORD_RULES.RESEARCH.actors` becomes `["service:researcher", "user"]` (`lib/schemas/ledger.ts:517`). A legacy record keeps `service:researcher`.
- **Its calls, read where they were charged.** Today `recordResearch` returns null without `RESEARCH_PRINCIPAL` and reads the run's calls under it (`workers/research/record.ts:39`, `:68-75`; `researchCallsOf`, `lib/db/budget.ts:99-101`). A person's run's calls are under the person's principal, so `concludeRun` reads them there, from the run's `organisationId` and `userId`, and needs no research principal.
- **The reader's calls and the writer's.** Both are kind `RESEARCH` on `hb-frontier`, and `BudgetLedger` has no column for the request row (`prisma/schema.prisma:589-614`), so `modelCallOf(calls, "hb-frontier")` cannot tell them apart. The run's `writingAt` does: the writer's calls are the `hb-frontier` rows from that instant, the reader's those before it (`lib/research/record.ts` gains the split).
- **New optional members** of the strict payload:
  - `conversationId` (uuid);
  - `questionSha256`: the run's own column, the sha256 of the normalised question (§ 4.2). It is the same hash on the row and on the record, so an auditor can match them. It differs from the `ANSWER` record's, which hashes the question as stored (`turn.ts:252`); the name is the same and the definition is stated in the schema's comment;
  - `reportSha256` (sha256 or null);
  - `refusal` (`R-SCOPE` | `R-PERSONAL` | null): the hyphenated cause, an enum member;
  - `models.writer` (a model id or null).
- **Widened enums and rules:**
  - `planned` gains `"refused"`;
  - `end.state` gains `"REFUSED"`, with a code that matches `CODE_PATTERN` (`/^[A-Z][A-Z0-9_]{0,63}$/`, `lib/schemas/research.ts:52`), which has no hyphen: `R_SCOPE` or `R_PERSONAL`, the cause with its hyphens as underscores. The cause itself travels in `refusal`. Written as the cause, the code would make `ResearchEndSchema` refuse the payload (`lib/schemas/ledger.ts:408-410`), `append` would throw `LEDGER_PAYLOAD`, and `concludeRun` would fail for every refused run. Passed through today's `runEndOf`, it would become `INTERNAL` without a word (`lib/research/record.ts:24-28`). `runEndOf` gains the `REFUSED` case, and the `research.run` line carries the same code;
  - the findings' outcomes gain `VALID` and `DRAFTED`. At the end of a run only `INVALID` and `VALID` appear: what a person later does with a finding is the draft's or the researcher proposal's own record, not the run's.
- **What it still never names:** a suggestion or a message. The existing refine, "a brief and a reader go with a run that planned one", stands. `lib/schemas/ledger.test.ts`'s payload walk takes the new members, and a refused record.

**`ERASED`, on a research conversation's delete**:

- the payload's `scope.kind` gains `"research"`: `{ stepKey, scope: { kind: "research", id } }`, its step key `stepKeyOf("research:<id>", "erased")`;
- appended by the endpoint after the delete commits, looked for by its step key first, `ledgerSeq: null` when the append fails (spec 45 § 3.7, unchanged);
- since the person's `RESEARCH` records name the conversation's id, the record adds no new fact about them.

**`EXPORT`** gains the scope kind `research` (§ 11.10).

**The audit pack.** In `lib/schemas/audit.ts`, the `answers` checkbox selects `["ANSWER", "RESEARCH", "ERASED"]`, and its label becomes `assistant and research records, and deletions` (as unit 71's review set it, § 31: the `ERASED` records stay under it). An account's pack selects by actor (spec 38 § 3), so it takes the person's research records and never a legacy one.

## 16. What reaches the client, and what never does

**`ResearchRunViewSchema`**, the run endpoint's answer and each run of the conversation's view:

```ts
{ id, conversationId, ordinal,
  question: string | null,                          // null once purged
  language: "en" | "pt", seeded: boolean,           // seeded: the seeded run of a seeded research (no earlier run planned, § 31)
  state, line: { key, tone }, stale: boolean,       // the line's words, § 18; stale: under way past 90 minutes (§ 6)
  refusal: { cause, code, pointers: [{ sectionId, title }], beforeRetrieval: true } | null,   // a RefusalView
  resetsAt: string | null,                          // a run that met the cap
  steps: [{ seq, kind, at, query?, results?, url?, title?, opened?, sections? }],
  sections: [{ id, title }],                        // the targets
  report: { paragraphs: [{ text, sections: SectionId[], pages: number[] }] } | null,
  pages: [{ n, url, host, title: string | null, opened: boolean, search: number | null }],
  findings: [{ id, n,                               // n: 1 to the number that passed, never the reader's ordinal
               textPurged: boolean,
               anchor: { kind, id, section, title } | null, changeKind: string | null, changeClass: string | null, curatorReason: string | null,
               change: { before, after } | null, sources: [{ url, host }] | null, note: string | null,   // null once purged
               use: { state: "VALID" | "DRAFTED" | "SENT" | "DUPLICATE" | "PROPOSED" | "REFUTED",
                      suggestionId: string | null, href: string | null, failure: string | null },     // a DUPLICATE's id by § 8.5's rule
               proposal: ProposalView | null }],    // a PROPOSED one's panel (spec 43 § 5.3)
  usage: { searches, pagesOpened, pagesSeen: number | null, costUsd: string | null },
  flag: { kind, reason } | null,
  createdAt, finishedAt: string | null, textPurged: boolean }
```

- Before the reader answers, `pages` are built from the steps. Afterwards they come from `found.read`, the turn's own list. Once the text is purged they are empty and `pagesSeen` is null.
- `SENT` is a `SUBMITTED` finding with its suggestion. `sending` is never the server's word: it is the client's own after a 202 (§ 8.3).
- `failure` is one of the finding's codes (§ 8.1): a code chosen from a closed list that names the person's next step, not a failure of the run.

**Never sent to any client:**

- `INVALID` findings and their reasons, the reader's ordinals, and the number of findings checked (A7);
- the brief;
- the reader's notes on the pages;
- the seed answer's uncovered sentences;
- the planner's or the writer's raw output and dropped paragraphs;
- a run's failure code (words only, spec 43 D10);
- the workflow's id;
- a duplicate's id that is not the person's to see (§ 8.5);
- anything of another person.

A test walks every research endpoint's response schema for `brief`, `says`, `notes`, `uncovered`, `invalidReason` and `ordinal` on a finding, and finds none, the pattern of `tests/research-contract.test.ts`.

**What changes from spec 43 § 5.2:** "the run's spend" is now shown, as `usage.costUsd` and in the statistics, because it is the person's own money (A3, A9).

## 17. Retention and deletion

### 17.1 The 30 days (A9)

`purgeResearchRuns` in `lib/db/research.ts` is called by `scripts/assistant-purge.ts` after `purgeAssistantText`, with the same `reader` option. It walks the owners of runs with text older than `TEXT_RETENTION_DAYS` (30) through an owner statement of its own, registered in `RAW_SQL.md`.

- **What it nulls**, on each run of a research conversation **whose own `createdAt`** is older than `TEXT_RETENTION_DAYS`: `question`, `brief`, `found`, `steps` and `report`. It stamps the run's `textPurgedAt`. A follow-up asked yesterday in a research opened 31 days ago keeps its text, its report and its unused findings.
- **What it keeps:** the states, the counts, the anchors, the hashes, the flags, the findings' outcomes, and the conversation's own row.
- **The conversation's `textPurgedAt`** is stamped only once every run of it is purged.

A finding whose run's text is gone can no longer be drafted or sent, since its proposal and sources are gone. Its row says what became of it, and the block renders it as § 11.3 says.

The legacy purge, `purgeResearchText` by message ids, runs unchanged for the legacy rows.

### 17.2 Deleting a research conversation

`deleteResearchConversation(user, id, now)` in `lib/db/research.ts` is one interactive transaction inside the person's `withTenant`, in this order:

1. **Lock** the conversation row: `SELECT "id" FROM "ResearchConversation" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, registered in `RAW_SQL.md`. No row: `NOT_FOUND`. A start takes the same lock (§ 5.2), and a run's insert takes `FOR KEY SHARE` on it, so a start racing the delete waits, then fails on the missing row and answers 404 (spec 45 § 3.3's reasoning).
2. **Runs with a workflow** are detached and lose their text:
   - `conversationId` null;
   - `question`, `brief`, `found`, `steps` and `report` null;
   - the flag's two columns null;
   - `textPurgedAt` stamped where it is null.

   Their state is not touched. A run still under way ends `SKIPPED · TEXT_PURGED` at its next step, and what it already spent stays spent. The row is the 30-a-day tally until 24 hours after it started (spec 45 D9).
3. **Runs without a workflow** (refused by rule) go by the cascade.
4. **The conversation** is deleted.

**Stored responses.** Nothing of the conversation sits in a stored idempotent response, because none of the research endpoints' answers holds text or an address: the start's `{ runId, state }`, the draft's `{ suggestionId, href, items }`, the send's `{ findingId, use }` (§ 13). The delete forgets none, needs no settle rule, and never answers 409.

**The sweep** (`sweepDetachedRuns`, spec 45 § 3.5) changes in unit 70, before the first run of a conversation is written:

- **Its predicate** becomes "detached": `"messageId" IS NULL AND "conversationId" IS NULL`, in its owner statement and its reads. As built it reads `"messageId" IS NULL` alone (`lib/db/research.ts:535`, `:540`), which every new run matches. It would delete a person's live research once its workflow ended and 24 hours passed.
- **It keeps more findings.** Before a run goes it detaches, besides the `PROPOSED` findings that name a suggestion (`:549`), the `SUBMITTED` findings whose `finding:<id>` workflow the engine says is running, since it may still be waiting for the outcome (up to 40 days). The engine is asked as it is asked of the run's own workflow, and an engine that cannot be reached stops the step for the night.
- **It ends what it kept.** A second pass deletes detached findings that are no proposal of the asker's: `REFUTED` and `DUPLICATE` ones, and `SUBMITTED` ones whose workflow no longer runs. `SendFindingWorkflow` also deletes a detached finding it turns `REFUTED` (§ 8.4). So a research the person deleted keeps no link from them to a suggestion, except a proposal's, which spec 45 § 3.6 keeps on purpose.
- **A finding pressed just before the delete** whose `sendFinding` had not run finds its run's `found` gone and ends `TEXT_PURGED` (§ 8.4); the sweep takes it with its run.

**What stays after a delete:**

- every ledger record;
- the `BudgetLedger` rows;
- a draft made from a finding, which is the person's own suggestion;
- a finding already sent and made a suggestion, under **Improve · Proposals from your questions** once proposed, with `Remove my name` until the merge (spec 45 § 3.6).

## 18. States and errors

**The run's line** (`.research-line`; `research ·` then the word as a status mark, then the detail):

| The run | Mark | EN | Note |
|---|---|---|---|
| `QUEUED` | run | `research · queued` | |
| `PLANNING` | run | `research · planning · reading the book` | retrieval, then the planner |
| `READING` | run | `research · reading the web` | the counts are in the steps' caption (§ 11.3) |
| `VALIDATING` | run | `research · checking the findings` | no count (A7) |
| `WRITING` | run | `research · writing the report` | |
| `DONE` | ok | `research · done · {f} findings · {p} pages` | `no finding` when none passed |
| `REFUSED` | mute | `research · refused` | and the refusal card |
| `SKIPPED · BUDGET` | warn | `research · not started · your budget is spent · resets {date}` | no model answered |
| `FAILED · BUDGET` | warn | `research · stopped · your budget ran out · resets {date}` | what it has stays shown |
| `FAILED · *` | mute | `research · failed` | the code never shown; what it has stays shown |
| under way, stale (§ 6), or `FAILED · ABANDONED` | mute | `research · stopped · no answer from the engine` | the composer enabled |
| `SKIPPED · TEXT_PURGED` | mute | `research · stopped · its text was removed` | a delete mid-run, or the seed deleted before the plan |
| `SKIPPED · UNAVAILABLE` | mute | `research · not run` | the engine refused the start, or the gateway the planner |

**The page's and the endpoints' states:**

| State | What the person sees |
|---|---|
| signed out | the sign-in notice, the form disabled |
| research unavailable (no engine configured) | `Notice`: `Research is not available here: the workflow engine is not running`; the composer disabled |
| the organisation's switch off (D2) | `Notice`: `Research is off for your organisation`; the composer disabled |
| 30 today | the composer's help `30 researches today · the next at {time}`; disabled |
| budget remembered | `your budget is spent · resets {date}`, with `See the meter` → `/[lang]/account#budget` |
| a run under way | the composer busy: the field read-only, `Start` disabled, `a research is under way in this conversation` |
| `?from` invalid | `Notice`: `That answer cannot start a research: it was refused, deleted, or its words were removed after 30 days`; `from` dropped |
| a foreign `?research` | the empty column, the parameter dropped |
| start 503 | `ErrorBox`: `The research did not start`, the message, `Retry` (it posts what the field holds: the same key while the question is unchanged) |
| any start not answered 202 (unit 72's review) | the question back in the field with its language, never lost, and the `ErrorBox` with the message; a 402, a 429 or a 403 also closes the composer as the page would have, and the box takes the focus |
| a finding's 409 `FINDING_USED` | the finding's use read again and shown |
| a finding's 409 `PROPOSAL_DUPLICATE` | `already proposed as {id}`, or `already proposed in Improve` (§ 8.5) |
| a finding's 422 `ANCHOR_UNKNOWN` | `The book has changed at {anchor} since this research. Start a new research to look again.` |
| a finding's 409 `FINDING_PURGED` | `This finding's text was removed after 30 days.` |
| a finding's 429 throttled, or a throttled contributor | the step 1 throttle notice's words (`SuggestGateNotice`) |
| a send's 429 `RESEARCH_SENDS_LIMIT` (D5) | `30 findings sent this month · the next on {date}` |
| a send that ended `SENDS_LIMIT` in its transaction (a burst at the thirtieth; review of unit 74) | the same words, with the reset of the month the page is read in, and the button again (§ 8.1) |
| a send followed for a minute without an answer | `reload to follow` |
| a draft whose finding's sources are not all among its evidence | the edit page's rail: `{n} sources of the finding are not among your evidence: add them as links`, with the addresses |
| send confirmed, engine down (503) | the finding stays offered; `Improve could not take it now · try again later` |
| delete 200 / 404 | `?deleted=<id>`, `Done · Research deleted.` |
| delete other | `ErrorBox`: `The research was not deleted`, the trace |
| flag 409 | the stored reason read back and shown |

## 19. Strings

EN and PT candidates for Andre (rules § 4.6). New keys in `messages/en.json` and `messages/pt.json` together. "Improve" in PT is the top bar's own word, `Melhorar`.

| Key | EN | PT (candidate) |
|---|---|---|
| `chrome.nav.research` | Research | Pesquisa |
| `research.page.metaTitle` | Research · The Harness Bible | Pesquisa · The Harness Bible |
| `research.page.title` | Research | Pesquisa |
| `research.page.viewLabel` | Research page regions | Regiões da página de pesquisa |
| `research.page.viewResearch` / `viewConversations` / `viewStats` | Research / Conversations / Statistics | Pesquisa / Conversas / Estatísticas |
| `research.page.statusList` | research · {n, plural, one {# conversation} other {# conversations}} | pesquisa · {n, plural, one {# conversa} other {# conversas}} |
| `research.page.statusToday` | {n} of 30 today | {n} de 30 hoje |
| `research.dock.title` | Research | Pesquisa |
| `research.dock.reads` | reads the web | lê a web |
| `research.dock.frame` | not part of the book · from the web · checked by code, not by Improve | não faz parte do livro · da web · verificada por código, não pelo Melhorar |
| `research.dock.openFull` | Open the Research page | Abrir a página de pesquisa |
| `research.dock.close` | Close research | Fechar a pesquisa |
| `research.dock.phoneTitle` / `phoneBody` | Research needs a wider screen here · Open the Research page, which works on a phone. | A pesquisa precisa de uma tela maior aqui · Abra a página de pesquisa, que funciona no celular. |
| `research.dock.empty` | Ask what the book should know from outside it. | Pergunte o que o livro deveria saber de fora dele. |
| `research.dock.fromAnswer` | From an answer: under any answer in the Assistant, press Start a research. | A partir de uma resposta: em qualquer resposta do Assistente, use Iniciar uma pesquisa. |
| `research.composer.formLabel` | Start a research | Iniciar uma pesquisa |
| `research.composer.ask` | Research question | Pergunta de pesquisa |
| `research.composer.counter` | {n} / {max} | {n} / {max} |
| `research.composer.language` | language | idioma |
| `research.composer.placeholder` | e.g. what changed in prompt-caching prices since 21.3 was verified | ex.: o que mudou nos preços de cache de prompt desde que a 21.3 foi verificada |
| `research.composer.submit` | Start | Iniciar |
| `research.composer.citesHelp` | searches the web · spends your model budget | busca na web · gasta o seu orçamento de modelo |
| `research.composer.scope` | about the book only · it refuses what is not, as the Assistant does | só sobre o livro · recusa o que não for, como o Assistente |
| `research.composer.inProgress` | a research is under way in this conversation | uma pesquisa está em andamento nesta conversa |
| `research.composer.dailyLimit` | 30 researches today · the next at {time} | 30 pesquisas hoje · a próxima às {time} |
| `research.composer.budget` | your budget is spent · resets {date} | o seu orçamento acabou · reinicia em {date} |
| `research.seed.cap` | from the Assistant · answer of {date} · cites {sections} | do Assistente · resposta de {date} · cita {sections} |
| `research.seed.body` | This research reads the answer and the sections it cited. Nothing is spent until you press Start. | Esta pesquisa lê a resposta e as seções que ela citou. Nada é gasto até você apertar Iniciar. |
| `research.seed.scratch` | Start from scratch instead | Começar do zero |
| `research.seed.invalid` | That answer cannot start a research: it was refused, deleted, or its words were removed after 30 days. | Essa resposta não pode iniciar uma pesquisa: foi recusada, apagada, ou suas palavras foram removidas após 30 dias. |
| `research.seed.deleted` | from an answer that was deleted | de uma resposta que foi apagada |
| `research.run.you` | you · {time} | você · {time} |
| `research.run.cap` | research · {time} · {duration} | pesquisa · {time} · {duration} |
| `research.run.purged` | its words were removed after 30 days | as palavras foram removidas após 30 dias |
| `research.line.word.*` | queued · planning · reading · checking · writing · done · refused · not started · stopped · failed · not run | na fila · planejando · lendo · verificando · escrevendo · concluída · recusada · não iniciada · interrompida · falhou · não feita |
| `research.line.detail.planning` | reading the book | lendo o livro |
| `research.line.detail.reading` | the web | a web |
| `research.line.detail.checking` | the findings | as descobertas |
| `research.line.detail.writing` | writing the report | escrevendo o relatório |
| `research.line.detail.done` | {f, plural, =0 {no finding} one {# finding} other {# findings}} · {p, plural, one {# page} other {# pages}} | {f, plural, =0 {nenhuma descoberta} one {# descoberta} other {# descobertas}} · {p, plural, one {# página} other {# páginas}} |
| `research.line.detail.donePurged` | {f, plural, =0 {no finding} one {# finding} other {# findings}} · {o, plural, one {# page opened} other {# pages opened}} | {f, plural, =0 {nenhuma descoberta} one {# descoberta} other {# descobertas}} · {o, plural, one {# página aberta} other {# páginas abertas}} |
| `research.line.detail.notStarted` | your budget is spent · resets {date} | o seu orçamento acabou · reinicia em {date} |
| `research.line.detail.stopped` | your budget ran out · resets {date} | o seu orçamento acabou durante a pesquisa · reinicia em {date} |
| `research.line.detail.abandoned` | no answer from the engine | sem resposta do motor |
| `research.line.detail.purged` | its text was removed | o texto foi removido |
| `research.line.followLost` | still under way · reload to follow | ainda em andamento · recarregue para acompanhar |
| `research.steps.label` | steps | passos |
| `research.steps.caption` | steps · {s, plural, one {# search} other {# searches}} · {p, plural, one {# page} other {# pages}} | passos · {s, plural, one {# busca} other {# buscas}} · {p, plural, one {# página} other {# páginas}} |
| `research.steps.planning` | planning | planejando |
| `research.steps.sections` | sections {ids} | seções {ids} |
| `research.steps.searchPending` | search “{query}” | busca “{query}” |
| `research.steps.search` | search “{query}” · {n, plural, one {# result} other {# results}} | busca “{query}” · {n, plural, one {# resultado} other {# resultados}} |
| `research.steps.pagePending` | opening {host} | abrindo {host} |
| `research.steps.page` | read {host} · {title} | leu {host} · {title} |
| `research.steps.pageUntitled` | read {host} | leu {host} |
| `research.steps.unreachable` | {host} · did not open | {host} · não abriu |
| `research.steps.checking` | checking the findings | verificando as descobertas |
| `research.steps.writing` | writing | escrevendo |
| `research.report.cap` | report · from the web, not from the book · not checked by Improve | relatório · da web, não do livro · não verificado pelo Melhorar |
| `research.report.nothing` | The pages read say nothing the book does not already say. | As páginas lidas não dizem nada que o livro já não diga. |
| `research.pages.cap` | pages read · {n} · {opened} opened | páginas lidas · {n} · {opened} abertas |
| `research.pages.opened` | opened | aberta |
| `research.pages.inSearch` | in search {n} | na busca {n} |
| `research.pages.newTab` | opens in a new tab | abre em uma nova aba |
| `research.findings.cap` | finding {i} of {n} · a proposed change to the book | descoberta {i} de {n} · uma mudança proposta ao livro |
| `research.findings.checks` | it passed the code's checks; Improve and a curator decide | passou nas verificações do código; o Melhorar e um curador decidem |
| `research.findings.note` | researcher's note | nota do pesquisador |
| `research.findings.noteFrom` | written by the researcher from the pages it read | escrita pelo pesquisador a partir das páginas que leu |
| `research.findings.draft` | Draft it in Improve | Criar rascunho no Melhorar |
| `research.findings.draftHelp` | grades its sources on your model budget | avalia as fontes com o seu orçamento de modelo |
| `research.findings.send` | Send to Improve | Enviar ao Melhorar |
| `research.findings.sendTitle` | Send this finding to Improve? | Enviar esta descoberta ao Melhorar? |
| `research.findings.sendBody` | It becomes a researcher's proposal: Improve opens its sources, grades them, and a curator decides. Your question is not sent. If it is proposed, you can add your name. A submission is a record and is not taken back. | Ela vira uma proposta do pesquisador: o Melhorar abre as fontes, avalia-as, e um curador decide. A sua pergunta não é enviada. Se for proposta, você pode adicionar o seu nome. Um envio é um registro e não é desfeito. |
| `research.findings.sendConfirm` | Send | Enviar |
| `research.findings.sendCancel` | Cancel | Cancelar |
| `research.findings.drafted` | drafted · {id} | rascunho criado · {id} |
| `research.findings.openDraft` | Open draft | Abrir rascunho |
| `research.findings.sending` | sending to Improve | enviando ao Melhorar |
| `research.findings.followLost` | reload to follow | recarregue para acompanhar |
| `research.findings.sent` | sent · being checked by Improve | enviada · em verificação pelo Melhorar |
| `research.findings.proposed` | sent · proposed | enviada · proposta |
| `research.findings.refuted` | sent · not proposed | enviada · não proposta |
| `research.findings.duplicate` | already proposed as {id} | já proposta como {id} |
| `research.findings.duplicateHidden` | already proposed in Improve | já proposta no Melhorar |
| `research.findings.purged` | This finding's text was removed after 30 days. | O texto desta descoberta foi removido após 30 dias. |
| `research.findings.anchorGone` | The book has changed at {anchor} since this research. Start a new research to look again. | O livro mudou em {anchor} desde esta pesquisa. Inicie uma nova pesquisa para olhar de novo. |
| `research.findings.unconfigured` | could not be sent here · research proposals are not configured | não pôde ser enviada aqui · as propostas de pesquisa não estão configuradas |
| `research.findings.noRubric` | could not be sent · Improve has no rubric in force · try again later | não pôde ser enviada · o Melhorar não tem rubrica em vigor · tente de novo mais tarde |
| `research.findings.unreadable` | could not be sent · start a new research to look again | não pôde ser enviada · inicie uma nova pesquisa para olhar de novo |
| `research.findings.unavailable` | Improve could not take it now · try again later | o Melhorar não pôde recebê-la agora · tente de novo mais tarde |
| `research.findings.sendsLimit` | 30 findings sent this month · the next on {date} | 30 descobertas enviadas este mês · a próxima em {date} |
| `research.actions.copy` | Copy report | Copiar relatório |
| `research.actions.cost` | US$ {cost} · {s} searches · {p} pages opened | US$ {cost} · {s} buscas · {p} páginas abertas |
| `research.flag.report` | Flag this report | Sinalizar este relatório |
| `research.flag.refusal` | Flag this refusal | Sinalizar esta recusa |
| `research.flag.title.report` / `title.refusal` | Flag this report? · Flag this refusal? | Sinalizar este relatório? · Sinalizar esta recusa? |
| `research.flag.body` | The flag is a label for the operator, who reads flagged reports by reason. No text is sent. It is deleted with the research. | A sinalização é um rótulo para o operador, que lê os relatórios sinalizados por motivo. Nenhum texto é enviado. Ela é apagada com a pesquisa. |
| `research.flag.reason` | reason | motivo |
| `research.flag.reasons.wrong_citation` | a source does not say this | uma fonte não diz isto |
| `research.flag.reasons.missing_citation` | a statement has no source | uma afirmação não tem fonte |
| `research.flag.reasons.wrong_number` / `should_refuse` / `should_not_refuse` / `other` | wrong number · should have refused · should not have refused · other | número errado · deveria ter recusado · não deveria ter recusado · outro |
| `research.flag.confirm` / `cancel` | Flag · Cancel | Sinalizar · Cancelar |
| `research.flag.flagged` | flagged · {reason} | sinalizado · {reason} |
| `research.refusal.foot` | {code} · refused before any search | {code} · recusada antes de qualquer busca |
| `assistant.refusal.R-PERSONAL` | Research does not search the web about a person's or an organisation's own systems. Ask about what the book covers. | A pesquisa não busca na web sobre os sistemas de uma pessoa ou organização. Pergunte sobre o que o livro cobre. |
| `assistant.refusal.cause.R-PERSONAL` | scope · your own system | escopo · o seu próprio sistema |
| `research.list.title` | researches | pesquisas |
| `research.list.count` | {n, plural, one {# research} other {# researches}} | {n, plural, one {# pesquisa} other {# pesquisas}} |
| `research.list.new` | New research | Nova pesquisa |
| `research.list.noSections` | no sections | sem seções |
| `research.list.lineRuns` | {runs, plural, one {# run} other {# runs}} | {runs, plural, =0 {# execuções} one {# execução} other {# execuções}} |
| `research.list.lineFindings` | {f, plural, =0 {no finding} one {# finding} other {# findings}} | {f, plural, =0 {nenhuma descoberta} one {# descoberta} other {# descobertas}} |
| `research.list.lineUsed` (shown only when {u} > 0) | {u} used | {u, plural, one {# usada} other {# usadas}} |
| `research.list.seeded` | from an answer | de uma resposta |
| `research.list.purged` | text removed | texto removido |
| `research.list.run` | r{n} · {time} · {word} | p{n} · {time} · {word} |
| `research.list.runDone` | r{n} · {time} · {word} · {p, plural, one {# page} other {# pages}} · {f, plural, =0 {no finding} one {# finding} other {# findings}} | p{n} · {time} · {word} · {p, plural, one {# página} other {# páginas}} · {f, plural, =0 {nenhuma descoberta} one {# descoberta} other {# descobertas}} |
| `research.list.label` | Your researches | Suas pesquisas |
| `research.delete.trigger` | Delete research | Apagar pesquisa |
| `research.delete.title` / `titleNone` | Delete the research on {chapters}? · Delete this research? | Apagar a pesquisa sobre {chapters}? · Apagar esta pesquisa? |
| `research.delete.body` | Its questions, reports, pages and findings are deleted now. A research still running stops at its next step; what it already spent stays spent. A draft you made from a finding stays yours in Improve, and a finding Improve already took stays there, where you can remove your name until it is merged. The audit chain keeps one record per run, as hashes without words, and records this deletion. | As perguntas, os relatórios, as páginas e as descobertas são apagados agora. Uma pesquisa ainda em andamento para no próximo passo; o que já gastou continua gasto. Um rascunho que você criou a partir de uma descoberta continua seu no Melhorar, e uma descoberta que o Melhorar já recebeu continua lá, onde você pode remover seu nome até que seja incorporada. A cadeia de auditoria mantém um registro por execução, em hashes e sem palavras, e registra esta exclusão. |
| `research.delete.export` | Export JSONL first | Exportar o JSONL antes |
| `research.delete.cancel` / `confirm` | Cancel · Delete | Cancelar · Apagar |
| `research.delete.network` | The request did not reach the server. Nothing was deleted; try again. | A solicitação não chegou ao servidor. Nada foi apagado; tente novamente. |
| `research.delete.done` | Done · Research deleted. | Feito · Pesquisa apagada. |
| `research.delete.failed` | The research was not deleted | A pesquisa não foi apagada |
| `research.stats.title` | research statistics | estatísticas de pesquisa |
| `research.stats.runs` / `cost` / `sources` / `findings` / `flagged` | runs · cost · sources read · findings · flagged reports | execuções · custo · fontes lidas · descobertas · relatórios sinalizados |
| `research.stats.ends` | {done} done · {refused} refused · {stopped} stopped · {failed} failed | {done} concluídas · {refused} recusadas · {stopped} interrompidas · {failed} falharam |
| `research.stats.findingsLine` | {passed} passed the checks · {used} turned into improvements · {accepted} accepted | {passed} passaram nas verificações · {used} viraram melhorias · {accepted} aceitas |
| `research.stats.keptUntil` | research text is kept until {date} | o texto das pesquisas fica guardado até {date} |
| `research.errors.notStarted` | The research did not start | A pesquisa não começou |
| `research.notice.unavailable` | Research is not available here: the workflow engine is not running. | A pesquisa não está disponível aqui: o motor de workflows não está rodando. |
| `research.notice.offOrganisation` | Research is off for your organisation. | A pesquisa está desligada para a sua organização. |
| `research.edit.cap` | from your research | da sua pesquisa |
| `research.edit.note` | written by the researcher from the pages it read; it is not your rationale — the adjudicator reads only what you write | escrita pelo pesquisador a partir das páginas que leu; não é a sua justificativa — o adjudicador lê só o que você escreve |
| `research.edit.notAdded` | {n, plural, one {# source of the finding is} other {# sources of the finding are}} not among your evidence: add them as links | {n, plural, one {# fonte da descoberta não está} other {# fontes da descoberta não estão}} entre as suas evidências: adicione-as como links |
| `research.edit.prefilled` | prefilled by the researcher from the pages it read · read it before you submit | preenchida pelo pesquisador a partir das páginas que leu · leia antes de enviar |
| `reader.keys.research` | open research | abrir a pesquisa |
| `account.budget.research` | Research | Pesquisa |
| `account.budget.researchNote` | planner, reader and writer of your researches | planejador, leitor e redator das suas pesquisas |
| `assistant.dock.startResearch` | Start a research | Iniciar uma pesquisa |
| `improve.home.new` | New suggestion | Nova sugestão |
| `improve.home.fromResearch.title` | From a research | De uma pesquisa |
| `improve.home.fromResearch.research` / `anchor` / `kind` / `action` | research · anchor · change · action | pesquisa · âncora · mudança · ação |
| `improve.home.fromResearch.kept` | findings are kept with their research for 30 days | as descobertas ficam com a sua pesquisa por 30 dias |
| `improve.new.metaTitle` | New suggestion · Improve | Nova sugestão · Melhorar |
| `improve.new.title` | New suggestion | Nova sugestão |
| `improve.new.chapters` | Choose a chapter | Escolha um capítulo |
| `improve.new.sections` | Choose a section of chapter {n} | Escolha uma seção do capítulo {n} |
| `improve.new.back` | ← chapters | ← capítulos |
| `improve.new.statusbar` | new suggestion · chapter {n} | nova sugestão · capítulo {n} |
| `improve.history.class.fromResearch` (the queue's class line) | from research | da pesquisa |
| `improve.researchLog.months.refused` / `valid` / `sent` | refused · valid · sent | recusadas · válidas · enviadas |
| `api.errors.RESEARCH_IN_PROGRESS` | A research is under way in this conversation. Wait for it to end. | Uma pesquisa está em andamento nesta conversa. Espere que termine. |
| `api.errors.ACCOUNT_DELETION_REQUESTED` | This account is being deleted. Nothing new can be started. | Esta conta está sendo excluída. Nada novo pode ser iniciado. |
| `api.errors.RESEARCH_OFF_ORGANISATION` | Research is off for your organisation. Ask its admin. | A pesquisa está desligada para a sua organização. Fale com o administrador. |
| `api.errors.RESEARCH_DAILY_LIMIT` | 30 researches were started in the last 24 hours. Try again later. | 30 pesquisas foram iniciadas nas últimas 24 horas. Tente mais tarde. |
| `api.errors.RESEARCH_UNAVAILABLE` | Research is not available here now. Try again later. | A pesquisa não está disponível aqui agora. Tente mais tarde. |
| `api.errors.SEED_INVALID` | That answer cannot start a research. Start from scratch instead. | Essa resposta não pode iniciar uma pesquisa. Comece do zero. |
| `api.errors.FINDING_USED` | This finding was already used. | Esta descoberta já foi usada. |
| `api.errors.FINDING_PURGED` | This finding's text was removed after 30 days. | O texto desta descoberta foi removido após 30 dias. |
| `api.errors.PROPOSAL_DUPLICATE` | The same change is already proposed in Improve. | A mesma mudança já está proposta no Melhorar. |
| `api.errors.RESEARCH_SENDS_LIMIT` | 30 findings were sent this month. The next can be sent when the month resets. | 30 descobertas foram enviadas este mês. A próxima pode ser enviada quando o mês reiniciar. |

**Changed:**

| Key | Today | EN | PT |
|---|---|---|---|
| `improve.home.own.start` | open a section and use Suggest a change | Use New suggestion, or Suggest a change on a section of the book. | Use Nova sugestão, ou Sugerir uma mudança numa seção do livro. |
| `account.retention.research` / `researchValue` | an answered question may be researched … | research conversations · text 30 days, or until you delete them | conversas de pesquisa · texto por 30 dias, ou até você apagar |
| `assistant.delete.body` (its research sentence) | Research still running on it stops at its next step, unless it has already sent a finding to Improve. | Automatic research still running on it stops at its next step, unless it has already sent a finding to Improve. A research you started from one of its answers is a conversation of its own on the Research page, and is not deleted with it. | A pesquisa automática ainda em andamento sobre ela para no próximo passo, a menos que já tenha enviado uma descoberta ao Melhorar. Uma pesquisa que você iniciou a partir de uma das respostas é uma conversa própria na página de pesquisa e não é apagada com ela. |
| `audit` pack's `answers` label | answers | assistant and research records, and deletions | registros do assistente e de pesquisa, e exclusões |
| `improve.proposal.notAnswer` beside a new `notReport` | not part of the answer | not part of the report | não faz parte do relatório |

**Removed:** `account.prefs.research`, `researchOn`, `researchOff`, `researchNote`; `assistant.research.switchOn`.

## 20. Accessibility

- **Landmarks.** Three landmarks with names: `nav` "Your researches", the column's `aside` "Research", the statistics' `aside` "Research statistics". One `h1`, visually hidden, `Research`. Tab order follows reading order.
- **What is announced.** The column's log is `role="log"` and `aria-live="polite"`, as the Assistant's. In each run:
  - the line is `aria-atomic` and has no live role of its own (spec 43 D15), and its text changes at most once per state, not once a poll: during the read it reads `research · reading the web`, and the counts that grow are in the steps' caption;
  - the steps list and its caption are `aria-live="off"`, so twenty searches are not twenty announcements, and are readable in place;
  - the report, the pages and the findings are containers rendered empty from the run block's first render, `aria-live="off"`, and filled at the end, so their text is not read out. The end is announced once, by the line's `DONE` words (`research · done · 2 findings · 23 pages`), and the report is reached by its heading.
- **Headings.** A run is an `article` labelled `research {n}`. The report, the pages and each finding are headings of the run's level, so the outline reads `report`, `pages read`, `finding 1 of 2`.
- **Focus.**
  - `Start` keeps focus in the composer's field after a run starts: the field is read-only while the run is under way, never disabled (§ 11.3).
  - A start that did not start leaves the focus in the field, which holds the question again; one whose answer closes the composer (402, 429, 403) disables the field, and the focus goes to the `ErrorBox` that says why (`tabIndex={-1}`; unit 72's review).
  - When a run ends, focus does not move.
  - After `Send to Improve`'s 202, or a 409 read back, the pressed button is replaced by the finding's status line, which takes `tabIndex={-1}` and the focus, as `ProposalPanel` moves focus to what replaced the button pressed (`components/assistant/ProposalPanel.tsx:24`, `:70-80`). `ConfirmDialog` would otherwise return focus to an opener that has unmounted (`components/ui/ConfirmDialog.tsx:27`). Where the line has a link (`Open draft`, `View record`), the link takes it.
  - After a delete, focus goes to `New research` with the status line as its description (spec 45 § 3.9).
- **Dialogs.** Send's confirm, the flag's and the delete's are the shared `ConfirmDialog`: focus opens on Cancel and `Esc` cancels. In the dock, a dialog's `Esc` stands back from the dock's own, as the proposal consent's does (spec 43 § 16.2).
- **Links out.** A page link says where it goes (host and title) and that it opens a new tab.
- **Marks.** A state is a word and a shape (`.st`), never colour alone. Ids may break anywhere. Nothing truncates: queries, titles and addresses wrap (`overflow-wrap: anywhere` on an address).
- **Keys.** `r` is listed in the help dialog and obeys the map's guards. `a` and `r` never type into each other's dock or the Research page's column.
- **Touch.** 44px targets under `pointer: coarse` for the finding buttons, the flag and the delete.
- **Axe** finds nothing on each page state in EN and PT (§ 26).

## 21. Documents this amends

Each in the unit that makes it untrue, in its commit (rules § 6.1).

| Where | Says today | Amended by |
|---|---|---|
| architecture § 11, invariant 31 | "The researcher never answers a reader … reaches a reader only as a proposal" | 68 (§ 2's wording); the rest stands |
| architecture § 11, invariant 33 | two calls, the planner and the reader | 69: the writer added (§ 2) |
| architecture § 11, invariant 27 | "A change that began as research is credited to the reader who added their name" | 74: a contributor's draft from a finding is credited to the contributor; the `research` mark is provenance in both (§ 8.6) |
| architecture § 3.2 (route map) | no `/[lang]/research`; the `@assistant` slot holds the Assistant | 72 (the page), 76 (`/improve/new`), 77 (the slot holds both docks) |
| architecture § 3.4 (API), research row | the message's research view; endorse | 71, 73 (export), 74 |
| architecture § 4.1, § 4.2, § 4.4 (research rows, retention) | `ResearchRun.messageId` unique; text purged with the message | 68 (rows), 70 (purge and sweep), 71 (delete) |
| architecture § 4.3 (`EXPORT`, `ERASED` scopes) | conversation scopes only | 68: `research` in both |
| architecture § 5.2 roles; § 5.5 "Research is paid for by the platform" | the platform pays | 70: the person pays; the platform pays Improve's vetting of sent findings |
| architecture § 5.6 rates | 30 runs "at the turn's end" | 71 |
| architecture § 6.1 (the researcher's table, and its last paragraph: "… and a curator decide"), § 6.3 (`ResearchWorkflow` row), § 6.4 (research transport) | triggered by an answer; a curator decides every research change; the line's poll | 69, 70, 72; `SendFindingWorkflow` and the contributor's draft (§ 8.6) added in 74 |
| architecture § 9 (threat model), the researcher's rows | two calls; "… and decided by a curator (invariants 32 to 34)" | 69: the writer's row (untrusted notes, no tool, output checked, OT paragraphs dropped, shown only to the asker); 74: on a contributor's draft from a finding, the contributor and the adjudicator are the control |
| architecture § 12 | — | 68: A1 to A12 and D1 to D5 as decided, with the date |
| project-overview: the opening paragraph, "The researcher's road", the Assistant feature line about the research line, Capability 5's features and success criteria, "A general AI chat product" and "research on request" in Not in scope | research follows each answer; platform-paid; never answers | 75 (the road and the criteria); 72 (the page in the features) |
| ui-context § 9.9 / § 10 / § 12 / § 13.3 | no research page, no `r` key; `.dock` is the Assistant's alone | 72 (classes, `data-dock`), 77 (`r`) |
| code-standards § File Organization, § Workers | `components/research/` absent; the researcher's two assemblers | 69, 72 |
| `lib/env.ts`'s `RESEARCH_PRINCIPAL` comment | "Read by the workers alone" | 74: the web tier reads its presence (§ 8.3) |
| spec 40 § 5, § 6.1, § 7, § 8.2, § 10, D2, D3 | eligibility; the platform's budget; switches; "research on request" out of scope | 75 (a note at the top: superseded by 48 for new runs; legacy rows as written) |
| spec 41 § 5, § 6, § 7 (`ANCHOR`), § 10 D1 | two calls; the reader given every cited section | 69 |
| spec 42 § 3 (who pays), § 8 (out of scope: "the asker editing the proposal, adding evidence"; "a person adopting a refuted finding") | — | 74: a contributor's own draft from an unused finding is in scope (§ 8.2); adopting a refuted one stays out |
| spec 43 § 3 ("no button"), § 4 (`switch on`), § 5.2 (spend never shown), § 7 (the research log's month table), § 9, § 11, D2 (refuted never shown), D5 ("not now") | — | 75 (the switch-over), 74 (§ 10.3; D3 of this spec) |
| spec 44 § 2 R1, R2, R3, R8, R9; § 3 measures; § 4 the series' principal and its two views | an answered turn starts a run; the platform's budget; `ResearchSpend` is every call of an organisation with a research row | 70 (the views: `ResearchSpend` redefined, `ResearchFlag` added, `cap.sql` and `cost-per-run.sql` rewritten, `flags.sql`), 75 (the gate) |
| spec 46 § 3.2 item 3 (research off while a request stands, through `researchSwitches` and the hand-over) | the hand-over answers `OFF_USER` | 75: the start endpoint's check 4 (§ 5.2) holds it, built in 71 |
| spec 46 § 3.3 step 4 (conversations) | the Assistant's conversations through `deleteConversation` | 75: the research conversations through `deleteResearchConversation` too, before step 5 |
| spec 46 § 3.3 step 5, § 3.8 (research concluded on its cancellation, 65d) | `ResearchWorkflow`'s runs, behind `patched()` | 75: the account's runs of either workflow, each under its stored `workflowId` (a legacy run's `research:<messageId>`, a person's `research:<runId>`), `ResearchRunWorkflow` concluding on cancellation as built in 70 (§ 5.1), no patch; and each `finding:<id>` of the account's `SUBMITTED` findings, which ends with nothing owed (§ 8.4) |
| spec 46 § 3.5 (every row that names the person) | no `ResearchConversation` | 75: `ResearchConversation`, `CASCADE` on `userId`, deleted at step 4 |
| spec 26 § 10 (out of scope) and its page's description | — | 72: the Research page is modelled on it |
| spec 34 § 4, spec 35 § 3 (no start button; "open a section") | — | 76 |
| spec 38 § 2 ("Research is never on a reader's meter"), § 3 (the pack's `answers`) | — | 68 (meter), 71 (pack) |
| spec 46 § 3.6 (the audit pack's label, "assistant answers, deletions and deletion requests") and § 6's `account.audit.kind.answers` row | 65b changes "assistant answers and deletions" | 71: the label is "assistant and research records, and deletions" (EN) and "registros do assistente e de pesquisa, e exclusões" (PT), and 65b adds "deletion requests" to it: "assistant and research records, deletions and deletion requests" |
| spec 45 § 3.5 (the sweep's predicate and what it keeps), § 6 (the delete's body) | detached = `messageId` null; only `PROPOSED` findings kept | 70, 75 |
| the tracker, Open Questions, gateway numbers (spec 11 D4, D5) | `tokensPerMinute` sized for Assistant turns | 70: they must now cover a reader's request (§ 7.1) |
| the tracker | — | each unit |

## 22. Risks and limits

- **The person now pays about US$ 0.60 a research** on the real provider: the planner about US$ 0.013, the reader about US$ 0.57, and the writer about US$ 0.05 by D1's estimate (spec 41 § 12). An individual's cap, `INDIVIDUAL_TOKEN_CAP`, a number Andre still owes, may be spent in a few researches; until it exists an individual cannot research at all (§ 7.1). The composer says research spends the budget, and the statistics say how much each one cost.
- **The key's rate.** A reader's request reports up to some 300,000 tokens against a `tpm_limit` that is owed and was asked for with Assistant turns in mind (§ 7.1). The writer waits it out once (§ 5.6). A continuation can still be refused and end the run `READER_FAILED`, and the organisation's own Assistant turns can be refused for the rest of that minute. The numbers Andre owes (spec 11 D4, D5) decide how often.
- **Drafting spends too.** `Draft it in Improve` starts up to ten gradings at once on the contributor's principal, before they have read the draft. The button's help line says so; the draft can be deleted, but the gradings are spent.
- **The writer holds the question and text the web shaped.** It holds no tool, and its output goes only to the person who asked, as plain text, with no address that can be a link and no paragraph about operating plant equipment. A persuasive page can still put a wrong statement in a report. The report is labelled as from the web and not checked by Improve, and a flag is the person's way to say so.
- **A page's injected text can reach the next run's planner only through the brief side.** The planner of a follow-up reads earlier questions and briefs, never reports, so it holds nothing the web wrote.
- **A contributor can carry a web-steered proposal past a curator** by drafting a finding and submitting it, since the adjudicator may decide a person's suggestion. They could do the same by hand today. The edit page labels the prefilled text, and the history keeps its provenance (§ 8.6).
- **The brief's overlap check will fail some runs** whose questions are short and generic, at the planner's cost. It is counted.
- **A follow-up's planner and writer read up to six earlier runs.** A long research conversation forgets its start, as the Assistant's does.
- **Research reads verified chapters only**, as the Assistant does (§ 2, A5).
- **Live steps are progress, not evidence.** A continuation's blocks that the stream missed are in the final list all the same, since `found.read` comes from the whole turn.
- **A refused first call in an organisation** is remembered per person, so each member meets it once.
- **The day's count can be one over.** The start locks the conversation, not the person, so two starts in two conversations at the thirtieth can both pass (§ 5.2).
- **The research principal's cap is shared.** It now pays only Improve's vetting of sent findings, and every person's sends wait at the reset once it is spent. D5 bounds what one person can take of it.
- **A throttled contributor's findings can expire unused**, since the throttle's 30 days are as long as the text's. Sending them on the platform's budget would bypass the throttle, so it is not offered (§ 8.1).
- **A reload seconds after a send** shows the button again until `sendFinding` commits; a press then is the same send (§ 8.3).
- **Legacy runs still in flight** run on the legacy workflow until they end. A legacy run asleep at the platform's cap wakes at the reset and runs once more on the platform's budget.
- **The `research` parameter on the Research page's own URL** reads `?research=` twice over, which is the price of one parameter for the page and the dock (§ 12).
- **The asker's id in the request's metadata.** Every model call names its payer as `metadata.user_id`, the gateway's spend attribution (`lib/gateway/client.ts`), so for an individual account each of a run's three requests carries `user:<id>`, the reader's included, and the proxy may pass it to the provider. It is an opaque id, never part of a prompt or a search, so no page can make the reader repeat it; spec 33 records the same of the adjudicator. Hashing it would change every call's attribution and is not this spec's (the review of unit 69).

## 23. Out of scope

- A picker of Assistant answers on the Research page (§ 11.3).
- Research of a refusal, or research on a schedule.
- Research of an unverified chapter (§ 2, A5).
- Sending a finding a person drafted to curators as a researcher proposal too, or drafting a sent one.
- A person adopting a refuted finding as their own (spec 42 § 8, kept).
- Delete in the dock.
- Renaming a research; deleting one run.
- A research grader and its calibration.
- Notifications when a curator decides.
- Removing the legacy workflow and its v1 assemblers (unit 78, § 25).

## 24. Decisions this spec needs

All five answered by Andre on 2026-10-12, each as recommended: D1 the frontier writer, D2 the organisation's switch kept, D3 `sent · not proposed` shown, D4 the `r` key, D5 20 sends a day and 30 a month.

| # | Decision | Recommended, and Andre's answer (2026-10-12) | Why |
|---|---|---|---|
| D1 | The report's writer and its size | **Andre: as recommended.** **A third call on `hb-frontier` after the reader, at most 600 words in at most 8 paragraphs each citing a page or a section, from the reader's notes of at most 60 words a page** (about US$ 0.05 a run). The alternatives are B, the reader writes the report itself, and C, the writer on `hb-small` (about US$ 0.005) | The reader may not hold the question (invariant 33), so a report it wrote would answer the English brief, not the person's question in their language. The report is the one free-standing prose the product writes and the thing the person pays for, and the Assistant drafts its answers on the frontier model. The notes keep the writer's prompt a few thousand tokens instead of the pages' tens of thousands |
| D2 | The organisation's research switch | **Andre: as recommended.** **Kept**, as the organisation's say over its members' research. Off, a start is refused (403 `RESEARCH_OFF_ORGANISATION`), and the command and its audit row are unchanged. The alternative is to drop it with the person's | A3 has the organisation's budget pay for its members' research, and the switch was the organisation's consent to its members' words going to the web side. A2 removed only the account page's switch |
| D3 | A finding the person sent that Improve refutes | **Andre: as recommended.** **Shown to them as `sent · not proposed`**, with no record link: a refuted proposal's record is not the asker's to read (`askerOfProposal` reads `PROPOSED` only). The alternative is spec 43 D2's rule, never shown | Under spec 43 the person never chose to send anything, so a refutation shown would have been news about the machine. Now they pressed the button, and silence would read as "still being checked" for ever |
| D4 | The Research dock's key | **Andre: as recommended.** **`r`**, free in `resolveKeyAction`, with `a`'s guards. The alternative is no key, only the header and a link | A9 asks for the dock "as the Assistant's", whose key is `a`; `r` is the next free letter and names it |
| D5 | How many findings one person may send to Improve as researcher proposals | **Andre: as recommended.** **20 a day and 30 a calendar month**, the month counted from the findings' `sentAt` (429 `RESEARCH_SENDS_LIMIT` with the month's reset); since unit 74's review counted in a row of its own that no delete reaches, as § 8.3 says, the thirty unchanged. The alternatives are A, 20 a day only, and C, one ceiling of 150 a month across all users | Every send's grading and adjudication is on the one research principal, US$ 20 a month shared by everyone, about US$ 0.10 to 0.15 a send (§ 7.3). At 20 a day one person can spend it in about a week, and everyone's sends then wait for the reset. Thirty a month caps one person at about US$ 4.50 of it. A platform ceiling bounds the cap exactly but lets one person take every place |

## 25. Units

Ten units in Andre's lean shape, one small review at the end of each. Within a unit each part is verified by rules § 7 before the next. A migration is its own part and goes first. A read side ships before anything writes what it reads. The product works at the end of each.

| Unit | Parts | Folders | After it |
|---|---|---|---|
| **68 · The rows and the contracts** | 68a migration (§ 4.2, `Suggestion.fromResearch` and the finding's `sentAt` included); 68b contracts: `lib/schemas/research.ts` (states, outcomes, research refusal causes), `lib/schemas/researcher.ts` (steps, report, `ReaderOutputV2Schema`, `found`'s new members), the ledger's `RESEARCH` members (the `REFUSED` code as `R_*`, `runEndOf`'s case), `ERASED`'s and `EXPORT`'s `research` scope kinds, with their record rules and walk rows; the budget meter's `research` consumer, `FAINT_AT_ZERO`, `NOTE_KEY` and `account.budget.research` / `researchNote`; architecture § 11 invariant 31 and § 12 | `prisma/`, `lib/schemas/`, `lib/budget/`, `components/account/`, `messages/`, `context/` | nothing reads the new rows; the meter shows a faint `research` row at zero |
| **69 · The researcher, version 2** | 69a guide `guides/researcher/v2.0` (planner, reader, writer); 69b `v2/planner.ts` and the brief sensor's two readings; 69c `v2/reader.ts`, the notes, `callModelTurn`'s `onBlock` and its counts on a failure, the fetch title in `tools.ts`; 69d `v2/writer.ts`, the row `researchWriter`, `lib/sensors/report.ts` with its OT rule, the stub's writer (`ot` included) and notes; invariant 33 and the threat model's writer row | `guides/`, `workers/agents/researcher/v2/`, `lib/gateway/`, `lib/sensors/`, `infra/gateway/stub/`, `context/` | pure agents tested on the stub; nothing calls them yet |
| **70 · The run on demand** | 70a the door: the run's reads and guarded writes, `VALID` rows, the step statements (`RAW_SQL.md`), report, `writingAt`; `ENDED_STATES` with `REFUSED`; `runsStartedSince` leaving out `SKIPPED · BUDGET` and `SKIPPED · UNAVAILABLE`; `normalisedQuestion` and `ResearchMarkRow` moved out of `eligibility.ts`; `purgeResearchRuns` by the run's own age; **the sweep's predicate, its kept findings and its second pass** (§ 17.2); `readerStats` by kind; retrieval's `ref`; 70b `ResearchRunWorkflow` and its activities on the person's principal (heartbeats, the 90-minute execution timeout through `WORKFLOWS`, the cancellation and the catch-all, `abandonRun`, the writer's wait at the rate limit, the second redaction), its `WORKFLOWS` entry and registration, the `RESEARCH` record read under the run's principal with the writer told by `writingAt`, the `research.write` line; 70c the views migration (`ResearchSpend` redefined by run and payer, `ResearchFlag`), `cap.sql`, `cost-per-run.sql`, `flags.sql`, the grants in `init.sql`, spec 44 § 4; the tracker's gateway numbers | `lib/db/`, `lib/search/`, `lib/research/`, `lib/workflows/`, `workers/`, `lib/schemas/workflows.ts`, `lib/metrics/sql/research/`, `prisma/`, `infra/observability/`, `scripts/`, `context/` | the workers run a run when one is started; nothing starts one |
| **71 · The research API and its policy** | 71a `policies/hb/research.rego` with its deny tests and `ResourceKindSchema`'s `research`; 71b the endpoints of § 13 but the two findings' and the export, the start's checks (§ 5.2) with the lock, the engine's reconcile, the deletion request, `otRule` and the unverified-chapter rule (`chaptersPassed` moved to `lib/db/content.ts`), the `P2002` mapping, the delete door with `ERASED`, the audit pack's `answers`; the error codes and their `api.errors` strings; OpenAPI; contract tests | `policies/`, `lib/api/`, `app/api/v1/research/`, `lib/db/`, `lib/sensors/scope.ts`, `messages/` | research works through the API beside the automatic research, which still runs |
| **72 · The Research page** | 72a the classes in `globals.css` and ui-context; 72b the route, `lib/research/links.ts` (with `researchRefHref`), the layout, `ResearchConversations`, `ResearchDock` page variant with the run block (line, steps, report, pages, findings shown without their buttons; the purged and the stale run), `Composer`'s `namespace` and `busy`, `RefusalCard`'s `hrefOf` and `foot`, the seed `?from=`, `useRunFollow`, the header's `Research`, **`data-dock` on the Assistant's dock and the page's column, and `AskShortcut`'s query**; the strings; `npm run research:seed` rewritten for the page's states | `app/`, `components/research/`, `components/assistant/`, `components/chrome/`, `lib/`, `messages/`, `scripts/` | a person researches on the page; a finding is shown and not yet usable; `a` on the page opens the Assistant |
| **73 · The page's statistics, flags, delete and export** | 73a `researchStats`, `ResearchStatsPanel` with the meter, `w=`; 73b `Flag this report` (`FlagButton`'s `endpoint`, `readBack`, `namespace`, kind `report`), `Delete research` (`DeleteConversation` props, `?deleted=`), the export endpoint and its link, `Copy report` | `lib/db/`, `lib/api/`, `app/api/v1/research/`, `components/`, `messages/` | the page is whole but for the findings' buttons |
| **74 · Turn into improvements** | 74a the `finding` kind and rule with deny tests; the door's `createDraftFromFinding` (with `fromResearch`), `liveSuggestionWithKey`, `suggestionVisibleTo` and the submit's re-check; `lib/research/submission.ts`; `claimFindingForDraft`, `noteOfDraft` (with the sources not among the items), `duplicateVisibleTo`; `workers/research/pace.ts` (the pacing constants and `outcomeOfState` moved unchanged, the legacy workflow importing them); `SendFindingWorkflow` with its activities and entry; 74b the two endpoints (the month's sends of D5), OpenAPI, contract tests; 74c `FindingAction` by role with the send confirm, the help line, the throttle notice, the failures' lines and the follow after a 202, `ProposalPanel` under a proposed one, the edit page's `from your research` and the prefilled label, the history's and the queue's provenance mark; the research log's month table (§ 10.3); invariant 27, § 6.1 and the threat model (§ 8.6); D3 | `policies/`, `lib/db/`, `lib/research/`, `lib/improve/`, `workers/`, `lib/api/`, `components/`, `messages/`, `context/` | a finding becomes a draft or a researcher proposal |
| **75 · The Assistant hands over** | 75a `researchAfterTurn` out of the turn; `afterTurn.ts`, `eligibility.ts` and the mark writers deleted; the researcher's gate: R1 (an answered turn starts no run, the answer unchanged), R2 (30 a day, the organisation's switch), R3 (the canary in no byte of the reader's request or its searches, and in the writer's request, which holds no tool), R8 (the whole road from the Research page), R9 (a run spends the person's budget; Improve's vetting of a sent finding spends the research principal's); the series' cost per run from the views of 70c; 75b `Start a research` in `TurnActions` and `WalkTurn`; the account's switch and action removed; the Retention line; `ResearchLine` without `switch on`; the delete body's sentence; `tests/research/` rewritten for the new road; the truncation suite's research screens; project-overview and specs 40, 43, 44, 46 amended | `workers/`, `lib/`, `components/assistant/`, `app/[lang]/account/`, `tests/`, `messages/`, `context/` | nothing researches on its own; an answer offers a research |
| **76 · Improve's two starts** | 76a `/[lang]/improve/new` and its loader, `SuggestGateNotice` shared with step 1 and shown at the chooser's top; 76b the landing page's `New suggestion` for everyone and `From a research` (`unusedFindingsOf`, `FindingAction`); specs 34, 35 amended | `app/[lang]/improve/new/`, `components/improve/`, `lib/db/`, `messages/`, `context/` | Improve starts from scratch or from a research |
| **77 · The Research dock on every page** | 77a `ResearchMount` in the slot with § 12's parameter rules, `ResearchShortcut`, `KeyAction` `research`, `AskShortcut`'s `research` rule, the keyboard map's row and `reader.keys.research`; 77b `ResearchDock variant="dock"`, the overlay, `Esc`, the phone notice, `Open the Research page` | `app/[lang]/@assistant/`, `components/`, `lib/hooks/`, `messages/`, `context/` | the dock opens on every page |
| **78 · (later) The automatic research removed** | after no `ResearchWorkflow` run is open (its runs wait at most 40 days from their submission, so not before 2026-11-22): the legacy workflow, its activities, the v1 assemblers, `useResearchFollow` once no legacy run is under way, and `User.researchEnabled` in the release after. `workers/research/pace.ts` stays: `SendFindingWorkflow` imports it, and its running histories replay it | `workers/`, `lib/`, `prisma/` | — |

**Order.** 68 → 69 → 70 → 71 → 72 → 73 → 74 → 75 → 76 → 77. Unit 70's workers deploy before unit 71's endpoints, and unit 74's `SendFindingWorkflow` before its endpoint (spec 45 § 5.3's rule). Spec 46's units 66 and 65 follow unit 77 (its § 13).

## 26. Verification (in addition to rules § 7)

On the stub gateway throughout, with the engine's test server for workflows. A real run is Andre's to start (rules § 8.14). The command, `npm run research:check`, and a real research from the page are his.

**Unit 68**

- The migration applies to a database holding legacy runs, findings and marks, and every legacy row still reads in its line, its panel and the research log.
- The `CHECK` refuses a run with both a message and a conversation.
- `ResearchConversation` is refused by the tenant filter for another person.
- The ledger walk accepts the new `RESEARCH` members, a refused record with code `R_SCOPE`, and `ERASED`'s and `EXPORT`'s `research` scope, and refuses a sentence in any, and a code `R-SCOPE`.
- The meter maps `RESEARCH` to `research`, and the account page shows the row faint at zero, with its note, in EN and PT.

**Unit 69**

- The planner's, reader's and writer's prompts hold exactly their slots: a test passes a marker word as the question. It is in the planner's and the writer's requests, in no byte of the reader's request or of any search the stub ran, and the asker's id, e-mail and name are in none of the three prompts. For an individual account the asker's id is each request's `metadata.user_id`, and nowhere else (§ 22).
- The reader's and the planner's requests hold no tool but the reader's two server tools. The writer's holds none.
- The brief sensor refuses a brief repeating five words of an earlier question.
- The report sensor drops, case by case, a paragraph with an unknown page, an unknown section, no reference, an address, a secret, an instruction to act on plant equipment (`x-hb-stub-write: ot`), and words past 600. A report left empty fails.
- `onBlock` sees each search and fetch block of the stub's streamed turn in order.
- A continuation refused at the cap throws with the turn's counts so far.
- The guide's hashes match its manifest, and `npm run secrets:scan` is clean.

**Unit 70**

- **On the time-skipping server, with doubles:** done; refused (`NOT_ABOUT_THE_BOOK`, `PERSONAL`), its record's code `R_SCOPE` and `R_PERSONAL`; budget at the planner (`SKIPPED · BUDGET`, `budgetResetsAt` set, not counted); the planner's gateway unavailable (`SKIPPED · UNAVAILABLE`, not counted); budget at the reader and at the writer (`FAILED · BUDGET`, the steps, the counts and the findings kept); the writer at the rate limit, once (waits, then done) and twice (`FAILED · RATE_LIMIT`); the reader's and the writer's failures; a heartbeat missed (the step fails within a minute); a cancellation (concluded with its record); a defect after the read (`FAILED · INTERNAL` through `abandonRun`); text purged at each step. The history holds only ids, enumerations, numbers and hashes (`freeTextIn`).
- **On the database, the stub and the engine's test server** (`tests/integration/research-run.test.ts` extended):
  - a from-scratch question: retrieval's rows carry the run's `ref`; the steps grow while the reader streams, every step there and in order; `VALID` rows; a report; one `RESEARCH` record signed `user:<id>` naming the conversation, its `models.reader` the reader's call and `models.writer` the writer's;
  - a seeded question: the planner reads the seed's claims, and the run's sections hold the seed's cited sections and retrieval's;
  - a follow-up's planner reads the earlier brief and not the report;
  - the asker's ledger has the planner's, the reader's and the writer's rows, and the research principal's has none; the record is written with `RESEARCH_PRINCIPAL` unset.
- The purge at 31 days empties the five columns of a run 31 days old and keeps the text of a follow-up one day old in the same conversation.
- **The sweep** deletes a detached new run and never a live one older than 24 hours. That case is written first and fails on the code as built. It keeps a detached `SUBMITTED` finding whose workflow runs, and deletes a detached `REFUTED` one.
- **The views**: `ResearchSpend` holds a person's research, embed and re-rank rows by run and none of their organisation's Assistant rows; `cap.sql` counts only the research principal's refusals; `ResearchFlag` names no person; the dashboard's role still cannot read `ResearchRun`.

**Unit 71**

- `opa test policies`: every deny case of § 14.
- Contract tests for each endpoint's answers and errors, the rate headers, and the idempotent replay of a start.
- The start's checks in order (§ 5.2): an OT question and a question naming an unverified chapter are `REFUSED` with no workflow and not counted; the thirty-first run is 429; a run that met the cap is 402; a run under way is 409; a run under way whose workflow the engine does not know is ended `FAILED · ABANDONED` and the start goes on; an account with a deletion request is 403; the engine down is 503 with the row taken back and not counted.
- Two starts in one conversation with two keys at once: one 202, one 409, never two runs and never a 500.
- The delete: a running run is detached and ends `SKIPPED · TEXT_PURGED`; the conversation's rows are gone; `ERASED` appended once; a racing start answers 404.
- A walk of every research endpoint's schema finds no brief, note, uncovered sentence, invalid reason or finding ordinal.

**Unit 72**

- **Browser**, EN and PT, as a reader on the stub:
  - a question from scratch shows its steps one by one without a reload, then the report, the pages and the findings;
  - `?from=` prefills and spends nothing until Start;
  - an invalid `from` shows its notice;
  - the URL gains `?research=<id>` on the first Start;
  - the list's new row;
  - in a research with a follow-up, every `[n]` of run 2's report lands on run 2's page row, and no id repeats in the document;
  - a section link in a research opens the reader with no Assistant dock;
  - `a` on the Research page opens the Assistant's dock and writes nothing into the research composer.
- The widths 1440, 1360, 1200, 1000, 900 and 390: the columns of § 11.2, no horizontal overflow.
- Axe clean on: empty, seeded, under way, done, refused, stopped, purged.
- The PT truncation suite's new screens from the rewritten seed.
- A report's paragraph renders no link but its chips and page numbers.
- The live region announces each state once (the test counts the log's text changes, through a whole run, the read's twenty steps and the end included).
- Focus stays in the composer's field when a run starts.

**Unit 73**

- The statistics' cells against a count in SQL for the seed's person.
- The meter's `research` row.
- A flag stored once, and a second answered from the row; the dialog's words are research's.
- Delete from the list, with the status line, focus on `New research`, and the overlay at 1200px; the dialog's export link downloads a signed file that verifies, with one `EXPORT` record of scope `research`.
- `Copy report`'s text.
- Axe and truncation for the statistics and the dialogs.

**Unit 74**

- **As a verified contributor:** `Draft it in Improve` makes a draft with the proposal, `fromResearch` and one pending item per source, each with its own `GradeEvidenceWorkflow`. The rationale is empty. The rail shows the note, and a source whose grading did not start is listed as not among the evidence, after a reload too. A second press is 409. An anchor changed by a newer release is 422. A live suggestion with the same key is 409, with its id only when it is the contributor's own or merged. A finding sent with the same key after the draft makes the draft's submission 409. A throttled contributor sees the notice and no button.
- **As a reader, and as an unverified contributor:** `Send to Improve` confirms, then the block reads `sending`, `sent · being checked` and `proposed` without a reload, and focus is on the status line. The suggestion is `RESEARCHER` with no owner. `Add my name` works for the sender. The proposal is listed under Improve. The thirty-first send of the month is 429 (D5).
- A refuted one reads `sent · not proposed` (D3).
- The policy refuses a verified contributor's `propose`.
- The engine down at the press is 503 and the finding is unchanged; a web tier that dies after the start leaves a finding the workflow sends.
- Each `sendFinding` end: `RESEARCH_PRINCIPAL` unset in the workers, no rubric, the anchor gone, the research deleted between the press and the step (`TEXT_PURGED`), the finding gone; each line as § 8.1 says.
- The chapter history shows `research` beside the contributor of a merged draft from a finding.
- Invariant 32 still holds for a sent finding (spec 42 § 10.5's test).
- The research log's new columns against the records.

**Unit 75**

- An answered turn writes no `ResearchRun`, and its `final` has no `research`.
- A legacy turn's line and panel still render.
- `Start a research` is on answers of each mode and on no refusal or purged turn.
- The account page has no research switch, and its Retention line is the new one.
- `npm run gate:research` passes R1 to R10 with their new readings, and R11 is blocked as before.
- `tests/research/` (`npm run test:research`) runs the whole road on the stub: answer, Start a research, report, send, proposed, named, a curator's accept.

**Unit 76**

- `/en/improve/new` lists the chapters, `?ch=21` lists its nine sections, and a section leads to step 1. A reader sees the role notice at the chooser's top and no chapter list, and a throttled contributor the throttle notice. Signed out is the sign-in redirect.
- The landing page shows `New suggestion` to everyone, and `From a research` with a finding's button to its owner only.
- Axe and truncation at 1440 and 390.

**Unit 77**

- `r` opens the dock on the home page, a reader section, search, Improve and the account page.
- `a` with the research dock open opens the Assistant's in its place. A URL with both dock parameters shows the Assistant.
- `r` on `/assistant?ask=<id>` opens the research dock over the page and keeps the conversation; `a` on `/research?research=<id>` keeps the research; `r` on step 1 and on `/rubric?from=21.3` keeps `from`.
- `Esc` closes the dock, and the dock's `Open the Research page` keeps the research.
- Under 768px there is the phone notice.
- Axe clean with the dock open, EN and PT.
- The keyboard map lists `r`.

## 27. Checked against the code before it was written (2026-10-12)

Three reviewers checked the draft against the code, each from one side: the data and the workflows, the product and its screens, and safety. They raised 54 findings: three of high severity, 28 medium and 23 low. Two ids were raised twice, by two lenses (`stuck-run-locks-conversation`, `dangling-references`). Every finding was read against the code it cites, and every one is fixed in the text. Two are fixed in part, because what is left is a number Andre owes or decides (*payer-switch-ignores-tpm*, *shared-vetting-cap-abuse*, now D5). In three, one step of the claim did not hold against the code, and the fix stands without it (*export-dropped-with-wrong-reason*, *stuck-run-blocks-conversation*, *send-finding-dead-ends*). None was rejected outright.

- **Data and workflows** (20: eight medium, twelve low).
  - *stuck-run-locks-conversation*: § 5.2 check 3 (under way defined; `REFUSED` an end state; the engine asked; `FAILED · ABANDONED`), § 5.1 (the 90-minute execution timeout, the catch-all), § 6 (the stale run).
  - *refused-code-breaks-code-pattern*: § 15. Confirmed against `CODE_PATTERN` and `runEndOf`; the code is `R_SCOPE`/`R_PERSONAL`, the cause in `refusal`.
  - *send-claim-orphans*: § 8.3 and § 8.4. Nothing is claimed before the start; `sendFinding` claims and creates in one transaction, and every end of it is defined. The sweep keeps a `SUBMITTED` finding while its workflow runs.
  - *retrieval-swallows-budget*: § 5.3 and § 7.2. Retrieval is unchanged and degrades; the planner's refusal ends the run.
  - *steps-append-race*: § 6, one ordered chain of one-statement writes, registered raw.
  - *reader-no-heartbeat*: § 5.1, heartbeats, and the worst case restated with the retries; the hook gives up at 90 minutes.
  - *payer-switch-ignores-tpm*: answered in part. § 7.1, § 5.6 and § 22 state the size of a reader's request against the key's rate and wait the writer out once. The rate itself stays the number Andre owes (spec 11 D4, D5), deferred by him until paid accounts exist; this spec does not invent it.
  - *record-reads-wrong-principal*: § 15, read under the run's principal, the writer told by `writingAt`, one hash named.
  - *concurrent-start-race*: § 5.2, the conversation locked and `P2002` mapped.
  - *retrieval-verified-only*: § 2 (A5) and § 5.2, research reads verified chapters, the unverified-chapter rule at start, the set bounded at ten.
  - *eligibility-delete-breaks-imports*: § 9.2, both moved in unit 70.
  - *found-pages-collision*: § 5.4 and § 5.5, `notes` then `says`; `pages` unchanged; a v2 schema.
  - *unavailable-start-counted*: § 2 (A8), § 5.2, § 7.2.
  - *draft-response-holds-urls*: § 8.2 and § 17.2; the answer holds no address, and the draft answers no 503.
  - *failure-row-wording*: § 8.1, one row per code; `NO_RUBRIC`, `PARSE` and `TEXT_PURGED` added.
  - *purge-scope-ambiguous*: § 17.1.
  - *budget-path-loses-counts*: § 5.4 and § 7.2.
  - *unit78-removes-shared-constants*: § 8.4, `workers/research/pace.ts` in unit 74, kept by unit 78.
  - *orphan-findings-after-sweep*: § 8.4 and § 17.2.
  - *dangling-references*: A13 and A14 are spec 27's (its § 3), not spec 40's; the research log's change is § 10.3.
- **Product and screens** (19: two high, thirteen medium, four low).
  - *dock-params-clobber-page-state* (high): § 12, whose parameter is whose, by path.
  - *page-anchor-ids-collide-across-runs* (high): § 11.3, `run-<runId>-page-<n>`, and a test in unit 72.
  - *seed-sections-ignore-edited-question*: § 5.3.
  - *live-region-announces-more-than-claimed*: § 11.3, § 18 and § 20; the counts out of the line, the end's containers silent.
  - *focus-after-start-and-send*: § 11.3 (`busy`) and § 20.
  - *reused-components-missing-keys*: § 11.5 and § 19.
  - *flag-dialog-says-grader-calibration*: § 11.5, § 11.7 and § 19.
  - *unit68-meter-row-and-strings*: § 7.1, § 19, unit 68's row.
  - *interim-a-key-types-into-research*: § 12 and unit 72.
  - *refusal-card-reuse-gaps*: § 11.3, § 11.5, § 16 and § 19, with `researchRefHref`.
  - *anchor-failure-mislabelled*: § 8.1.
  - *sent-finding-not-followed*: § 8.3.
  - *purged-run-rendering-unspecified*: § 11.3 and § 16.
  - *export-dropped-with-wrong-reason*: answered, though its premise holds only in part. The Assistant's export carries records, never words (`lib/api/endpoints/assistant.ts:312-317`), so the draft's reason was right in substance. Story 2 asks for all the Assistant's features, and the export is cheap, so it is added (§ 11.10).
  - *throttled-contributor-dead-end*: § 8.1, the throttle notice in place of the button; sending on the platform's budget is not offered, since it would bypass the throttle (§ 22).
  - *new-suggestion-role-gated*: § 10.1 and § 10.2, for everyone, as A11 says.
  - *stuck-run-locks-conversation*: as the data lens's.
  - *dangling-references*: as the data lens's.
  - *sources-not-added-not-persisted*: § 8.2, read by `noteOfDraft`.
- **Safety** (15: one high, seven medium, seven low).
  - *spec46-left-broken* (high): § 21's five spec 46 rows; § 5.1 (cancellation and its record, no patch); § 5.2 check 4; § 8.4 (a finding gone, a cancellation).
  - *refused-code-fails-ledger*: as *refused-code-breaks-code-pattern*.
  - *stuck-run-blocks-conversation*: as the data lens's *stuck-run-locks-conversation*. One step of its claim does not hold: `concludeResearch` writes the end state before the record (`workers/activities/research.ts:155-159`), so a record that fails leaves the row ended. The lock came from `REFUSED` missing from `ENDED_STATES` and from a workflow that dies before its conclude.
  - *send-finding-dead-ends*: § 8.1 and § 8.4, every non-retryable end defined, and the delete dialog's sentence narrowed (§ 19). Its claim that the step can wait long behind 35-minute readers on the same queue does not hold: the worker runs activities concurrently (`workers/temporal.ts:55`, the SDK's default), so one long activity does not hold the queue.
  - *draft-path-invariants-27-32*: § 8.6, with `Suggestion.fromResearch`; invariant 27, § 6.1 and the threat model amended in unit 74.
  - *shared-vetting-cap-abuse*: answered in part. § 7.3 and § 22 state the shared cap; the bound on one person's sends is D5. The exposure is smaller than today's, when one person's automatic runs spent the same principal on the planner and the reader too. Counting refuted sends toward Improve's throttle was not taken: the throttle's rule is about a contributor's unverifiable evidence (spec 33 § 7), and a sender wrote none.
  - *research-views-wrong-after-a3*: § 11.7 and unit 70c, the views redefined and the flags given a view of their own.
  - *report-ot-guide-only*: § 5.7.
  - *a7-rejected-count-visible*: § 2 (A7), § 6, § 16, § 18.
  - *question-hash-two-definitions*: § 4.2 and § 15, one definition, the normalised one, on the row and the record.
  - *redaction-in-web-tier-only*: § 5.1 and § 5.2, redacted again in the workers.
  - *end-states-and-unavailable-count*: § 5.2 and § 7.2.
  - *draft-press-spends-silently*: § 8.1 and § 22, a help line under the button. A confirm was not added: the send's confirm is there because a submission is a record and not taken back, and a draft can be deleted.
  - *duplicate-reveals-others-suggestion*: § 8.5.
  - *draft-key-not-rechecked*: § 8.5.

## 28. As built (unit 68: the rows and the contracts, 2026-10-12)

Built as § 4.2, § 5.4 to § 5.7, § 6, § 7.1 and § 15 say.

- **The migration** `20261012120000_research_conversations`: the four enum values, `ResearchConversation`, the run's, the finding's and the suggestion's new columns, and the `CHECK`, registered in `RAW_SQL.md`. It applied to the development database, which holds legacy runs. `ResearchConversation` joins the tenant filter by `userId`.
- **The contracts:** `RESEARCH_REFUSALS`, `PLANNER_REFUSALS` and `refusalCodeOf` in `lib/schemas/research.ts`; the steps, the writer's output, the report with its drop rules, `ReaderOutputV2Schema` and `found`'s four new members in `lib/schemas/researcher.ts`. `runEndOf` gains `REFUSED`, and the legacy line maps the two new states, which a legacy run never reaches.
- **The ledger:** `RESEARCH`'s new optional members, `planned: refused`, the `REFUSED` end with its code, and the person as an actor; `ERASED`'s and `EXPORT`'s `research` scope. A new helper, `researchErasedStepKeyOf`, gives a research delete its own step key, `research:<id>`.
- **The meter:** `RESEARCH` maps to a `research` row beside the Assistant's, faint at zero, with its note.

**The review**, one read-only pass, found one medium and three low, all fixed in the unit's commit:

- `openapi.json` had not been regenerated for the two new states, which CI's check would have failed on. It is regenerated, and also picks up the delete's rate bucket of unit 62's review, which had been left out.
- The `ERASED` comment named the Assistant's step-key helper for a research delete; `researchErasedStepKeyOf` now exists.
- A refused record could name no cause or end otherwise. A fourth refine holds both.
- A run detached by its conversation's delete has no conversation, so `conversationId` is nullable on the record. Its record would otherwise have failed, and the run with it.

**Verified:**

- type check and lint;
- the unit suite: 2,287 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded;
- the ledger's payload walk, with the new members, a refused record and its code, and the scopes;
- the research database suites: `research-rows` (a new case for the conversation's tenant filter, the `CHECK`, the ordinal's uniqueness and the cascade) and `research-run`;
- the account page's meter in EN and PT in Chromium: the `research` row, faint at zero, with its note.

## 29. As built (unit 69: the researcher, version 2, 2026-10-12)

Built as § 5.3 to § 5.8 say. Nothing calls the new agents before unit 70.

- **The guide** `guides/researcher/v2.0`, its three parts pinned in its manifest; v1.0 is unchanged.
- **The agents** `workers/agents/researcher/v2/planner.ts`, `reader.ts` and `writer.ts`, which share version 1's `render.ts` and their strict parse in `v2/output.ts`. Each input type holds exactly its slots. The planner's slots 4 and 5 are one field that says from scratch, seeded or follow-up, since a run is only one of them. A fourth target fails the parse, `PLANNER_FAILED`, rather than `BRIEF_TARGET`.
- **The brief sensor** reads `sections` (every target among the run's sections) and `earlierQuestions` (no five words of any). Its one legacy caller passes the cited sections.
- **The gateway.** `onBlock` is attached inside `callModel`, where the stream is created, so no block is missed. A turn's failure carries its counts, read with `turnCountsOf`, and keeps its class. `tools.ts` reads a fetch's title and lists the pages read, `https` only, a page's number being its place in the list. The row `researchWriter` is named by the call.
- **The report sensor** `lib/sensors/report.ts`, with its seven rules. A page written `[n]` in the text counts as a reference. The paragraph that crosses the 600th word goes, with every one after it.
- **The stub:** the writer's six fixtures, and the version 2 reader's notes, given only to a request carrying the version 2 guide's heading.

**The review**, one read-only pass, found two medium and two low, all fixed in the unit's commit:

- **The planner took a provider's failure for the gateway's absence.** A timeout or a server error the provider may have seen, and billed, would have ended a run `SKIPPED · UNAVAILABLE`, uncounted. Only a call refused before the provider saw it now does, as § 5.3 says; the others are `FAILED · PLANNER_FAILED`.
- **A page's title reached the writer**, unbounded and unchecked: a page could pass instructions past the 60-word note. The writer now reads a page's number and note, never its title or its address. The guide and architecture's table and threat model say so.
- **The asker's id in the metadata** is a limit, now written in § 22. A canary case for an individual account shows it in each request's metadata and in no prompt.
- **The docs**, this section and the tracker.

**Verified:**

- type check and lint;
- the unit suites of the agents, the sensors, the gateway, the schemas, the guides, the stub and the legacy research: 414 tests;
- the canary across the three calls, for an organisation and for an individual;
- `npm run secrets:scan`: 241 files, none found.

## 30. As built (unit 70: the run on demand, 2026-10-12)

Built as § 5, § 6, § 7, § 15 and § 17 say. Nothing starts a run before unit 71: the suites write the run's rows themselves.

- **70a, the door** (`lib/db/research.ts`): a person's run's reads inside the asker's context (`readConversationRun`, the question, the seed, the earlier runs, the steps, the report) and its guarded writes — the question redacted again with its hash, `writingAt` once, the report, the reset at the cap, the sections and the targets with the brief. The live steps are two raw statements, registered in `RAW_SQL.md`: an append whose `seq` is the step's place, taken in the same statement (`once` for a retried step), and a `jsonb_set` that lands only on the step of that `seq`; both bind the asker's id and refuse a run whose text is gone. `ENDED_STATES` gains `REFUSED`; `runsStartedSince` leaves out `SKIPPED · BUDGET` and `SKIPPED · UNAVAILABLE`. `normalisedQuestion` is `lib/research/question.ts` (with `questionSha256Of`), `ResearchMarkRow` `lib/research/view.ts`. `purgeResearchRuns` purges each run by its own age through its owner statement, and the nightly job calls it after `purgeAssistantText`. **The sweep** reads "detached" as `"messageId" IS NULL AND "conversationId" IS NULL`; its test was written first and failed on the code as built, deleting a live research. It keeps a sent finding while `finding:<id>` runs, and a second pass deletes the detached `REFUTED`, `DUPLICATE` and ended `SUBMITTED` findings. `readerStats` reads by kind; retrieval takes an optional `ref`; `researchCallsOf` returns each row's instant.
- **70b, the run**: `ResearchRunWorkflow` (`workers/workflows/researchRun.ts`) and its seven activities (`workers/activities/researchRun.ts`), the agents' steps in `workers/research/run/`, all as § 5.1's table. `WorkflowDefinition` gains `executionTimeoutMs`, which `sdkEngine`'s start passes as `workflowExecutionTimeout`. The record is `recordPersonRun`, with `frontierCallsOf` splitting the reader's calls from the writer's at `writingAt`. Lines gain `research.write`.
- **70c, the views**: migration `20261012180000_research_views` — `ResearchSpend` by run and by payer (`platform` for every call of the research principal, the organisation named `Research` with no seats, and since the review the organisation whose `researchPrincipal` is true; `person` for anyone else's `RESEARCH` calls and their retrieval naming a run), and `ResearchFlag`. `cap.sql` counts the platform's refusals alone, `cost-per-run.sql` the calls that name a run, and a sixth statement, `flags.sql`, the flags by kind and reason. The grants, the dashboard and its rule are regenerated. Spec 44 § 4, spec 45 § 3.5, architecture § 3.1, § 4, § 5.2, § 5.5, § 6.3 and the tracker's gateway numbers are amended.

Decided here, for the review:

- **No record where no planner answered.** A run's record has `planned: failed` whenever a planner call was answered and the run has no brief and no refusal: a parse failure, a brief sensor's check, and also a timeout, a cancellation or text gone after that call. It has `planned: failed` too, with no brief's hash and no reader or writer, where a brief was stored and no reader was ever called: a delete, an erasure or a cancellation between `planRun` and `readRun` (the review's second finding). Where no planner answered (`SKIPPED · BUDGET`, `SKIPPED · UNAVAILABLE`, text gone first) there is no record, since nothing was spent on a model.
- **The codes the engine gives.** A step the engine timed out (a missed heartbeat) ends `FAILED · TIMEOUT`, and any code that is not one of ours ends `FAILED · INTERNAL`. A check (`validateRun`) failing with anything but `TEXT_PURGED` is "a defect after the read", the catch-all's.
- **A run another hand ended.** `loadRun` answers `ENDED` for a row already ended (a start the web tier took back after the engine had it), and the workflow returns without concluding.
- **A cancellation** is concluded and then thrown on, so the engine closes the run as cancelled.
- **The question's hash** is rewritten with the question when the workers' redaction changes it, so the row and the record keep one hash.
- **The platform's principal in the views** is the organisation whose `researchPrincipal` is true, which `ensureResearchOrganisation` sets and finds it by; a view cannot read `RESEARCH_PRINCIPAL`. As first built it was recognised by its name and zero seats (the review's third finding).
- **`finding:<id>`** has its id form in `lib/schemas/workflows.ts` now. Until unit 74 enters `SendFindingWorkflow` in `WORKFLOWS`, the nightly job answers "not running" for such an id, which is the engine's own answer today.
- **The run's view** (`ResearchRunViewSchema`, § 16) is left to unit 71, whose endpoint it serves. Unit 70 builds the door's reads that view needs.
- **The end-to-end suite** is a file of its own, `tests/integration/research-on-demand.test.ts`, beside `research-run.test.ts`, which stays the legacy run's. The suites that apply `init.sql` share a lock (`METRICS_ROLE_LOCK`), since two sessions granting at once fail.
- **Deploy note.** `hb_metrics`'s grants on `ResearchSpend.payer` and on `ResearchFlag` exist only once `infra/observability/init.sql` is applied again (the `observe-init` service). On a Grafana already running, `cap.sql`, which reads `payer`, and `flags.sql` fail as `hb_metrics` with a permission error until then. The migrations come first, then `observe-init`, then the workers' restart.

**The review**, one read-only pass, found six, all fixed in the unit's commit:

- **A cancellation did not stop the agent's step that was running.** The steps are cancelled `TRY_CANCEL`, but the heartbeating wrapper never read the activity's cancellation, so after the workflow concluded `FAILED · CANCELLED` the reader went on streaming for up to half an hour on the person's key and could write `found` onto the ended row. The wrapper now races the work against the activity's `cancelled`, so the step ends at its next heartbeat; the work is handed the activity's `cancellationSignal`, which `callModel` and `callModelTurn` pass to the SDK's request, so the reader's stream is aborted; and the read and the write store nothing once it has fired — no counts, no `found`, no report — failing `CANCELLED`, which nobody awaits. The planner's and the writer's requests are not streamed and are not aborted (ten and five minutes at most); their answers are dropped by the race. The workflow suite's cancellation case runs the real read step and activity on the test server and shows the step ended before the reader answered, its signal aborted, and nothing written after.
- **A run whose planner was paid had no `RESEARCH` record when its reader never ran.** A delete or an erasure between `planRun` and `readRun` ended the run `SKIPPED · TEXT_PURGED` with a brief and no frontier call, which `personPayloadOf` took for a record it could not name. Such a run is now recorded `planned: failed`, with no brief's hash and no reader, which the payload's refines admit.
- **The platform's principal was found by its organisation's name.** An additive migration, `20261012200000_research_principal`, adds `Organisation.researchPrincipal` (default false) with a partial unique index, one principal at most, marks the organisation the command had made, and redefines `ResearchSpend` to join on the column, its seven columns and their grants unchanged. `ensureResearchOrganisation` sets it and finds the organisation by it, and a racing second command finds the first's row. The views' suite shows an organisation named `Research` with no seats paying as a person, and a second principal refused.
- **The purge test passed only alone.** The other cases' runs, stamped by the deletes they stood for, made three researches to stamp where it counted one. The case now wipes the asker's rows first, and passes alone and with its file.
- **A research's purge stamp went stale after a later follow-up.** No door inserted a person's run yet (the suites wrote their rows; the start is unit 71's), so the door gains the insert: `createConversationRun`, one transaction that locks the research `FOR UPDATE` as its delete does, takes the next ordinal, inserts the run `QUEUED` with its workflow's id and the question's hash, and moves the research's `lastRunAt` and clears its `textPurgedAt`. Unit 71's start reads its checks again under that lock. And the purge clears a stamp where a run of the research holds text.
- **The docs:** architecture's retention row now says the question also reaches retrieval's embedding and re-rank; the record sentence above; the deploy note; this paragraph.

**Verified:**

- type check and lint on every touched file;
- the unit suite: 2,418 passed after the review (2,413 before it), with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded. This includes the workflow suite of § 26 on the time-skipping server (eleven cases: a real heartbeat timeout, a real cancellation that stops the read it finds running, and a history of ids);
- migration `20261012200000_research_principal` applied to the development database, its research organisation marked, the dashboard's grants on `ResearchSpend` kept;
- the database suites `research-rows`, `research-run`, `research-door`, `research-on-demand`, `research-views`, `conversation-delete`, `assistant-stats` and `observability`, with the purge filter: 76 passed. The research purge case of `research-door`, whose purge is scoped to the suite's own asker (`purgeResearchRuns({ reader })`), was run on purpose after the review, alone and with its file: 1 and 8 passed;
- `npm run secrets:scan`: 241 files, none found.

## 31. As built (unit 71: the research API and its policy, 2026-10-12)

Built as § 5.2, § 13, § 14, § 15 (`ERASED` and the pack), § 16, § 17.2 and § 18 say, but for the export (unit 73) and the findings' two endpoints (unit 74).

- **71a, the policy:** `policies/hb/research.rego` — `create` for any person, the owner's `read`, `list`, `ask`, `write`, `export` and `delete`, no service — with `policies/tests/research_test.rego`: another person, anonymous, a service, an organisation's admin on a member's research, another organisation's, a resource with no owner. `ResourceKindSchema` gains `research`. The `finding` kind and its `submit` rule are unit 74's, with their deny cases.
- **71b, the endpoints** (`lib/api/endpoints/research.ts`, `app/api/v1/research/`): open (201), read, delete, start (202), the run's view, the flag, in `ALL_ENDPOINTS` and `openapi.json`. The start runs § 5.2's eight checks in order, redacts, applies `otRule` (new in `lib/sensors/scope.ts`, which `scopeRules` now asks for its two OT rules) and the unverified-chapter rule (`chaptersPassed`, moved to `lib/db/content.ts`), then `createConversationRun`, which now reads check 3's newest run and check 7's count again under the research's lock, inserts a rule's refusal as an ended `REFUSED` run with no workflow, and answers a `P2002` as `IN_PROGRESS`. The door gains the conversation's create and read, the seed's facts, the start's reads (`newestConversationRun`, `researchStartGates`, `latestBudgetReset`, `dailyLimitUntil`), `deleteResearchConversation` (its lock registered in `RAW_SQL.md`), `flagResearchRun` and the two views; the view itself is `lib/research/runView.ts`, pure; a run's cost is `runCostOf` (`lib/db/budget.ts`). The ten error codes of § 13 and their `api.errors` strings; the audit pack's `answers` and its label.

Decided here, for the review:

- **`seed`** in `ResearchConversationSchema` is the seed answer's id, or null.
- **The two free rules' order** is § 5.2's listing: the plant-equipment rule, then the unverified-chapter rule. That is the reverse of the Assistant's `scopeRules`, which asks the unverified chapter first, so a question that is both is `REFUSED · R-SCOPE-OT` here and `R-UNVERIFIED` in the Assistant. `OT_POINTERS` moved to `lib/sensors/scope.ts`, so the card's pointers and the Assistant's are one constant.
- **Check 6** reads the latest of the person's runs that had a workflow (`ordinal` set, so never a legacy run, which one answer still makes until unit 75; a workflow, so never a rule's refusal, which never reached the gateway).
- **Check 7's reset** is the thirtieth newest counted run's start plus 24 hours. The count is `runsStartedSince`'s, so until unit 75 a person's automatic runs share the thirty.
- **A rule's refusal** takes the next ordinal under the same lock and the same two re-reads, and is ended as it is inserted.
- **The seeded run** (`isSeededRun`, `lib/db/research.ts`) is a run of a seeded research no earlier run of which planned, that is, had its brief stored (`briefSha256` set, which the purge keeps). Ordinal 1 alone would not do: a first question a rule refused, a start the engine refused or a stale run ended at the next start leaves no brief, and the next question is still the one the seed is for. A planner's refusal, failure or cap leaves none either. The one predicate decides three things: the insert's `gap` (`Message.substituted > 0`) and cited sections, at most ten, which the plan completes (decided under the research's lock, the endpoint reading the seed for any start of a seeded research); the seed the planner reads (`readRunSeed`); and the view's `seeded`. Every other run is inserted with no `gap` and no sections. An earlier run has always ended before a later one is inserted, and no brief is written onto an ended run, so a run's answer never changes.
- **A start in flight.** A start commits its row before it asks the engine, so a second start in between finds no workflow. Check 3 answers 409 for a `QUEUED` row younger than `START_IN_FLIGHT_MS` (60 s; a start's request asks the engine twice, five seconds each at most) and leaves the row alone. It ends an older one, or a row in another state under way, only on the state it read, and a write that changed nothing (its workflow, its start or another start moved the row) is 409. So two starts at once are one 202 and one 409, and the first never answers after its row was ended. The read of the row after the start is gone. What is left is a start whose request outlives the minute: its row may be ended before its engine call arrives, and its workflow then finds the row ended and returns (§ 30).
- **A refused start:** any failure of the start takes the row back to `SKIPPED · UNAVAILABLE`; the engine's own (`WorkflowsUnavailableError`) is 503 `RESEARCH_UNAVAILABLE`, anything else a 500 after the take-back.
- **The run's line** has fourteen keys (`RESEARCH_RUN_LINE_KEYS`), one per row of § 18, `done` and `donePurged` apart. A run is under way in the states `ENDED_STATES` leaves out, stale 90 minutes after it was created.
- **A finding's class and change** are computed as a submission computes them, against its anchor in the current release, which is the class a draft or a send would be given (§ 8.2 step 4); an anchor the release no longer has keeps its kind and id, with no section, class or change. A suggestion's id is shown for a `DRAFTED` and a `PROPOSED` finding only; a sent, refuted or duplicate one's is withheld until unit 74's `duplicateVisibleTo`; `href` is null until unit 74 gives it.
- **A refusal's card:** its code is its cause, as the Assistant's (`REFUSAL_CODES`); `R-PERSONAL`, like `R-UNVERIFIED`, has no pointers, since § 5.3 names the run's two sections for `R-SCOPE` alone.
- **The run endpoints serve a research's runs only:** a legacy run, and a run a delete detached, is a 404.
- **A flag's kind** must be the run's — a report on a `DONE` run with one, a refusal on a `REFUSED` run — and its reason is any of `FLAG_REASONS`, as the Assistant's flag takes any. A flag already standing is tested first: a second flag is 409 `FLAG_DUPLICATE` whatever the run is now, with the flag that stands in its `detail` (`{ kind, reason }`, both codes; § 18).
- **The cost** is the `RESEARCH`, `EMBED` and `RERANK` rows that name the run, under the principal it was charged to; null where there are none.
- **The document** says 200 for the open's 201 and the start's 202, as it does for every endpoint that answers a `Response` (the evidence item's 202 among them): the generator writes one success status.

**The review**, one read-only pass, found two medium and two low, all fixed in the unit's commit:

- **Check 3's end raced a start whose engine call was still in flight.** A start commits its row `QUEUED`, then starts the workflow. A second start that asked the engine in between found nothing and ended the row `FAILED · ABANDONED`. If that landed after the first's read of its row, both answered 202, and the first's workflow, already past `loadRun`, could pay its planner. If it landed before, the first answered a 409 for a second start that might itself fail a later check. Now a `QUEUED` row younger than `START_IN_FLIGHT_MS` is answered 409 and left alone, and the end is `abandonConversationRun`, conditional on the state read, whose empty write is 409. The read after the start is gone. As a guard, `planRun`, `readRun` and `writeReport` read the row first and call no model on an ended one: they fail `RUN_ENDED`, and the conclude writes nothing over the other hand's end. Its record and line say what the row says, a record only where a planner was paid before (§ 15). The research API suite holds the first start's engine call open and asserts 409 for the second, the row untouched and 202 for the first; it also moves a stale row while the engine is asked and asserts 409 with the row as moved.
- **The seed went to ordinal 1, which may never have planned.** A first question a rule refused, a refused start or a stale run left the rephrased question at ordinal 2 treated as a follow-up: no `gap`, no cited sections, no seed for the planner, `seeded` false. The seeded run is now `isSeededRun`'s (above), one predicate for the insert, `readRunSeed` and the view. The research API suite refuses a seeded research's first question by the plant-equipment rule and asserts the second carries the seed. A run after one that planned does not.
- **A second flag on a run the 30 days reached answered 422.** The purge takes the report and keeps the flag, so the kind test failed before the duplicate test. The duplicate is now tested first, and its 409 carries the flag that stands, which § 18 reads back.
- **The audit label dropped "deletions"**, though the `ERASED` records sit under the checkbox. Spec 46's unit 65b also meant to change the same string. The label is now "assistant and research records, and deletions" ("registros do assistente e de pesquisa, e exclusões"), and spec 46 § 3.6 and § 6 are amended so that 65b adds "deletion requests" to it (§ 21). Also written down: the start's two rules run in the reverse of `scopeRules`'s order (above).

**Verified:**

- type check and lint on every touched file;
- `opa test policies`: 86 passed, the research file's 8 among them; the contract suite against a policy server started on another port from this tree: 17 passed. The sidecar on 8181 has since been restarted with this policy, and the contract suite passes against it too (17);
- the unit suite: 2,468 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded, and one of the workflow suites (`merge`, `suggestion`) timing out at 5 s in the parallel run on this machine, each passing alone. After the review: `lib/api`, `workers/activities`, `lib/research`, the audit schema's and the workflow suite `tests/workflows/researchRun.test.ts`, 323 passed;
- the database suites `research-api` (new; fifteen cases after the review: the checks in order with the rows they leave, two starts at once, a start in flight, a stale row moved while the engine is asked, the seed after a refused first question, the delete and a start that loses the lock to it, the views and the flags), `research-door`, `research-rows`, `research-on-demand`, `conversation-delete`, `unverified-rule`, `assistant-stream` and `content`, with the purge filter. After the review: `research-api`, `research-door`, `research-on-demand` and the contract suite, 42 passed;
- `npm run secrets:scan`: 241 files, none found.

## 32. As built (unit 72: the Research page, 2026-10-12)

Built as § 11.1 to § 11.5, § 12 (the header, `data-dock` and `AskShortcut`'s query), § 16, § 18, § 19 and § 20 say, but for the statistics' cells, the flags, the delete, the export and `Copy report` (unit 73) and the findings' buttons (unit 74).

- **72a, the classes** (`app/globals.css`, ui-context § 9.9's table, § 10, § 13.2 and § 13.3): the page reuses `.assistant-page` and its regions as they are; `.research-page` sets the column's frame line; the run block's classes (`.run`, `.run-body`, `.run-steps`, `.run-report`, `.run-ref`, `.run-pages`, `.finding`, `.run-actions`), the seed card's body and the list's run rows are new. The containers that are empty take no room.
- **72b, the page:** `app/[lang]/research/page.tsx` with its loader `lib/db/researchPage.ts`; `lib/research/links.ts` (`researchPageHref`, `researchPageStateOf`, `researchRefHref`, `runPageId`); `lib/research/runBlock.ts` (the line's parts, the steps' words and counts, a report paragraph's pieces, a finding's outcome line) and `lib/research/summary.ts` (`lineOfRuns`), pure; `lib/hooks/useRunFollow.ts` (`createRunFollow`, one state object, and the hook, which says it lost the run on a 401, 403 or 404 as after the 90 minutes); `components/research/` — `ResearchDock` (the page's column; its dock form is unit 77's), `ResearchConversations`, `RunBlock`, `RunLine`, `RunSteps`, `RunReport`, `RunPages`, `FindingCard`, `SeedCard`. The door gains `listResearchConversations`, `researchConversationCounts` and `readSeedView`. `Composer` gains `namespace` and `busy` (and, in the review, `restore` and a form `ref`), `ErrorBox` an optional `ref` that makes it focusable, and `RefusalCard` `hrefOf` and `foot`; `TopBar` gains `Research`; the Assistant's dock carries `data-dock="assistant"` and `AskShortcut` finds it by it. `RESEARCHER_GUIDE_VERSION` moved to `lib/schemas/researcher.ts`, which the workers' `plan.ts` reads, since the page's header names it and the web tier imports nothing of `workers/`.
- **The seed:** `npm run research:seed` now writes the page's states first (`tests/fixtures/research/page.ts`): six researches — done with a follow-up, under way, refused, stopped, purged, seeded — and an Assistant answer to seed from, as rows with no workflow, so none counts toward the thirty or is the start's budget reset. The Assistant's legacy research lines stay its second part until unit 75. `--page` writes the first part alone, `--account` another account, `--report` elsewhere; the page's browser suite seeds its own account this way.

Decided here, for the review:

- **The third region** holds the budget meter alone, in an `aside` labelled `research statistics`, until unit 73's cells.
- **A finding's outcome** (`drafted · S-…`, `sent …`, `already proposed …`, the purged sentence) is shown as a line with no button: § 11.3's purged run needs it, and unit 74 puts `FindingAction` in its place. Sources are listed by host, not linked.
- **The line's words.** A detail that is the word's object joins it with no `·` (`reading the web`, `checking the findings`, `writing the report`), as § 18 writes them; so `research.line.detail.writing` is `the report` (`o relatório`), not `writing the report`, which would read `writing · writing the report`.
- **Strings beyond § 19:** `research.dock.release`, `guide`, `log`, `openAssistant`; `research.seed.capNone`, `open`, `invalidTitle`; `research.run.label` (`research {n}`), `capStarted` (the caption without a duration while the run is under way); `research.steps.folded`; the two notices' titles; `research.errors.retry`, `network`; `research.list.empty`, `more`, `runs`, `close`. The thirty is `{max}` from `RESEARCH_RUNS_PER_DAY`, never a literal; `research.actions.cost` is plural-aware.
- **What the log announces.** The run's caption and its cost row are `aria-live="off"` beside the steps, report, pages and findings, and a question asked is rendered at once in the block its run becomes (keyed by ordinal), so the log reads each state once: the browser suite counts seven texts from the empty column to `done`, through twenty steps.
- **The composer's closed states** are read by the loader, each the start's own check: the engine unconfigured and the organisation's switch (with their notice), the budget's reset (`See the meter` → the account's meter) and the day's thirty (the time the next one frees). A start answered 402, 429 or 403 closes it the same way, under an `ErrorBox` with the answer's words. Any start not answered 202 gives the question back to the field with its language (`Composer`'s `restore`); `Retry` follows a 503, a 500 or a request that did not arrive, and submits the form, so it posts what the field holds, under the same key while the question is unchanged. The submit leaves the focus in the field, which is read-only while a run is under way and keeps the focus after an answer that leaves it enabled; an answer that closes the composer disables it, and the focus goes to the `ErrorBox`.
- **The list** labels a research by its runs' targets, counts every run, refused ones among them, counts the findings that passed (every outcome but `INVALID`, as a run's line counts them), and, only when one was, how many of them were used — drafted or sent, whatever became of them. Each part of the meta is kept whole with its `·` (`.research-meta-part`), so the 232px row breaks between parts. A research opened by this session stands at the instant its open's 201 answered (`createdAt`), or the page's `openedAt`, until the server lists it; after any start's answer the router is refreshed, so the server's row, and a 503's `SKIPPED · UNAVAILABLE` run, replace what the column built. `n` is rounded up to a step of twenty.
- **The seed card** stands above an open seeded research's first question with its header alone, and reads `from an answer that was deleted` once the answer is gone; an invalid `from` is taken off the URL by `replaceState`, so the notice stays on screen.
- **A page row is a link only for a web address**; `researchRefHref` encodes an id that is not a section's.
- **Under 1000px** the region switch's first value is `dock`, the Assistant page's name for the column, so its CSS applies unchanged.
- **The header's fifth item** makes the top bar wrap to three rows from 768px to 852px in EN (to about 840px in PT), where it wrapped to two; nothing overflows. From 1000px to 1199px it left the middle cluster 148–362px wide, too narrow for the search field and the release stamp side by side, so the stamp is hidden there (`app/globals.css`, ui-context § 9.8's chrome row); the status bar carries the release on most pages.

**The review**, one read-only pass, found six, all fixed in the unit's commit:

- **The list's row read wrong.** `no finding used` repeated the run line's `no finding`, which means none passed; it always wrapped at the list's 232px, leaving `used` alone; and it was always 0 in this unit. The row now says the findings that passed (`listResearchConversations` and `lineOfRuns` count them, every outcome but `INVALID`) and, only when one was, `· {u} used`; each part is a `.research-meta-part` that never wraps, its `·` kept with it. In PT a row counts `execuções`, as the list's own label does; the header's count stays `pesquisas`. § 19's `research.list.line` became `lineRuns`, `lineFindings` and `lineUsed`, still candidates.
- **A failed start lost the question, and a 402 or a 429 closed the composer silently.** `Composer` cleared the field on submit, and nothing gave it back. Now any answer but 202 gives the question and its language back (`restore`), with an `ErrorBox` in the log: a 409 or a 422 leaves it in the enabled field, which keeps the focus; a 402, a 429 or a 403 closes the composer, and the box (`ErrorBox`'s new `ref`, `tabIndex={-1}`) takes the focus from the field it disables. `Retry` submits the form, so it posts the text the person can see, under the same key while it is unchanged. The browser suite answers the start 503, then 402, then 429.
- **A new research's row read `01 Jan`** when its first start failed: `lineOfRuns` fell back to the epoch. The row now stands at the `createdAt` the open's 201 answered (the schema had it), or the loader's `openedAt` for an open research with no run; and the router is refreshed after any start's answer once the research exists, so a 503's `SKIPPED · UNAVAILABLE` run appears.
- **The top bar's release stamp overlapped the search field from 1000px to about 1160px on every page**, and wrapped out of the bar at 1000px and 1040px: the fifth item left the middle cluster 148–362px wide. The stamp is hidden from 1000px to 1199px (ui-context § 9.8's chrome row). Measured on the Research page, the Assistant page and a chapter, EN and PT, at 1000, 1040, 1080, 1120, 1160, 1199, 1200, 1240, 1280 and 1360px: no two items overlap and none leaves the 48px bar. The three-row wrap under 1000px was measured again: 768px to 852px in EN, to about 840px in PT (the sentence above said about 810px).
- **The seed card's region was named like a link** (`Open the answer`): it is `aria-labelledby` its header's text.
- **A follow stopped by a 401, 403 or 404 left the run under way for ever**, the composer busy with it. The stop now says it lost the run, as the 90 minutes do: the line reads `reload to follow` and the composer is free (§ 6).

Verified (before the unit's review, which is the caller's):

- type check and lint on every touched file;
- the unit suite: 2,500 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded, and `tests/workflows/researchRun.test.ts` timing out once at 5 s in the parallel run, 11 of 11 alone. Twenty-seven cases are new: the links, the run block's words, the list's line, the follow (stops at an end and when stale, on 401, 403 and 404, a 429's wait, a 5xx and the network retried, nothing while hidden, the 90 minutes), and the duration's format;
- the database suites `research-page` (new, four cases: the list, the counts, the seed's card and another person's, the loader's open, foreign and seeded states, every seeded view parsing as the endpoint's) and `research-api`, with the purge filter: 19 passed;
- the browser suite `tests/e2e/research.spec.ts` (new), EN and PT: 13 passed — a real start as an individual account with no gateway key (`SKIPPED · UNAVAILABLE` at the planner, nothing spent), the steps one by one from the run's view served in place of the server's, the announcements, the follow-up's page ids, the reader with no Assistant dock, `a`, `?from=` with no write, the invalid seed, axe on seven states, and the widths 1440, 1360, 1200, 1000, 900 and 390; the Assistant's delete and keyboard suites: 6 passed;
- the PT truncation suite: 103 screens, none truncated, 22 of them new (eleven Research page screens at 1440 and 390);
- in Chromium, every state (eleven: empty, seeded, invalid seed, done, under way, refused, stopped, purged, seeded and open, the list, the statistics) at 1440, 1200, 1000, 900 and 390 in light and dark, EN and PT, and three of them at 1360: no horizontal overflow, axe clean, no page error;
- `npm run secrets:scan`: 241 files, none found.

Verified after the review:

- type check and lint on every touched file;
- `lib/research`, `lib/hooks`, `lib/i18n` and the catalogues' suite: 125 passed (the follow's 401, 403 and 404 case now asserts the run lost; the list's line counts the findings that passed);
- the database suites `research-page` (the list's findings beside its used) and `research-api`, with the purge filter: 19 passed;
- the browser suite `tests/e2e/research.spec.ts`, EN and PT: 15 passed, the refused start's case new; the Assistant's delete and keyboard suites: 6 passed; the PT truncation suite: 103 screens, none truncated;
- in Chromium, starts answered 409, 422, 403 and a request that never arrived: the question kept every time, the focus in the field, or on the box for the 403; the list's longest meta in EN and PT at 232px: no part split;
- `npm run secrets:scan`: 241 files, none found.

## 33. As built (unit 73: the page's statistics, flags, delete and export, 2026-10-12)

Built as § 11.6 to § 11.10, § 13's export row, § 15's `EXPORT` scope, § 19 and § 20 say, but for the points below. The findings' buttons stay unit 74's.

- **73a, the statistics:** `lib/research/stats.ts`, pure (`researchStatsOf`, `usdText`, and `USED_OUTCOMES`, which the list's door now imports rather than keep its own); `lib/db/researchStats.ts` (`researchStats(user, window, now)`), with `runCostsOf` in `lib/db/budget.ts`, the costs of many runs in one grouped read a principal, beside `runCostOf`; `components/research/ResearchStatsPanel.tsx`, the Assistant's statistics in form — the window's two links, five cells, the retention line — with the budget meter and its `research` row under it. The loader reads the statistics in the window `w` names and the day the oldest held text is kept until.
- **73b, the controls:** `FlagButton` gains `endpoint`, `readBack`, `namespace` and the kind `report` with the answer's reasons; `DeleteConversation` gains `endpoint` and `namespace`; the Assistant's endpoints, read-back and words stay the defaults. `RunBlock`'s action row holds `Copy report` and `Flag this report` on a run that ended `DONE` with a report (`copyReportOf` in `lib/research/runBlock.ts`; `copied` in the status bar's `StatusNote`, which the page now renders), and a refused run's card the refusal's quiet `Flag this refusal`. `ResearchConversations`'s open block ends with `export JSONL`, where the research has a record, and `Delete research`; `?deleted=<id>` starts the column's session afresh (the id is part of the identity `ResearchDock` keys its session by; the page's `key` on the column went in the review), the list says `Done · Research deleted.` in a `role=status` line, `New research` takes the focus described by it, the composer does not take it, and between 1000px and 1359px the overlay opens. **The export:** `researchConversationExport` (`GET`, `writes: true`, the policy's `export`, `EXPORT_RATE`) and its route; `researchRecordSeqs` in `lib/db/research.ts`, and `researchRecordsAt` in `lib/db/ledger.ts`, `researchRecordAt`'s predicate for the research's step keys in one statement; `lib/ledger/export.ts`'s scope by `seq` takes the kind `research`, which the trailer and the `EXPORT` record name; `openapi.json` regenerated. No rego change (the owner's `export` was unit 71's), no migration.

Decided here, for the review:

- **`NOTHING_TO_EXPORT` is a 404.** § 11.10 and § 13 said 422 "as the Assistant's", but the catalogue (`lib/api/errors.ts`) answers the code 404, for the Assistant's export and a suggestion's alike. The code is the contract and its status the catalogue's, so the research's is 404 too; changing it would change two exports that ship. § 11.10 and § 13 now say so.
- **The runs the statistics count:** the person's runs in their researches — so a run a delete detached goes with its research, and a legacy run, the platform's, never counts — with a workflow, started in the window; the flags alone count every run, a rule's refusal included (the review). A run ends `done`, `refused`, `stopped` or `failed` by the word its own line reads (§ 18: `stopped` takes the cap mid-run, the engine's silence, a stale run and text gone mid-run); one under way, not started at the cap or not run is a run and none of the four, as its line says none of them. The cell says `runs` (`execuções`), not `researches`, which the list counts (the review).
- **Per run** divides the cost by the runs charged anything, so one that spent nothing (not run) does not lower the price of one that did. Money is read as a number at a range check and printed to four decimals at most with no trailing zero (`0.61`, `0.0042`), with a `.` as the run's cost row prints it.
- **Accepted** never counts a duplicate: it doubles another suggestion, which is not the one the finding made. A draft's suggestion is read by the owner's own list (`listOwnSuggestions`), a sent one's by `readProposalsForAsker`, each only where a finding names one.
- **Pages seen** add up the runs whose `found.read` is held, each its array's length read in SQL (`pagesSeenOf`, lib/db/RAW_SQL.md; the review); with none held the part reads `— pages seen`.
- **Flagged reports** counts every run with a flag, a refusal's among them — a rule's too, which has no workflow (the review) — as § 11.6's "the runs with a flag" reads. A window whose only run is a flagged rule's refusal shows the cells, not the empty line.
- **The refusal's flag** is built here with the report's (§ 11.7), on every refused run, a rule's refusal included, which the endpoint takes. After a 409 the flag that stands is read back from the run's own view (§ 11.7), not from the 409's `detail`.
- **A cell's line, one part to a row** (`3 done`, `2 refused`, …): a run-on line in a cell about 117px wide parted a count from its word, in EN and in PT. § 19's `ends` and `findingsLine` are split at their ` · `; the sources' line is four keys of its own, a count before its words.
- **`Copy report`** writes a paragraph's sections as `[21.3]` after it, as `Copy with citations` writes them, so what is copied is what the paragraph shows; § 11.9 names the page markers alone.
- **The export link** is offered only where the research has a `RESEARCH` record (the loader asks `researchRecordSeqs`), since a `download` link to a 404 saves an error body; the Assistant offers its export on any turn. A research of none — every run refused by a rule, or never answered by a planner, as a development account's `SKIPPED · UNAVAILABLE` runs are — has no link, and its dialog no `Export JSONL first`.
- **The window's labels** are the Assistant statistics' own (`assistant.stats.month`, `all`, `windowLabel`).
- **Strings beyond § 19**, candidates: `research.stats.usd`, `perRun` (`perResearch` until the review), `searches`, `pagesOpened`, `pagesSeen`, `pagesSeenNone`, `empty`; `research.actions.copied`; `research.list.export`.
- **The research seed's runs carry their workflow ids** (unit 72 wrote none), since the statistics count only runs with one; the rule's refusal keeps none, and the seeded research's report is flagged (`wrong_citation`). So nine of the seed's runs count toward the person's thirty, as real ones would; the budget's reset the start reads is still none, the newest run meeting no cap. No `BudgetLedger` row is written, since those rows are never deleted again. Run again, the seed removes the runs a delete of one of its researches detached, which keep its trace (the review). The demo reader's states were seeded again on this machine (`--page`).
- `lib/db/auditExport.ts` tells a scope by `seq` by its `seqs`, as `lib/ledger/export.ts` now does, where it named `messages`; and `export.ts`'s `kinds ?? []`, a branch no scope reaches, is gone, so `npm run test:ledger` is at 100 % branches again.

Verified (before the unit's review, which is the caller's):

- type check, and lint on every touched file with no warning;
- the unit suite: 2,514 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded, and `tests/workflows/suggestion.test.ts` timing out once in the parallel run, 26 of 26 alone. New: the statistics' arithmetic (7), `Copy report` and the line's word (3), the export endpoint (3), the ledger's research scope (1), the walk of § 16 reading the views and not the download; `npm run test:ledger`: 100 % branches;
- `opa test policies`: 86 passed;
- the database suites `research-stats` (new: each cell against a count in SQL, in the month and over all time; another person's nothing; a research's export signed with a key made in the suite, the file verifying with its public half, one `EXPORT` record of scope `research`, `NOTHING_TO_EXPORT` and `NOT_FOUND`, the page's link only with a record), `research-page`, `research-api`, `research-door`, `research-rows`, `research-on-demand`, `assistant-stats`, `conversation-delete`, `ledger` and the contract suite (the export's case added), with the purge filter: 82 passed, 4 skipped;
- the browser suite `tests/e2e/research.spec.ts`, EN and PT: 23 passed, eight new (the statistics; the flag and the refusal's flag; the delete; the overlay at 1200px; `Copy report`); the Assistant's delete and keyboard suites: 6 passed;
- the PT truncation suite: 113 screens, none truncated, ten new (the statistics over all time, the two flag dialogs, the delete dialog and the list after a delete, at 1440 and 390);
- in Chromium as a development account of its own with no gateway key, seeded with `--page --account`: the done, all-time, refused, seeded and PT states at 1440, 1200, 900 and 390, the statistics in front and the PT list under 1000px, and the delete and flag dialogs at 1440 and 390 in EN and PT, light and dark (68 screens): no horizontal overflow, axe clean, no page error; the list's and the dialog's export downloaded a file that verifies with `infra/ledger/export-public.pem`, with one `EXPORT` record of scope `research`; a flag stored once and a second answered 409, the stored one shown after a reload, the flagged cell moved; the copied text; a delete at 1440 and 1200 with the status line, the focus and a 404 after;
- `npm run secrets:scan`: 241 files, none found.

**The review**, one read-only pass, found eight, all fixed in the unit's commit:

- **After a delete, the first research started remounted the whole column.** The page keyed `ResearchDock` by `deleted`; a start at `?deleted=<id>` puts the new research on the URL by `replaceState`, so its refresh rendered the key `page`: a 503's question, box and `Retry` went, a run's start that never arrived lost the question, and a 202 dropped the focus to the body. The key is gone. The delete's id is now part of the identity `ResearchDock` keys its session by (`research:seed:deleted`), so the delete's landing starts the session afresh (`railOpen` from it, the focus on `New research`) — also for a research this session opened that the server had not listed yet, whose delete alone would have left the identity `none:` — and the first start after it is the research this session opened catching up; `New research` from there starts the session again, the overlay it opened closed. The browser suite: a delete, then a start answered 503, the question, the box and `Retry` there after the start's refresh (the case fails with the key put back); and at 1200px `New research` closes the overlay, the field in focus.
- **A deleted seeded research's runs outlived the seed.** The seed's runs have workflow ids, so a delete detaches them, and `clearResearchPage` read only runs in a research: the detached ones kept the seed's trace and counted toward the day's thirty for 24 hours. It now deletes the account's runs of the seed's trace in no research and of no message, their findings by the cascade. `scripts/research-seed.ts` said no seeded run counts toward the thirty; it says nine do, and why.
- **A rule's refusal's flag was never counted.** The door read only runs with a workflow; a rule's refusal has none and takes a flag. It reads every run in the person's researches in the window, each with `workflow`, and `researchStatsOf` counts the flags over all of them and every other cell over those with a workflow; a window whose only run is a flagged rule's refusal shows the cells, not the empty line. A unit case, and the database suite flags the seed's rule refusal and counts the flags in SQL over every run.
- **Two comments said 422** for `NOTHING_TO_EXPORT` (the export's endpoint, the loader): they say 404.
- **The delete dialog said "one record per research"**; the chain keeps one `RESEARCH` record per run that reached a planner. `research.delete.body` and § 19 say "one record per run" (`um registro por execução`).
- **"researches" meant two things:** the statistics' first cell, runs by § 11.6, read `researches` beside the list's `6 researches`. The cell is `runs` (`execuções`) and its cost `per run` (`por execução`), the empty line `No research runs in this window yet.`; the keys `research.stats.runs` and `perRun`, and `ResearchStats`' `runs` and `cost.perRun`. § 11.6 and § 19 amended; the strings stay candidates.
- **The statistics read every run's whole `found`** for the length of `found.read`. `pagesSeenOf` reads it in SQL, `jsonb_array_length("found" -> 'read')` where it is an array and the text held, bound to the person's id and the runs' ids and registered in lib/db/RAW_SQL.md; a run with no count adds nothing, and with none the part still reads `— pages seen`.
- **The accepted cell was never checked against the database.** The database suite adds two merged suggestions, a draft of the person's own and a researcher's proposal — chapter 93, which no book has, under a rubric version of its own that applies in 2000 — and a `DRAFTED` and a `SUBMITTED` finding naming them in the done research's follow-up; SQL counts the accepted by the suggestions' state, owner and origin, and the cell reads 2. After, the suggestions go back to draft and are deleted with the rubric version (past draft a suggestion is never deleted, 29 § 3); nothing of the suite stays.

Verified after the review:

- type check and lint on every touched file;
- `lib/research`, `lib/i18n`, the catalogues', the improvement door's, the improvement schema's, the research contract's and the research endpoints' suites: 167 passed, the rule's refusal's case new;
- the database suites `research-stats`, `research-page` and `research-api`, with the purge filter: 22 passed;
- the browser suite `tests/e2e/research.spec.ts`, EN and PT: 24 passed, one new and the overlay's case longer. In the first full run the PT case of the 503, 402 and 429 starts, which the review did not touch, lost a `page.goto` to `net::ERR_ABORTED` once; it passed six of six alone and in the second full run;
- the PT truncation suite: 113 screens, none truncated, none skipped;
- `npm run secrets:scan`: 241 files, none found.

**A flake, recorded at the commit (2026-10-12):** the e2e case of unit 72's review, "a start that did not start gives the question back", failed once in three full runs of `tests/e2e/research.spec.ts`, with `net::ERR_ABORTED` on a `page.goto` that the start's `router.refresh()` raced; it passed alone six times and in the other two full runs. The page is not at fault; the case's navigation should wait for the refresh to settle.

## 34. As built (unit 74: turn into improvements, 2026-10-12)

Built as § 8, § 10.3, § 11.3's finding block, § 11.5's `FindingAction` and `ProposalPanel`, § 13's two findings' endpoints, § 14's `finding` rule, § 16's `use`, § 18's finding rows, § 19 and § 21's unit 74 rows say, but for the points below.

- **74a, the rule and the doors.** `policies/hb/research.rego` gains the `finding` kind's `submit` — its owner's, unless they draft (`drafts_findings`: a contributor or above, verified) — and no service touches either kind; `policies/tests/research_test.rego` its deny cases (a verified contributor's, a verified curator's, another person's, an organisation's admin on a member's, a service's, anyone signed out, any other action, a resource with no owner). `ResourceKindSchema` gains `finding`. The improvement door gains `createDraftFromFinding` (the draft as `createDraft` makes one, the proposal and its key, `fromResearch`, an empty rationale, one pending `LINK` item a source up to ten), `liveSuggestionWithKey`, `suggestionVisibleTo` and `ownSuggestionStates`; a person's read, the queue's rows and the history's carry `fromResearch`, a service's never. `POST /suggestions/{id}/submit` checks a `DRAFT` with `fromResearch` against the live keys again, after the intake sensors and before the consent is put on file. `lib/research/submission.ts` holds `submissionOf` (moved from `workers/research/submit.ts`), `findingKeyOf`, `findingSourcesOf` and `sourcesNotAmong`; `sendsMonthOf` is in `lib/schemas/research.ts` beside `RESEARCH_SENDS_PER_MONTH` since the review, so the page can compute the reset it shows. The research door gains the finding's reads (`readFindingForUse`, `readFindingToSend`), `sendsInMonth` (the month's counter; `findingsSentSince` until the review), `clearFindingFailure`, `claimFindingForDraft`, `noteOfDraft`, `duplicateVisibleTo`, and the send's writes (`writeFindingFailure`, `sendFindingTx`, `writeFindingOutcome`); the run's view reads a drafted finding's draft by its owner's own read and a duplicate's visibility (`findingUseOf`, pure). `workers/research/pace.ts` holds the five pacing constants, `nextOutcomesWaitMs` and `outcomeOfState`, moved unchanged; the legacy `ResearchWorkflow` and `workers/research/outcomes.ts` import them. `SendFindingWorkflow` (`workers/workflows/sendFinding.ts`), its two activities (`workers/activities/sendFinding.ts`, the steps in `workers/research/send.ts`) and its `WORKFLOWS` entry; the nightly sweep asks the engine about `finding:<id>` with `workflowRunning` (`scripts/assistant-purge.ts`).
- **74b, the endpoints** (`lib/api/endpoints/researchFindings.ts`, `app/api/v1/research/findings/`): the draft and the send in § 8.2's and § 8.3's orders, in `ALL_ENDPOINTS`, `openapi.json` regenerated, the contract suite's case.
- **74c, the page.** `FindingAction` (`components/research/FindingAction.tsx`, its words and states `lib/research/findingAction.ts`, pure): the button of the role with the draft's help line, the step 1 throttle notice in its place, the send's `ConfirmDialog`, each code's line, the follow after a 202, `Open draft`, and a proposed finding's `ProposalPanel`, which takes `context` (`answer`, `report`) and `hrefOf` in place of `basePath`. The page's loader reads who the person is to their findings (`findingRoleOf`, `suggestGate`'s order). The edit page's rail opens with `from your research` (`components/improve/FromResearchInstrument.tsx`), its sources read against the items the rail draws, and step 2 carries the prefilled label. The queue's class line reads `from research` and the history marks a draft from a finding `research` beside the contributor's own credit. The research log's months count `refused`, `valid` and `sent`. Invariant 27, architecture § 3.1, § 3.4, § 6.1, § 6.3 and § 9, code-standards § Workers, `lib/env.ts`'s comment, specs 42 (§ 3, § 8) and 43 (§ 7.2, D2) amended.

Decided here, for the review:

- **A finding's `href`** in the view is a path under the page's own locale (`/improve/<id>/edit`, `/improve/<id>`, `/improve/<id>/record`), which the page prefixes, since the run's endpoint knows no page's locale; a drafted finding whose draft its owner deleted has none, and reads `drafted · S-…` alone. The draft's answer names its edit page in the language its body gave.
- **The draft's `items`** is how many of the finding's sources are items of the draft with their grading started; one whose start failed is taken off.
- **A finding that no longer parses** is 422 `UNPROCESSABLE` with `detail.failure: PARSE` at either endpoint, which the block reads as `could not be sent · start a new research to look again`; § 8.4 named `PARSE` for the send's step alone.
- **`FINDING_USED`** carries the finding's use and the suggestion's id by the view's own rules (`findingUseOf`), at step 3 and, since the review, when the draft's claim loses a race and the finding is read again; an `INVALID` finding reads as absent (404), since it is never shown (A7).
- **The month's thirty** are a counter of their own since the review: `ResearchSendMonth { userId, month, count }`, one row a person a calendar month in UTC (`month` `2026-10`, checked by the migration), keyed by both, under the tenant filter by `userId`, the user's relation `onDelete: Cascade` so spec 46's erasure takes it, and nothing else ever deleting it. The send's transaction adds one exactly when a finding becomes a suggestion — a duplicate made nothing and is not one of them — by one atomic statement that refuses the thirty-first; the endpoint's check reads the row first. The reset is the first instant of the next month. Migration `20261012220000_research_send_months` (additive) also wrote the rows of the months already sent in, from the findings that still held a `sentAt`. `sentAt` stays, when the suggestion was made; no count reads it.
- **`SENDS_LIMIT`** (review): a send whose transaction met the thirty is rolled back and leaves the finding `VALID` with this code, which the block reads as § 18's `30 findings sent this month · the next on {date}` with the reset of the month the page is read in (`FindingRole`'s `send` carries it, `findingRoleOf` computing it from the loader's instant) and the button again; a code says nothing of the month it was written in, so the button is what lets a finding stopped at the thirty be sent after the reset. No new string: `research.findings.sendsLimit` serves both.
- **The send's follow** goes on through `sent · being checked by Improve` within its minute, so a proposal Improve places that quickly reads `sent · proposed` with its panel without a reload, as § 26 asks; a finding still being checked when the minute ends keeps its true line, and only one the follow never saw move reads `reload to follow`. § 8.3 had the follow stop at `SUBMITTED`.
- **`SendFindingWorkflow`** answers no query and takes no signal; it returns its end (`GONE`, `USED`, `FAILED` with the code, `DUPLICATE`, `PROPOSED`, `REFUTED`, or `UNDECIDED` after forty days) with the suggestion's id. A send whose activity fails three times for another reason (the database away) fails the workflow with the finding still `VALID`, nothing committed: the next press starts a new run under the same id, which the engine allows once the first has closed.
- **The workers' principal check** reads whether `RESEARCH_PRINCIPAL` is set (`lib/env.ts`), not the legacy planner's helper, which unit 78 removes.
- **`pace.ts` on the workflow code's allow-list** (`eslint.config.mjs`, a toolchain file, changed for this reason and no other; `tests/workflows-lint.test.ts`): the lint's own comment says a pure module a workflow comes to need is added by name. The move changes no command the legacy workflow asks of the engine, so it needs no `patched()`; the development engine's 40 newest `ResearchWorkflow` histories replayed clean against the new bundle.
- **`fromResearch` is a person's to read, never a service's**: `SELECTED.ownedSuggestion` differs from a service's `suggestion` by `userId` and `fromResearch`, so the adjudicator's input cannot carry it (§ 8.6); `tests/improve-door.test.ts` holds both.
- **The queue's mark** reads the key § 19 names, `improve.history.class.fromResearch`; a researcher's proposal keeps `research`.
- **Strings beyond § 19**, candidates: `research.edit.open` (`Open the research` · `Abrir a pesquisa`), the rail's link back to the run; `research.findings.sendsLimit` takes `{max}` from `RESEARCH_SENDS_PER_MONTH`, never a literal, as unit 72 did for the day's thirty. The throttle notice is step 1's own words (`improve.suggest.throttled`).
- **The research log's columns** read runs · planned nothing · refused · planner failed · invalid · valid · sent · duplicate · refuted · proposed · searches · page reads; the three that only legacy runs fill come after `sent`.
- **The browser suite's drafter** is an account of the suite's own, `e2e-research-drafter@`, a verified contributor seeded as the research account is; both presses are answered in the page, since a real send starts the send's workflow and a real draft its gradings.

Verified (before the unit's review, which is the caller's):

- type check, and lint on every touched file with no warning;
- the unit suite: 2,554 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded. New: the policy's cases (93 in `opa test policies`), the submission (6), the finding's block (11), the view's use (2), the send's steps (8), the history's mark, the research log's columns, the queue's item, the submit's re-check (2), the workflow lint's allow-list; `tests/workflows/sendFinding.test.ts` on the test server (8: proposed, refuted, every end of the send with no child, an ask that failed, a finding gone while it waits, forty days undecided, a cancellation, a history of ids and codes);
- the database suites, with the purge filter: `research-findings` (new, 8: the draft and its rail, the draft door's refusals, a duplicate's visible id, the month's thirty, research proposals unconfigured and the engine down, each end of the send, the send to `PROPOSED` with the asker's check and list and the draft's key live, refuted and detached), `research-rows`, `research-run`, `research-door`, `research-on-demand`, `research-views`, `research-api`, `research-page`, `research-stats`, `suggestions`, `suggestion-workflow`, `improve`, `improve-policy`, `improve-schema`, `evidence`, `workflows` and `merge`: 184 passed in one parallel run, the other failures being the parallel run's — the `ERASED` and `EXPORT` cases waiting on the ledger's lock past 5 s, and `suggestions`' "the chapter's next serial", which the new suite's chapter-21 suggestions can come between in a parallel run — each file passing alone after;
- the contract suite against a policy server started from this tree on port 8183: 18 passed; against the sidecar on 8181, which serves the bundle before this unit, its new case is refused 403 where the policy now allows the send, as expected until the sidecar is restarted;
- the browser suite `tests/e2e/research.spec.ts`, EN and PT: 28 passed, four new; `improve.spec.ts` and `suggest.spec.ts`: 24 passed; the PT truncation suite: 115 screens, none truncated, two new (the send's confirm at 1440 and 390), after a first run in which seven screens at 390 did not render and the second rendered them all;
- in Chromium against the development server, with three development accounts of the unit's own seeded by `npm run research:seed -- --page --account …`: a reader and an unverified contributor see `Send to Improve`, a verified contributor `Draft it in Improve` with its help line; a send with its POST and the run's reads answered in the page reads `sending to Improve` with the focus on it, then `sent · being checked by Improve`, then `sent · proposed` with the panel, `not part of the report`, EN and PT, axe clean on the dialog; a draft made through the door with no grading started shows `drafted · S-… · Open draft`, and its edit page `from your research` with the note, the link back and the source not among its evidence, and the prefilled label, at 1440 and 390 in EN and PT, axe clean, no horizontal overflow once the addresses wrap (`.xref` is `nowrap`; the rail's links are not); the draft deleted after;
- `npm run secrets:scan`: 241 files, none found.

**The review**, one read-only pass, found two, both fixed in the unit's commit:

- **Medium: the month's thirty (D5) could be passed.** The send endpoint counted the person's findings with a `sentAt` in the month — rows the person's own deletes remove (a refuted finding of a deleted research, deleted by `writeFindingOutcome`; the sweep's runs and its second pass) — and `sentAt` was written only by the workflow's transaction after the press, so a burst of presses all read the old count. A reader could have sent some 600 a month against the shared US$ 20 research principal. The thirty are now a counter no delete reaches: `ResearchSendMonth { userId, month, count }` (migration `20261012220000_research_send_months`, additive, with the rows of the months already sent in), under the tenant filter, the account's cascade its only delete. `sendFindingTx` takes the place after the door made the suggestion, by one statement that inserts it at one or adds one only under thirty and answers the count (`INSERT … ON CONFLICT DO UPDATE … WHERE "count" < 30 RETURNING`, lib/db/RAW_SQL.md); none answered rolls the transaction back, the suggestion and its serial with it, and the step writes the new code `SENDS_LIMIT` on the finding, which stays `VALID`. A duplicate takes no place. The endpoint's fast check reads the row (`sendsInMonth`, in place of `findingsSentSince`). `sendsMonthOf` moved to `lib/schemas/research.ts` and gives the month's key; the page's `send` role carries the month's reset, so the block reads `SENDS_LIMIT` as § 18's words with the button again (§ 8.1, § 8.4, § 18 amended; no new string). Tests: the month's key in UTC (`lib/schemas/research.test.ts`, moved from the submission's); the block's line by role (`findingAction.test.ts`); the step's `limited` (`send.test.ts`); the workflow's `FAILED · SENDS_LIMIT`; and in `research-findings`: the 429 read off the counter with no finding sent, at twenty-nine a duplicate taking no place and a burst of four presses at once making exactly one suggestion, the other three `VALID` · `SENDS_LIMIT` with no suggestion under their keys; the month rolling over in UTC (20:59 on 31 January in São Paulo still January's thirty, 21:30 February's first); and the person's two sends still two after a refuted detached finding is deleted, the research deleted and the sweep has taken its runs, while their findings would say one.
- **Low: one `FINDING_USED` answered the row's vocabulary.** A draft whose claim lost a race answered `{ use: <FindingOutcome>, suggestionId: null }` — `SUBMITTED` where the view says `SENT`, and no id where the view gives one. The endpoint now reads the finding again and answers as step 3 does (`usedRefusal`, `findingUseOf`); `FindingClaimed`'s refusal carries nothing. A case in `research-findings`: a send's move between the read and the claim is answered `{ use: "SENT", suggestionId: null }`.

Verified after the review:

- type check, and lint on every touched file with no warning; `npm run api:openapi`: `openapi.json` unchanged;
- `lib/research`, `workers/research`, `lib/api`, `lib/schemas`, `lib/db`, `tests/workflows/sendFinding.test.ts`, the workflow lint's, the improvement door's and schema's and the observability suites: 603 passed;
- `opa test policies`: 93 passed;
- the database suites `research-findings` (12, four new), `research-door`, `research-page`, `research-rows`, `research-api` and the contract suite, with the purge filter: 59 passed, 2 skipped;
- the browser suite `tests/e2e/research.spec.ts`, EN and PT: 28 passed;
- `npm run secrets:scan`: 241 files, none found.

The workers run the send's step and transaction, and the development server's database client was built before the new model: each reads and takes the counter after its restart.

## 35. As built (unit 75: the Assistant hands over, 2026-10-12)

Built as § 4.3, § 9, § 19 (its unit 75 rows and "Removed"), § 21's unit 75 rows and § 25's row say, but for the points below.

- **75a, out of the turn.** `workers/answer/turn.ts` calls no research: no run row, no mark, no workflow follows a turn, and the `final` event has no `research` key. `workers/research/afterTurn.ts`, `lib/research/eligibility.ts` and their tests are deleted; from `lib/db/research.ts`, `writeRunMarks`, `removeRunMarks` and `readMarks` (read only by the hand-over and the gate's turns), `researchSwitches` and `setUserResearch`; from `lib/schemas/research.ts`, `RESEARCH_DEDUPE_DAYS`, which only the eligibility read. `createResearchRun` stays, the legacy run's suite and the research seed writing legacy rows through it until unit 78, and so does `writeBudgetMark`, the legacy workflow's. The gate's stub stack has no research to switch off. `User.researchEnabled` stays in the schema, read by nothing; the legacy `ResearchWorkflow` is unedited and stays registered.
- **The gate** (`lib/gate/research.ts`, `workers/gate/researchTurns.ts`, `scripts/research-gate.ts`): R1, R2, R3, R8 and R9 read as § 25 has them. R1's own turns are the fifty answerable golden questions and one refusal of each cause through the workers over the stub, counted for what must not follow them — `research` in a `final`, a `ResearchRun` naming a turn's message, a research call on its trace — with each answer read back from its conversation as its `final` gave it; with nothing to switch, there is one pass, the engine is not needed, and D2's timing is gone. R9's facts read every person's runs (an ordinal set) in their own context, their research calls on their own principals, any call naming one of them on the platform's research principal — the organisation whose `researchPrincipal` is true, as the views find it — and that principal's months. The suites the criteria name are `tests/research/road.test.ts`, `research-on-demand`, `research-api`, `research-door`, `research-findings`, the version 2 agents' canary, reader and writer suites and `researchRun`'s workflow suite beside the legacy ones that still hold of the legacy run (R3's legacy reader since the review, R4, R5, R7, R10); the hand-over's, the eligibility's and the legacy planner's, plan's and read's suites are out of the list.
- **75b, the button.** `Start a research` (`assistant.dock.startResearch`) in `TurnActions` after `Flag this answer`, and in a walk's footer after `Flag this step`: a `Button` with an `href`, `researchPageHref(locale, { from: messageId })`. `seedsResearch` (`lib/assistant/turns.ts`, pure) says which turns offer it. The account page's research row, `updateResearch`, `AccountData.researchEnabled` and the five keys of "Removed" are gone; `account.retention.research`/`researchValue` and `assistant.delete.body` say § 19's words; a legacy `off` line reads `off` alone (`researchLineOf` has no `switchable`). `npm run research:org`'s comment says "research by its members" (D2).
- **`tests/research/road.test.ts`** (`npm run test:research`): an answer through `runTurn` on the stub, with nothing of research after it; its `Start a research` built as `TurnActions` builds it, and the page's loader at that `?from=` (prefilled, nothing written); the page's open and start endpoints; the run on the engine's test server with its real activities on the person's principal, to a report and a `VALID` finding, the answer unchanged; the send endpoint, then `SendFindingWorkflow` with the suggestion's real activities and the fixture fetcher, to `PROPOSED` on the research principal; the curator's pages with nobody who asked on them; `Add my name` through its endpoint; a curator's accept, recorded; the answer unchanged at the end.
- **The seed and the screens.** The research seed's answer (`tests/fixtures/research/page.ts`) has a question the Assistant refused after it, and the report names its conversation, `seedConversation`. The truncation suite gains `assistant-start-research` at 1440 and 390; `tests/e2e/research.spec.ts` a case in EN and PT: the answer's link and its address, none on the refusal, no research line, the page prefilled with no write, the account page with no switch and the Retention line.

Decided here, for the review:

- **`final.research` is absent, not `null`**: § 9.2 says the event "carries no `research`", and `SseFinalSchema.research` stays optional. A client reads absence as no line (`answerOfFinal`), and a stored `final` of a turn from before unit 75, replayed, still parses and shows its legacy line; `lib/assistant/turns.test.ts` holds both.
- **Which turns offer it** (§ 9.1): an answer, refusal null, whose words are held — its claims (a turn just streamed) or its text (one read back) — and whose question's text is held, with a conversation, which only a signed-in reader has. So a failed turn, which never stored words, offers none, as a purged one: the page's seed would refuse both as not `answered`. Every mode passes through the same predicate; a compare, a lab and a brief through `TurnActions`, a walk through its footer.
- **Its place**: after the flag and before a lab turn's `Open Lab NN`; in a walk's footer before the spacer, so `Next` keeps its place at the right.
- **R1's "the answer unchanged"** has nothing to compare against once there is no hand-over: it reads as invariant 31's "never changes an answer". The gate's turns read each answer back as its `final` gave it; `research-on-demand`'s seeded case and the road compare every column of the seed answer and every row hanging from it before and after a research seeded from it. R1 still reads "and a refusal starts none".
- **`tests/research/` is a suite of the database and the engine's test server**, not the browser flow spec 43 D17 named: this machine's workers read the web on the real provider, so a browser road would start real runs, and a development server on the stub is not this unit's to start. The road ends at the curator's accept, recorded, the suggestion's workflow then ended before its merge reaches a repository; the merge, a release and the history's mark are `merge.test.ts`'s and `history.test.ts`'s, as R8 has had them since unit 61. The accept is the decision endpoint's steps — the rule's agreement (`decisionOf`), the action through the door, the workflow signalled, its `CURATOR` record — since the endpoint's default dependencies are not exported; the policy is allowed, its rules being opa's and the contract suite's.
- **The gate does not run the stream suite**, whose purge case is not scoped to its own reader; its first case now also asserts no run row, no `research` in the `final` and no line read back, and the road's first case is what R1 selects.
- **The research rows suite** loses its switches-and-marks case; a case of the budget mark the legacy run sets at the platform's cap, read back with its reset by a legacy line, takes its place. The conversation delete's case keeps the day's count and drops the marks, which nothing writes.
- **`axeFindings` takes a region** (`within`), since the Assistant page with a conversation open fails axe on its own: the column's `export JSONL` link (`ConversationsTree`'s log foot, `a[download]`) is under WCAG 2.2's target size beside `Delete conversation`, at 1440 in EN and PT. It is not this unit's: the new case scans the turns, and the defect is recorded in the tracker.
- **`npm run gate:research` was not run whole** before the review: its suites include two purge cases, each scoped to its suite's own reader, and this unit runs none. Its parts were run instead (below). After the review it was run whole once, as § 26 asks.

Verified (before the unit's review, which is the caller's):

- type check, and lint on every touched file with no warning; `npm run api:openapi`: `openapi.json` unchanged;
- the unit suite: 2,545 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded. New or rewritten: the gate's rules (13: R1's and R9's new facts), `seedsResearch` on each mode and on a refusal, a failed, an open and a purged turn, a `final` with and without `research` (3), the legacy `off` line with no switch;
- the database suites, with the purge filter: `assistant-stream`, `conversation-delete`, `research-rows`, `research-run` and `research-on-demand`: 37 passed, 4 skipped; `research-page`, `research-stats`, `research-findings`, `research-api` and `research-door`, on the seed with its refusal: 41 passed, 1 skipped; `tests/research/road.test.ts`: 3 passed;
- the gate's twenty-two suite files through its own runner (`lib/gate/run.ts`), with the purge filter: 194 passed, 3 skipped (purge cases), and each selection of R1 to R10 found in the run and passed; R1's own turns through `measureResearchTurns` on the in-process stub stack: 50 of 50 answers read back unchanged, no run, no research call, no `final` with research, 4 of 4 refusals with nothing of research, and the criterion a pass; R9's facts on the development database: no person's run on the platform's principal, 26 research calls of people's runs on their own principals, 2026-10 US$ 0.93 of US$ 20.00, a pass;
- the browser suites: `tests/e2e/research.spec.ts`, `assistant-delete.spec.ts`, `keyboard.spec.ts` and `accounts.spec.ts`: 40 passed, two new; the PT truncation suite after the demo reader's page states were seeded again (`--page`): 117 screens, none truncated, none skipped, two new — its `assistant-research` screen drawing the legacy conversation's lines, each answer's `Start a research` beside them and the proposal panel with its consent open, so a legacy turn's line and panel still render;
- in Chromium against the development server, as a development account of the unit's own (`unit75-check@`) seeded with `--page --account`: EN and PT at 1440 and 390, light and dark — the answer's `Start a research` to `/{locale}/research?from=<id>`, none on the refusal, no research line, axe clean on the turns, no horizontal overflow, the Research page prefilled with no request but GETs, the account page with no research switch, axe clean, no page error;
- `npm run secrets:scan`: 241 files, none found.

**The review**, one read-only pass, found six, all fixed in the unit's commit:

- **R3 had lost two measurements.** The research log was no longer among the curator's pages the canary is checked on, and the legacy reader's half of the canary had left R3, though a legacy run asleep at the platform's cap may still plan and read with the version 1 agents until unit 78 (§ 22). The road now reads the research log through its page's loader (`getResearchLog`) beside the queue and the record: the sent finding is its month's `sent`, from the `submitted` record `service:researcher` signs, and the log holds neither the marker, the asker's id, name or address, nor five words of the question. R3 selects `workers/agents/researcher/reader.test.ts`'s "canary's second half" again, a file already in the gate's list for R4.
- **The delete body overstated**: a legacy run that has already sent a finding to Improve does not stop at its next step. § 9.5, § 19 and `assistant.delete.body` say "unless it has already sent a finding to Improve" again (`a menos que já tenha enviado uma descoberta ao Melhorar`), spec 45 § 6's words.
- **Spec 46's amendment named the wrong workflow id**: a legacy run's is `research:<messageId>` (`researchWorkflowId`). § 21's row and spec 46 § 3.3 step 5 now cancel each run under its stored `workflowId`.
- **Architecture § 6.3's `ResearchWorkflow` row** still said new turns are skipped at the cap; no turn is handed over, and the clause is gone.
- **`RESEARCH_SKIPS`' comment** called the first eight legacy rows' alone, and the eighth, `BUDGET`, is a person's run's end too. It now says the first seven and `NOTHING_TO_RESEARCH` are.
- **R1's measure overstated.** "Answers read back unchanged" was the turns' own consistency, with nothing to compare against: it reads "answers read back as their final gave them", and R1's note names invariant 31's evidence, `research-on-demand`'s seeded case and the road, each comparing the seed answer, every column and every row hanging from it, before and after a research seeded from it.

Verified after the review:

- type check, and lint on every touched file with no warning;
- the gate's rules, `tests/messages.test.ts` and `lib/schemas/research.test.ts`: 17 passed; `tests/research/road.test.ts` on the database: 3 passed;
- `npm run gate:research`, whole, once, on the stub stack and the engine's test server (its purge cases each scoped to its suite's own reader: `purgeResearchRuns` and `sweepDetachedRuns` to `research-door`'s two, `sweepDetachedRuns` to `research-findings`' reader, `purgeAssistantText` to `research-rows`' reader; the stream suite is not among its files): its 22 suite files 197 passed, none failed or skipped; R1 to R10 pass — R1's own turns 50 of 50 answers read back as their final gave them, no run, no research call, 4 of 4 refusals with nothing of research; R5 2 items of 2 researcher suggestions, both opened with a stored text; R6 opa 93 of 93; R9 no person's run on the platform's principal, 30 research calls of people's runs on their own principals, 2026-10 US$ 0.93 of US$ 20.00 — and R11 blocked on `npm run research:check`, Andre's one paid call: **not met**, 10 pass, 0 fail, 1 blocked. The gate's own process read the workers' store for R5, as it is built to, its suites a store of their own;
- `npm run secrets:scan`: 241 files, none found.

The workers must be restarted for a live turn to stop handing its answer to research; until then the running workers still run the hand-over they were started with. The development server needs no restart.

## 36. As built (unit 76: Improve's two starts, 2026-10-13)

Built as § 10.1, § 10.2, § 18's rows for these, § 19's `improve.home.*` and `improve.new.*` rows, § 20 and § 21's unit 76 rows say, but for the points below.

- **76a, the chooser.** `app/[lang]/improve/new/page.tsx` (RSC per request, `noindex`; signed out, the sign-in with `next`) with its loader `lib/db/suggestChooser.ts` (`getSuggestChooser`) and `components/improve/SuggestChooser.tsx`: the release's chapters under their parts' captions (Book Home's `part ii · harness engineering`), each row `NN · title · vX.Y.Z` a link to `?ch=NN`; then the chapter's sections, the outline's layers with their titles in the edition's language, each a link to step 1 at that section (`suggestStartHref`), under `← chapters` and a `.meta` line naming the chapter. `lib/improve/suggest.ts` gains `suggestChooserHref` and `chooserChapterOf`, pure. Step 1's three notices are `components/improve/SuggestGateNotice.tsx`, which step 1's `StepBody`, the chooser (at its top, in place of either list) and `FindingAction` render. The classes are new in `app/globals.css` and ui-context § 9.9 (`.improve-new*`), and the chooser renders at every width.
- **76b, the landing page.** `ImproveHome`'s head holds the primary `New suggestion` (to the chooser, for every visitor), the rubric's link and, where the section is, the `From a research` link to `#from-research`; `From a research` stands right under the heading, before the research proposals, as § 10.2 lists it. `unusedFindingsOf(user)` in `lib/db/research.ts` reads, inside the person's tenant, every `VALID` finding of a research of theirs whose run's text is held, newest run first and in the reader's order within a run, the first fifty (`UNUSED_FINDINGS_MAX`), each as the run's view gives it (`findingViewOf`, numbered among its run's findings that passed the checks, its anchor resolved at the current release) less its note, change and sources, and the research's chapters for its label (`chaptersOfSections`); `getImproveHome` adds it with `findingRoleOf`, as the Research page's loader reads the role. Each row's last cell is `FindingAction` with a new `place`, `improve`. The help line under **Your suggestions** is § 19's.

Decided here, for the review:

- **Which chapters the chooser offers:** every chapter of the release, verified or not. The draft door and step 1 take an anchor in any chapter (`resolveAnchor`, `POST /suggestions`); only research reads verified chapters alone (A5). Chapter 00, whose outline has two layers (00.1, 00.9), lists those two.
- **Read from Book Home's loader, not the dock's catalogue.** § 10.1 names `getDockCatalogue`, which has no part to group by, and a field added to it would be served without it from its `unstable_cache` entry until the cache turned. `getHomeData(locale, null)` is cached per release too and already groups the chapters as the book's home does; its titles are the edition's as Book Home prints them, unmarked by language as its tiles are. A chapter's sections are `getChapterData`'s outline, read at the chapter's first layer, which every chapter has; the sections' titles carry `lang`, as step 1's strip does.
- **A `ch` the release has not** (`77`, `abc`, `021`) reads as none chosen: the chapters' list, the parameter left in the address. The status bar reads `new suggestion · chapter 21` only while a chapter's sections are listed, else `new suggestion` (`improve.new.statusbarNone`, a string beyond § 19).
- **The gate first.** The chooser asks `suggestGate` before it reads a chapter: a reader, a builder, an organisation admin, an unverified or a throttled contributor reads step 1's notice and nothing else, whatever `ch` holds.
- **`FindingAction`'s `place`.** In the `improve` place a throttled contributor's notice is not in each row — the table has it once above (§ 10.2) — though a draft refused 429 at the press still says it in its row; and a send that settles, or a finding read again after a 409, does not refresh the page: the table holds unused findings alone, so a refresh would take the row, the line that says what became of the finding, and the focus on it, away. Only a finding gone from its run refreshes the page, since its row is gone too. On the Research page nothing changed. The throttle notice is `SuggestGateNotice` in both places (§ 18).
- **The research's cell** is its label as the list's (`ch21`, or `no sections`) as a link to `/[lang]/research?research=<conversationId>#run-<runId>`, then the run's day in `.meta`; the anchor's id is `.meta` with its section's title in the run's language; the change is the edit page's kind caption (`improve.suggest.edit.kindCap`: `new claim`, `number`, …), which names all six kinds where step 1's `change.*` names a section's four.
- **The Research page lands on the run the address names.** The column brought the newest run into view on its first render, so `#run-<id>` — this table's link, and since unit 74 the edit page's link back — landed on the follow-up, with the run whose findings the row offers scrolled out of view above it. On the first render, while the newest run is still the one the column rendered with (so that the effect React runs twice in development does the same both times), a `#run-<id>` naming a run in the column brings that run's head into view instead (`components/research/ResearchDock.tsx`); a new run, as before, the newest. Once the column has moved the address is not read again, and a question given back leaves the log at its end, where its box stands (the review, below).
- **At 390px** the landing page's tables scroll within their own box, as they did (ui-context § 9.9's `.improve-home-table`), so a finding's button is reached by scrolling the table or by the keyboard; nothing scrolls the page sideways.
- **Strings beyond § 19**, candidates: `improve.new.statusbarNone` (`new suggestion` · `nova sugestão`). `improve.home.own.start` in PT names the reader's button as it reads, `Sugerir uma alteração` (`Use Nova sugestão, ou Sugerir uma alteração numa seção do livro.`), where § 19's candidate wrote `Sugerir uma mudança`. The parts' captions, the notices and the kinds of change are existing keys.

Verified (before the unit's review, which is the caller's):

- type check, and lint on every touched file with no warning; no API schema changed, so `openapi.json` was not regenerated;
- the unit suite, alone: 2,547 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded (a first run beside the browser suites lost three workflow files to the 5 s timeout, 48 of 48 alone); new: the chooser's address and its `ch` (2 cases in `lib/improve/suggest.test.ts`);
- the database suites, with the purge filter: `improve-starts` (new, 4: every chapter of the release once by part, chapter 21's nine sections to step 1, a `ch` the release has not; the three gates; the unused findings as the run's view gives them, a send's code kept, a drafted one gone and the other keeping its number, a run whose words are gone; the landing page's role by person and nothing for another or signed out), `research-page`, `research-findings` and `research-door`: 27 passed, 1 skipped;
- the browser suites: `tests/e2e/improve-starts.spec.ts` (new), EN and PT, 12 passed — signed out; a contributor's chapter, section and step 1, `← chapters`, the status bar, 390px with nothing sideways; the reader's and the unverified contributor's notices with no list; a reader's `Send to Improve` confirmed, `sending to Improve` focused, `sent · being checked by Improve` in the row kept; a contributor's `Draft it in Improve` with its help line and the post's key and language; an account with nothing unused; the research link landing on its run — every press answered in the page and a guard refusing any other write, axe on each state; `improve.spec.ts` and `suggest.spec.ts`: 24 passed; `research.spec.ts`: 30 passed, then in two of three full runs its recorded flake (48 § 33: "a start that did not start", `page.goto` aborted by the start's `router.refresh()`), passing alone; the case now asks the load again until it lands (`toPass`), a test's change only, and the suite passed whole twice after it (30, and 42 with `improve-starts`);
- the PT truncation suite: 125 screens, none truncated, none skipped, eight new (`improve-home-from-research`, `improve-new`, `improve-new-chapter`, `improve-new-role`, at 1440 and 390);
- in Chromium against the development server, as four development accounts of the unit's own (`unit76-reader@`, `unit76-unverified@`, `unit76-contributor@`, `unit76-throttled@`; individual accounts with no gateway key, seeded with `npm run research:seed -- --page --account …`, the last throttled for twenty days by a row write): signed out, each account's landing page and chooser, and the contributor's `?ch=21` and `?ch=00`, at 1440, 1000 and 390, light and dark, EN and PT (132 screens): no horizontal overflow, axe clean, no page error; a send and a draft pressed with their POSTs answered in the page, none reaching the server;
- `npm run secrets:scan`: 241 files, none found.

**The review**, one read-only pass, found three, all fixed in the unit's commit:

- **A follow-up given back sent the column back to the run the address named.** After a follow-up's start was refused (503, 402, 429, or no answer), its block left, the landed run was the newest again and `#run-<id>` was still in the address, so the column scrolled up to that run and the box at the log's end went out of view — on a 402 or a 429 with the focus in it. The column now reads the address only until it first moves (`landedKey` null for good after), and a question given back leaves the log at its end, where its box stands in its block's place: before this unit a give-back brought the newest run's head into view, which a run taller than the log also kept the box away from. A browser case opens the seed's done research at its first run, asks a follow-up answered 503 and finds the box in view, the field keeping the question and the focus, EN and PT; it failed before the fix, and with the address alone fixed.
- **`unusedFindingsOf` had no cap and resolved the anchors one after another.** It reads the newest fifty (`UNUSED_FINDINGS_MAX`; the run's id orders two runs started in the same instant, so the cut falls in one place). The rest stay offered under their runs on the Research page and come into the table as newer ones are used or the 30 days take the newer runs' words; the table does not say so, which would be a string beyond § 19. Each run's `found` is parsed once and its research's chapters counted once, and the anchors and their sections' titles are resolved together. A database case: sixty unused in two runs, the table's fifty the newer run's thirty and then the older's first twenty, each numbered in its own run, none with the reader's words.
- **A comment said the note never reaches the page, but it did:** `FindingAction` is a client island, so its `finding` prop is in the page whole. `unusedFindingsOf` now hands each finding with its note, change and sources null — the block reads its id, use, `textPurged`, anchor and proposal, the row its anchor and kind — and `ImproveHome`'s comment says so. `improve-starts` compares the run's own view less those three, and checks the view has them.

Verified after the review:

- type check, and lint on every touched file with no warning;
- the unit suites under `lib/research` and `lib/improve`: 336 passed;
- the database suites, with the purge filter: `improve-starts` (5, one new) and `research-page`: 9 passed;
- the browser suites `tests/e2e/research.spec.ts` (32, two new: the follow-up given back, EN and PT) and `tests/e2e/improve-starts.spec.ts` (12), in one run: 44 passed;
- `npm run secrets:scan`: 241 files, none found.

## 37. As built (unit 77: the Research dock on every page, 2026-10-13)

Built as § 12 (the slot, whose parameter is whose, one dock at a time, the key, the form, what it holds, `Esc`, the phone notice, signed out), § 19's `research.dock.*` and `reader.keys.research` rows, § 20's keys and § 21's unit 77 rows say, but for the points below. With it spec 48's ten units are built; unit 78 waits for the legacy runs (§ 25), and spec 46's units come next.

- **77a, the slot and the keys.** `components/research/ResearchMount.tsx` (RSC) stands beside `AssistantMount` in the `@assistant` slot's two pages, the slot keeping its name. It renders the key alone on `/research`, with no `research` on the URL, and while the Assistant's dock is open (`ask` on any path but `/assistant`), so a URL with both dock parameters shows the Assistant's; otherwise `ResearchDock variant="dock"`, read by `loadResearchDock` (`lib/db/researchPage.ts`: the open research with its runs and its seed, the composer's closed states and the person's role to their findings, as the page reads them, and nothing of the list, the statistics or the export). `components/research/ResearchShortcut.tsx` owns `r`, `AskShortcut`'s pattern: with research's column on the page (`.dock[data-dock="research"]`, the dock or the Research page's column) it focuses its question, otherwise it opens the dock where the person is. `resolveKeyAction` gains `research` with `a`'s guards, `useKeyboardMap` leaves the act to its owner, and the keyboard map lists `r · open research`. The parameter rules by path are two pure functions in `lib/research/links.ts` that both keys use — `openDockHref` (a dock opened empty: its own parameter afresh, the other dock's dropped but on the page that owns them, nothing else touched) and `otherDockClosedHref` (a key whose own column is already on the page closes the other dock over it) — with `withResearch` and `researchDockCloseHref` (the page's URL without `research`). `AskShortcut` gains the `research` rule through them.
- **77b, the dock.** `ResearchDock`'s props are the column's shared ones and either the page's (`variant` absent or `page`) or the dock's (`variant: "dock"`, `signedIn`, `closeHref`). The dock is the Assistant's overlay as it is (`.dock.is-over` with its `.dock-backdrop.is-over`, which closes it) at every width from 768px, a reader section included, whose grid stays as it is; its header carries `Open the Research page` (`/[lang]/research`, with `?research=<id>` once a research is open) and `Close research` as the Assistant dock's two icon buttons; its URL is the page's with `research` — `1` before the first Start, the research's id after it by `replaceState`, a foreign id corrected to `1` — and a section in it links to the reader with `research` (`researchRefHref`), so the dock stays open there. `Esc`, the close and the backdrop replace the URL with the page's own and give the focus back to what had it when `r` opened the dock (`lib/hooks/dockOpener.ts`, which `ResearchShortcut` fills). Under 768px it does not render, and `.dock-phone` says so with `Open the Research page` and `Close research`. Signed out it shows the sign-in notice with the form disabled. The page's seed card and closed-state conversions moved to the loader's file (`seedCardOf`, `closedCardOf`), which the page and the mount share.

Decided here, for the review:

- **Sign-in and sign-out render nothing**, not the key alone: § 12 says the key alone, "as `AssistantMount` does on `/assistant`", but `AssistantMount` renders nothing on those two pages, and a key there would put `research=1` on a URL that shows no dock.
- **The focus comes back to the opener**, the rule spec 24 § 9 gives the Assistant's dock ("`esc` closes it and returns focus to where it was when `a` was pressed"), which § 12's "as the Assistant's" carries. The dock is opened by a navigation and its composer takes the focus first, so `ResearchShortcut` remembers the element before it pushes the URL, and the close gives it back if it is still on the page; opened by a link or a load, nothing is remembered. The Assistant's own dock does not give it back today (its close leaves the focus on the body): it is not changed here, since the Assistant must behave as before.
- **A panel's or a dialog's `Esc` stands back** (§ 20): the dock reads whether a peek, the keyboard map or a modal dialog was open as the key goes down, in the capture phase, because the keyboard map's own listener, added by the page before the dock's, has closed the map and React taken it off the page by the time the key reaches the dock's bubbling listener; read then, `Esc` with the map open would close both. The Assistant's dock reads the peek alone; not changed.
- **The phone notice has two links**: `Open the Research page`, which § 12 names, and `Close research`, as `AssistantMount`'s notice has its close, since the notice stands fixed at the page's foot until the parameter goes. It stands on a reader section too, where the Assistant's is the reader's own column's: the reader knows nothing of `research`.
- **The dock's log holds what it positions** (`.dock[data-dock="research"] .dock-log { position: relative; }`): the PT truncation suite found the fixed dock "clipped vertically by 1777px" over a reader section — a page row's visually hidden `opens in a new tab` far down the scrolled log had the fixed dock as its containing block, which made the dock taller than its box, so focus or a script could have scrolled the whole dock. The rule holds the Research page's column too, where it changes nothing seen. No new class: `.research-page .research-frame` became `.research-frame`, so the dock has the column's frame line, and `.research-page` keeps only the column's padding under 768px.
- **What the dock shows beside the runs**: the empty state names both starts, as the page's empty column does; an open seeded research's card stands above its first question (`from` is never a dock's, so there is no seed before Start); the closed states' notices and help lines are the page's, read by the same checks.
- **The dock refreshes the router** where the page's column does (after a start's answer, at a run's end, after a finding's press), so its runs and closed states move; the page under it renders again with it.
- **The header's words** are the page column's (`reads the web`, the release, the researcher's guide); at 520px in EN its two icon buttons wrap to a second line of the header, as a header may (ui-context § 11).
- **`j` and `k`** on a reader section with the dock open go to the next section without `research`, as they go without `ask` today: the reader's key targets carry neither.
- **Strings**: none beyond § 19. `research.dock.phoneTitle` and `phoneBody` are § 19's row split at its ` · `. All are candidates.

Verified (before the unit's review, which is the caller's):

- type check, and lint on every touched file with no warning; no API schema changed, so `openapi.json` was not regenerated;
- the unit suite: 2,551 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded, and `tests/workflows/suggestion.test.ts` timing out once at 5 s in the parallel run, 26 of 26 alone. New: the two docks' parameters by path (`openDockHref`, `otherDockClosedHref`, the close's URL; 4 cases in `lib/research/links.test.ts`) and `r` with `a`'s guards (`useKeyboardMap.test.ts`);
- the database suites, with the purge filter: `research-page` (a case new: the dock's loader against the page's for the same research, a seeded one's card, `1`, a malformed and a foreign id as none, nothing signed out) and `research-stats`: 8 passed; `tests/research/road.test.ts`, which reads the page's loader: 3 passed;
- the browser suites: `tests/e2e/research-dock.spec.ts` (new, account `e2e-research-dock@`), EN and PT, 13 passed — `r` on the home page, a reader section, search, Improve and the account page with the question in focus; `r` in a field; `Esc` twice (the field's, then the dock's) back to the page's URL with the focus on the brand that had it; a flag's dialog's `Esc` leaving the dock; the close, the backdrop, `Open the Research page`, a section's link keeping the dock, no list and no delete; one dock at a time both ways and a URL with both; `r` on `/assistant?ask=<id>`, `a` on `/research?research=<id>`, each key putting its own column back in front, `r` keeping `from` on step 1 and `/rubric`; a start from the dock on `/search?q=cache` (its run's request answered 503 in the page) recording the research beside `q` and giving the question back; axe on the empty dock, the done research over a reader section, the 503's box and signed out; the overlay at 1440, 1200, 1000 and 768 and the phone notice at 390 with no horizontal overflow — and in one run with `research.spec.ts` (32), `assistant-delete.spec.ts` (4), `flows.spec.ts` (12) and `peek.spec.ts` (1): 62 passed; `keyboard.spec.ts`, EN and PT, with `r` and its row in the map on the book's first page: 1 of 2 in the first run — the EN walk lost one `j`, on 29.2, half a book after the `r` cases, with `r` and its row passing in both — and the EN walk alone after: passed, every key of the map true;
- the PT truncation suite: 128 screens, none truncated, none skipped, three new (`research-dock` at 1440, `research-dock-empty` at 1440 and 390, the phone notice); its first run found the dock clipped vertically over a reader section, fixed as above;
- in Chromium against the development server as a development account of the unit's own (`unit77-check@`, individual, no gateway key, seeded with `npm run research:seed -- --page --account …`), every start's request answered in the page: the keys on seven pages, the swaps, the paths, the map, `Esc` with the map and with a flag's dialog open, the close, the backdrop, the focus given back (35 checks); and the done research over a reader section and the empty dock over the home page at 1440, 1360, 1200, 1000, 900, 768 and 390, light and dark, EN and PT, and signed out in EN and PT (200 checks): the dock flush right and at most 520px wide with its backdrop from 768px, the phone notice under it, no horizontal overflow, axe clean, no page error;
- `npm run secrets:scan`: 241 files, none found.

The development server picked the slot's changed pages up without a restart; no new slot, migration, policy or worker change, so nothing is owed a restart.

**The review of unit 77** (one read-only pass, 2026-10-13) found one medium and two low, fixed in the unit's commit:

- **`r` and `a` acted while a modal dialog held the focus.** Pressing `r` in `Flag this report` moved the focus to the dock's composer outside the open dialog, and `Esc` then left the dialog open with the focus on the page; pressing `a` swapped the Research dock away, the dialog with it, even while a confirmed `Send to Improve` was out, so its answer could land behind a closed dialog (spec 45 § 20's rule). Both shortcuts now stand back while an `[aria-modal='true']` element is open, the selector the dock's own `Esc` reads; the Assistant's `a` changes only there. A browser case presses both keys in an open dialog.
- **Two lines of the docs** (architecture's route row and ui-context's dock rows) now leave out sign-in and sign-out, where the mount renders nothing, and the Research page.

