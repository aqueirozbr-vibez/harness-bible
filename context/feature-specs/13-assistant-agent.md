# 13 · The assistant agent — feature spec (guide, prompt assembly, sensors, the grounding grader, the answer flow)

Read `CLAUDE.md` and `context/ai-workflow-rules.md` before starting.

Source of truth: `context/architecture.md` § 6.1 (the assistant: frontier model for drafting and a small model for scope classification; guide `v1.8`; prefix order guide · citation rules · release id · retrieved sections · conversation · question; may read retrieved sections, the conversation and decision-aid results, never anything outside the corpus or the user's identity; output `{claims: [{text, sectionId, figureId?}], refusal?: {cause}, mode_result?}`; sensors before: scope classifier and the unverified-chapter check; sensors after: citation, edition, the grounding grader in an isolated context; cap: one repair pass), § 6.2 (the grader's κ ≥ 0.7 against curator labels; a criterion below 0.6 retired), § 6.3 (`AnswerWorkflow`: scope sensor → retrieval → draft with the token stream → citation sensor per claim → substitution → grader → repair below 0.7 → final event → `answer` ledger record; a refusal before retrieval costs zero gateway calls), § 6.4 (citations and substitutions render only from the final event), § 11 invariants 11 (sensors before judgment), 12 (arithmetic in code), 13 (agent identity), 14 (uncited claim replaced server side), 15 (one repair pass); `context/code-standards.md` § Workers, workflows and agents (`workers/agents/<agent>/assemble.ts` in the fixed order from the versioned guide with a parameter type listing exactly the fields the agent may read; `parse.ts` with the zod output schema, a parse failure being the one cap; fenced untrusted data; sensors as pure `(input) => SensorVerdict`, `PASS | FAIL | WARN | NA` plus detail, ordered by the workflow); `context/project-overview.md` § Assistant (five modes; scope; the four refusal causes with codes such as `R-SCOPE-OT`, refused before retrieval, costing no model call, pointing to what the book covers; every claim cites chapter and section; uncited claims replaced from the final event only; numbers copied, never recomputed; the citation sensor verifies each quoted figure at its location; the verdicts panel: citation, scope, grader, edition, latency). The screens fix the verdict vocabulary: `sensor verdicts 5 of 5 pass · citation sensor 4 / 4 figures found at cited location · scope sensor in corpus · 1 claim out of scope, replaced · grader grounded 0.94 · isolated context · edition 5 / 5 citations resolve in EN v1.5.0 · latency first token 1.3 s · complete 4.6 s` (Assistant-Answer), `refused · cause · scope · control-system operation · R-SCOPE-OT · refused before retrieval` (Assistant-Refusal-Walk), `Billing for replayed events: the book does not cover this` (Mobile-Assistant). The guide itself is `guides/assistant/v1.8/` (written 2026-09-23, hash-pinned): its scope, modes, refusal wording, numbers rule, output schema.

Prerequisite specs: `11-model-gateway.md` (the client, purposes, request policy, errors, the stub), `12-retrieval.md` (`retrieve()` and `RetrievedSection`), the golden set (`golden/assistant/2026.09.jsonl`) and the guide loader (`lib/guides/load.ts`).

Scope: tracker unit 27. Everything between a validated question and a final answer object: the scope sensor, prompt assembly, the model call, the output parser, the citation and edition sensors, the substitution rule, the grounding grader, the repair pass, and the answer flow that orders them. It produces an `AnswerResult` and a token stream; it does not know HTTP, SSE, the conversation rows or the ledger (spec 15 owns those and calls this). The walk, lab and brief modes' inputs (spec 18, 19) arrive as fields of the request; this spec handles them generically.

## 1. Purpose

The assistant is a harness, not a chat: a fixed guide, a fixed set of things it may read, sensors that decide before the model is asked and check after it answered, and one repair pass. The user sees an answer whose every claim cites a section the sensor confirmed, or a refusal with a code and a pointer. The model never decides scope, never sets a score, never sees anything outside the retrieved sections, and never has its uncited words shown as cited.

## 2. Dependencies and order

| Needs | Why |
|---|---|
| `lib/guides/load.ts` and `guides/assistant/v1.8` (done) | the byte-stable prefix and its hash |
| `lib/gateway/` (spec 11: `callModel`, purposes `assistant`, `grading`; `hb-frontier`, `hb-small`; the stub) | the calls |
| `lib/search/retrieve.ts` (spec 12) | the eight sections and their figure ids |
| The release rows: `Section`, `Figure`, `ChapterVersion.verifyStatus`, `Edition` | the sensors check claims against them |
| `golden/assistant/2026.09.jsonl` | the tests' questions and expected labels |

