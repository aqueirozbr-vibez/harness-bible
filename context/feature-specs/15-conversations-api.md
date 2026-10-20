# 15 · Conversations and the assistant API — feature spec (the activity models, the four endpoints, the SSE stream, retention)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: `context/architecture.md` § 3.4 (Assistant: `POST /assistant/conversations`, `POST /assistant/conversations/{id}/messages` as SSE, `POST /assistant/messages/{id}/flag`, `GET /assistant/conversations/{id}`; user / owner; 30/min, 20/min budget-gated, 10/min; `Idempotency-Key` on messages; 402 at the budget cap; a refusal is a 200 with `refusal`), § 4 (`Conversation`, `Message` with mode, refusalCause, guideVersion, modelId, firstTokenMs, tokensIn/Out, traceId; `Citation`, `SensorVerdict`, `Flag`; keyed by `userId` and `releaseId`; message text nulled after 30 days, metadata, citations, verdicts and flags kept), § 4.5 (the nightly purge: `Message.text = null`, `Conversation.textPurgedAt`), § 5.4 (a conversation is readable by its user and nobody else; curators see the calibration set as labelled samples), § 5.6 (assistant messages 20/min/user, a token bucket in PostgreSQL), § 6.3 (`AnswerWorkflow` as route handler plus workers; the `answer` ledger record), § 6.4 (the stream carries tokens, then one final event with citations and verdicts; the client renders substitutions and citations only from it), § 7 (the answer's span: message id, citations resolved / total, refusal cause, grader score, first token ms), § 11 invariants 14, 18, 23; `context/code-standards.md` § API (the status catalogue: 402 budget, 409 duplicate flag, 422 semantic failure, 429 rate limit, 503; a refusal is a 200 with `refusal`, not an error; `ReadableStream` SSE from a route handler with a final JSON event; handlers do not write ledger records for workflow-owned events; every endpoint has a contract test), § Data (a text column over a few kilobytes is a defect); `09-keycloak-oauth.md` § 7 (the handler pipeline: a `Response` returned by `run` passes through with the pipeline's headers, idempotency claims complete with the status), § 6.2 (`/api/v1` rules); the screens: `you · 10:42 … assistant · explain · 10:42 · en · cites en edition v1.5.0`, `Log · ch21 · 4 turns … t3 · 10:38 refused … earlier conversations ch21 · durable execution 18 Sep · 6 turns · 6 pass`, `export JSONL`, `Flag this answer`, `Flag this refusal`, `hash 8c21f04e9ab3 · prev 3f7a91c2d0e5`.

