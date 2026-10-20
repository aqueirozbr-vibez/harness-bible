import { cookies } from "next/headers";

import { SESSION_DAYS } from "@/lib/auth/rules";
import { env } from "@/lib/env";

/*
 * The two cookies (feature-specs/08 § 4.2, 09 § 8.2). Route handlers set them
 * as `Set-Cookie` headers on their response (testable without a request
 * scope); server actions use the `cookies()` store. Components never touch them.
 */

const secure = env.NODE_ENV === "production";
/** `__Host-` binds the cookie to the origin in production (09 § 8.2). */
const prefix = secure ? "__Host-" : "";

export const SESSION_COOKIE = `${prefix}hb.session`;
export const OAUTH_COOKIE = `${prefix}hb.oauth`;
export const OAUTH_COOKIE_MAX_AGE_S = 600;
const OAUTH_PATH = "/api/v1/auth";

export interface OauthCookie {
  readonly idp: "google" | "github";
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly next: string;
  readonly intent: "sign-in" | "link";
  readonly locale: "en" | "pt";
}

interface CookieOptions {
  readonly path: string;
  readonly maxAge: number;
}

function serialize(name: string, value: string, { path, maxAge }: CookieOptions): string {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The value of one cookie in a `Cookie` header, or null. */
export function cookieFromHeader(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return part.slice(index + 1).trim();
      }
    }
  }
  return null;
}

/* ── Set-Cookie values for route handlers ─────────────────────────────────── */

export const sessionCookieHeader = (token: string): string => serialize(SESSION_COOKIE, token, { path: "/", maxAge: SESSION_DAYS * 86_400 });
export const clearSessionCookieHeader = (): string => serialize(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
export const oauthCookieHeader = (value: OauthCookie): string => serialize(OAUTH_COOKIE, JSON.stringify(value), { path: OAUTH_PATH, maxAge: OAUTH_COOKIE_MAX_AGE_S });
export const clearOauthCookieHeader = (): string => serialize(OAUTH_COOKIE, "", { path: OAUTH_PATH, maxAge: 0 });

export function parseOauthCookie(raw: string | null): OauthCookie | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as Record<string, unknown>;
    if ((c.idp !== "google" && c.idp !== "github") || typeof c.state !== "string" || typeof c.codeVerifier !== "string" || typeof c.nonce !== "string" || typeof c.next !== "string") return null;
    return { idp: c.idp, state: c.state, codeVerifier: c.codeVerifier, nonce: c.nonce, next: c.next, intent: c.intent === "link" ? "link" : "sign-in", locale: c.locale === "pt" ? "pt" : "en" };
  } catch {
    return null;
  }
}

/* ── the request-scoped store, for server actions and pages ──────────────── */

export async function readSessionCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: SESSION_DAYS * 86_400 });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 0 });
}
