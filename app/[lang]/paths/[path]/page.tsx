import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { TopBar } from "@/components/chrome/TopBar";
import { PathsPage } from "@/components/paths/PathsPage";
import { getSession } from "@/lib/auth/session";
import { getPathsData } from "@/lib/db/reader-state";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";
import { PathKeySchema } from "@/lib/paths/definitions";

import { resetPath, startPath } from "../actions";

export const dynamic = "force-dynamic";

interface PathRouteProps {
  readonly params: Promise<{ lang: string; path: string }>;
}

export async function generateMetadata({ params }: PathRouteProps): Promise<Metadata> {
  const { lang, path } = await params;
  const locale = LocaleSchema.parse(lang);
  const key = PathKeySchema.safeParse(path);
  if (!key.success) return {};
  const t = await getTranslations({ locale, namespace: "paths" });
  const tn = await getTranslations({ locale, namespace: "home.continue.pathName" });
  return { title: t("metaTitleOne", { name: tn(key.data) }), alternates: { languages: { en: `/en/paths/${path}`, pt: `/pt/paths/${path}` } } };
}

/** One path, full width (feature-specs/05 § 3). */
export default async function PathRoute({ params }: PathRouteProps) {
  const { lang, path } = await params;
  const locale = LocaleSchema.parse(lang);
  const key = PathKeySchema.safeParse(path);
  if (!key.success) {
    notFound();
  }
  setRequestLocale(locale);
  const user = await getSession();
  const { result: data, ms: loadedMs } = await timed(() => getPathsData(locale, user));
  return (
    <>
      <TopBar locale={locale} current="book" release={{ id: data.release.id, sha: data.release.gitSha }} session={user} nextPath={`/${locale}/paths/${key.data}`} compact />
      <PathsPage data={data} locale={locale} loadedMs={loadedMs} only={key.data} startAction={startPath} resetAction={resetPath} />
    </>
  );
}
