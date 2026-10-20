import { NextResponse } from "next/server";
import { z } from "zod";

import { deviceOf } from "@/lib/auth/rules";
import { env } from "@/lib/env";
import type { Locale } from "@/lib/i18n/routing";

/*
 * Small request helpers shared by the auth routes (feature-specs/09 § 4.2, § 8.3).
 */

export const LocaleParamSchema = z.enum(["en", "pt"]);

/** The locale a `next` path names, else the `locale` param, else `en`. */
export function localeOf(next: string | null, fallback: string | null): Locale {
  const fromNext = next === null ? null : /^\/(en|pt)(\/|$|\?|#)/.exec(next)?.[1];
  if (fromNext === "en" || fromNext === "pt") return fromNext;
  const parsed = LocaleParamSchema.safeParse(fallback);
  return parsed.success ? parsed.data : "en";
}

export function loginRedirect(locale: Locale, error: string): NextResponse {
  return NextResponse.redirect(new URL(`/${locale}/login?error=${error}`, env.APP_URL), 302);
}

export function deviceFromRequest(request: Request): string {
  return deviceOf(request.headers.get("user-agent"));
}

/** Browser mutations must come from this origin (09 § 8.3): `Sec-Fetch-Site`, else `Origin`, else `Referer`. */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  const app = new URL(env.APP_URL).origin;
  if (origin !== null) return origin === app;
  const referer = request.headers.get("referer");
  if (referer !== null) {
    try {
      return new URL(referer).origin === app;
    } catch {
      return false;
    }
  }
  return false;
}

/** Development provider availability (08 § 5.7): never in production. It lives in ./devProvider.ts, which a script can load. */
export { devProviderEnabled } from "@/lib/auth/devProvider";
