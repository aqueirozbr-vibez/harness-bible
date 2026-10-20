# 40 · The research run — feature spec (what an answer hands over, eligibility, `ResearchWorkflow`, the platform's budget, privacy)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: Andre's request of 2026-10-05 (spec 27 § 1, steps 1 to 4) and his answers A2, A4, A6, A12, A13 and A14 (spec 27 § 3). No screen and no section of the PRD or TRD covers this spec; where it touches rules they wrote (the 30-day purge, tenant isolation, the gateway as the only path to a model, budgets enforced at the gateway) those rules hold unchanged.

Prerequisite specs: `13-assistant-agent.md` and `15-conversations-api.md` (the turn and its rows), `21-assistant-retention-observability.md` (the purge, redaction), `11-model-gateway.md` (principals, the cap), `28` (the engine), `29`.

Scope: tracker unit 57 (57a to 57e). From the end of an answered turn to a run that has a state: started, skipped with its reason, or waiting. Not here: what the researcher does inside a run (spec 41), what becomes of what it finds (42), what the reader sees (43).

**Superseded for new runs by feature-specs/48 (unit 75, 2026-10-12).** Research is a person's act, on request (48 A1, A2): since unit 75 no answered turn is handed to research. `researchAfterTurn` (§ 6.1) is out of the turn, and it, the eligibility of § 5 (`lib/research/eligibility.ts`) and the writers of a section's and a question's marks are deleted; the `final` event carries no `research`, its schema keeping the member optional for the stored finals of earlier turns. The reader's own switch of § 8.2 is gone from the account page and read by nothing (`User.researchEnabled`, dropped in a later release); the organisation's stays, read by the research start (48 D2). A person's run is started on the Research page, on their own budget (48 § 5, § 7), and "research on request" is no longer out of scope (§ 10). What this spec says of the legacy rows stands as written: they are read as they stand — the line and the panel under their answers, the purge, the sweep, the research log — and a legacy run still waiting finishes on `ResearchWorkflow`, unedited, which stays registered until unit 78.

## 1. Purpose

"The assistant sends the answer to the researcher." This spec is that sentence: the moment, the conditions, the cost and the privacy of handing a reader's turn to a second agent. It is built so that three things are true whatever the researcher later does: the answer is never slower or different because research exists; a reader's words go no further than the product's own rows and one model call that never sees the web; and the month's spend on research cannot pass the cap Andre set, because the gateway refuses, not because code counts.

## 2. Dependencies and order

57a (the rows) and 57b (what a turn keeps) are independent. 57c is pure. 57d needs all three and the engine. 57e needs 57d.

## 3. The rows (57a)

One additive migration.

```
enum ResearchState { QUEUED PLANNING READING VALIDATING SUBMITTING DONE SKIPPED WAITING_BUDGET FAILED }
enum ResearchSkip  { OFF_USER OFF_ORGANISATION NOT_AN_ANSWER NO_CITATION DEDUPED SAME_QUESTION DAILY_LIMIT BUDGET
                     NOTHING_TO_RESEARCH TEXT_PURGED UNAVAILABLE }
enum FindingOutcome { INVALID DUPLICATE REFUTED PROPOSED }

ResearchRun                                  // the asker's own row: under the tenant filter, keyed by userId
  id uuid, messageId String? @unique         // the assistant message it follows; null once detached by its conversation's delete (45 § 3.5, unit 62b)
  userId, organisationId?, releaseId, locale
  state ResearchState, skip ResearchSkip?, failure String?     // failure: a code, never text
  gap Boolean                                // the answer said "the book does not cover this"
  sectionAnchors String[]                    // the sections the answer cited
  questionSha256 String
  brief String?, briefSha256 String?         // the planner's text; purged with the message's (§ 8.3)
  searches Int, pageReads Int
  workflowId String @unique, traceId, createdAt, finishedAt?, textPurgedAt?

ResearchFinding                              // the asker's own row
  id uuid, runId, userId, ordinal Int, outcome FindingOutcome, invalidReason String?
  suggestionId String?                       // the only place a reader's question is tied to a suggestion
  @@unique([runId, ordinal])

ResearchMark                                 // the platform's: no user, no text
  key String @id                             // "section:<anchor>" | "question:<sha256>" | "budget"
  at DateTime, until DateTime?

Organisation.researchEnabled Boolean @default(true)
User.researchEnabled         Boolean @default(true)
Message.uncovered            Json?           // § 4
Message.retrievedSections    String[]        // § 4
BudgetKind += RESEARCH
```

