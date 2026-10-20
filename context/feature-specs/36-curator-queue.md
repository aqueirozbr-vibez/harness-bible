# 36 · The curator queue — feature spec (the queue and its deadlines, the decision and the override, calibration, seeds, the monthly sample)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: `docs/design/screens/Curator-Queue.html` and its PNG; overview § Core user flow step 13 and § Features · Improve — curator; PRD requirement 8 (override with a coded reason; overrides as calibration data) and Metrics; TRD § 6.1 (the Curation rows), § 7.5 (the override sequence), § 8.1 (calibration, seeds); architecture § 6.2 and invariants 13 and 17; Andre's answers A15 (deadlines) and A16 (seeds at zero) of 2026-10-05.

Prerequisite specs: `29` (the roster, the policy, `CuratorAction`, `CalibrationEvent`), `33` (§ 6.3, the signal this spec sends), `34` § 3 (the classes), `35`.

Scope: tracker unit 53 (53a to 53e). Not here: the merge a curator performs after accepting (spec 37 § 6), the researcher's group in the queue (spec 43 § 7 adds it to what is built here).

## 1. Purpose

The curator is where the product admits what its rubric cannot decide: a safety statement, the scenario's fixed numbers, a chapter's structure, and any case where the arithmetic is right and the answer is still wrong. The queue routes each of those to someone whose roster covers the part, gives it a deadline, and treats every disagreement between curator and adjudicator as a measurement of the adjudicator. A queue that only collected decisions would be a to-do list; this one is also the calibration instrument.

## 2. Dependencies and order

53a (reads) and 53c (the decision) are the API; 53b is the page over 53a; 53d reads what 53c writes; 53e adds two mechanisms that are switched off until Andre sets their numbers.

## 3. The queue's reads (53a)

`GET /api/v1/curation/queue?class=&part=` — role `CURATOR`; 120 a minute. It returns the open items whose `parts` meet the caller's roster, in groups.

### 3.1 Groups

| Group | Holds | Deadline (A15) |
|---|---|---|
| Safety / OT-boundary | `CURATOR_ALWAYS` · `SAFETY_OT` | 24 hours |
| Scenario parameter | `SCENARIO_PARAMETER` | 5 days |
| Structure | `STRUCTURE` | 5 days |
| New source tier | `NEW_SOURCE_TIER` | 6 days |
| Request more · for inspection | outcome `REQUEST_MORE` of a person's suggestion; an adjudicator's failure | 7 days |
| Researcher proposals | spec 43 § 7 | 7 days |
| Ready to merge | accepted, the chapter's check passed (spec 37 § 6) | 7 days (D3) |
| Merging · waiting on a hand | accepted, its merge waiting: a curator's commit, a lab not run, the repository, a failed step, or no merge begun (spec 37 § 15) | 7 days |
| Sampled · accepted tier B | § 7.2 | the last day of the month |
| Decided today | what this curator decided since midnight, with seeds revealed | — |

"Rubric change", the screen's fifth group, is not built (spec 30 § 8).

### 3.2 An item

`{ id, anchor, classLine, tier (the strongest item's), score, age, deadline, state, shared }`. `classLine` is the short text the screen prints after the anchor (`price · shared 37.2`, `structure · split aid`), composed from the class, the reason and the cross-chapter verdict. A shared item appears in the queue of every part in `Suggestion.parts`, and the first curator to decide decides it ("the price row is shared, so either curator may decide").

`seeded` is never in this response. A seed is indistinguishable until decided (§ 7.1).

### 3.3 Deadlines

Counted from the moment the suggestion entered `CURATOR_QUEUE`. The response gives the instant; the page prints the time left and turns it to the failure colour with a minus sign when past (`−2 h`). The header's marks count `overdue`, `due < 24 h` and `in sla`. Passing a deadline changes nothing else: it is a signal to a person, and the roster panel's "median decision time" (spec 38 § 5) is where it adds up.

## 4. The page (53b)

`/[lang]/improve/queue`, role `CURATOR`, RSC with a client detail pane; three columns as the screen: the queue (480 px), the selected suggestion, the calibration rail (360 px). The top bar's search is the queue's on this page (`suggestion id, anchor, contributor`). The selected item is in the URL (`?s=S-15-0377`), so a reload and a shared link open the same one.

