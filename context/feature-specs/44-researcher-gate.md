# 44 · The researcher's gate — feature spec (the criteria of Capability 5 as measurements, its series and its dashboard)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: overview § Success criteria · Capability 5, written with this plan (unit 44); Andre's request and answers of 2026-10-05 (spec 27); the invariants this capability adds (architecture § 11, 31 to 35). Its form follows `22-phase2-gate.md` and `39-phase4-gate.md`; its series follow `21-assistant-retention-observability.md` § 5.

Prerequisite specs: `40` to `43`, all built; `39`.

Scope: tracker unit 61. `npm run gate:research`, the researcher's series in `lib/metrics/sql/`, and its dashboard. It builds no feature.

## 1. Purpose

The researcher is the capability with no primary source and the most ways to be wrong quietly: it can leak a question, be steered by a page, spend a month's budget, or fill a curator's queue with proposals nobody should accept. Each of those has a rule in specs 40 to 43, and each rule has a criterion here that can be demonstrated. What cannot be judged before the researcher has run for real is whether its proposals are any good. The gate says so plainly: those are measures it reports, with no threshold, until Andre has a month of them and sets one.

## 2. The criteria

On the stub gateway unless the row says otherwise.

| # | Criterion (overview) | Measured by | Passes without a paid run |
|---|---|---|---|
| R1 | an answered turn starts a run and is not changed or slowed by it; a refusal starts none | spec 40 § 12.3 to 12.5; the turn's `totalMs` over 50 golden questions with research configured and not, compared | yes |
| R2 | the run obeys its limits: 30 days or a gap, the same question once in 30 days, 30 runs a day, both switches | spec 40 § 12.2 | yes |
| R3 | the question never reaches the side that reads the web | the canary of spec 41 § 11.3 and its page-level form, spec 43 § 13.6 | yes |
| R4 | a page cannot make the researcher act | the injection fixture of spec 41 § 11.7 | yes |
| R5 | evidence is only what the product opened itself | every `EvidenceItem` of every researcher suggestion in the database has a `fetchStatus` written by the product's fetcher and a stored text with its hash | yes |
| R6 | nothing the researcher proposed is merged without a curator | over the ledger: every `merged` record of a researcher suggestion is preceded by a `curator` record of action `ACCEPT` on it; spec 42 § 10.5 | yes |
| R7 | what Improve refutes is logged and not proposed | spec 42 § 10.2 and 43 § 13.5: the four records exist, no queue item, nothing shown to the asker but the count | yes |
| R8 | the whole road once: question, run, finding, Improve's acceptance, the proposal shown, a name added, a curator's accept, the merge, the history's `research` mark and the endorser's credit | spec 42 § 10.8 | yes |
| R9 | research spends the platform's budget and stops at its cap | spec 40 § 12.8 and 12.10: no row on a reader's ledger; at the cap the gateway refuses, new turns are skipped, nothing exceeds the cap | yes |
| R10 | a reader's words are gone after 30 days, from the product's rows and from every workflow history | spec 40 § 12.7 and 12.9 | yes |
| R11 | the provider's tools pass through the gateway and their cost is known | `npm run research:check` (spec 41 § 11.1) | **blocked** until Andre runs it: one paid call |

**Amended by feature-specs/48 (unit 75, 2026-10-12)**, for research on request (48 § 25): R1 reads "an answered turn starts no run and its answer is unchanged by research; a refusal starts none" — the gate's own turns count what must not follow a turn (no run, no research call, no `research` in a `final`) and read each answer back as its `final` gave it, and "not slowed" (D2) has nothing left to measure; R2 "a person's research obeys its limits: 30 runs a day, and none where their organisation switched research off", the start endpoint's checks; R3 the canary through the planner, the reader and the writer, whose request holds the question and no tool, and a sent finding's curator pages; R8 the road from an answer's `Start a research` to a curator's accept, `tests/research/road.test.ts`, beside the merge suite; R9 "a run spends the person's own budget and stops at their cap; Improve's vetting of a sent finding spends the platform's research principal, within its cap", read over every person's runs and the principal's months. R4 to R7, R10 and R11 keep their reading, R10 adding a person's run's purge by its own age. § 3's cost of a run is `cost-per-run.sql` over the views of unit 70c: the calls that name a run, whoever paid, over the runs whose reader answered.

## 3. Measures without a verdict

Reported by the gate from the rows, each with its counts, each `not yet measured` until a real run exists. No number here has a target: the sources give none and none is invented.

