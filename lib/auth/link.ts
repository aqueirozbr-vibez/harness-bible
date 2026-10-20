import { devProviderEnabled } from "@/lib/auth/devProvider";
import { displayNameFor, resolveUser, userLocaleFor } from "@/lib/auth/rules";
import { getPrisma } from "@/lib/db/client";
import { currentParts, setRosterEntry, type RosterEntry } from "@/lib/db/improve";
import { withSystem } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { Locale } from "@/lib/i18n/routing";
import type { ProviderProfile, Role } from "@/lib/schemas/auth";
import { PARTS } from "@/lib/schemas/improve";

/*
 * User resolution at sign-in (feature-specs/09 § 4.3): the pure decision in
 * `rules.ts` applied to the rows, inside the authentication exemption of the
 * tenant guard, in one transaction.
 */

export interface ResolvedUser {
  readonly userId: string;
  readonly organisationId: string | null;
  readonly role: Role;
  readonly created: boolean;
  readonly identityCreated: boolean;
  /** The mirrored role differs from the stored one: other sessions are revoked (09 § 8.4). */
  readonly roleChanged: boolean;
}

const PROVIDER_ENUM = { google: "GOOGLE", github: "GITHUB" } as const;

export class SignInRefused extends AppError {
  constructor(readonly reason: "email" | "deleted" | "not-invited") {
    super("AUTH_REFUSED", `sign-in refused: ${reason}`);
  }
}

/** Resolve, adopt or create the user for a verified profile; refuse per the rules. */
export async function resolveUserFor(profile: ProviderProfile, locale: Locale, now = new Date()): Promise<ResolvedUser> {
  return withSystem(() =>
    getPrisma().$transaction(async (tx) => {
      const deleted = (u: { deletedAt: Date | null; deletionRequestedAt: Date | null }) => u.deletedAt !== null || u.deletionRequestedAt !== null;
      const bySub = await tx.user.findUnique({ where: { keycloakSub: profile.providerAccountId }, select: { id: true, deletedAt: true, deletionRequestedAt: true } });
      const byEmail = bySub === null ? await tx.user.findUnique({ where: { email: profile.email }, select: { id: true, deletedAt: true, deletionRequestedAt: true } }) : null;
      const decision = resolveUser(
        { emailVerified: profile.emailVerified, email: profile.email, allowList: env.AUTH_ALLOWED_EMAILS },
        { bySub: bySub === null ? null : { id: bySub.id, deleted: deleted(bySub) }, byEmail: byEmail === null ? null : { id: byEmail.id, deleted: deleted(byEmail) } },
      );
      if (decision.action === "refuse") throw new SignInRefused(decision.reason);

      let userId: string;
      let created = false;
      let roleChanged = false;
      let organisationId: string | null = null;
      if (decision.action === "create") {
        const user = await tx.user.create({
          data: { keycloakSub: profile.providerAccountId, email: profile.email, displayName: displayNameFor(profile.name, profile.email), role: profile.role, identityVerified: profile.verified, locale: userLocaleFor(locale) },
          select: { id: true },
        });
        userId = user.id;
        created = true;
      } else {
        const current = await tx.user.findUniqueOrThrow({ where: { id: decision.userId }, select: { id: true, role: true, displayNameEdited: true, organisationId: true } });
        userId = current.id;
        organisationId = current.organisationId;
        roleChanged = current.role !== profile.role;
        await tx.user.update({
          where: { id: userId },
          data: {
            keycloakSub: profile.providerAccountId,
            email: profile.email,
            role: profile.role,
            identityVerified: profile.verified,
            ...(current.displayNameEdited || profile.name === null ? {} : { displayName: displayNameFor(profile.name, profile.email) }),
          },
        });
      }

      /* One Keycloak subject per user: identities left by a previous subject (the broker user was recreated) are stale. */
      await tx.identity.deleteMany({ where: { userId, providerAccountId: { not: profile.providerAccountId } } });
      const provider = PROVIDER_ENUM[profile.provider];
      const existing = await tx.identity.findUnique({ where: { provider_providerAccountId: { provider, providerAccountId: profile.providerAccountId } }, select: { id: true } });
      if (existing === null) {
        await tx.identity.create({ data: { userId, provider, providerAccountId: profile.providerAccountId, email: profile.email, lastSignInAt: now } });
      } else {
        await tx.identity.update({ where: { id: existing.id }, data: { email: profile.email, lastSignInAt: now } });
      }
      if (roleChanged) await tx.session.deleteMany({ where: { userId } });

      return { userId, organisationId, role: profile.role, created, identityCreated: existing === null, roleChanged };
    }),
  );
}