Build order: 27a `lib/schemas/assistant.ts` (the request, the output, the verdicts, the result) and `lib/sensors/scope.ts` with its rules → 27b `workers/agents/assistant/assemble.ts` and `parse.ts` → 27c `lib/sensors/citation.ts`, `lib/sensors/edition.ts`, the substitution → 27d the grounding grader (`workers/agents/grader/`) and the repair pass → 27e `workers/answer/flow.ts` ordering them, with the golden-set test runner in `tests/agents/` → verification.

## 3. The contract (`lib/schemas/assistant.ts`, 27a)

```ts
const RefusalCauseSchema = z.enum(["R-SCOPE", "R-SCOPE-OT", "R-RECOMPUTE", "R-UNVERIFIED"]);
const ModeSchema = z.enum(["explain", "compare", "walk", "lab", "brief"]);

/** What spec 15 hands the flow: already validated, already rate-limited, already budgeted by the gateway. */
interface AnswerRequest {
  readonly releaseId: ReleaseId;
  readonly locale: "en" | "pt";                                   // the answer's language
  readonly mode: Mode;
  readonly context: { chapter: number; section: SectionId | null; chapters?: readonly [number, number]; labId?: string };
  readonly question: string;                                      // ≤ 800 characters (the composer's cap)
  readonly conversation: readonly { role: "user" | "assistant"; text: string; refusal: RefusalCause | null }[];   // this conversation's earlier turns, newest last, text purged turns omitted
  readonly aidResult: AidStepResult | null;                       // walk mode (spec 18): the script's values with their derive lines
  readonly principal: Principal;
  readonly traceId: string;
}

/** The model's structured output (architecture § 6.1; the guide's schema). */
interface AssistantOutput {
  readonly claims: readonly { text: string; sectionId: SectionId; figureId: FigureId | null }[];   // text ≤ 60 words
  readonly refusal: { cause: RefusalCause; pointers: readonly SectionId[] } | null;
  readonly mode_result: WalkResult | BriefResult | null;
}

interface SensorVerdict { readonly sensor: "scope" | "citation" | "edition" | "grader" | "latency"; readonly verdict: "PASS" | "FAIL" | "WARN" | "NA"; readonly detail: string; readonly data: Record<string, number | string | boolean> }

interface AnswerResult {
  readonly kind: "answer" | "refusal";
  readonly refusal: { cause: RefusalCause; code: string; pointers: readonly { sectionId: SectionId; title: string }[]; beforeRetrieval: boolean } | null;
  readonly claims: readonly ResolvedClaim[];                     // in order; substituted claims carry `substituted: true` and the sentence "the book does not cover this"
  readonly citations: readonly { sectionId: SectionId; figureId: FigureId | null; version: string; editionLang: "EN" | "PT" }[];   // distinct, in first-use order
  readonly verdicts: readonly SensorVerdict[];                   // the five, in the panel's order
  readonly grounded: number | null;                              // the grader's score, 0–1
  readonly repaired: boolean;
  readonly guide: { version: string; sha256: string };
  readonly modelId: string;                                      // the pinned id the gateway reported
  readonly timings: { scopeMs: number; retrieveMs: number; firstTokenMs: number | null; draftMs: number; sensorsMs: number; graderMs: number; totalMs: number };
  readonly usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  readonly modeResult: WalkResult | BriefResult | null;
}
```

`ResolvedClaim` is a claim plus what the citation sensor found: `{ text, sectionId, figureId, valueText | null, found: boolean, substituted: boolean }`. Every schema is zod; the model's raw output is parsed by `AssistantOutputSchema` and nothing downstream reads unparsed JSON.

## 4. Sensors before the model (27a)

### 4.1 The scope sensor (`lib/sensors/scope.ts`)

Runs before retrieval and before any frontier call. Two parts, rules first, the small model only when the rules do not decide:

