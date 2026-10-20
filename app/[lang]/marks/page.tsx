import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { TopBar } from "@/components/chrome/TopBar";
import { MarksPage, type MarksActionError } from "@/components/marks/MarksPage";
import { getSession } from "@/lib/auth/session";
import { getMarksData } from "@/lib/db/marks";
import { timed } from "@/lib/db/timing";
import { LocaleSchema } from "@/lib/i18n/routing";
import { SectionIdSchema } from "@/lib/schemas/ids";

import { deleteNoteFromList, removeBookmark } from "./actions";

/* Every row is per user: the page renders per request (feature-specs/07 § 3). No loading boundary: it would mask the no-JS path (05, 06). */
export const dynamic = "force-dynamic";

interface MarksRouteProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<{ error?: string; removed?: string; deleted?: string }>;
}

const ACTION_ERRORS: ReadonlySet<string> = new Set(["session", "remove", "delete"]);

function sectionOrUndefined(value: string | undefined): string | undefined {
  return value !== undefined && SectionIdSchema.safeParse(value).success ? value : undefined;
}

export async function generateMetadata({ params }: MarksRouteProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "marks" });
  return { title: t("metaTitle"), robots: { index: false }, alternates: { languages: { en: "/en/marks", pt: "/pt/marks" } } };
}

export default async function MarksRoute({ params, searchParams }: MarksRouteProps) {
  const locale = LocaleSchema.parse((await params).lang);
  setRequestLocale(locale);
  const { error, removed, deleted } = await searchParams;
  const user = await getSession();
  const { result: data, ms: loadedMs } = await timed(() => getMarksData(locale, user));
  return (
    <>
      <TopBar locale={locale} current="book" release={{ id: data.release.id, sha: data.release.gitSha }} session={user} nextPath={`/${locale}/marks`} compact />
      <MarksPage
        data={data}
        locale={locale}
        loadedMs={loadedMs}
        error={error !== undefined && ACTION_ERRORS.has(error) ? (error as MarksActionError) : undefined}
        removed={sectionOrUndefined(removed)}
        deleted={sectionOrUndefined(deleted)}
        removeAction={removeBookmark}
        deleteAction={deleteNoteFromList}
      />
    </>
  );
}