Prerequisite specs: `11-model-gateway.md` (the workers' surface, `workersFetch`, `BudgetExceededError`), `13-assistant-agent.md` (`AnswerRequest`, `AnswerResult`, the flow), `14-ledger-core.md` (`append` with the `ANSWER` payload). Numbered 15 as the Phase 2 plan has it: 14 is the ledger core.

Scope: tracker unit 29. The five activity models and their migration, the four endpoints on the handler pipeline, the SSE protocol between browser, web tier and workers, the workers' `/answer` route that runs spec 13's flow and writes the rows and the ledger record, the loaders the dock and the log rail read, the OPA rules, the retention script, and the contract tests. No screen (spec 16 and 17 render what these return).

## 1. Purpose

A conversation is the user's, lives on the pinned release, and is answered by a flow that writes what it did before the browser hears the end: the assistant row with its verdicts and citations, and the ledger record whose hash the final event carries. The endpoints are the contract for the dock and for any client; the pipeline gives them the same validation, rate limit, idempotency and policy every other endpoint has; the stream is the one place the product answers before the answer is final, and it says so with a final event nobody may render ahead of.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| The handler pipeline (done): parse, session, rate limit, idempotency, policy, `Response` passthrough | the four endpoints are `Spec`s like every other |
| `Release.current`, `ChapterVersion.verifyStatus`, `Section` anchors (done) | a conversation's context is validated against the release |
| The workers container and `workersFetch` (spec 11), the answer flow (spec 13), `append` (spec 14) | the message endpoint forwards; the workers answer, write and record |
| OPA rules for the new kinds | `conversation` and `message` join `policies/hb/` |

Build order: 29a migration `0011_assistant` (the five models, the tenant guard entries) and `lib/db/assistant.ts` (creates, reads, the log rail's list, the purge) → 29b `lib/schemas/api.ts` additions, `policies/hb/assistant.rego` with tests, the three JSON endpoints (`conversations` POST and GET, `flag`) with contract tests → 29c the SSE endpoint, the workers' `/answer` route, the stream protocol, the idempotent replay, contract tests against the stub gateway → 29d `scripts/assistant-purge.ts` and the OpenAPI regeneration → verification.

## 3. Data contract and schema (migration `0011_assistant`)

```prisma
enum MessageRole { USER ASSISTANT }
enum AssistantMode { EXPLAIN COMPARE WALK LAB BRIEF }
enum FlagKind { ANSWER REFUSAL }

model Conversation {
  id             String        @id @default(uuid())
  userId         String                                   // tenant column
  user           User          @relation(fields: [userId], references: [id])
  organisationId String?
  releaseId      String                                   // pinned at creation; a conversation never crosses releases
  chapter        Int
  sectionId      String?                                  // the context section anchor at creation ("21.3")
  locale         String                                   // "en" | "pt": the answer language
  contextLabel   String                                   // "ch21 · durable execution": the rail's line; from the release's title, never user text
  createdAt      DateTime      @default(now())
  lastMessageAt  DateTime      @default(now())
  textPurgedAt   DateTime?
  messages       Message[]

  @@index([userId, lastMessageAt])
}

model Message {
  id               String         @id @default(uuid())
  conversationId   String
  conversation     Conversation   @relation(fields: [conversationId], references: [id])
  userId           String                                 // tenant column (denormalised, as Bookmark and Note)
  role             MessageRole
  ordinal          Int                                    // 1, 2, … within the conversation; a turn is a USER row then its ASSISTANT row
  mode             AssistantMode
  text             String?                                // ≤ 800 characters for USER; the assistant's claims joined for ASSISTANT; null after the purge
  refusalCause     String?                                // "R-SCOPE-OT"; ASSISTANT rows only
  refusalBeforeRetrieval Boolean?
  guideVersion     String?
  guideSha256      String?
  modelId          String?
  promptSha256     String?
  grounded         Decimal?                               // 0–1
  repaired         Boolean        @default(false)
  substituted      Int            @default(0)
  citesEdition     String?                                // "EN" | "PT"
  firstTokenMs     Int?
  totalMs          Int?
  tokensIn         Int?
  tokensOut        Int?
  cacheReadTokens  Int?
  overBudget       Boolean        @default(false)         // retrieval past its 600 ms budget (12 § 7.2)
  traceId          String
  ledgerSeq        Int?                                   // the ANSWER record (14 § 4.3)
  ledgerHash       String?
  createdAt        DateTime       @default(now())
  citations        Citation[]
  verdicts         SensorVerdict[]
  flags            Flag[]

  @@unique([conversationId, ordinal])
  @@index([userId, createdAt])
}

model Citation {
  id          String   @id @default(uuid())
  messageId   String
  message     Message  @relation(fields: [messageId], references: [id])
  userId      String
  ordinal     Int
  sectionId   String                                      // anchor
  figureId    String?
  version     String
  editionLang String
  claimText   String?                                     // the claim's sentence; null after the purge (it is answer text)

  @@unique([messageId, ordinal])
  @@index([sectionId])
}

model SensorVerdict {
  id        String  @id @default(uuid())
  messageId String
  message   Message @relation(fields: [messageId], references: [id])
  userId    String
  sensor    String                                        // scope | citation | edition | grader | latency
  verdict   String                                        // PASS | FAIL | WARN | NA
  detail    String                                        // the panel's line ("4 / 4 figures found at cited location")
  data      Json

  @@unique([messageId, sensor])
}

model Flag {
  id        String   @id @default(uuid())
  messageId String
  message   Message  @relation(fields: [messageId], references: [id])
  userId    String
  kind      FlagKind
  reason    String                                        // a coded reason (§ 5.4), never free text
  createdAt DateTime @default(now())

  @@unique([messageId, userId])                           // one flag per user per message (409 on a second)
  @@index([createdAt])
}
```

All five join `TENANT_MODELS` by `userId` (`lib/db/client.ts`). `Message.text` and `Citation.claimText` are the only free text; the purge nulls both. `User` gains `conversations Conversation[]`; account deletion (08 § 5.8, the hard delete still to be built) removes the five tables' rows and the ledger keeps the pseudonym. No row holds a name, an e-mail or the organisation's name.

## 4. Loaders and writes (`lib/db/assistant.ts`, 29a)

- `createConversation(user, { releaseId, chapter, sectionId, locale })` inside the tenant context; validates the chapter and section against the release (`CONTEXT_INVALID` 422 when the section is not in the release or the chapter has no version) and sets `contextLabel` from the chapter's title.
- `getConversation(user, id)` with messages in ordinal order, each with citations, verdicts and the user's flag; `null` for another user's id (the tenant guard makes a foreign id invisible; the endpoint answers 404, never 403, so ids are not an oracle).
- `listConversations(user, { limit })` for the log rail's "earlier conversations": id, `contextLabel`, `lastMessageAt`, turns, `passCount` (assistant messages whose verdicts are all PASS or NA), `refusedCount` (the screen's `6 turns · 6 pass`). A loader, not an endpoint (the rail is a server component of spec 17).
- `appendUserMessage(conversation, { text, mode, ordinal })`, `appendAssistantMessage(conversation, result, ledger)` (called by the workers, § 6.3), `recordFlag(user, messageId, kind, reason)` (`FLAG_DUPLICATE` 409 on the unique index).
- `purgeMessageText(olderThan)` (§ 8) and `conversationStats(user)` for spec 21.

## 5. The endpoints (`lib/api/endpoints/assistant.ts`, 29b and 29c)

All four: `auth: "session"`, resource kinds `conversation` and `message` with the owner in the policy input (`ownResource`), rate keys per user. New Rego file `policies/hb/assistant.rego`: a user may `create`, `read` and `ask` on a `conversation` they own and `flag` a `message` they own; the agent identity is denied all four; tests for the owner, a foreign owner, an anonymous subject and the service identity.

### 5.1 `POST /api/v1/assistant/conversations` (30/min)

Body `{ chapter: 0–40, section?: SectionId, locale: "en" | "pt" }` (the release is the current one, never chosen by the client). 201 `{ id, releaseId, chapter, sectionId, locale, contextLabel, createdAt }`. 422 `CONTEXT_INVALID` with the field.

### 5.2 `GET /api/v1/assistant/conversations/{id}` (60/min)

200 the conversation with `messages[]` (each: `id, role, ordinal, mode, text` (null when purged), `refusal { cause, code, beforeRetrieval } | null`, `citations[]`, `verdicts[]`, `grounded`, `repaired`, `citesEdition`, `ledger { seq, hash, prevHash } | null`, `timings { firstTokenMs, totalMs }`, `flag { kind, reason, createdAt } | null`, `createdAt`), `textPurgedAt`. 404 for a foreign or unknown id. `cache-control: private, no-store`.

### 5.3 `POST /api/v1/assistant/conversations/{id}/messages` (SSE; 20/min per user; `Idempotency-Key` required)

Body `{ text: ≤ 800 characters after trim (400 `TEXT_TOO_LONG`), mode, context?: { chapter?, section?, chapters?: [n, n], labId? }, aidInputs?: Record<string, number> }` (walk mode: spec 18's inputs, validated there; `chapters` for compare: two distinct verified chapters, 422 otherwise). The pipeline runs its steps (parse, session, rate limit, idempotency, policy), then `run` returns a `Response` whose body is the stream of § 6, with the pipeline's `traceparent` and rate-limit headers; the idempotency claim completes with status 200 and the final event's JSON as the stored body, so a replay with the same key answers a one-event stream holding the stored `final` (D1); an in-flight duplicate is 409 `IDEMPOTENCY_IN_FLIGHT` as today.

Before the stream opens the endpoint checks what it can without the workers: the conversation exists and is the caller's (404), the release is still current (409 `RELEASE_CHANGED`: a conversation pinned to a superseded release is read-only and the client offers a new one), the previous turn is complete (409 `TURN_IN_PROGRESS`), the context is valid (422). Then it forwards to the workers (§ 6.2). A `WorkersUnavailableError` before any event is 503 `ASSISTANT_UNAVAILABLE`; a `BudgetExceededError` is 402 `BUDGET_EXCEEDED` with `{ resetsAt }` and the message "Model budget reached for this organisation; resets {date}" (`assistant.budget` in the catalogues; the PT string is a candidate).

### 5.4 `POST /api/v1/assistant/messages/{id}/flag` (10/min)

Body `{ kind: "answer" | "refusal", reason: "wrong_citation" | "missing_citation" | "wrong_number" | "should_not_refuse" | "should_refuse" | "other" }` (coded reasons, no free text: the flag enters the grader's calibration set as a labelled sample, spec 17; D2). 201 `{ id, messageId, kind, reason, createdAt }`; 404 for a foreign message; 409 `FLAG_DUPLICATE`; 422 when `kind` does not match the message (`refusal` on an answer or the reverse).

## 6. The stream (29c)

### 6.1 Protocol (browser ← web tier)

`text/event-stream`, `cache-control: no-store`, `x-accel-buffering: no`, one `id:` per event (the message ordinal and a counter), events in this order:

| Event | Data | When |
|---|---|---|
| `meta` | `{ messageId, conversationId, ordinal, traceId, mode, guide: { version }, alias: "hb-frontier" }`, and `question` when the question was stored other than as sent: a secret pasted into it reads `[redacted:{kind}]` (feature-specs/21 § 6.2, added 2026-10-04) | first, after the user row is written |
| `status` | `{ step: "retrieving" \| "drafting" \| "checking" \| "grading" \| "repairing" }` | at each step of spec 13's flow |
| `token` | `{ text }` | each text delta of the draft; never sent during a repair |
| `final` | the `AnswerResult` view of § 5.2's message shape plus `ledger { seq, hash, prevHash }` | once; the only source of citations, substitutions, refusals and verdicts (invariant 14) |
| `error` | `{ code, message, traceId }` | instead of `final` when the flow failed after `meta` (`ASSISTANT_UNAVAILABLE`, `BUDGET_EXCEEDED` with `resetsAt`); the stream closes |

A refusal is a `final` with `kind: "refusal"` and no `token` events: HTTP 200 (code-standards: a refusal is not an error). A comment line is written at a fixed interval while waiting on the workers so proxies keep the connection (D3). The client's hook (`lib/hooks/useSse.ts`, spec 16) reconnects on a dropped connection by fetching the conversation (§ 5.2): the message row either has its final state or is `TURN_IN_PROGRESS`; it never re-posts.

### 6.2 Web tier → workers

`workersFetch("/answer", { conversationId, userId, principal, text, mode, context, aidInputs, locale, releaseId, traceId })` returns the workers' own event stream (the same event names, JSON lines); the route pipes it through, translating each line into an SSE event and adding the `id:` counter. The web tier writes nothing to the five tables for an assistant turn (D4): it validates and forwards; the workers own the turn.

### 6.3 The workers' `/answer` route

In order, inside the workers:

1. Write the `USER` message row (ordinal n) and bump `lastMessageAt`; emit `meta`.
2. Build spec 13's `AnswerRequest` (the conversation's earlier turns from the rows, text purged turns omitted; the aid result for walk mode from spec 18) and run the flow with sinks that emit `status` and `token`.
3. On the result: write the `ASSISTANT` row (ordinal n+1) with its citations and verdicts in one transaction; `append` the `ANSWER` ledger record (14 § 6) with the message id, question and answer hashes, citations, verdicts, guide, model, prompt hash, timings, usage; update the row with `ledgerSeq` and `ledgerHash`; emit `final` with the row's view and the ledger line.
4. On a failure after `meta` (gateway down, retrieval down, budget): write the `ASSISTANT` row as a failed turn (`refusalCause: null`, `text: null`, a `SensorVerdict` of sensor `scope` with verdict `NA` and the error code as detail, so the log rail can show the turn) and emit `error`. No ledger record for a failed turn (nothing was answered); the span records it.
5. The `BudgetLedger` rows are the gateway client's (spec 11) and are written whatever the outcome.

`TURN_IN_PROGRESS` is a row-level state: the `USER` row exists without its `ASSISTANT` row; a second post while it stands is 409; a turn abandoned by a crash is closed by the purge script as a failed turn after the flow's maximum duration (spec 11's timeouts summed), D5.

## 7. Schemas and the contract (`lib/schemas/api.ts`, `openapi.json`)

`ConversationCreateSchema`, `ConversationSchema`, `MessageSchema` (with `CitationViewSchema`, `VerdictViewSchema`, `LedgerLineSchema`), `MessagePostSchema`, `FlagPostSchema`, `FlagSchema`, `SseFinalSchema` (the `final` event's data: the message view). The OpenAPI document describes the messages endpoint with `text/event-stream` and the event data schemas under `x-sse-events` (D6); `npm run api:openapi` regenerates and CI diffs it. Error codes added to the catalogue: `CONTEXT_INVALID` 422, `TEXT_TOO_LONG` 400, `RELEASE_CHANGED` 409, `TURN_IN_PROGRESS` 409, `FLAG_DUPLICATE` 409, `BUDGET_EXCEEDED` 402, `ASSISTANT_UNAVAILABLE` 503, each with EN and PT messages in `api.errors.*`.

## 8. Retention (`scripts/assistant-purge.ts`, `npm run assistant:purge`, 29d)

Nightly (a schedule outside the repository until Temporal, code-standards § Data): `Message.text = null` and `Citation.claimText = null` for messages older than 30 days, `Conversation.textPurgedAt` set when all of a conversation's messages are purged, failed turns older than the flow's maximum duration closed (§ 6.3). Citations, verdicts, flags, timings, hashes and the ledger stay, until the reader deletes the conversation: since unit 62e its rows go then, at once, and the ledger alone stays (feature-specs/45 § 3). The script prints counts and writes one span line; it appends no ledger record in Phase 2 (the `EXPORT` and `ANSWER` kinds are the only Phase 2 kinds). `npm run auth:sweep` stays separate.

## 9. Security controls

- Ownership is a policy fact and a tenant filter: the endpoints name the owner in the policy input and the guard scopes every query; a foreign id is 404.
- The user's text reaches the model only through the assembler's fence (spec 13); the endpoints store it as data and the log renders it as text.
- The stream carries no key, no prompt, no section HTML; the `final` event is the row's view.
- Rate limits: 30 / 20 / 60 / 10 per minute per user as architecture § 3.4; the messages bucket also protects the gateway budget from a runaway client.
- Idempotency on messages (a UUID key, 24 h): a retried post never runs the flow twice or writes two turns.
- Every turn is attributable: trace id on the rows, the span, the `BudgetLedger` rows and the ledger record.

## 10. Out of scope

- The dock, the composer, the log rail and the refusal card (spec 16, 17); the walk's inputs and steps (spec 18); modes' result rendering (spec 19).
- A conversation list endpoint (the rail is a server component reading the loader; an API client lists nothing in Phase 2), conversation deletion by the user (decided since: `DELETE /api/v1/assistant/conversations/{id}`, feature-specs/45 § 3, unit 62h), JSONL export of a conversation (spec 17 builds it from the ledger export of spec 14, scope `all` filtered by the message ids).
- Bearer access to the assistant (session only in Phase 2; the bearer path stays on `/me`).

## 11. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | Idempotent replay of a streamed message | A a one-event stream holding the stored `final` / B 200 JSON of the final event | **A**: the client's stream reader stays the only code path; the pipeline already stores the completed body |
| D2 | Flag reasons | A a coded list of six / B free text | **A**: a flag is a calibration label; free text would be a second retention problem and could carry identity |
| D3 | Keep-alive while waiting | a comment line at a fixed interval | **yes**, interval to be confirmed by Andre (the first token target is 2 s; a comment every few seconds costs nothing) |
| D4 | Who writes the turn's rows | A the workers, in the flow / B the route writes the user row, the workers the rest | **A**: one owner per turn, one transaction for the assistant row and the ledger, and the route stays a validator and a pipe (code-standards: handlers do not write for workflow-owned events) |
| D5 | Abandoned turns | A closed by the purge script after the flow's maximum duration / B closed by a heartbeat from the workers | **A** in Phase 2: no scheduler exists; B when Temporal owns the flow |
| D6 | Describing SSE in OpenAPI | A `text/event-stream` with an `x-sse-events` extension naming each event's schema / B leave the stream undocumented | **A**: the contract test reads the same schemas; a client generator sees the shapes |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Migration on a fresh database; the five models in `TENANT_MODELS`; a query outside a tenant context throws `NO_TENANT`; two users' conversations are invisible to each other.
2. OPA: `assistant.rego` tests: owner allowed for `create`, `read`, `ask`, `flag`; a foreign owner denied; anonymous denied; `service:adjudicator` denied.
3. Contract (stub gateway, the workers running): create a conversation (201, the label from the release, `CONTEXT_INVALID` on `99.1`); post a message with the stream read to the end: `meta` first, `status` in order, `token` deltas, `final` with `kind: "answer"`, citations, five verdicts, `ledger.seq` and a 64-hex `hash`, and the `GET` afterwards returning the same message view with `text` and `claimText` set; a refusal question (an OT question from the golden set) streams `meta` then `final` with `kind: "refusal"`, `beforeRetrieval: true`, no `token`, HTTP 200, and no `BudgetLedger` row of kind `ASSISTANT` on the frontier alias; a second post with the same `Idempotency-Key` returns a one-event stream with the stored `final` and creates no rows; a post without the key is 400; a post during an open turn is 409 `TURN_IN_PROGRESS`; the 21st post in a minute is 429 with `Retry-After`; a 801-character text is 400; a foreign conversation id is 404; `x-hb-stub-fail: 500` after `meta` ends with an `error` event, a failed-turn row with the `NA` verdict and no ledger record; the stub's budget error is 402 before `meta` (or an `error` event with `resetsAt` after it); the workers stopped is 503 before any event.
4. Flags: 201 on an answer with `kind: "answer"`; 409 on the second; 422 for `kind: "refusal"` on an answer; 404 for a foreign message; the flag appears on the `GET`.
5. Ledger: the message's `ledgerHash` equals the record's `hash`, `prevHash` matches the chain, `verifyChain` over the whole chain passes after ten turns; the record's `questionSha256` is the sha256 of the posted text and `answerSha256` of the joined claims.
6. Purge: after `npm run assistant:purge` with a clock 31 days ahead, `text` and `claimText` are null, `textPurgedAt` set, citations and verdicts intact, the ledger record unchanged and still verifying; a turn abandoned (a `USER` row alone older than the maximum) is closed as failed.
7. `openapi.json` gains four operations and the SSE extension; the diff step passes; the token grep is clean (no UI in this unit).
8. Invariant check: 14 (the route never emits a citation before `final`; a `token` event carries text only), 18 (the ledger payload holds hashes, the rows hold the text for 30 days), 23 (every endpoint through the pipeline; OPA down denies all four).
