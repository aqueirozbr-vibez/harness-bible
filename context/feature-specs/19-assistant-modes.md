# 19 · Compare, lab and brief modes — feature spec (contexts, retrieval scoping, mode results, mode sensors, the three bodies)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screens: `docs/design/screens/Assistant-Answer.html` and `Assistant-Refusal-Walk.html` (the mode radiogroup `Explain · Compare · Walk a decision aid · Explain a lab run · Executive brief`; the context line `context · ch21 v1.5.0 · 21.3 worked numbers` with `change context`; the log row `t2 · 10:34 · pass · Compare 37 and 15 on caching · compare · 6 citations`; the answer turn's shape, its `.cite` chips, the verdicts box and the action row, which the three bodies reuse); no screen shows a compare, lab or brief body, so this spec composes them from the design system (`.tbl` § 9.3 with the diff-table vocabulary, `.kv` § 9, `.cap`, `.notice`, `.midnum` § 13.5) and records that as a deliberate composition, not a difference. Governing context: `guides/assistant/v1.8/guide.md` § The five modes (2 compare: the two chapters' positions side by side on the asked point, each side cited from its own chapter; a disagreement the book leaves open is said to be open, never resolved; 4 lab: what the lab reproduces, which figures it checks and what a diverging figure means, from the lab's README, files and last run as retrieved; 5 brief: what Part III says on the asked decision in at most six claims, each cited from a Part III section; caps: 220 words for explain, compare and lab, six claims for the brief); `context/architecture.md` § 6.1 (output `{claims, refusal?, mode_result?}`; sensors after), § 11 invariants 11–15; `context/project-overview.md` § Assistant (five fixed modes; not a general chat); `context/feature-specs/12-retrieval.md` § 6 (scoping: compare = the two chapters with both `NN.1` always included; lab = the lab's chapter with the README as a pseudo-section plus `NN.4`; brief = Part III chapters 34–40 with the context chapter's `NN.8` when it is in Part III); `13-assistant-agent.md` § 3 (`AnswerRequest.context {chapter, section, chapters?, labId?}`, `mode_result`, the five verdict rows), `15-conversations-api.md` § 5 (the message post's `context`; `chapters` must be two distinct verified chapters), `16-assistant-dock.md` § 5.3 and D3/D4 (the radios enabled, the context line, `change context` as a link), `17-refusal-log-flags.md` § 5 (log row `{mode} · {n} citations`), `18-decision-aid-walk.md` (the walk; the pattern of a mode's own turn component and sensor row). The lab data the pipeline already stores: `Lab` (`readme`, `title`, `expectedRuntimeS`, `declaresModelCalls`, `egressExtra`, `derived`, `ciVerdict`, `ciCheckedAt`), `LabFile` (paths without `results/`), `Figure` → `DeriveLink` (`labId`, `filePath`, `line`, `expression`).

Prerequisite specs: 12, 13, 15, 16 (18 for the pattern only).

Scope: tracker unit 33. Everything the three modes need beyond Explain: the context each takes and how the dock collects it, the web tier's validation, the pseudo-sections retrieval adds for lab mode, the `mode_result` schemas, the mode sensor and its verdict row, the three turn bodies, the context line, the log row and status cells. Not here: the phone sheet (20), the golden-set runner over these modes (22), opening the lab (Phase 3; `labHref` stays null until then).

## 1. Purpose

Explain answers about the section on screen. The other three modes change what the assistant reads and what shape the answer takes, without changing the rules: every claim still cites a section, every number still comes from the book, and the sensors still decide what reaches the screen. Compare puts two chapters' positions side by side and says when the book leaves a point open. Explain a lab run tells a reader what the chapter's lab reproduces and how its last run went, from the lab's own README and CI results. Executive brief answers a decision question from Part III in at most six cited claims. The mode is a contract the reader can see: the context line says what is being read, and a mode row in the verdicts says the shape was kept.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| Retrieval's per-mode scoping (spec 12 § 6, done in unit 26) | the candidate sets; this spec adds the lab pseudo-sections' text |
| The flow and the five sensors (spec 13) | the mode sensor is a sixth, pure, in the same shape |
| The message post and its `context` validation (spec 15) | compare's `chapters`, lab's `labId` |
| The dock, turns, chips, verdicts (spec 16), log rows (17) | the bodies render inside the answer turn |

