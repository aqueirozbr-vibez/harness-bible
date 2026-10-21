import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { ContentBlock, Message, MessageCreateParams, MessageCreateParamsNonStreaming, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";

import { newSpanId } from "@/lib/api/trace";
import { appendBudgetRow, type BudgetRowInput } from "@/lib/db/budget";
import { findGatewayKey } from "@/lib/db/gateway";
import { env, messageTextGate, type MessageTextGate } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { outcomeOfGatewayError, outcomeOfMessage, recordCall, type CallRecord, type RecordDeps } from "@/lib/gateway/budget";
import { BudgetExceededError, budgetResetAt, GatewayRefusedError, GatewayUnavailableError, isBudgetError, ProviderRefusalError } from "@/lib/gateway/errors";
import { decryptKey, keySecret } from "@/lib/gateway/keys";
import { limitsFor, limitsOfRow } from "@/lib/gateway/policy";
import { NO_USAGE } from "@/lib/gateway/prices";
import { callHeaders } from "@/lib/gateway/headers";
import { MESSAGE_TEXT_OFF, messageTextHeaders } from "@/lib/gateway/messageText";
import { logGatewaySpan, promptSha256, type GatewaySpanLogger } from "@/lib/gateway/span";
import { principalId, ServerToolsSchema, type GatewayCall, type Principal } from "@/lib/schemas/gateway";

/*
 * The one door to a model (feature-specs/11 § 5.1; architecture § 11 invariants 6, 7, 10). The official SDK on
 * the gateway's Anthropic-format route with the principal's virtual key as `apiKey` (D1): the gateway enforces
 * the budget before a provider sees the request, this module moves bytes and records numbers. It never reads a
 * model's text. Workers only: the lint rule of § 5.5 keeps it out of the web tier, and without
 * GATEWAY_KEY_SECRET it refuses (`GATEWAY_KEYS_UNAVAILABLE`).
 */

type Fetch = typeof fetch;

/** The SDK's default: 408, 409, 429, 5xx and connection errors; a budget refusal is exempted by `budgetAwareFetch`. */
const MAX_RETRIES = 2;
const CALL_ID_HEADER = "x-litellm-call-id";

export interface GatewayDeps {
  readonly baseUrl: string | undefined;
  readonly keySecret: string | undefined;
  readonly findKey: (principal: Principal) => Promise<{ readonly keyCiphertext: string } | null>;
  readonly append: (row: BudgetRowInput) => Promise<unknown>;
  readonly log: GatewaySpanLogger;
  readonly fetch: Fetch;
  readonly now: () => Date;
  /** The development text switch's gate (feature-specs/49 § 9.1); absent counts as off. */
  readonly messageText?: MessageTextGate;
}

export function defaultGatewayDeps(): GatewayDeps {
  return { baseUrl: env.GATEWAY_URL, keySecret: env.GATEWAY_KEY_SECRET, findKey: findGatewayKey, append: appendBudgetRow, log: logGatewaySpan, fetch: globalThis.fetch, now: () => new Date(), messageText: messageTextGate };
}

/**
 * The SDK retries a 429, and the proxy's budget refusal is a 429 (25b, from auth_checks.py). The SDK also honours
 * `x-should-retry: false`, so a budget refusal gets that header here and is never repeated (spec § 5.1).
 */
export function budgetAwareFetch(base: Fetch): Fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.status !== 429) return response;
    const text = await response.clone().text();
    if (!isBudgetError(response.status, text)) return response;
    const headers = new Headers(response.headers);
    headers.set("x-should-retry", "false");
    return new Response(text, { status: response.status, statusText: response.statusText, headers });
  };
}

/** The SDK's error as the client's (spec § 5.2), or null for an error that is not the gateway's (a ledger write, an abort by the caller). */
export function mapGatewayError(error: unknown, now: Date): BudgetExceededError | GatewayUnavailableError | GatewayRefusedError | null {
  if (error instanceof APIConnectionTimeoutError) return new GatewayUnavailableError("timeout", error.message);
  if (error instanceof APIConnectionError) return new GatewayUnavailableError("connection", error.message);
  if (error instanceof APIError && typeof error.status === "number") {
    const status = error.status;
    if (isBudgetError(status, error.error ?? error.message)) return new BudgetExceededError(budgetResetAt(now), error.message);
    if (status === 429) return new GatewayUnavailableError("rate_limit", error.message);
    if (status >= 500) return new GatewayUnavailableError("server", error.message);
    return new GatewayRefusedError(status, error.message);
  }
  return null;
}

