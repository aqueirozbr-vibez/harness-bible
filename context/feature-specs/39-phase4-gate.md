# 39 · The Phase 4 gate — feature spec (the eleven criteria as measurements, the curated set of suggestions, the report)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: overview § Success criteria · Phase 4 (eleven criteria) and § Cross-cutting; PRD "Phase 4 … Gate: adjudication precision < 3% on 100 curated suggestions; override rate < 10%; rubric published"; TRD § 8.1 (the evidence grader's reference set of "100 curated suggestions with curator-assigned tiers") and § 11; `22-phase2-gate.md`, whose form this spec follows.

Prerequisite specs: `28` to `38`, all built.

Scope: tracker unit 56. `npm run gate:phase4`: one report that says, for each criterion, pass, fail, blocked or deferred, with the number it measured. It builds no feature.

## 1. Purpose

The gate exists so that "Improve is done" is a report and not an opinion. As in the earlier phases (`lib/gate/`), a criterion nothing measured is never a pass: it is `blocked` when it needs something outside the repository (curators, a paid run, a host for the book), `deferred` when a later unit measures it.

## 2. The criteria

| # | Criterion (overview) | Measured by | Can pass on this machine |
|---|---|---|---|
| P4.1 | the four worked examples end to end, with their documented outcomes | the integration tests of specs 33 § 8, 36 § 11.2 and 37 § 12.2, run by the gate against the stub gateway: example 1 accepted and merged with a patch bump; 2 declined at intake with zero frontier tokens and tiers B and D named; 3 request more naming a tier A run on the chapter's lab; 4 request more, then accepted only by an override recorded with `OV-IND-02` | yes |
| P4.2 | 100 % of rubric branches; the score is a maximum plus at most one 10; thresholds route by class; a derived change needs the derive script in the branch | `npm run test:rubric`'s coverage; the property tests; spec 37 § 12.4 | yes |
| P4.3 | no anchor, a rationale over 200 words, an anchor missing at the current version: rejected at intake with the sensor named | the three endpoint tests of spec 31 § 10.3 | yes |
| P4.4 | curator-always classes never reach the adjudicator; the policy denies it and denies a curator outside the part | OPA's tests; over every decided suggestion in the database, none of class `CURATOR_ALWAYS` has an adjudication by a model | yes |
| P4.5 | the adjudicator's input has no name, employer or other suggestion | the contract test of spec 33 § 11.6 | yes |
| P4.6 | on 100 curated suggestions: precision under 3 %, override rate under 10 %; the meter per criterion; a rubric review record over 20 % | § 3 | **blocked**: needs the set labelled by curators and one real run |
| P4.7 | an accepted change opens a branch, the lab suite runs, the merge is blocked when the chapter's lab fails and proceeds when an unrelated one fails, the version bumps, the next release ingests with a matching render hash | spec 37 § 12.2, 12.3 on a local repository | the local part yes; "CI runs the lab suite" **blocked** on a host and a runner (spec 37 § 9) |
| P4.8 | every record from submission to merge verifies; the exported trailer's head hash matches; a per-chapter export includes neighbours from other chapters | `verifyView` and `verifyExport` over the examples' records and exports | yes |
| P4.9 | three tier U declines in 30 days set `throttledUntil`; new submissions return 429 with the reason | spec 33 § 11.10 | yes |
| P4.10 | the rubric is published at `/[lang]/rubric`, downloadable as JSON, its version on every adjudication | the page and the endpoint answer; every `Adjudication` row has a `rubricVersionId` | yes |
| P4.11 | an admin exports an audit pack per account and per chapter, sees the budget by consumer, and the gateway refuses at the cap with no overage in `BudgetLedger` | spec 38 § 8; a suggestion pushed against a capped principal on the stub: the call is refused and no row exceeds the cap | yes, for the individual account; the organisation's admin is **blocked** with organisational accounts |

And one condition the PRD lists as a dependency, reported beside the criteria: **a roster of at least two curators per part** (`CuratorRoster`), per part, with the parts that fall short named.

From the cross-cutting list the gate also reports, as measures without a verdict of their own: the time from submission to decision for automatic classes against 10 minutes, and to completion against 24 hours, over the suggestions in the database.

## 3. The curated set (P4.6)

- **The set**: `golden/suggestions-<release>.jsonl`, 100 suggestions generated from the release's own rows as the assistant's golden set is (`lib/golden/`): each names a real anchor, a change kind, a proposed change and evidence documents kept as fixture files, with the outcome the rubric's arithmetic expects where arithmetic decides. The generator spreads them over the change classes and the tiers. A curator may edit any line.
- **Labels**: a curator assigns each item's tier and relevance and the decision they would take, in a labels file read strictly (the Phase 2 pattern, `lib/gate/labels.ts`). This is the evidence grader's reference set too (TRD § 8.1: agreement on tier and relevance at or above 0.7).
- **The run**: the set through the real workflow with the real gateway, on a principal and a budget Andre names. It is a paid run, so it is his to start (as the golden run of Phase 2 is); the gate prints the command and an estimate first and never starts it itself.
- **The measures**: precision is "accepted then reverted", which a run alone cannot show; on the set it is read as accepted by the adjudicator where the curator's label is decline. The override rate is the share of the adjudicator's decisions the labels disagree with, overall and per criterion, with a `RubricReview` opened for any criterion over 20 %.