Build order: 33a the contracts: `CompareResult`, `LabResult`, `BriefResult` in `lib/schemas/assistant.ts`, the guide's mode-result paragraph for compare and lab (a v1.8 amendment, re-pinned), the mode sensor `lib/sensors/mode.ts` with its verdict row → 33b the lab pseudo-sections (`lib/labs/pseudoSections.ts`: README and last run as text; the figures-checked table computed in code) and the web tier's context validation for the three modes → 33c the dock: `ModeContext` (the per-mode context line and pickers), `CompareTurn`, `LabTurn`, `BriefTurn`, the log row and status cells → 33d strings, the golden-set items for compare and lab through the flow, verification.

## 3. Contexts and what the reader picks (33c, validated in 33b)

| Mode | Context the post carries | The dock collects it | Context line |
|---|---|---|---|
| compare | `chapters: [a, b]`, `a` the current chapter by default | a `.select` of the release's verified chapters for the second (`compare with · chapter`), the first swapped with a `swap` `.xref`; unverified chapters listed disabled with `unverified` | `context · ch37 v1.3.2 ↔ ch15 v1.1.0` |
| lab | `labId` of the current chapter's lab | none (a chapter has at most one lab); a chapter without a lab shows the picker's `Empty` `Chapter 05 has no lab. Chapters with labs: …` and the composer stays disabled | `context · Lab 21 · ch21 v1.5.0 · last run REPRODUCED · 23 Sep 2026` |
| brief | `chapter` only | none; the line names Part III | `context · Part III · from ch37 v1.3.2` (a context chapter outside Part III: `context · Part III · ch34–40`, D4) |

`change context` keeps spec 16 D4's meaning (a link to the section page) for explain and lab; for compare the second chapter is chosen in the dock (D3) because there is no page for it. The composer's label follows the mode: `compare chapter {a} with chapter {b} on…`, `ask about Lab {n}`, `ask for a brief on…`; the placeholder gives one example each (§ 8).

