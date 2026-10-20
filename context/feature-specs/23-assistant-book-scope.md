# 23 · Assistant 2.0, book scope — feature spec (a conversation without a chapter, the question's own references, the unverified rule, guide v1.13)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: Andre's request of 2026-10-04, quoted in § 1. No screen belongs to this spec: it changes what the assistant is asked of, not what it looks like (the dock is spec 24, the statistics spec 25, the page spec 26). Where this spec and specs 12, 13, 15, 16, 18 or 19 disagree about the reader's position in the book, this spec is later and wins; every other rule of those specs stands.

Prerequisite specs: `12-retrieval.md` (the plan per mode), `13-assistant-agent.md` (the scope rules, the classifier, the guide), `15-conversations-api.md` (the rows and the endpoints), `18-decision-aid-walk.md`, `19-assistant-modes.md`, `22-phase2-gate.md` (the golden run and the gate, which this spec runs again).

Scope: tracker unit 40. The server side of Assistant 2.0: the conversation row without a chapter, the turn's context reduced to what a mode explicitly picks, the references a question names, the unverified rule without a context chapter, the retrieval plan, the refusal pointers, guide v1.13, the API schemas, the golden runner and the gate. Not here: any change to what the dock looks like or where it opens (24), the statistics (25), the page (26).

## 1. Purpose

Andre, 2026-10-04:

> the assistant 2.0 features:
> - the assistand is bound to the books, not to the chapters or the subsection of a chapter
> - i can ask any question at any point about anything related to harness
> - the assistant sub page should contain 3 things: the conversations, the assistant dock and a dashboard of the observability stats

Assistant 1 answers from the whole book already: explain mode retrieves across every verified chapter (spec 12 § 7.2). What ties it to a chapter is everything around retrieval: the conversation row stores a chapter, the dock exists only beside a section, a question asked from an unverified chapter is refused whatever it asks, and the lists send the reader back to "the conversation's chapter". This spec removes that tie on the server. After it, a conversation belongs to a reader and a release and to nothing else; what a question is about is read from the question, and what a mode works on (two chapters, an aid, a lab) is picked for that turn.

What does not change (D1): the assistant answers from the book and nothing else. "Anything related to harness" means anything the book covers, from any chapter, asked from anywhere. A question the book does not cover still gets "the book does not cover this" and the nearest sections that do. Invariant 14, the guide's first paragraph, the overview's "not a general AI chat product" and criterion P2.1a all rest on that, so changing it is a different product and a decision of its own.

## 2. Assistant 2.0 as four units

| Spec | Unit | What it delivers | The product between units |
|---|---|---|---|
| 23 (this) | 40 | the server stops reading a chapter | the dock still opens beside a section and still sends its chapter; the server ignores it |
| `24-assistant-dock-anywhere.md` | 41 | the dock without a chapter, opened from any page with `a` | the old page at `/assistant/[id]` still works, in the new dock |
| `25-assistant-stats.md` | 42 | the reader's own statistics, as loaders and one panel | the panel exists and no page shows it yet |
| `26-assistant-page.md` | 43 | `/assistant`: the conversations, the dock and the statistics | complete |

The order is forced by what each needs. The dock cannot drop its chapter until the server accepts a conversation without one (40 before 41). The page shows the dock and the panel, so both exist first (41 and 42 before 43). 42 does not depend on 40 or 41 and may be built at any point before 43.

**The real golden run comes after unit 40 (D9).** The Phase 2 gate still waits for one paid run of the golden set (tracker, Open Questions). A run made before this unit measures Assistant 1 under guide v1.12 and would have to be paid for again.

## 3. What binds the assistant to a chapter today

Found by reading the code on 2026-10-04. Each row is closed by the sub-unit named.

