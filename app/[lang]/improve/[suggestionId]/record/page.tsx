import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { TopBar } from "@/components/chrome/TopBar";
import { ImproveRecord } from "@/components/improve/ImproveRecord";
import { getSession } from "@/lib/auth/session";
import { getImproveRecord } from "@/lib/db/improveRecord";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";
import { SuggestionIdSchema } from "@/lib/schemas/ids";

/*
 * A suggestion's record (feature-specs/35 § 5; unit 52c): its hash-chained records, the chain checked on the request,
 * and what the merge added. Rendered per request. Before a merge, the suggestion's own audience: its owner and a
 * curator of one of its parts; anyone else, signed out included, gets the not-found page (35 D2). Once merged, anyone
 * (unit 54d): the chapter's history links here.
 */
export const dynamic = "force-dynamic";

interface ImproveRecordRouteProps {
  readonly params: Promise<{ lang: string; suggestionId: string }>;
}

export async function generateMetadata({ params }: ImproveRecordRouteProps): Promise<Metadata> {
  const { lang, suggestionId } = await params;
  const locale = LocaleSchema.parse(lang);
  const t = await getTranslations({ locale, namespace: "improve.record" });
  const id = SuggestionIdSchema.safeParse(suggestionId).success ? suggestionId : "";
  return { title: t("metaTitle", { id }), robots: { index: false }, alternates: { languages: { en: `/en/improve/${id}/record`, pt: `/pt/improve/${id}/record` } } };
}

export default async function ImproveRecordRoute({ params }: ImproveRecordRouteProps) {
  const { lang, suggestionId } = await params;
  const locale = LocaleSchema.parse(lang);
  if (!SuggestionIdSchema.safeParse(suggestionId).success) notFound();
  setRequestLocale(locale);
  const user = await getSession();

  const { result, ms: loadedMs } = await timed(() => getImproveRecord({ locale, user, id: suggestionId }));
  if (result.kind === "missing") notFound();
  /* A draft has no record yet: it is written on its edit page. */
  if (result.kind === "draft") redirect(`/${locale}/improve/${suggestionId}/edit`);
  const { release } = result.context.page;
  return (
    <>
      <TopBar locale={locale} current="improve" release={{ id: release.id, sha: release.gitSha }} session={user} nextPath={`/${locale}/improve/${suggestionId}/record`} compact />
      <ImproveRecord locale={locale} id={suggestionId} data={result} curator={user?.displayName ?? null} loadedMs={loadedMs} />
    </>
  );
}