Until the labels and a run exist, P4.6 is `blocked` and says which of the two is missing.

## 4. The report

`pipeline/reports/phase4-gate-<release>.json` and the printed table, in the form `lib/gate/common.ts` already gives the two earlier gates; exit 1 unless every criterion passes.

## 5. Out of scope

- The researcher's criteria (spec 44).
- Load and availability measures of § Cross-cutting.

## 6. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | How precision is read on a set that is never merged | the adjudicator accepted where the curator's label declines | "accepted then reverted" needs time and merges; the set has labels instead, and a curator declining what was accepted is what a revert is |
| D2 | Who starts the paid run | Andre | the standing rule for every real-provider run in this repository |

## 7. Verification (in addition to `ai-workflow-rules.md` § 7)

1. `npm run gate:phase4` on this machine, with the stub and a local book repository: P4.1 to P4.5 and P4.8 to P4.10 pass with their numbers; P4.6 is blocked naming the labels and the run; P4.7 passes its local part and names the blocked part; P4.11 passes for an individual account.
2. Each builder of `lib/gate/phase4.ts` has a unit test for pass, fail and blocked, as the Phase 2 builders have.
3. The gate makes no model call to a real provider: with the gateway pointed at a closed port it produces the same report.

## 8. As built (unit 56: the gate, the curated set and its run, 2026-10-10)

- **`npm run gate:phase4`** (`scripts/phase4-gate.ts`; the rules in `lib/gate/phase4.ts`, pure, with a test for each builder's pass, fail and blocked). It runs the suites the criteria name once, through vitest's JSON reporter — the worked examples, the merge's integration suite, the suggestion workflow's, the intake's sensors and endpoint, the adjudicator's contract test, the thresholds, the ledger's export and verifier, the audit export's endpoints and workflow, the meter, the gateway's budget rows and client, the evidence activities — and each criterion selects its tests by file and name, so a test renamed away is "no such test in the run", a fail, never a pass by absence. The rubric's branches come from `npm run test:rubric`'s coverage summary (120/120). The policy's tests run through `opa test policies` (`OPA_BIN` or the PATH). The database gives the curator-always check (no adjudication by a model on a `CURATOR_ALWAYS` class), the adjudications' versions, the roster's counts, the two measures and the capped principals' months; the running app answers `/en/rubric` and `/api/v1/rubric/current`. The report is `pipeline/reports/phase4-gate-<release>.json` and the printed table in `lib/gate/common.ts`'s form, with the roster condition and the two measures under it; exit 1 unless every criterion passes.
- **On this machine, 2026-10-10**: P4.1 to P4.5 and P4.7 to P4.11 pass with their numbers (the four examples 4/4; branches 120/120 and 91 rubric tests; the intake's 25; opa 72/72 and no curator-always change by a model; the contract test; the merge's 11 on a local repository, CI named blocked for want of a host and a runner; the four seeded records verified and exported with predecessors; the throttle's two; the rubric page and JSON 200 with v1.2 on every adjudication; the account's 32 and no capped month over — the gateway integration fixture's organisations, whose rows its suite appends past their caps on purpose, left out). **P4.6 is blocked**, naming the labels and the real run. The roster condition is met (six curators a part in development); the measures: five automatic decisions, p95 9.3 h (four within ten minutes — the fifth waited a curator's hand in the queue); no merge in the development database.
- **The curated set** (§ 3; `lib/golden/suggestions.ts`, pure; `npm run gate:suggestions` writes it): 100 suggestions from the release's own rows, deterministic for a release — 35 wording changes quoting a sentence of a section, 25 cited figures and 10 derived ones set to a nearby value, 15 source rows re-verified or re-cited (which the class rule reads as cited figures), 10 claims added, 5 restructures (curator-always) — with 149 evidence documents as fixture files under `golden/suggestions/evidence/`, each written to be of a tier (a regulator's notice, a study, a vendor's page, the trade press, a post, a forum, a screenshot, an unreadable page) at a domain of its own, dated or not, and the outcome the arithmetic expects (the score always, the decision where a rule decides: 18 declines, 1 request for more; 81 for the adjudicator or a curator). `golden/suggestions-2026.09.jsonl` is in the repository, for the curators to label into `golden/suggestions/labels/2026.09.jsonl` (`CuratedLabelSchema`: the strongest evidence's tier and relevance, the decision, the criteria disagreed with).
- **The run** (`npm run gate:suggestions:run -- --stub | --real [--principal <organisation id>] [--limit N]`): each item drafted through the endpoints by the run's own account, its documents served from the fixture files by the examples' fetcher, the real `SuggestionWorkflow` on the test engine with its real activities; on `--stub`, the stub gateway grades and adjudicates as the documents were meant; on `--real`, the real gateway does, charged to the principal named — paid, and Andre's to start (D2): the gate prints the command and about $6.00 and never starts it. It writes `pipeline/reports/suggestions-run-<release>-<grade>[-<stamp>].json`; `--limit` makes a pilot, written as `suggestions-pilot-…`, which the gate does not read. A three-item stub pilot ran on this machine: three suggestions drafted, decided by the stub's adjudicator, written.
- **Decided here, for Andre to see**: a test the criterion names that the run does not hold fails the criterion; P4.7 passes on its local part and names CI blocked, as § 7.1 asks; the four-a-day and the cap's months leave the gateway fixture's organisations out; the account scope's view in P4.8 is the examples' suggestion scope, the per-chapter neighbours being the export suite's until the database has a merged change.
- Verified: `lib/gate/phase4.test.ts` (16 cases), the gate's three runs on this machine, the generator's output read back through its schema, the pilot.

