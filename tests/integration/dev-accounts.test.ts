import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as authDev } from "@/app/api/v1/auth/dev/route";
import { resolveDevUser } from "@/lib/auth/link";
import { createSession, sessionFromToken } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { currentParts } from "@/lib/db/improve";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { subjectOf } from "@/lib/policy/input";
import { PARTS } from "@/lib/schemas/improve";

/*
 * Development accounts for a contributor and a curator (feature-specs/29 § 6.4; tracker unit 46e), against the
 * database and through the route as a browser reaches it. The development sign-in made a reader and nothing else;
 * asked, it now makes or changes an account to a role, verified or not, which is what building Improve on a
 * machine needs. Only where the endpoint itself answers: that it does not in production is
 * lib/api/endpoints/authDev.test.ts.
 *
 * The suite's accounts are its own and are removed after, with their sessions and audit rows.
 */

const hasDatabase = env.DATABASE_URL !== undefined && env.AUTH_DEV_PROVIDER === "1";

const CONTRIBUTOR = "dev-accounts-contributor@harness-bible.local";
const CURATOR = "dev-accounts-curator@harness-bible.local";
const READER = "dev-accounts-reader@harness-bible.local";
const BY_ROUTE = "dev-accounts-route@harness-bible.local";
const NOBODY = "dev-accounts-nobody@harness-bible.local";
const ROSTERED = "dev-accounts-rostered@harness-bible.local";
const ROUTE_ROSTERED = "dev-accounts-route-rostered@harness-bible.local";
const EMAILS = [CONTRIBUTOR, CURATOR, READER, BY_ROUTE, NOBODY, ROSTERED, ROUTE_ROSTERED];

/* The endpoint allows ten sign-ins a minute from one address, and the buckets outlive a run: each run has its own address. */
const ADDRESS = `2001:db8::${Date.now().toString(16)}`;
const base = env.APP_URL.replace(/\/$/, "");
const get = (query: string): Promise<Response> => authDev(new Request(`${base}/api/v1/auth/dev${query}`, { headers: { "x-forwarded-for": ADDRESS } }), { params: Promise.resolve({}) });

const account = (email: string) => withSystem(() => getPrisma().user.findUnique({ where: { email }, select: { id: true, role: true, identityVerified: true } }));
const sessionsOf = (userId: string) => withSystem(() => getPrisma().session.count({ where: { userId } }));
const tokenOf = (response: Response): string => /hb\.session=([^;]+)/.exec(response.headers.getSetCookie().join("\n"))?.[1] ?? "";