1. **Rules (pure, no model).** `R-UNVERIFIED` when `context.chapter` (or either of `context.chapters`, or the aid's chapter) is not `PASSED` in the release. `R-RECOMPUTE` when the question asks for a computation the book did not make: an imperative of the form recompute / recalculate / re-run / extrapolate / estimate / "what would it be at" followed by a quantity, in EN or PT (the patterns are a table in the file, tested against the golden set's 13 recompute questions and 150 figure questions: zero false positives on the latter). `R-SCOPE-OT` when the question names an action on plant equipment: a verb from the operations list (write, set, force, bypass, disable, trip, start, stop, acknowledge, push, tune) with an object from the equipment list (setpoint, drive, register, PLC, DCS, valve, breaker, interlock, alarm, historian tag, controller, transmitter, loop) or a tag pattern (`P-101`, `LT-104`, `V-203`); tested against the 12 OT questions and 150 figure questions likewise.
2. **The small model** (`hb-small`, purpose `assistant`, § 5.3 of spec 11's policy: 256 tokens, 5 s), asked only when no rule fired: the question, the context (chapter title and section title), and the scope statement of the guide, with the instruction to answer `{"cause": "R-SCOPE" | "R-SCOPE-OT" | "R-RECOMPUTE" | "none", "reason": ≤ 20 words}`. `none` means proceed. A timeout or an unparseable answer means proceed (D2: the classifier is a gate against wasted frontier calls, not the last defence; the citation sensor and the grader still stand behind it), recorded as `WARN` in the scope verdict.

The classifier runs in parallel with retrieval (architecture § 8): both start together; a refusal discards the retrieval result and costs one small call; a rule refusal costs none. The refusal's pointers: for `R-SCOPE-OT`, the two sections the guide names (`35.2`, `28.1`) when verified, else none; for `R-RECOMPUTE`, the section holding the figure the question named (from the golden set's pattern: the section id in the question, or the context section) and the chapter's `NN.8`; for `R-UNVERIFIED`, none; for `R-SCOPE`, the top two retrieved sections when retrieval ran and returned any with a re-rank score above the "covers" line (D3), else none.

Verdict: `scope · in corpus` (PASS) or `scope · <cause>` (the refusal, FAIL with `beforeRetrieval: true`), or, after the model answered, `in corpus · N claims out of scope, replaced` (WARN) when the citation sensor substituted claims.

## 5. Prompt assembly (`workers/agents/assistant/assemble.ts`, 27b)

```ts
interface AssistantPromptInput {                    // exactly what the agent may read; nothing else has a place here
  readonly guide: Guide;                            // prefix, version, sha256
  readonly releaseId: ReleaseId;
  readonly sections: readonly RetrievedSection[];   // ≤ 9
  readonly conversation: AnswerRequest["conversation"];
  readonly question: string;
  readonly mode: Mode;
  readonly locale: "en" | "pt";
  readonly aidResult: AidStepResult | null;
}
export function assemble(input: AssistantPromptInput): { system: TextBlockParam[]; messages: MessageParam[]; promptSha256: string }
```

The fixed order (architecture § 6.1), each slot a labelled block:

1. `system[0]`: the guide prefix, byte for byte, with `cache_control: {type: "ephemeral"}` (the one cache breakpoint; the prefix is the same bytes for every request of the version, so it is cached across users).
2. `system[1]`: the release id and the mode line: `release 2026.09 · mode explain · answer in en · edition EN`.
3. The retrieved sections, in rank order, each fenced as untrusted data the assembler writes and the caller cannot alter:

```
<section id="21.3" chapter="21" version="v1.0.0" edition="EN" verify="PASSED">
…plain text…
figures: F-21-05 "expected work redone" 45% (derived, L14); F-21-07 "duplicate side effects a day" 117 (derived, L47)
</section>
```

   The figure line lists every figure of the section with its id, label, printed value, tier and derive line, so the model can cite figure ids it did not have to guess (the citation sensor checks them). Section bodies are the plain `text` of `RetrievedSection`, never HTML.
4. The conversation as alternating user and assistant turns (an earlier refusal as its one sentence), at most the last six turns (D4).
5. The walk's `aidResult` fenced as `<aid step="2" of="4">` with the values and lines, walk mode only.
6. The question, as the last user message, fenced as `<question>`: the user's text is data, not instructions, and the guide says so.

`promptSha256` hashes the canonical request minus slots 4 to 6 (spec 11 § 5.4): the same guide, release and sections hash the same, which is what "byte-stable prefix" means in the gate.

Two things the type makes impossible: a user's identity, organisation or e-mail (no field), and anything from another conversation (the conversation is the request's own rows). The assembler runs in the workers only.

Two constraints the provider puts on this assembly (unit 37b, from the Claude API guidance cached 2026-06-24; nothing here is code until 27b builds it):

