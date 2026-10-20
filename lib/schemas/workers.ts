import { z } from "zod";

import { EMBEDDING_DIMENSIONS, PrincipalSchema } from "@/lib/schemas/gateway";

/*
 * The workers' private surface (feature-specs/11 § 7.2, § 9): the bodies the web tier forwards and the answers
 * the workers return, validated at both ends. `/embed/query` is spec 12 § 4.3's row and spec 15 adds `/answer`;
 * each row is one route with its body and its answer. The error body is the handler's (§ 2: the channel reuses the trace id and
 * the error catalogue).
 */

export const WORKERS_ROUTES = ["/health", "/keys/ensure", "/keys/rotate", "/gateway/check", "/embed/query", "/answer"] as const;
export const WorkersRouteSchema = z.enum(WORKERS_ROUTES);
export type WorkersRoute = z.infer<typeof WorkersRouteSchema>;

/** The one route that answers a stream of lines; every other answers one object (feature-specs/15 § 6.2). */
export const STREAM_ROUTES = ["/answer"] as const;
export type StreamRoute = (typeof STREAM_ROUTES)[number];
export type JsonRoute = Exclude<WorkersRoute, StreamRoute>;

export const PrincipalBodySchema = z.strictObject({ principal: PrincipalSchema });
export type PrincipalBody = z.infer<typeof PrincipalBodySchema>;

export const GatewayStateSchema = z.enum(["up", "down"]);
export type GatewayState = z.infer<typeof GatewayStateSchema>;

/** The workflow engine as the workers see it (feature-specs/28 § 4.5): `off` when no engine is configured. */
export const EngineStateSchema = z.enum(["up", "down", "off"]);
export type EngineState = z.infer<typeof EngineStateSchema>;

/**
 * `gateway` is the cached liveliness probe, never a model call; `keys` the GatewayKey rows the workers can open;
 * `temporal` the cached probe of the workflow engine and its namespace.
 */
export const HealthSchema = z.strictObject({ ok: z.boolean(), gateway: GatewayStateSchema, keys: z.int().nonnegative(), temporal: EngineStateSchema });
export type Health = z.infer<typeof HealthSchema>;

export const KeyEnsuredSchema = z.strictObject({ litellmKeyId: z.string().min(1), createdAt: z.iso.datetime({ precision: 3 }) });
export type KeyEnsured = z.infer<typeof KeyEnsuredSchema>;

/** `rotatedAt` is null when the principal had no key and the rotation minted its first one (workers/keys.ts). */
export const KeyRotatedSchema = z.strictObject({ litellmKeyId: z.string().min(1), rotatedAt: z.iso.datetime({ precision: 3 }).nullable() });
export type KeyRotated = z.infer<typeof KeyRotatedSchema>;

export const UsageSchema = z.strictObject({
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  cache_creation_input_tokens: z.int().nonnegative(),
  cache_read_input_tokens: z.int().nonnegative(),
});

/** The usage block of the smoke test (§ 3.6): the pinned id the gateway reported and the four counts. */
export const GatewayCheckAnswerSchema = z.strictObject({ model: z.string().min(1), usage: UsageSchema });
export type GatewayCheckAnswer = z.infer<typeof GatewayCheckAnswerSchema>;

/** The longest text the route embeds: the composer's cap (feature-specs/12 § 7.2), which the search query (200) is well inside. */
export const EMBED_QUERY_MAX_CHARACTERS = 800;

export const EmbedQueryBodySchema = z.strictObject({ text: z.string().min(1).max(EMBED_QUERY_MAX_CHARACTERS), principal: PrincipalSchema });
export type EmbedQueryBody = z.infer<typeof EmbedQueryBodySchema>;

/** One vector of the column's width, the id the gateway reported, and the call's own time (feature-specs/12 § 4.3). */
export const EmbeddedQuerySchema = z.strictObject({
  embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS).readonly(),
  modelId: z.string().min(1),
  ms: z.int().nonnegative(),
});
export type EmbeddedQueryAnswer = z.infer<typeof EmbeddedQuerySchema>;

