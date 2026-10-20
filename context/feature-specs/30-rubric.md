# 30 · The rubric — feature spec (`lib/rubric`: tiers, factors, the score, change classes, thresholds and routing; rubric v1.2 as data; the Rubric page)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: PRD "Evidence grading rubric" (pp. 7–10: tiers, adjustments, thresholds, the four worked examples), the screen `docs/design/screens/Rubric.html` (every string of the page; the mapping of the book's chips to evidence tiers; the changelog), TRD § 4.2 schema rules (p. 22) and § 11 ("100 % of rubric branches"); architecture § 3.1 (`lib/rubric/` is pure), invariant 8.

Prerequisite specs: `29-improvement-schema.md` (the enums; `RubricVersion`, `Threshold`), `13-assistant-agent.md` § 4.1 (the control-system vocabulary this spec reuses).

Scope: tracker unit 47 (47a to 47d). The arithmetic and the rules that decide a suggestion's class and route, as pure functions; the rubric as a versioned file and as rows; the two public endpoints; the page. Not here: grading an item (spec 32 § 7 produces the grades this spec multiplies), the adjudicator (33), rubric changes as a process (§ 8).

## 1. Purpose

The rubric is the part of Improve that a model never decides (invariant 8). A grader says which tier an item is and how directly it bears on the claim; from there on everything is arithmetic and table lookup, and that arithmetic is what makes the same evidence get the same outcome for every contributor, the researcher included. This spec puts it in one dependency-free module, tested on every branch with the PRD's four examples, and publishes it, because a contributor is entitled to compute their own score before they submit.

## 2. Dependencies and order

47a and 47b are pure and need nothing. 47c needs the tables of spec 29. 47d needs 47c.

## 3. The score (47a, `lib/rubric/score.ts`)

Every function takes the rubric as a parameter (`Rubric`, § 5.1); none reads a file, a row or a clock.

### 3.1 Tiers

| Tier | Name | Base |
|---|---|---|
| A | Reproducible | 100 |
| B | Primary published | 85 |
| C | Primary vendor | 70 |
| D | Independent analyst | 60 |
| E | Practitioner | 40 |
| F | Reported | 25 |
| G | Opinion | 5 |
| U | Unverifiable | 0 |

`U` is not a weak tier, it is the absence of evidence: an item whose source could not be opened is `U` whatever it claims to be (PRD: "graded as unverifiable, not as weak").

### 3.2 Factors

| Factor | Values | Set by |
|---|---|---|
| relevance | direct 1.0 · partial 0.6 · tangential 0.2 | the grader's classification, with the source opened |
| recency | at most 90 days 1.0 · at most a year 0.7 · older 0.3 · a stable fact 1.0 | code, from the item's publication date and whether the anchor is fast-moving (§ 3.4) |
| independence | no stake 1.0 · the vendor concerned 0.8 · the contributor's own employer 0.7 | the grader's classification for the vendor; code for the employer (spec 32 § 7.4) |

`adjusted = floor(base × relevance × recency × independence)`, computed in decimal arithmetic and rounded down, so that no score reaches a threshold by rounding (D1).

### 3.3 The suggestion's score

```
score = max(adjusted over the items) + (10 if a corroborating item exists, else 0)
```

