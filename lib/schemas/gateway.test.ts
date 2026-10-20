import { describe, expect, it } from "vitest";

import { ALIASES, GatewayCallSchema, OUTCOMES, principalId, PrincipalSchema, PURPOSES } from "./gateway";

describe("gateway schemas (feature-specs/11 § 5.1, § 6)", () => {
  it("fixes the aliases, purposes and outcomes the spec names", () => {
    expect(ALIASES).toEqual(["hb-frontier", "hb-small", "hb-embed", "hb-rerank"]);
    expect(PURPOSES).toEqual(["assistant", "grading", "adjudication", "lab", "embed", "rerank", "research"]);
    expect(OUTCOMES).toEqual(["ok", "budget", "unavailable", "refused", "provider_refusal"]);
  });

  it("takes a principal as exactly one id", () => {
    expect(PrincipalSchema.safeParse({ organisationId: "org-1" }).success).toBe(true);
    expect(PrincipalSchema.safeParse({ userId: "u-1" }).success).toBe(true);
    expect(PrincipalSchema.safeParse({ organisationId: "org-1", userId: "u-1" }).success).toBe(false);
    expect(PrincipalSchema.safeParse({}).success).toBe(false);
    expect(PrincipalSchema.safeParse({ userId: "" }).success).toBe(false);
  });

  it("names the principal as org:<id> or user:<id>", () => {
    expect(principalId({ organisationId: "org-1" })).toBe("org:org-1");
    expect(principalId({ userId: "u-1" })).toBe("user:u-1");
  });

  it("validates a call: a guide with its hash or none, a 32-hex trace id, a ref or null", () => {
    const call = { purpose: "assistant", alias: "hb-frontier", guide: { agent: "assistant", version: "v1.8", sha256: "a".repeat(64) }, principal: { userId: "u-1" }, traceId: "b".repeat(32), ref: "msg-1" };
    expect(GatewayCallSchema.safeParse(call).success).toBe(true);
    expect(GatewayCallSchema.safeParse({ ...call, guide: null, ref: null }).success).toBe(true);
    expect(GatewayCallSchema.safeParse({ ...call, guide: { agent: "assistant", version: "v1.8", sha256: "short" } }).success).toBe(false);
    expect(GatewayCallSchema.safeParse({ ...call, traceId: "nope" }).success).toBe(false);
    expect(GatewayCallSchema.safeParse({ ...call, alias: "claude-opus-5" }).success).toBe(false);
    expect(GatewayCallSchema.safeParse({ ...call, extra: 1 }).success).toBe(false);
    expect(GatewayCallSchema.safeParse({ ...call, row: "evidenceGraderBytes" }).success).toBe(true);
    expect(GatewayCallSchema.safeParse({ ...call, row: "noSuchRow" }).success).toBe(false);
    /* unit 58a: the provider's two web tools and nothing else (feature-specs/41 § 3) */
    expect(GatewayCallSchema.safeParse({ ...call, purpose: "research", guide: { agent: "researcher", version: "v1.0", sha256: "a".repeat(64) }, serverTools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 }] }).success).toBe(true);
    expect(GatewayCallSchema.safeParse({ ...call, serverTools: [] }).success).toBe(false);
    expect(GatewayCallSchema.safeParse({ ...call, serverTools: [{ name: "lookup", input_schema: { type: "object" } }] }).success).toBe(false);
    expect(GatewayCallSchema.safeParse({ ...call, serverTools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10, allowed_domains: [] }] }).success).toBe(false);
  });
});
