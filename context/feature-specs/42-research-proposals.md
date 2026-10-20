# 42 · Research proposals — feature spec (a finding as a suggestion, its own rules in Improve, proposed or refuted, endorsement, the curator's decision and credit)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: Andre's request of 2026-10-05, steps 5 to 7 ("if the researcher finds something, sends it to the improve agent · the improve agent decides if it is a relevant addition · if it is, it shows the human to approve the improvement to the chapter"; "if the improve feature refutes the output of the research, it is logged, but nothing chages or is proposed") and his answers A1 (the reader endorses, a curator decides), A5 (any signed-in reader may endorse, with consent given on the spot) and A11 (any change class). Spec 27 § 4, which amends the rules about who may contribute and who is credited.

Prerequisite specs: `29` (origin, the policy), `31`, `32`, `33` (the workflow whose two researcher branches are defined here), `36` (the curator's decision), `37` (merge, history, credit), `40`, `41`.

Scope: tracker unit 59 (59a to 59e). Not here: what the reader, the curator and the history page show of all this (spec 43). Built 2026-10-10 (§ 11).

## 1. Purpose

The researcher's findings are worth exactly as much as the process that vets them, and the product already has that process. This spec adds no second, lighter road into the book for a machine: a finding becomes a suggestion and meets every sensor, the same fetcher, the same grader, the same arithmetic and the same adjudicator as a person's. Then it meets two things a person's accepted suggestion does not: the reader who asked, who may sign it, and a curator, without whom nothing a machine proposed can ever be merged.

## 2. Dependencies and order

59a is rules and policy. 59b needs the validated findings of spec 41 and the working workflow of spec 33. 59c, 59d and 59e follow in order.

## 3. What is different about a researcher's suggestion (59a)

Everything not listed here is the same as for a person's.

| | A person's suggestion | A researcher's |
|---|---|---|
| `origin` | `HUMAN` | `RESEARCHER` |
| contributor | a verified contributor who gave consent | none (`userId` null); the actor of its records is `service:researcher` |
| starts as | a draft, written in a form | `SUBMITTED`, created by the research run |
| rationale | the contributor's, read by the adjudicator | the reader agent's note, shown to people, **never given to the adjudicator** (it is text written under the influence of web pages) |
| independence 0.7 | when the source is the contributor's employer | never |
| who pays for grading and adjudication | the contributor's principal | the research principal |
| the adjudicator | may `decide` | may only `recommend`: the policy denies it `decide` (spec 29 § 6.2) |
| after the adjudicator accepts | merged, by a curator's merge | proposed: shown to the asker, placed in the curator queue; merged only after a curator's own accept |
| "request more" | waits for the contributor to revise | refused: nobody will revise it |
| throttle | counts its tier `U` declines | never throttled |
| revision | by its contributor | none |

Amended by feature-specs/48 (unit 74, 2026-10-12): a person's research's finding is sent by its asker, one at a time, and is this table's researcher's suggestion in every respect, its grading and adjudication still the research principal's — the asker is never charged, since the suggestion has no owner and the link from it to its asker runs one way (48 § 7.3). A verified contributor may instead draft a finding of their own research: that is a person's suggestion, the left column, with the proposal prefilled, `fromResearch` set, and the rationale left empty, so the note this table keeps from the adjudicator never reaches it (48 § 8.2, § 8.6).

Invariant 32, new: **a suggestion of origin `RESEARCHER` reaches `MERGING` only by a `curator` record with action `ACCEPT`.** The workflow has no other transition to it, the policy denies the adjudicator the decision, and the gate checks the ledger for a merged researcher suggestion without one (spec 44).

## 4. From a finding to a suggestion (59b)

Step 5 of `ResearchWorkflow`, one valid finding at a time.

### 4.1 The rows

`lib/db/improve.ts` `createFromResearch(finding)` as `service:researcher`, in one transaction: the `Suggestion` (id allocated as any other; `origin`, the class from `classOf`, `proposal`, `proposalKey`, the note as `rationale`, `state` `SUBMITTED`), its `Anchor`, and one `EvidenceItem` of kind `LINK`, state `PENDING`, per source address. Then `ResearchFinding.suggestionId` is set, in the asker's own row.

### 4.2 The sources are opened again

The items are created with an address and nothing else. `SuggestionWorkflow`, started as a child (`suggestion:<id>`), grades them at its step 3: the product's own fetcher opens each address (spec 32 § 4), stores what it got, and the evidence grader reads that. What the provider's tools showed the reader agent is not used for anything after validation. A page that served one thing to the provider's fetch and another to ours is graded on what ours saw; a page that no longer opens is tier `U`.

### 4.3 The same proposal is not made twice

`proposalKey` is the hash of the anchor and the normalised proposal. Before creating a suggestion the step asks whether one with that key already exists, of any origin and in any state but `DRAFT`, made against the same content of the anchor. If so the finding's outcome is `DUPLICATE` and nothing is created. So a proposal a curator declined does not return every month, and one a person already made is not doubled; when the book's text at that anchor changes, the key's context changes with it and the question is open again.

## 5. Proposed or refuted (59c)

The research run waits for each child workflow to reach one of two places, and writes the finding's outcome.

| The suggestion | Outcome | What follows |
|---|---|---|
| declined at intake (a sensor, the floor) | `REFUTED` | `CLOSED`. Its `submitted`, `graded`, `sensors` and `decided` records are in the ledger, as for any suggestion. Nothing is shown to the asker but the run's count (`nothing to propose`), and no curator is asked anything. |
| asked for more by the adjudicator or by rule | `REFUTED` | the same: "request more" is a refusal when nobody can supply more (spec 33 § 6.1) |
| declined by the adjudicator | `REFUTED` | the same |
| a failing consistency sensor | `REFUTED` | the same |
| recommended by the adjudicator | `PROPOSED` | `CURATOR_QUEUE`, group "researcher proposals", deadline 7 days (A15); shown to the asker |
| curator-always class, sensors passed | `PROPOSED` | `CURATOR_QUEUE`, in its reason's own group and deadline, marked as research; shown to the asker |
| the adjudicator failed | `PROPOSED` | `CURATOR_QUEUE` with the failure named, as for a person's |

This is Andre's rule as he wrote it: what Improve refutes is logged and nothing is proposed. The log is the ledger; curators can read it as a list (spec 43 § 7.2), and the asker cannot read the refuted finding at all.

## 6. Endorsement (59d)

`POST /api/v1/proposals/{suggestionId}/endorse` and `DELETE` of the same — any signed-in reader, when the policy's `endorse` on `proposal` finds that the suggestion came from one of their own research runs. 10 a minute. Body `{ consent: true }`.

- **Who** (A5): the reader who asked, whatever their role, without identity verification. Nobody else is offered a proposal, so nobody else can sign one.
- **Consent**: the reader's `provenanceConsentAt` is set if it was null; without `consent: true`, 422 `CONSENT_REQUIRED`. The sentence shown is the one the suggest form uses (spec 34 § 6).
- **When**: while the suggestion is in `CURATOR_QUEUE` or `MERGING`. After the `merged` record, credit is written and the endpoint answers 409.
- **How**: a `ProposalEndorsement { suggestionId, userId, createdAt }` row (additive, in this unit's migration; at most one per suggestion), then the signal `endorsed` to the suggestion's workflow, whose activity appends the `ENDORSED` record with the reader's pseudonym as actor. Withdrawing deletes the row and appends a second `ENDORSED` record with `withdrawn: true`; the ledger keeps both, as it keeps everything.
- **What it changes**: credit, and one line the curator sees. It is not a vote and not a condition: the proposal went to the queue whether or not anyone signs it (A1).

Endorsing makes public, by the reader's own choice, that this reader stands behind this change. It does not publish their question: the run, its brief and the link from question to suggestion stay their own rows.

The credit list may now hold a name whose identity was never verified. The history shows `verified` beside the names that are, and nothing beside the others (spec 43 § 8).

## 7. The curator's decision, and credit (59e)

- **The decision** is spec 36 § 5's, with two segments instead of three: accept or decline. Accepting what the adjudicator recommended is agreement; declining it is an override against the adjudicator, with the criterion disputed and a note (spec 36 § 5.2). Both write a calibration event marked with the origin, so the adjudicator's agreement with curators is measured on research separately.
- **On accept**: `MERGING` and `MergeWorkflow`, exactly as for a person's (spec 37). The check, the curator's `Merge`, the version bump and the release are the same.
- **The `merged` record**: `contributor` null; `endorsedBy` the endorser's pseudonym, or null.
- **Chapter-History**: the row's class cell carries `research`; its contributor cell names the endorser, or holds a dash. The credit list counts it for the endorser. The agent is credited nowhere (invariant 27): `research` says where the change came from, and the evidence column says what it rests on.
- **On decline**: `CLOSED`. The asker's proposal reads `declined by a curator`. The proposal key keeps it from being proposed again while the anchor's text stands (§ 4.3).

## 8. Out of scope

- Other readers endorsing, or a count of endorsements.
- The asker editing the proposal, adding evidence to it, or arguing with the curator. Amended by feature-specs/48 § 8.2 (unit 74, 2026-10-12): a verified contributor's own draft from an unused finding of their research is in scope — a draft of theirs, prefilled, which they edit and add evidence to as any; a proposal already sent stays the curators'.
- A person adopting a refuted finding as their own suggestion. They can write one in the form like anyone. Still out of scope (48 § 23): a finding is used once, drafted or sent, never both.
- Notifying the asker outside the product.

## 9. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | The researcher's note is kept from the adjudicator | yes | it is the one piece of free text in the suggestion that a web page could have shaped and that is not itself the thing under judgment |
| D2 | Sources are re-opened by the product | yes (§ 4.2) | "relevance graded with the source opened" must mean opened by the party that grades, or a model's summary of a page becomes evidence |
| D3 | A duplicate of a declined proposal | never proposed again while the anchor's text is unchanged | a curator's "no" should hold; the alternative is the same item in the queue every thirty days |
| D4 | Withdrawing an endorsement | allowed until the merge | consent that cannot be taken back before publication is not consent |
| D5 | Curator-always findings shown to the asker | yes, like any proposal | A1 and A11 together; the asker sees that it needs a curator and why |

## 10. Verification (in addition to `ai-workflow-rules.md` § 7)

On the stub, with fixture pages, against the engine's test environment.

1. A finding with a tier B source: a suggestion of origin `RESEARCHER` with no `userId`; its item was fetched by the product's fetcher (the test's fetch double was called for it); graded; scored 85; the adjudicator's payload has no note and no origin; the policy was asked `recommend`; the suggestion is in `CURATOR_QUEUE`; the finding is `PROPOSED`.
2. The same with a tier G source: declined at intake with no frontier call; `CLOSED`; the finding is `REFUTED`; the four records are in the ledger; no queue item exists.
3. A finding scoring between floor and accept ends `REFUTED`, not waiting.
4. A finding on a figure with `scenarioParam` goes to the queue's scenario group without an adjudicator call.
5. Invariant 32: a test tries every workflow path with origin `RESEARCHER` and asserts none reaches `MERGING` without a `curator` record of action `ACCEPT`; OPA denies `service:adjudicator` `decide` on it.
6. A second run that produces the same proposal on unchanged text yields `DUPLICATE` and creates nothing; after the anchor's text changes, it creates one.
7. Endorse: the asker succeeds with consent and their `provenanceConsentAt` is set; without consent 422; another reader is refused by the policy; after the merge 409; withdrawal appends a second record.
8. The whole road: question, run, finding, proposed, endorsed, a curator's accept, the check, the merge, a release: the history row shows `research`, the endorser in the contributor cell, the curator, and the record verifies from `submitted` to `merged`.
9. The research principal's ledger has the grading and adjudication rows; the asker's has none.
10. From a suggestion's row and its records there is no path to the asker: a test with a curator's caller cannot obtain the run, the message or the user by any function of `lib/db/improve.ts`, and no ledger record of the suggestion names them unless an `ENDORSED` record exists.

## 11. As built — units 59a to 59e (2026-10-10)

The rules of § 3 that the workflow and the policy apply were built with Improve itself (units 46d, 50a to 50f: the decision paths of origin `RESEARCHER` in `lib/improve/decision.ts`, `recommend` instead of `decide` in the policy, the adjudicator's prompt reading `rationale: none`, no revision, no throttle count). Unit 59a added what was missing of the table: who pays. 59b built the door and the submission, 59c the outcomes, 59d the endorsement (§ 11.7), 59e the curator's two decisions (§ 11.8). What the reader, the curator and the history page show of all this is spec 43's (units 60b to 60e).

### 11.1 The door (§ 4.1)

`createFromResearch(caller, input)` in `lib/db/improve.ts`, for `service:researcher` alone. In one transaction: the suggestion's id from the chapter's counter, as a person's draft takes it; the `Suggestion` row `SUBMITTED` at once — `origin RESEARCHER`, `userId` null, `submittedAt` and `workflowId` set, the proposal, its key, the reader's note as `rationale`; the `Anchor`; one `EvidenceItem` of kind `LINK`, state `PENDING`, per source, with its host. `researchSuggestionStates(caller, ids)` is the one read the researcher has of the rows it made: id, state and outcome, nothing else.

The submission is `workers/research/submit.ts` (`submitStep`), the activity `submitFindings`. Each finding in `found.valid` is parsed again, its anchor resolved against the release again (gone: `INVALID · ANCHOR`), and `submissionOf` builds the door's input: the class by `classOf` as a person's draft has it (rule 3 reads the passage and the proposed text, rule 4 the tier), the parts from the anchor's and its readers', the key by `proposalKeyOf` over the anchor's content hash and the normalised proposal, the https sources once each. Then the finding's row in the asker's context names the suggestion, outcome `SUBMITTED` (a new value of `FindingOutcome`): the one direction the link runs (40 § 3). The activity returns the ids and the workflow starts each `SuggestionWorkflow` as a child under `suggestion:<id>` with `ParentClosePolicy.ABANDON`, so that a curator's decision days later is still the child's to take; a child the engine refuses is logged and its finding stays `SUBMITTED`. The rows and the finding's row are two transactions in two contexts (the door's, then the asker's); a crash between them leaves a suggestion with no finding naming it, which the duplicate rule makes harmless on the next run.

### 11.2 The sources opened again (§ 4.2)

Nothing of this unit: the items are created with an address and the grading workflow's `fetchItem` opens it with the product's fetcher, as for any link. The end-to-end suite proves it by handing the fetcher a double that serves the stub's fixture page and asserting the item graded from what the double served. Spec 43 D9's development fixture fetcher (the stub's `standards.example` pages served to the workers' fetcher by a development-only switch) was not built: this machine runs research on the real provider, whose findings cite real pages the fetcher opens. On the stub, a finding's source cannot be opened, so the stub path refutes every finding and shows no proposal; D9 stays Andre's to confirm before anyone needs the stub path to show one.

### 11.3 The same proposal is not made twice (§ 4.3)

The door asks for a suggestion with the same `proposalKey` in any state but `DRAFT`, of any origin, and answers `{ created: false, duplicateOf }`; the finding's row is `DUPLICATE` naming it. The key holds the anchor's content hash, so a changed text at the anchor opens the question again.

### 11.4 Who pays (§ 3)

The grader and the adjudicator charge a researcher's suggestion to the research principal (`RESEARCH_PRINCIPAL`, 40 § 7.1): `workers/activities/evidence.ts` `researcherPrincipalOf` and `workers/activities/suggestion.ts` `researcherContributor` stand in for the contributor at the three principal reads, with no verified e-mail, so the independence adjustment of 0.7 never applies. A researcher's suggestion on a machine without the principal fails `NO_PRINCIPAL`, non-retryable. The asker's ledger gains nothing (the suite asserts the research principal's rows and the asker's zero).

### 11.5 Proposed or refuted (§ 5)

`workers/research/outcomes.ts` (`outcomesStep`, the activity `findingOutcomes`): for each finding `SUBMITTED` with a suggestion, where the suggestion stands as `service:researcher` reads it — `CLOSED` is `REFUTED`, whatever closed it; `CURATOR_QUEUE`, `MERGING` and `MERGED` are `PROPOSED`; anything else is still deciding. The workflow asks once after the children start and then every `OUTCOMES_EVERY` (30 s) while any finding is still deciding, for at most `OUTCOMES_FOR_MS` (40 days: a wait at the budget's cap can last a month), then ends `DONE`. The `RESEARCH` record is written at that end and carries each finding's outcome. The queue's group, deadline and words for a researcher's proposal are spec 43 § 7's (unit 60d): today the proposal sits in the queue in its class's group.

### 11.6 Verification (§ 10)

- `workers/research/submit.test.ts`: the submission's fields, the class of a restructure, one suggestion per valid finding, `DUPLICATE` and `INVALID · ANCHOR`, `TEXT_PURGED` and `NO_RUBRIC`; the outcomes' mapping and counts.
- `tests/workflows/research.test.ts`: the children started and the outcomes awaited, on doubles.
- `tests/integration/research-run.test.ts`, on the database, the stub and the engine's test server, the Improve activities real: § 10.1 (a tier B source: origin `RESEARCHER`, no `userId`, the fixture page opened by the fetch double, graded B, scored 85, the adjudicator's accept, `CURATOR_QUEUE`, `PROPOSED`, the line counting one proposal, the four records signed by the researcher, the research principal's grading and adjudication rows and none of the asker's); § 10.2 (a tier G source: declined at the floor with no frontier call, `CLOSED`, `REFUTED`, nothing proposed); § 10.9. Not yet run as tests: § 10.3, 10.4, 10.6 (the second run), 10.7, 10.8 and 10.10; 10.5's policy half is unit 46d's suite.
- The engine's test server gives every workflow an execution timeout of ten years as its one timer; a run awaited through the time-skipping client while a child sits parked in the queue sends the clock there, and the child ends `TIMED_OUT`. The suite awaits a run with `resultOf`, which moves the clock one poll at a time (`tests/workflows/environment.ts`).

### 11.7 Endorsement (§ 6; unit 59d)

`POST` and `DELETE /api/v1/proposals/{suggestionId}/endorse` (`lib/api/endpoints/proposals.ts`), any signed-in role, 10 a minute. The policy's resource is `proposal` with `ownerId` the caller when a finding of their own names the suggestion and is proposed (`askerOfProposal`, inside their context; `PROPOSED` only since the review, § 11.11), and nobody otherwise; the policy's `endorse` by owner is unit 46d's, and `read` by owner (43 D7) was added for the panel and the pages to come. The order is the decision endpoint's: `consent: true` or 422 `CONSENT_REQUIRED`; the suggestion read through the door's `readProposalsForAsker` (a researcher's by id, nothing of a person); in `CURATOR_QUEUE` or `MERGING`, else 409 (`MERGED`: the credit is written); the consent on the account first, as the submission has it; the `ProposalEndorsement` row — the asker's own, under the tenant filter, at most one a proposal — then the signal `endorsed` `{ userId, at, withdrawn }` to the suggestion's workflow. A workflow that cannot be told takes the row back: the engine down is the pipeline's 503, an ended workflow 409. A name already there is answered as it stands, with no second record. The withdrawal is the same in reverse: the row gone, the signal with `withdrawn: true` and the consent's instant, the row put back when the workflow cannot be told; 404 where no name was there.

`SuggestionWorkflow` takes the signal whenever it comes, in the queue or while the merge runs, beside the wait rather than in its way: a loop of its own records each by the activity `recordEndorsement`, which appends the `ENDORSED` record — actor `user:<id>`, `{ stepKey, consentAt, withdrawn }`, the step `endorse:<at>` or `withdraw:<at>` — once; the run ends after the last one is recorded. Who stands behind a proposal is read from the records alone, by `endorserOf` (`lib/improve/endorsement.ts`): the latest `ENDORSED` record, unless it withdrew. The merged record's `endorsedBy` and the history's contributor cell use it, so a name taken back before the merge credits nobody (D4).

### 11.8 The curator's decision (§ 7; unit 59e)

Two segments: `decisionOf` refuses `KEEP_REQUEST_MORE` on origin `RESEARCHER` with `NOT_FOR_RESEARCH` (422) before the override rule, and `curatorPathOf` has no path for it (43 D16): an action that reached the workflow all the same is recorded as nothing and the run waits on. `QueueDecision` takes the origin and shows accept and decline alone for a researcher's; its words for a researcher's (§ 7.1 of spec 43: `recommended`, `Accept`) are unit 60d's. The accept and the decline, the calibration event, the merge and its record, Chapter-History's `research` mark and the endorser in the contributor cell were already the merge's and the history's (units 53c, 54c, 54d); this unit made the credit honour a withdrawal.

### 11.9 Verification, continued (§ 10)

- `lib/api/endpoints/proposals.test.ts`: § 10.7 on doubles — the asker is owner and another reader is not; consent; the states; the order and the undo; the second press; the withdrawal.
- `tests/workflows/suggestion.test.ts`: the signal recorded in the queue, the withdrawal after it, one sent with the decision recorded before the run ends, one that names no reader ignored.
- `tests/integration/research-run.test.ts`: § 10.7 end to end on the DONE case — the endpoints' own code with the engine's client the test server's: the row, the two `ENDORSED` records by the asker's pseudonym with the consent's instant, the row gone, the consent on the account, the ledger's six records.
- `lib/improve/curation.test.ts`, `lib/improve/decision.test.ts`, `lib/api/endpoints/curation-decision.test.ts`: `NOT_FOR_RESEARCH`, the path, the 422 before anything is written. `lib/improve/endorsement.test.ts`, `lib/improve/history.test.ts`: the credit after a withdrawal.
- `policies/tests/improve_test.rego`: `read` on `proposal` by its asker and nobody else (73 of 73).
- Not yet run as tests: § 10.8 (the whole road to a release) and 10.10.

### 11.10 Decisions taken on the way

| # | Decision | Taken | Why |
|---|---|---|---|
| D6 | How the run learns a suggestion's place | the run polls the rows every 30 s for up to 40 days | a signal from the child would make the suggestion's workflow know its parent, and nothing else of the suggestion knows the run (40 § 3) |
| D7 | A merge under way or done is `PROPOSED` | yes | the finding was proposed and then accepted; the asker's line counts proposals, and the record page (unit 60e) says what became of each |
| D8 | A child the engine refuses to start | logged, the finding left `SUBMITTED` | the suggestion exists and a worker's restart may start it; the run says so in its log and ends after the wait |
| D9 | What the `endorsed` signal carries, and what the activity reads | the reader's id, the consent's instant, the direction; the activity reads the reader's row again, in their context, before it records (amended by the review, § 11.11) | the record's facts, no text (28 § 5.3); a signal the endpoint took back after the engine had taken it must record nothing, which only a second read can know, as a curator's action is read again before its record |
| D10 | A second endorsement of the same proposal by the same reader | answered as the first; the workflow told again with the row's own instant, which writes the record once (amended by the review) | a retry after a lost answer is not a second consent; told again, it writes a record that never followed, and the step key keeps it to one |
| D11 | Where the endorsement is taken by the workflow | a loop of its own, beside the wait | the signal may come while the merge child runs, when the wait's condition is not being awaited |
| D12 | When names stop | when the curator's merge is taken (its `curator` record of action `MERGE`), not at `MERGED` (the review) | the merged record reads the names from the records when it is written; a name after the merge is taken could miss it, and the history follows the merged record |
| D13 | How many names a proposal takes | 20 records of names given and taken back; past them a new name is refused, a withdrawal never (the review) | each is a signal and steps in the suggestion's workflow, whose history the engine bounds; a scripted toggling could otherwise end the workflow and leave the proposal undecidable |
| D14 | How the run waits for its suggestions | every 30 s for ten minutes, then twice as long each time up to two hours, for forty days; an ask that fails is asked again (the review) | an ask every 30 s for forty days would pass the engine's history limit in under two days, and the server would end the run with nothing concluded |

### 11.11 The review (2026-10-10)

One review of the unit: three lenses (correctness; privacy, authorization and invariants; the API and its failure modes) raised seventeen findings, a skeptic each judged ten of them after the dedupe, eight confirmed and two refuted; three the dedupe had joined to a neighbour were judged by the builder, two real and fixed with the rest, one recorded as a limit. Fixed in one commit:

| # | Finding | Fix |
|---|---|---|
| 1 | The run asked where its suggestions stand every 30 s for forty days: a suggestion waiting at the budget's cap made the run's history pass the engine's limit (51,200 events) in about 39 hours, and the server would end the run — row `SUBMITTING` for good, no `RESEARCH` record (medium) | `nextOutcomesWaitMs`: 30 s for ten minutes, then doubling to two hours; forty days are about five hundred asks (D14). Tested on the time-skipping server over the whole forty days |
| 2 | An ask that failed (the database away a moment) failed the run, with nothing concluded (medium; the builder's) | the ask is caught: the last answer is kept and asked again at the next |
| 3 | A retried `submitFindings` took its own earlier suggestion for a duplicate: the finding overwritten `DUPLICATE`, the suggestion never started (medium) | the step reads the rows an earlier attempt wrote and reuses a `SUBMITTED` one; the door's create and the finding's row are one transaction (`submitFinding`), so a step that dies between them leaves neither |
| 4 | A record of a name or of its withdrawal that failed was dropped, and the credit is read from the records alone: a confirmed withdrawal could still credit the reader (medium) | asked again after a minute, doubling to an hour, as a curator's action is, behind the patch `59-record-endorsement-again` |
| 5 | A signal the engine took after the endpoint's 5 s deadline had passed was recorded although the endpoint took the row back and answered 503 (low) | the activity reads the reader's row again (D9): a name is recorded while the row of that instant stands, a withdrawal only of the standing name of that instant while no row of it stands |
| 6 | A row left without its record (a process dying between the row and the signal) was never repaired: a second press sent nothing (low) | every press tells the workflow, with the row's own instant (D10); an undo takes back only the row the request wrote, by its instant |
| 7 | A name or a withdrawal during the merge's last steps was recorded after the merged record, which then disagreed with the history (low; two findings) | names stop when the curator's merge is taken (D12); the activity records nothing after a merged record; the history takes a merged change's credit from its merged record |
| 8 | Toggling a name was bounded only by the rate limit, and each toggle grows the suggestion's workflow history toward the engine's limit (low) | 20 records of names a proposal (D13) |
| 9 | Two presses at once: the reader's own name answered 409 "carries another name" (low; the builder's) | a unique-key refusal reads the row again and answers the reader's own as standing |

`askerOfProposal` now counts only a `PROPOSED` finding: the policy's owner is the reader of a proposal they are shown, never of a finding still deciding or refuted.

Refuted: that a curator who asked the question, then endorsed and decided the same proposal, approves their own change — the specs let any curator of the part decide a researcher's proposal and the asker endorse it whatever their role, and keeping an endorser from deciding would be a new rule (Andre's to decide; tracker, For Andre to decide); and that the child workflow's parent link in the engine is a way back from the suggestion to the asker — specs 40 § 6.2 and 42 § 4.2 ask for the child, and the engine is the operators', who reach the database the link already lives in.

A limit recorded, not fixed: a proposal left in `MERGING` after its merge child failed has no suggestion workflow to tell, so a withdrawal is refused (409) until a curator's merge or return settles it; the name stands meanwhile, as the panel will say.
