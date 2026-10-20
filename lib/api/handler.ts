import type { ZodType } from "zod";

import { ApiError, toApiError } from "@/lib/api/errors";
import { abandonIdempotent, beginIdempotent, bodyHashOf, completeIdempotent, type IdempotencyStart } from "@/lib/api/idempotency";
import { clientIp, rateKeyForIp } from "@/lib/api/ip";
import { MAX_BODY_BYTES } from "@/lib/api/limits";
import { logSpan, type SpanLogger } from "@/lib/api/log";
import { errorMessage, localeOfRequest } from "@/lib/api/messages";
import { consumeToken, type RateLimitResult } from "@/lib/api/ratelimit";
import { newSpanId, parseTraceparent, traceIdOf, traceparent } from "@/lib/api/trace";
import { userFromBearer } from "@/lib/auth/bearer";
import { OAUTH_COOKIE, SESSION_COOKIE } from "@/lib/auth/cookies";
import { sameOrigin } from "@/lib/auth/request";
import { sessionFromToken, tenantOf, type SessionUser } from "@/lib/auth/session";
import { recordAuthEvent } from "@/lib/db/audit";
import { withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { Locale } from "@/lib/i18n/routing";
import { subjectOf, type PolicyAction, type PolicyResource } from "@/lib/policy/input";
import { authorize as authorizeWithOpa, type Decision } from "@/lib/policy/opa";
import type { Role } from "@/lib/schemas/auth";
import { withSpanScope } from "@/lib/telemetry/spans";

/*
 * The one handler pipeline (code-standards § API Routes; feature-specs/09 § 7).
 * Order, none skippable: trace → parse → session → origin → rate limit →
 * idempotency → policy → endpoint → serialise → span. The factory has no
 * opt-out flags; `deps` exists for tests.
 */

export type AuthMode = "public" | "session" | "bearer" | "session-or-bearer";
export type Query = Readonly<Record<string, string | ReadonlyArray<string>>>;
export type RouteParams = Readonly<Record<string, string | ReadonlyArray<string>>>;

/**
 * The claim on this request's `Idempotency-Key`, handed to an endpoint whose response body the pipeline cannot
 * see: a stream is written after the handler has returned, so the endpoint stores its own outcome and answers a
 * replay in its own medium (feature-specs/15 § 5.3, D1). Only `idempotent: "endpoint"` endpoints receive one.
 */
export interface IdempotencyClaim {
  /** The stored outcome of an earlier request with the same key, or `null` when this request is the first. */
  readonly replay: { readonly status: number; readonly body: unknown } | null;
  readonly complete: (status: number, body: unknown) => Promise<void>;
}

export interface RunInput<P, Q, B> {
  readonly params: P;
  readonly query: Q;
  readonly body: B;
  readonly session: SessionUser | null;
  readonly traceId: string;
  readonly locale: Locale;
  readonly request: Request;
  readonly idempotency: IdempotencyClaim | null;
}

/** `R` is the response schema's output, `RIn` its input: the endpoint returns the input, the pipeline parses it. */
export interface EndpointSpec<P, Q, B, R, RIn = R> {
  /** Route template for the OpenAPI document and the rate-limit bucket, e.g. `/api/v1/bookmarks/{sectionId}`. */
  readonly path: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly summary: string;
  readonly auth: AuthMode;
  /** Minimum role: a cheap gate before the policy. */
  readonly role?: Role;
  readonly params?: ZodType<P, unknown>;
  readonly query?: ZodType<Q, unknown>;
  readonly body?: ZodType<B, unknown>;
  readonly response: ZodType<R, RIn>;
  /** `bucket` names the bucket where a path's methods take different rates; the path names it otherwise (feature-specs/45 D7; review of unit 62). */
  readonly rateLimit?: { readonly key: "ip" | "user"; readonly limit: number; readonly windowS: number; readonly bucket?: string };
  /** `"endpoint"` when the response body is a stream: the pipeline claims the key and the endpoint stores the outcome. */
  readonly idempotent?: boolean | "endpoint";
  readonly policy: { readonly action: PolicyAction; readonly resource: (input: { params: P; query: Q; body: B; session: SessionUser | null }) => PolicyResource | Promise<PolicyResource> };
  /** `public` responses may be revalidated by intermediaries; everything else is `no-store`. */
  readonly cache?: "public" | "private";
  /**
   * The events this endpoint's response body carries, when that body is a stream: the document describes it as
   * `text/event-stream` and lists the event data schemas under `x-sse-events` (feature-specs/15 § 7, D6). The
   * pipeline does not read this — it passes a `Response` through untouched — the generated document does.
   */
  readonly events?: Readonly<Record<string, ZodType>>;
  /**
   * Bytes rather than JSON, for the document (feature-specs/32 § 5, the storage routes): `request` names the media
   * type of a body the endpoint reads itself from `request.body` — the pipeline reads no body when `body` is unset —
   * and `response` the type of a body it answers as a `Response`. The pipeline does not read this either.
   */
  readonly raw?: { readonly request?: string; readonly response?: string };
  /**
   * The path carries a credential, a signed URL's token (feature-specs/32 § 15): the request's line, its span and the
   * policy's context name the endpoint's template, never the path as asked, which the secret guard would redact and
   * page on (unit 51d's review).
   */
  readonly credentialInPath?: true;
  /**
   * A GET that writes: an export appends its own `EXPORT` record (feature-specs/17 § 6, 35 § 5). The origin check holds
   * it as it holds a mutation (09 § 8.3), so no other site can have a signed-in person's browser fetch it, and a HEAD —
   * which Next answers with the GET's handler — is refused rather than recording a file nobody receives (the 52c review).
   */
  readonly writes?: true;
  readonly run: (input: RunInput<P, Q, B>) => Promise<RIn | Response>;
}

/** Shorthand: the spec type of a schema quartet, with the response's input type for `run`. */
export type Spec<PS extends ZodType | undefined, QS extends ZodType | undefined, BS extends ZodType | undefined, RS extends ZodType> = EndpointSpec<
  PS extends ZodType ? PS["_output"] : undefined,
  QS extends ZodType ? QS["_output"] : undefined,
  BS extends ZodType ? BS["_output"] : undefined,
  RS["_output"],
  RS["_input"]
>;

export interface HandlerDeps {
  readonly sessionFromRequest: (request: Request, mode: AuthMode) => Promise<SessionUser | null>;
  readonly authorize: (subject: ReturnType<typeof subjectOf>, action: PolicyAction, resource: PolicyResource, context: { traceId: string; method: string; path: string }) => Promise<Decision>;
  readonly consume: (key: string, limit: number, windowS: number) => Promise<RateLimitResult>;
  readonly idempotency: {
    readonly begin: (user: SessionUser, path: string, key: string, bodyHash: string) => Promise<IdempotencyStart>;
    readonly complete: (user: SessionUser, path: string, key: string, status: number, body: unknown) => Promise<void>;
    readonly abandon: (user: SessionUser, path: string, key: string) => Promise<void>;
  };
  readonly audit: typeof recordAuthEvent;
  readonly log: SpanLogger;
}

const METHODS_WITH_BODY: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);
const MUTATIONS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLE_RANK: Readonly<Record<Role, ReadonlyArray<Role>>> = {
  READER: ["READER"],
  BUILDER: ["READER", "BUILDER"],
  CONTRIBUTOR: ["READER", "BUILDER", "CONTRIBUTOR"],
  CURATOR: ["READER", "BUILDER", "CONTRIBUTOR", "CURATOR"],
  ORG_ADMIN: ["READER", "ORG_ADMIN"],
};

