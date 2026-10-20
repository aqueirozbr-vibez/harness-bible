# 27 · Improve and the researcher — the plan (two capabilities, eighteen specs, units 44 to 61)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: Andre's request of 2026-10-05, quoted in § 1, and his sixteen answers of the same day, recorded in § 3. For the original Improve capability: `specs/PRD — Harness Bible Interactive.pdf` (Capability 4, the rubric, the four worked examples), `specs/TRD — Harness Bible Interactive.pdf` (§ 4.2 improvement schema, § 6.1 endpoints, § 7.4 to 7.7 sequences, § 8 agents) and the seven screens of `docs/design/screens/` (Improve-Suggest, Improve-Adjudication, Improve-Record, Curator-Queue, Chapter-History, Rubric, Account-Admin). The researcher has no primary source: the PRD and the TRD are silent on an agent that proposes changes, and three of their rules point the other way (§ 4). This spec is where those rules are amended.

This spec builds nothing. It is the index of specs 28 to 44, the record of what was decided before any of them was written, and the order of the units.

## 1. Purpose

Andre, 2026-10-05:

> i want to buid capability 4 - Improve
>
> but i want to go beyond the original scope and to connect the improve withe the assistant
>
> this connection will be a 5th capability - the harness researcher agent. this new agent will find trusted sources of information and look for additional content, beyond what's in the book.
>
> if the researcher finds something that the improve feature approves, it displays the suggestion to the human decide to add or not to the book.
>
> if the improve feature refutes the output of the research, it is logged, but nothing chages or is proposed.
>
> the idea is the following:
>
> 1. I ask a question to the assistant
> 2. the assistant generates an answer based on the book
> 3. the assistant send the answer to the researcher
> 4. the researcher checks if there's a possible improvement looking up trusted sources
> 5. if the researcher finds something, sends it to the improve agent
> 6. the improve agent decides if it is a relevant addition
> 7. if it is, it shows the human to approve the improvement to the chapter
>
> this is a additional feature, we'll also keep the original scope of the improve feature, which is humans suggesting improvements.

Two capabilities follow from it.

**Capability 4, Improve**, as the PRD defines it: a person proposes a change anchored to a section, a figure or a source row, with evidence; the evidence is fetched and graded against the published rubric; deterministic sensors check the change against the book; an adjudicator accepts, asks for more or declines; a curator decides what the rubric cannot; an accepted change becomes a commit in the book's repository, a version bump and a new release; every step is a ledger record.

**Capability 5, the researcher**: after the assistant has answered a question from the book, a second agent looks outside the book for something the book should say or should correct. What it finds does not go to the reader as an answer. It goes into Improve as a suggestion with sources, through the same fetcher, grader, sensors and adjudicator a person's suggestion passes. If Improve accepts it, the reader who asked sees the proposal and may put their name to it, and a curator decides. If Improve refutes it, the ledger says so and nothing else happens.

The second is built on the first and cannot exist without it: a finding is a suggestion, and everything that makes a suggestion trustworthy is Capability 4's.

## 2. The whole flow, once

```
reader asks ──▶ assistant answers from the book (unchanged; Phase 2)
                    │  final event carries research: queued | skipped | off | unavailable
                    ▼
        ResearchWorkflow (platform budget, after the answer, never delaying it)
          1 eligibility      switches on · not a refusal · not researched in 30 days, or a gap · reader under 30 runs a day
          2 planner          small model, no web: reads question + answer + cited sections, writes a brief or "nothing to research"
          3 brief sensor     secrets, personal data and length checked in code
          4 reader           frontier model with the provider's web search and fetch: reads the brief and the book's sections,
                             never the question; returns at most 3 findings, each anchored, each with the pages it opened
          5 validation       anchor exists · "before" matches the book · every source is a page the run really opened
                    │  one suggestion per valid finding, origin RESEARCHER, no contributor
                    ▼
        SuggestionWorkflow (the same one a person's suggestion runs)
          intake sensors ─▶ our own fetcher opens every source ─▶ evidence grader ─▶ score in code ─▶ floor
          ─▶ consistency sensors ─▶ change-class router ─▶ adjudicator
                    │
        ┌───────────┴─────────────┐
   refuted (declined, or more     accepted by Improve
   evidence asked, or a sensor)        │
        │                              ▼
   ledger records only;          proposal shown to the reader who asked ("add my name", optional)
   nothing is proposed           and placed in the curator queue of the chapter's part
                                       │ curator accepts
                                       ▼
                                 MergeWorkflow: branch, commit, the chapter's check, merge, version bump, release, ingestion
```

