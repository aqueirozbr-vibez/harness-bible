# 34 · The suggest form — feature spec (the Improve classes, the anchor step, the proposed change, evidence grading live, the score and the submission)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: `docs/design/screens/Improve-Suggest.html` and its PNG (layout, every string, the states it shows), `Components.html` (the Improve empty state and the three error states), `hb.css` (the classes); overview § Core user flow step 10 and § Features · Improve — contributor; architecture § 3.1 (`components/improve/`), § 3.2, § 6.4; `context/ui-context.md`.

Prerequisite specs: `31` (the draft's endpoints), `32` (evidence), `30` (the score, the prediction), `29` (roles).

Scope: tracker unit 51 (51a to 51e). The pages a contributor writes a suggestion on. Not here: anything the form calls (31, 32), the outcome page (35).

## 1. Purpose

The form's job is to make a weak suggestion visible to its author before it costs anything: the class and its thresholds as soon as the anchor is chosen, each item's tier and arithmetic as it is added, the score, and the sentence that says which evidence would be enough. A contributor who reads `request more · short by 4` and adds the missing item has saved an adjudication and a curator's time.

## 2. Dependencies and order

| Unit | Delivers |
|---|---|
| 51a | the classes of `hb.css` the Improve screens use and `globals.css` lacks, ported once for specs 34 to 36, with `ui-context.md` |
| 51b | the entry route and the anchor step |
| 51c | the edit page: context strip, anchor column, proposed change, class panel |
| 51d | the evidence list, grading live |
| 51e | the rationale, the live score column, consent, submit; the states |

## 3. The classes (51a)

Rules § 3.4 and § 5: a new component class ships first, with its `ui-context.md` entry, and no existing class is restyled. 51a reads the seven Improve screens' markup against `globals.css`, lists every class they use that is missing (the evidence tier badges `ev ev-a … ev-u`, the block badges, the context strip, the evidence item row and its grading state, the band meter with floor and accept ticks, the timeline's markers, the queue's group rows, among others), and ports those from `hb.css` unchanged. The list is the unit's report. Nothing is designed here: a class the screens do not use is not added.

## 4. Routes (51b)

The TRD writes the form's address as `/[lang]/ch/[n]/@improve/new?anchor=`, the notation of a parallel slot, and the reader's "Suggest a change" link was built with that text literally in its URL, which no route answers. The screen is a full page with its own context strip and a "back to 15.9" link, not a panel beside the chapter. So:

| Address | What |
|---|---|
| `/[lang]/ch/[n]/improve/new?anchor=<id>` | step 1: what the change is anchored to and what kind of change it is; confirming creates the draft |
| `/[lang]/improve/[suggestionId]/edit` | the screen: the draft being written |

`components/reader/SectionActions.tsx` links to the first (its only change). Both are RSC pages with client islands, `noindex`, and under 768 px show the "desktop or tablet" notice the architecture gives the Improve routes.

**Amended by feature-specs/48 § 10.1 (unit 76, 2026-10-13), a second way in.** Step 1 is also reached from Improve: the landing page's `New suggestion` (A11) opens `/[lang]/improve/new`, the release's chapters by part, then `?ch=NN`, the chapter's sections (the outline's layers), each a link to step 1 at that section, `/[lang]/ch/NN/improve/new?anchor=NN.k`, where the person picks the section, one of its figures or a source row as before. Step 1 is unchanged, and the reader's `Suggest a change` still goes straight to it. The notices of § 7 for a role that does not draft, an unverified identity and the throttle are one component, `SuggestGateNotice`, which step 1, the chooser (at its top, in place of its lists) and a research finding's block render alike (48 § 8.1, § 18).

**Step 1.** The anchor arrives preselected from the reader (`anchor=21.3`). The page shows the screen's left column: the segmented control `Section | Figure | Source row`, the list for the chosen kind (the section's figures; the chapter's source rows with `row · entry · tier · checked`), the anchored text at the current version with its chips, and "Read by …" when other anchors read it. For a section a second control picks what is proposed (edit a passage, add a claim, add a source row, restructure): the screen has no such control, because its example is a source row; the strings are candidates (§ 8). A button creates the draft (`POST /suggestions`) and goes to the edit page. Nothing is stored before that.

## 5. The edit page (51c, 51d)

Layout as the screen: top bar; the context strip; three columns, 392 px, the form, 376 px; the status bar. All numbers on it come from the draft's `GET`.

- **Context strip**: back to the section, the chapter and version, the anchor, the stale mark when the anchor is past 90 days, the id, `draft · not submitted`.
- **Left**: the anchor, read-only now (a different anchor is a different suggestion), and the **Change class** panel: the class, `accept at or above`, `decline below (floor)`, `recency factor`, `curator always`, and `detected from anchor type and value type`.
- **2 · Proposed change**: by change kind. `SET_VALUE` and a row's value: `before · current` (read-only, struck through), `after · proposed`, `unit`, and the line `$0.30 → $0.25 per million tokens · −16.7%` with the help about derived figures that read the row. `EDIT_TEXT`: the passage picked from the section's text and its replacement. `ADD_CLAIM`, `ADD_ROW`, `RESTRUCTURE`: their fields (spec 31 § 4). A change of the proposal that moves the class (spec 30 § 4.2, rules 3 and 4) updates the class panel and says why in one line.
- **3 · Evidence items** (51d): each item as the screen draws it. Graded: ordinal, kind, title, publisher and note, the tier badge with its accessible name, the score, the arithmetic, `opened · 200 · 12 days old`, `Remove`. Grading: dashed, `aria-busy`, the loader with the stage (`grading ▮▮▯ 2 of 3`), `Cancel`. The corroboration row when one applies. `add evidence`: `+ Link`, `+ DOI`, `+ Upload`, and `+ Saved lab run` shown disabled with "arrives with the IDE" (candidate). The help line about `U`.
  The list refreshes from the draft while any item is pending, at the interval of D2, and stops when none is.
- **4 · Rationale**: the textarea, the help, the counter `142 / 200 words` from the shared word count. Over 200 the counter turns to the error state and Submit is disabled, and the server would refuse anyway.

Autosave: a change is saved after the pause of D3, and on blur; the status bar's right cell reads `autosaved 14:02:31`. `Save draft` saves at once.

## 6. The live score and submission (51e)

Right column, as the screen:

- **Score**: the big number, `accept ≥ 70`, `floor 25`, the meter with its accessible sentence, "how it is computed", the rows naming the strongest item, the corroboration, an item that was not added and why, an item still grading, and the total line.
- **Predicted outcome**: the badge (`request more · short by 4`, `accept`, `decline · under the floor`, `curator always · no score decides`), the sentence, the `would suffice` box from `wouldSuffice`, and the footer while an item is grading.
- **Identity**: the contributor's name with `verified`, and the help: "The adjudicator sees only verified or unverified. Your name and employer are not passed to it."
- **Consent**, once, when `provenanceConsentAt` is null: a checkbox whose label says the name is kept with the change for provenance (candidate).
- `Submit for grading` (primary) and `Save draft`; the meta line with the save time and the day's count of 20.

Submit calls `POST …/submit`. On 422 the page shows the sensor's own message beside the field it concerns, in the Components screen's error form (`anchor not found · intake sensor`, with `Choose an anchor`). On success it goes to `/[lang]/improve/[id]` (spec 35).

The page computes nothing it shows: every number is the server's (architecture § 3.1: "the server recomputes").

## 7. States

| State | The page |
|---|---|
| signed out | redirect to sign-in with `next` |
| a reader or builder | a notice: what a contributor is, and that the role is given by the organisation or the editorial team (candidate); no form |
| a contributor not verified | a notice: identity is verified through the sign-in provider; no form |
| throttled | the notice with the date and the reason; drafts readable, nothing new |
| no evidence yet | the Components screen's empty state adapted to the list |
| an item unreachable | the `link could not be opened` error with `Replace evidence` |
| grading at the budget cap | the item pending with the gateway's message and reset date |
| the draft's anchor changed in a new release | a notice with the old and the new text and `Choose an anchor` |
| workflows unavailable on submit | the error naming that nothing was submitted |
| under 768 px | the "desktop or tablet" notice |

## 8. Strings

