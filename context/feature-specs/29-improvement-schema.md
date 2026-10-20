# 29 · The improvement schema — feature spec (models and enums, the one door to them, suggestion ids, ledger payloads, roles and the curator roster)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: TRD § 4.2 (the improvement block of the Prisma schema, pp. 19–21), § 4.3 (the ledger's kinds and what each covers), § 6.2 (roles and the agent's dual identity); architecture § 4.2 and § 5; `prisma/schema.prisma` as built, which this spec extends and where it differs from the TRD says why (§ 8). No screen belongs to this spec.

Prerequisite specs: `04-content-domain-schema.md` (anchors, `Part`), `08-user-auth.md` and `09-keycloak-oauth.md` (roles, the policy input), `14-ledger-core.md` (the chain, `append`, the placeholder payloads), `27-improve-and-researcher-plan.md`.

Scope: tracker unit 46 (46a to 46e). The rows Improve is made of and the rules about who touches them. Not here: the rubric's own two tables' content (spec 30), any endpoint (31 onwards), the research tables (spec 40 § 3, a later migration).

## 1. Purpose

Everything Improve does is a change of state on a suggestion: drafted, submitted, graded, sensed, decided, queued, merged. This spec fixes the vocabulary once so that the eight specs after it name the same columns, the same states and the same record payloads. It also settles the one structural question the TRD leaves implicit: whose rows these are.

## 2. Whose rows (D1)

Every account-scoped row in the product carries its tenant and is read through the tenant filter (invariant 24). A suggestion is not account-scoped in that sense. It is a contribution to the one book all tenants read; a curator, who may belong to another organisation or to none, must read it; its record is published in the chapter's history. Architecture § 5.4 already says so in its own words: owner the contributor, readable by the curators of the chapter's part.

So the improvement models are **platform models**, outside the tenant filter, as `LedgerRecord` and the content tables are. In exchange:

1. They are read and written only through `lib/db/improve.ts` (46b). No other module names `prisma.suggestion` or any of its children; a CI grep holds that, as one holds the ledger's single writer.
2. Every read function takes the caller (`{ userId, role, parts }` or a named service) and puts the owner-or-curator condition **in the query**, so a handler that forgot to ask the policy still could not read another contributor's draft.
3. OPA is asked first, as for every endpoint (invariant 23).

What stays a tenant's: nothing in this spec. The research run, which records which reader's question started it, is the asker's own row and is specified with the researcher (spec 40 § 3).

## 3. Enums and models (46a)

One forward-only, additive migration (invariant 30). Sketch, not final Prisma; 46a writes the schema and reports every deviation.

```
enum SuggestionOrigin { HUMAN RESEARCHER }
enum AnchorKind       { SECTION FIGURE SOURCE_ROW }
enum ChangeKind       { EDIT_TEXT SET_VALUE EDIT_ROW ADD_CLAIM ADD_ROW RESTRUCTURE }        // what is proposed; spec 30 § 4.1
enum ChangeClass      { WORDING CITED_FIGURE DERIVED_FIGURE NEW_CLAIM CURATOR_ALWAYS }      // TRD
enum CuratorReason    { SAFETY_OT SCENARIO_PARAMETER STRUCTURE NEW_SOURCE_TIER RUBRIC }     // why CURATOR_ALWAYS; the queue's groups
enum EvidenceKind     { LINK DOI UPLOAD LAB_RUN }
enum EvidenceTier     { A B C D E F G U }
enum EvidenceState    { PENDING GRADED }
enum Decision         { ACCEPT REQUEST_MORE DECLINE CURATOR_REVIEW }
enum SuggestionState  { DRAFT SUBMITTED INTAKE_DECLINED GRADED SENSED DECIDED CURATOR_QUEUE
                        MERGING MERGED CLOSED }                                             // TRD; § 3.1 for what each means here
// SuggestionOrigin gained CURATOR with unit 54e (2026-10-10; feature-specs/37 § 8, § 21): a curator's revert, a suggestion
// of its own with no contributor, merging from the start.
enum SuggestionSensor { SCHEMA ANCHOR_EXISTS EVIDENCE_PARSES RATIONALE_LENGTH
                        DERIVE_CONSISTENCY CROSS_CHAPTER LINT }
enum SensorResult     { PASS FAIL WARN NA }
enum CuratorActionKind{ ACCEPT KEEP_REQUEST_MORE DECLINE MERGE REVERT }

Suggestion
  id                String  @id            // "S-15-0377", § 4.2
  origin            SuggestionOrigin
  userId            String?                // the contributor; null when origin = RESEARCHER
  chapterNumber     Int
  chapterVersionId  String                 // the version it was written against
  releaseId         String
  parts             Part[]                 // the anchor's part and every part a shared figure or row reaches (spec 33 § 4.2)
  changeKind        ChangeKind
  changeClass       ChangeClass
  curatorReason     CuratorReason?
  proposal          Json                   // the ProposalSchema union of spec 31 § 4
  proposalKey       String                 // sha256 over the anchor and the normalised proposal: spec 42 § 4.3
  rationale         String?                // at most 200 words: the contributor's; for origin RESEARCHER the agent's note, never read by the adjudicator (spec 42 § 3)
  locale            Lang
  state             SuggestionState
  outcome           Decision?              // the last decision in force
  score             Int?
  rubricVersionId   String
  workflowId        String? @unique
  createdAt, submittedAt?, decidedAt?, closedAt?
  @@index([state, changeClass]) @@index([userId, createdAt]) @@index([chapterNumber, state]) @@index([proposalKey])

Anchor                                      // 1:1, required before SUBMITTED
  suggestionId      String  @id
  kind              AnchorKind
  sectionAnchor     String                 // "21.3": always set, the section the figure or row belongs to
  figureAnchor      String?                // "F-21-03"
  sourceRowAnchor   String?                // "21.9 r4"
  currentText       String                 // what the anchor read when the suggestion was written
  contentSha256     String                 // of the anchored row as the pipeline stored it
  existsAtVersion   Boolean

EvidenceItem
  id uuid, suggestionId, ordinal Int, kind EvidenceKind, state EvidenceState
  url String?, doi String?, storageKey String?, labRunId String?     // labRunId has no relation until Phase 3
  title String?, host String?, publishedOn DateTime?, ageDays Int?
  fetchStatus String                       // "opened:200" | "unreachable:<reason>" | "not_supplied" | "unsupported:<type>"
  contentSha256 String?, textKey String?   // the text the grader read, in object storage
  tier EvidenceTier?, baseScore Int?, relevance Decimal?, recency Decimal?, independence Decimal?, adjustedScore Int?
  reason String?                           // the grader's, at most 30 words
  gradedBy String?                         // a model id, or "intake-rules"
  gradedAt DateTime?
  @@unique([suggestionId, ordinal])

SuggestionSensorVerdict
  id uuid, suggestionId, sensor SuggestionSensor, result SensorResult, detail String, data Json, createdAt
  @@unique([suggestionId, sensor])

Adjudication                                // 1:1; one per suggestion, replaced by a revision's (spec 33 § 6.4)
  suggestionId @id, decision Decision, decidedBy String    // "intake-rules" | "router" | "adjudicator"
  score Int, acceptAt Int?, floorAt Int?, sufficientTier EvidenceTier?, failingSensor SuggestionSensor?
  guideVersion String?, guideSha256 String?, modelId String?, promptSha256 String?
  rubricVersionId, decidedAt, traceId

CriterionVerdict
  id uuid, suggestionId, criterion String  // tier | relevance | recency | independence | corroboration | threshold
  verdict String, reason String            // at most 30 words
  @@unique([suggestionId, criterion])

CuratorAction
  id uuid, suggestionId, curatorId, action CuratorActionKind
  overrideCode String?, criterion String?, note String?    // note at most 400 characters
  seeded Boolean @default(false), seedMatched Boolean?, queueWaitMs Int, createdAt
  @@index([overrideCode]) @@index([curatorId, createdAt])

CalibrationEvent                            // the TRD's "calibration store"
  id uuid, suggestionId, criterion String?, adjudicatorDecision Decision?, adjudicatorScore Int?
  curatorAction CuratorActionKind, overrideCode String?, seeded Boolean, rubricVersionId, createdAt
  @@index([createdAt]) @@index([criterion, createdAt])

RubricVersion   id String @id ("v1.2"), publishedAt, appliesAt, sha256, tiers Json, adjustments Json, examples Json
Threshold       id uuid, rubricVersionId, changeClass, acceptAt Int?, floorAt Int?   @@unique([rubricVersionId, changeClass])

CuratorRoster   id uuid, userId, part Part, since DateTime, until DateTime?          @@unique([userId, part])
SuggestionCounter chapterNumber Int @id, next Int
Merge           suggestionId @id, branch, commitSha?, versionFrom, versionTo?, bump, check Json?, mergedById?, mergedAt?,
                releaseFrom, releaseTo?, revertedBy String?                          // spec 37
AuditExport     id uuid, requestedById, scope Json, fromSeq, toSeq, records, headHash, storageKey?, state, createdAt   // spec 38
```

