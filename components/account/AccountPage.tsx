import { useTranslations } from "next-intl";

import { AccountHead } from "@/components/account/AccountHead";
import { BudgetInstrument } from "@/components/account/BudgetInstrument";
import { IdentitiesInstrument } from "@/components/account/IdentitiesInstrument";
import { MarksSummary } from "@/components/account/MarksSummary";
import { PreferencesInstrument } from "@/components/account/PreferencesInstrument";
import { ProfileInstrument } from "@/components/account/ProfileInstrument";
import { RetentionInstrument, type RetentionStats } from "@/components/account/RetentionInstrument";
import { SessionsInstrument } from "@/components/account/SessionsInstrument";
import { StatusBar } from "@/components/chrome/StatusBar";
import { ErrorBox } from "@/components/ui/ErrorBox";
import { Notice } from "@/components/ui/Notice";
import type { BudgetView } from "@/lib/budget/view";
import { formatPercent, formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { AccountData, Role } from "@/lib/schemas/auth";
import type { Part } from "@/lib/schemas/improve";

export type AccountError = "linked-elsewhere" | "last-identity" | "session" | "failed" | "name" | "confirm";
export type AccountNotice = { readonly kind: "saved" } | { readonly kind: "revoked" } | { readonly kind: "linked" | "unlinked"; readonly provider: "google" | "github" } | { readonly kind: "role"; readonly role: Role };

/** Where the development provider is on: what the session holds that a role's actions need (feature-specs/29 § 17). */
export interface DevStanding {
  readonly verified: boolean;
  /** The roster's parts, a curator's; empty for every other role. */
  readonly parts: ReadonlyArray<Part>;
}

const ERROR_KEY: Record<AccountError, string> = { "linked-elsewhere": "linkedElsewhere", "last-identity": "lastIdentity", session: "session", failed: "failed", name: "name", confirm: "confirm" };

interface AccountPageProps {
  readonly data: AccountData;
  readonly locale: Locale;
  readonly loadedMs: number;
  /** The reader's conversations and the date their oldest text is kept until (feature-specs/21 § 3.2). */
  readonly retention: RetentionStats;
  /** The month's model budget for the reader's organisation, or for the reader on an individual account (feature-specs/21 § 4). */
  readonly budget: BudgetView;
  readonly providersConfigured: boolean;
  /** The development provider is on: the profile's role is a switch, with what the role can do (feature-specs/29 § 16, § 17); null where it is off. */
  readonly dev: DevStanding | null;
  readonly notice: AccountNotice | null;
  readonly error: AccountError | null;
}

/**
 * The account page: head, outcome line, six instruments and the budget meter (feature-specs/21 § 4.2), status bar
 * (feature-specs/08 § 6.3). The curator roster and the audit export were here until 2026-10-12; they are on Book
 * management, which the head links to for curators and organisation admins (feature-specs/47).
 */
export function AccountPage({ data, retention, budget, locale, loadedMs, providersConfigured, dev, notice, error }: AccountPageProps) {
  const t = useTranslations("account");
  const th = useTranslations("home.statusbar");
  const providerName = (p: "google" | "github") => t(`provider.${p}`);
  return (
    <>
      <main className="account">
        <AccountHead data={data} locale={locale} />
        {error !== null ? <ErrorBox title={t("error.title")}>{t(`error.${ERROR_KEY[error]}`, { provider: "" })}</ErrorBox> : null}
        {error === null && notice !== null ? (
          <Notice title={t("notice.title")}>
            {notice.kind === "saved"
              ? t("notice.saved")
              : notice.kind === "revoked"
                ? t("notice.revoked")
                : notice.kind === "role"
                  ? t("notice.role", { role: t(`role.${notice.role}`) })
                  : notice.kind === "linked"
                    ? t("notice.linked", { provider: providerName(notice.provider) })
                    : t("notice.unlinked", { provider: providerName(notice.provider) })}
          </Notice>
        ) : null}
        <div className="account-grid">
          <ProfileInstrument data={data} locale={locale} nameError={error === "name"} dev={dev} />
          <SessionsInstrument data={data} locale={locale} />
          <PreferencesInstrument data={data} locale={locale} />
          <IdentitiesInstrument data={data} locale={locale} providersConfigured={providersConfigured} />
          <BudgetInstrument budget={budget} locale={locale} />
          <MarksSummary data={data} locale={locale} />
          <RetentionInstrument locale={locale} stats={retention} />
        </div>
      </main>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("statusbar", { email: data.user.email })}</span>
        {budget.percent === null ? null : <span className="desktop-only">{t("budget.status", { pct: formatPercent(budget.percent, locale) })}</span>}
        <span className="desktop-only">{th("lang", { lang: locale.toUpperCase(), src: data.sourceLang })}</span>
        <span className="desktop-only">{th("release", { id: data.release.id })}</span>
      </StatusBar>
    </>
  );
}