A person's suggestion enters at `SuggestionWorkflow` directly, from the suggest form, and on acceptance by the adjudicator goes to `MergeWorkflow`, where a curator merges, as the TRD has it.

## 3. What Andre decided on 2026-10-05

Sixteen questions were put to him before any spec was written. His answers, in the order asked. Where he did not take the recommended option the row says so, because those are the places a later reader would otherwise assume the recommendation.

| # | Question | Answer | Recommended? |
|---|---|---|---|
| A1 | Which human decides on a researcher finding that Improve accepted? | **The reader endorses, a curator decides.** The reader who asked sees the proposal and may put their name to it; it goes to the curator queue either way, and the curator decides. | no (a curator alone) |
| A2 | Which answers go to the researcher? | **Every answered turn, deduplicated.** Never a refusal. | yes |
| A3 | What makes a source trusted? | **The open web; the rubric decides.** No registry of domains. The evidence grader assigns each source its tier and weak tiers fall under the floor. | no (a curated registry) |
| A4 | What of the reader's turn may the researcher use? | **The question and the answer, redacted.** Nothing of them is kept on the proposal; curators never see who asked or what. An organisation can switch research off for its members. | yes |
| A5 | Who may endorse? | **Any signed-in reader**, giving provenance consent on the spot, with no identity verification. | no (verified contributors) |
| A6 | Whose budget pays? | **The platform's.** One principal the operator names, with its own monthly cap at the gateway. | yes |
| A7 | Which search? | **The model provider's own** web search and fetch tools, through the gateway. | yes |
| A8 | Improve before the IDE leaves lab-run evidence and derived-figure changes without input. | **Build Improve now, defer both.** The IDE stays in the plan, after this. | yes |
| A9 | What runs the workflows? | **Temporal**, as the architecture documents. | yes |
| A10 | The book folder is not a Git repository. Where does an accepted change go? | **A local Git repository of the book.** A hosted pull request and a CI webhook are deferred until the book has a host. | yes |
| A11 | Which kinds of change may the researcher propose? | **Anything a person may**, the curator-always classes included. | no (figures and new claims) |
| A12 | When may the researcher look at a section again? | **After 30 days, or at once on a gap** (an answer that says "the book does not cover this"). | no (90 days) |
| A13 | How much may one run do? | **10 web searches, 10 page reads, at most 3 proposals; 30 runs a day started by one reader.** | no (5 / 5 / 2 / 10) |
| A14 | The research budget's monthly cap? | **US$ 20.** | no (US$ 50) |
| A15 | Curator deadlines, which no source states? | **The design screen's**: 24 hours for safety and OT-boundary, 5 days for scenario parameters and structure, 6 days for a new source tier, 7 days for request-more inspections and for researcher proposals. | yes |
| A16 | Seeded items, whose share no source states? | **The mechanism, at a share of zero.** A seed needs a second curator to set its answer. | yes |

Two of the answers pull against each other and both stand: A13 makes a run about twice as expensive as the middle setting and A14 sets the lowest cap offered. By the estimate given with the question (about US$ 0.50 a run at the middle setting, to be measured in unit 58), the cap buys in the order of twenty runs a month. The gateway enforces it; research then waits for the reset (spec 40 § 7). The first month's ledger is the measurement that says whether either number should move.

## 4. Rules of the product this plan amends

