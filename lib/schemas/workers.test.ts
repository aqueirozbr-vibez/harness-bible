import { describe, expect, it } from "vitest";

import { EMBED_QUERY_MAX_CHARACTERS, EmbeddedQuerySchema, EmbedQueryBodySchema, GatewayCheckAnswerSchema, HealthSchema, KeyEnsuredSchema, KeyRotatedSchema, PrincipalBodySchema, ROUTE_ANSWERS, ROUTE_BODIES, WORKERS_ROUTES, WorkersErrorSchema, WorkersRouteSchema } from "./workers";
import { EMBED_MODEL_ID } from "@/lib/gateway/prices";

describe("workers schemas (feature-specs/11 § 7.2)", () => {
  it("fixes the six routes of Phase 2's surface so far, each with its body and answer schema", () => {
    expect(WORKERS_ROUTES).toEqual(["/health", "/keys/ensure", "/keys/rotate", "/gateway/check", "/embed/query", "/answer"]);
    expect(WorkersRouteSchema.safeParse("/answer").success).toBe(true);
    expect(WorkersRouteSchema.safeParse("/nothing").success).toBe(false);
    expect(ROUTE_BODIES["/health"]).toBeNull();
    for (const route of ["/keys/ensure", "/keys/rotate", "/gateway/check"] as const) expect(ROUTE_BODIES[route]).toBe(PrincipalBodySchema);
    expect(ROUTE_BODIES["/embed/query"]).toBe(EmbedQueryBodySchema);
    expect(Object.keys(ROUTE_ANSWERS).sort()).toEqual([...WORKERS_ROUTES].sort());
  });

  it("takes a body as exactly one principal and nothing else", () => {
    expect(PrincipalBodySchema.safeParse({ principal: { organisationId: "org-1" } }).success).toBe(true);
    expect(PrincipalBodySchema.safeParse({ principal: { userId: "u-1" } }).success).toBe(true);
    expect(PrincipalBodySchema.safeParse({ principal: { organisationId: "org-1" }, token: "x" }).success).toBe(false);
    expect(PrincipalBodySchema.safeParse({}).success).toBe(false);
  });

  it("answers health with the gateway's state and a key count, and the key routes with the id and an instant", () => {
    expect(HealthSchema.safeParse({ ok: true, gateway: "up", keys: 2, temporal: "up" }).success).toBe(true);
    expect(HealthSchema.safeParse({ ok: true, gateway: "unknown", keys: 2, temporal: "up" }).success).toBe(false);
    /* The workflow engine (feature-specs/28 § 4.5): up, down, or off when none is configured; never absent. */
    for (const temporal of ["up", "down", "off"]) expect(HealthSchema.safeParse({ ok: true, gateway: "up", keys: 2, temporal }).success, temporal).toBe(true);
    expect(HealthSchema.safeParse({ ok: true, gateway: "up", keys: 2, temporal: "starting" }).success).toBe(false);
    expect(HealthSchema.safeParse({ ok: true, gateway: "up", keys: 2 }).success).toBe(false);
    expect(HealthSchema.safeParse({ ok: true, gateway: "down", keys: -1 }).success).toBe(false);
    expect(KeyEnsuredSchema.safeParse({ litellmKeyId: "abc", createdAt: "2026-09-23T12:00:00.000Z" }).success).toBe(true);
    expect(KeyEnsuredSchema.safeParse({ litellmKeyId: "abc", createdAt: "2026-09-23" }).success).toBe(false);
    expect(KeyRotatedSchema.safeParse({ litellmKeyId: "abc", rotatedAt: null }).success).toBe(true);
    expect(KeyRotatedSchema.safeParse({ litellmKeyId: "abc", rotatedAt: "2026-09-23T12:00:00.000Z", key: "sk-1" }).success).toBe(false);
  });

  it("takes a query to embed as a principal and text within the composer's cap, and answers with one vector of the column's width", () => {
    const principal = { organisationId: "org-1" };
    expect(EmbedQueryBodySchema.safeParse({ principal, text: "idempotency keys" }).success).toBe(true);
    expect(EmbedQueryBodySchema.safeParse({ principal, text: "" }).success).toBe(false);
    expect(EmbedQueryBodySchema.safeParse({ principal, text: "x".repeat(EMBED_QUERY_MAX_CHARACTERS) }).success).toBe(true);
    expect(EmbedQueryBodySchema.safeParse({ principal, text: "x".repeat(EMBED_QUERY_MAX_CHARACTERS + 1) }).success).toBe(false);
    expect(EmbedQueryBodySchema.safeParse({ principal, text: "q", releaseId: "2026.09" }).success).toBe(false);
    const embedding = Array.from({ length: 1024 }, () => 0.01);
    expect(EmbeddedQuerySchema.safeParse({ embedding, modelId: EMBED_MODEL_ID, ms: 42 }).success).toBe(true);
    expect(EmbeddedQuerySchema.safeParse({ embedding: embedding.slice(1), modelId: EMBED_MODEL_ID, ms: 42 }).success).toBe(false);
    expect(EmbeddedQuerySchema.safeParse({ embedding, modelId: EMBED_MODEL_ID, ms: 1.5 }).success).toBe(false);
  });

  it("answers the check with the pinned id and the four counts, and an error with the handler's body", () => {
    const usage = { input_tokens: 4, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    expect(GatewayCheckAnswerSchema.safeParse({ model: "claude-haiku-4-5", usage }).success).toBe(true);
    expect(GatewayCheckAnswerSchema.safeParse({ model: "claude-haiku-4-5", usage: { ...usage, cache_read_input_tokens: null } }).success).toBe(false);
    expect(WorkersErrorSchema.safeParse({ code: "GATEWAY_BUDGET", message: "…", traceId: "a".repeat(32) }).success).toBe(true);
    expect(WorkersErrorSchema.safeParse({ code: "GATEWAY_BUDGET", message: "…", traceId: "nope" }).success).toBe(false);
  });
});
