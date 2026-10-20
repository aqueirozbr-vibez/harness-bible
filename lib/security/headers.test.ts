import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, randomNonce, staticSecurityHeaders } from "./headers";

describe("security headers", () => {
  it("builds the production CSP with the nonce and the Keycloak form action", () => {
    const csp = contentSecurityPolicy({ nonce: "abc", dev: false, keycloakOrigin: "https://auth.example" });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).toContain("style-src-elem 'self' 'nonce-abc'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://auth.example");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).toContain("object-src 'none'");
  });

  it("relaxes only what development needs", () => {
    const csp = contentSecurityPolicy({ nonce: "abc", dev: true, keycloakOrigin: null });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("style-src-elem 'self' 'unsafe-inline'");
    expect(csp).not.toContain("style-src-elem 'self' 'nonce");
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(csp).toContain("form-action 'self';");
  });

  it("adds HSTS only in production and makes distinct nonces", () => {
    expect(staticSecurityHeaders(false).some((h) => h.key === "Strict-Transport-Security")).toBe(false);
    expect(staticSecurityHeaders(true).some((h) => h.key === "Strict-Transport-Security")).toBe(true);
    expect(staticSecurityHeaders(true).map((h) => h.key)).toContain("X-Frame-Options");
    expect(randomNonce()).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(randomNonce()).not.toBe(randomNonce());
  });
});
