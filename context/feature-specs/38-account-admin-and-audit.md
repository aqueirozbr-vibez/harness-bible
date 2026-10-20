# 38 · Account, audit and the roster — feature spec (the budget meter by consumer, the audit export, the public curator roster)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: `docs/design/screens/Account-Admin.html` (Model budget, Audit export, Curator roster); overview § Core user flow step 16 and § Features · Account and administration; TRD § 6.1 (the Organisation rows), § 7.7 (`ExportWorkflow`), § 4.3 (the export's form); architecture § 4.3, § 5.5, § 6.3.

Prerequisite specs: `14-ledger-core.md` (the export, its scopes, the signed trailer), `21-assistant-retention-observability.md` § 4 (the budget meter as built), `28`, `29` (the roster), `32` § 5 (object storage).

Scope: tracker unit 55 (55a to 55c). The three parts of the Account-Admin screen that Improve makes possible. The rest of that screen is § 6.

## 1. Purpose

Phase 4's own list ends with "audit export; Account-Admin screens". Most of that screen describes an organisation: seats, members, single sign-on, residency. The product has no organisational accounts yet (architecture § 5.1: individual accounts are the only kind Phase 1 built), so this spec builds what does not depend on them: the budget's new consumers, the audit pack, and the roster every account may read.

## 2. The budget meter by consumer (55a)

The account page's meter (unit 35b) already groups the month's `BudgetLedger` rows by kind. Improve adds two kinds a contributor's principal pays for, `GRADING` and `ADJUDICATION` (spec 33 § 7), which the screen's breakdown does not show although the TRD's ledger has them. The breakdown gains their two rows, with the count of suggestions they served, in the screen's form (`consumer · tokens · of cap`).

Research is never on a reader's meter: the platform pays (A6, spec 40 § 7), and its spend is on the researcher's dashboard (spec 44).

## 3. The audit export (55b)

`POST /api/v1/org/audit-exports` — `Idempotency-Key`; 4 a day (TRD). Body `{ scope: { kind: "account" | "chapter", id }, from, to, kinds: ("adjudications" | "overrides" | "merges" | "answers")[] }`. Answer `{ id, state }`.

- **Who.** The TRD says an organisation's admin. Until organisations exist: an `ORG_ADMIN` for their organisation; any signed-in person for their own account (D1); anyone for a chapter, whose records are public once merged. The policy's `export` action on `audit-export` gets those three rules, with their deny cases.
- **`ExportWorkflow`** (`export:<id>`, queue `hb-improve`): select the ledger's records by scope, range and kinds, with each record's predecessor so a filtered file verifies (spec 14); write the JSONL and its signed trailer to object storage under `audit/<id>.jsonl`; append the `EXPORT` record (the export is itself a ledger record); set the row to `READY`. The file is delivered by a signed URL valid 24 hours (TRD § 7.7), asked for through `GET /api/v1/org/audit-exports/{id}`.
- **The `account` scope**, which spec 14 refuses today (`LEDGER_SCOPE_NOT_YET`), is implemented here: the records whose actor is that account's pseudonym, and for an organisation its members'.
- **The form**: the screen's panel on `/[lang]/account` (on Book management, `/[lang]/account/book`, for curators and organisation admins, since 2026-10-12: feature-specs/47; the API's rules above are unchanged): `scope` (`Per account | Per chapter`), the chapter select, `from`, `to`, the four `records` checkboxes, the estimate of records in range, `Export audit pack`, and the last export's line with its head hash and `chain verified`. The estimate is a count query, never a guess.

## 4. The curator roster (55c)

The screen's panel, read-only and "visible to all accounts": `part · chapters · curators · queue · median decision time`, one row per part, from `CuratorRoster`, the chapters of each part, the open queue count, and the median time from queue entry to decision over the last quarter. It was on `/[lang]/account` for a signed-in reader; since 2026-10-12 it is on Book management (`/[lang]/account/book`) for curators and organisation admins, and the Rubric page links to it for them alone (feature-specs/47, D3); a part with fewer than two curators is shown as it is, and the Phase 4 gate is where that is judged (spec 39).

