import en from "@/messages/en.json";
import pt from "@/messages/pt.json";

import type { Locale } from "@/lib/i18n/routing";

/*
 * Error messages in the user's language (feature-specs/09 § 7): the API
 * namespace of the catalogues, read directly (route handlers have no
 * next-intl request scope). The parity test covers both files.
 */

type Catalogue = { readonly api: { readonly errors: Readonly<Record<string, string>> } };
const CATALOGUES: Readonly<Record<Locale, Catalogue>> = { en: en as unknown as Catalogue, pt: pt as unknown as Catalogue };

/** `Accept-Language` or the referring page's locale, EN by default. */
export function localeOfRequest(request: Request): Locale {
  const referer = request.headers.get("referer");
  if (referer !== null && /\/pt(\/|$|\?)/.test(referer)) return "pt";
  const accept = request.headers.get("accept-language") ?? "";
  return /^\s*pt\b/i.test(accept) ? "pt" : "en";
}

export function errorMessage(code: string, locale: Locale, fallback: string): string {
  return CATALOGUES[locale].api.errors[code] ?? CATALOGUES.en.api.errors[code] ?? fallback;
}
