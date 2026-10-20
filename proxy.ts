import createMiddleware from "next-intl/middleware";
import { NextRequest, type NextResponse } from "next/server";

import { routing } from "@/lib/i18n/routing";
import { contentSecurityPolicy, randomNonce } from "@/lib/security/headers";

/*
 * Locale routing (`/` → `/en`, unknown prefixes → 404 through the [lang]
 * layout) plus the per-request CSP nonce (feature-specs/09 § 6.1, § 8.1, D10).
 * No data access, no cookie read (code-standards § Next.js). Pages are dynamic,
 * so Next itself sends `private, no-cache, no-store, max-age=0, must-revalidate`.
 */
const intl = createMiddleware(routing);

const dev = process.env.NODE_ENV !== "production";
const keycloakOrigin = (() => {
  const issuer = process.env.KEYCLOAK_ISSUER;
  if (issuer === undefined) return null;
  try {
    return new URL(issuer).origin;
  } catch {
    return null;
  }
})();

export function proxy(request: NextRequest): NextResponse {
  const nonce = randomNonce();
  const csp = contentSecurityPolicy({ nonce, dev, keycloakOrigin });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = intl(new NextRequest(request, { headers: requestHeaders }));
  response.headers.set("content-security-policy", csp);
  return response;
}

export default proxy;

/* Section ids carry a dot (`/en/ch/21/21.3`), so only real static files are excluded, not "anything with a dot". */
export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|mjs|map|txt|xml|json|woff2?|ttf)$).*)"],
};