`messages/{en,pt}.json`, namespace `improve.suggest.*`. EN strings are the screen's, verbatim. Strings the screen does not have are written as EN and PT candidates in the unit's report and marked in the catalogue (rules § 4.6): the section's change-kind control, the disabled lab-run note, the consent label, the role notices, the class-changed line. PT follows the catalogue's voice and the 30 % budget; the two pages join the truncation suite's list.

## 9. Out of scope

- Opening a lab from the form ("Open Lab 22 with this change").
- A rich-text or diff editor for prose; the passage and its replacement are plain text.
- The phone layout.

## 10. Decisions this spec needs

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | The form's address | `/ch/[n]/improve/new` then `/improve/[id]/edit` | § 4; the draft has an id from the start, so the page that edits it should carry it |
| D2 | Refresh interval while an item grades | 2 s | a grading takes seconds; the search page's own budget is 500 ms and a fetch's deadline 20 s, so 2 s shows each of the three stages without hammering the endpoint. A number: Andre's to confirm |
| D3 | Autosave pause | 1 s after the last keystroke | the same class of number |
| D4 | The section's change-kind control | add it | a section can be edited, extended or restructured, and the class depends on which |

## 11. Verification (in addition to `ai-workflow-rules.md` § 7)

1. 51a: the token grep (rules § 7.5) on the diff; each ported class is byte-equal to `hb.css`; `ui-context.md` lists each.
2. From `/en/ch/15/15.9`, "Suggest a change" opens step 1 with the section preselected; choosing a source row and confirming creates `S-15-NNNN` and lands on the edit page.
3. The edit page against the PNG at 1440: structure, labels and status-bar cells; every deliberate difference listed (the day's count; the disabled lab-run control; the consent control).
4. Adding a link shows the grading state with stages and then the graded item; the score and prediction change without a reload; the numbers equal `GET /suggestions/{id}`.
5. A rationale of 201 words disables Submit; the API refuses the same payload.
6. A successful submit lands on the outcome page; the suggestion is `SUBMITTED`.
7. Each state of § 7 reached and seen; keyboard only: every control reachable in order, the segmented controls by arrow keys, the dialog-free flow.
8. Zero axe violations at 1440 in EN and PT; the truncation suite passes with both pages added; a Playwright flow `suggest` joins `tests/e2e/` for the contributor account.

## 12. As built (unit 51a: the classes, 2026-10-07)

Nothing was ported: every class of `hb.css` the seven Improve screens use is already in `globals.css`. The list § 3 asks for is empty. The components it names are either ported classes or drawn by the screens with inline styles.

- **How it was read**: each of `hb.css`'s 199 selectors was matched against the seven screens' markup in Chromium and looked up in `globals.css` without the `.hb` scope. 158 match an element of the screens, and each of them is in `globals.css`, except the scope itself (there `:root` and `body`) and the element resets that Tailwind's preflight makes. The screens use 115 class names, all `hb.css`'s, and every one is in `globals.css` except the `.hb` wrapper. The tokens are equal: 34 light, and 23 dark in both of the dark blocks; the two font stacks differ only by `next/font`'s variables (ui-context § 13.1). No class is set by a script.
- **Read again, independently**:
  - four readers of the screens found no class missing;
  - a skeptic went through all 199 selectors of `hb.css`'s 182 rules (it has no media blocks), in their compound, descendant and state forms, and raised four candidates, each refuted by a reader of its own;
  - the 66 classes named by ui-context § 6, § 7, § 9.4, § 9.6 and § 13.3, by specs 34 to 36 and by the Components screen's Improve states are all defined.
- **Where § 3's components are**:
  - ported: the evidence tier badges (`.ev .ev-a … .ev-u`, `.ev-lg`; ui-context § 7), the block badges (`.st-block .sb-*`; § 6) and the timeline's markers (`.tl-m i.o i.v i.f`; § 9.4);
  - inline `style=""` in the screens, as Book Home's and the assistant's were (66 to 223 elements a screen): the context strip, the evidence item row and its grading state, the band meter with its floor and accept ticks, the queue's group rows and the pages' column grids. Each becomes a composition class in the unit that builds its page — 51b to 51e the suggest form, 52a to 52c the landing page, the adjudication and the record, 53b the queue — listed in ui-context § 9.9 as it is made.
- **What the pages will meet**: the port differs from `hb.css` in places, by decisions of earlier units, now listed in ui-context § 13.2; each page's screen match lists the ones it shows. Two would change what an element is:
  - in the app `.dock` is the assistant's fixed dock, so Improve-Adjudication's `aside.dock` (the other open suggestion) takes a class of its own in 52b;
  - `.tree` is the reading paths' indented list in `--ink-3`, so Chapter-History's layer tree takes its own in the unit that builds that page.
- **The documents**: ui-context § 3.1 gave `.tex` hb.css's opacity .8, which the port dropped on 2026-09-22 for contrast. It now says so, and § 13.2 has the table.

Verified: the token grep of rules § 7.5 on the diff matches nothing, and `globals.css` is unchanged, so § 11.1's other two checks hold with nothing ported; `npx tsc --noEmit` exit 0; `npm run lint` exit 0, no warning; with the database, purge excluded, 188 files and 2,029 tests passed, 17 skipped.

## 13. As built (unit 51b, part 1: the route and the anchor step, 2026-10-07)

`/[lang]/ch/[n]/improve/new?anchor=<id>` is built: step 1 is the screen's left column on a page of its own, under the chapter context strip. Part 2 is the draft's creation: the section's change-kind control (D4) and the button that creates the draft (§ 4).

- **The address says what is chosen.** `anchor` is the chosen anchor. For a row, `from` is the reader's section, whose figures the page lists; a section's and a figure's lists are their own section's, whatever `from` says (§ 15). Every choice (a kind, a figure, a row) is a link. So the loader (`lib/db/suggestStart.ts`) resolves one anchor at a time, with the create endpoint's own `resolveAnchor`. It reads the lists with the reader's `getChapterData`, for that section and for the chapter's `NN.9`. Choosing a kind chooses something of it: the section, its first figure, or the first row its figures cite, else the chapter's first row. A kind with nothing to choose is a disabled link, with a line that says why.
- **The kind control** is `.seg-links`, the current kind marked `aria-current` (§ 11.7; `components/improve/SegLinks.tsx`). It is one stop in the tab order: the arrow keys move it between the kinds, and it returns to the current kind when focus leaves, as a tab list's does. Enter follows. The browser's own chords (Alt+Arrow) are left alone.
- **The anchored text** is what a draft would store: the source edition's text, a figure's `label · value unit`, or a row's `claim — citation`. It carries its tier chip (`ven vendor · 21.9 r1`) and its fast-moving or stale mark. When something reads it, "Read by …" follows, each section a link. A section shows its id and title, not its whole text: the passage is chosen on the next step.
- **The states of § 7 the step meets are built here**, since this page is where a visitor arrives:
  - signed out: the sign-in, with `next`;
  - a reader, a builder or an organisation admin: the role notice;
  - an unverified contributor: the verification notice;
  - a throttled contributor: the throttle's date and reason.

  `suggestGate` (`lib/improve/suggest.ts`) asks them in the create endpoint's order. It only spares a person a form the endpoint would refuse; the endpoint still decides. Under 768px the page was the "desktop or tablet" notice, its title the page's heading; since § 16 the step renders at every width. A missing anchor, or one not in the release, is the Components screen's `anchor not found`, whose `Choose an anchor` opens the chapter; an id of no anchor's form is not repeated back. An anchor of another of the book's chapters redirects to that chapter's page; one past chapter 40 is not found here.
- **The reader's link** is `/[lang]/ch/NN/improve/new?anchor=NN.k` (`suggestStartHref`); it was the slot text `@improve`.
- **Deliberate differences from the screen**:
  - the heading is the page's `h1`, where the screen has an `h2`; the page has no other heading;
  - the strip wraps and grows where the screen's is one 44px line;
  - the column stands alone at 392px; the rest of the screen is the edit page's;
  - there is no Change class panel, which is the edit page's (§ 5);
  - the figure list is the reader's figures table (`figure · value · tier`), which the screen does not draw;
  - every "Read by" section is a link;
  - the kind control is a row of links (`.seg-links`), where the screen's is buttons (`.seg`): each kind is an address;
  - the port's differences from hb.css that the page shows (ui-context § 13.2): `.tex` without opacity; the rows that wrap (`.row`, `.between`, `.inst-f`, `.inst-h`); `.st` and `.tbl th` wrapping, the header cell at its bottom; the status bar's minimum height; and the hover language of § 9.10;
  - on the PT page the anchored text, a figure's label and a row's entry are marked `lang="en"`, and the titles carry the edition's language.
- **Strings**: `improve.suggest.*`, EN the screen's wherever it has them. The error's sentence is the Components screen's without "Nothing was graded." and without its `intake sensor` cell: nothing is graded at step 1, and no sensor speaks. The rest are candidates in both languages (the tracker's Open Questions): the notices; a section's anchored form; the lists' counts and their empty lines (`noFigures`, `noRows`); the anchored text's region name; the strip's forms for a section and a figure; and the error for an empty anchor.
- **Composition classes**: ui-context § 9.9.
- **Found, not changed**: a figure's anchored text writes its unit after a value that already carries it (`2% %`). The text is `resolveAnchor`'s (unit 48a), which a draft stores and hashes, so changing it is a unit of its own.

