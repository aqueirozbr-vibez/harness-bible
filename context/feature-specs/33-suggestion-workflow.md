# 33 · The suggestion workflow — feature spec (`SuggestionWorkflow`, a change as an edit, the consistency sensors, the adjudicator, the decision, the throttle, the four worked examples)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: PRD Capability 4 (the flowchart and requirements 3 to 9; the four worked examples, pp. 9–10); TRD § 2.3 (the Improve pipeline), § 7.4 (the sequence), § 8 (the adjudicator's column), § 6.3 (adjudication at a budget cap), § 6.4 (the throttle); architecture § 6.1, § 6.3 and invariants 8, 11, 12, 13, 15, 17 and 18; the screens Improve-Adjudication (reasons, sensors, what would suffice) and Curator-Queue (the adjudication panel).

Prerequisite specs: `28` (the engine), `29` (rows, ledger payloads, the policy), `30` (the rubric), `31` (intake), `32` (evidence and its grader).

Scope: tracker unit 50 (50a to 50g). From a submitted suggestion to a decision recorded. Not here: the curator's side of a decision (spec 36 defines the signal this workflow answers), the merge (37), the researcher's rules for its own suggestions beyond the two branches named in § 6 (42).

## 1. Purpose

This is the PRD's flowchart as one durable function: sensors, grading, arithmetic, sensors again, a router, one model call, a decision. Its shape is the book's argument about harnesses: everything deterministic runs before anything that costs a frontier call, and the model is asked only what code cannot settle, then checked by code. A suggestion with a screenshot for evidence must end here without a model having read it.

## 2. Dependencies and order

| Unit | Delivers |
|---|---|
| 50a | the workflow through intake, grading and the floor; `submitted` and `graded` records; replaces the stand-in of spec 31 § 6.4 |
| 50b | a proposal applied to the book's source text, proved by re-parsing (pure) |
| 50c | the three consistency sensors |
| 50d | the router and the adjudicator agent |
| 50e | the decision, the `sensors` and `decided` records, the states, the revision loop, the curator's signal |
| 50f | the throttle; the wait at a budget cap |
| 50g | the four worked examples end to end; the development seed |

## 3. The workflow (50a)

`SuggestionWorkflow({ suggestionId })`, id `suggestion:<id>`, queue `hb-improve`. Every step is an activity that reads and writes through `lib/db/improve.ts` as the service named; arguments and results are ids and enumerations (spec 28 § 5.3).

```
1 record        SUBMITTED row and `submitted` record          service:intake (actor of the record: the contributor's pseudonym, or service:researcher)
2 intake        the four sensors of spec 31 § 5                fail → 9a
3 grade         every PENDING item through fetch and grader    `graded` record; score by scoreOf
4 route         routeOf(class, score, verdicts, strongestTier) DECLINE_AT_INTAKE → 9a · REQUEST_MORE_BY_RULE → 9b
5 sense         derive consistency · cross-chapter · lint      a FAIL → 9a, naming the sensor
6 class         CURATOR_ALWAYS → 9c
7 adjudicate    one frontier call (§ 5)                        failure or inconsistency → 9c
8 decide        the adjudicator's decision                     → 9
9 outcome       a decline by rule · b request more · c curator · the adjudicator's accept, request more or decline
```

### 3.1 A decline that costs nothing

Steps 2, 4 and 5 can end a suggestion with no frontier call (invariant 11). The decision is recorded like any other: an `Adjudication` with `decidedBy: "intake-rules"`, `modelId` null, and one `CriterionVerdict` per criterion built from the grades (the tier with the grader's own reason; relevance, recency, independence and corroboration with their values; the threshold line, `5 < floor 25`), which is what the Improve-Adjudication screen shows for `S-23-0412` under "intake rules · rubric v1.2". The `decided` record carries usage zero.

### 3.2 Grading inside the workflow

A person's items were graded as they were added (spec 32 § 8), so step 3 usually finds nothing pending and only records. A researcher's items arrive ungraded and are graded here, by the same activities. Either way the `graded` record lists every item with its tier, factors, adjusted score, the sha256 of the text that was graded and of the grader's reason.

### 3.3 The score is recomputed here

`Suggestion.score` is written by step 3 from the rows, by `scoreOf`, whatever the form displayed. The TRD asks for "one SQL statement"; this build computes it in `lib/rubric` from rows read in one transaction, because the corroboration rule needs the publisher comparison of spec 30 § 3.3 and the same function must serve the preview. Recorded as a deviation.

## 4. Consistency

### 4.1 A change as an edit (50b, `pipeline/edit/`)

Two later things need to know what the book would look like with the change in it: the lint sensor, and the merge. So the change is applied by one pure function, written once:

`applyProposal(files, anchor, proposal) → { files, touched: [{ path, before, after }] } | { refused: reason }`

- It takes the chapter's source files as the content pipeline reads them and returns them edited. It locates the anchor with the pipeline's own parser, run in a mode that reports where in the source each section, figure and source row begins and ends; it does not search the text for the anchored words.
- **It proves itself.** After the edit it parses the result and compares the rows with the rows before: they must differ at the anchor and, for a source row that figures read, at those figures, and nowhere else. Any other difference refuses the edit (`refused: "unexpected-change"`, naming the row).
- It never writes to disk and never touches a repository. Spec 37 commits what it returns.
- `RESTRUCTURE` has no automatic edit: it returns `refused: "manual"`, and a curator makes the change by hand in the merge (spec 37 § 4.3).

The unit starts by reading the parser and reporting what locating an anchor needs from it; if the parser cannot report positions without a change to how it parses, that change is proposed as its own unit first (rules § 2.6).

Reported on 2026-10-07 (§ 13): a section's and a source row's places needed only offsets the parser found and dropped; a figure's needed a map from the rendered paragraph back to the file, since the figure grammar reads rendered HTML. Andre chose to build that first, as unit 50b's part 1; `applyProposal` is part 2.

### 4.2 The sensors (50c, `lib/sensors/consistency.ts`)

| Sensor | Checks | Results |
|---|---|---|
| `DERIVE_CONSISTENCY` | a derived figure changes only with its script (invariant 5): the suggestion's tier A run changed `DeriveLink.filePath`, and the run's printed value is the proposed one | `NA` for anything but a derived figure; `PASS`; `FAIL` |
| `CROSS_CHAPTER` | the anchored figure or row is read elsewhere: figures bound to the row, the same figure in another chapter, cross-references to the anchor | `PASS` when nothing else reads it; `WARN` listing every other anchor (`F-23-06 also at 37.4 — a change would need both`), and adding their parts to `Suggestion.parts` so those parts' curators see it; `FAIL` only when the proposal would leave two readings of one shared figure that the edit cannot reconcile |
| `LINT` | `applyProposal` succeeds: the chapter parses with the change and nothing else moved | `PASS`; `FAIL` with the refusal; `NA` for `RESTRUCTURE` and for any other `manual` refusal (Andre, 2026-10-07, § 14) |

How the release marks a figure as shared is read from the data, not assumed: 50c first counts, on release 2026.09, what each of the three rules of `CROSS_CHAPTER` finds, and fixes the rule with those counts in its report.

A `WARN` never declines. It is shown to the contributor, the adjudicator and the curator, and the merge honours it (spec 37 § 5.3).

## 5. The adjudicator (50d)

### 5.1 The agent

| | |
|---|---|
| Guide | `guides/adjudicator/v2.1/`, the first version here, numbered as the screens and the TRD number it; it holds the four override codes (spec 36 § 5.2) because the screen says "codes come from the adjudicator guide v2.1" |
| Model | `hb-frontier`, purpose `adjudication`, request row `adjudicator` (numbers set in the unit under the delegation of 2026-09-24) |
| Prefix, byte-stable | 1 the guide · 2 the rubric's thresholds · then per call: 3 the anchored text · 4 the proposed change · 5 the graded evidence · 6 the sensor verdicts |
| Identity | `service:adjudicator`; the policy is asked `decide` (a person's suggestion) or `recommend` (a researcher's) before the call, and a deny sends the suggestion to a curator |
| Cap | one attempt; failure → curator queue (invariant 15) |

### 5.2 Its input is assembled from what was recorded

"The adjudicator's input is assembled by the workflow from ledger rows, never from the request" (TRD § 7.4). The ledger carries hashes of text, so the assembler (`workers/agents/adjudicator/assemble.ts`) reads the suggestion's rows and **checks each piece of text against the hash its ledger record holds** (`proposalSha256`, `rationaleSha256`, each item's `reasonSha256`) before using it. A mismatch is a failure, and the suggestion goes to a curator with the mismatch named.

What it contains: the anchored text at the current version; the proposal; for each item its kind, tier, the three factors, the adjusted score, whether it was opened, and the grader's reason; the score and its arithmetic; the seven sensor verdicts; the rationale of a person's suggestion; `contributor: { verified }`, or `null` for a researcher's.

What it never contains (invariant 12, held by a contract test on the payload): a name, an e-mail address, an organisation, an employer, a user id, another suggestion, a curator's note, the evidence documents themselves, the origin of the suggestion, the reader whose question started a research run.

The proposal, the rationale and the grader's reasons are text written by a stranger or derived from a stranger's document. They are fenced as data in the prompt, as the grader fences a document.

### 5.3 Its output

```ts
{ decision: "ACCEPT" | "REQUEST_MORE" | "DECLINE",
  criteria: [{ name: "tier" | "relevance" | "recency" | "independence" | "corroboration" | "threshold",
               verdict: string, reason: string /* at most 30 words */ }],   // exactly one per name
  sufficientTier?: EvidenceTier,      // with REQUEST_MORE
  failingSensor?: SuggestionSensor }  // with DECLINE by a sensor
```

### 5.4 Checked by code

1. Strict parse; six criteria, one per name.
2. `consistent(...)` (spec 30 § 4.4): it cannot accept under the threshold, with a failed sensor, or a derived figure without tier A; it cannot ask for more under the floor.
3. A `sufficientTier` must be one `wouldSuffice` lists.

What is left to the adjudicator is the judgment the arithmetic cannot make: whether the proposed change says what the evidence supports, no more. So it may decline or ask for more at a score that would allow acceptance, with its reason; it can never go the other way. Any failure of 1 to 3 is its one failure.

## 6. The decision (50e)

### 6.1 What each outcome does

| Outcome | A person's suggestion | A researcher's suggestion |
|---|---|---|
| declined by rule (a sensor, the floor) | `INTAKE_DECLINED` or `CLOSED`; the page names the sensor or shows what would suffice | `CLOSED`: refuted |
| request more by rule (the derived class) | `CURATOR_QUEUE`, group "request more · for inspection" | `CLOSED`: refuted |
| curator always | `CURATOR_QUEUE`, grouped by reason | `CURATOR_QUEUE`, and shown to the reader (spec 42 § 5) |
| the adjudicator accepts | `MERGING`: `MergeWorkflow` starts as a child (spec 37) | `CURATOR_QUEUE`, group "researcher proposals", and shown to the reader: never merged on the adjudicator's word (invariant 32) |
| the adjudicator asks for more | `CURATOR_QUEUE`, group "request more · for inspection"; the contributor may revise | `CLOSED`: refuted |
| the adjudicator declines | `CLOSED` | `CLOSED`: refuted |
| the adjudicator fails | `CURATOR_QUEUE` with the failure named | the same |

Every row writes the `sensors` record (the verdicts that exist by then) and the `decided` record, in that order, each once (spec 28 § 4.4).

### 6.2 The records

`submitted` → `graded` → `sensors` → `decided`, as the Improve-Record timeline lists them. An intake failure at step 2 writes `submitted`, `sensors`, `decided`.

### 6.3 The curator's signal