**The detail** composes what the curator needs to decide without opening anything else: the chapters and versions; the id, state, when it was submitted and `verified contributor`; the routing sentence (which parts, why, and the anchor's age when stale); **Change**; **Evidence** as the screen's table (`# · item · tier · base · rel · rec · ind · score`, the strongest-plus-corroboration row, the band meter); **Adjudication** (the sensors, the criteria, the named sufficient evidence), absent for a curator-always item, which no adjudicator saw; and the decision panel (§ 5.3). A link opens the text the grader read for each item (spec 32 § 5), which is how a curator checks a grade.

The contributor's name is shown to the curator, as the screen shows it in the record; it is the adjudicator that never sees it.

## 5. The decision (53c)

`POST /api/v1/curation/{suggestionId}/decision` — a curator whose roster meets the suggestion's parts (policy; 403 otherwise); `Idempotency-Key`; 60 an hour. Body `{ action: "ACCEPT" | "KEEP_REQUEST_MORE" | "DECLINE", overrideCode?, criterion?, note? }`.

### 5.1 Order

1. Policy (`decide` on `curation`, with `part`, `changeClass` and `origin` in the resource).
2. The suggestion is in `CURATOR_QUEUE`; otherwise 409.
3. The override rule (§ 5.2); 422 `OVERRIDE_CODE_REQUIRED` or `OVERRIDE_NOTE_REQUIRED`.
4. A `CuratorAction` row is written with the note, the code, `queueWaitMs` and, for a seed, `seeded` and whether it matched.
5. The workflow is signalled: `curatorDecision({ actionId })`. The signal carries the id only (spec 28 § 5.3).
6. The workflow's activity appends the `curator` record and the `CalibrationEvent` in one step and moves the state (spec 33 § 6.3). The handler writes neither (invariant 17).

The answer is `{ ledgerSeq }` once the record exists, within the workflow client's deadline; if the workflow has not recorded it by then, 202, and the page's status footer reads `recording` until the next read shows the hashes (`override recorded · OV-IND-02 · independence · accepted on inspection · prev … → …`).

### 5.2 What an override is

A curator's decision that differs from what the adjudicator or the rules decided: accepting what was declined or left at request more; declining what was accepted.

- **Accepting against the adjudicator** needs the criterion overridden, a code and a note of at most 400 characters. The four codes are the screen's, kept in the adjudicator guide v2.1, each tied to its criterion:

  | Code | Criterion | Meaning |
  |---|---|---|
  | `OV-IND-01` | independence | Independence waived: regulator-mandated disclosure |
  | `OV-IND-02` | independence | Independence waived: sole authoritative source |
  | `OV-REC-01` | recency | Recency: stable fact misclassified as fast-moving |
  | `OV-REL-01` | relevance | Relevance graded too low |

- **Declining against the adjudicator** (an accepted suggestion at merge, or a researcher proposal the adjudicator accepted) needs the criterion disputed and a note. No source gives codes for this direction and none is invented here (D1).
- **A curator-always item** has no adjudication to override: accept, request more or decline with a note, no code, and its calibration event has no adjudicator side.
- **Agreeing** (accepting a researcher proposal the adjudicator accepted; keeping a request more) is recorded as agreement and is the denominator of the override rate.

### 5.3 The panel

The screen's: the segmented control `Accept on inspection | Keep request more | Decline`; `criterion overridden`; the `coded reason` select; the note with its counter (`137 of 400`); the sentence that overrides are calibration data and which rate this one counts toward; `Record override and accept` and `Cancel`; the line naming what the merge will need. Which controls show follows § 5.2: no code field on a curator-always item.

## 6. Calibration (53d)

### 6.1 Measures (`lib/improve/calibration.ts`, pure, over `CalibrationEvent` rows)

| Measure | Definition | Lines |
|---|---|---|
| override rate per criterion | of the decisions a curator reviewed that had an adjudication, in the rolling quarter, the share overridden on that criterion | target 10 %, review 20 % |
| adjudicator κ | Cohen's κ between the adjudicator's decision and the curator's on the items both decided, per quarter; the function is the one the Phase 2 gate uses (`lib/gate`) | retire under 0.6, gate 0.7 |
| adjudication precision | accepted suggestions later reverted by a curator, over accepted, per quarter | under 3 % |

Each is reported with its counts (`2 of 111`). With too few events to mean anything the rail shows the counts and a dash for the rate; the screen's `0.68`, `21.4%` and `1.8%` are samples and are never printed as readings. Researcher proposals are counted in the same measures and also on their own, so the researcher's precision is visible apart from people's (spec 44).

### 6.2 `GET /api/v1/curation/metrics`

Role `CURATOR`; 60 a minute. The three measures, by quarter, with counts.

### 6.3 A rubric review

When a criterion's override rate passes 20 % in a quarter, the activity that wrote the event opens a `RubricReview` row (`id` `R-<rubric version>-<serial>`, the criterion, the rate, the quarter, the counts): one per criterion and quarter. The rail shows `rubric review triggered` with the id, as the screen does for independence. The review itself, changing the rubric, is a person's work outside this build (spec 30 § 8); the record that it is due is what the gate asks for.

`RubricReview` is one more additive table, in this unit's migration.

### 6.4 The rail

Override rate per criterion with its legend and scale; Adjudicator κ with its scale and sentence; Adjudication precision with its rows; the footer's link to the public rubric.

## 7. Seeds and the monthly sample (53e)

Both are built, tested, and off until a number is set.

### 7.1 Seeds (A16: share zero)

A seed is a decided suggestion offered again to a curator who has not seen it, with the answer a second curator set. `CURATOR_SEED_SHARE` (a setting, 0) is the share of a curator's queue that seeds may make up. At 0 none is ever offered. Above 0: seeds are drawn from suggestions another curator decided, shown as ordinary items (same response shape, their real ids replaced by fresh ones), and on decision the action is marked `seeded`, compared with the known answer, never signalled to any workflow, and revealed under "Decided today" with the dotted chip and `match` or `diverged · to calibration`. Seeds measure the curator's consistency, never the adjudicator, and are excluded from § 6.1's three measures.

### 7.2 The monthly sample of accepted tier B

"Curators sample accepted tier-B items monthly" (PRD, Risks). `CURATOR_SAMPLE_PER_MONTH` (a setting, unset) is how many merged suggestions whose strongest item was tier B are drawn per part each month into the "Sampled" group. A curator's verdict on one is `ACCEPT` (stands) or `DECLINE`, which starts a revert (spec 37 § 8) and counts in precision. Unset: nothing is sampled. No source gives the number (D2).

## 8. States

| State | The page |
|---|---|
| not a curator | the product's not-found page |
| a curator with no roster row | the queue, empty, with a line saying no part is assigned |
| nothing open | each group absent; the calibration rail still shows |
| decided by another curator meanwhile | the decision is refused 409 and the detail reloads with who decided and when |
| workflows unavailable | the decision is refused; nothing was written |
| engine slow to record | the status footer reads `recording` |

## 9. Out of scope

- Rubric-change items; editing the roster; reassigning an item to a named curator.
- Bulk decisions.
- A curator deciding their own suggestion: refused (403), since a curator is also a contributor by role.

## 10. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | Codes for declining against the adjudicator | none until Andre names them; a note and the criterion are required | the four codes in the sources all waive something in the contributor's favour; inventing the others would put strings in the guide and the ledger nobody approved |
| D2 | Size of the monthly tier-B sample | Andre's number; unset means none | the sources say "monthly" and the screen's `2 of 2 open` is a sample row |
| D3 | A deadline for "ready to merge" | 7 days | A15 covers the groups the screen shows; this group is this build's (the TRD has the curator merge a pull request on a host) and takes the longest deadline A15 gives |
| D4 | The note is stored as text | yes, in `CuratorAction`, with only its hash in the ledger | the next curator needs to read why; the ledger rule is about what is hashed and exported |
| D5 | The count under which a measure says nothing (§ 6.1) | 20 decisions in the quarter, for all three (decided with unit 53d) | the gate's own minimum for κ (`KAPPA_MIN_PAIRS`); the two rates take it too, so the three begin to read together |
| D6 | "The rolling quarter" | the calendar quarter so far, UTC (decided with unit 53d) | the screen labels the rail `Q3 2026`, § 6.2 reports by quarter and a review is one per quarter: a 90-day window would give a review no quarter to belong to |
| D7 | κ over three decisions or two | whether each accepted (decided with unit 53d) | the gate's function is binary; an override is exactly a disagreement on accepting, and declining what was left at request more is no override (§ 5.2) |
| D8 | How many quarters the metrics give | four: this one and the three before it (decided with unit 53d) | a year of history for the leading-indicator dashboard; older quarters stay in the rows |
| D9 | Links on a seed's detail | none: its suggestion's page and record would show the answer (decided with unit 53e) | a seed is the same as any item until it is decided; a curator who looks for the links can tell, which is less than an answer shown, and a page of a seed's own would be a second, false record |
| D10 | When a seed is offered | when the curator's queue is read, up to the number wanted (decided with unit 53e) | a fresh id and an offer time have to be stable across reads, so the offer is a row; it is the curator's own and no ledger record, and at share 0 no read writes one |
| D11 | What a seed shows | what stood when its suggestion was queued, its time running from the offer (decided with unit 53e) | an item shown with the decision since, or a deadline already past, would read as a seed |
| D12 | The verdict on a sampled item | with unit 54e's revert; nothing is sampled before 54c merges (decided with unit 53e) | `DECLINE` starts a revert (37 § 8), which is 54e's; recording a revert that nothing performs would leave the book changed and the record saying otherwise |

## 11. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Contract tests for the three endpoints; 403 for a curator outside the part and for a contributor; 422 for an accept against the adjudicator without a code; 409 for a suggestion not in the queue.
2. The PRD's fourth example completed: `S-15-…` from spec 33's fixture, accepted with `OV-IND-02` and a note; the `curator` record carries the code and the note's hash; a `CalibrationEvent` exists for `independence`; the suggestion is `MERGING`; the chain verifies.
3. The handler appends nothing to the ledger: with the engine's worker stopped, the decision returns 202 and the ledger's head has not moved; started again, the record appears once.
4. Deadlines: an item of each group gets the deadline of § 3.1 from its queue entry time; the marks count correctly at a fixed clock.
5. A shared item appears for curators of both parts and, once one decides, for neither.
6. `calibration.ts`: fixtures give the override rate per criterion, κ and precision to the digit; under the minimum count the rate is null; at 21 % on one criterion one `RubricReview` row is opened, and a second event in the same quarter opens no second.
7. Seeds: at share 0 the queue never contains one (property test over random queues); at 0.5 in a test, seeds appear, their `seeded` flag is absent from the response until decided, a decision on one signals no workflow and is revealed with `match` or `diverged`.
8. The page against the PNG at 1440 in the override-open state; every deliberate difference listed (no rubric-change group; the two new groups; measured values or dashes in the rail).
9. Zero axe violations in EN and PT; the page joins the truncation suite; a Playwright flow `curate` for the curator account.

## 12. As built (unit 53a: the queue's reads, 2026-10-08)

`GET /api/v1/curation/queue?class=&part=` is built (`lib/api/endpoints/curation.ts`), for a curator, at 120 a minute, under the policy's read of the curation.

- **What is in it** (`curatorQueue`, the one door): suggestions in `CURATOR_QUEUE` whose parts meet the caller's roster, longest-waiting first. A shared item is in each of its parts' queues and leaves all of them when it leaves the queue. The caller's own suggestions are never in it, since they may not decide them (§ 9). `part` narrows to one of the caller's parts, and a part they do not curate gives nothing; `class` narrows to one change class. Anyone who curates no part gets an empty queue.
- **The groups** (`lib/improve/queue.ts`, `groupOf`), in § 3.1's order, each with its deadline in hours:
  - a curator-always change goes by its reason: safety (24), scenario parameter (120), structure (120), new source tier (144);
  - a person's request for more and an adjudicator's failure go under inspection (168).

  Researcher proposals, ready to merge and the monthly sample come with their units (43, 37, 53e). A rubric change has no group, and no suggestion is given that reason yet. A group with nothing in it is absent (§ 8).
- **An item**:
  - its id, its anchor (kind, id, section), its class, its curator reason and outcome, and the strongest graded item's tier (`strongestTierOf`);
  - its score, its state, and when it was submitted and queued;
  - its deadline, from the decision that queued it;
  - its parts, and `shared` when there is more than one.

  § 3.2's `classLine` is given as its parts, the class and the reason, for the page to word in the reader's language: a sentence in the API would be English only. The cross-chapter section a shared row also reaches (`shared 37.2`) is the sensors' note's, and comes with the page's detail (53b). No seed's flag is in the answer, which is held to a strict schema.
- **Decided today**: the caller's own curator actions since midnight UTC, newest first (`curatorDecidedSince`). Nothing writes one until 53c.
- **The marks** (`marksOf`): overdue, due in under a day, and in time, at the answer's own `now`, which the page measures time left against.
- **The deadline table** moved from the decision page's helper into `lib/improve/queue.ts` (`GROUP_DEADLINE_HOURS`). That page's `queueDeadlineOf` now reads the group, so the two pages cannot disagree.

Verified:
- **`lib/improve/queue.test.ts`**, 7 of 7: the groups by class and reason, a rubric change with none, each group's deadline from a fixed queue time (§ 11.4), the marks at a fixed clock, the strongest tier.
- **`lib/api/endpoints/curation.test.ts`**, 7 of 7, the rows and the pipeline doubled:
  - the declaration; a contributor's 403 and a stranger's 401;
  - the items filed in order with their deadlines; a rubric change and an empty group absent; the marks;
  - the filters handed to the door; today from midnight;
  - a class or a part the product has not, refused;
  - no seed's flag, the answer held to its schema.
- **The door's suite** (`tests/integration/improve.test.ts`) gains one case (§ 11.5): a shared item in both parts' queues and in neither once it leaves; never the curator's own; a part not theirs gives nothing; a class narrows; a contributor's queue is empty; the strongest item's grade; today's actions the caller's alone.
- **Live, on the development server**: a curator made by the dev sign-in, who curates every part, read the seeded requests for more under inspection, each due seven days after its decision. A class narrowed the queue, a class the product has not was refused, and a contributor got 403.
- **The rest**: the database suite, purge excluded: 202 files and 2,157 tests passed, none failed. `npm run lint` and `npm run build` exit 0; the secrets scan finds nothing; the OpenAPI document, 35 paths; the decision page's check passed again on the queue's deadline table.

## 13. As built (unit 53b: the queue's page, 2026-10-08)

`/[lang]/improve/queue` is built, per request, as § 4 has it. It is a curator's; anyone else, signed out included, gets the not-found page (§ 8). The page reads 53a's queue (`readCurationQueue`, shared by the endpoint and the page's loader, `lib/db/queuePage.ts`) and the selected suggestion as its own read gives it to a curator of its parts.

- **Three columns**, as the screen: the queue (480px), the selected suggestion, the calibration rail (360px). The selection is in the address (`?s=S-15-0009`); an id the curator may not read, or none, selects the queue's first.
- **The queue**:
  - the cap names the curator and their parts; `Routed by change class` with how many are open; the marks;
  - the table, one group a heading row with its count. Each item: its id, the link that selects it and is marked as current; its anchor and class line (the reason or the class, `shared` when it reaches more than one part); its strongest tier; its score; its age; and its time left, in the warning colour inside a day and the failure colour with a minus sign once past;
  - then "Decided today". A curator with no roster row reads that no part is assigned; an empty queue says so.
- **The detail**:
  - the chapter and version; the id, its badge, when it was submitted and by whom, the contributor by name to the curator (the adjudicator never sees it) unless their consent no longer stands or their account is going;
  - the routing sentence: each part and its curators from the roster (`curatorsOfParts`, two named and the count of the rest); that a curator of any part may decide, the first to decide deciding, when it reaches more than one part; the anchor's age when stale;
  - **Change**: current, struck through, beside proposed;
  - **Evidence**: the screen's table (`# · item · tier · base · rel · rec · ind · score`, a factor under one in the warning colour), the strongest-plus-corroboration line with the score, and the band with its three zones, the floor, the acceptance and the score;
  - **Adjudication**: the sensors beside the criteria, the named sufficient evidence; absent for a curator-always change, which no adjudicator saw;
  - links to the suggestion's own page and its record.
- **The rail**: the three measures' instruments, each reading a dash and what it measures. The measures are 53d's, over the calibration events 53c's decisions write; the screen's samples are never printed (§ 6.1).
- **Strings**: `improve.queue.*`, candidates in both languages.

Not built here:
- **The decision panel**, `Accept on inspection | Keep request more | Decline` with its code and note: unit 53c's, with the endpoint it posts to.
- **The top bar's search as the queue's** (`suggestion id, anchor, contributor`): the top bar's search is still the book's on this page.
- **The link to the text the grader read** (spec 32 § 5): it needs a signed address for an item's stored text, which no read gives a curator yet.

  Both are recorded for Andre (tracker, Known defects and limits).

Verified:
- **`lib/improve/queue.test.ts`** gains the span's case: whole hours under a day, days from one, past when negative.
- **By hand, as a curator of every part** (the dev sign-in's):
  - the queue read the two seeded requests for more under inspection, the first selected and marked;
  - its detail drew the routing sentence, Change, Evidence with its band, and Adjudication with the adjudicator's criteria;
  - `?s=S-15-0009` selected the other;
  - axe found nothing in EN or PT;
  - a contributor and a signed-out visitor got the not-found page.
- **The browser spec**: the curator's page with its title and rail, axe; a contributor's not-found page.
- **The truncation suite** gains the queue as a curator's screen (`curator-queue`, a fourth account kind, `layout-curator@…`).
- **The rest**: the database suite, purge excluded: 202 files and 2,158 tests passed, none failed. The browser spec `improve`: 8 of 8. The truncation suite passed with the queue's screen. `npm run lint` and `npm run build` exit 0; the secrets scan finds nothing.

## 14. As built (unit 53c: the curator's decision, 2026-10-08)

`POST /api/v1/curation/{suggestionId}/decision` is built (`lib/api/endpoints/curation.ts`, its route under `app/api/v1/curation/[suggestionId]/decision/`), for a curator, at 60 an hour, with an `Idempotency-Key`, under the policy's `decide` on the curation. The policy's resource is the suggestion's owner, parts, class and origin, read with the caller's own condition, so a suggestion outside their parts gets the not-found answer.

- **The order** (§ 5.1):
  1. the suggestion as the curator may read it, else 404;
  2. in the queue, else 409 with its state;
  3. the override rule (`decisionOf`, `lib/improve/curation.ts`, pure), else 422;
  4. the action (`writeCuratorAction`, the one door): written only while the suggestion is in the queue, in one of the caller's parts and not their own, with `queueWaitMs` from the decision that queued it, and not seeded (seeds are 53e's);
  5. the workflow told `curatorDecision({ actionId })`, the id only;
  6. the record looked for by its step key, `stepKeyOf(workflowId, "curator:" + actionId)`, every 250 ms for 5 s: 200 `{ actionId, ledgerSeq }`, or 202 with `ledgerSeq: null` while the workflow records it.

  The handler writes nothing to the ledger (invariant 17). `stepKeyOf` moved from the workers' ledger activity to `lib/ledger/hash.ts`, so both sides compute the key the one way.
- **Not told, not kept** (§ 8): when the signal fails, the action is taken back (`withdrawCuratorAction`: the caller's own, and only while no calibration event names it). An ended workflow is 409; the engine down is the pipeline's 503.
- **Decided meanwhile** (§ 8): once an action of the present visit to the queue stands, a second curator's is not written, and the answer is 409. The workflow would otherwise record the first and drop the second (33 § 20). The check runs in the action's transaction without a lock. Two decisions in the same few milliseconds can both be written; the workflow then records the first and drops the other, whose row stays unrecorded and is passed over (below).
- **The override rule** (§ 5.2): five refusals, each 422 with its message in both languages:
  - `OVERRIDE_CODE_REQUIRED`;
  - `OVERRIDE_CODE_INVALID`: not the guide's code, or not the criterion's;
  - `OVERRIDE_CODE_NOT_TAKEN`: a code where none is given;
  - `OVERRIDE_CRITERION_REQUIRED`: declining against an accept;
  - `OVERRIDE_NOTE_REQUIRED`.

  § 5.1 named the first and the last. A decision is an agreement, an override, or neither. A curator-always change, an adjudicator's failure and a decision with nothing standing take no code and need a note.
- **The panel** (§ 5.3; `QueueDecision`, the page's client island) shows on the detail while the suggestion waits in the queue, is not the curator's own, and has no decision of this visit:
  - the header names the curator and their parts, over `Accept on inspection | Keep request more | Decline`;
  - for an accept against what stands: the coded reason (the four codes of § 5.2 with their meanings), and `criterion overridden · independence` once one is chosen;
  - for a decline against an accept: the criterion disputed, with the line that the guide gives no code for it (D1);
  - the note with its counter (`105 of 400`), marked required while it is;
  - the sentence on calibration, which depends on what stands:
    - an override counts toward its criterion's rate;
    - agreeing, or deciding beside the adjudicator, is calibration data in the rates' denominator;
    - what the intake rules decided, or nothing at all, is not calibration data;
  - the button names what it records (`Record override and accept`, `Record and keep request more`, …) and waits until the decision is whole; `Cancel` clears it;
  - the status line, a live region drawn only once it says something: `recording`, `recorded`, a 422's message, or the 409's or 503's.

  Once the endpoint answers, the page reads the suggestion again with it still selected (`?s=`) and shows its decision.
- **The decision once made** (`QueueDecided`, from `queueDecisionOf` in the one door and the record by its step key):
  - who decided and when;
  - then § 5's status footer: `override recorded` or `decision recorded`; the code, the criterion and the action (`OV-IND-02 · independence · accepted on inspection`); and `prev … → …`;
  - `recording` until the record exists, the page reading itself again every two seconds for a minute meanwhile (`OutcomeRefresh`).

  It shows the newest action the workflow recorded, or the present visit's. An action never recorded and past its visit is passed over. A curator who arrives after another has decided reads who and when (§ 8).
- **Strings**: `improve.queue.decision.*`, `improve.queue.decided.*`, `improve.queue.detail.parts` and `api.errors.OVERRIDE_*`, candidates in both languages.

Not built here:
- **The line naming what the merge will need** (`merge needs Lab 15 and Lab 37 to reproduce`) and the footer's `branch open · labs queued`: the merge is spec 37's.
- **A decline against an accept is built and tested**, but no suggestion stands at accept in the queue in this build: ready-to-merge items and researcher proposals come with units 37 and 43.
- **§ 11.3, live** (stop the engine's worker; the decision answers 202 and the head does not move; restart it; the record appears once): not run here, because the development workers also serve the assistant, which Andre was using. The contract test covers the 202 path and the handler writing nothing.
- **§ 11.9's `curate` flow in the browser spec**: by its header's rule the spec keeps nothing a run leaves, and a decision is a record the database keeps. The flow is the scripted check below, run by hand.

Verified:
- **`lib/improve/curation.test.ts`**, 6 of 6:
  - an accept against a request for more, with its code tied to the criterion and its note (the PRD's fourth example);
  - a code the guide does not have, or one tied to another criterion;
  - agreement;
  - declining a request for more, which is no override;
  - declining an accept, which needs the criterion and takes no code;
  - a curator-always change and an adjudicator's failure, which take a note and never a code.
- **`lib/api/endpoints/curation-decision.test.ts`**, 8 of 8, with the rows, the engine and the pipeline doubled:
  - the declaration;
  - the PRD's fourth example: `OV-IND-02` and a note; the action written with `independence`; the workflow told the id; the record's seq answered;
  - 202 while the workflow has not recorded it;
  - each 422 before anything is written;
  - 409 for a suggestion not in the queue;
  - the action taken back when the workflow cannot be told, with 409 or 503;
  - a contributor's 403, and the not-found answer outside the curator's parts;
  - 400 for bodies the decision does not take.
- **`lib/ledger/hash.test.ts`** gains a case for `stepKeyOf`.
- **The door's suite** (`tests/integration/improve.test.ts`), 22 of 22. The action's case now covers:
  - written only in the queue, in the caller's part, never on their own;
  - a second action in the same visit refused;
  - taken back once by its own curator, never by another, and never while an event names it;
  - `queueDecisionOf`: the open visit's action while it records, then recorded; an unrecorded action past its visit passed over; nothing for a contributor.
- **Live, on the development engine, free** (a scratch script; no model was asked):
  - **The suggestion**: a check contributor drafted a curator-always change, a wording edit whose new text resets a PLC (safety and OT), with one link that cannot be opened (graded U by rule), and submitted it. The router queued S-21-1561 for a curator, with `CURATOR_REVIEW` and no adjudication.
  - **A seeded item**: on S-15-0009, which the adjudicator left at request more, the panel offered the coded reason. `OV-IND-02` named independence and its rate, and the button waited for the note. Recorded, it was refused 409: the seeded workflow ran on the test server, so no engine here holds it. Nothing was kept, and the panel was offered again.
  - **The new item**: on S-21-1561 the panel showed no code field, the sentence that no adjudication stands, and a button waiting for the note. `Record and accept` answered 200. The detail then showed `decision recorded · accepted on inspection · prev 44c4402a0856 → 9b2eef4a7a24` and no panel, in EN and PT.
  - **The workflow** moved it to `MERGING` with `ACCEPT`. Its `curator` record is signed `user:` with the curator's id and carries the action, no code, no criterion, and the note's hash, never its text. The chain verified, and a calibration event exists with no adjudicator side.
  - **Axe** found nothing on the panel or on the decided item, in EN or PT.
  - An earlier run decided S-21-1560 the same way.
- **The rest**:
  - the database suite, purge excluded: 204 files and 2,173 tests passed, none failed;
  - the browser spec `improve`: 8 of 8;
  - the truncation suite passed, its queue screen now carrying the panel;
  - `npm run lint` and `npm run build` exit 0, and the secrets scan finds nothing;
  - the OpenAPI document has 36 paths and 41 operations.

## 15. As built (unit 53d: calibration, 2026-10-08)

The three measures of § 6.1 are built in `lib/improve/calibration.ts`, which is pure. So are `GET /api/v1/curation/metrics`, the rubric review of § 6.3 and the rail's readings.

- **The measures** are taken over the calibration events of a quarter, never a seed's (§ 7.1):
  - **Override rate per criterion**: of the decisions a curator reviewed that had an adjudication, the share overridden on that criterion. A reviewed decision is a queue decision (accept, keep, decline) on what the adjudicator decided; the adjudicator's failure does not count.
    - An override is read from the two decisions (§ 5.2): accepting what the adjudicator left at request more or declined, or declining what it accepted. It is attributed to the event's criterion.
    - Every criterion of the rubric has its row, `threshold` included, which the screen leaves out.
  - **The adjudicator's κ**, by the gate's own `cohenKappa`. The function moved, with its lines, to `lib/gate/kappa.ts`, so that Improve measures with it without importing the gate; `phase2.ts` re-exports it.
    - The pairs are whether each side accepted. The gate's function is binary, and an override is exactly a disagreement there; a curator declining what the adjudicator asked more for agrees with it on not accepting.
  - **Adjudication precision**: of the adjudicator's accepts decided in the quarter, the share a curator has since reverted. A revert is a `REVERT` action, which is spec 37's; there is none yet.
  - **Counts and the minimum**: each measure comes with its counts. Under 20 (D5) the rate is null, and the rail shows the counts and a dash.
  - **The researcher's proposals** are measured with everything else, and again on their own (spec 44).
- **The quarter** is the calendar's, UTC: `2026-Q4` runs from 1 October to 1 January. § 6.1's "rolling quarter" is read as the quarter so far, so the rail, the API and a review all mean the same span (D6).
- **`GET /api/v1/curation/metrics`** (`lib/api/endpoints/curation.ts`; route `app/api/v1/curation/metrics/`): for a curator, 60 a minute, under the policy's read of the curation.
  - **What it answers**: this quarter and the three before it, newest first (D8). Each quarter has the measures over everything and over the researcher's proposals alone, and the reviews it opened. The answer also carries the lines the rail draws and the minimum.
  - **How it reads**: three statements over the year, through the one door: `calibrationEventsBetween`, `adjudicatorAcceptsBetween` and `rubricReviewsIn`. A caller who is not a curator reads nothing.
  - **Shared with the page**: `readCurationMetrics` sorts the rows by quarter, and the queue's page renders it too. Nobody is named.
- **The rubric review** (§ 6.3): `RubricReview`, one additive table (migration `20261008130000_rubric_review`).
  - **The row**: an id `R-<rubric version>-<serial>` (`R-1.2-0007`, the version's next serial), the criterion, the quarter, the rate with its counts, and when it opened. It is unique on criterion and quarter, and its key to the rubric version is kept, as everything decided under a version is.
  - **Who opens it**: the workflow's step that writes the calibration event (33 § 6.3). The step now dates the event with its own clock and reads the quarter's events. It then opens a review for each criterion whose rate is strictly over 20 % (`reviewsDue`).
  - **Once only**: one review per criterion and quarter. A step run again, or another event in the same quarter, opens no second; `openRubricReview` answers with the one already there. The review's id takes the rubric version of the event.
- **The rail** (§ 6.4): `QueueRail`, with `QueueRailOverride`, `QueueRailKappa` and `QueueRailPrecision`, all for this quarter.
  - **`Override rate · per criterion · Q4 2026`**:
    - the legend: target 10 %, review 20 %, scale 0–25 %;
    - each criterion with `overridden of reviewed`, its rate or a dash, and its bar with both lines;
    - a criterion past the line, or with a review, in the warning colour, with `rubric review triggered` and the review's id;
    - the footer's sentence.
  - **`Adjudicator κ · vs curators`**:
    - the value or a dash, with its mark: under the floor, below gate, at the gate, or no reading;
    - the scale from 0.5 to 0.8, with the retirement zone and both lines;
    - `agreed of pairs agree on accepting`, and the sentence.
  - **`Adjudication precision`**:
    - the share or a dash, with its mark: within target or over target;
    - `accepted, later reverted` with its counts, and the target;
    - the footer's link to the public rubric, with its hash.
  - Under the three instruments, a sentence gives the minimum.
- **Strings**: `improve.queue.rail.*` replaces 53b's placeholders, with candidates in both languages. `formatKappa` prints κ to two decimals.

Not built here:
- **The monthly tier-B sample's row** (`tier b sample this month · 2 of 2 open`): 53e's.
- **The screen's sentence comparing κ with the chapter-12 judge**: a sample of the screen's, not a measure.
- **A link to a review**: no page shows one, so its id is printed.

Decided here, for Andre to see (§ 10, D5 to D8): the minimum is 20 for all three measures; the quarter is the calendar's; κ is taken over whether each side accepted; the metrics give four quarters.

Verified:
- **`lib/improve/calibration.test.ts`**, 11 of 11:
  - the lines, and what an override is;
  - the rates per criterion to the digit (5 of 40 on independence is 0.125), with no rate under twenty decisions;
  - a decision on a seed, a curator-always change, the adjudicator's failure or a merge counted in none;
  - a review due at 21 %, none at 20 % exactly;
  - κ to the digit: 0.4898 on 20 pairs, the gate's function's own value;
  - precision: 2 of 111 is 0.018;
  - the researcher's proposals apart;
  - the quarter's bounds, and counting back across a year.
- **`lib/api/endpoints/curation-metrics.test.ts`**, 5 of 5:
  - the declaration; 403 for a contributor and 401 for no one signed in;
  - the year read once, and four quarters newest first, each from its own rows: 24 % on independence with its review, and under the minimum the counts and no rate;
  - the researcher's proposals apart; the lines and the minimum;
  - nobody named, held to the strict schema.
- **The door's suite** gains the calibration case:
  - the quarter's events, with their origin and the seed's among them, and not one written a millisecond before the quarter;
  - the adjudicator's accepts, with the one reverted, and not the router's;
  - a review opened; the same criterion and quarter answered with the one there; another criterion given the next serial;
  - nothing for a contributor, and a service other than intake refused.
- **The workflow activities' suite** gains the review's case (§ 11.6), in the far quarter 2099-Q1. With nineteen decisions before it, a twentieth that is a fifth override on independence (25 %) opens one review (`R-1.2-…`, 5 of 20). A twenty-first, kept, at 23.8 %, opens no second.
- **The schema suites**:
  - the block declares the review after the calibration event;
  - its migration only adds: one table, two indexes, and its key, RESTRICT;
  - the database has the table.
- **`lib/i18n/format.test.ts`** gains `formatKappa`, and the gate's suite passes unchanged on the moved function.
- **Live, on the development server**:
  - the metrics for a curator gave four quarters, `2026-Q4` first; no decision this quarter had an adjudication, so counts and no rate; precision `0 of 2`;
  - a contributor got 403;
  - the rail drew as above, in EN and PT;
  - with a review for independence (the check's own, inserted and removed within the script), the row was marked `rubric review triggered · R-1.2-9999`;
  - axe found nothing, in either language, with the review and without it.
- **The rest**:
  - the database suite, purge excluded: 206 files and 2,197 tests passed, none failed;
  - the browser spec `improve`: 8 of 8;
  - the truncation suite passed, its queue screen carrying the rail's readings;
  - `npm run lint` and `npm run build` exit 0, and the secrets scan finds nothing;
  - the OpenAPI document has 37 paths and 42 operations;
  - the one door's guard covers the fifteenth table, in the suite and in CI's search.

## 16. As built (unit 53e: seeds and the monthly sample, 2026-10-09)

Both mechanisms of § 7 are built and tested, and both are off. `CURATOR_SEED_SHARE` is unset, which reads as 0 (A16), and `CURATOR_SAMPLE_PER_MONTH` is unset (D2). Andre sets the numbers. Both settings are in `lib/env.ts` and `.env.example`.

- **Seeds** (§ 7.1):
  - **How many**: `seedsWanted` (`lib/improve/seeds.ts`, pure) gives the seeds a queue of `n` real items may carry at share `s`: at most that share of all its items, `⌊s·n / (1 − s)⌋`. At 0 the seeds are not even asked for; nor are they in an empty queue.
  - **The offer**: `CurationSeed`, one additive table (migration `20261009120000_curation_seed`), holds an offer: the fresh id, the suggestion it is of, the curator it is offered to, the known answer, what stood, and when it was offered.
    - The fresh id is the chapter's next serial, taken as a draft takes one, so no suggestion is ever given it.
    - A suggestion can be offered when it is past draft and out of the queue, in the curator's parts, and not the curator's own. Another curator must have decided it, that decision recorded with its calibration event; and the caller must never have decided it or been offered it.
    - The known answer is the newest such decision. What stood is the adjudication's decision; with no adjudication row the router queued it, so `CURATOR_REVIEW`.
    - Offers are made when the queue is read, up to the number wanted, oldest decided first, and read again as they are (`seedsOffered`, the one door's). An offer whose suggestion is back in the queue is not shown.
  - **As an item**: a seed is filed as any item is, in its group by its class and reason, in the queue since the offer: `submittedAt`, `queuedAt` and the deadline count from it. Each group is now ordered by the time in the queue, whatever order the rows come in, so a seed has its place as any item does. Nothing in the answer says seed (§ 3.2).
  - **Its detail** shows the suggestion it is of under the seed's id, as the queue showed it (`maskedAsSeed`): in the queue, with what stood, since the offer, with no curator's decision shown. It has the panel, and no link to the suggestion's page or record, which would show the answer (D9).
  - **The decision** (`POST /curation/{seed id}/decision`):
    - the policy decides on the suggestion the seed is of, and the override rule applies against what stood;
    - `writeSeedDecision` writes an action on the real suggestion marked `seeded`, compared with the answer (`seedMatched`), its wait counted from the offer, once;
    - no workflow is told, so there is no record and no calibration event, and the seed is in none of § 6.1's measures;
    - the answer is 200 with no `ledgerSeq`;
    - the recording step refuses a seeded action, should one ever be signalled.
  - **The reveal**:
    - "Decided today" lists the seed under its own id, with the dotted `seed · known answer` chip, `accepted · known answer accepted`, and `match`, or `diverged · to calibration`. Its count reads `n · seeds revealed`, and the screen's legend follows.
    - The seed's detail then shows `Seed revealed`: the decision beside the answer, and the mark.
  - **Passed over elsewhere**: the outcome page's coded reason, the queue's decided block and the decided-meanwhile count all ignore a seeded action, which is a curator's consistency and never the suggestion's decision.
- **The monthly sample** (§ 7.2):
  - **The draw**: `sampleOf` draws `perMonth` ids by a hash of the month and each id, so a month reads the same on every request and the next month draws again. It draws per part, from the merged suggestions in the curator's parts (`mergedInParts`, never their own) whose strongest item was tier B; a suggestion of two parts is drawn once.
  - **The group**: `Sampled · accepted tier B`, last in the screen's order, its count reading `n · monthly sample`. Its items are in it from the month's first day and due by its end, so the group has no deadline in hours (`deadlineHours` null).
  - **What it holds today**: nothing. Nothing is merged before unit 54c.
- **Strings**: `improve.queue.group.sampled`, `sampledCount`, `seedsRevealed` and `improve.queue.seed.*`, candidates in both languages.
- **Classes**: `.seed-chip`, `.queue-decided-item` and `.queue-legend`.

Not built here:
- **The verdict on a sampled item**. `ACCEPT` stands; `DECLINE` starts a revert, which is spec 37 § 8, unit 54e's (D12). A sampled item, being merged, shows no panel, and is read in the queue until then. **Built in unit 54e, part 2** (2026-10-10; spec 37 § 22): the detail's panel offers `Stands` — `ACCEPT` on the merged suggestion, an action alone, once since it merged — and `Revert` with a note, which is `REVERT` (37 § 8); the verdict given shows in the detail with who and when, and the revert's id.
- **Links on a seed's detail** (D9).

Decided here, for Andre to see (§ 10, D9 to D12):
- a seed has no link to its suggestion's page or record;
- offers are made when the queue is read;
- a seed shows what stood when it was queued, and its time runs from the offer;
- the sample's verdict is 54e's.

Verified:
- **`lib/improve/seeds.test.ts`**, 6 of 6:
  - at share zero no seed for any of a thousand random queues (§ 11.7);
  - above it, never more than the share over a thousand random shares and queues;
  - none in an empty queue, nor at 1 or more;
  - the month and its end; the sample the same on every read of a month, another the next, never more than asked.
- **`lib/api/endpoints/curation.test.ts`** gains four cases:
  - at share 0 the seeds are not asked for, for queues of 0 to 40;
  - at a half, as many seeds as items, filed in their group by when they came, no flag in the answer;
  - the sample per part from the merged tier-B, due by the month's end, the tier-C one not drawn;
  - "Decided today" revealing a seed with its answer and whether it matched.
- **`lib/api/endpoints/curation-decision.test.ts`** gains two cases:
  - a seed decided as one: decided on as the suggestion it is of, the override rule against what stood, the action written seeded, no workflow told, 200 with no seq;
  - a seed's override still needs its code, and a seed decided twice is 409.
- **The door's suite** gains the seeds' case:
  - what another curator decided and recorded is offered under a fresh id from the chapter's counter, the same offer on a second read, nothing at 0;
  - none of: decided but never recorded, the caller's own, in the queue;
  - decided once, seeded and matched, revealed in "Decided today" under the seed's id, no longer shown;
  - the outcome page's coded reason and the queue's decided block passing the seeded action over;
  - a seeded action no bar to deciding a suggestion in the queue;
  - the merged suggestions in the parts, not the caller's own.
- **The schema suites and the one door's guard** count the sixteenth table, in the suite and in CI's search; its migration only adds.
- **`lib/env.test.ts`**, new: every variable the environment's schema declares is read, and only those. The two settings were first declared and not read, and so read as off whatever the process held.
- **Live, on the development server**, started with `CURATOR_SEED_SHARE=0.5` and `CURATOR_SAMPLE_PER_MONTH=2` for the check alone, then started again without them:
  - a fresh check curator's queue, with two real items, carried two seeds (`S-21-1671`, `S-21-1672`) in the safety group, as items in the queue with what stood, the same on a second read; nothing in the answer said seed or named the suggestions they were of;
  - no sample was drawn, nothing being merged;
  - a seed's detail showed the panel and no link;
  - accepted, it answered 200: the action was written seeded and matched, the suggestion it was of did not move, and no record was added;
  - the detail and "Decided today" revealed it with the chip, `accepted · known answer accepted`, `match` and the legend, in EN and PT;
  - axe found nothing;
  - the check's seeds and seeded actions were deleted.
- **The rest**:
  - the database suite, purge excluded: 2,211 tests passed. One case of the workflow test environment (`tests/workflows/suggestion.test.ts`, step 7's request for more) timed out at its 5 s while the build ran beside it; it passed when its file ran alone, 19 of 19;
  - the browser spec `improve`: 8 of 8;
  - the truncation suite passed;
  - `npm run lint` and `npm run build` exit 0, and the secrets scan finds nothing;
  - the OpenAPI document has 37 paths and 42 operations, with the queue's sampled group and its revealed seeds.

## 17. Review of unit 53 (2026-10-09)

One review of the whole unit, three lenses (correctness, access, house rules), each finding checked by one skeptic. Fourteen findings were confirmed, two of them found twice, so twelve distinct; all are fixed in one commit, and six were refuted.

- **A decision on an item that waited 25 days failed** (high). `queueWaitMs` is milliseconds, and the column was an `INTEGER`, whose largest value is 24 days and 20 hours. Every retry of the decision answered 500, and since the wait only grows, the item could never be decided. A seed decided 25 days after its offer failed the same way.
  - **Fix**: the column is a `BIGINT` (migration `20261009150000_queue_wait_bigint`), read as a number at the door. The `curator` record's `queueWaitMs` was a number already.
- **An action whose recording step failed blocked its visit for good** (medium). The run dropped the signal and waited. The endpoint then refused every later action of the visit, since one stood. The detail showed `recording` with no panel, and a curator-always item, which takes no revision, stayed in the queue for ever.
  - **Fix**: the run records the action again after a minute, doubling to an hour, until the step succeeds or says the action is none of the visit's (`workers/workflows/suggestion.ts`).
  - A run that dropped one before this replays as it ran (the patch `53-record-curator-action-again`).
- **Seeds could pair an old answer with newer evidence** (medium, two findings). The answer was the newest recorded decision, but what stood and the evidence the seed shows were read as they are now. After a revision decided again, the two no longer belonged together.
  - Separately, an open offer came back after its curator had met, or even decided, the suggestion itself. It came back with its first offer time, so its deadline was already past.
  - **Fix**: a seed is now only of a **settled** suggestion (merging, merged or closed), where nothing its contributor writes changes it, and never of one the caller decided. An answer counts only when no decision of the adjudicator's or the rules' came after it.
  - An open offer whose suggestion was decided again since the offer is never shown again.
  - An offer the queue has no room for is offered again when it has, its time starting then (D11).
- **A seed's answer could be read before it was decided** (medium). The seed's suggestion was one that had sat in the curator's own queue, where its real id, its page and its record are theirs to read. § 7.1 says "a curator who has not seen it".
  - **Fix**: a seed's answer must have been given before the caller began to curate any of its suggestion's parts (`CuratorRoster.since`), so it never sat in their queue.
  - **Limit**: the real suggestion can still be read by a curator who finds its id. Seeds measure the consistency of curators who are not looking (D9). Seeds are off (A16) until Andre sets a share.
- **A criterion on a decision that is no override was recorded as given** (low). An API call could send one with an agreement. It reached the action, the record and the calibration event, and the decided block then read the decision as an override.
  - **Fix**: refused, `OVERRIDE_CRITERION_NOT_TAKEN` (422), as a code is. A criterion is an override's alone. The panel never sent one.
- **The panel**:
  - **A new key on every press** (two findings): a retry after a lost answer was refused 409 rather than replayed. The panel then said that nothing was recorded, although the first press had recorded the decision. The key is now kept across retries of one body (code-standards' rule) and changes with the body.
  - **Its button gave no reason**: it was `aria-disabled` with nothing beside it saying why, and a press said nothing. Now the reason stands under the panel's sentence (`#queue-decision-why`, the words the refusal would have) and the button names it with `aria-describedby`. A press says it in the live region, and the next edit clears it.
  - **The note's counter** was part of its label: no live `.counter`, no flag past 400. It is now the house's counter beside the label (`.flabel`), live and `.is-over` past 400. A note past 400 is named under the panel's sentence too.
  - **After a write that changed the address**, the router's copy of the page was never cleared. Now it refreshes whenever it writes (code-standards).
- **The list**: a group's heading was a `th` with `scope="colgroup"` in a table with no column groups, so browsers made it the header of every cell. It is now `scope="rowgroup"`, the header of its own body's rows.
- **PT**:
  - an override is now an `anulação`, as the rubric page says it, and only a revert is a `reversão`. The rail's two measures no longer read alike.
  - the queue's counts agree with their number (`1 aberta`, `0 atrasadas`; zero is plural, written `=0`, since the language's rules put 0 with one).

Refuted:
- the month's sample changing with a filter or a mid-month merge;
- a researcher's request kept against an accept being no override;
- a merged suggestion filed both as a seed and as sampled;
- the queue's read writing offers without `writes: true`;
- `Cancel` dropping the focus;
- four modifiers of the evidence band missing from ui-context.

Decided here, for Andre to see:
- seeds only of settled suggestions, answered before the curator began to curate any of their parts. The supply of seeds for a long-serving curator is the part's history before them; nothing is offered at share 0;
- a failed recording retried after a minute, doubling to an hour, without end: the action stands, so the run never drops it.

Verified:
- **`lib/improve/curation.test.ts`** gains the refused criterion: on an agreement, a plain decision and a curator-always change.
- **`lib/api/endpoints/curation-decision.test.ts`**: an agreement sent with a criterion is 422 `OVERRIDE_CRITERION_NOT_TAKEN`, and nothing is written.
- **`tests/workflows/suggestion.test.ts`**: a recording whose step fails is tried again after one timer of 60 s, and the action is recorded.
- **`tests/integration/improve.test.ts`**, the seed case, against the database:
  - offered: two settled suggestions answered before the curator's roster began;
  - not offered: one unrecorded, the caller's own, one in the queue, one still open to revision, one decided again after its answer, and one answered after the curator began;
  - with room for one, the other offer waits, its time restarting; decided again since, it is never shown again;
  - the wait reads as a `BIGINT`.
- **Live, on the development server**, as the check curator on S-15-0009, a seeded item whose workflow ran on the test server:
  - the button said why it waited, and a press said it in the live region;
  - the counter was live and flagged at 401 of 400;
  - an edit cleared the refusal;
  - a lost answer's retry kept its key, and a changed note took another;
  - the decision was refused 409 and nothing was kept;
  - the group headings head their rows;
  - PT read `Registrar anulação e aceitar` and `2 abertas · 0 atrasadas · 0 vencem < 24 h`;
  - axe found nothing, in EN and PT.
- **The rest**:
  - the database suite, purge excluded: 209 files and 2,224 tests passed, none failed;
  - the browser spec `improve`: 8 of 8;
  - the truncation suite passed;
  - `npm run lint` and `npm run build` exit 0, and the secrets scan finds nothing;
  - the OpenAPI document is unchanged at 37 paths and 42 operations.
