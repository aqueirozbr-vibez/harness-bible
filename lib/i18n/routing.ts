import { defineRouting } from "next-intl/routing";
import { z } from "zod";

import type { Lang } from "@/lib/schemas/domain";

/** Route locales, lowercase, always prefixed: `/en/...`, `/pt/...` (architecture § 3.2). */
export const locales = ["en", "pt"] as const;

export const routing = defineRouting({
  locales,
  defaultLocale: "en",
  localePrefix: "always",
});

export const LocaleSchema = z.enum(locales);
export type Locale = z.infer<typeof LocaleSchema>;

/** The BCP 47 tag the `<html lang>` attribute carries per edition (style guide § 12). */
export const HTML_LANG: Record<Locale, string> = {
  en: "en-GB",
  pt: "pt-BR",
};

/** Route locale → content edition language (TRD `Lang`). */
export function localeToLang(locale: Locale): Lang {
  return locale === "pt" ? "PT" : "EN";
}