- **No assistant prefill.** `claude-opus-5` answers 400 to a prefilled last assistant turn, so the JSON envelope cannot be forced by opening the answer with `{`. The shape comes from `output_config.format` (§ 6) and from the guide's own instruction, and slot 4's conversation therefore always ends on the question of slot 6, never on a half-written assistant turn.
- **The cache breakpoint sits immediately after the byte-stable prefix.** Caching is a prefix match: every byte before the last `cache_control` breakpoint is the cached prefix, and anything volatile before it invalidates the whole cache. `system[0]` is the guide prefix and carries the one breakpoint; the release and mode line, the sections, the conversation and the question all follow it. A breakpoint moved after slot 2 or later would put the mode, the locale or the retrieved sections inside the prefix and the Phase 2 gate's cache-read check (`cache_read_input_tokens > 0` across requests, spec 11 § 5.3) could not pass.

## 6. The model call and the parser (27b)

`callModel` with purpose `assistant`, alias `hb-frontier`, the policy row "assistant draft" of spec 11 § 5.3 (streamed, with that row's `max_tokens` ceiling and effort, not repeated here), `output_config.format` set to the JSON schema of `AssistantOutput` so the provider constrains the shape. The stream's text deltas are forwarded to spec 15's SSE as the token stream; nothing in them is rendered as a citation or a substitution until the final event (invariant 14). On `finalMessage()` the text is parsed:

- `parse.ts`: strip nothing, parse JSON, validate with `AssistantOutputSchema`; a claim's `sectionId` must be one of the retrieved ids and its `figureId`, when set, one of that section's figure ids, else the claim is marked unparseable (not dropped: it becomes an uncited claim and the citation sensor substitutes it).
- A parse failure of the whole output (not JSON, or a schema failure at the top level) is the agent's one cap: the repair pass (§ 8) runs with the parser's error as the repair instruction; a second failure ends as a refusal with cause `R-SCOPE` and pointers from retrieval, verdict `grader · NA · unparseable output`, so the user sees a refusal, never raw text.
- `stop_reason: "refusal"` (the provider's safety stop, spec 11 `ProviderRefusalError`) is a refusal with cause `R-SCOPE`, no repair, recorded with the provider's category in the span (never shown).
- `stop_reason: "max_tokens"` is a repair-pass trigger with the instruction to answer within the limit.

## 7. Sensors after the model (27c)

### 7.1 The citation sensor (`lib/sensors/citation.ts`, pure)

Input: the parsed claims, the retrieved sections with their figures (id, label, `valueText`, tier, derive line, `sourceRowId`). For each claim:

- The section must be one of the retrieved sections (else FAIL for that claim).
- When `figureId` is set: the figure must belong to that section, and the claim's text must contain the figure's `valueText` as printed (digits, unit, separators; a comparison after normalising whitespace and the thin space), else FAIL: "figure not found at cited location". A claim that contains a number in figure position (the pipeline's `NUM_SOURCE` grammar) but names no `figureId` is FAIL: "number without a figure id" (the guide's numbers rule).
- When `figureId` is null: the claim's text must share at least one content term with the cited section's text (the lexemes of `websearch_to_tsquery`, computed in code from the section's `textEn`; D5 fixes the rule as "at least one term of three or more letters that is not a stop word"), else FAIL: "claim does not appear in the cited section". This is the coarse check; the grader (§ 7.3) is the fine one.

Verdict: `citation sensor · n / m figures found at cited location` (PASS when every claim passed; WARN when at least one was substituted; FAIL only when every claim failed, which ends as a refusal after the repair). Each failed claim is **substituted** server side: its text becomes the sentence "the book does not cover this" (`assistant.noCover` in the catalogues, PT "o livro não cobre isso"), its citation is dropped, `substituted: true`. The token stream already sent may have shown the original words; the final event carries the substituted claims and the client renders from the final event only (architecture § 6.4). The substitution count feeds the scope verdict's `N claims out of scope, replaced`.

### 7.2 The edition sensor (`lib/sensors/edition.ts`, pure)

Every citation must resolve in one edition: the retrieved sections' `editionLang` are all the same (retrieval guarantees it) and each cited section's `version` is the release's. Verdict `edition · n / n citations resolve in EN v1.0.0` (PASS), or FAIL naming the citation that does not (a defect, since retrieval produced the ids; logged with the trace). When `locale` differs from the edition, the result carries `citesEdition: "EN"` and the client shows "cites the EN edition" (Mobile-Assistant).

### 7.3 The grounding grader (`workers/agents/grader/`, 27d)

An isolated context: a second, non-streaming `hb-frontier` call (purpose `grading`, policy row "grounding grader" of spec 11 § 5.3, whose numbers are that table's) whose prompt holds only the guide's grader section (`guides/assistant/v1.8/grader.md`, built 2026-09-25 as a **named part** of the same version: `manifest.json` gains `parts.grader` with its own files and its own sha256, and `loadGuidePart("assistant", "v1.8", "grader")` loads and checks it exactly as the prefix is checked. It is deliberately **not** concatenated into `files`: the assistant's prefix is byte-stable and cached for every reader, and the grader's rules inside it would move those bytes while telling the assistant how it is about to be judged), the retrieved sections (the same fence), and the answer's claims after substitution. It never sees the question, the conversation, the user or the first call's reasoning. Output: `{ grounded: 0–1, criteria: [{ name: "supported" | "precise" | "complete" | "in_scope", verdict: "PASS" | "FAIL", reason: ≤ 30 words }] }`. `grounded` is the share of `PASS` criteria weighted equally, recomputed in code from the criteria (invariant 12: no score is taken from the model; the model's own `grounded` field is ignored). D6 fixes the four criteria; the calibration procedure of architecture § 6.2 retires one below κ 0.6.

Verdict: `grader · grounded 0.94 · isolated context` (PASS at ≥ 0.7, FAIL below; NA when the grader call failed, in which case the answer ships with `grounded: null` and the span records why).

### 7.4 Latency

`latency · first token 1.3 s · complete 4.6 s` (info; PASS when first token ≤ 2 s, WARN above: the architecture's budget is a target, not a refusal).

## 8. The repair pass (27d)

At most one (invariant 15), triggered by: the grader below 0.7; a whole-output parse failure; `max_tokens`. The repair call is the draft call again (non-streaming, the policy's "repair pass" row) with one more user message: the grader's failed criteria with their reasons, or the parser's error, or "answer within the limit", and the instruction to return the corrected output. Its result goes through the same parser and sensors; the grader runs once more only when the trigger was the grader. After the repair the answer ships whatever the score (architecture § 6.3: "second grader failure ships the substituted answer with a lower score in the log"), `repaired: true`. The token stream is not replayed: the client shows the repaired answer from the final event, and spec 15 says how the stream ends when a repair happened (the stream's last event before the final one is `repairing`).

## 9. The flow (`workers/answer/flow.ts`, 27e)

```
answer(request, sinks) →
  t0
  [scope rules]            → refusal? → result (beforeRetrieval, zero calls)                         … scopeMs
  [classifier ∥ retrieve]  → cause? → refusal with pointers, retrieval discarded (one small call)      … retrieveMs
  [assemble] → [draft, streaming to sinks.token]                                                       … firstTokenMs, draftMs
  [parse] → [citation sensor → substitution] → [edition sensor]                                       … sensorsMs
  [grader]                                                                                             … graderMs
  score < 0.7 or parse failure or max_tokens → [repair once] → [parse, sensors, grader if scored]
  → AnswerResult
```

Every step's outcome is one line in the answer's span (spec 15 writes the ledger record from the result). A `BudgetExceededError` at any call ends the flow with it (spec 15 answers 402); a `GatewayUnavailableError` before the draft is 503 (spec 15); during the grader it is `grader · NA`. Retrieval failing entirely (spec 12: both halves) is 503. Nothing is retried beyond the SDK's own retries.

## 10. Strings (`messages/{en,pt}.json`, `assistant.*`; spec 16 adds the screen's)

| Key | EN | PT |
|---|---|---|
| `assistant.noCover` | `the book does not cover this` | `o livro não cobre isso` *(candidate)* |
| `assistant.refusal.R-SCOPE` | `The book does not cover this.` | `O livro não cobre isso.` |
| `assistant.refusal.R-SCOPE-OT` | `The book gives no advice on operating control systems.` | `O livro não dá orientação sobre operar sistemas de controle.` |
| `assistant.refusal.R-RECOMPUTE` | `This assistant does not compute figures.` | `Este assistente não calcula números.` |
| `assistant.refusal.R-UNVERIFIED` | `This chapter has not been verified yet.` | `Este capítulo ainda não foi verificado.` |
| `assistant.refusal.cause.R-SCOPE` … | `scope · out of scope`, `scope · control-system operation`, `scope · recomputation request`, `scope · unverified chapter` | *(candidates)* |
| `assistant.verdict.*` | the five rows' vocabulary above | *(candidates)* |

The refusal sentences are the guide's own; the model's refusal text is never shown, the catalogue's is (the model's output carries the cause only).

## 11. Out of scope

- HTTP, SSE, rate limits, idempotency, the conversation rows, the ledger record, flags (spec 15, 17).
- The dock, the composer, rendering (spec 16); the walk's inputs and steps (spec 18); the modes' scoping (spec 12) and their result rendering (spec 19).
- The 300-question run and κ against curator labels (spec 22); this spec's tests run the flow on the golden set against the stub for shape and sensor behaviour, and on a real key for a sample.
- Tool use by the assistant: none. The assistant has no tools (architecture § 6.1: no agent holds a tool that writes content; the walk's script is run by the application, not by the model).

## 12. Decisions this spec needs

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | The output shape at the provider | A `output_config.format` with the schema (constrained decoding) / B free text parsed by the schema | **A**: fewer repair passes; B only if the gateway strips the field |
| D2 | Classifier timeout or parse failure | A proceed with WARN / B refuse | **A**: a slow classifier must not turn every question into a refusal; the after-sensors still guard |
| D3 | `R-SCOPE` pointers from retrieval | A the top two re-ranked sections above a score line / B none | **A** with the line at the re-ranker's median score over the golden set's in-scope questions, measured in spec 22, not fixed here; until measured, B |
| D4 | Conversation window in the prompt | six turns | **six** (the screen's log shows four to six turns per conversation); Andre to confirm |
| D5 | The coarse text check for an uncited-figure claim | one shared content term of three or more letters | **as stated**; the grader is the fine check; a stricter rule would substitute true paraphrases |
| D6 | The grader's criteria | `supported` (every claim follows from its cited section), `precise` (figures and ids exact), `complete` (the question's ask is addressed or declared uncovered), `in_scope` (no claim outside the sections) | **these four**, each PASS/FAIL, score the share; calibration may retire one |
| D7 | The grader's guide | A a third file `grader.md` in `guides/assistant/v1.8` (same version, same manifest) / B a separate agent version `guides/grader/` | **A** for Phase 2: the grounding grader belongs to the assistant's release; `guides/grader/v1.3` is the evidence grader of Phase 4 |

## 13. Verification (in addition to `ai-workflow-rules.md` § 7)

1. Unit, sensors: the scope rules refuse all 12 OT and all 13 recompute questions of the golden set and none of the 150 figure questions; `R-UNVERIFIED` on every unverified chapter of the release; the citation sensor finds every figure at its location on 30 synthetic claims built from real figures, fails a claim whose value is altered by one digit, fails a number without a figure id, passes a paraphrase sharing a term and fails one sharing none; the edition sensor passes a consistent set and fails a foreign version; `grounded` recomputed from the criteria ignores the model's own number.
2. Unit, assembly: the same guide, release and sections hash the same `promptSha256` across different questions and conversations; the system block carries `cache_control`; the parameter type has no field for identity (a type-level test: `@ts-expect-error` on `userId`); sections are fenced with their figure lines; the question is the last message.
3. Against the stub: the full flow on every golden item: figure questions produce claims citing the expected section and figure with `found: true`, 5 of 5 verdicts PASS and `grounded ≥ 0.7`; refusal items end as refusals with the expected cause, `beforeRetrieval: true` for rule causes, and zero `BudgetLedger` rows of kind `ASSISTANT` on the frontier alias for rule refusals; a stub answer with an out-of-scope claim (`x-hb-stub-uncited: 1`) is substituted, the verdict reads `1 claim out of scope, replaced`, and the final result carries the sentence; a stub parse failure triggers one repair and a second failure ends as `R-SCOPE`; `max_tokens` triggers one repair; the grader below 0.7 (`x-hb-stub-grounded: 0.5`) triggers one repair and the result ships `repaired: true` with the second score; the budget error ends the flow; the gateway down before the draft ends the flow with `GatewayUnavailableError` and during the grader with `grader · NA`.
4. With a real key (sample): 20 figure questions and 10 refusals from the golden set through the real gateway; citation on every claim; refusals with the expected cause; first token under 2 s at p95 on the sample; `cache_read_input_tokens > 0` from the second question on (the prefix is cached); the span lines carry guide version and hash, pinned id and prompt hash.
5. Invariant check: 11 (the scope sensor runs before any frontier call; a rule refusal makes no call at all), 12 (`grounded` from criteria in code), 13 (the assembler's type; the workers-only import), 14 (substitution server side; the result, not the stream, is the source of citations), 15 (one repair, tested by the double-failure case).
