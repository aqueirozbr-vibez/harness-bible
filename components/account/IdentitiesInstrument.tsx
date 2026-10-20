import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { StatusMark } from "@/components/ui/StatusMark";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { AccountData, Provider } from "@/lib/schemas/auth";

import { unlinkIdentity } from "@/app/[lang]/account/actions";

interface IdentitiesInstrumentProps {
  readonly data: AccountData;
  readonly locale: Locale;
  readonly providersConfigured: boolean;
}

const PROVIDERS: ReadonlyArray<Provider> = ["google", "github"];

/** Linked sign-ins with `Unlink` and `Link {provider}` (feature-specs/08 § 6.3). */
export function IdentitiesInstrument({ data, locale, providersConfigured }: IdentitiesInstrumentProps) {
  const t = useTranslations("account");
  const { identities } = data;
  const linked = new Set(identities.map((i) => i.provider));
  const linkHref = (p: Provider) => `/api/v1/auth/login?idp=${p}&intent=link&next=${encodeURIComponent(`/${locale}/account`)}`;
  return (
    <section id="identities" className="col" style={{ scrollMarginTop: 16 }}>
      <InstrumentPanel label={t("identities.label")} meta={[{ key: "n", node: String(identities.length) }]} className="account-inst">
        <div className="col gap-s3">
          {identities.length === 0 ? (
            <Empty caption={t("identities.label").toLowerCase()}>
              <p className="ui">{t("identities.none")}</p>
            </Empty>
          ) : (
            <ul className="col gap-s3" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {identities.map((i) => (
                <li key={i.provider} className="between" style={{ gap: 12 }}>
                  <span className="col" style={{ gap: 2, minWidth: 0 }}>
                    <StatusMark tone="ok">{t(`provider.${i.provider}`)}</StatusMark>
                    <span className="small">{i.email}</span>
                    <span className="meta">
                      {t("identities.linked", { date: formatDate(i.linkedAt, locale) })} · {t("identities.lastUsed", { date: formatDate(i.lastSignInAt, locale) })}
                    </span>
                  </span>
                  {identities.length > 1 ? (
                    <form action={unlinkIdentity}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="provider" value={i.provider} />
                      <Button type="submit" variant="quiet" size="sm">
                        {t("identities.unlink")}
                      </Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {providersConfigured ? (
            <div className="row gap-s2" style={{ flexWrap: "wrap" }}>
              {PROVIDERS.filter((p) => !linked.has(p)).map((p) => (
                <Button key={p} size="sm" href={linkHref(p)} native>
                  {t("identities.link", { provider: t(`provider.${p}`) })}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </InstrumentPanel>
    </section>
  );
}
