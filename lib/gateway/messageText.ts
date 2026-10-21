import type { MessageTextGate } from "@/lib/env";
import type { AgentName } from "@/lib/schemas/gateway";

/*
 * The workers' lock on a call's text (feature-specs/49 § 9.2, lock 1). The gateway redacts every call's messages
 * and response before its logger runs (its global redaction setting, on in every environment); a request may opt out
 * with this header, and the gateway honours it only for a key whose metadata allows it (lock 2, `workers/keys.ts`),
 * after which the collector passes the text only when its own half is on (lock 3). This is the only file of the
 * product that names the header (tests/gateway-config.test.ts).
 *
 * Never for the evidence grader's PDF or image row: a contributor's file of up to 32 MB, not a turn of
 * conversation, and the collector deletes it by name too (§ 9.3).
 */

const OPT_OUT_HEADER = "litellm-disable-message-redaction";

/** No gate given counts as the gate off, so a path that forgets to pass one fails closed. */
export const MESSAGE_TEXT_OFF: MessageTextGate = { on: false, why: "no gate was given" };

export function messageTextHeaders(agent: AgentName, gate: MessageTextGate): Readonly<Record<string, string>> {
  return gate.on && agent !== "evidence.grade.bytes" ? { [OPT_OUT_HEADER]: "true" } : {};
}
