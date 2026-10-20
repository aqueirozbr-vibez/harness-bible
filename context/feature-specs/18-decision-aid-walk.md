# 18 · Decision-aid walk — feature spec (the walk mode: inputs, the script run, the steps, the explanation)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth for the screen: `docs/design/screens/Assistant-Refusal-Walk.html` (desktop, 1440) with `png/Assistant-Refusal-Walk.png`, state b: the turn `you · 10:40 · mode changed to walk a decision aid · 37.8`, the walk instrument (`Walk · 37.8 · which configuration? · step 2 of 4`), the four-step strip (`1 · done Your inputs`, `2 · now Cost per task` with `aria-current="step"` and the `--act` rule, `3 Review load`, `4 Choose` faint), the inputs grid (`.field` pairs: `queries per day 2,000`, `steps per task 11`, `share routed to human review (%) 36.5`, `cache hit rate (%) 62`, `.input.mono` with `inputmode`), the run line (`.loader` `lab-37/derive.py ▮▮▮▮▮▮▮▮▮▮ 100%` · `exit 0 · 0.8 s`), the step result (`step 2 · cost per task, a against c`, two `.meter` bars `A 13×` and `C 1×` in the ver tone, the `.midnum` `13×` beside the sentence `Configuration C is 13× cheaper per task than A at these inputs ƒ 37 derive L142.`, the muted line `Prices come from source rows verified 02 Sep 2026 37.9. Your inputs equal the book's P-101 scenario, so the result equals the book's figure.`), the footer (`Back`, `Flag this step`, primary `Next: review load`), the collapsed verdicts (`derive output matched · 3 of 3 pass`); the reading column's `walking` band (`The assistant is walking this aid with your inputs. Step 2 of 4.`, run tone on `--act-bg`), `decision aid · which configuration?` with the `.tree.box` of the four steps (`✢`, `├─ └─`, `done` / `now` marks), the `.tbl` `configuration · what it is · cost / task` with the chosen row `.sel` and the footer `relative to C · scenario inputs ƒ L142`; the log row `t4 · 10:40 · step 2/4 · Walk 37.8 with our inputs · walk · derive run 1`; the status bar `assistant docked · walk · step 2 of 4` and `derive run 0.8 s`. Governing context: `context/architecture.md` § 6.3 (the decision-aid walk: load the aid schema → validate inputs against declared ranges → run the script with the inputs in the lab's image, no user shell, no egress → return the result, derive line, source verification date → ledger record; an input outside its range is a field error naming the range; the model never computes, it explains a result the script produced), § 6.1 (the assistant may read decision-aid results), § 11 invariants 12 (arithmetic in code), 20 (sandbox egress default-deny); `context/project-overview.md` § Assistant (the walk runs the chapter's `derive.py` at the user's inputs in a read-only sandbox with no egress; the model explains the result, it does not compute it) and § Success criteria · Phase 2 (the 37.8 walk at the book's P-101 inputs returns the chapter's own figure with a derive chip and the source verification date); `context/ui-context.md` § 9.6 (`.meter`, `.loader .blocks`), § 9.2 (`.field .input`), § 9.5 (`.tree`), § 13.4 (`✢`, box-drawing), § 13.5 (`.midnum`); the aids built on 2026-09-23: `aids/*.json`, `lib/aids/` (`checkInputs` naming the range, `applyAid`, `runAid` in the lab tier's container, `stepValues` by slash paths), `aids.*` message keys.