`ResearchRun` and `ResearchFinding` join the tenant filter's models. A curator, the adjudicator and every query of `lib/db/improve.ts` have no way from a suggestion to the run that produced it: the reference points one way, from the asker's row.

## 4. What a turn hands over (57b)

Two things the researcher needs are computed during a turn and discarded today.

- **What the assistant would have said.** A claim the citation sensor could not ground is replaced by "the book does not cover this" (invariant 14), and the model's own sentence is gone by the time the turn returns. That sentence is the best description of what the book lacks. `answer()` keeps the replaced sentences and the turn stores them as `Message.uncovered` (`[{ sectionId, text }]`).
- **What was retrieved.** The sections retrieval gave the model, cited or not, as `Message.retrievedSections` (anchors).

`Message.uncovered` is never sent to a client: no endpoint's schema carries it, and a test asserts the assistant's `final` event and `GET /assistant/conversations/{id}` do not. It is model text about the reader's question, so it is purged with `Message.text` (§ 8.3). `retrievedSections` is metadata and stays.

Nothing else about the turn changes: same prompt, same sensors, same record. The `answer` ledger record is untouched, since it already counts substitutions.

## 5. Eligibility (57c, `lib/research/eligibility.ts`, pure)

`eligibility(turn, switches, marks, startedLast24h, now) → { run: true, gap } | { run: false, skip }`. First match:

| # | Check | Skip |
|---|---|---|
| 1 | research is configured (a research principal, the engine up) | `UNAVAILABLE` |
| 2 | the reader's switch is on | `OFF_USER` |
| 3 | the reader's organisation's switch is on | `OFF_ORGANISATION` |
| 4 | the turn is an answer: no refusal of any cause, not a failed turn | `NOT_AN_ANSWER` |
| 5 | the answer cites at least one section | `NO_CITATION` |
| 6 | the research budget is not known to be spent this month (the `budget` mark, § 7.2) | `BUDGET` |
| 7 | the reader started fewer than 30 runs in the last 24 hours (A13) | `DAILY_LIMIT` |
| 8 | this question, normalised and hashed, was not researched in the last 30 days (A12) | `SAME_QUESTION` |
| 9 | the answer has a gap, **or** at least one cited section was not researched in the last 30 days (A12) | `DEDUPED` |

Rule 9 is A12 as answered: a section is looked at again after 30 days, or at once when an answer says the book does not cover something. Rule 8 is why a gap asked about every day is researched once a month and not daily.

The question is normalised for hashing only: lower-cased, whitespace collapsed. The hash is the one the `answer` record already carries.

## 6. The run (57d)

### 6.1 Started at the turn's end, without touching the turn

In the workers' `runTurn`, after the assistant's message is stored and its ledger record attached, and before the `final` event:

1. Read the switches, the marks and the reader's count; call `eligibility`.
2. Write the `ResearchRun` row: `QUEUED`, or `SKIPPED` with its reason.
3. When queued: write the marks for the question and for each cited section (so a second turn a moment later is deduplicated), and start `ResearchWorkflow({ runId })`, id `research:<messageId>`, queue `hb-research`.
4. The `final` event carries `research: { state, skip?, runId? }`.

All of it is inside one `try`. Any failure sets `research: { state: "SKIPPED", skip: "UNAVAILABLE" }`, is logged with the trace id, and the turn completes exactly as it would have. Research can fail; it cannot fail an answer. The time these steps take is inside the turn's `totalMs` and is measured by the gate (spec 44).

### 6.2 `ResearchWorkflow`

```
1 load        the question, the answer, the uncovered sentences, the sections   inside the reader's own tenant context
2 plan        the planner (spec 41 § 5): a brief, or nothing to research       → NOTHING_TO_RESEARCH ends the run
3 read        the reader with web search and fetch (spec 41 § 6)                → findings
4 validate    each finding checked in code (spec 41 § 7)                        → INVALID · DUPLICATE · valid
5 submit      one suggestion per valid finding; its SuggestionWorkflow as a child (spec 42 § 4)
6 conclude    wait for each child to be proposed or refuted; the RESEARCH record; DONE
```

