import { askEndpoint, conversationCreate, messageFlag } from "@/lib/api/endpoints/assistant";
import { handler } from "@/lib/api/handler";
import { newSpanId, traceparent } from "@/lib/api/trace";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { resolveDevUser } from "@/lib/auth/link";
import { createSession, revokeAllSessions, tenantOf, type SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { WorkersClientDeps } from "@/lib/workers/client";

/*
 * The API as the gate asks it (feature-specs/22 § 3, "through the API"): the endpoints the routes serve, called in
 * the gate's own process with a signed-in reader's cookie, so a turn passes the whole pipeline — session, origin,
 * rate limit, idempotency, policy, the endpoint, the stream — and only the workers' address is the gate's own. The
 * stream suite asks the same way (tests/integration/assistant-stream.test.ts); the route files add nothing to these
 * functions but their path.
 *
 * It needs the database and the policy sidecar, as any request does. It holds no key and calls no gateway: the
 * workers it is pointed at do.
 */

export interface SseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** A stream's body as its events: frames parted by a blank line, comment lines (the keep-alive) left out. */
export function sseEventsOf(body: string): ReadonlyArray<SseEvent> {
  const out: SseEvent[] = [];
  for (const frame of body.split("\n\n")) {
    const lines = frame.split("\n").filter((line) => line.length > 0 && !line.startsWith(":"));
    if (lines.length === 0) continue;
    const field = (name: string) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
    let data: unknown = {};
    try {
      data = JSON.parse(field("data") ?? "{}");
    } catch {
      data = {};
    }
    out.push({ id: field("id") ?? "", event: field("event") ?? "", data: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {} });
  }
  return out;
}

export interface GateTurn {
  /** The response's status: 200 for a stream, whatever the pipeline refused with otherwise. */
  readonly status: number;
  readonly events: ReadonlyArray<SseEvent>;
  /** The body of a response that was not a stream: the pipeline's error, as it answered. */
  readonly refused: string | null;
}

export interface GateApi {
  /** The reader the gate asks as. */
  readonly user: SessionUser;
  /** `POST /api/v1/assistant/conversations`; the new conversation's id. */
  readonly open: (context: { readonly locale: "en" | "pt" }) => Promise<string>;
  /** `POST /api/v1/assistant/conversations/{id}/messages`, read to the end of its stream. The trace id is the caller's, so the turn's gateway calls can be found by it. */
  readonly ask: (conversationId: string, body: Readonly<Record<string, unknown>>, traceId: string) => Promise<GateTurn>;
  /** `POST /api/v1/assistant/messages/{id}/flag`; the status and the body as answered. */
  readonly flag: (messageId: string, body: { readonly kind: "answer" | "refusal"; readonly reason: string }) => Promise<{ readonly status: number; readonly body: string }>;
  readonly close: () => Promise<void>;
}

const ASK_TEMPLATE = "/api/v1/assistant/conversations/{id}/messages";
const FLAG_TEMPLATE = "/api/v1/assistant/messages/{id}/flag";

/**
 * Signs the gate's reader in and returns the endpoints bound to the given workers. The reader is a development
 * account of its own, so its conversations are nobody else's; its rate-limit buckets are emptied first, because a
 * gate run twice in a minute is still one gate.
 */
export async function startGateApi(workers: WorkersClientDeps, email: string): Promise<GateApi> {
  const account = await resolveDevUser(email, "en");
  const user: SessionUser = { id: account.userId, organisationId: account.organisationId, role: "READER", displayName: "Gate", locale: "en", identityVerified: false, parts: [], sessionId: null };
  await withSystem(() => getPrisma().rateLimitBucket.deleteMany({ where: { key: { startsWith: `user:${user.id}:` } } }));
  const token = await createSession(user.id, { device: "gate", idpSessionId: null });

  const origin = env.APP_URL.replace(/\/$/, "");
  const create = handler(conversationCreate);
  const ask = handler(askEndpoint(() => workers));
  const flag = handler(messageFlag);

  function headersOf(traceId: string | null): Headers {
    const headers = new Headers({ "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": "127.0.0.1", "idempotency-key": crypto.randomUUID() });
    headers.set("cookie", `${SESSION_COOKIE}=${token}`);
    if (traceId !== null) headers.set("traceparent", traceparent(traceId, newSpanId()));
    return headers;
  }

  return {
    user,
    open: async (context) => {
      const body = { locale: context.locale };
      const response = await create(new Request(`${origin}${conversationCreate.path}`, { method: "POST", headers: headersOf(null), body: JSON.stringify(body) }));
      const answered = (await response.json()) as { id?: unknown; code?: unknown; message?: unknown };
      if (response.status >= 300 || typeof answered.id !== "string") throw new Error(`the API did not open a conversation: ${String(response.status)} ${String(answered.code ?? "")} ${String(answered.message ?? "")}`.trim());
      return answered.id;
    },
    ask: async (conversationId, body, traceId) => {
      const request = new Request(`${origin}${ASK_TEMPLATE.replace("{id}", conversationId)}`, { method: "POST", headers: headersOf(traceId), body: JSON.stringify(body) });
      const response = await ask(request, { params: Promise.resolve({ id: conversationId }) });
      const text = await response.text();
      const stream = (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
      return { status: response.status, events: stream ? sseEventsOf(text) : [], refused: stream ? null : text };
    },
    flag: async (messageId, body) => {
      const request = new Request(`${origin}${FLAG_TEMPLATE.replace("{id}", messageId)}`, { method: "POST", headers: headersOf(null), body: JSON.stringify(body) });
      const response = await flag(request, { params: Promise.resolve({ id: messageId }) });
      return { status: response.status, body: await response.text() };
    },
    close: async () => {
      /* What the pipeline kept for this reader goes with the session: the stored first responses of its posts. */
      await withTenant(tenantOf(user), () => getPrisma().idempotencyKey.deleteMany({}));
      await revokeAllSessions(user);
    },
  };
}
