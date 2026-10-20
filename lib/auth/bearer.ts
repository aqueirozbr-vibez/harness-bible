import { getOidc, keycloakConfigured } from "@/lib/auth/oidc";
import { partsOf, type SessionUser } from "@/lib/auth/session";
import { getPrisma } from "@/lib/db/client";
import { withSystem } from "@/lib/db/tenant";
import { REALM_ROLE } from "@/lib/schemas/auth";

/*
 * Bearer authentication for non-browser clients (feature-specs/09 § 6.2, D7):
 * a Keycloak access token, verified against the JWKS, resolved to an existing
 * user by `keycloakSub`. Never creates a user. In the pipeline's contract from
 * day one; no Phase 1 endpoint enables it.
 */

export async function userFromBearer(authorization: string | null): Promise<SessionUser | null> {
  if (authorization === null || !authorization.toLowerCase().startsWith("bearer ")) return null;
  if (!keycloakConfigured()) return null;
  const token = authorization.slice(7).trim();
  if (token.length === 0) return null;
  try {
    const oidc = await getOidc();
    const claims = await oidc.verifyAccessToken(token);
    const user = await withSystem(() =>
      getPrisma().user.findUnique({ where: { keycloakSub: claims.sub }, select: { id: true, organisationId: true, displayName: true, locale: true, identityVerified: true, deletedAt: true, deletionRequestedAt: true } }),
    );
    if (user === null || user.deletedAt !== null || user.deletionRequestedAt !== null) return null;
    const role = REALM_ROLE[(claims.role ?? "reader").toLowerCase()] ?? "READER";
    return { id: user.id, organisationId: user.organisationId, role, displayName: user.displayName, locale: user.locale, identityVerified: user.identityVerified, parts: await partsOf(user.id, role, new Date()), sessionId: null };
  } catch {
    return null;
  }
}
