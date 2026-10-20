import * as jose from "jose";
import * as client from "openid-client";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { IdTokenClaimsSchema, LogoutTokenSchema, ProviderProfileSchema, REALM_ROLE, type IdTokenClaims, type Provider, type ProviderProfile } from "@/lib/schemas/auth";

/*
 * The one OIDC client (feature-specs/09 § 4.1): Keycloak is the only issuer the
 * application trusts; Google and GitHub sit behind it. openid-client does
 * discovery, PKCE, state and nonce checks and id-token validation; jose
 * verifies back-channel logout tokens against the same JWKS.
 */

export const BACKCHANNEL_EVENT = "http://schemas.openid.net/event/backchannel-logout";
const SCOPES = "openid email profile hb";
/** Tolerated clock difference for `iat` (09 § 4.2: within 5 minutes). */
const IAT_SKEW_S = 300;

export interface OidcOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /** Test seam: server metadata instead of discovery. */
  readonly metadata?: client.ServerMetadata;
  /** Test seam: HTTP implementation for the token endpoint. */
  readonly fetch?: client.CustomFetch;
  /** Test seam: key set for logout tokens instead of the discovered JWKS. */
  readonly jwks?: jose.JWTVerifyGetKey;
}

export interface AuthorizationRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly url: URL;
}

export interface Oidc {
  /** Builds the authorization URL with PKCE, state, nonce and the identity-provider hint (09 § 4.2). */
  authorizationRequest(input: { idp: Provider; intent: "sign-in" | "link" }): Promise<AuthorizationRequest>;
  /** Exchanges the code at the callback URL and returns the validated profile plus the raw id token (kept for logout). */
  finish(currentUrl: URL, checks: { state: string; nonce: string; codeVerifier: string }): Promise<{ readonly profile: ProviderProfile; readonly idToken: string }>;
  /** Keycloak's end-session URL: `id_token_hint` when the session kept one (no confirmation page), `client_id` and the post-logout redirect (09 D4). */
  endSessionUrl(postLogoutRedirect: string, idTokenHint?: string | null): URL;
  /** Verifies a back-channel logout token; returns its `sid` and `sub` (09 § 4.2). */
  verifyLogoutToken(token: string): Promise<{ readonly sid: string | null; readonly sub: string | null; readonly jti: string }>;
  /** Verifies a Keycloak access token presented as a bearer (09 § 6.2, D7): issuer, signature, `typ`, `azp`. */
  verifyAccessToken(token: string): Promise<{ readonly sub: string; readonly role: string | null; readonly verified: boolean }>;
}

/** Maps the validated claims to the provider-neutral profile (09 § 4.3). */
export function profileFromClaims(claims: IdTokenClaims): ProviderProfile {
  const idp = (claims.idp ?? "").toLowerCase();
  if (idp !== "google" && idp !== "github") {
    throw new AppError("AUTH_PROVIDER", `the id token names no known identity provider (idp=${claims.idp ?? "missing"})`);
  }
  const role = REALM_ROLE[(claims.hb_role ?? "reader").toLowerCase()] ?? "READER";
  return ProviderProfileSchema.parse({
    provider: idp,
    providerAccountId: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified,
    name: claims.name ?? null,
    role,
    verified: claims.hb_verified === true || claims.hb_verified === "true",
    idpSessionId: claims.sid ?? null,
  });
}