async function cleanup(): Promise<void> {
  await withSystem(async () => {
    const prisma = getPrisma();
    const ids = (await prisma.user.findMany({ where: { email: { in: EMAILS } }, select: { id: true } })).map((user) => user.id);
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.authEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

describe.skipIf(!hasDatabase)("development accounts, against the database", () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it("makes a reader, not verified, when asked for nothing more: as it always has", async () => {
    const made = await resolveDevUser(READER, "en");
    expect(made).toMatchObject({ role: "READER", roleChanged: false });
    expect(await account(READER)).toMatchObject({ id: made.userId, role: "READER", identityVerified: false });
  });

  it("makes a verified contributor and a verified curator when asked", async () => {
    const contributor = await resolveDevUser(CONTRIBUTOR, "en", { role: "CONTRIBUTOR", verified: true });
    const curator = await resolveDevUser(CURATOR, "pt", { role: "CURATOR", verified: true });
    expect(contributor).toMatchObject({ role: "CONTRIBUTOR", roleChanged: false });
    expect(await account(CONTRIBUTOR)).toMatchObject({ role: "CONTRIBUTOR", identityVerified: true });
    expect(await account(CURATOR)).toMatchObject({ id: curator.userId, role: "CURATOR", identityVerified: true });
  });

  it("leaves an account as it is when it signs in again and is asked for nothing", async () => {
    const again = await resolveDevUser(CURATOR, "en");
    expect(again).toMatchObject({ role: "CURATOR", roleChanged: false });
    expect(await account(CURATOR)).toMatchObject({ role: "CURATOR", identityVerified: true });
  });

  it("changes a role when told to, keeps the verification it was not told of, and revokes the account's other sessions", async () => {
    const reader = await account(READER);
    if (reader === null) expect.fail("the suite's reader was made by its first case");
    await createSession(reader.id, { device: "unknown", idpSessionId: null });
    await createSession(reader.id, { device: "unknown", idpSessionId: null });
    expect(await sessionsOf(reader.id)).toBe(2);

    const verifiedOnly = await resolveDevUser(READER, "en", { verified: true });
    expect(verifiedOnly).toMatchObject({ role: "READER", roleChanged: false });
    expect(await account(READER)).toMatchObject({ role: "READER", identityVerified: true });
    expect(await sessionsOf(reader.id)).toBe(2);

    const promoted = await resolveDevUser(READER, "en", { role: "CONTRIBUTOR" });
    expect(promoted).toMatchObject({ userId: reader.id, role: "CONTRIBUTOR", roleChanged: true });
    expect(await account(READER)).toMatchObject({ role: "CONTRIBUTOR", identityVerified: true });
    expect(await sessionsOf(reader.id)).toBe(0);
  });

  it("signs in through the route as a verified curator of every part, and the session and the policy's subject say so", async () => {
    const response = await get(`?email=${encodeURIComponent(BY_ROUTE)}&role=CURATOR&verified=true&next=/en/improve`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${base}/en/improve`);
    const session = await sessionFromToken(tokenOf(response));
    expect(session).toMatchObject({ role: "CURATOR", identityVerified: true, parts: [...PARTS] });
    expect(subjectOf(session)).toMatchObject({ kind: "user", role: "CURATOR", verified: true, parts: [...PARTS] });
    const events = await withSystem(() => getPrisma().authEvent.findMany({ where: { userId: session?.id }, select: { kind: true, detail: true } }));
    expect(events.filter((event) => event.kind === "sign_in")).toEqual([{ kind: "sign_in", detail: { idp: "dev" } }]);
    expect(events.filter((event) => event.kind === "roster_set")).toHaveLength(PARTS.length);
  });

  it("records the change of role when the route changes one, and signs the account in as what it now is", async () => {
    const response = await get(`?email=${encodeURIComponent(BY_ROUTE)}&role=CONTRIBUTOR&next=/en`);
    expect(response.status).toBe(302);
    const session = await sessionFromToken(tokenOf(response));
    expect(session).toMatchObject({ role: "CONTRIBUTOR", identityVerified: true });
    const kinds = await withSystem(() => getPrisma().authEvent.findMany({ where: { userId: session?.id, kind: "role_changed" }, select: { detail: true } }));
    expect(kinds).toEqual([{ detail: { to: "CONTRIBUTOR", idp: "dev" } }]);
    expect(await sessionsOf(session?.id ?? "")).toBe(1);
  });

  it("puts a curator it is asked for on the roster for every part, once, and the route logs each row as the operator's command does (29 § 17)", async () => {
    const first = await resolveDevUser(ROSTERED, "en", { role: "CURATOR", verified: true });
    expect(first.rosterSet.map((entry) => entry.part)).toEqual([...PARTS]);
    expect(first.rosterSet.every((entry) => entry.until === null)).toBe(true);
    expect(await currentParts(first.userId)).toEqual([...PARTS]);
    /* Again as a curator, or with no role asked: the rows in force stay, and none is begun twice. */
    expect((await resolveDevUser(ROSTERED, "en", { role: "CURATOR" })).rosterSet).toEqual([]);
    expect((await resolveDevUser(ROSTERED, "en")).rosterSet).toEqual([]);
    /* A contributor is put on no roster. */
    expect((await resolveDevUser(CONTRIBUTOR, "en", { role: "CONTRIBUTOR", verified: true })).rosterSet).toEqual([]);

    const response = await get(`?email=${encodeURIComponent(ROUTE_ROSTERED)}&role=CURATOR&verified=true&next=${encodeURIComponent("/en/account?switched=CURATOR")}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${base}/en/account?switched=CURATOR`);
    const routed = await account(ROUTE_ROSTERED);
    expect(routed).toMatchObject({ role: "CURATOR", identityVerified: true });
    const logged = await withSystem(() => getPrisma().authEvent.findMany({ where: { userId: routed?.id, kind: "roster_set" }, select: { detail: true } }));
    expect(logged.map((event) => (event.detail as { part?: unknown }).part).sort()).toEqual([...PARTS]);
    const session = await sessionFromToken(tokenOf(response));
    expect(session?.parts).toEqual([...PARTS]);
  });

  it("refuses a role it does not know, and makes no account for it", async () => {
    const response = await get(`?email=${encodeURIComponent(NOBODY)}&role=curator`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(await account(NOBODY)).toBeNull();
  });
});
