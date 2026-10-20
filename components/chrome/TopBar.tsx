import { useTranslations } from "next-intl";
import Link from "next/link";

import { LangToggle } from "@/components/chrome/LangToggle";
import { SearchBox } from "@/components/chrome/SearchBox";
import { signInHref } from "@/lib/auth/signIn";
import type { Locale } from "@/lib/i18n/routing";
import { cn } from "@/lib/utils";

type NavKey = "book" | "assistant" | "research" | "labs" | "improve";

const NAV: ReadonlyArray<{ key: NavKey; path: string }> = [
  { key: "book", path: "" },
  { key: "assistant", path: "/assistant" },
  /* the Research page, between the Assistant and Improve since 2026-10-12 (feature-specs/48 A10) */
  { key: "research", path: "/research" },
  { key: "improve", path: "/improve" },
  /* after Improve since 2026-10-12 (Andre) */
  { key: "labs", path: "/labs" },
];

interface TopBarProps {
  readonly locale: Locale;
  /** Which primary section is current; `account` on the account pages; null elsewhere. */
  readonly current: NavKey | "account" | null;
  readonly release: { readonly id: string; readonly sha: string };
  /** The signed-in reader, or null: the end cluster shows `Account` or `Sign in` (feature-specs/08 § 6.4). */
  readonly session?: { readonly displayName: string } | null;
  /** Where `Sign in` returns to; defaults to the locale's home. */
  readonly nextPath?: string;
  /** Phone layout of the reader: brand and toggle only below 768px (feature-specs/03 § 6.10). */
  readonly compact?: boolean;
  /** Keep the search field on phones even when compact (the search page, feature-specs/06 § 6.8). */
  readonly searchOnPhone?: boolean;
  /** The query shown in the search field (the search page). */
  readonly query?: string;
}

/** App top bar: brand, primary nav, search, release stamp, edition toggle, account (ui-context § 9.8). */
export function TopBar({ locale, current, release, session = null, nextPath, compact = false, searchOnPhone = false, query }: TopBarProps) {
  const t = useTranslations("chrome");
  const signIn = signInHref(locale, nextPath);
  return (
    <header className={cn("topbar", compact && "topbar-compact", searchOnPhone && "topbar-search")}>
      <Link href={`/${locale}`} className="brand" aria-label={t("brandLabel")}>
        <span className="glyph">✢</span>
        <b>{t("brand")}</b>
        <span className="faint">{t("brandSub")}</span>
      </Link>
      <nav className="nav" aria-label={t("navLabel")}>
        {NAV.map((item) => (
          <Link
            key={item.key}
            href={`/${locale}${item.path}`}
            aria-current={current === item.key ? "page" : undefined}
          >
            {t(`nav.${item.key}`)}
          </Link>
        ))}
      </nav>
      <div className="grow topbar-mid">
        <SearchBox locale={locale} value={query} />
        <span className="tex">{t("release", { id: release.id, sha: release.sha.slice(0, 8) })}</span>
      </div>
      <div className="row topbar-end">
        <LangToggle />
        {session === null ? (
          <Link href={signIn} className="small muted topbar-account">
            {t("signIn")}
          </Link>
        ) : (
          <Link href={`/${locale}/account`} className="small muted topbar-account" aria-current={current === "account" ? "page" : undefined}>
            {t("account")}
          </Link>
        )}
      </div>
    </header>
  );
}