/** An SDK client on the gateway with the principal's key: `GATEWAY_KEYS_UNAVAILABLE` without the secret, `GatewayUnavailableError` without a gateway or a key. */
export async function gatewayClient(principal: Principal, deps: GatewayDeps = defaultGatewayDeps()): Promise<Anthropic> {
  if (deps.baseUrl === undefined) {
    throw new GatewayUnavailableError("unconfigured", "GATEWAY_URL is not set: every model call is refused (feature-specs/11 § 8).");
  }
  keySecret(deps.keySecret);
  const row = await deps.findKey(principal);
  if (row === null) {
    throw new GatewayUnavailableError("no_key", `${principalId(principal)} has no gateway key; the workers mint one on first use (feature-specs/11 § 7.3).`);
  }
  return new Anthropic({ apiKey: decryptKey(deps.keySecret, row.keyCiphertext), baseURL: deps.baseUrl, maxRetries: MAX_RETRIES, fetch: budgetAwareFetch(deps.fetch) });
}

type CallBase = Omit<CallRecord, "outcome" | "latencyMs">;

/** The call's server tools, checked against the schema whatever the caller's type said, and refused as a whole when any is not one of the two. */
function serverToolsOf(tools: GatewayCall["serverTools"]): MessageCreateParams["tools"] {
  const parsed = ServerToolsSchema.safeParse(tools);
  if (!parsed.success) throw new AppError("GATEWAY_TOOLS_REFUSED", `serverTools: ${parsed.error.issues.map((issue) => issue.message).join("; ")} (feature-specs/41 § 3)`);
  return parsed.data;
}

/**
 * One model call: the alias as `model`, the principal as `metadata.user_id` (the proxy's spend attribution), the
 * prompt hash, the timeout of the purpose, `traceparent`; then one ledger row and one span whatever happened. A
 * streaming call returns once the gateway has answered the request, so a refusal surfaces as a typed error here,
 * and its ledger row is written when the stream ends: `finalMessage()` then answers with the message, or raises
 * the failure of that row or the provider's refusal, as the non-streaming path does.
 *
 * Tools (feature-specs/41 § 3; unit 58a): a request never carries its own `tools`, and one that does is refused before
 * anything is sent (`GATEWAY_TOOLS_REFUSED`), so no module can hand the model a client tool by the door. The only
 * tools a call may hold are `call.serverTools`, the provider's web search and web fetch of `ServerToolsSchema`,
 * checked again here; they go on the request as `tools`. A call that searched has the count and the fee on its row.
 *
 * A streamed call may be given `onBlock` (feature-specs/48 § 6; unit 69c): it is told each content block as the stream
 * completes it, through the SDK's `contentBlock` event, so a reader's searches and fetches can be shown while the
 * request runs. It is attached here, on the line that creates the stream, because a listener attached after this
 * function returns could miss the blocks the stream had already read. It is progress and never the answer: the
 * caller's answer is still `finalMessage()`. The SDK calls a listener synchronously and a throw inside one would fail
 * the stream, so a listener that throws is logged with the call's trace and the call goes on.
 *
 * A streamed call may also be given `signal` (feature-specs/48 § 5.1; review of unit 70): the activity's cancellation,
 * which the SDK's request takes as its own, so a run cancelled while its reader streams — spec 46's erasure, an
 * operator — stops the request instead of reading on for up to half an hour on the person's key. The abort is the
 * caller's, not the gateway's (`mapGatewayError` answers null), so `finalMessage()` rejects with the SDK's
 * `APIUserAbortError` and the row is recorded `unavailable`, as any failure the gateway did not name.
 */