Curators appear by display name: being on the roster is a public role, and the roster command (spec 29 § 6.3) says so to the operator who adds a name. Since 2026-10-12 the panel is shown to curators and organisation admins only (feature-specs/47 D1), and the command says that.

## 5. States

| State | Behaviour |
|---|---|
| nothing in range | the estimate reads 0 and the export is refused with `LEDGER_EXPORT_EMPTY`, the ledger's own refusal |
| export running | the panel shows `preparing` with the count so far |
| the store unavailable | the workflow retries; the row stays `PREPARING`; nothing is appended to the ledger until the file exists |
| the fifth export of a day | 429 with the reset time |

## 6. Not built: the parts of Account-Admin that need organisations

Seats, the role filter, `Invite member`, the single sign-on state, `Change cap`, the residency control with its disabled EU option, and the organisation header. They arrive with organisational accounts, which are their own decision and unit (the same input pilot onboarding waits for). Also not here, because they are the IDE's: IDE minutes and Sandbox policy.

## 7. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | An individual exports their own account's records | yes | the audit pack exists so a party can check what was decided about their own contributions; refusing it to individuals would make it useless until organisations exist |
| D2 | The roster shown to every signed-in reader | yes; since 2026-10-12, to curators and organisation admins (feature-specs/47 D1, D3) | the screen says "visible to all accounts · read-only"; the page now says "curators and organisation admins · read-only" |

## 8. Verification (in addition to `ai-workflow-rules.md` § 7)

1. A contributor whose suggestion was graded and adjudicated sees two new rows in the meter, and their sum with the others equals the month's total; no row of kind `RESEARCH` is ever on a reader's meter.
2. An export per chapter and one per account: each file verifies with `verifyExport`; the trailer's head hash matches; a per-chapter file includes the predecessors that belong to other chapters; each export appended one `EXPORT` record and the chain verifies (the gate's criterion).
3. The signed URL serves the file and stops serving it after its life; another account's id is refused by the policy.
4. The fifth export in a day is 429.
5. The roster panel equals the roster rows; the median is computed from decisions in a fixture.
6. The account page with the three panels: zero axe violations in EN and PT; in the truncation suite.

## 9. As built (units 55a and 55c: the meter's two rows and the curator roster, 2026-10-10)

