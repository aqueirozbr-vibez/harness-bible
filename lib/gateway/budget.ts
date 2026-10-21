import { appendBudgetRow, monthOf, type BudgetRowInput } from "@/lib/db/budget";
import type { BudgetKind } from "@/lib/db/generated/enums";
import type { AppError } from "@/lib/errors";
import { BudgetExceededError, GatewayRefusedError } from "@/lib/gateway/errors";
import { costOf, priceFor, selfHosted, type Usage, usageOf, webSearchFeeUsd } from "@/lib/gateway/prices";
import { logGatewaySpan, type GatewaySpan, type GatewaySpanLogger } from "@/lib/gateway/span";
import { principalId, type Alias, type GatewayCall, type Outcome, type Purpose } from "@/lib/schemas/gateway";

/*
 * The record of a call (feature-specs/11 § 5.4): every completed or refused call writes one BudgetLedger row and
 * one span line, from the same facts. The row and the span are built by pure functions; `recordCall` hands them
 * to the query and the logger it was given (the database and console.info by default; the tests pass doubles).
 */

export interface CallRecord {
  readonly call: GatewayCall;
  readonly outcome: Outcome;
  /** The pinned id the gateway reported; the alias when the call produced no response. */
  readonly modelId: string;
  readonly usage: Usage;
  readonly costUsd: number;
  /** The gateway reported an id `prices.ts` cannot price: the row keeps the counts at cost 0 and is repriceable. */
  readonly priceUnknown: boolean;
  /** The provider's count of web searches in the call (`usage.server_tool_use`, 41 § 3): 0 for a call without the tool; priced into `costUsd`. */
  readonly searches: number;
  readonly promptSha256: string;
  /** The call's own span id: its span's, and the one its `traceparent` names, so the gateway's generation nests under it (49 § 5.3). */
  readonly spanId: string;
  readonly gatewayCallId: string | null;
  readonly latencyMs: number;
  readonly firstTokenMs: number | null;
}

const KIND_OF_PURPOSE: Readonly<Record<Purpose, BudgetKind>> = {
  assistant: "ASSISTANT",
  grading: "GRADING",
  adjudication: "ADJUDICATION",
  lab: "LAB",
  embed: "EMBED",
  rerank: "RERANK",
  research: "RESEARCH",
};

export function budgetKindOf(purpose: Purpose): BudgetKind {
  return KIND_OF_PURPOSE[purpose];
}

/**
 * The reported id, its counts and their cost. Pricing never fails a call the gateway answered and charged for: an
 * id `priceFor` cannot resolve from the call's alias is recorded at cost 0 with the reported id and the four counts
 * kept, so the row can be repriced once `prices.ts` catches up, and says so in the span and in one log line
 * (spec § 5.4). `hb-embed` is in that state by construction until Voyage's published rate arrives
 * (feature-specs/12 § 3, BLOCKED).
 */
export function pricedUsage(alias: Alias, modelId: string, usage: Usage): Pick<CallRecord, "modelId" | "usage" | "costUsd" | "priceUnknown"> {
  /* A model we run ourselves costs nothing per token, which is not the same as a price nobody recorded: the row is
   * free and known to be free, so `hb.price_unknown` keeps meaning "someone must update prices.ts" (12 § 3). The
   * question is asked of the alias's pin, not of `modelId`: the gateway echoes the alias for this provider. */
  if (selfHosted(alias)) return { modelId, usage, costUsd: 0, priceUnknown: false };
  const { price } = priceFor(alias, modelId);
  if (price === null) {
    console.error(`gateway: no price for the model ${modelId} the gateway reported on ${alias}; the row is written at cost 0 (update lib/gateway/prices.ts, feature-specs/11 § 3.2)`);
  }
  return { modelId, usage, costUsd: price === null ? 0 : costOf(price, usage), priceUnknown: price === null };
}

