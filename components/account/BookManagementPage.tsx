import { useTranslations } from "next-intl";
import Link from "next/link";

import { AuditExportPanel, type AuditChapterOption } from "@/components/account/AuditExportPanel";
import { RosterInstrument } from "@/components/account/RosterInstrument";
import { StatusBar } from "@/components/chrome/StatusBar";
import { BookStatus } from "@/components/reader/BookStatus";
import { formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { RosterPanel } from "@/lib/improve/roster";
import type { AuditExportView } from "@/lib/schemas/audit";
import type { HomeRelease, HomeStatus } from "@/lib/schemas/home";

interface BookManagementPageProps {
  readonly locale: Locale;
  /** The signed-in curator or organisation admin: their name for the status bar, their id for the export's account scope. */
  readonly user: { readonly id: string; readonly displayName: string };
  readonly release: HomeRelease;
  readonly status: HomeStatus;
  readonly sourceLang: string;
  readonly roster: RosterPanel;
  /** The audit export's form (feature-specs/38 § 3): the chapters it offers, the person's latest pack, and the page's clock. */
  readonly audit: { readonly chapters: ReadonlyArray<AuditChapterOption>; readonly latest: AuditExportView | null; readonly today: string };
  readonly loadedMs: number;
}

/**
 * Book management (feature-specs/47 § 3.2): the account's page for curators and organisation admins. Book status
 * across the page without its legend, which stays on the home under the grid it explains (47 D7), then the curator
 * roster beside the audit export, in the account page's grid. The three are the components the home and the account
 * page drew until 2026-10-12, unchanged but for that.
 */
export function BookManagementPage({ locale, user, release, status, sourceLang, roster, audit, loadedMs }: BookManagementPageProps) {
  const t = useTranslations("account.book");
  const th = useTranslations("home.statusbar");
  return (
    <>
      <main className="account">
        <div className="account-head">
          <div className="col" style={{ gap: 6 }}>
            <Link className="cap" href={`/${locale}/account`}>
              {t("back")}
            </Link>
            <h1 className="h2">{t("title")}</h1>
          </div>
          <span className="meta">{t("who")}</span>
        </div>
        <BookStatus release={release} status={status} locale={locale} />
        <div className="account-grid">
          <RosterInstrument roster={roster} locale={locale} />
          <AuditExportPanel locale={locale} userId={user.id} chapters={audit.chapters} latest={audit.latest} today={audit.today} />
        </div>
      </main>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("statusbar", { name: user.displayName })}</span>
        <span className="desktop-only">{th("lang", { lang: locale.toUpperCase(), src: sourceLang })}</span>
        <span className="desktop-only">{th("release", { id: release.id })}</span>
      </StatusBar>
    </>
  );
}
