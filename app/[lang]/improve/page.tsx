import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { TopBar } from "@/components/chrome/TopBar";
import { ImproveHome } from "@/components/improve/ImproveHome";
import { getSession } from "@/lib/auth/session";
import { getImproveHome } from "@/lib/db/improveHome";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";
import { SuggestionIdSchema } from "@/lib/schemas/ids";

/*
 * The Improve landing page (feature-specs/35 § 3; unit 52a): what Improve is, and for a contributor their own
 * suggestions, for a curator the queue's count. Rendered per request: it is the visitor's own list.
 */
export const dynamic = "force-dynamic";

interface ImproveRouteProps {
  readonly params: Promise<{ lang: string }>;
  /** `deleted`: the draft `Delete draft` deleted, for the `Done` notice (feature-specs/45 § 4). */
  readonly searchParams: Promise<{ deleted?: string }>;
}

export async function generateMetadata({ params }: ImproveRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "improve.home" });
  return { title: t("metaTitle"), alternates: { languages: { en: "/en/improve", pt: "/pt/improve" } } };
}

export default async function ImproveRoute({ params, searchParams }: ImproveRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const { deleted } = await searchParams;
  const user = await getSession();
  const { result, ms: loadedMs } = await timed(() => getImproveHome({ locale, user }));
  return (
    <>
      <TopBar locale={locale} current="improve" release={{ id: result.release.id, sha: result.release.gitSha }} session={user} nextPath={`/${locale}/improve`} compact />
      <ImproveHome locale={locale} data={result} loadedMs={loadedMs} deleted={deleted !== undefined && SuggestionIdSchema.safeParse(deleted).success ? deleted : undefined} />
    </>
  );
}
