import { callModel, defaultGatewayDeps, type GatewayDeps } from "@/lib/gateway/client";
import { BudgetExceededError, GatewayRefusedError, GatewayUnavailableError, ProviderRefusalError } from "@/lib/gateway/errors";
import { requestFor } from "@/lib/gateway/policy";
import { consistent, type Routing } from "@/lib/rubric/thresholds";
import type { EvidenceTier } from "@/lib/schemas/domain";
import type { GatewayCall, Principal } from "@/lib/schemas/gateway";
import type { RubricRules } from "@/lib/schemas/rubric";

import { assembleAdjudicator, type AdjudicatorInput } from "./assemble";
import { parseAdjudication, type AdjudicationOutput } from "./parse";

/*
 * One suggestion adjudicated (feature-specs/33 § 5): the prompt of assemble.ts through the gateway client on the
 * `adjudicator` row as `service:adjudicator`'s call, charged to the contributor's principal (§ 7), then checked by
 * code (§ 5.4): the strict parse; `consistent` — it cannot accept under the acceptance, with a failed sensor, or a
 * single-tier class without that tier, and cannot ask for more under the floor; a tier that would suffice that the
 * arithmetic lists; a failing sensor that did fail. One attempt (invariant 15): a gateway failure, a provider's refusal
 * or an output any check refuses is the agent's one failure, named, and the suggestion goes to a curator. A budget
 * refusal is thrown: waiting for the reset is the workflow's (50f).
 */

export const ADJUDICATOR_REQUEST = requestFor("adjudicator");

export interface AdjudicateInput {
  readonly prompt: AdjudicatorInput;
  readonly call: { readonly principal: Principal; readonly traceId: string; readonly ref: string };
  /** What code checks the output against: the rubric's rules and the routing the score was made by. */
  readonly rules: RubricRules;
  readonly routing: Routing;
}

export interface AdjudicateDeps {
  readonly gateway: GatewayDeps;
}

export const defaultAdjudicateDeps = (): AdjudicateDeps => ({ gateway: defaultGatewayDeps() });

interface Answered {
  /** The model that answered, or null when none did. */
  readonly model: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number } | null;
  readonly promptSha256: string;
}

export type Adjudicated = (Answered & { readonly ok: true; readonly output: AdjudicationOutput }) | (Answered & { readonly ok: false; readonly failure: string });

/** The output's first disagreement with the arithmetic, named; null when it keeps to it (§ 5.4 checks 2 and 3). */
export function arithmeticDisagreement(output: AdjudicationOutput, rules: RubricRules, routing: Routing, wouldSuffice: ReadonlyArray<EvidenceTier>): string | null {
  const threshold = rules.thresholds[routing.changeClass];
  if (!consistent(rules, output.decision, routing)) {
    if (output.decision === "ACCEPT") return `it accepts at ${String(routing.score)} against ${String(threshold?.acceptAt ?? "no acceptance")}, or with a sensor failed, or without the class's one tier`;
    return `it asks for more at ${String(routing.score)}, under the floor of ${String(threshold?.floorAt ?? "none")}`;
  }
  if (output.sufficientTier !== undefined && !wouldSuffice.includes(output.sufficientTier)) return `tier ${output.sufficientTier} is not one that would suffice (${wouldSuffice.length === 0 ? "none would" : wouldSuffice.join(", ")})`;
  if (output.failingSensor !== undefined && !routing.verdicts.some((v) => v.sensor === output.failingSensor && v.result === "FAIL")) return `${output.failingSensor} did not fail`;
  return null;
}

function failureOf(error: unknown): string {
  if (error instanceof GatewayUnavailableError) return `gateway unavailable (${error.cause})`;
  if (error instanceof GatewayRefusedError) return `gateway refused (${String(error.status)})`;
  if (error instanceof ProviderRefusalError) return `provider refusal (${error.category ?? "unspecified"})`;
  return "the call failed before an answer";
}

/** The call and the request an adjudication makes: one place, so what is recorded is what is sent. */
export function adjudicationRequestOf(input: AdjudicateInput) {
  const prompt = assembleAdjudicator(input.prompt);
  const call: GatewayCall = {
    purpose: "adjudication",
    alias: "hb-frontier",
    agent: "adjudicator.decide",
    guide: { agent: "adjudicator", version: input.prompt.guide.version, sha256: input.prompt.guide.sha256 },
    principal: input.call.principal,
    traceId: input.call.traceId,
    ref: input.call.ref,
  };
  const request = { ...ADJUDICATOR_REQUEST, system: [...prompt.system], messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })) };
  return { call, request, promptSha256: prompt.sha256 };
}

export async function adjudicate(input: AdjudicateInput, deps: AdjudicateDeps = defaultAdjudicateDeps()): Promise<Adjudicated> {
  const { call, request, promptSha256 } = adjudicationRequestOf(input);
  let model: string;
  let text: string;
  let usage: Answered["usage"];
  try {
    const message = await callModel(call, request, deps.gateway);
    model = message.model;
    text = message.content.map((block) => ("text" in block ? block.text : "")).join("");
    usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, cacheReadTokens: message.usage.cache_read_input_tokens ?? 0 };
  } catch (error: unknown) {
    if (error instanceof BudgetExceededError) throw error;
    return { ok: false, failure: failureOf(error), model: null, usage: null, promptSha256 };
  }
  const parsed = parseAdjudication(text);
  if (!parsed.ok) return { ok: false, failure: parsed.reason, model, usage, promptSha256 };
  const disagreement = arithmeticDisagreement(parsed.output, input.rules, input.routing, input.prompt.arithmetic.wouldSuffice);
  if (disagreement !== null) return { ok: false, failure: disagreement, model, usage, promptSha256 };
  return { ok: true, output: parsed.output, model, usage, promptSha256 };
}