| # | Where | Today | After | Closed in |
|---|---|---|---|---|
| B1 | `Conversation.chapter`, `sectionId`, `contextLabel` (`prisma/schema.prisma`; migration `20260925120000_assistant`) | `chapter` and `contextLabel` are `NOT NULL`; the label is "ch21 · durable execution" | nullable, not written and not read (§ 7.1) | 40d |
| B2 | `ConversationCreateSchema` (`lib/schemas/api.ts`) | `chapter` required | `{ locale }` | 40d |
| B3 | `askEndpoint` (`lib/api/endpoints/assistant.ts`) and `turn.ts` (`workers/answer/`) | the conversation's chapter and section fill every turn's context | no fallback: the context is what the turn's mode picked | 40b, 40d |
| B4 | `chaptersVerifiedFor` (`workers/answer/run.ts`) | the context chapter must have passed VERIFY, so a question asked from chapter 35 is refused whatever it asks | judged on what the question names and on what the mode picked (§ 5.2) | 40b |
| B5 | `planOf` (`lib/search/retrieve.ts`) | explain always includes the context section; walk and lab scope to the context chapter; brief always includes the context chapter's `.8` | explain always includes the sections the question names; walk and lab scope to the aid's and the lab's chapter; brief includes nothing extra (§ 5.3) | 40b |
| B6 | the `R-RECOMPUTE` pointer (`workers/answer/flow.ts`) | the context section | the sections the question names, else none (§ 5.4) | 40b |
| B7 | the walk's aid and the lab (`askEndpoint`, `contextProblem` in `lib/db/assistant.ts`) | the aid and the lab must be the context chapter's own | any aid and any lab of the release (§ 7.3) | 40d |
| B8 | guide v1.12, mode 1 | "Answer a question about the current section or chapter." | v1.13 (§ 6) | 40c |
| B9 | the golden runner and the gate (`lib/gate/goldenRun.ts` `contextOf`, `workers/gate/goldenDeps.ts`, `lib/gate/api.ts`, `lib/gate/measure.ts`, `lib/gate/walk.ts`) | every item and every gate turn opens a conversation on a chapter | open with a locale; send only the mode's picks (§ 8) | 40e |
| B10 | the dock, its slot, its strings, the lists | — | spec 24 and spec 26 | units 41, 43 |

