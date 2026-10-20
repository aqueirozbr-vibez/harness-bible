# 46 · Deleting an account and withdrawing consent — feature spec (an account is erased 30 days after its deletion was asked for: its own rows go, the rows that name it keep their record without it, what others still owe it is finished first, and the audit chain records the request and the erasure under its pseudonym; a contributor withdraws their consent to provenance and is shown by that pseudonym)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

**Written 2026-10-11, revised after the review of its design (§ 12); Andre answered its six open decisions on 2026-10-12, each on the recommendation (§ 13).** D4's support address is a setting he gives before any real request. The other four decisions are taken on a recommendation and say so. **It is built after spec 48** (Andre, 2026-10-12), unit 66 first, then unit 65.

Citations: `path:line` is the code at `acc11c3`. `08:129` is line 129 of `context/feature-specs/08-user-auth.md`, and every spec number works the same way. `architecture:297`, `code-standards:108`, `project-overview:258`, `ai-workflow-rules:15` and `tracker:146` are lines of the context files. Migration names are shortened from `prisma/migrations/<stamp>_<name>/migration.sql`.

Source of truth: Andre's D8 of 2026-10-11 (spec 45 § 2), and the lines it builds on:

| What | As recorded |
|---|---|
| This spec | 45 D8: "The account's hard delete and the withdrawal of provenance consent · **The next spec after this one** (Andre, 2026-10-11): spec 46, written after unit 62. It reuses this spec's door, and `ERASED` with an account scope." (45:39). The order: after unit 64 comes spec 46, "written after unit 62" (45:459; tracker:442). |
| The retention rows | TRD § 4.4 (pp. 23-24): "Account deletion on request · 30 days after request · Soft delete, then hard delete of `User`, notes, bookmarks, conversations; ledger keeps the pseudonym"; "Contributor identity · With consent, life of account · `provenanceConsentAt`; withdrawal blocks new suggestions and pseudonymises the user in exports". Architecture § 4.4 repeats both, adds the key's revocation, and says "each request is a ledger record" (architecture:294, :297). PRD p. 11: "contributor identity retained for provenance with consent; … deletion on request". |
| The job | code-standards:108: the "30-day account hard delete" is a script on a schedule until Temporal's schedules exist, "and each run writes its ledger record itself (decided 2026-09-23)". |
| Rows that name a person | code-standards:109: a nullable column with `ON DELETE SET NULL`, or the person's own row that cascades, "so that an account's hard delete is never refused". 29:288: "an account's hard delete has to go through (LGPD), and neither a refusal nor the loss of the curator's action is acceptable". |
| What is not erased | 45 D5: an ended suggestion's words, **Not now** (45:36). |
| A name on a proposal | "Until withdrawn or the account is deleted … withdrawal before the merge removes the credit, after it the history shows the pseudonym" (architecture:296). A name is taken back until the merge: "consent that cannot be taken back before publication is not consent" (42 D4, 42:107). |
| Precedence | Architecture § 11 invariants, then the TRD, the PRD, the UI package, and the four context files; a disagreement is reported, not resolved silently (ai-workflow-rules:15). |

No screen of the UI package shows an erasure or a withdrawal of consent. `Account-Admin`'s Retention instrument has the note and `Request deletion`, nothing more (`docs/design/screens/Account-Admin.html:109-121`). Everything here is composed from what the product has: the shared `ConfirmDialog` the deletion already opens, a quiet `btn btn-sm` in a form, `Notice`, `ErrorBox`, a `.help` line.

Before this spec was written, four readers mapped the code: the account and its request; every row that names the person; provenance and consent; the ledger and its records. Then three reviewers checked the draft against the code, one lens each: the data, the invariants, the product. They raised 30 findings, one high, twelve medium and seventeen low. Every one is answered, where the spec cites it and in § 12. Every claim about the code cites the line it rests on.

