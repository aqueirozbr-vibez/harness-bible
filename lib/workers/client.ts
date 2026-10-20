import { newSpanId, traceparent } from "@/lib/api/trace";
import { currentSpanId } from "@/lib/telemetry/spans";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { ROUTE_ANSWERS, WorkersErrorSchema, type JsonRoute, type RouteAnswer, type RouteBody, type StreamRoute, type WorkersRoute } from "@/lib/schemas/workers";

/*
 * The web tier's side of the private channel (feature-specs/11 § 7.2, § 7.3, § 9): `workersFetch` adds the
 * bearer and the `traceparent`, times out per route, validates the answer with the route's schema, and maps a
 * connection failure to `WorkersUnavailableError` (503 for the caller). It forwards typed bodies only, never a
 * header or an environment value, and never sees a key. No `WORKERS_URL` or no `WORKERS_TOKEN` is the same
 * error before any request: fail closed (invariant 23).
 */

export type WorkersUnavailableCause = "unconfigured" | "connection" | "timeout" | "malformed";

/** The workers could not be reached, did not answer in time, or answered something that is not their protocol. */
export class WorkersUnavailableError extends AppError {
  override readonly cause: WorkersUnavailableCause;

  constructor(cause: WorkersUnavailableCause, message: string) {
    super("WORKERS_UNAVAILABLE", message);
    this.name = "WorkersUnavailableError";
    this.cause = cause;
  }
}

/** The workers answered with an error body: its code is kept, so the caller maps it as the workers meant it (a budget, an unknown principal). */
export class WorkersRefusedError extends AppError {
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(code, message);
    this.name = "WorkersRefusedError";
    this.status = status;
  }
}

/**
 * The deadline of each route in milliseconds, or null for none. Spec § 7.2 says the client times out per route,
 * and § 12.5 requires `WorkersUnavailableError` within that timeout, so every route has one: without it a hung
 * workers process holds a web request until undici's 300 s header timeout. The four values are Andre's
 * (2026-09-24), with the derivation he approved beside each:
 *   `/health`         5 s  — a liveness check, refreshed every 30 s (`workers/health.ts`).
 *   `/keys/ensure`   10 s  — one or two gateway management calls, no model call.
 *   `/keys/rotate`   10 s  — the same two calls, mint then delete.
 *   `/gateway/check` 20 s  — the scope classifier's own 5 s timeout (`lib/gateway/policy.ts`) across its attempts,
 *                            plus a margin: three when Andre gave the number, two since unit 37b gave that row one
 *                            retry, so the 20 s keeps a wider margin over its 10 s worst case.
 * `/embed/query` is spec 12 § 6, D6: a quarter of the search page's 500 ms budget, after which the page
 * runs the lexical statement alone.
 */
/**
 * The `/answer` route's deadline: the longest a turn can still be running (the comment at its entry below says how
 * it is derived). Named because the retention purge reads it too: a question still alone after this was abandoned.
 */
export const ANSWER_DEADLINE_MS = 450_000;

export const ROUTE_TIMEOUT_MS: Readonly<Record<WorkersRoute, number | null>> = {
  "/health": 5_000,
  "/keys/ensure": 10_000,
  "/keys/rotate": 10_000,
  "/gateway/check": 20_000,
  /* One turn is several model calls: the draft, at most one repair, and the grader, each with the SDK's retries
     (feature-specs/11 § 5.3). 450 s is their worst case summed — a bound on a hung worker, not a target, and the
     reader sees the answer stream long before it. Derived from the policy table, as the four above are. */
  "/answer": ANSWER_DEADLINE_MS,
  "/embed/query": 150,
};

export interface WorkersClientDeps {
  readonly baseUrl: string | undefined;
  readonly token: string | undefined;
  readonly fetch: typeof fetch;
  readonly timeouts: Readonly<Record<WorkersRoute, number | null>>;
}

export function defaultWorkersDeps(): WorkersClientDeps {
  return { baseUrl: env.WORKERS_URL, token: env.WORKERS_TOKEN, fetch: globalThis.fetch, timeouts: ROUTE_TIMEOUT_MS };
}

export interface WorkersFetchOptions {
  readonly traceId: string;
}