export const WorkersErrorSchema = z.object({ code: z.string().min(1), message: z.string(), traceId: z.string().regex(/^[0-9a-f]{32}$/) });
export type WorkersError = z.infer<typeof WorkersErrorSchema>;

/** Body and answer per route; `null` is a GET. */
/**
 * One turn of the assistant (feature-specs/15 § 6.2). Unlike every other route this one answers a **stream** of
 * JSON lines rather than one object, because the reader watches the answer arrive; the web tier translates each
 * line into a server-sent event. The body is what the web tier validated, plus the reader it validated it for.
 */
export const AnswerBodySchema = z.strictObject({
  conversationId: z.uuid(),
  user: z.strictObject({ id: z.string().min(1), organisationId: z.string().nullable(), role: z.string(), displayName: z.string(), locale: z.string() }),
  principal: PrincipalSchema,
  text: z.string().min(1).max(800),
  mode: z.enum(["explain", "compare", "walk", "lab", "brief"]),
  /** What the mode picked (feature-specs/23 § 5.1): the workers resolve a walk's and a lab's chapter themselves. */
  context: z
    .strictObject({
      chapters: z.tuple([z.number().int(), z.number().int()]).optional(),
      labId: z.string().optional(),
    })
    .nullable(),
  /** walk mode (feature-specs/18 § 6): the aid and the inputs the web tier already validated against its ranges; null otherwise. */
  aid: z.strictObject({ id: z.string().min(1), inputs: z.record(z.string(), z.number()) }).nullable().default(null),
});
export type AnswerBody = z.infer<typeof AnswerBodySchema>;

export interface WorkersRoutes {
  readonly "/health": { readonly body: null; readonly answer: Health };
  readonly "/keys/ensure": { readonly body: PrincipalBody; readonly answer: KeyEnsured };
  readonly "/keys/rotate": { readonly body: PrincipalBody; readonly answer: KeyRotated };
  readonly "/gateway/check": { readonly body: PrincipalBody; readonly answer: GatewayCheckAnswer };
  readonly "/embed/query": { readonly body: EmbedQueryBody; readonly answer: EmbeddedQueryAnswer };
  /** Answers a stream, not an object: `RouteAnswer` is `never` and the server writes the lines itself. */
  readonly "/answer": { readonly body: AnswerBody; readonly answer: never };
}

export type RouteBody<R extends WorkersRoute> = WorkersRoutes[R]["body"];
export type RouteAnswer<R extends WorkersRoute> = WorkersRoutes[R]["answer"];

export const ROUTE_BODIES: { readonly [R in WorkersRoute]: z.ZodType<RouteBody<R>> | null } = {
  "/health": null,
  "/keys/ensure": PrincipalBodySchema,
  "/keys/rotate": PrincipalBodySchema,
  "/gateway/check": PrincipalBodySchema,
  "/embed/query": EmbedQueryBodySchema,
  "/answer": AnswerBodySchema,
};

export const ROUTE_ANSWERS: { readonly [R in WorkersRoute]: z.ZodType<RouteAnswer<R>> } = {
  "/health": HealthSchema,
  "/keys/ensure": KeyEnsuredSchema,
  "/keys/rotate": KeyRotatedSchema,
  "/gateway/check": GatewayCheckAnswerSchema,
  "/embed/query": EmbeddedQuerySchema,
  /* The stream has no one answer to validate: the server writes its lines and the web tier translates them. */
  "/answer": z.never(),
};

/**
 * One line of `/answer`'s stream (feature-specs/15 § 6.1). The web tier validates each line before it becomes a
 * server-sent event, so a malformed line ends the stream rather than reaching a reader's browser as content; the
 * data of each event keeps the shape the flow gave it, because the web tier forwards and never composes.
 */
export const TURN_EVENTS = ["meta", "status", "token", "final", "error"] as const;
export const TurnEventSchema = z.strictObject({ event: z.enum(TURN_EVENTS), data: z.record(z.string(), z.unknown()) });
export type TurnEventLine = z.infer<typeof TurnEventSchema>;
