import { tenantOf, type SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { currentRelease, requireDatabase } from "@/lib/db/shared";
import { withSystem, withTenant } from "@/lib/db/tenant";
import { AppError } from "@/lib/errors";
import { AccountDataSchema, type AccountData, type Provider } from "@/lib/schemas/auth";
import type { Principal } from "@/lib/schemas/gateway";

/*
 * The account page's reads and writes (feature-specs/08 § 4, § 5.5). Every
 * query runs inside the session's tenant context; the user row is read
 * through the authentication exemption because `User` is organisation-scoped
 * and an individual account has no organisation.
 */

const SESSIONS_SHOWN = 20;
const PROVIDER_KEY = { GOOGLE: "google", GITHUB: "github" } as const;
const PROVIDER_ENUM = { google: "GOOGLE", github: "GITHUB" } as const;

/** What stands between a contributor and a suggestion (feature-specs/31 § 6.2, § 6.3): their throttle, and whether they have consented to provenance. */
export interface ContributorStanding {
  readonly throttledUntil: Date | null;
  readonly provenanceConsentAt: Date | null;
}

export function contributorStandingOf(user: Pick<SessionUser, "id">): Promise<ContributorStanding> {
  requireDatabase();
  return withSystem(() => getPrisma().user.findUniqueOrThrow({ where: { id: user.id }, select: { throttledUntil: true, provenanceConsentAt: true } }));
}

/** A person a suggestion's record names (feature-specs/35 § 5): their display name, and whether it may be shown. */
export interface RecordPerson {
  readonly displayName: string;
  /** They consented to provenance: a contributor's name is shown only while their consent stands. */
  readonly consented: boolean;
  /** Their account is gone or going: they appear by pseudonym, always. */
  readonly deleted: boolean;
  /** Their identity is verified, as the curator's queue says of a contributor (36 § 4). */
  readonly verified: boolean;
}

/**
 * The people of a suggestion's record by id, for the record page's actors (35 § 5). Read through the authentication
 * exemption, as the person's own row is: the contributor and the curators of a suggestion are not the reader's tenant.
 * Nothing but the name and the two facts that decide whether it is shown.
 */
export async function recordPeople(ids: ReadonlyArray<string>): Promise<ReadonlyMap<string, RecordPerson>> {
  if (ids.length === 0) return new Map();
  const rows = await withSystem(() => getPrisma().user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, displayName: true, provenanceConsentAt: true, deletedAt: true, deletionRequestedAt: true, identityVerified: true } }));
  return new Map(rows.map((row) => [row.id, { displayName: row.displayName, consented: row.provenanceConsentAt !== null, deleted: row.deletedAt !== null || row.deletionRequestedAt !== null, verified: row.identityVerified }]));
}

/**
 * What the grading activity needs of a contributor and nothing else (feature-specs/32 § 7.4, § 8; unit 49e): whose
 * budget a grade is charged to — the organisation's, or the person's on an individual account (11 § 3.4) — and the
 * verified e-mail address code compares with a publisher's domain for independence. The address goes to
 * `stakeOf` and nowhere near a prompt; an unverified address names no employer. Read by the workers, through the
 * authentication exemption as every user read is.
 */
/**
 * A contributor's suggestions paused until `until` (33 § 7; unit 50f), never brought forward: a throttle that already
 * runs to a later day stands. The create and submit endpoints refuse while it runs (31 § 6.3).
 */
export async function throttleContributor(userId: string, until: Date): Promise<void> {
  requireDatabase();
  await withSystem(() => getPrisma().user.updateMany({ where: { id: userId, OR: [{ throttledUntil: null }, { throttledUntil: { lt: until } }] }, data: { throttledUntil: until } }));
}

export interface ContributorForGrading {
  readonly principal: Principal;
  readonly verifiedEmail: string | null;
}

export async function contributorForGrading(userId: string): Promise<ContributorForGrading | null> {
  requireDatabase();
  const user = await withSystem(() => getPrisma().user.findUnique({ where: { id: userId }, select: { organisationId: true, email: true, identityVerified: true } }));
  if (user === null) return null;
  return { principal: user.organisationId === null ? { userId } : { organisationId: user.organisationId }, verifiedEmail: user.identityVerified ? user.email : null };
}

export async function getAccountData(user: SessionUser): Promise<AccountData> {
  requireDatabase();
  const release = await currentRelease();
  const row = await withSystem(() =>
    getPrisma().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, email: true, displayName: true, role: true, locale: true, createdAt: true, organisation: { select: { name: true } } },
    }),
  );
  const { identities, sessions, total, bookmarks, notes } = await withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const now = new Date();
    const [identities, sessions, total, bookmarks, notes] = await Promise.all([
      prisma.identity.findMany({ where: {}, orderBy: { createdAt: "asc" } }),
      prisma.session.findMany({ where: { expiresAt: { gt: now } }, orderBy: { lastSeenAt: "desc" }, take: SESSIONS_SHOWN }),
      prisma.session.count({ where: { expiresAt: { gt: now } } }),
      prisma.bookmark.count({ where: {} }),
      prisma.note.count({ where: {} }),
    ]);
    return { identities, sessions, total, bookmarks, notes };
  });
  return AccountDataSchema.parse({
    user: { id: row.id, email: row.email, displayName: row.displayName, role: row.role, locale: row.locale.startsWith("pt") ? "pt" : "en", createdAt: row.createdAt, organisation: row.organisation },
    identities: identities.map((i) => ({ provider: PROVIDER_KEY[i.provider], email: i.email, linkedAt: i.createdAt, lastSignInAt: i.lastSignInAt })),
    sessions: sessions.map((s) => ({ id: s.id, current: s.id === user.sessionId, device: s.device, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt })),
    olderSessions: Math.max(0, total - sessions.length),
    marks: { bookmarks, notes },
    release: { id: release.id, gitSha: release.gitSha },
    sourceLang: "EN",
  });
}

export async function updateDisplayNameFor(user: SessionUser, displayName: string): Promise<void> {
  requireDatabase();
  await withSystem(() => getPrisma().user.update({ where: { id: user.id }, data: { displayName, displayNameEdited: true } }));
}

export async function updateLocaleFor(user: SessionUser, locale: "en" | "pt"): Promise<void> {
  requireDatabase();
  await withSystem(() => getPrisma().user.update({ where: { id: user.id }, data: { locale: locale === "pt" ? "pt-BR" : "en-GB" } }));
}

/** Removes one linked sign-in; refused when it is the only one (08 § 5.5). */
export async function unlinkIdentityFor(user: SessionUser, provider: Provider): Promise<void> {
  requireDatabase();
  await withTenant(tenantOf(user), async () => {
    const prisma = getPrisma();
    const count = await prisma.identity.count({ where: {} });
    if (count <= 1) throw new AppError("LAST_IDENTITY", "keep at least one sign-in linked");
    await prisma.identity.deleteMany({ where: { provider: PROVIDER_ENUM[provider] } });
  });
}

/** LGPD deletion request (08 § 5.5): marks the account and closes every session; the hard delete is a later job. */
export async function requestDeletionFor(user: SessionUser): Promise<void> {
  requireDatabase();
  await withSystem(() => getPrisma().user.update({ where: { id: user.id }, data: { deletionRequestedAt: new Date() } }));
  await withTenant(tenantOf(user), () => getPrisma().session.deleteMany({ where: {} }));
}