The PRD and the TRD were written for suggestions made by people. Four of their rules meet the researcher head on. Each is amended here once, and the context files carry the amended form.

| Rule as written | Where | What it becomes |
|---|---|---|
| "Contributors need an account with a verified identity; anonymous suggestions are not accepted, because provenance is part of the evidence." A suggestion leaves `DRAFT` only with `identityVerified` and `provenanceConsentAt`. | PRD p3; architecture invariant 25 | Unchanged **for a person's suggestion**. A researcher's suggestion has no contributor at all: its provenance is its sources, each opened and graded by the product itself, and its record names the origin. It can never be accepted without a curator (new invariant 32). |
| "No edit is attributed to the agent." | PRD p7; invariant 27 | Stands, and is made precise: a change that began as research is credited to the reader who endorsed it, if one did, and to no one otherwise; the history marks its origin, which is provenance, not credit. The credit list holds people only. |
| "No agent holds a tool that writes content." The adjudicator writes only its adjudication. | TRD p44, p31 | Stands. The researcher holds a search tool and a fetch tool and writes nothing: its output is a finding, which code turns into a suggestion row. Content still changes only through a curator's merge (invariant 3). |
| The assistant "answers from the book only"; the product is "not a general AI chat product". | overview § Out of scope; spec 23 D1 | Stands without exception. The researcher never answers the reader. What it finds reaches the reader only as a proposal that Improve accepted, shown as a proposal, under the answer and not in it (new invariant 31). |

And one rule of the build order: `ai-workflow-rules.md` § 1.3 fixed the phases as Reader, Assistant, IDE, Improvement. By A8 the order is now Reader, Assistant, **Improvement, Researcher**, IDE. Two things in Improve take their input from the IDE and wait for it: evidence of kind `LAB_RUN` (tier A) and, with it, any derived-figure change, whose accept threshold is 100 on tier A alone (spec 32 § 3, spec 33 § 6).

## 5. Decisions made in the specs, for Andre to confirm

The sixteen answers do not settle everything a build needs. The specs settle the rest on a recommendation, each marked `D` in its own § "Decisions this spec needs" and gathered in the tracker's Open Questions. The ones that shape more than one spec:

1. **Improvement rows are the platform's, not a tenant's** (29 D1). A suggestion is a contribution to the one book every tenant reads, and a curator of another organisation must read it. So `Suggestion` and its children are outside the tenant filter, as `LedgerRecord` and the content tables are, and every read goes through one module that enforces owner-or-curator in the query, with OPA in front. A research run, which records who asked, stays the asker's own row.
2. **A reader's words never enter a workflow's history** (28 D3). Temporal keeps every activity's input and result. Activities therefore pass ids, enumerations, numbers and hashes; text is read from and written to the product's own rows, where the 30-day purge reaches it.
3. **The researcher is two calls that never share a context** (41 D1): a planner that reads the reader's question and never sees the web, and a reader that sees the web and never the question. A page that tells the agent to leak what it knows finds an agent that knows only the book.
4. **A source counts only if the product opened it itself** (42 D2). The researcher names pages; the evidence fetcher opens each one again, and the grader reads what the fetcher got. What the provider's search tool returned to the researcher is not evidence.
5. **The class of a change is computed from what is anchored and what kind of change is declared, never by a model** (30 § 4.2, D4), with the assistant's own control-system vocabulary deciding the safety and OT-boundary class.
6. **Notifications are in the product, not by e-mail** (35 D3), until a mail service exists. The TRD's e-mail conduit is deferred with it.

## 6. The specs

