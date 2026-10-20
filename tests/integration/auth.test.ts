import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveDevUser, resolveUserFor } from "@/lib/auth/link";
import { hashToken } from "@/lib/auth/rules";
import { countSessions, createSession, revokeAllSessions, revokeOtherSessions, revokeSession, revokeSessionsByIdpSession, sessionFromToken, sweepExpiredSessions, type SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { ProviderProfile } from "@/lib/schemas/auth";

/*
 * Sessions and user resolution against the database (feature-specs/08 § 12.2,
 * 09 § 14.2): two users isolated by the tenant guard; rows removed after.
 */
const hasDatabase = env.DATABASE_URL !== undefined;

const EMAIL_A = "auth-a@harness-bible.local";
const EMAIL_B = "auth-b@harness-bible.local";
const SUB_A = "kc-test-sub-a";
const SUB_B = "kc-test-sub-b";

const profileA: ProviderProfile = { provider: "google", providerAccountId: SUB_A, email: EMAIL_A, emailVerified: true, name: "Auth A", role: "READER", verified: false, idpSessionId: "kc-sid-a" };

async function cleanup(): Promise<void> {
  await withSystem(async () => {
    const prisma = getPrisma();
    const users = await prisma.user.findMany({ where: { email: { in: [EMAIL_A, EMAIL_B, "auth-c@harness-bible.local"] } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.identity.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

const asUser = (id: string, sessionId: string | null = null): SessionUser => ({ id, organisationId: null, role: "READER", displayName: "x", locale: "en-GB", identityVerified: false, parts: [], sessionId });

describe.skipIf(!hasDatabase)("authentication against the database", () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it("refuses session and identity queries outside a context, and allows them inside the system exemption", async () => {
    await expect(getPrisma().session.findMany()).rejects.toMatchObject({ code: "NO_TENANT" });
    await expect(getPrisma().identity.findMany()).rejects.toMatchObject({ code: "NO_TENANT" });
    await expect(withSystem(() => getPrisma().session.count())).resolves.toBeTypeOf("number");
  });

  it("creates the user at first sign-in, signs in again by sub, mirrors the role and records the identity", async () => {
    const first = await resolveUserFor(profileA, "en");
    expect(first).toMatchObject({ created: true, identityCreated: true, roleChanged: false, role: "READER" });
    const again = await resolveUserFor(profileA, "en");
    expect(again).toMatchObject({ userId: first.userId, created: false, identityCreated: false, roleChanged: false });

    const promoted = await resolveUserFor({ ...profileA, role: "BUILDER", provider: "github", name: "Auth A Renamed" }, "en");
    expect(promoted).toMatchObject({ userId: first.userId, roleChanged: true, identityCreated: true, role: "BUILDER" });
    const user = await withSystem(() => getPrisma().user.findUniqueOrThrow({ where: { id: first.userId }, include: { identities: true } }));
    expect(user.role).toBe("BUILDER");
    expect(user.keycloakSub).toBe(SUB_A);
    expect(user.displayName).toBe("Auth A Renamed");
    expect(user.identities.map((i) => i.provider).sort()).toEqual(["GITHUB", "GOOGLE"]);
  });

  it("adopts a pre-created user by e-mail and refuses unverified, deleted and uninvited profiles", async () => {
    const pre = await withSystem(() => getPrisma().user.create({ data: { email: EMAIL_B, displayName: "Pre B", role: "READER" }, select: { id: true } }));
    const adopted = await resolveUserFor({ ...profileA, providerAccountId: SUB_B, email: EMAIL_B, idpSessionId: null }, "pt");
    expect(adopted).toMatchObject({ userId: pre.id, created: false });
    const row = await withSystem(() => getPrisma().user.findUniqueOrThrow({ where: { id: pre.id } }));
    expect(row.keycloakSub).toBe(SUB_B);

    /* the broker user was recreated: a new subject on the same e-mail replaces the old identities */
    await resolveUserFor({ ...profileA, providerAccountId: SUB_B, email: EMAIL_B, provider: "github" }, "en");
    const readopted = await resolveUserFor({ ...profileA, providerAccountId: "kc-test-sub-b2", email: EMAIL_B, provider: "google" }, "en");
    expect(readopted.userId).toBe(pre.id);
    const identities = await withSystem(() => getPrisma().identity.findMany({ where: { userId: pre.id } }));
    expect(identities.map((i) => `${i.provider}:${i.providerAccountId}`)).toEqual(["GOOGLE:kc-test-sub-b2"]);
    expect((await withSystem(() => getPrisma().user.findUniqueOrThrow({ where: { id: pre.id } }))).keycloakSub).toBe("kc-test-sub-b2");

    await expect(resolveUserFor({ ...profileA, emailVerified: false }, "en")).rejects.toMatchObject({ code: "AUTH_REFUSED", reason: "email" });
    await withSystem(() => getPrisma().user.update({ where: { id: pre.id }, data: { deletionRequestedAt: new Date() } }));
    await expect(resolveUserFor({ ...profileA, providerAccountId: "kc-test-sub-b2", email: EMAIL_B }, "en")).rejects.toMatchObject({ code: "AUTH_REFUSED", reason: "deleted" });
    await expect(resolveDevUser(EMAIL_B, "en")).rejects.toMatchObject({ reason: "deleted" });
  });

  it("opens, reads, touches, revokes and sweeps sessions per user", async () => {
    const a = (await resolveUserFor(profileA, "en")).userId;
    const c = await resolveDevUser("auth-c@harness-bible.local", "en");
    const tokenA1 = await createSession(a, { device: "edgeWindows", idpSessionId: "kc-sid-a" });
    const tokenA2 = await createSession(a, { device: "safariIphone", idpSessionId: "kc-sid-a" });
    const tokenC = await createSession(c.userId, { device: "unknown", idpSessionId: null });

    const sessionA1 = await sessionFromToken(tokenA1);
    expect(sessionA1).toMatchObject({ id: a, role: "READER", sessionId: hashToken(tokenA1) });
    expect(await sessionFromToken("short")).toBeNull();
    expect(await sessionFromToken(`${tokenA1.slice(0, -2)}xx`)).toBeNull();
    expect(await countSessions(asUser(a))).toBe(2);

    /* an old lastSeenAt is rewritten on the next read; a near expiry is extended */
    const idA2 = hashToken(tokenA2);
    await withTenant({ userId: a, organisationId: null }, () => getPrisma().session.update({ where: { id: idA2 }, data: { lastSeenAt: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() + 86_400_000) } }));
    await sessionFromToken(tokenA2);
    const touched = await withTenant({ userId: a, organisationId: null }, () => getPrisma().session.findUniqueOrThrow({ where: { id: idA2 } }));
    expect(Date.now() - touched.lastSeenAt.getTime()).toBeLessThan(60_000);
    expect(touched.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);

    /* user C cannot revoke A's session; A can */
    expect(await revokeSession(asUser(c.userId), hashToken(tokenA1))).toBe(false);
    expect(await sessionFromToken(tokenA1)).not.toBeNull();
    expect(await revokeOtherSessions(asUser(a, idA2), idA2)).toBe(1);
    expect(await sessionFromToken(tokenA1)).toBeNull();
    expect(await sessionFromToken(tokenA2)).not.toBeNull();

    /* the broker's back-channel logout removes every session of that sid */
    const tokenA3 = await createSession(a, { device: "unknown", idpSessionId: "kc-sid-a" });
    expect(await revokeSessionsByIdpSession("kc-sid-a")).toBe(2);
    expect(await sessionFromToken(tokenA3)).toBeNull();
    expect(await sessionFromToken(tokenC)).not.toBeNull();

    /* an expired row yields null and is swept */
    const idC = hashToken(tokenC);
    await withTenant({ userId: c.userId, organisationId: null }, () => getPrisma().session.update({ where: { id: idC }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    expect(await sessionFromToken(tokenC)).toBeNull();
    expect(await sweepExpiredSessions()).toBeGreaterThanOrEqual(1);
    expect(await revokeAllSessions(asUser(a))).toBe(0);
  });

  it("keeps at most 20 open sessions per user", async () => {
    const a = (await resolveUserFor(profileA, "en")).userId;
    const tokens: string[] = [];
    for (let i = 0; i < 21; i += 1) tokens.push(await createSession(a, { device: "unknown", idpSessionId: null }));
    expect(await countSessions(asUser(a))).toBe(20);
    expect(await sessionFromToken(tokens[0])).toBeNull();
    expect(await sessionFromToken(tokens[20])).not.toBeNull();
    await revokeAllSessions(asUser(a));
  });
});
