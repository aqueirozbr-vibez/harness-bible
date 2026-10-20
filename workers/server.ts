import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { z } from "zod";

import { logSpan, type SpanLogger } from "@/lib/api/log";
import { newSpanId, newTraceId, parseTraceparent, traceparent } from "@/lib/api/trace";
import { AppError } from "@/lib/errors";
import type { GatewayDeps } from "@/lib/gateway/client";
import { ROUTE_BODIES, WorkersRouteSchema, type EngineState, type GatewayState, type RouteAnswer, type RouteBody, type WorkersRoute } from "@/lib/schemas/workers";
import { withSpanScope } from "@/lib/telemetry/spans";

import { gatewayCheck } from "./check";
import { embedQuery } from "./embed";
import { ensureKey, rotateKey, type KeyDeps } from "./keys";

/*
 * The workers' private HTTP surface (feature-specs/11 § 7.1, § 7.2, § 9): every request carries the shared
 * bearer `WORKERS_TOKEN` (D7) and a `traceparent`; every body is validated here as it was at the web tier;
 * every answer is JSON with the trace id, and an error is the handler's `{ code, message, traceId }`. The
 * routes: `GET /health`, `POST /keys/ensure`, `POST /keys/rotate`, `POST /gateway/check` and
 * `POST /embed/query` (spec 12 § 4.3); spec 15 adds its own. `startWorkers` is exported so the tests run the
 * surface in-process on a free port, as the stub is. Nothing here prints a key.
 */

export interface WorkersOptions {
  readonly token: string;
  readonly keys: KeyDeps;
  readonly gateway: GatewayDeps;
  /** The cached liveliness probe (workers/health.ts). */
  readonly probe: () => Promise<GatewayState>;
  /** The cached probe of the workflow engine (workers/health.ts `engineProbe`); absent = no engine, `off`. */
  readonly engine?: () => Promise<EngineState>;
  /** The GatewayKey rows the workers can open (lib/db/gateway.ts `countGatewayKeys`). */
  readonly keyCount: () => Promise<number>;
  /** One turn of the assistant, writing its rows and emitting the stream's events (feature-specs/15 § 6.3). */
  readonly answer: (body: RouteBody<"/answer">, emit: (event: unknown) => void, traceId: string) => Promise<void>;
  readonly host: string;
  /** 0 asks the operating system for a free port (tests). */
  readonly port: number;
  readonly log?: SpanLogger;
}

/** Every route that answers one JSON object; `/answer` answers a stream and is served on its own path. */
type JsonRoute = Exclude<WorkersRoute, "/answer">;

export interface RunningWorkers {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * The HTTP status of an error's code on this surface (spec § 5.2 for the gateway's three; the catalogue's
 * 400 and 404 for the rest). An unknown code is 500, its message withheld, as the handler does.
 */
export const WORKERS_STATUS_OF: Readonly<Record<string, number>> = {
  INVALID_INPUT: 400,
  WORKERS_UNAUTHORISED: 401,
  GATEWAY_BUDGET: 402,
  NOT_FOUND: 404,
  PRINCIPAL_UNKNOWN: 404,
  GATEWAY_UNAVAILABLE: 503,
  GATEWAY_KEYS_UNAVAILABLE: 503,
  GATEWAY_INDIVIDUAL_CAP_UNSET: 503,
  GATEWAY_REFUSED: 500,
};

class WorkersRefusal extends AppError {
  readonly status: number;

  constructor(code: string, message: string) {
    super(code, message);
    this.name = "WorkersRefusal";
    this.status = WORKERS_STATUS_OF[code] ?? 500;
  }
}

/** Every thrown value as a refusal: a catalogued code keeps its message; anything else is a 500 that says nothing of its cause. */
export function refusalOf(error: unknown): { readonly status: number; readonly code: string; readonly message: string } {
  if (error instanceof AppError && WORKERS_STATUS_OF[error.code] !== undefined) return { status: WORKERS_STATUS_OF[error.code], code: error.code, message: error.message };
  return { status: 500, code: "INTERNAL", message: "the request did not complete" };
}

function bearerOf(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : null;
}

