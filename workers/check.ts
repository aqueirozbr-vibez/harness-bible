import { newTraceId } from "@/lib/api/trace";
import { callModel, defaultGatewayDeps, type GatewayDeps } from "@/lib/gateway/client";
import { requestFor } from "@/lib/gateway/policy";
import { usageOf, type Usage } from "@/lib/gateway/prices";
import type { Principal } from "@/lib/schemas/gateway";

/*
 * The smoke test of a fresh environment (feature-specs/11 § 3.6, § 7.2 `/gateway/check`): one `hb-small` call with
 * a fixed prompt through the client, so the key, the budget, the ledger row and the span are all exercised, and
 * the usage block comes back for the operator to read. The stub answers it with its fixed echo.
 */

export const CHECK_PROMPT = "gateway check";

export interface GatewayCheck {
  readonly model: string;
  /** The four counts as the ledger records them (the API's nullable cache counts read as zero). */
  readonly usage: Usage;
}

export async function gatewayCheck(principal: Principal, deps: GatewayDeps = defaultGatewayDeps()): Promise<GatewayCheck> {
  const message = await callModel(
    { purpose: "assistant", alias: "hb-small", agent: "gateway.check", guide: null, principal, traceId: newTraceId(), ref: null },
    { ...requestFor("scopeClassifier"), messages: [{ role: "user", content: CHECK_PROMPT }] },
    deps,
  );
  return { model: message.model, usage: usageOf(message.usage) };
}