**The budget meter by consumer (55a; § 2).** The `GRADING` kind of `BudgetLedger` serves two callers — the assistant's grader, part of every answer (21 D2), and Improve's grader of a suggestion's evidence (33 § 3.2) — and the rows tell them apart by `ref`: Improve's grader and the adjudicator write the suggestion they served, the assistant's calls write nothing (the message row does not exist yet when the call is made). So:
- `monthBreakdown` (`lib/db/budget.ts`) reads the month's kinds twice, with `ref` null and with `ref` set, counts the assistant's answers among the rows with none, and counts the distinct `(kind, ref)` pairs of `GRADING` and `ADJUDICATION` as the suggestions served. `BudgetFacts.kinds` rows carry `suggestion: boolean`; the facts carry `suggestions: { grading, adjudication }`.
- `budgetView` (`lib/budget/view.ts`) maps a row to its consumer with `consumerOf(kind, suggestion)`, exhaustive over the enum, so the rows always sum to the total the gateway counted; the breakdown's consumers are `assistant`, `grading`, `adjudication`, `retrieval`, `labs`, in that order.
- `BudgetInstrument` prints the two rows in the screen's form (`consumer · tokens · of cap`), each with the suggestions it served beside it as the assistant has its answers (`Grading · 3 suggestions`); at zero they read faint, as the labs do, for a reader who never contributed. No `RESEARCH` kind exists in the ledger's enum: research is the platform's (A6), never on a reader's meter.
- Verified: `lib/budget/view.test.ts` (a contributor's month: 120,000 and 80,000 tokens in the two rows, the sum unchanged, the answers unmoved); `tests/integration/gateway.test.ts` (Improve's rows apart from the assistant's grader by `ref`; two suggestions graded, one adjudicated); the account page live in EN and PT, axe clean.

**The curator roster (55c; § 4).** `lib/db/roster.ts` reads the current release's chapters by part, the roster in force (`curatorsOfParts`, every part), the queue's count by part and the quarter's decision waits, each through its own door; `rosterPanelOf` (`lib/improve/roster.ts`, pure) makes the rows: one per part that has chapters in the release — the four of the book; `P4`, with none, is not a row whatever the roster table holds for it — with the chapter span (`01–15`), the curators by display name in roster order (a deleted or deleting account's name left out), the queue's count and the median of the quarter's waits, in milliseconds, null where the part had no decision.
- Two functions join the door (`lib/db/improve.ts`): `queueCountByPart` (what waits in `CURATOR_QUEUE` with the part among its parts, a shared item counted in each; a count of the queue by part, never by person, invariant 26) and `decisionWaitsSince` (the curators' own `ACCEPT`, `KEEP_REQUEST_MORE` and `DECLINE` since an instant, with the parts of the suggestion each decided, in two statements; no seed's, and none with no wait, which is the verdict that a sampled change stands, 36 § 7.2, given on a merged suggestion and not in the queue). Neither takes a caller: the roster panel is every account's (D2), as `curatorsOfParts` already is.
- The quarter is 91 days before now (`QUARTER_DAYS`); the panel's stamp says `since 11 Jul 2026`. The median prints in days with one decimal (`1.4 d`), the screen's unit.
- `RosterInstrument` on `/[lang]/account` (`#roster`), under the grid of instruments: `part · chapters · curators · queue · median decision time`, the roman numerals in capitals as this table of the screen has them, the footer's rule and a link to the rubric; the Rubric page's head links back (`the curator roster`). A part with fewer than two curators is shown as it is (spec 39 judges that).
- Verified: `lib/improve/roster.test.ts` (the screen's four parts from a fixture: spans, names once each and never a deleted account's, the queue by part, the median — a two-part suggestion's decision in both parts' medians — and null without a decision); the account page live in EN and PT with the roster's six development curators, axe clean; the rubric's link. The PT truncation suite measures the account page.

Decided here, for Andre to see:
- **A part without chapters is not a row**: the roster table holds `P4` rows (the development sign-in puts a curator on every part), but the panel shows the book's four parts, as the screen does.
- **The median leaves out the verdict that a sampled change stands**, which is written with no wait: a decision in the queue took time from queue entry to decision; a verdict on a merged change did not.

## 10. As built (unit 55b, part 1: the audit export's workflow and endpoints, 2026-10-10)