| Measure | Definition |
|---|---|
| cost of a run | the research principal's spend over the runs that reached the reader stage |
| what a run yields | findings per run; the share of runs the planner ended with nothing to research |
| what Improve does with findings | of valid findings: refuted by the floor, by a sensor, by the adjudicator; proposed |
| the strongest tier of refuted findings | the distribution, and the share of sources graded `U` |
| the researcher's precision | of proposals a curator decided, the share accepted; and of those merged, the share later reverted |
| the adjudicator on research | its agreement with curators on researcher proposals, beside its agreement on people's |
| endorsement | of proposals shown, the share a reader put their name to |
| time | from the answer to a proposal shown; from a proposal to a curator's decision, against the 7 days |

The first month of these is what tells Andre whether 30 days, 10 searches, 3 proposals and US$ 20 (A12 to A14) were the right numbers.

## 4. Series and dashboard

One read-only statement per series in `lib/metrics/sql/`, with the window and the bucket as parameters, as the assistant's are: research runs by state and skip reason; findings by outcome; cost per run; proposals by curator decision. The run-level series read `RESEARCH` ledger records and the research principal's `BudgetLedger` rows; none reads `ResearchRun`, so the dashboard's database role needs no grant on a reader's rows and cannot see who asked. They are registered in `lib/db/RAW_SQL.md`, printed by `npm run research:metrics`, and added to the generated Grafana dashboard with one alert: research spend at the cap before the month's twentieth day, which is information, not an incident.

Spans from the product's own lines (`lib/telemetry/lines.ts`): `research.run`, `research.plan`, `research.read`, each with the run id, counts and the outcome, and never a word of a question, a brief or a page.

**Amended by feature-specs/48 (unit 70, 2026-10-12), for research on request, which a person pays for (A3).** The run-level series no longer read "the research principal's `BudgetLedger` rows" alone: migration `20261012180000_research_views` redefines `ResearchSpend` by run and by payer — every call charged to the platform's research principal, payer `platform`, and anyone else's `RESEARCH` calls and their retrieval's embedding and re-rank naming a run, payer `person`; an organisation's Assistant calls are never in it — and adds `ResearchFlag`, the day, kind and coded reason of each flag a person puts on their research, naming no person and no run. `cap.sql` counts the platform principal's refusals alone (a person's cap is their own budget's); `cost-per-run.sql` is the cost of the calls that name a run over the runs whose reader answered, the platform's vetting of sent findings being no run's; a sixth statement, `flags.sql`, counts the flags by kind and reason. The dashboard's role is granted `ResearchSpend.payer` and `ResearchFlag`'s three columns, and still nothing of `ResearchRun`. Spans gain `research.write`, the writer's step, with the paragraphs the report sensor kept and dropped.

## 5. The report

`pipeline/reports/research-gate-<release>.json` and the printed table; exit 1 unless every criterion passes; § 3's measures printed beneath, never affecting the exit.

## 6. Out of scope

- A quality threshold for proposals.
- A comparison of the researcher's proposals with what a person would have found.

## 7. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | No target for the researcher's precision yet | none until a month is measured | rules § 4.5; a target set before any measurement would be a guess wearing a number |
| D2 | R1's "not slowed" | the turn's median `totalMs` with research configured is within the run-to-run spread of the same 50 questions without it, the spread measured in the same session | the hand-off is a few row writes and one call to the engine; a fixed number of milliseconds would be invented |

## 8. Verification (in addition to `ai-workflow-rules.md` § 7)

1. `npm run gate:research` on this machine with the stub: R1 to R10 pass with their numbers; R11 is blocked and prints the command.
2. Each builder has a unit test for pass, fail and blocked.
3. The series return the same numbers in `npm run research:metrics` and through the dashboard's role; that role is refused a `SELECT` on `ResearchRun`.
4. No span or log line of a run contains the canary word of spec 41 § 11.3.

## 9. As built (unit 61a: the series, the dashboard, the lines, 2026-10-11)

Unit 61 is built in two parts: 61a, § 4 — what the gate's measures and an operator read — and 61b, § 2, § 3 and § 5, the gate itself.