While a suggestion is in `CURATOR_QUEUE` the workflow waits for `curatorDecision({ actionId })` (spec 36 § 5). On it, an activity appends the `curator` record and the calibration event in one step (invariant 17), then: accept → `MERGING` and the merge; keep request more → `DECIDED`, waiting for a revision; decline → `CLOSED`. A signal for a suggestion not in the queue is ignored and logged.

### 6.4 Revision

`revised()` from spec 31 § 6.5 runs steps 2 to 9 again as attempt n + 1. The step keys include the attempt, so the second pass writes its own records and the chain shows both. `Adjudication` and the criterion rows hold the latest; the ledger holds all.

### 6.5 When the workflow ends

At `CLOSED` or `MERGED`. A person's suggestion left at "request more" stays open, waiting on its contributor or on a curator, with no timer to close it: no source gives a lifetime for one, and the queue's seven-day deadline (spec 36 § 3.3) is what brings a curator to it.

## 7. The throttle and the cap (50f)

- **Throttle.** After every decline of a person's suggestion an activity counts that contributor's suggestions declined in the last 30 days whose every evidence item was tier `U`. At three it sets `User.throttledUntil` to 30 days from now (TRD § 6.4). A decline on tier G does not count ("S-23-0412 was graded G, not U. It does not count", the screen). The researcher is never throttled; its share of `U` items is a number of its dashboard (spec 44).
- **The cap.** The grader's and the adjudicator's calls are charged to the contributor's principal (kinds `GRADING`, `ADJUDICATION`, `ref` the suggestion id), or to the research principal for a researcher's suggestion. When the gateway refuses for budget the activity returns the reset date and the workflow sleeps until it; the suggestion says `waiting for budget · resets 01 Nov` where its state is shown. The 24-hour target counts from the reset (TRD § 6.3).
- **Timing.** "Decision under 10 minutes for automatic classes" and the 24-hour completion target are measured from the records' timestamps (spec 39), not enforced by a timer: a timer could only mark a suggestion late, which the timestamps already say.

## 8. The four worked examples (50g)

The gate's first criterion (overview § Success criteria · Phase 4). Each example is a fixture in `tests/fixtures/improve/` and an integration test that runs the real workflow against the engine's test environment, the stub gateway, and a fetcher given the fixture's documents.

