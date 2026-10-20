import { randomBytes } from "node:crypto";

import { cache } from "react";

import { readSessionCookie } from "@/lib/auth/cookies";
import { hashToken, SESSION_MAX_PER_USER, sessionExpiry, shouldExtend, shouldTouch } from "@/lib/auth/rules";
import { getPrisma } from "@/lib/db/client";
import { currentParts } from "@/lib/db/improve";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { Role } from "@/lib/schemas/auth";
import type { Part } from "@/lib/schemas/improve";

/*
 * Sessions (feature-specs/08 § 5.2, 09 § 4.4). The cookie holds an opaque
 * token; the row holds its hash. `getSession()` is the seam every page and
 * action calls; it reads no token from Keycloak and makes no network call.
 */

export type { Role };

export interface SessionUser {
  readonly id: string;
  readonly organisationId: string | null;
  readonly role: Role;
  readonly displayName: string;
  readonly locale: string;
  /** `User.identityVerified`, mirrored from the identity provider at sign-in: what the policy is told as `verified` (feature-specs/29 § 6.1). */
  readonly identityVerified: boolean;
  /** The parts of the book this person curates now, by the roster; empty for anyone whose role is not curator (29 § 6.1). */
  readonly parts: ReadonlyArray<Part>;
  /** The current session row; null only when a caller built the user by hand (tests). */
  readonly sessionId: string | null;
}

/**
 * The roster's parts for a person of this role, at `now`. Read for each request, so a roster change needs no new
 * sign-in; and only for a curator, so nobody else's request pays for it or carries a part.
 */
export async function partsOf(userId: string, role: Role, now: Date): Promise<ReadonlyArray<Part>> {
  return role === "CURATOR" ? currentParts(userId, now) : [];
}

/** Creates the row and returns the cookie token; the 21st session of a user revokes the oldest (09 D8). */
export async function createSession(userId: string, input: { device: string; idpSessionId: string | null; idToken?: string | null }): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const id = hashToken(token);
  const now = new Date();
  await withTenant({ userId, organisationId: null }, async () => {
    const prisma = getPrisma();
    const open = await prisma.session.findMany({ where: { expiresAt: { gt: now } }, orderBy: { lastSeenAt: "desc" }, select: { id: true } });
    const surplus = open.slice(SESSION_MAX_PER_USER - 1).map((s) => s.id);
    if (surplus.length > 0) await prisma.session.deleteMany({ where: { id: { in: surplus } } });
    await prisma.session.create({ data: { id, userId, expiresAt: sessionExpiry(now), device: input.device, idpSessionId: input.idpSessionId, idToken: input.idToken ?? null, lastSeenAt: now } });
  });
  return token;
}

async function loadSession(): Promise<SessionUser | null> {
  if (env.DATABASE_URL === undefined) return null;
  const token = await readSessionCookie();
  return sessionFromToken(token);
}

/** The session a cookie token names, or null; touches and extends the row per the rules. */
export async function sessionFromToken(token: string | null, now = new Date()): Promise<SessionUser | null> {
  if (token === null || token.length < 16) return null;
  const id = hashToken(token);
  const row = await withSystem(() =>
    getPrisma().session.findUnique({
      where: { id },
      select: {
        id: true,
        expiresAt: true,
        lastSeenAt: true,
        user: { select: { id: true, organisationId: true, role: true, displayName: true, locale: true, identityVerified: true, deletedAt: true, deletionRequestedAt: true } },
      },
    }),
  );
  if (row === null || row.expiresAt <= now) return null;
  if (row.user.deletedAt !== null || row.user.deletionRequestedAt !== null) return null;
  if (shouldTouch(row.lastSeenAt, now) || shouldExtend(row.expiresAt, now)) {
    await withTenant({ userId: row.user.id, organisationId: row.user.organisationId }, () =>
      getPrisma().session.update({ where: { id }, data: { lastSeenAt: now, ...(shouldExtend(row.expiresAt, now) ? { expiresAt: sessionExpiry(now) } : {}) } }),
    );
  }
  return {
    id: row.user.id,
    organisationId: row.user.organisationId,
    role: row.user.role,
    displayName: row.user.displayName,
    locale: row.user.locale,
    identityVerified: row.user.identityVerified,
    parts: await partsOf(row.user.id, row.user.role, now),
    sessionId: row.id,
  };
}

/** The signed-in user, or null. Memoised per request. */
export const getSession: () => Promise<SessionUser | null> = cache(loadSession);

/** The tenant context a session implies, for `withTenant`. */
export function tenantOf(user: SessionUser): { userId: string; organisationId: string | null } {
  return { userId: user.id, organisationId: user.organisationId };
}

/** Delete one of the user's own sessions; true when a row went. */
export async function revokeSession(user: SessionUser, sessionId: string): Promise<boolean> {
  const result = await withTenant(tenantOf(user), () => getPrisma().session.deleteMany({ where: { id: sessionId } }));
  return result.count > 0;
}

export async function revokeOtherSessions(user: SessionUser, currentId: string): Promise<number> {
  const result = await withTenant(tenantOf(user), () => getPrisma().session.deleteMany({ where: { id: { not: currentId } } }));
  return result.count;
}

export async function revokeAllSessions(user: SessionUser): Promise<number> {
  const result = await withTenant(tenantOf(user), () => getPrisma().session.deleteMany({ where: {} }));
  return result.count;
}

/** Back-channel logout (09 § 4.2): every session opened from that broker session. */
export async function revokeSessionsByIdpSession(idpSessionId: string): Promise<number> {
  const result = await withSystem(() => getPrisma().session.deleteMany({ where: { idpSessionId } }));
  return result.count;
}

/** Rows past their expiry; the seed and `npm run auth:sweep` call it. */
export async function sweepExpiredSessions(now = new Date()): Promise<number> {
  const result = await withSystem(() => getPrisma().session.deleteMany({ where: { expiresAt: { lt: now } } }));
  return result.count;
}

export async function countSessions(user: SessionUser): Promise<number> {
  return withTenant(tenantOf(user), () => getPrisma().session.count({ where: { expiresAt: { gt: new Date() } } }));
}
