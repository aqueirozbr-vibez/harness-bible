import { traceparent } from "@/lib/api/trace";
import type { GatewayCall } from "@/lib/schemas/gateway";

/*
 * The headers every model call sends beside its body (feature-specs/49 § 5.3, § 6.2): the `traceparent` that makes
 * the gateway's generation a child of the call's own span, and the two `langfuse_*` headers the gateway's
 * `langfuse_otel` logger copies into its span, the agent as the generation's name and the guide's version as its
 * version. Request options, never the body, so `promptSha256` does not move; an enumeration and a version, never
 * text. The proxy does not forward client headers to the provider (`forward_client_headers_to_llm_api` is unset).
 */
export function callHeaders(call: Pick<GatewayCall, "traceId" | "agent" | "guide">, spanId: string): Readonly<Record<string, string>> {
  return {
    traceparent: traceparent(call.traceId, spanId),
    langfuse_generation_name: call.agent,
    ...(call.guide === null ? {} : { langfuse_version: call.guide.version }),
  };
}