## 9. Review of unit 56 (2026-10-10)

One review of the gate, the set and its run, three lenses (the gate's honesty, the curated set and its run, the house rules). The three lenses raised twenty-four findings; the nine skeptics could not run — the session's usage limit was reached as they started — so the findings were judged by the builder against the code and the evidence each quoted, and the ones that held are fixed in one commit. Duplicates across lenses are counted once.

- **P4.6 could never pass on the generated set** (medium, twice): the five curator-always items end `CURATOR_REVIEW`, which the measure excluded, and the pass wanted a hundred judged. **Fix**: the pass wants the whole set labelled and run; both rates are over the adjudicator's own decisions (39 § 3), the rule's and the curator's items counted beside them. The builders' test has 76 adjudicated, 19 by rule, 5 a curator's.
- **The rates' denominators held the rule's decisions** (medium). **Fix**: as above — `CuratedPair` carries who decided.
- **`opa test` was read as total minus failed** (medium): an errored or skipped test counted as a pass, and the exit code was never read. **Fix**: the PASS line's own number, the exit code, and no count at all a fail (nothing outside the repository is missing when a policy does not compile).
- **P4.1 passed on four tests that stop before two of its outcomes** (medium, twice). **Fix**: the fourth example's override with `OV-IND-02` and the first's merge with a patch bump are selected from their own suites (36 § 11.2, 37 § 12.2); the note says where each is measured.
- **The run drafted a hundred under one account through an endpoint that allows twenty a day** (high). **Fix**: the synthetic account's bucket is emptied before the run, as the gate's own turns empty theirs, and its throttle is lifted after each item (the set's unreadable items would earn it by the third; the throttle is P4.9's suite's); a run with an item not run exits 1.
- **Tier A documents** (high, twice): a document a grader reads can never be A (A is a reproducible lab run), and the stub refuses the header. **Fix**: no A in the cycle; the strongest document is B.
- **Unreadable documents were served as opened, empty pages** (medium, twice). **Fix**: a U document has no file and its URL is one the fetcher does not hold, so the fetcher answers `unreachable` and the item is U by the intake's rules with no grader asked, on the stub and on the real gateway alike.
- **Fast-moving anchors scored as stable** (medium). **Fix**: the generator selects `fastMoving` for figures and rows and the arithmetic reads it.
- **The vendor's stake was never sent to the stub, and a DOI resolver was read as a vendor** (low). **Fix**: the item carries its vendor domain, the stub's header says `vendor` where the document is the vendor's, and resolvers are nobody's vendor.
- **Evidence files were named by the draft's index, not the item's id** (low). **Fix**: `<id>-<k>.txt`.
- **The printed command offered a user id for `--principal`** (low, twice). **Fix**: an organisation id; the run refuses one that is no organisation, or holds no gateway key, before anything is cleared or drafted.
- **A real run with no key wrote a `real` file of U's** (low). **Fix**: `--real` needs `--principal`, the key is checked first, and a real run that made no paid call writes nothing.
- **P4.11's overage covered organisations only and passed vacuously with none** (low). **Fix**: individual accounts' months against `INDIVIDUAL_TOKEN_CAP` where it is set; no capped principal with rows is `blocked`, not a pass.
- **`thresholds.test.ts` ran and counted twice** (low, twice). **Fix**: once, in the coverage run.
- **P4.4's "decided" counted adjudication rows the router never writes** (low). **Fix**: counted by `decidedAt`.
- **P4.10 passed on 200 alone** (low). **Fix**: the JSON must carry the rubric's version.
- **P4.3 did not run the three endpoint cases of 31 § 10.3** (low). **Fix**: the suggestions' integration suite's case and the creation's `ANCHOR_REQUIRED` are selected, one each.

Not taken: a `--real` run to the stub's figures (the stub is as meant), the review's wish for the gate to refuse a `real` file of zero cost at read time (the run refuses to write one).

Verified: `lib/gate/phase4.test.ts` (16), the gate run again (ten pass, P4.1 6/6, P4.3 27/27, P4.4 opa 72/72 with the router's three decisions counted, P4.6 blocked), the set regenerated (100 items, 141 documents), an eight-item stub pilot (eight of eight drafted and decided), the full suite, lint and build.
