import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { TopBar } from "@/components/chrome/TopBar";
import { RubricPage } from "@/components/rubric/RubricPage";
import { managesBook } from "@/lib/auth/rules";
import { getSession } from "@/lib/auth/session";
import { getCurrentRelease, getHomeData } from "@/lib/db/content";
import { currentRubricVersion } from "@/lib/db/improve";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";
import { hasRubric, loadRubric } from "@/lib/rubrics/load";
import { SectionIdSchema } from "@/lib/schemas/ids";

/*
 * The Rubric page (feature-specs/30 § 6): public, the rubric in force, every number read from its published file.
 * Rendered per request: which version is in force is a row, and the page is what that version says, so a new
 * version published is a new page without a build. The file is read through the loader, hash-checked against the
 * row as the endpoint checks it (30 § 5.2); a published version whose file is not here is a fault, not a page.
 */
export const dynamic = "force-dynamic";

interface RubricRouteProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<{ from?: string }>;
}

export async function generateMetadata({ params }: RubricRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "rubric" });
  return { title: t("metaTitle"), alternates: { languages: { en: "/en/rubric", pt: "/pt/rubric" } } };
}

export default async function RubricRoute({ params, searchParams }: RubricRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const query = await searchParams;
  const from = SectionIdSchema.safeParse(query.from);
  const user = await getSession();
  const { result, ms: loadedMs } = await timed(async () => {
    const row = await currentRubricVersion();
    if (row === null) return null;
    if (!hasRubric(row.id)) throw new Error(`rubric ${row.id} is published and its file is not here`);
    const loaded = loadRubric(row.id);
    if (loaded.sha256 !== row.sha256) throw new Error(`rubric ${row.id} is published with sha256 ${row.sha256.slice(0, 12)}… and the file here is ${loaded.sha256.slice(0, 12)}…`);
    const [release, home] = await Promise.all([getCurrentRelease(), getHomeData(locale, null)]);
    return { loaded, release, chapters: home.status.chapters };
  });
  if (result === null) notFound();
  return (
    <>
      <TopBar locale={locale} current="improve" release={{ id: result.release.id, sha: result.release.gitSha }} session={user} nextPath={`/${locale}/rubric`} compact />
      <RubricPage rubric={result.loaded.rubric} sha256={result.loaded.sha256} release={{ id: result.release.id, gitSha: result.release.gitSha }} chapters={result.chapters} locale={locale} from={from.success ? from.data : null} roster={user !== null && managesBook(user.role)} loadedMs={loadedMs} />
    </>
  );
}