| Spec | Capability | Subject | Units |
|---|---|---|---|
| 27 (this) | both | the plan | 44 (the specs themselves) |
| `28-workflow-engine.md` | 4 | Temporal: the service, the workers, the web tier's client, tests | 45 |
| `29-improvement-schema.md` | 4 | the models, ids, ledger payloads, roles and roster | 46 |
| `30-rubric.md` | 4 | `lib/rubric`: tiers, factors, score, classes, thresholds; the rubric as data; the Rubric page | 47 |
| `31-suggestion-intake.md` | 4 | drafts, anchors, the intake sensors, submission, limits | 48 |
| `32-evidence.md` | 4 | the fetcher, uploads, DOIs, the evidence grader | 49 |
| `33-suggestion-workflow.md` | 4 | `SuggestionWorkflow`, consistency sensors, the adjudicator, the throttle | 50 |
| `34-improve-suggest-screen.md` | 4 | the suggest form | 51 |
| `35-adjudication-and-record.md` | 4 | the outcome page, the record, the Improve landing page | 52 |
| `36-curator-queue.md` | 4 | the queue, decisions and overrides, calibration, deadlines, seeds | 53 |
| `37-merge-and-release.md` | 4 | the book's repository, `MergeWorkflow`, version bump, release, Chapter-History | 54 |
| `38-account-admin-and-audit.md` | 4 | budget by consumer, audit export, the roster panel | 55 |
| `39-phase4-gate.md` | 4 | the gate | 56 |
| `40-research-run.md` | 5 | the hand-off from an answer, eligibility, the run, privacy, budget | 57 |
| `41-researcher-agent.md` | 5 | the planner, the reader, the web tools, validation | 58 |
| `42-research-proposals.md` | 5 | a finding as a suggestion, the outcome, endorsement, credit | 59 |
| `43-research-in-the-product.md` | 5 | the dock's research line, the proposal, the queue's group, the switches | 60 |
| `44-researcher-gate.md` | 5 | the researcher's criteria and its observability | 61 |

## 7. The units, in build order

One unit at a time (rules § 2). A lettered unit is one deliverable with its own verification. The order is the dependency order: nothing is built before what it reads exists, and every unit leaves a product that type-checks and passes its tests.

### Capability 4 — Improve

