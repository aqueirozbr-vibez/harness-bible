# 31 · Suggestion intake — feature spec (drafts, anchors, the proposal, the intake sensors, submission, limits)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: PRD Capability 4, requirements 1 and 3 (the form's fields; "free-text suggestions with no anchor are rejected at intake"); TRD § 6.1 (the Suggestions rows of the endpoint catalogue), § 6.4 (20 a day; the throttle), § 7.4 steps 1 to 3, the schema rules of p. 22; architecture § 3.4, § 5.6, § 6.4 and invariants 11, 23 and 25. The suggest screen is spec 34's; this spec is what it calls.

Prerequisite specs: `29-improvement-schema.md`, `30-rubric.md` (§ 4: change kinds and classes), `28-workflow-engine.md` (§ 5, the client that starts a workflow).

Scope: tracker unit 48 (48a to 48d). Creating, changing and reading a draft; resolving its anchor; the four intake sensors; submitting. Not here: evidence (spec 32 owns `POST /suggestions/{id}/evidence`), the workflow that a submission starts (33), any page (34, 35).

## 1. Purpose

A suggestion is useful to the book only if it says exactly what would change and where. Intake is the part of Improve that refuses everything that does not, before a grader or an adjudicator is paid to read it: an anchor that does not exist, a passage that is not in the section, a rationale that argues instead of pointing at evidence. It is all deterministic, and it runs twice: once at the endpoint, so a person is told at once what to fix, and once more in the workflow, so that nothing that reached the workflow by another road (the researcher, a release that moved under a draft) skips it.

## 2. Dependencies and order

48a creates a draft; 48b fills it; 48c is pure and can be written beside either; 48d needs all three and the workflow client of unit 45d. Until unit 50a exists, 48d starts the proving workflow's stand-in declared in § 6.4, so the endpoint is real and tested before the workflow it will start.

## 3. A draft and its anchor (48a)

`POST /api/v1/suggestions` — session; role `CONTRIBUTOR` or above and `verified` (policy, spec 29 § 6.2); `Idempotency-Key`; 20 a day for the contributor (TRD § 6.4), counted on drafts created.

Request: `{ anchor: { kind, id }, changeKind, locale }`. `id` is the anchor as the reader prints it: `21.3`, `F-21-03`, `21.9 r4`.

It resolves the anchor against `Release.current`, fills `Anchor` (`currentText`, `contentSha256`, `existsAtVersion`), computes the class (`classOf`, spec 30 § 4.2) and allocates the id (spec 29 § 4.2).

