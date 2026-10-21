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
import { EmbeddingsResponseSchema, EMBEDDING_DIMENSIONS, principalId, type GatewayCall } from "@/lib/schemas/gateway";

/*
 * The embedding call (feature-specs/12 § 4.2, § 4.3): one `hb-embed` call per batch on the gateway's
 * `/v1/embeddings` route, with the principal's virtual key, its ledger row and its span line, exactly as
 * `callModel` does for `/v1/messages`. The SDK carries the route because the key, the retries, the error mapping
 * and the `traceparent` are the same; the Messages resource has no embeddings method, so the request goes through
 * the client's generic `post`. Workers only, like the rest of `lib/gateway/` (§ 5.5 of spec 11).
 *
 * The call has no deadline of its own: the spec fixes one for the web tier's route to the workers (§ 6, D6, 150 ms)
 * and none for this job, so the SDK's own request timeout stands rather than a number invented here.
 */

const CALL_ID_HEADER = "x-litellm-call-id";
const EMBEDDINGS_ROUTE = "/v1/embeddings";

export interface Embedded {
  /** One vector per input text, in the order the texts were given. */
  readonly vectors: ReadonlyArray<ReadonlyArray<number>>;
  /** The id the gateway reported, which the ledger row records; the pin the columns store is `EMBED_TARGET`. */
  readonly modelId: string;
  readonly usage: Usage;
  readonly ms: number;
}

/**
 * The call a caller describes: the alias and the purpose are this module's, so no other model can be reached here,
 * and its agent is one of the embedder's two, the query's or the release job's (feature-specs/49 § 6.2).
 */
export type EmbedCall = Omit<GatewayCall, "alias" | "purpose" | "agent"> & { readonly agent: "embed.query" | "embed.release" };

/** The four counts of an embeddings answer: input tokens only, which is what the provider bills. */
function usageOfEmbeddings(usage: { readonly prompt_tokens?: number; readonly total_tokens?: number } | undefined): Usage {
  return { ...NO_USAGE, input_tokens: usage?.prompt_tokens ?? usage?.total_tokens ?? 0 };
}

/** The vectors in the order of the texts, with each one's length checked against the column's (§ 4.1). */
function vectorsOf(data: ReadonlyArray<{ readonly index: number; readonly embedding: ReadonlyArray<number> }>, texts: number): ReadonlyArray<ReadonlyArray<number>> {
  if (data.length !== texts) {
    throw new AppError("GATEWAY_EMBED_COUNT", `the gateway returned ${data.length} embeddings for ${texts} texts (feature-specs/12 § 4.3)`);
  }
  const ordered = [...data].sort((a, b) => a.index - b.index);
  for (const item of ordered) {
    if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new AppError("GATEWAY_EMBED_DIMENSIONS", `embedding ${item.index} has ${item.embedding.length} dimensions, not ${EMBEDDING_DIMENSIONS}: the pin and Section.embedding disagree (feature-specs/12 § 3)`);
    }
  }
  return ordered.map((item) => item.embedding);
}

/**
 * The answer read: the vectors in the order of the texts, the id the gateway reported and its counts, or the
 * `AppError` that says why the body cannot be read. It is returned rather than thrown so the caller records the
 * call before raising it: the gateway answered, so the call is a completed one and owes its `BudgetLedger` row and
 * its span (feature-specs/11 § 5.4).
 */
function readEmbeddings(data: unknown, texts: number): Pick<Embedded, "vectors" | "modelId" | "usage"> | AppError {
  const parsed = EmbeddingsResponseSchema.safeParse(data);
  if (!parsed.success) {
    return new AppError("GATEWAY_EMBED_ANSWER", `the gateway's ${EMBEDDINGS_ROUTE} answer is not an embeddings response: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")}`);
  }
  try {
    return { vectors: vectorsOf(parsed.data.data, texts), modelId: parsed.data.model, usage: usageOfEmbeddings(parsed.data.usage) };
  } catch (error: unknown) {
    if (error instanceof AppError) return error;
    throw error;
  }
}

/**
 * One batch of texts embedded through the gateway. Whatever happens, the call writes one `BudgetLedger` row and one
 * span line; a budget refusal, an unreachable gateway and a refused request are the typed errors of § 5.2, which
 * the job reads to stop with its counts (§ 4.2).
 */
export async function embedTexts(call: EmbedCall, texts: ReadonlyArray<string>, deps: GatewayDeps = defaultGatewayDeps()): Promise<Embedded> {
  if (texts.length === 0) throw new AppError("GATEWAY_EMBED_EMPTY", "embedTexts was given no text; the job batches at least one section per call (feature-specs/12 § 4.2)");
  const full: GatewayCall = { ...call, alias: "hb-embed", purpose: "embed" };
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const request = { model: full.alias, input: texts };
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
    answer = await client.post<unknown>(EMBEDDINGS_ROUTE, { ...options, body: { ...request, metadata: { user_id: principalId(full.principal) } } }).withResponse();
  } catch (error: unknown) {
    const mapped = mapGatewayError(error, deps.now());
    if (mapped === null) throw error;
    return refuse(mapped);
  }

  /* The gateway has answered, so the call completed and its row and span are owed whatever the body holds
     (feature-specs/11 § 5.4): an answer this module cannot read is recorded with the gateway's own call id, under
     the outcome `outcomeOfGatewayError` gives a non-gateway error, and only then raised. */
  const gatewayCallId = answer.response.headers.get(CALL_ID_HEADER);
  const read = readEmbeddings(answer.data, texts.length);
  if (read instanceof AppError) return refuse(read, gatewayCallId);
  await recordCall({ ...base, outcome: "ok", ...pricedUsage(full.alias, read.modelId, read.usage), gatewayCallId, latencyMs: elapsed() }, recordDeps);
  return { ...read, ms: elapsed() };
}