/** The outcome a typed gateway error is recorded as (spec § 5.2, § 5.4). */
export function outcomeOfGatewayError(error: AppError): Outcome {
  if (error instanceof BudgetExceededError) return "budget";
  if (error instanceof GatewayRefusedError) return "refused";
  return "unavailable";
}

/**
 * The usage, cost and outcome of a message the gateway answered (a refusal stop is the provider's, recorded as
 * such). A call that carried the web search tool reports its searches in `usage.server_tool_use`; their fee
 * (40 § 7.3) is added to the tokens' cost, and the count is kept for the span and the run.
 */
export function outcomeOfMessage(
  alias: Alias,
  message: {
    readonly model: string;
    readonly stop_reason: string | null;
    readonly usage: Parameters<typeof usageOf>[0] & { readonly server_tool_use?: { readonly web_search_requests: number } | null };
  },
): Pick<CallRecord, "outcome" | "modelId" | "usage" | "costUsd" | "priceUnknown" | "searches"> {
  const searches = message.usage.server_tool_use?.web_search_requests ?? 0;
  const priced = pricedUsage(alias, message.model, usageOf(message.usage));
  return {
    outcome: message.stop_reason === "refusal" ? "provider_refusal" : "ok",
    ...priced,
    costUsd: priced.costUsd + webSearchFeeUsd(searches),
    searches,
  };
}

export function toBudgetRow(record: CallRecord, now: Date): BudgetRowInput {
  return {
    principal: record.call.principal,
    month: monthOf(now),
    kind: budgetKindOf(record.call.purpose),
    alias: record.call.alias,
    modelId: record.modelId,
    inputTokens: record.usage.input_tokens,
    outputTokens: record.usage.output_tokens,
    cacheReadTokens: record.usage.cache_read_input_tokens,
    cacheWriteTokens: record.usage.cache_creation_input_tokens,
    costUsd: record.costUsd,
    outcome: record.outcome,
    ref: record.call.ref,
    traceId: record.call.traceId,
    gatewayCallId: record.gatewayCallId,
  };
}

export function toSpan(record: CallRecord): GatewaySpan {
  return {
    "gen_ai.system": "anthropic",
    "gen_ai.request.model": record.modelId,
    "hb.alias": record.call.alias,
    "hb.agent": record.call.agent,
    "hb.guide.version": record.call.guide?.version ?? null,
    "hb.guide.sha256": record.call.guide?.sha256 ?? null,
    "hb.prompt.sha256": record.promptSha256,
    "gen_ai.usage.input_tokens": record.usage.input_tokens,
    "gen_ai.usage.output_tokens": record.usage.output_tokens,
    "gen_ai.usage.cache_read_input_tokens": record.usage.cache_read_input_tokens,
    "gen_ai.usage.cache_creation_input_tokens": record.usage.cache_creation_input_tokens,
    "hb.cost_usd": record.costUsd,
    "hb.price_unknown": record.priceUnknown,
    "hb.web_search_requests": record.searches,
    "hb.purpose": record.call.purpose,
    "hb.principal": principalId(record.call.principal),
    "hb.outcome": record.outcome,
    trace_id: record.call.traceId,
    span_id: record.spanId,
    "x-litellm-call-id": record.gatewayCallId,
    latency_ms: record.latencyMs,
    first_token_ms: record.firstTokenMs,
  };
}

export interface RecordDeps {
  readonly append: (row: BudgetRowInput) => Promise<unknown>;
  readonly log: GatewaySpanLogger;
  readonly now: () => Date;
}

export const defaultRecordDeps: RecordDeps = { append: appendBudgetRow, log: logGatewaySpan, now: () => new Date() };

/** The row first, then the span: a call whose row could not be written is not reported as recorded. */
export async function recordCall(record: CallRecord, deps: RecordDeps = defaultRecordDeps): Promise<void> {
  await deps.append(toBudgetRow(record, deps.now()));
  deps.log(toSpan(record));
}