/** A constant-time comparison of the bearer with the token; a different length is a mismatch without an early return on content. */
export function bearerMatches(bearer: string | null, token: string): boolean {
  if (bearer === null) return false;
  const a = Buffer.from(bearer, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function parseBody<R extends WorkersRoute>(route: R, text: string): RouteBody<R> {
  const schema = ROUTE_BODIES[route] as z.ZodType<RouteBody<R>> | null;
  if (schema === null) return null as RouteBody<R>;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new WorkersRefusal("INVALID_INPUT", "body: not JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new WorkersRefusal("INVALID_INPUT", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

const METHOD_OF: Readonly<Record<WorkersRoute, "GET" | "POST">> = { "/health": "GET", "/keys/ensure": "POST", "/keys/rotate": "POST", "/gateway/check": "POST", "/embed/query": "POST", "/answer": "POST" };

export function startWorkers(options: WorkersOptions): Promise<RunningWorkers> {
  const log = options.log ?? logSpan;

  /* Every route but `/answer`, which answers a stream of lines rather than one object and is served below. */
  const handlers: { readonly [R in JsonRoute]: (body: RouteBody<R>, traceId: string) => Promise<RouteAnswer<R>> } = {
    "/health": async () => {
      const [gateway, keys, temporal] = await Promise.all([options.probe(), options.keyCount(), options.engine?.() ?? Promise.resolve<EngineState>("off")]);
      return { ok: true, gateway, keys, temporal };
    },
    "/keys/ensure": async ({ principal }) => {
      const info = await ensureKey(principal, options.keys);
      return { litellmKeyId: info.litellmKeyId, createdAt: info.createdAt.toISOString() };
    },
    "/keys/rotate": async ({ principal }) => {
      const info = await rotateKey(principal, options.keys);
      return { litellmKeyId: info.litellmKeyId, rotatedAt: info.rotatedAt === null ? null : info.rotatedAt.toISOString() };
    },
    "/gateway/check": async ({ principal }) => {
      const check = await gatewayCheck(principal, options.gateway);
      return { model: check.model, usage: check.usage };
    },
    "/embed/query": async ({ principal, text }, traceId) => {
      /* No ref: the search page has no id to attribute the row to, and the assistant calls embedQuery itself with its message id. */
      const embedded = await embedQuery({ guide: null, principal, traceId, ref: null }, text, options.gateway);
      return { embedding: embedded.embedding, modelId: embedded.modelId, ms: embedded.ms };
    },
  };

  async function dispatch<R extends JsonRoute>(route: R, req: IncomingMessage, traceId: string): Promise<RouteAnswer<R>> {
    const body = parseBody(route, METHOD_OF[route] === "POST" ? await readBody(req) : "");
    return handlers[route](body, traceId);
  }

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const incoming = parseTraceparent(typeof req.headers.traceparent === "string" ? req.headers.traceparent : null);
    const traceId = incoming?.traceId ?? newTraceId();
    const spanId = newSpanId();
    /* The web tier's request span, as its `traceparent` names it: this request's line carries it (feature-specs/21 § 5.1). */
    const parent = incoming === null ? {} : { parentId: incoming.parentId };
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://workers").pathname;
    const headers = { "content-type": "application/json; charset=utf-8", traceparent: traceparent(traceId, spanId), "cache-control": "no-store" };
    const finish = (status: number, body: unknown, code?: string): void => {
      log({ traceId, spanId, ...parent, method, path, status, ms: Math.round(performance.now() - started), subject: null, code });
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    try {
      if (!bearerMatches(bearerOf(req), options.token)) throw new WorkersRefusal("WORKERS_UNAUTHORISED", "the workers' bearer is missing or wrong (feature-specs/11 § 7.1)");
      const route = WorkersRouteSchema.safeParse(path);
      if (!route.success || METHOD_OF[route.data] !== method) throw new WorkersRefusal("NOT_FOUND", `${method} ${path} is not a route of the workers`);

      if (route.data === "/answer") {
        /* One turn, streamed as JSON lines (feature-specs/15 § 6.2). The status line waits for the first event, so
           a failure before one — an unknown conversation, a body this surface refuses — is still a status code the
           web tier can map, and a failure after one is an `error` line on a stream already open. */
        const body = parseBody("/answer", await readBody(req));
        let open = false;
        const emit = (event: unknown): void => {
          if (!open) {
            res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", traceparent: traceparent(traceId, spanId), "cache-control": "no-store", "x-accel-buffering": "no" });
            open = true;
          }
          res.write(`${JSON.stringify(event)}\n`);
        };
        try {
          /* `request`: the turn's spans hang from this request's span, which the Langfuse road drops (feature-specs/49 § 5.6). */
          await withSpanScope({ traceId, spanId, request: true }, () => options.answer(body, emit, traceId));
        } catch (error: unknown) {
          if (!open) throw error;
          const refusal = refusalOf(error);
          console.error("workers failed mid-stream", traceId, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
          emit({ event: "error", data: { code: refusal.code, message: refusal.message, traceId } });
        }
        if (!open) throw new Error("/answer emitted no event: the turn owes the stream at least `meta` (feature-specs/15 § 6.1)");
        log({ traceId, spanId, ...parent, method, path, status: 200, ms: Math.round(performance.now() - started), subject: null });
        res.end();
        return;
      }

      const json = route.data;
      finish(200, await withSpanScope({ traceId, spanId, request: true }, () => dispatch(json, req, traceId)));
    } catch (error: unknown) {
      const refusal = refusalOf(error);
      if (refusal.status >= 500) console.error("workers failed", traceId, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      finish(refusal.status, { code: refusal.code, message: refusal.message, traceId }, refusal.code);
    }
  }

  const server = createServer((req, res) => {
    void serve(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address() as AddressInfo;
      const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
      resolve({
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections();
            server.close((error) => (error === undefined ? done() : fail(error)));
          }),
      });
    });
  });
}