| Unit | What | Spec | Depends on |
|---|---|---|---|
| 44 | the specs and the context files | 27–44 | — |
| 45a | Temporal as a service: compose, configuration, its own database | 28 § 3 | — |
| 45b | the workers run a Temporal worker; the proving workflow | 28 § 4 | 45a |
| 45c | the test environment for workflows | 28 § 6 | 45b |
| 45d | the web tier's client: start, signal, query, fail closed | 28 § 5 | 45b |
| 45e | the two nightly jobs as schedules of the engine | 28 § 4.6 | 45d |
| 46a | migration: the improvement enums and models | 29 § 3 | — |
| 46b | `lib/db/improve.ts`, the one door to those rows; ids `S-NN-NNNN` | 29 § 4 | 46a |
| 46c | the six ledger payloads and the two new kinds; `append` admits them | 29 § 5 | 46a |
| 46d | roles reach the policy: `verified`, the roster, the rules for `suggestion` and `curation` | 29 § 6.1–6.3 | 46a |
| 46e | development accounts for a contributor and a curator | 29 § 6.4 | 46d |
| 47a | `lib/rubric`: tiers, factors, adjusted score, the score, "would suffice" | 30 § 3 | — |
| 47b | change kinds, class detection, thresholds, routing | 30 § 4 | 47a |
| 47c | rubric v1.2 as data: the file, the rows, `GET /rubric/*` | 30 § 5 | 46a, 47b |
| 47d | the Rubric page | 30 § 6 | 47c |
| 48a | `POST /suggestions`: a draft with its anchor resolved and its class computed | 31 § 3 | 46b, 46d, 47b |
| 48b | the draft's proposal and rationale: update, read, delete | 31 § 4 | 48a |
| 48c | the four intake sensors, pure | 31 § 5 | 48b |
| 48d | `POST /suggestions/{id}/submit`: consent, limits, the workflow started | 31 § 6 | 48c, 45d |
| 49a | the fetcher: the guard and one way out to a URL | 32 § 4 | — |
| 49b | object storage and uploads | 32 § 5 | — |
| 49c | DOIs | 32 § 6 | 49a |
| 49d | the evidence grader: guide v1.3, assembly, parser, request row | 32 § 7 | 47a, 49a, 49b |
| 49e | `POST /suggestions/{id}/evidence`: graded on add; the score preview | 32 § 8 | 48a, 49d, 45d |
| 49f | PDFs and images as evidence | 32 § 9 | 49d |
| 50a | `SuggestionWorkflow` through intake, grading and the floor; `submitted` and `graded` records | 33 § 3 | 48d, 49d, 46c |
| 50b | a proposal applied to the book's source text, proved by re-parsing | 33 § 4.1 | 46b |
| 50c | the consistency sensors: derive, cross-chapter, lint | 33 § 4.2 | 50b |
| 50d | the router and the adjudicator: guide v2.1, assembly from what was recorded, the checks in code | 33 § 5 | 50a, 50c |
| 50e | the decision, the `sensors` and `decided` records, the states, revision, the curator's signal | 33 § 6 | 50d |
| 50f | the throttle; the wait at a budget cap | 33 § 7 | 50e |
| 50g | the four worked examples end to end; the development seed | 33 § 8 | 50f |
| 51a | the Improve classes of `hb.css`, ported once, with `ui-context.md` | 34 § 3 | — |
| 51b | the suggest route and the anchor step | 34 § 4 | 51a, 48a |
| 51c | the edit page: context strip, anchor column, proposed change, class panel | 34 § 5 | 51b, 48b |
| 51d | the evidence list, grading live | 34 § 5 | 51c, 49e |
| 51e | the rationale, the live score, consent, submit; the states | 34 § 6, § 7 | 51d, 48d |
| 52a | the Improve landing page | 35 § 3 | 46b |
| 52b | the adjudication page | 35 § 4 | 50e, 51a |
| 52c | the record: timeline, chain check, export | 35 § 5 | 52b |
| 53a | the queue's reads: `GET /curation/queue`, groups, deadlines | 36 § 3 | 50e, 46d |
| 53b | the queue page: list and detail | 36 § 4 | 53a, 51a |
| 53c | the decision: endpoint, signal, `curator` record, calibration event; the override codes | 36 § 5 | 53a, 45d |
| 53d | calibration: the three measures, `GET /curation/metrics`, the rubric review, the rail | 36 § 6 | 53c |
| 53e | seeds at share zero; the monthly tier-B sample, unset | 36 § 7 | 53c |
| 54a | the book's repository: configuration and the Git adapter | 37 § 3 | — |
| 54b | `MergeWorkflow` to a branch that passed or failed the chapter's check | 37 § 4 | 54a, 50b, 50e |
| 54c | the curator's merge: version bump, release, ingestion, the `merged` record | 37 § 5, § 6 | 54b, 53c |
| 54d | Chapter-History: `GET /chapters/{n}/history`, the page, credit | 37 § 7 | 54c |
| 54e | a revert | 37 § 8 | 54c |
| 55a | the budget meter with grading and adjudication | 38 § 2 | 50a |
| 55b | the audit export: `ExportWorkflow`, the endpoint, the form | 38 § 3 | 45d, 49b |
| 55c | the curator roster panel | 38 § 4 | 46d, 53a |
| 56 | the Phase 4 gate | 39 | 45 to 55 |

### Capability 5 — the researcher