Verified:

| What | Result |
|---|---|
| `lib/improve/suggest.test.ts`, 15 cases | an id's kind by its form; the address, a row's space written `+`; the section the lists are read from; what a kind selects; the gate in the endpoint's order, every role |
| `tests/e2e/suggest.spec.ts`, 5 cases | four in EN and PT, with axe on every screen they reach: from the reader's link to step 1 with 21.3 chosen; the arrow keys to Figure and Enter; a row chosen; an unknown anchor; the reader's notice; the phone's notice. The fifth, in EN only: signed out, to the sign-in and back |
| the truncation suite | its five new screens (section, figure, row, unknown anchor, the role notice), padded PT, at 1440 and 390: no label truncated; a third sign-in, a verified contributor, measures the form |
| by hand | the prose-only chapter 00, both kinds disabled with their lines, one tab stop, no axe finding |
| the whole suite | `npx tsc --noEmit` exit 0; `npm run lint` exit 0, no warning; with the database, purge excluded, 189 files and 2,044 tests passed, 17 skipped, no run left waiting; `npm run build` exit 0, the route `ƒ /[lang]/ch/[n]/improve/new`; `npm run secrets:scan` 0 findings; the token grep of rules § 7.5 finds nothing in the diff or the new files |

## 14. As built (unit 51b, part 2: the draft's creation, 2026-10-07)

Step 1 creates the draft. Unit 51b is complete.

- **What is proposed (D4, taken on the recommendation; Andre was told before the unit and said "next")**:
  - a section offers four kinds, as native radios under a `what is proposed` label: edit a passage, add a claim, add a source row, restructure. These are `EDIT_TEXT`, `ADD_CLAIM`, `ADD_ROW` and `RESTRUCTURE`, in 30 § 4.1's order (`changeKindsFor`), the first chosen. The arrow keys are the browser's;
  - a figure takes `SET_VALUE` and a row `EDIT_ROW`, with no control;
  - the kind is final for the draft, since `PATCH` refuses another (31 § 4), so this is the only place a section's kind is chosen.
- **The button** (`Create draft`, a candidate: the screen has no button at step 1) posts to `POST /api/v1/suggestions` from a client island (`components/improve/CreateDraft.tsx`), as the assistant's dock posts its turns. The handler's limit of twenty a day, its policy and the throttle all apply, because nothing is called around them:
  - the idempotency key is kept for one body. A double click or a retry is the same draft, and a changed choice is a new request, never `IDEMPOTENCY_MISMATCH`;
  - a refusal is the error form with the server's own sentence (the catalogue's, in the page's language by the Referer) and its trace;
  - a request that does not reach the server says so, and that nothing was created;
  - on success the page goes to `/[lang]/improve/[id]/edit`, which answers 404 until unit 51c builds it.
- **Not a server action**, against code-standards' rule as written ("the generated OpenAPI client, never raw `fetch`"). That client does not exist, and a server action reaches `lib/db` after the policy, outside the handler's limit and idempotency. This section says the button posts `POST /suggestions` (§ 4). The rule now records what the dock, the flag button and this button do, for Andre to confirm (code-standards; architecture § 12).
- **The browser spec**: in EN only, since each create spends one of the account's twenty a day. A refusal is faked by intercepting the request; then the kind is chosen by the arrow keys and the draft created, read back through the API (`DRAFT`, `ADD_CLAIM`, `NEW_CLAIM`, `en`) and deleted. In PT, the four labels and the button.
- **Found while verifying**: the development server held a Prisma client from before unit 50f's `budgetResetsAt` (migration `20261007140000`). The create answered 500 until the server was restarted. A migration needs the development server restarted, as the workers already do (Session Notes).

Verified:

| What | Result |
|---|---|
| `lib/improve/suggest.test.ts`, now 16 cases | the four kinds of a section in their order, a figure's one, a row's one |
| `tests/e2e/suggest.spec.ts`, 5 cases | as part 1, with the four kinds and the button in EN and PT; in EN the refusal's error form with its trace, the kind by the arrow keys, the draft created, read back and deleted; a figure's button alone |
| the truncation suite | its five suggest screens at 1440 and 390 with the control and the button: nothing truncated |
| the whole suite | `npx tsc --noEmit` exit 0; `npm run lint` exit 0, no warning; with the database, purge excluded, 189 files and 2,045 tests passed, 17 skipped, no run left waiting; `npm run build` exit 0; `npm run secrets:scan` 0 findings; the token grep finds nothing |

## 15. The review of step 1 (unit 51b, 2026-10-07)

One read-only review of part 1 through five lenses (spec and screen, accessibility, correctness and security, strings, conventions and documents). It found 31 things; each that a refuter checked was confirmed, and the rest were checked by hand. Changed:

- **The language toggle carries the page's query.** It dropped it on every page, which on step 1 lost the anchor (`components/chrome/LangToggle.tsx`; a search's `q` and the dock's `ask` are kept the same way).
- **A section's and a figure's lists are their own section's**: `from` decides a row's alone (`homeSectionOf`). A hand-made address could show one section's text beside another's anchor.
- **The kind control's tab stop** moves with the arrows and returns to the current kind when focus leaves. Before, Tab or Shift+Tab after an arrow landed back in the group. The arrows leave Alt, Ctrl, Cmd and Shift chords to the browser.
- **An anchor past chapter 40** is not found here; it was redirected to a 404. **An id of no anchor's form** is not repeated in the error. **The way back** is checked to be a section the chapter has.
- **On a phone** the notice is inside the page's `main`, its title the page's heading.
- **On the PT page** English text carries `lang="en"`, and titles the edition's language (WCAG 3.1.2).
- **On a touch screen** the kind control's segments and the radio rows are 44px (WCAG 2.5.8, ui-context § 9.1).
- **PT wording**: `no cap.`, `aberta a partir do`, `provedor de login`, and the stale mark and the checked column in the catalogue's masculine.
- **Conventions**:
  - the loader moved from the route to `lib/db/suggestStart.ts`, the route reading params alone;
  - `SegLinks` moved to `components/improve/`, its one feature's folder;
  - the strip lost a prop nothing passed.
- **The records**: § 13's strings, differences and tests, ui-context § 9.9's row (it had fallen outside its table) and its `.seg-links` row (`aria-current`, not `aria-pressed`), the notice's reach, a stale `@assistant`, and architecture § 12's order.

Left for Andre (Open Questions):

- **Zoom (WCAG 1.4.10)**: a desktop zoomed past 200 % has a CSS viewport under 768px and is shown the "desktop or tablet" notice. The rule is this spec's and the architecture's, so it is not changed here.

Recorded, not changed (Session Notes):

- the search page's `.seg-links` sort keeps 32px segments on touch, against § 9.1's 44px.

## 16. Andre's answers of 2026-10-07: "use your recommendations"

Given after the zoom question (§ 15) and D3, and taken to settle the recommendations then open on this spec:

