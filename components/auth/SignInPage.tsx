import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { StatusBar } from "@/components/chrome/StatusBar";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { Notice } from "@/components/ui/Notice";
import { formatSeconds } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";

export type SignInError = "state" | "denied" | "email" | "not-invited" | "deleted" | "provider";
const ERROR_KEY: Record<SignInError, string> = { state: "state", denied: "denied", email: "email", "not-invited": "notInvited", deleted: "deleted", provider: "provider" };

interface SignInPageProps {
  readonly locale: Locale;
  readonly release: { readonly id: string; readonly gitSha: string };
  readonly next: string | null;
  /** The section `next` points at, when it is one and exists. */
  readonly returnTo: { readonly id: string; readonly title: string } | null;
  readonly providersConfigured: boolean;
  readonly devProvider: boolean;
  readonly error: SignInError | null;
  readonly notice: "deletion-requested" | null;
  readonly loadedMs: number;
}

/** The sign-in page: two provider buttons, the return row, the outcome notices (feature-specs/08 § 6.1). */
export function SignInPage({ locale, release, next, returnTo, providersConfigured, devProvider, error, notice, loadedMs }: SignInPageProps) {
  const t = useTranslations("auth");
  const th = useTranslations("home.statusbar");
  const nextParam = next === null ? "" : `&next=${encodeURIComponent(next)}`;
  const href = (idp: "google" | "github") => `/api/v1/auth/login?idp=${idp}${nextParam}`;
  const devHref = `/api/v1/auth/dev?email=dev%40harness-bible.local${nextParam}`;

  return (
    <>
      <main className="auth">
        <div className="col" style={{ gap: 8 }}>
          <span className="cap">{t("cap", { id: release.id })}</span>
          <h1 className="h1">{t("title")}</h1>
          <p className="muted paths-blurb">{t("blurb")}</p>
        </div>
        {error !== null ? <Notice title={t("error.title")}>{t(`error.${ERROR_KEY[error]}`)}</Notice> : null}
        {notice === "deletion-requested" ? <Notice title={t("notice.deletionTitle")}>{t("notice.deletion")}</Notice> : null}
        <InstrumentPanel label={t("panel.label")} meta={[{ key: "sso", node: t("panel.meta") }]} timestamp={t("panel.stamp")}>
          {providersConfigured || devProvider ? (
            <div className="col gap-s3">
              {providersConfigured ? (
                <>
                  <Button href={href("google")} native variant="primary" className="rail-btn auth-btn">
                    <span>{t("panel.google")}</span>
                    <span className="meta">google</span>
                  </Button>
                  <Button href={href("github")} native className="rail-btn auth-btn">
                    <span>{t("panel.github")}</span>
                    <span className="meta">github</span>
                  </Button>
                </>
              ) : null}
              {devProvider ? (
                <Button href={devHref} native className="rail-btn auth-btn" variant={providersConfigured ? "quiet" : "default"}>
                  <span>{t("panel.dev")}</span>
                  <span className="meta">dev</span>
                </Button>
              ) : null}
              <p className="help">{t("panel.retention")}</p>
            </div>
          ) : (
            <Empty caption={t("statusbar.in")}>
              <p className="ui">{t("empty.none")}</p>
              <p className="small muted">{t("empty.hint")}</p>
            </Empty>
          )}
        </InstrumentPanel>
        {next !== null ? (
          <div className="empty filters-note">
            <span className="glyph">✢</span>
            <span className="small muted">{returnTo === null ? t("return.book") : t("return.section", { id: returnTo.id, title: returnTo.title })}</span>
          </div>
        ) : null}
      </main>
      <StatusBar trailing={th("loaded", { s: formatSeconds(loadedMs) })}>
        <span>{t("statusbar.in")}</span>
        <span className="desktop-only">{th("lang", { lang: locale.toUpperCase(), src: "EN" })}</span>
        <span className="desktop-only">{th("release", { id: release.id })}</span>
      </StatusBar>
    </>
  );
}
