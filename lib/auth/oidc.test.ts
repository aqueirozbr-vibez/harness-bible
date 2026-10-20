import * as jose from "jose";
import { describe, expect, it } from "vitest";

import { BACKCHANNEL_EVENT, createOidc, profileFromClaims, type Oidc } from "./oidc";

/*
 * The OIDC client against a fake issuer (feature-specs/09 § 14.2): no network;
 * the token endpoint is a fetch stub and the id tokens are signed here.
 */

const ISSUER = "http://issuer.test/realms/harness-bible";
const CLIENT_ID = "hb-web";
const REDIRECT = "http://localhost:3000/api/v1/auth/callback";

const metadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
  end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
  token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  code_challenge_methods_supported: ["S256"],
};

const keys = await jose.generateKeyPair("RS256", { extractable: true });
const otherKeys = await jose.generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await jose.exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const jwks = jose.createLocalJWKSet({ keys: [jwk] });

interface TokenOptions {
  readonly nonce?: string;
  readonly iss?: string;
  readonly aud?: string;
  readonly expOffset?: number;
  readonly iatOffset?: number;
  readonly claims?: Record<string, unknown>;
  readonly key?: CryptoKey;
}

async function idToken(o: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    sub: "kc-sub-1",
    email: "Reader@Example.com",
    email_verified: true,
    name: "Reader One",
    idp: "google",
    hb_role: "builder",
    sid: "kc-sid-1",
    azp: CLIENT_ID,
    ...(o.nonce !== undefined ? { nonce: o.nonce } : {}),
    ...o.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? CLIENT_ID)
    .setIssuedAt(now + (o.iatOffset ?? 0))
    .setExpirationTime(now + (o.expOffset ?? 300))
    .sign(o.key ?? keys.privateKey);
}

