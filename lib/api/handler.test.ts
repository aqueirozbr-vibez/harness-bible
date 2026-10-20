import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { SessionUser } from "@/lib/auth/session";

import { handler, sessionTokenFromCookieHeader, type EndpointSpec, type HandlerDeps } from "./handler";

/*
 * The pipeline in isolation (feature-specs/09 § 14.2): every step in order, a
 * failing step stops the rest, the error body is the catalogue's.
 */

const user: SessionUser = { id: "u1", organisationId: null, role: "READER", displayName: "U", locale: "en-GB", identityVerified: false, parts: [], sessionId: "s1" };
const builder: SessionUser = { ...user, id: "u2", role: "BUILDER" };

interface Trace {
  readonly steps: string[];
  readonly deps: HandlerDeps;
  readonly lines: unknown[];
  readonly events: unknown[];
  /** Who the policy was asked about, each time it was asked. */
  readonly subjects: unknown[];
}

function fakeDeps(overrides: Partial<{ session: SessionUser | null; allow: boolean; allowed: boolean; idempotency: "new" | "replay" | "in-flight" | "mismatch" }> = {}): Trace {
  const steps: string[] = [];
  const lines: unknown[] = [];
  const events: unknown[] = [];
  const subjects: unknown[] = [];
  const deps: HandlerDeps = {
    sessionFromRequest: async () => {
      steps.push("session");
      return overrides.session ?? null;
    },
    authorize: async (subject) => {
      subjects.push(subject);
      steps.push("policy");
      return overrides.allow === false ? { allow: false, reason: "policy_deny" } : { allow: true };
    },
    consume: async () => {
      steps.push("ratelimit");
      const allowed = overrides.allowed !== false;
      return { allowed, limit: 10, remaining: allowed ? 9 : 0, resetS: 6, retryAfterS: allowed ? 0 : 6 };
    },
    idempotency: {
      begin: async () => {
        steps.push("idempotency");
        const kind = overrides.idempotency ?? "new";
        if (kind === "replay") return { kind, status: 200, body: { ok: "replayed" } };
        return { kind } as { kind: "new" };
      },
      complete: async () => {
        steps.push("complete");
      },
      abandon: async () => {
        steps.push("abandon");
      },
    },
    audit: async (e) => {
      events.push(e);
    },
    log: (line) => lines.push(line),
  };
  return { steps, deps, lines, events, subjects };
}

const base: EndpointSpec<{ id: string }, { q?: string }, { text: string } | undefined, { id: string; text: string | null; who: string | null }> = {
  path: "/api/v1/things/{id}",
  method: "POST",
  summary: "test",
  auth: "session",
  params: z.object({ id: z.string().regex(/^\d{2}\.\d$/) }),
  query: z.object({ q: z.string().optional() }),
  body: z.object({ text: z.string().max(10) }).optional(),
  response: z.object({ id: z.string(), text: z.string().nullable(), who: z.string().nullable() }),
  rateLimit: { key: "user", limit: 10, windowS: 60 },
  idempotent: true,
  policy: { action: "write", resource: ({ params, session }) => ({ kind: "note", id: params.id, ownerId: session?.id ?? null }) },
  run: async ({ params, body, session }) => ({ id: params.id, text: body?.text ?? null, who: session?.id ?? null }),
};

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "8b6a1c6e-2f6e-4f0c-9b4a-2b1d8f6e7a10", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}

