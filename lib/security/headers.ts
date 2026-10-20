/*
 * Response headers (feature-specs/09 § 8.1). Pure: `proxy.ts` and
 * `next.config.ts` call these; tests assert them.
 */

export interface CspOptions {
  readonly nonce: string;
  readonly dev: boolean;
  /** Keycloak's origin, allowed as a form action (the sign-out form posts there through a redirect chain). */
  readonly keycloakOrigin: string | null;
}

export function contentSecurityPolicy({ nonce, dev, keycloakOrigin }: CspOptions): string {
  const directives: ReadonlyArray<string> = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    /* Turbopack injects nonce-less <style> elements for CSS hot reload; a nonce would make 'unsafe-inline' ignored, so development lists neither. */
    dev ? "style-src-elem 'self' 'unsafe-inline'" : `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'",
    `form-action 'self'${keycloakOrigin === null ? "" : ` ${keycloakOrigin}`}`,
    "base-uri 'self'",
    "object-src 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ];
  return directives.join("; ");
}

/** The headers every response carries (09 § 8.1), HSTS only in production. */
export function staticSecurityHeaders(production: boolean): ReadonlyArray<{ readonly key: string; readonly value: string }> {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" }] : []),
  ];
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
