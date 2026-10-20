import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { TopBar } from "@/components/chrome/TopBar";
import { SuggestStart } from "@/components/improve/SuggestStart";
import { getSession } from "@/lib/auth/session";
import { signInHref } from "@/lib/auth/signIn";
import { getSuggestStart } from "@/lib/db/suggestStart";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";
import { anchorKindOf, chapterDigitsOf, suggestStartHref } from "@/lib/improve/suggest";

/*
 * Step 1 of the suggest form (feature-specs/34 § 4, § 7, § 13, § 14; unit 51b): what the change is anchored to.
 * Rendered per request: it is a person's page — their role, identity and throttle — and its anchor is in the query.
 * Nothing is stored by the page; the step's button creates the draft (components/improve/CreateDraft.tsx).
 */
export const dynamic = "force-dynamic";

interface SuggestStartRouteProps {
  readonly params: Promise<{ lang: string; n: string }>;
  readonly searchParams: Promise<Record<string, string | ReadonlyArray<string> | undefined>>;
}

export async function generateMetadata({ params }: SuggestStartRouteProps): Promise<Metadata> {
  const { lang, n } = await params;
  const locale = LocaleSchema.parse(lang);
  const t = await getTranslations({ locale, namespace: "improve.suggest" });
  return { title: t("metaTitle"), robots: { index: false }, alternates: { languages: { en: `/en/ch/${n}/improve/new`, pt: `/pt/ch/${n}/improve/new` } } };
}

export default async function SuggestStartRoute({ params, searchParams }: SuggestStartRouteProps) {
  const { lang, n } = await params;
  const locale = LocaleSchema.parse(lang);
  if (!/^\d{2}$/.test(n) || Number(n) > 40) notFound();
  setRequestLocale(locale);
  const query = await searchParams;
  const anchor = typeof query.anchor === "string" ? query.anchor.trim() : "";
  const from = typeof query.from === "string" ? query.from : undefined;
  const kind = anchorKindOf(anchor);
  /* An anchor of another of the book's chapters is that chapter's page: a draft takes its chapter from its anchor
     (31 § 3). One past the book's last chapter is no chapter's: it stays here and is not found. */
  const elsewhere = kind !== null && chapterDigitsOf(anchor, kind) !== n;
  if (kind !== null && elsewhere && Number(chapterDigitsOf(anchor, kind)) <= 40) redirect(suggestStartHref(locale, anchor, kind, from ?? anchor));
  const here = kind === null || elsewhere ? `/${locale}/ch/${n}/improve/new` : suggestStartHref(locale, anchor, kind, from ?? anchor);
  const user = await getSession();
  if (user === null) redirect(signInHref(locale, here));

  const { result, ms: loadedMs } = await timed(() => getSuggestStart({ locale, n, user, kind: elsewhere ? null : kind, anchor, from, here }));
  return (
    <>
      <TopBar locale={locale} current="improve" release={{ id: result.release.id, sha: result.release.gitSha }} session={user} nextPath={here} compact />
      <SuggestStart locale={locale} chapterDigits={n} back={result.back} strip={result.strip} body={result.body} rubric={result.rubric} loadedMs={loadedMs} />
    </>
  );
}
