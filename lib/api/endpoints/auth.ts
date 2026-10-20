import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import type { Spec } from "@/lib/api/handler";
import { clearOauthCookieHeader, clearSessionCookieHeader, cookieFromHeader, OAUTH_COOKIE, oauthCookieHeader, parseOauthCookie, sessionCookieHeader } from "@/lib/auth/cookies";
import { resolveDevUser, resolveUserFor, SignInRefused } from "@/lib/auth/link";
import { getOidc, keycloakConfigured } from "@/lib/auth/oidc";
import { deviceFromRequest, devProviderEnabled, localeOf } from "@/lib/auth/request";
import { safeNext } from "@/lib/auth/rules";
import { createSession, revokeAllSessions, revokeSession, revokeSessionsByIdpSession, tenantOf, type SessionUser } from "@/lib/auth/session";
import { recordAuthEvent } from "@/lib/db/audit";
import { getPrisma } from "@/lib/db/client";
import { withTenant } from "@/lib/db/tenant";
import { env } from "@/lib/env";
import type { Locale } from "@/lib/i18n/routing";
import { NoBodySchema } from "@/lib/schemas/api";
import { ProviderSchema, RoleSchema } from "@/lib/schemas/auth";

/*
 * The authentication routes through the pipeline (feature-specs/09 § 4.2,
 * § 6.2, unit 22c): every failure is a redirect to the sign-in page with a
 * named error, cookies travel as Set-Cookie headers on the redirect, and the
 * audit table gets a row per outcome (§ 8.6).
 */

const IP_10 = { key: "ip", limit: 10, windowS: 60 } as const;
const AUTH = (action: "login" | "callback" | "backchannel") => ({ action, resource: () => ({ kind: "auth" as const, id: null }) });

function redirect(to: URL | string, cookies: ReadonlyArray<string> = []): Response {
  const headers = new Headers({ location: to.toString() });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

function loginError(locale: Locale, error: string, cookies: ReadonlyArray<string> = []): Response {
  return redirect(new URL(`/${locale}/login?error=${error}`, env.APP_URL), cookies);
}

const LoginQuerySchema = z.object({ idp: z.string().optional(), next: z.string().optional(), intent: z.string().optional(), locale: z.string().optional() });
const CallbackQuerySchema = z.looseObject({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), locale: z.string().optional() });
/* `role` and `verified` are read as text and judged by the endpoint, after it has said whether it is here at all:
   in production the answer to any query is the 404 it has always been (feature-specs/29 § 6.4, § 10.8). */
const DevQuerySchema = z.object({ email: z.string().optional(), next: z.string().optional(), locale: z.string().optional(), role: z.string().optional(), verified: z.string().optional() });
const DevVerifiedSchema = z.enum(["true", "false"]);

export const authLogin: Spec<undefined, typeof LoginQuerySchema, undefined, typeof NoBodySchema> = {
  path: "/api/v1/auth/login",
  method: "GET",
  summary: "Start a sign-in through Keycloak with Google or GitHub",
  auth: "public",
  query: LoginQuerySchema,
  response: NoBodySchema,
  rateLimit: IP_10,
  policy: AUTH("login"),
  run: async ({ query }) => {
    const locale = localeOf(query.next ?? null, query.locale ?? null);
    const next = safeNext(query.next, locale);
    const idp = ProviderSchema.safeParse(query.idp);
    if (!idp.success || !keycloakConfigured()) return loginError(locale, "provider");
    const intent = query.intent === "link" ? "link" : "sign-in";
    try {
      const oidc = await getOidc();
      const authorization = await oidc.authorizationRequest({ idp: idp.data, intent });
      return redirect(authorization.url, [oauthCookieHeader({ idp: idp.data, state: authorization.state, codeVerifier: authorization.codeVerifier, nonce: authorization.nonce, next, intent, locale })]);
    } catch {
      return loginError(locale, "provider");
    }
  },
};

