import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";

import { TopBar } from "@/components/chrome/TopBar";
import { SuggestChooser } from "@/components/improve/SuggestChooser";
import { getSession } from "@/lib/auth/session";
import { signInHref } from "@/lib/auth/signIn";
import { getSuggestChooser } from "@/lib/db/suggestChooser";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";
import { chooserChapterOf, suggestChooserHref } from "@/lib/improve/suggest";

/*
 * The new-suggestion chooser (feature-specs/48 § 10.1, A11; unit 76): a chapter, then a section, then today's step 1 at
 * `/[lang]/ch/NN/improve/new?anchor=NN.k`. Rendered per request: it is a person's page — their role, identity and
 * throttle decide whether it lists anything — and `noindex`. Signed out, the sign-in with `next`, as step 1. Nothing is
 * stored: step 1's button still creates the draft.
 */
export const dynamic = "force-dynamic";

interface SuggestChooserRouteProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<Record<string, string | ReadonlyArray<string> | undefined>>;
}

export async function generateMetadata({ params }: SuggestChooserRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "improve.new" });
  return { title: t("metaTitle"), robots: { index: false }, alternates: { languages: { en: "/en/improve/new", pt: "/pt/improve/new" } } };
}

export default async function SuggestChooserRoute({ params, searchParams }: SuggestChooserRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const chapter = chooserChapterOf((await searchParams).ch);
  const here = suggestChooserHref(locale, chapter);
  const user = await getSession();
  if (user === null) redirect(signInHref(locale, here));

  const { result, ms: loadedMs } = await timed(() => getSuggestChooser({ locale, user, chapter }));
  return (
    <>
      <TopBar locale={locale} current="improve" release={{ id: result.release.id, sha: result.release.gitSha }} session={user} nextPath={here} compact />
      <SuggestChooser locale={locale} body={result.body} loadedMs={loadedMs} />
    </>
  );
}
