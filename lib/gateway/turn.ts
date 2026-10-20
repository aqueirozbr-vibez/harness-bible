import type { ContentBlock, Message, MessageCreateParamsNonStreaming, MessageParam } from "@anthropic-ai/sdk/resources/messages";

import { callModel, mapGatewayError, type GatewayDeps } from "@/lib/gateway/client";
import { GatewayRefusedError } from "@/lib/gateway/errors";
import { pagesSeen, serverToolUsageOf, toolBlocksOf, usesOf, type ToolBlocksSeen } from "@/lib/gateway/tools";
import { WEB_SEARCH_TOOL_TYPE, type GatewayCall, type ServerTool, type ServerTools } from "@/lib/schemas/gateway";

/*
 * One turn of a model that holds the provider's web tools (feature-specs/41 § 3; unit 58a). The provider may answer
 * `stop_reason: "pause_turn"` with the turn unfinished — a search done, the answer not yet written — and the
 * reference's mechanics are these: send the same request again with the paused content appended as the assistant's
 * message, the same tools, no new message of ours, and read on. Continuing is the same attempt, not a second one
 * (invariant 15): the agent's cap is one turn, however many requests the provider needed for it. Each request is one
 * `callModel`, so each writes its own ledger row and span under the run's `ref`, and the gateway sees and charges
 * each as the request it is. Each request is streamed (2026-10-10, after the first real run): the provider runs the
 * searches, the fetches and its result-filtering code inside the request before the answer begins, which takes
 * minutes, and a non-streamed request meets the provider's ten-minute edge where a streamed one does not; the stream's
 * `finalMessage()` is the whole message, tool blocks included, and its failure is mapped as the client maps one.
 *
 * The limits of uses bound the whole turn, not each request (41 § 3; A13): the continuation's tools carry what is
 * left of the call's `max_uses` after the uses the content already holds, and a tool with no use left is left out of
 * the continuation — the eleventh search would be the product's doing, not the model's — while the other goes on (the
 * provider pauses after its own number of tool iterations, which a turn of ten searches reaches with every fetch still
 * unused; review of units 57–58). A turn that pauses with no use left on either tool is not continued and ends as
 * `unfinished`, which the reader treats as the turn's answer missing; so does a continuation the gateway refuses
 * (a 4xx on the request that carried the paused content), rather than failing the turn after what it already cost. At
 * most CONTINUATIONS_MAX continuations, so a provider that paused without end could not run the activity past its
 * deadline (the reader's row: 180 s a request).
 *
 * Two things for a person's research (feature-specs/48 § 5.4, § 6; unit 69c). `onBlock` is told each content block
 * as the stream completes it, across every request of the turn in order, so the run can show each search and each
 * page while the turn runs; it is progress, and the turn's answer, its pages and `SOURCE_NOT_SEEN` still come from the
 * whole content as before. And a turn that fails keeps what it counted: the error it throws — a continuation's
 * `BudgetExceededError` or `GatewayUnavailableError` above all, since the requests before it were charged for their
 * searches — is the same error of the same class, and `turnCountsOf(error)` reads the provider's counts of the
 * requests that had answered, so the run stores what it paid for before it ends.
 *
 * And a turn may be given `signal`, the activity's cancellation (48 § 5.1; review of unit 70): each request of the turn
 * is sent with it, so a cancelled run's stream is aborted where it stands and no continuation follows. The abort is
 * thrown as the SDK's error, carrying the turn's counts as any other failure.
 */

export const CONTINUATIONS_MAX = 2;

/** What a turn had counted when it failed: the provider's counts over the requests that answered, and the continuations sent. */
export interface TurnCounts {
  readonly searches: number;
  readonly fetches: number;
  readonly continuations: number;
}

/* Keyed by the error itself, so the error keeps its class and its fields and callers keep testing it with `instanceof`. */
const countsOfFailure = new WeakMap<object, TurnCounts>();

/** The counts of the turn that threw `error` (48 § 5.4); null for an error no turn threw. A first request's failure counts zeros. */
export function turnCountsOf(error: unknown): TurnCounts | null {
  return typeof error === "object" && error !== null ? (countsOfFailure.get(error) ?? null) : null;
}