/**
 * What the development provider says of a person, where a real provider would (feature-specs/29 § 6.4). A member
 * left out leaves the account as it is; for a new account that is a reader, not verified.
 */
export interface DevIdentity {
  readonly role?: Role;
  readonly verified?: boolean;
}

export interface ResolvedDevUser {
  readonly userId: string;
  readonly organisationId: string | null;
  readonly role: Role;
  /** The role given differs from the stored one: the account's other sessions are revoked, as at a provider's sign-in (09 § 8.4). */
  readonly roleChanged: boolean;
  /** The roster rows this sign-in began, asked for the curator's role (29 § 17): the endpoint logs each as the operator's command does. */
  readonly rosterSet: ReadonlyArray<RosterEntry>;
}

/**
 * The development provider (08 § 5.7): the user with that e-mail, created as a reader when absent.
 *
 * It may also be told the account's role and whether its identity is verified (29 § 6.4), which is the one place the
 * application writes either: everywhere else they are mirrored from the identity provider at sign-in (architecture
 * § 5.1). The development provider stands where that provider stands, and only where it is switched on: asked for a
 * role or a verification anywhere else, this refuses before it reads a row.
 *
 * Asked for the curator's role, it also stands where the operator stands (29 § 17): a development curator curates
 * every part, so that what a curator may do can be done on a machine with one person. The parts the account is not on
 * the roster for are put on it from now, with no end, through the one door as `npm run roster:set` puts them.
 */
export async function resolveDevUser(email: string, locale: Locale, as: DevIdentity = {}): Promise<ResolvedDevUser> {
  if ((as.role !== undefined || as.verified !== undefined) && !devProviderEnabled()) {
    throw new AppError("FORBIDDEN", "a role or a verification is given by the identity provider; the development provider gives one only where it is switched on, and never in production (feature-specs/29 § 6.4).");
  }
  return withSystem(() =>
    getPrisma().$transaction(async (tx) => {
      const now = new Date();
      const rosterFor = async (userId: string, role: Role): Promise<ReadonlyArray<RosterEntry>> => {
        if (role !== "CURATOR" || as.role !== "CURATOR") return [];
        const held = new Set(await currentParts(userId, now, tx));
        const set: RosterEntry[] = [];
        for (const part of PARTS.filter((each) => !held.has(each))) set.push(await setRosterEntry({ userId, part, until: null }, now, tx));
        return set;
      };
      const found = await tx.user.findUnique({ where: { email }, select: { id: true, organisationId: true, role: true, identityVerified: true, deletedAt: true, deletionRequestedAt: true } });
      if (found === null) {
        const role = as.role ?? "READER";
        const created = await tx.user.create({ data: { email, displayName: displayNameFor(null, email), role, identityVerified: as.verified ?? false, locale: userLocaleFor(locale) }, select: { id: true, organisationId: true } });
        return { userId: created.id, organisationId: created.organisationId, role, roleChanged: false, rosterSet: await rosterFor(created.id, role) };
      }
      if (found.deletedAt !== null || found.deletionRequestedAt !== null) throw new SignInRefused("deleted");
      const role = as.role ?? found.role;
      const verified = as.verified ?? found.identityVerified;
      const roleChanged = role !== found.role;
      if (roleChanged || verified !== found.identityVerified) await tx.user.update({ where: { id: found.id }, data: { role, identityVerified: verified } });
      if (roleChanged) await tx.session.deleteMany({ where: { userId: found.id } });
      return { userId: found.id, organisationId: found.organisationId, role, roleChanged, rosterSet: await rosterFor(found.id, role) };
    }),
  );
}
