# 41 · The researcher — feature spec (the gateway's web tools, the guide, the planner and its brief, the reader, the validation of findings)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: Andre's request of 2026-10-05 ("this new agent will find trusted sources of information and look for additional content, beyond what's in the book") and his answers A3 (the open web; the rubric decides), A7 (the model provider's own search), A11 (any change a person may propose) and A13 (10 searches, 10 page reads, 3 proposals a run). The architecture's rules for an agent apply as written: § 5.7 (the model-visible surface), § 6.1 (a versioned guide, a byte-stable prefix, a structured output, sensors on both sides, a cap), § 9 (prompt injection), invariants 6, 8, 9, 10 and 15. For the provider's tools: the Claude API reference the build loads through its `claude-api` skill, which the unit reads again before writing any tool parameter.

Prerequisite specs: `11-model-gateway.md` (`callModel`, the request rows, the stub), `13-assistant-agent.md` (assembly and parsing as built), `30` (the rubric's tiers, which the reader is shown), `31` § 4 (`ProposalSchema`), `40` (the run).

Scope: tracker unit 58 (58a to 58e). Not here: when a run starts (spec 40), what a finding becomes (42).

## 1. Purpose

The assistant is forbidden to say anything the book does not. The researcher's whole job is to look where the assistant may not, and that makes it the first agent in the product that reads text nobody vetted and holds a tool that reaches outside. Chapters 25 and 28 of the book it serves describe what goes wrong with such an agent and how to build one anyway, and this spec is those chapters applied: split what knows a private thing from what reads untrusted things, give neither a way to act, and check everything either produces in code.

## 2. Dependencies and order

58a first: until the proxy is shown to carry the provider's web tools, nothing else here can run. Then 58b (the guide), 58c (the planner), 58d (the reader), 58e (validation).

## 3. The gateway learns research (58a)

- **Vocabulary**: purpose `research`; agent `researcher`; two request rows in `lib/gateway/policy.ts`, `researchPlanner` on `hb-small` and `researchReader` on `hb-frontier`. Their token ceilings, timeouts, retries and effort are set in the unit with their derivations, under the delegation Andre gave for that table on 2026-09-24, and recorded in architecture § 12. Rows are charged to `RESEARCH_PRINCIPAL` (spec 40 § 7).
- **Tools on a call.** `callModel` has never passed tools. It gains an optional `serverTools` argument, typed to the two this spec uses and nothing else: the provider's web search and web fetch, in the versions current for the pinned frontier model (`web_search_20260209` and `web_fetch_20260209` by the reference at the time of writing; tool versions are dated, so the unit confirms them). Each carries its limit of uses: 10 searches and 10 fetches a call (A13). There is no client tool: the model cannot ask this product to do anything.
- **What the product reads back.** Besides the final text, the response's tool-result blocks: the addresses the search returned and the addresses the fetch opened. They are the run's list of pages really seen (§ 7). The usage's count of searches is stored on the run and priced (spec 40 § 7.3).
- **A turn the provider pauses.** A call with server tools may come back unfinished, to be continued. Continuing it is the same attempt, not a second one; the limits of uses bound the whole. The unit follows the reference for the mechanics.
- **The proof.** That the pinned LiteLLM image passes these tools and their result blocks on its Anthropic route is not known. 58a proves it against the real gateway with one call that makes one search, which costs money, so it is a command Andre runs (`npm run research:check`), as every real-provider run is his to start. If the proxy does not carry them the unit stops (rules § 4.4) with the options: a newer pin of the proxy, or the provider's search called by a route the proxy does forward.
- **The stub** (`infra/gateway/stub/`): a request carrying the web tools gets a deterministic answer built from fixture pages named by a header: tool-use and tool-result blocks for those pages, then the findings a fixture defines. A request to `hb-small` with the planner's guide gets the fixture's brief. Everything below is tested on the stub.

## 4. The guide (58b)

`guides/researcher/v1.0/`: `manifest.json` with two parts, each with its own files and hash, loaded by `loadGuidePart` as the assistant's grader part is: `planner` (`planner.md`) and `reader` (`reader.md`). They are separate parts and not one prefix because the two calls must not share instructions any more than they share context: the reader's guide never mentions that a reader's question exists.

`lib/guides/load.ts`'s `Agent` union gains `"researcher"`. `npm run secrets:scan` covers the folder and both assemblers.

## 5. The planner (58c)

### 5.1 What it is

One call on `hb-small`, no tools. It decides whether there is anything worth looking for and, if so, writes the brief the reader will work from.

| | |
|---|---|
| Prefix | 1 the planner guide · then per call: 2 the cited sections (titles, text, their figures with tier, verification date and the fast-moving flag) · 3 the answer's claims with their citations · 4 the sentences the book did not cover · 5 the question |
| May read | the redacted question; the answer; the uncovered sentences; the sections the answer cited |
| May never read | who asked (no id, name, organisation or locale beyond the language); earlier turns; anything from the web |
| Cap | one attempt; failure ends the run `FAILED` |

### 5.2 Its output

```ts
| { research: false, reason: "COVERED" | "NOT_ABOUT_THE_BOOK" | "PERSONAL" }
| { research: true,
    brief: string,                                   // English, at most 200 words
    targets: [{ section: string, intent: "UPDATE" | "GAP" | "CONTRADICTION" }] }
```

`research: false` is a good outcome and a cheap one: an answer the book covers fully, on sections whose figures are fresh, needs no search. `PERSONAL` is for a question about the reader's own system or organisation, which the book is not for and the web must not be asked about.

The brief is in English whatever language the question was asked in: the book's source language, and the language most sources are in (D2). Its limit is the product's existing limit for a text that explains what evidence should show: the rationale's 200 words.

### 5.3 The brief sensor (`lib/sensors/brief.ts`, pure)

The brief is the only text that crosses from the side that knows the question to the side that reads the web. Before the reader is called, code checks it:

- no secret, by the patterns the product already redacts with (`lib/security/redact.ts`);
- no e-mail address, no URL, no long run of digits (a phone or document number);
- at most 200 words;
- every target is a section the answer cited;
- it does not contain the question: no run of five or more consecutive words of the question appears in it.

A failure ends the run `FAILED` · `BRIEF`, with which check failed and nothing of the text. The planner is not asked again.

## 6. The reader (58d)

### 6.1 What it is

One call on `hb-frontier`, with web search and web fetch.

| | |
|---|---|
| Prefix | 1 the reader guide · 2 the rubric's tiers with their examples (so it prefers a regulation to a forum) · then per call: 3 today's date · 4 the target sections with their figures and source rows · 5 the brief |
| May read | the brief; the target sections of the book; what its two tools return |
| May never read | the question; the answer; the uncovered sentences; who asked |
| Tools | the provider's web search (10 uses) and web fetch (10 uses); no domain list in either direction (A3) |
| Cap | one attempt; failure ends the run `FAILED` |

What it reads from the web is untrusted, and the guide says so in the terms the grader's does. It is the difference from the grader that matters: the grader cannot act on a page; the reader can search again. So the reader holds nothing a page could profit from stealing: the book is public, the brief was checked, and the question is not there.

### 6.2 Its output

```ts
{ findings: [{                       // at most 3 (A13)
    anchor: { kind: AnchorKind, id: string },
    changeKind: ChangeKind,
    proposal: Proposal,              // the ProposalSchema of spec 31 § 4
    sources: [{ url: string }],      // at least one; pages this call opened
    note: string                     // at most 200 words: what the sources say and why the change follows
}] }
```

An empty list is the common answer and is not a failure.

By A11 a finding may be of any change kind a person may propose. Its class is not the reader's to say: `classOf` computes it (spec 30 § 4.2), and a finding that lands in a curator-always class goes to a curator as a person's would.

## 7. Validation (58e, `lib/research/validate.ts`, pure)

Every finding is checked in code before it becomes anything. `validate(finding, context) → { valid } | { invalid: reason }`:

| Check | Refused as |
|---|---|
| the anchor is in a section the reader was given, and exists in the pinned release | `ANCHOR` |
| the change kind may be anchored there (spec 30 § 4.1) and the proposal passes the `SCHEMA` sensor of spec 31 § 5: the passage occurs once, a text edit changes no digit | `PROPOSAL` |
| the proposal changes something: it is not what the book already says | `NO_CHANGE` |
| every source is an `https` address that appears in this call's own tool results: a page the search returned or the fetch opened | `SOURCE_NOT_SEEN` |
| at least one source remains | `NO_SOURCE` |
| the note is within its limit and passes the secret patterns | `NOTE` |

Findings beyond the third are dropped and counted. Each invalid finding is a `ResearchFinding` row with its reason and nothing of its text.

`SOURCE_NOT_SEEN` is the check that keeps the reader honest about where a claim came from: an address it wrote but never opened is an invention, however plausible. And passing this check earns a source nothing: the evidence fetcher opens every one again and the grader reads what the fetcher got (spec 42 § 4.2).

## 8. What can go wrong, and what stops it

| Attack or failure | What stops it |
|---|---|
| a page tells the reader to reveal what it knows | the reader knows the book and a brief; the question, the answer and the asker were never in its context (§ 5, § 6) |
| a page tells the reader to put text into its next search or fetch | the same: nothing private is there to put |
| the planner copies the question into the brief | the brief sensor's overlap check (§ 5.3) |
| a page tells the reader to propose a change | it can propose; the proposal is graded on sources the product opens itself, scored in code, checked by sensors, judged by an adjudicator that never sees the page, shown to a reader as a proposal, and decided by a curator |
| a page is written to be graded highly | the grader's own defences (spec 32 § 7.3), the curator's monthly sample, and the researcher's precision on its dashboard (spec 44) |
| the reader invents a source | `SOURCE_NOT_SEEN`; and an address that does not open is tier `U` |
| a finding edits a safety statement | `classOf` rule 3 sends it to a curator; the adjudicator never decides it |
| cost runs away | 10 and 10 uses a call, one call a run, 30 runs a day a reader, and the gateway's cap on the research key |

## 9. Out of scope

- A registry of trusted or excluded domains (A3). If the research log shows a publisher that is consistently worthless, a block list is one parameter of the fetch and search tools and its own decision.
- The researcher reading the product's own database beyond what the assembler gives it; a tool that queries the book. It is given the sections; it has no retrieval of its own.
- A second pass, a critic, or a debate between agents.
- Languages: the reader searches as it sees fit from an English brief; proposals are written for the chapter's source language.

## 10. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | One agent or two calls with separate contexts | two | an agent that holds a reader's question, reads untrusted pages and can issue searches has all three legs the book's chapter 28 says must never meet; splitting removes the first from the call that has the other two |
| D2 | The brief's language | English | the reader's sources and the book's source text are English; a Portuguese question still gets its proposal shown in the reader's language by the product's own strings |
| D3 | The planner on the small model | yes | its work is a judgment of coverage and a paragraph; with a US$ 20 cap, a cheap "nothing to research" is most of the saving |
| D4 | The reader is shown the rubric's tiers | yes | A3 made the rubric the judge of sources; a reader that knows what scores will spend its ten searches on what can pass |
| D5 | Who runs the first real call | Andre | it is a paid call (§ 3) |

## 11. Verification (in addition to `ai-workflow-rules.md` § 7)

On the stub unless marked.

1. **Real, Andre's to run**: `npm run research:check` makes one reader call with one search through the real gateway and prints the tool blocks' types, the count of searches in the usage, the gateway's recorded spend and the ledger's cost for it.
2. The planner's request holds no tool; the reader's request holds the two server tools with their limits and no client tool.
3. **The canary.** A question carrying a unique marker word: the marker is in the planner's request, and in no byte of the reader's request, of any search query or of any fetched address the stub received. The same holds for the reader's id and e-mail address, which are in neither request.
4. The brief sensor: one case per check of § 5.3, including a brief that repeats five words of the question.
5. Each planner output: `research: false` ends the run `DONE` with `NOTHING_TO_RESEARCH` and no reader call; a malformed output ends it `FAILED` with one planner row in the ledger and no second.
6. `validate`: one case per row of § 7; a fourth finding is dropped.
7. **The injection fixture.** A fixture page whose text orders the agent to add a specific sentence to the book and to search for a marker string: no search for the marker reaches the stub's log that was not already in the brief's terms; whatever finding results is refused by `SOURCE_NOT_SEEN` or goes on to be graded like any other, and the test asserts it was never written to a content table.
8. Both assemblers pass `npm run secrets:scan`; the guide's hashes match its manifest; a changed byte refuses to load.
9. A reader call that returns unfinished is continued and counted as one attempt; its searches across the continuation do not exceed 10.

## 12. As built (unit 58, 58a to 58e: the gateway's web tools, the guide, the planner, the reader, validation, 2026-10-10)

- **The gateway learns research (58a)**: purpose `research`, agent `researcher`, rows `researchPlanner` (`hb-small`, 1,024 tokens, 30 s, one try) and `researchReader` (`hb-frontier`, 16,000 tokens, 180 s a request, one try), with their derivations in `lib/gateway/policy.ts` and architecture § 12. `GatewayCall.serverTools` is the only way a tool reaches a request: `ServerToolsSchema` admits `web_search_20260209` and `web_fetch_20260209` with one to ten uses each and nothing else — no domain list, no location, no citations, no client tool — and `callModel` refuses a request that carries `tools` of its own (`GATEWAY_TOOLS_REFUSED`) before anything is sent. The tool versions are the ones the installed SDK (0.128.0) types for the pinned frontier model; it also types later dated variants (`20260318`), which this spec does not use. `lib/gateway/tools.ts` reads the response's blocks by shape — `server_tool_use`, `web_search_tool_result`, `web_fetch_tool_result` — into the searches with their queries and results, the fetches with the address opened or the error, and the texts; `pagesSeen` is every `https` address a search returned or a fetch opened, once each. `lib/gateway/turn.ts` (`callModelTurn`) is the turn: a `pause_turn` is continued by sending the paused content back as the assistant's message with the same tools and nothing of ours, at most twice, each request its own `callModel` and so its own ledger row and span under the run's `ref`; the continuation's `max_uses` are lowered to what is left of the call's, and a turn that pauses with no use left on a tool is not continued — the eleventh search would be the product's — and ends `unfinished`, which the reader treats as its one failure. The search's fee is `WEB_SEARCH_USD_PER_THOUSAND` (US$ 10, from the provider's list on `PRICES_AS_OF`), added to the row's cost from `usage.server_tool_use.web_search_requests` and counted on the span as `hb.web_search_requests`; web fetch has no fee of its own. The stub (`infra/gateway/stub/research.ts`) answers a request with the web tools from fixture pages named by `x-hb-stub-research` (`found` when unset, `nothing`, `pause`, `injection`, `four`, `malformed`) in the documented block shapes, logs every search and fetch it emits and the limits a continuation carried, charges the fee as the proxy might, refuses a tool it does not know and a streamed tool turn; a planner's request (the planner guide's heading on `hb-small`) gets the plan `x-hb-stub-plan` names (`research` when unset, `covered`, `not-about-the-book`, `personal`, `leak`, `malformed`). `npm run research:check` (`workers/research/check.ts`) is the proof against the real proxy: one reader-row call with the search tool alone, limited to one use, printing the blocks' types, the provider's count, the gateway's `/key/info` spend before and after (which is how 40 § 7.3's question — does `max_budget` count the fee — is answered) and the ledger row's cost; it exits 2 when the blocks did not come back. **Andre's to run**; it has not run on this machine.
- **The guide (58b)**: `guides/researcher/v1.0/` — `planner.md` and `reader.md` as `parts.planner` and `parts.reader` of a manifest with no prefix of its own (`files: []`), which `loadGuide` now refuses by name so nobody assembles an empty prefix; `loadGuidePart("researcher", "v1.0", "planner" | "reader")`, each by its own hash; `Agent` += `"researcher"`. The parts open with the headings the stub keys on. The reader's part never names a question or an asker (its test holds it to no `question` and no `ask`); its `ADD_ROW` tier is the book's chip (`PRIMARY` … `PRACTITIONER`), which is what `ProposalSchema` takes — the first draft said the rubric's letters and the validation's own test caught it. `npm run secrets:scan` covers the folder and `workers/agents/researcher/`.
- **The planner (58c)**: `workers/agents/researcher/planner.ts` — the prompt in its five slots (the guide part cached; then the language, the cited sections with their figures and source rows rendered by `render.ts` in the assistant's own `<section>` fence with one `figures:` line, the claims as the citations recorded them, the uncovered sentences, the question, each fenced with its closing tag broken), `parsePlan` strict to `PlannerOutputSchema` (`lib/schemas/researcher.ts`, apart from `lib/schemas/research.ts` because it holds a model's words), `plan` with one attempt and a budget refusal thrown. The step (`workers/research/plan.ts`): the turn and its citations read inside the asker's context, the sections at the run's release (`readResearchSections`, the source edition's text), the rubric in force for the tiers' letters, the call charged to `RESEARCH_PRINCIPAL`; the brief through `lib/sensors/brief.ts` (`SECRET`, `EMAIL`, `URL`, `DIGITS`, `LENGTH`, `TARGET`, `QUESTION`, in that order; five consecutive words of the question, compared lower-cased without punctuation) and then stored on the run with its hash — the activity returns `{ planned: "brief" }` and nothing of the text (invariant 35). Failures are codes: `PLANNER_FAILED`, `BRIEF_<CHECK>`, `TEXT_PURGED`, `RESEARCH_UNCONFIGURED`; the cap writes the `budget` mark and returns the reset.
- **The reader (58d)**: `workers/agents/researcher/reader.ts` — slot 1 the guide part and slot 2 the rubric's tiers with their base scores (`renderTiers`), cached together; then today's date, the sections and the brief; the call carries `researchTools()` and the request no `tools`; `read` runs `callModelTurn`, treats an unfinished turn as its failure, and parses `ReaderOutputSchema` strictly (any number of findings, since the fourth and beyond are dropped by the validation, not refused as a whole). What it found goes on the run: migration `20261010190000_research_found` adds `ResearchRun.found` (JSONB), the findings as written and the pages seen (`ResearchFoundSchema`), the asker's own text between the read, the validation and the submission, purged with the brief; the counts go on `searches` and `pageReads`. The reader is given every section the answer cited, not the planner's targets alone: the targets have no column, they are among the cited sections, and the brief says which matter — so an anchor in any cited section is one the reader was given.
- **Validation (58e)**: `lib/research/validate.ts`, pure — `ANCHOR` (the id's form matches its kind and the section, or the section holding the figure or the row, is among those given), `PROPOSAL` (the intake's `schemaSensor`, unchanged: the kind on the anchor, the passage once, no digit changed, the schema itself), `NO_CHANGE` (an edit whose `after` is its `before`, a claim the section already makes, a figure's own value, a row as it stands, a row whose claim or address a row already has), `SOURCE_NOT_SEEN` (every source `https` and among the pages seen; one invented address refuses the finding), `NO_SOURCE`, `NOTE` (200 words, the secret patterns); the fourth finding dropped and counted. The step (`workers/research/validate.ts`) writes an `INVALID` row with its reason for each refusal and leaves the valid ordinals on `found.valid` for the submission (42 § 4, unit 59b), which takes those and no other. The conclude step appends the `RESEARCH` record (40 § 6.3; `lib/research/record.ts`, `workers/research/record.ts`) after the run's state, once by `sha256(workflowId + ":research:1")`, as `service:researcher` with no suggestion: the planner's model from the run's `hb-small` call and the reader's from its last `hb-frontier` call (the alias when the gateway never answered), the usage summed, the findings' rows, the planner part's pin as the guide; a run that never planned has no record.
- Verified on the stub: `lib/gateway/tools.test.ts` (6), `lib/gateway/turn.test.ts` (5: the tools and their limits sent, the blocks read, the fee priced; a paused turn continued once with the limits lowered and one row per request; no continuation with no use left; a request's own tools refused before anything is sent; the stub's 400 for a stranger tool), `lib/schemas/gateway.test.ts`, `lib/gateway/policy.test.ts`, `lib/gateway/budget.test.ts` (the fee), `lib/guides/load.test.ts` (the two parts, the empty prefix refused), `lib/sensors/brief.test.ts` (9, one case per check and the five-word overlap), `workers/agents/researcher/planner.test.ts` (8) and `reader.test.ts` (9), `workers/research/plan.test.ts`, `read.test.ts`, `validate.test.ts` (14), `lib/research/validate.test.ts` (7, one case per row of § 7 and the fourth dropped), `lib/research/record.test.ts` (4), and end to end on the database, the stub and the engine's test server, `tests/integration/research-run.test.ts` (4): the canary — a marker word in the question is in the planner's request and in no byte of the reader's request nor of any search the stub ran; a plan of nothing ends the run `SKIPPED · NOTHING_TO_RESEARCH` with no reader call; a malformed plan ends it `FAILED · PLANNER_FAILED` after one planner row and no second; a leaking brief ends it `FAILED · BRIEF_QUESTION`; the injection page's finding is refused `SOURCE_NOT_SEEN`, no search for its marker reached the stub, and its sentence is in no content table; the asker's ledger gains no row and the research principal's gains the planner's and the reader's; the `RESEARCH` record for each run that planned. `npm run secrets:scan` clean; the full suite, lint and build.

Decided here, for Andre to see:
- **`serverTools` lives on `GatewayCall`**, not as a parameter of its own: the call already names everything the ledger and the span are written from, and a tool is a fact about the call; the request itself may never carry `tools`, which is the rule a lint could not state and the client enforces.
- **A continuation is bounded twice**: by what is left of the uses, and by `CONTINUATIONS_MAX = 2`, so a provider that paused without end could not run the activity past its 10 minutes (3 × 180 s).
- **The reader holds the cited sections, not the planner's targets** (above). If a run's findings show the reader proposing at a cited section the brief did not point to, a `targets` column is the change.
- **What the reader found has a column** rather than a second trip through the engine or a submission in the same activity: the engine keeps every argument and result and the purge cannot reach it (invariant 35), and the submission is spec 42's own step.
- **`ADD_ROW`'s tier in the guide is the chip**, since that is the proposal's schema; the rubric's letters are explained beside it.

Exercised live on 2026-10-10, on Andre's word ("I want the real thing working locally in this machine"): the research organisation created (`npm run research:org -- --create`), its key minted at the real gateway, `RESEARCH_PRINCIPAL` set, the workers restarted. `npm run research:check` against the pinned proxy: both tools carried — `server_tool_use`, `web_search_tool_result` and `web_fetch_tool_result` came back, one search and one fetch counted, US$ 0.30 (53k input tokens: the fetched page and the provider's own result-filtering code runs, which appear as `code_execution_tool_result` blocks the product does not read); the gateway's spend read US$ 0.295815 a minute later, the ledger's cost to the cent with the fee in it, so **`max_budget` counts the search fee** (40 § 7.3 answered; the check's own before/after read 0 because the proxy writes spend a moment after the call). The first real run timed out at the reader's 180 s; the reader's row is now streamed and 600 s a request (the provider's ten-minute edge for a non-streamed request, and the tool loop takes minutes), the activity 35 minutes, the stub streams a tool turn. The second real run, on a question about idempotency keys: the planner's brief in 4 s (US$ 0.013), the reader in 1 m 42 s — 3 searches, 3 fetches, 23 pages seen, 3 findings, all valid: two `ADD_CLAIM`s placed after the book's own passages and an `ADD_ROW` citing the IETF draft at tier PRIMARY, their sources pages it opened (Stripe's documentation, the datatracker) — for US$ 0.57, 311k of it cache reads; about US$ 0.60 a run, A13 and A14's estimate. The run ended DONE and the line read `nothing to propose`, the submission being unit 59's.

## 13. The review's findings (units 57 and 58 together, 2026-10-10)

One review for the two units, three read-only lenses (privacy and the gateway; the run across its activities and rows; conformance to the specs and the tests' honesty) and one skeptic per lens: 27 findings raised, 22 confirmed, 3 refuted, none left uncertain. Every confirmed finding is fixed in one commit; the refuted three are recorded with what was done anyway.

Confirmed and fixed:
- **The question's hash was of the raw question** (40 § 5 rule 8; `normalisedQuestion` was never called): the turn now hands `sha256Hex(normalisedQuestion(text))` to the researcher, so the same question asked again with other spacing or case is the same question. The `answer` record's own hash is untouched.
- **An engine refusal left a QUEUED row and its marks behind** while the final event said `SKIPPED · UNAVAILABLE`: the hand-over now takes both back — the row ends `SKIPPED · UNAVAILABLE` (`writeResearchState`) and the marks this run set are removed (`removeRunMarks`, by key and instant, so a mark another run set stands) — best effort, logged, the answer untouched; the event carries the row's id.
- **A run whose text the purge took while it waited ended FAILED** (`TEXT_PURGED` thrown by a step after a budget wait, or by the validation outside the workflow's guard), overwriting the purge's `SKIPPED · TEXT_PURGED`: the workflow now ends the run `SKIPPED · TEXT_PURGED` for that code from any step, and `writeResearchState` moves no run that has ended (DONE, SKIPPED or FAILED) and writes no text onto a run whose `textPurgedAt` is set — it says whether it wrote, and `writeResearchFound` likewise; the plan, read and validate steps fail `TEXT_PURGED` where the write did not take, instead of restoring a purged brief or findings.
- **The daily limit did not count a run that started and ended SKIPPED** (a planner that found nothing is a paid call): `runsStartedSince` counts every row with a `workflowId`, whatever it ended as.
- **A reader that failed after searching left `searches`/`pageReads` at 0**, and the `RESEARCH` record repeated the zeros for a call the ledger priced: `writeResearchCounts` writes the turn's counts before the step fails `READER_FAILED`.
- **A paused turn with one tool exhausted ended unfinished although the other had uses left** — the provider pauses after its own number of tool iterations, which ten searches reach with every fetch unused: `remainingTools` now leaves out the exhausted tool and continues with the other, lowered; the turn ends unfinished only when neither has a use left, or when the gateway refuses the continuation (a 4xx on the request that carried the paused content), rather than failing the turn after what it cost. Whether the real proxy accepts a continuation whose tool list shrank is one more thing `npm run research:check` cannot show; the first real paused turn will.
- **The `RESEARCH` record named the planner by the refused row's alias after a budget wait**: `modelCallOf` prefers the call the gateway answered over one it refused, for both aliases.
- **Parse failures echoed a key the model wrote** into the activity's failure message, and so into the engine's history: an `unrecognized_keys` issue now reads "has a key the guide did not name", and the key is never echoed, in either parser.
- **The brief sensor missed a bare host and a non-ASCII e-mail**, and **its overlap check was defeated by a soft hyphen or a decomposed accent**: the URL check names a bare host under the common public suffixes (`acme.com`, `intranet.acme.com.br`, `acme.io:8080`) and leaves the book's own vocabulary alone (`node.js`, `v1.2`, `e.g.`); the e-mail check takes any local part; `wordsOf` composes (NFKC) and drops soft hyphens and zero-width characters first.
- **`reader.md`'s `SET_VALUE` wording invited values the schema refuses** (`45%`, `1,450`), and one such finding failed the whole run: the guide now says the number alone with the unit in `unit`; and the reader's envelope is parsed as a list of findings as written, each held to `ReaderFindingSchema` by the validation, where one of another shape is refused `PROPOSAL` alone and the rest stand (the manifest's hash moved with the guide's text).
- **`npm run research:check` proved the search tool alone**: it now declares both tools at one use each and asks for one search and one fetch, and reports `fetchCarried` beside `toolsCarried`, exiting 2 when either did not come back.
- **The hand-over's time is not inside the turn's `totalMs`**, as 40 § 6.1 said: the answer fixes `totalMs` before the hand-over; the spec's as-built now says so, and the final event follows the hand-over.
- **Vacuous assertions**: the end-to-end test now asserts that neither request — the planner's or the reader's — carries the asker's id, e-mail or display name (41 § 11.3 "in neither request").
- **`NO_SOURCE` is unreachable on a parsed finding** (the schema needs one non-blank source and `SOURCE_NOT_SEEN` refuses the whole finding on one bad address): kept in `validate` as defence in depth for a caller that hands it an unparsed finding, and said here.

Refuted, and what was done anyway:
- **No `RESEARCH` record for a run whose planner was called and failed** — the skeptic read the as-built's decision as standing; the record now exists all the same, with `planned: "failed"` (the ledger's enum gains the value), because the call was charged and the ledger should say research ran: a planner that failed to parse, or a brief the sensor refused, is one record with the planner's model and no reader.
- **The count of findings beyond the third lived only in a log line** — now also on the asker's row (`found.dropped`), no ledger change.
- **The stub's tool blocks lacked the SDK's `caller`** — added (`{ type: "direct" }`); the stub still answers a tool request on `hb-small`, since the provider's refusal of one there is not established.
