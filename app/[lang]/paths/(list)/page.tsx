import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { TopBar } from "@/components/chrome/TopBar";
import { PathsPage, type PathsActionError } from "@/components/paths/PathsPage";
import { getSession } from "@/lib/auth/session";
import { getPathsData } from "@/lib/db/reader-state";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";

import { resetPath, startPath } from "../actions";

/* Progress is per user: the page renders per request; the release content behind it is cached (feature-specs/05 § 3).
   The page sits in a route group so its loading boundary does not wrap `[path]` and mask that route's 404. */
export const dynamic = "force-dynamic";

interface PathsRouteProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<{ error?: string }>;
}

const ACTION_ERRORS: ReadonlySet<string> = new Set(["session", "start", "reset"]);

export async function generateMetadata({ params }: PathsRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "paths" });
  return { title: t("metaTitle"), alternates: { languages: { en: "/en/paths", pt: "/pt/paths" } } };
}

export default async function PathsRoute({ params, searchParams }: PathsRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const { error } = await searchParams;
  const user = await getSession();
  const { result: data, ms: loadedMs } = await timed(() => getPathsData(locale, user));
  return (
    <>
      <TopBar locale={locale} current="book" release={{ id: data.release.id, sha: data.release.gitSha }} session={user} nextPath={`/${locale}/paths`} compact />
      <PathsPage data={data} locale={locale} loadedMs={loadedMs} error={error !== undefined && ACTION_ERRORS.has(error) ? (error as PathsActionError) : undefined} startAction={startPath} resetAction={resetPath} />
    </>
  );
}
