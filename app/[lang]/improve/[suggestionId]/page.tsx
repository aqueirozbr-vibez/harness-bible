import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { TopBar } from "@/components/chrome/TopBar";
import { ImproveOutcome } from "@/components/improve/ImproveOutcome";
import { getSession } from "@/lib/auth/session";
import { getImproveOutcome } from "@/lib/db/improveOutcome";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";
import { SuggestionIdSchema } from "@/lib/schemas/ids";

/*
 * A suggestion's own page, the adjudication page (feature-specs/35 § 4; unit 52b): where a submission lands and the
 * landing page's rows link. Rendered per request. The owner and a curator of one of its parts read it; anyone else,
 * signed out included, gets the not-found page, since a suggestion is not public until it is merged.
 */
export const dynamic = "force-dynamic";

interface ImproveOutcomeRouteProps {
  readonly params: Promise<{ lang: string; suggestionId: string }>;
}

export async function generateMetadata({ params }: ImproveOutcomeRouteProps): Promise<Metadata> {
  const { lang, suggestionId } = await params;
  const locale = LocaleSchema.parse(lang);
  const t = await getTranslations({ locale, namespace: "improve.outcome" });
  const id = SuggestionIdSchema.safeParse(suggestionId).success ? suggestionId : "";
  return { title: t("metaTitle", { id }), robots: { index: false }, alternates: { languages: { en: `/en/improve/${id}`, pt: `/pt/improve/${id}` } } };
}

export default async function ImproveOutcomeRoute({ params }: ImproveOutcomeRouteProps) {
  const { lang, suggestionId } = await params;
  const locale = LocaleSchema.parse(lang);
  if (!SuggestionIdSchema.safeParse(suggestionId).success) notFound();
  setRequestLocale(locale);
  const user = await getSession();
  if (user === null) notFound();

  const { result, ms: loadedMs } = await timed(() => getImproveOutcome({ locale, user, id: suggestionId }));
  if (result.kind === "missing") notFound();
  /* A draft is written on its edit page. */
  if (result.kind === "draft") redirect(`/${locale}/improve/${suggestionId}/edit`);
  const { release } = result.context.page;
  return (
    <>
      <TopBar locale={locale} current="improve" release={{ id: release.id, sha: release.gitSha }} session={user} nextPath={`/${locale}/improve/${suggestionId}`} compact />
      <ImproveOutcome locale={locale} id={suggestionId} data={result} loadedMs={loadedMs} />
    </>
  );
}
