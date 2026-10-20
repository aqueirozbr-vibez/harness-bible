import { AppError } from "@/lib/errors";
import type { Alias, Purpose, REQUEST_ROWS } from "@/lib/schemas/gateway";

/*
 * The request policy per purpose (feature-specs/11 § 5.3, D6). Andre delegated the numbers on 2026-09-24
 * ("think if the numbers make sense, change if necessary"), so unit 37b checked every row against the Claude API
 * guidance (the `claude-api` skill, cached 2026-06-24) and against the installed SDK's own types. What changed and
 * why is the spec's § 5.3 table and its D6 row; the four derivations that matter here:
 *
 *   `maxTokens` is a ceiling, never a target. On `claude-opus-5` adaptive thinking is on by default and its tokens
 *   count against `max_tokens`, so a ceiling sized to the answer alone cuts the answer itself short after a long
 *   think (`stop_reason: "max_tokens"`). The three frontier rows therefore carry the guidance's own headroom
 *   (64,000 streamed, 16,000 not) rather than the guide's 220-word answer plus room; spend is bounded by the
 *   gateway's `max_budget` (invariant 7), not by this number, and the model is never told it.
 *
 *   `effort` defaults to `high` on `claude-opus-5`, and visible text only begins after thinking ends, so high
 *   effort spends the 2 s first-token budget of architecture § 8 on a short answer grounded in retrieved sections.
 *   Every row therefore steps down to `medium` — **one** level, not two (review of unit 37, 2026-09-24): the
 *   budget is the reason to step down, and the measurement that would say what a step costs is the Phase 2 gate's
 *   own citation rate on the golden set and its grounding score (project-overview § Success criteria,
 *   spec 13 § 7.3), which no machine here can run. `low` is the next step down if that gate shows headroom, and
 *   `Effort` keeps all three levels for that reason: `high` is the model's default, the level these rows came from
 *   and the one they return to if the gate says the budget can afford it, so it stays in the union although no row
 *   holds it today. `xhigh` and `max` stay out: they are above the default, and no row can reach them from here.
 *
 *   `maxRetries` is per row because the SDK retries twice by default (§ 5.2) and a timeout is retried, so the worst
 *   case is the timeout times the attempts. The classifier runs in parallel with retrieval under that same 2 s
 *   target, so it gets one retry (10 s, not 15 s); every row states its worst case. `limitsFor` resolves a row
 *   from `(purpose, alias)`, which cannot tell the draft from the repair — both are `assistant` on `hb-frontier`,
 *   so the draft's row answers for both. The repair's `timeoutMs` and `maxRetries` must therefore equal the
 *   draft's, and `policy.test.ts` asserts that equality so a future divergence fails instead of going unread.
 *
 *   `hb-small` is `claude-haiku-4-5`, which answers 400 to `output_config.effort`: its row keeps `effort: null` and
 *   `requestFor` emits no `output_config` at all.
 *
 *   `evidenceGrader` (unit 49d, 2026-10-06; feature-specs/32 § 7.5, under the same delegation): `hb-small` on a
 *   document of up to DOCUMENT_CHARS_MAX characters (workers/agents/grader/assemble.ts) answering a five-key object
 *   whose longest field is a 30-word reason — some 60 tokens of output, so a ceiling of 512 is eight times the
 *   answer and never a target; the small model refuses an effort setting, as the classifier's row records. 20 s a
 *   try is the product's own deadline for a call that includes a long input (feature-specs/11 § 7.2's `/gateway/check`),
 *   four times the classifier's 5 s for a prompt forty times as long; the SDK's two retries, because nothing waits
 *   on it in a request — the grading workflow does — so the worst case of 60 s is the activity's to bound (49e).
 *
 *   `evidenceGraderBytes` (unit 49f, 2026-10-06; feature-specs/32 § 9, § 19, under the same delegation): the same
 *   agent on a PDF or an image, which goes uncut as the provider's own block, so the text row's derivation does not
 *   hold. A request is up to 32 MB (the provider's limit), and a retry would send all of it again and may be charged
 *   again, so the row has none: one try, the agent's cap (invariant 15). Its deadline is 90 s, what the grading
 *   activity's 120 s bound (49e) leaves after a quarter is kept for the activity's own reads and writes; the first
 *   real PDF's latency (Andre's paid check) is the measurement it waits on. A call names it (`GatewayCall.row`),
 *   since it shares its purpose and alias with the text row. No retry also means a 429, a 529 or a 5xx, which the
 *   provider does not bill, is not tried again: the grade is `U` with the gateway's status, as spec 32 § 7 has any
 *   gateway failure. Retrying statuses but not a timeout would need the client to tell them apart (recorded).
 *
 *   `adjudicator` (unit 50d, 2026-10-07; feature-specs/33 § 5.1, under the same delegation): `hb-frontier` deciding one
 *   suggestion on a prompt of a few thousand tokens — the anchored passage, the proposal, at most ten graded items
 *   with their reasons, the sensors — and answering six criteria whose reasons are at most 30 words, some 400 tokens.
 *   The ceiling is the unstreamed one the grounding grader has, so thinking cannot cut the answer short; medium
 *   effort, one step under the model's default, as every frontier row is, though here nothing waits on a first token
 *   and judging is the part that benefits. No retry: the agent's cap is one attempt and a failure goes to a curator
 *   (invariant 15). 120 s for that one try, since the workflow and not a reader waits on it: the grounding grader's
 *   30 s a try with its three tries' worth of time kept for thinking on a longer input; the activity's own bound
 *   is above it (unit 50d). The first real call is the measurement it waits on.
 *
 *   `researchPlanner` (unit 58a, 2026-10-10; feature-specs/41 § 5, under the same delegation): `hb-small` reading the
 *   sections an answer cited, the answer and the question — a few thousand tokens — and answering either a refusal
 *   with its reason or a brief of at most 200 words with its targets, some 400 tokens, so 1,024 is a ceiling two and
 *   a half times the answer and never a target; the small model refuses an effort setting. 30 s for one try: longer
 *   than the classifier's 5 s for a prompt many times its length, shorter than the evidence grader's 20 s times its
 *   tries, because nothing waits on it but the workflow. No retry: the agent's cap is one attempt (invariant 15), and
 *   a retried timeout would be a second call for one answer; a failure ends the run FAILED (41 § 5.1).
 *
 *   `researchReader` (unit 58a, 2026-10-10; feature-specs/41 § 6, under the same delegation): `hb-frontier` with the
 *   provider's web search and web fetch, ten uses each (A13), answering at most three findings with a proposal and a
 *   200-word note each, some 2,000 tokens, under a 16,000 ceiling so thinking cannot cut them short; medium effort, as
 *   every frontier row. Streamed, and 600 s for one request (the first real run, 2026-10-10, timed out at the 180 s
 *   first set): the provider runs the searches, the fetches and its own result-filtering code inside the request
 *   before the answer begins, each several seconds, and twenty of them is many minutes; a non-streamed request also
 *   meets the provider's ten-minute edge, which a streamed one does not. The turn may be paused and continued at most
 *   twice (lib/gateway/turn.ts), so the whole stays within the 35 minutes the research workflow gives the activity
 *   (3 × 600 s and a margin). No retry: a retry would run again searches the provider charges for, and the agent's cap
 *   is one attempt; a failure ends the run FAILED (41 § 6.1).
 *
 *   `researchWriter` (unit 69d, 2026-10-12; feature-specs/48 § 5.6, D1, under the same delegation): `hb-frontier` with
 *   no tool, writing a person's report from the question, the target sections, the findings that passed and the pages'
 *   notes of at most 60 words each — a prompt of a few thousand tokens — and answering at most eight paragraphs and 600
 *   words with their references, some 1,000 tokens, under the unstreamed ceiling so thinking cannot cut them short;
 *   medium effort, as every frontier row. Unstreamed, since the report is shown whole once the report sensor has passed
 *   it (48 § 2, A1), so nothing reads a first token. 120 s for one try, the adjudicator's, for an answer of the same
 *   order that only the workflow waits on, inside the writing activity's 5 minutes (48 § 5.1). No retry: the agent's cap
 *   is one attempt; a gateway's 429 at the key's rate never reached the provider and is the workflow's to wait out once
 *   (48 § 5.6), which a retry here would spend at once. A call names it (`GatewayCall.row`), since it shares its
 *   purpose and alias with the reader's row.
 *
 * Embeddings and re-ranking are spec 12's rows and have none here.
 */

