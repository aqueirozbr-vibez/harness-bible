import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { SignOutPage } from "@/components/auth/SignOutPage";
import { TopBar } from "@/components/chrome/TopBar";
import { safeNext } from "@/lib/auth/rules";
import { countSessions, getSession } from "@/lib/auth/session";
import { currentRelease } from "@/lib/db/shared";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";

/* Reads the cookie: per request (feature-specs/08 § 3). A GET changes nothing (09 § 8.3). */
export const dynamic = "force-dynamic";

interface LogoutRouteProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<{ next?: string }>;
}

export async function generateMetadata({ params }: LogoutRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "auth.out" });
  return { title: t("metaTitle"), robots: { index: false }, alternates: { languages: { en: "/en/logout", pt: "/pt/logout" } } };
}

export default async function LogoutRoute({ params, searchParams }: LogoutRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const next = safeNext((await searchParams).next, locale);
  const user = await getSession();
  const { result, ms: loadedMs } = await timed(async () => {
    const release = await currentRelease();
    const sessions = user === null ? 0 : await countSessions(user);
    return { release: { id: release.id, gitSha: release.gitSha }, sessions };
  });
  return (
    <>
      <TopBar locale={locale} current={null} release={{ id: result.release.id, sha: result.release.gitSha }} session={user} compact />
      <SignOutPage locale={locale} release={result.release} session={user === null ? null : { displayName: user.displayName, sessions: result.sessions }} next={next} loadedMs={loadedMs} />
    </>
  );
}
