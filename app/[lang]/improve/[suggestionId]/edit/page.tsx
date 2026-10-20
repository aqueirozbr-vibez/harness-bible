import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { TopBar } from "@/components/chrome/TopBar";
import { SuggestEdit } from "@/components/improve/SuggestEdit";
import { getSession } from "@/lib/auth/session";
import { signInHref } from "@/lib/auth/signIn";
import { getSuggestEdit } from "@/lib/db/suggestEdit";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";
import { SuggestionIdSchema } from "@/lib/schemas/ids";

/*
 * The suggest form's edit page (feature-specs/34 § 5, § 7; unit 51c): the draft being written, where step 1's
 * `Create draft` lands. Rendered per request: it is the owner's page of their own draft. The page reads; the
 * editor's saves are `PATCH /api/v1/suggestions/{id}` (lib/hooks/draftSave.ts).
 */
export const dynamic = "force-dynamic";

interface SuggestEditRouteProps {
  readonly params: Promise<{ lang: string; suggestionId: string }>;
}

export async function generateMetadata({ params }: SuggestEditRouteProps): Promise<Metadata> {
  const { lang, suggestionId } = await params;
  const locale = LocaleSchema.parse(lang);
  const t = await getTranslations({ locale, namespace: "improve.suggest.edit" });
  const id = SuggestionIdSchema.safeParse(suggestionId).success ? suggestionId : "";
  return { title: t("metaTitle", { id }), robots: { index: false }, alternates: { languages: { en: `/en/improve/${id}/edit`, pt: `/pt/improve/${id}/edit` } } };
}

export default async function SuggestEditRoute({ params }: SuggestEditRouteProps) {
  const { lang, suggestionId } = await params;
  const locale = LocaleSchema.parse(lang);
  if (!SuggestionIdSchema.safeParse(suggestionId).success) notFound();
  setRequestLocale(locale);
  const here = `/${locale}/improve/${suggestionId}/edit`;
  const user = await getSession();
  if (user === null) redirect(signInHref(locale, here));

  const { result, ms: loadedMs } = await timed(() => getSuggestEdit({ locale, user, id: suggestionId }));
  if (result.kind === "missing") notFound();
  /* A suggestion past draft is read on its own page (spec 35). */
  if (result.kind === "submitted") redirect(`/${locale}/improve/${suggestionId}`);
  return (
    <>
      <TopBar locale={locale} current="improve" release={{ id: result.release.id, sha: result.release.gitSha }} session={user} nextPath={here} compact />
      <SuggestEdit locale={locale} id={suggestionId} data={result} loadedMs={loadedMs} />
    </>
  );
}