- **How a run ended, in its record** (40 § 6.3, amended): the `RESEARCH` payload gains `end` — `DONE`, or `SKIPPED` or `FAILED` with the skip's or the failure's code (`ResearchEndSchema`; a code of the run's own, else `INTERNAL`, since the engine names a crash by its error's class: `runEndOf`). Optional, so the records written before stay valid; they read as `planned brief`, `planned nothing`, `planned failed`.
- **The lines and spans**: one line kind, `research` (`lib/telemetry/print.ts`, the collector's allow-list), with three spans — `research.plan` and `research.read` as each agent's step ends (its outcome: `brief`, `nothing`, `budget`, `found`, `purged`, `failed`; the code it failed with; the reader's findings, searches and page reads), and `research.run` as the run ends, from the workflow's conclude step (the state, the code, the row's counts, how many findings were proposed and refuted, the run's whole time) or from the hand-over for a turn it skipped (the skip, the hand-over's time). Each carries the run's id on the turn's trace and no text; a failure is the one error. A line that cannot be printed changes nothing of the turn.
- **Two views** (migration `20261011090000_research_metrics`): `ResearchFact` — the `RESEARCH` records' facts (planned, ended, code, searches, page reads, the findings' outcomes) and the curators' accepts and declines of researchers' proposals — and `ResearchSpend` — the calls charged to the organisations research is charged to (kind, alias, outcome, cost, and the run a research call served). Every row is dated to its day. The dashboard's role is granted their columns and nothing of `ResearchRun`, `ResearchFinding`, `ProposalEndorsement` or `LedgerRecord`, whose payloads the assistant's spec already kept from it (21 § 5.2).
- **Five statements** in `lib/metrics/sql/research/`: runs by how they ended (and all), findings by outcome (and all), cost per run (the principal's spend over the runs whose reader the gateway answered, by the day of the calls), proposals by curator decision (each a share of the bucket's decisions: the accept line is § 3's precision), and calls refused at the cap (before the twentieth and from it). `npm run research:metrics -- --month YYYY-MM` prints them (`lib/metrics/research.ts`, through the assistant's `runStatement`).
- **The dashboard "Research"** (`infra/observability/grafana/dashboards/research.json`, generated by `npm run observe:generate` from `lib/metrics/researchDashboard.ts`): three numbers of the range, a panel per series by day, and a Loki panel of every run's end from its `research.run` line, by outcome and code. **The one alert** (`provisioning/alerting/research.json`): the cap's line before the twentieth over the last day, severity `info`.
- Verified: `lib/research/record.test.ts`, `workers/research/validate.test.ts` (the end in the record); `lib/telemetry/spans.test.ts`, `workers/research/afterTurn.test.ts`, `workers/activities/research.test.ts` (the lines); `lib/metrics/research.test.ts` (each statement reads only the two views, the three parameters, the five columns), `lib/metrics/researchDashboard.test.ts`, `tests/observability.test.ts` (the grants, the generated files); `tests/integration/observability.test.ts` — § 8.3: each research statement run as `hb_metrics` returns the rows the application's own role reads, and the role is refused `ResearchRun`, `ResearchFinding` and `ProposalEndorsement`. Live: `npm run research:metrics -- --month 2026-10` on the development database.

Decided here, for Andre to see:
- **Runs by state come from the records, which exist only for runs that reached the planner.** A turn the hand-over skipped (off, deduplicated, the day's limit, the cap, unavailable) has a `ResearchRun` row and no record; the dashboard counts it from its `research.run` line in Loki. The alternative, a grant on `ResearchRun`'s state columns, is what § 4 rules out.
- **The views, not grants on the ledger.** The role cannot read `LedgerRecord.payload` (21 § 5.2: an `answer` record holds a message's id and its question's hash), so research reaches it through a view that lifts out of the records the facts the series need and nothing else.
- **This machine's ledger holds the test suites' research records** beside the real runs' — 320 records in October against one real run with a reader — as it holds their `answer` records; the series count them all, as the assistant's do, and the gate says so beside its measures.

## 10. As built (unit 61b: the gate, 2026-10-11)

`npm run gate:research` (`scripts/research-gate.ts`, the rules pure in `lib/gate/research.ts`): the suites the criteria name, once, through vitest's JSON reporter with a store of their own and **without the research principal in their environment**; the policy's tests through opa (`lib/gate/run.ts`, lifted from the Phase 4 gate, which now uses it too); R1's own turns; the database and the ledger for R5, R6 and R9; the facts `npm run research:check` now writes, for R11. It writes `pipeline/reports/research-gate-<release>.json` — the criteria, § 3's measures, R1's numbers turn by turn, and the suites — prints the table and the measures beneath, and exits 1 unless every criterion passes.

**On this machine, 2026-10-11, run three times (the third after the review's fixes, § 11): R2 to R10 passed each time and R11 is blocked; R1 failed on the first and the third, and passed on the second.**

| # | How it is measured | Here |
|---|---|---|
| R1 | the gate's own turns (`workers/gate/researchTurns.ts`) through the workers over the stub: 50 answered golden questions without research, with it, and without it again — the hand-over the product's own, its rows and marks real, its engine call on a queue no worker reads (`hb-research-gate`), every run it started ended and every mark taken back — then a turn whose engine refuses the start and one refusal of each cause with research configured; the hand-over's suite, eligibility's refusal row, the contract that no endpoint carries what a turn hands over | pass on the second run, fail on the first. Run 1: to the final event 172 ms without research, 191 ms with it, 171 ms without again — 20 ms over a spread of 1 ms, slowed by D2; `totalMs` 74 / 85 / 74 ms. Run 2: 173 / 173 / 155 ms — 9 ms within a spread of 17 ms (per question, 7 ms against 23 ms); `totalMs` 75 / 72 / 72 ms. Run 3: 168 / 173 / 159 ms — 9 ms just past a spread of 9 ms; `totalMs` 73 / 72 / 72 ms. Every run: 50 of 50 answers unchanged, 30 runs started (6 deduplicated, 14 past the day's 30), the engine's refusal read SKIPPED · UNAVAILABLE, 4 of 4 refusals with no run and no research call |
| R2 | eligibility, one test a row; the switches and the marks on the database; a skipped turn's row | pass |
| R3 | the canary end to end (the planner alone; since 61b also no printed line, no span — § 8.4 — no payload of the run's history and no curator's page: the queue with the proposal selected and its record carry neither the asker's id, name or address nor five words of the question, and the research log neither); its two halves at the agents | pass |
| R4 | the injection fixture end to end and at the reader; `SOURCE_NOT_SEEN` | pass |
| R5 | every evidence item of every researcher's suggestion in the database: a fetch status, a text only where the fetcher opened the page, its hash, the text in the workers' store; the suites' findings graded from what the fetcher served | pass (2 items of 2 suggestions, both opened and stored) |
| R6 | over the ledger, every `merged` record of a researcher's suggestion after a curator's `ACCEPT` on it; every decision path of origin `RESEARCHER`; **the merge itself now refuses a researcher's proposal without a curator's accept** (`NO_CURATOR_ACCEPT`, `workers/activities/merge.ts`), tested in the merge suite; `NOT_FOR_RESEARCH`; opa 74 of 74 | pass (no researcher's suggestion merged on this database yet) |
| R7 | the refuted run end to end; closed is refuted; the research log names what refuted it | pass |
| R8 | the road in the two suites that can run it — the research suite from the question to a proposal with a name on it, the merge suite (new case) from a curator's accept of a researcher's proposal with a reader's name on it through the check, the merge and a release to the merged record with no contributor and the reader as its endorser — and the history's presenter on that record | pass |
| R9 | no research row on any principal but research's; the principal's months within its gateway budget; the suites at the cap | pass (2026-10: $0.89 of $20.00) |
| R10 | the purge on the suite's own reader; a purge met on the way; every payload of a completed run's history an id, a value, a hash or an instant (40 § 12.7, new) | pass |
| R11 | the newest `pipeline/reports/research-check-<date>.json` | **blocked**: `npm run research:check` (one paid call) has not been run since it began writing its facts |

The measures (§ 3), from this database: a run that read cost $0.89 (one run, the real one of 2026-10-10); 1.45 findings a run that planned a brief (252); planned nothing 10.7 % (39 of 364 records); findings PROPOSED 160, DUPLICATE 128, INVALID 39, REFUTED 39 (366 in all); refuted by the floor 1, its tier G; no curator's decision, merge or endorsement of a researcher's proposal yet. The records are mostly the suites' — 364 against one real run that read — which the report says beside them

Decided here, for Andre to see:
- **R1's "not slowed" is the time to the `final` event, not `totalMs`.** D2 names the turn's `totalMs`, which the answer fixes before the hand-over runs (40 § 6.1, amended in the review of units 57 and 58): measured there, nothing research does could ever slow it. The `final` event is what a reader waits for and what the hand-over sits in front of. Both are measured and reported.
- **By D2's rule, R1's verdict on this machine turns on the run.** The hand-over (the marks, the run's row, the engine's start) costs some 10 to 20 ms on a stub turn of about 170 ms, which is the size of the stub's own run-to-run noise: the first run's two passes without research had medians a millisecond apart, so 20 ms read as slowed; the second's were 18 ms apart, so 9 ms did not; the third's 9 ms apart, against 9 ms. In the first run the turns' own `totalMs` was higher in the configured pass too, which the hand-over cannot touch: the workflow engine keeps its history in this machine's application database server (`POSTGRES_SEEDS: db`), so each start writes beside the turns' queries. Against real turns of seconds the difference is a fraction of a second; D2 is Andre's, applied as written: **For Andre to decide** in the tracker.
- **The gates' stub stack hands its turns to research only when told to.** Until 61b it used the turn's default hand-over, which on a machine that configures research (this one, since 2026-10-10) would have started a real run — the real provider, the research budget — for every answered turn the Phase 2 gate or `gate:golden -- --stub` asked. Its default is now research off (`researchOffDeps`); the researcher's gate gives its own. A real golden run (`--real`) goes through the running workers and does hand its answers to research, on research's own cap: said where its command is given.
- **R8 is run in two suites**, not one test: a merge publishes a release, which the merge suite does into a database of its own; the research suite runs on the development database, whose release must not move.
- **The merge refuses a researcher's proposal with no curator's accept** whatever path reached it: the record a merge follows from is the newest accept, and the adjudicator's recommendation is a `decided` record of `ACCEPT`.
- **§ 3's measures read the records, the research principal's calls and the improvement tables**; runs and their findings come from the same records, so a yield is over the runs whose findings it counts. On this machine the records include the suites' runs.
- **The researcher's gate's improvement reads are the door's** (`researcherEvidence`, `researcherSuggestionsForGate`, `adjudicatorAgreement`), as the Phase 4 gate's are.

Verified: `lib/gate/research.test.ts` (each builder's pass, fail and blocked, D2, the measures, the report); `tests/integration/research-run.test.ts` (the lines and spans, the history, the pages); `tests/integration/merge.test.ts` (the researcher's road to a release, and the refusal); the gate run three times on this machine.

## 11. The review (unit 61, 2026-10-11)

One review of the unit (61a and 61b): two lenses — the gate and its turns; the series, the views, the grants and the lines — raised ten findings; a skeptic each judged the eight most severe: four confirmed, three distinct, and four refuted. The builder judged the two left; both were real and were fixed with the rest. Fixed in one commit:

| # | Finding | Fix |
|---|---|---|
| 1 | The gate took back its marks by deleting every key at its instant, and a turn with one fresh section re-marks every section it cites: a reader's mark the gate's turn had re-dated was deleted, and a later real turn citing that section alone would have started a paid run the thirty days should have skipped. The product's own undo, when the engine refuses a start, had the same flaw (medium; two findings) | `removeRunMarks(question, sections, at, before)` puts each key back as it stood before the run wrote it — gone where there was none, the earlier mark where the run's upsert re-dated one — and touches only a key still at the run's instant, so a mark written since stands; the hand-over's undo passes the marks it read, and the gate keeps the hand-over's own read and takes its marks back newest first. Verified on the database (`tests/integration/research-rows.test.ts`) and by the gate itself: the marks table before and after a run of the gate is the same, a reader's real marks of that evening included |
| 2 | The rows suite, which the gate runs, wrote over the platform's budget mark and deleted it after (low) | it reads the mark first and puts it back after, and only while its own still stands |
| 3 | A run whose validation or submission failed ended with no `RESEARCH` record and no `research.run` line, and stayed `SUBMITTING` (low) | it ends `FAILED` with the code, concluded as an agent's failure is, behind the patch `61-validation-failure-concluded` (the run waits on timers, so its code replays) |
| 4 | The cap's rule read a window of 24 hours over rows dated to their day, so a refusal late on one UTC day was out of the window minutes later (low; the builder's) | a window of two days |
| 5 | The share accepted showed no value in a range of declines alone (low; the builder's) | the proposals statement gives both decisions a line in every bucket that has one, zero included |

Refuted, and kept as they were or made plainer: R5's passing with no researcher's suggestion in the database (a missing text fails the suite's tier B already; the suite now also checks the source the fetcher received against its hash, and the gate the same over the database); the dashboard's role linking a run to its asker by joining the per-call view to `BudgetLedger` (the research lines already carry the run on the turn's trace, which an operator reading Loki can follow to the answer's message, so the view adds nothing an operator could not see); R1 passing with most hand-overs failed (a failing engine start is slow, not fast; the criterion now says so outright when a hand-over fails in the configured pass); the measures' refusal breakdown not summing to the refused count (the suites delete their suggestions and keep their records; the measure now says what it counts).

