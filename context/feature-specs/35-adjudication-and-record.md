# 35 · The outcome and the record — feature spec (the Improve landing page, the adjudication page, the record with its chain check and export)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: `docs/design/screens/Improve-Adjudication.html` and `Improve-Record.html` with their PNGs; the style guide's Timeline; overview § Core user flow steps 12 and 15 and § Features · Improve — contributor; TRD § 4.3 (verification of a filtered view "plus the two chain neighbours outside it"), § 6.1 (`GET /suggestions/{id}`, `GET /suggestions/{id}/record`); architecture § 4.3, § 5.4, invariants 16, 18, 26, 27. The landing page has no screen.

Prerequisite specs: `14-ledger-core.md` (views, `verifyView`, the export), `17-refusal-log-flags.md` § 6 (the conversation export this one mirrors), `29`, `33`, `34` § 3 (the classes).

Scope: tracker unit 52 (52a to 52c). What a contributor sees after submitting, and what anyone entitled sees of a suggestion's history. Not here: the curator's view of the same suggestion (36), the chapter's history (37 § 7), the researcher's proposals on the landing page (43 § 5).

## 1. Purpose

A decision nobody can read is not a calibrated decision. The adjudication page says what was decided and, criterion by criterion, why, in the rubric's own terms, and what evidence would change it. The record page shows that the decision is what the ledger says it is: every step with its hash and the previous hash, recomputed in front of the reader.

## 2. Dependencies and order

52a needs only the rows. 52b needs the workflow's outcomes. 52c needs 52b and, for its right rail's merge panels, shows what exists: they fill in when spec 37 is built.

## 3. The Improve landing page (52a)

`/[lang]/improve`: the top bar's `Improve` item has pointed here since Phase 1, at nothing. RSC, per request.

| Visitor | Sees |
|---|---|
| signed out | what Improve is in three lines, the link to the rubric, the sign-in notice |
| any signed-in reader | the same, plus their research proposals (spec 43 § 6) when that exists |
| a contributor | **Your suggestions**: a table of their own, newest first: id, anchor, class, state, score against accept, age, with drafts first. Rows that wait on them (`request more`, a failed intake) are marked. A link to start one says to open a section and use "Suggest a change" |
| a curator | a line with the queue's open count for their parts and the link to it |

No count of suggestions per person appears anywhere but on a person's own list (invariant 26).