- **D3, the autosave pause: 1 s** after the last keystroke, with a save on blur (§ 5; unit 51c).
- **Zoom (WCAG 1.4.10): step 1 renders at every width.** It is one 392px column, which is the page's width under 768px; a desktop zoomed past 200 % is such a viewport. The edit page's three columns keep the "desktop or tablet" notice (§ 4, § 7). Built the same day: the step's column, strip and status bar render under 768px, and the browser spec checks a phone has the whole step with no sideways scroll.
- **Confirmed as built**: D1, the two addresses; D4, a section's four kinds of change chosen at step 1; and the same-origin `fetch` of the create (§ 14; code-standards).
- **Not yet asked of him**: D2, the refresh while an item grades (2 s recommended), is 51d's, and stays in the tracker's Open Questions until then.

## 17. As built (unit 51c, part 1: the edit page and a figure's value, 2026-10-08)

`/[lang]/improve/[suggestionId]/edit` is built, where step 1's `Create draft` lands. Part 1 is the page, the anchor column with the Change class panel, and step 2 for a figure's value with the autosave of D3. The other kinds' fields are part 2; until then their step 2 is its heading and the kind's caption alone.

- **The read**: the page renders the draft as `GET /suggestions/{id}` answers it. `readSuggestionView`, exported from the endpoint's module, is what the endpoint's read now runs too, so the page and the API share one view: its class, thresholds, proposal and anchor. The loader (`lib/db/suggestEdit.ts`) adds what the strip and the column need from the release: the chapter's and the section's titles, the anchor's tier, fast-moving and stale marks, and a figure's printed value and unit, which `resolveAnchor` now carries (`value`).
- **Who sees what**:
  - signed out, the sign-in with `next`;
  - a draft that is not the person's, or no draft of that id, 404: a draft is its owner's alone, a curator's part or not (`lib/db/improve.ts`), so another's is not read at all;
  - past draft, a redirect to `/[lang]/improve/[id]`, spec 35's page (404 until 52b): the person's own, or since the review (§ 19) one a curator reads;
  - an owner who is no longer a contributor or a curator, § 7's role notice and no form, since the `PATCH` asks the role. Identity and the throttle concern the submission and come with 51e;
  - under 768px, the "desktop or tablet" notice inside `main` (§ 16), between the strip and the status bar.
- **The strip** is step 1's with the screen's right end: `suggestion`, the id, and `draft · not submitted` as a muted `.st-block`, kept together when the strip wraps. The strip now has 8px of padding above and below, so that a wrapped strip's back link keeps its 24px target clear of the top bar (WCAG 2.5.8; axe found it on the PT page at 1440, where the strip wraps). Step 1's strip has the same padding.
- **The anchor column**:
  - the step's head: `step 1 of 4 · anchor`, its title as an `h2`, and a candidate line saying the anchor is fixed with the draft;
  - the anchored text as the draft stores it, its text and hash as at creation, with the release's tier chip and marks. `AnchoredText` moved out of step 1's picker so both pages render it;
  - the **Change class** panel: the class by its Rubric page name; `accept at or above` and `decline below (floor)`, or `no score decides`; `recency factor`, `applies · fast-moving` or `does not apply · stable` by the anchor's fast-moving flag (30 § 3.4); `curator always`, `no` or `yes ·` the reason; and the footer `detected from anchor type and value type`. The screen's `applies · price` names a value type the release does not record; the flag is what decides recency.
- **Step 2 for a figure's value**: the screen's grid. `before · current` is the number as the book prints it, struck through and read-only (`7,500 tokens` → `7500`); then `after · proposed`; then `unit`, starting from the figure's own. Under them, the line prints the new value in the figure's shape, as the merge prints it, with its change: `7,500 tokens → 8,000 tokens · +6.7%`. The printer is `pipeline/edit/apply.ts`'s, moved to `lib/improve/value.ts` so the page and the merge share it. A unit other than the figure's prints as typed, since the merge refuses it as a change of wording. The line echoes the person's input, as § 5's word counter will; no number of the class or the score is computed on the page.
- **The autosave (D3)**: one second after the last keystroke, and at once on blur, `PATCH /api/v1/suggestions/{id}` from the island, as the create posts (code-standards).
  - One request at a time: a change made while one is out is sent when it returns. What the server has is not sent again. What is unsaved when the page goes away goes with `keepalive`.
  - Fields that make no proposal are not sent: the after field takes `aria-invalid` and the schema's own words, `a decimal like 0.25`.
  - The status bar's last cell reads `loaded 0.38 s` until the first edit. Then it reads `unsaved changes`, `saving`, or `autosaved 14:02:31` (UTC, as every time of the app), or `not saved ·` with the reason and the trace.
  - The state lives in a plain object (`createDraftAutosave`, tested with fake timers); the hook only mounts it.
- **The class moved**: each save answers the view with the class recomputed (31 § 4). The panel listens for the saves. When the class moves, the panel updates and says why in one line, in a status region present from the start:
  - rule 3: `Class changed to curator always: the proposed text is about operating equipment.`;
  - rule 4: the sentence for a new source tier, which part 2's new row can reach;
  - on the way back: `Class changed to {class}: what is proposed no longer makes it the curator's.`
- **Strings**: `improve.suggest.edit.*`, `.class.*`, `.value.*`, `.save.*`, and the strip's `suggestion` and `draft`. The screen's words are EN verbatim: the panel's labels, step 2's, `draft · not submitted`, `autosaved {time}`. The rest are candidates in both languages:
  - the page's title and its hidden heading, the anchor-fixed line;
  - the kinds' captions other than `number`;
  - the recency values, the curator reasons;
  - the class-changed sentences, the save states.