Never a sum, never an average. The corroborating item is any item other than the strongest that is tier D or above, has independence 1.0, was opened, bears on the claim directly or partially, and comes from a different publisher than the strongest (D2; the PRD's fourth example: "a second vendor page is not independent"). It is added once, however many qualify. `scoreOf(items)` returns `{ score, strongestId, corroboratedById, perItem }`, which is what the score instrument and the `graded` record print.

A suggestion with no opened item has score 0.

### 3.4 Recency applies to fast-moving figures only

The anchor is fast-moving when its `Figure.fastMoving` or `SourceRow.fastMoving` is true (prices, deadlines, model versions, benchmarks: the book's own flag). A proposal that adds a claim or a row declares `fastMoving` itself (spec 31 § 4), and the curator sees the declaration. For a stable anchor the factor is 1.0 whatever the item's age. For a fast-moving anchor an item with no date the grader could find takes 0.3 (D3): a price of unknown age is an old price.

**Decided 2026-10-08** (Andre, "use your recommendations"; found by unit 51c's review): for a claim or a row added, the proposal's declaration is what recency reads, since the section it is added to has no flag of its own (31 § 3: "false for a section until the proposal declares it"); the curator sees the declaration. Until then the grader and the adjudicator read the anchor's flag alone, so a claim about a price added to a stable section was graded as stable. `fastMovingOf` (`lib/improve/proposal.ts`) is now the one rule the grader, the adjudicator's prompt and its `wouldSuffice`, the suggestion's view (`fastMoving`) and the edit page's class panel read.

### 3.5 What would suffice

`wouldSuffice(items, changeClass, fastMoving)` answers the question the adjudication page and the predicted outcome put: which evidence would turn this into an acceptance. For each tier from the weakest up it asks whether one more item of that tier, at its best (direct, recent, independent), reaches `acceptAt`, alone or with the corroboration the present items would then give or receive. It returns the weakest tiers that do, at most two, each with its condition and its arithmetic:

- `S-15-0377` (C at 56, D at 42, class cited figure): `D ≤ 90 d as strongest: 60 + 10 = 70 · B: 85`.
- `S-23-0412` (G at 5): `B: 85`, and `D: 60 alone asks for more; a second independent D adds 10`.
- A derived figure: tier A only, on the chapter's lab.

The adjudicator names a sufficient tier in its output; the workflow accepts the name only if this function lists it (spec 33 § 5.4).

## 4. Classes, thresholds and routing (47b)

### 4.1 What a change is (`ChangeKind`) and where it may be anchored

| Change kind | Anchor | Meaning |
|---|---|---|
| `EDIT_TEXT` | section | replace a quoted passage of the section's prose with another |
| `SET_VALUE` | figure | a new value, with its unit, for the figure |
| `EDIT_ROW` | source row | a new claim, citation, link, date or value for the row |
| `ADD_CLAIM` | section | a new sentence or paragraph, with its source |
| `ADD_ROW` | section (the chapter's Sources layer) | a new source row |
| `RESTRUCTURE` | section | split, merge, move or remove a section |

Any other pairing is refused by the schema sensor (spec 31 § 5). An `EDIT_TEXT` whose passage overlaps a figure, or which changes a digit, is refused with the figure named: a number is changed by anchoring the figure, so that its tier and its derive link are in the picture.

### 4.2 The class (`classOf(anchor, changeKind, proposal)`)

First match wins. Every input is a row of the release or a field of the proposal; no model is asked (invariant 8).

| # | When | Class · reason |
|---|---|---|
| 1 | `RESTRUCTURE` | `CURATOR_ALWAYS` · `STRUCTURE` |
| 2 | the anchored figure has `scenarioParam = true` | `CURATOR_ALWAYS` · `SCENARIO_PARAMETER` |
| 3 | the anchored text or the proposed text is about operating equipment, by the vocabulary the assistant's control-system rule uses (`lib/sensors/scope.ts`, spec 13 § 4.1) | `CURATOR_ALWAYS` · `SAFETY_OT` |
| 4 | the proposal names a source tier that is not one of the book's seven | `CURATOR_ALWAYS` · `NEW_SOURCE_TIER` |
| 5 | `SET_VALUE` on a figure of tier `DERIVED` | `DERIVED_FIGURE` |
| 6 | `SET_VALUE` on any other figure; `EDIT_ROW` | `CITED_FIGURE` |
| 7 | `ADD_CLAIM`, `ADD_ROW` | `NEW_CLAIM` |
| 8 | `EDIT_TEXT` | `WORDING` |

Rule 3 errs towards the curator on purpose: a false match costs a curator a look, a miss lets a model decide a safety statement. `RUBRIC` is the sixth curator reason and has no rule here, because a rubric change has no chapter anchor (§ 8).

### 4.3 Thresholds (rubric v1.2)

| Class | Accept at or above | Floor (decline below) |
|---|---|---|
| Wording, clarification, typo | 40 | 5 |
| Cited figure, date, price, deadline | 70 | 25 |
| Derived figure | 100, tier A only | 100 |
| New claim or source row | 85 | 40 |
| Curator always | no score decides | — |

### 4.4 Routing (`routeOf`, `consistent`)

- `routeOf(changeClass, score, intakeVerdicts, strongestTier)` → `DECLINE_AT_INTAKE` (an intake sensor failed, or the score is under the floor: no frontier call, invariant 11), `REQUEST_MORE_BY_RULE` (the derived class alone, below), `CURATOR` (curator always), `ADJUDICATE`.
- **The derived class has one rule of its own.** Its accept and its floor are both 100, and the PRD's third example scores 60 and is answered "request more", not declined. So in `DERIVED_FIGURE` a suggestion whose strongest item is tier A but adjusts to under 100 is `REQUEST_MORE_BY_RULE`, naming a tier A run on the chapter's lab with the change applied; one with no tier A item is declined at intake, naming tier A. Neither costs a model call: nothing a model could say would change either (D6).
- `consistent(decision, score, thresholds, verdicts, changeClass, strongestTier)`: what the adjudicator may say. `ACCEPT` only when `score ≥ acceptAt`, no sensor failed, and for a derived figure the strongest item is tier A. `REQUEST_MORE` only when `score ≥ floorAt`. `DECLINE` always, with a failing sensor or a reason. An output that is not consistent is the adjudicator's one failure, and the suggestion goes to a curator (invariant 15).
- `predict(…)`, for the suggest form's "predicted outcome": the same two functions run on the draft, which is why the prediction and the outcome cannot disagree about arithmetic.

## 5. The rubric as data (47c)

### 5.1 The file

`rubric/v1.2/rubric.json`, a top-level folder beside `guides/`, `aids/` and `golden/`: `{ version, publishedAt, appliesAt, tiers, adjustments, thresholds, chips, examples, changelog }`, validated by `RubricSchema` (`lib/schemas/rubric.ts`), with a `manifest.json` pinning its sha256 the way a guide's does. `chips` is the screen's mapping of the book's seven source chips to evidence tiers; `examples` are the four worked examples with every number of their arithmetic.

`npm run rubric:publish -- v1.2` checks the hash, and writes the `RubricVersion` row and its `Threshold` rows if absent. A version is never edited in place: a change is a new folder, a new hash, a new row.

### 5.2 Endpoints

`GET /api/v1/rubric/current` and `GET /api/v1/rubric/{version}`: public, in the handler pipeline, rate limited as the other public reads are; the body is the file. The Rubric page's "Download rubric v1.2 · JSON" is the second.

Every adjudication stores `rubricVersionId` (spec 29), so a score in a chapter's history is read at the rubric in force on its date, as the history's footer says.

## 6. The Rubric page (47d)

`/[lang]/rubric`, RSC, static per rubric version, public. The screen is the specification for layout and strings: the header, Evidence tiers, the scoring rule stated once, the chip mapping, Adjustment factors, Thresholds by change class with its legend, the four worked examples, the changelog, the status bar. The numbers on the page are read from the rubric, never typed into the component (the same rule the budget meter follows).

Differences from the screen, each deliberate:

- **"Suggest a change" is not rendered.** A rubric change is a curator-only class with no flow in this build (§ 8).
- **`κ vs curators 0.68 · Q3 2026` in the status bar is the screen's sample.** The cell shows the measured value when spec 36 § 6 has one, and is absent until then; a number nobody measured is not printed.
- **The header's "opened from ch15 …"** appears only when the page was opened from a chapter (a `from` parameter).
- The worked examples link to their records only when those suggestions exist in this database (they do on a machine seeded with spec 33 § 8's fixtures).

PT strings are candidates written with the unit and marked as the catalogue marks them (rules § 4.6).

## 7. Tests

`lib/rubric/` is held at 100 % branch coverage by its own script, as `lib/ledger/` is (rules § 5). The four worked examples are fixtures in `tests/fixtures/rubric.ts` and each is asserted to the number:

| Example | Items | Score | Route |
|---|---|---|---|
| 1 · Annex III date | B, direct, 9 days, independent | 85 × 1.0 × 1.0 × 1.0 = 85 | ≥ 70: adjudicate; accept is consistent |
| 2 · screenshot | G | 5 | < 25: declined at intake; `wouldSuffice` names B, and D with corroboration |
| 3 · Lab 22 repair cap | A, partial relevance | 100 × 0.6 = 60 | tier A under 100 in the derived class: request more by rule, naming a tier A run on the chapter's lab |
| 4 · cached-input price | C × 0.8 = 56; D × 0.7 = 42 | 56 + 10 = 66 | between 25 and 70: request more; `wouldSuffice` names `D ≤ 90 d` and `B` |

Property tests: the score never exceeds 110; adding an item never lowers it; ten items of tier G never beat one of tier F; removing the corroborating item lowers the score by exactly 10.

## 8. Out of scope

- **Rubric changes as a process**: the `R-1.2-0007` records of the curator queue, the review a 20 % override rate triggers, the announcement "30 days before it applies". This build has one rubric, v1.2. When the override meter crosses 20 % the product says so (spec 36 § 6.3) and a person edits the file as a reviewed change.
- Quarterly recalibration of thresholds: the same.
- The rubric's PT translation of tier examples beyond the catalogue's candidates.

## 9. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | Rounding of the adjusted score | down | the PRD's examples are all whole numbers and state no rule; rounding down never lifts a suggestion over a threshold |
| D2 | What "independent" means for corroboration | independence 1.0, another publisher, direct or partial relevance | the PRD says "a second independent item at tier D or above" and, by example, that a second page of the same vendor is not one; a tangential item says nothing about the claim |
| D3 | A fast-moving item with no date | 0.3 | the alternative, 1.0, would make an undated price the strongest evidence |
| D4 | The safety and OT-boundary class by vocabulary | yes, the assistant's own | the sources say such changes go to a curator and do not say how they are recognised; a model must not decide it; one vocabulary for "this is about operating equipment" is better than two |
| D5 | Where the rubric file lives | `rubric/` in this repository | the TRD has it in the book's repository with the guides; the guides moved here on 2026-09-23 for the same reason: the application must not depend on the book for its own rules |
| D6 | The derived class under 100: a rule or the adjudicator | a rule (§ 4.4) | accept needs 100 on tier A and the score is arithmetic, so the adjudicator could only repeat it at a frontier call's price; the Improve-Adjudication screen's dock shows that suggestion beside "what the adjudicator saw", which reads as if a model decided it, and is the one place this differs from the screen |

## 10. Verification (in addition to `ai-workflow-rules.md` § 7)

1. `npm run test:rubric` reports 100 % branches on `lib/rubric/**`, with the four examples and the property tests passing.
2. `lib/rubric/**` imports nothing outside itself and `lib/schemas/`; a lint test holds it.
3. Every row of § 4.2 has a case, in order, including a text edit that trips rule 3 and a figure with `scenarioParam`.
4. `consistent` refuses an accept at 66 against 70, an accept with a failed sensor, an accept of a derived figure on tier B, and a request more under the floor. `routeOf` sends a derived figure with a tier A item at 60 to `REQUEST_MORE_BY_RULE` and one with a tier B item at 85 to `DECLINE_AT_INTAKE`.
5. `npm run rubric:publish -- v1.2` is idempotent; with one byte of the file changed it refuses.
6. `GET /api/v1/rubric/current` equals the file; an unknown version is 404 in the API's error form.
7. `/en/rubric` and `/pt/rubric` at 1440 and 390: the screen's structure, every number equal to the file's, zero axe violations; the page joins the truncation suite's list (code-standards § Testing).


## 11. As built (unit 47a, 2026-10-05)

§ 3 as written, in `lib/rubric/score.ts`: `recencyOf`, `factorsOf`, `adjustedOf`, `scoreOf` and `wouldSuffice`, every one taking the rubric's rules first. The four worked examples pass to the number (§ 7), 100 % of the branches are held by `npm run test:rubric`, and a lint rule holds the folder to its own files and the shared schemas (§ 10.2).

- **The rubric the functions take** is `RubricRules` (`lib/schemas/rubric.ts`): the tiers with their bases, the three adjustments, the corroboration and the thresholds per class; the part of § 5.1's `Rubric` the arithmetic reads. Unit 47c adds the version, the dates, the chips, the examples and the changelog around it. v1.2's values are the fixture `RUBRIC_V1_2` (`tests/fixtures/rubric.ts`), every number from the Rubric screen; the file of 47c is checked against it.
- **A factor is a number of hundredths** (`multipleOf(0.01)`), so `adjusted = floor(base × relevance × recency × independence)` is taken in whole numbers and rounded down (D1): no score is a rounding of a binary fraction, and a test holds every product of v1.2's values against integer arithmetic.
- **An item is its graded row**: tier, opened or not, the three factors as stored, the publisher. `scoreOf` recomputes each item's adjusted score from its tier and factors, whatever a row's `adjustedScore` says; an item that was not opened is tier U with no factors (§ 3.1), an opened one that lacks a factor scores 0, and when no item scores above 0 there is no strongest item (`null`), which is how "a suggestion with no opened item has score 0" reads in the `graded` record.
- **What corroborates**, on the factors a row has (D2): another item, opened, whose tier's base is at least the corroboration tier's, whose independence is at least the no-stake factor, whose relevance is at least the partial factor, and whose publisher is known, as is the strongest item's, and differs. *Both publishers must be known*: an upload with no publisher neither corroborates nor is corroborated, because what cannot be shown to be a second source is not counted as one. The publisher is compared as the caller gives it (spec 32 § 7.4's registrable domain).
- **The strongest item is chosen first, then the corroboration**, as the PRD and the Rubric screen state it ("added once, after the strongest item is chosen"). Of items equally strong, the strongest is the first that has a corroborating item, else the first of them. **Kept as stated, with its corner**: the spec's property "adding an item never lowers the score" (§ 7) does not hold under this rule when the new, stronger item shares its publisher with the only corroborating item, or has no known publisher: `C 56 (vendor) + D 42 (tracker) = 66`, then a recent D from the same tracker makes `60`. The property is tested as it does hold, for an item of a publisher none of the items has, and both corners are tested as they are. The tracker puts the question to Andre: the rule, or a score that never falls.
- **Recency** (§ 3.4): windows `≤ 90 days 1.0`, `≤ 365 days 0.7`, then `0.3`; a stable anchor `1.0` whatever the age; no date is an old one (D3). "A year" is read as 365 days, since the row's age is in days.
- **Tier C's best is the vendor's page.** `wouldSuffice` asks what one more item of a tier would do *at its best*, and the Rubric screen defines tier C as "from the vendor concerned": so its best independence is the vendor's 0.8, carried in the rules as `stakeAtBest` (`vendor` for C, `none` for every other tier). This is what makes both screens' answers come out: `D ≤ 90 d as strongest: 60 + 10 = 70 · B: 85` for S-15-0377 and `B: 85`, `D: 60 alone asks for more; a second independent D adds 10` for S-23-0412; read "independent" literally and a tier C item at 70 would be named before B in both.
- **`wouldSuffice`** adds one item of each tier, from the weakest base up, at its best (direct, recent where the anchor is fast-moving, its tier's least stake, a publisher no present item has) and asks `scoreOf`: alone (`ALONE`), as the strongest with a present item corroborating it (`CORROBORATED`), corroborating the present strongest (`CORROBORATING`), or failing those with a second such item of its tier (`WITH_A_SECOND`). The two weakest tiers that reach the class's acceptance are returned, those asking for one item before the one asking for two, each with `adjusted`, `withinDays` (the first window's, for a fast-moving anchor), `bonus` and the `score` it would make. Nothing is named where no score decides, where the present items already reach the acceptance, or outside the class's single tier where it has one (`onlyTier`, the derived figure's A). The page's sentences are the page's (47d, 51c): this returns the arithmetic.
- **Not built here**: `classOf`, the thresholds' routing and `consistent` (47b), the file and `rubric:publish` (47c), the page (47d). The thresholds' *shape* is here because `wouldSuffice` reads `acceptAt`; 47b reads `floorAt` and `onlyTier` for the routing.

Verified:

| § 10 | What | Result |
|---|---|---|
| 1 | `npm run test:rubric` | 51 cases, branches 100 % (59 of 59); the four examples to the number: 85, 5, 60 and 56 + 10 = 66, with the strongest and the corroborating item named |
| 1 | the properties of § 7 | never above 110 and always the strongest's adjusted score with or without the bonus, on 4,000 generated sets; never lowered by an item of a new publisher, on 4,000; ten tier-G items score 5 and one tier-F item 25; removing the corroborating item lowers the score by exactly 10, or by nothing when another item corroborates, on every generated set where one exists |
| 1 | the coverage gate with a group of tests left out | `ERROR: Coverage for branches (66.1%) does not meet global threshold (100%)`, exit 1 |
| 1 | 23 rules weakened one at a time in place (rounding, a sum, each condition of corroboration, each rule of recency, the unopened item, the tie, the bonus, and seven of `wouldSuffice`) | 23 of 23 caught by a test that names the rule; one was caught only after a test with other numbers was added (the derived figure's single tier is redundant at v1.2's) |
| 2 | a probe file in `lib/rubric/` importing `node:fs`, `zod`, `@/lib/db/client`, `@/lib/env` and `../auth/signIn` | each refused by name; `./score` allowed; the probe deleted |
| — | `lib/schemas/rubric.test.ts` | 19 cases: v1.2 parses and holds the screen's numbers; a tier, a relevance, a stake or a class left out, a factor of three decimals, windows out of order, a floor above its acceptance and an unknown key are each refused |
| — | the whole suite | `npx tsc --noEmit` 0; `npm run lint` 0 warnings; without a database 1,227 passed in 147 files (the rows suite's known failure aside); with the database and the engine, purge excluded, 146 files and 1,430 tests passed, 17 skipped, twice; `npm run test:ledger` 100 %; `npm run build` 0; `npm run secrets:scan` 0 findings |

**Seen once:** the first database run after the no-database run failed eight tests with `403`, every one the policy client's `opa_unreachable` at about 420 ms, the sidecar answering past the client's deadline on a loaded machine; the two runs after it, one on an idle machine, passed everything. It is the client failing closed, as designed, and not this unit's.


## 12. As built (unit 47b, 2026-10-06)

§ 4 as written: `lib/rubric/changeClass.ts` (the anchor of each kind of change, `classOf`) and `lib/rubric/thresholds.ts` (`routeOf`, `consistent`, `predict`), pure, with every row of § 4.2 a case in order (§ 10.3) and the refusals of § 10.4, under the same coverage gate and lint rule as the score.

- **`classOf(anchor, changeKind, proposal)`** returns the class, the curator's reason (for `CURATOR_ALWAYS` and no other) and the row of § 4.2 that decided. The anchor is its kind, the figure's row where it is one (`tier`, `scenarioParam`) and its text; the proposal is its text and the source tier it names, if any (spec 31 § 4: a row's `tier`, or `newTier`). The pairing of kind and anchor is not checked here: `ANCHOR_OF_CHANGE_KIND` is the table of § 4.1 and the schema sensor (48c) refuses the rest; a value set with no figure row classes as a cited figure, not a derived one.
- **Rule 3 reads the scope sensor's vocabulary**, as § 4.2 and D4 say: `aboutOperatingEquipment(text)` is a new export of `lib/sensors/scope.ts`, a verb of its list with an instrument tag or an object of its list, the two equipment rules of `scopeRules` together; a test holds it to those on every question of the golden set. So the lint rule of § 10.2 names one import beyond the folder and the schemas: `@/lib/sensors/scope`, itself pure. Both the anchored and the proposed text are read.
- **Rule 4** takes "the book's seven" as `SourceTierSchema` spells them: a tier given in another spelling is a new tier, and the schema of the proposal (48b) is what keeps a contributor's choice to the seven.
- **`routeOf(rules, { changeClass, score, verdicts, strongestTier })`**, in order: a failed sensor declines at intake in any class and at any score (the Rubric screen's "a failing sensor declines at any score"); a class with no thresholds goes to the curator; a class with a single tier (`onlyTier`, the derived figure's A) declines at intake without an item of that tier and asks for more by rule under its acceptance, each naming the tier (D6); under the floor declines; the rest is the adjudicator's, the acceptance included, since accepting is the adjudicator's to say with its reasons. The result carries `namedTier` for the two rules that name one; for every other decline `wouldSuffice` names the tiers.
- **`consistent(rules, decision, routing)`**: accept only at the acceptance or above, with no sensor failed, and on the single tier where the class has one; request more only at the floor or above; decline always; `CURATOR_REVIEW` never, since sending a suggestion to the curator is the product's to do when the adjudicator fails (invariant 15), and nothing is consistent for a class no score decides. The spec's signature passes the thresholds and the class; here the rules are passed and the thresholds read from them by the class, as every function of the folder does.
- **`predict(rules, routing)`** is `routeOf` and, on the adjudicator's route, the decision `consistent` would allow at this score: accept, else request more. It carries the thresholds and, for a request for more, `shortBy`, the acceptance less the score: `request more · short by 4` for S-15-0377, 40 for S-22-0356 under its rule. A property test runs it against `routeOf` and `consistent` on every class, every score from 0 to 110, both sensor states and three strongest tiers: the prediction and the outcome cannot disagree.
- **The verdicts** are read by `result` alone: one `FAIL` declines, `WARN` and `NA` do not, whichever sensor it is; which sensors count as intake's is the caller's (50a).

Verified:

| § 10 | What | Result |
|---|---|---|
| 3 | every row of § 4.2, in order (`lib/rubric/changeClass.test.ts`) | 12 cases: each row, a text edit tripping rule 3 by its passage and by its proposal, a figure with `scenarioParam` of a cited and of a derived tier, each of the seven tiers not tripping rule 4 and `REGULATOR` tripping it, and first-match-wins over four pairs of rows |
| 4 | `consistent` and `routeOf` (`lib/rubric/thresholds.test.ts`) | 19 cases: an accept at 66 against 70 refused, and at the acceptance less one in every class; with a failed sensor refused; a derived figure on tier B refused and on A at 100 allowed; a request for more under the floor refused; a derived figure with a tier A item at 60 asked for more by rule naming A, with a tier B item at 85 declined at intake naming A |
| 7 | the four worked examples | classed as their screens print; routed adjudicate, declined at intake, request more by rule, adjudicate; predicted accept, decline, request more short by 40, request more short by 4 |
| 1 | `npm run test:rubric` | 82 cases over the three files, branches 100 % (120 of 120) |
| 1 | 23 rules weakened one at a time in place (every row of the class, their order, each condition of the routing and of consistency, the prediction's decision and its distance) | 23 of 23 caught by a test that names the rule; one only after a case at the acceptance less one was added |
| — | `aboutOperatingEquipment` on the golden set (`lib/sensors/scope.test.ts`) | equals the two equipment rules of `scopeRules` on every question; four passages of prose as expected |
| — | the whole suite | `npx tsc --noEmit` 0; `npm run lint` 0 warnings; without a database 1,260 passed, 220 skipped in 149 files (the rows suite's known failure aside); with the database and the engine, purge excluded, 148 files and 1,463 tests passed, 17 skipped, twice, after a first run failed two cases on one policy timeout as § 11 saw it; `npm run test:ledger` 100 %; `npm run build` 0; `npm run secrets:scan` 0 findings |


## 13. As built (unit 47c, 2026-10-06)

§ 5 as written: `rubric/v1.2/rubric.json` with its `manifest.json`, `RubricSchema`, `npm run rubric:publish -- v1.2`, and the two public endpoints. The page (47d) is not here.

- **The file** has § 5.1's nine keys in § 5.1's order, and holds numbers, enumerations, ids and days and no sentence (`freeTextIn(RubricSchema)` finds none, and the walker learned that a day is as much an instant as a timestamp). Its rules are byte for byte the fixture `RUBRIC_V1_2` the rubric's suites assert against; a test holds the two equal. The page's words, the tiers' names and examples, the four examples' descriptions and the changelog's sentences, are the catalogue's (§ 6, 47d), not the file's.
- **`chips`** is the screen's seven: `PRIMARY B`, `VENDOR C`, `ANALYST D`, `PRACTITIONER E`, `ILLUSTRATIVE` none (an assumption, not evidence), `DERIVED A`, `OPEN U`. The screen's eighth row, "no chip → F, G", is not a chip and is the page's row.
- **`examples`** are the four with every number of their arithmetic: the items as graded (tier, relevance, stake, age, publisher left out), each item's base, factors and adjusted score, the suggestion's score with the index of the strongest and of the corroborating item, the class's thresholds, the route and the decision. `tests/rubric-file.test.ts` recomputes every one of them from the items with `factorsOf`, `adjustedOf`, `scoreOf`, `routeOf` and `predict`, and holds them equal to the fixtures: the file cannot state a number the arithmetic does not produce.
- **`changelog`** is `v1.0` on 2026-01-15, `v1.1` on 2026-04-01 and `v1.2` on 2026-07-01, the three dated entries of the screen; the schema holds that it ends with the file's own version on the day it applies. The screen's fourth cell, "next · Q4 2026 review" with an override rate, is a sample measurement and is not in the file (§ 6: a number nobody measured is not printed).
- **`publishedAt` and `appliesAt` are both 2026-07-01**, the one date the screen gives v1.2. § 8's "announced 30 days before it applies" is the process of a rubric change, out of scope, and the screen gives no second date; a date invented to be thirty days earlier would be a number no source has. The schema holds only that a rubric applies on or after the day it is published.
- **`manifest.json`** pins the sha256 of the file's text, normalised as a guide's prefix is (LF, one trailing LF), and `npm run rubric:pin -- <version>` writes it, as `guides:pin` does for a guide; the spec did not name the script and a new version cannot be pinned by hand. The pin parses the file first, so what is not a rubric is not pinned.
- **The loader is `lib/rubrics/load.ts`**, outside `lib/rubric/`, which is pure by lint and reads no file: `loadRubric(version, dir?)` hash-checks, parses and refuses a changed byte, a file that is not a rubric and a folder named for another version than the file says; `hasRubric`, `listRubricVersions`, `rubricText`, `readRubricManifest` beside it.
- **The rows** are written through the door: `publishRubricVersion` writes the `RubricVersion` row with the file's `tiers`, `adjustments` and `examples` as JSON and one `Threshold` row per class (both numbers null for the curator's class), once; a version published already with the same hash is left as it is, one with another hash is refused (`CONFLICT`); `readRubricVersion` and `currentRubricVersion` (the latest `appliesAt` at or before now) read them. These three take no caller: an operator's command writes and anybody reads. **`Threshold` has no column for `onlyTier`**, the derived figure's single tier: the rows carry the two numbers and the file is the authority (unit 46a's table did not foresee it; a column is a model change and so a unit of its own, in the tracker for Andre).
- **`npm run rubric:publish -- v1.2 [--dir <folder>]`** loads (so a changed byte is refused before a row is read), publishes, and says `published` with the day it applies and the count of threshold rows, or `is published already … nothing written`; `--dir` is for a test that must not touch the repository's folder.
- **The endpoints** (`lib/api/endpoints/rubric.ts`) are public, 120 a minute per address as the content reads are, with the public cache rule, under the policy's `content` resource (`rubric`, `rubric/<version>`). `current` is the row in force; `{version}` takes a version's form (`v1.2`) and is `400` for anything else and `404` for a version not published, in the API's error form. The body is the file, loaded and checked against the row's hash: a published row whose file is missing or differs is a fault (`500 INTERNAL`) and never a body. The endpoints are made by `rubricEndpoints(deps)` so the rows and the files can be doubled, as the handler's own tests double the pipeline.

Verified:

| § 10 | What | Result |
|---|---|---|
| 5 | `npm run rubric:publish -- v1.2`, twice, through the command (`tests/integration/rubric-publish.test.ts`) | the first run wrote the row and five threshold rows, or said it was published already; the second said so and wrote nothing; the row's hash is the manifest's and its JSON columns equal the file |
| 5 | the command on a copy with one byte changed (`"bonus": 11`) | exit 1, `rubric v1.2 has changed … never edited in place`, before anything was read from the database |
| 5 | the door asked to publish v1.2 under another hash | `CONFLICT`; the row unchanged |
| 6 | `GET /api/v1/rubric/current` and `/v1.2` through the routes and through the development server | 200, the body equal to the file byte for byte of its JSON, `ratelimit-limit: 120` and the public cache rule; `/v9.9` 404 `NOT_FOUND`; `/latest` 400 `INVALID_INPUT` |
| 6 | the endpoints with the rows and the files doubled (`lib/api/endpoints/rubric.test.ts`) | 7 cases: the file of the version in force and not of one applying later; nothing published 404; a published row's file missing or changed 500 |
| — | the file (`tests/rubric-file.test.ts`) | 10 cases: loads against its manifest; its rules are the fixture; the chips; the four examples equal to the fixtures and to the arithmetic; no sentence; a changed byte, a non-rubric pinned to its own hash, a folder of another version, and what is not a version, each refused |
| — | the schema (`lib/schemas/rubric.test.ts`) | as before, with `RubricSchema` on the file |
| — | `tests/improve-door.test.ts` | the two new tables are named in `lib/db/improve.ts` and nowhere else |
| — | the whole suite | `npx tsc --noEmit` 0; `npm run lint` 0 warnings; without a database 1,277 passed, 224 skipped in 152 files (the rows suite's known failure aside); with the database and the engine, purge excluded, 151 files and 1,484 tests passed, 17 skipped, twice; `npm run test:ledger` and `npm run test:rubric` 100 %; `npm run build` 0; `npm run secrets:scan` 0 findings; `openapi.json` regenerated |

**On this machine rubric v1.2 is published**: the integration suite's first run wrote the same row the command writes, and it is left in place, as the suite's comment says. A machine that has not run the suite publishes with `npm run rubric:publish -- v1.2`.


## 14. As built (unit 47d, 2026-10-06)

§ 6 as written: `/[lang]/rubric`, public, the Rubric screen's structure and strings, every number read from the published rubric. It is the last unit of this spec.

- **The page** (`app/[lang]/rubric/page.tsx`, `components/rubric/RubricPage.tsx`, `RubricExamples.tsx`) is rendered per request from the version in force: the row (`currentRubricVersion`) names it and the loader reads its file, hash-checked against the row as the endpoint does (§ 13). "Static per rubric version" is kept as what the page depends on, the version and nothing of the reader; no build is needed when a version is published, and no rubric published is a 404. Every number on it comes from the file: the bases, the factors, the windows, the bonus and its tier, the thresholds, the chips' tiers, each example's arithmetic and score, the changelog's versions and days, the hash in the status bar.
- **The words are the catalogue's**, namespace `rubric` (150 keys): the tiers' names and examples, the four examples' descriptions, notes and footers, the changelog's three sentences, and every label. EN is the screen's, verbatim; PT is a candidate of this unit, listed in the tracker with the others for Andre to confirm. Two numbers in those strings are the screen's references and not the file's: the chapters the header points at for the grader's design (27) and the recalibration (32), constants of the component, as the screen names them.
- **Differences from the screen**, each deliberate: `Suggest a change` is not rendered (§ 6); the status bar has no `κ vs curators` cell (§ 6) and no `adjudicator guide` cell, since no adjudicator guide exists until unit 50d; the header's stamp has no `next review Q4 2026`, a date the file does not hold (§ 8 puts the quarterly review out of scope); the screen's changelog has a fourth cell, `next · Q4 2026 review` with an override rate, which is a sample measurement and is not shown; the worked examples' ids are text, not links, until the record page exists (unit 52c), after which they link where the suggestion exists (§ 6); `opened from ch15 · 15.9 sources` appears only with `?from=<section id>` and without the screen's chapter version. The factor cells wrap rather than hold `nowrap`, and the chips' table and the thresholds' table share their width in fixed columns, because the PT suite measured both spilling at 390 px otherwise.
- **The tier letters are the file's, not the page's**: the examples' `56 C`, the chips' badges and the corroboration's tier are rendered from the rubric, so a rubric that renamed or renumbered a tier would show as it says.
- **The banded bar** (ui-context § 7) is drawn with data-driven widths, fail-bg to the floor, warn-bg to the acceptance, ver-bg above, marks at both, and carries its numbers as its accessible name; the curator's class has the dashed empty bar. The legend is the instrument's footer.
- **The two arithmetic boxes** are the screen's two forms: one item shows its base with the tier's note and each factor with its own (ex. 3's `relevance · their set` is the example's phrase); where the base is already under the floor, `× —  no adjustment can lift it`; several items show a product line each, `max`, `+ 10` with who corroborates, and the result. The threshold's note after the result (`≥ 70 cited date`, `< 25 floor`, `< 100 tier A only`, `< 70 cited price`) is each example's string with the file's numbers in it.
- **In the suites**: the page is in the PT truncation suite's list (`rubric`, § 10.7), and `tests/e2e/rubric.spec.ts` reads the file from the repository and holds the page to it in EN and PT, at 1440 and at 390: eight tiers with their bases, the rule's bonus and tier, eight chip rows, the four multiplier cells formatted for the language, every class's two numbers and its bar's name, the four examples' ids, scores and decisions, the changelog's cells, the status bar, the download's address, no `Suggest a change`, no sideways scroll, and axe finding nothing. It leaves no part for the gate's report.

Verified:

| § 10 | What | Result |
|---|---|---|
| 7 | `/en/rubric` and `/pt/rubric` at 1440 and 390 (`tests/e2e/rubric.spec.ts`) | 4 of 4, and the `from` parameter's case: the structure as the screen draws it, every number equal to the file's, zero axe violations |
| 7 | the PT truncation suite with the page in its list | 36 renders, 9,606 labels, none truncated; the page's two renders 382 and 367 labels. Three runs before it found the chips' table and the thresholds' table spilling at 390 px with the padded catalogue, and a `nowrap` on `A only`; each was changed and measured again |
| — | looked at in EN and PT, light and dark, 1440 and 390 | as the screen, with the differences above |
| — | the whole suite | `npx tsc --noEmit` 0; `npm run lint` 0 warnings; the catalogues' keys at parity; without a database 1,277 passed, 224 skipped in 152 files (the rows suite's known failure aside); with the database and the engine, purge excluded, 151 files and 1,484 tests passed, 17 skipped, twice; `npm run test:ledger` and `npm run test:rubric` 100 %; `npm run build` 0; `npm run secrets:scan` 0 findings; no hex, radius or shadow in the new components |