Already free of a chapter, and left alone: the `Message` row, the `ANSWER` ledger record (`chapterVersionId: null`), the prompt's assembly (`workers/agents/assistant/assemble.ts` has no context slot), the classifier's three causes, the mode sensor (it reads the pair, the lab id and the aid's chapter, each of which still arrives), the nine metric series.

## 4. The question's own references (40a)

`lib/sensors/references.ts`, pure, no I/O, EN and PT:

```ts
export interface QuestionReferences {
  /** Section ids introduced by a cue word, in order of appearance: "section 21.3", "seção 21.3", "§ 21.3". */
  readonly namedSections: ReadonlyArray<SectionId>;
  /** Chapter numbers introduced by a cue word: "chapter 34", "capítulo 34", "ch34", "ch. 34", "cap. 34". */
  readonly namedChapters: ReadonlyArray<number>;
  /** Lab numbers: "lab 23", "Lab 23". */
  readonly namedLabs: ReadonlyArray<number>;
  /** Section ids that stand alone in the text ("In 21.3, how often…"), without a cue word. */
  readonly bareSections: ReadonlyArray<SectionId>;
}
export function referencesOf(question: string): QuestionReferences;
```

Two tiers, because a bare `37.8` may be a section or a number. A **named** reference counts for the unverified rule and for retrieval. A **bare** section id counts for retrieval only and never refuses. A section id is two digits, a dot and a digit from 1 to 9 (the shape the reader's routes accept); a chapter is 0 to 40. Whether an id exists in the release is the caller's check, not this function's.

Of the golden set's 201 questions that expect an answer in explain mode, 200 name their section or chapter with a cue word and one (G-0301, "In 21.3, …") names it bare. All seven explain questions that expect `R-UNVERIFIED` name their chapter with a cue word ("What does chapter 34 (Selecting use cases) recommend?").

Tests (`references.test.ts`): each cue form in EN and PT; `P-101`, `0.68`, `3.4×`, `42 bar` and `$237.60` yield nothing; a bare `37.8 %` is a bare section and not a named one; and over the golden set, every explain question yields at least the section or chapter its `context` names.

## 5. The workers (40b)

### 5.1 The context of a turn

`AnswerContextSchema` (`lib/schemas/assistant.ts`) keeps its field names and changes their meaning from "where the reader is" to "what this turn's mode works on":

| Field | Set when | From |
|---|---|---|
| `chapter: number \| null` | walk, lab | the aid's chapter, the lab's chapter; resolved by the endpoint, never sent by a client |
| `section: SectionId \| null` | walk | the aid's own section (`aids/*.json` `section`) |
| `chapters?: [a, b]` | compare | the reader's pick |
| `labId?: string` | lab | the reader's pick |
| `references: QuestionReferences` | every mode | `referencesOf(question)`, computed once by the turn |

Explain and brief carry `chapter: null` and `section: null`. `workers/answer/turn.ts` stops reading `conversation.chapter` and `conversation.sectionId`.

### 5.2 `R-UNVERIFIED` without a context chapter

`chaptersVerifiedFor` answers "has everything this turn is asked of passed VERIFY in this release":

| Mode | Judged on |
|---|---|
| explain | the chapters of `namedSections`, `namedChapters` and `namedLabs`; none named is `true` |
| compare | the pair, and the named references |
| walk | the aid's chapter |
| lab | the lab's chapter |
| brief | Part III has at least one verified chapter (spec 19 D4, unchanged), and the named references |

Any one unverified chapter among them refuses the turn (D5). The rule's place in `scopeRules` is unchanged (first), and so is the refusal: before retrieval, no pointer, a ledger record.

What this fixes: six golden refusal items (G-0252, G-0256, G-0260, G-0264, G-0268, G-0272) expect `R-SCOPE-OT` or `R-SCOPE` and refuse today as `R-UNVERIFIED` only because they are asked from chapters 35 and 37 (tracker, Open Questions, "Eight golden items cannot hit their label as written"). They name no chapter, so they now reach their own rule.

What retrieval already guarantees: every plan keeps `verifiedOnly`, so no answer can cite an unverified chapter whatever the rule misses.

**A chapter named by its title (D6).** "What does the chapter on regulation recommend?" names no number. With the rule alone it would be answered from the verified chapters, or with "the book does not cover this", which is false of a book that has the chapter. The classifier (`workers/answer/run.ts`, the `hb-small` call that already runs on every question the rules let through) gains a fourth cause for it. One line is added to its prompt, built from the release and omitted when every chapter is verified:

```
R-UNVERIFIED: asks about one of these chapters by its number or its title; they have not passed verification: 34 Selecting use cases; 35 OT/IT and functional safety; …
```

A question about a topic, which a verified chapter may also cover, is not that cause: retrieval answers it from the verified chapters. A classified `R-UNVERIFIED` carries no pointers (the two retrieved sections that other classified refusals point to are dropped), as the cause's rule says: "then nothing from it".

### 5.3 The retrieval plan

`planOf(mode, context, briefChapters)`:

| Mode | Scope | Always included |
|---|---|---|
| explain | every verified chapter (unchanged) | the first two of: `namedSections`, then `bareSections`, then `NN.1` for each of `namedChapters`, in that order, those that exist in the release (D7) |
| compare | the pair (unchanged) | `AA.1`, `BB.1` (unchanged) |
| walk | `context.chapter`, now the aid's | `context.section`, now the aid's own section instead of a hard-coded `NN.8` |
| lab | `context.chapter`, now the lab's | `NN.4` (unchanged) |
| brief | Part III (unchanged) | nothing |

Spec 12 D7 ("ask about 21.3 must be able to cite 21.3") holds in its new form: the section is in the set because the question names it, not because the reader is on it.

### 5.4 Refusal pointers

`R-SCOPE-OT`: `35.2`, `28.1` (unchanged). `R-RECOMPUTE`: the first two of `namedSections` then `bareSections` that exist in the release; none named, no pointer, and the card omits its "what the book does cover" block as spec 17 § 3 already allows. `R-UNVERIFIED`: none. `R-SCOPE` from the classifier: the two nearest retrieved sections (unchanged).

## 6. Guide v1.13 (40c)

`guides/assistant/v1.13/`, a copy of v1.12 with two edits to `guide.md`; `citation-rules.md` and `grader.md` are byte-identical, so their part hashes do not change. `manifest.json` carries the new prefix hash; `ASSISTANT_GUIDE_VERSION` becomes `v1.13`.

| Line | v1.12 | v1.13 (candidate; Andre's to edit) |
|---|---|---|
| mode 1 | **Explain a section.** Answer a question about the current section or chapter. Every claim cites the section it comes from. | **Explain.** Answer a question about anything the book covers, from the retrieved sections. Every claim cites the section it comes from. |
| title | `# Harness Bible assistant · guide v1.12` | `# Harness Bible assistant · guide v1.13` |

Nothing else in the guide speaks of the reader's position. The mode keeps its name and its API value `explain` (D3): the rows, the ledger records, the golden set and the series all carry it.

## 7. The row and the API (40d)

### 7.1 Migration

`prisma/migrations/<stamp>_assistant_book_scope/`: `ALTER TABLE "Conversation" ALTER COLUMN "chapter" DROP NOT NULL, ALTER COLUMN "contextLabel" DROP NOT NULL`. Forward-only; every existing row stays valid and nothing is dropped (D4). The three columns stay in the table, with a schema comment that Assistant 1 wrote them until this migration and nothing reads them since.

### 7.2 The database layer (`lib/db/assistant.ts`)

- `createConversation(user, { locale })`: no chapter, no section, no label.
- `ConversationSummary` becomes `{ id, lastMessageAt, turns, passCount, refusedCount, textPurged, citedChapters }`. `citedChapters` is the distinct chapters of the conversation's `Citation` rows in order of first citation, read through Prisma inside `withTenant`. It is the conversation's label (D8): it is never the reader's text, it survives the 30-day purge because citations do, and it is short by construction, which the no-truncation rule (ui-context § 11) needs.
- `contextProblem(releaseId, context)`: the pair exists and is distinct (unchanged); the lab exists in the release (it no longer has to be "the context chapter's own"); the `chapter` and `section` checks go, because no client sends them.

### 7.3 Schemas and endpoints

| Schema or endpoint | Change |
|---|---|
| `ConversationCreateSchema` | `{ locale }` |
| `ConversationSchema` (the create and read responses) | `chapter`, `sectionId` and `contextLabel` leave the response |
| `MessagePostSchema.context` | `{ chapters?, labId? }`; `chapter` and `section` leave it |
| `CitationViewSchema` | gains `deriveLine: number \| null`, the cited figure's derive line, so a chip can show `ƒ L45` for a figure of any section (today the dock knows only the open section's figures). Filled where the view is built: `getConversation` and the `final` event |
| `askEndpoint` | no merge of the conversation's chapter. Compare needs `chapters`; lab needs `labId`; walk needs `aidId` of any aid `findAid` knows, and sets `context.chapter` and `context.section` from the aid; explain and brief take no context. The error codes are unchanged (`CONTEXT_INVALID`, `AID_UNKNOWN`, `AID_INPUTS`) |

If the pipeline parses bodies strictly, a `chapter` sent by a dock loaded before the deploy would be a 400; the build checks which it is and, if strict, keeps `chapter` and `section` as accepted and ignored until unit 41 removes the sender. `openapi.json` is regenerated. Rate limits, policy (`assistant.rego`) and the stream are untouched.

## 8. The golden set, the gate and the tests (40e)

- `golden/assistant/2026.09.jsonl` is not edited. Each item's `context` stays in the file as where the generator took the question from; it is no longer sent.
- `contextOf(item)` (`lib/gate/goldenRun.ts`) sends `{ chapters }` for compare and `{ labId }` for lab, and nothing for the rest. `open` (`workers/gate/goldenDeps.ts`, `lib/gate/api.ts`) takes a locale only.
- The gate's own turns (`lib/gate/measure.ts`, `lib/gate/walk.ts`): the `R-UNVERIFIED` turn asks a question that names an unverified chapter instead of opening a conversation on one; the walks pass their `aidId` and nothing else.
- About 17 test files open a conversation on a chapter or assert `contextLabel`; each moves with the layer it tests.
- The stub run is made again and compared with unit 36b's (149 of 151 figure items and 44 of 50 refusal items hit their label then). Expected, and to be reported as measured: the six refusal items of § 5.2 hit their label, so 50 of 50; the figure items do not move.

## 9. Strings

None. Every user-visible string this change touches belongs to the dock (spec 24) or the page (spec 26). The refusal sentences of `assistant.refusal.*` are unchanged.

## 10. Out of scope

- Answering from anything but the book (D1).
- A hidden hint of the section the reader has open (D2). Spec 24 D2 proposes the visible alternative: the reader's "Ask about 21.3" button writes the id into the question.
- Dropping the three columns, or back-filling old rows.
- Conversations that cross releases: a conversation stays pinned to its release (spec 15 § 3).
- Detecting an unverified chapter by topic. Retrieval's `verifiedOnly` is the guarantee; the classifier's line (D6) covers the title.

## 11. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | What "anything related to harness" is answered from | A the book only, from any chapter, asked from anywhere / B the book first, then the model's own knowledge, marked as uncited / C general chat | **A**: it is what the three features need, and B or C would break invariant 14, the guide's first rule, P2.1a and the overview's out-of-scope line. If Andre means B, it is a spec of its own |
| D2 | The reader's position | A none: the question's references are its context / B a hidden per-turn hint of the open section | **A**: the same question gets the same answer wherever it is asked, which is what "not bound to the chapter" means and what can be tested |
| D3 | The five modes | A keep them; compare, walk and lab pick their target for the turn / B one mode | **A**: the walk, the lab explanation and the brief are features the overview lists, and none needs a position, only a target |
| D4 | The migration | A relax `NOT NULL` on `chapter` and `contextLabel` / B keep them and write a placeholder / C a new table | **A**: forward-only, every row stays valid, nothing is dropped. It relaxes rather than adds, so invariant 30's wording gains "or relaxing" when the unit is built |
| D5 | A question naming a verified and an unverified chapter | A refuse / B answer from the verified one | **A**: a refusal never carries a partial answer (guide, "Scope and refusal") |
| D6 | A chapter named by title | A the rule on numbers only, the title a known limit / B the classifier also knows the unverified chapters' numbers and titles | **B**: without it the assistant says the book does not cover a chapter the contents page lists. It changes a model call's prompt, so it is measured by the real golden run and not by the stub |
| D7 | How many named sections retrieval always includes | 1 / 2 / all | **2**: the most any mode forces today (compare's two `.1` sections), so the prompt grows by no more than a compare's |
| D8 | A conversation's label | A the chapters its answers cite / B its first question | **A**: spec 15's rule that the label is never the reader's text stands, the label survives the purge, and it cannot be long. The open conversation's turns still show their questions |
| D9 | The real golden run | A after unit 40 / B before, as a baseline of Assistant 1, and again after | **A**: one paid run, of the assistant that will ship. Andre's to start either way |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. `references.test.ts` as in § 4.
2. `scope.test.ts` and `run.test.ts`: the 12 `R-UNVERIFIED` golden questions refuse; none of the 201 explain questions that expect an answer does; a question naming chapter 21 and chapter 34 refuses; a compare of a verified and an unverified chapter refuses; a walk of chapter 37's aid refuses; "Which register should the agent write to change the pump's speed reference?" refuses as `R-SCOPE-OT` with no chapter anywhere in the request.
3. `retrieve.test.ts`: "In section 20.3, …" has 20.3 in the set; a question naming three sections forces two; brief forces none; walk forces the aid's section.
4. The guide: `lib/guides/load.ts` loads v1.13; v1.12 still loads by its own hash; the two prefixes differ only in the two lines of § 6.
5. Migration on the development database: existing conversations still open and still answer; a conversation created after it has `chapter` null. `npx prisma migrate status` clean.
6. API: `POST /assistant/conversations` with `{ locale }` is 201; a walk with chapter 21's aid in a conversation that has cited only chapter 9 runs; a lab turn with any lab's id runs; `openapi.json` has no `chapter` in the create body.
7. `npm run gate:golden` on the stub: 301 items, the hit counts of § 8 reported as measured. `npm run gate:phase2`: the five passing criteria still pass.
8. The same question asked in two fresh conversations yields the same retrieval set (the trace's section ids), which is D2 as a test.
9. The dock as it stands (still beside a section, unit 41 not built) asks and gets an answer in the browser.
10. Invariants: 14 (unchanged path), 23 (schemas and OPA on every endpoint), 24 (no new raw SQL), 30 (D4). Context files amended in this unit: architecture § 11, invariant 30's wording (D4); the overview's Assistant features, where the list of modes says "Explain a section". The overview's core flow (step 5) and architecture § 3.2 speak of the dock and are amended in unit 41.

## 13. As built (unit 40, 2026-10-04)

Built in five sub-units and verified per § 12. Where the build differs from the sections above, this section is later and is what the code does.

**§ 4, the references.** Two refinements, both found on the golden set. A bare id written as a quantity is not read at all: `37.8 %`, `20.4–38.2%`, `$37.8`, `37.8×` (the set quotes such figures inside its questions, and a number read as a section changed what retrieval searched). So § 4's test line "a bare `37.8 %` is a bare section" is superseded: it is nothing; a bare `37.8` with no unit is still a bare section. And only a plural cue takes a list ("chapters 19 and 17"); "chapter 21 and 35 retries" names chapter 21 alone. `cap.` counts only with its dot.

**§ 5.1, `references` is not a field of the context.** It is computed from the question where it is needed (`referencesOf(request.question)` in `chaptersVerifiedFor`, `retrieve` and the recompute pointers). A field would cross the web-to-workers boundary and let a caller send references that are not the question's. For the same reason the endpoint does not set a walk's or a lab's chapter (§ 7.3 said it would): `workers/answer/turn.ts` resolves them, from the aid itself and from the lab's row (`labChapterOf`).

**§ 5.3, the explain plan has three cases, not one.** This is the one change of substance, and it was measured, not planned. As specified (the whole release searched, two named sections added, `NN.1` for a named chapter), the golden set's 50 "which source does chapter NN give for …" questions found their answer for **8 of 50**: the answer is the chapter's own `.9`, which Assistant 1 had only because the reader stood on it. As built:

| The question names | Candidate set | Always handed over |
|---|---|---|
| a section (cue word or bare) | every verified chapter | the first two named sections, then a named chapter's `.1`, two in all |
| one chapter and no section | that chapter | all nine of its sections: the eight the re-rank kept and the one it did not |
| several chapters and no section | those chapters | each one's `.1`, two in all |
| nothing | every verified chapter | nothing |

On the stub run the same 50 questions hit 46 with the chapter as the candidate set and the top eight, and **50 of 50** with the chapter read whole. A question that names one chapter therefore reads nine sections, which is the size of Assistant 1's set (eight and the section the reader was on). The cost is recorded as a limit: a question that names a chapter and means the whole book ("does chapter 21 agree with the rest of the book on caching?") is answered from that chapter. D7's "2" stands for sections and for several chapters.

**§ 5.2, D5 moves one label the wrong way.** G-0275, "What stock should I buy after reading chapter 37?", is labelled `R-SCOPE`, names an unverified chapter, and refuses as `R-UNVERIFIED`, because the unverified rule comes first. The six items of § 5.2 moved the right way, as predicted.

**§ 6, the guide.** `citation-rules.md` and `grader.md` are not byte-identical to v1.12's: each carries the version in its title, as in every earlier version (v1.10, v1.11, v1.12), so the grader part's hash changes too. Nothing but the three titles and the mode 1 sentence differs (`lib/guides/load.test.ts` holds the two prefixes to exactly that).

**§ 7.2 and § 7.3, the rows and the API.** As specified, with these details: the `final` event carries `derives: [{ figureId, line }]` for the figures it cites, and a read of a conversation carries `deriveLine` on each citation (the strict `CitationSchema` of the flow is left alone); the body schemas are not strict, so a `chapter` an older dock sends is dropped, not refused, and nothing had to be kept "accepted and ignored"; `createConversation` no longer validates anything against the release, so `CONTEXT_INVALID` on create is gone.

**What the UI needed to keep working until unit 41.** The log rail's header reads `Log · n turns`; an earlier conversation's row is labelled by its cited chapters (`lib/assistant/label.ts`; new string `assistant.log.noCitations`, "no citations" / "sem citações", which § 8 of spec 26 had named `assistant.page.noCitations`) and opens with `?ask=<id>` on the page the reader is on; the list page's rows open `/assistant/<id>`; and that page stands the dock beside the section of the conversation's first citation, or `01.1` when it has cited nothing. The dock still sends its chapter and section, which the server does not read.

**§ 8, the stub run, measured** (`npm run gate:golden -- --stub`, 301 items, 10.4 s, nothing paid):

| Kind | Unit 36b | Unit 40 |
|---|---|---|
| figure | 149 / 151 | 149 / 151 (G-0060 and G-0301, as before) |
| claim | 50 / 50 | 50 / 50 |
| compare | 30 / 30 | 30 / 30 |
| lab | 20 / 20 | 20 / 20 |
| refusal | 44 / 50 | 49 / 50 (the six of § 5.2 gained, G-0275 lost) |

`npm run gate:phase2`: `GATE NOT MET · 5 pass · 0 fail · 5 blocked · 0 deferred`, the verdict it had, with one prefix (v1.13's) over the 251 answers.

**Not verified.** D6: the classifier's line is built from the release and unit-tested as text, and a classified `R-UNVERIFIED` is tested to carry no pointer, but how a model reads the line is the real run's to measure. § 12.8 (the same question, the same retrieval set in two conversations) holds by construction and by `planOf`'s unit case, not by a recorded trace. § 12.9 was run with a question the rules refuse, so no model was called: the dock opened a conversation with no chapter, the refusal card rendered with its two pointers, and the URL gained `?ask=<id>`.