- **Differences from the screen at 1440**, deliberate:
  - the right column (score, prediction, identity, submit) is 51e's, and its 376px track is empty until then;
  - evidence is 51d's and the rationale 51e's;
  - the status bar has no `grader · small tier` cell until evidence is graded on the page (51d);
  - `applies · fast-moving` for `applies · price`;
  - the anchor column has no kind control and no list, since the anchor is fixed with the draft, and so no `selected · … · anchor#…` footer: the anchored text and its marks are what it shows (recorded by the review, § 19);
  - a derived figure's panel shows 100 and 100 without the Rubric page's `A only`, which the view does not carry (the `Threshold` rows' missing column, an open question since unit 47);
  - the strip wraps with PT.
- **Found, not changed**: the figure's anchored text still prints its unit twice (`7,500 tokens tokens`), § 13's finding; the edit page shows what the draft stores.

Verified:
- the unit tests: `lib/improve/value.test.ts` (9) and `lib/hooks/draftSave.test.ts` (8);
- the browser spec, 7 of 7, with the edit page in EN and PT: the strip, the panel, the value saved with no button and read back through `GET`, an invalid value held back, rule 3 moving the class and back, a reload, the phone's notice, and axe on each state;
- the truncation suite, with `suggest-edit` at both widths and the moved class at 1440, nothing truncated;
- a scratch check: the role notice for an owner made a reader; another's draft 404 for a curator; signed out to the sign-in; a malformed id 404;
- `npx tsc --noEmit` exit 0; `npm run lint` exit 0; with the database, purge excluded, 191 files and 2,062 tests passed, 17 skipped; `npm run build` exit 0; `npm run secrets:scan` 0 findings; the token grep finds nothing; no workflow run left open.

## 18. As built (unit 51c, part 2: the other kinds' editors, 2026-10-08)

Step 2 now has an editor for each of the six kinds, and unit 51c is complete. No screen draws these five. Each takes the value editor's form, a field's current value read-only beside the proposed one where there is a current value, and their words are candidates.

- **A passage edited** (`EDIT_TEXT`):
  - the section's source text, as the book's file has it, in a read-only area where a passage is selected by the pointer or the keyboard;
  - `Use the selected text`, which fills the passage, and the replacement too while it is empty. The passage is the file's text because the schema sensor looks for it there (31 § 5); a passage copied from the rendered page differs where a paragraph has a link or emphasis. Both fields take typing as well;
  - under the passage, what the sensor will say: found once, not found, found n times, or holding a figure. Under the replacement: a changed digit, or no change;
  - the checks are the sensor's own functions, moved to `lib/improve/passage.ts`. Their number pattern moved to `pipeline/parse/patterns.ts`, which `figures.ts` re-exports, so a client island carries them without the markdown parser. A test holds the check to the sensor, case by case;
  - the draft is saved whatever the checks say: the sensor decides at submit, and a draft may be half written.
- **A claim added** (`ADD_CLAIM`): the claim; where it goes, either at the section's end or after a passage picked as above, with its occurrence check; and fast-moving, a declaration the curator sees. Recency reads the anchor's own flag (30 § 3.4), so the class panel's recency line stays the section's (corrected by the review, § 20). A choice saves at once, as a blur does.
- **A restructure** (`RESTRUCTURE`): what changes, in words. The class panel already says it is the curator's (rule 1).
- **A row edited** (`EDIT_ROW`):
  - the row's claim, citation, link, DOI and verified date, each beside its current value, which is struck through once a new one is written;
  - an empty field keeps the row's own, since a suggestion cannot take a row's link away (the schema's fields are optional, never null). The proposal holds the fields that differ;
  - a row's value is not offered: the Sources table has no column for it, and the merge refuses it (unit 50b). This was the tracker's recommendation, taken;
  - `resolveAnchor` now carries a row's fields (`row`).
- **A row added** (`ADD_ROW`): claim, citation, an optional link and DOI, the tier, and fast-moving. The tier starts unchosen, since it is the contributor's claim. `a tier the book does not have` asks for the tier's name, which moves the class to the curator's by rule 4, and the panel says so in its line.
- **What the fields make**: `lib/improve/editors.ts` builds each kind's proposal with `ProposalSchema`'s own parse, so the form sends nothing the endpoint would refuse. The words for a field that makes none:
  - a field the schema refuses, in that field's own words (`a link like https://example.com/page`, `a DOI like 10.1000/182`);
  - an empty field: `{field} is empty`;
  - a row edit that changes nothing: `change at least one of the row's fields`.

  The words show under the field once the person has written something, and in the status bar's cell.
- **Found in part 1's autosave, and fixed**: a save that returned while a newer change waited for its pause set the cell to `autosaved` for up to a second, though the latest text was not saved. The cell now goes back to `unsaved changes`, or to the fields' reason when they stopped making a proposal while the save was out. Two new cases in `lib/hooks/draftSave.test.ts` hold it.
- **Strings**: `improve.suggest.source.*`, `.check.*`, `.text.*`, `.claim.*`, `.row.*`, `.newRow.*`, `.restructure.*`, `.problem.*` and `fastMovingField`, all candidates in both languages.
- **Layout**: the value editor's grid and classes, extended (ui-context § 9.9). A radio or checkbox row is 44px on touch.

Verified:
- the unit tests: `lib/improve/editors.test.ts` (12, the passage check against the sensor among them), and the autosave's two new cases (10 in all);
- the browser spec, 8 of 8, with the five editors in EN under an account of their own (`e2e-suggest-kinds`, five drafts a run): each read back through `GET`; the passage's checks; a refused link; an unchosen tier; a new tier moving the class; axe on each;
- the truncation suite with the four editors at 1440 (a passage with its checks, a claim placed after a passage, a row with a refused link, a new row of a new tier), nothing truncated. Its drafts are now made once a run, one a kind, and deleted at the end;
- `npx tsc --noEmit` exit 0; `npm run lint` exit 0; with the database, purge excluded, 192 files and 2,076 tests passed, 17 skipped; `npm run build` exit 0; `npm run secrets:scan` 0 findings; the token grep finds nothing.

## 19. The review of unit 51c (2026-10-08)

One read-only review of part 1 through five lenses (correctness, accessibility, boundaries, tests and records, strings), each finding checked by a skeptic: 23 findings, 16 kept, 7 refuted. They are 12 defects, each fixed or recorded:

- **The autosave**:
  - a change back to the saved value made while a save was out was never sent, and the cell said `autosaved`. A change is now compared with what the server will hold once the request that is out returns, and sent when it returns. A save that returns after the fields moved on leaves the cell in their state (part 2 had fixed half of this);
  - a refused save is not tried again by itself, so a `409` is not repeated every second;
  - fields that make no proposal say so after the pause, or on blur, not at every keystroke of a value being typed (`0.` on the way to `0.25`). A field's error shows once it is left. That is now so in every editor;
  - the fake-timer suite has 13 cases.
- **Back and Forward**: Next's router kept the page as first loaded, and Back restored it, so the fields, the class and the next save started from a proposal the server no longer held. A unit-only edit then wrote the stale value back. The router is now refreshed after each save, as the dock refreshes after its writes; the fields keep what they hold. The browser spec saves, leaves by the strip's link, comes back, and finds the saved value. Run without the refresh, that check fails.
- **The class-changed line** said "no longer makes it the curator's" for any move rules 3 and 4 did not cause. A save reclassifies by the release's anchor too (31 § 4), so a class can move for a reason the proposal is not. The line now names rules 3 and 4, says the return from them, and otherwise says only where the class went (`Class changed to curator always: {reason}.`, `Class changed to {class}.`).
- **Tablets**: the 392px and 376px tracks left the form almost no width between 768 and about 1100px, which is also a desktop zoomed to 125–150 %. Under 1200px the empty right track goes and the anchor column is 300–340px. Under 1000px the anchor column stands above the form. The browser spec checks 1024 and 820.
- **The save cell** did not wrap, so a refusal with its trace ran past the status bar on a tablet. It wraps now.
- **Another's suggestion**: § 17 said a curator may read another's draft through the API, but the door gives nobody another's draft. A curator who opens the edit address of a suggestion past draft is now sent to its page, as the owner is; another's draft is 404.
- **Records**: § 17's differences now say the anchor column has no kind control, list or anchor hash. Spec 31 § 4 said the autosave calls `PATCH` through a server action; it is the island's same-origin `fetch`. Code-standards' `lib/improve/` map lists `suggest.ts`, `value.ts`, `editors.ts` and `passage.ts`.
- **The browser spec**: an invalid value is shown to be held back (the draft's `GET` keeps the last valid one), and a blur's `PATCH` leaves before the pause would have sent it.
- **PT**: the Rubric page said `alegação` where the suggest form says `afirmação`. Both now say `afirmação` (`rubric.thresholds.class.NEW_CLAIM`, the relevance rule).
- **Recorded, not changed**: when the page goes away while a save is out, the fields' last state is sent with `keepalive` beside it. The two can reach the server in either order, so the older can be stored last. Nothing short of a version on the draft orders them, and that is a change of the endpoint.

Refuted:
- the line's echo of a negative value (§ 17 says why the value is printed as typed);
- step 1's draft left by a failing assertion (that test's shape predates the unit);
- the tracker's date (the table lists finished units);
- `ProposedChange` in architecture's folder map (the map is of proposed names);
- the PT error's example `0.25` (the before field shows the same point);
- the PT rule-3 sentence (`equipamento em operação` is a sound reading).

Verified after the fixes: the browser spec, 8 of 8; the truncation suite, nothing truncated; `npm run lint` exit 0; with the database, purge excluded, 192 files and 2,079 tests passed, 17 skipped; `npm run build` exit 0; `npm run secrets:scan` 0 findings.

## 20. The review of unit 51c, part 2 (2026-10-08)

One read-only review of part 2 through the same five lenses, each finding checked by a skeptic: 25 findings, 15 kept and 10 refuted. Of the refuted, two had been fixed already by part 1's review (§ 19): the revert during a save, and the tablet widths. Seven more were taken all the same, since each cost little and left the page or its tests better; they are marked *refuted, taken* below. All 15 kept were fixed or recorded:

- **Keyboard selection**: in Chromium a `readonly` textarea takes the keyboard's selection away, so a passage could be picked by the pointer alone (found while checking the finding that it showed no caret). The source area is now an ordinary area that refuses every edit before it is made (`beforeinput`), says it is read-only (`aria-readonly`), and asks a tablet for no keyboard. The browser spec picks a passage by Shift and the arrows, Tab and Enter, and checks that typing in the source changes nothing.
- **The pick is announced**: the passage's field takes the focus once it holds the passage, so a screen reader reads what was taken.
- **The fast-moving box**: § 18 and the claim editor said it makes recency apply. Recency reads the anchor's own flag (30 § 3.4; the grader passes the anchor's), and the declaration is the curator's to see. The records are corrected. Whether a claim or a row declared fast-moving should make recency apply to its evidence is a question for Andre (the tracker's Open Questions).
- **CSS**:
  - `.textarea.err` and `.select.err` now exist beside `.input.err`, since the editors mark an area and the tier list;
  - the source area is mono, which `.textarea`'s `font: inherit` had undone;
  - a row's claim and citation areas are 64px, which `.textarea`'s 96px minimum had undone.
