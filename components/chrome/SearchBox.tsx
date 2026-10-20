import { useTranslations } from "next-intl";

import { Kbd } from "@/components/ui/Kbd";
import type { Locale } from "@/lib/i18n/routing";

interface SearchBoxProps {
  readonly locale: Locale;
  /** The current query on the search page (feature-specs/06 § 6.9). */
  readonly value?: string;
}

/** Top-bar search: a plain GET form to the search route; the `/` shortcut arrives with the keyboard map. */
export function SearchBox({ locale, value }: SearchBoxProps) {
  const t = useTranslations("chrome.search");
  return (
    <form action={`/${locale}/search`} method="get" role="search" className="grow searchbox-form">
      <label className="row searchbox">
        <span className="cap">{t("cap")}</span>
        <input
          type="search"
          name="q"
          className="grow searchbox-input"
          placeholder={t("placeholder")}
          aria-label={t("label")}
          autoComplete="off"
          defaultValue={value}
        />
        <Kbd>/</Kbd>
      </label>
    </form>
  );
}
