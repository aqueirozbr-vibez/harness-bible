import type { z } from "zod";

import { GatewayRefusedError, GatewayUnavailableError, ProviderRefusalError } from "@/lib/gateway/errors";
import { jsonBody, unfenced } from "@/workers/agents/unfenced";

/*
 * What the researcher's three version 2 calls share of their answers (feature-specs/48 § 5.3, § 5.4, § 5.6; unit 69):
 * an output held to the guide's object, and a failure named. The parse is version 1's, written once for the three:
 * JSON, with or without a code fence or prose around it, held strictly to the schema, a key the guide did not name
 * refused without its name being echoed — the name is the model's text, and the reason reaches the engine's history
 * (invariant 35). A failure names the gateway's cause or the provider's category and never the model's words.
 */

export type ParsedOutput<T> = { readonly ok: true; readonly output: T } | { readonly ok: false; readonly reason: string };

export type ResearcherCall = "planner" | "reader" | "writer";

/** The output held to the guide's object: JSON, the schema's shape, no key the guide did not name (invariant 10). */
export function parseOutput<S extends z.ZodType>(text: string, schema: S, agent: ResearcherCall): ParsedOutput<z.infer<S>> {
  let value: unknown;
  try {
    value = JSON.parse(jsonBody(unfenced(text)));
  } catch {
    return { ok: false, reason: `the ${agent}'s output is not JSON` };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.code === "unrecognized_keys") return { ok: false, reason: `the ${agent}'s output has a key the guide did not name${issue.path.length === 0 ? "" : ` at ${issue.path.map(String).join(".")}`}` };
    const path = issue === undefined ? "" : issue.path.map(String).join(".");
    return { ok: false, reason: issue === undefined ? `the ${agent}'s output is not the guide's object` : path.length === 0 ? `the ${agent}'s output is not the guide's object: ${issue.message}` : `the ${agent}'s output has a fault at ${path}: ${issue.message}` };
  }
  return { ok: true, output: parsed.data as z.infer<S> };
}

/** A call's failure before an answer, named by its cause and never by text. */
export function failureOf(error: unknown): string {
  if (error instanceof GatewayUnavailableError) return `gateway unavailable (${error.cause})`;
  if (error instanceof GatewayRefusedError) return `gateway refused (${String(error.status)})`;
  if (error instanceof ProviderRefusalError) return `provider refusal (${error.category ?? "unspecified"})`;
  return "the call failed before an answer";
}

/** The usage a call reports, in the run's units. */
export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}

export function usageOf(usage: { readonly input_tokens: number; readonly output_tokens: number; readonly cache_read_input_tokens?: number | null }): CallUsage {
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadTokens: usage.cache_read_input_tokens ?? 0 };
}
