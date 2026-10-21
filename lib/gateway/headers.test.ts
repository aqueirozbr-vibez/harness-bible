import { describe, expect, it } from "vitest";

import { AGENT_NAMES } from "@/lib/schemas/gateway";

import { callHeaders } from "./headers";

const TRACE = "b".repeat(32);
const SPAN = "c".repeat(16);

describe("a model call's headers (49 § 5.3, § 6.2)", () => {
  it("names the call's span as the parent, the agent as the generation, and the guide's version where there is a guide", () => {
    expect(callHeaders({ traceId: TRACE, agent: "assistant.draft", guide: { agent: "assistant", version: "v1.13", sha256: "a".repeat(64) } }, SPAN)).toEqual({
      traceparent: `00-${TRACE}-${SPAN}-01`,
      langfuse_generation_name: "assistant.draft",
      langfuse_version: "v1.13",
    });
    expect(callHeaders({ traceId: TRACE, agent: "embed.query", guide: null }, SPAN)).toEqual({ traceparent: `00-${TRACE}-${SPAN}-01`, langfuse_generation_name: "embed.query" });
  });

  it("carries each agent's name as it is, an enumeration member and nothing else", () => {
    for (const agent of AGENT_NAMES) expect(callHeaders({ traceId: TRACE, agent, guide: null }, SPAN).langfuse_generation_name).toBe(agent);
  });
});