export interface ModelTurn {
  /** The last response: its `model`, `stop_reason` and `usage` are the turn's final ones. */
  readonly message: Message;
  /** Every content block of the turn in order, across the continuations: what the parser and the pages are read from. */
  readonly content: ReadonlyArray<ContentBlock>;
  readonly continuations: number;
  readonly seen: ToolBlocksSeen;
  /** The `https` addresses the searches returned and the fetches opened (41 § 7). */
  readonly pages: ReadonlyArray<string>;
  /** The provider's own counts, summed over the requests of the turn: what the run stores and the ledger priced. */
  readonly searches: number;
  readonly fetches: number;
  /** The provider paused once more than the turn could continue: the content holds no final answer. */
  readonly unfinished: boolean;
}

/** The tools of a continuation: each of the call's that has a use left, with what is left; null when none has. */
export function remainingTools(tools: ServerTools, uses: { readonly searches: number; readonly fetches: number }): ServerTools | null {
  const left: ServerTool[] = [];
  for (const tool of tools) {
    const used = tool.type === WEB_SEARCH_TOOL_TYPE ? uses.searches : uses.fetches;
    if (used >= tool.max_uses) continue;
    left.push({ ...tool, max_uses: tool.max_uses - used });
  }
  return left.length === 0 ? null : left;
}

/** One streamed request: the stream's final message, with the stream's own failure as the client's typed error; `onBlock` hears each block as it completes; `signal` aborts it. */
async function streamedCall(call: GatewayCall, request: MessageCreateParamsNonStreaming, deps: GatewayDeps | undefined, now: () => Date, onBlock: ((block: ContentBlock) => void) | undefined, signal: AbortSignal | undefined): Promise<Message> {
  const { stream: _unstreamed, ...rest } = request as MessageCreateParamsNonStreaming & { stream?: false };
  void _unstreamed;
  const stream = await callModel(call, { ...rest, stream: true }, deps, onBlock, signal);
  try {
    return await stream.finalMessage();
  } catch (error: unknown) {
    throw mapGatewayError(error, now()) ?? error;
  }
}

/**
 * The turn, continued while the provider pauses it. `call.serverTools` names the tools and their limits for the
 * whole; the request is the row's, given without `stream` and without `tools` of its own (the client refuses one), and
 * sent streamed. `onBlock`, when given, hears every block of every request in order (48 § 6); `signal`, when given,
 * aborts the request it finds running and every one after it (48 § 5.1).
 */
export async function callModelTurn(call: GatewayCall & { readonly serverTools: ServerTools }, request: MessageCreateParamsNonStreaming, deps?: GatewayDeps, onBlock?: (block: ContentBlock) => void, signal?: AbortSignal): Promise<ModelTurn> {
  const content: ContentBlock[] = [];
  let messages: ReadonlyArray<MessageParam> = request.messages;
  let tools: ServerTools = call.serverTools;
  let continuations = 0;
  let searches = 0;
  let fetches = 0;
  let paused: Message | null = null;
  for (;;) {
    let message: Message;
    try {
      message = await streamedCall({ ...call, serverTools: tools }, { ...request, messages: [...messages] }, deps, deps?.now ?? (() => new Date()), onBlock, signal);
    } catch (error: unknown) {
      /* a continuation the gateway refuses leaves the turn unfinished with what it holds; the first request's refusal is the caller's */
      if (paused !== null && error instanceof GatewayRefusedError && error.status >= 400 && error.status < 500) return finished(paused, content, continuations, searches, fetches, true);
      /* any other failure is thrown as it came, carrying what the turn had counted (48 § 5.4) */
      if (typeof error === "object" && error !== null) countsOfFailure.set(error, { searches, fetches, continuations });
      throw error;
    }
    paused = message;
    content.push(...message.content);
    const usage = serverToolUsageOf(message.usage);
    searches += usage.searches;
    fetches += usage.fetches;
    if (message.stop_reason !== "pause_turn") return finished(message, content, continuations, searches, fetches, false);
    const left = continuations < CONTINUATIONS_MAX ? remainingTools(call.serverTools, usesOf(toolBlocksOf(content))) : null;
    if (left === null) return finished(message, content, continuations, searches, fetches, true);
    tools = left;
    /* the paused content goes back as the assistant's message, and nothing of ours after it */
    messages = [...messages, { role: "assistant", content: message.content as unknown as MessageParam["content"] }];
    continuations += 1;
  }
}

function finished(message: Message, content: ReadonlyArray<ContentBlock>, continuations: number, searches: number, fetches: number, unfinished: boolean): ModelTurn {
  const seen = toolBlocksOf(content);
  return { message, content, continuations, seen, pages: pagesSeen(seen), searches, fetches, unfinished };
}