**Amended by feature-specs/48 § 10.2 (unit 76, 2026-10-13), Improve's two starts.** The head carries `New suggestion` beside the rubric's link for every visitor (A11): a link to the new-suggestion chooser (`/[lang]/improve/new`), which tells a reader, a builder, an organisation admin, an unverified or a throttled contributor why they cannot draft, and sends a signed-out visitor to sign in. The contributor's row above no longer says to open a section: the help line reads "Use New suggestion, or Suggest a change on a section of the book." And any signed-in person with findings of their research not yet used sees **From a research** right under the heading, before the research proposals, with an anchor link to it in the head: each `VALID` finding whose run's text is held, newest first — its research (label and the run's day, a link to the run on the Research page), its anchor and section title, its kind of change, and its button by role or its line, followed after a send as under its run (48 § 8.1, § 8.3). A throttled contributor reads the throttle notice once above that table and no button. A person with no unused finding sees neither the section nor the link.

**Notifications** (D3): this page is the product's notification of a decision. The TRD sends e-mail for decisions, throttles and rubric changes; there is no mail service, so the states are shown where the contributor looks: the marked rows here, the throttle notice on the form. Nothing is pushed.

## 4. The adjudication page (52b)

`/[lang]/improve/[suggestionId]`, RSC; the owner, and a curator of one of its parts (spec 29 § 6.2). Anyone else gets the product's not-found page: the existence of a suggestion is not public until it is merged.

The screen is the layout: the context strip; the header (`adjudication · S-23-0412 · submitted … · decided …`, the anchor as title); **Decision** (the score as the big number, the badge, `floor 25 · accept 70`, the mono line, the sentence, the footer with tokens and the record's short hash); **Anchor** (the quote, before and after with their tier marks, the evidence box); **Reasons**, one line per criterion; **Sensors**; **What would suffice**; the actions.

What decides which variant renders:

| Outcome | The page |
|---|---|
| in progress (`SUBMITTED`, `GRADED`, `SENSED`) | the header, the anchor, the evidence as graded so far, and a status line naming the step; it refreshes at the suggest form's interval until decided |
| waiting for budget | the same, with `waiting for budget · resets …` |
| declined at intake | the screen as drawn for `S-23-0412`: `declined at intake before any model call`, `intake rule · 0 tokens`, reasons from the rules, what would suffice |
| declined by a sensor | the failing sensor's row marked, its note as the reason |
| request more | the badge `request more`, the named tier, `Revise with new evidence` as the primary action |
| request more by rule (derived) | the screen's dock content for `S-22-0356`: `accept 100 · tier A only`, the request for a tier A run on the chapter's lab; the lab button is absent until the IDE exists and the page says so |
| in the curator queue | the decision so far and `with a curator · part iii`, and the deadline's date |
| accepted, merging, merged | the badge, and the link `View full record` as the primary action |
| closed by a curator's decline | the curator's coded reason if any; the note is the curator's and is not shown to the contributor (its hash is in the record) |

The right column of the screen is "also yours · open": the contributor's most recent other open suggestion, in the compact form the screen draws. It is absent when there is none, and absent for a curator.

`Revise with new evidence` opens the edit page in its revision state: evidence and rationale editable, anchor and proposal fixed (spec 31 § 6.5).

The throttle box (`3 declines for unverifiable evidence in a month throttles suggestions; you have 0`) shows the contributor's own count from the same query the throttle uses, and the note that a tier G decline does not count when this one is such.

## 5. The record (52c)

`/[lang]/improve/[suggestionId]/record`, the same audience until the suggestion is merged; public from then on, because the chapter's history links to it (the Chapter-History screen: "each row links to a hash-chained decision record"). Built in unit 54d, part 1 (2026-10-10; spec 37 § 19): the page and `GET /suggestions/{id}/record` answer anyone for a merged suggestion, the policy told `merged` on the resource.

- **Header and the three panels** (Change, Decision, Evidence) as the screen.
- **Record**: the timeline from `lib/db/ledger.ts` `view({ suggestionId })`: time, title, actor, body, and the hash line `prev … · hash …` in the 12-character form `ledgerLine` already prints. Titles and bodies are composed from each record's payload by one presenter (`lib/improve/record.ts`): `Submitted`, `Graded`, `Sensors`, `Decided · accept`, `Curator · approved`, `Merged`, and for a researcher's suggestion `Endorsed`. A second attempt after a revision appears as its own entries.
- **Actors**: a person appears by display name only to the owner and to curators; to anyone else, and always for a contributor who withdrew consent or deleted their account, by the pseudonym the ledger holds. Agents appear as what they are: `grader · small tier · rubric v1.2`, `adjudicator guide v2.1 · rubric v1.2`, `deterministic · 4 sensors`. No edit is attributed to an agent (invariant 27): an agent's entries are decisions and checks.
- **Right rail**: Version, Lab gate, Source row, Credit (spec 37 fills these; before a merge they read what is known: `not merged`), **Chain integrity**, Export.
- **Chain integrity** is computed on the request: `verifyView` over the suggestion's records with their predecessors and the two neighbours outside the view. The line reads `chain verified · 6 records · head 3c07e9a14b52` with the loader at `6 / 6 links match`, or names the first break (`ChainBreak.field`, the `seq`) in the error state. It is never cached as a string.
- **Export record**: `GET /api/v1/suggestions/{id}/record/export`, the ledger's JSONL export in its `suggestion` scope with the signed trailer, appending its own `EXPORT` record, exactly as a conversation's export does (spec 17 § 6). Its rate limit is the conversation export's.

`GET /api/v1/suggestions/{id}/record` returns the same records as JSON with hashes (TRD § 6.1), for the same audience as the page.

## 6. Strings

Namespace `improve.outcome.*` and `improve.record.*`; EN verbatim from the two screens. Candidates, written with the unit: the landing page, the in-progress and waiting lines, the absent-lab note, the pre-merge rail, the chain-break error. Dates and numbers through the locale formatters; ids, versions, hashes and codes never localised (invariant 28).

## 7. Out of scope

- E-mail (D3).
- A public list of open suggestions per section. The Components screen's empty state ("No suggestions on 21.3") implies one; it would show unreviewed changes to every reader, and no screen of the reader has a place for it.
- Comment threads between contributor and curator.

## 8. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | Two addresses for the two screens | `/improve/[id]` and `/improve/[id]/record` | the TRD gives both screens one route; the overview's flow already names `/record`; "View full record" is a link on the first screen |
| D2 | Who sees a record before the merge | the owner and the part's curators; public once merged | architecture § 5.4; the history page is public and links to it |
| D3 | Notifications without e-mail | in the product, on the landing page | no mail service exists; adding one is infrastructure and a vault secret, and nothing here needs a person told faster than they would look |
| D4 | The curator's note | never shown to the contributor | the ledger carries its hash, not its text, and the adjudicator may never read it (invariant 12); the coded reason is the public part |

## 9. Verification (in addition to `ai-workflow-rules.md` § 7)

1. With `npm run improve:seed`: `/en/improve/<example 2>` matches the Improve-Adjudication PNG's main column for the declined state; `<example 3>` and `<example 4>` show request more with their named evidence; each deliberate difference listed.
2. `/en/improve/<example 1>/record` shows the records in order with `prev` equal to the entry above's `hash`, and `chain verified`; with one record's payload altered in a test double, the page names the break and its `seq`.
3. The export file verifies with `verifyExport` and the public key; an `EXPORT` record was appended; the chain still verifies.
4. Audience: another contributor gets not-found on both pages; a curator of another part gets not-found; a signed-out visitor gets not-found before the merge and the record after it.
5. To a signed-out visitor of a merged record, the contributor appears by name only when consent stands; a deleted account's entries show the pseudonym.
6. The landing page for each of the four visitors of § 3; no query on it counts suggestions by person other than the visitor.
7. Zero axe violations on the three pages in EN and PT at 1440; all three join the truncation suite.

## 10. As built (unit 52a: the Improve landing page, 2026-10-08)

`/[lang]/improve` is built, per request, as § 3 has it. No screen draws it, so it is composed from the Rubric page's measure and the shared table.

- **Every visitor** sees the head: `improve`, `Improve the book`, what Improve is in three sentences, and `Read the rubric`.
- **Signed out**: the sign-in notice, its link returning to the page.
- **A reader or a builder**: the head alone (their research proposals arrive with spec 43 § 6).
- **A contributor**, and a curator, who is one on the ladder: **Your suggestions**, their own, drafts first, then newest first (`listOwnSuggestions` in the one door, in two statements as `partsOf` reads). Each row has:
  - the id, linked to a draft's edit page or to the suggestion's own page (52b's, the not-found page until it is built);
  - the anchor, the class (the Rubric page's names), the state, or the outcome where one is decided;
  - the score against the class's acceptance under the rubric the suggestion was written against (`56 / 70`; `—` before any score; the score alone where no score decides);
  - the days since its last move.

  A row that waits on its owner — a request for more, a failed intake (`takesRevision`) — is marked `waits on you`: the page's notification of a decision (D3). An empty list says so, and the help says how to start one: open a section and use `Suggest a change`.
- **A curator** also sees `Curator queue`: how many suggestions wait in the queue for their parts (`curatorQueueCount`, a count of the queue by part, never of anyone's suggestions), and `Open the queue`. The link goes to `/[lang]/improve/queue`, 53b's page, the not-found page until it is built.
- **Invariant 26**: no query counts suggestions by person. The list is the visitor's own; the queue's count is by part.
- **Strings**: `improve.home.*`, candidates in both languages; the class names are the Rubric page's.

Verified:
- **The door's suite** (`tests/integration/improve.test.ts`): a person's own list in its order, nobody else's, with its anchors; the queue's count growing by one for the part a suggestion entered, and by nothing for another part, a contributor or a curator of no part. 19 of 19.
- **The browser spec** (`tests/e2e/improve.spec.ts`), 6 of 6, axe on each:
  - signed out in EN and PT: the head, the rubric's link, the sign-in link returning to the page, no list;
  - a contributor in EN and PT: their new draft first, linked to its edit page;
  - a reader: no notice, no list;
  - a curator: the queue's line and link beside their own list.
- **The truncation suite**: signed out and a contributor's list, at 1440 and 390, nothing truncated.
- **The rest**: the database suite, purge excluded, 197 files and 2,115 tests passed, none failed; `npm run lint`, `npm run build` exit 0; the secrets scan 0 findings.

## 11. As built (unit 52b, part 1: the adjudication page, 2026-10-08)

`/[lang]/improve/[suggestionId]` is built, per request, as § 4 has it for what a decision shows; what a contributor does next from it is part 2.

- **Who sees it**: the loader (`lib/db/improveOutcome.ts`) reads the suggestion as `GET /suggestions/{id}` does (`readSuggestionView`): its owner, and a curator of one of its parts once it is past draft. Anyone else, a signed-out visitor, and an id that is none get the not-found page. The owner's draft goes to its edit page.
- **The layout is the screen's**:
  - the edit page's context strip (`suggestionContext`, shared with it), with the suggestion's id and no draft mark;
  - the header: `adjudication · S-… · submitted … · decided …`, and the anchor as the title (a section's id and title, a figure's id and label, a row's id and claim);
  - **Decision** beside **Anchor**; **Reasons** across; **Sensors** beside **What would suffice**; the actions.
- **The variant** (`lib/improve/outcomeView.ts` `variantOf`) is one of: in progress, waiting for budget, declined, request more, request more by rule, with a curator, accepted (merging and merged with it), closed. A decline is the intake rules', a sensor's or the adjudicator's (`declinedBy`). The variant decides the badge and the box's colour, the mono line, the sentence and which action is primary.
- **Decision**: the score as the big number, the badge, `floor · accept`, the mono line and the sentence. Its footer names who decided (`intake rule`, `router`, or the adjudicator's model), the tokens the `DECIDED` record's usage adds up to, and the record's short hash (`rec#a91f·20d6`).
- **Anchor**: the quote, and before and after by the proposal's kind (`changeOf`). Under them, the evidence as graded, each item with its tier, its arithmetic and how it was read, in the edit page's words.
- **Reasons**: one line per criterion, from the adjudication. **Sensors**: each verdict with its note, a failing row marked. **What would suffice**: the scoring's `wouldSuffice`, or tier A for the derived class; absent when nothing is asked.
- **While deciding** (in progress, waiting for budget): the page reads `GET /suggestions/{id}` at the suggest form's interval (2 s, `EVIDENCE_POLL_MS`) and redraws when the state or the decision moves. A hidden tab does not read.
- **Actions**:
  - `View full record`, to 52c's address (the not-found page until 52c), primary when accepted;
  - `Back to <section>`;
  - the override note.
- **Strings**: `improve.outcome.*`. EN is from the screen where it gives the words; the rest are candidates in both languages.

Part 2 adds what part 1 leaves out:
- `Revise with new evidence` and the edit page's revision state (31 § 6.5). Today the edit page sends anything past draft here.
- The right column, `also yours · open`.
- The throttle box.
- The curator's line with the part and the deadline's date, and the coded reason of a curator's decline.
- The sensors' notes in the reader's language. Part 1 prints each sensor's own sentence (`detail`, English, hashed into the `sensors` record) and does not word their `data`.

Found while building:
- **`vv1.0.0`**: the anchor sensor's sentence printed two `v`s, because the release stores a chapter's version with one. This is fixed for new suggestions. The seed's records keep the sentence they were given.
- **`93% %`**: a figure's value prints its unit twice, here and on the edit page alike. 925 of the release's 2,201 figures keep the unit in the value as well, and 19 labels are cut (`(derive`). The anchor's text is hashed into every draft, so this is recorded for a unit of its own (tracker, Known defects).

Verified:
- **`lib/improve/outcomeView.test.ts`**, 6 of 6: the variants, who declined, the short hash, and the change by kind. Also the anchor sensor's version case.
- **The browser spec** (`tests/e2e/improve.spec.ts`), 7 of 7: a draft's own page goes to its edit page; a reader, a signed-out visitor and an id that is none get the not-found page. Nothing is submitted, since a submitted suggestion is a record the database keeps.
- **By hand, against the worked examples** (§ 9.1, `npm run improve:seed`):
  - `S-23-0009`, declined at intake, matches the screen's main column: `declined at intake before any model call`, `intake rule · 0 tokens`;
  - `S-15-0009` and `S-22-0009` request more, the second by rule, `tier A only`;
  - `S-28-0009` is accepted;
  - axe finds nothing on each in EN, nor on `S-15-0009` in PT;
  - another contributor and a signed-out visitor get the not-found page.
- **Not yet in the truncation suite**: the page needs a decided suggestion, which no suite makes. PT was checked by hand at 1440.
- **The rest**: the database suite, purge excluded: 198 files and 2,122 tests passed, none failed. `npm run lint` and `npm run build` exit 0; the secrets scan finds nothing.

## 12. As built (unit 52b, part 2: revising with new evidence, 2026-10-08)

What the owner does from the page, and its right column. Unit 52b is complete.

- **`Revise with new evidence`** is the primary action wherever the suggestion takes a revision (`takesRevision`: declined at intake, or asked for more in `DECIDED` or the queue), for its owner only. It opens the edit page in its revision state (31 § 6.5):
  - the strip reads `revision · not submitted`, and the status bar `revision`;
  - step 2 shows the change as submitted, read-only, with the sentence that a different change is a new suggestion (`ProposalFixed`);
  - the evidence and the rationale are written as a draft's are, which the endpoints already allowed in these states;
  - `Submit the revision` saves every field first, as Submit does. Its `POST …/submit` signals the running workflow (`revised`), which runs the steps again as the next attempt.

  Any other suggestion past draft still sends its edit address to its own page.
- **The page follows a revision.** Where the suggestion waits on its owner, the page reads itself for a minute after it loads, so a revision just sent is seen taken up. In progress, it reads until a decision, as before. Each read compares the state and the decision's time (`refreshKeyOf`), because a revision under way keeps the earlier attempt's decision in its row.
- **The right column** is the owner's only, absent for a curator reading another's suggestion; 472px, as the screen draws it:
  - `also yours · open`: the owner's most recently submitted other open suggestion, past draft and not ended (`latestOwnOpenSuggestion`). It is compact: its id linked to its page, its badge, its chapter and section with when it was decided, the anchor's text and the change, the score against the acceptance with a meter and the strongest item, and a derived request's box;
  - the throttle rule, with the owner's own count by the throttle's own query (`ownUnverifiableDeclines`), and of a decline whether it counts (`S-23-0009 was graded G, not U. It does not count.`);
  - what the adjudicator saw, where the adjudicator decided, with its guide and rubric.
- **A derived figure's request for more** (`request more by rule`) shows the screen's request, `A tier A run on Lab 22 with the change applied.` In place of the lab button, it says that the button comes with the IDE and that a curator inspects the request until then.
- **With a curator**, the line names the parts (`part iii`) and the queue's deadline. The deadline is spec 36 § 3.1's (A15), counted from the decision that queued the suggestion (`queueDeadlineOf`; `QUEUE_DEADLINE_HOURS`, which unit 53a reads too).
- **Closed by a curator**, the line ends with the action's coded reason when there is one (`latestCuratorDecision`: the action, the code and the criterion, never the note, D4).
- **Fixed from part 1**:
  - an adjudicator's or a rule's decline that ends in `CLOSED` read as a curator's close; `variantOf` now tells them apart by the decision;
  - a revision under way read as its earlier decline; it now reads as in progress, drawn with no decision.
- **Not built**: the sensors' notes in the reader's language. The page prints each sensor's own sentence in English, as the record holds it. Wording the notes from their facts needs those facts in the suggestion's read, which the API does not carry, and a sentence for each sensor and outcome in both catalogues. This is recorded for Andre (tracker, Known defects and limits).

Verified:
- **`lib/improve/outcomeView.test.ts`**, 12 of 12: the two variant fixes, the deadlines, and whether a decline counts.
- **The door's suite** (`tests/integration/improve.test.ts`) gains one case: the owner's latest other open suggestion, their own count, and the curator's code without the note.
- **By hand, against the worked examples** (`npm run improve:seed`):
  - the revise action on `S-23-0009`, `S-15-0009` and `S-22-0009`, and not on `S-28-0009`;
  - the right column on each, and `S-22-0009`'s request;
  - the edit page's revision state; `S-28-0009`'s edit address goes to its page;
  - another contributor gets the not-found page on both addresses;
  - axe finds nothing in EN or PT.
- **A revision end to end on the development engine**, free: `S-21-1254`, declined at intake with its one item U, was revised with one more unopenable link. Its page followed the run to a second decision by rule; the second attempt's four records follow the first's; no model was asked. The seeded examples cannot be revised by hand: the seed ran their workflows on the test server, so the engine has none to tell, and the submission answers 409.
- **The rest**: the database suite, purge excluded: 198 files and 2,129 tests passed, none failed. The browser specs `improve` and `suggest`: 21 of 21. The truncation suite passed. `npm run lint` and `npm run build` exit 0; the secrets scan finds nothing.

## 13. Review of units 51e, 52a and 52b (2026-10-08)

One review for the three units, three lenses (correctness, access, house rules): 19 findings. The skeptics of all three lenses died on the network outage, so each finding was checked by hand against the code. 12 were real and are fixed in one commit:
- **A suggestion the router queued for a curator read as in progress, and its page read itself every two seconds without end.** The router writes no decision row (33 § 6.1), and a curator's decision moves the suggestion without rewriting it (33 § 6.3), so `variantOf` now takes the suggestion's outcome as the decision that stands and the row only for who decided. The footer says `router · 0 tokens` where no row was written. The test that had a router write a row now has the intake rules write it, as they do.
- **Submit could send the older text** (51e): when a field's save returned while newer text waited, the autosave said `saved` for the older body, and Submit's wait for every field ended there. A body the fields have moved past is no longer said `saved` (`lib/hooks/draftSave.ts`); the newer one's own save says it.
- **The page missed a wait at the budget cap**, which begins and ends with the state unchanged: `refreshKeyOf` now includes `budgetResetsAt`.
- **A row's edit of its link, DOI or date showed an empty `after`**: `changeOf` now lists every field the edit changes.
- **The throttle note could read `graded U, not U`** with an item still pending; it now says nothing until every item is graded.
- **The book's text without its language**: `AnchorChanged`'s two texts and the Anchor's `before · current` cell now carry `lang`.
- **The verdict was never announced**: the Decision's body is a polite live region, so the page's redraw with a decision is read out.
- **The decision's time without its date** when it was decided on a later day than it was submitted.
- **The meters**: a ticked place shared by a derived figure's floor and acceptance no longer gives two siblings one key (`Meter`, for every caller), and the compact score has no meter where no threshold decides the class.
- **A suggestion with a curator** takes `--warn`, as ui-context says; under way and closed stay neutral.
- **The page's language alternates** in its metadata, as every page has.

Recorded, not fixed (tracker, Known defects and limits):
- **The throttle counts the evidence as it is now.** An owner may add or remove items on a declined suggestion that takes a revision without resubmitting it, which can take a decline out of the count (#9). This predates this unit: the endpoints took those edits since 49e and 50e.
- **The landing page's `days since its last move`** runs from the decision a revision answered, since a revision's return to `SUBMITTED` sets no time the row keeps (#7).
- **The edit page's `n of 20 submitted in 24 h`** counts suggestions submitted, while the limit is the submit endpoint's token bucket, which refusals, retries and revisions also spend (#8).

Refuted or not real: a curator's accept of an item under the acceptance, and the line `accept 0` for a curator-always class (#5's further cases) are reachable only once unit 53c records a curator's action, and belong to that unit; the meter of the edit page's score before any grade (`score ?? 0`) reads zero points graded, which is what the column prints in its arithmetic.

## 14. As built (unit 52c, part 1: the record page, 2026-10-08)

`/[lang]/improve/[suggestionId]/record` and `GET /api/v1/suggestions/{id}/record` are built, per request, for the audience before a merge; the export and the public read once merged are part 2.

- **Who sees it**: the suggestion's own audience, as its read has it: its owner, and a curator of one of its parts once it is past draft (D2). Anyone else, a signed-out visitor and an id that is none get the not-found page. A draft has no record yet, so its record's address goes to its edit page.
- **The layout is the screen's**:
  - the header: `suggestion record · S-… · contributor <who> · identity verified`, and the anchor as the title (the decision page's, `anchorTitleOf`);
  - **Change**, **Decision** and **Evidence**, at 1.35 to 1 to 1. Change shows the anchored text, the value or text before struck through and after, and the class. Decision shows the score against the acceptance in its outcome's colour, the badge, the floor and whether every sensor passed. Evidence shows each item as the decision page shows it (`EvidenceStatus`, now shared);
  - **Record**, hash-chained, one entry a record in chain order: when, the title, who acted, what the record says, and `prev … · hash …` in the 12-character form (`ledgerLine`), the last marked `head`. Markers: open for a submission, the verified colour for an accept, a curator's approval and a merge, the failure colour for a decline;
  - the rail at 440px: Version, Lab gate, Source row (for a row's suggestion) and Credit, which the merge fills (spec 37) and which before it read `not merged`; and **Chain integrity**.
- **The presenter** (`lib/improve/record.ts`, `entriesOf`) is one function from each record's payload to its facts: ids, codes, counts and versions, never a sentence, since no payload holds one (invariant 18). The page words the facts.
  - Titles: `Submitted` (`Resubmitted · attempt 2` for a revision's), `Graded`, `Sensors`, `Decided · accept`, `Curator · approved`, `Merged`, `Endorsed`, `Exported`.
  - A curator's note is said only to exist, as its hash.
  - A payload that does not read as its kind is said to be so, with its hash line kept.
- **Actors**:
  - A person appears by display name to this audience, except a contributor whose consent no longer stands and anyone whose account is gone or going, who appear by the ledger's pseudonym (`user:` and the first eight of the id). The names are read for the request (`recordPeople`) and nowhere stored.
  - An agent appears as what it is: `grader · <model> · rubric v1.2`, `deterministic · 4 sensors`, `adjudicator guide v2.1 · rubric v1.2`, `intake rules · rubric v1.2`, `router · rubric v1.2`.
- **Chain integrity** is computed on the request (`checkedView` in `lib/db/ledger.ts`). It runs `verifyView` over the suggestion's records, each with its chain predecessor read back so the walk crosses the gaps where other records sit, and the two neighbours outside the view. It reads `chain verified · 8 records · head dae20bf8e780` and `recompute 100% · 8 / 8 links match`, or, in the error state, the first break's record and field. It is never cached.
- **`GET /api/v1/suggestions/{id}/record`** (`lib/api/endpoints/record.ts`): the records with their payloads and hashes, and the same chain check. A person is their pseudonym here, as in the ledger. The audience and the rate are the suggestion's read's.
- **Strings**: `improve.record.*`, candidates in both languages; ids, versions, hashes and codes are never localised.

Verified:
- **`lib/improve/record.test.ts`**, 6 of 6: each kind's facts from the fixtures' payloads, the attempts, the markers, the names and pseudonyms, the curator's note as a fact of existence only, an unreadable payload.
- **By hand, against the worked examples**:
  - each of the four reads its four records with its outcome's words, and `chain verified · 4 records` with `4 / 4 links match`;
  - the JSON read answers the four records with the chain;
  - `View full record` on the decision page lands here;
  - `S-21-1254`, revised once, reads eight records, `Resubmitted · attempt 2` among them, and its chain is verified across the 740 records between its attempts;
  - axe finds nothing in EN or PT;
  - another contributor and a signed-out visitor get the not-found page, on the page and on the JSON read.
- **The browser spec** adds the record's addresses to the own-page case: a draft's goes to its edit page and its JSON read is empty; a reader and a signed-out visitor find nothing.
- **The rest**: the database suite, purge excluded: 199 files and 2,140 tests passed, none failed. The browser spec `improve`: 7 of 7. `npm run lint` and `npm run build` exit 0; the secrets scan finds nothing; the OpenAPI document regenerated, 33 paths.

## 15. As built (unit 52c, part 2: the record's export, 2026-10-08)

Unit 52c is complete with this part.

- **`GET /api/v1/suggestions/{id}/record/export`** (`lib/api/endpoints/record.ts`): the ledger's JSONL in its `suggestion` scope with the signed trailer (`exportJsonl`), as an attachment (`hb-suggestion-S-….jsonl`), at the conversation export's rate (`EXPORT_RATE`, now shared). The audience is the record's.
- **The export is a record of the suggestion's own.** The `EXPORT` record it appends carries the suggestion's id, so it joins the suggestion's view: the record page shows it as `Exported`, and the next export carries it. A conversation's export carries none, since a conversation has no column in the ledger. Its payload is a conversation export's: the scope, the span, the count, the head and the file's sha256.
- **A draft has nothing to export**, which the endpoint says (`NOTHING_TO_EXPORT`, 404) before it asks for the key, so the answer is the same on a deployment without one. Without the platform key nothing is exported, and the person reads `INTERNAL`, as with a conversation's export (14 § 7).
- **The rail's `Export record`**: a plain anchor, since a prefetched link is followed and this one records an export, with `JSONL with hash chain · n lines` (the records and the trailer). It is absent while there is no record.
- **What part 2 leaves to spec 37**, as § 5 has it:
  - the rail's Version, Lab gate, Source row and Credit, which the merge fills and which read `not merged` until then;
  - the record's public read once merged, which the chapter's history links to. No suggestion can be merged until spec 37's units, so it is built and tested with the merge.

Verified:
- **`lib/api/endpoints/record.test.ts`**, 4 of 4, the rows and the pipeline doubled:
  - the declaration;
  - the file as an attachment, and the `EXPORT` record in the suggestion's view with the file's hash;
  - the not-found answer for anyone the read refuses, with nothing recorded;
  - a draft's `NOTHING_TO_EXPORT` before any key is asked for, a record-less suggestion's, and `INTERNAL` without the key.
- **Live, on the development server**: `S-21-1254`'s export answered its signed JSONL. The ledger's own `verifyExport` with `infra/ledger/export-public.pem` found it valid: eight lines, the signature valid, the chain intact, matching its trailer. The record page then read nine records, `Exported` the last, with the chain still verified. Another contributor got the not-found answer.
- **The browser spec**: a draft's export is `NOTHING_TO_EXPORT`, and a reader's is the not-found answer.
- **The rest**: the database suite, purge excluded: 200 files and 2,144 tests passed, none failed. The browser spec `improve`: 7 of 7. The truncation suite passed. `npm run lint` and `npm run build` exit 0; the secrets scan finds nothing; the OpenAPI document, 34 paths.

## 16. Review of unit 52c (2026-10-08)

One review, three lenses (correctness, access, house rules), each finding checked by one skeptic. It made eight distinct findings; the export's was found by two lenses. Six were confirmed and are fixed in one commit, and two were refuted.

- **The chain check vouched for a rewritten record whose next record lay outside the view** (medium). `checkedView` linked each record of the view to its predecessor, and only the last to the record after it. A record rewritten with a fresh hash, its own link kept, still passed when its successor was not the view's.
  - **Fix**: each record whose next record lies outside the view is now held to that record's link (`linksAt`; `verifyView`'s `successor`), so a rewrite breaks at its successor. A successor the chain lacks is named too.
  - **Limit**: a record deleted from the view leaves no trace in the view itself. A walk of the range finds it, and the record page does not make one; this is recorded in the tracker (Known defects and limits).
- **The export was a GET that wrote** (medium). The origin check held only mutations, so another site could have a signed-in owner's or curator's browser fetch the export, adding a permanent `EXPORT` record in their name. Next also answers HEAD with the GET's handler, so a HEAD recorded an export of a file nobody received.
  - **Fix**: a spec may now say it writes (`writes: true`). The pipeline holds such a GET to the origin check and answers HEAD with 405 (`METHOD_NOT_ALLOWED`).
  - The record's export and the conversation's (17 § 6), which shared the pattern, both say so. The record page's own link is the site's own and downloads as before.
- **A submitted suggestion with no record yet answered 500 without the export key, and 404 with it**: the key was read before the export learnt there was nothing to sign. The record count (`countView`) is now asked first, so the answer is `NOTHING_TO_EXPORT` either way, as a conversation's export answers.
- **The book's text without its language, and a PT word marked English.** Change's proposed text had no `lang`, and the heading marked the whole line, `Figura` and `Linha` included, with the edition's language.
  - **Fix**: the anchored text, the before and the after are the book's English, which the anchor holds whichever edition the page serves, and are now marked `en`.
  - The heading keeps the page's language and marks only the book's text in it: `<book>` in `improve.outcome.title`, rendered with `t.rich`. A section's title takes the edition's language.
  - The decision page and the queue's Change had the same pattern and are fixed with it. The catalogue test formats a string that marks part of itself with its tag kept (`t.markup`).
- **No record yet read as verified.** A suggestion submitted before its workflow wrote its first record showed the verified mark beside `no records yet`, and `recompute 100% · 0 / 0 links match`. It now shows the mute mark and no count.
- **The export's classes were missing from ui-context**: `.record-export` and `.record-export-button` are now in the record page's row, with the chain line's three marks.

Refuted:
- An export's records growing a suggestion's view without limit: each is a true record made by the suggestion's own audience at the rate § 5 set, and the other-site part is closed by the second fix.
- A researcher's suggestion crediting `service:researcher` as its contributor: nothing creates one before unit 59b.

Verified:
- **`lib/ledger/verify.test.ts`** gains the successor's case:
  - a rewritten record whose predecessor is intact breaks at the record after it;
  - a successor that is missing, or at another seq, is named;
  - the last record's successor is the neighbour after it.
- **`lib/ledger/display.test.ts`** gains `hashLine`'s case: the module is at 100 % on every measure.
- **`lib/api/endpoints/record.test.ts`** gains two cases:
  - another site's page and a HEAD are refused, and nothing is recorded;
  - a submitted suggestion with no record, on a server without the key, gets `NOTHING_TO_EXPORT`.
- **Live, on the development server, as the check curator**:
  - the export was refused to another site's page (403) and to a HEAD (405), and nothing was recorded;
  - the record page's own link downloaded the export and recorded it;
  - the chain of S-21-1561 verified across its gap;
  - on PT pages (the record page, the decision page and the queue), the heading's `Figura` and `Linha` kept the page's language, with the book's text marked English, as Change's texts were;
  - axe found nothing.
- **The rest**:
  - the database suite, purge excluded: 204 files and 2,177 tests passed, none failed;
  - the browser spec `improve`: 8 of 8;
  - the truncation suite passed;
  - `npm run lint` and `npm run build` exit 0, and the secrets scan finds nothing;
  - the OpenAPI document is unchanged, at 36 paths and 41 operations: the flag is the pipeline's, not the contract's.
