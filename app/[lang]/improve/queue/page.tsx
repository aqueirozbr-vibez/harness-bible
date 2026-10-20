import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { TopBar } from "@/components/chrome/TopBar";
import { CuratorQueue } from "@/components/improve/CuratorQueue";
import { getSession } from "@/lib/auth/session";
import { getQueuePage } from "@/lib/db/queuePage";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";
import { SuggestionIdSchema } from "@/lib/schemas/ids";

/*
 * The curator queue's page (feature-specs/36 § 4; unit 53b): a curator's, the product's not-found page for anyone
 * else (36 § 8). Rendered per request; the selected suggestion is `?s=`.
 */
export const dynamic = "force-dynamic";

interface QueueRouteProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<{ s?: string }>;
}

export async function generateMetadata({ params }: QueueRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "improve.queue" });
  return { title: t("metaTitle"), robots: { index: false }, alternates: { languages: { en: "/en/improve/queue", pt: "/pt/improve/queue" } } };
}

export default async function QueueRoute({ params, searchParams }: QueueRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const user = await getSession();
  if (user === null) notFound();
  const asked = (await searchParams).s;
  const { result, ms: loadedMs } = await timed(() => getQueuePage({ locale, user, selectedId: asked !== undefined && SuggestionIdSchema.safeParse(asked).success ? asked : null }));
  if (result.kind === "missing") notFound();
  return (
    <>
      <TopBar locale={locale} current="improve" release={{ id: result.release.id, sha: result.release.gitSha }} session={user} nextPath={`/${locale}/improve/queue`} compact />
      <CuratorQueue locale={locale} data={result} curator={user.displayName} loadedMs={loadedMs} />
    </>
  );
}
