import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/Button";
import { StatusMark } from "@/components/ui/StatusMark";
import { managesBook, shortId } from "@/lib/auth/rules";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { AccountData } from "@/lib/schemas/auth";

interface AccountHeadProps {
  readonly data: AccountData;
  readonly locale: Locale;
}

/**
 * Name left, the four facts right, as the Account-Admin head row (feature-specs/08 § 6.3); then, for a curator or an
 * organisation admin, the button to Book management (feature-specs/47 § 4, D5).
 */
export function AccountHead({ data, locale }: AccountHeadProps) {
  const t = useTranslations("account");
  const { user, identities } = data;
  return (
    <div className="account-head">
      <div className="col" style={{ gap: 6 }}>
        <span className="cap">{user.organisation === null ? t("cap.individual") : t("cap.org", { name: user.organisation.name })}</span>
        <h1 className="h2">{user.displayName}</h1>
      </div>
      <dl className="account-facts">
        <div className="col" style={{ gap: 2 }}>
          <dt className="cap">{t("facts.account")}</dt>
          <dd className="tex">{shortId(user.id)}</dd>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <dt className="cap">{t("facts.signIn")}</dt>
          <dd className="row" style={{ gap: 10 }}>
            {identities.length === 0 ? <span className="meta">—</span> : identities.map((i) => <StatusMark key={i.provider} tone="ok">{i.provider}</StatusMark>)}
          </dd>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <dt className="cap">{t("facts.signedInAs")}</dt>
          <dd className="small">
            {user.email} · {t(`role.${user.role}`)}
          </dd>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <dt className="cap">{t("facts.since")}</dt>
          <dd className="small">{formatDate(user.createdAt, locale)}</dd>
        </div>
      </dl>
      {managesBook(user.role) ? (
        <div className="account-head-actions">
          <Button href={`/${locale}/account/book`} size="sm">
            {t("book.open")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