Prerequisite specs: `08` (§ 5.5 and § 6.3, the request), `09` (D3, Keycloak), `11` (§ 3.4, gateway keys), `15` (§ 3, the five assistant tables), `29` (§ 3, the improvement tables' keys), `33` (the suggestion's waits), `35` and `37` (who is named; the merge), `38` (§ 3, the audit pack's account scope), `40` (the research run), `42` (§ 6, names on proposals), `45` (the door, `ERASED`, detached runs, the withdrawal).

Scope: tracker units 65 (deleting an account) and 66 (withdrawing consent). Not here: § 10.

Two citations elsewhere point nowhere, and this spec uses the right ones:

- **Spec 08 has no § 5.8.** Its § 5 runs from § 5.1 to § 5.7 (08:134-215), yet 15:131, 21:9, 21:49 and 21:243 cite it. The request is 08 § 5.5 (08:194).
- **"Architecture § 7"** (08:5, 08:194) is now Observability (architecture:467). The deletion row is architecture § 4.4 (architecture:297).

## 1. Purpose

A reader can ask for their account to be deleted, and nothing deletes it.

- **The request** marks the account and closes its sessions (`lib/db/account.ts:134-139`). The action writes one `AuthEvent`, which is swept after 90 days (`app/[lang]/account/actions.ts:142-155`; `lib/db/audit.ts:26`, `:45-48`).
- **Nothing follows it.** No code writes `User.deletedAt`, no job reads `deletionRequestedAt`, and no row of the account is ever removed. The only jobs are `assistant:purge` and `auth:sweep` (`package.json:44-45`).
- **Three things on screen are untrue:**
  - "Each request is a record in the audit chain." (en.json:277; 45:315);
  - "the account and its marks are deleted after 30 days" (en.json:287);
  - "write to support to cancel" (en.json:54, :59): no string, page or setting names an address.
- **A contributor cannot withdraw their consent to provenance.** Its one writer sets it where it is null (`lib/api/endpoints/suggestions.ts:99-101`), and nothing clears it.

This spec erases an account 30 days after its request (D3):

- every row that is the person's own goes;
- every row that names the person keeps its record without them;
- what a workflow still owes the account (a curator's record, a research run's conclusion, a suggestion's decision) is finished before the row goes;
- the account's gateway key is revoked;
- the audit chain records the request and the erasure under the account's pseudonym.

It reuses spec 45's door for each conversation and its withdrawal for a suggestion. It also lets a contributor withdraw their consent, after which every page names them by the chain's pseudonym.

Two things are kept on purpose, as in spec 45. The ledger only gains records (invariant 16). And what the person submitted to the book stays in its record (45 D5).

## 2. Decisions

| # | Decision | Answer |
|---|---|---|
| D1 | What the erasure does with the `User` row | **Recommended: the row is removed.** The TRD says "hard delete of `User`" (TRD § 4.4, p. 24; architecture:297), and the TRD stands over the context files (ai-workflow-rules:15): over 08:129 ("`deletedAt` stays the hard-delete marker") and over architecture:270 ("delete sets `deletedAt`", from the TRD's p. 22, which describes the soft delete). Only a removal fires the keys the schema was built with (code-standards:109; 29:288): `SET NULL` on the suggestion, the curator's action, the merge and the audit export (`improvement`:334, :361, :379, :382), and `CASCADE` on the roster (`improvement`:373), the seeds (`curation_seed`:32), the research runs (`research_rows`:94) and the endorsements (`research_proposals`:20). `tests/integration/improve-schema.test.ts:236-255` holds the four `SET NULL`s and the roster's cascade; the other three cascades have no test, and 65g's suite adds them (§ 8). `deletedAt` keeps a use: it marks an erasure under way (§ 3.3). A person who signs in again later becomes a new account, with a new id and a new pseudonym (`lib/auth/rules.ts:101-102`; `lib/auth/link.ts:53-59`); while the Keycloak user stands, that account takes its subject, role and verification (D5). The alternative, a row kept with its columns blanked, fires no key and needs a placeholder for the unique `email` (`prisma/schema.prisma:115`); `keycloakSub` is nullable (`:127`). |
| D2 | The account's records in the chain | **Recommended: `ERASED` with an account scope, one record per step.** The steps are `requested` at the request, `cancelled` if the request is taken back (D4), and `erased` once the row is gone (§ 3.6). 45 D8 names the kind; "each request is a ledger record" (architecture:297) gives the first step, and "each run writes its ledger record itself" (code-standards:108) the last. Each record is signed with the account's pseudonym: each step is the person's request or its outcome, as the intake activity signs a contributor's `SUBMITTED` record and the withdrawal's activity their `RETRACTED` one (`workers/activities/suggestion.ts:220-224`, `:659`). The kind's rule therefore stays `actors: ["user"]` (`lib/schemas/ledger.ts:520`). Under D4 (B) an operator's command writes the `cancelled` record on the person's written request, and it is signed with the pseudonym all the same: a rule is one per kind (`lib/schemas/ledger.ts:510-521`, `:535-544`), so a service allowed to sign that step would be allowed to sign every `ERASED` record, a conversation's included. The operator's hand is in the cancel's `AuthEvent` (§ 3.6). No new kind and no migration: `ERASED` has been in the enum since 62b. The account's conversations get no record each; the account's `erased` record covers them. |
| D3 | When the erasure runs | **Andre, 2026-10-12: (A), day 30 or 31.** The nightly `npm run account:erase`, a script beside the other two (`infra/schedules/crontab:4-5`) until Temporal's schedules exist (code-standards:108). Whether the nightly jobs are scheduled on this machine is the question unit 45e already waits on (tracker:146): the erasure follows Andre's answer to it, and runs by hand until then. What is open here is the day. The TRD says "30 days after request" (architecture:297). The overview, whose success criteria are its own to set (ai-workflow-rules:9), says "a deletion request is fulfilled within 30 days" (project-overview:258). A nightly run meets one or the other. **(A) Day 30 or 31:** the first run once the request is 30 days old; the overview's line reads "30 days after the request" from 65a. **(B) Day 29 or 30:** the first run once it is 29 days old; the overview stands, the strings say "within 30 days", and the time to cancel (D4) is a day shorter than the TRD's 30 days. **Recommended: (A).** The TRD stands over the overview (ai-workflow-rules:15), and the request's notice already says "after 30 days" (en.json:59). |
| D4 | How a request is taken back in its 30 days | **Andre, 2026-10-12: (B), an operator on the person's written request; the address is set later** — `SUPPORT_EMAIL`, required in production, a placeholder in development, given by Andre before any real request (§ 13). The strings say "write to support to cancel" (en.json:54, :59), but no string, page or setting holds an address: nothing in `lib/`, `app/`, `components/` or `messages/` names `support@`, `mailto:` or a `SUPPORT` setting. After the request the person sees only the notice and the refusal (`app/[lang]/account/actions.ts:153-154`; `lib/api/endpoints/auth.ts:107-109`). No command and no code clears `deletionRequestedAt`. In every option a cancel is refused once the erasure has begun (§ 3.3, step 1), and the refusal then says so (`auth.error.erasing`, § 6). **(A) The person, by signing in:** in the 30 days a sign-in is not refused but offered `Keep my account`, which clears the request and appends `cancelled` (with its `requested` first where that is missing). The callback refuses before any session exists (`lib/api/endpoints/auth.ts:97-110`), so a short-lived proof of the sign-in, which only the callback can make, has to pass to the offer's action: a new door in the sign-in, argued in its unit (code-standards:85). The callback ends the broker session as a refusal does (§ 3.2), and a person who keeps the account signs in again. New strings: the offer and its outcome. **(B) An operator, on the person's written request:** one configured address, `SUPPORT_EMAIL` in `lib/env.ts`, required in production as a provider's settings are (08:211), shown as `{address}` in the dialog's body, the notice and the refusal. The operator answers the request at the account's own e-mail address, which the identity provider vouched for (08 § 5.3, step 1), and runs `npm run account:keep -- --email <e-mail>` only on a reply from it. The command names an account as `npm run roster:set` does (`scripts/roster-set.ts:29`). The `cancelled` record is signed with the pseudonym though an operator runs it (D2): the product never authenticates the written request, and the operator's check is all there is. **(C) None:** the request is final from the confirm, the strings say so, and the 30 days are only the TRD's wait. **Recommended: (B).** It keeps the promise on screen, adds no door to the sign-in, and suits a pilot of invited accounts; it needs the address from Andre. (A) is its self-service form, if requests become common. |
| D5 | The Keycloak user | **Andre, 2026-10-12: (A), an operator deletes it by hand after the erasure.** The application cannot reach it: `hb-web` has no service account (`infra/keycloak/realm-harness-bible.json:617`; 09:449), and the admin API is on a private hostname (09:91). The Keycloak user keeps the e-mail, the name, the links to Google and GitHub (`realm-harness-bible.json:652-690`), and 90 days of user and admin events (`:22-23`, `:58`). It also keeps the role and the verification an operator set on it (09:84, :107; `infra/keycloak/README.md:7`), so a sign-in through it after the erasure makes a new account with the old subject, role and verification (`lib/auth/link.ts:53-59`). **(A) An operator deletes it by hand, after the erasure:** the job's line names the Keycloak subject of each account it erased, and `infra/keycloak/README.md` says how. No credential is added. Until the operator acts, Keycloak keeps the e-mail and the links, and a returning sign-in gets the old role and verification. **(B) The job deletes it:** through a confidential client of its own, whose service account holds `manage-users` only and whose secret sits in the workers' environment. The user is deleted by subject before the row goes; a refusal holds the account until the next night. **(C) Left in place:** Keycloak keeps the e-mail and the links for good, and a sign-in makes a new account with the old role and verification. In each, the dialog's body says what becomes of the sign-in service's copy (§ 6). **Recommended: (A)** for the pilot. A credential that can delete every user in the realm is a larger risk than a handful of deletions by hand. (B) fits when organisational accounts bring the admin API (09:84, :449). |
| D6 | What withdrawing consent blocks | **Andre, 2026-10-12: (A), consent is asked again.** The TRD says "withdrawal blocks new suggestions" (TRD § 4.4, p. 24; architecture:294). Consent is one column per account, written by a submission and by a name on a proposal (42:76; 43:123). Today it is given only in a draft's submit box (`components/improve/SubmitPanel.tsx:130-135`; `lib/db/suggestEdit.ts:201`) and with a name on one's own proposal (`components/assistant/ProposalPanel.tsx:231-237`; `lib/api/endpoints/proposals.ts:133`, `:140`). A reader, or a contributor with nothing new to submit, could not undo a withdrawal. In both options the account page's row therefore offers `Give consent` while none stands, and the withdrawal asks first (§ 4.4). **(A) Asked again:** the column is cleared. The submit box and the proposal's consent ask again, as they ask anyone who never gave it, and so does the row. Consent given again, anywhere, is the account's and names the person beside every change. No migration. **(B) A state of its own:** a migration adds `provenanceWithdrawnAt`, its own first part. The withdrawal clears `provenanceConsentAt` and sets the new column, so the names, invariant 25 and the service's move out of draft read as they do today (`lib/db/account.ts:50`; `lib/db/improve.ts:1131`; architecture:576). While it is set, a submission and a name on a proposal are refused with `422 CONSENT_WITHDRAWN` in place of the consent they would ask for (`lib/api/endpoints/suggestions.ts:444-445`; `proposals.ts:133`), and only the row's `Give consent` clears it. **Recommended: (A).** No suggestion leaves draft without consent given again (invariant 25, held since 66b in the person's own move too, § 4.3), which is what "blocks" asks. (B) adds a column, a refusal and an error code for the same rule. |
| D7 | The person's suggestions past draft, at the erasure | **Andre, 2026-10-12: (A), closed where they wait for the person alone.** Whatever the answer (§ 3.8): a draft is deleted with its files; a suggestion waiting for the person's revision first loses what it gained since its last submission, as a draft loses its content; one still `SUBMITTED` whose workflow runs holds the account until it is decided; and what was submitted keeps its words and files (45 D5). Spec 29 nulls `Suggestion.userId` so that "the suggestion keeps its record without the person" (29:133; architecture:234), and a merge credits the pseudonym its `SUBMITTED` record holds (`workers/activities/merge.ts:555-558`, `:574`). What is open is whether a suggestion that waits for a person is closed. **(A) Closed where it waits for the person alone:** declined at intake, or asked for more in `DECIDED`, it is withdrawn through 45 § 5's door and signal, and its `RETRACTED` record is signed with the pseudonym. Nobody else could move it: no revision can come (`workers/activities/suggestion.ts:222-223`). One in a curator's queue goes on, and may be accepted and merged. **(B) Closed wherever it waits for a person:** as (A), and one in a curator's queue too (45 § 5.1). **(C) None closed:** each stays where it is; one waiting for a revision waits for good, its run replaying at every restart (`workers/workflows/suggestion.ts:316`; code-standards:116), as an abandoned suggestion's run does today. In each, a suggestion the erasure leaves open that later comes back to wait for a revision (a curator's request for more, or a failed check's return, `workers/activities/merge.ts:417-429`) waits for good. The dialog's body says which applies (§ 6). **Recommended: (A).** It closes what only the person could have moved and leaves a curator's work to the curator; a person who wants a queued suggestion out withdraws it before asking (45 § 5). |
| D8 | The person's research, names on proposals, short-lived rows and audit packs | **Recommended: the research is concluded, the names come off proposals before the merge, the short-lived rows go at once, and the packs of the account's own scope lose their files.** At the erasure: each research run whose workflow still runs is cancelled, and concludes with its record before its row goes (§ 3.8). A name standing on a proposal whose merge is not taken is withdrawn, as Remove my name withdraws it ("until withdrawn or the account is deleted", architecture:296). Every finding of the account goes by `userId` (45:142). The stored first answers (`IdempotencyKey`) and the rate buckets keyed by the raw id go with the account, without waiting for their sweeps. A pack whose scope is the account itself loses its file (step 7): after the erasure nobody can read it (`lib/db/improve.ts:1969-1972`), and its `EXPORT` record keeps what it was. This departs from architecture:243's "Retained" for that file alone; the row stays. A chapter's pack holds public records and an organisation's is the organisation's (`policies/hb/audit.rego:21-38`), so their files stay. `AuthEvent` rows keep their `SET NULL` and their 90 days (`security`:18; `lib/db/audit.ts:26`). |
| D9 | Organisations | **Recommended: no organisation case is built.** No code assigns a person to an organisation (`lib/auth/link.ts:53-75`), and no endpoint asks for `manage` (`lib/policy/input.ts:12`). A member's erasure frees their seat (`SET NULL`, `accounts`:130) and leaves the organisation's key and spend as they are (`lib/db/budget.ts:15-17`). It is never refused, the last administrator's included (code-standards:109; roles are Keycloak's, 09:84). An administrator deleting a member waits for organisational accounts (38:47). |
| D10 | Names standing on proposals after a withdrawal of consent | **Andre, 2026-10-12: (B), the withdrawal takes them off.** From 66a every page that names a person for provenance asks for consent, the record page and the queue included (§ 4.2), whatever the answer. What is open is a name standing on a proposal not yet being merged. The chain records that consent: each `ENDORSED` record carries its instant (`lib/schemas/ledger.ts:443-446`; `workers/activities/suggestion.ts:639-641`), and the latest one not withdrawn is the name standing (`lib/improve/endorsement.ts:19-25`). A merge writes it into the `MERGED` record as `endorsedBy` (`workers/activities/merge.ts:576`), and the history credits it (`lib/improve/history.ts:142`, `:151`, `:199-208`). **(A) The names stay:** a later merge credits the pseudonym, a credit made after the consent was withdrawn. Remove my name stays the way to take a name back (42 D4). The withdrawal itself is an `AuthEvent` kept 90 days (`lib/db/audit.ts:26`, `:45-48`), and the chain goes on showing each standing name's consent. The withdrawal needs no engine. **(B) The withdrawal takes them off:** before it clears consent, it withdraws each name standing on a proposal whose merge is not taken, as step 3 of the erasure does (§ 3.3), each with an `ENDORSED` record of the withdrawal. No credit follows a withdrawn consent, and the chain says when that consent was taken back. The withdrawal needs the engine where a name stands, and giving consent again does not put the names back. **Recommended: (B).** "Consent that cannot be taken back before publication is not consent" (42 D4), and the erasure takes names off the same way (D8). |

## 3. Deleting an account (unit 65)

### 3.1 What the reader gets

At the request (§ 3.2), as today and more:

- Every session of the account closes in the application, and this browser's broker session at Keycloak. A broker session in another browser ends when a sign-in through it is refused (§ 3.2).
- No new research of the person's questions starts (§ 3.2).
- The chain records the request (D2).
- From then on the account cannot sign in by Keycloak, by the development provider or by bearer (`lib/auth/link.ts:40-47`, `:144`; `lib/auth/session.ts:81`; `lib/auth/bearer.ts:25`).
- It appears by pseudonym on every page (`lib/db/account.ts:50`). Since 66a this includes the curator's queue, whose lines today read "not endorsed" or "contributor" for a person whose deletion is pending (§ 4.2).

On the night D3 names (§ 3.3):

- **Deleted:**
  - the `User` row;
  - its `Session`, `Identity`, `Bookmark`, `Note` (the reader's own text, `prisma/schema.prisma:260`) and `ReadingPathProgress` rows;
  - every conversation, through spec 45's door, with its messages, citations, verdicts, flags and stored answers;
  - its research runs, each concluded first, and every finding of the account, attached or detached;
  - its names on proposals not yet being merged, its roster rows and its seeds;
  - its drafts with their files, and what a suggestion waiting for its revision gained since its last submission;
  - the files of the audit packs of its own account;
  - its `IdempotencyKey` rows and its rate buckets;
  - its gateway key, revoked at the gateway first.
- **Closed:** its suggestions that wait for a person, as D7 says.
- **Nulled** (the person leaves the row; § 3.5): `Suggestion.userId`, `CuratorAction.curatorId`, `Merge.mergedById`, `AuditExport.requestedById`, `Seat.userId`, `AuthEvent.userId`.
- **Recorded:** the `erased` record.

What stays, and why:

- **Every ledger record**, its actor `user:<id>` (invariant 16; `lib/schemas/ledger.ts:215-216`). A record's hash covers its actor and its payload, and the next record's link covers that hash (architecture:279-281). So a pseudonym in the chain cannot be changed.
- **`BudgetLedger` rows**, with an individual's id, the trace and the suggestion (`prisma/schema.prisma:589-614`). They are never deleted (architecture:239; `lib/db/client.ts:142-144`).
- **The person's submitted suggestions**, as their last submission left them, with their words and the files they uploaded (45 D5).
- **The curators' actions, merges and audit-export rows**, without the person. Each action keeps its note (29:288). A pack of the person's own account keeps the account's id in its scope (`lib/schemas/audit.ts:36-43`, `:76-82`; `lib/db/improve.ts:1939`, `:1945`): the same id its `EXPORT` record holds in the chain (`lib/schemas/ledger.ts:132-148`).
- **`AuthEvent` rows**, without the person, until their 90 days (D8).
- **The platform's research marks**, and the researcher's suggestions the person's questions led to. Neither names anybody (45:57; invariant 35).
- **Outside the database:**
  - a curator's pseudonym in the book's commit trailers (`workers/activities/merge.ts:328`; 37:128);
  - ids in log lines and spans (`lib/api/handler.ts:222`; `lib/gateway/span.ts:32`);
  - workflow histories: 72 hours after a run closes (architecture:236), and for as long as a suggestion's run waits, since its `endorsed` and `withdrawn` signals carry the id (`lib/schemas/workflows.ts:84`, `:92`);
  - LiteLLM's own rows of a revoked key, and Langfuse's `user_id`, without message bodies since unit 64 (`lib/gateway/client.ts:131`; 45 § 29);
  - backups;
  - exports the person already downloaded;
  - the Keycloak user, until D5's answer removes it.

### 3.2 The request

`requestDeletion` keeps its form, its typed word and its policy (`app/[lang]/account/actions.ts:142-146`; `policies/hb/user.rego:5-10`). What it does changes in four places.

1. **One transaction, naming the account.**
   - `requestDeletionFor(user, now)` marks the row and deletes the account's sessions in one transaction, under the authentication exemption, which covers both models (`lib/db/client.ts:89`).
   - Under the exemption the client injects nothing (`lib/db/client.ts:152`; `lib/db/tenant.ts:37-40`), so every statement names the account itself, as `recordConsent` does (`lib/api/endpoints/suggestions.ts:99-101`): the mark `where: { id: user.id, deletionRequestedAt: null, deletedAt: null }`, the delete `where: { userId: user.id }`. Today's delete is `deleteMany({ where: {} })`, held to one account only by its tenant context (`lib/db/account.ts:138`); moved under the exemption as it stands, it would delete every account's sessions.
   - It first reads the current session's `idpSessionId` and `idToken`, for item 4.
   - It answers whether it marked the row, and the request's instant as stored.
   - A sign-in can resolve its user before the mark and create its session after it, because `createSession` reads no marker (`lib/api/endpoints/auth.ts:98-99`; `lib/auth/session.ts:45-57`). The row it leaves is refused on every use (`session.ts:81`) and deleted by the erasure (§ 3.3, step 9). No lock is added for it.
2. **The `requested` record**, appended after the commit, by the request that marked the row only, keyed by the stored instant (§ 3.6).
   - The action looks for it by its key first, as the conversation's delete does (`lib/api/endpoints/assistant.ts:286-290`). A second request from another tab marks nothing and appends nothing.
   - An append that fails leaves the request standing without its record, and the line names the trace. A cancel appends it before its own (§ 3.6), and the erasure before it begins (§ 3.3, step 2).
   - The `deletion_requested` `AuthEvent` stays.
3. **Research is no longer started.** `researchSwitches` (`lib/db/research.ts:72-77`), which the research hand-over reads (`workers/research/afterTurn.ts:110-114`), answers the person's own switch as off while a request stands. Nothing under `lib/research/` or `workers/` reads `deletionRequestedAt` today, so a turn still running in another tab when they confirm would start a run, and its planner would send their question to the model provider after the request. It now ends with a skipped run (`OFF_USER`). A cancel turns research on again. Runs already started go on (§ 3.10).
   - **Amended by feature-specs/48 (unit 75, 2026-10-12):** the hand-over and `researchSwitches` are gone, since no turn starts a run. The research start endpoint's check 4 holds this rule (48 § 5.2, built in unit 71): while a request stands, a person's start is refused 403 `ACCOUNT_DELETION_REQUESTED` before anything is spent, and a cancel lifts it.
4. **The broker's session ends**, as sign-out ends it (`lib/api/endpoints/auth.ts:148-157`), with no change to the realm.
   - For a brokered session, the action redirects to Keycloak's end-session with the id token as the hint, `/{locale}` as the address to come back to, which the realm lists already (`realm-harness-bible.json:630`), and the logout's `state` parameter set to `deletion-requested`, which the end-session gives back with the redirect.
   - Book Home (`app/[lang]/(home)/page.tsx`), given that `state` and no session, redirects to the login page with its notice.
   - A new post-logout address would not do: the realm file reaches Keycloak only through the import at start (`infra/keycloak/start.mjs:39-41`, `:49`; `infra/keycloak/README.md:3`), which skips a realm that exists, so no deployment would have it.
   - Without Keycloak, or for the development provider, the action redirects to the notice as today.
   - Only this browser's broker session ends. Another device's lives on, 8 hours idle and 30 days at most (`realm-harness-bible.json:41-42`), until a sign-in through it; its application session is gone with the rest.

**A refused sign-in ends its broker session too.** Keycloak authenticates before the callback refuses (`lib/api/endpoints/auth.ts:97-110`), and the browser flow tries Keycloak's cookie before any provider (`realm-harness-bible.json:699-713`; a sign-in sends no `prompt=login`, `lib/auth/oidc.ts:103`). Left open, that session would sign anyone at that browser's "Continue with Google" into the account, to be refused again. So on a `deleted` refusal the callback redirects to the end-session with the id token it has just received and `state=deleted`, and Book Home turns that into `/{locale}/login?error=deleted` (65e). Once the erasure has begun the refusal is `erasing` instead (§ 6), since no cancel is taken then.

### 3.3 The erasure, in order

`npm run account:erase` (`scripts/account-erase.ts`) runs `eraseDueAccounts({ now, deps, account? })` from `lib/auth/erase.ts`.

- **Which accounts.** Under the authentication exemption, each read naming the accounts by their markers, it takes those whose request is as old as D3 says by the run's clock, and those whose erasure began on an earlier night (`deletedAt` set).
- **The steps.** For each account, the steps below run in this order, and each is idempotent.
- **A hold.** A step that fails holds the account for the night. So does a step that needs the engine or the gateway when either does not answer, and a wait for work a workflow still owes the account (§ 3.8). Nothing after it runs, the next night takes the account up again, and the job's line counts it and names what it waits for. The one exception is the removal of files in steps 6 and 7, which is best effort, as the draft's delete makes it (45 § 13).
- **`account` and `--now`.** `account` scopes a run to one account, for the suites and the gates, as the purge's `reader` does (`lib/db/research.ts:532`, `:537`). `--now` moves the clock for verification, and the script takes it only together with `--account`. Unscoped, a mistaken instant would erase, for good, every account whose request is younger than D3's age, cut short the cancel the notice promises, and break architecture:297's "30 days after request". The purge's own `--now` takes any instant (`scripts/assistant-purge.ts:38-44`), since all it can do early is purge text.
- **No policy.** The run is the platform's, as the purge is, and asks no policy: the person's request passed it (§ 3.2).
- **Acting for the account.** The run acts for the account through a session user built by hand: `sessionId` null, and `identityVerified` and `parts` the least they could be (code-standards:84). The gates build one the same way for the door (`workers/gate/goldenDeps.ts:21-23`).

**Before it begins**, the account is held while either of these stands, and a cancel is still taken meanwhile:

- an action the person took as a curator that a workflow has still to record (§ 3.8);
- a suggestion of theirs still `SUBMITTED` whose workflow runs (§ 3.8).

1. **Begin.** `deletedAt = now`, naming the account, where its request is as old as D3 says and `deletedAt` is null. From here on a cancel is refused (D4), so a request is never taken back half done.
2. **The request's record** is appended if it is missing (§ 3.6).
3. **Names on proposals.**
   - The proposals whose standing name is the account's are read from the chain: the account's `ENDORSED` records (`lib/db/ledger.ts:109-111`, with `accountView`, `:63-66`), and on each proposal the latest name standing (`lib/improve/endorsement.ts:19-30`).
   - Only proposals whose curator's merge is not taken are touched. That is the endpoint's own test (`lib/api/endpoints/proposals.ts:89-91`, `:97-101`).
   - The account's `ProposalEndorsement` rows on those proposals are deleted (`removeEndorsement`, `lib/db/research.ts:260-262`). Then each proposal's workflow is told `endorsed { userId, at, withdrawn: true }`, with `at` the standing name's `consentAt`, as `Remove my name` tells it (`proposals.ts:159-168`).
   - The activity records a withdrawal where no row of that instant stands and that name stands (`workers/activities/suggestion.ts:619-642`). This holds after the account's row is gone too, because the activity reads the endorsement by the id the signal names (`lib/db/research.ts:268-270`).
   - A workflow that has ended (`WorkflowNotFoundError`) has nothing to withdraw. An engine that does not answer holds the account.
   - The function is the one the consent's withdrawal uses under D10 (B) (§ 4.4).
4. **Conversations**, each through `deleteConversation` (`lib/db/assistant.ts:620-642`), unchanged. The door detaches the research runs that have a workflow and empties their text, forgets the stored finals, and deletes the rows children first. `TURN_IN_PROGRESS` cannot happen 30 days after the account's last session (`:594-603`); if it does, the account is held.
   - **Amended by feature-specs/48 (unit 75, 2026-10-12):** the account's research conversations too, each through `deleteResearchConversation` (48 § 17.2), before step 5: a run under way is detached without its text, the rest of the research's rows go, and one `ERASED` record of scope `research` is appended for each.
5. **Research.** Each of the account's runs whose workflow the engine says is running (`workflowRunning`, `lib/workflows/client.ts:267-282`) is cancelled (`cancelWorkflow`, `:256-265`), and concludes with its record (§ 3.8). The account is held until the engine says none of them runs.
   - **Amended by feature-specs/48 (unit 75, 2026-10-12):** the account's runs of either workflow, each asked and cancelled under its stored `workflowId` — a legacy `ResearchWorkflow`'s (`research:<messageId>`) and a person's `ResearchRunWorkflow`'s (`research:<runId>`), which concludes on its cancellation with its record as unit 70 built it (48 § 5.1), no patch — and each `finding:<id>` of the account's `SUBMITTED` findings, whose `SendFindingWorkflow` ends on its cancellation with nothing owed (48 § 8.4).
6. **Suggestions** (§ 3.8):
   - each draft through the draft delete's own steps (`lib/api/endpoints/suggestions.ts:612-630`): `deleteDraft` through the door (`lib/db/improve.ts:1079-1085`), each pending item's grading cancelled, everything under the draft's prefix removed (`lib/storage/index.ts:54`; `lib/schemas/storage.ts:79`), best effort, a failure logged with the draft's id;
   - each suggestion waiting for its revision loses what it gained since its last submission;
   - each one D7 closes is withdrawn, and the account is held until its `RETRACTED` record is written.
7. **Audit packs.** The file of each pack whose scope is the account itself (`audit/<id>.jsonl`, `lib/schemas/audit.ts:115-118`) is removed, best effort as in step 6. Its row stays and loses the person at step 9, its scope keeping the account's id (§ 3.1). The files of a chapter's or an organisation's packs the person asked for stay (D8).
8. **The gateway key** of the principal `{ userId }` alone, an individual's (§ 3.4).
9. **The rows, in one transaction** inside the account's own tenant context, each statement naming the account.
   - First its `ResearchRun` rows, whose findings go with them by the cascade; then every `ResearchFinding` of the account by `userId`, whatever its `runId` (the locks, below).
   - Then its `Session`, `Identity`, `Bookmark`, `Note`, `ReadingPathProgress`, `IdempotencyKey` and `ProposalEndorsement` rows.
   - Its rate buckets, keyed `user:<id>:…` (`lib/api/handler.ts:252-253`). They are no tenant model, so no guard applies to them.
   - Then the `User` row, guarded on `deletedAt` being set. The keys do the rest (§ 3.5).
   - The transaction never names `GatewayKey`: for an organisation member, the principal guard would read the member's context as the organisation's (`lib/db/client.ts:114-119`).
   - If a `RESTRICT` key still finds a row (a conversation that step 4 missed, say), the whole transaction is refused, and the account is held.
10. **The `erased` record**, after the commit, by its step key (§ 3.6).

**The repair.** Each run also mends what a failed append left, request by request and within the run's scope (§ 3.6).

**The locks.** No raw statement is added.

- Begin and a cancel are each one guarded update: begin on `deletedAt` null, a cancel on `deletedAt` null and on the request's own instant. Exactly one of them wins.
- When two runs overlap, each finds the other's steps done. The `User` delete is guarded, so the second run finds no row.
- A sign-in in the meantime is refused by either marker.
- The nightly sweep detaches a run's `PROPOSED` findings and then deletes the run, in two statements outside a transaction (`lib/db/research.ts:548-553`). On the night of an erasure the account's runs are what it visits: step 4 detaches them, and they are older than its 24 hours (`:504`, `:535`). Were step 9 to delete only detached findings and leave the rest to the cascade, a detach committed between its two statements would leave a finding with the account's id and a suggestion's, and no key to `User` (`prisma/schema.prisma:1298-1300`), which no later night would visit. Deleting the runs first locks their findings through the cascade; deleting every finding by `userId` next catches a detach committed before; a detach that comes after waits on the lock and finds nothing.

### 3.4 The gateway key

The architecture's order is to revoke the key at the gateway, then remove the row (architecture:297, :626). A `RESTRICT` key holds the account's row until the key's row is gone (`gateway_key_restrict`:13).

Nothing does this today:

- `revoke` is private, and it logs a refusal rather than failing (`workers/keys.ts:140-146`);
- no workers route revokes a principal's key (`lib/schemas/workers.ts:12`);
- `lib/db/gateway.ts` deletes no row.

The design:

- **`revokeKey(principal, deps)`** joins `workers/keys.ts`.
  - It reads the row of the principal `{ userId }` in that principal's own context (`lib/db/gateway.ts:39-42`; `lib/db/budget.ts:15-17`). No row means nothing to do.
  - It calls `/key/delete` with the key's gateway id; a 404 counts as deleted (`workers/keys.ts:102-124`).
  - Then `deleteGatewayKey(principal, litellmKeyId)` in `lib/db/gateway.ts` removes the row, guarded on that id.
  - A refusal at the gateway throws and keeps the row. Otherwise the row would go and leave a budgeted key that nothing could revoke, which is the reason the key is `RESTRICT` (architecture:626).
- **How the job reaches it.** As `npm run gateway:key` reaches `ensureKey`: as a script of the workers' code, run with the workers' environment (`scripts/gateway-key.ts:30-45`; `eslint.config.mjs:92-93`). No route is added. "The workers' `/key/delete`" (architecture:297) is the gateway's route this calls.
- **Whose key.** Only the principal `{ userId }`'s. An organisation member's key is the organisation's, and step 9 never touches `GatewayKey`.
- **Today.** While spec 11's D5 is deferred, no individual account holds a key (`workers/keys.ts:95-97`; tracker:782), so this step finds none here.

### 3.5 Every row that names the person, and what becomes of it

| Rows | Key to `User` (migration:line) | At the erasure |
|---|---|---|
| `Session`, `Identity`, `Bookmark`, `Note`, `ReadingPathProgress` | `RESTRICT` (`accounts`:133-142; `identity`:23) | deleted, step 9 |
| `Conversation`, with its `Message`, `Citation`, `SensorVerdict` and `Flag` rows | `RESTRICT` (`assistant`:118; its children `RESTRICT` to their parents) | through the door, step 4 |
| `GatewayKey`, an individual's | `RESTRICT` (`gateway_key_restrict`:13) | revoked and removed, step 8 |
| `ResearchRun` | `CASCADE` (`research_rows`:94) | concluded, step 5; deleted by `userId`, step 9 |
| `ResearchConversation` (feature-specs/48 § 4.2; amended in unit 75) | `CASCADE` on `userId` (`research_conversations`) | deleted through `deleteResearchConversation`, step 4 |
| `ResearchFinding`, attached or detached | none of its own (`prisma/schema.prisma:1298-1300`); `runId` `CASCADE` (`research_rows`:97) | every one deleted by `userId`, step 9 (45:142) |
| `ProposalEndorsement` | `CASCADE` (`research_proposals`:20) | withdrawn at step 3 where it stands before the merge; otherwise deleted, step 9 |
| `CuratorRoster`, `CurationSeed` | `CASCADE` (`improvement`:373; `curation_seed`:32) | with the row |
| `Suggestion`, a draft | `SET NULL` (`improvement`:334) | deleted with its files, step 6 |
| `Suggestion` waiting for its contributor's revision | `SET NULL` (`improvement`:334) | items no `SUBMITTED` record names deleted with their objects, a rationale not the one last submitted cleared; then closed or left as D7 says, step 6; kept without the person |
| `Suggestion` otherwise past draft; `CuratorAction`; `Merge`; `AuditExport` | `SET NULL` (`improvement`:334, :361, :379, :382) | kept without the person; an `AuditExport` of the account's own scope keeps the account's id in its scope and loses its file, step 7 |
| `Seat`, `AuthEvent` | `SET NULL` (`accounts`:130; `security`:18) | kept without the person; an `AuthEvent` until its 90 days |
| `IdempotencyKey` | none; a tenant model by `userId` (`lib/db/client.ts:67`) | deleted, step 9: it holds first answers, an answer's claims among them (45:50) |
| `RateLimitBucket`, keyed `user:<id>:…` | none (`lib/api/handler.ts:252`) | deleted, step 9 |
| `BudgetLedger` | none | kept (architecture:239) |
| `LedgerRecord` | none | kept; the account's `ERASED` records added, and the `ENDORSED` and `RETRACTED` records of what the erasure withdrew |

### 3.6 The records

- **The payload.** `ErasedPayloadSchema` (`lib/schemas/ledger.ts:466`) becomes a union of two strict members.
  - The conversation's member is as today.
  - The account's member is `{ stepKey, scope: { kind: "account", id }, step, requestedAt }`:
    - `id` is the account's uuid;
    - `step` is one of `requested`, `cancelled` and `erased`;
    - `requestedAt` is the request's instant. Each step's record carries it, so an auditor finds a request's records together.
  - The payload walk takes a union (`lib/schemas/freeText.ts:81`).
  - The test that refuses an account scope (`lib/schemas/ledger.test.ts:504`) becomes the account member's own test. It refuses a missing step, an extra member, and a scope of any other kind.
- **The rule** stays `ERASED: { actors: ["user"], about: "nothing" }` (`lib/schemas/ledger.ts:520`). Each record is signed `user:<id>` (D2), and none names a suggestion or a chapter version.
- **The step keys** sit beside `erasedStepKeyOf` (`lib/db/ledger.ts:86-87`):
  - `stepKeyOf("account:<id>", "requested:<requestedAt>")`;
  - `stepKeyOf("account:<id>", "cancelled:<requestedAt>")`;
  - `stepKeyOf("account:<id>", "erased")`.

  `erasedRecordAt` already finds any of them by kind and step key (`:89-92`). A request made again after a cancel gets its own keys.
- **When.** As in 45 § 3.7, each record is appended after the commit of what it records, so the chain never claims a step that did not happen. Each is looked for by its key first.
  - `requested` is appended only by the request that marked the row, under the stored instant (§ 3.2).
  - Before a cancel appends `cancelled:<t>`, it appends `requested:<t>` where that is missing. A request taken back before its night, whose own append failed, still has both.
- **The repair**, request by request. For each account within the run's scope whose chain holds a `requested:<t>` as old as step 1 takes (D3), with neither `cancelled:<t>` nor `erased`, and whose row is gone, the run appends `erased`.
  - It tests the latest request, never the account: an earlier cancelled request keeps its `cancelled` record for good, and a later erasure whose last append failed is mended all the same.
  - It closes, for an account, the gap that spec 45 had to leave open for a conversation (45 § 3.7, § 9).
  - A row removed some other way after its request is that old gets the same record, which says what is so: the account is gone after its request. It does not say what removed it. A row removed with no `requested` record is never touched.
- **The audit pack** selects these records under `answers` (`lib/schemas/audit.ts:27`). The checkbox's label becomes "assistant and research records, deletions and deletion requests" (65b; en.json:211): 65b adds "deletion requests" to the label spec 48's unit 71 set, "assistant and research records, and deletions" (amended by unit 71, spec 48 § 21).
  - An account's own pack reaches them once a cancel lets the person sign in again (`policies/hb/audit.rego:11-19`; `lib/db/auditExport.ts:27-32`), and then holds `requested` and `cancelled`.
  - Before a cancel, the account's own pack cannot be asked for, and an organisation's selects its current members.
  - The operator's export of the whole chain holds them all (`npm run ledger:export`).
- **The cancel's `AuthEvent`.** The cancel writes an `AuthEvent` of kind `deletion_cancelled`, kept 90 days like the rest (`lib/db/audit.ts:14`, `:26`), whose `by` is `operator` under D4 (B) and `account` under (A). It names the hand the record's pseudonym does not.

### 3.7 Names after the erasure

From the request on, the person appears by pseudonym everywhere (`lib/db/account.ts:50`), the queue's lines included since 66a (§ 4.2). A row that is gone reads the same way (`lib/improve/history.ts:77-84`; `lib/db/queuePage.ts:130`). Two pages read the person from the row and would lose them once it goes:

- **The record page** reads the contributor from the `SUBMITTED` record's actor (`lib/db/improveRecord.ts:73-74`), so it keeps the pseudonym.
- **The chapter history** reads a person's change's contributor from `Suggestion.userId` (`lib/improve/history.ts:151`), which the erasure nulls. The change would lose its contributor and its line in the credit list (`:199-208`).
  - 65c makes the history read the contributor from the merged record's `contributor` (`lib/schemas/ledger.ts:393`), which is written from the `SUBMITTED` actor (`workers/activities/merge.ts:555-558`, `:574`). The history already reads the endorser from the merged record (`history.ts:142`). `Suggestion.userId` is read only where no merged record can be read.
  - The loader already reads the person behind every actor (`lib/db/chapterHistory.ts:46-47`).
  - An erased contributor then keeps their credit under the pseudonym, as spec 37 says (37:541) and as "the ledger keeps the pseudonym" means (architecture:234).
- **The queue's detail** reads its contributor from the row (`lib/db/queuePage.ts:141`), and shows no contributor line once `userId` is null (`components/improve/QueueDetail.tsx:57-64`). 66a reads it from the `SUBMITTED` record's actor, as the record page does (§ 4.2).

### 3.8 What a workflow still owes the account

**A curator's action.** A curator's decision and merge are written as a `CuratorAction` row, and a workflow records them, signing the `CURATOR` record with the pseudonym it reads from that row (`workers/activities/suggestion.ts:574-617`; `workers/activities/merge.ts:431-453`). After step 9 the row's `curatorId` is null (`improvement`:361).

- **Today, losing the row loses the action.** `recordCuratorDecision` and `recordMergeAction` drop an action with a null curator before they look for its record (`suggestion.ts:577`, `:583`; `merge.ts:433`, `:439`). `recordMerged` reads `mergedBy` from the row and fails for good without it (`merge.ts:545-548`, `:577`; non-retryable, `:141`).
- **A merge waits weeks on a failed step by design** (`workers/workflows/merge.ts:66-75`). Once `main` holds the change and is tagged, each recheck runs only the release and the record (`:122-135`). A curator erased while such a merge waits would leave the book changed, the suggestion `MERGING` for good, no `MERGED` record (invariant 18), and no line in the history, which needs `mergedAt` (`lib/improve/history.ts:149`).
- **65c carries an action by its record.** `recordCuratorDecision` and `recordMergeAction` look for their `CURATOR` record by its step key before they read the curator from the row; where it is there, they finish what follows it (the calibration event and the move; the merge) without the row's curator. `recordMerged` takes `mergedBy` from that record's actor (`merge.ts:437`, `:451`), never from the row.
- **An action no record holds yet holds the account.** It cannot be recorded without its curator, and losing it is what 29:288 refuses. A lost queue decision would also strand its suggestion: the door still counts it as the visit's action, and refuses every other curator's decision and the contributor's withdrawal (`lib/db/improve.ts:589-591`, `:602-604`, `:620`). So the erasure is held before it begins while an action of the person's is owed a record:
  - in a queue, an action of this visit (`:602-604`);
  - in a merge, the curator's merge since its passed check (`:672`), or a revert's own action (`workers/workflows/merge.ts:143-146`);
  - each with no `CURATOR` record under its step key (`suggestion.ts:582`; `merge.ts:437`).

  The line names the suggestion. A record stays owed only while its step keeps failing, and a merge's failed step waits for a recheck by hand (`merge.ts:66-75`), so the line is what brings an operator to it.

**Research.** A cancelled run would end with no `RESEARCH` record: `concludeResearch` writes it (`workers/activities/research.ts:153-160`), and the workflow reaches it only through `end()` (`workers/workflows/research.ts:68-72`), which a cancellation never reaches. Its calls were charged, so the chain would lose runs whose spend `BudgetLedger` keeps (`research_metrics`:9-34), against one record a run (architecture:282; `lib/schemas/ledger.ts:412-417`). Not cancelling does not help: a run waiting for its suggestions asks for up to 40 days (`workers/workflows/research.ts:36`, `:147-151`), and once step 9 removes its row it fails `RESEARCH_RUN_MISSING` (`workers/activities/research.ts:77-80`).

- **Amended by feature-specs/48 (unit 75, 2026-10-12):** what 65d builds below is the legacy `ResearchWorkflow`'s alone; a person's `ResearchRunWorkflow` concludes on its cancellation as unit 70 built it, with no patch, and a `SendFindingWorkflow` ends on its cancellation with nothing owed (48 § 5.1, § 8.4).
- **65d concludes a run on its cancellation**, in a scope the cancellation does not reach. A run past its submission ends `DONE` with what its suggestions had come to; one before it ends `SKIPPED` · `TEXT_PURGED`, since step 4 emptied its text (45 § 3.5).
- The new command is behind `patched()`, as `VALIDATION_FAILURE_PATCH` is (`workers/workflows/research.ts:59-60`, `:122`), with a replay test of a history recorded before it, and the development engine's running research histories replayed against the new bundle before the workers restart (code-standards:116).
- Step 5 holds the account until the engine says none of its runs is running. A run asleep, at the budget or between two asks, takes the cancellation at once.
- Its child suggestions run on: they were started with `ABANDON` (`workers/workflows/research.ts:129`), and they name nobody.

**The person's suggestions** (D7).

- **A draft** goes with its files (step 6).
- **A suggestion waiting for its revision** (`takesRevision`, `lib/schemas/improve.ts:89-91`) can hold content no record names: a rationale rewritten in place and items added since its last submission (`lib/db/improve.ts:1179`, `:1188-1204`, `:1231-1246`). Its `SUBMITTED` record holds only the earlier rationale's hash and the earlier items' ids (`workers/activities/suggestion.ts:244-246`), no revision can now come (`:222-223`), and spec 45 keeps an item of a revision only because an earlier record names it (45:193, :498). So, as for a draft:
  - each item no `SUBMITTED` record of the suggestion names is removed through the door (`removeEvidenceItem`, `lib/db/improve.ts:1251-1259`), with the objects under its prefix (`lib/schemas/storage.ts:77`), and its grading cancelled when pending;
  - the rationale is cleared through the door (`updateDraft`, `:1188-1204`) where its sha256 is not the latest `SUBMITTED` record's `rationaleSha256`. The words it overwrote were gone already.
- **Then D7's closing**, through the withdrawal's own door and signal (`requestWithdrawal`, `lib/db/improve.ts:616-625`; `withdrawn`, `lib/schemas/workflows.ts:91-92`), acting for the account.
  - The account is held until the `RETRACTED` record is there under its key (`workers/activities/suggestion.ts:647`): recording it needs the row's contributor (`withdrawalStands`, `:653`), which step 9 nulls.
  - A request already standing is sent again with its instant, as the endpoint does (45 § 20).
  - The record is signed with the pseudonym (`:659`), as D2's are.
- **A suggestion still `SUBMITTED` whose workflow runs** holds the account before it begins. Its next model step charges the contributor's principal, which only the row names, the organisation's for a member (`lib/db/account.ts:74-79`). Without the row the step fails `NO_PRINCIPAL` for good, and the suggestion stays `SUBMITTED`, in no queue and in no list (`workers/activities/suggestion.ts:331-334`, `:416-418`; `workers/activities/evidence.ts:295-297`).
  - A run asleep at a budget cap (`workers/workflows/suggestion.ts:158-164`, `:182-185`) wakes at the reset, at most a month on, and is decided while the row is there. D7's rule then applies where the decision left it.
  - One whose workflow no longer runs is left as it is (§ 9).
- **Every other suggestion goes on.** In a curator's queue (under D7 (A) or (C)) or merging, it may be decided and merged, credited to the pseudonym its `SUBMITTED` record holds.

### 3.9 What changes after the fact

The erasure deletes every conversation of the account, so 45 § 3.8 applies to each:

- seven of the nine assistant series lose its rows;
- cost per active account loses the reader from its denominator;
- the grader's calibration set loses its flags.

The research series keep every run, each concluded with its record (§ 3.8); a run concluded at the erasure says what it had come to then. Their views read the ledger and `BudgetLedger` (45:129).

The researcher's gate's measure "from the answer to a proposal shown" loses an erased asker's proposals, the findings the sweep kept for them included: it reads each reader's `PROPOSED` findings in their own context (`scripts/research-gate.ts:203-216`), as 45 § 3.8 lists for a deleted conversation (45:164). The gate's comment beside it says so (65g).

An organisation's audit pack no longer selects an erased member's records or suggestions (`lib/db/auditExport.ts:27-32`; `lib/db/improve.ts:1796-1800`).

### 3.10 The 30 days, the object store and organisations

- **The 30 days** are the TRD's (D3). In them the account is refused at sign-in, named by pseudonym, and no new research of its questions starts. Its rows stay as they are, and work already under way, a research run or a suggestion's run, goes on. How a request is taken back is D4.
- **The object store** keeps files under three roots (`lib/schemas/storage.ts:19-25`):
  - a draft's evidence goes (step 6), and so does what a revision added that no record names;
  - a submitted suggestion's evidence stays for the life of its record (architecture:240; 45 D5);
  - the packs of the account's own scope go (step 7), a chapter's or an organisation's stay;
  - a merge's lab log names no person (`lib/schemas/storage.ts:81`).
- **Organisations**, as D9 says: a member is erased as any account is. No organisation case is built, and the erasure is never refused.

## 4. Withdrawing consent (unit 66)

### 4.1 What the contributor gets

- **On the account page**, the Retention instrument's `contributor identity` row says whether consent stands, and since when. Today the row is text (`components/account/RetentionInstrument.tsx:36-37`; en.json:273-274).
  - While consent stands, it offers **Withdraw consent**, which asks again in the page before it acts (§ 4.4).
  - While none stands, it offers **Give consent**.
  - Both are forms and work without JavaScript (08:369).
- **Once it is withdrawn**, the person is named nowhere for provenance, neither as a contributor nor as the name on a proposal. The record page, the queue and the chapter history (its JSON included) show the chain's pseudonym instead: `user:` and eight hex (`lib/improve/history.ts:83`).
- **Under D10 (B)** their names come off proposals a curator has not begun to merge, each with its record.
- **What it blocks** (D6, option A):
  - a new suggestion leaves draft only with consent given again (`lib/api/endpoints/suggestions.ts:444-445`), held in the person's own move too (§ 4.3);
  - a name goes on a proposal only with it (`proposals.ts:133`).

  Given again, on the row, in the submit box or with a name, consent names the person beside all their changes, because it is the account's (42:76; 43:123).

What it does not change:

- **The chain's earlier records.** Their actors are pseudonyms already, bound by the hashes (architecture:279-281, :293). Each `ENDORSED` record keeps its `consentAt` (`lib/schemas/ledger.ts:446`); under D10 (B) a withdrawal record follows each standing one.
- **Every export.** The audit pack, a record's or a chapter's JSONL and a conversation's export carry ledger lines, never a name (`lib/ledger/export.ts:101-104`). So "pseudonymises the user in exports" (architecture:294) holds by construction. What the withdrawal changes is the pages, and the history's JSON, which named the person.
- **The person's open suggestions**, which go on; Withdraw (45 § 5) takes one back. Under D10 (A), their standing names on proposals stay, credited to the pseudonym, and Remove my name (45 § 3.6) takes one back.
- **Names already seen**, and exports already downloaded.
- **Links between one person's changes.** Each carries the same pseudonym, and the public JSON record gives it whole (`lib/api/endpoints/record.ts:112-131`).

### 4.2 The read side (66a)

- **Who asks for consent.** The record page names anyone other than the contributor without asking for consent (`lib/db/improveRecord.ts:80`), and the queue names a proposal's endorser the same way (`lib/db/queuePage.ts:146`). The history asks (`lib/improve/history.ts:151`).
  - All three ask, for everyone named for provenance: the contributor, and the reader whose name stands on a proposal.
  - A curator is named for the role, and consent does not govern them (37:100; `history.ts:152`).
- **The queue's two lines carry the pseudonym.**
  - The queue types its endorser as a name or nothing (`lib/db/queuePage.ts:59`) and gives nothing for a person whose account is going (`:146`), which renders "not endorsed" (`components/improve/QueueDetail.tsx:57-59`; en.json:2002). That is untrue while the name stands and the merge will credit it, and today it is what the queue reads for anyone whose deletion is pending.
  - Its contributor line is likewise a name or nothing (`queuePage.ts:141`).
  - Both become `{ name, pseudonym }`, as the record page has them (`lib/db/improveRecord.ts:107-108`). A hidden name renders the pseudonym's short form in the same strings (`endorsedBy`, `byName`, `byNameVerified`; en.json:1981-1982, :2001), so no string is added. `notEndorsed` stays for a proposal no name stands on.
  - The contributor is read from the `SUBMITTED` record's actor, as the record page reads it (`improveRecord.ts:73-74`), so the line outlives the row (§ 3.7).
- **The account page** reads `provenanceConsentAt` with the rest of the account, for the row (`lib/db/account.ts:84-89`).
- **Why the read side comes first.** Nothing clears consent today, so for anyone who submitted after unit 50a these branches cannot be reached (tracker:658). The read side ships before the write.

### 4.3 The guards (66b)

Two writes must hold before anything clears consent.

- **The person's move out of draft holds invariant 25.**
  - The submit endpoint reads consent once (`lib/api/endpoints/suggestions.ts:431`, `:443-445`), puts consent given now on file, starts the workflow, and then makes the person's own move (`:465-470`).
  - Only a service's move holds the contributor's verification and consent in its query (`lib/db/improve.ts:1130-1132`). A withdrawal from another tab between the read and the move would leave the suggestion `SUBMITTED` with no consent on file, and the workflow's first step would go on, the row having moved (`workers/activities/suggestion.ts:282-285`).
  - So `transition` holds the same condition for the person's move from `DRAFT` to `SUBMITTED`. Refused, the endpoint answers `CONSENT_REQUIRED` and cancels the run it has just started, whose first step waits on the draft meanwhile (`:285`).
- **The revision path puts the consent on file.**
  - Today the endpoint asks for consent before a revision (`suggestions.ts:444-445`), but writes it only on a draft's path (`:466`), after the revision's branch has returned (`:453-463`).
  - After a withdrawal, a revision would pass with `consent: true` and leave none on file.
  - The consent therefore goes on file before the branch.

### 4.4 The write (66c)

- **`withdrawConsent`** is a form action beside `requestDeletion` in `app/[lang]/account/actions.ts`. In order:
  1. zod;
  2. the session;
  3. the policy's `write` on the user themselves (`policies/hb/user.rego:5-10`);
  4. under D10 (B), each name standing on a proposal whose merge is not taken is withdrawn, by the function step 3 of the erasure uses (§ 3.3). A proposal whose workflow cannot be told keeps its name, and the action stops there with `?error=consent-names#retention`: consent is not cleared while a name it covers stands. Names already withdrawn stay withdrawn, and a second press finishes the rest;
  5. `provenanceConsentAt = null` under the authentication exemption, naming the account: `where: { id: user.id, provenanceConsentAt: { not: null } }`, as `recordConsent` names it (`lib/api/endpoints/suggestions.ts:99-101`). Under the exemption nothing is injected (`lib/db/client.ts:152`), so a statement without the id would clear every account's consent, which nothing could undo;
  6. an `AuthEvent` of kind `consent_withdrawn`. The kind joins `AuthEventKind` (`lib/db/audit.ts:14`); the column is a string (`prisma/schema.prisma:195`);
  7. a redirect to `?saved=consent#retention`, with its notice.
- **`giveConsent`** sits beside it: zod, the session, the policy, `recordConsent` (`:99-101`), an `AuthEvent` of kind `consent_given`, and `?saved=consent-given#retention`.
- **The controls** are quiet small buttons in forms, each with a help line that says what it does.
  - `Withdraw consent` leads to `?confirm=consent#retention`, where the row asks again, with the help line, the confirming form and `Cancel`, as the sign-out page asks before it signs out (08 § 6.2). Under D10 (B), consent given again does not put back a name the withdrawal took off, which is why it asks first.
  - The shared `ConfirmDialog` would need JavaScript, as the deletion's dialog does (§ 9); the account's actions work without it (08:369).
- **The record.** The chain records consent where a name goes on a proposal: each `ENDORSED` record carries its instant (`lib/schemas/ledger.ts:443-446`). A `SUBMITTED` record carries none (`:244-266`).
  - Under D10 (B), each standing name gets a withdrawal record, so the chain says when that consent was taken back. The account's withdrawal itself is its `AuthEvent`, kept 90 days (`lib/db/audit.ts:26`, `:45-48`).
  - Under D10 (A), the `AuthEvent` is all there is, and the chain goes on showing each standing name's consent.
  - No `ERASED` step records it: `ERASED` records deletions, and the audit pack selects it as one (`lib/schemas/audit.ts:27`).
- No migration under D6 (A).

## 5. Endpoints and the page

**No `/api/v1` endpoint changes its contract**, so `openapi.json` does not either:

- the request, the withdrawal and the giving of consent are form actions of the account page;
- the erasure is `npm run account:erase`;
- under D4 (B) the cancel is `npm run account:keep`, and under (A) a form action of the login page;
- the submit endpoint answers its existing `CONSENT_REQUIRED` in one more case (§ 4.3).

**The Retention instrument** keeps its rows, its note and its button (`components/account/RetentionInstrument.tsx:25-57`).

- **The deletion's dialog** keeps its typed word and its form (`components/account/DeleteAccountDialog.tsx:28-35`). Its body says what goes, what stays and how a request is taken back (§ 6). Under D4 (B) the page passes it the support address.
- **The note** "Each request is a record in the audit chain" becomes true of the account's request (en.json:277; 45:315).
- **The `contributor identity` row** gains its two states, its two controls and the withdrawal's question (§ 4.4). The page's notices gain `consent` and `consent-given`, and its errors `consent-names` (`components/account/AccountPage.tsx:24-25`).

**The login page and Book Home.** The notice after the request and the sign-in's refusal take their words from D4's answer (§ 6). The login page gains the `erasing` error (`app/[lang]/login/page.tsx:24`). Book Home reads the logout's `state` and sends `deletion-requested` and `deleted` on to the login page (§ 3.2).

## 6. Strings

EN and PT candidates for Andre (rules § 4.6). The keys are named in the units that add them.

**Deleting an account** (changed). The candidates are for the recommended answers: D3 (A), D4 (B), D5 (A), D7 (A).

| Key | Today | Candidate EN | Candidate PT |
|---|---|---|---|
| `account.delete.body` | Sessions close now; the account and its marks are deleted after 30 days. Type delete to confirm. | Sessions close now, and no new research of your questions starts. In 30 days the account is deleted: its conversations, notes, bookmarks, reading progress and drafts, and your name on proposals a curator has not begun to merge. Until then, write to {address} to cancel the request. Suggestions waiting for your revision are withdrawn; one with a curator may still be decided and merged. What you submitted keeps its words and the files you uploaded, under a pseudonym, and the audit chain keeps its records the same way and records this request and the deletion. The sign-in service keeps your e-mail and your Google or GitHub link until an operator removes them. Type delete to confirm. | As sessões são encerradas agora, e nenhuma nova pesquisa das suas perguntas começa. Em 30 dias a conta é excluída: as conversas, notas, favoritos, progresso de leitura e rascunhos, e o seu nome nas propostas que um curador ainda não começou a incorporar. Até lá, escreva para {address} para cancelar o pedido. As sugestões que aguardam a sua revisão são retiradas; uma que está com um curador ainda pode ser decidida e incorporada. O que você enviou mantém as suas palavras e os arquivos anexados, sob um pseudônimo, e a cadeia de auditoria mantém os seus registros da mesma forma e registra este pedido e a exclusão. O serviço de login mantém o seu e-mail e o vínculo com o Google ou o GitHub até que um operador os remova. Digite delete para confirmar. |
| `account.retention.note` | Deletion is on request. Each request is a record in the audit chain. | unchanged; true of the account's request since 65e | unchanged |
| `auth.notice.deletion` | Your sessions were closed. The account is deleted after 30 days; write to support to cancel before then. | Your sessions were closed. The account is deleted after 30 days; write to {address} to cancel before then. | Suas sessões foram encerradas. A conta é excluída após 30 dias; escreva para {address} para cancelar antes disso. |
| `auth.error.deleted` | This account is pending deletion. Write to support to cancel the request. | This account is pending deletion. Write to {address} to cancel the request. | Esta conta está com exclusão pendente. Escreva para {address} para cancelar o pedido. |
| `auth.error.erasing` (new) | — | This account is being deleted, and the request can no longer be cancelled. | Esta conta está sendo excluída, e o pedido não pode mais ser cancelado. |
| `account.audit.kind.answers` | assistant and research records, and deletions (spec 48's unit 71) | assistant and research records, deletions and deletion requests | registros do assistente e de pesquisa, exclusões e pedidos de exclusão |

Other answers change these sentences:

| Answer | Where | EN | PT |
|---|---|---|---|
| D3 (B) | "In 30 days", "after 30 days" | Within 30 days · within 30 days | Em até 30 dias · em até 30 dias |
| D4 (A) | the body's cancel sentence | Until then, you can sign in and keep the account. | Até lá, você pode entrar e manter a conta. |
| D4 (A) | the notice | Your sessions were closed. The account is deleted after 30 days; until then, you can sign in and keep it. | Suas sessões foram encerradas. A conta é excluída após 30 dias; até lá, você pode entrar e mantê-la. |
| D4 (A) | the offer, in place of the refusal: title · body · button · done | This account is pending deletion · Keep it, and the request is cancelled; otherwise it is deleted on {date}. · Keep my account · Your account is kept. Sign in again to use it. | Esta conta está com exclusão pendente · Mantenha-a, e o pedido é cancelado; caso contrário, ela é excluída em {date}. · Manter minha conta · Sua conta foi mantida. Entre de novo para usá-la. |
| D4 (C) | the body's cancel sentence | This cannot be taken back. | Isso não pode ser desfeito. |
| D4 (C) | the notice | Your sessions were closed. The account is deleted after 30 days. | Suas sessões foram encerradas. A conta é excluída após 30 dias. |
| D4 (C) | the refusal, and `erasing`'s | This account is pending deletion and can no longer be used. | Esta conta está com exclusão pendente e não pode mais ser usada. |
| D5 (B) | the sign-in service | The sign-in service deletes your e-mail and your Google or GitHub link with it. | O serviço de login exclui o seu e-mail e o vínculo com o Google ou o GitHub junto com ela. |
| D5 (C) | the sign-in service | The sign-in service keeps your e-mail and your Google or GitHub link. | O serviço de login mantém o seu e-mail e o vínculo com o Google ou o GitHub. |
| D7 (B) | the suggestions | Suggestions waiting for your revision or for a curator are withdrawn. | As sugestões que aguardam a sua revisão ou um curador são retiradas. |
| D7 (C) | the suggestions | Suggestions you submitted stay where they are. | As sugestões que você enviou ficam onde estão. |

The body names what a person would look for. What it leaves out, `BudgetLedger` rows, 90 days of `AuthEvent` rows, logs and backups, is § 3.1's, and § 9 says so.

**Withdrawing consent** (new, unit 66). The candidates are for D6 (A) with D10 (B).

| | EN | PT |
|---|---|---|
| the row, consent given | kept for provenance · consent given {date} | mantida para proveniência · consentimento dado em {date} |
| the row, none | a pseudonym only · no consent on file | só um pseudônimo · nenhum consentimento registrado |
| withdraw, the trigger and the confirm | Withdraw consent | Retirar consentimento |
| withdraw's help, and its question | Your suggestions and proposals then show the audit chain's pseudonym instead of your name, and your name comes off proposals a curator has not begun to merge. Nothing else is deleted. | Suas sugestões e propostas passam a mostrar o pseudônimo da cadeia de auditoria em vez do seu nome, e o seu nome sai das propostas que um curador ainda não começou a incorporar. Nada mais é apagado. |
| cancel | Cancel | Cancelar |
| withdrawn | Consent withdrawn. Your name is no longer shown with your changes. | Consentimento retirado. Seu nome não aparece mais com as suas alterações. |
| a name not taken off | Consent was not withdrawn: a proposal could not be told to take your name off. Names already taken off stay off; try again in a minute. | O consentimento não foi retirado: não foi possível avisar uma proposta para tirar o seu nome. Os nomes já retirados continuam fora; tente de novo em um minuto. |
| give, the trigger | Give consent | Dar consentimento |
| give's help | Keep my name with my changes, for their provenance. Your name is then shown beside all of them. | Manter meu nome com as minhas alterações, para a sua proveniência. Seu nome passa a aparecer ao lado de todas elas. |
| given | Consent given. Your name is shown with your changes. | Consentimento dado. Seu nome aparece com as suas alterações. |

- Under D10 (A), withdraw's help and question read: "Your suggestions and proposals then show the audit chain's pseudonym instead of your name. Names you put on proposals stay, under that pseudonym; Remove my name takes one off. Nothing is deleted." / "Suas sugestões e propostas passam a mostrar o pseudônimo da cadeia de auditoria em vez do seu nome. Os nomes que você pôs em propostas ficam, sob esse pseudônimo; Remover meu nome tira um deles. Nada é apagado." The "name not taken off" line goes.
- Under D6 (B), `CONSENT_WITHDRAWN` reads: "You withdrew your consent to provenance. Give it again on your account page first." / "Você retirou o seu consentimento à proveniência. Dê-o de novo na sua página de conta antes."

**Amended** (unit 66):

| Key | Today | Candidate EN | Candidate PT |
|---|---|---|---|
| `improve.suggest.submit.consent` (en.json:1194) | Keep my name with this change, for its provenance. | Keep my name with my changes, for their provenance. | Manter meu nome com as minhas alterações, para a sua proveniência. |

The reason: the consent is the account's (42:76), and given after a withdrawal it names the person beside every change again (D6). The proposal's panel shows the same sentence and one of its own (en.json:2149); its own sentence does not change.

## 7. What the context files say today

Each of these is amended by the unit that makes it untrue, in that unit's commit (rules § 6.1). Two exceptions go in 65a, once Andre has answered: a citation that is wrong now, and a line D1 or D3 decides.

| Where | Says today | Amended by |
|---|---|---|
| TRD § 4.2, pp. 14 and 22 (read-only) | `deletedAt` "soft delete"; "a user delete sets deletedAt" | stays as written. The request's `deletionRequestedAt` is the soft delete, and `deletedAt` marks an erasure under way (65a, architecture § 12) |
| 08:129 | "`deletedAt` stays the hard-delete marker" | 65a (D1) |
| 08:5, 08:194 | "architecture § 7" | 65a: § 4.4 |
| 08:194, :329, :380 | the hard delete "is a later job"; "rows still exist until the hard delete"; the hard delete and its record out of scope | 65g |
| 08:244, :285, :324, :346, :358 | the notice, the dialog's body, the refusal | 65i, as D4 is answered |
| 09:395 | "`RateLimitBucket` is not account data (keys hash the IP)" | 65a: a user's buckets carry the raw id (`lib/api/handler.ts:252`). 65g: they go with the account |
| 15:131; 21:9, :49, :243 | "08 § 5.8"; 21:9 "still open there" | 65a: 08 § 5.5. 65g: built |
| 42 § 6 (42:76-79) | a name is taken back by Remove my name | 66c under D10 (B): a withdrawal of consent takes it off too |
| 45:142, :315, :423 | the hard delete "must delete" detached findings; the note untrue of the account's request "until spec 46" | 65g, 65e |
| architecture § 4.1, Accounts row (architecture:230) | "the hard delete follows after 30 days" | 65g: by `npm run account:erase`, the row removed |
| architecture § 4.1, Improvement row (architecture:234) | "a contributor's hard delete nulls `Suggestion.userId` and the ledger keeps the pseudonym" | 65c: the history reads the contributor from the merged record; 65g: a suggestion waiting for its contributor, as D7 says |
| architecture § 4.1, Audit packs row (architecture:243) | "Retained" | 65g: a pack of the account's own scope loses its file at the erasure (D8) |
| architecture § 4.2, the consent rule (architecture:270) | "delete sets `deletedAt`" | 65a (D1) |
| architecture § 4.3 (architecture:282) | `ERASED`: "a reader's deletion of a conversation" | 65b; 65d: a research run concluded at its cancellation, still one record a run |
| architecture § 4.4 (architecture:294, :296, :297) | the rows on consent, endorsements and account deletion | 66c (:294, and :296 under D10 (B)); 65g (:296, :297); 65f (:297's key) |
| architecture § 6.3 | two nightly jobs | 65g: the erasure's row |
| architecture § 12 | — | 65a: D1 to D10 as Andre answers them, and "the workers' `/key/delete`" (architecture:626) read as the workers' key code |
| code-standards:108 | the "30-day account hard delete": a script until Temporal's schedules exist | unchanged: 65g is that script, and unit 45e's schedules take it when they are built |
| project-overview:258 | "a deletion request is fulfilled within 30 days" | 65a under D3 (A): "30 days after the request" (TRD § 4.4); unchanged under (B) |
| `infra/schedules/` README, crontab and `schedules.ps1` | two jobs | 65g |
| `infra/keycloak/README.md` | — | 65g under D5 (A); 65e: the walk's new checks |
| comments: `requestDeletionFor`'s "the hard delete is a later job" (`lib/db/account.ts:134`); `recordPeople`'s "gone or going" (`:36`); the research gate's measure (`scripts/research-gate.ts:203-206`) | — | with the code |

Two conflicts are reported here and not changed: spec 35 says names go to the owner and curators only (35:66), and also names people to anyone on a merged record (35:98; `lib/db/improveRecord.ts:77-81`); and the overview's "within 30 days" against the TRD's "30 days after request", which is D3 (ai-workflow-rules:15).

## 8. Verification (in addition to rules § 7)

**Unit 65**

- **The contract** (65b):
  - the account member takes each step;
  - it refuses a missing step, a missing instant, an extra member, and a scope of another kind;
  - a service as the actor is refused;
  - the conversation's member is unchanged;
  - the `answers` label in EN and PT.
- **Records carried by their record** (65c), on the database and the time-skipping server:
  - a merge tagged whose release or record step failed, its curator's account then erased: a recheck records `MERGED` with `mergedBy` the `CURATOR` record's actor, and the history credits it;
  - a merge whose action was recorded before its curator was erased is not dropped at a recheck before `main` moves;
  - a queue decision recorded whose move failed finishes its move after its curator is erased.
- **Research concluded on its cancellation** (65d), on the time-skipping server:
  - a run waiting for its suggestions, cancelled, ends `DONE` with its record;
  - a run asleep at the budget, cancelled after its text was emptied, ends `SKIPPED` · `TEXT_PURGED` with the record 45 § 3.5 gives it;
  - a history recorded before the patch replays, and fails without the `patched()` check;
  - the development engine's running research histories replay against the new bundle before the workers restart.
- **The request, on the database** (65e):
  - the mark and the sessions' delete are one transaction, and another account's row and sessions are untouched;
  - a second request marks nothing, answers the stored instant and appends nothing;
  - the `requested` record is appended once, under the stored instant's key;
  - an append that fails is appended by the job, or by a cancel before it;
  - a turn's research hand-over after the request starts no run (`OFF_USER`), and after a cancel starts one again.
- **The broker's session** (65e): `npm run auth:kc:walk` extended, against the realm as it stands, with no edit to it:
  - after the request the end-session returns its `state`, and the login page shows the notice;
  - a new sign-in asks the provider again;
  - a refused sign-in lands on its refusal and leaves no broker session behind it;
  - the `erasing` refusal once the erasure has begun.
- **The erasure, on the database** (65g), in a new suite (`tests/integration/account-erase.test.ts`), scoped to the suite's own accounts. The account starts with a row of every kind in § 3.5. After the run:
  - each row is gone, nulled or kept as the table says, the seeds', the research runs' and the endorsements' cascades included (D1);
  - the `erased` record is there once;
  - a stray session row from a racing sign-in is deleted;
  - a sweep's detach between step 9's two research statements leaves no finding (§ 3.3, the locks);
  - `BudgetLedger` rows and every earlier ledger record are unchanged;
  - an organisation member's run leaves the organisation's key;
  - a pack of the account's own scope loses its file and keeps its row with the account's id, and a chapter's pack it asked for keeps its file;
  - a cancel after begin is refused;
  - a second run changes nothing;
  - `--now` without `--account` is refused.
- **Held**, and nothing after the hold changes:
  - the engine away (nothing after step 2), and the gateway refusing (the key row stays);
  - a conversation with a young turn;
  - a curator's action owed its record, with a cancel still taken meanwhile;
  - a `SUBMITTED` suggestion whose workflow runs;
  - a research run still running after its cancel;
  - a withdrawal whose record is not yet written (D7).
- **Suggestions** (65g, as D7 is answered):
  - a draft deleted with its files;
  - a suggestion under revision losing an item no record names, with its objects, and a rewritten rationale, and keeping what its record names;
  - under (A) or (B), its `RETRACTED` record signed with the pseudonym and the suggestion `CLOSED`;
  - under (A), one in a curator's queue left to go on.
- **Repaired** (65g):
  - a missing `erased` record is appended once;
  - an account with an earlier cancelled request, whose later erasure's append failed, is repaired;
  - a request younger than step 1's age, and an account outside the run's scope, are left alone;
  - a row deleted by hand with no `requested` record is left alone.
- **On the time-skipping server**: a name's withdrawal is recorded after the account's row has gone.
- **The history** (65c): an erased contributor keeps their credit under the pseudonym, and the record page and the history agree.
- **The key** (65f): `revokeKey` against a double of the gateway, for no key, a key revoked, a 404 and a refusal.
- **The cancel** (65h), as D4 is answered. Under (B):
  - a request standing is cleared, its `requested` record appended first where it was missing, then its `cancelled` record and its `AuthEvent` with `by: "operator"`;
  - a cancel once the erasure has begun is refused;
  - the person signs in again as before, and research is on again;
  - a production boot with no `SUPPORT_EMAIL` is refused.
- **The page** (65i): the dialog in EN and PT with the answered sentences, the notice and the refusals, axe, and the PT truncation suite.
- **Not on the development database**: the script is not run against it unscoped, because there it would erase every account whose request is old enough (as in 45 § 24).

**Unit 66**

- **The read side** (66a):
  - a contributor and an endorser are each named while consent stands, and by pseudonym after, on the record page, the queue and the history;
  - in the queue, a hidden endorser reads "endorsed by user:…", never "not endorsed", and a contributor whose row is gone keeps a line;
  - a curator is named either way.
- **The guards** (66b):
  - a withdrawal between a submission's read of consent and its move leaves the draft a draft, answers `CONSENT_REQUIRED` and cancels the run;
  - a revision after a withdrawal puts the consent on file.
- **The write** (66c):
  - consent cleared, with its `AuthEvent`, and another account's consent untouched;
  - the row's two states;
  - the question before the withdrawal, and `Give consent`, without JavaScript;
  - consent given again through the row, the submit box and `Add my name`;
  - under D10 (B): each standing name withdrawn with its record before consent is cleared; an engine away leaves consent standing and says so; a second press finishes.
- **The browser**: the controls in EN and PT, axe, and PT truncation.
- **`opa test`** unchanged: every action is the user's `write` on themselves, which the policy already allows (`policies/hb/user.rego:5-10`).

## 9. Risks and limits

- **"Deleted" may read as "every trace is gone".** The dialog says what stays that a person would look for; `BudgetLedger` rows, 90 days of `AuthEvent` rows, logs and backups are § 3.1's alone. Whether this answers an LGPD request is for counsel to read (45:405).
- **The pseudonym is the account's own id** (`lib/schemas/ledger.ts:215-216`). Once the row is gone, the id remains in several places: `BudgetLedger`, an own-scope audit export's scope and its `EXPORT` record, log lines, workflow histories, LiteLLM's key alias (`workers/keys.ts:77`), the book's commit trailers, and the Keycloak user until D5's answer removes it. These link to each other, not to a person, unless a backup is restored. Counsel again.
- **The ledger's text hashes are unkeyed**, so a short question can still be confirmed by guessing (45:406).
- **The erasure needs the engine**, and the gateway too where a key exists. While either does not answer, an account waits past its 30 days, and the job's line says so.
- **The erasure waits on work others owe the account**: a curator's action owed a record, a `SUBMITTED` suggestion's decision (until a budget's reset, at most), a research run's conclusion, a withdrawal's record. The line names each. If a workflow cannot record a curator's action at all, a step that keeps failing, the account waits until an operator mends that step: the erasure is late, not lost.
- **Nothing is scheduled on this machine** (tracker:146). The erasure runs when `npm run account:erase` is run, until Andre answers unit 45e's question.
- **A run is not atomic.** Steps 3 to 8 come before step 9's transaction. An account held between them has lost some rows, but it is still refused at sign-in, and the next night finishes it. From step 1 on, a cancel is refused.
- **A suggestion the erasure leaves open that comes back to wait for a revision waits for good** (§ 3.8, D7), as an abandoned suggestion's run waits today (`workers/workflows/suggestion.ts:316`).
- **A `SUBMITTED` suggestion whose workflow no longer runs** stays `SUBMITTED` after the erasure, as it would have stayed with the account.
- **An upload never added as an item to a suggestion under revision** stays under its prefix: no row and no record names it, and the store has no listing to find it by. A draft's goes with its whole prefix.
- **An organisation's audit pack** loses an erased member's records (§ 3.9).
- **The Keycloak user**, under D5 (A), waits for an operator. Until then Keycloak keeps the e-mail and the links, and a sign-in through it makes an account with the old role and verification.
- **Only the requesting browser's broker session ends at the request.** On other devices the application's sessions are gone; a sign-in through their broker session is refused and ends it.
- **Paid research already in flight** when a run is cancelled completes and is charged. Its record can then precede the reader's counts and understate them, unlike 45 § 3.5's detached run, whose workflow waited for the call.
- **A draft's or a pack's file whose removal fails** stays. Its log line names the suggestion or the export, never the person.
- **Under D4 (B), the cancel rests on the operator's check** of the account's own e-mail address. The product does not authenticate the written request, and the `cancelled` record is signed with the pseudonym; its `AuthEvent` says an operator ran it.
- **Consent given again names the person beside every change** (D6), including the changes made before the withdrawal. The submit box's amended sentence names all their changes, and the row's help line says so (§ 6). Under D10 (B) it does not put back the names the withdrawal took off.
- **One person's changes stay linkable to each other** (§ 4.1).
- **The deletion's dialog opens only with JavaScript** (`components/account/DeleteAccountDialog.tsx:28`), although spec 08 § 9 requires every account action to work without it (08:369). Found by reading the code; recorded here, not fixed. The consent's controls work without it.

## 10. Out of scope

- **Erasing a submitted suggestion's words and files** (45 D5).
- **Organisational accounts**: membership, an administrator's delete of a member, the last administrator (38:47).
- **An export of everything the account holds**, before it goes.
- **Keyed hashes** in the ledger's payloads (45:406).
- **How long telemetry and backups are kept**: the operator's question and counsel's (`infra/observability/README.md:49`; architecture:582).
- **A pseudonym per suggestion.**
- **LiteLLM's and Langfuse's own retention**, of a revoked key's rows and of metadata.
- **A trigger for the deletion's dialog that works without JavaScript** (§ 9).
- **Spec 35's two sentences on the public audience** (§ 7).
- **A sweep of objects under a suggestion's prefix that no item or record names** (45 § 9).
- **Ending broker sessions on other devices**, which needs Keycloak's admin API (D5).
- **Closing a suggestion whose contributor is gone when it comes back to wait for a revision**: the suggestion's workflow would have to know its contributor is gone.

## 11. Units

Two units in Andre's lean shape, with one review each at its end. Within a unit, each part is verified by rules § 7 before the next. A migration is its own first part; none is needed under the recommended answers: `ERASED` has been in the enum since 62b, and `deletedAt` exists (`prisma/schema.prisma:124`). A read side ships before anything writes what it reads, and a guard before anything it guards against.

**Unit 66 · withdrawing consent**

| Part | What | Folders |
|---|---|---|
| 66a | The read side: a person named for provenance only while their consent stands, on the record page, in the queue and in the history; the queue's endorser and contributor lines with the pseudonym, the contributor read from the `SUBMITTED` record; `provenanceConsentAt` in the account's data; the Retention row's two states | `lib/db/`, `lib/schemas/`, `components/improve/`, `components/account/`, `messages/` |
| 66b | The guards: the person's move out of draft holds invariant 25, a refusal answered `CONSENT_REQUIRED` and the run cancelled; the revision path's consent on file before its branch | `lib/db/`, `lib/api/` |
| 66c | The write: `withdrawConsent`, naming the account, with its question in the page and, under D10 (B), the names taken off first; `giveConsent`; the two `AuthEvent` kinds; the notices and the error; the submit box's amended sentence; the strings; the browser flows. Then the one review of unit 66 | `app/`, `lib/`, `components/`, `messages/` |

Under D6 (B), unit 66 starts with a migration part (`provenanceWithdrawnAt`), and 66c gains the two refusals and their code.

**Unit 65 · deleting an account**

| Part | What | Folders |
|---|---|---|
| 65a | This spec, the tracker, and architecture § 12's decisions as Andre answers them. The lines that are wrong today: the "08 § 5.8" and "architecture § 7" citations (08, 15, 21), 09:395; and the lines D1 and D3 decide: 08:129, architecture:270, project-overview:258 | `context/` |
| 65b | The `ERASED` account member, its step keys, and the payload walk's and the rule's tests; the audit pack's `answers` label. Nothing writes one before 65e | `lib/schemas/`, `lib/db/`, `messages/` |
| 65c | Records that outlive their person: the history's contributor read from the merged record; `recordCuratorDecision` and `recordMergeAction` carried by their `CURATOR` record once it is there; `recordMerged`'s `mergedBy` from that record | `lib/improve/`, `workers/activities/` |
| 65d | `ResearchWorkflow` concludes a run on its cancellation, behind `patched()`, with its replay test; the running histories replayed before the workers restart. Deployed before 65g's job runs anywhere | `workers/workflows/`, `tests/` |
| 65e | The request: one transaction naming the account, what it marked and when; the `requested` record; research off while a request stands; the broker's session ended through the logout's `state`, with Book Home's redirect; a refused sign-in's broker session ended; the `erasing` refusal; the walk extended | `lib/db/`, `lib/auth/`, `lib/api/`, `app/[lang]/account/`, `app/[lang]/(home)/`, `app/[lang]/login/`, `infra/keycloak/` |
| 65f | The key: `revokeKey` and `deleteGatewayKey` | `workers/`, `lib/db/` |
| 65g | The erasure: `lib/auth/erase.ts` and its door functions (the account's drafts, revisions, withdrawals, owed actions and packs through `lib/db/improve.ts`, its runs and findings through `lib/db/research.ts`, begin and the rows through `lib/db/account.ts`); the holds; the repair; `scripts/account-erase.ts` and `npm run account:erase`; `infra/schedules/`; D5's step; the research gate's comment | `lib/`, `scripts/`, `infra/` |
| 65h | The cancel, as D4 is answered: `npm run account:keep` and `SUPPORT_EMAIL` under (B), the sign-in's offer under (A), nothing under (C) | `scripts/`, `lib/` (A: `lib/auth/`, `app/`) |
| 65i | The page: the dialog's body, the notice and the refusals, the strings EN and PT, the browser flows. Then the one review of unit 65 | `components/`, `app/`, `messages/` |

**Order** (Andre, 2026-10-12: after spec 48's units; within this spec, as recommended): unit 66 first, then unit 65.

- Unit 66 needs neither a job nor, under D10 (A), the engine. Its 66a mends the queue's line for anyone whose deletion is pending today, and under D10 (B) its way of taking a name off serves 65g.
- In unit 65, the workers' parts (65c, 65d) are deployed before 65g's job runs anywhere.

## 12. The review of the design (2026-10-11)

Three reviewers checked the draft against the code, one lens each: the data, the invariants and the product. They raised 30 findings: one high, twelve medium, seventeen low. Each is answered where the spec cites it, and here. Six are answered in part, and each says what was not taken and why.

- **The data.**
  - *curator-erased-mid-merge* (medium): § 3.8 and the hold before begin; 65c. The other way offered, the loss as Andre's decision against 29:288, was not taken: a lost queue decision would also strand its suggestion, which the door would go on counting as decided (`lib/db/improve.ts:602-604`).
  - *exemption-drops-tenant-guard* (medium): § 3.2, item 1, and § 4.4, step 5, name the account in every statement under the exemption; § 8 checks another account's rows.
  - *delete-body-overpromises* (medium): § 6, with *delete-dialog-omits-what-stays* and *dialog-body-ignores-d5*. The body varies with D3, D4, D5 and D7, says what stays, no longer promises the provider's link goes, and speaks of proposals a curator has not begun to merge.
  - *d7-waiting-suggestions-never-end* (low): D7 is Andre's, and § 3.8 says what each kind of suggestion does. In part: a `SUBMITTED` suggestion is answered by a hold while its workflow runs, so that it is decided while the row still names whom to charge. Keeping its organisation without the row would need a column, and closing it is no move the table has (`lib/schemas/improve.ts:71`). And a run that waits for good is already the lot of an abandoned suggestion (`workers/workflows/suggestion.ts:316`), so D7 weighs it as a cost rather than a new defect.
  - *erasure-races-research-sweep* (low): step 9's order and the locks (§ 3.3); § 8.
  - *consent-withdrawal-record-premise* (low): § 4.4's premise is corrected, and what records a withdrawal is part of D10's two options. In part: no `ERASED` step records it, since `ERASED` records deletions and the pack selects it as one (`lib/schemas/audit.ts:27`); nor is one `AuthEvent` kind kept past the 90 days of the rest (`lib/db/audit.ts:45-48`), since under D10 (B) the chain records what that would.
  - *requested-record-gaps* (low): a cancel appends `requested` before `cancelled`, and the repair tests each request, not the account (§ 3.6); § 8.
  - *gate-measure-changes* (low): § 3.9; the gate's comment in 65g.
  - *audit-export-scope-names-account* (low): § 3.1, step 7 and § 3.5 say it. In part: the rows are not rewritten, since the pack's `EXPORT` record holds the same id in its scope for good (`lib/schemas/ledger.ts:132-148`), and a row made clean would leave the chain's copy where it is.
  - *d1-citations* (low): D1 cites each cascade to its migration, 65g's suite tests the three untested ones, and the blanked row needs a placeholder for `email` only.
- **The invariants.**
  - *research-cancel-drops-records* (medium): § 3.8 and 65d; step 5 holds until the account's runs have ended. Accepting the loss, with architecture:282 amended, was the other way offered; not taken.
  - *d10-consent-withdrawal-keeps-credit* (medium): D10 is Andre's, with two options and (B) recommended; § 4.4's premise is corrected.
  - *delete-dialog-omits-what-stays* (medium): § 6, as above.
  - *queue-endorser-reads-not-endorsed* (medium): § 4.2, in 66a, which ships before unit 65; § 3.1 and § 3.7 say what the queue reads until then.
  - *revision-content-outlives-erasure* (medium): § 3.8, under every answer to D7; § 3.5's table; D7 says it.
  - *d6-option-b-incomplete* (low): D6 (B) clears `provenanceConsentAt` too, so invariant 25 and every read of consent stand as written, and only the two refusals and `Give consent` read the new column.
  - *pack-files-removed-beyond-own* (low), with *audit-pack-files-vs-retained*: step 7 takes only the account's own scope; D8 and § 7 name architecture:243.
  - *cancelled-record-actor-and-reach* (low): the reach is answered: § 3.6 says an account's own pack holds `requested` and `cancelled` after a cancel, and the checkbox's label names them. In part: the actor stays the pseudonym. A rule is one per kind (`lib/schemas/ledger.ts:510-521`, `:535-544`), so a service allowed to sign the cancel would be allowed to sign any `ERASED` record, a conversation's included. The operator's hand is in the cancel's `AuthEvent`, and D4 (B) says the product does not authenticate the written request.
  - *step-keyed-records-twice-or-false* (low): § 3.2, item 2, appends only what the request marked, under the stored instant; § 3.6's repair is scoped and waits for step 1's age, and says what a row removed by hand is recorded as; § 8.
  - *now-flag-erases-early* (low): § 3.3 takes `--now` only with `--account`; § 8.
- **The product.**
  - *d4b-support-address-nowhere* (high): D4 (B) gains its address, the operator's check and its cost; (A) is reworded; § 6 gives the notice and the refusal under each option, and the `erasing` refusal once a cancel is refused.
  - *realm-post-logout-not-applied* (medium): § 3.2, item 4, keeps the realm as it is and carries the notice by the logout's `state`; the walk runs against the realm as it stands.
  - *dialog-body-ignores-d5* (medium): § 6; D1 and D5 say what a returning sign-in gets. In part: the operator's removal is not moved before day 30. A Keycloak user deleted before the erasure would leave a request cancelled after it without the role and verification the next sign-in mirrors (`lib/auth/link.ts:65-74`), so the job names the subjects it has erased instead.
  - *withdrawal-races-submission-invariant-25* (medium): § 4.3, in 66b, before anything clears consent.
  - *withdrawal-has-no-undo-under-d6a* (medium): D6 and § 4.4 give the row `Give consent` and a question before the withdrawal. The question is asked in the page, not by the shared `ConfirmDialog`, which needs JavaScript the account's actions may not (08:369).
  - *d7-open-suggestions-should-be-andres* (low): D7 is Andre's, with (B) the option this finding proposed.
  - *request-leaves-research-on* (low): § 3.2, item 3.
  - *broker-session-only-requesting-browser* (low): § 3.1 says only this browser's broker session ends; § 3.2 ends a refused sign-in's.
  - *d3-should-be-andres* (low): D3 is Andre's; unit 45e's question stays where it is (tracker:146), and the erasure follows it.
  - *audit-pack-files-vs-retained* (low): with *pack-files-removed-beyond-own*, above.

## 13. Andre's answers (2026-10-12)

| # | Answer | What it fixes in this spec |
|---|---|---|
| D3 | (A) day 30 or 31 | the job erases at the first nightly run once a request is 30 days old; 65a changes project-overview:258 to "30 days after the request" |
| D4 | (B) an operator, on the person's written request; the address set later | 65h builds `npm run account:keep` and `SUPPORT_EMAIL` in `lib/env.ts`: required in production, a placeholder in development, shown as `{address}` in the dialog, the notice and the refusal; Andre gives the address before any real request |
| D5 | (A) an operator deletes the Keycloak user by hand | the job's line names the Keycloak subject of each account it erased, and `infra/keycloak/README.md` says how; no credential is added |
| D6 | (A) consent is asked again | no migration; the withdrawal clears `provenanceConsentAt`, and the account page offers `Give consent` while none stands |
| D7 | (A) closed where they wait for the person alone | a suggestion declined at intake or asked for more is withdrawn through 45 § 5's door with its `RETRACTED` record; one in a curator's queue goes on |
| D10 | (B) the withdrawal takes the names off | before clearing consent, the withdrawal takes each name off a proposal whose merge is not taken, with an `ENDORSED` record of each; the withdrawal needs the engine where a name stands |
| Order | after spec 48 | units 66 and 65 are built once spec 48's units are; within this spec, 66 first |

