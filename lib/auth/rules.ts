import { createHash } from "node:crypto";

import type { Locale } from "@/lib/i18n/routing";
import type { Role } from "@/lib/schemas/auth";

/*
 * Pure rules of authentication (feature-specs/08 § 4.1, 09 § 4.3). No I/O.
 */

export const SESSION_DAYS = 30;
export const SESSION_MAX_PER_USER = 20;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A same-origin path under the locale prefixes, else the locale's home (08 § 5.4). */
export function safeNext(candidate: string | null | undefined, locale: Locale): string {
  const home = `/${locale}`;
  if (candidate === null || candidate === undefined) return home;
  const value = candidate.trim();
  if (value.length === 0 || value.length > 2048) return home;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\s]/.test(value)) return home;
  if (!/^\/(en|pt)(\/|$|\?|#)/.test(value)) return home;
  return value;
}

/** The pilot allow-list: e-mails and `@domain` entries; an empty list allows everyone (08 D7). */
export function allowedEmail(email: string, allowList: string): boolean {
  const entries = allowList
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  if (entries.length === 0) return true;
  const address = email.trim().toLowerCase();
  const domain = address.slice(address.indexOf("@"));
  return entries.some((e) => (e.startsWith("@") ? e === domain : e === address));
}

/** Device summary key (a message key under `account.device.*`), from a small table rather than a library. */
export function deviceOf(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const iphone = /iPhone/.test(ua);
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));
  const android = /Android/.test(ua);
  const windows = /Windows NT/.test(ua);
  const mac = /Macintosh/.test(ua) && !ipad;
  const edge = /Edg\//.test(ua);
  const firefox = /Firefox\//.test(ua);
  const chrome = /Chrome\//.test(ua) && !edge;
  const safari = /Safari\//.test(ua) && !chrome && !edge && !firefox;
  if (iphone && safari) return "safariIphone";
  if (ipad && safari) return "safariIpad";
  if (android && chrome) return "chromeAndroid";
  if (windows && edge) return "edgeWindows";
  if (windows && chrome) return "chromeWindows";
  if (windows && firefox) return "firefoxWindows";
  if (mac && safari) return "safariMac";
  if (mac && chrome) return "chromeMac";
  return "unknown";
}

/** `lastSeenAt` is rewritten at most hourly (08 § 5.2). */
export function shouldTouch(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() >= HOUR_MS;
}

export function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_DAYS * DAY_MS);
}

/** Rolling expiry, extended once a day (08 D10). */
export function shouldExtend(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() - now.getTime() < (SESSION_DAYS - 1) * DAY_MS;
}

/** Cookie tokens are stored hashed: a database read yields nothing usable (09 § 8.4). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface ExistingUsers {
  /** The user whose `keycloakSub` equals the token's `sub`. */
  readonly bySub: { readonly id: string; readonly deleted: boolean } | null;
  /** The user whose e-mail equals the token's e-mail (when `bySub` is null). */
  readonly byEmail: { readonly id: string; readonly deleted: boolean } | null;
}

export type Resolution =
  | { readonly action: "sign-in"; readonly userId: string }
  | { readonly action: "adopt"; readonly userId: string }
  | { readonly action: "create" }
  | { readonly action: "refuse"; readonly reason: "email" | "deleted" | "not-invited" };

/** The five branches of 09 § 4.3, as a decision without I/O. */
export function resolveUser(input: { readonly emailVerified: boolean; readonly email: string; readonly allowList: string }, existing: ExistingUsers): Resolution {
  if (!input.emailVerified) return { action: "refuse", reason: "email" };
  if (existing.bySub !== null) {
    return existing.bySub.deleted ? { action: "refuse", reason: "deleted" } : { action: "sign-in", userId: existing.bySub.id };
  }
  if (existing.byEmail !== null) {
    return existing.byEmail.deleted ? { action: "refuse", reason: "deleted" } : { action: "adopt", userId: existing.byEmail.id };
  }
  if (!allowedEmail(input.email, input.allowList)) return { action: "refuse", reason: "not-invited" };
  return { action: "create" };
}

/** Display name for a new user: the provider's name, else the local part of the e-mail. */
export function displayNameFor(name: string | null | undefined, email: string): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length > 0) return trimmed.slice(0, 60);
  return email.slice(0, email.indexOf("@")).slice(0, 60) || "reader";
}

/** `User.locale` from the request locale (05: `en-GB` / `pt-BR`). */
export function userLocaleFor(locale: Locale): string {
  return locale === "pt" ? "pt-BR" : "en-GB";
}

/** The account id as the screen prints it: the uuid's first eight hex digits as `abcd·ef01`. */
export function shortId(id: string): string {
  const hex = id.replace(/-/g, "").slice(0, 8);
  return `${hex.slice(0, 4)}·${hex.slice(4, 8)}`;
}

/**
 * Who opens Book management, the account's page of Book status, the curator roster and the audit export
 * (feature-specs/47 § 3.1, D1): curators and organisation admins, by role, as the curator queue reads a curator.
 */
export function managesBook(role: Role): boolean {
  return role === "CURATOR" || role === "ORG_ADMIN";
}
