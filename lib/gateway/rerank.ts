import type Anthropic from "@anthropic-ai/sdk";

import { newSpanId } from "@/lib/api/trace";
import { AppError } from "@/lib/errors";
import { outcomeOfGatewayError, pricedUsage, recordCall, type RecordDeps } from "@/lib/gateway/budget";
import { defaultGatewayDeps, gatewayClient, mapGatewayError, type GatewayDeps } from "@/lib/gateway/client";
import { GatewayUnavailableError } from "@/lib/gateway/errors";
import { NO_USAGE, type Usage } from "@/lib/gateway/prices";
import { callHeaders } from "@/lib/gateway/headers";
import { MESSAGE_TEXT_OFF, messageTextHeaders } from "@/lib/gateway/messageText";
import { promptSha256 } from "@/lib/gateway/span";
import { principalId, RerankResponseSchema, type GatewayCall, type RerankResponse } from "@/lib/schemas/gateway";

/*
 * The re-ranker (feature-specs/12 § 7.1; architecture § 1: a small cross-encoder through the gateway, top 40 to
 * top 8 before the assistant drafts). One `hb-rerank` call of kind `RERANK` on the gateway's `/rerank` route with
 * the principal's key, its ledger row and its span line, exactly as `embedTexts` calls `/v1/embeddings`: the SDK
 * carries the route because the key, the retries, the error mapping and the `traceparent` are the same, and the
 * Messages resource has no rerank method, so the request goes through the client's generic `post`. Workers only,
 * like the rest of lib/gateway/ (spec 11 § 5.5).
 *
 * The call has no deadline of its own, as the embedding call has none: the budget retrieval answers to is the
 * 600 ms of architecture § 8, which `lib/search/retrieve.ts` measures and reports, and a per-call timeout is a
 * number neither spec gives.
 */

const CALL_ID_HEADER = "x-litellm-call-id";
const RERANK_ROUTE = "/rerank";

/**
 * The provider's per-document limit, in characters, above which a document is cut and the hit says so (§ 7.1).
 * It is `null` because the limit is the provider's, read from LiteLLM's model info, and § 7.1 forbids inventing
 * one here: until it is known, a document is sent whole and no hit is truncated. The cut itself is
 * `documentsFor`, tested with a limit given, so the day the number arrives it is one constant.
 *
 * That day was 2026-09-25: the re-ranker is self-hosted, so the provider's model info is ours to read.
 * `BAAI/bge-reranker-base` takes 512 tokens for the query and the document together; the composer caps a
 * question at 800 characters, and at a conservative 3.5 characters a token for mixed EN and PT that leaves
 * about 1,000 characters of document. Derived from the pin, not chosen: a new pin recomputes it from the
 * new model's window. It also bounds the latency, which on a processor is the binding cost (12 § 3.1).
 */
export const RERANK_DOCUMENT_CHARACTERS: number | null = 1_000;

export interface RerankDocument {
  /** The caller's own id for the document (a section anchor); the gateway sees positions, not ids. */
  readonly id: string;
  readonly text: string;
}

export interface RerankHit {
  readonly id: string;
  /** The cross-encoder's relevance score for the query, as the provider reported it. */
  readonly score: number;
  /** The document was longer than the provider's limit and only its first part was scored (§ 7.1). */
  readonly truncated: boolean;
}

export interface Reranked {
  /** The documents the gateway scored, by score descending, at most `topN` of them. */
  readonly hits: ReadonlyArray<RerankHit>;
  /** The id the gateway reported, or the alias when the answer carried none. */
  readonly modelId: string;
  readonly usage: Usage;
  readonly ms: number;
}

/** The call a caller describes: the alias, the purpose and the agent are this module's, so no other model can be reached here (49 § 6.2). */
export type RerankCall = Omit<GatewayCall, "alias" | "purpose" | "agent">;

export interface RerankInput {
  readonly query: string;
  readonly documents: ReadonlyArray<RerankDocument>;
  /** How many of the scored documents to keep: the assistant's eight (§ 7.2). */
  readonly topN: number;
}

/** A document as it is sent: cut to the provider's limit when there is one, with the flag the hit carries. */
export function documentsFor(documents: ReadonlyArray<RerankDocument>, limit: number | null): ReadonlyArray<{ readonly id: string; readonly text: string; readonly truncated: boolean }> {
  return documents.map((document) => {
    const truncated = limit !== null && document.text.length > limit;
    return { id: document.id, text: truncated ? document.text.slice(0, limit) : document.text, truncated };
  });
}

/**
 * The input tokens of a re-rank answer: the proxy's `meta`, or the provider's own `usage` when the proxy passed it
 * through. A count nobody reported is 0, as for a call whose usage block is absent (spec 11 § 5.4).
 */
export function usageOfRerank(answer: RerankResponse): Usage {
  const tokens = answer.meta?.tokens?.input_tokens ?? answer.meta?.billed_units?.total_tokens ?? answer.usage?.total_tokens ?? 0;
  return { ...NO_USAGE, input_tokens: tokens };
}

