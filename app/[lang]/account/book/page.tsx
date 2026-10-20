import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { BookManagementPage } from "@/components/account/BookManagementPage";
import { TopBar } from "@/components/chrome/TopBar";
import { latestAuditExportView } from "@/lib/api/endpoints/audit";
import { managesBook } from "@/lib/auth/rules";
import { getSession } from "@/lib/auth/session";
import { signInHref } from "@/lib/auth/signIn";
import { getHomeData } from "@/lib/db/content";
import { readRosterPanel } from "@/lib/db/roster";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";

/*
 * Book management (feature-specs/47 § 3): per request; signed out → the sign-in page with `next`, as the account page;
 * signed in without the role of a curator or an organisation admin → 404, as the curator queue answers (47 D1).
 */
export const dynamic = "force-dynamic";

interface BookManagementRouteProps {
  readonly params: Promise<{ lang: string }>;
}

export async function generateMetadata({ params }: BookManagementRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "account.book" });
  return { title: t("metaTitle"), robots: { index: false }, alternates: { languages: { en: "/en/account/book", pt: "/pt/account/book" } } };
}

export default async function BookManagementRoute({ params }: BookManagementRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const user = await getSession();
  if (user === null) redirect(signInHref(locale, `/${locale}/account/book`));
  if (!managesBook(user.role)) notFound();
  /* What the home's Book status and the account page's two instruments read until 2026-10-12 (47 § 3.3): the
     release and its status, the chapters a pack may be of, the roster (38 § 4), and the person's latest pack (38 § 3). */
  const now = new Date();
  const { result, ms: loadedMs } = await timed(() => Promise.all([getHomeData(locale, null), readRosterPanel(now), latestAuditExportView(user.id, now)]));
  const [home, roster, latest] = result;
  const chapters = home.parts.flatMap((part) => part.chapters.map((chapter) => ({ digits: String(chapter.number).padStart(2, "0"), title: chapter.title })));
  return (
    <>
      <TopBar locale={locale} current="account" release={{ id: home.release.id, sha: home.release.gitSha }} session={user} compact />
      <BookManagementPage locale={locale} user={{ id: user.id, displayName: user.displayName }} release={home.release} status={home.status} sourceLang={home.sourceLang} roster={roster} audit={{ chapters, latest, today: now.toISOString() }} loadedMs={loadedMs} />
    </>
  );
}
