import type { Locale } from "@/lib/i18n/routing";
import type { Role } from "@/lib/schemas/auth";

/*
 * The one place the sign-in link is spelled (feature-specs/08 § 6.1). Five callers used to build it inline — the
 * top bar, the sign-in notice, the account page and its actions, and the reader's phone bookmark cell — which is
 * how they came to disagree about the `next` parameter's shape (review of unit 37, 2026-09-24).
 */

/** `/{locale}/login`, with `next` when the caller has somewhere to return the reader to. */
export function signInHref(locale: Locale, next?: string): string {
  return `/${locale}/login${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`;
}

/** The roles whose actions the policy gives only to a verified identity (29 § 6.2): the switch verifies the account it makes one. */
const VERIFIED_ROLES: ReadonlySet<Role> = new Set(["CONTRIBUTOR", "CURATOR"]);

/**
 * The development sign-in as `email` in `role`, back to the account page, which then says what was switched: where a
 * segment of the account page's role switch points (feature-specs/29 § 16, § 17). A contributor or a curator is
 * verified with it, since the policy refuses an unverified one; the other roles leave verification as the account has
 * it. The endpoint is a 404 in production, where the switch is not rendered either.
 */
export function devRoleHref(email: string, role: Role, locale: Locale): string {
  const verified = VERIFIED_ROLES.has(role) ? "&verified=true" : "";
  return `/api/v1/auth/dev?email=${encodeURIComponent(email)}&role=${role}${verified}&next=${encodeURIComponent(`/${locale}/account?switched=${role}`)}`;
}