`LedgerKind` gains `RESEARCH` and `ENDORSED`; `BudgetKind` is untouched here (`GRADING` and `ADJUDICATION` exist; `RESEARCH` arrives with spec 40).

Foreign keys: children cascade from `Suggestion` only while it is a `DRAFT` (a draft may be deleted by its owner); from `SUBMITTED` on nothing is deleted, because the ledger refers to it. `Suggestion.userId` is `SET NULL` on the account's hard delete: the ledger keeps the pseudonym (architecture § 4.4), and the suggestion keeps its record without the person.

### 3.1 The states

The TRD's ten, with the meaning this build gives each. A suggestion's `state` says where it is; `outcome` says what was last decided.

| State | Entered when | Leaves to |
|---|---|---|
| `DRAFT` | created | `SUBMITTED`, or deleted |
| `SUBMITTED` | `submit` accepted and the workflow started; a revision's return | `INTAKE_DECLINED`, `GRADED`, `CURATOR_QUEUE` (a person's request for more by rule; unit 50e) |
| `INTAKE_DECLINED` | a sensor failed — an intake sensor or, since unit 50e, a consistency one — or the score is under the floor or without the derived class's single tier (no adjudicator call) | `CLOSED`; a revision returns it to `SUBMITTED` |
| `GRADED` | every item graded, score at or over the floor | `SENSED` |
| `SENSED` | consistency sensors recorded | `DECIDED`, `CURATOR_QUEUE` |
| `DECIDED` | the adjudicator's decision recorded, a curator kept a request for more, or the cap's wait ended in one | `MERGING` (accept, origin `HUMAN`), `CURATOR_QUEUE` (request more, for inspection; and every accept of origin `RESEARCHER`), `CLOSED` (decline), `SUBMITTED` (a revision of a request for more; unit 50e) |
| `CURATOR_QUEUE` | waiting for a curator | `MERGING` (curator accepts), `DECIDED` (keeps request more), `CLOSED` (declines), `SUBMITTED` (a revision of a request for more; unit 50e) |
| `MERGING` | `MergeWorkflow` running | `MERGED`, `DECIDED` with request more (the chapter's check failed) |
| `MERGED` | on the book's main branch and in a published release | `CLOSED` |
| `CLOSED` | nothing further will happen | — |

Since unit 50e the steps before a decision run while the suggestion is `SUBMITTED`, and the decision moves it in one statement through `GRADED` and `SENSED` where the run reached them (33 § 19).

A researcher's suggestion that Improve refuted ends `CLOSED` with `outcome` `DECLINE` or `REQUEST_MORE`: for it, "request more" is a refusal, since nobody is there to add evidence (spec 42 § 5).

## 4. The one door (46b)

### 4.1 `lib/db/improve.ts`

The functions later specs call, each taking a `Caller`:

```ts
type Caller =
  | { kind: "user"; userId: string; role: Role; parts: ReadonlyArray<Part> }   // parts: the roster's, empty for a non-curator
  | { kind: "service"; id: "service:intake" | "service:grader" | "service:adjudicator" | "service:researcher" | "service:merge" };
```

- A `user` caller reads a suggestion when it is their own, or when they are a `CURATOR` and one of their parts is in `Suggestion.parts`. Their own drafts are theirs alone.
- A `service` caller reads the rows its agent's may-read list names (architecture § 6.1) and no `User` row: the module has no function that returns a contributor's name, e-mail or organisation to a service, so there is nothing to forget to withhold (invariant 12).
- State changes are one function, `transition(suggestionId, from, to, patch)`, which updates only when the row is still in `from`. A workflow activity that runs twice finds the row already moved and does nothing.

### 4.2 Suggestion ids

`S-<chapter, two digits>-<serial, four digits>`: `S-15-0377`. The serial is per chapter, starting at 1, taken from `SuggestionCounter` under a row lock in the transaction that creates the draft. A fifth digit appears when a chapter passes 9,999; nothing parses the width. The id is assigned at creation, so a draft has it (the suggest screen shows `S-15-0377` with `draft · not submitted`).

Ids never localise (invariant 28) and are never reused: a deleted draft leaves a gap.

## 5. Ledger payloads (46c)

Spec 14 left six kinds as loose placeholders that `append` refuses (`LEDGER_KIND_NOT_YET`). This unit gives each its strict schema in `lib/schemas/ledger.ts`, adds two kinds, and lets `append` admit all eight. A strict object refuses an unknown key, so free text cannot ride in under a name the schema does not know; every piece of text a person or a model wrote appears as `…Sha256` (invariant 18).

Common to the six: `stepKey` (spec 28 § 4.4), `rubricVersion`, `origin`.

| Kind | Actor | Payload |
|---|---|---|
| `SUBMITTED` | `user:<id>` or `service:researcher` | `changeKind`, `changeClass`, `curatorReason`, `anchor { kind, section, figure, sourceRow, chapterVersionId, contentSha256, existsAtVersion }`, `proposalSha256`, `proposalKey`, `rationaleSha256`, `rationaleWords`, `evidence [{ id, kind, host, doi }]`, `verified` (the contributor's, for a person), `releaseId` |
| `GRADED` | `service:grader` | `items [{ id, kind, fetchStatus, tier, base, relevance, recency, independence, adjusted, gradedBy, reasonSha256, contentSha256 }]`, `score`, `strongestItemId`, `corroboratedById`, `usage`, `traceId` |
| `SENSORS` | `service:intake` | `verdicts [{ sensor, result }]`, `parts`, `detailSha256` |
| `DECIDED` | `service:intake`, `service:adjudicator` | `decision`, `decidedBy`, `score`, `acceptAt`, `floorAt`, `sufficientTier`, `failingSensor`, `criteria [{ name, verdict, reasonSha256 }]`, `guide { version, sha256 }` or null, `modelId`, `promptSha256`, `usage`, `traceId` |
| `CURATOR` | `user:<id>` | `action`, `overrideCode`, `criterion`, `noteSha256`, `seeded`, `seedMatched`, `queueWaitMs`, `part` |
| `MERGED` | `service:merge` | `branch`, `commitSha`, `versionFrom`, `versionTo`, `bump`, `releaseFrom`, `releaseTo`, `renderHash`, `check { lab, lint }`, `contributor` (pseudonym or null), `endorsedBy` (pseudonym or null), `mergedBy` (pseudonym), `reverts` (suggestion id or null) |
| `RESEARCH` (new) | `service:researcher` | spec 40 § 6.3 |
| `ENDORSED` (new) | `user:<id>` | `stepKey`, `consentAt` |

`suggestionId` and `chapterVersionId` are the record's own columns, set on every Phase 4 record, which is what makes the per-suggestion and per-chapter views of spec 14 work for them.

`lib/ledger/` stays at 100 % branch coverage (rules § 5): the new schemas have a fixture each in `tests/fixtures/ledger.ts` and the enum-parity test covers the two new kinds.

## 6. Roles, the roster and the policy (46d, 46e)

### 6.1 The subject carries what the policy needs

Two gaps found in the code as built, both closed here:

- `SessionUser` does not carry `identityVerified`, and the handler calls `subjectOf()` without it, so the policy has always been told `verified: false`. `SessionUser` gains `identityVerified`, and `subjectOf` passes it.
- The policy's "per-part roster check joins in Phase 4" (`policies/hb/agent.rego`). The subject gains `parts`, read from `CuratorRoster` for a `CURATOR` at the time of the request (rows with `until` null or in the future), empty otherwise. The roster is data, loaded per request, never part of the policy bundle: a roster change takes effect on the next request.

### 6.2 Rules (`policies/hb/improve.rego`, with tests for every deny)

| Action · resource | Allowed to |
|---|---|
| `create` · `suggestion` | role `CONTRIBUTOR` or above, `verified` |
| `read`, `write` · `suggestion` | its owner; a `CURATOR` with a part in `resource.parts` (read only); the reader from whose research run it came (read only; spec 43 § 5, as `read` on `proposal` by its owner, D7) |
| `submit` · `suggestion` | its owner, `verified`; `service:researcher` when `resource.origin == "RESEARCHER"` |
| `read` · `curation` | role `CURATOR` |
| `decide` · `curation` | a `CURATOR` with a part in `resource.parts`; `service:adjudicator` unless `changeClass == "CURATOR_ALWAYS"` or `origin == "RESEARCHER"` (it may only `recommend` there: invariant 32) |
| `recommend` · `curation` | `service:adjudicator` unless `changeClass == "CURATOR_ALWAYS"` |
| `endorse` · `proposal` | the reader whose research run produced it (`resource.ownerId == subject.id`); any role |
| any · `user`, `conversation`, `message` | never a service (as today) |

Consent is not the policy's: `provenanceConsentAt` is a fact about the person at the moment of submitting or endorsing, checked and set by the endpoint (specs 31 § 6, 42 § 6).

### 6.3 The roster

`CuratorRoster` rows are written by `npm run roster:set -- --email <e-mail> --part <P0…P3> [--until <date>]`, an operator's command, each run logged as an `AuthEvent`. No screen edits the roster in this build; the public panel that shows it is spec 38 § 5. The development sign-in is its one other writer: a development curator is put on it for every part (§ 17), never in production.

The PRD's dependency, "a curator roster of at least two per part", and architecture § 12's "policy requires two per part before Phase 4 opens that part's queue" are a condition of going live, not of the code running: the Phase 4 gate reports it per part (spec 39), and the queue works with one curator so that a development machine with one person can exercise it.

### 6.4 Development accounts (46e)

Roles are mirrored from Keycloak at sign-in and never written by the application (architecture § 5.1), and the development sign-in makes a `READER`. To build and test Improve a machine needs a verified contributor and a curator. `GET /api/v1/auth/dev` gains two optional parameters, `role` and `verified`, honoured only where the endpoint itself is (never in production), and the realm file gains nothing. The end-to-end suite's accounts follow the pattern unit 23d set: `e2e-contributor@…`, `e2e-curator@…`.

## 7. Out of scope

- The rubric's rows as content (spec 30 § 5).
- The research tables and the two switches (spec 40 § 3).
- A screen for the roster; rubric-change records (`R-…`).
- Seats and membership.

## 8. Where this differs from the TRD, and why

| TRD | Here | Why |
|---|---|---|
| `SensorVerdict` shared by messages and suggestions | a separate `SuggestionSensorVerdict` | the built `SensorVerdict` is the reader's own row under the tenant filter; a suggestion's verdicts are the platform's (D1) |
| `Anchor.sectionId`, `figureId`, `sourceRowId` | anchors as strings with the chapter version | the built content model identifies a section across releases by its anchor (tracker D19); a foreign key to one release's row would die with the release |
| `ChangeClass` alone | plus `ChangeKind` and `CuratorReason` | the class must be computed (invariant 8), and it is computed from what is anchored and what kind of change is declared; the queue groups curator-always items by reason |
| `Adjudication.modelId` required | nullable, with `decidedBy` | a decline at intake has no model: the Improve-Adjudication screen shows it with reasons and `intake rule · 0 tokens` |
| ledger kind `override` | none | TRD § 4.3 gives it no payload; an override is the `curator` record with its code |
| `CuratorAction.action String` | an enum | the screen's three segments, plus merge and revert |
| no calibration table | `CalibrationEvent` | TRD § 7.5 writes to a "calibration store" it never defines |
| no roster table | `CuratorRoster` | TRD § 6.2 checks "a curator whose roster includes the chapter's part" |
| `Suggestion.userId` required | nullable, with `origin` | Andre's Capability 5 (spec 27 § 4) |

## 9. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | Improvement rows under the tenant filter, or the platform's | the platform's (§ 2) | a curator of another organisation must read them; the alternative is a cross-tenant exemption in the filter, which architecture § 12 (unit 29d) calls the largest hole it could have |
| D2 | Serial per chapter or one for the product | per chapter | the screens' ids climb chapter by chapter (`S-37-0219`, `-0226`, `-0229`, `-0233`) |
| D3 | The roster edited by command or by screen | by command | no screen in the package edits it, and it changes a few times a year |
| D4 | `role` and `verified` on the development sign-in | yes, non-production only | the alternative is a Keycloak test realm with seeded users on every developer's machine |

## 10. Verification (in addition to `ai-workflow-rules.md` § 7)

1. The migration applies to the development database and to an empty one; `prisma migrate diff` shows additions only.
2. `lib/db/improve.ts`: a contributor reads their own draft and not another's; a curator of Part III reads a submitted suggestion whose `parts` hold `P3` and not one that holds only `P1`; a curator reads nobody's draft; a service function returns no `User` field (asserted on the return type and on the selected columns).
3. `transition` from a state the row has left changes nothing and says so.
4. Two drafts created concurrently on one chapter get consecutive serials; the id matches `^S-\d{2}-\d{4,}$`.
5. `append` accepts a valid payload of each of the eight kinds and refuses each with one unknown key; `npm run test:ledger` stays at 100 % branch coverage; the chain verifies after the appends.
6. OPA: every row of § 6.2 has an allow case and its deny cases, including a curator outside the part, an unverified contributor, `service:adjudicator` on `CURATOR_ALWAYS` and on a researcher's suggestion, and a reader endorsing another reader's proposal.
7. A signed-in verified user's policy input shows `verified: true`; before this unit it showed `false` (the test is written first and fails).
8. `GET /api/v1/auth/dev?role=CURATOR` answers 404 with `NODE_ENV=production`, as the endpoint does today.
9. The CI grep finds `prisma.suggestion` and its children in `lib/db/improve.ts` and its tests only.



## 11. As built (unit 46a, 2026-10-05)

The migration of § 3: `prisma/migrations/20261005120000_improvement`, thirteen enums, fourteen tables, and `RESEARCH` and `ENDORSED` on `LedgerKind`. It applies to the development database, which went from 31 tables to 45 and whose ledger held 6,078 records before and after, and to an empty database, where all fifteen migrations run in order. After it a `migrate diff` proposes only the seven statements it has always proposed here (the generated `tsv` columns and the vector index, which Prisma cannot declare).

§ 3 is a sketch and asked for every deviation to be reported. These are all of them.

| § 3 said | Built | Why |
|---|---|---|
| `proposal Json`, `proposalKey String`, both required | both nullable, and a check that they are there together or not at all | a draft exists before its proposal: spec 31 § 3 creates it from an anchor, a kind of change and a locale, and the proposal arrives by `PATCH`. The alternative was a placeholder that is not a proposal, with a hash of it |
| `EvidenceItem.fetchStatus String` | nullable | an item is created `PENDING` before the fetcher has been (spec 32 § 8), and § 4.4's four values are all outcomes of a fetch |
| `EvidenceItem.publishedOn DateTime?` | a date, without a time | it is the day a source was published |
| `CuratorAction.curatorId` and `AuditExport.requestedById` required | nullable, `SET NULL` when the account is deleted, as `Suggestion.userId` and `Merge.mergedById` are | an account's hard delete has to go through (LGPD), and neither a refusal nor the loss of the curator's action is acceptable; the ledger keeps the pseudonym. A roster row is about the person and goes with the account |
| the suggestion's chapter version, release and chapter | plain ids, no foreign key to `ChapterVersion`, `Release` or `Chapter` | no activity row has one (`Conversation.releaseId`, `Citation.sectionId`): a content row belongs to one release. In development the content tables are emptied by a cascading truncate before a re-ingest, which would take every suggestion with it |
| "children cascade from `Suggestion` only while it is a `DRAFT`; from `SUBMITTED` on nothing is deleted" | every child cascades from its suggestion, and a trigger (`suggestion_kept`) refuses the `DELETE` of a suggestion past `DRAFT` | a foreign key cannot depend on the parent's state. One refusal at the suggestion covers every child, and the database holds it whatever the client code does, as the ledger's trigger does |
| the indexes listed | two more: `CuratorAction(suggestionId)` and `CalibrationEvent(suggestionId)` | the only two children with no key or unique index starting with the suggestion; the record page reads them by it and a draft's deletion checks them |
| nothing about defaults | `Suggestion.state` starts `DRAFT`, `EvidenceItem.state` `PENDING` | what § 3.1 and spec 32 § 8 say each starts as; a researcher's suggestion is written `SUBMITTED` explicitly (spec 42 § 4) |
| `LedgerKind` gains two kinds | in the database and in `LEDGER_KINDS`, as two more placeholders `append` refuses | the code's list mirrors the enum exactly and a test holds that. Their payloads, with the other six, are unit 46c |

Sixteen checks say in the database what § 3 says in words or in comments: a suggestion's id has the form `S-NN-NNNN` and its chapter is the row's own; a researcher's proposal has no contributor; the curator's reason is set for the class `CURATOR_ALWAYS` and for no other; a suggestion names at least one part; a proposal and its key are there together; an anchor names the one figure or the one source row its kind says, beside its section; every sha256 is 64 lower-case hex characters (seven columns); a curator's note is at most 400 characters; a roster row ends after it starts; a counter starts from one. A rubric version that anything refers to cannot be deleted.

Left as the sketch has them, as strings and not enumerations: `Adjudication.decidedBy`, `CriterionVerdict.criterion` and `verdict`, `Merge.bump`, `AuditExport.state`, `EvidenceItem.fetchStatus` and `gradedBy`. The units that write them fix their values. Decimals have the schema's usual precision. The architecture's row for these tables also named `RubricReview` and `ProposalEndorsement`: they are specs 36 and 42's own migrations, and that row now says so.

**One contradiction between two specs, found and not settled here.** § 3 says that from `SUBMITTED` on nothing is deleted, because the ledger refers to it. Spec 32 § 8 lets the owner delete an evidence item of a suggestion that is open for revision, and the `graded` record names items by id. The schema as built refuses the deletion of the suggestion and says nothing about one item. It is unit 49e's to settle, with Andre, and is in the tracker.

The models are in none of the tenant guard's lists, so the guard filters none of them: they are the platform's by § 2. Nothing reads or writes them yet; `lib/db/improve.ts` is unit 46b, and the grep of § 10.9 with it.

Tests: `tests/improve-schema.test.ts` reads the files (the migration only adds, and alters no table that existed; it creates exactly what the schema declares; which key cascades, which is set to null, which restricts; no key to a content table; the guard's lists; the register of raw SQL). `tests/integration/improve-schema.test.ts` asks the database, in SQL, each case inside a transaction that is rolled back: the defaults, a draft deleted with everything it has, a suggestion in each of the nine later states refused by name, every check with a case it takes and one it refuses, the unique keys, and an account deleted with its suggestion, action, merge and export left without the person. It passes on the development database and on the empty one, and leaves no row.



## 12. As built (unit 46b, 2026-10-05)

The door of § 4: `lib/db/improve.ts`. Five functions, each taking its caller first, and the search that keeps every other module away from these tables.

| Function | Who | What |
|---|---|---|
| `createDraft(caller, draft)` | a person | their draft and its anchor, with the chapter's next id, in one transaction |
| `readSuggestion(caller, id)` | a person | the suggestion with its anchor, evidence, sensor verdicts, adjudication and criteria, if it is theirs or, for a curator, past draft in one of their parts; else null |
| `readSuggestionAsService(caller, id)` | one of the five services | the same in every state, without `userId` |
| `deleteDraft(caller, id)` | a person | their own draft, and only a draft |
| `transition(caller, id, from, to, patch)` | a person or a service | the move, only if the row is still in `from`; otherwise nothing, and where the row is now |

A later unit that needs another read or write of these rows adds its function there: the proposal's update (48b), evidence (49e), the queue (53), the roster's parts for a caller (46d), a researcher's proposal (59). Nothing was written ahead of the unit that will use it.

Where it differs from § 4, and what it settles:

- **`transition` takes the caller**, which § 4.1's signature did not. A person moves only their own suggestion and only from `DRAFT` to `SUBMITTED`, the one move an endpoint makes on a person's behalf (spec 31 § 6.1); anything else from a person is refused before the database is asked, and another person's suggestion is not found. A service makes any move the table of moves has (since unit 50a; below).
- **Which moves are legal is not checked here.** § 3.1 lists them, and spec 33 names one § 3.1 does not (a revision of a suggestion left at "request more" runs the steps again). The table is written once, with the workflow that makes the moves (unit 50). **Since unit 50a (2026-10-06) it is**: `SUGGESTION_MOVES` in `lib/schemas/improve.ts` holds § 3.1's pairs, and `transition` refuses a service's move outside it (`FORBIDDEN`) before the database is asked; the moves spec 33 § 6 adds come with unit 50e's states. And a service's move out of `DRAFT` holds invariant 25 in its query — the contributor verified, their consent recorded — so the workflow's catch-up (31 § 6.1) can never be first to move a draft whose consent the endpoint is still writing: the endpoint wrote the consent only when its own move won, so a workflow that moved first left a person's suggestion submitted with no consent on record (found reading 48d in unit 50a; the invariant outranks the spec). What the door holds is the rule § 4.1 states: the row moves only from where the caller says it is, and the patch is applied with the move or not at all.
- **Every function takes the client it runs on**, last and optional, as the ledger's queries do. Spec 31 § 6.2 needs the transition and the consent in one transaction; and since the database never deletes a suggestion past draft, a suite that could not run the door on a transaction it rolls back would leave its rows in the development database for good.
- **A suggestion is read one statement at a time.** One query with the five relations is run by the client as several statements at once, which on a transaction's single connection the driver warns it will stop queueing (found here: the first such read in a transaction raised the warning). The door reads the suggestion and then each kind of row under it in turn, and the suite fails if the warning returns.
- **The service read is one general read.** Each agent's own, narrower view arrives with the agent: the adjudicator's must leave out the rationale of a researcher's proposal (spec 42 § 3), which this one includes. No function returns a row of `User`, a curator's action or a curator's note, and the selected columns and the return types are held to that by a test.
- **A curator is the role `CURATOR` with a part**, exactly. The policy's other reader, the person whose research run produced a suggestion (§ 6.2), is not in the door's condition yet: the research tables are spec 40's.
- **The id's schema takes a fifth digit** (`SuggestionIdSchema` was four exactly), and `suggestionIdOf(chapter, serial)` writes one. The serial is taken by one upsert of the chapter's counter row inside the creating transaction, so the row is held until that transaction ends; a creation that fails gives its serial back, and a deleted draft does not.

**The search of § 10.9** is `tests/improve-door.test.ts`, in `npm test`, and the same pattern as a step of CI. It takes the tables from the schema's improvement block, so one added there is covered without being listed; it looks for them through the client and also in SQL, which the first search alone would miss; and it finds only `lib/db/improve.ts`. Tests are not searched: the door's own suites name these tables.

Verified by running it, on the development database:

| § 10 | Case | Result |
|---|---|---|
| 2 | a contributor reads their own draft, and another contributor reads it | the suggestion; null |
| 2 | a curator of Part III reads a submitted suggestion whose parts are P1 and P3, one whose part is P1 alone, a draft in P3, and their own draft | yes, no, no, yes |
| 2 | a contributor carrying parts, a curator with none | neither reads another's |
| 2 | a service reads a draft and a submitted suggestion | both, with no `userId` and the contributor's id nowhere in what is returned |
| 3 | `DRAFT` to `SUBMITTED` twice by the owner, then by a service | moved; then twice "not moved, it is `SUBMITTED`", and the first patch stands |
| 3 | a service moving from a state the row is not in, or a suggestion that does not exist | not moved, with the row's state; not moved, null |
| 4 | twelve drafts created at the same moment on one chapter by two people | twelve ids, serials 1 to 12, none twice; after one is deleted the next is 13 |
| 9 | the search | `lib/db/improve.ts` and no other file |

The suite uses chapter 98, which no book has, so no real chapter's counter moves, and it leaves no row.



## 13. As built (unit 46c, 2026-10-05)

The payloads of § 5, in `lib/schemas/ledger.ts`: eight strict schemas, and `append` admits every kind. The refusal `LEDGER_KIND_NOT_YET` is gone with the placeholders it guarded.

- **No member of the eight can hold a sentence**, and that is held the general way, not member by member. A test walks each fixture and puts a sentence in place of every string it holds (over ninety places), and each is refused; and `freeTextIn`, the walk that holds the workflows' schemas (spec 28 § 14), finds nothing in any of the eight. So a member added to a payload later is held to it without a test being added. Every string is an id, an enumeration, a version, a hash, or one of a few forms written for the purpose: a host name, a DOI, a fetch status (`opened:200`, `unreachable:403`, `unsupported:application/zip`, `not_supplied`), a model id, a branch, a commit, an override code (`OV-IND-02`), a pseudonym (`user:` and an id).
- **The vocabulary is its own file**, `lib/schemas/improve.ts`: the thirteen enumerations of § 3 and the book's parts as zod schemas, each held equal to its Prisma enum, in order, by a test; and two lists that are columns of text in the database, the six criteria of an adjudication and the three deciders. The payloads are built from it, and so will the API's requests be from unit 48.
- **A record's own columns are checked for its kind** (`recordIssue`, refusal `LEDGER_COLUMNS`), which § 5 gives as a column of its table and as one sentence: who may be the actor, and that a suggestion's record names the suggestion and the chapter version while a research record names neither. A `decided` record signed by a person or a `curator` record signed by a service is refused whatever its payload says. `ANSWER` and `EXPORT` are left as unit 28 built them.
- **The pairings the tables hold are held in the payloads too**: the curator's reason with the class `CURATOR_ALWAYS`; an anchor's kind with the figure or the source row it names; `verified` with a person's suggestion and null for a researcher's; in `decided`, one line for a criterion, and the guide, the model and the prompt all three with the adjudicator's decision and none with a rule's; in `research`, a brief and a reader with a run that planned one.

Where § 5 left a value open, what was built, each for the unit that will write the record:

| Member | Built as | Whose it is to confirm |
|---|---|---|
| a criterion's `verdict` in `decided` | a value of at most 32 characters with no space in it (`C`, `0.8`, `+10`, `66<70`). Spec 33 § 5.3 has it a string from the adjudicator, which would be the one place in the ledger a model could write a phrase | 50d, whose guide gives the adjudicator's verdicts that form, and 50e, which builds a rule's; the page's line `5 < floor 25` is composed on the page |
| `check { lab, lint }` in `merged` | each one of `PASS`, `FAIL`, `NOT_RUN`, `NONE`: spec 37 § 4.4's own four cases (passed, failed, no runner to run it, the chapter has none) | 54b |
| `endorsed` | `{ stepKey, consentAt, withdrawn }`: § 5 lists the first two and spec 42 § 6 adds the third for a withdrawal; here every record says which it is | 59 |
| `usage` | the shape the `answer` record has: input, output and cache-read tokens | — |
| a rationale that is absent | `rationaleSha256` null with `rationaleWords` 0, for a researcher's proposal with no note | 59 |
| an item nobody could open, in `graded` | tier `U` with the three factors and the text's hash null, and `gradedBy` the rule's name | 49d |

§ 5 pointed to "spec 40 § 9" for the `RESEARCH` payload; it is spec 40 § 6.3, and the table now says so.

Fixtures: `tests/fixtures/ledger.ts` has one payload per kind and `IMPROVE_RECORDS`, one whole record of each as `append` takes it. They tell the PRD's fourth worked example as spec 33 § 8 does: `S-15-0377`, a cited price in 15.9, a tier C item from the vendor concerned at 56 and a tier D item five months old at 42, score 66 against 70, request more, a curator's accept with `OV-IND-02`, and the patch from v1.3.2 to v1.3.3.

Verified (§ 10.5): `append` accepts a record of each of the eight kinds and refuses each with one key its schema does not name, against the in-memory chain and against the database; on the database the chain verifies through the eight, the suggestion's own view returns its seven in order and the research record is in no suggestion's view; a refused record leaves the head where it was. `npm run test:ledger` is at 100 % of branches (174 of 174). The records the database suite appends stay in the development ledger, as all of that suite's do, so they are about nothing real: a suggestion of chapter 98 and a chapter version that does not exist.

Not changed, and worth knowing: the two payloads of Phase 2 are older than this rule. `answer` has five members that are plain strings (a citation's version, the guide's version, the model's id, the trace id and a sensor's name, with a walk's aid id), all written by code. The walk is not run over them, and tightening them would have to accept every record already in a chain.



## 14. As built (unit 46d, 2026-10-05)

§ 6.1 to § 6.3: the policy is told who is verified and which parts a curator has, the rules of § 6.2 are in the bundle, and the roster is written by one command.

- **The test of § 10.7 was written first and failed**, as asked: with a verified curator's session the handler told the policy `verified: false` and no part. It passes now.
- **The session carries both**, not only the policy's subject as § 6.1 words it: `SessionUser` has `identityVerified` and `parts`. The subject (`subjectOf`) and the door's caller (`callerOf`) are both made from the session, so the two cannot disagree about who is asking. `parts` is read from the roster each time a session is resolved, by cookie or by bearer token, and only for the role `CURATOR`; a change to the roster needs no new sign-in. `subjectOf` no longer takes `verified` as an argument, which is how it had come to be always false.
- **Every session user built by hand states both**, 27 places in 19 files: fixtures, the gate's synthetic accounts and the workers' turn. All say not verified and no part, which is the least a person can be; the workers' turn says so in a comment, because the web tier sends neither.
- **The rules** are `policies/hb/improve.rego`, one rule per reader of each row of § 6.2. The two curation rules that waited in `agent.rego` since Phase 1 moved there, and the adjudicator's now also needs the suggestion's origin.
- **The tenant rule changed, by one line.** A suggestion, its curation and a proposal are the platform's kinds, so the rule that refuses another organisation's resource leaves them to their own rules. Without it a curator who belongs to an organisation is refused every suggestion, and § 2 says a curator of another organisation must read one. Being of no tenant gives nothing: every reader of these kinds is named by a rule.
- **One rule beyond the table**: a curator does not decide their own suggestion. It is spec 36 § 7's, and it belongs with the rule it restricts.
- **One row of the table is not built**: the third reader of a suggestion, the person whose research run produced it. Spec 43 § 5 gives that rule to its own unit (60b), with the research tables it needs. `endorse` on a proposal, which needs only the proposal's owner, is built.
- **A rule that reads what the caller left out does not fire.** A curation sent without its class or its origin is not the adjudicator's to decide, and a suggestion sent without its parts is no curator's to read. The endpoint that forgets a field is refused, not allowed.
- **The input's vocabulary**: the actions `recommend` and `endorse`, the kind `proposal`, and on a resource `parts`, `changeClass` and `origin` in the product's own enumerations. The single `part` a resource could carry, which nothing ever set, is gone. `serviceSubject` makes a service's subject.
- **The roster** (§ 6.3): `currentParts` and `setRosterEntry` in the door, `npm run roster:set`. A row in force keeps the day it began when its end is set or cleared; one that had ended begins again; an end that is not after the beginning is refused by name. `--until` takes a day, which is the instant that day begins in UTC, or an ISO instant. The command names the account by its display name and id, never echoes the e-mail, says when the account's role is not curator (the row then decides nothing until the identity provider gives the role), says that the roster is public (spec 38 § 4), and writes one audit row, `roster_set`.

Verified:

| § 10 | What | Result |
|---|---|---|
| 6 | `opa test policies` | 63 of 63: the 25 of Phase 1 and 2, two of them rewritten for the new input, and 38 for Improve, an allow and every refusal for each row of § 6.2 |
| 6 | six rules weakened one at a time in a copy of the bundle | each caught by a test that names what was wrongly allowed: an unverified contributor, the adjudicator on a researcher's proposal, a curator on their own suggestion, the tenant rule on a curator of another organisation, a curator writing, a person named like the researcher |
| 7 | the handler's test, written first | failed with `verified: false`; passes |
| 7 | a session made as a sign-in makes one, for a verified curator and an unverified reader | `identityVerified` true and false; the subject's `verified` the same |
| — | `npm run roster:set` for that curator, then the same session again | the part is in the session and in the subject, with no new sign-in; one `roster_set` row with no e-mail in it |
| — | the command with an unknown account, an unknown part, a date that is none, an end before the beginning | exit 1 each, by name, and nothing written |
| — | the rules asked by `authorize` of the sidecar | every case as the Rego tests have it: the names the code sends are the names the rules read |
| — | a signed-in reader through the development server on the new bundle | sign-in, `/api/v1/me` and a bookmark write all answer |

**The sidecar serves the bundle it was started with.** The one on this machine had run since 28 September; it was stopped and started again on the new bundle, detached as it was. Against the old bundle `tests/integration/improve-policy.test.ts` fails with the sentence that says to restart it.



## 15. As built (unit 46e, 2026-10-05)

§ 6.4 as written: the development sign-in can be asked for a role and a verification, and the end-to-end suite has a contributor and a curator. It is the last unit of this spec.

- **The endpoint.** `GET /api/v1/auth/dev` takes `role`, one of the product's five roles as the enumeration writes them (`CURATOR`, not `curator`), and `verified`, `true` or `false`. Both are read as text and judged by the endpoint after it has said whether it is here at all, so that in production, and anywhere the provider is not switched on, the answer to any query is the 404 it has always been, a role that is no role included. Where it is on, a value that is neither is a 400 `INVALID_INPUT` that lists the values, before an account is read or made.
- **A member left out leaves the account as it is.** A new account is a reader, not verified, as before, so every sign-in written before this unit does what it did: the end-to-end reader, the gate's accounts, a person typing the address with an e-mail and nothing else.
- **One function writes, and it has its own lock.** `resolveDevUser(email, locale, as)` in `lib/auth/link.ts`, the file that already holds the mirror from the identity provider; nothing else in the application writes `User.role` or `User.identityVerified`. Asked for a role or a verification where the development provider is off, it refuses with `FORBIDDEN` before it reads a row: the endpoint's 404 is the first lock and this is the second, for a script or a worker that calls the function without passing the endpoint.
- **A change of role is treated as the identity provider's is** (spec 09 § 8.4): in the transaction that writes it the account's sessions are revoked, and the endpoint records `role_changed` with `{ to, idp: "dev" }` before the `sign_in`. The sign-in that changed the role then gets its own new session. A change of verification alone revokes nothing: a session reads the account each time it is resolved (§ 14).
- **`devProviderEnabled` has its own file**, `lib/auth/devProvider.ts`, re-exported from `lib/auth/request.ts` where it was. `link.ts` is loaded by scripts and by the workers, and should not load the request helpers to ask one question of the environment.
- **Nothing else changed**: the realm file gains nothing, as § 6.4 says, and neither does the login page. `openapi.json` shows the two parameters as optional strings, because the endpoint judges them itself for the 404 to come first.
- **The end-to-end suite's accounts** (`tests/e2e/support.ts`): `CONTRIBUTOR` is `e2e-contributor@harness-bible.local` and `CURATOR` is `e2e-curator@harness-bible.local`, both verified. `signIn` takes what to ask for as a fourth argument; `accountSession(browser, baseURL, name, account)` keeps a session of any of the three, and `readerSession` is a call of it. `tests/e2e/accounts.spec.ts` signs each in through a browser and reads the role back from `/api/v1/me` and from the account page; it leaves no part in the gate's report. The curator has no part on the roster: a flow that needs one sets it with `npm run roster:set` (§ 14).

Verified:

| § 10 | What | Result |
|---|---|---|
| 8 | the production build served by `next start`, the provider unset: `?role=CURATOR`; an e-mail with `role=CURATOR&verified=true`; `?role=emperor`; `?verified=perhaps`; no query | 404 `NOT_FOUND` to each, no cookie, and no account made for the e-mail; `/api/v1/releases/current` on the same server answered 200 |
| 8 | the handler with the provider off (`lib/api/endpoints/authDev.test.ts`) | 404 to six queries; nothing resolved, no session, no audit event |
| 8 | `resolveDevUser` asked for a role or a verification with the provider off, and in production with the switch on (`lib/auth/devProvider.test.ts`) | `FORBIDDEN` each time; the database is not reached |
| — | against the database (`tests/integration/dev-accounts.test.ts`) | a reader as before; a verified contributor and a verified curator made; an account signing in again and asked nothing keeps its role and verification; verification given alone keeps the role and the sessions; a change of role revokes the account's sessions |
| — | through the route, same suite | a verified curator's session and policy subject say curator and verified; a change of role records `role_changed` and leaves the one new session; `role=curator` is a 400 and makes no account |
| — | through a browser on the development server (`tests/e2e/accounts.spec.ts`) | 3 of 3: the contributor, the curator and the reader each read back their own role from the API and from the account page |
| — | the specs that already used the changed helpers (`flows`, `resume`) | 12 flows and 3 resumes, all passing but one flow once (below) |

A production process with `AUTH_DEV_PROVIDER=1` does not start at all (`lib/env.ts`, spec 09 § 8.5; seen in unit 45d), which is why the production check ran with it unset.

**Seen once, cause not established:** `reading-path · en` failed its accessibility check with `document-title` on the screen the flow calls `section on a path`, on the first run after the production build; it passed four runs of four after. It signs nobody in and none of this unit's code is on its path. It is in the tracker's session notes for whoever sees it again.



## 16. As built (the role switch on the account page, 2026-10-05)

Not in § 6.4, and not a unit of the plan: Andre asked for it on 2026-10-05, after unit 46e, so that a development account's role can be changed without typing the address ("for now, just create a switch component in the dev account that allow to switch between roles"; "add this switch to the account subpage").

- **Where.** The account page's Profile panel, in the `role` row. Where the development provider is on, the row is a switch of the five roles with the account's own pressed, followed by the tag `dev`; anywhere else it is what it was, the role as text and `set by the organisation admin`. The page asks `devProviderEnabled()` and passes the answer down, as the sign-in page does for its development button.
- **What a segment is.** A link to the development sign-in of § 15 as this account in that role, returning to the account page in the reader's language (`devRoleHref` in `lib/auth/signIn.ts`). So the switch adds no endpoint, no server action and no second writer of a role: what § 15 says of a change of role holds for it, the revoked sessions and the `role_changed` record included.
- **It says nothing of verification.** The account keeps what it has. A contributor made with the switch from a new development account is not verified, and the policy refuses an unverified contributor (§ 6.2): until a second control is asked for, verification is given by the address (`&verified=true`).
- **The segments are plain anchors, not `Link`s** (`components/account/DevRoleSwitch.tsx`): a prefetched link is followed, and following one changes the role. They carry `aria-current` on the account's role and are grouped under the row's visible label, after the pattern of the search page's sort (`.seg-links`).
- **No new string.** The label is the row's own (`account.profile.role`), the segments are the catalogue's role names (`account.role.*`), and `dev` is the provider's tag as the sign-in page already prints it.
- **On a phone the five segments wrap** inside their frame, onto three rows at 390 px in both languages. Nothing is clipped and the page does not scroll sideways.

Verified:

| What | Result |
|---|---|
| a browser on the development server (`tests/e2e/accounts.spec.ts`, a fourth account of the suite, `e2e-roles@…`) | the five segments in order with the account's role current; a click on `curator` and one back on `reader` each change what `/api/v1/me` and the page say; axe finds nothing on the page |
| the account flow in EN and PT, with its accessibility scan | 2 of 2 |
| the Portuguese truncation suite with the padded catalogue | 34 screens, none with a finding; the account screen 372 labels at 1440 and 335 at 390, seven more than that morning at each width |
| the same session read on a production build under `next start`, the provider unset | the account page answers 200 with the role as text and the administrator's note, no switch, and no mention of the development sign-in anywhere in the page; the switch's own address answers 404 |
| the link's shape (`lib/auth/signIn.test.ts`) | 3 cases: the address, an e-mail that could open a second parameter, and no `verified` |
| seen at 1440 and 390, EN and PT, light and dark | as described above |

## 17. As built (the role switch made whole, 2026-10-08)

Andre, 2026-10-08, on the account page: "as the dev user, i want to be able to mimic all roles, currently this selector is just mocked, it doesn't confirm the role and allow for the correspondent actions." The switch did change the role (§ 16), but it changed nothing else:
- a contributor made with it was not verified, so the policy refused it every suggestion (§ 6.2);
- a curator made with it was on the roster for no part, so it could read nobody's suggestion;
- the page did not say that anything had happened.

Taken on the recommendations, which Andre may reverse:
- **A contributor or a curator is verified by the switch.** `devRoleHref` adds `verified=true` for those two roles, whose actions the policy gives only to a verified identity. The other roles leave verification as the account has it. The unverified state is still reached by the address (`&verified=false`), which the suites use.
- **A development curator curates every part.** Asked for the curator's role, `resolveDevUser` puts the account on the roster for each part it is not on now, from now and with no end, through the one door (`setRosterEntry`), as `npm run roster:set` would. The endpoint logs each row as a `roster_set` event, as the command does, with `idp: dev`. So the development sign-in is now the roster's one other writer (§ 6.3), on the same terms as its writing of a role: only where the provider is switched on, never in production. A row stays when the account becomes another role, and matters only while it is a curator (`partsOf`).
- **The page says what was switched, and what the role can do.** The switch returns to `/[lang]/account?switched=<role>`, and the page then shows `Your role is now contributor. A change of role signs this account's other sessions out.` Under the switch, one line says what the role can do now: a contributor suggests changes, identity verified; a curator reads the suggestions submitted in parts `0, i, ii, iii`; a builder's labs and an organisation admin's pages are not built yet; an unverified contributor or curator is refused, and the line says how to fix it.

Verified:
- **`lib/auth/signIn.test.ts`**: the verification by role, and the return address with `switched`.
- **`tests/integration/dev-accounts.test.ts`**: a curator asked for is put on the roster for every part, once; again, or with no role asked, nothing is begun twice; a contributor is put on no roster; the route logs a `roster_set` for each part, and the session holds them all. The case of § 16 that held a development curator to no parts now holds it to every part.
- **By hand, on an account of its own**:
  - a reader switched to contributor is verified and offered `Create draft` at step 1;
  - as a curator it curates every part, sees the queue's line on Improve, and reads another person's submitted suggestion with no right column;
  - builder and admin each say what is not built;
  - axe finds nothing on the page with the notice, in EN or PT.
