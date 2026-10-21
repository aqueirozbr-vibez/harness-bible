import { describe, expect, it } from "vitest";

import { AGENT_NAMES } from "@/lib/schemas/gateway";

import { MESSAGE_TEXT_OFF, messageTextHeaders } from "./messageText";

const OPEN = { on: true, why: null } as const;
const SHUT = { on: false, why: "LANGFUSE_MESSAGE_TEXT is off" } as const;

describe("the workers' lock on a call's text (49 § 9.2, lock 1)", () => {
  it("asks the gateway not to redact only with the gate open, and never for the evidence grader's PDF or image row", () => {
    for (const agent of AGENT_NAMES) {
      expect(messageTextHeaders(agent, OPEN), agent).toEqual(agent === "evidence.grade.bytes" ? {} : { "litellm-disable-message-redaction": "true" });
    }
  });

  it("sends nothing with the gate shut, or with no gate given, for every agent", () => {
    for (const agent of AGENT_NAMES) {
      expect(messageTextHeaders(agent, SHUT), agent).toEqual({});
      expect(messageTextHeaders(agent, MESSAGE_TEXT_OFF), agent).toEqual({});
    }
  });
});
