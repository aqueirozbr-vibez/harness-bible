# 45 · Deleting and withdrawing — feature spec (a reader deletes a conversation, its rows included; the asker's proposals outlive it; a contributor deletes a draft, with its files, or withdraws a suggestion that waits for a person)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: Andre's request of 2026-10-11, "we need to add a path for deleting conversations and improvements", and his four answers the same day:

| Question | His answer, as offered to him |
|---|---|
| What should deleting a conversation do? | **Delete the rows too**: "The rows themselves go once nothing writes to them. Departs from TRD § 4.4; past metrics, the reader's statistics and the calibration set change after the fact; needs a tally to keep the 30-a-day research cap; about twice the build. The ledger still keeps the same ids and hashes for good." He chose it over "Erase and hide", which kept the rows without their words. |
| A research proposal that came from a deleted conversation: what happens to it? | **Keep it, name removable**: "The proposal stays under Improve · Proposals from your questions, and 'Remove my name' is added there too, so the reader keeps the right to take their name back until the curator's merge (spec 42 D4). The delete dialog says so." |
| May a contributor withdraw a suggestion after submitting it? Today only a draft can be deleted ("a submission is a record"). | **Where it waits**: "Allowed while it waits for a person: declined at intake, asked for more evidence, or in the curator's queue. It closes with a 'withdrawn by its contributor' record; nothing is deleted. Refused while it is being decided, accepted, merging, merged or closed. Rate: 120 a minute, as other suggestion writes." |
| May a contributor erase their own words and files from a suggestion that has ended? | **Not now**. |

No screen of the UI package shows a delete or a withdrawal. Everything here is composed from what the product already has: the shared `ConfirmDialog`, a quiet `btn btn-sm`, the `ErrorBox`, a `role=status` line, the record timeline.

Before this spec was written, the code was mapped by readers, three designs were judged against each other (erase and hide; erase then delete; erase and hide with withdrawal), and the design that follows Andre's answers was checked against the code by four reviewers, each from its own side (the turn's tail; research rows; withdrawal; everything that reads the rows). They raised 29 findings, nine of medium severity and none high; every one is answered below (§ 12).

Prerequisite specs: `15` (the conversations API, § 8 retention), `17` (flags, D6), `21` (retention and observability), `26` (the assistant page), `31` (intake: the draft's delete), `33` (the suggestion's workflow and its waits), `36` (curation), `40` (the research run, § 8.3), `42` (proposals, D4), `43` (research in the product, § 6).

Scope: tracker units 62 (deleting a conversation) and 63 (drafts and withdrawals). Not here: § 10.

## 1. Purpose

A reader has had no way to delete anything they asked. The account's deletion request marks the account and closes its sessions, and the hard delete it promises is not built (`lib/db/account.ts` `requestDeletionFor`). A contributor can delete a draft through the API, but the page offers no control, and the draft's files stay on disk. Past the draft, a contributor who changes their mind cannot take a suggestion out of a curator's queue.

This spec gives the reader a real delete: the conversation's rows go, not only their words. It also gives the contributor two acts: deleting a draft with everything it stored, and withdrawing a suggestion that is waiting for a person. Two things are kept on purpose. The ledger only gains records (invariant 16). And a proposal the reader's question led to stays theirs to see and to take their name from.

## 2. Decisions

| # | Decision | Answer |
|---|---|---|
| D1 | What deleting a conversation does | **Delete the rows** (Andre, 2026-10-11). In the request: the conversation, its messages, citations, verdicts and flags, and the stored copy of each answer. Research runs still working are detached and lose their text in the request; their rows go once their workflow has ended and 24 hours have passed since they started (§ 3.5). Departs from TRD § 4.4 ("Conversation metadata · Life of account") and from architecture § 4.4, by Andre's decision. |
| D2 | Does a deletion leave a record in the audit chain? | **Yes** (Andre, 2026-10-11): one new ledger kind, `ERASED` (§ 3.7). The account page's Retention panel already says "Deletion is on request. Each request is a record in the audit chain." |
| D3 | A proposal that came from a deleted conversation | **Kept, name removable** (Andre, 2026-10-11). The asker's `PROPOSED` finding outlives its run, and **Remove my name** is added to the Improve list (§ 3.6). |
| D4 | Withdrawing a submitted suggestion | **Where its workflow waits for a person** (Andre, 2026-10-11), at `SUGGESTION_RATE`, 120 a minute (§ 5). |
| D5 | Erasing the words of an ended suggestion | **Not now** (Andre, 2026-10-11). |
| D6 | The gateway's Langfuse callbacks may keep prompt text, which no delete reaches (`infra/gateway/litellm.yaml`) | **Switch message bodies off at the gateway** (Andre, 2026-10-11), before Langfuse has keys, as one config unit of its own: unit 64, the setting checked against the pinned image. Langfuse keeps spans and costs, and no text. |
| D7 | The rate limit of `DELETE /api/v1/assistant/conversations/{id}` | **30 a minute** (Andre, 2026-10-11): `CREATE_RATE`, as creating a conversation (`lib/api/endpoints/assistant.ts:45`). |
| D8 | The account's hard delete and the withdrawal of provenance consent | **The next spec after this one** (Andre, 2026-10-11): spec 46, written after unit 62. It reuses this spec's door, and `ERASED` with an account scope. |
| D9 | The tally that keeps the 30-a-day research cap | **The run's own row** (Andre, 2026-10-11, confirming this spec's reading of D1). No tally table: the cap counts research runs started in the last 24 hours (`runsStartedSince`), so a detached run's own row, kept without its text or its message until 24 hours after it started, is the tally. The alternative, a `ResearchTally` table of `{ userId, startedAt }`, would let the row go sooner and need a table, a write at every deletion of a young run, and a sweep of its own. |

## 3. Deleting a conversation (unit 62)

### 3.1 What the reader gets

At once, in the request:

