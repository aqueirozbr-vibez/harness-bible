import { useTranslations } from "next-intl";
import Link from "next/link";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import type { Locale } from "@/lib/i18n/routing";
import type { AccountData } from "@/lib/schemas/auth";

interface MarksSummaryProps {
  readonly data: AccountData;
  readonly locale: Locale;
}

/** The "Your marks" cells, counting and linking to the marks page (feature-specs/08 § 6.3, from 05 § 6.2). */
export function MarksSummary({ data, locale }: MarksSummaryProps) {
  const t = useTranslations("paths.marks");
  return (
    <InstrumentPanel label={t("label")} meta={[{ key: "account", node: t("meta") }]} body="bare" className="account-inst">
      <div className="marks-grid">
        <Link href={`/${locale}/marks#bookmarks`} className="rr marks-cell">
          <span className="mono marks-count">{data.marks.bookmarks}</span>
          <span className="cap">{t("bookmarks")}</span>
        </Link>
        <Link href={`/${locale}/marks#notes`} className="rr marks-cell">
          <span className="mono marks-count">{data.marks.notes}</span>
          <span className="cap">{t("notes")}</span>
        </Link>
      </div>
    </InstrumentPanel>
  );
}