- **Too long to save** (*refuted, taken*: the server's refusal would be shown, but in words the person cannot act on): the longest sections run to 37,519 characters, so a whole section picked as a passage, with its replacement, makes a body over the pipeline's 64 KB. The builders now refuse such a proposal before it is sent and say so (`the proposal is over 64 KB, the most a save takes: make it shorter`). The limit moved to `lib/api/limits.ts`, a module the handler and the form both import.
- **Words**:
  - a tier left unchosen says `choose a tier` (*refuted, taken*: `{field} is empty` was the pattern; a list left on its first option is not empty);
  - a row's help says that a row has one link, so a DOI written there becomes it (the merge prints the DOI's link in the Link cell);
  - a row's verified date shows in the app's date format;
  - PT names the column `verificado`, as the reader's Sources table does (*refuted, taken*: the catalogue says `verificação` for the check's date elsewhere, and the field edits the column);
  - the restructure's description is the contributor's note, in the page's language, and no longer marked `lang="en"`.
- **One component a file** (code-standards; *refuted, taken*: other files of the repository hold several components, but the rule is the standard and the split cost nothing): the three files of several components became nine of one each (`TextEditor`, `ClaimEditor`, `RestructureEditor`, `RowEditor`, `NewRowEditor`, `SourcePicker`, `PassageChecks`, `FieldProblem`, and `TierChip` out of `AnchoredText`).
- **Tests**:
  - the sensor-agreement test compares each check with the sensor's own data (the occurrences, the figure, the field), not pass and fail alone (*refuted, taken*: § 18 claimed agreement on the verdict only, but a check could have drifted under it);
  - the restructure step is read back whole and checked by axe;
  - the truncation suite's prepares wait 15 s at most, so a hung one is recorded as not rendered, and its drafts are deleted in a `finally` (*refuted, taken*: the exposure predates part 2, and part 2 made it five drafts a run).
- **Refuted, and left**: nothing else; ui-context § 13.3's component table was brought up to date with the records (*refuted, taken*: architecture's folder map is of proposed names, as § 19 says).
- **Records**: the tracker's count of units left, 20; its Current Goal, which said the building had not started; and the component names in architecture § 3.1 and ui-context § 13.3.

Verified after the fixes: `lib/improve/editors.test.ts` (13); the browser spec, 8 of 8; the truncation suite, nothing truncated; `npm run lint` exit 0; with the database, purge excluded, 192 files and 2,080 tests passed, 17 skipped; `npm run build` exit 0; `npm run secrets:scan` 0 findings.

## 21. The fast-moving declaration counts (2026-10-08)

Andre's "next, use your recommendations" settled the question § 20 left open, as recommended. A claim or a row added declares whether it is fast-moving, and that declaration is what recency reads for its evidence (30 § 3.4, as decided). The view carries the flag the rule gives (`fastMoving`), and each save answers it. So the class panel's `recency factor` follows the box: tick it on a claim, and the panel says `applies · fast-moving` after the save, with no class-changed line, since the class has not moved. The browser spec checks it.

## 22. As built (unit 51d, part 1: the evidence list, 2026-10-08)

Step 3 is built on the edit page: the list, each item's states, the corroboration row, the empty state, and adding a link or a DOI. Uploads are part 2. D2 is decided on the recommendation (Andre, "next, use your recommendations"): **2 s**.

- **The read, every two seconds**: the list is a client island that starts from the draft's `GET`, as the page renders it. While any item is pending it reads `GET /suggestions/{id}` again two seconds after the last read answered, and stops once none is. It is the endpoint's own read, so its policy and its rate apply: 120 a minute, in one bucket per person for the suggestion's route, which its saves and removes share; the list asks 30 (corrected by § 24: this sentence first said the rate was the dock's research line's, which is 60 a minute every 5 s on its own endpoint, 43 § 4, D1).
- **The stage**: the view now carries each pending item's stage (`stage`). It is read from what the grading workflow's activities write on the row:
  - nothing fetched yet is `1 of 3`;
  - fetched, with no text stored, is `2 of 3`;
  - the text stored is `3 of 3`, the grade or a wait at the budget cap.

  Spec 32 § 8 names the workflow's query as the loader's number. The query still answers, and its suite still holds it, but a read every two seconds should not ask the engine for each pending item. The rows reach the same stages, because each activity writes before the next begins. One mapping of the row (`itemViewOf`, now beside the view) serves the read, a save's answer and the add's answer.
