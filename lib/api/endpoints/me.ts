import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import { revokeSession, type SessionUser } from "@/lib/auth/session";
import { getAccountData } from "@/lib/db/account";
import { recordAuthEvent } from "@/lib/db/audit";
import { getPrisma } from "@/lib/db/client";
import { withSystem } from "@/lib/db/tenant";
import { ownResource } from "@/lib/policy/input";
import { MeSchema, MeSessionsSchema, SessionParamsSchema, SessionRevokedSchema } from "@/lib/schemas/api";

/*
 * The caller's own account (feature-specs/09 § 6.2): `/me` and `/me/sessions`.
 * The session delete names the row's owner in the policy input, so a foreign
 * id is a policy deny, not a lookup oracle.
 */

const USER_RATE = { key: "user", limit: 60, windowS: 60 } as const;

function requireUser(session: SessionUser | null): SessionUser {
  if (session === null) throw new ApiError("NO_SESSION", "sign in to use this endpoint");
  return session;
}

export const me: Spec<undefined, undefined, undefined, typeof MeSchema> = {
  path: "/api/v1/me",
  method: "GET",
  summary: "The signed-in account",
  auth: "session-or-bearer",
  response: MeSchema,
  rateLimit: USER_RATE,
  policy: { action: "read", resource: ({ session }) => ({ kind: "user", id: requireUser(session).id, organisationId: session?.organisationId ?? null }) },
  run: async ({ session }) => {
    const data = await getAccountData(requireUser(session));
    return { ...data.user, createdAt: data.user.createdAt.toISOString() };
  },
};

export const meSessions: Spec<undefined, undefined, undefined, typeof MeSessionsSchema> = {
  path: "/api/v1/me/sessions",
  method: "GET",
  summary: "The caller's open sessions",
  auth: "session",
  response: MeSessionsSchema,
  rateLimit: USER_RATE,
  policy: { action: "list", resource: ({ session }) => ownResource("session", null, requireUser(session)) },
  run: async ({ session }) => {
    const started = performance.now();
    const data = await getAccountData(requireUser(session));
    const items = data.sessions.map((s) => ({ id: s.id, current: s.current, device: s.device, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(), expiresAt: s.expiresAt.toISOString() }));
    return { items, count: items.length + data.olderSessions, ms: Math.round(performance.now() - started) };
  },
};

export const meSessionDelete: Spec<typeof SessionParamsSchema, undefined, undefined, typeof SessionRevokedSchema> = {
  path: "/api/v1/me/sessions/{id}",
  method: "DELETE",
  summary: "Sign one of the caller's sessions out",
  auth: "session",
  params: SessionParamsSchema,
  response: SessionRevokedSchema,
  rateLimit: USER_RATE,
  policy: {
    action: "revoke",
    resource: async ({ params, session }) => {
      const user = requireUser(session);
      const row = await withSystem(() => getPrisma().session.findUnique({ where: { id: params.id }, select: { userId: true } }));
      return { kind: "session", id: params.id, ownerId: row?.userId ?? null, organisationId: user.organisationId };
    },
  },
  run: async ({ params, session, traceId, request }) => {
    const user = requireUser(session);
    const revoked = await revokeSession(user, params.id);
    if (revoked) await recordAuthEvent({ kind: "session_revoked", userId: user.id, sessionId: params.id, detail: { by: "self", current: params.id === user.sessionId }, traceId, request });
    return { id: params.id, revoked };
  },
};
