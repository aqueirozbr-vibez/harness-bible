import { canonicalize, type JsonValue } from "@/lib/ledger/canonical";
import { sha256Hex } from "@/lib/ledger/hash";
import type { AgentName, Alias, Outcome, Purpose } from "@/lib/schemas/gateway";
import { genAiSpanOf } from "@/lib/telemetry/lines";
import { printLine } from "@/lib/telemetry/print";
import { recordSpan } from "@/lib/telemetry/spans";

/*
 * The span of a model call (feature-specs/11 § 5.4; architecture § 7): OTel GenAI attribute names as one JSON log
 * line, the handler's form until the collector exists (spec 21). No prompt text, no answer text, no key: nothing
 * the line holds could rebuild the prompt (code-standards § Workers).
 */

export interface GatewaySpan {
  readonly "gen_ai.system": "anthropic";
  /** The pinned id the gateway reported, or the alias when the call produced no response. */
  readonly "gen_ai.request.model": string;
  readonly "hb.alias": Alias;
  /** Who made the call (feature-specs/49 § 6.2): the span's name on the Langfuse road, and its generation's. */
  readonly "hb.agent": AgentName;
  readonly "hb.guide.version": string | null;
  readonly "hb.guide.sha256": string | null;
  readonly "hb.prompt.sha256": string;
  readonly "gen_ai.usage.input_tokens": number;
  readonly "gen_ai.usage.output_tokens": number;
  readonly "gen_ai.usage.cache_read_input_tokens": number;
  readonly "gen_ai.usage.cache_creation_input_tokens": number;
  readonly "hb.cost_usd": number;
  /** True when `prices.ts` could not price the id the gateway reported: the cost is 0 and the row awaits a reprice. */
  readonly "hb.price_unknown": boolean;
  /** The provider's count of web searches in the call (41 § 3); 0 for a call without the tool. */
  readonly "hb.web_search_requests": number;
  readonly "hb.purpose": Purpose;
  readonly "hb.principal": string;
  readonly "hb.outcome": Outcome;
  readonly trace_id: string;
  /** The span's own id, sent in the call's `traceparent`: the gateway's generation is its child (feature-specs/49 § 5.3). */
  readonly span_id: string;
  readonly "x-litellm-call-id": string | null;
  readonly latency_ms: number;
  readonly first_token_ms: number | null;
}

export type GatewaySpanLogger = (span: GatewaySpan) => void;

export const logGatewaySpan: GatewaySpanLogger = (span) => {
  printLine("model_call", span);
  /* The same facts as a `gen_ai.*` span when a collector is configured (feature-specs/21 § 5.1); nothing otherwise. */
  recordSpan(genAiSpanOf(span, Date.now()));
};

/**
 * sha256 of the canonical request without `metadata`, `stream` and the conversation (`messages`): the byte-stable
 * prefix of spec 13 hashes the same across turns, and a different principal or a longer conversation does not
 * change it (invariant 10 wants the prompt identified, not copied).
 */
const VOLATILE_FIELDS: ReadonlySet<string> = new Set(["messages", "metadata", "stream"]);

export function promptSha256(request: object): string {
  const prefix = Object.fromEntries(Object.entries(request).filter(([name]) => !VOLATILE_FIELDS.has(name)));
  return sha256Hex(canonicalize(JSON.parse(JSON.stringify(prefix)) as JsonValue));
}