/** The gateway's results as hits of the caller's documents, by score descending; a result outside the batch is a defect. */
export function hitsOf(
  results: RerankResponse["results"],
  sent: ReadonlyArray<{ readonly id: string; readonly truncated: boolean }>,
  topN: number,
): ReadonlyArray<RerankHit> {
  const hits = results.map((result) => {
    const document = sent[result.index];
    if (document === undefined) {
      throw new AppError("GATEWAY_RERANK_INDEX", `the gateway scored document ${result.index} of a batch of ${sent.length} (feature-specs/12 § 7.1)`);
    }
    return { id: document.id, score: result.relevance_score, truncated: document.truncated };
  });
  return [...hits].sort((a, b) => b.score - a.score).slice(0, topN);
}

/**
 * The answer read: the hits by score, the id the gateway reported (the alias when it named none) and its counts, or
 * the `AppError` that says why the body cannot be read. It is returned rather than thrown so the caller records the
 * call before raising it: the gateway answered, so the call is a completed one and owes its `BudgetLedger` row and
 * its span (spec 11 § 5.4).
 */
function readRerank(
  data: unknown,
  sent: ReadonlyArray<{ readonly id: string; readonly truncated: boolean }>,
  topN: number,
  alias: string,
): Pick<Reranked, "hits" | "modelId" | "usage"> | AppError {
  const parsed = RerankResponseSchema.safeParse(data);
  if (!parsed.success) {
    return new AppError("GATEWAY_RERANK_ANSWER", `the gateway's ${RERANK_ROUTE} answer is not a rerank response: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")}`);
  }
  try {
    return { hits: hitsOf(parsed.data.results, sent, topN), modelId: parsed.data.model ?? alias, usage: usageOfRerank(parsed.data) };
  } catch (error: unknown) {
    if (error instanceof AppError) return error;
    throw error;
  }
}

/**
 * One batch of documents scored against the query. Whatever happens, the call writes one `BudgetLedger` row and
 * one span line; a budget refusal, an unreachable gateway and a refused request are the typed errors of spec 11
 * § 5.2, which retrieval reads to keep the fused order instead (§ 7.2, D8).
 */
export async function rerank(call: RerankCall, input: RerankInput, deps: GatewayDeps = defaultGatewayDeps()): Promise<Reranked> {
  if (input.documents.length === 0) throw new AppError("GATEWAY_RERANK_EMPTY", "rerank was given no document; retrieval re-ranks the candidates of one query (feature-specs/12 § 7.2)");
  if (!Number.isInteger(input.topN) || input.topN < 1) throw new AppError("GATEWAY_RERANK_TOP_N", `topN must be a whole number of at least 1, not ${input.topN} (feature-specs/12 § 7.1)`);
  const full: GatewayCall = { ...call, alias: "hb-rerank", purpose: "rerank", agent: "rerank" };
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const sent = documentsFor(input.documents, RERANK_DOCUMENT_CHARACTERS);
  const request = { model: full.alias, query: input.query, documents: sent.map((document) => document.text), top_n: input.topN };
  const base = { call: full, promptSha256: promptSha256(request), spanId: newSpanId(), modelId: full.alias, usage: NO_USAGE, costUsd: 0, priceUnknown: false, searches: 0, gatewayCallId: null, firstTokenMs: null };
  const recordDeps: RecordDeps = { append: deps.append, log: deps.log, now: deps.now };
  const refuse = async (error: AppError, gatewayCallId: string | null = null): Promise<never> => {
    await recordCall({ ...base, outcome: outcomeOfGatewayError(error), gatewayCallId, latencyMs: elapsed() }, recordDeps);
    throw error;
  };

  let client: Anthropic;
  try {
    client = await gatewayClient(full.principal, deps);
  } catch (error: unknown) {
    if (error instanceof GatewayUnavailableError) return refuse(error);
    throw error;
  }

  const options = { headers: { ...callHeaders(full, base.spanId), ...messageTextHeaders(full.agent, deps.messageText ?? MESSAGE_TEXT_OFF) } };
  let answer: { readonly data: unknown; readonly response: Response };
  try {
    answer = await client.post<unknown>(RERANK_ROUTE, { ...options, body: { ...request, metadata: { user_id: principalId(full.principal) } } }).withResponse();
  } catch (error: unknown) {
    const mapped = mapGatewayError(error, deps.now());
    if (mapped === null) throw error;
    return refuse(mapped);
  }

  /* The gateway has answered, so the call completed and its row and span are owed whatever the body holds
     (spec 11 § 5.4): an answer this module cannot read is recorded with the gateway's own call id, under the
     outcome `outcomeOfGatewayError` gives a non-gateway error, and only then raised. */
  const gatewayCallId = answer.response.headers.get(CALL_ID_HEADER);
  const read = readRerank(answer.data, sent, input.topN, full.alias);
  if (read instanceof AppError) return refuse(read, gatewayCallId);
  await recordCall({ ...base, outcome: "ok", ...pricedUsage(full.alias, read.modelId, read.usage), gatewayCallId, latencyMs: elapsed() }, recordDeps);
  return { ...read, ms: elapsed() };
}
