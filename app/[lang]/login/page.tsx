import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";

import { SignInPage, type SignInError } from "@/components/auth/SignInPage";
import { TopBar } from "@/components/chrome/TopBar";
import { keycloakConfigured } from "@/lib/auth/oidc";
import { devProviderEnabled } from "@/lib/auth/request";
import { safeNext } from "@/lib/auth/rules";
import { getSession } from "@/lib/auth/session";
import { sectionTitleOf } from "@/lib/db/marks";
import { currentRelease } from "@/lib/db/shared";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";

/* Reads the cookie and the query: per request (feature-specs/08 § 3). */
export const dynamic = "force-dynamic";

interface LoginRouteProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<{ next?: string; error?: string; notice?: string }>;
}

const ERRORS: ReadonlySet<string> = new Set(["state", "denied", "email", "not-invited", "deleted", "provider"]);

export async function generateMetadata({ params }: LoginRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("metaTitle"), robots: { index: false }, alternates: { languages: { en: "/en/login", pt: "/pt/login" } } };
}

export default async function LoginRoute({ params, searchParams }: LoginRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const query = await searchParams;
  const next = query.next === undefined ? null : safeNext(query.next, locale);
  const user = await getSession();
  if (user !== null) redirect(next ?? `/${locale}`);

  const { result, ms: loadedMs } = await timed(async () => {
    const release = await currentRelease();
    const section = next === null ? null : /^\/(?:en|pt)\/ch\/\d{2}\/(\d{2}\.\d)(?:$|[?#])/.exec(next)?.[1];
    const title = section === undefined || section === null ? null : await sectionTitleOf(section, locale);
    return { release: { id: release.id, gitSha: release.gitSha }, returnTo: section !== undefined && section !== null && title !== null ? { id: section, title } : null };
  });

  return (
    <>
      <TopBar locale={locale} current={null} release={{ id: result.release.id, sha: result.release.gitSha }} session={null} nextPath={next ?? undefined} compact />
      <SignInPage
        locale={locale}
        release={result.release}
        next={next}
        returnTo={result.returnTo}
        providersConfigured={keycloakConfigured()}
        devProvider={devProviderEnabled()}
        error={query.error !== undefined && ERRORS.has(query.error) ? (query.error as SignInError) : null}
        notice={query.notice === "deletion-requested" ? "deletion-requested" : null}
        loadedMs={loadedMs}
      />
    </>
  );
}