function fakeFetch(makeToken: () => Promise<string>): (url: string, options: { body?: unknown; method?: string }) => Promise<Response> {
  return async (url) => {
    if (url === metadata.token_endpoint) {
      const id_token = await makeToken();
      return new Response(JSON.stringify({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
}

async function oidcWith(makeToken: () => Promise<string>): Promise<Oidc> {
  return createOidc({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: "secret", redirectUri: REDIRECT, metadata, fetch: fakeFetch(makeToken) as never, jwks });
}

async function start(oidc: Oidc, idp: "google" | "github" = "google", intent: "sign-in" | "link" = "sign-in") {
  const request = await oidc.authorizationRequest({ idp, intent });
  const callback = new URL(REDIRECT);
  callback.searchParams.set("code", "code-1");
  callback.searchParams.set("state", request.state);
  return { request, callback };
}

describe("authorizationRequest", () => {
  it("builds the Keycloak URL with PKCE, state, nonce and the provider hint", async () => {
    const oidc = await oidcWith(() => idToken());
    const { request } = await start(oidc, "github");
    const p = request.url.searchParams;
    expect(request.url.origin + request.url.pathname).toBe(metadata.authorization_endpoint);
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(p.get("scope")).toBe("openid email profile hb");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")).toBe(request.state);
    expect(p.get("nonce")).toBe(request.nonce);
    expect(p.get("kc_idp_hint")).toBe("github");
    expect(p.get("prompt")).toBeNull();
    const google = await oidc.authorizationRequest({ idp: "google", intent: "sign-in" });
    expect(google.url.searchParams.get("prompt")).toBe("select_account");
    const link = await oidc.authorizationRequest({ idp: "github", intent: "link" });
    expect(link.url.searchParams.get("prompt")).toBe("login");
  });
});

describe("finish", () => {
  it("accepts a valid id token and maps the profile", async () => {
    let nonce = "";
    const oidc = await oidcWith(() => idToken({ nonce }));
    const { request, callback } = await start(oidc);
    nonce = request.nonce;
    const { profile, idToken: rawIdToken } = await oidc.finish(callback, { state: request.state, nonce: request.nonce, codeVerifier: request.codeVerifier });
    expect(rawIdToken.split(".")).toHaveLength(3);
    expect(profile).toEqual({ provider: "google", providerAccountId: "kc-sub-1", email: "reader@example.com", emailVerified: true, name: "Reader One", role: "BUILDER", verified: false, idpSessionId: "kc-sid-1" });
  });

  it("refuses a state mismatch, a wrong nonce, a wrong issuer, a wrong audience and an expired token", async () => {
    let nonce = "";
    const good = await oidcWith(() => idToken({ nonce }));
    const { request, callback } = await start(good);
    nonce = request.nonce;
    const wrongState = new URL(callback);
    wrongState.searchParams.set("state", "other");
    await expect(good.finish(wrongState, { state: request.state, nonce: request.nonce, codeVerifier: request.codeVerifier })).rejects.toThrow();
    await expect(good.finish(callback, { state: request.state, nonce: "not-the-nonce", codeVerifier: request.codeVerifier })).rejects.toThrow();

    for (const bad of [{ iss: "http://evil.test" }, { aud: "other-client" }, { expOffset: -60 }, { iatOffset: 3600 }] as const) {
      const oidc = await oidcWith(() => idToken({ nonce, ...bad }));
      const s = await start(oidc);
      nonce = s.request.nonce;
      await expect(oidc.finish(s.callback, { state: s.request.state, nonce: s.request.nonce, codeVerifier: s.request.codeVerifier })).rejects.toThrow();
    }
  });

  it("refuses an unknown provider, another client's token and an unverified e-mail is passed through", async () => {
    let nonce = "";
    const noIdp = await oidcWith(() => idToken({ nonce, claims: { idp: "saml-corp" } }));
    const a = await start(noIdp);
    nonce = a.request.nonce;
    await expect(noIdp.finish(a.callback, { state: a.request.state, nonce: a.request.nonce, codeVerifier: a.request.codeVerifier })).rejects.toMatchObject({ code: "AUTH_PROVIDER" });

    const otherAzp = await oidcWith(() => idToken({ nonce, claims: { azp: "other" } }));
    const b = await start(otherAzp);
    nonce = b.request.nonce;
    await expect(otherAzp.finish(b.callback, { state: b.request.state, nonce: b.request.nonce, codeVerifier: b.request.codeVerifier })).rejects.toMatchObject({ code: "AUTH_PROVIDER" });

    const unverified = await oidcWith(() => idToken({ nonce, claims: { email_verified: false, idp: "github", hb_role: "nonsense" } }));
    const c = await start(unverified);
    nonce = c.request.nonce;
    const { profile } = await unverified.finish(c.callback, { state: c.request.state, nonce: c.request.nonce, codeVerifier: c.request.codeVerifier });
    expect(profile.emailVerified).toBe(false);
    expect(profile.provider).toBe("github");
    expect(profile.role).toBe("READER");
  });
});

describe("endSessionUrl and logout tokens", () => {
  it("builds the end-session URL with client_id and the post-logout redirect", async () => {
    const oidc = await oidcWith(() => idToken());
    const url = oidc.endSessionUrl("http://localhost:3000/en");
    expect(url.origin + url.pathname).toBe(metadata.end_session_endpoint);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("http://localhost:3000/en");
    expect(url.searchParams.get("id_token_hint")).toBeNull();
    expect(oidc.endSessionUrl("http://localhost:3000/en", "a.b.c").searchParams.get("id_token_hint")).toBe("a.b.c");
  });

  async function logoutToken(o: { iss?: string; aud?: string; events?: Record<string, unknown>; key?: CryptoKey; sid?: string; nonce?: string } = {}): Promise<string> {
    return new jose.SignJWT({ events: o.events ?? { [BACKCHANNEL_EVENT]: {} }, ...(o.sid === undefined ? { sid: "kc-sid-1" } : o.sid === "" ? {} : { sid: o.sid }), ...(o.nonce !== undefined ? { nonce: o.nonce } : {}) })
      .setProtectedHeader({ alg: "RS256", kid: "k1", typ: "logout+jwt" })
      .setIssuer(o.iss ?? ISSUER)
      .setAudience(o.aud ?? CLIENT_ID)
      .setIssuedAt()
      .setJti("jti-1")
      .sign(o.key ?? keys.privateKey);
  }

  it("verifies a logout token and refuses the wrong issuer, audience, key or event", async () => {
    const oidc = await oidcWith(() => idToken());
    await expect(oidc.verifyLogoutToken(await logoutToken())).resolves.toEqual({ sid: "kc-sid-1", sub: null, jti: "jti-1" });
    await expect(oidc.verifyLogoutToken(await logoutToken({ iss: "http://evil.test" }))).rejects.toThrow();
    await expect(oidc.verifyLogoutToken(await logoutToken({ aud: "other" }))).rejects.toThrow();
    await expect(oidc.verifyLogoutToken(await logoutToken({ key: otherKeys.privateKey }))).rejects.toThrow();
    await expect(oidc.verifyLogoutToken(await logoutToken({ events: { other: {} } }))).rejects.toMatchObject({ code: "AUTH_PROVIDER" });
    await expect(oidc.verifyLogoutToken(await logoutToken({ sid: "" }))).rejects.toMatchObject({ code: "AUTH_PROVIDER" });
    await expect(oidc.verifyLogoutToken(await logoutToken({ nonce: "n" }))).rejects.toMatchObject({ code: "AUTH_PROVIDER" });
    await expect(oidc.verifyLogoutToken("not.a.jwt")).rejects.toThrow();
  });
});

describe("profileFromClaims", () => {
  it("lower-cases the e-mail, maps roles and the verified flag", () => {
    const base = { iss: ISSUER, sub: "s", aud: CLIENT_ID, exp: 1, iat: 1, email: "a@b.io", email_verified: true };
    expect(profileFromClaims({ ...base, idp: "GitHub", hb_role: "curator", hb_verified: "true" })).toMatchObject({ provider: "github", role: "CURATOR", verified: true, name: null });
    expect(profileFromClaims({ ...base, idp: "google" })).toMatchObject({ role: "READER", verified: false, idpSessionId: null });
    expect(() => profileFromClaims({ ...base })).toThrow();
  });
});