export const authCallback: Spec<undefined, typeof CallbackQuerySchema, undefined, typeof NoBodySchema> = {
  path: "/api/v1/auth/callback",
  method: "GET",
  summary: "Keycloak's redirect back: code exchange, user resolution, session cookie",
  auth: "public",
  query: CallbackQuerySchema,
  response: NoBodySchema,
  rateLimit: IP_10,
  policy: AUTH("callback"),
  run: async ({ query, request, traceId }) => {
    const cookie = parseOauthCookie(cookieFromHeader(request.headers.get("cookie"), OAUTH_COOKIE));
    const locale = cookie?.locale ?? localeOf(null, query.locale ?? null);
    const clear = [clearOauthCookieHeader()];
    if (cookie === null) {
      await recordAuthEvent({ kind: "sign_in_refused", userId: null, detail: { reason: "state" }, traceId, request });
      return loginError(locale, "state", clear);
    }
    if (query.error !== undefined) return loginError(locale, query.error === "access_denied" ? "denied" : "provider", clear);
    if (query.state !== cookie.state) {
      await recordAuthEvent({ kind: "sign_in_refused", userId: null, detail: { reason: "state" }, traceId, request });
      return loginError(locale, "state", clear);
    }
    try {
      const oidc = await getOidc();
      const url = new URL(request.url);
      const currentUrl = new URL(url.pathname + url.search, env.APP_URL);
      const { profile, idToken } = await oidc.finish(currentUrl, { state: cookie.state, nonce: cookie.nonce, codeVerifier: cookie.codeVerifier });
      const resolved = await resolveUserFor(profile, locale);
      const token = await createSession(resolved.userId, { device: deviceFromRequest(request), idpSessionId: profile.idpSessionId, idToken });
      await recordAuthEvent({ kind: "sign_in", userId: resolved.userId, detail: { idp: profile.provider, created: resolved.created }, traceId, request });
      if (resolved.roleChanged) await recordAuthEvent({ kind: "role_changed", userId: resolved.userId, detail: { to: resolved.role }, traceId, request });
      if (resolved.identityCreated && !resolved.created) await recordAuthEvent({ kind: "identity_linked", userId: resolved.userId, detail: { idp: profile.provider }, traceId, request });
      const target = new URL(safeNext(cookie.next, locale), env.APP_URL);
      if (cookie.intent === "link" && resolved.identityCreated) target.searchParams.set("linked", profile.provider);
      return redirect(target, [...clear, sessionCookieHeader(token)]);
    } catch (error) {
      if (error instanceof SignInRefused) {
        await recordAuthEvent({ kind: "sign_in_refused", userId: null, detail: { reason: error.reason }, traceId, request });
        return loginError(locale, error.reason, clear);
      }
      console.error("auth callback failed", traceId, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      return loginError(locale, "provider", clear);
    }
  },
};

const LogoutBodySchema = z.object({ locale: z.string().optional(), next: z.string().optional(), all: z.string().optional() });

/** The sign-out page's forms post here as `application/x-www-form-urlencoded`; the body is read here, not by the pipeline. */
export const authLogout: Spec<undefined, undefined, undefined, typeof NoBodySchema> = {
  path: "/api/v1/auth/logout",
  method: "POST",
  summary: "Sign out of this session or of every session; ends the broker session too",
  auth: "session",
  response: NoBodySchema,
  rateLimit: { key: "user", limit: 10, windowS: 60 },
  policy: { action: "revoke", resource: ({ session }) => ({ kind: "session", id: session?.sessionId ?? null, ownerId: session?.id ?? null, organisationId: session?.organisationId ?? null }) },
  run: async ({ session, request, traceId }) => {
    const user = session as SessionUser;
    const form = await request.formData().catch(() => new FormData());
    const parsed = LogoutBodySchema.parse({ locale: form.get("locale") ?? undefined, next: form.get("next") ?? undefined, all: form.get("all") ?? undefined });
    const locale = localeOf(parsed.next ?? null, parsed.locale ?? null);
    const home = new URL(safeNext(parsed.next, locale), env.APP_URL);
    let brokered = false;
    let idTokenHint: string | null = null;
    if (user.sessionId !== null) {
      const row = await withTenant(tenantOf(user), () => getPrisma().session.findUnique({ where: { id: user.sessionId ?? "" }, select: { idpSessionId: true, idToken: true } }));
      brokered = row?.idpSessionId !== null && row?.idpSessionId !== undefined;
      idTokenHint = row?.idToken ?? null;
      if (parsed.all === "1") {
        const count = await revokeAllSessions(user);
        await recordAuthEvent({ kind: "sign_out_all", userId: user.id, sessionId: user.sessionId, detail: { count }, traceId, request });
      } else {
        await revokeSession(user, user.sessionId);
        await recordAuthEvent({ kind: "sign_out", userId: user.id, sessionId: user.sessionId, traceId, request });
      }
    }
    const cookies = [clearSessionCookieHeader()];
    if (brokered && keycloakConfigured()) {
      try {
        const oidc = await getOidc();
        return redirect(oidc.endSessionUrl(new URL(`/${locale}`, env.APP_URL).toString(), idTokenHint), cookies);
      } catch {
        /* the application session is gone either way */
      }
    }
    return redirect(home, cookies);
  },
};

export const authBackchannel: Spec<undefined, undefined, undefined, typeof NoBodySchema> = {
  path: "/api/v1/auth/backchannel-logout",
  method: "POST",
  summary: "Keycloak's back-channel logout: ends every session of that broker session",
  auth: "public",
  response: NoBodySchema,
  rateLimit: { key: "ip", limit: 60, windowS: 60 },
  policy: AUTH("backchannel"),
  run: async ({ request, traceId }) => {
    const empty = new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
    if (!keycloakConfigured()) return empty;
    try {
      const form = await request.formData();
      const token = form.get("logout_token");
      if (typeof token !== "string" || token.length === 0) return empty;
      const oidc = await getOidc();
      const { sid, jti } = await oidc.verifyLogoutToken(token);
      const count = sid === null ? 0 : await revokeSessionsByIdpSession(sid);
      await recordAuthEvent({ kind: "backchannel_logout", userId: null, detail: { verified: true, count, jti }, traceId, request });
    } catch (error) {
      await recordAuthEvent({ kind: "backchannel_logout", userId: null, detail: { verified: false }, traceId, request });
      console.warn("backchannel logout refused", error instanceof Error ? error.message : String(error));
    }
    return empty;
  },
};

const EmailSchema = z.string().trim().toLowerCase().email();

export const authDev: Spec<undefined, typeof DevQuerySchema, undefined, typeof NoBodySchema> = {
  path: "/api/v1/auth/dev",
  method: "GET",
  summary: "Development provider: signs the named user in without Keycloak, as a role and verified or not when asked (never in production)",
  auth: "public",
  query: DevQuerySchema,
  response: NoBodySchema,
  rateLimit: IP_10,
  policy: AUTH("login"),
  run: async ({ query, request, traceId }) => {
    if (!devProviderEnabled()) throw new ApiError("NOT_FOUND", "not here");
    const role = query.role === undefined ? undefined : RoleSchema.safeParse(query.role);
    const verified = query.verified === undefined ? undefined : DevVerifiedSchema.safeParse(query.verified);
    if (role?.success === false || verified?.success === false) {
      throw new ApiError("INVALID_INPUT", "role is one of the product's roles and verified is true or false", { role: RoleSchema.options, verified: DevVerifiedSchema.options });
    }
    const locale = localeOf(query.next ?? null, query.locale ?? null);
    const email = EmailSchema.safeParse(query.email ?? "dev@harness-bible.local");
    if (!email.success) return loginError(locale, "email");
    try {
      /* A member the query left out is left out here too: the account keeps what it has (29 § 6.4). */
      const user = await resolveDevUser(email.data, locale, { ...(role === undefined ? {} : { role: role.data }), ...(verified === undefined ? {} : { verified: verified.data === "true" }) });
      const token = await createSession(user.userId, { device: deviceFromRequest(request), idpSessionId: null });
      if (user.roleChanged) await recordAuthEvent({ kind: "role_changed", userId: user.userId, detail: { to: user.role, idp: "dev" }, traceId, request });
      /* A development curator's parts, each logged as `npm run roster:set` logs its row (29 § 17). */
      for (const entry of user.rosterSet) await recordAuthEvent({ kind: "roster_set", userId: user.userId, detail: { part: entry.part, since: entry.since.toISOString(), until: null, idp: "dev" }, traceId, request });
      await recordAuthEvent({ kind: "sign_in", userId: user.userId, detail: { idp: "dev" }, traceId, request });
      return redirect(new URL(safeNext(query.next, locale), env.APP_URL), [sessionCookieHeader(token)]);
    } catch (error) {
      if (error instanceof SignInRefused) {
        await recordAuthEvent({ kind: "sign_in_refused", userId: null, detail: { reason: error.reason, idp: "dev" }, traceId, request });
        return loginError(locale, error.reason);
      }
      return loginError(locale, "provider");
    }
  },
};