Web tier (spec 15's endpoint): compare requires `chapters` of two distinct chapters both `PASSED` in the release (422 `CONTEXT_INVALID` with field `chapters` and the failing chapter; an unverified one is also `R-UNVERIFIED` territory, but the endpoint refuses first so no turn is created); lab requires `labId` naming the context chapter's `Lab` row (422 field `labId`); brief takes the chapter as is. The `contextLabel` on the conversation stays the chapter's; the message row keeps the mode and the context JSON already in spec 15.

## 4. What retrieval adds for lab mode (33b)

Spec 12 scopes lab mode to the lab's chapter and always includes the README as a pseudo-section (`labId`, layer null) plus `NN.4`. This spec defines the two pseudo-sections' text, built in `lib/labs/pseudoSections.ts` (pure, from the `Lab` row and the chapter's figures):

- `lab:{labId}:readme`: the README's plain text (`Lab.textEn`), with the facts line first: `Lab 21 · expected runtime 2 m · model calls: none · egress: none`.
- `lab:{labId}:lastRun`: `last run: REPRODUCED · CI · 23 Sep 2026` and one line per figure the lab checks: `p_no_failure_f0.02 · chapter 0.769 · last run 0.769 · match` (D2: the last run in Phase 2 is CI's, from `ciVerdict`, `ciCheckedAt` and `derived`; Phase 3's `LabRun` replaces it with the reader's own run when one exists).

The figures the lab checks are the chapter's `Figure` rows whose `DeriveLink.labId` is this lab; each is matched to a `derived` value by `DeriveLink.expression` (the key the script prints; `—` when the key is absent, never a guess), and `match` / `diverge` is decided in code by the pipeline's own numeric comparison (`lib/labs/checkedFigures.ts`: `{ figureId, key, chapterValue, runValue | null, verdict: "match" | "diverge" | "missing" }`). The model receives these lines as retrieved text and may quote them; the citation sensor verifies a quoted figure against the `Figure` row as usual (the pseudo-section carries the chapter's `figureIds`). Compare and brief add nothing: their scoping is sections only.

## 5. Mode results and the mode sensor (33a)

```ts
const CompareResultSchema = z.object({ openPoint: z.string().max(240).nullable() });     // the point the book leaves open, in the model's words, or null
const LabResultSchema = z.object({ reproduces: z.string().max(240), divergingMeans: z.string().max(240).nullable() });   // what the lab reproduces; what a diverging figure would mean (null when the last run matched everything)
const BriefResultSchema = z.object({ decision: z.string().max(120), stance: z.enum(["recommends", "conditional", "leaves-open"]), condition: z.string().max(240).nullable() });
const ModeResultSchema = z.union([WalkResultSchema, CompareResultSchema, LabResultSchema, BriefResultSchema]).nullable();
```

`parse.ts` picks the branch by the request's mode (a result of another shape is a parse failure, the one cap). The grouping of compare claims by chapter, the figures table in lab mode and the count of brief claims are all computed in code from the claims and the data, never taken from `mode_result` (invariant 12's spirit: the model's structure is checked, not trusted).

`lib/sensors/mode.ts` (pure, `(request, output, retrieved) => SensorVerdict` with `sensor: "mode"`, added to the enum; NA in explain and walk):

| Mode | PASS when | FAIL detail |
|---|---|---|
| compare | at least one surviving claim cites each of the two chapters, and no claim cites a third | `only chapter 37 cited` / `cites chapter 12, outside the pair` (the outside claim is substituted) |
| lab | every claim cites the lab's chapter, and every figure quoted is one the lab checks (by `figureId`) | `quotes F-21-05, not checked by Lab 21` (substituted) |
| brief | 1 to 6 claims, every one in Part III (34–40), `mode_result.stance` present | `7 claims` (the seventh and later are dropped, WARN), `cites 21.3, outside Part III` (substituted) |

The verdict row reads `mode · compare · both chapters cited`, `mode · lab · 4 figures from the run`, `mode · brief · 6 of 6 in Part III`; it runs after the citation sensor and before the grader, and the box counts it (`6 of 6 pass` on these modes). The flow's substitution rule applies to a claim the mode sensor rejects exactly as to an uncited one.

Guide v1.8 gains one paragraph in its output section naming the three results (the walk's is spec 18's); `guides/assistant/v1.8/manifest.json` is re-pinned and `lib/guides/load.ts` verifies it (the amendment is a guide change under invariant 10, made as its own commit).

## 6. The three bodies (33c)

All three are variants of spec 16's answer turn: the same `.turn.turn-assistant`, head line `assistant · compare · 10:34`, the `cites` line, the verdicts box, the action row (`Copy with citations`, `Flag this answer`) and the record footer. What differs is the body between the head and the verdicts.

### 6.1 `CompareTurn`

```
.compare                       two columns at ≥ 1200 (the dock's 520px: 2 × ~230), one column below
  .compare-side × 2
    .cap                       "ch37 · cost model"  (chapter number and title)
    ol.claims                  the chapter's claims in order, each with its CitationChip
  .compare-open (when openPoint) .notice  "the book leaves this open · {openPoint}"   (`.notice` in the warn tone, no chip: it is the model's summary, and the mode sensor has verified both sides are cited)
```

A side with no surviving claims (all substituted) shows the substitution sentence once; the mode sensor has already failed the turn in that case and the verdicts say so.

### 6.2 `LabTurn`

```
.labturn
  .kv                          lab · Lab 21 · control plane      last run · REPRODUCED · CI · 23 Sep 2026      expected runtime · 2 m      model calls · none
  table.tbl.lab-figures        caption "figures Lab 21 checks"   th figure · chapter · last run · —
                               tr per checked figure: FigureChip · .n chapter value (with its tier mark) · .n run value · .d-match "= match" | .d-div "≠ diverge" (tr.row-div) | "—" missing
  p.ui  the claims in order with chips (explain's rendering)
  .turn-actions                + "Open Lab 21" (spec 16's `openLab`; disabled with the help text `labs open in Phase 3` while `labHref` is null)
```

The `.kv` and the table come from the data the turn was answered with (the `final` event carries `lab: { title, verdict, checkedAt, expectedRuntimeS, declaresModelCalls, figures[] }` computed by the workers from the same pseudo-section input, so the screen and the model saw one thing). The book value is the left column (§ 9.3).

### 6.3 `BriefTurn`

```
.brief
  .cap                         "executive brief · {mode_result.decision}"
  .brief-stance                .st  recommends (ver) | conditional (warn) | leaves open (muted)   + .small the condition when present
  ol.brief-claims              ≤ 6 numbered claims, each with its CitationChip (chapter and section: "37.8")
  p.small.muted                "from Part III · {n} chapters cited"
```

The reading column's cited band and highlights (spec 16 § 7) apply when a citation is in the current chapter; a brief from Part I cites nothing on screen, and the band stays absent.

### 6.4 Log row and status bar

`.cap` per mode: `compare · 6 citations`, `lab · 4 citations`, `brief · 6 claims`. Status bar: `assistant docked · compare` / `· lab` / `· brief`; the trailing cell stays `first token 0.8 s`.

## 7. States

| State | Rendering |
|---|---|
| Compare, second chapter not chosen | the select shows `choose a chapter`; `Ask` disabled with `help` `pick the chapter to compare with` |
| Compare, same chapter twice | the select refuses the current chapter (disabled option) |
| Lab, chapter without a lab | the `Empty` and a disabled composer (§ 3) |
| Lab, CI never ran (`ciVerdict` null) | `.kv` `last run · none yet`; the table's run column `—`; the pseudo-section says `last run: none` |
| Brief, context outside Part III | allowed, the line names Part III (D4) |
| Mode sensor FAIL | the substituted claims, the row in fail, `n of 6 pass`, the log row in warn with `1 claim replaced` |
| Streaming | as explain: tokens, then the body from `final` only (invariant 14; the compare columns and the lab table appear with `final`) |

## 8. Strings (`assistant.compare.*`, `assistant.lab.*`, `assistant.brief.*`, `assistant.mode.*`; PT candidates)

`compare.with` compare with · chapter / comparar com · capítulo; `compare.choose` choose a chapter / escolha um capítulo; `compare.swap` swap / trocar; `compare.unverified` unverified / não verificado; `compare.help` pick the chapter to compare with / escolha o capítulo para comparar; `compare.label` compare chapter {a} with chapter {b} on… / comparar o capítulo {a} com o {b} sobre…; `compare.placeholder` Where do chapters 37 and 15 agree on caching? / Onde os capítulos 37 e 15 concordam sobre cache?; `compare.open` the book leaves this open · {point} / o livro deixa isto em aberto · {point}; `compare.context` context · ch{a} {va} ↔ ch{b} {vb}; `lab.label` ask about Lab {n} / perguntar sobre o Lab {n}; `lab.placeholder` What does Lab 21 reproduce, and which figures does it check? / O que o Lab 21 reproduz e quais números ele confere?; `lab.noLab` Chapter {n} has no lab. Chapters with labs: {list}. / O capítulo {n} não tem lab. Capítulos com lab: {list}.; `lab.context` context · Lab {n} · ch{n} {v} · last run {verdict} · {date}; `lab.kvLab` lab; `lab.kvRun` last run / última execução; `lab.kvRuntime` expected runtime / duração esperada; `lab.kvModel` model calls / chamadas a modelo; `lab.none` none / nenhuma; `lab.notYet` none yet / ainda nenhuma; `lab.figures` figures Lab {n} checks / números que o Lab {n} confere; `lab.thFigure` figure / número; `lab.thChapter` chapter / capítulo; `lab.thRun` last run / última execução; `lab.match` = match / = confere; `lab.diverge` ≠ diverge / ≠ diverge; `lab.phase3` labs open in Phase 3 / os labs abrem na Fase 3; `brief.label` ask for a brief on… / pedir um resumo sobre…; `brief.placeholder` Should we route review to a small model first? / Devemos rotear a revisão primeiro para um modelo pequeno?; `brief.cap` executive brief · {decision} / resumo executivo · {decision}; `brief.recommends` recommends / recomenda; `brief.conditional` conditional / condicional; `brief.leavesOpen` leaves open / deixa em aberto; `brief.from` from Part III · {n} chapters cited / da Parte III · {n} capítulos citados; `brief.context` context · Part III · from ch{n} {v} / contexto · Parte III · a partir do ch{n} {v}; `brief.contextOutside` context · Part III · ch34–40; `mode.name` mode / modo; `mode.compare` both chapters cited / os dois capítulos citados; `mode.compareOne` only chapter {n} cited / só o capítulo {n} citado; `mode.compareOutside` cites chapter {n}, outside the pair / cita o capítulo {n}, fora do par; `mode.lab` {n} figures from the run / {n} números da execução; `mode.labOutside` quotes {figure}, not checked by Lab {n} / cita {figure}, não conferido pelo Lab {n}; `mode.brief` {n} of {m} in Part III / {n} de {m} na Parte III; `mode.briefOutside` cites {section}, outside Part III / cita {section}, fora da Parte III; `mode.briefMany` {n} claims, six kept / {n} afirmações, seis mantidas; `mode.na` n/a; log `compare · {n} citations`, `brief · {n} claims` / `resumo · {n} afirmações`.

## 9. Keyboard, accessibility

- The compare select is a labelled `.select`; its disabled options carry the `unverified` text, not colour alone.
- The compare columns are two lists under `.cap` headings; a screen reader hears chapter, then its claims. Below 1200 they stack in the same order.
- The lab table is a `table` with `caption`, `th scope="col"`, the diff cells as symbol and word (`= match`), the diverging row `tr.row-div` also marked by the cell text.
- The brief's stance is a `.st` with its word; the claims are an ordered list.
- The mode verdict row is announced like the others; the box's `n of m` includes it.

## 10. Out of scope

- The reader's own lab run as the last run (Phase 3, `LabRun`); opening the lab (`labHref` null until then).
- Comparing three or more chapters, or two sections of one chapter (the guide says two chapters).
- A brief from outside Part III's chapters as sources (the scope is fixed; a question that needs Part II gets `the book does not cover this` in the brief).
- Mode-specific golden-set expansion (spec 22 runs the existing 30 compare and 20 lab items; brief items exist only as unverified-chapter refusals).

## 11. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | What `mode_result` carries for compare and lab | A minimal: the open point; what the lab reproduces and what divergence means / B structured sides and figure tables from the model | **A**: sides, tables and counts are computed in code from the claims and the data; the model's structure is checked by the mode sensor, not rendered |
| D2 | The "last run" in Phase 2 | A CI's verdict, date and `derived` values / B none until Phase 3 | **A**: the guide names the last run; CI's is real, dated and already stored; Phase 3 swaps in the reader's own |
| D3 | Compare's second chapter | A a select inside the dock / B `change context` as a link (spec 16 D4) | **A** for the second chapter only: no page stands for "chapter 15 as the other side"; the first stays the current chapter |
| D4 | A brief asked from a chapter outside Part III | A allowed, scoped to Part III / B refused `R-SCOPE` | **A**: the mode defines its sources, not the reader's position in the book |
| D5 | The mode sensor's place | A a sixth verdict row `mode`, NA on explain and walk / B folded into the citation row's detail | **A**: a reader sees the shape was kept as its own line; the count `n of m` grows by one on these modes |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Schemas: each `mode_result` branch parses for its mode and fails for another; the guide re-pins and `loadGuide` accepts the new manifest.
2. Mode sensor (pure, fixtures): compare with claims on 37 and 15 → PASS; only 37 → FAIL `only chapter 37 cited`; a claim on 12 → FAIL and that claim substituted; lab quoting `F-21-05` not checked → FAIL and substituted; brief with 7 claims → WARN, six kept; a claim on 21.3 → FAIL; explain → NA.
3. Pseudo-sections (ch21 fixture): the README text starts with the facts line; the last-run text lists ch21's four checked figures with `match`, values equal to the `Figure` rows and `derived`; a lab with `ciVerdict` null yields `last run: none`; a figure whose key is absent yields `—` and `missing`.
4. Web tier: compare with `[21, 21]` → 422 `chapters`; with an unverified chapter → 422 naming it; lab with a foreign `labId` → 422 `labId`; brief from ch05 → 200 and the stream.
5. End to end (stub gateway, workers): the golden set's 30 compare items answer with both chapters cited and `mode · compare · both chapters cited`; the 20 lab items cite `NN.4` or the README pseudo-section and their tables list the checked figures; a brief on ch37 renders ≤ 6 numbered claims, all in 34–40, with the stance line; each turn's log row reads its `.cap`; reload renders the bodies from the message view.
6. Dock: the compare select lists verified chapters, disables the current and unverified ones, the swap exchanges the pair, the context line shows both versions; lab mode on ch05 shows the `Empty`; the `Open Lab 21` button is disabled with its help text; the status cells per mode.
7. Layout: the compare columns at 1440 and stacked in the 900 overlay; the lab table inside 520px without horizontal scroll at EN and PT (a `.scroll` wrapper when a figure label is long); PT strings without overflow.
8. axe: zero WCAG 2.2 AA violations on the three bodies and the compare picker, EN and PT.
9. Token grep clean; new classes (`.dock-context-pick`, `.compare`, `.compare-side`, `.compare-open`, `.labturn`, `.lab-figures`, `.brief`, `.brief-stance`, `.brief-claims`) in `globals.css` and ui-context § 9.9; message parity.
10. Invariant check: 12 (grouping, tables, counts and match verdicts in code), 14 (bodies from `final` only), 10 (the guide amendment is its own commit with a new pin), 11 (the mode sensor runs before the grader and before anything reaches the screen).