| Unit | What | Spec | Depends on |
|---|---|---|---|
| 57a | migration: research runs, findings, marks, the two switches, the `RESEARCH` budget kind | 40 § 3 | 46a |
| 57b | what a turn hands over: the sentences the book did not cover, the sections retrieved | 40 § 4 | 57a |
| 57c | eligibility, pure: the switches, answers only, 30 days or a gap, the same question, 30 a day, the budget mark | 40 § 5 | 57a |
| 57d | `ResearchWorkflow`: started at the turn's end, the research principal, the cap | 40 § 6, § 7 | 57b, 57c, 45b |
| 57e | privacy: the reader's switch on the account page, the organisation's by command, the purge | 40 § 8 | 57d |
| 58a | the gateway learns research: purpose, request rows, the provider's web tools through the proxy, the stub | 41 § 3 | 57a |
| 58b | the researcher's guide v1.0: the planner part and the reader part | 41 § 4 | 58a |
| 58c | the planner and the brief sensor | 41 § 5 | 58b, 57d |
| 58d | the reader with web search and fetch; its parser | 41 § 6 | 58c |
| 58e | the validation of findings | 41 § 7 | 58d, 48c |
| 59a | a suggestion's origin: its rules in the workflow and the policy | 42 § 3 | 50g |
| 59b | a finding becomes a suggestion with evidence and enters `SuggestionWorkflow`; duplicates | 42 § 4 | 58e, 59a |
| 59c | proposed or refuted; the `RESEARCH` record | 42 § 5 | 59b |
| 59d | endorsement: consent, the endpoint, the `ENDORSED` record | 42 § 6 | 59c |
| 59e | the curator's decision on a proposal; credit and the history's mark | 42 § 7 | 59d, 53c, 54d |
| 60a | the research line under an answer (buildable now: it needs the run alone) | 43 § 4 | 57d |
| 60b | the proposal in the dock, and "add my name" | 43 § 5 | 59d, 60a |
| 60c | the reader's proposals on the Improve landing page | 43 § 6 | 60b, 52a |
| 60d | the queue's researcher group, the detail's words and two segments, the research log | 43 § 7 | 59c, 53b |
| 60e | the record and outcome pages of a researcher's proposal, the audience `asker` (added 2026-10-10, when spec 43 was rewritten for the research UX) | 43 § 8 | 59c, 60b |
| 61 | the researcher's gate, its series and its dashboard | 44 | 57 to 60 |

Seventy-three units after this one: fifty-three in Improve, its gate included, and twenty in the researcher, its gate included. The first that is not a preparation for something else is 50g: four suggestions decided end to end.

## 8. What is not in either capability

Each of these was considered and left out, and each has its reason in the spec named.

- **E-mail** for decisions, throttles and rubric changes (35 D3): no mail service exists. The product shows every state where the person looks for it.
- **A hosted pull request and the CI lab-suite webhook** (37 § 9): the book has no host. The merge runs on a local repository; `POST /webhooks/ci` is not built.
- **Evidence of kind `LAB_RUN` from a person, and so any accepted derived-figure change** (32 § 3): the IDE's input. The kind exists in the schema and in the fixtures.
- **Rubric changes as queue items (`R-…` records), and their announcement** (30 § 8): the rubric is v1.2 from a file; a new version is a reviewed change to that file.
- **Seats, members, SSO state and the residency control of Account-Admin** (38 § 6): they need organisational accounts, which Phase 1 did not build (architecture § 5.1).
- **`AnswerWorkflow` on Temporal**: the assistant's turn stays the route handler and the workers' flow it is. Nothing in this plan needs it moved.
- **Research on a schedule** (40 § 10): a sweep of figures past 90 days would serve goal 6 directly and reuse every piece of this plan. It was not asked for, so it is not here.
- **The researcher answering the reader**, in any form (§ 4).
- **Phase 3, the IDE.** It follows these two capabilities.

## 9. Verification of this unit (44)

Unit 44 is documentation. It is done when:

1. Specs 27 to 44 exist and each names its units, its sources, its decisions and its verification.
2. `project-overview.md` describes five capabilities, the new order and the researcher's success criteria; `architecture.md` carries the new containers, conduits, folders, routes, endpoints, models, agents, workflows, threats and invariants, and § 12 the sixteen answers; `ai-workflow-rules.md` § 1.3 states the order as decided; `progress-tracker.md` lists the units and the open decisions.
3. No file under `app/`, `components/`, `lib/`, `workers/`, `pipeline/`, `policies/`, `prisma/` or `messages/` changed.