Activities take and return ids, enumerations and counts (spec 28 § 5.3). The question never is a workflow argument: step 1 reads it from the reader's rows and step 2 passes it to the model in memory.

Each agent has one attempt (invariant 15). A failure of the planner or the reader ends the run `FAILED` with a code; the marks stay, so the same sections are not retried until their 30 days pass or a gap appears.

### 6.3 The `RESEARCH` record

One per run that reached step 2, appended by step 6, actor `service:researcher`, `suggestionId` and `chapterVersionId` null:

`{ stepKey, runId, releaseId, sections, gap, planned: "brief" | "nothing", briefSha256, searches, pageReads, findings: [{ ordinal, outcome }], guide { version, sha256 }, models { planner, reader }, usage, traceId }`

It names no suggestion and no message. The ledger says that research ran and what came of it; who asked is in the asker's own rows and nowhere else.

## 7. The platform's budget

### 7.1 The principal (A6)

`RESEARCH_PRINCIPAL`, an ordinary `org:<id>` in the form `GATEWAY_ANONYMOUS_PRINCIPAL` already uses, read by the workers alone. The operator creates that organisation and mints its key; its cap is **US$ 20 a month** (A14), which is the key's `max_budget` at the gateway. No principal kind is added: the "platform principal" stays deferred with billing (architecture § 12, unit 37c).

Charged to it, each with its own `BudgetKind` and the run or suggestion as `ref`: the planner and the reader (`RESEARCH`), and the grading and adjudication of the suggestions a run produced (`GRADING`, `ADJUDICATION`). A reader's own principal pays nothing for research; a test asserts a reader's ledger gains no row from a run.

### 7.2 At the cap

The gateway refuses (invariant 7). The activity returns the reset date; the run becomes `WAITING_BUDGET` and sleeps until then; and the `budget` mark is written with `until` the reset. While that mark stands, rule 6 skips new turns outright. Research therefore does not queue a month of questions to spend the next month's budget in its first hour: the runs caught in flight resume at the reset, and everything asked in between was skipped and says so.

By the estimate given with A13 and A14 the cap is reached after a few dozen runs. That is the design working, not a fault.

### 7.3 The provider's search fee

The provider charges per web search as well as per token. Whether the gateway's `max_budget` counts that fee is not known and is measured in unit 58a. If it does not, the fee is added to the run's `BudgetLedger` row from the usage the provider reports, at a price pinned in `lib/gateway/prices.ts` from the provider's list, and the tracker records that the hard cap covers tokens only.

## 8. Privacy (57e)

### 8.1 What leaves the deployment, and to whom

| What | Goes to | Why it is acceptable |
|---|---|---|
| the redacted question, the answer, the uncovered sentences, the cited sections | the model provider, in the planner's call, through the gateway | the same party and the same path the assistant's own call uses for the same question |
| the brief and the book's sections | the model provider, in the reader's call | the brief is checked by code before it is sent (spec 41 § 5.3) |
| search queries and page addresses | the web, issued by the provider's tools | formed by the reader from the brief; the reader never held the question |
| nothing | any other service | no search vendor, no analytics |

Secrets are already redacted from a question before it is stored (spec 21 § 6.2), so the planner reads the redacted form.

### 8.2 The switches

- A reader: `User.researchEnabled`, on the account page beside the theme and shortcut controls, default on.
- An organisation: `Organisation.researchEnabled`, default on (A4). With no organisation admin screen yet, it is set by an operator's command and logged.
- Off means rule 2 or 3: no run row beyond the skipped one, no model call.

The account page's retention notice gains one line saying that an answered question may be researched, what is sent, and that it can be switched off (candidate, spec 43 § 9; built in unit 57).

### 8.3 Retention

The assistant's nightly purge (`purgeAssistantText`) also empties `ResearchRun.brief` and `Message.uncovered` when it empties the message's text, and stamps `textPurgedAt`. Hashes, counts, states and anchors stay. A run still waiting when its text is purged ends `SKIPPED` · `TEXT_PURGED`, and so does one detached by its conversation's delete (feature-specs/45 § 3.5; units 62b, 62c). Account deletion removes the reader's runs and findings with their conversations; a suggestion that came from one of them stays, because it holds nothing of the reader.

