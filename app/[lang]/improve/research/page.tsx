import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { TopBar } from "@/components/chrome/TopBar";
import { ResearchLog } from "@/components/improve/ResearchLog";
import { getSession } from "@/lib/auth/session";
import { getResearchLog } from "@/lib/db/researchLog";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";

/*
 * The research log (feature-specs/43 § 7.2; unit 60d): a curator's, the product's not-found page for anyone else.
 * Rendered per request.
 */
export const dynamic = "force-dynamic";

interface ResearchLogRouteProps {
  readonly params: Promise<{ lang: string }>;
}

export async function generateMetadata({ params }: ResearchLogRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "improve.researchLog" });
  return { title: t("metaTitle"), robots: { index: false }, alternates: { languages: { en: "/en/improve/research", pt: "/pt/improve/research" } } };
}

export default async function ResearchLogRoute({ params }: ResearchLogRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const user = await getSession();
  if (user === null) notFound();
  const { result, ms: loadedMs } = await timed(() => getResearchLog({ user }));
  if (result.kind === "missing") notFound();
  return (
    <>
      <TopBar locale={locale} current="improve" release={{ id: result.release.id, sha: result.release.gitSha }} session={user} nextPath={`/${locale}/improve/research`} />
      <ResearchLog locale={locale} data={result} loadedMs={loadedMs} />
    </>
  );
}