Prerequisite specs: `13-assistant-agent.md` (walk mode's `aidResult` in the prompt, `mode_result`), `15-conversations-api.md` (`aidInputs` on the message post), `16-assistant-dock.md` (the dock and turns), `17-refusal-log-flags.md` (log rows, flags).

Scope: tracker unit 32. The walk mode end to end: choosing an aid, the inputs form, the run in the workers through the container, the results per step, the model's explanation checked against the script's values, the step strip with Back and Next, the reading column's band and tree, the log row, the status bar cells, the ledger record's walk fields. Not here: new aids (data files, any time), the phone sheet (20).

## 1. Purpose

A decision aid is the book's own script run at the reader's numbers. The reader types their inputs, the script runs where it cannot reach anything, and the assistant explains what came out, quoting only what the script printed and pointing at the line that printed it. The steps make the aid a walk rather than a calculator: each step shows one question, its values and one explanation, and the reader moves through them. Nothing on screen is an estimate: the values are the script's, the explanation is checked against them, and the source rows' verification date says how fresh the prices are.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| `lib/aids/` and the two aids (done): schema, `checkInputs`, `applyAid`, `runAid` with `AID_RUNNER=docker`, `stepValues` | the mechanism; this spec adds presentation fields to the schema (§ 3) |
| The workers container (spec 11) with Docker available to it | the run happens in the workers, in the lab tier's container |
| The answer flow (spec 13) with `aidResult` in the prompt and `mode_result` for walk | the explanation |
| The message post's `aidInputs` and the `final` event's `modeResult` (spec 15) | the transport |
| The dock, turns, log rows, flags (specs 16, 17) | where the walk renders |

Build order: 32a the aid schema's presentation fields and the aid picker (`listAidsFor(chapter)`; `aids.*` strings for both aids complete) → 32b the workers' run path: `runAidForTurn` (validate, run, `stepValues`, the source verification date, the run record), the `deriveConsistency` sensor, the walk's `mode_result` and the flow's walk branch (spec 13 § 5 slot 5) → 32c the dock: `WalkTurn` (`DecisionAidForm`, the step strip, `StepResult`, the run line, Back / Next / Flag this step), the log row and status cells → 32d the reading column's band and tree → verification.

## 3. The aid as data (extends `lib/aids/schema.ts`)

Each step gains presentation the client renders without arithmetic of its own beyond what is declared:

```ts
const AidStepSchema = z.object({
  ordinal, titleKey, reads, line,                           // as built
  /** What the step shows: bars over declared paths, and one headline. Arithmetic is limited to these two forms, computed in code (invariant 12). */
  bars: z.array(z.object({ labelKey: MESSAGE_KEY, path: z.string(), tone: z.enum(["ink", "ver"]).default("ink") })).default([]),
  headline: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("value"), path: z.string(), unit: z.string().nullable() }),
    z.object({ kind: z.literal("ratio"), of: z.tuple([z.string(), z.string()]), format: z.literal("times") }),   // "13×" = of[0] / of[1]
    z.object({ kind: z.literal("pct"), path: z.string() }),
  ]).nullable().default(null),
  /** The section whose source rows price the step, for the verification-date line; null when none. */
  pricesFrom: SectionIdSchema.nullable().default(null),
});
```

`aids/ch37-which-configuration.json` gains, for step 2, `bars: [{ labelKey: "a", path: "A/total" }, { labelKey: "c", path: "C/total", tone: "ver" }]`, `headline: { kind: "ratio", of: ["A/total", "C/total"], format: "times" }`, `pricesFrom: "37.9"`; step 3 bars over `sensitivity_B/esc/0.0`, `…/0.1`, `…/0.3` and headline `pct` on `saving_A_to_C_route70_pct`; step 4 headline `value` on `breakeven_vs_C_queries` with unit `queries per month`. `aids/ch21-task-survival.json` gains bars over the three `p_no_failure` keys and a `pct` headline per step. The ratio is `of[0] / of[1]` rounded to one decimal in code and shown as `13×` (the bars' widths are `value / max` of the step's bars, also code); nothing else is computed. `checkAid` extends to the new paths (every `bars[].path`, `headline` path and `of` must be among `reads`, so a step can only present what it reads).

`listAidsFor(chapter)` returns the aids whose `chapter` matches; the current release's `Lab` row for `labId` supplies the lab folder (the workers copy the lab's `LabFile` rows into the scratch folder, so the run uses the release's pinned files, never the book checkout, D1).

## 4. The run (workers, 32b)

`runAidForTurn({ aid, inputs, releaseId, principal, traceId })`:

1. `checkInputs` (pure; the web tier already ran it and answered 422, § 6, so a failure here is a defect).
2. Materialise the lab folder from `LabFile` rows of the release (D1), `runAid` with the `docker` runner (spec 11 § 7's workers hold `DOCKER_BIN`; `AID_RUNNER=python` only on a machine without Docker), the lab tier's cap (`Lab.wallClockCapS`).
3. On `exitCode !== 0`, a timeout, or missing results: the turn ends as a failed run (§ 7), no model call.
4. `stepValues` for every step; a step with `missing` paths is reported as such (the model is told the value is absent; the client shows `—`).
5. The prices line: `pricesFrom`'s source rows' latest `verifiedAt` (the section's `NN.9` rows the aid names), formatted by the client.
6. Build `AidStepResult[]` (per step: ordinal, values by path, the derived headline and bar numbers computed here, the line) and hand it to the flow as `aidResult`; the assembler fences it as `<aid>` (spec 13 § 5 slot 5) with every value labelled by its key and line.

The model's output for walk mode (spec 13's `mode_result`): `{ steps: [{ ordinal, explained: string ≤ 60 words }] }` plus the usual `claims` (the explanations are also claims citing the aid's section, `figureId: null`). The `deriveConsistency` sensor (`lib/sensors/deriveConsistency.ts`, pure): every number in an explanation (the pipeline's `NUM_SOURCE` grammar) must equal, after normalising separators and the `×` / `%` suffixes, one of that step's values, headline or bar numbers, or a number the fenced aid result carries; a number that matches nothing fails the explanation, which is substituted like an uncited claim (`the book does not cover this` becomes, for a step, the sentence `The script's values are shown above; the explanation was withheld.` `assistant.walk.withheld`, D2). Verdict row: `derive output matched · n of m steps` (the verdicts box shows it as the first row on a walk turn, then the five of spec 13; the screen's `3 of 3 pass` summary counts the walk's own checks).

The ledger record (spec 14's `ANSWER` payload) gains, for walk turns, `aid: { id, inputsSha256, runMs, exitCode, valuesSha256 }` (the inputs and values as hashes: they are the reader's numbers).

## 5. The dock (32c)

### 5.1 Choosing the aid

Selecting `Walk a decision aid` in the mode strip replaces the composer's textarea with the aid picker: the aids of the context chapter as `.seg` (one aid: preselected and the seg hidden; none: `Empty` `This chapter has no decision aid yet. Chapters with one: 21, 37.` and the mode's context line unchanged). Below the picker, `DecisionAidForm`: the inputs grid (two columns, `.field` per input with the catalogue label, `.input.mono`, `inputmode` numeric or decimal by `integer`, the default from the aid, `aria-describedby` a `.help` with the range `between 100 and 100,000`), and the primary `Run at these inputs` (`assistant.walk.run`). No question text: the walk's user turn is the inputs (the log row and the user block read `Walk 37.8 with our inputs`, `you · 10:40 · mode changed to walk a decision aid`).

### 5.2 The walk turn

`article.turn.turn-walk` (`aria-label="Turn n, walking decision aid 37.8"`): the user line (`you · 10:40 · mode changed to walk a decision aid` and the aid's section at the right), then `section.inst.walk` with `.inst-h` `Walk · 37.8 · which configuration? · step 2 of 4`, the step strip `ol.walk-steps` (grid of n columns; each `li` with a top rule: ink for done, `--act` for now with `aria-current="step"`, `--rule` faint for later; `.meta` `1 · done` / `2 · now` / `3`, `.small` the step title), then, for step 1, the inputs as read-only `.field`s with an `Edit inputs` quiet button (returns to the form; a new run is a new turn); for steps 2 to n, the run line (`.loader` `lab-37/derive.py` with ten `.blocks` and `100%`, `.meta` `exit 0 · 0.8 s`), `StepResult`: `.cap` `step 2 · cost per task, a against c`, the bars (`.meter`, `.meter.ver`, label, value formatted per unit), the headline `.midnum` in `--ver` beside the explanation `p.ui` with the `DeriveLink` `ƒ 37 derive L142` (the step's `line`; opens the lab's code pane as the reader's derive chips do), the prices line `p.small.muted` with `Cite {pricesFrom}` and the verification date, and, when the inputs equal the aid's defaults, the sentence `Your inputs equal the book's scenario, so the result equals the book's figure.`; a withheld explanation shows the withheld sentence in `.nocover` form. Footer `.inst-f`: `Back` (disabled on step 1), `Flag this step` (the message's flag with the step in the reason's detail; one flag per message still: the dialog names the step), the grow, primary `Next: {next step title}` (on the last step `Done`, which collapses the walk to its summary line `walked · 4 steps · 13×`).

Steps are client state within the turn (all values arrived in `final`); Back and Next change nothing on the server. During the run the turn shows the run line at `0%` growing with the status events (`status: running` from the workers; the loader's blocks fill on `final`; the caret stays the only animation, the blocks step in discrete events, D3) and the log row reads `step 1/4` in the running tone with `walk · derive run 1`.

Verdicts: the box reads `derive output matched · 3 of 3 pass` collapsed, expanding to the walk row plus the five.

### 5.3 Status bar

`assistant docked · walk · step 2 of 4` while a walk turn is current; trailing cell `derive run 0.8 s` (the run's `ms`) instead of `first token`.

## 6. The web tier (spec 15's endpoint, extended)

`POST /assistant/conversations/{id}/messages` with `mode: "walk"` requires `aidId` and `aidInputs`; the endpoint loads the aid (`findAid`; 422 `AID_UNKNOWN` when it is not the context chapter's), runs `checkInputs` and answers 422 `AID_INPUTS` with `errors[]` (`key`, `reason`, `min`, `max`) so the form names the range beside each field (`between {min} and {max}`, `whole numbers only`, `enter a number`), stores the inputs on the user message (`Message.aidInputs Json?`, a new column, D4), and forwards. The `final` event carries `modeResult` (the steps with values and explanations, the run line data) and the row's view holds it (`Message.modeResult Json?`) so a reload renders the walk.

## 7. States

| State | Rendering |
|---|---|
| Chapter without an aid | the picker's `Empty` with the chapters that have one |
| Inputs invalid | 422 field errors under the inputs; `Run` stays enabled |
| Running | the turn with the run line at 0%, the strip on step 1 `now`, the log row `step 1/4`, `Run` disabled |
| Run failed (`exitCode ≠ 0`, timeout, no results) | the turn shows the run line `exit 1 · 12.0 s` in `--fail` and an `ErrorBox` `The script did not finish at these inputs. Nothing was explained.` with `Edit inputs`; no model call; the log row `failed`; a failed-turn row (spec 15 § 6.3) with the run's exit code in the verdict detail |
| Docker unavailable in the workers | 503 `ASSISTANT_UNAVAILABLE` before the turn; the composer's error box |
| Explanation withheld by the sensor | the step's values and bars shown, the withheld sentence, the verdict `derive output matched · 2 of 3` in warn |
| Reading column | the `walking` band with the step count, the tree with `done` / `now` marks following the strip, the section's own prose beneath (the screen's table and walk prose are not in the book: § 11) |

## 8. Strings (`assistant.walk.*`, the `aids.*` labels exist; PT candidates)

`mode` walk a decision aid; `pick` decision aid / auxílio de decisão; `noAid` This chapter has no decision aid yet. Chapters with one: {list}. / Este capítulo ainda não tem auxílio de decisão. Capítulos com um: {list}.; `range` between {min} and {max} / entre {min} e {max}; `integer` whole numbers only / só números inteiros; `number` enter a number / digite um número; `run` Run at these inputs / Executar com estas entradas; `you` you · {time} · mode changed to walk a decision aid / você · {time} · modo alterado para percorrer um auxílio de decisão; `userLine` Walk {section} with our inputs / Percorrer {section} com nossas entradas; `title` Walk · {section}; `step` step {n} of {m} / passo {n} de {m}; `done` done / feito; `now` now / agora; `inputs` Your inputs / Suas entradas; `editInputs` Edit inputs / Editar entradas; `runLine` {lab}/derive.py; `exit` exit {code} · {s} s; `stepCap` step {n} · {title}; `sameAsBook` Your inputs equal the book's scenario, so the result equals the book's figure. / Suas entradas são iguais ao cenário do livro, então o resultado é igual ao número do livro.; `prices` Prices come from source rows verified {date} / Os preços vêm de linhas de fonte verificadas em {date}; `withheld` The script's values are shown above; the explanation was withheld. / Os valores do script estão acima; a explicação foi retida.; `back` Back / Voltar; `flagStep` Flag this step / Sinalizar este passo; `next` Next: {title} / Próximo: {title}; `finish` Done / Concluir; `walked` walked · {n} steps · {headline}; `matched` derive output matched · {n} of {m} / saída do derive conferida · {n} de {m}; `failed` The script did not finish at these inputs. Nothing was explained. / O script não terminou com estas entradas. Nada foi explicado.; `band` The assistant is walking this aid with your inputs. Step {n} of {m}. / O assistente está percorrendo este auxílio com suas entradas. Passo {n} de {m}.; `walking` walking / percorrendo; `statusWalk` assistant docked · walk · step {n} of {m}; `runMs` derive run {s} s; `derive` ƒ {chapter} derive L{line}.

## 9. Keyboard, accessibility

- The strip is an `ol` with `aria-current="step"`; Back and Next are buttons; `Next` is the one primary in the walk; arrow keys are not bound (steps are buttons in order).
- Inputs are labelled fields with `inputmode`, `aria-describedby` for the range and `aria-invalid` with the error text on 422.
- The bars are `Meter` (`role="meter"` with `aria-valuenow`, `aria-label` the bar's label); the headline is text.
- The run line's `.loader` is `role="status"`; the blocks are text glyphs; `aria-live` announces `exit 0` once.
- The tree in the reading column is a list with the marks in words (`done`, `now`).

## 10. Out of scope

- Authoring aids in the UI, or aids for chapters beyond 21 and 37 (data files in `aids/`, each a small unit with its `aids.*` strings).
- Running `run.py` (the lab's reproduction) from the walk: the IDE's job (Phase 3).
- Multiple aid runs inside one turn: new inputs are a new turn (the log keeps every run as `derive run n`).
- Charts beyond bars: § 13.5 allows ruled tables and single numbers; a step needing more is a spec change.

## 11. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | Which script runs | A the release's `LabFile` rows, materialised per run / B the book checkout on disk | **A**: the pinned release is the content the reader sees; the workers have no book checkout in staging |
| D2 | A withheld explanation | A show the values, withhold the sentence with a fixed line / B substitute "the book does not cover this" | **A**: the values are the script's and stand; the sentence about a number that is not there is what fails |
| D3 | The run line's progress | A blocks stepping on status events, 0% → 100% on `final` / B a timer-driven fill | **A**: the guide forbids animation beyond the caret; a stepped fill is state, not motion |
| D4 | Where the reader's inputs live | A `Message.aidInputs` and `Message.modeResult` JSON columns on the message rows / B a separate `AidRun` table | **A** in Phase 2: one turn, one run; the ledger holds the hashes; Phase 3's `LabRun` is a different thing |
| D5 | The screen's `13×` | the real chapter 37 script gives `A/total 810` vs `C/total 237.6` at the book's inputs, a ratio of 3.4×, from line 24 (not L142) | **build to the script**: the screen's figures are illustrative; the Phase 2 gate criterion is "the walk at the book's inputs returns the chapter's own figure with a derive chip", which the real values satisfy (recorded as a deliberate difference from the PNG) |

## 12. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Schema: both aids validate with their new presentation fields; `checkAid` refuses a bar path outside `reads`; the ratio and pct headlines compute in code on a fixture results object (810 / 237.6 → `3.4×`).
2. Run (workers, Docker up, stub gateway): a walk turn on 37.8 with the aid's defaults: the run line ends `exit 0 · n s`, step 2 shows bars `A 810` and `C 237.6` (formatted), the headline `3.4×`, the `ƒ 37 derive L24` chip opening the code pane, the prices line with 37.9's verification date and the `same as the book` sentence; the stub's explanations (which quote the fenced values) pass `derive output matched · 3 of 3`; with `qpd` at 20,000 the headline stays `3.4×` and `A 8100`, the `same as the book` line is absent; `Back` and `Next` move the strip and the tree in the reading column; `Done` collapses to `walked · 4 steps · 3.4×`; a reload with `?ask=` renders the walk from the row's `modeResult`.
3. Validation: `qpd` at 5 answers 422 with `between 100 and 100,000` under the field and no run; a non-numeric input `enter a number`; a fractional `steps` on 21.8 `whole numbers only`; an aid id from another chapter 422 `AID_UNKNOWN`.
4. Sensor: a stub explanation quoting `42×` (not a value) is withheld, the verdict reads `2 of 3` in warn, the step still shows its bars; the ledger record carries `aid.inputsSha256` and `valuesSha256`.
5. Failure: an aid whose edit makes the script raise (a test aid in the test's temp dir) ends as a failed run with `exit 1`, the error box, no `BudgetLedger` row on the frontier alias, a failed-turn row; Docker stopped answers 503 before the turn.
6. Chapter 21: `21.8-task-survival` at 22 steps and 26 calls shows `p_no_failure` bars and the headlines; a chapter without an aid (ch05) shows the `Empty` with `21, 37`.
7. Layout: 1440 matches `Assistant-Refusal-Walk.png` state b in structure and vocabulary; deliberate differences listed (real values and line numbers, D5; four inputs are five for 37.8; the reading column's table and walk prose absent because the book's 37.8 is a worksheet); the log row `step 2/4`; the status bar cells; PT strings, no overflow at 1440 and 1200; the 900 overlay.
8. axe: zero WCAG 2.2 AA violations on the form, the running state, a step result and the failed state, EN and PT.
9. Token grep clean; new classes (`.turn-walk`, `.walk`, `.walk-steps`, `.walk-inputs`, `.walk-run`, `.walk-result`, `.walking-band`, `.aid-tree`) in `globals.css` and ui-context § 9.9; message parity.
10. Invariant check: 12 (the only arithmetic is the declared ratio, pct and bar widths, in code; the model's numbers are checked against the script's), 20 (the run's container has no network: the test asserts `dockerArgs` on the workers' spawn), 14 (the explanation renders from `final` only).