/** The session cookie value from the request's own `Cookie` header (route handlers, tests). */
export function sessionTokenFromCookieHeader(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE || name === "hb.session" || name === "__Host-hb.session") return rest.join("=") || null;
  }
  return null;
}

async function defaultSession(request: Request, mode: AuthMode): Promise<SessionUser | null> {
  if (mode === "bearer") return userFromBearer(request.headers.get("authorization"));
  const fromCookie = await sessionFromToken(sessionTokenFromCookieHeader(request.headers.get("cookie")));
  if (fromCookie !== null || mode !== "session-or-bearer") return fromCookie;
  return userFromBearer(request.headers.get("authorization"));
}

export const defaultDeps: HandlerDeps = {
  sessionFromRequest: defaultSession,
  authorize: (subject, action, resource, context) => authorizeWithOpa(subject, action, resource, context),
  consume: consumeToken,
  idempotency: { begin: beginIdempotent, complete: completeIdempotent, abandon: abandonIdempotent },
  audit: recordAuthEvent,
  log: logSpan,
};

function queryOf(url: URL): Query {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const current = out[key];
    if (current === undefined) out[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else out[key] = [current, value];
  }
  return out;
}

async function readBody(request: Request): Promise<{ raw: string; json: unknown }> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE", "the body is over 64 KB");
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new ApiError("UNSUPPORTED_MEDIA", "send application/json");
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE", "the body is over 64 KB");
  if (raw.length === 0) return { raw, json: undefined };
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    throw new ApiError("INVALID_INPUT", "the body is not valid JSON", { path: [] });
  }
}