| # | Suggestion | Evidence | Must end |
|---|---|---|---|
| 1 | a cited date in 36.3 | one item, tier B, direct, 9 days old, independent | score 85; accepted by the adjudicator; `MERGING` (the merge and the patch bump are spec 37's test) |
| 2 | a cited figure in chapter 23 | one upload, a screenshot, tier G | score 5; declined at intake; **zero rows in the gateway's ledger for the frontier model**; `wouldSuffice` names B and D |
| 3 | a derived decision aid in 22.8 | a tier A run fixture, partial relevance | score 60; request more by rule, naming a tier A run on the chapter's lab |
| 4 | a cited price in 15.9 | tier C from the vendor concerned (56) and tier D, five months old (42) | score 66; request more; `sufficientTier` D; in the queue for inspection (the override with `OV-IND-02` is spec 36's test) |

The values in the screens (2 Aug 2026 → 2 Dec 2027; 2.4× → 1.3×; $0.30 → $0.25) are the design's samples; the PRD gives none. The fixtures anchor to what release 2026.09 really holds at those places and propose a change to it; where the release has no such anchor, 50g names the nearest one it used and why.

The stub gateway learns two answers: the evidence grader's (a tier and classifications chosen by a header the fixture sets, as the scope classifier's cause is) and the adjudicator's (the decision the arithmetic allows, with six reasons).

`npm run improve:seed` writes the four as suggestions in the development database, so the pages of specs 34 to 36 have something to show before anyone has submitted anything.

## 9. Out of scope

- A lifetime for a suggestion left at request more (§ 6.5).
- A second adjudication attempt, a repair pass, or a second model's opinion.
- Notifying the contributor by e-mail (spec 35 D3).

## 10. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | Every request more goes to the queue for inspection | yes | the Curator-Queue screen has the group, with `S-15-0377` in it, and the PRD's fourth example ends in a curator accepting on inspection |
| D2 | What the adjudicator may do at an accepting score | decline or ask for more, with its reason; never the reverse | PRD: "the agent's score decides only what the rubric can decide"; the arithmetic is code's, the fit of the change to the evidence is the judgment |
| D3 | The adjudicator is not told a suggestion came from research | not told | it should judge the change and the evidence; "from a machine" is a prior, not evidence |
| D4 | The score in code, not in one SQL statement | code | § 3.3 |
| D5 | The 24-hour target as a measure, not a timer | a measure | § 7 |

## 11. Verification (in addition to `ai-workflow-rules.md` § 7)

1. The four examples of § 8 pass against the test environment, each asserting its state, its score, its records in order and the chain's verification from the first record to the last.
2. Example 2: the stub's request log holds no `hb-frontier` call for that suggestion (invariant 11).
3. A suggestion whose anchor was removed by a newer release is declined at step 2 with `ANCHOR_EXISTS`, recorded.
4. `applyProposal`: each change kind on a fixture chapter; a proposal that would move an unrelated row is refused; the output re-parses to rows that differ only where they should. Its tests run without a database or a repository.
5. `CROSS_CHAPTER` on a shared figure returns `WARN` and widens `Suggestion.parts`.
6. The adjudicator's payload contract test: a fixture contributor's name, e-mail, organisation and employer domain appear nowhere in the request the stub received; nor does the origin.
7. An adjudicator output that accepts at 66 against 70, that omits a criterion, or that names a tier `wouldSuffice` does not list sends the suggestion to the queue, recorded as the adjudicator's failure.
8. A text in the suggestion's row changed after `submitted` was recorded is caught by the assembler's hash check.
9. The workers killed between steps 3 and 4 and restarted: one `graded` record, not two.
10. Three declines on tier `U` in 30 days set `throttledUntil`; a fourth create answers 429; a decline on tier G does not count.
11. With the principal at its cap, the workflow sleeps and resumes when the test's clock passes the reset.
12. OPA denies `service:adjudicator` `decide` on a `CURATOR_ALWAYS` suggestion and on a researcher's; the workflow routes both to the queue without calling the model.

## 12. As built (unit 50a, 2026-10-06 and 2026-10-07)

§ 3 as written for steps 1 to 4, in two parts (rules § 3.1): the door's, the ledger's and the budget's functions first (spec 29 § 12), the workflow second. Andre decided three things on 2026-10-06: the workflow **ends after step 4** with the route in its result, and the suggestion stays `SUBMITTED` until unit 50e's decision moves it; the intake activity **may learn the contributor's id**, to sign the `submitted` record; the `graded` record's **usage is the suggestion's grading calls**.

- **The workflow** (`workers/workflows/suggestion.ts`, replacing 48d's stand-in under the same name, id, queue, signal and `WORKFLOWS` entry): 1 `recordSubmitted`; 2 `runIntake`, a `FAIL` ending it with `DECLINE_AT_INTAKE` and the sensor; 3 each id `pendingItems` names through the grader's three activities in the order the items were added (`grading.ts`, shared with GradeEvidenceWorkflow so their numbers are written once), a grade the budget refused ending it with no route (50f's wait), then `recordGraded`; 4 `routeSuggestion`. Its result is `{ suggestionId, state, route, failingSensor, namedTier, score }`, the score with no ceiling of 100: a strongest item at 100 with the corroboration bonus scores 110 (30 § 3.3). `revised` is taken and does nothing yet. The grader's activities are called directly and not as a child workflow: § 3.2 says "by the same activities", and a child could not take an `evidence:<itemId>` id that is still running. The score and the route are computed in activities, since workflow code may import no `lib/rubric` (its lint rule).
- **The activities** (`workers/activities/suggestion.ts`, each as the service § 3 names and idempotent on the row and the ledger): `recordSubmitted` (`service:intake`) makes the move out of draft when the endpoint has not — a move the door now makes only for a verified, consenting contributor (invariant 25; 29 § 12), and allowed the moment the workflow runs, because the endpoint now puts the consent given at submission on file before it starts the workflow (31 § 6.2, as changed by this unit); `STILL_A_DRAFT` (retryable) is left for a contributor whose verification or consent is gone in between — and appends the `submitted` record, signed `user:<id>` (`contributorIdOf`) or `service:researcher`, `verified` true for a person and null for a researcher's; `runIntake` (`service:intake`) runs the four sensors on `intakeFactsOf` with the anchor resolved again, writes their verdicts as rows (`writeSensorVerdicts`) where the detail stays, and returns `{ sensor, result }`; `pendingItems` names the pending ids in order; `recordGraded` (`service:grader`, which the record's rules require) reads the rows in one transaction, scores them as the view does (`gradedItemsOf`, `scoreOf`, the suggestion's own rubric checked against its published hash), appends the `graded` record and only then writes the score (`writeSuggestionScore`), so the row follows the ledger, refusing a suggestion no longer `SUBMITTED` (`NOT_SUBMITTED`) and a model's grade whose stored object is gone (`TEXT_MISSING`) rather than record it as having read nothing; `routeSuggestion` (`service:intake`) is `routeOf` with the same checked rubric and this attempt's four verdicts, never the `Threshold` rows (30 § 13).
- **The records' forms**, permanent, and recomputed by the adjudicator's assembler (50d): the step key is `sha256(workflowId + ":" + step)`, the step `<kind>:<attempt>` — `submitted:1`, `graded:1`; `proposalSha256` the sha256 of the stored proposal's RFC 8785 canonical JSON, the ledger's own form; `rationaleSha256` of the rationale as stored, with `rationaleWords` by `countWords`; each item's `reasonSha256` of its reason as stored, and its `contentSha256` the store's hash of the object under its `text` key — what the grader read, since 49f — or null when it has none; `usage` the gateway's `GRADING` rows whose `ref` is the suggestion, since its last `graded` record, under the contributor's principal (`gradingUsageOf`); `traceId` one per attempt, minted by the workflow — it names only the record, since each grade made on add had its own; 50d and 50e are to use the attempt's id for the calls the workflow itself makes; an item's host only when the record's host form takes it (a bracketed address or a trailing dot is recorded null, and the row keeps it).
- **Append once** (`workers/activities/ledger.ts`): the step's record is looked up by its key (`recordAt`) and appended only when there is none; a payload or columns refusal fails for good, anything else is the engine's retry. The look and the append are two statements, so an attempt that outlives its timeout while still running could append beside its retry (Open Questions).
- **The numbers**: `runIntake`, `pendingItems` and `routeSuggestion` 5 s and three attempts — a few reads and at most one write of rows, the work the proving workflow's reads and the submit's first move were given those for (28 § 12; 31 § 6.4); the two steps that append, `recordSubmitted` and `recordGraded`, 60 s and three, the grader's own store step's numbers: they wait on the chain's lock, a transaction bounded at 2 s for a connection and 5 s once held and twice on a race, so an attempt the engine times out is not still appending beside its retry; the grader's three keep 60 s/3, 60 s/3 and 120 s/1. Recorded for Andre to confirm, as 45b, 48d and 49e recorded theirs.
- **Left to 50c–50f**: steps 5 to 9; 9a and 9b with § 3.1's intake-rules `Adjudication` and its criteria; the states past `SUBMITTED`; the `sensors` and `decided` records; the revision loop; the wait at a budget cap. Until then every submitted suggestion ends `SUBMITTED` with its verdicts, its score and its two records, and nothing resumes it when 50e lands; a step-2 failure shows its failing verdict on a suggestion that is still submitted.
- **Items still pending at step 2** (Andre, 2026-10-07, option A): the workflow's `EVIDENCE_PARSES` asks each item only for what its kind needs (`requireGraded` false; the submit endpoint keeps requiring every item graded), and step 3 grades what is still pending before the score — a researcher's items, which arrive ungraded, and a person's item added while the submission was under way, which would otherwise have been declined at intake while it was being graded. The review of 50a found the conflict between 31 § 5 and § 3's order; this settles it. An item whose own grading workflow is still running when step 3 reaches it may be graded by both, the second finding it graded or writing nothing: the cost of one grade, at most.
- **A researcher's suggestion** has its branch in step 1 (`service:researcher`, `verified` null) and nothing else yet: `gradeItem` refuses a suggestion with no contributor until the research principal exists (59b).

Verified:

| § 11 | What | Result |
|---|---|---|
| — | the workflow on Temporal's test server (`tests/workflows/suggestion.test.ts`, 9 cases, replacing the stand-in's 4) | steps 1 to 4 in order with a pending item through fetch, store and grade — the stand-in's one activity is not among the doubles, so the first case fails against it; the graded record's step with the workflow's id, attempt 1 and a trace id of its own; the route asked with step 3's score and tier and step 2's verdicts; a failing sensor ending it with no grade, score or route (invariant 11); an unopened item and one with nothing to read taken no further; nothing pending; a budget refusal ending it with no record; a rule's route with its tier; the signal; the first step tried again; a bad argument asking nothing |
| 3, 9 | the activities against the database, the ledger and the store (`tests/integration/suggestion-workflow.test.ts`, 7 cases, chapter 95, holding the ledger's lock) | step 1: the move and the record once with every field, signed `user:<id>`, `verified` true, a bracketed host recorded null; an unconsenting contributor's draft, and an unverified one's, left a draft, retried, nothing recorded; a missing suggestion not retried. Step 2: four verdict rows; an anchor the release no longer has fails `ANCHOR_EXISTS` (§ 11.3); the anchor resolved by its own kind and id in the suggestion's locale (a figure, in Portuguese); an item still pending passes by its form and is named for step 3 (option A); a draft has no step 2. The pending items in order. Step 3: the score the view's, the `graded` record once though the step ran twice (§ 11.9), each item's hashes, the usage asked of the contributor's principal; a second attempt's record under its own key, counting the calls since the first's; a pending item and a rubric file not the one published refused, nothing recorded. Step 4: the route by the rubric; a failed verdict declines at any score |
| — | the helper (`workers/activities/ledger.test.ts`, 4 cases) | the step key; a record found is answered and nothing appended; one appended when none; a payload's or the columns' refusal not retried, a conflict left to the engine |
| — | the endpoint against the real engine (`tests/integration/suggestions.test.ts`, the dev workers restarted on 50a's code) | the submit's workflow run by the workers to `{ state: SUBMITTED, route: ADJUDICATE, score: 56 }` for a wording change with one item graded C, its `submitted` record signed by the contributor's pseudonym and its `graded` one by the grader; no gateway row |
| — | the endpoint (`lib/api/endpoints/suggestions.test.ts`) | the consent given now on file, then the start, then the move, in that order; none recorded when it was on file |
| — | part 1 (commit 825e133) | the table and the door's refusals, invariant 25, the verdicts and the score, the lookup, the usage, the shared helpers: 12 cases |
| — | the review | four lenses — the records, the engine, the door and the invariants, the tests — over both parts, each high or medium finding put to a skeptic: 28 findings, many reported by more than one lens. **Fixed in this unit**: a suggestion could be left `SUBMITTED` with no records when the endpoint's move with the consent committed after step 1 had given up (confirmed; now the consent is on file before the start, so the workflow's own move is allowed at once); step 1's 5 s under the append it waits on (rated high, confirmed; the two appending steps now have 60 s, over the append's own bounds); the score written after the record without checking the suggestion was still submitted, and a model's grade recorded as having read nothing when its stored object was gone (both now refused); the result's score capped at 100 though corroboration reaches 110 (no cap); five gaps in the tests (a refused host recorded null, a second attempt's record and its `since`, the anchor's kind, id and locale, an unverified contributor held back as an unconsenting one is, the consent before the start). **Recorded, not fixed**: the look and the append in two statements (a migration or the protected append); the step-2 sensor that fails a pending item before step 3 could grade it (confirmed; a conflict between specs 31 and 33, Andre's, to settle with 59b); a run that fails after the row moved leaves it `SUBMITTED` with nothing to drive it again (50e); the usage read under today's principal; a revised rationale against the first `submitted` record (50d); the trace id that names only the record; the view's own cap of 100 |
| — | the whole suite | `npx tsc --noEmit` 0; `npm run lint` 0 warnings; without a database 1,694 passed and 261 skipped in 180 files (the rows suite's known failure aside); with the database, the engine and the store, purge excluded, 179 files and 1,938 tests passed, 17 skipped, on the second run; the first lost one case of the policy suite to the sidecar's deadline, the known first-run flake, which passed alone straight after (an earlier pair of runs had lost two of the assistant's cases to records these suites appended before they held the ledger's lock, and once the telemetry edition-gap case, its third sighting); `npm run test:ledger` and `npm run test:rubric` 100 %; `npm run build` 0; `npm run secrets:scan` 0 findings |

**Not verified**: a worker killed between steps 3 and 4 on the real engine (the test server cannot restart a worker on the same queue; § 11.9 is proved at the activity, the step run twice leaving one record); a researcher's suggestion (unit 59); a budget refusal at step 3 on the real engine (unreachable for a person: a pending item fails step 2 first).

## 13. As built (unit 50b, part 1: the parser's positions, 2026-10-07)

§ 4.1's report first, then the change Andre chose on it ("parser unit first").

- **What the parser knew.** `parseChapterFile` found each `## NN.k` heading by its offset and kept only the trimmed text between two of them; `parseSourceRows` filtered the table's lines and lost their numbers; the figure grammar reads rendered paragraph HTML, three steps from the file — the fences lifted out with their caption lines, marked's render (characters escaped as entities, a blockquote folded into one paragraph), the build's `<p>` regex. A section and a row needed only the offsets the parser dropped. A figure needed a map through the renderer: a change to how the parser works, though not to what it produces.
- **Built**: `buildChapter(file, book, { positions: true })` returns `ChapterPositions` beside its rows (`pipeline/build.ts`), offsets into the file's text:
  - each section's heading line and its markdown (`ParsedLayer.heading` and `.body`, computed on every parse now; an empty section's body just after its heading), null where the file has none — a prose-only chapter's headings, its Sources;
  - each Sources row's line and its cells trimmed, from the one table walk `parseSourceRows` itself reads (`sourceRowSpans`), with the row ids the database uses (`NN.9 rK`);
  - each figure's printed value, `at`, or null with the reason the file does not hold it as one run of text.
- **How a figure is found** (`pipeline/parse/sourceMap.ts`, `proseOrigins`): marked keeps no positions, so the map is made in three steps, each checked. Every token is placed by its `raw`, which must stand at that place character for character, a blockquote's or a list item's lines through their prefixes. The markdown is rendered again by the build's own renderer — one factory now, `proseMarked`, whose leaf hook is the identity for the build — with each leaf's HTML between private-use markers. Each leaf's HTML is aligned with its raw text through the entities marked writes and the numeric references it reads, and a character is mapped only where the markdown holds the character it renders. `liftFences` keeps where each character of its output came from (`origin`), and `figurePass` where each figure's value sits in the paragraph's HTML (`spans`). A render that differs from the build's maps nothing; a token or a leaf that cannot be placed maps to nothing; neither is ever a guess.
- **Beside the rows, never in them.** The rows feed the content hash: a position on a row or a figure would have given every chapter a new version at the next ingest. Ingestion does not ask for positions.
- **Why not a search for the value**: 1,021 of the book's 2,201 figures, 46 %, print a value that stands more than once in their own section, and a number can stand in a link's target or in inline code; § 4.1 asks for the parser's own reading.
- **Left to part 2**, `applyProposal` (`pipeline/edit/`): the edits and their proof by re-parsing, and five questions that are Andre's before it is built, each with its options and a recommendation in the tracker's Open Questions (from a read-only map of the parser and the change kinds made for this unit): whether an edit that adds a figure may renumber the chapter's later ones (a figure's id is its ordinal in the chapter, and 1,021 of the book's 2,201 figures, 46 %, print a value that stands more than once in their own section, so a figure cannot be matched by its value); whether a figure's label and the chapter's standfirst may change with an edit in their paragraph; which figures may change the row they read when a row is edited or added; what is done with the fields the file has no place for (`EDIT_ROW`'s `value`, a day where the Verified cell holds a month, an added row's date, `fastMoving`, a new tier); and the refusal reasons besides `unexpected-change` and `manual`. The positions mode is additive: part 2 may add a paragraph's span if its answers need one.

Verified:

| § 11 | What | Result |
|---|---|---|
| — | the whole book before and after (41 chapters of `../bible`) | every chapter's content hash equal to a record taken before the change, with positions asked for and without; the release's render hash recomputed with this code from the same book tree (`3b30415f…`) equal to the one recorded when 2026.09 was ingested (`38ec2533…`, invariant 2); 362 sections, 407 source rows and 2,201 figures placed, each span holding exactly its text; no figure left unlocated |
| — | each position proved by an edit (a scratch run over the whole book; the test over chapter 21) | a figure's digits changed at its span, a word added to a row's claim cell or at a section's end: the rebuilt chapter reads the edit in that row, and no other figure's id or value, row's claim or section's text changes (a neighbouring figure's label, the words around a number, may change with it) — 2,201 figures, 407 rows, 325 sections. Two faults of the check, not of a position: its first rotation turned 11.0 into 22.1, which the figure grammar reads as a section reference, and left 25 values of zeros alone unchanged; it now keeps zeros and gives a value of zeros a 7, so every value is changed and keeps its shape |
| — | the source map (`pipeline/parse/sourceMap.test.ts`, 7 cases) | entities; emphasis, strong, inline code, an escape, a link's text but not its target; a numeric reference and raw HTML; a blockquote's lines and a loose list's; CRLF; the renderer's own markup mapped to nothing; nothing mapped when the render differs or the text holds a marker |
| — | the parser's pieces (4 cases added) | the layers' heading and body, an empty layer, a prose-only chapter; the rows' lines and cells, a CRLF table and an empty cell; where the lifted text came from; the figure pass's spans |
| — | the build (`pipeline/positions.test.ts`, 5 cases) | chapter 21: positions only when asked and no row changed; every span; every figure, row and section proved by an edit; the whole book, when it is checked out: no hash changed and nothing unlocated |
| — | the review | an adversarial review in three lenses (wrong positions, the build unchanged, the contract and the tests), each finding put to a skeptic, ran beside the verification. Its one finding before this commit was real and is fixed here: an image's alt text was placed by searching its raw text, which finds the `!` of `![!](…)` before the alt text's own; a token's text is now placed where its syntax puts it (`textAt`), with a test. The rest of its result finished after part 1's commit, and its confirmed findings are fixed in 50b's follow-up commit: a numeric reference that marked decodes into a marker character (`&#xE002;`) shifted every later origin of its section, so a figure could take another figure's place and pass every check, and in a table cell made the build throw (confirmed, medium; now the map refuses a render that holds a marker and reads each leaf by its own length); one text leaf of more than about 125,000 characters overflowed the stack (low; no spread now); the edit proof's claim was wider than its check, and 25 values of zeros alone (`0`, `00`) were never changed by its rotation (low; the claim now says what is checked, and every value is changed); a module-level arrow function and an American spelling (low; fixed). Not upheld: a position for an empty Sources table (an `ADD_ROW` there is refused as `manual`), and a guard on the rendered bytes (the markdown and figures suites pin them). Over 70,000 random inline strings, 28,000 documents and 600 synthetic chapters it found no other wrong position |
| — | the whole suite | `npx tsc --noEmit` exit 0; `npm run lint` exit 0 with no warning; `npx vitest run` without a database 1,711 passed and 261 skipped in 182 files (the rows suite's known failure aside), and the pipeline's 108 again after the review's fix; `npm run build` exit 0; `npm run secrets:scan` 0 findings. Not run: the database suites, which take from the pipeline only `sha256` and the figure grammar's expressions, both unchanged; `test:ledger` and `test:rubric`, whose folders this unit does not touch |

## 14. As built (unit 50b, part 2: `applyProposal`, 2026-10-07)

§ 4.1 on part 1's positions (§ 13), with Andre's five answers of 2026-10-07 ("next, use your recommendations"; the tracker's Open Questions, "50b part 2").

- **The function** (`pipeline/edit/apply.ts`): `applyProposal(files, anchor, proposal, options?) → { files, touched } | { refused, row, detail }`. `files` is the book as the content pipeline reads it (`loadBook`'s `BookFiles`); the anchor is its kind and id (`21.3`, `F-21-07`, `21.9 r4`), which name the chapter; `touched` is each file changed, by its path in the book's repository, whole before and after. The fourth argument, `{ on }`, is the day a row is verified — the decision's day in a merge (37 § 4.1 step 2), the run's in the lint sensor: a departure from § 4.1's signature that decision 4 made, since a row added needs a date and the proposal carries none.
- **One splice per proposal**, located by the positions. `EDIT_TEXT` replaces its passage, found once in the located section's text as the intake `SCHEMA` sensor counts it (`occurrences`). `ADD_CLAIM` joins its paragraph after a passage that ends a sentence — past the closing marks a reader does not quote, a bold run-in's `**`, and never inside a word, inline code, a link or a table row — or stands as a paragraph of its own at the section's end. `SET_VALUE` rewrites the figure's printed value in the figure's own shape (`45%` → `50%`, `1 s` → `2 s`, `$0.05` → `$0.07`, `7,500` → `8,000`, `02` → `05`), four digits and more grouped as the book groups them. `EDIT_ROW` writes the cells the proposal names, the day given — the decision's, which wins over the proposal's `verifiedOn` (37 § 4.1 step 2) — or else its `verifiedOn`, as the book's `Mon YYYY`, a DOI as its doi.org link in the Link column. `ADD_ROW` puts a row numbered next after the last, dated by the day given.
- **The proof** (`pipeline/edit/prove.ts`): the chapter is built again from the edited file and compared with the chapter before. The sections the edit is not in read as they did — text, words, code, references, diagrams, and their HTML but for figure ids; each source chip names the row it named, but a chip that named no row may name a row added. In the section the edit is in, code, diagrams, captions and sub-headings must stay as they were, or the edit is `manual`. Figures are matched by their place in the file across the splice, so an id the edit shifted is not a difference (decision 1). A figure's label may change in the paragraph the edit is in — the blank-line block of the file around it — and the standfirst with an edit in the first layer (2). No figure changes its tier, derive link, value or the row it reads, but the figure a value was set on, which must read the new value, and figures no row read before, which a row added may take (3). Rows are matched by their number; the edited or added row must read what the proposal names. A figure the edit did not write is a difference.
- **Refusals** (decision 5), each naming the row with a one-line detail: `manual` where no automatic form exists — a restructure; a derived figure, a scenario parameter of the lab, a derived figure the lab does not print, or one whose tier follows its value, since its value changes with the lab's script (invariant 5); a figure without a proven place, or that is a piece of a longer number; a value the grammar does not read where it stands; an edit that reaches code, a diagram, a caption or a sub-heading; a pipe or a line break written into a table row; a unit changed, a negative value, a row's value, a new tier, a cell that would hold a pipe or a line break, a link the table has no column for or the Link cell would cut (a last `)`, `.`, `,`, `;` or `]`), a URL and another DOI on one row, a row added with no day or to a chapter with no Sources row, a claim with a line break, in the middle of a sentence or a word, in inline code, a link or a table row, in the Sources section, or at the end not reading as a paragraph (a heading, a list, a fence, a link definition, an italic line a fence would take for its caption), and an `EDIT_TEXT` in the Sources section, whose rows a row's edit or a row added changes; `unexpected-change` for every failure of the proof; `does-not-parse` when the chapter fails to parse before or after the edit or renders outside the reader vocabulary; `not-found` when the files lack the anchor, or the quoted passage once. 50c's `LINT` answers `NA` for `manual`, as for `RESTRUCTURE` (§ 4.2, as changed by decision 5).
- **Recorded, not done**: `fastMoving` on a claim or a row added is neither written nor compared — the book's flag is the one the parser computes (decision 4); in chapters 00 to 33 the registry's verify date overrides every row's, so a `verifiedOn` changes the cell's text and not the row's date (54b's); a shared figure edited in every chapter that reads it is 37 § 4.1 step 3's, which calls this once per chapter; a revert (37 § 6) is a proposal with before and after exchanged, which `EDIT_TEXT` and `SET_VALUE` take as they are.

Verified:

| § 11 | What | Result |
|---|---|---|
| 4 | `pipeline/edit/apply.test.ts`, 14 cases on chapter 21, no database or repository | each change kind applied and the output built again: a passage reworded, the standfirst with it; a value in the figure's shape (`75,000` → `80,000`) and every other figure as it was; a claim at a section's end whose figure shifts every later id, and one joining its paragraph; a row's claim and its month; a DOI's link and the day given; a row added and numbered next, taking the figures `(illustrative)` gave no row. Refused: a citation reworded so that four figures would lose their row, a tier taken from a sentence's numbers, a claim whose parenthetical would retier its paragraph's other figures (`unexpected-change`, each naming the figure); each `manual` of the list above; a passage absent or twice, an unknown figure, another chapter (`not-found`); an `ftp:` link and a `javascript:` link (`does-not-parse`) |
| — | the whole book (`../bible`, a scratch run) | every figure that is not derived given a new value (its first digit rotated, its shape kept), 1,619 of them: 1,068 applied and proved, and 551 refused as `manual` — 409 derived figures the lab does not print, 119 scenario parameters of the lab, 22 pieces of a longer number, one figure whose tier follows its value; every row's claim reworded, 407 of 407 applied and proved. No ordinary edit was refused as a fault |
| — | the review | two lenses (the edits and the proof; the contract and the tests), each finding put to a skeptic; 13 confirmed and fixed in 50b's follow-up commit. High: a reworded citation was applied while chips in other sections changed the row they named, since the proof compared only figures' rows (each chip is now compared). Medium: a claim could land inside a bold run-in, inline code or a caption (it now steps past the closing marks a reader does not quote, and is refused inside a word, code, a link or a table row); the edited section's code, diagrams, captions and sub-headings could change (now `manual`); a value set on a piece of a longer number garbled it (`128` of `128,000-token`; now `manual`); a pipe written into a table row shifted its cells (now `manual`); a URL the Link cell cuts, or a URL and DOI differing in case, was refused as a fault (now `manual`); a scenario parameter set to another value its script names was applied while the derived figures computed from it stayed (now every scenario parameter of the lab, and every derived figure the lab does not print, is `manual`). Low: zero padding (`08:5`) and the book's grouping (`2000`, which a parenthetical can read as a year) are kept now; a value the grammar does not read where it stands (`66.1`, read as a section reference) is `manual`; an italic claim a fence above would take for its caption, and a link definition, are refused at a section's end; the proposal's `verifiedOn` gave way to the decision's day as 37 § 4.1 step 2 says; the label allowance and the other sections' HTML were untested (both are now). Not upheld: `ADD_ROW` refused on the six chapters whose table has no row yet (by design, `manual`); CRLF files (the book is LF); `on` optional (documented); an unreachable guard's bare `Error`. Part 1's review finished after part 1's commit, and its confirmed findings are fixed in 50b's follow-up commit (§ 13). Before it, the whole-book run found one fault, fixed here: a value set on a figure whose tier follows its value under a derived tag — 104 scenario parameters, 42 derived figures the lab does not print, one illustrative number in an "arithmetic derived" sentence — was refused as `unexpected-change`; it is `manual`, since the value changes with the lab's script (invariant 5), so `LINT` answers `NA` rather than decline at step 5 a suggestion whose class sends it to a curator |
| — | the whole suite | `npx tsc --noEmit` exit 0; `npm run lint` exit 0 with no warning; `npx vitest run` without a database 1,723 passed and 261 skipped in 183 files (the rows suite's known failure aside); `npm run build` exit 0; `npm run secrets:scan` 0 findings. Not run: the database suites, `test:ledger` and `test:rubric`, which nothing here touches |

## 15. As built (unit 50c, part 1: the consistency sensors, 2026-10-07)

§ 4.2's three sensors as pure functions (`lib/sensors/consistency.ts`), and `CROSS_CHAPTER`'s rules as pure functions over the release's rows (`lib/improve/readings.ts`), fixed from the release as § 4.2 asks. Part 2 runs them as the workflow's step 5.

**What each rule finds on release 2026.09** (the book whose tree hash is the release's):

| Rule | Found |
|---|---|
| 1 · figures bound to a row | 124 of 407 rows read by figures (906 readings), 41 of them from two sections or more |
| 2 · the same figure in another chapter | the same id elsewhere: none, since an id carries its chapter; the same lab key in two chapters: none; the same value and label in two chapters, with no chapter named: 43 groups, mostly chance (`2%`); a figure whose own tier parenthetical names another chapter: 20, of which 11 that chapter prints the same value — and where it prints the value more than once (six `8`s in chapter 4) which is meant cannot be read |
| 3 · cross-references to the anchor | 195 references to sections (147 sections; 42 of them from another chapter), none to a row; 1,175 mentions of a whole chapter |

**The rules as fixed**: (1) a row is read by the sections of the figures bound to it; (2) a figure is the same figure as one in another chapter when one's own tier parenthetical — the chip in its sentence, which the figure grammar tiered it by — names the other's chapter, both print the same value, and the chapter named prints it once: 17 figures in 9 pairs on the release, among them `8×` (10.2, 37.2), `629` (16.2, 28.3) and `2,000`, which 04.7 and 37.1 both cite from 16.7; (3) a section or a row is read by the other sections that refer to it. A mention of a whole chapter is not a reading of any anchor in it.

- **`DERIVE_CONSISTENCY`**: `NA` for anything but a derived figure; `FAIL` for a derived figure unless a tier A run changed `derive.py` and printed the value proposed — every derived figure in this build, which refuses a lab run as evidence until the IDE (32 § 3); the router has sent such a suggestion to ask for more before step 5 in any case (30 § 4).
- **`CROSS_CHAPTER`**: `PASS` when nothing else reads the anchor; `WARN` naming every other reading in the screen's words (`F-23-06 also at 37.4 — a change would need both`) with the parts to add to `Suggestion.parts`; `FAIL` only for a value set on a figure whose other reading cannot take it — a derived one — which no shared figure of the release is.
- **`LINT`**: on `applyProposal`'s answer (§ 14): `PASS`; `FAIL` with a refusal that is a fault; `NA` for `RESTRUCTURE` and any other `manual` refusal (decision 5 of 50b), and when the files read are not the release's.
- **Over the release**: sections 242 `PASS` and 120 `WARN`; figures 2,184 `PASS` and 17 `WARN`; rows 283 `PASS` and 124 `WARN`; no `FAIL`.

Verified: `lib/sensors/consistency.test.ts` and `lib/improve/readings.test.ts`, 13 cases — each sensor's results on facts; the chips of chapter 21 (`17:42`'s two figures both tiered by `(scenario, ch16)`); each rule, a figure a chapter prints twice not counted, a derived reading that cannot be set; the rules and the sensor over every anchor of the book, by a scratch run, as above.

## 16. As built (unit 50c, part 2: step 5, 2026-10-07)

`SuggestionWorkflow` runs step 5 for a route that goes on — `CURATOR` or `ADJUDICATE`; `DECLINE_AT_INTAKE` and `REQUEST_MORE_BY_RULE` end at step 4, as § 3 has them — and a `FAIL` ends it as a decline by rule naming the sensor (`route: DECLINE_AT_INTAKE`, `failingSensor`), as at step 2. The workflow then ends and leaves the suggestion `SUBMITTED`: steps 6 to 9 are 50d's and 50e's.

- **The activity** (`runConsistency`, `workers/activities/suggestion.ts`, as `service:intake`, which writes step 2's verdicts too): it reads the suggestion and its proposal, the release's rows the three rules read (`releaseReadings`, `lib/db/anchors.ts`: a row's bound figures and the references to it; a section's references; for a figure, every figure printing its value, with the chapters each one's chip names), and the book's files where the book is kept (`BOOK_DIR`); runs part 1's sensors; writes their three verdicts as rows; and adds to `Suggestion.parts` the parts a `WARN` names (`widenParts`, the door's, once each, on a suggestion still `SUBMITTED`). It returns `{ sensor, result }` only.
- **The files are the release's or none.** `LINT` applies the change to the files read only when their tree hash is the release's `gitSha` (the pipeline's own hash, 04 § 6.7), so the edit is proved on what was released and not on a book that has moved on; otherwise, or when there is no book, it answers `NA`, with that as its detail. A row is dated by the run's day (50b's decision 4).
- **The numbers**: 60 s and three attempts, those of the steps that do more than a few reads: it reads the book from disk and builds the chapter twice besides its rows, a few seconds on this machine. Recorded for Andre with the workflow's others.

Verified:

| § 11 | What | Result |
|---|---|---|
| 5 | the activity against the database (`tests/integration/suggestion-workflow.test.ts`, 1 case added) | the three verdicts written as rows; nothing reading the anchor and no files: `PASS` and `NA`, with the detail; a section of another part referring to it: `WARN`, and the suggestion's parts widened to `P2, P3`, once however often it runs |
| — | the workflow on Temporal's test server (`tests/workflows/suggestion.test.ts`, 2 cases added, 4 changed) | step 5 after a route that goes on, to the adjudicator or a curator, never after a request for more; a `FAIL` declines by rule naming `LINT`; a `WARN` does not |
| — | the endpoint against the real engine (`tests/integration/suggestions.test.ts`, the dev workers restarted on this code) | the submit's workflow ran steps 1 to 5: on the real chapter 21, `DERIVE_CONSISTENCY` `NA`, `CROSS_CHAPTER` `PASS`, `LINT` `PASS` — the change applied to the release's own files and proved (the run's history, read from the engine) — and the result as before, `ADJUDICATE` with no failing sensor |
| — | the whole suite | `npx tsc --noEmit` exit 0; `npm run lint` exit 0 with no warning; with the database, the engine and the store, purge excluded, 185 files and 1,987 tests passed, 17 skipped, on the first run; `npm run build` exit 0; `npm run secrets:scan` 0 findings |

## 17. As built (unit 50d, part 1: the adjudicator agent, 2026-10-07)

§ 5 as an agent with no caller yet; part 2 is steps 6 and 7 in the workflow, the policy's question and the rows.

- **The guide** (`guides/adjudicator/v2.1/guide.md`, pinned `ed45d968…`): what is code's and what is the adjudicator's — it may decline or ask for more at an accepting score, never the reverse; one verdict and a reason of at most 30 words on each of the six criteria; every stranger's text fenced as data; the answer's form; the four override codes, which it never uses and the curator's screen reads from it (36 § 5.2).
- **The prompt** (`workers/agents/adjudicator/assemble.ts`): § 5.1's slots — the guide and the rubric's thresholds, byte-stable and cached, then the anchored text, the proposal, each item with its tier, its three factors, its adjusted score, whether it was opened and the grader's reason, the score's arithmetic (the score, the class's acceptance and floor, the item that decides it and the one that corroborates it, the tiers that would suffice), the seven sensors, a person's rationale and `contributor: verified`, or `none` for a researcher's. Its parameter type has no field for anything § 5.2 forbids, so nothing that names the contributor, nor the origin, can reach it (invariant 12); a fenced text's own closing tag is broken, so it cannot close its fence. `recordedMismatch` checks the proposal, the rationale and each grader's reason against the hashes their `submitted` and `graded` records hold (the forms of § 12) and names the first that is not.
- **The output** (`parse.ts`, `adjudicate.ts`): § 5.3's object, strictly — six criteria, one per name; a tier that would suffice with a request for more and only then; a failing sensor only with a decline — then code's checks: `consistent` (spec 30 § 4.4), a tier the arithmetic lists, a sensor that did fail. Any failure, of the gateway, the provider, the parse or a check, is the agent's one failure, named; a budget refusal is thrown for 50f's wait.
- **The request row** `adjudicator` (`lib/gateway/policy.ts`, under the delegation of 2026-09-24): `hb-frontier`, the unstreamed ceiling of 16,000 tokens so thinking cannot cut the answer short, medium effort, one attempt (invariant 15), 120 s, since the workflow and not a reader waits; the call is purpose `adjudication`, charged to the contributor's principal with the suggestion as `ref` (§ 7).
- **The stub's adjudicator** (`infra/gateway/stub/answer.ts`, § 8): the decision the prompt's arithmetic line allows, with six reasons; `x-hb-stub-adjudicate` forces a decision, five criteria, a key it may not have or prose, for code to refuse.

Verified: `workers/agents/adjudicator/adjudicate.test.ts`, 9 cases on the stub gateway started in the process — the slots and the cached prefix; a stranger's closing tag; each recorded text's hash; the strict parse; the checks, among them § 11.7's acceptance at 66 against 70; the call charged as `ADJUDICATION` with the suggestion as `ref`; each failure named; a budget refusal thrown; and § 11.6, the request holding no contributor's name, address, organisation, employer domain or origin.

## 18. As built (unit 50d, part 2: steps 6 and 7, 2026-10-07)

§ 3's steps 6 and 7 in `SuggestionWorkflow`, on part 1's agent (§ 17). The workflow then ends and leaves the suggestion `SUBMITTED`, its decision in the rows: steps 8 and 9 — the states, the `sensors` and `decided` records — are 50e's.

- **Step 6.** A `CURATOR` route, a class no score decides, ends after step 5 with no model asked (invariant 13), and its result has no decision.
- **Step 7** (`adjudicateSuggestion`, `workers/activities/suggestion.ts`, as `service:adjudicator`), for an `ADJUDICATE` route:
  - **the policy first** (§ 5.1): `decide` for a person's suggestion, `recommend` for a researcher's, on the curation resource with its parts, class and origin. A refusal by the rules is the curator's, with no call and no row. A policy that could not be asked — the sidecar unreachable, or an answer that is not one — denies (invariant 23) but refuses nothing: that is the adjudicator's failure, named, with no call;
  - **what was recorded** (§ 5.2): this run's `submitted:1` and `graded:<attempt>` records, found by their step keys; the proposal, the rationale and each grader's reason checked against the hashes they hold, and the score computed from the rows against the recorded one. A missing record, a text or a score that does not match, or an anchor the current release no longer has, is the adjudicator's failure, named, with no call (§ 11.8);
  - **the prompt from the rows**: the anchor's text and fast-moving flag as the release has them now (`resolveAnchor`, as step 2 reads it); the items in the order they were added, with their factors — `none` for an item never opened, a change to part 1's type — adjusted scores, whether opened, and reasons; the arithmetic by the suggestion's own rubric, checked against its published hash: the score, the class's acceptance, floor and single tier, the items that decide and corroborate it, `wouldSuffice`'s tiers; the seven sensors as their rows say; a person's rationale and `contributor: verified`, and neither for a researcher's (42 § 3);
  - **the call** is charged to the contributor's principal, with the suggestion as `ref` and the attempt's trace id, the graded record's (§ 7, § 12). `contributorIdOf` now tells `service:adjudicator` the contributor's id for that alone, a third caller beside the grader and the intake activity, which § 7 requires. The id is in the request's `metadata.user_id`, the gateway's spend attribution, and never in the prompt;
  - **the answer is written as rows** by the door's new `writeAdjudication`: the `Adjudication` and its criteria, over any it had, in one transaction, on a suggestion still `SUBMITTED`, by the adjudicator or the intake rules. The first write under an attempt's trace id stands, and a second under it changes nothing. The row holds `decidedBy: adjudicator`, the score, the thresholds, the guide's version and hash, the model, the prompt's hash and the trace id, with either:
    - the decision, the tier that would suffice and the six criteria; or
    - `CURATOR_REVIEW`, with the failure named in a new column, `Adjudication.failure`. Migration `20261007120000_adjudication_failure` adds it, with a check that a failure goes only with `CURATOR_REVIEW`. It is what the curator's queue shows for "an adjudicator's failure" (36 § 3.1).

    Only `{ outcome, decision, sufficientTier }` crosses the engine (28 § 5.3);
  - **a budget refusal** writes nothing: the workflow ends with no decision, for 50f's wait.
- **The activity's own failure.** It has one attempt and 180 s: the call's 120 s, and a minute for its reads and its write. A second attempt would be a second frontier call. If it throws or runs out of time, the workflow catches the failure and runs `recordAdjudicatorFailure` (60 s, three attempts). That writes the failure by its code (`the adjudication did not finish (TIMEOUT)`), unless the attempt's own row is already there; when loading the guide or the rubric is what failed, it writes the failure without them. It answers what the attempt's row then says, which is the activity's decision when the activity wrote one before the engine gave up on it. Should even that fail, the workflow still ends at the curator, with the failure unwritten. So every failure of step 7 ends at a curator (invariant 15), and the result never contradicts the row.
- **The result** gains two fields:
  - `decision`: `ACCEPT`, `REQUEST_MORE` or `DECLINE`; `CURATOR_REVIEW` for a failure or a refusal; null where no adjudicator was asked or the budget waits;
  - `sufficientTier`.
- **Part 1, corrected.** Guide v2.1 asked for a verdict "in a few words", but the `decided` record takes a value with no space (29 § 13, and the tracker's open question named 50d's guide for it). Now:
  - the guide asks for that form;
  - `parse.ts` enforces the record's own expression;
  - the stub answers `graded` and `56>=40`.

  The guide is pinned again (`9139b776…`): no adjudication had been made with it.
- **The suite on the real engine now submits a curator-always change.** The development workers call the real gateway, so an adjudicator's route there would be a frontier call, and that suite calls no model (spec 31 § 10.8). The adjudicator's route is proven on the test server, and against the database with the stub gateway.
- **The one real call** (Andre, 2026-10-07: "you can test with a real model call, once") was made after this part's commit, on the development workers, which call the real gateway.
  - **What went in**: a wording change of 21.3 (`Retries are not optional at eleven steps.` → `Retries are required at eleven steps.`), by a verified, consenting contributor of the demo organisation, with one vendor item written already graded (C, 56) so that no grader was asked.
  - **What came out**: S-21-0619 ran steps 1 to 7 in 10 s. The seven sensors passed, `LINT` on the release's own files. `hb-frontier` accepted at 56 against 40 and code's checks passed. Its six criteria came in the record's form (`C`, `direct`, `stable`, `0.8`, `none`, `56>=40`), each reason within thirty words.
  - **What was written**: the row and the criteria, with the guide's hash and the prompt's. One gateway row, `ADJUDICATION`, charged to the demo organisation's principal under the attempt's trace id: 1,218 input, 552 output and 1,854 cache-write tokens, $0.031.
  - **The model** the row names is the gateway's alias, as every call through the gateway records it (spec 11). The alias named `anthropic/claude-opus-5` in the gateway's configuration that day.
  - **Left in the development database** as the run's record: the suggestion, and the check's account, `adjudicator-check@harness-bible.local`, in the demo organisation.
- **Found for 59b**: for a researcher's suggestion the prompt would read `contributor: none` and `rationale: none`, which says where it came from. Yet § 5.2 lists the origin among what the prompt never holds, and D3 says the adjudicator is not told, while § 5.2 itself asks `null` for a researcher's contributor. It cannot happen yet: the activity has no principal for a researcher's suggestion until 59b, which settles it.
- **Left to 50e**:
  - the states and the records;
  - the `decided` record's rule that the adjudicator's decision carries its guide, its model and its prompt. As it stands, it does not take a failure's row from before any model answered, which has no model, nor one from before the prompt was built, which has no prompt;
  - a revision's attempt checks its rationale against the `submitted:1` record, so a revision that changes the rationale needs its hash recorded first.

Verified:

| § 11 | What | Result |
|---|---|---|
| 6, 7, 8, 12 | the activities against the database, the policy sidecar and the stub gateway started in the process (`tests/integration/suggestion-workflow.test.ts`, 4 cases added) | A wording change at 56 against 40 accepted: its row and six criteria written with the guide's hash, the model and the prompt's hash; one call charged to the contributor's principal as `ADJUDICATION`, with the suggestion as `ref`; the prompt holding the seven verdicts and the rationale, and nothing that names the contributor or the origin. A rationale changed after its record failed by name, with no call. Five criteria from the stub failed by name, with the model recorded and no criteria. A curator-always change refused by the policy, with no call and no row. A budget refusal writing nothing. The activity's own failure written by its code, and not over the attempt's row |
| — | the workflow on Temporal's test server (`tests/workflows/suggestion.test.ts`, 3 cases added, 6 changed) | step 7 asked with the graded record's run, attempt and trace id; a curator's route ending at step 6; a request for more with its tier; a decline; the curator for a failure or a refusal; no decision while the budget waits; one attempt, and a thrown failure recorded by its code |
| — | the door (`tests/integration/improve.test.ts`, 1 case changed) | the adjudicator told whose suggestion it is; the merge and the researcher not |
| — | the endpoint against the real engine (`tests/integration/suggestions.test.ts`, the dev workers restarted on this code) | a curator-always change through steps 1 to 6: `{ route: CURATOR, score: 56, decision: null }`, and no gateway row |
| — | the one real call | as above: accepted, its criteria in the record's form, code's checks passed, one `ADJUDICATION` row, $0.031 |
| — | the review | One short review of 50c and of both parts of 50d; it ran nothing. It found four defects, all in step 7's failure paths, fixed in the follow-up commit with 2 cases added and 1 changed:<br>1. When the activity's write landed but its completion was lost, the failure recorder kept the row, yet the workflow still answered the curator. It now answers what the attempt's row says.<br>2. An attempt that outlived its timeout could overwrite the failure recorded after it. The first write of a trace now stands.<br>3. The recorder needed the guide and the rubric whose loading may be what failed. It now writes without them.<br>4. A policy that could not be asked was taken for a refusal, with nothing written. It is now the adjudicator's failure, named.<br>It also found the researcher's prompt above, for 59b. 50c's code and the new tests read correct, each test able to fail |
| — | the whole suite | `npx tsc --noEmit` exit 0. `npm run lint` exit 0, no warning. With the database, the engine and the store, purge excluded, 185 files and 2,003 tests passed, 17 skipped, on the second run; after the review's fixes, 185 files and 2,005 tests passed, 17 skipped, on the first run. The first run lost two cases to the tests' own expectations, both fixed before the second: the door's pin on who learns the contributor's id, and a check that counted the request's spend attribution as the prompt. `npm run build` exit 0. `npm run secrets:scan` 0 findings |

## 19. As built (unit 50e, part 1: the decision recorded, 2026-10-07)

§ 6.1 and § 6.2 for every way a run ends: whoever decided, the decision's rows, its two records and the moves to where it leaves the suggestion. The workflow then ends; the waits — the curator's signal and the revision — are part 2.

- **Who decides.** What crosses the engine is who decided (`Decided`), and the rest is read from the rows:
  - the intake rules: a failing intake sensor (step 2), the floor or the derived class's rule (step 4), a failing consistency sensor (step 5), with the decision a rule makes and what it rests on;
  - the router: a class no score decides (step 6), and a policy that refused the adjudicator;
  - the adjudicator: its decision, or its failure, as step 7 left its row.
- **The decision's rows.**
  - A rule's decision is an `Adjudication` of its own, `decidedBy: intake-rules`, with six lines built from the grades as § 3.1 has them (`ruleCriteria`, `lib/improve/decision.ts`): the strongest item's tier with the grader's own reason; its relevance, recency and independence (`1.00`); the corroboration's bonus (`+10`, or `none`); the score against the thresholds (`5<25`, `56>=40`), with a reason naming the floor, the acceptance, the class's one tier or the failing sensor. With no item above zero, each line says so.
  - The adjudicator's rows are step 7's. Should that step have left none, its failure is written here.
  - The router's decision has no row, since no adjudicator saw it (36 § 4).
- **The records**, once each per attempt and in that order (§ 6.2):
  - `sensors:<attempt>`, by `service:intake`: the verdicts that exist by then — four after step 2 or 4, seven after step 5 — the suggestion's parts, and `detailSha256`. That is the sha256 of the canonical JSON of each verdict's sensor and detail, in the sensors' order (`detailSha256Of`).
  - `decided:<attempt>`, by `service:adjudicator` for the adjudicator's decision and its failure, by `service:intake` for a rule's and the router's. It holds the row's decision, thresholds, tier and sensor; each criterion's verdict with its reason as a hash; the guide, the model and the prompt; and the tokens. The tokens are the adjudicator's `ADJUDICATION` rows since the attempt's `graded` record (`adjudicationUsageOf`), and zero for a decision no model made.
  - **The record's rule, changed:** it takes the adjudicator's failure (`CURATOR_REVIEW`) with what it had — a guide that loaded, a prompt that was built, a model that answered. It still wants all three with the adjudicator's decision, and none with a rule's. The tracker's open question named 50e for this; no `decided` record had been written.
- **The moves** (`pathOf`; the door's new `moveAlong`, one conditional `UPDATE` along a path whose every hop the table has). Steps 1 to 7 run while the suggestion is `SUBMITTED`, so the decision makes the moves, through `GRADED` and `SENSED` where the run reached them. Where each decision leaves a suggestion:

  | Decided | A person's | A researcher's |
  |---|---|---|
  | a decline by rule | `INTAKE_DECLINED`, which may be revised | `CLOSED` |
  | a request for more by rule | `CURATOR_QUEUE` (the table gains `SUBMITTED → CURATOR_QUEUE`) | `CLOSED` |
  | the router | `CURATOR_QUEUE` | the same |
  | the adjudicator's accept | `DECIDED`: `MERGING` is a running `MergeWorkflow`, 54b's | `CURATOR_QUEUE` (invariant 32) |
  | its request for more | `CURATOR_QUEUE` | `CLOSED` |
  | its decline | `CLOSED` | the same |
  | its failure | `CURATOR_QUEUE` | the same |

  The move sets `outcome` and `decidedAt`, and `closedAt` with `CLOSED`. A step run again finds each part done and moves nothing twice. A grade or an adjudication the budget refused decides nothing, and the suggestion stays `SUBMITTED` (50f).
- **Decided here, on the spec's tables, for Andre to see:**
  - every decline by rule leaves a person's suggestion `INTAKE_DECLINED`, a consistency sensor's included. § 6.1 reads "`INTAKE_DECLINED` or `CLOSED`", and `CLOSED` is taken as a researcher's;
  - a person's accepted suggestion waits in `DECIDED` for the merge (54b), rather than being `MERGING` with no merge running;
  - the router's decisions have no `Adjudication` row.
- **The result**: `state` is where the decision left the suggestion, and `decision` is the `decided` record's — a rule's, the router's `CURATOR_REVIEW`, or the adjudicator's. It is null only while the budget waits.
- **Left to part 2**: the waits. Until part 2, the workflow ends at the decision, and a revision's submit answers 409, "its workflow has ended", as it already did.

Verified:

| § 11 | What | Result |
|---|---|---|
| — | the decision, pure (`lib/improve/decision.test.ts`, 5 cases) | every path, for each decider, decision and origin, made of the table's moves from `SUBMITTED`; each end as § 6.1 puts it; the six lines for the PRD's screenshot at 5 against 25, for a corroboration, a request for more by rule, a sensor's decline and no item above zero, each verdict in the record's form and each reason within thirty words; the sensors' hash independent of the rows' order |
| — | the activities against the database (`tests/integration/suggestion-workflow.test.ts`, 4 cases added) | a floor decline: the intake-rules row and its six lines, the `sensors` and `decided` records' every field, `INTAKE_DECLINED` with its outcome and day, nothing twice when run again; a failing intake sensor: `submitted`, `sensors`, `decided` and no `graded`, the line naming the sensor; the adjudicator's accept: `DECIDED`, the record with the guide's hash, the model, the prompt, six criteria and the tokens asked of the contributor's principal since the graded record; the router: the queue with no row; the adjudicator's failure: the queue, recorded with the guide it had and no model or prompt |
| — | the workflow on Temporal's test server (`tests/workflows/suggestion.test.ts`) | every ending records its decision by who made it — the intake rules at steps 2, 4 and 5, the router at step 6 and for a refusal, the adjudicator for its decision and its failure — under the attempt's trace id, and says where it left the suggestion; nothing recorded while the budget waits |
| — | the endpoint against the real engine (`tests/integration/suggestions.test.ts`, the dev workers restarted on this code) | the curator-always change: `CURATOR_QUEUE`, `CURATOR_REVIEW`, and its four records, `submitted`, `graded`, `sensors` and `decided` |
| — | the vocabulary and the records (`lib/schemas`) | the new move; the `decided` rule taking the adjudicator's failure, and not a rule's guide |
| — | the whole suite | `npx tsc --noEmit` exit 0; `npm run lint` exit 0, no warning; with the database, the engine and the store, purge excluded, 186 files and 2,014 tests passed, 17 skipped, on the first run; `npm run test:ledger` exit 0, its coverage held; `npm run build` exit 0; `npm run secrets:scan` 0 findings |

## 20. As built (unit 50e, part 2: the waits, 2026-10-07)

§ 6.3 to § 6.5: after its decision the workflow waits where a person may still act, with no timer, and ends where nothing will.

- **What it waits for** (`waitsFor` in the workflow):
  - in `CURATOR_QUEUE`, for `curatorDecision({ actionId })`, the decision endpoint's signal (53c);
  - where the suggestion takes new evidence — `INTAKE_DECLINED`, or a request for more in `DECIDED` or the queue (`takesRevision`, one predicate in `lib/schemas/improve.ts` for the submit endpoint, the workflow and its activity) — for `revised`.

  A `waits` query answers which, and null while an attempt runs or at an end. **Every signal is kept, whenever it comes**, and taken where it applies — an action in the queue, a revision where the suggestion takes one — and its activity judges whether it does:
  - an action must be of this visit, made since the suggestion entered the queue (`decidedAt`);
  - a revision must answer the decision that stands. The `revised` signal carries the `decidedAt` the submit endpoint read (`RevisedSignalSchema`), which is each decision's own time on a real clock.

  A person may act the moment a decision's move is committed, before the run has seen it. A signal then arrives with the activity's completion, or during a retry of up to a minute, and is not lost. An action or a revision that does not apply, and a step of the waits that fails, leave the run waiting (`orNull`), so that a run which waited weeks is not lost to one bad row.
- **Where it ends**:
  - `CLOSED`;
  - an accept, whose merge is unit 54b's: `MERGING` from the queue, the one exit the table has for a curator's accept; `DECIDED` from the adjudicator (§ 19);
  - a grade or an adjudication the budget refused, which leaves the suggestion `SUBMITTED` with nothing decided (50f).
- **A curator's decision** (`recordCuratorDecision`, as `service:intake`). It reads the action through the door's new `readCuratorAction`, which hands the note out as its hash and the curator as an id. Then:
  - it records nothing for an action of another suggestion, one that is no queue's decision (a merge, a revert), one made before this visit began, one whose code or criterion the record does not take (`CuratorPayloadSchema`; the endpoint, 53c, refuses them), or a suggestion no longer in the queue whose action it has not recorded and moved;
  - it appends the `curator` record: signed `user:<curatorId>`, step key `curator:<actionId>`, the note as its hash, and the part — the first of the suggestion's parts the curator's roster held when they acted, since the action row has no part;
  - it writes the `CalibrationEvent` (`writeCalibrationEvent`), with the adjudicator's decision and score only where the adjudicator decided (36 § 5.2), once for the action. The event names its action in a new unique column, `curatorActionId` (migration `20261007130000_calibration_action`);
  - it moves the suggestion (`curatorPathOf`): an accept to `MERGING`; a kept request for more to `DECIDED`, or a researcher's to `CLOSED`; a decline to `CLOSED`.

  Invariant 17's "one step" is one activity whose two writes are each idempotent, so a retry completes whichever is missing. It is not one transaction: the ledger's append owns its own. The actions are tried in turn: one that is none of the visit's costs the next nothing, and a second curator's action, after the first moved the suggestion on, is none of its visit's.
- **A revision** (`reopenForRevision`, then steps 2 to 9 as the next attempt).
  - If the suggestion takes a revision and the signal answers the decision that stands, the door's new `reopenSuggestion` moves it back to `SUBMITTED`. The table gains `DECIDED → SUBMITTED` and `CURATOR_QUEUE → SUBMITTED`, and the outcome's condition is the door's `REVISABLE`.
  - The move freezes the row — a submitted suggestion takes no edit — and the attempt's own `submitted:<n>` record is then appended from it, so the record says exactly what the attempt reads.
  - Run again after its move, the step finds the suggestion `SUBMITTED`, which while the run waits can only be its own doing, and appends the record if it is missing.

  Each attempt has its own trace id. The adjudicator checks an attempt's texts against that attempt's `submitted` record, which settles the tracker's open question on a revised rationale.
- **Decided here, for Andre to see:**
  - a revision records its own `submitted:<n>`, the first of the two ways the open question offered;
  - until 54b, a curator's accept waits in `MERGING` with no merge running, and the adjudicator's in `DECIDED`;
  - every signal is kept and judged by its activity: an action by when it was made against when its visit began, a revision by the decision it names. Both compare `decidedAt`, the worker's clock, with a time read elsewhere, which a skew of the two clocks could misjudge only for a person acting within that skew;
  - the calibration event is keyed by its action;
  - the `curator` record's part is the first one the curator's roster held.
- **Waiting runs replay new code.** A run left waiting replays the workflow's code when the workers restart. A change to what it asks of the engine therefore needs `patched()`, or the development engine's waiting runs ended first (code-standards). The endpoint suite's real-engine run ends its own waiting run.
- **A router's decision takes away an earlier attempt's rows** (`clearAdjudication`, the door's). The rows then hold the latest decision, and a curator's calibration event never takes an adjudicator side from a visit no adjudicator decided.
- **Only an unloadable rubric is gone without.** The router's record and the adjudicator's missing row go without the rubric only when it cannot be loaded as published (`NO_RUBRIC`). Any other failure to read it is retried, so a database blip never writes null thresholds into the ledger. The same holds for the failure recorder of 50d.
- **The review of part 1** (a short review over its commit; it ran nothing) found four defects, fixed here:
  1. Recording the adjudicator's decision threw, after the `sensors` record, when the contributor's account was gone. It now counts no tokens, before either record.
  2. A rubric the workers can no longer load stopped the router's and the adjudicator's records, which take the thresholds from the row or go without them.
  3. The derived class's decline said no item was tier A when the strongest item merely was not. It now names the strongest item's tier.
  4. Spec 29 § 3.1's table did not show the new moves. It does now.

Verified:

| § 11 | What | Result |
|---|---|---|
| — | the workflow on Temporal's test server (`tests/workflows/suggestion.test.ts`, 15 cases, rewritten) | every ending that waits is checked to wait, through the query, for what it should, and ended there. A curator's route is decided in the queue and ended at the curator's accept. A request for more kept by a curator waits for a revision, which runs steps 2 to 9 again as attempt 2 under its own trace id and ends at the second attempt's accept. Ignored, with nothing recorded: a revision before any decision, or of a curator's change; a curator's decision outside the queue; an action the activity finds none of the queue's |
| 11.8 | the activities against the database, the policy sidecar and the stub gateway (`tests/integration/suggestion-workflow.test.ts`, 3 cases added) | A curator's accept: the `curator` record's every field, once; the calibration event once, with no adjudicator side for a curator-always change; `MERGING`; nothing for an action of another suggestion, one not there, or one after the queue. A kept request for more the adjudicator made: `DECIDED`, the event with its decision and score. A revision: the second `submitted` record with the revised rationale's hash, the move back, nothing twice when run again, attempt 2's adjudication checking the revised rationale; a suggestion that takes no revision not returned. The adjudicator's decision recorded with its contributor's account gone and a rubric file that is not the one published |
| — | the endpoint against the real engine (`tests/integration/suggestions.test.ts`, the dev workers restarted on this code) | the curator-always change decided and waiting for a curator, by the query, and its run ended |
| — | the review of part 2 | One short review of part 2's commit; it ran nothing. It found eight defects, all fixed in the follow-up commit:<br>1. A signal sent between a decision's move and the wait was lost, for up to a minute after a worker restart. Every signal is now kept and judged by its activity.<br>2. A calibration event could take an earlier attempt's adjudication. A router's decision now clears the stale row.<br>3. One action row the record does not take, or a step's exhausted retries, failed a waiting run. It is now nothing to record, and a failed step leaves the run waiting.<br>4. A valid action was discarded behind an invalid one. Actions are now tried in turn.<br>5. An earlier visit's action could decide a later visit. An action must now be newer than the visit.<br>6. A revision's record could disagree with the row. The move now comes first and freezes it.<br>7. A database blip became null thresholds. Only an unloadable rubric is gone without.<br>8. Two tests of ignored signals could not fail. They are rewritten so that each can.<br>Tests: the workflow suite's three cases changed or added for 1, 3, 4 and 8; the activities suite's 1 case added (2) and 3 changed (1, 3, 5, 6, 7); the endpoint's revision case sending the decision it answers. One test needed a later clock for a second decision, since its activities run on a fixed one |
| — | after the follow-up | `npx tsc --noEmit` exit 0; `npm run lint` exit 0, no warning; with the database, the engine and the store, purge excluded, 186 files and 2,020 tests passed, 17 skipped, on the first run, no run left waiting; `npm run test:ledger` exit 0; `npm run build` exit 0; `npm run secrets:scan` 0 findings |
| — | the whole suite | `npx tsc --noEmit` exit 0; `npm run lint` exit 0, no warning; with the database, the engine and the store, purge excluded, 186 files and 2,017 tests passed, 17 skipped, on the first run, no run left waiting in the engine; `npm run test:ledger` exit 0; `npm run build` exit 0; `npm run secrets:scan` 0 findings |

## 21. As built (unit 50f, part 1: the throttle, 2026-10-07)

§ 7's throttle. Part 2 is the wait at a budget cap.

- **When it runs.** After every decline of a suggestion — by rule, by the adjudicator, by a curator — the workflow runs `throttleOnDecline` (5 s, three attempts: a row read, a count, one write). Its failure leaves the run where it was (`orNull`).
- **What it counts** (`unverifiableDeclinesOf`, the door's): the contributor's suggestions with outcome `DECLINE`, decided in the thirty days before now, every item graded `U`. It returns a number and never the rows, so the activity learns of the contributor's other suggestions nothing but how many. A suggestion with no item, or one still pending, has nothing graded `U` and is not counted; nor is one graded G (the screen's `S-23-0412`).
- **What it does** at three such declines (`lib/improve/throttle.ts`, `THROTTLE`): it sets `User.throttledUntil` thirty days from now (`throttleContributor`, `lib/db/account.ts`). The create and submit endpoints already refuse while that runs, with 429 `SUGGESTION_THROTTLED` and the date (31 § 6.3), and a suggestion already submitted proceeds.
- **Nothing** for a researcher's suggestion (§ 7), for a suggestion that is not declined, or for a contributor whose account is gone.
- **Decided here, for Andre to see:**
  - "at three" is at three or more: each further decline in the window sets the pause to thirty days from it, and a pause is never brought forward;
  - the window is the declines' `decidedAt`, so a declined suggestion being revised still counts until its next decision replaces the outcome.

Verified:

| § 11 | What | Result |
|---|---|---|
| 10 | the activity against the database (`tests/integration/suggestion-workflow.test.ts`, 1 case added, a contributor of its own) | two declines on tier U, then one on tier G: nobody throttled; the third on tier U: `throttledUntil` thirty days from the decision, as the account reads it; with those declines moved out of the window, a fourth throttles nobody, and the pause set is not brought forward; a suggestion not declined counts nothing. The fourth create's 429 is the endpoint's, as its own suites prove (31 § 11.6) |
| — | the rule (`lib/improve/throttle.test.ts`) | the window's start, nothing under three, thirty days at three and over |
| — | the workflow on Temporal's test server | the count after a decline by rule, by the adjudicator and by a curator, and after no other decision |
| — | the whole suite | `npx tsc --noEmit` exit 0; `npm run lint` exit 0, no warning; with the database, the engine and the store, purge excluded, 187 files and 2,023 tests passed, 17 skipped, on the first run, no run left waiting; `npm run build` exit 0; `npm run secrets:scan` 0 findings |

## 22. As built (unit 50f, part 2: the wait at a budget cap, 2026-10-07)

§ 7's cap, as spec 28 § 4 has it: a budget refusal is a value carrying the reset, and the workflow sleeps until then — no activity retries into a cap.

- **What meets the cap** answers the reset and how long until it, the activity's clock measuring the wait: the standards keep the clock out of workflow code.
  - The grade (`gradeItem`) answers `{ state: PENDING, resetsAt, waitMs }`, the item's pending reason saying the reset as before.
  - The adjudication answers `{ outcome: BUDGET, resetsAt, waitMs }`, with nothing written.
- **The run sleeps it out** (`sleepUntilReset`):
  - the suggestion says until when (`markBudgetWait`, the door's `writeBudgetWait`, on a submitted suggestion);
  - the run sleeps that long;
  - the suggestion says it no longer waits;
  - the run asks again. At step 3 that is the grade alone (`gradeItemAgain`), the item's text being stored already. At step 7 it is the adjudicator once more, under the same attempt and trace id: the refused call was never made, so the suggestion still has one adjudication.

  The run sleeps a minute at the least (`LEAST_BUDGET_WAIT_MS`). A reset already past, or one the gateway has not yet made, measures no wait at all, and asks a moment apart would follow each other until the run's history filled. The marks are the page's, so their failure leaves the wait as it is, and the decision's move clears any mark a wait left behind. A cap met again is slept out again.
- **Where it shows**: a new column, `Suggestion.budgetResetsAt` (migration `20261007140000_budget_wait`), which the suggestion's view carries as `budgetResetsAt`. Specs 34 and 35 compose it as `waiting for budget · resets 01 Nov`.
- **The 24-hour target counts from the reset** (TRD § 6.3), as spec 39 will measure it from the records, with no timer here (§ 7).
- **GradeEvidenceWorkflow**, the grade on add, still ends with its item pending at a cap. The suggestion's own step 3 grades that item, waiting if it must.
- **Decided here, for Andre to see:**
  - the wait is on the suggestion's row and in its view;
  - the run sleeps the wait measured when the cap was met, so a cap raised meanwhile does not wake it early;
  - after the wait, the adjudicator is asked again under the attempt's own trace id.

Verified:

| § 11 | What | Result |
|---|---|---|
| 11 | the workflow on Temporal's test server (`tests/workflows/suggestion.test.ts`, 2 cases changed) | A grade at the cap: the run's one timer is the week the activity measured; the suggestion says the reset, then null; only the grade is asked again, and the run goes on to its decision. An adjudication at the cap: the same timer and marks, the adjudicator asked twice, the decision recorded once. Both woke when the test's clock passed the reset |
| — | the activities against the database (`tests/integration/suggestion-workflow.test.ts`, `tests/integration/evidence.test.ts`, 2 cases changed) | the adjudicator's and the grader's answers at the cap carry the reset and the wait to it from the activity's clock; the suggestion's row says the reset, then nothing |
| — | the review | The background review could not reach its model twice (a network failure), so its checklist was worked through by hand. It found two defects, fixed in the follow-up commit with 1 case added and 1 changed:<br>1. A wait measured at nothing — a reset already past, or one the gateway has not yet made — let asks at the cap follow each other at once. There is now a minute at the least; the test server's timer shows it.<br>2. A mark a wait left behind, its clearing failed or its run ended mid-sleep, outlived the wait. The decision's move now clears it.<br>Held: the throttle's count and every decline's path to it; the adjudicator asked again with no second charge and no second write, the refused call never made and the first write of a trace standing; the grade asked again only after the item's text was stored. After the fix: `npx tsc --noEmit` exit 0; `npm run lint` exit 0, no warning; with the database, purge excluded, 2,023 tests passed and one failed, the assistant stream's "21st question in a minute", the known second-run flake, which passed alone straight after (19 of 19); `npm run build` exit 0; `npm run secrets:scan` 0 findings |
| — | the whole suite | `npx tsc --noEmit` exit 0; `npm run lint` exit 0, no warning; with the database, the engine and the store, purge excluded, 187 files and 2,023 tests passed, 17 skipped, on the first run, no run left waiting; `npm run test:ledger` exit 0; `npm run build` exit 0; `npm run secrets:scan` 0 findings |

## 23. As built (unit 50g, part 1: the four worked examples, 2026-10-07)

§ 8's four examples, end to end, the Phase 4 gate's first criterion. Part 2 is `npm run improve:seed` (§ 24).

- **The fixtures** (`tests/fixtures/improve/examples.ts`): each example's anchor, proposal, rationale, evidence and end. Each anchor is what release 2026.09 holds, or the nearest one where the PRD's place holds none, with the reason:

  | # | The PRD's place | Anchor used | Why |
  |---|---|---|---|
  | 1 | a cited date in 36.3 | `F-28-32`, "those obligations apply from 2 December 2027" (28.7), set to 2028 | chapter 36 is unverified in 2026.09 and holds no figure; this is a primary source's date, and the one the screen's sample changes to (→ 2 Dec 2027) |
  | 2 | a cited figure in chapter 23 | `F-23-19`, an analyst's 35% (23.2), set to 40% | — |
  | 3 | a derived decision aid in 22.8 | `F-22-20`, the derived success rate after retries (22.3), set to 95% | 22.8 holds no figure; this is the latest of the chapter's derived figures that is no scenario parameter |
  | 4 | a cited price in 15.9 | `15.9 r1`, the list-price row, its claim edited | 15.9 is chapter 15's Sources; the row moves fast, as a five-month-old item's recency needs |

  The documents are the fixture's, on `.example` hosts, so nobody's real page is quoted. The screens' values remain the design's samples.
- **The harness** (`tests/fixtures/improve/harness.ts`, for the suite and for part 2's seed):
  - the stub gateway, started in the process, with its ledger rows kept there, so no model is asked and the gateway's own ledger is not written;
  - a fetcher given the fixture's documents, each dated so many days before the run;
  - the workflow's real activities, its own and the grader's, wired to both;
  - each draft made as a person makes one: signed in through the development provider with consent on file, then created and patched through the endpoints, so its anchor is resolved and its class computed as for anyone;
  - its evidence added through the door and left pending, for the workflow's own step 3 to grade. The upload is a stored PNG under its item's key.
- **A saved lab run arrives with the IDE** (32 § 3), so example 3's tier A run is an item written as the IDE would leave it: graded A, relevance ×0.60, adjusted 60. No grader is asked.
- **The stub's grader learned its classifications** (§ 8: "a tier and classifications chosen by a header"). `x-hb-stub-grade: B:direct:none` names the tier, the relevance and the stake (`parseStubGrade`). A tier alone keeps `partial` and `none`, as before.
- **Where each ends** (`tests/integration/worked-examples.test.ts`, the real workflow on Temporal's test server):

  | # | Ends | Calls |
  |---|---|---|
  | 1 | 85; the adjudicator accepts; `DECIDED`, the run ending. The PRD's `MERGING` is a running merge, unit 54b's, which an accepted suggestion waits for in `DECIDED` (§ 19) | a grade on `hb-small`, one adjudication on `hb-frontier` |
  | 2 | 5; declined at intake; `INTAKE_DECLINED`, waiting for a revision; what would suffice is B (alone) and D (with a second) | the grade alone — no `hb-frontier` call (§ 11.2, invariant 11) |
  | 3 | 60; asked for more by rule, naming tier A; `CURATOR_QUEUE`, waiting for a curator or a revision | none |
  | 4 | 56 corroborated by 42: 66; the adjudicator asks for more with `sufficientTier` D; `CURATOR_QUEUE`, for inspection | two grades, one adjudication |

  Each has its four records — `submitted`, `graded`, `sensors`, `decided` — in order, and the chain verified from the first of them to the last (`verifyChain` over the range, linked from the record before). The arithmetic is the rubric's own: v1.2's recency gives 0.7 within a year on a fast-moving anchor, and a vendor's stake gives 0.8.
- **Lint**: `tests/fixtures/improve/` imports the workers, the gateway's client and the fetcher's types, as `tests/workflows/` does: it runs them in the test environment on the stub and fetches nothing a stranger chose (`eslint.config.mjs`).

Verified:

| § 11 | What | Result |
|---|---|---|
| 1, 2 | `tests/integration/worked-examples.test.ts`, 4 cases | each example's state, score, decision and decider, its records in order and its chain; example 2's single call on the small model and its would-suffice B and D; example 4's `decided` record with `sufficientTier` D; example 3 graded with no call; on the first run |
| — | the stub (`tests/gateway-stub.test.ts`, 1 case) | a tier alone; a tier with its relevance and stake; a value it does not know refused; the grader's output with each |
| — | the whole suite | `npx tsc --noEmit` exit 0; `npm run lint` exit 0, no warning; with the database, the engine and the store, purge excluded, 188 files and 2,029 tests passed, 17 skipped, on the first run, no run left waiting; `npm run build` exit 0; `npm run secrets:scan` 0 findings |

## 24. As built (unit 50g, part 2: the development seed, 2026-10-07)

`npm run improve:seed` (`scripts/improve-seed.ts`) writes § 8's four examples as suggestions in the development database, so that the pages of specs 34 to 36 have something to show. Unit 50g is complete.

- **How**: as § 23's suite runs them, on the same harness. Each is drafted through the endpoints by `improve-seed@harness-bible.local`, signed in through the development provider with consent on file. The real workflow then runs it on Temporal's test environment, which the script starts, with the real activities on the stub gateway started in the process and the fixture's documents. No model is asked: the development workers call the real gateway, and an example run on them would be paid calls.
- **What it needs**: `DATABASE_URL`, `OPA_URL` and `AUTH_DEV_PROVIDER=1`, which `.env` sets for development, with the database and the policy sidecar up, and the test server's file, fetched on first use or by `npm run workflows:test-server`; not the engine and not the workers. Not `OBJECT_STORE_SECRET` either: it writes and reads the store by key, as the activities do, and signs no URL. The examples are written for release 2026.09 and rubric v1.2 in force. It holds `LEDGER_LOCK` only while it clears and runs the examples, which append to the development ledger: the test server's start and the bundle come before.
- **What it prints**: one line per example — the id, the example, the state, the score, the decision and who made it — checked against § 8: an example that ends elsewhere is marked `≠ § 8`, and the seed exits 1 with the set seeded as it ended. The SDK's lines and the endpoints' own (a line per request and per policy decision) are held, and shown only if it fails. A run not ended in 120 s is its failure: a workflow task that keeps failing is retried for ever.
- **Where each ends**: as in § 23's table — `DECIDED` at 85, accepted by the adjudicator; `INTAKE_DECLINED` at 5, declined by rule; `CURATOR_QUEUE` at 60, asked for more by rule; `CURATOR_QUEUE` at 66, asked for more by the adjudicator.
- **Run again**, it first removes the account's suggestions: back to draft so that they can go, with their stored evidence, in one transaction (`clearExampleSuggestions`; the suite's `clearExampleAccount` removes its account as well, and the two share `waitingOf`). The new set is under the same account, with new ids, since a suggestion's number is never reused. The account stays, with whatever a person did while signed in as it: a bookmark, a note or a conversation would hold its delete back. The ledger keeps the earlier set's records, as it keeps every record.
- **Its limits**:
  - the runs are the seed's own and end with it. A seeded suggestion's `workflowId` names a run of the seed's test environment, not of the engine, so a revision of one answers 409 while the engine is up (`CONFLICT`, its workflow has ended; with the engine down, the engine's 503), and a curator's decision (53c) would find no run to signal;
  - example 2's screenshot is stored under its item's key in the store's directory (`OBJECT_STORE_DIR`, `.store` by default). The development server signs a URL for it only once `OBJECT_STORE_SECRET` is in `.env`.

Verified:

| What | Result |
|---|---|
| the seed, run twice on the development database | the first wrote S-28-0003, S-23-0003, S-22-0003 and S-15-0003, each ending as § 8 says; the second replaced them with the 0004 set: one account, four rows, the 0003 rows and their stored evidence gone; about 6 s each |
| the suite (`tests/integration/worked-examples.test.ts`) on the shared `clearExampleAccount` and `waitingOf` | its 4 cases passed |
| the whole suite | `npx tsc --noEmit` exit 0; `npm run lint` exit 0, no warning; with the database, the engine and the store, purge excluded, 188 files and 2,029 tests passed, 17 skipped, on the first run, no run left waiting; `npm run build` exit 0; `npm run secrets:scan` 0 findings |
| after the review: the seed with a bookmark on its account | the same account, the bookmark kept, the 0006 set replaced by 0007; before the change the account's delete failed on such a row, with its suggestions already gone |
| after the review: the seed told to expect 84 for example 1 | that line marked `≠ § 8: DECIDED, score 84, ACCEPT by adjudicator`, the count line, exit 1; the next run seeded the 0009 set, exit 0 |
| after the review: the whole suite | with the database, purge excluded, 188 files and 2,029 tests passed, 17 skipped; no run left waiting |