export async function createOidc(options: OidcOptions): Promise<Oidc> {
  const issuer = new URL(options.issuer);
  const insecure = issuer.protocol === "http:";
  let config: client.Configuration;
  if (options.metadata !== undefined) {
    config = new client.Configuration(options.metadata, options.clientId, options.clientSecret);
    if (options.fetch !== undefined) config[client.customFetch] = options.fetch;
    if (insecure) client.allowInsecureRequests(config);
  } else {
    config = await client.discovery(issuer, options.clientId, options.clientSecret, undefined, {
      ...(options.fetch !== undefined ? { [client.customFetch]: options.fetch } : {}),
      ...(insecure ? { execute: [client.allowInsecureRequests] } : {}),
    });
  }
  const metadata = config.serverMetadata();
  const jwks = options.jwks ?? (metadata.jwks_uri !== undefined ? jose.createRemoteJWKSet(new URL(metadata.jwks_uri)) : undefined);

  return {
    async authorizationRequest({ idp, intent }) {
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: options.redirectUri,
        scope: SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        nonce,
        kc_idp_hint: idp,
        ...(intent === "link" ? { prompt: "login" } : idp === "google" ? { prompt: "select_account" } : {}),
      });
      return { state, nonce, codeVerifier, url };
    },

    async finish(currentUrl, checks) {
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const raw = tokens.claims();
      if (raw === undefined) throw new AppError("AUTH_PROVIDER", "the token response carried no id token");
      const parsed = IdTokenClaimsSchema.safeParse(raw);
      if (!parsed.success) throw new AppError("AUTH_PROVIDER", `the id token is missing a claim: ${parsed.error.issues[0]?.path.join(".") ?? "?"}`);
      if (parsed.data.azp !== undefined && parsed.data.azp !== options.clientId) throw new AppError("AUTH_PROVIDER", "the id token was issued to another client");
      if (parsed.data.iat > Math.floor(Date.now() / 1000) + IAT_SKEW_S) throw new AppError("AUTH_PROVIDER", "the id token was issued in the future");
      return { profile: profileFromClaims(parsed.data), idToken: tokens.id_token ?? "" };
    },

    endSessionUrl(postLogoutRedirect, idTokenHint = null) {
      return client.buildEndSessionUrl(config, {
        client_id: options.clientId,
        post_logout_redirect_uri: postLogoutRedirect,
        ...(idTokenHint !== null && idTokenHint.length > 0 ? { id_token_hint: idTokenHint } : {}),
      });
    },

    async verifyLogoutToken(token) {
      if (jwks === undefined) throw new AppError("AUTH_PROVIDER", "no key set to verify the logout token");
      const { payload, protectedHeader } = await jose.jwtVerify(token, jwks, { issuer: metadata.issuer, audience: options.clientId, maxTokenAge: "5 minutes" });
      if (protectedHeader.typ !== undefined && protectedHeader.typ !== "logout+jwt" && protectedHeader.typ !== "JWT") {
        throw new AppError("AUTH_PROVIDER", "not a logout token");
      }
      const parsed = LogoutTokenSchema.safeParse(payload);
      if (!parsed.success) throw new AppError("AUTH_PROVIDER", "malformed logout token");
      if (!(BACKCHANNEL_EVENT in parsed.data.events)) throw new AppError("AUTH_PROVIDER", "not a back-channel logout event");
      if (parsed.data.sid === undefined && parsed.data.sub === undefined) throw new AppError("AUTH_PROVIDER", "logout token names neither sid nor sub");
      return { sid: parsed.data.sid ?? null, sub: parsed.data.sub ?? null, jti: parsed.data.jti };
    },

    async verifyAccessToken(token) {
      if (jwks === undefined) throw new AppError("AUTH_PROVIDER", "no key set to verify the bearer token");
      const { payload, protectedHeader } = await jose.jwtVerify(token, jwks, { issuer: metadata.issuer });
      if (protectedHeader.typ !== undefined && protectedHeader.typ !== "Bearer" && protectedHeader.typ !== "JWT" && protectedHeader.typ !== "at+jwt") throw new AppError("AUTH_PROVIDER", "not an access token");
      if (payload.azp !== options.clientId) throw new AppError("AUTH_PROVIDER", "the access token was issued to another client");
      if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new AppError("AUTH_PROVIDER", "the access token names no subject");
      const role = typeof payload.hb_role === "string" ? payload.hb_role : null;
      return { sub: payload.sub, role, verified: payload.hb_verified === true || payload.hb_verified === "true" };
    },
  };
}

export function keycloakConfigured(): boolean {
  return env.KEYCLOAK_ISSUER !== undefined && env.KEYCLOAK_CLIENT_SECRET !== undefined;
}

const globalForOidc = globalThis as unknown as { hbOidc?: Promise<Oidc> };

/** The process-wide client against the configured Keycloak realm; throws when it is not configured. */
export function getOidc(): Promise<Oidc> {
  if (!keycloakConfigured() || env.KEYCLOAK_ISSUER === undefined || env.KEYCLOAK_CLIENT_SECRET === undefined) {
    return Promise.reject(new AppError("AUTH_NOT_CONFIGURED", "KEYCLOAK_ISSUER and KEYCLOAK_CLIENT_SECRET are not set (feature-specs/09 § 10)."));
  }
  globalForOidc.hbOidc ??= createOidc({
    issuer: env.KEYCLOAK_ISSUER,
    clientId: env.KEYCLOAK_CLIENT_ID,
    clientSecret: env.KEYCLOAK_CLIENT_SECRET,
    redirectUri: `${env.APP_URL}/api/v1/auth/callback`,
  }).catch((error: unknown) => {
    globalForOidc.hbOidc = undefined;
    throw error;
  });
  return globalForOidc.hbOidc;
}