- **An item, by its state** (32 § 10; the Improve-Suggest screen; the Components screen's error form):
  - *graded*: the ordinal, the kind, the document's title, where it is (a link without its scheme, or a DOI), and the stake and recency window its factors name. The stake is read back from the rubric's independence table: `vendor concerned`, `independent`, `the contributor's employer`. The window shows only where recency cost something: the rubric's `≤ 1 year`, or `over 1 year`. Then the tier badge, named by the Rubric page's words (`Evidence tier C, Primary vendor`); the score; the arithmetic, with a factor below 1.0 in `--warn`; `opened · 200 · 12 days old`, warn where recency cost something; and `Remove`;
  - *grading*: dashed and `aria-busy`, with a pending tier's dashed badge and `—`. The loader shows the stage (`grading ▮▮▮ 3 of 3`) and what the stage does (`opened · 200 · classifying tier`), with `Cancel`;
  - *waiting at the budget cap*: in place of the loader, the Components screen's `budget cap reached` with the reset day from the row's reason;
  - *not opened*: the Components screen's `link could not be opened` with the U badge, where it pointed, and its sentence. An HTTP status is `Evidence 2 returned 403.`; the fetcher's own causes each have words; the guard's twenty-five refusals share one. Then `Replace evidence`, which removes the item and opens the add row with its link or DOI;
  - *a type no link is read as*, and *nothing arrived*: U, score 0, and a line saying so (32 § 10).
- **The corroboration row** follows the item that corroborates, with the rubric's tier and bonus: `Corroboration: item 02 is a second independent item at tier D or above.` and `+10 · once`.
- **The empty state** is the Components screen's form: `evidence · S-21-…`, `No evidence yet.`, and what to do.
- **Adding**:
  - `+ Link` and `+ DOI` each open a field under the row. The item is added through `POST …/evidence`, posted as the create posts, with the key kept for one body. It appears pending at once;
  - an `http` link is held back before it is sent;
  - a refusal is the error form with the server's words and the trace;
  - at ten items the row is closed with the endpoint's own sentence;
  - `+ Saved lab run` shows disabled with `arrives with the IDE`, and the screen's help line follows.
- **After each write** (an add, a remove, a cancel) the router is refreshed (code-standards).
- **The status bar** gains the screen's `grader · small tier`.
- **Nothing here reaches a model.** The suites add only addresses that cannot be opened (a `.invalid` name, a DOI that resolves to nothing). The workflow then grades them U by rule, since the dev workers grade through the real gateway (Session Notes). The graded, grading and budget states come from reads the browser answers itself, built on the real one.
- **Strings**: `improve.suggest.evidence.*`, and `improve.suggest.edit.grader`. EN is the screen's and the Components screen's where they have the words: the title and its caption, `link`, the arithmetic's form, `vendor concerned`, `independent`, `opened · 200 · 12 days old`, `5 months old`, `grading`, `classifying tier`, `Remove`, `Cancel`, the labels of both, the corroboration's sentence and value, `add evidence` and its four buttons, the help line, `link could not be opened`, `Evidence 2 returned 403. It is graded U, score 0, not weak. The other items still count.`, `Replace evidence`, `budget cap reached`, `Tier pending`, `grader · small tier`. The rest are candidates in both languages.

Verified:
- the unit tests: `lib/improve/evidenceView.test.ts` (7);
- the browser spec, the evidence test in EN and PT: the empty state; an `http` link held back; a link that cannot be opened graded U by the real workflow, with its sentence and the read agreeing; the replace; then the graded, grading and budget states from answered reads (the badge's name, the arithmetic with PT's decimal comma, the stake and window, the corroboration, the stage, the reset day); axe on each;
- a scratch run of the same, with a DOI that resolves to nothing graded U by the real workflow (`Evidence 1 returned 404.`);
- the truncation suite with step 3 at its fullest at 1440 (159 labels), nothing truncated;
- the browser spec, 10 of 10, step 1's create now checking step 2 by its own region, since the page has a step 3;
- `npx tsc --noEmit` exit 0; `npm run lint` exit 0; with the database, purge excluded, 194 files and 2,091 tests passed, 17 skipped; `npm run build` exit 0; `npm run secrets:scan` 0 findings; the token grep finds nothing; no workflow run left open.

## 23. As built (unit 51d, part 2: uploads, 2026-10-08)

`+ Upload` is built, and with it the words for an item that opened but was graded U all the same. Unit 51d is complete.

- **The form** (`EvidenceUpload`): `+ Upload` opens a file field under the row, as `+ Link` does, and the field takes the focus. A browser words its own picker in the browser's language, so the box shows the page's: `choose a file`, then `no file chosen` or the file's name. The file input lies transparent over the whole box. It stays the control that takes the focus, the keys and the click, and the box draws its focus ring, as the search box does. The picker offers the five types (32 § 5) and their extensions.
- **The type** a file is sent as is the browser's when it is one of the five, else its name's extension's (`uploadTypeOf`, `lib/improve/upload.ts`). Anything else is held back in the form, with nothing asked of the server: `a PDF, a PNG or JPEG image, or a text or Markdown file`.
- **Three steps**, which the loader counts (`uploading ▮▮▯ 2 of 3`, then what the step does: `sending the file`):
  1. **The ticket** (`POST …/evidence/uploads`, unit 49b) names the most the type may weigh. A file over it is refused there, with nothing sent: `a file of this type may be at most 7.1 MB`. The number is the ticket's, in MB of 1024 × 1024 bytes, as D2 counts its 100 MB, rounded down (`formatMegabytes`; § 24).
  2. **The file** is `PUT` to the ticket's URL with the ticket's header. While the store is a directory, that URL is the web tier's own route (32 § 15), so the write is same-origin, as the fetch rule asks. A bucket's URL will be another origin; the exception is to be recorded when there is one.
  3. **The item** is added (`POST …/evidence` with the `uploadKey`, the idempotency key kept for that one body). It appears pending at once.

  A try after a failure starts at the step that failed: a file the store has is not sent again, and a ticket within a minute of its end is replaced. Closing the form any way at all stops the first two steps (§ 24; at first only `Cancel` did). Once the add is sent it is waited for, so an item the server took is never missing from the list. `fetch` reports no progress for an upload, so the loader counts steps, not bytes.
- **An upload on the list** is `upload`, titled `uploaded file`, since nothing of the contributor's naming is kept (open, below). Its status says `uploaded` where a link's says `opened · 200`: `uploaded · reading the text` while it grades, `uploaded · 12 days old` once graded.
- **Graded U all the same.** An item that opened, or a file the store took, can still be graded U, in either of two ways:
  - by intake rules: a file that is not the type it was sent as, an image too wide, a PDF too large for the request, the source sent again after it was opened, or no text;
  - because the grader gave no tier: the gateway's or the provider's refusal, or an answer that did not parse.

  Part 1 showed such an item as a bare U with score 0. It is now the Components screen's error form, as an unreachable link is. The form has `evidence could not be graded`, the U badge, where the item points, the sentence (`Evidence 1 could not be graded: its bytes are not the type it was sent as. It is graded U, score 0, not weak. The other items still count.`) and `Replace evidence`. For an upload, `Replace evidence` removes it and opens the upload's form again. Nine of intake rules' reasons have their own words (`ruledOf`, `RULED_CAUSES`); every other reason gets the grader's sentence. The form serves links too: a link that opened and gave no text.
- **The kind column** is 60px, not the screen's 44px. The screen's width holds `link` and `DOI`. In `.label`'s style, PT's `arquivo` measures 50.8px and `execução` 58.1px; the truncation suite found the first. The foot and the budget wait move with the column, keeping their place under the title.
- **Nothing here reaches a model.** The one file the suites store is a "PDF" whose bytes are not one. Intake rules grade it U before any call (32 § 19, `media_mismatch`). The dev workers grade through the real gateway, so no suite uploads a real PDF, image or text.
- **The development server's store**: an upload needs `OBJECT_STORE_SECRET`, which this machine's `.env` still lacks (tracker, Session Notes). For this unit the server was restarted with a secret generated into its environment, never printed and never written to `.env`. The browser spec's upload test asks the store first; where the store cannot sign, the test is skipped and says why.
- **Strings**: `+ Upload` is the screen's. The rest are candidates in both languages: `add.upload`, `fileLabel`, `chooseFile`, `noFile`, `fileInvalid`, `fileTooLarge`, `uploading`, `step.*`, `uploadTitle` and `ruled.*`. The empty state now names a file.

**Open, for Andre**: an upload has no name on the list. The file's name is the contributor's words, and the grader may never read the contributor (32 § 7.1). What the grader reads of a document's name is the fence's `title:`, and unit 49f took a file name out of it. So a name would need a column of its own that the grader's input never reads. Recommended: a `fileName` column, shown on the list and to the curator, never in the prompt. It is a schema change.

Verified:
- **The unit tests**: `lib/improve/upload.test.ts` (5); `ruledOf` in `lib/improve/evidenceView.test.ts`; `formatMegabytes` in `lib/i18n/format.test.ts`.
- **The browser spec's upload test, in EN and PT**:
  - the picker worded in the page's language, its field focused;
  - a page held back with nothing asked of the server;
  - an image of 7,500,001 bytes refused after the ticket, with nothing sent;
  - a "PDF" whose bytes are not one sent through the ticket, the `PUT` and the add, in that order, and graded U by the real workflow. Its sentence shows, and the read agrees: `UPLOAD`, `GRADED`, `U`, `media_mismatch`, `intake-rules`, `opened:200`;
  - the replace opening the form again, its field focused;
  - axe on each.
- **The browser spec**: 12 of 12.
- **A scratch run of the same, with more**:
  - Space and a click on the box open the picker;
  - the loader and `Cancel` while the `PUT` was held back four seconds, with nothing added;
  - a graded upload, a grading one and a U from the grader's refusal, from answered reads;
  - axe on each.
- **The truncation suite** at 1440 (190 labels): step 3 with a graded upload, one graded U by rule and the upload's form open. Nothing truncated after the kind column's change.
- **The rest**: `npx tsc --noEmit` exit 0; `npm run lint` exit 0; `npm run build` exit 0; `npm run secrets:scan` 0 findings; the token grep finds nothing; no workflow run left open.
- **The database suite**, purge excluded: 194 files passed, 1 failed and 1 skipped (196), with 2,097 tests passed and 17 skipped (corrected by § 24: first written as 195 of 196). The one failure was the assistant's 21st question in a minute answered 200 for 429, a known sighting (Session Notes); that file passed alone straight after, 19 passed.

## 24. The reviews of unit 51d (2026-10-08)

One read-only review a part, five lenses each with a skeptic. Part 1 (with the fast-moving fix): 38 findings kept, 4 refuted; part 2: 21 kept, 5 refuted (one skeptic lost to a network outage, so the tests-and-records lens went unchecked and was read by hand). Many were the same defect seen by two or three lenses. Fixed in one commit:

- **Recency after a changed declaration** (the fast-moving fix's own defect): an item's recency is fixed when it is graded, so ticking the box afterwards left it scored as the other kind of claim while the panel, the view and the adjudicator read the new one. A `PATCH` now scores the graded items again in the same transaction (`rescoredOf`, from the age the grader recorded; no model), and the list reads them when a save flips the flag.
- **A wait at the budget cap** had no button, and nothing in a draft grades the item again, so the draft could be neither submitted nor cleared. The wait is now the Components screen's `budget cap reached` with `gateway` and `Remove`, its sentence says to remove the item and add it again after the reset, and the list no longer reads the draft for it.
- **The reads**: a read that started before a write of the list's own is dropped; a hidden tab is not read; a 429 waits for `Retry-After`; a 401, 403 or 404, or an answer the page is too old to parse, stops the reads and says so.
- **Adds**: a retry the handler replays answers 202 with no body; it now counts as added and the list reads the draft. A lost answer says that adding again is safe. Closing the upload's form any way stops its first two steps, and an upload that answers after its form closed closes nothing else. A refused `PUT` drops its ticket.
- **The span**: the storage routes' path is the signed token, which the secret guard redacted and paged on for every upload; their line, span and policy context now name the template (`credentialInPath`).
- **Accessibility**: the tier badge is an image by its name; the error forms are alerts, as the Components screen's are, and a grade that lands is announced; focus goes back to the opening button when a form closes, to the step's heading after a remove, and to a field held back; Add stays focusable while it works (`aria-disabled`); Replace names its item; the form's own check speaks before the browser's URL check.
- **Words**: an undated item's window says so (`no date, so over 1 year`); an unsupported link with no type says `no stated type`; PT ages read as the document's (`idade: 12 dias`), not as when it was opened; a failed remove no longer says nothing was created; the size limit is rounded down (22.8 MB, 7.1 MB), so a file under the number shown is under the limit.
- **Small**: the extension table cannot match `.constructor`; the rule under the corroboration row is single, and an item after a failed one keeps its top rule; the upload field's error bar shows, and a long file name wraps instead of being cut.
- **Tests and records**: the ADD_ROW endpoint case declares against the section's flag; the adjudicator's prompt is tested with a claim declared fast-moving; a repository test ties `ruledOf`'s words to the reasons the workers write; the rate sentence of § 22, architecture § 6.3's stage, spec 32 § 7.2, the `lib/improve` map, the strings the screen has verbatim, the accounts' draft counts and the run notes are corrected.

Recorded, not fixed: a grading that lands between a `PATCH` and the grader's write can still store the old recency (the next save corrects it); a tab open across a deploy that adds a field to the view stops reading and asks for a reload.

Verified: the unit and endpoint tests; the database suite, purge excluded, 195 files and 2,107 tests passed, 17 skipped, with the suggestions suite's serial case failing beside the evidence suite as before and passing alone (13 of 13); the browser spec 12 of 12; a scratch run of what the spec does not reach (the read when the box flips, the focus after an add and a cancel, the announcement, a 404 stopping the reads, an upload stopped by switching forms) all passing; the truncation suite (194 labels on the evidence screen); `npm run lint`, `npm run build` exit 0; the secrets scan 0 findings; `openapi.json` unchanged.

## 25. An upload's file name (2026-10-08)

Decided on Andre's "continue, use your recommendation" (§ 23's open question): an upload keeps its file name, as the contributor's browser gave it, in a column of its own (`EvidenceItem.fileName`, migration `20261008120000_evidence_file_name`, nullable and additive). The upload's add sends it (`fileName`, optional, trimmed, at most 255 characters); the view carries it; the list calls an upload by it, where it had said `uploaded file`. The grader's input never reads it: the grader may never read the contributor (32 § 7.1), and a name is the contributor's words, as a name that states a tier would be. The evidence integration suite uploads a file named for a tier, and checks the row keeps the name and the grade's input does not hold it. `openapi.json` regenerated.

## 26. As built (unit 51e: the rationale, the live score and Submit, 2026-10-08)

The edit page is complete, as § 5 to § 7 describe it. Unit 51 is done.

- **Step 4, the rationale** (`RationaleStep`): the textarea, its help and the counter `142 / 200 words` from `countWords`, the count the sensor uses. Over 200 the counter (`.counter.is-over`) and the field turn to the error state, the help says why, and Submit waits. It is saved by the autosave, which now takes a field (`proposal` or `rationale`), as the proposal is.
- **The view's scoring gains `wouldSuffice`**, computed on the server by the rubric's own `wouldSuffice` with the draft's fast-moving flag (`openapi.json` regenerated). The page computes nothing it shows.
- **The right column** (`ScoreColumn`), as the screen draws it:
  - *Score*: the big number in the colour of where it stands, `accept ≥` and `floor`, the shared `Meter` with both ticks and the screen's accessible sentence, the scale's labels, and "how it is computed": the strongest item, the corroboration and what it added, each other item alone (`42 · not added`) or grading, and the total line (`56 + 10 = 66`). A class no score decides says so, with no meter.
  - *Predicted outcome*: the badge and its sentence, by the route and the decision; the `would suffice` box from the view's `wouldSuffice` (`An independent tier D item ≤ 90 days old, or a tier B item.`, and `D ≤ 90 d as strongest: 60 + 10 = 70 · B: 85`); while an item grades, the footer that says the prediction will change.
  - *Identity*: the name with `verified`, and the help. The screen's `sso · 18 Mar 2026` is not drawn: no column holds when an identity was verified.
  - **Live**: the column draws the draft as the page loaded it, then every fresh view another island has (`hb:draft-view`): each of the evidence list's reads and each save's answer. So the score and the prediction change without a reload and are always the read's.
- **Submit** (`SubmitPanel`): the consent, once, while none is on file (`Keep my name with this change, for its provenance.`, a candidate); `Submit for grading`; `Save draft`, which asks every field to save at once; and the meta line with the last save's time and the submissions of the last 24 hours against 20 (the limit is a rolling window of 24 h, so the page does not claim a calendar day). Submit first asks every field to save and waits until each has, so what the server checks is what the page shows; a field that cannot save stops it with a sentence. Then `POST …/submit`, with the key kept for one body. Success goes to `/[lang]/improve/[id]`, unit 52b's page; until 52b is built that address is the not-found page. Submit waits, and says why, for a rationale of more than 200 words and for the consent; under a throttle it waits with the notice.
- **A refusal beside its field** (`SubmitProblem`): an intake sensor's 422 or a missing consent is shown in the Components screen's error form beside the field it concerns: `anchor not found · intake sensor` in the anchor column with `Choose an anchor`; the schema's after step 2; the evidence's after step 3; the rationale's after step 4; the consent's by its checkbox. Each shows the catalogue's sentence, the sensor's own and the trace. Any other refusal (the throttle, the engine down, the rate) is the panel's error form. `WORKFLOWS_UNAVAILABLE` gained its catalogue sentence in both languages.
- **§ 7's remaining states**: an identity not verified sees step 1's notice and no form; a throttled contributor sees the form, with Submit waiting under the notice and the date; an anchor the release has changed shows the text the draft recorded and the text the release has now, or that it has none, with `Choose an anchor` (`AnchorChanged`; a section's long text scrolls in a box that takes the focus); workflows unavailable on submit is the panel's error form, which says nothing was done.
- **Layout**: the screen's 376px rail at 1440. Under 1200px it stands under the anchor column, beside the form; under 1000px after the form; under 768px the page is the notice, as before.
- **Strings**: EN is the screen's where it has the words (`Rationale`, `plain text · read by the adjudicator`, the label, the help, `Score`, `how it is computed`, the rule's sentence, `Predicted outcome`, `if submitted now`, `request more · short by 4`, its sentence, `would suffice`, `Identity`, its help, `Submit for grading`, `Save draft`). The rest are candidates in both languages.

Verified:
- **Unit tests**: `lib/improve/scoreView.test.ts` (6); the rationale's autosave in `lib/hooks/draftSave.test.ts`.
- **The browser spec**, the 51e test in EN and PT:
  - the rail before anything is graded;
  - 201 words turning the counter to its error state, and Submit waiting with why;
  - a submission with no proposal refused by the schema sensor, shown right after step 2, the draft still a draft;
  - a link that cannot be opened graded U, the rail following without a reload, its number and prediction the read's;
  - axe on each.

  The whole spec passes 14 of 14.
- **A scratch run** went further: `Save draft`, and a successful submission. The latter landed on `/en/improve/S-21-1254` and the suggestion left draft (`INTAKE_DECLINED` at score 0, by rule, no model). That suggestion stays in the development database, as every record does, which is why the committed spec does not submit.
- **The truncation suite** passes, the rail on every edit screen (the evidence screen measures 268 labels).
- **The rest**: the database suite, purge excluded, 197 files and 2,114 tests passed, 17 skipped, none failed; `npm run lint`, `npm run build` exit 0; the secrets scan 0 findings; the token grep finds nothing.