function unavailableOf(error: unknown, route: WorkersRoute): WorkersUnavailableError {
  if (error instanceof DOMException && error.name === "TimeoutError") return new WorkersUnavailableError("timeout", `${route}: the workers did not answer in time`);
  return new WorkersUnavailableError("connection", `${route}: ${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)}`);
}

export async function workersFetch<R extends JsonRoute>(route: R, body: RouteBody<R>, options: WorkersFetchOptions, deps: WorkersClientDeps = defaultWorkersDeps()): Promise<RouteAnswer<R>> {
  if (deps.baseUrl === undefined) throw new WorkersUnavailableError("unconfigured", "WORKERS_URL is not set: the workers cannot be reached (feature-specs/11 § 8).");
  if (deps.token === undefined) throw new WorkersUnavailableError("unconfigured", "WORKERS_TOKEN is not set: every request to the workers carries it (feature-specs/11 § 7.1).");
  const timeout = deps.timeouts[route];
  const headers: Record<string, string> = { authorization: `Bearer ${deps.token}`, traceparent: traceparent(options.traceId, currentSpanId(options.traceId) ?? newSpanId()), accept: "application/json" };
  if (body !== null) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await deps.fetch(`${deps.baseUrl}${route}`, {
      method: body === null ? "GET" : "POST",
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      ...(timeout === null ? {} : { signal: AbortSignal.timeout(timeout) }),
    });
  } catch (error: unknown) {
    throw unavailableOf(error, route);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new WorkersUnavailableError("malformed", `${route}: the workers answered ${response.status} without JSON`);
  }
  if (response.status !== 200) {
    const refusal = WorkersErrorSchema.safeParse(json);
    if (!refusal.success) throw new WorkersUnavailableError("malformed", `${route}: the workers answered ${response.status} without an error body`);
    throw new WorkersRefusedError(response.status, refusal.data.code, refusal.data.message);
  }
  const parsed = ROUTE_ANSWERS[route].safeParse(json);
  if (!parsed.success) throw new WorkersUnavailableError("malformed", `${route}: the answer is not the route's shape (${parsed.error.issues.map((issue) => issue.path.join(".") || "body").join(", ")})`);
  return parsed.data as RouteAnswer<R>;
}

/**
 * The one route whose answer is a stream (feature-specs/15 § 6.2): this opens it and hands the caller the body's
 * lines. A failure to open it is the same three errors as every other route, which is why the web tier can still
 * answer 503 or 402 with a status code — nothing has been written to the reader yet. Once the lines flow, a
 * failure is theirs to carry: the workers write an `error` line and the route forwards it.
 */
export async function workersStream(
  route: StreamRoute,
  body: RouteBody<StreamRoute>,
  options: WorkersFetchOptions,
  deps: WorkersClientDeps = defaultWorkersDeps(),
): Promise<ReadableStream<Uint8Array>> {
  if (deps.baseUrl === undefined) throw new WorkersUnavailableError("unconfigured", "WORKERS_URL is not set: the workers cannot be reached (feature-specs/11 § 8).");
  if (deps.token === undefined) throw new WorkersUnavailableError("unconfigured", "WORKERS_TOKEN is not set: every request to the workers carries it (feature-specs/11 § 7.1).");
  const timeout = deps.timeouts[route];
  let response: Response;
  try {
    response = await deps.fetch(`${deps.baseUrl}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.token}`,
        traceparent: traceparent(options.traceId, currentSpanId(options.traceId) ?? newSpanId()),
        accept: "application/x-ndjson",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(timeout === null ? {} : { signal: AbortSignal.timeout(timeout) }),
    });
  } catch (error: unknown) {
    throw unavailableOf(error, route);
  }

  if (response.status !== 200) {
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new WorkersUnavailableError("malformed", `${route}: the workers answered ${String(response.status)} without JSON`);
    }
    const refusal = WorkersErrorSchema.safeParse(json);
    if (!refusal.success) throw new WorkersUnavailableError("malformed", `${route}: the workers answered ${String(response.status)} without an error body`);
    throw new WorkersRefusedError(response.status, refusal.data.code, refusal.data.message);
  }
  if (response.body === null) throw new WorkersUnavailableError("malformed", `${route}: the workers answered 200 without a body`);
  return response.body;
}