- The conversation leaves their list and every endpoint: the read, the ask, the flag, the research view and the export answer 404, as another reader's id does today.
- Its rows are deleted: `Conversation`, `Message` (the questions, the answers, the uncovered sentences, the walk's inputs, the stored mode results), `Citation`, `SensorVerdict`, `Flag`.
- The stored copy of each answer is deleted: the `final` event the ask endpoint keeps in `IdempotencyKey.response` for 24 hours, which holds the claims (`lib/api/endpoints/assistant.ts:240`).
- A research run that ended, or never had a workflow, goes with its message. A run still working is detached from it and loses its text (§ 3.5).

What stays, and why:

- **Every ledger record.** Each `ANSWER` record keeps the message and conversation ids, the cited sections, the verdicts, the timings, the hashes of the question and the answer, and the reader's pseudonym (`lib/schemas/ledger.ts:102-124`), as Andre's option said. One more record, `ERASED`, says the conversation was deleted (D2).
- **`BudgetLedger` rows**, which are append-only (`BUDGET_APPEND_ONLY`) and carry the spend, the reader and the trace.
- **The platform's research marks** (`ResearchMark`): they name no reader and hold no text, and taking them back would reopen paid research (spec 44 § 11). A run that had searched nothing when the conversation was deleted leaves its marks standing, as a failed run does.
- **A proposal the conversation led to**, and the reader's name on it while they keep it there (§ 3.6).
- **A detached research run's row**, without text or message, until its workflow has ended and 24 hours have passed (§ 3.5, D9).
- Outside the database, as before: ids in log lines and spans, ids and hashes in workflow histories for 72 hours, backups, an export the reader already downloaded, and Langfuse if it is keyed, until unit 64 switches its message bodies off (D6).

### 3.2 The endpoint

`DELETE /api/v1/assistant/conversations/{id}`, the spec `conversationDelete` in `lib/api/endpoints/assistant.ts`, the route's `DELETE` export beside its `GET`, and an `ALL_ENDPOINTS` entry; the OpenAPI document regenerated.

- A session and the same-origin check, as every write (`lib/api/handler.ts:126`, `:247`). No body and no `Idempotency-Key`: the pipeline claims a key on `POST` and `PATCH` only (`handler.ts:263`), and a delete is idempotent by construction, a second one answering 404.
- Policy: action `delete` (already a `PolicyAction`) on `ownResource("conversation", id, user)`. A new rule in `policies/hb/assistant.rego` allows it for the owner, beside read, ask and list; services stay denied; no organisation administrator may delete a reader's conversation, as none may read one.
- Rate: `CREATE_RATE`, 30 a minute (D7).
- Answers: `200 { id, deleted: true, ledgerSeq }` (`ledgerSeq` null when the record could not be appended, § 3.7); `404 NOT_FOUND`; `409 TURN_IN_PROGRESS` while the last turn settles (§ 3.4); and the pipeline's 401, 403 and 429.

The ask endpoint changes in one place: it looks the conversation up **before** it replays a stored final. Today the replay comes first (`assistant.ts:175-177`), so a final stored in the instant after the delete could still be answered.

### 3.3 The door

`deleteConversation(user, id, now)` in `lib/db/assistant.ts`: one interactive transaction inside the reader's `withTenant`, in this order.

1. **Lock the conversation row** with `SELECT "id" FROM "Conversation" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, registered in `lib/db/RAW_SQL.md`. No row: `NOT_FOUND`. The lock has to be `FOR UPDATE`. A `Message` insert's foreign-key check takes `FOR KEY SHARE` on the conversation row, and only `FOR UPDATE` conflicts with it. An `UPDATE` of a column that is not a key takes `FOR NO KEY UPDATE`, which does not (review finding *lock-orders-only-the-question*). Held, it makes every writer of the conversation's rows wait. Once the delete commits, each one fails on the missing row instead of landing between the delete's statements and tripping a `RESTRICT` key.
2. **The settle rule** (§ 3.4), read under the lock. Not settled: `TURN_IN_PROGRESS`.
3. **Research.** The runs of the conversation's messages that have a workflow (`workflowId` not null) lose their text and are detached: `brief` null, `found` null, `textPurgedAt` stamped where it is null, `messageId` null. Their state is not touched. Runs with no workflow, which were skipped at the hand-over and never counted for the cap, stay attached and go with their message by the cascade.
4. **Forget the stored finals**: the reader's `IdempotencyKey` rows on the ask path (`/api/v1/assistant/conversations/{id}/messages`, the template the pipeline keys by) whose `response.messageId` is one of the conversation's messages.
5. **Delete**, child first, because the keys from `Citation`, `SensorVerdict` and `Flag` to `Message`, and from `Message` to `Conversation`, are `ON DELETE RESTRICT` (`prisma/migrations/20260925120000_assistant/migration.sql:120-126`): `Flag`, `Citation`, `SensorVerdict`, `Message`, `Conversation`.

The writers that can meet a deleted conversation, and what each does:

- `appendUserMessage`: its insert fails on the missing conversation. It answers `NOT_FOUND`, so a question racing a delete gets a 404, not a 500.
- The nightly purge: a row deleted under it is skipped, not fatal. `writeFailedTurn` and the purge's write of a stored mode result tolerate a missing row (`updateMany`, or the missing-row codes caught for that row). Otherwise one delete could stop the night's purge for every reader after it, since the purge has no catch per reader (`lib/db/assistant.ts:489-539`).
- The turn's own tail: the settle rule keeps the delete out of it. A turn still running past its deadline, which a walk's or a lab's aid can make longer than the model calls alone, fails at its next write and logs it. It recreates nothing, because every insert needs the conversation's row.

### 3.4 The settle rule

The delete answers `409 TURN_IN_PROGRESS` while the conversation's last message is either of the following, or, since the review of unit 62 (§ 28), while any of its answers or refusals younger than 450 s has no stored final, since a reader may ask again before an earlier answer's final is stored:

- a `USER` row younger than `ANSWER_DEADLINE_MS`, 450 s (`lib/workers/client.ts:57`): the flow may still be running; or
- an `ASSISTANT` row with a guide version (answered or refused, not a failed turn) younger than 450 s whose final is not yet stored: no `IdempotencyKey` row of the reader on the ask path holds its id as `response.messageId`.

The stored final is the turn's last write. The `final` event follows the `ANSWER` record, its line on the row and the research hand-over (`workers/answer/turn.ts:263-276`), and the web tier stores the event as it passes (`assistant.ts:240`; `lib/api/sse.ts:99-100`). Every ask carries a key, because the pipeline requires one on `POST` (`handler.ts:263-265`). So this one test covers everything the tail writes: the ledger line, the run row (which the hand-over may not write when it fails early, review finding *handover-may-write-no-run*), and the stored final itself, which a delete before it would miss (*final-stored-after-forget*).

Settled, and deleted with the rest: a lone `USER` row older than 450 s (an abandoned turn, which the purge would otherwise close); a failed turn (no guide version; its error event is its last act); and an `ASSISTANT` row older than 450 s whose final was never stored (the reader closed the tab mid-stream).

The page enables **Delete** only after the `final` event, so the 409 meets a second tab, a client of the API, or a click within the instant between the event and its store. The page offers the delete again.

### 3.5 Research rows after the request

**The migration** (relaxing, forward-only): `ResearchRun.messageId` and `ResearchFinding.runId` become nullable. Both foreign keys keep `ON DELETE CASCADE`. So the gates' and the suites' cleanups, which delete messages and rely on the cascade to take their runs (`workers/gate/goldenDeps.ts` `clearConversations`; `tests/integration/assistant-stream.test.ts` and five more), behave as before. The door detaches a run before it deletes the message, so the cascade only takes what the door meant to let go.

**What a detached run does, by where it stood:**

| Where the run stood | What happens |
|---|---|
| `QUEUED` | `loadResearch` finds the text purged and the run ends `SKIPPED` · `TEXT_PURGED`, with no paid call. This needs two changes. `loadResearch` must test `textPurgedAt` before it reads the turn. And `readResearchTurn` and `readResearchCitations` must answer null and `[]` for a run with no message, before any query: `findUnique({ where: { id: null } })` is not "no text", and a filter of `undefined` would read another of the reader's messages (review finding *detached-run-reads-null-message*). |
| `PLANNING`, the planner's call in flight (up to 10 min) | The call completes and is charged. Its brief is refused (`textPurgedAt` is set), and the run ends `SKIPPED` · `TEXT_PURGED` **with no `RESEARCH` record**, because no brief stands (`plannedOf`). The call shows in `ResearchSpend` only. |
| `WAITING_BUDGET` | It sleeps until the budget's reset, then ends `SKIPPED` · `TEXT_PURGED` at its next step. Its row waits with it. |
| `READING`, the reader's call in flight (up to 35 min) | The call completes and is charged, and its findings are refused. The run ends `SKIPPED` · `TEXT_PURGED` with its record. The reader's step writes its counts of searches and page reads with the unguarded `writeResearchCounts` **before** its findings, so the record says what the provider charged (review finding *inflight-run-record*). |
| `VALIDATING`, `SUBMITTING` | The step finds no `found` and the run ends `SKIPPED` · `TEXT_PURGED` with its record. |
| Past its submission, waiting for its suggestions (up to 40 days) | It needs no text. It goes on asking where its suggestions stand, by run id, and ends `DONE` with its record. Its findings become `PROPOSED` or `REFUTED` as before. |

`ResearchRunRow.messageId` becomes `string | null`, and `recordResearch` drops its `research:${run.messageId}` fallback: a run that concludes has its `workflowId`.

**The sweep.** A new step of the nightly retention run, `npm run assistant:purge`: a sibling of `purgeResearchText` in `lib/db/research.ts`, called by `scripts/assistant-purge.ts` after `purgeAssistantText`, honouring its `reader` option the same way.

- **Its readers.** It has its own owner statement, `SELECT DISTINCT "userId" FROM "ResearchRun" WHERE "messageId" IS NULL AND "createdAt" < $cutoff`, registered in `RAW_SQL.md`. The purge's own statement names only readers who still have messages or an unpurged conversation, so it would never visit a reader who deleted their last conversation (review findings *sweep-misses-readers*).
- **What it deletes.** For each reader, inside `withTenant`, it deletes a detached run once both hold:
  - it started more than 24 hours ago, so the cap's window no longer counts it (D9);
  - it has no workflow, or the engine says its workflow is not running (closed, or no longer known to it).
- **Why the engine.** The sweep asks the engine, not the run's row, whether the workflow is still running. A row can say it ended while its workflow still runs: the 30-day purge ends a waiting run `SKIPPED` on its row, and a run's conclusion writes its state before its record. A workflow can also stop without its row ever saying so. Keying on the workflow closes both gaps (review finding *sweep-keys-on-row-not-workflow*). `lib/workflows/client.ts` gains a describe of one workflow for this.
- **If the engine cannot be reached**, the step is skipped that night and its counts say so.
- **The findings.** Before a run is deleted, its `PROPOSED` findings that name a suggestion are detached (`runId` null) and kept. Its other findings go with it by the cascade.

**Amended by feature-specs/48 § 17.2 (unit 70, 2026-10-12), for research on request.**

- **"Detached" is neither a message nor a research conversation**: `"messageId" IS NULL AND "conversationId" IS NULL`, in the owner statement and in the reads. Read on `"messageId"` alone, every run of a person's research matched, and the sweep would have deleted a person's live research once its workflow ended and 24 hours passed.
- **It keeps more findings.** Before a run goes, besides its `PROPOSED` findings, it detaches and keeps its `SUBMITTED` findings whose `finding:<id>` workflow (spec 48 § 8.4) the engine says is running. The engine is asked as for the run's own workflow, and an engine that cannot be reached stops the step for the night.
- **It ends what it kept.** A second pass deletes the detached findings that are no proposal of the asker's: `REFUTED` and `DUPLICATE` ones, and `SUBMITTED` ones whose workflow no longer runs. Its owner statement names the readers with such a finding too. The counts gain the findings kept and deleted.

The research metrics do not read `ResearchRun`: their views are built from the ledger and `BudgetLedger` (migration `20261011090000_research_metrics`). So the sweep moves none of the five research series. The researcher's gate reads one measure through the run: "from the answer to a proposal shown", from `finding.run.createdAt` (`scripts/research-gate.ts:208-211`). It skips a finding with no run and prints how many it skipped (review finding *gate-measure-reads-run*).

### 3.6 The asker's proposals

The `PROPOSED` findings outlive their run, so the proposal stays under **Improve · Proposals from your questions**. The two reads that serve it already read findings without the run:

- `readProposalsOfAsker` reads by tenant, outcome and suggestion (`lib/db/research.ts:191`). Its order moves from the run's `createdAt` to the proposal's own time, the suggestion's `submittedAt`, which the door's rows carry. A detached finding has no run, and Postgres sorts its null key first under `DESC`.
- `askerOfProposal` counts by suggestion and outcome (`:227`).

The `ProposalEndorsement` row's only key is to `User`, so the delete leaves the reader's name where it was.

**Remove my name** joins the Improve list. In the landing page's proposals table (`components/improve/ImproveHome.tsx:85`), the name column's cell gets a small client island beside "with your name" that removes the name. It calls the panel's own endpoint, `DELETE /api/v1/proposals/{suggestionId}/endorse`, on the same rule: until the curator's merge is taken (spec 42 D4). It uses the panel's strings (`improve.proposal.unendorse`, `failedRemove`, `settled`). Today the panel under the answer is the only way to take a name back, and it goes with the conversation.

`ResearchFinding` has no key to `User`. A detached finding does not go with its account by any cascade, so the account's hard delete (D8) must delete it by `userId`.

### 3.7 The record of a deletion (D2)

Andre answered D2 yes on 2026-10-11.

- **The kind.** One new ledger kind, `ERASED`:
  - Actor `user:<id>`. It names no suggestion and no chapter version.
  - A strict payload `{ stepKey, scope: { kind: "conversation", id } }`, with the step key `stepKeyOf("conversation:<id>", "erased")`.
  - The id is already in every `ANSWER` record of the conversation, so the record adds no new fact about the reader. It only says the rows were deleted, which explains why those records point at nothing.
- **Where it is declared.** `LEDGER_KINDS` and the Prisma enum together; the payload's union member; a `RECORD_RULES` entry `ERASED: { actors: ["user"], about: "nothing" }`, since a kind with no rule is never checked (`lib/schemas/ledger.ts:510-511`); a row in the payload walk of `lib/schemas/ledger.test.ts`; and a finder by step key in `lib/db/ledger.ts`, beside `researchRecordAt`. `lib/ledger` does not change.
- **When it is appended.** The endpoint appends it after the delete commits, so the ledger never claims a deletion that did not happen. It looks for an existing record by step key first. The route-written `EXPORT` record is the precedent (`assistant.ts:296-305`).
- **If the append fails** after the commit, the deletion stands without its record. The answer carries `ledgerSeq: null` and the request's line names the trace. A second delete of the same id answers 404 and cannot write it. Making that 404 the retry would need a search of the ledger's `ANSWER` payloads by conversation, so the limit is recorded instead (review finding *erased-append-no-retry*).
- **The audit pack.** The reader's pack selects `ERASED` beside `ANSWER`: in `lib/schemas/audit.ts`, `answers` becomes `["ANSWER", "ERASED"]`, and the checkbox's label says so.

### 3.8 What changes after the fact

Andre's option named these, and this is them exactly (review findings *metrics-not-all-lose*, *gate-measure-reads-run*):

- **The assistant series.** Seven of the nine lose the conversation's rows: citation rate, flag rate, refusal rate by cause, first-token p95, grounded distribution, edition mismatch, purge. Cost per active account keeps the spend, which comes from `BudgetLedger`, but loses the reader from its denominator, so a past value can rise. Cache-read share reads `BudgetLedger` alone and does not change.
- **The reader's statistics panel** loses the conversation's turns, except its cache cell, which reads `BudgetLedger`.
- **The grader's calibration set** (`lib/db/calibration.ts`) loses the conversation's flags. The flag dialog says so (§ 6).
- **The researcher's gate's measure** "from the answer to a proposal shown" loses the findings whose run the sweep deleted.
- **What does not change:** the research series, the ledger, the budget meter, and an export already downloaded, whose `EXPORT` record stays valid.

### 3.9 The page

On the assistant page only, in v1.

- **Delete conversation** is a quiet `btn btn-sm` in the open conversation's block of the conversations column (`components/assistant/ConversationsTree.tsx:82-93`), beside **export JSONL**, with `aria-haspopup="dialog"`.
  - It shows whether or not the conversation has turns. An ask refused before its question was written leaves a conversation with none, which the list still shows (review finding *empty-conversation-has-no-foot*).
  - It is disabled while an answer streams, with a help line.
  - It is never inside the row's link: a button inside it would be nested interactive content.
- **The dialog** is the shared `ConfirmDialog`: focus opens on Cancel, Esc cancels, and the confirm is the destructive one.
  - Its title names the cited chapters, as the row's label does, never the reader's words.
  - Its body says what goes and what stays (§ 6).
  - Its child is **Export JSONL first**, the conversation's own export.
- **On 200 or 404** the page goes to `/[lang]/assistant?deleted=<id>`, without `?ask`; `<id>` since the review of unit 62, so that each delete mounts the dock afresh (§ 28).
  - Going to the page without `?ask` remounts the dock's session and its conversations column, so any client state would be lost. The URL carries the outcome instead (review finding *status-lost-on-remount*).
  - From the parameter the column's head shows a `role=status` line, focus moves to **New conversation**, and between 1000 and 1359 px the conversations overlay opens to show it.
- **Otherwise** an `ErrorBox` says what failed, that nothing was deleted, and the trace.
- **Not in the dock, nor in the chapter's log rail**, in v1. The dock's window-level Esc (`components/assistant/AssistantDock.tsx:240-251`) would close the dock behind the dialog.

## 4. Deleting a draft (unit 63)

The delete exists: `DELETE /api/v1/suggestions/{id}`, owner only, `DRAFT` only, policy `write` (`lib/api/endpoints/suggestions.ts:498-518`). What it lacks is the cleanup and a control.

- **What the delete cleans up.**
  - `deleteDraft` (`lib/db/improve.ts:1011-1015`) returns the draft's items from the same transaction: ids, states, storage keys.
  - The endpoint cancels the `evidence:<itemId>` run of each `PENDING` item, as the item's own delete does (`lib/api/endpoints/evidence.ts:144-152`).
  - Whatever the cancels answer, the endpoint removes the draft's whole prefix in the store, `evidence/<suggestionId>/`, not only the items' keys. An upload that never became an item has a key under it that no item names (review finding *draft-cleanup-leaves-objects*). The store gains a removal by prefix: one directory in the local store.
  - An item removed from a draft loses its objects the same way. An item removed from a suggestion under revision keeps them, because its earlier records name it (tracker row 702 stays open).
- **A grade already reading the item** may write its object after the removal, because a cancel does not stop a running activity. The grader's `fetchItem` and `storeText` therefore remove the object they just wrote when the row's write answers false.
- **No ledger record**: a draft was never in the ledger. Its id stays a gap in the serial (spec 29 § 3).
- **The control.**
  - **Delete draft** goes on the edit page's rail, but not on a revision: a suggestion under revision is not a draft.
  - It opens a `ConfirmDialog`.
  - On 200 or 404 the autosave stops and the page goes to `/[lang]/improve?deleted=<id>`, which shows a Done notice as the marks page does.

## 5. Withdrawing a suggestion (unit 63)

### 5.1 Where

A person's suggestion (origin `HUMAN`) can be withdrawn while its workflow waits for a person:

- `INTAKE_DECLINED`;
- `DECIDED` or `CURATOR_QUEUE` with `REQUEST_MORE`;
- `CURATOR_QUEUE` waiting for a curator.

These are exactly the places where `SuggestionWorkflow` rests in its one condition (`workers/workflows/suggestion.ts:204-208`, `:299`). A move to `CLOSED` is already legal from each of them (`lib/schemas/improve.ts:72-76`). Neither `SUGGESTION_MOVES` nor any trigger changes. The only trigger on `Suggestion` refuses the delete of a row past draft, which this does not do.

The withdrawal is refused (409, with the state):

- while `SUBMITTED`: the run is mid-step, and a grade or an adjudication may be in flight, a run asleep at a budget cap included;
- once accepted or merging: the merge child runs to the end;
- once `MERGED` or `CLOSED`.

A researcher's proposal and a curator's revert have no owner, so the policy refuses them (`policies/hb/improve.rego:44-49`; the `CHECK` `"origin" = 'HUMAN' OR "userId" IS NULL`).

### 5.2 The endpoint

`POST /api/v1/suggestions/{id}/withdraw`: role `CONTRIBUTOR`; policy `write` on `resourceOf`, so only the owner passes; an `Idempotency-Key`; `SUGGESTION_RATE`, 120 a minute.

1. **Read the row** through the door. The endpoint refuses (409, with the state) when the state is not one of § 5.1's, or when a curator's action of this visit stands. That is the count `writeCuratorAction` makes: an action since the decision that queued the suggestion, which the workflow will record first.
2. **Write the request on the row.** A door function `requestWithdrawal(caller, id, at, decidedAt)` sets `Suggestion.withdrawnAt = at`, guarded on all of these: the caller's row, origin `HUMAN`, a state of § 5.1, the `decidedAt` the endpoint read, and no withdrawal standing. The caller's own request already standing is answered as it stands, with its instant, and the endpoint sends that request again (§ 20).
3. **Signal** `withdrawn { userId, at, decidedAt }`, which carries ids and instants only (code-standards line 124), through the `WORKFLOWS` registry. On any error the request is taken back: `withdrawnAt` is set to null where it still is `at`. The answer is then 503 (the engine is unavailable) or 409 (the run has ended). A 503 means the request was taken back; a signal the engine took as the deadline passed may still be recorded, and the row then reads withdrawn (§ 9, § 17; review of unit 63).
4. **Wait for the record** by its step key, as the curator's decision does (`lib/api/endpoints/curation.ts:166-181`, 5 s). It answers `200 { id, state, ledgerSeq }`, with the state read from the row, or `202` while it is recorded. The signal delivered, a failure of this wait answers 202 too: the run decides (§ 20).

`writeCuratorAction` gains `withdrawnAt: null` in its query. A curator's decision on a suggestion whose withdrawal stands is then refused with the decision endpoint's existing conflict: the suggestion is no longer in the queue.

### 5.3 The workflow

`SuggestionWorkflow` changes as follows (review finding *patched-guards-the-command-not-the-signal*):

- **The handler.** It takes `withdrawn` with a handler registered at the start, unconditionally, beside `revised` and `curatorDecision`. A handler and a condition's term are not commands. A `patched()` check made at the start would answer false while every waiting run replays, and those runs would never take a withdrawal.
- **The condition.** The wait gains a term: `withdrawals.length > 0`.
- **The order.** A withdrawal is handled after a curator's action already queued, which goes first, and before a revision.
- **The patch.** The withdrawal is shifted off its queue first. Only then does `patched("63e-withdrawal")` gate the one new command, the activity `recordWithdrawal`. A false answer drops the withdrawal.
- **Deploy order.** The workers (63e) are deployed before the endpoint (63f). No history then holds a withdrawal that old code ignored, and `signalWorkflow` refuses a signal missing from the registry in any case.
- **A failure.** A failed `recordWithdrawal` goes back to the front of its queue and is tried again on the `RECORD_AGAIN` back-off, inside the same patch, as a curator's action is. Its record is appended before its move, so it must not be dropped half done (review finding *failed-withdrawal-step-unspecified*).

**`recordWithdrawal`** records only if all of these hold (review finding *stale-withdrawal-outlives-its-decision*):

- the suggestion is `HUMAN`;
- its contributor is the signal's user;
- the row holds the signal's `at` as `withdrawnAt`;
- its `decidedAt` is the signal's;
- its state is still one of § 5.1's;
- no curator's action of this visit stands.

When they hold, it does two things:

1. It appends `RETRACTED` once, by step key, with actor `user:<id>`, the suggestion and its chapter version. The payload is `{ stepKey, rubricVersion, origin, from, outcome }`; the first three are what every suggestion record carries.
2. It calls `moveAlong(from → CLOSED, { closedAt })`. The run then ends, since `CLOSED` waits for nothing.

When they do not hold, it takes the request back and records nothing. A withdrawal sent against one decision therefore never closes the suggestion after a merge has returned it under another.

**What is kept:**

- the outcome and `decidedAt`, so a withdrawn intake decline still counts for the throttle (`lib/db/improve.ts:1442-1444`);
- the evidence, the scores and every record.

No `CuratorAction`, `CalibrationEvent` or seed is written or removed, so the curation measures do not move.

### 5.4 The kind and the read side

**The kind** is `RETRACTED`. `WITHDRAWN` is taken: the record timeline titles an unknown kind by its own name and already uses `title.WITHDRAWN` for an endorsement taken back (`components/improve/RecordTimeline.tsx:38-42`).

It is declared in five places:

- the Prisma enum and `LEDGER_KINDS`;
- the payload's union member;
- `RECORD_RULES` `RETRACTED: { actors: ["user"], about: "suggestion" }` (review finding *record-rules-entry*);
- a row in the payload walk of the ledger's test;
- `lib/schemas/audit.ts`, where `adjudications` becomes `["DECIDED", "RETRACTED"]`.

**The read side ships before the first record**, since a kind the reader cannot parse reads `UNREADABLE` (`lib/improve/record.ts:107-108`):

- **The record.** The record's facts and the timeline's title and body for `RETRACTED`.
- **The view.** `withdrawnAt` reaches `SuggestionViewSchema`, the door's suggestion select and `OWN_ROW` (review finding *read-side-variant-order*).
- **The outcome view.** It shows the withdrawal in two variants:
  - *withdrawing*: a waiting state with `withdrawnAt` set, while it is recorded;
  - *withdrawn*: `CLOSED` with `withdrawnAt`. This is checked first in the `CLOSED` branch, before the decline test. Otherwise a withdrawal from `INTAKE_DECLINED` would read "Declined", and every other one "closed by a curator".
- **The landing table** derives its state label from it.
- **The control.** **Withdraw** sits for the owner in § 5.1's states, in the outcome page's actions row (`components/improve/ImproveOutcome.tsx:90-104`), with a `ConfirmDialog`. On a 202 the page's Decision says the withdrawal is being recorded, then shows where the suggestion ended. A 202 never reads as success.

## 6. Strings

EN and PT candidates for Andre (rules § 4.6). Keys are named in the units that add them.

**Deleting a conversation**

| | EN | PT |
|---|---|---|
| trigger | Delete conversation | Apagar conversa |
| help while streaming | available when the answer has finished | disponível quando a resposta terminar |
| title | Delete the conversation on {chapters}? | Apagar a conversa sobre {chapters}? |
| title, no citation | Delete this conversation? | Apagar esta conversa? |
| body | Its questions, answers, citations and flags are deleted now. Research still running on it stops at its next step, unless it has already sent a finding to Improve. The audit chain keeps one record per answer, as hashes without words, and records this deletion. | As perguntas, as respostas, as citações e as sinalizações são apagadas agora. A pesquisa ainda em andamento sobre ela para no próximo passo, a menos que já tenha enviado uma descoberta ao Melhorar. A cadeia de auditoria mantém um registro por resposta, em hashes e sem palavras, e registra esta exclusão. |
| body, when it led to a proposal, or may | A proposal that comes from it stays under Improve, where you can remove your name until it is merged. | Uma proposta que vem dela continua em Melhorar, onde você pode remover seu nome até que seja incorporada. |
| link | Export JSONL first | Exportar o JSONL antes |
| confirm | Delete | Apagar |
| done | Done · Conversation deleted. | Feito · Conversa apagada. |
| failure | The conversation was not deleted | A conversa não foi apagada |
| settling (409) | The last answer is still being saved · try again in a moment | A última resposta ainda está sendo salva · tente de novo em instantes |

**Amended** (each lands with the unit that makes it true):

| Key | Today | Candidate EN | Candidate PT |
|---|---|---|---|
| `account.retention.conversationsValue` | text 30 days | text 30 days, or until you delete it | texto por 30 dias, ou até você apagar |
| `auth.panel.retention` | … assistant conversations 30 days as text, then metadata; … | … assistant conversations 30 days as text, then metadata, until you delete them; … | … conversas com o assistente por 30 dias como texto, depois só metadados, até você apagá-las; … |
| `assistant.flag.body` | … No text is sent. | … No text is sent. It leaves the set if you delete the conversation. | … Nenhum texto é enviado. Ela sai do conjunto se você apagar a conversa. |
| `account.retention.note` | Deletion is on request. Each request is a record in the audit chain. | unchanged; with `ERASED` (D2) it becomes true of a conversation's deletion. It stays untrue of the account's request, which writes an `AuthEvent` swept after 90 days, until spec 46 (D8). | unchanged |

**The Improve list**: none new. It reuses `improve.proposal.unendorse`, `failedRemove` and `settled`.

**Deleting a draft**

| | EN | PT |
|---|---|---|
| trigger | Delete draft | Apagar rascunho |
| title | Delete draft {id}? | Apagar o rascunho {id}? |
| body | The draft, its evidence and the files you uploaded for it are deleted. Nothing of it was recorded, and its number is not used again. | O rascunho, as suas evidências e os arquivos que você enviou para ele são apagados. Nada dele foi registrado, e o número não é usado de novo. |
| done | Done · Draft {id} deleted. | Feito · Rascunho {id} apagado. |

**Withdrawing**

| | EN | PT |
|---|---|---|
| trigger | Withdraw | Retirar |
| title | Withdraw suggestion {id}? | Retirar a sugestão {id}? |
| body | It is closed now and goes no further, and it is not reopened. Its record stays, with your withdrawal in it. | Ela é encerrada agora, não segue adiante e não é reaberta. O registro fica, com a sua retirada nele. |
| while recording | Withdrawal sent · being recorded | Retirada enviada · sendo registrada |
| outcome badge | withdrawn | retirada |
| timeline | Withdrawn by its contributor | Retirada por quem a enviou |
| refused | accepted · being merged: it can no longer be withdrawn | aceita · sendo incorporada: não pode mais ser retirada |

Since the review of unit 63 the control says neither the line while recording nor the refused line: the redrawn Decision says both, as `improve.outcome.decision.line.withdrawing` and the accepted or merging badge (§ 20).

## 7. What the context files say today

Each of these is amended by the unit that makes it untrue, in its commit (rules § 6.1). None is changed before the code (review finding *amend-list-incomplete*).

| Where | Says today | Amended by |
|---|---|---|
| TRD § 4.4 (read-only) | Conversation metadata · Life of account · Rows stay for the metrics and the calibration set | stays as written: departed from by Andre's D1, recorded in architecture § 12 (62a) |
| architecture § 4.4, rows "Assistant message text" and "Conversation metadata" | text nulled after 30 days; metadata kept for the life of the account | 62e: the reader's delete takes the rows at once; a detached research run's row stays until its workflow ends and 24 h have passed |
| architecture § 4.1, the assistant row and the research row | "Message text nulled after 30 days; metadata, citations, verdicts, flags kept"; "`ResearchRun.messageId` unique … counts, states, anchors and hashes stay" | 62b (nullable columns), 62e (the delete) |
| architecture § 4.3, the record kinds | `research`, `endorsed` the latest | 62d (`erased`), 63c (`retracted`) |
| architecture § 3.4, the Assistant and Suggestions rows | no `DELETE` of a conversation; the draft's delete | 62h, 63a, 63f |
| architecture § 6.3, the text-purge job's row | the purge clears text and deletes no row | 62f: the purge's research sweep deletes detached runs |
| spec 15 § 8 and § 10 | "Citations, verdicts, flags, timings, hashes and the ledger stay"; "conversation deletion by the user (… a later decision)" | 62e, 62h |
| spec 17 § 7 (line 82), § 10 (line 99), D6 (line 111) | "nothing is deleted"; "Deleting a conversation" out of scope; D6 defer | 62a marks D6 decided by this spec; 62i the rest |
| spec 21 § 3.3 (line 49) | "the purge never deletes rows" | 62f |
| spec 26 § 10 (line 128) | "Deleting or renaming a conversation (spec 17 D6, still deferred …)" | 62i: renaming only |
| spec 31 (lines 50, 122) | "`DELETE /api/v1/suggestions/{id}` — owner, `DRAFT` only"; "Withdrawing a submitted suggestion. … a submission is a record." | 63a, 63f |
| spec 40 § 3 and § 8.3 (lines 30, 166) | `messageId String @unique`; "A run still waiting when its text is purged ends `SKIPPED` · `TEXT_PURGED`" | 62b, 62c |
| spec 43 § 6 (line 137) | a purged conversation's reader still sees the proposal | 62i: purged or deleted, with Remove my name on the list |
| project-overview line 123 | "the link between a question and a proposal … is purged with the message text after 30 days" | 62a, reported here as a disagreement the code already settled the other way: the link holds no text and outlives the purge (spec 43 § 6) and now the delete. Andre kept the correction on 2026-10-11. |
| `lib/db/assistant.ts` `purgeAssistantText`'s comment; `lib/db/research.ts` `readProposalsOfAsker`'s | what stays; "one whose conversation's text was purged" | with the code they describe |

## 8. Verification (in addition to rules § 7)

- **The door, on the database**:
  - **Refused, and nothing changes:** a foreign id; an open turn and an unstored final, each with 409; a racing question, which gets `NOT_FOUND` rather than a 500.
  - **Deleted:** an abandoned turn with the rest; every row of the conversation gone; the stored final forgotten, and a replay of its key answering 404.
  - **Research:**
    - a run with a workflow is detached, its text erased and its state untouched;
    - a run without one is deleted;
    - a detached `QUEUED` run ends `SKIPPED` · `TEXT_PURGED` on the time-skipping server;
    - the reader's `PROPOSED` finding is still listed under Improve, and its name can be removed.
  - **Unchanged:** the marks, and `runsStartedSince`.
- **The sweep, on the database**:
  - **Kept:** a detached run younger than 24 h; a detached run whose workflow runs; every run, when the engine is unreachable.
  - **Deleted:** a detached run older than 24 h whose workflow is closed or unknown, with its `PROPOSED` findings kept detached.
  - **Reach:** a reader with no message left is visited.
- **The purge:** a row deleted between its read and its write is skipped, and the purge goes on to the next reader.
- **The endpoint**:
  - contract: 200, 404, 409, the error body, the policy's action, the rate limit's headers;
  - the policy's deny cases: another reader, anonymous, an organisation's administrator, a service;
  - the `ERASED` record appended once, and found by its step key on a retry before commit.
- **The page**, in EN and PT:
  - Playwright: delete from the column, the dialog, the status line after the remount, focus on New conversation, and the overlay at 1200 px;
  - axe, and the PT truncation snapshot.
- **The Improve list:** Remove my name on a proposal whose conversation was deleted.
- **The draft**:
  - the delete cancels a pending item's grading and removes the prefix, an orphan upload included;
  - a grade finishing after the delete leaves no object.
- **The withdrawal**:
  - each of § 5.1's states;
  - each refused state;
  - a curator's action racing the request: whichever comes first wins, and the other is refused or recorded nothing;
  - a stale withdrawal after a merge returned the suggestion records nothing;
  - the record written exactly once;
  - a replay of a history recorded before the patch;
  - a failed `recordWithdrawal` tried again;
  - the 503 path leaving the row as it was;
  - the outcome page's two variants;
  - the timeline's line.

## 9. Risks and limits

- **"Delete" may read as "every trace is gone".** The dialog says what stays: the ledger's records, kept as hashes and ids; `BudgetLedger`; ids in logs and spans; workflow histories for 72 hours; backups; downloaded exports; Langfuse if keyed (D6). Whether this answers a per-conversation LGPD request is for counsel to read.
- **The `ANSWER` record's `questionSha256` is a plain sha256 of the redacted question**, so a short question can be confirmed for good by guessing. Deleting does not change this. Keying that hash would be a separate change to the payload.
- **Paid research already in flight completes and is charged**, and its output is dropped. A planner's brief that comes back after the delete leaves no `RESEARCH` record, only its spend (§ 3.5).
- **A detached run's row**, without text or message, lives until its workflow ends and 24 hours have passed, and until the nightly run sweeps it. A run asleep at the budget keeps it until the reset. On this machine neither nightly job is scheduled (unit 45e is set aside), so the sweep runs when `npm run assistant:purge` is run.
- **The marks stay.** A run detached before it searched leaves its question and sections marked for 30 days, as a failed run does.
- **The settle rule waits for the stored final.** A turn whose final never arrives can be deleted only 450 s after its answer.
- **The `ERASED` record can be lost**, if its append fails after the delete commits (§ 3.7).
- **Withdrawal needs a live run.** It answers 503 while the engine is down and 409 once the run has ended. It is not possible while a suggestion is `SUBMITTED`, a budget sleep included.
- **A request left standing.** If the signal fails and the take-back fails too, or the server stops between the request and its signal, the request stands with no run told of it. The curators' queue leaves the suggestion out meanwhile. The owner's page offers Withdraw again once the request has stood unrecorded for two minutes, and the endpoint sends that request again (§ 20). A failed take-back's line names it with the trace (§ 18); a stopped server logs nothing.
- **A curator's action that reaches the run first wins**, and the contributor's withdrawal then records nothing. The 202 says only that the withdrawal is being recorded. The reverse is unreachable in practice but not closed: a curator's action written in the instant after a withdrawal was recorded is never recorded, since neither write locks the suggestion's row (§ 17).
- **A 503 can understate.** A withdrawal signal the engine takes just as the endpoint's 5 s deadline passes may still be recorded after the endpoint answered 503 and took the request back; the run's move writes the request's instant again, so the row and the record agree (§ 17).
- **An upload's PUT after its draft's delete.** The signed URL's PUT checks only its token, which lives ten minutes. A PUT that lands after the delete writes under the removed prefix, and its object then has no row and stays. The route stands for a bucket's pre-signed URL and reads no row; closing it needs a sweep of prefixes no suggestion names, as a bucket's lifecycle rule would be (§ 20).
- **A deleted draft's grade already in flight is still paid.**
- **The detached `QUEUED` run is the usual case** of a delete moments after an answer. Without § 3.5's two read changes it would fail its workflow and stay `QUEUED` for good. Those changes ship in 62c, before the door.

## 10. Out of scope

- **Erasing an ended suggestion's words** (D5).
- **The account's hard delete and the withdrawal of provenance consent** (D8): spec 46.
- **The gateway's message logging** (D6): unit 64, its own config unit.
- **Delete in the dock and in the chapter's log rail.** The dock's window-level Esc must first stand back for a dialog. The flag dialog in the dock already has this defect, found by reading the code.
- **Deleting all conversations at once.** It would go on the account page's Retention instrument, with the account's typed-word dialog.
- **Renaming a conversation, and deleting a single turn.** Ordinals and later answers are built from earlier rows.

## 11. Units

Two units in Andre's lean shape, one review each at its end. Within a unit, each part is verified by rules § 7 before the next. A migration is its own part and goes first. A read side ships before anything writes what it reads.

**Unit 62 · deleting a conversation**

| Part | What | Folders |
|---|---|---|
| 62a | This spec, the tracker, architecture § 12's decision (D1 to D9, all Andre's), spec 17 D6 marked decided, project-overview line 123 | `context/` |
| 62b | Migration: `ResearchRun.messageId` and `ResearchFinding.runId` nullable, both keys still `CASCADE`; `ERASED` on `LedgerKind` | `prisma/` |
| 62c | Research reads of a detached run: `ResearchRunRow.messageId` nullable; `readResearchTurn`/`readResearchCitations` with no query for a null message; `loadResearch` tests `textPurgedAt` first; `recordResearch`'s fallback dropped; the reader's counts written before its findings; `readProposalsOfAsker`'s order; the research gate's measure; `clearResearchOf` clearing detached rows, and the `Flag` delete it lacks (review finding *clear-routines-flag*) | `lib/`, `workers/`, `scripts/`, `tests/` |
| 62d | The `ERASED` contract, its record rule, its finder, the audit pack's `answers` | `lib/` |
| 62e | The door: `deleteConversation` (§ 3.3, § 3.4); `appendUserMessage`'s `NOT_FOUND`; the purge tolerating a deleted row; the raw lock in `RAW_SQL.md` | `lib/` |
| 62f | The sweep: the describe in `lib/workflows/client.ts`, the sibling in `lib/db/research.ts` with its owner statement, its call in `scripts/assistant-purge.ts` | `lib/`, `scripts/` |
| 62g | The policy: `delete` on a conversation for its owner, with the deny cases; `opa test`; the sidecar restarted | `policies/` |
| 62h | The endpoint at `CREATE_RATE`, and the ask endpoint's lookup before its replay; the record's append; OpenAPI regenerated; the contract tests | `lib/api/`, `app/api/` |
| 62i | The page: Delete conversation, its dialog, `?deleted=1`; Remove my name on the Improve list; the strings EN and PT; the browser flows. Then the one review of unit 62 | `components/`, `app/`, `messages/` |

**Unit 63 · drafts and withdrawals**

| Part | What | Folders |
|---|---|---|
| 63a | The draft's cleanup: `deleteDraft` returning its items; the cancels; the store's removal by prefix; the grader removing an object whose row is gone; an item removed from a draft losing its objects | `lib/`, `workers/` |
| 63b | Migration: `RETRACTED` on `LedgerKind`; `Suggestion.withdrawnAt` | `prisma/` |
| 63c | Contracts and the door: `RetractedPayloadSchema`, its record rule, the audit pack's `adjudications`; the `withdrawn` signal's schema and its `WORKFLOWS` entry; `requestWithdrawal` and its take-back; `writeCuratorAction`'s guard; `withdrawnAt` in the view, the select and `OWN_ROW` | `lib/` |
| 63d | The read side: the record's facts for `RETRACTED` and the outcome view's two variants (moved here from 63c, § 15), the timeline's `RETRACTED`, the outcome page's variants, the landing table's label, the strings | `lib/improve/`, `components/`, `messages/` |
| 63e | The workflow: the handler, the condition's term, the patched `recordWithdrawal` with its retry; deployed before 63f | `workers/` |
| 63f | The endpoint `POST /api/v1/suggestions/{id}/withdraw`; OpenAPI regenerated; the contract tests | `lib/api/`, `app/api/` |
| 63g | The controls: Delete draft on the edit rail with the `?deleted` notice; Withdraw on the outcome page. Then the one review of unit 63 | `components/`, `app/`, `messages/` |

**Order** (Andre, 2026-10-11, confirming the units): unit 63 first, then unit 62. Then unit 64, the gateway's message bodies switched off (D6), one config unit; and spec 46, the account's hard delete and the withdrawal of provenance consent (D8), written after unit 62.

## 12. The review of the design (2026-10-11)

Four reviewers checked the design against the code, each from one side. They raised 29 findings: nine of medium severity, twenty low, none high. Each is answered where the spec cites it, and the rest here.

- **The turn's tail.**
  - *final-stored-after-forget* and *handover-may-write-no-run*: § 3.4's stored-final test.
  - *lock-orders-only-the-question* and *purge-races-delete*: § 3.3's `FOR UPDATE`, and the writers that tolerate a deleted row.
  - *empty-conversation-has-no-foot* and *status-lost-on-remount*: § 3.9.
  - *metrics-statement-imprecise*: § 3.8.
- **Research rows.**
  - *detached-run-reads-null-message*, *null-messageid-reads* and *relaxed-columns-readers*: § 3.5's reads.
  - *sweep-misses-readers*, twice: the sweep's own owner statement.
  - *sweep-keys-on-row-not-workflow*: the engine's answer.
  - *inflight-run-record*: the counts first, and the limit stated.
  - *gate-measure-reads-run*: the measure skips and says how many.
  - *harness-and-seed-cannot-reach-detached* and *clear-routines-flag*: 62c.
  - *marks-stand-after-early-delete*: the marks stay, stated in § 3.1 and § 9.
- **Withdrawal.**
  - *stale-withdrawal-outlives-its-decision*: `decidedAt` in the signal, and `recordWithdrawal`'s checks.
  - *patched-guards-the-command-not-the-signal*: § 5.3.
  - *withdrawal-has-no-row-to-take-back*: the request written on the row and taken back.
  - *failed-withdrawal-step-unspecified*: the retry.
  - *draft-cleanup-leaves-objects*: the prefix and the grader's removal.
  - *read-side-variant-order* and *record-rules-entry*: § 5.4.
- **Readers and contracts.**
  - *erased-append-no-retry*: the limit stated in § 3.7.
  - *amend-list-incomplete*: § 7.
  - *erased-contract-sites*: § 3.7.
  - *metrics-not-all-lose*: § 3.8.

## 13. As built (unit 63a: the draft's cleanup, 2026-10-11)

§ 4 as written. What it took:

- **The store** gains `removeUnder(prefix)` (`lib/storage/local.ts`), exported as `removeObjectsUnder` (`lib/storage/index.ts`): every object whose key begins with the prefix's segments, sidecars and all, an object at the prefix itself included. A prefix is checked as a key is, so it is never the store's root and never outside it. Two prefixes join the key helpers of `lib/schemas/storage.ts`: `evidencePrefix(suggestionId)` and `evidenceItemPrefix(suggestionId, itemId)`. An upload's key names its item, so one item's objects are all under its own segment.
- **The door's `deleteDraft`** answers `{ deleted: true, items }` (each item's id and state, read in the same transaction as the delete) or `{ deleted: false }`.
- **The draft's delete** (`suggestionDelete`) cancels each pending item's grading, then removes everything under the draft's prefix. An upload PUT before the delete under a ticket that never became an item goes too; one that lands after it stays (§ 9). Both steps are best effort, because the draft is already gone: a failure is logged with the trace and the answer is still `200 { id, deleted: true }`. A grading whose item is gone ends at its next step. Cancelling one is `cancelEvidenceGrading`, now shared by the item's delete and the draft's.
- **The item's delete**, from a draft, removes everything under the item's prefix. From a suggestion under revision it removes nothing, since an earlier attempt's records name the item.
- **The grader's steps.** After `fetchItem` stores a source and `storeText` stores a text, each step checks its row's write. When the write found the row gone, the step removes what it just stored. A write refused because the item was graded meanwhile leaves the object to its row: removing it there would take the source another attempt's row names (§ 4's review finding, made precise).

Verified on this machine:

- type check, lint;
- the unit suites:
  - the store's `removeUnder`;
  - the draft's delete with its cleanup, and with a cleanup that fails;
  - the item's delete from a draft and from a revision;
- the database suites `tests/integration/evidence.test.ts`, `improve.test.ts` and `suggestions.test.ts`, 48 cases, with three new:
  - an item deleted while `fetchItem`, and then `storeText`, stored its object leaves no object;
  - the draft's delete through its route removes the item's source and an upload never added;
  - on the real engine, an item removed from a draft takes what it stored.
- The whole unit suite: 2237 passed. `tests/integration/assistant-rows.test.ts` fails without a database, as recorded (tracker, Known defects).

## 14. As built (unit 63b: the migration, 2026-10-11)

Migration `20261011120000_suggestion_withdrawn`, additive (invariant 30): `ALTER TYPE "LedgerKind" ADD VALUE 'RETRACTED'` and `ALTER TABLE "Suggestion" ADD COLUMN "withdrawnAt" TIMESTAMP(3)`.

- **How it was made.** It was written as the tracker's recipe says: the statements `prisma migrate diff` proposed, without the seven drift statements it always adds. After `migrate deploy` the diff shows the drift alone.
- **The kind's mirror.** `LEDGER_KINDS` changes in the same part, since the ledger's unit test holds it equal to the Prisma enum. The kind's payload, its rule and its finder are 63c's, and nothing writes one before 63e.
- **What it was checked against.**
  - The development database.
  - A database migrated from nothing: the merge suite makes one of its own and runs `migrate deploy` on it.
  - `tests/integration/improve-schema.test.ts`, whose list of the enum's values gains `RETRACTED` at the end.
- **After it.** The client was regenerated, and the development server and the workers restarted, since both hold the client they started with.

Verified: type check; the ledger's unit tests (103); the merge, improvement-schema and ledger suites on the database (40).

## 15. As built (unit 63c: the contracts and the door, 2026-10-11)

§ 5.2 to § 5.4 as written, but for the read side (see "Moved to 63d").

- **The rule.** `takesWithdrawal(state, outcome)` and `WITHDRAWABLE_STATES` (`lib/schemas/improve.ts`): a curator's queue, or wherever a revision is taken. The endpoint, the door, the activity, the record and the page read it.
- **The record.** `RetractedPayloadSchema` is `{ stepKey, rubricVersion, origin, from, outcome }`. It is strict, refuses an origin other than `HUMAN`, and refuses a `from`/`outcome` pair that takes no withdrawal. It has its member of the union and its rule, `RETRACTED: { actors: ["user"], about: "suggestion" }`.
  - The audit pack's `adjudications` selects `DECIDED` and `RETRACTED`. Its label is renamed "adjudications and withdrawals" in 63d (§ 16).
  - The ledger's fixtures gain a ninth record. The payload walk, the record rules and the chain test of `append`, the unit's and the database's, now run through nine kinds.
- **The signal.** `SUGGESTION_WITHDRAWN_SIGNAL = "withdrawn"` with `WithdrawnSignalSchema { userId, at, decidedAt }`, in the suggestion workflow's `WORKFLOWS` entry.
  - `decidedAt` is nullable: a suggestion in the queue may have no decision's time, and `writeCuratorAction` already counts no visit for one.
  - The registry's free-text walk takes the new schema with the rest.
- **The door** (`lib/db/improve.ts`) gains three functions and one guard:
  - `requestWithdrawal(caller, id, at)` writes `withdrawnAt` in one transaction. It refuses a suggestion that is not the caller's, one that is not a person's, one with a request already standing, one where no withdrawal is taken, and one with a curator's action of this visit. Its `UPDATE` is guarded on the state and the `decidedAt` it read. It answers the decision the request was made against, or where the suggestion is.
  - `takeBackWithdrawal(caller, id, at)` takes back only the request of that instant, the caller's own when a person calls it, and never a closed one: a recorded withdrawal keeps its `withdrawnAt`.
  - `withdrawalStands(service, id, { userId, at, decidedAt })` is what the run reads before it records. It returns nothing of the person.
  - `writeCuratorAction` gains `withdrawnAt: null`, so a curator decides nothing past a withdrawal that stands.
  - The check of "a curator's action of this visit" is one helper, `actionStands`, used by the curator's write and by both withdrawal reads.
- **The view.** `withdrawnAt` joins the service's and the person's selects (the door's own test holds every selected member to a column), `OWN_ROW`, and `SuggestionViewSchema`.
  - `openapi.json` was regenerated. It also takes in unit 60e's `verified` on the history's person, which that commit did not regenerate.

**Moved to 63d.** The record's facts for `RETRACTED` and the outcome view's two variants go with the components that render them, so that each part type-checks on its own. The record's presenter and the outcome page's maps are typed over every kind and every variant.

**Fixed here: a gap in 63b's verification.** 63b ran the targeted suites but not the whole unit suite, so `tests/improve-schema.test.ts` was not run. That test reads the enum's spelling from `prisma/schema.prisma`, and it now names `RETRACTED` at the end. Two more expectations moved with the new kind: the audit pack's EXPORT record of an adjudications pack names `RETRACTED` beside `DECIDED` (`workers/activities/export.test.ts`), and the endpoint test's fake draft carries `withdrawnAt`.

Verified:

- type check, lint;
- the whole unit suite: 2253 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded;
- the database suites `tests/integration/improve.test.ts`, `ledger.test.ts` and `suggestions.test.ts`: 49 cases. The new door case covers:
  - a request in each waiting state;
  - refused for an accepted, a merging or a submitted suggestion, another's, and a second;
  - a curator's action refused past a request;
  - `withdrawalStands` as written and off by instant, by decision and by person;
  - a curator's action first, which refuses the request;
  - the take-back's four cases, and a closed one kept.

## 16. As built (unit 63d: the read side, 2026-10-11)

§ 5.4's read side, with the record's facts and the outcome's variants that moved here from 63c.

- **The outcome's variants.** `variantOf` gains `withdrawing` (a waiting state with `withdrawnAt`) and `withdrawn` (`CLOSED` with `withdrawnAt`). The second is checked first in the `CLOSED` branch, so an intake decline withdrawn reads as withdrawn, not declined.
  - `refreshKeyOf` gains `withdrawnAt`, since a withdrawal asked for or taken back moves no state.
  - Both badges are `sb-mute` and both boxes neutral, under ui-context § 9.9's rule: neutral while under way and once closed.
- **The record's facts.** `RETRACTED` says where it was withdrawn from and under which decision; a payload that does not parse reads `UNREADABLE`. It has no marker, as it is neither an accept nor a decline. The timeline's body names where the suggestion waited, from the facts: declined at intake, asked for more, or in a curator's queue.
- **The pages.**
  - The outcome page follows a withdrawing suggestion until it is recorded, as it follows one in progress.
  - It no longer offers a revision while a withdrawal stands: the run handles the withdrawal before any revision (§ 5.3).
  - The Improve list's row says the withdrawal, and is no longer marked as waiting on its contributor.
  - The audit pack's checkbox reads "adjudications and withdrawals", since that choice now selects both kinds (63c).
- **Strings** (EN | PT), candidates beside § 6's for Andre:

| Key | EN | PT |
|---|---|---|
| `improve.outcome.decision.badge.withdrawing` | Withdrawing | Em retirada |
| `improve.outcome.decision.badge.withdrawn` | Withdrawn | Retirada |
| `improve.outcome.decision.line.withdrawing` | score {score} · withdrawal sent · being recorded | pontuação {score} · retirada enviada · sendo registrada |
| `improve.outcome.decision.line.withdrawn` | score {score} · withdrawn by its contributor | pontuação {score} · retirada por quem a enviou |
| `improve.outcome.decision.say.withdrawing` | The withdrawal is being recorded. This page follows it until the suggestion is closed. | A retirada está sendo registrada. Esta página a acompanha até que a sugestão seja encerrada. |
| `improve.outcome.decision.say.withdrawn` | Its contributor withdrew this suggestion. It goes no further; its record stays, with the withdrawal in it. | Quem a enviou retirou esta sugestão. Ela não segue adiante; o registro fica, com a retirada nele. |
| `improve.record.timeline.title.RETRACTED` | Withdrawn by its contributor | Retirada por quem a enviou |
| `improve.record.timeline.body.RETRACTED` | It was closed {after its decline at intake · while more evidence was asked for · in a curator's queue} and goes no further. | Ela foi encerrada {depois da recusa na entrada · enquanto se pedia mais evidência · na fila de um curador} e não segue adiante. |
| `improve.home.withdrawing` / `withdrawn` | withdrawal sent · being recorded / withdrawn | retirada enviada · sendo registrada / retirada |
| `account.audit.kind.adjudications` (changed) | adjudications and withdrawals | adjudicações e retiradas |

**Verified:**

- type check, lint;
- the unit suites of `lib/improve`: each waiting state withdrawing, closed by a withdrawal before a decline, none asked for as before, the refresh key moving with a withdrawal, and the `RETRACTED` facts, actor and marker;
- the message catalogue's parity;
- the token grep on the diff: nothing;
- `npm run build`.
- **On the development server**, as `queue-check-contributor@`:
  - The Improve list, the outcome and record pages of S-21-1759, and the account page, in EN and PT, read as before: no key unresolved, and axe found nothing. The audit choice reads "adjudications and withdrawals".
  - With `withdrawnAt` set on S-21-1759 for the check and cleared after (the row is `DECIDED` again with none), the list reads "withdrawal sent · being recorded" with no "waits on you". The outcome page reads `WITHDRAWING` / `EM RETIRADA`, with § 6's line and no Revise. axe again found nothing.
  - The `withdrawn` variant and the timeline's line wait for a recorded withdrawal (63g's run).

## 17. As built (unit 63e: the workflow, 2026-10-11)

§ 5.3 as written, with the two answers the map of unit 63 raised, both routine readings of § 5.3's intent (rules § 4.3).

- **The workflow.** `SuggestionWorkflow` registers `withdrawn` at its start beside `revised` and `curatorDecision`.
  - Its one condition gains `withdrawals.length > 0`: every wait is one of § 5.1's places.
  - A withdrawal is taken after a curator's action already queued and before a revision.
  - It is shifted off its queue before `patched("63e-withdrawal")` gates the one new command, `recordWithdrawal`. On a false answer, a run that waited before the patch drops it.
  - A failed step goes back to the front and is tried again on the curator's back-off, `RECORD_AGAIN`.
  - A recorded withdrawal ends the run at `CLOSED` with the decision that stood. It does not pass through `afterDecision`, so the throttle is not counted again and no merge starts.
- **The activity** (`recordWithdrawal`, as `service:intake`):
  - It looks for its `RETRACTED` record by the step key `stepKeyOf(workflowId, "retracted:<at>")` first. A step run again after it recorded only finishes the move, so it never judges the request twice.
  - Otherwise it asks the door whether the request stands (`withdrawalStands`). If it does not, the request of that instant is taken back and nothing is recorded.
  - If it does, the activity appends the record, signed with the contributor's pseudonym, then moves to `CLOSED`. The outcome and `decidedAt` stay.
- **Answer 1, a request left standing** (review of the map, Q1). Every other way out of a wait clears a request standing with it:
  - a curator's decision recorded first, whose move writes `withdrawnAt: null` (`recordCuratorDecision`);
  - a revision's return (`reopenSuggestion`).
  - Without this, a request and a curator's decline written in the same instant would leave the declined suggestion reading "withdrawn".
- **Answer 2, the 503 that races the record** (Q2). The withdrawal's own move writes the request's instant again (`TransitionPatch.withdrawnAt`), and the take-back acts only in a waiting state. A take-back between the record and the move therefore cannot leave a record the row denies. The 503 can understate (§ 9).
- **A seed** offered from a withdrawn suggestion is masked with `withdrawnAt: null`, as its other dates are, so a curator's seed never reads "withdrawing" (`lib/db/queuePage.ts`).
- **The replay test.** A run recorded on the code before the change replays on it.
  - The history (`tests/fixtures/workflows/suggestion-before-63e.json`) holds a decision by rule, a `withdrawn` signal the old code had no handler for, a curator's action recorded again after a minute, a revision and its attempt.
  - It is stored as the History message's protobuf encoding in base64: this install has four copies of protobufjs, and the SDK's JSON helpers fail on the wrong one ("type must be a Type").
  - With the `patched()` check removed, the replay fails with a `DeterminismViolationError`, so the test has teeth.
  - `tests/workflows/environmentOf.ts` gains `replay`.
- **The order on this machine:**
  1. Both running `SuggestionWorkflow` histories on the development engine (S-21-1254, S-21-1759) were replayed against the new bundle (`Worker.runReplayHistories`, read only): both replay.
  2. The workers were restarted.
  3. `npm run workflows:check` passed.
  - The endpoint (63f) comes after. Since 63c the signals' registry carries `withdrawn`, so only the order keeps an old worker from being told one.

**Verified:**

- type check, lint;
- the workflow suite on the test server, 26 cases, run twice:
  - a withdrawal in the queue, after a decline by rule (the throttle counted once), after a request for more by rule, and with a null `decidedAt`;
  - a malformed signal ignored;
  - the order: a curator's action, then the withdrawal, then a revision;
  - a failed step recorded again a minute later;
  - the replay.
- the database suites `tests/integration/suggestion-workflow.test.ts` and `improve.test.ts`. The withdrawal's cases are:
  - recorded once, with the record's step key and payload, and `CLOSED` with the outcome, `decidedAt` and the request's instant kept;
  - a request no longer standing: another person's, a decision since, a curator's action first, and another instant's left alone;
  - a curator's decision recorded first clears the request;
  - a take-back between record and move undone by the move;
  - a curator's decline written beside a request;
  - a request made stale by a merge's return.

One test case changed in passing: the workflow suite's ordering case first ended its run while attempt 2 still had an activity in flight, and the test server's clock then would not move for the next case's timer. It now ends the run only once attempt 2 waits.

## 18. As built (unit 63f: the endpoint, 2026-10-11)

§ 5.2 as written: `POST /api/v1/suggestions/{id}/withdraw` (`suggestionWithdraw`), its route, its registration and `openapi.json`. It is the owner's (role `CONTRIBUTOR`, policy `write`), takes an `Idempotency-Key`, and runs at `SUGGESTION_RATE`.

1. **The row read.** 404 for none of the caller's. 409, with `{ state, outcome }`, for a suggestion that is not a person's, has no workflow, or is where no withdrawal is taken (`takesWithdrawal`). A null `decidedAt` is not refused: the signal carries it.
2. **The request** (`requestWithdrawal`). The door's answer is the endpoint's: a curator's action of this visit gives a 409 with the state. The caller's own request already standing is sent again, with its instant (§ 20).
3. **The signal**, with the decision the door's `UPDATE` was guarded on. On a failed signal the request is taken back, and the engine's answer is the answer: 409 for a run that has ended, 503 for an engine that does not answer.
   - Where the take-back finds nothing to take back, the run already took the signal and closed the suggestion. The endpoint then goes on to wait for the record rather than claim nothing changed.
   - A take-back that itself fails is logged with the trace (§ 9).
4. **The `retracted` record** under `stepKeyOf(workflowId, "retracted:<at>")`, the key the activity writes it with. It is polled with the curator's decision's wait (`RECORD_WAIT_MS`, `RECORD_POLL_MS`, now exported from `curation.ts`). Found, the row is read again and its state answered, never assumed; not found, 202 with `ledgerSeq: null`. A failed read here answers the same 202 (§ 20).
   - The pipeline stores a 202's body as null, so a replay of its key answers 202 with no body. The page reads the status.

**Policy.** No Rego changes. A new policy test holds that nobody writes a researcher's proposal (`test_nobody_writes_a_researchers_proposal`): it has no owner, so nobody withdraws it.

**Run on this machine,** with the workers on 63e, as `queue-check-contributor@`:

- S-21-2241 was drafted with a link the fetcher's guard refuses, graded U and declined at intake by rule. No model was called.
- Its withdrawal answered `200 { state: CLOSED, ledgerSeq: 24473 }`.
- The row kept its `DECLINE` and holds `withdrawnAt` and `closedAt`. Its record reads `SUBMITTED, GRADED, SENSORS, DECIDED, RETRACTED`, the last with `{ from: INTAKE_DECLINED, outcome: DECLINE, origin: HUMAN }`.
- A new key answered 409 with `{ state: CLOSED, outcome: DECLINE }`, and the first key replayed its 200.
- S-21-2241 stays in the development database as that check left it.

**Verified:**

- type check, lint;
- the endpoint's unit cases, among 77 in the three endpoint suites:
  - declared as § 5.2 says;
  - 200 in each waiting state, the request before the signal, the signal's members and the step key;
  - 202, and a null `decidedAt`;
  - 409 for five states, a researcher's proposal and the door's refusal;
  - the take-back's 409 and 503, and the record awaited where nothing was taken back;
  - 404, 403 and 400;
- `opa test`: 75 of 75;
- the whole unit suite: 2266 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded;
- the contract, suggestions and policy suites on the database: 33;
- `npm run build`;
- the run above.

## 19. As built (unit 63g: the controls, 2026-10-11)

§ 4's and § 5.4's controls, composed from what the product has: the shared `ConfirmDialog`, `Button`, `ErrorBox` and `Notice`. No new class.

- **Delete draft** (`components/improve/DeleteDraft.tsx`): a quiet small button on the edit page's rail under Submit, never on a revision. The dialog's body says what goes.
  - Confirmed: `DELETE /api/v1/suggestions/{id}`. On 200 or 404, every field's autosave stops and the page is *replaced* by `/[lang]/improve?deleted=<id>`, so Back never returns to a draft that is gone.
  - Anything else keeps the dialog open with an `ErrorBox` that gives the server's words and the trace.
  - The rail is a desktop's (34 § 16), so a phone has no Delete draft, as it has no form.
- **The autosave's stop.** `requestDraftStop()` (`lib/hooks/draftView.ts`, the event `hb:draft-stop`) halts every field's machine (`DraftAutosave.halt`). Nothing is sent at the pause, on a blur or on leaving. A request still out says nothing when it answers.
- **The Done notice.** The Improve page reads `deleted` from its query, kept only when it is a suggestion's id, and shows `Notice` "Done · Draft {id} deleted." under its head, as the marks page does.
- **Withdraw** (`components/improve/OutcomeWithdraw.tsx`): in the outcome page's actions row, for the owner of a person's suggestion with no withdrawal asked for, where `takesWithdrawal`.
  - The dialog's body says what stays. The post carries an Idempotency-Key, kept across retries of one press that went unanswered.
  - *As amended by the review of unit 63 (§ 20):* 200, 202 and 409 redraw the page, whose Decision says the answer, live: withdrawn, being recorded (never done), or where the suggestion now stands. Focus goes to the Decision's heading.
  - A 409 that leaves the suggestion where it waits says "It can no longer be withdrawn here; the page now shows where it stands." and no longer offers Withdraw.
  - Anything else keeps the dialog open with what failed and the trace.
- **Strings** (EN | PT), candidates beside § 6's:

| Key | EN | PT |
|---|---|---|
| `improve.suggest.deleteDraft.cancel` / `confirm` | Cancel / Delete | Cancelar / Apagar |
| `improve.suggest.deleteDraft.failed` | The draft was not deleted | O rascunho não foi apagado |
| `improve.suggest.deleteDraft.network` | The request did not reach the server. Nothing was deleted; try again. | A solicitação não chegou ao servidor. Nada foi apagado; tente novamente. |
| `improve.home.notice.title` / `deleted` | Done / Draft {id} deleted. | Feito / Rascunho {id} apagado. |
| `improve.outcome.withdraw.cancel` / `confirm` | Cancel / Withdraw | Cancelar / Retirar |
| `improve.outcome.withdraw.moved` | It can no longer be withdrawn here; the page now shows where it stands. | Ela não pode mais ser retirada aqui; a página agora mostra onde ela está. |
| `improve.outcome.withdraw.failed` | The suggestion was not withdrawn | A sugestão não foi retirada |
| `improve.outcome.withdraw.network` | The request did not reach the server. Nothing was withdrawn; try again. | A solicitação não chegou ao servidor. Nada foi retirado; tente novamente. |

The triggers, titles and bodies are § 6's.

**Verified:**

- type check, lint;
- the autosave's unit cases, the halt's included, and the catalogue's parity;
- the whole unit suite;
- `npm run build`;
- **the browser suite** `tests/e2e/suggest.spec.ts`, "Delete draft" in EN and PT under an account of its own (`e2e-suggest-delete@`):
  - the dialog opened, its body, axe on it;
  - cancelled, with focus back on the trigger and the draft still there;
  - confirmed: the Improve page with its notice, the draft's read a 404, axe on the notice;
- **the PT truncation suite**, all screens, with two new ones that measure clean: the dialog at 1440 px, and the notice at 1440 and 390 px;
- **Withdraw, by hand on the development server**, as `withdraw-check@` (a new contributor, since a withdrawn decline still counts for the throttle):
  - S-21-2261 (EN) and S-21-2262 (PT), each declined at intake by rule with no model call, were withdrawn through the page.
  - The dialog had its body, with focus on Cancel. After the confirm the page read `WITHDRAWN` / `RETIRADA` with the line "withdrawn by its contributor" and no Withdraw. The record's timeline titled the entry "Withdrawn by its contributor", and the Improve list read "withdrawn" / "retirada". axe found nothing on each page.
  - Withdraw was absent on S-21-1561 (merging) and on S-21-2241 (withdrawn by 63f's run).
  - The three suggestions stay withdrawn in the development database.

**Screen match:** none to make. No screen of the UI package shows a delete or a withdrawal (the spec's preamble).

## 20. The review (unit 63, 2026-10-11)

One review of the whole unit, by three lenses: the withdrawal, the draft and the surface. It found eight things, one medium and seven low. A skeptic checked the medium one, confirmed it, and proposed the smaller fix taken here. All eight are fixed in one commit, or written down as limits.

- **Withdraw's own redraw removed its lines and dropped focus** (medium, *withdraw-control-unmounted-by-own-refresh*). The control's refresh redraws the page with the request on the row, which removes the control, its 202 line and its 409 line; focus then fell to the page's body.
  - Now the redrawn Decision says the answer, live: withdrawn, being recorded, or accepted and merging. After any answer that closes the dialog, focus goes to the Decision's heading (`tabIndex={-1}`), which every redraw keeps.
  - A 409 that leaves the suggestion where it waits says why in a status region mounted empty, and no longer offers Withdraw.
  - The control's two lines left the catalogue (`improve.outcome.withdraw.recording`, `.refused`); § 6, § 5.4 and § 19 say so.
- **Cancel and Esc closed a dialog whose request was out** (*confirm-cancel-live-while-request-in-flight*). `ConfirmDialog` takes `cancelDisabled`: Cancel is disabled and `esc` waits while it is set, read through a ref so the focus effect does not run again. Delete draft and Withdraw set it while their request is out.
- **The queue offered a decision on a suggestion being withdrawn** (*queue-offers-decision-on-withdrawing-suggestion*). `curatorQueue`, `curatorQueueCount` and `queueCountByPart` now hold `withdrawnAt: null`, as `writeCuratorAction` does. The queue's detail offers no decision while a withdrawal stands; its badge says Withdrawing.
- **A 5xx after a delivered signal** (*withdraw-5xx-after-delivered-signal*). A failure while waiting for the record, or reading the row again, answered 500 though the run would close the suggestion. Once the signal is delivered, the endpoint answers 202 whatever the wait meets, and logs the failure with the trace.
- **A request stranded before its signal** (*request-stranded-before-signal*). A server stopped between the request's commit and the signal left the request with no run told of it, and nothing repaired it.
  - Now the door answers the caller's own request already standing as it stands, with its instant. The endpoint sends that request again and awaits its record under that instant's key; a re-send that fails takes the request back by that instant.
  - The owner's page offers Withdraw again once the request has stood unrecorded for two minutes (`WITHDRAWAL_RESEND_MS`), on the page's next read. A run that already holds it records it once, by its step key.
  - The door checks a curator's action before the request standing, so a request beside a curator's action is still refused: the action is recorded first and clears it.
- **§ 5.2 promised "503, nothing changed"** (*spec-5-2-503-guarantee-stale*), which § 9 and § 17 contradict. Step 3 now points to them.
- **An item's delete skipped its objects when the cancel failed** (*item-delete-cancel-throw-skips-removal*). With the engine down, the cancel's 503 came before the removal. The item's objects are now removed before the cancel.
- **An upload's PUT after its draft's delete** (*upload-put-after-draft-delete*): written down as a limit (§ 9), and § 13's claim made precise. The storage route stands for a bucket's pre-signed URL and reads no row.

**Verified:**

- type check, lint;
- the endpoint and outcome-view unit suites, 82 cases, with four new:
  - a failed read of the record after the signal answers 202, with nothing taken back;
  - a request already standing sent again with its instant, its record awaited under that key, and a failed re-send taking it back by that instant;
  - an item's objects removed when the cancel answers 503;
  - `resendsWithdrawal` at two minutes, before and after;
- the whole unit suite: 2271 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded;
- the database suites `improve`, `evidence`, `suggestions`, `storage` and `roster`, 58 cases. The withdrawal case now asserts the request answered as it stands, and the queue's list, count and count by part each losing the suggestion once its withdrawal stands;
- `npm run build`;
- **by hand on the development server**, as `withdraw-review@` (a new contributor):
  - S-21-2283 (EN), declined at intake by rule with no model call:
    - with a 409 faked at the network, the page kept it declined, offered no Withdraw, said "It can no longer be withdrawn here; the page now shows where it stands.", and focus was on the Decision's heading;
    - with the real withdrawal held 1.5 s at the network, Cancel was disabled and `esc` left the dialog open;
    - after that, the page read `WITHDRAWN` with no Withdraw and focus on the Decision's heading;
    - axe found nothing at each step.
  - S-21-2282 (PT): a request written through the door three minutes back, with no signal, read `EM RETIRADA` with Withdraw offered. Withdraw sent it again. The run recorded it under the request's own instant, and the page read `RETIRADA`, "retirada por quem a enviou". axe found nothing.
  - S-21-2281 (EN) went the same way as S-21-2283 in a first run, whose printed results were cut off.
  - The three stay withdrawn in the development database, and `withdraw-review@` now has three declines, the throttle's count.

## 21. As built (units 62b and 62c: the migration, and the research reads of a detached run, 2026-10-11)

Built together and committed as one: the nullable keys reach every read 62c changes, so 62b alone does not type-check.

**62b, the migration** `20261011150000_conversation_erased`, relaxing only (invariant 30):

- `ALTER TYPE "LedgerKind" ADD VALUE 'ERASED'`;
- `ResearchRun.messageId` and `ResearchFinding.runId` drop `NOT NULL`. Both keys keep `ON DELETE CASCADE`, so a message deleted with its run still attached takes the run, as the gates' and the suites' cleanups expect.
- It was written as the tracker's recipe says, without the seven drift statements; after `migrate deploy` the diff shows the drift alone.
- **The kind's mirror** changes with it: `LEDGER_KINDS`, both schema suites' lists of the enum (`tests/improve-schema.test.ts`, `tests/integration/improve-schema.test.ts`), and `openapi.json`, regenerated (the record export's kind enum). The kind's payload, rule and finder are 62d's; nothing writes one before 62h.
- The client was regenerated, and the development server and the workers restarted on it. No real research run was mid-call, and no workflow code changed, so nothing was replayed. `npm run workflows:check` passed after the restart.

**62c, the reads of a detached run**, § 3.5's table made true before anything detaches a run:

- `ResearchRunRow.messageId` is `string | null`. `readResearchTurn` answers null and `readResearchCitations` `[]` for a run with no message, before any query.
- `loadResearch` tests `textPurgedAt` before it reads the turn, so a detached `QUEUED` run ends `SKIPPED` · `TEXT_PURGED` with no read and no paid call.
- `recordResearch` no longer falls back to `research:<messageId>`: a run with no workflow gets no record.
- **The reader's counts first.** The read step writes its searches and page reads with the unguarded `writeResearchCounts` before its findings; `writeResearchFound` no longer takes counts. A run purged or detached while the reader ran keeps what the provider charged.
- **The asker's proposals** are ordered by the proposal's own time, the suggestion's `submittedAt`, newest first, since a finding the sweep keeps has no run to order by. The research view of a conversation keys its map by message and skips a row without one, which its query by message never returns.
- **The research gate's measure** "from the answer to a proposal shown" skips a finding with no run and says how many it skipped (`toShownSkipped`).
- **The harness's clear** (`clearResearchOf`): cleared for everything of an asker, it takes the runs a delete detached and the findings the sweep kept, and the suggestions they made. It now deletes the conversation's flags before its messages, a key it lacked.

**Verified:**

- type check, lint;
- the whole unit suite: 2272 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded. The new and changed cases:
  - `loadResearch` reads no turn for a run whose text is purged or that is detached, and moves nothing;
  - the record step writes nothing for a run with no workflow;
  - the reader's counts are written first, a purged run's included;
  - the gate's measure says how many it skipped;
- the database suites `improve-schema`, `ledger`, `research-rows` (whole, its purge case scoped to its own reader), `research-run`, and `merge`, which migrates a database of its own from nothing: 48 cases. `research-rows` now also holds that a run with no message reads no turn and no citation.

## 22. As built (unit 62d: the `ERASED` contract, 2026-10-11)

§ 3.7 as written:

- **The payload.** `ErasedPayloadSchema`, strict: `{ stepKey, scope: { kind: "conversation", id } }`, the id a UUID. It joins the payload union, and the payload walk of `lib/schemas/ledger.test.ts`, which holds every payload free of text.
- **The rule.** `RECORD_RULES` gains `ERASED: { actors: ["user"], about: "nothing" }`: a person signs it, and it names no suggestion and no chapter version.
- **The step key and the finder** (`lib/db/ledger.ts`): `erasedStepKeyOf(conversationId)` is `stepKeyOf("conversation:<id>", "erased")`, and `erasedRecordAt(stepKey)` finds the record by its kind and step key alone, beside `researchRecordAt`.
- **The audit pack.** `answers` selects `["ANSWER", "ERASED"]`. An account's pack holds the records its pseudonyms wrote, so a reader's deletions come with their answers.
- **The label** of that checkbox says so. A candidate beside § 6's:

| Key | EN | PT |
|---|---|---|
| `account.audit.kind.answers` (changed) | assistant answers and deletions | respostas do assistente e exclusões |

Nothing writes an `ERASED` record before 62h. `openapi.json` does not change: no response schema carries a ledger payload.

**Verified:**

- type check, lint;
- the ledger, schema and export unit suites, 206 cases: the payload refuses another scope, an id that is not one, and any member beyond the two; the rule refuses a service as the actor, and a record that names a suggestion or a chapter version;
- the ledger's database suite, 12 cases. A new case appends an `ERASED` record about a conversation nobody has, which stays in the development ledger as this suite's others do. `erasedRecordAt` finds it by its step key, and neither another conversation's key nor `researchRecordAt` does. A record naming a suggestion, or carrying a title, is refused and the head does not move.

## 23. As built (unit 62e: the door, 2026-10-11)

§ 3.3 and § 3.4 as written, in `lib/db/assistant.ts`:

- **`deleteConversation(user, id, now)`** runs one interactive transaction inside the reader's tenant context and answers `{ deleted: true, messages, detached, forgotten }` or `{ deleted: false, reason }`, the reason `NOT_FOUND` or `TURN_IN_PROGRESS`.
  1. The conversation's row is locked with the raw `SELECT … FOR UPDATE`, which names the reader's id itself, since a raw statement passes no guard. It is registered in `lib/db/RAW_SQL.md`.
  2. The settle rule is read under the lock. A last row younger than `ANSWER_DEADLINE_MS` holds the delete when it is a question, or an answer or refusal whose `final` is not stored. A failed turn has no guide version and settles at once; anything older than the deadline is settled.
  3. The research runs of its messages that have a workflow get `textPurgedAt` where it was null, then lose `brief` and `found` and are detached (`messageId` null). Their state is not touched. A run without a workflow goes with its message by the key's cascade.
  4. The stored finals are forgotten: the reader's keys on `ASK_PATH`, now exported beside the door for the endpoint to share, whose `response.messageId` is one of the conversation's messages.
  5. Its rows are deleted children first: flags, citations, verdicts, messages, the conversation.
- **A question racing the delete** gets `NOT_FOUND`. `appendUserMessage`'s insert waits on the lock and fails on the key, and the key's code (`P2003`, `isForeignKeyViolation` in `lib/errors.ts`) is answered as the conversation's read would be. If the question lands first, the delete is held instead (`TURN_IN_PROGRESS`).
- **The purge skips a row deleted under it.** A stored mode result is written by `updateMany`. An abandoned turn is closed through `closeAbandonedTurn`, which answers false where its conversation is gone. A failed turn's own write of the conversation's time is an `updateMany` too. No reader's delete stops the night's run for the readers after it.
- `purgeAssistantText`'s comment, architecture § 4.1 and § 4.4, and spec 15 § 8 now say the delete takes the rows. Spec 15 § 10's "a later decision" is the endpoint's, 62h.

**Verified:**

- type check, lint;
- the whole unit suite: 2273 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded;
- a new database suite, `tests/integration/conversation-delete.test.ts`, 5 cases, run three times:
  - **refused, nothing changed:** an open question, another reader's id, an id nobody has; an answer moments old whose final is not stored, then deleted once it is, its key forgotten;
  - **deleted:** a settled conversation with a flag, a failed turn and an abandoned question, every row gone and its final's key forgotten; a second delete is `NOT_FOUND`; another reader's rows and key untouched;
  - **research:** a run with a workflow detached, in its state, without its text, stamped; a run without one gone; the marks and `runsStartedSince` unchanged;
  - **the race:** a question and the delete at once, either the question refused `NOT_FOUND` or the delete held; a question after the delete is `NOT_FOUND`;
  - **the purge:** `closeAbandonedTurn` skips a conversation that is gone and closes one that is not;
- **on the time-skipping server**, a new case of `tests/integration/research-run.test.ts`: a turn handed over, its conversation deleted while its run is `QUEUED`, then the real research workflow and activities. The run ends `SKIPPED` · `TEXT_PURGED`, with no model call and no budget row. Its row stays, detached, and no `RESEARCH` record is written;
- the database suites `research-run`, `research-rows`, `assistant-rows`, `assistant-stats` and `assistant-stream`, with the purge filter: 51 cases.

## 24. As built (unit 62f: the sweep, 2026-10-11)

§ 3.5's sweep as written:

- **The engine's answer.** `lib/workflows/client.ts` gains a fifth call, `describe`, behind `workflowRunning(name, id)`. It answers whether the latest run under the id is `RUNNING`. A run closed in any way does not run, and neither does an id the engine no longer knows: that is `false`, not an error. An engine that cannot be reached is `WorkflowsUnavailableError`, as for every call.
- **The sweep.** `sweepDetachedRuns({ now, running, reader? })` sits in `lib/db/research.ts` beside the purge's half for research.
  - Its readers come from its own raw statement, registered in `RAW_SQL.md`: the readers with a detached run that started before the cutoff. A reader who deleted their last conversation is reached.
  - For each reader, inside their context, it takes their detached runs past `DETACHED_RUN_KEPT_MS`, 24 hours, oldest first. A run with no workflow is not running; any other is asked of `running`.
  - A run whose workflow does not run first has its `PROPOSED` findings that name a suggestion detached, and is then deleted; its other findings go by the cascade.
  - `running` answering `null` means the engine could not be reached. The sweep stops there and says so (`engineAnswered: false`), with what it did before.
- **The nightly run.** `npm run assistant:purge` calls it after the purge, its `running` the research workflow's `workflowRunning` with an unreachable engine as `null`. It prints a second line, swept or skipped, adds four counts to its job line, and closes the engine's connection at the end.

The script was not run against the development database: it applies the 30-day retention to every reader there. The sweep is verified scoped to a reader of the suite's own, as the purge's `reader` option lets the gate do.

**Verified:**

- type check, lint;
- the client's unit suite, 19 cases, two new: `workflowRunning` asks the engine, takes a run the engine no longer knows as not running, refuses an id of the wrong form unasked, and is unavailable, never `false`, when the engine cannot be reached;
- **on the compose engine** (`tests/integration/workflows.test.ts`): the proving workflow is running while it waits, not running once it has ended, and an id nobody started is not running;
- a new case of `tests/integration/conversation-delete.test.ts`, for a reader whose last conversation was deleted with three runs detached:
  - with the engine away, nothing goes;
  - then the run a day old whose workflow has ended is deleted, its `PROPOSED` finding kept detached and still the asker's (`askerOfProposal`), its other finding gone;
  - the run a day old whose workflow runs is kept, and the young run is kept without the engine being asked;
  - `runsStartedSince` is unchanged.

## 25. As built (unit 62g: the policy, 2026-10-11)

§ 3.2's rule as written: `policies/hb/assistant.rego` allows `delete` on a `conversation` to a user who owns it, in a rule of its own beside read, ask and list. No other rule names a conversation for `delete`: `reader.rego`'s and `roles.rego`'s are for marks and lab sessions. The service identities stay denied by `agent_denied`.

**Verified:**

- `opa test`: 78 of 78, three new cases:
  - the owner deletes their conversation;
  - another reader, an anonymous caller, an organisation's administrator and a service identity do not;
  - and nobody deletes a single message, which no endpoint offers (§ 10);
- `opa fmt` finds nothing to change;
- the development sidecar was restarted on the new bundle and answered the owner's delete `true` and another reader's `false`.

## 26. As built (unit 62h: the endpoint, 2026-10-11)

§ 3.2 and § 3.7's append as written:

- **`DELETE /api/v1/assistant/conversations/{id}`** (`conversationDelete`, made by `conversationDeleteEndpoint(deps)` so its seams can be doubled). It is the route's `DELETE` beside its `GET`, and the 53rd operation of `ALL_ENDPOINTS` and `openapi.json`.
  - A session, the same-origin check, the policy's `delete`, `CREATE_RATE`. No body and no Idempotency-Key.
  - The door's answer is the endpoint's: 404 `NOT_FOUND`, 409 `TURN_IN_PROGRESS`, or `200 { id, deleted: true, ledgerSeq }` (`ConversationDeletedSchema`).
- **The `ERASED` record.** After the door's commit, the endpoint looks for the record under `erasedStepKeyOf(id)` and appends one only where none is there. The actor is `user:<id>`, about nothing, the payload `{ stepKey, scope: { kind: "conversation", id } }`. An append that fails leaves the deletion standing: `ledgerSeq` null, and a line with the trace.
- **The ask** looks its conversation up before it replays a stored final, so a final stored as the conversation went is answered 404. Its path is the door's `ASK_PATH`, the one the delete forgets finals under, so the two cannot drift.

**Verified:**

- type check, lint;
- a new unit suite, `lib/api/endpoints/assistant.test.ts`, 6 cases:
  - declared as § 3.2 says;
  - the door, then one record with its payload, and its place in the chain;
  - a record already under the key answered, with no second;
  - a failed append answering `ledgerSeq` null with the trace;
  - 404 and 409 appending nothing;
  - 401 and 403 asking the door nothing;
- the contract suite on the database and the sidecar, 15 cases, one new:
  - held at 409 `TURN_IN_PROGRESS` with a question a moment old, the rate's header 30;
  - another reader's delete 404, none signed out 401, and the conversation still there;
  - the owner's 200, its `ledgerSeq` the `ERASED` record's, by the owner, about the conversation;
  - after it, the read and a second delete each 404;
- the stream suite with the purge filter, 19 cases. Its replay case now deletes the conversation, stores the final under its key again as a final landing after the forget would, and gets 404 for the replay;
- `openapi.json` regenerated: the new operation.

## 27. As built (unit 62i: the page, 2026-10-11)

§ 3.6's and § 3.9's controls, composed from what the product has: the shared `ConfirmDialog`, `Button`, `ErrorBox` and the column's own rows. One class is new, `.conversations-done`, for the line's padding.

- **Delete conversation** (`components/assistant/DeleteConversation.tsx`) sits in the open conversation's block of the assistant page's column, beside `export JSONL`, in its foot.
  - The block now opens whether or not the conversation has turns, so a conversation with none can be deleted too.
  - The button is a quiet small one, outside the row's link. While an answer streams it is disabled, its help line "available when the answer has finished" its description.
  - **The dialog** is the shared confirm.
    - Its title names the cited chapters, as the row's label does, or "Delete this conversation?" for none.
    - Its body says what goes and what stays, with § 6's proposal sentence when an answer of it led to one.
    - `Export JSONL first` is its child where there is an answer to export. Cancel and `esc` wait while the request is out.
  - **On 200 or 404** the page is replaced by itself without `ask` and with `?deleted=1`.
  - **On 409** the dialog says the last answer is still being saved. Anything else gives the server's words and the trace.
- **After a delete** the page passes `deleted` to the dock.
  - The column's head shows "Done · Conversation deleted." in a `role=status` line.
  - `New conversation` takes focus with that line as its description. The composer, which takes focus on an empty dock, stands back after a delete.
  - The dock opens the conversations overlay. Between 1000 and 1359 px that shows the line; at other widths it changes nothing.
- **Remove my name on the Improve list** (`components/improve/ProposalName.tsx`) goes in the name cell, beside "with your name", while the proposal waits for a curator or is being merged.
  - It calls the panel's endpoint, `DELETE /api/v1/proposals/{id}/endorse`, with the panel's strings.
  - Removed, or gone already, the cell reads "—" and focus goes to the proposal's record link.
  - A 409 keeps the name and says "this proposal no longer takes names": the panel's shorter line, since the cell already says "with your name". Failures say so in a status region mounted empty.
- **Strings** (EN | PT), candidates, § 6's for the delete and its amended three:

| Key | EN | PT |
|---|---|---|
| `assistant.delete.trigger` | Delete conversation | Apagar conversa |
| `assistant.delete.streaming` | available when the answer has finished | disponível quando a resposta terminar |
| `assistant.delete.title` / `titleNone` | Delete the conversation on {chapters}? / Delete this conversation? | Apagar a conversa sobre {chapters}? / Apagar esta conversa? |
| `assistant.delete.body` / `bodyProposal` | § 6's | § 6's |
| `assistant.delete.export` | Export JSONL first | Exportar o JSONL antes |
| `assistant.delete.cancel` / `confirm` | Cancel / Delete | Cancelar / Apagar |
| `assistant.delete.done` | Done · Conversation deleted. | Feito · Conversa apagada. |
| `assistant.delete.failed` | The conversation was not deleted | A conversa não foi apagada |
| `assistant.delete.settling` | The last answer is still being saved · try again in a moment | A última resposta ainda está sendo salva · tente de novo em instantes |
| `assistant.delete.network` | The request did not reach the server. Nothing was deleted; try again. | A solicitação não chegou ao servidor. Nada foi apagado; tente novamente. |
| `account.retention.conversationsValue` (changed) | text 30 days, or until you delete it | texto por 30 dias, ou até você apagar |
| `auth.panel.retention` (changed) | … then metadata, until you delete them; … | … depois só metadados, até você apagá-las; … |
| `assistant.flag.body` (changed) | … No text is sent. It leaves the set if you delete the conversation. | … Nenhum texto é enviado. Ela sai do conjunto se você apagar a conversa. |

- Spec 17 § 7 and § 10, spec 26 § 10, spec 43 § 6 and architecture § 3.2's two page rows now say what the page offers.

**Verified:**

- type check, lint;
- the whole unit suite, the catalogue's parity included;
- **the browser suite** `tests/e2e/assistant-delete.spec.ts`, 3 cases, under an account of its own (`e2e-assistant-delete@`). Each uses a conversation with no turn, made through the API, since a turn would ask a model:
  - in EN and PT: the dialog opened, its body, axe on it;
  - cancelled: focus back on the trigger, and the conversation still there;
  - confirmed: `?deleted=1`, the line, `New conversation` focused with the line as its description, the conversation's read a 404, axe on the page;
  - at 1200 px: the overlay open with the line and the focus, axe, and its backdrop closing it;
- **the PT truncation suite**, all screens, with two new ones that measure clean at 1440 and 390 px:
  - the dialog over the research seed's conversation, its longest title and body: a cited chapter and a proposal;
  - the column's line after a delete;
- **Remove my name, by hand on the development server**, as the demo reader, on the research seed's proposal S-03-0002, a name put on it through the door for the check and taken off after:
  - the cell offered the button, and axe found nothing;
  - with the removal answered 200 at the network, the cell read "—" and focus was on the record link;
  - with the real endpoint, which answers 409 because the seed's workflow runs on no engine here, the name stayed and the line said the proposal no longer takes names;
- **the database suites**:
  - `research-run`: the first case now deletes its conversation at its end, and the proposal is still listed under Improve and still the asker's;
  - `conversation-delete`: the sweep's case now puts the asker's name on the proposal before the delete, and takes it back after the sweep.

## 28. The review (unit 62, 2026-10-11)

One review of the whole unit, by three read-only lenses: the data side, the endpoint with its policy and record, and the surface. They found eleven things: four medium and seven low. A skeptic checked each medium one, confirmed all four, and twice proposed a smaller or better fix, which is the one taken. All eleven are fixed in one commit.

- **The settle rule read only the last row** (medium, *settle-rule-checks-only-last-row*).
  - A reader may ask again as soon as an answer's row exists, before its final is stored. A second tab could then make a later turn settle while an earlier answer's tail, its research hand-over and its stored final, still ran.
  - The delete then missed that final's key, the final landed after it, and the answer's words outlived the delete in `IdempotencyKey`.
  - Now `settled` reads every row younger than the deadline: the last must not be a young question, and every young answer or refusal must have its final stored. That is two queries.
- **Back brought a deleted conversation back** (medium, *back-restores-deleted-conversation*). The delete only navigated, and Next restores Back and Forward from its client cache.
  - The control now refreshes the router after it navigates, as code-standards asks of every island that writes through `fetch`. Back then asks the server, which no longer has the conversation.
  - The Improve list's `Remove my name` refreshes too.
- **A conversation the page made itself survived its delete in the dock's session** (medium, *session-created-conversation-survives-delete*). A first ask refused before its question was written leaves a conversation the server never rendered; § 3.9 names that case. Its delete changed nothing the dock's session keys on: the conversation stayed listed, the dialog stayed open, and the next question went to the deleted id.
  - The page now lands on `?deleted=<id>`, and the dock is keyed on it, so each delete mounts the dock and the column afresh, a second one in the same visit included.
  - `New conversation` leaves the parameter, so it mounts the dock again too, which also closes the overlay a delete opened (*new-conversation-keeps-forced-overlay*, low).
- **Focus was lost after a failed request, and the trap let it out** (medium, *focus-lost-after-409-trap-broken*). The confirm, disabled while its request is out, lost focus to the page, and a 409 left it there. The dialog's Tab only wrapped from its own first and last controls.
  - `ConfirmDialog` now treats focus outside the dialog as on its edge, by Tab's direction.
  - When a request ends with the dialog still open, focus goes back to the confirm. This fixes Delete draft and Withdraw too.
- **A flag racing the delete** (low, two lenses, *flag-insert-not-blocked-by-conversation-lock*).
  - A flag's key check waits on its message, not on the conversation. A flag written between the delete's statements could therefore fail the delete with 500, or fail itself with 500.
  - The delete now locks its messages `FOR UPDATE` as it reads them, registered in `RAW_SQL.md`. `recordFlag` answers a key failure as `NOT_FOUND`.
- **The delete shared the read's rate bucket** (low, *delete-shares-read-rate-bucket*). The pipeline keys a bucket by path, and the GET and the DELETE of `/conversations/{id}` take different rates, so each clamped the other.
  - A spec's rate may now name its bucket (`rateLimit.bucket`), and the delete's is `DELETE /api/v1/assistant/conversations/{id}`.
- **The dialog said research stops** (low, *body-says-research-stops*). A run that has sent its finding to Improve goes on until the finding is decided, and may yet become a proposal.
  - The body now says research stops "unless it has already sent a finding to Improve".
  - The proposal sentence now reads "a proposal that comes from it" and shows for such a run too.
  - § 6's two rows change with them; both stay candidates.
- **`Remove my name` dropped focus on a 409** (low, *proposal-name-409-drops-focus*). Focus now goes to the proposal's record, as on a removal.
- **The overlay's backdrop hid an open dialog** (low, *overlay-backdrop-hides-open-dialog*). Between 1000 and 1359 px, a click outside the dialog closed the overlay with the dialog in it. The backdrop now stands back while the dialog is open.

**Verified:**

- type check, lint;
- the whole unit suite: 2282 passed, with `tests/integration/assistant-rows.test.ts` failing without a database, as recorded;
- the API unit suites, 187 cases, one new: the delete draws on its own bucket;
- the database suites `conversation-delete`, 7 cases with one new, and `contract`, 15 cases. The new case holds the delete while an earlier answer's final is unstored behind a settled later one, then deletes once it is stored, with both keys forgotten;
- the browser suite on the development server, 4 cases:
  - EN and PT now open the conversation from the list, and after the delete Back shows the list without it;
  - the 1200 px case lands on a `?deleted=<id>`;
  - a new case makes a conversation through a walk refused at its inputs, which writes nothing and asks no model, and deletes it. No dialog, row or session survives, focus is on `New conversation`, and the next walk makes a conversation of its own;
- the PT truncation suite: every screen clean, the two delete screens included.

The development server's Turbopack stopped on an internal panic while these were checked, after a production build ran beside it. It was started again on a fresh cache; nothing of the unit's was involved.

## 29. As built (unit 64: the gateway's message bodies off, 2026-10-11)

D6 as Andre answered it, before Langfuse has keys: one setting in `infra/gateway/litellm.yaml`, `litellm_settings.turn_off_message_logging: true`.

**Checked at the pinned image** (`ghcr.io/berriai/litellm:main-stable@sha256:87f3…0d02`, LiteLLM 1.102.1), by reading its source in the running container:

- The proxy sets each key of `litellm_settings` on the `litellm` module, and the module declares `turn_off_message_logging`.
- Both the success and the failure handler call `redact_message_input_output_from_logging` before any callback, the `langfuse` one included. It replaces the messages, the prompt and the response with "redacted-by-litellm" when redaction is on.
- **A request can still turn redaction off.** The image honours a `litellm-disable-message-redaction` header and a `turn_off_message_logging` request parameter ahead of the global. Nothing of the application sends either: no file under `lib/`, `workers/`, `app/`, `components/` or `scripts/` names them, and `tests/gateway-config.test.ts` now holds that.
- **The gateway's own spend logs** keep a prompt only under `store_prompts_in_spend_logs`, which is off by default and not set here.
- **The Langfuse variables** are named in the gateway's environment and hold no value, so no callback has run. Only their presence was looked at, never a value.

**The gateway restarted** on the new file (`docker compose restart gateway`, no real research run mid-call). It answered `/health/liveliness` 200, its mounted settings read the three keys, and its start logged no error.

**Verified:** `tests/gateway-config.test.ts`, its twelve earlier cases and two new ones. The settings block holds the setting beside the two Langfuse callbacks, with no prompt in the spend logs. No application source sends either override. The new case failed before the setting and passed after.
