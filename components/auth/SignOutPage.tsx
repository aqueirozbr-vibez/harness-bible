import { useTranslations } from "next-intl";
import Link from "next/link";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { StatusBar } from "@/components/chrome/StatusBar";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";

interface SignOutPageProps {
  readonly locale: Locale;
  readonly release: { readonly id: string; readonly gitSha: string };
  readonly session: { readonly displayName: string; readonly sessions: number } | null;
  readonly next: string;
  readonly loadedMs: number;
}

/** The sign-out page: a confirm with `Sign out` and `Sign out everywhere`, or the signed-out state (feature-specs/08 § 6.2). */
export function SignOutPage({ locale, release, session, next, loadedMs }: SignOutPageProps) {
  const t = useTranslations("auth.out");
  const th = useTranslations("home.statusbar");
  return (
    <>
      <main className="auth">
        {session === null ? (
          <Empty caption={t("label").toLowerCase()} action={<Button href={`/${locale}/login`}>{t("signIn")}</Button>}>
            <p className="ui">{t("already")}</p>
          </Empty>
        ) : (
          <InstrumentPanel label={t("label")} meta={[{ key: "who", node: session.displayName }]}>
            <div className="col gap-s3">
              <p className="ui">{t("question")}</p>
              <div className="row gap-s2" style={{ flexWrap: "wrap" }}>
                <form method="post" action="/api/v1/auth/logout">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="next" value={`/${locale}`} />
                  <Button type="submit" variant="primary">
                    {t("confirm")}
                  </Button>
                </form>
                <form method="post" action="/api/v1/auth/logout">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="next" value={`/${locale}`} />
                  <input type="hidden" name="all" value="1" />
                  <Button type="submit" variant="quiet">
                    <span>{t("everywhere")}</span>
                    <span className="meta">{t("sessions", { n: session.sessions })}</span>
                  </Button>
                </form>
                <Link href={next} className="btn btn-q">
                  {t("cancel")}
                </Link>
              </div>
            </div>
          </InstrumentPanel>
        )}
      </main>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("statusbarOut")}</span>
        <span className="desktop-only">{th("lang", { lang: locale.toUpperCase(), src: "EN" })}</span>
        <span className="desktop-only">{th("release", { id: release.id })}</span>
      </StatusBar>
    </>
  );
}
