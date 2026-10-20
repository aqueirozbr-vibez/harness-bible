import "dotenv/config";

import { writeFileSync } from "node:fs";

import { z } from "zod";

import { ALL_ENDPOINTS } from "@/lib/api/endpoints";
import { STATUS_OF } from "@/lib/api/errors";
import { ErrorBodySchema } from "@/lib/schemas/api";

/*
 * Generates `openapi.json` from the endpoint specs (code-standards § API
 * Routes: the document is generated from the schemas). `npm run api:openapi`.
 */

type Json = Record<string, unknown>;

function jsonSchema(schema: z.ZodType): Json {
  return z.toJSONSchema(schema, { unrepresentable: "any", io: "output", reused: "inline" }) as Json;
}

function pathParams(path: string): ReadonlyArray<string> {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

const errorSchema = jsonSchema(ErrorBodySchema);
const paths: Record<string, Json> = {};

for (const spec of ALL_ENDPOINTS) {
  const method = spec.method.toLowerCase();
  const parameters: Json[] = pathParams(spec.path).map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
  if (spec.query !== undefined) {
    const q = jsonSchema(spec.query);
    const props = (q.properties ?? {}) as Record<string, Json>;
    const required = new Set((q.required ?? []) as string[]);
    for (const [name, schema] of Object.entries(props)) parameters.push({ name, in: "query", required: required.has(name), schema });
  }
  const isRaw = spec.response instanceof z.ZodNever;
  /* A stream is described by its media type and its events, because its body is not one document (15 § 7, D6); a body
     of bytes (32 § 5) by its media type alone. */
  const events = spec.events as Readonly<Record<string, z.ZodType>> | undefined;
  const raw = spec.raw as { request?: string; response?: string } | undefined;
  const responses: Record<string, Json> = isRaw
    ? { "302": { description: "Redirect; cookies travel as Set-Cookie headers." }, "200": { description: "Empty body." } }
    : raw?.response !== undefined
      ? { "200": { description: "The object's bytes, with its Content-Type.", content: { [raw.response]: { schema: { type: "string", format: "binary" } } } } }
      : events === undefined
        ? { "200": { description: "OK", content: { "application/json": { schema: jsonSchema(spec.response) } } } }
        : { "200": { description: "OK", content: { "text/event-stream": { schema: { type: "string" } } } } };
  for (const code of ["INVALID_INPUT", "NO_SESSION", "FORBIDDEN", "NOT_FOUND", "RATE_LIMITED", "INTERNAL"]) {
    const status = String(STATUS_OF[code]);
    responses[status] ??= { description: code, content: { "application/json": { schema: errorSchema } } };
  }
  const operation: Json = {
    summary: spec.summary,
    operationId: `${method}${spec.path.replace(/[^a-zA-Z0-9]+/g, "_")}`,
    security: spec.auth === "public" ? [] : spec.auth === "bearer" ? [{ bearer: [] }] : spec.auth === "session-or-bearer" ? [{ cookie: [] }, { bearer: [] }] : [{ cookie: [] }],
    "x-rate-limit": spec.rateLimit ?? null,
    "x-policy": { action: spec.policy.action },
    "x-idempotent": spec.idempotent === true || spec.idempotent === "endpoint" || spec.method === "PUT" || spec.method === "DELETE",
    ...(events === undefined ? {} : { "x-sse-events": Object.fromEntries(Object.entries(events).map(([name, schema]) => [name, jsonSchema(schema)])) }),
    parameters,
    responses,
    ...(spec.body !== undefined
      ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(spec.body) } } } }
      : raw?.request !== undefined
        ? { requestBody: { required: true, content: { [raw.request]: { schema: { type: "string", format: "binary" } } } } }
        : {}),
  };
  const key = spec.path;
  paths[key] = { ...(paths[key] ?? {}), [method]: operation };
}

const document = {
  openapi: "3.1.0",
  info: { title: "The Harness Bible API", version: "1.0.0", description: "Phase 1 endpoints (feature-specs/09 § 6.2). Every response carries `traceparent`; errors are `{ code, message, detail?, traceId }`; rate-limited endpoints carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`." },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: { cookie: { type: "apiKey", in: "cookie", name: "hb.session" }, bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: { ErrorBody: errorSchema },
  },
  paths,
};

writeFileSync("openapi.json", `${JSON.stringify(document, null, 2)}\n`);
console.log(`openapi.json: ${Object.keys(paths).length} paths, ${ALL_ENDPOINTS.length} operations`);