describe("handler pipeline", () => {
  it("runs the steps in order and serialises through the response schema", async () => {
    const t = fakeDeps({ session: user });
    const res = await handler(base, t.deps)(post("/api/v1/things/21.3", { text: "hi" }), { params: { id: "21.3" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "21.3", text: "hi", who: "u1" });
    expect(t.steps).toEqual(["session", "ratelimit", "idempotency", "policy", "complete"]);
    expect(res.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("RateLimit-Limit")).toBe("10");
    expect(res.headers.get("RateLimit-Remaining")).toBe("9");
    expect(t.lines[0]).toMatchObject({ method: "POST", status: 200, subject: "u1", policy: "allow" });
  });

  /*
   * feature-specs/29 § 6.1, § 10.7. Written before the change it tests, and it failed: the session's user did not
   * carry `identityVerified`, so the policy had always been told `verified: false`, whoever asked.
   */
  it("tells the policy that a verified person is verified, and which parts a curator has", async () => {
    const curator = { ...user, role: "CURATOR", identityVerified: true, parts: ["P1", "P3"] } as SessionUser;
    const asked = fakeDeps({ session: curator });
    await handler(base, asked.deps)(post("/api/v1/things/21.3", { text: "hi" }), { params: { id: "21.3" } });
    expect(asked.subjects).toHaveLength(1);
    expect(asked.subjects[0]).toMatchObject({ kind: "user", id: "u1", role: "CURATOR", verified: true, parts: ["P1", "P3"] });

    const reader = fakeDeps({ session: user });
    await handler(base, reader.deps)(post("/api/v1/things/21.3", { text: "hi" }), { params: { id: "21.3" } });
    expect(reader.subjects[0]).toMatchObject({ kind: "user", id: "u1", role: "READER", verified: false, parts: [] });
  });

  it("keeps the incoming trace id", async () => {
    const t = fakeDeps({ session: user });
    const res = await handler(base, t.deps)(post("/api/v1/things/21.3", { text: "hi" }, { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }), { params: { id: "21.3" } });
    expect(res.headers.get("traceparent")).toContain("0af7651916cd43dd8448eb211c80319c");
  });

  it("stops at parse with 400 and the failing path, before the session is read", async () => {
    const t = fakeDeps({ session: user });
    const res = await handler(base, t.deps)(post("/api/v1/things/nope", { text: "hi" }), { params: { id: "nope" } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ code: "INVALID_INPUT", detail: { in: "params", path: ["id"] } });
    expect(typeof body.traceId).toBe("string");
    expect(t.steps).toEqual([]);
    const long = await handler(base, t.deps)(post("/api/v1/things/21.3", { text: "x".repeat(11) }), { params: { id: "21.3" } });
    expect((await long.json()).detail.in).toBe("body");
  });

  it("refuses a non-JSON body, an oversized body and a missing idempotency key", async () => {
    const t = fakeDeps({ session: user });
    const h = handler(base, t.deps);
    const text = new Request("http://localhost:3000/api/v1/things/21.3", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect((await h(text, { params: { id: "21.3" } })).status).toBe(415);
    const big = new Request("http://localhost:3000/api/v1/things/21.3", { method: "POST", headers: { "content-type": "application/json", "content-length": "70000" }, body: "{}" });
    expect((await h(big, { params: { id: "21.3" } })).status).toBe(413);
    const noKey = new Request("http://localhost:3000/api/v1/things/21.3", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ text: "a" }) });
    const res = await h(noKey, { params: { id: "21.3" } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("answers 401 without a session and 403 below the role, before rate limiting", async () => {
    const anon = fakeDeps({ session: null });
    const res = await handler(base, anon.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("NO_SESSION");
    expect(anon.steps).toEqual(["session"]);
    const t = fakeDeps({ session: user });
    const gated = await handler({ ...base, role: "BUILDER" }, t.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } });
    expect(gated.status).toBe(403);
    expect((await gated.json()).code).toBe("ROLE_REQUIRED");
    const ok = fakeDeps({ session: builder });
    expect((await handler({ ...base, role: "BUILDER" }, ok.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } })).status).toBe(200);
  });

  it("refuses a cross-site cookie mutation", async () => {
    const t = fakeDeps({ session: user });
    const res = await handler(base, t.deps)(post("/api/v1/things/21.3", { text: "a" }, { "sec-fetch-site": "cross-site" }), { params: { id: "21.3" } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("BAD_ORIGIN");
    expect(t.steps).toEqual(["session"]);
  });

  it("answers 429 with Retry-After when the bucket is empty", async () => {
    const t = fakeDeps({ session: user, allowed: false });
    const res = await handler(base, t.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("6");
    expect(res.headers.get("RateLimit-Remaining")).toBe("0");
    expect(t.steps).toEqual(["session", "ratelimit"]);
  });

  it("replays, reports in-flight and refuses a mismatched body", async () => {
    const replay = fakeDeps({ session: user, idempotency: "replay" });
    const r = await handler(base, replay.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await r.json()).toEqual({ ok: "replayed" });
    expect(replay.steps).toEqual(["session", "ratelimit", "idempotency"]);
    const flight = fakeDeps({ session: user, idempotency: "in-flight" });
    expect((await handler(base, flight.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } })).status).toBe(409);
    const mismatch = fakeDeps({ session: user, idempotency: "mismatch" });
    expect((await handler(base, mismatch.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } })).status).toBe(422);
  });

  it("denies with 403 on a policy deny, records the event and never runs the endpoint", async () => {
    let ran = false;
    const t = fakeDeps({ session: user, allow: false });
    const res = await handler({ ...base, run: async () => { ran = true; return { id: "x", text: null, who: null }; } }, t.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } });
    expect(res.status).toBe(403);
    expect((await res.json())).toMatchObject({ code: "FORBIDDEN" });
    expect(ran).toBe(false);
    expect(t.events[0]).toMatchObject({ kind: "policy_denied", userId: "u1", detail: { action: "write", resource: "note", reason: "policy_deny" } });
    expect(t.steps).toEqual(["session", "ratelimit", "idempotency", "policy", "abandon"]);
    expect(t.lines[0]).toMatchObject({ policy: "deny", code: "FORBIDDEN" });
  });

  it("never leaks a field the response schema does not name, and maps thrown codes", async () => {
    const t = fakeDeps({ session: user });
    const leaky = await handler({ ...base, run: async () => ({ id: "21.3", text: null, who: null, secret: "x" }) as never }, t.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } });
    expect(await leaky.json()).toEqual({ id: "21.3", text: null, who: null });
    const { AppError } = await import("@/lib/errors");
    const thrown = await handler({ ...base, run: async () => { throw new AppError("UNKNOWN_SECTION", "99.9 is not in the release"); } }, t.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } });
    expect(thrown.status).toBe(404);
    const unknown = await handler({ ...base, run: async () => { throw new Error("db exploded with password=hunter2"); } }, t.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } });
    expect(unknown.status).toBe(500);
    const body = await unknown.json();
    expect(body.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("passes a Response through with the trace header, and serves public GETs anonymously", async () => {
    const t = fakeDeps({ session: null });
    const spec: EndpointSpec<undefined, undefined, undefined, never> = { path: "/api/v1/x", method: "GET", summary: "raw", auth: "public", response: z.never(), cache: "public", policy: { action: "read", resource: () => ({ kind: "content", id: null }) }, run: async () => Response.redirect("http://localhost:3000/en", 302) };
    const res = await handler(spec, t.deps)(new Request("http://localhost:3000/api/v1/x"));
    expect(res.status).toBe(302);
    expect(res.headers.get("traceparent")).toBeTruthy();
    expect(t.steps).toEqual(["session", "policy"]);
  });

  it("localises the message from Accept-Language and the referer", async () => {
    const anon = fakeDeps({ session: null });
    const pt = await handler(base, anon.deps)(post("/api/v1/things/21.3", { text: "a" }, { "accept-language": "pt-BR,pt;q=0.9" }), { params: { id: "21.3" } });
    expect((await pt.json()).message).toBe("Entre para usar este endpoint.");
    const en = await handler(base, anon.deps)(post("/api/v1/things/21.3", { text: "a" }), { params: { id: "21.3" } });
    expect((await en.json()).message).toBe("Sign in to use this endpoint.");
  });

  it("reads the session cookie from the Cookie header", () => {
    expect(sessionTokenFromCookieHeader("a=1; hb.session=tok-en; b=2")).toBe("tok-en");
    expect(sessionTokenFromCookieHeader("__Host-hb.session=t")).toBe("t");
    expect(sessionTokenFromCookieHeader("other=1")).toBeNull();
    expect(sessionTokenFromCookieHeader(null)).toBeNull();
  });
});