function parseWith<T>(schema: ZodType<T, unknown> | undefined, value: unknown, where: "params" | "query" | "body"): T {
  if (schema === undefined) return undefined as T;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ApiError("INVALID_INPUT", `${where}: ${issue?.message ?? "invalid"}`, { in: where, path: issue?.path.map(String) ?? [], issues: result.error.issues.slice(0, 5).map((i) => ({ path: i.path.map(String), message: i.message })) });
}

function hasRole(user: SessionUser, role: Role): boolean {
  return ROLE_RANK[user.role].includes(role);
}

/** Builds the route handler Next exports as `GET`, `POST`, … */
export function handler<P, Q, B, R, RIn>(spec: EndpointSpec<P, Q, B, R, RIn>, deps: HandlerDeps = defaultDeps) {
  return async (request: Request, context?: { params?: Promise<RouteParams> | RouteParams }): Promise<Response> => {
    const started = performance.now();
    const traceId = traceIdOf(request);
    const spanId = newSpanId();
    /* The caller's span, when it sent one: the request's line names it, so a trace joins across processes (21 § 5.1). */
    const parentId = parseTraceparent(request.headers.get("traceparent"))?.parentId;
    const url = new URL(request.url);
    /* What the line, the span and the policy's context call the path: the template where the path is a credential. */
    const logged = spec.credentialInPath === true ? spec.path : url.pathname;
    const locale = localeOfRequest(request);
    const headers = new Headers({ "content-type": "application/json; charset=utf-8", traceparent: traceparent(traceId, spanId), "cache-control": spec.cache === "public" ? "private, max-age=0, must-revalidate" : "no-store" });
    let subjectId: string | null = null;
    let policy: "allow" | "deny" | "skipped" = "skipped";
    let session: SessionUser | null = null;
    let claimed: { user: SessionUser; key: string } | null = null;
    let replay: { status: number; body: unknown } | null = null;

    const finish = (status: number, body: unknown, code?: string): Response => {
      deps.log({ traceId, spanId, ...(parentId === undefined ? {} : { parentId }), method: request.method, path: logged, status, ms: Math.round(performance.now() - started), subject: subjectId, policy, code });
      return new Response(body === null ? null : JSON.stringify(body), { status, headers });
    };
    const fail = (error: unknown): Response => {
      const api = toApiError(error);
      if (api.status >= 500) console.error("handler failed", traceId, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      return finish(api.status, { code: api.code, message: errorMessage(api.code, locale, api.message), ...(api.detail === undefined ? {} : { detail: api.detail }), traceId }, api.code);
    };

    try {
      /* 2 parse */
      const rawParams = context?.params === undefined ? {} : await context.params;
      const params = parseWith(spec.params, rawParams, "params");
      const query = parseWith(spec.query, queryOf(url), "query");
      const { raw, json } = METHODS_WITH_BODY.has(request.method) && spec.body !== undefined ? await readBody(request) : { raw: "", json: undefined };
      const body = parseWith(spec.body, json, "body");

      /* 3 session */
      session = await deps.sessionFromRequest(request, spec.auth);
      subjectId = session?.id ?? null;
      if (session === null && spec.auth !== "public") throw new ApiError("NO_SESSION", "sign in to use this endpoint");
      if (spec.role !== undefined && (session === null || !hasRole(session, spec.role))) throw new ApiError("ROLE_REQUIRED", `this needs the ${spec.role.toLowerCase()} role`);

      /* 4 origin, for cookie-authenticated mutations and reads that write; no HEAD for a read that writes */
      const viaCookie = session !== null && session.sessionId !== null;
      if (spec.writes === true && request.method === "HEAD") throw new ApiError("METHOD_NOT_ALLOWED", "this is a download: ask for it with GET");
      if (viaCookie && (MUTATIONS.has(request.method) || spec.writes === true) && !sameOrigin(request)) throw new ApiError("BAD_ORIGIN", "send this request from the site itself");

      /* 5 rate limit */
      if (spec.rateLimit !== undefined) {
        const scope = spec.rateLimit.key === "user" && session !== null ? `user:${session.id}` : `ip:${rateKeyForIp(clientIp(request))}`;
        const result = await deps.consume(`${scope}:${spec.rateLimit.bucket ?? spec.path}`, spec.rateLimit.limit, spec.rateLimit.windowS);
        headers.set("RateLimit-Limit", String(result.limit));
        headers.set("RateLimit-Remaining", String(result.remaining));
        headers.set("RateLimit-Reset", String(result.resetS));
        if (!result.allowed) {
          headers.set("Retry-After", String(result.retryAfterS));
          throw new ApiError("RATE_LIMITED", "too many requests; wait and retry");
        }
      }

      /* 6 idempotency */
      if (spec.idempotent !== undefined && spec.idempotent !== false && (request.method === "POST" || request.method === "PATCH")) {
        if (session === null) throw new ApiError("NO_SESSION", "sign in to use this endpoint");
        const key = request.headers.get("idempotency-key");
        if (key === null || !UUID.test(key)) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", "send an Idempotency-Key header holding a UUID");
        const start = await deps.idempotency.begin(session, spec.path, key, bodyHashOf(raw));
        if (start.kind === "replay") {
          headers.set("Idempotency-Replayed", "true");
          /* A streaming endpoint replays in its own medium: a JSON body here would answer an SSE request with
             something its client cannot read (feature-specs/15 § 5.3, D1). */
          if (spec.idempotent !== "endpoint") return finish(start.status, start.body);
          replay = { status: start.status, body: start.body };
        }
        if (start.kind === "in-flight") throw new ApiError("IN_PROGRESS", "the same request is still running");
        if (start.kind === "mismatch") throw new ApiError("IDEMPOTENCY_MISMATCH", "this key was used with a different body");
        if (start.kind === "new") claimed = { user: session, key };
      }

      /* 7 policy */
      const resource = await spec.policy.resource({ params, query, body, session });
      const decision = await deps.authorize(subjectOf(session), spec.policy.action, resource, { traceId, method: request.method, path: logged });
      policy = decision.allow ? "allow" : "deny";
      if (!decision.allow) {
        await deps.audit({ kind: "policy_denied", userId: session?.id ?? null, sessionId: session?.sessionId ?? null, detail: { action: spec.policy.action, resource: resource.kind, resourceId: resource.id, reason: decision.reason }, traceId, request });
        throw new ApiError("FORBIDDEN", "you cannot do this to that resource");
      }

      /* 8 endpoint */
      const claim: IdempotencyClaim | null =
        spec.idempotent !== "endpoint" || session === null
          ? null
          : { replay, complete: async (status, stored) => (claimed === null ? undefined : deps.idempotency.complete(claimed.user, spec.path, claimed.key, status, stored)) };
      const input: RunInput<P, Q, B> = { params, query, body, session, traceId, locale, request, idempotency: claim };
      /* The endpoint runs inside the request's span: what it records is this span's child, and the workers it calls are told whose child they are.
         `request` marks those children for the Langfuse road, which drops the request's own span (feature-specs/49 § 5.6). */
      const output = await withSpanScope({ traceId, spanId, request: true }, () => (session === null ? spec.run(input) : withTenant(tenantOf(session), () => spec.run(input))));

      /* 9 serialise */
      if (output instanceof Response) {
        /* A redirect's headers are immutable: rebuild the response with the pipeline's headers underneath the endpoint's own. */
        const merged = new Headers(headers);
        merged.delete("content-type");
        for (const [name, value] of output.headers) if (name !== "set-cookie") merged.set(name, value);
        for (const cookie of output.headers.getSetCookie()) merged.append("set-cookie", cookie);
        merged.set("traceparent", traceparent(traceId, spanId));
        deps.log({ traceId, spanId, ...(parentId === undefined ? {} : { parentId }), method: request.method, path: logged, status: output.status, ms: Math.round(performance.now() - started), subject: subjectId, policy });
        /* A stream's outcome is not known yet: its endpoint stores it from the stream itself (§ 5.3, D1). */
        if (claimed !== null && spec.idempotent !== "endpoint") await deps.idempotency.complete(claimed.user, spec.path, claimed.key, output.status, null);
        return new Response(output.body, { status: output.status, statusText: output.statusText, headers: merged });
      }
      const parsed = spec.response.safeParse(output);
      if (!parsed.success) throw new ApiError("INTERNAL", `response does not match its schema at ${parsed.error.issues[0]?.path.join(".") ?? "?"}`);
      if (claimed !== null) await deps.idempotency.complete(claimed.user, spec.path, claimed.key, 200, parsed.data);
      return finish(200, parsed.data);
    } catch (error) {
      if (claimed !== null) await deps.idempotency.abandon(claimed.user, spec.path, claimed.key).catch(() => undefined);
      return fail(error);
    }
  };
}

/** Which cookies this pipeline knows, for tests that build requests. */
export const KNOWN_COOKIES = { session: SESSION_COOKIE, oauth: OAUTH_COOKIE } as const;

export function isProductionLike(): boolean {
  return env.NODE_ENV === "production";
}