Response: `{ id, state: "DRAFT", changeKind, changeClass, curatorReason, thresholds: { acceptAt, floorAt }, fastMoving, anchor: { kind, id, currentText, tier, verifiedOn, readBy } }`. `readBy` lists the other anchors that read this one (a source row's figures; a figure that also appears in another chapter), which the screen prints as "Read by 15.3 worked numbers and by 37.3 configuration C".

Refusals, in the API's error form: 422 `ANCHOR_REQUIRED` (no anchor), 422 `ANCHOR_UNKNOWN` (not in the pinned release; the detail names the release), 422 `CHANGE_KIND_INVALID` (a pairing spec 30 § 4.1 does not list), 429 `SUGGESTION_THROTTLED` with `throttledUntil` and the reason (§ 6.3), 429 on the daily limit.

## 4. The proposal and the rationale (48b)

`PATCH /api/v1/suggestions/{id}` — owner; state `DRAFT`, or a state a revision is allowed from (§ 6.5); body `{ proposal?, rationale? }`. Idempotent by content. It is what the form's autosave calls: a same-origin `fetch` from the edit page's island, so that the endpoint's role, policy and rate apply (34 § 17; code-standards; architecture § 6.4).

`ProposalSchema` (`lib/schemas/improve.ts`), a union on `kind`:

| Kind | Fields |
|---|---|
| `EDIT_TEXT` | `before` (a passage of the section's source text), `after` |
| `SET_VALUE` | `after` (a decimal), `unit` |
| `EDIT_ROW` | any of `claim`, `citation`, `url`, `doi`, `verifiedOn`, `value { after, unit }`; at least one |
| `ADD_CLAIM` | `text`, `placeAfter` (a passage of the section, or `end`), `fastMoving` |
| `ADD_ROW` | `claim`, `citation`, `url?`, `doi?`, `tier` (one of the book's seven, or `{ newTier }`), `fastMoving` |
| `RESTRUCTURE` | `description` |

The class is recomputed on every change of the proposal, because rule 3 of `classOf` reads the proposed text and rule 4 the tier; the response carries the class and thresholds again. No size limit is added here: the handler pipeline already refuses a body over 64 KB (`PAYLOAD_TOO_LARGE`).

`GET /api/v1/suggestions/{id}` — owner, or a curator of one of its parts (120 a minute): the draft or the submitted suggestion with its anchor, proposal, evidence, score and, once they exist, sensors and adjudication. A curator never gets a `DRAFT`.

`DELETE /api/v1/suggestions/{id}` — owner, `DRAFT` only. Since unit 63a (spec 45 § 4) it also cancels the draft's pending gradings and removes everything its evidence stored.

Not in the TRD's catalogue and added here because the form cannot work without them: `PATCH` and `DELETE`. Recorded in architecture § 3.4.

## 5. The intake sensors (48c, `lib/sensors/intake.ts`, pure)

Four functions, each returning `{ sensor, result, detail, data }`, each given rows and never a database.

| Sensor | Passes when | The failure says |
|---|---|---|
| `SCHEMA` | the proposal parses for its change kind; the kind is allowed on the anchor's kind; for `EDIT_TEXT` and `ADD_CLAIM`, the passage occurs exactly once in the section's source text; an `EDIT_TEXT` neither overlaps a figure nor changes a digit; `after` differs from `before` | which field, and for a number in prose, which figure to anchor instead |
| `ANCHOR_EXISTS` | the anchor exists in the pinned release, and its `contentSha256` is the one the draft recorded | `F-23-07 does not exist at ch23 v1.4.1` (the Components screen's string), or that the anchored text changed in a later release and what it reads now |
| `EVIDENCE_PARSES` | at least one evidence item, and every item has what its kind needs and has been through the fetcher (state `GRADED`, whatever its tier) | which item, and what it lacks |
| `RATIONALE_LENGTH` | a person's rationale is 1 to 200 words; a researcher's note is at most 200 | the count |

Words are counted by one function (`lib/improve/words.ts`: runs of non-whitespace), used by the form's counter, the endpoint and the sensor.

Declining for evidence that is merely weak is not intake's: an item graded `U` or `G` parses. The floor does that, after grading (spec 33 § 3.3).

**`EVIDENCE_PARSES` has two callers since unit 50a** (Andre, 2026-10-07, option A). The submit endpoint requires every item through the fetcher, as the table says: a person waits for their own items. The suggestion workflow's step 2 asks each item only for what its kind needs and leaves the grading to its step 3 (spec 33 § 3.2), which grades what is still pending before the score: a researcher's items arrive ungraded, and a person's item added while the submission was under way is graded there rather than declined. Its pass then reads `2 items, each with what its kind needs`.

## 6. Submission (48d)

`POST /api/v1/suggestions/{id}/submit` — owner; `Idempotency-Key`; 20 a day; body `{ consent: boolean }`.

### 6.1 Order

1. The policy (owner, `verified`).
2. The throttle and the daily limit (§ 6.3).
3. Consent (§ 6.2).
4. The four intake sensors. A failure is 422 `INTAKE_<SENSOR>` with the sensor's detail; the suggestion stays a draft and nothing is recorded, because nothing was submitted.
5. `startWorkflow("SuggestionWorkflow", "suggestion:<id>", { suggestionId })`. If the engine does not answer: 503 `WORKFLOWS_UNAVAILABLE`, still a draft.
6. Only then `transition(DRAFT → SUBMITTED)` with `submittedAt` and `workflowId`.

Response: `{ state: "SUBMITTED", workflowId }`. Step 5 before step 6 means a crash between them leaves a running workflow and a draft row; the workflow's first activity makes the same transition, so the row catches up. The reverse order could leave a suggestion that says submitted with nothing working on it.

The `submitted` ledger record is the workflow's, not the endpoint's (invariant 17).

### 6.2 Consent

Invariant 25: a person's suggestion leaves `DRAFT` only with `identityVerified` and `provenanceConsentAt`. The first is the policy's. For the second, a contributor whose `provenanceConsentAt` is null must send `consent: true`; the endpoint sets the column in the same transaction as the transition. Without it: 422 `CONSENT_REQUIRED`. The sentence the form shows beside the control is the Account-Admin screen's retention row, "contributor identity: for provenance, with consent", expanded into one line (candidate, spec 34 § 8).

### 6.3 Limits

| Rule | Value | Source | Enforced |
|---|---|---|---|
| drafts created | 20 a day per contributor | TRD § 6.1 | the handler's rate limit |
| submissions | 20 a day per contributor | TRD § 6.1 | the handler's rate limit |
| throttle | `throttledUntil` in the future | TRD § 6.4 | the endpoint, on create and on submit: 429 with the date and "3 declines for unverifiable evidence in 30 days"; suggestions already submitted proceed |

The Improve-Suggest screen prints "2 of 10 this month". The TRD says 20 a day and outranks the screen (rules, order of precedence), so the form prints the day's count against 20.

### 6.4 Until the workflow exists

Unit 48d is built before unit 50a. It starts `SuggestionWorkflow` by name; until 50a registers it, the workers register a workflow of that name that makes the `SUBMITTED` transition and returns. It is deleted by 50a, whose first test is that it is gone. This is the one place a unit ships something a later unit removes, and it is here so that the endpoint's order, refusals and idempotency are tested against a real engine and not a double.

### 6.5 Revising

The adjudication page's "Revise with new evidence" returns the suggestion to its owner for more evidence. A suggestion in `INTAKE_DECLINED`, or in `DECIDED` or `CURATOR_QUEUE` with outcome `REQUEST_MORE`, accepts new evidence items and a changed rationale (never a changed anchor or proposal: that is a different suggestion), and `submit` on it signals the running workflow with `revised` instead of starting one (spec 33 § 6.4). The daily limit counts it.

## 7. States

| State | Behaviour |
|---|---|
| not signed in | 401; the suggest route sends the visitor to sign in with `next` |
| signed in, not a contributor | 403 `ROLE_REQUIRED`; the page says what the role is for (spec 34 § 7) |
| a contributor, not verified | 403 from the policy; the page says identity is verified at sign-in with the provider |
| throttled | 429 with the date and the reason |
| a release was published while the draft was open | `ANCHOR_EXISTS` fails on submit if the anchored content changed; the draft shows the new text beside the old |

## 8. Out of scope

- Withdrawing a suggestion while it is being decided, once accepted or merging, or once merged. A draft can be deleted; a suggestion that waits for its contributor or a curator can be withdrawn since unit 63f, which closes it with a `retracted` record (spec 45 § 5). A submission is still a record.
- Editing the anchor or the proposal of a submitted suggestion.
- Suggestions on the rubric, on a lab's files, or that add a chapter (overview § Out of scope).

## 9. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | A failed intake at the endpoint: a 422, or a recorded decline | a 422, nothing recorded | TRD § 6.1 gives `submit` "422 intake sensor named"; a form error is not an adjudication. The workflow records the declines that reach it (spec 33 § 3.1) |
| D2 | A number changed inside prose | refused, with the figure to anchor | the class of a figure change depends on its tier and derive link, which only the figure's anchor carries |
| D3 | The daily count shown | of 20 today | the TRD over the screen |
| D4 | `PATCH` and `DELETE` on a draft | add them | "drafts autosaved" (overview § Features) has no endpoint in the TRD |

## 10. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Contract tests for the five endpoints against the generated OpenAPI document; every refusal of § 3, § 4 and § 6 in the API's error form.
2. A draft on `21.3` with `EDIT_TEXT` is `WORDING` with 40 and 5; on a derived figure with `SET_VALUE`, `DERIVED_FIGURE` with 100 and 100; on a figure with `scenarioParam`, `CURATOR_ALWAYS` · `SCENARIO_PARAMETER`; a proposal whose text trips the control-system vocabulary becomes `CURATOR_ALWAYS` · `SAFETY_OT` on the `PATCH` that adds it.
3. Each intake sensor: one passing and every failing case of § 5, as unit tests; the three the gate names (no anchor, a rationale of 201 words, an anchor that does not exist at the current version) as endpoint tests returning 422 with the sensor named.
4. A second `submit` with the same key returns the first answer; with a new key on a submitted suggestion it returns the running workflow, not a second one.
5. With the engine stopped, `submit` is 503 and the suggestion is still `DRAFT`.
6. A contributor with `throttledUntil` tomorrow gets 429 on create and on submit; their already submitted suggestion is untouched.
7. A reader and an unverified contributor are refused by the policy; a curator reads a submitted suggestion of their part and gets 404 on a draft.
8. Invariant check: no model call is made by any endpoint of this spec (the gateway's ledger holds no row after the suite).


## 11. As built (unit 48a, 2026-10-06)

§ 3 as written: `POST /api/v1/suggestions`, the first endpoint that writes an improvement row. The proposal, the read and the delete are 48b; the sensors 48c; the submission 48d.

- **The pipeline does what § 3 lists before the endpoint runs**: a session; the contributor's role as the handler's cheap gate (`ROLE_REQUIRED` for a reader or a builder, § 7); twenty a day for the contributor, the handler's rate limit keyed by user and path over 86,400 s; an `Idempotency-Key`, the same key answering the same draft; and the policy's `create` on a suggestion of the contributor's own, which refuses an unverified contributor (29 § 6.2). The endpoint then refuses a throttled contributor first (§ 6.3): `429 SUGGESTION_THROTTLED` with `throttledUntil` and TRD § 6.4's reason, read from the account through `contributorStandingOf` (`lib/db/account.ts`), which 48d reads again for the consent.
- **The anchor is resolved by `lib/db/anchors.ts`**, against `Release.current` as the content loaders read it: a section (its source edition's markdown is the anchored text), a figure (its label and value, its tier, whether it is fast-moving or a scenario parameter, the figures with the same id in other sections as `readBy`), a source row (its claim and citation, its tier, its verification date, the sections of the figures that read it as `readBy`). An id of the wrong form for its kind is `ANCHOR_UNKNOWN` as an absent one is, naming the release. `contentSha256` is the sha256 of the anchored text, which the `ANCHOR_EXISTS` sensor (48c) compares. `Anchor.sectionAnchor` is always the section: a row's is its chapter's layer 9.
- **The pairing of change kind and anchor kind is checked here**, before the anchor is read: `CHANGE_KIND_INVALID` names the kind the anchor takes (`ANCHOR_OF_CHANGE_KIND`, 30 § 4.1). The intake sensor (48c) checks it again at submission, as § 1 says everything is checked twice.
- **The class is `classOf` on the anchor, with no proposal yet**, and 48b computes it again on every change of the proposal. **For a section, rule 3 reads nothing at creation**: the text that rule reads is the passage the proposal quotes, and a section's whole source would make a chapter about a pump's work order the curator's at every line (§ 10.2 has a draft on 21.3 as `WORDING`; chapter 21's source text is about P-101). A figure's or a row's own text is read at creation, so a row about operating equipment is the curator's from the start.
- **The parts** are the anchor's chapter's and those of every section in `readBy` (29 § 3: the parts a shared figure or row reaches), so a curator of a chapter that reads the row will see the suggestion once it is past draft.
- **The rubric in force** gives the draft its `rubricVersionId` and the response its thresholds, read through the loader and checked against the row as `GET /rubric/current` checks it; a deployment with no rubric published, or whose file differs, cannot take a suggestion (`500 INTERNAL`), which is the deployment's fault and not the contributor's.
- **The response** is § 3's: the id, `DRAFT`, the kind, the class and the curator's reason, the thresholds (both null where no score decides), `fastMoving` (the figure's or the row's; false for a section until the proposal declares it), and the anchor with its text, tier, verification date and `readBy` (section and title in the contributor's language where the PT edition is at parity); `rubricVersion` is added, because the form prints it. The id's form is the ledger's (`S-21-0016`); the serial is the chapter's next and a draft that is refused or deleted leaves a gap, as 29 § 4.2 says.
- **The error messages** of the four new codes are the catalogue's (`api.errors`), EN and PT written with the unit, since no screen gives them: candidates for Andre with the page's strings.
- **Not here**: the daily count the form prints (48b's read), the `readBy` sentence (34), the sensors (48c).

Verified:

| § 10 | What | Result |
|---|---|---|
| 2 | against the database and the sidecar (`tests/integration/suggestions.test.ts`) | a draft on 21.3 with `EDIT_TEXT` is `WORDING` with 40 and 5, anchored to the section's source text with its hash, the rubric v1.2; `SET_VALUE` on `F-01-19` (derived) is `DERIVED_FIGURE` with 100 and 100; on `F-01-44` (a scenario parameter) `CURATOR_ALWAYS · SCENARIO_PARAMETER` with no thresholds; `EDIT_ROW` on `21.9 r1` is `CITED_FIGURE` with 70 and 25 and the row's verification date |
| 1, 4 | the same key twice, then a new key | the same draft, `Idempotency-Replayed: true`; the next key the chapter's next serial |
| 1 | the refusals through the route | `ANCHOR_REQUIRED`, `ANCHOR_UNKNOWN` (an absent section and a figure's id given as a section), `CHANGE_KIND_INVALID` naming `FIGURE`, each 422 in the API's error form and none writing a row |
| 7 | a reader, an unverified contributor, a throttled contributor | `403 ROLE_REQUIRED`; `403 FORBIDDEN` from the policy; `429 SUGGESTION_THROTTLED` with the date and the reason, then 200 once the throttle is cleared |
| 8 | the gateway's ledger | no row for the suite's accounts after the suite |
| — | with the rows doubled (`lib/api/endpoints/suggestions.test.ts`) | 14 cases: the declaration (session, role, twenty a day, key, `create`), 401, `ROLE_REQUIRED`, `FORBIDDEN` with the audit row, `IDEMPOTENCY_KEY_REQUIRED`, `RATE_LIMITED` with `Retry-After`, the four refusals with their details, a throttle in the past passing, no rubric or a changed file as a fault, the drafts' columns for a section, a derived figure, a scenario parameter, a row read by two sections of two parts, and a row about operating equipment |
| — | through the development server, as the end-to-end contributor | the same draft on `21.9 r1` twice with one key: `200`, `ratelimit-limit: 20`, the second `idempotency-replayed`; the row `DRAFT`, `CITED_FIGURE`, parts `{P2}`, rubric `v1.2`; the draft deleted after |
| — | the whole suite | `npx tsc --noEmit` 0; `npm run lint` 0 warnings; without a database 1,291 passed, 231 skipped in 154 files (the rows suite's known failure aside); with the database and the engine, purge excluded, 153 files and 1,505 tests passed, 17 skipped, twice; `npm run test:ledger` and `npm run test:rubric` 100 %; `npm run build` 0; `npm run secrets:scan` 0 findings; `openapi.json` regenerated |


## 12. As built (unit 48b, 2026-10-06)

§ 4 as written: `PATCH`, `GET` and `DELETE /api/v1/suggestions/{id}`, and `ProposalSchema`. The sensors are 48c; the submission 48d; the form that autosaves through a server action is spec 34's (unit 51), and the server action will be the same function as the endpoint's `run`, as architecture § 6.4 says.

- **`ProposalSchema`** (`lib/schemas/improve.ts`) is the union of § 4's table on `kind`, each member strict with exactly its fields: a decimal is text (`0.25`), so no binary fraction stands between the contributor and the row; a row edit names at least one of its six fields; a proposed row's `tier` is one of the book's seven or `{ newTier }`; `url` and `doi` have their forms. Every string is trimmed and at least one character; the body's size is the pipeline's 64 KB.
- **The proposal's key and the texts the class reads** are `lib/improve/proposal.ts`, pure: `normaliseProposal` (trimmed, runs of whitespace as one space), `proposalKeyOf(anchor, proposal)`, the sha256 of the ledger's canonical form of the anchor (its kind, its three anchors and its `contentSha256`, so that a changed text opens the question again, 42 § 4.3) and the normalised proposal; and `proposalTexts`, what rule 3 reads of it (the quoted passage and the proposed text) and what rule 4 reads (the tier named).
- **`PATCH`** writes the proposal (with its key and the class recomputed) and the rationale into the owner's draft through the door's `updateDraft`; the rationale alone also into a suggestion open for revision (§ 6.5: `INTAKE_DECLINED`, or `DECIDED` or `CURATOR_QUEUE` with outcome `REQUEST_MORE`), never the proposal there. A proposal of another kind than the draft's is `422 CHANGE_KIND_INVALID`; a change the state does not take is `409 CONFLICT` naming the state. No `Idempotency-Key`: the same patch twice is the same row, and the response is the suggestion as `GET` reads it, class and thresholds included. The class is computed as at creation, with the proposal's texts: for a section the passage quoted, for a figure or a row its own text; the figure's tier and scenario flag are read from the release again, and from the draft's own class where the release no longer has the figure, so that a release that moved under a draft does not reclassify it before the `ANCHOR_EXISTS` sensor refuses it.
- **`GET`** is the owner's or a curator of one of its parts' (the door's reading rule, 29 § 4.1): the suggestion with its anchor (and who else reads it, resolved again), proposal, rationale, score, evidence, sensors and adjudication, the thresholds of the rubric it was written against (its own `rubricVersionId`, loaded and hash-checked), and `own`, which tells a curator it is not theirs. A draft is its owner's alone: a curator of its part gets 404, as does anyone else; not there and not theirs are one answer.
- **`DELETE`** is the owner's, on a draft: the row goes with its anchor; a suggestion past draft is `409 CONFLICT` naming the state. **The policy action for a delete is `write`** (29 § 6.2 has `read` and `write` for the owner; the tracker's open row of unit 46d is closed by this): a draft is its owner's to write, deletion included, and no new rule was added to the bundle.
- **The policy is asked with the row**: each of the three builds its resource by reading the suggestion through the door with the caller's own condition (owner, parts, class, origin), so what the caller may not read is `404` before the policy is asked, and the policy is asked all the same for what is (invariant 23). The rates: reads 120 a minute per user as § 4 says; writes to a draft and deletes the same, since the form's autosave is one a second at most (34 D3) and TRD § 6.1 counts drafts created and submissions only.
- **Not here**: the day's count the form prints (34), `lib/improve/words.ts` and the sensors (48c), the autosave server action (51).

Verified:

| § 10 | What | Result |
|---|---|---|
| 2 | against the database and the sidecar (`tests/integration/suggestions.test.ts`) | a text edit on 21.3 is `WORDING` with 40 and 5 on the `PATCH` that adds it, and `CURATOR_ALWAYS · SAFETY_OT` with no thresholds on the `PATCH` whose proposed text trips the control-system vocabulary; the row's class, reason, proposal and key as written; the same patch twice the same suggestion |
| 7 | `GET` as the owner, a curator of the part, another contributor, a reader | the owner's draft with its proposal; 404 for the three others; 404 for an id of the right form that is nobody's; 400 for one of the wrong form |
| 1 | `DELETE` | the owner's draft gone with its anchor; 404 after; 404 for another's |
| 8 | the gateway's ledger | no row for the suite's accounts after the suite |
| — | with the rows doubled (`lib/api/endpoints/suggestions.test.ts`, 11 more cases) | the read's shape and its rubric; a curator of the part reading a submitted suggestion as not their own and a draft not at all; the policy's resource; the patch's key and class; a quoted passage, a proposed text and a new tier each making the change the curator's; a derived figure keeping its class where the release lost the figure; idempotence by content with no key; a proposal of another kind, seven malformed proposals; a rationale on a suggestion open for revision and a proposal refused there; both refused once submitted; a delete of a draft and of a submitted suggestion |
| — | through the development server, as the end-to-end contributor | create, patch (`WORDING`, 40 and 5, the proposal and rationale back), read (`own`, no evidence), delete, read again: 200, 200, 200, 200, 404 |
| — | the whole suite | `npx tsc --noEmit` 0; `npm run lint` 0 warnings; without a database 1,302 passed, 234 skipped in 154 files (the rows suite's known failure aside); with the database and the engine, purge excluded, 153 files and 1,519 tests passed, 17 skipped, twice; `npm run test:ledger` and `npm run test:rubric` 100 %; `npm run build` 0; `npm run secrets:scan` 0 findings; `openapi.json` regenerated |

**One interaction between suites, found and fixed:** the door's suite (`tests/integration/improve.test.ts`) inserts a throwaway rubric `v0.1` applying `now()`, and while it exists the suggestion endpoints took it as the version in force (the latest that applies), so four cases of this suite failed with `rubric/v0.1/manifest.json` missing on one run of four. It now applies on 2000-01-01, which nothing publishes and nothing reads as current.


## 13. As built (unit 48c, 2026-10-06)

§ 5 as written: `lib/sensors/intake.ts`, four pure functions and `intakeSensors` running them in the table's order, each given rows and answering `{ sensor, result, detail, data }` as a `SuggestionSensorVerdict` row holds it; `lib/improve/words.ts` counting words for the form, the endpoint and the sensor alike. The submit endpoint that runs them is 48d; the workflow that runs them again is 50a.

- **`SCHEMA`** takes the change kind, the anchor's kind, the proposal as stored and, for a section, its source text with its figures' ids and values. It fails, in this order and naming the field: a pairing 30 § 4.1 does not list; no proposal; a proposal that does not parse (`ProposalSchema`, the first issue's path); a proposal of another kind than the draft's; a passage (`before`, or a claim's `placeAfter` other than `end`) that is in the section's source text zero times or more than once; a text edit whose `before` holds one of the section's figures, naming it (D2: the figure is changed by anchoring it); a text edit whose digits differ between `before` and `after`, naming the figure when the new number is one of the section's, else that a number is changed by anchoring its figure; an `after` equal to `before`. "Holds a figure" is read with the pipeline's own `NUM` expression over the passage against the figures' `valueText`, so a `2` inside a word is not a figure and `77%` is. The same digits in another order are the same digits: a wording that moves a number is a wording.
- **`ANCHOR_EXISTS`** takes the draft's anchor, the pinned release's chapter version and the anchor as resolved now (or null): `F-23-07 does not exist at ch23 v1.4.1` in the Components screen's words; `F-23-06 changed since the draft at ch23 v1.5.0` with `was` and `now` in its data for the page to show both; `F-23-06 at ch23 v1.4.1` when it passes. The caller resolves the anchor (`lib/db/anchors.ts`) and hands the sensor the rows; it reads no database.
- **`EVIDENCE_PARSES`** takes the items: none is a failure; an item without what its kind needs (`LINK` a url, `DOI` a DOI, `UPLOAD` an uploaded file, `LAB_RUN` a saved run) or not through the fetcher (`state` other than `GRADED`) is named by its ordinal, the first in the items' order. A tier U or G parses, as § 5 says.
- **`RATIONALE_LENGTH`** counts with `countWords` (runs of non-whitespace): a person's 1 to 200, a researcher's note 0 to 200, the count in the detail and the bounds in the data.
- **The details are sentences a curator reads** on the adjudication page's Sensors table, in the screen's form and in EN only, as the screen has them; the data carries the same facts for a page to print in the reader's language. They are candidates, listed in the tracker.
- **Not here**: the three endpoint cases § 10.3 names (no anchor, 201 words, an anchor not at the current version) are the submit endpoint's (48d).

Verified:

| § 10 | What | Result |
|---|---|---|
| 3 | one passing and every failing case of § 5 (`lib/sensors/intake.test.ts`) | 21 cases over the four sensors and the runner: the eight failures of `SCHEMA` by name, every kind on its own anchor passing, the figure's expression on a passage, the three answers of `ANCHOR_EXISTS` with the screen's words, the four kinds' lacks and a pending item, the four bounds of the rationale |
| — | `countWords` (`lib/improve/words.test.ts`) | 2 cases: whitespace of every kind, the screen's 142 and the limit of 200 |
| — | 13 rules weakened one at a time in place | 13 of 13 caught by a test that names the rule |
| — | the whole suite | `npx tsc --noEmit` 0; `npm run lint` 0 warnings; without a database 1,325 passed, 234 skipped in 156 files (the rows suite's known failure aside); with the database and the engine, purge excluded, 155 files and 1,542 tests passed, 17 skipped, twice; `npm run test:ledger` and `npm run test:rubric` 100 %; `npm run build` 0; `npm run secrets:scan` 0 findings |


## 14. As built (unit 48d, 2026-10-06)

§ 6 as written: `POST /api/v1/suggestions/{id}/submit`, the stand-in `SuggestionWorkflow` of § 6.4, and the workflow's entry in the shared table. It is the last unit of this spec; the evidence endpoints (spec 32) and the workflow of spec 33 follow.

- **The order of § 6.1 is the pipeline's, then the endpoint's.** The handler does the session, the contributor's role, twenty submissions a day (the handler's rate limit, as for drafts), the `Idempotency-Key` and the policy's `submit` (owner and verified, 29 § 6.2), in its own fixed order, which puts the day's limit before the policy; the endpoint then does the rest in § 6.1's: the throttle (§ 6.3, as on create); the consent (§ 6.2); the four sensors on the rows (§ 5); the workflow started; only then the transition. A second request with the same key is answered by the pipeline from the first answer; a suggestion already past draft and not open for revision is answered with its running workflow, and nothing is started twice (§ 10.4).
- **Consent** (invariant 25): a contributor whose `provenanceConsentAt` is null sends `consent: true` or is told `422 CONSENT_REQUIRED` before any sensor runs; the column is set in the same transaction as the transition (`submitDraft`: the door's `transition` and the user's row in one `$transaction`), so the row says submitted exactly when the consent is on file. With it on file, `consent: false` is taken as the no-op it is.
- **The sensors run on what the endpoint reads**: the anchor resolved again against the pinned release, with the section's figures for the schema sensor; the pinned release's chapter version for the sentence when the anchor is gone; the items and the rationale as the door read them. The first failure is `422 INTAKE_<SENSOR>` with the sensor, its sentence and its data in the detail, and nothing is recorded (D1): the workflow records the declines that reach it.
- **The engine first, then the row** (§ 6.1 steps 5 and 6): `startWorkflow("SuggestionWorkflow", "suggestion:<id>", { suggestionId })` through the client of 45d; `503 WORKFLOWS_UNAVAILABLE`, from the client's own error, leaves a draft and nothing else; the transition follows, with `submittedAt` and the workflow's id. A crash between the two leaves a running workflow whose first activity makes the same move, so the row catches up; a transition that found the row already moved answers the state it found and the workflow that was started.
- **A revision** (§ 6.5): a suggestion in `INTAKE_DECLINED`, or in `DECIDED` or `CURATOR_QUEUE` with outcome `REQUEST_MORE`, goes through the throttle, the consent and the sensors as a draft does, and is then signalled `revised` instead of started; the answer is its state and its workflow. A workflow that has ended is `409 CONFLICT`. What the signal does is spec 33 § 6.4's (50e); the stand-in takes it and does nothing.
- **The stand-in** (`workers/workflows/suggestion.ts`, `workers/activities/suggestion.ts`): checks its argument, takes the `revised` signal, runs one activity, `submitted(suggestionId, workflowId)`, which makes `DRAFT → SUBMITTED` as the intake service with its own id on the row (idempotent: a row already past draft is left and its state returned), and returns `{ suggestionId, state }`. Its entry in `WORKFLOWS` (`lib/schemas/workflows.ts`: the input, the result, the `revised` signal, the id `suggestion:S-NN-NNNN`) stays when 50a replaces the function; its suite (`tests/workflows/suggestion.test.ts`) goes with it, and 50a's first test is that the stand-in is gone. **Gone since unit 50a** (2026-10-07; spec 33 § 12): the name, the id, the queue, the signal and the `WORKFLOWS` entry stay, and the workflow is spec 33's steps 1 to 4; its suite went with it. **And the consent goes on file before the start** (§ 6.2 as changed by 50a): the workflow's move out of draft holds invariant 25 in its query, so a consent written in the endpoint's own move could leave the workflow giving up on a commit it outlived, the suggestion then submitted with nothing behind it.
- **The error messages** of the five new codes (`CONSENT_REQUIRED`, `INTAKE_SCHEMA`, `INTAKE_ANCHOR_EXISTS`, `INTAKE_EVIDENCE_PARSES`, `INTAKE_RATIONALE_LENGTH`) are candidates in both catalogues, as the intake's four of 48a are; the form's own sentence for consent is spec 34's.

Verified:

| § 10 | What | Result |
|---|---|---|
| 3 | the three endpoint cases, against the database and the sidecar (`tests/integration/suggestions.test.ts`) | a 201-word rationale `422 INTAKE_RATIONALE_LENGTH` with the count; an anchor whose recorded hash is not the release's `422 INTAKE_ANCHOR_EXISTS`, the sentence naming the chapter's version and the data holding what it reads now; no evidence `422 INTAKE_EVIDENCE_PARSES`; each leaving the row a draft with no workflow. The no-anchor case is the creation's `ANCHOR_REQUIRED` (§ 11) |
| 4, 6.2 | against the real engine, with the workers restarted on this unit's code | `consent: false` on a first submission `422 CONSENT_REQUIRED`; `consent: true` then `200 { state: SUBMITTED, workflowId: suggestion:<id> }`, the row moved with `submittedAt` and the id, the consent on file; the workers' stand-in ran the workflow and it returned `{ suggestionId, state: SUBMITTED }`; a second key answered the same running workflow, `consent: false` too; the submitted suggestion refused to `DELETE` and `PATCH` with 409 |
| 5 | the engine not answering | with the engine doubled (`lib/api/endpoints/suggestions.test.ts`): `503 WORKFLOWS_UNAVAILABLE`, the transition not made, the suggestion a draft. The dev engine was not stopped for it |
| 6.4 | the stand-in on Temporal's test server (`tests/workflows/suggestion.test.ts`) | 4 cases: the move with its own id and the state returned; the state the endpoint left when it moved first; the signal taken; a bad argument failing without retry |
| — | with the rows and the engine doubled (`lib/api/endpoints/suggestions.test.ts`, 9 more cases) | the declaration; the happy path's order (start, then the row with the consent); consent on file; `CONSENT_REQUIRED`; the four sensors by name with nothing started; 503; the running workflow for a second key; the revision's signal and the ended workflow's 409; throttle, another's, a reader's, no key, a malformed body |
| — | through the development server | a draft filled and submitted without evidence: `422 INTAKE_EVIDENCE_PARSES`, the row still a draft, then deleted |
| 8 | the gateway's ledger | no row for the suite's accounts after the suite |
| — | the whole suite | `npx tsc --noEmit` 0; `npm run lint` 0 warnings; without a database 1,338 passed and 236 skipped in 157 files (the rows suite's known failure aside); with the database and the engine, purge excluded, 156 files and 1,557 tests passed, 17 skipped, twice; `npm run test:ledger` and `npm run test:rubric` 100 %; `npm run build` 0; `npm run secrets:scan` 0 findings; `openapi.json` regenerated |

**The suite's submitted suggestions are put back to draft and deleted**, by the suite and by name, since the database refuses to delete a suggestion past draft; their workflows stay in the engine's history as the proving ones do.
