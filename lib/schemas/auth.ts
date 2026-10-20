import { z } from "zod";

import { LangSchema } from "@/lib/schemas/domain";
import { ReleaseIdSchema } from "@/lib/schemas/ids";

/*
 * Data contracts for authentication (feature-specs/08 § 4, 09 § 9).
 */

export const ProviderSchema = z.enum(["google", "github"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const RoleSchema = z.enum(["READER", "BUILDER", "CONTRIBUTOR", "CURATOR", "ORG_ADMIN"]);
export type Role = z.infer<typeof RoleSchema>;

/** Keycloak realm role names → application roles (09 § 3.2). */
export const REALM_ROLE: Readonly<Record<string, Role>> = {
  reader: "READER",
  builder: "BUILDER",
  contributor: "CONTRIBUTOR",
  curator: "CURATOR",
  org_admin: "ORG_ADMIN",
};

export const DisplayNameSchema = z.string().trim().min(1).max(60);
export const PreferenceLocaleSchema = z.enum(["en", "pt"]);

/** The id-token claims the callback reads after openid-client validated the token (09 § 4.2). */
export const IdTokenClaimsSchema = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  nonce: z.string().optional(),
  sid: z.string().optional(),
  azp: z.string().optional(),
  email: z.string().trim().toLowerCase().email(),
  email_verified: z.boolean().default(false),
  name: z.string().trim().min(1).optional(),
  /** Identity-provider alias of the current login, from the `hb` scope mapper. */
  idp: z.string().optional(),
  hb_role: z.string().optional(),
  hb_verified: z.union([z.boolean(), z.string()]).optional(),
});
export type IdTokenClaims = z.infer<typeof IdTokenClaimsSchema>;

/** A back-channel logout token after signature verification (09 § 4.2). */
export const LogoutTokenSchema = z.object({
  iss: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number(),
  jti: z.string().min(1),
  sid: z.string().optional(),
  sub: z.string().optional(),
  events: z.record(z.string(), z.unknown()),
  nonce: z.undefined().optional(),
});

/** What a verified sign-in yields, provider-neutral (08 § 4 `ProviderProfile`, via Keycloak). */
export const ProviderProfileSchema = z.object({
  provider: ProviderSchema,
  providerAccountId: z.string().min(1),
  email: z.string().email(),
  emailVerified: z.boolean(),
  name: z.string().min(1).nullable(),
  role: RoleSchema,
  verified: z.boolean(),
  idpSessionId: z.string().nullable(),
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

export const AccountDataSchema = z
  .object({
    user: z
      .object({
        id: z.uuid(),
        email: z.string().email(),
        displayName: z.string().min(1),
        role: RoleSchema,
        locale: PreferenceLocaleSchema,
        createdAt: z.coerce.date(),
        organisation: z.object({ name: z.string().min(1) }).readonly().nullable(),
      })
      .readonly(),
    identities: z.array(z.object({ provider: ProviderSchema, email: z.string(), linkedAt: z.coerce.date(), lastSignInAt: z.coerce.date() }).readonly()).readonly(),
    sessions: z.array(z.object({ id: z.string().min(1), current: z.boolean(), device: z.string(), createdAt: z.coerce.date(), lastSeenAt: z.coerce.date(), expiresAt: z.coerce.date() }).readonly()).readonly(),
    /** Sessions beyond the 20 shown. */
    olderSessions: z.number().int().nonnegative(),
    marks: z.object({ bookmarks: z.number().int().nonnegative(), notes: z.number().int().nonnegative() }).readonly(),
    release: z.object({ id: ReleaseIdSchema, gitSha: z.string().regex(/^[0-9a-f]{8,40}$/) }).readonly(),
    sourceLang: LangSchema,
  })
  .readonly();
export type AccountData = z.infer<typeof AccountDataSchema>;