export function callModel(call: GatewayCall, request: MessageCreateParamsStreaming, deps?: GatewayDeps, onBlock?: (block: ContentBlock) => void, signal?: AbortSignal): Promise<MessageStream>;
export function callModel(call: GatewayCall, request: MessageCreateParamsNonStreaming, deps?: GatewayDeps): Promise<Message>;
export async function callModel(call: GatewayCall, request: MessageCreateParams, deps: GatewayDeps = defaultGatewayDeps(), onBlock?: (block: ContentBlock) => void, signal?: AbortSignal): Promise<MessageStream | Message> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  if ("tools" in request && request.tools !== undefined) throw new AppError("GATEWAY_TOOLS_REFUSED", "a request carries no tools of its own: the provider's web tools go on the call as serverTools, and there is no client tool (feature-specs/41 § 3)");
  const tools = call.serverTools === undefined ? {} : { tools: serverToolsOf(call.serverTools) };
  const base: CallBase = { call, promptSha256: promptSha256(request), spanId: newSpanId(), modelId: call.alias, usage: NO_USAGE, costUsd: 0, priceUnknown: false, searches: 0, gatewayCallId: null, firstTokenMs: null };
  const recordDeps: RecordDeps = { append: deps.append, log: deps.log, now: deps.now };
  const refuse = async (error: AppError): Promise<never> => {
    await recordCall({ ...base, outcome: outcomeOfGatewayError(error), latencyMs: elapsed() }, recordDeps);
    throw error;
  };

  let client: Anthropic;
  try {
    client = await gatewayClient(call.principal, deps);
  } catch (error: unknown) {
    if (error instanceof GatewayUnavailableError) return refuse(error);
    throw error;
  }
  const metadata = { ...request.metadata, user_id: principalId(call.principal) };
  /* The row's own deadline and retry count, per request: `timeout` is milliseconds in the TypeScript SDK, and
   * `maxRetries` overrides the client's default of two, so a row's worst case is its timeout times its attempts
   * (feature-specs/11 § 5.3; unit 37b). */
  const limits = call.row === undefined ? limitsFor(call.purpose, call.alias) : limitsOfRow(call.row, call.alias);
  const options = { timeout: limits.timeoutMs, maxRetries: limits.maxRetries, headers: { ...callHeaders(call, base.spanId), ...messageTextHeaders(call.agent, deps.messageText ?? MESSAGE_TEXT_OFF) }, ...(signal === undefined ? {} : { signal }) };

  if (request.stream === true) {
    const params: MessageCreateParamsStreaming = { ...request, ...tools, model: call.alias, metadata };
    const stream = client.messages.stream(params, options);
    let firstTokenMs: number | null = null;
    let gatewayCallId: string | null = null;
    stream.on("streamEvent", (event) => {
      if (firstTokenMs === null && event.type === "content_block_delta") firstTokenMs = elapsed();
    });
    if (onBlock !== undefined) {
      stream.on("contentBlock", (block) => {
        try {
          onBlock(block);
        } catch (error: unknown) {
          console.error("gateway: a block listener of a streamed call failed", call.traceId, error instanceof Error ? error.name : typeof error);
        }
      });
    }
    const finalMessage = stream.finalMessage.bind(stream);
    const recorded = finalMessage().then(
      (message) => recordCall({ ...base, ...outcomeOfMessage(call.alias, message), gatewayCallId, firstTokenMs, latencyMs: elapsed() }, recordDeps),
      (error: unknown) => {
        const mapped = mapGatewayError(error, deps.now());
        return recordCall({ ...base, outcome: mapped === null ? "unavailable" : outcomeOfGatewayError(mapped), gatewayCallId, firstTokenMs, latencyMs: elapsed() }, recordDeps);
      },
    );
    /* The logged branch keeps a consumer that never awaits `finalMessage()` from an unhandled rejection; the
     * consumer that does await it is told, because `finalMessage` below awaits this same promise. */
    recorded.catch((error: unknown) => {
      console.error("gateway: the ledger row of a streamed call was not written", call.traceId, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    });
    /*
     * The stream's `finalMessage()` carries what the non-streaming path throws (spec § 5.4, § 5.2): a ledger row
     * that could not be written fails the call rather than being logged and forgotten, and a provider refusal is
     * `ProviderRefusalError` after its row. The SDK's instance is patched rather than wrapped so the returned
     * value stays the `MessageStream` the caller iterates.
     */
    Object.defineProperty(stream, "finalMessage", {
      configurable: true,
      value: async (): Promise<Message> => {
        const message = await finalMessage();
        await recorded;
        if (message.stop_reason === "refusal") throw new ProviderRefusalError(message.stop_details?.category ?? null);
        return message;
      },
    });
    try {
      const { response } = await stream.withResponse();
      gatewayCallId = response.headers.get(CALL_ID_HEADER);
    } catch (error: unknown) {
      await recorded.catch(() => undefined);
      throw mapGatewayError(error, deps.now()) ?? error;
    }
    return stream;
  }

  const params: MessageCreateParamsNonStreaming = { ...request, ...tools, model: call.alias, metadata };
  try {
    const { data: message, response } = await client.messages.create(params, options).withResponse();
    await recordCall({ ...base, ...outcomeOfMessage(call.alias, message), gatewayCallId: response.headers.get(CALL_ID_HEADER), latencyMs: elapsed() }, recordDeps);
    if (message.stop_reason === "refusal") throw new ProviderRefusalError(message.stop_details?.category ?? null);
    return message;
  } catch (error: unknown) {
    const mapped = mapGatewayError(error, deps.now());
    if (mapped === null) throw error;
    return refuse(mapped);
  }
}