## 9. States a reader can meet

`queued`, `planning`, `reading`, `checking with Improve`, done with `n proposals` or `nothing to propose`, each skip reason in words, `waiting for budget · resets …`, `failed`. Their strings and where they show are spec 43 § 4, which maps every state and skip of § 3 to a line (rewritten 2026-10-10): a turn skipped for the budget and a run waiting for it read differently (43 D8), and a refusal has no line.

## 10. Out of scope

- **Research on a schedule**, or of a section nobody asked about.
- **Research on request** ("research this"), and research of a refusal: A2 chose every answered turn and never a refusal. Nothing in the product starts a run but an answer; spec 43 § 3 says so to the reader, and its D5 is where a manual start would be decided (recommended: not now).
- Earlier turns of the conversation: the run reads its own turn only (D2).
- A second run for the same message.

## 11. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | Only answers that cite a section | yes (rule 5) | a walk or a lab explanation with no citation has no section to improve |
| D2 | The run reads one turn, not the conversation | one turn | the less of a reader's words the planner holds, the less there is to leak; the answer already carries what the turn was about |
| D3 | New turns at the cap are skipped, not queued | skipped | § 7.2 |
| D4 | The uncovered sentences are stored | yes, purged at 30 days, never sent to a client | without them a gap is a count, and the researcher cannot tell what was missing |
| D5 | The organisation's switch set by command | for now | no organisation admin screen exists (spec 38 § 6) |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. The migration is additive; `ResearchRun` and `ResearchFinding` are refused by the tenant filter for another reader.
2. `eligibility`: one test per row of § 5, in order, including a gap inside the 30 days (runs), the same gap asked again (skipped, `SAME_QUESTION`), day 31 (runs), the thirtieth and thirty-first run of a day.
3. A turn with research configured and one without, on the stub: the same claims, citations, verdicts and `answer` record; the first has a `ResearchRun` and `research` in its `final` event.
4. With the engine stopped, a turn completes, its `final` event says `SKIPPED` · `UNAVAILABLE`, and no error reaches the reader.
5. A refusal of each of the four causes starts no run and makes no model call beyond its own.
6. `Message.uncovered` holds the replaced sentence of a substituted claim and appears in no API response (contract test over every assistant endpoint's schema).
7. The workflow's history for a run holds no string that is not an id, an enumeration or a hash (a test reads the history of a completed run and checks every payload against the schema-walk rule).
8. With the research key at its cap on the stub: the run waits, the `budget` mark is set, the next turn is skipped with `BUDGET`; at the reset the waiting run resumes.
9. The purge at 31 days empties `brief` and `uncovered` for the gate's own reader and leaves the hashes.
10. A reader's `BudgetLedger` has no new row after a run; the research principal's has the planner's and the reader's.

## 13. As built (unit 57, 57a to 57e: the rows, what a turn hands over, eligibility, the run, privacy, 2026-10-10)

- **The rows (57a)**: migration `20261010170000_research_rows`, additive — `ResearchRun`, `ResearchFinding` and `ResearchMark` as § 3 has them, in a block of the schema of their own; `ResearchRun.workflowId` nullable, since a skipped turn's row has no workflow; a run cascades from its message and its user, a finding from its run. `ResearchRun` and `ResearchFinding` join the tenant filter by `userId` (lib/db/client.ts): another reader's context finds nothing, and the workflow reads and writes them inside the asker's own context — which is why its input is the run's id **and the asker's**, both ids (28 § 5.3). `User.researchEnabled`, `Organisation.researchEnabled`, `Message.uncovered`, `Message.retrievedSections`, `BudgetKind.RESEARCH` (which the budget meter leaves off every row, as § 7 and 38 § 2 want). The door is `lib/db/research.ts`; the improvement door's test now ends its block at the next marker.
- **What a turn hands over (57b)**: `answer()` keeps the model's own sentence behind each claim the citation sensor replaced, paired by position with the sensed claims (the sensors keep one claim per claim, in order; were they not to, nothing is paired and the gap is a count), and the sections retrieval gave the model; `appendAssistantMessage` writes them; `AnswerResult` carries them as optional fields the `final` event never copies. `tests/research-contract.test.ts` walks every endpoint's response and event schemas for `uncovered` and `retrievedSections` and finds neither.
- **Eligibility (57c)**: `lib/research/eligibility.ts`, pure, the nine checks of § 5 in order; the budget mark holds until the reset it names; the question's hash is the `answer` record's (lower-cased, whitespace collapsed). One test per row, with A12's day 31 and A13's thirtieth and thirty-first.
- **The run (57d)**: `researchAfterTurn` (`workers/research/afterTurn.ts`) at the turn's end, after the message and its record and before the `final` event — the switches, the marks and the day's count read, eligibility, the row (`QUEUED` with the workflow's id, or `SKIPPED` with its reason), the marks for a queued run, `ResearchWorkflow` under `research:<messageId>` on `hb-research` — inside one try: any failure is `SKIPPED · UNAVAILABLE`, logged with the trace id, and the turn completes as it would have. The `final` event carries `research: { state, skip, runId }`. Research is configured where `RESEARCH_PRINCIPAL` and the engine's address are set; in development neither is, so every turn is skipped as `UNAVAILABLE` and nothing is started. `ResearchWorkflow` runs the six steps of § 6.2 with one attempt for the planner and the reader (invariant 15), waits at the cap for the reset the activity gives, ends `SKIPPED · TEXT_PURGED` where the text went before it read, and `FAILED` with the code where an agent failed. **The planner and the reader are spec 41's (unit 58)**: until they are built, `planResearch` fails the run with `PLANNER_NOT_BUILT`, and the `RESEARCH` record — which names the planner's model and guide — arrives with the planner. (Built in unit 58: spec 41 § 12 — the activities now run the planner, the reader, the validation and append the record.)
- **Privacy (57e)**: the reader's switch on the account page's Preferences (`updateResearch`, a segmented control with its sentence of what is sent and where it is switched off), the organisation's by `npm run research:org -- --organisation <id> --set on|off` with an audit row (`research_set`), the Retention instrument's line; the nightly purge empties `ResearchRun.brief` and `Message.uncovered` with the message's text, stamps `textPurgedAt`, and ends a run still waiting as `SKIPPED · TEXT_PURGED`; hashes, counts, states and anchors stay.
- Verified: `lib/research/eligibility.test.ts` (9), `workers/research/afterTurn.test.ts` (4), `tests/workflows/research.test.ts` (4: done, purged, the planner's failure and a plan of nothing, the budget's wait), `tests/integration/research-rows.test.ts` (3: another reader refused, the turn read back inside the asker's, the purge), `tests/research-contract.test.ts`, the full suite, lint, build, the PT truncation suite.

Decided here, for Andre to see:
- **The workflow is told the asker's id** beside the run's, so its activities read and write inside the asker's own tenant context; the alternative, a system exemption for the research rows, would widen a door kept to the four authentication models on purpose.
- **A run whose planner is not yet built fails with a code** rather than planning nothing: a `RESEARCH` record of "nothing planned" would say the planner spoke when none exists. In development no run is started at all, research being unconfigured.
- **The purge's research half runs inside each reader's context**, as the purge walks readers; the rows are the reader's.

Not exercised live: a turn with research configured (there is no research principal on this machine), the budget's wait on a real cap.

Amended by the review of units 57 and 58 (2026-10-10; spec 41 § 13): the hand-over's time is **not** inside the turn's `totalMs`, which the answer fixes before the hand-over runs — § 6.1's sentence stands corrected here; the question's hash handed to research is of the normalised question (§ 5 rule 8), the `answer` record's hash is of the question as redacted; an engine refusal takes the QUEUED row and its marks back; a run met by the purge on the way ends `SKIPPED · TEXT_PURGED` from any step and no step writes text onto a purged run; the day's count takes every run that had a workflow, however it ended; and the `RESEARCH` record of § 6.3 may say `planned: "failed"` for a planner that was called and failed, or a brief the sensor refused. **§ 7.3 answered on 2026-10-10** (spec 41 § 12): the gateway's `max_budget` counts the provider's search fee — its spend after the real check equalled the ledger's cost with the fee in it — so the hard cap covers tokens and searches, and the ledger's fee is the same money seen twice, not an addition.