- **The request** (`lib/schemas/audit.ts`): a scope — `account` by the id the session holds (a person's own, or the organisation's for its admin, D1) or `chapter` by two digits — a window and the four record kinds of the screen's checkboxes, each a selection of the ledger's kinds: `adjudications` the `DECIDED` records, `overrides` the curators' `CURATOR` records, `merges` the `MERGED` records (a revert's among them), `answers` the assistant's `ANSWER` records. Since unit 71 (feature-specs/48 § 15) `answers` selects `["ANSWER", "RESEARCH", "ERASED"]` under the label `assistant and research records, and deletions`: the assistant's answers, a person's research runs, which they sign, and the deletion of either; an account's pack selects by actor, so a legacy run's record, `service:researcher`'s, is never in it.
- **The account scope** (`lib/ledger/export.ts`, `lib/db/ledger.ts`): the records the account's pseudonyms wrote — a curator's, a reader's answers, its exports — **and the records about its own suggestions**, whoever wrote them (the adjudicator's `decided`, the `merged`), since D1's reason is to check what was decided about one's own contributions; for an organisation, its members' and their suggestions'. `LEDGER_SCOPE_NOT_YET` is gone. A scope narrowed to kinds says so in the trailer (`scope.kinds`), so the file states its own filter; the `EXPORT` payload may name the `AuditExport` row (`exportId`), by which a retried step finds the record it wrote.
- **The row** (`AuditExport`, the door's since it is a table of the improvement block): the request in `scope`, `PREPARING` with the estimate as its count, then `READY` with the span, the head hash, the key and `readyAt` (migration `20261010150000_audit_export_prepare`: the span and the head nullable while preparing, `readyAt`, an index by requester and day).
- **`ExportWorkflow`** (`export:<id>`, queue `hb-improve`): `writeAuditPack` selects the records with their predecessors, writes the signed JSONL to `audit/<id>.jsonl`, reads the object back and verifies it with the public half of the export key — so `READY` means a pack that verifies, and the panel's `chain verified` is the row's state; `recordAuditPack` appends the `EXPORT` record under the requester's pseudonym once and makes the row `READY`. The store or the key unavailable is a failure the engine retries without end, with a growing wait, the row `PREPARING` meanwhile and nothing appended until the file exists (§ 5). A row gone or a scope that selects nothing is not retried.
- **The endpoints** (`lib/api/endpoints/audit.ts`): `POST /api/v1/org/audit-exports` with `Idempotency-Key`, the policy's `export` on `audit-export` (policies/hb/audit.rego: any signed-in person for their own account or for a chapter, an `ORG_ADMIN` for the organisation; the resource names the owner, the organisation or the chapter, and nothing a rule allows for another account), four a day by the UTC day (the fifth 429 with the day's end), a scope that selects nothing refused before any row is made (`NOTHING_TO_EXPORT`), the row and its workflow started, `{ id, state }`; `GET /api/v1/org/audit-exports/{id}` for the requester, with a signed URL that serves the file for 24 hours from the read (TRD § 7.7) once ready; `GET /api/v1/org/audit-exports/estimate`, the form's count (a count query, never a guess).
- Verified: `lib/ledger/export.test.ts` (an account's view, narrowed to kinds, the trailer naming them, the file verifying), `lib/api/endpoints/audit.test.ts` (the resource for each scope, the row made and started, nothing and the fifth refused, the read with its URL and without, the estimate), `workers/activities/export.test.ts` (written, read back and verified; a store that gives back something else or a pack that does not verify fails; the record once; `READY` answered from the row), the policy's six tests (72 in all), the full suite, lint and build. **Part 2** is the form on the account page and the live check.

Decided here, for Andre to see:
- **The account scope includes the records about the account's suggestions**, not only those its pseudonym wrote: the adjudicator's and the merge's records are what a party checks when it checks what was decided about its contributions (D1).
- **The count while preparing is the estimate**: the file is written in one pass, and the row says the estimate until the file's count replaces it.

## 11. As built (unit 55b, part 2: the form, and its live check, 2026-10-10)

- **The form** (`AuditExportPanel`, a client island on `/[lang]/account`, `#audit`): the screen's `scope` as a segmented control (`Per account`, the reader's own id; `Per chapter`, with the release's chapters in a select), `from` and `to` as date inputs over the last thirty days, the four `records` checkboxes, and the estimate, asked of `GET …/estimate` as the form settles (400 ms) and said in words — the count, "counting…", or that the window and a kind are wanted. `Export audit pack` is disabled at zero; pressed, it `POST`s with a fresh idempotency key, then reads the pack every two seconds until it is `READY` (ten minutes at most), the status line saying `preparing · N records` meanwhile. The last export's line has the date and count, the head hash's first twelve characters with `chain verified`, and the download link, which is the signed URL with its life; a pack still preparing when the page is drawn is followed the same way. A refusal is said beside the button: the day's four spent and when the next may be asked (`RATE_LIMITED`'s `resetsAt`), nothing in range, or a request that did not reach the server.
- **The account page** reads the reader's latest pack (`latestAuditExportView`) and the release's chapters for the select; the panel sits with the instruments, under Retention. On a phone the roster's five columns scroll within their instrument, as the queue's table does (the truncation suite found the overflow).
- **The live check, on the development server**: the check contributor's account, adjudications and overrides over thirty days — six records, counted by the estimate. `Export audit pack`: the row `PREPARING` with 6, the workflow's two steps, `READY` within seconds; the row's head hash `3f58898a…`, the one `EXPORT` record under the pseudonym naming the export, the kinds `DECIDED, CURATOR` and the file's hash; the download link the app's signed storage route, which served the file; the file verified with the public key alone (`verifyExport`: six lines, the signature valid, the trailer matched, the scope the account's narrowed to the two kinds). The page drawn again showed the last export with its hash and `chain verified`. `Per chapter` on a chapter with no merged change counted no records and left the button disabled. In PT, the panel with its kinds and `cadeia verificada`. axe found nothing in either language. Three packs were asked of the day's four.
- **Not exercised live**: the fifth pack of a day (the endpoint's test holds it); an organisation's pack (no organisational accounts exist).
- Verified: the panel's parity in EN and PT, the PT truncation suite with the account page, the full suite, lint and build, and the live check above.

## 12. Review of unit 55 (2026-10-10)

One review of the whole unit, three lenses (the numbers and the export's correctness, authorisation and exposure, the page's islands and the house rules), each finding checked by one skeptic. Eleven findings were raised, nine confirmed (two of them the same), two refuted; all are fixed in one commit.

- **A pack whose workflow the engine did not take stayed `PREPARING` for ever** (medium). The row was made before the start, and a start that failed left it: counted among the day's four, drawn as the last export, followed by the panel for ten minutes. **Fix**: the row goes when the start fails (`removeAuditExport`, while `PREPARING`), and the refusal says no pack was asked for; the endpoint's suite has the case.
- **Four a day was a count then an insert** (low). Two requests at once both passed. **Fix**: the count and the row are one transaction under the requester's advisory lock (`pg_advisory_xact_lock(hashtext(id))`, in `lib/db/RAW_SQL.md`), the door answering `{ created: false, spent }` for the fifth.
- **An account's pack missed the revert of its own merged change** (low), whose records are the revert's. **Fix**: the reverts of the account's merges are in its scope (`revertIdsOf`). Decided here: an undoing is part of what was decided about one's contributions.
- **The idempotency key was fresh on every press** (medium, found twice): a retry after a lost answer asked for a second pack. **Fix**: the body and its key are kept while no answer came, so the retry replays the first pack; the network sentence says so.
- **The island never refreshed the router** (medium): Back restored the page without the pack. **Fix**: `router.refresh()` when the pack is started and when it is ready.
- **The follow stopped silently after ten minutes** (low), the button disabled for good. **Fix**: after ten minutes the pack is read every thirty seconds instead, for a store the workflow waits out.
- **A stale read could land after a new pack was started** (low). **Fix**: the poll's fetch is aborted by the cleanup, a read that was stopped writes nothing, and a ready pack clears only a `following` status.
- **On a coarse pointer the scope control's 44 px buttons overflowed their 40 px frame** (low). **Fix**: `min-height` on both, so the frame grows with its buttons; checked on a phone with touch.

Refuted: curators deduplicated by display name (two curators of a part sharing a name would show as one — the roster's names are the public role's, and a shared name is the operator's to tell apart); the read rule naming the caller as `ownerId` (the door's `readOwnAuditExport` is what refuses a foreign pack, and the rule is the belt).

Also found by the phone's axe during the check: the roster's scrolling table was not keyboard-focusable; it sits in a focusable region now (`.roster-scroll`).

Verified: `lib/api/endpoints/audit.test.ts` (nine cases), the door's test, the policy's tests, the full suite, lint and build; live: the day's fourth pack through the transaction, the fifth refused in words with the next time and no row, the pack kept after Back, the control's frame on a coarse pointer (46 px with 44 px buttons), axe clean on the phone.
