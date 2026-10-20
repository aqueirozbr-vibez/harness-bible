"use client";

import { useLocale, useTranslations } from "next-intl";

import { usePathname, useRouter } from "@/lib/i18n/navigation";
import { HTML_LANG, routing } from "@/lib/i18n/routing";

/**
 * EN / PT edition toggle; switches the locale prefix of the current path (ui-context § 9.8). The query goes with it:
 * it is the page's state — a search, the suggest form's anchor, the dock — and a path alone would drop it.
 */
export function LangToggle() {
  const t = useTranslations("chrome.lang");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="langtoggle" role="group" aria-label={t("label")}>
      {routing.locales.map((candidate) => (
        <button
          key={candidate}
          type="button"
          lang={HTML_LANG[candidate]}
          aria-pressed={candidate === locale}
          onClick={() => router.replace(`${pathname}${window.location.search}`, { locale: candidate })}
        >
          {candidate.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