export type PolicyName = (typeof REQUEST_ROWS)[number];
export type Effort = "low" | "medium" | "high";

export interface RequestPolicy {
  readonly alias: Alias;
  readonly maxTokens: number;
  readonly effort: Effort | null;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly stream: boolean;
  readonly reason: string;
}

export const REQUEST_POLICIES: Readonly<Record<PolicyName, RequestPolicy>> = {
  assistantDraft: {
    alias: "hb-frontier",
    maxTokens: 64_000,
    effort: "medium",
    timeoutMs: 60_000,
    maxRetries: 2,
    stream: true,
    reason: "a ceiling the streamed answer and its thinking cannot reach, not a target: the answer stays the guide's 220 words and six claims; medium effort is one step under the model's default for the 2 s first-token budget, and `low` waits for the gate to show headroom; worst case 180 s",
  },
  assistantRepair: {
    alias: "hb-frontier",
    maxTokens: 16_000,
    effort: "medium",
    timeoutMs: 60_000,
    maxRetries: 2,
    stream: false,
    reason: "the one repair pass rewrites the draft under the draft's limits, unstreamed, so its ceiling is the unstreamed one; medium effort because the pass rewrites named uncited claims out of a draft the sensors have already judged, while the reader waits on the same answer — the draft's first-token budget is not its own reason; its timeout and retry count equal the draft's, because `limitsFor` reads one row for both; worst case 180 s",
  },
  groundingGrader: {
    alias: "hb-frontier",
    maxTokens: 16_000,
    effort: "medium",
    timeoutMs: 30_000,
    maxRetries: 2,
    stream: false,
    reason: "a small score object, whose ceiling is the unstreamed one so thinking cannot cut it short; medium effort because judging is the part that benefits; worst case 90 s",
  },
  scopeClassifier: {
    alias: "hb-small",
    maxTokens: 256,
    effort: null,
    timeoutMs: 5_000,
    maxRetries: 1,
    stream: false,
    reason: "a cause code before retrieval, in parallel with it, so one retry and not the SDK's two; the small model refuses an effort setting; worst case 10 s",
  },
  evidenceGrader: {
    alias: "hb-small",
    maxTokens: 512,
    effort: null,
    timeoutMs: 20_000,
    maxRetries: 2,
    stream: false,
    reason: "a five-key object whose longest field is a 30-word reason, some 60 tokens, so 512 is a ceiling eight times the answer and never a target; the small model refuses an effort setting; 20 s a try for a prompt that carries a document, the product's own deadline for a long call; the SDK's two retries, since the grading workflow and not a request waits on it; worst case 60 s, the activity's to bound",
  },
  evidenceGraderBytes: {
    alias: "hb-small",
    maxTokens: 512,
    effort: null,
    timeoutMs: 90_000,
    maxRetries: 0,
    stream: false,
    reason: "the same five-key answer for a PDF or an image sent whole as the provider's block, a request of up to 32 MB: no retry, since a retry re-sends all of it and may be charged again, and the agent's cap is one attempt; 90 s, what the grading activity's 120 s leaves after a quarter kept for its reads and writes, until the first real PDF is measured; worst case 90 s",
  },
  adjudicator: {
    alias: "hb-frontier",
    maxTokens: 16_000,
    effort: "medium",
    timeoutMs: 120_000,
    maxRetries: 0,
    stream: false,
    reason: "six criteria with reasons of at most 30 words, some 400 tokens, under the unstreamed ceiling so thinking cannot cut it short; medium effort, as every frontier row; one attempt, the agent's cap, a failure going to a curator; 120 s for it, since the workflow waits and not a reader; worst case 120 s",
  },
  researchPlanner: {
    alias: "hb-small",
    maxTokens: 1_024,
    effort: null,
    timeoutMs: 30_000,
    maxRetries: 0,
    stream: false,
    reason: "a refusal with its reason or a brief of at most 200 words with its targets, some 400 tokens, so 1,024 is a ceiling two and a half times the answer and never a target; the small model refuses an effort setting; 30 s for a prompt that carries the cited sections, the answer and the question, since only the workflow waits; one attempt, the agent's cap, a failure ending the run; worst case 30 s",
  },
  researchReader: {
    alias: "hb-frontier",
    maxTokens: 16_000,
    effort: "medium",
    timeoutMs: 600_000,
    maxRetries: 0,
    stream: true,
    reason: "at most three findings with a proposal and a 200-word note each, some 2,000 tokens, under a 16,000 ceiling so thinking cannot cut them short; medium effort, as every frontier row; streamed, and 600 s a request, because the provider runs up to ten searches, ten fetches and its result-filtering code inside it before the answer begins (the first real run timed out at 180 s) and a non-streamed request meets the provider's ten-minute edge; a paused turn is continued at most twice so the whole stays within the activity's 35 minutes; one attempt, the agent's cap, since a retry would run charged searches again; worst case 600 s a request",
  },
  researchWriter: {
    alias: "hb-frontier",
    maxTokens: 16_000,
    effort: "medium",
    timeoutMs: 120_000,
    maxRetries: 0,
    stream: false,
    reason: "a report of at most eight paragraphs and 600 words with their references, some 1,000 tokens, under the unstreamed ceiling so thinking cannot cut it short; medium effort, as every frontier row; unstreamed, since the report is shown whole after its sensor; no tool; one attempt, the agent's cap, the gateway's 429 at the key's rate being the workflow's to wait out once; 120 s for it, the adjudicator's, since only the workflow waits; worst case 120 s",
  },
};

export interface PolicyParams {
  readonly model: Alias;
  readonly max_tokens: number;
  readonly output_config?: { readonly effort: Effort };
}

/** The request fields a policy fixes; the caller adds its messages and, for a streamed row, `stream: true`. */
export function requestFor(name: PolicyName): PolicyParams {
  const policy = REQUEST_POLICIES[name];
  return { model: policy.alias, max_tokens: policy.maxTokens, ...(policy.effort === null ? {} : { output_config: { effort: policy.effort } }) };
}

/** The per-request limits of a row, in the units the TypeScript SDK's `RequestOptions` takes: `timeout` in milliseconds. */
export interface RequestLimits {
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

/**
 * A row named by the call (unit 49f): its limits, when the row is one for the call's alias; a row for another
 * alias is refused, so a call cannot borrow a frontier row's deadline for a small model or the other way round.
 */
export function limitsOfRow(row: PolicyName, alias: Alias): RequestLimits {
  const policy = REQUEST_POLICIES[row];
  if (policy.alias !== alias) throw new AppError("GATEWAY_POLICY_UNKNOWN", `the request row ${row} is for ${policy.alias}, not ${alias} (feature-specs/11 § 5.3)`);
  return { timeoutMs: policy.timeoutMs, maxRetries: policy.maxRetries };
}

/** The purpose and alias of a call name its policy row; a pair without a row has no limits and is refused. */
export function limitsFor(purpose: Purpose, alias: Alias): RequestLimits {
  const of = ({ timeoutMs, maxRetries }: RequestPolicy): RequestLimits => ({ timeoutMs, maxRetries });
  if (purpose === "assistant" && alias === "hb-frontier") return of(REQUEST_POLICIES.assistantDraft);
  if (purpose === "assistant" && alias === "hb-small") return of(REQUEST_POLICIES.scopeClassifier);
  if (purpose === "grading" && alias === "hb-frontier") return of(REQUEST_POLICIES.groundingGrader);
  if (purpose === "grading" && alias === "hb-small") return of(REQUEST_POLICIES.evidenceGrader);
  if (purpose === "adjudication" && alias === "hb-frontier") return of(REQUEST_POLICIES.adjudicator);
  if (purpose === "research" && alias === "hb-small") return of(REQUEST_POLICIES.researchPlanner);
  if (purpose === "research" && alias === "hb-frontier") return of(REQUEST_POLICIES.researchReader);
  throw new AppError("GATEWAY_POLICY_UNKNOWN", `no request policy for purpose ${purpose} on ${alias} (feature-specs/11 § 5.3)`);
}
