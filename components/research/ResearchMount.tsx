import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { ResearchDock } from "@/components/research/ResearchDock";
import { ResearchShortcut } from "@/components/research/ResearchShortcut";
import { Notice } from "@/components/ui/Notice";
import type { PageQuery } from "@/lib/assistant/links";
import { getSession } from "@/lib/auth/session";
import { getCurrentRelease } from "@/lib/db/content";
import { closedCardOf, loadResearchDock, seedCardOf } from "@/lib/db/researchPage";
import { LocaleSchema } from "@/lib/i18n/routing";
import { researchDockCloseHref, researchPageHref } from "@/lib/research/links";
import { RESEARCHER_GUIDE_VERSION } from "@/lib/schemas/researcher";

/*
 * The Research dock on every page (feature-specs/48 § 12, A9; unit 77), `AssistantMount`'s pattern. The `@assistant`
 * slot renders it beside `AssistantMount` for whatever URL the person is on — the slot keeps its name, since renaming it
 * would move every file of the slot for no behaviour: the `r` key always, and the dock when `?research=…` is on that URL.
 * `research=1` is the dock with no research; `research=<id>` is that research, and an id that is not the person's reads
 * as absent (the tenant guard hides it), so a foreign id is the empty dock and the dock corrects the URL itself.
 *
 * Whose parameter is whose (§ 12): `research` is the dock's on every path but `/research`, whose own column it opens, so
 * there this renders the key alone, as `AssistantMount` does on `/assistant`. Sign-in and sign-out render nothing, as
 * `AssistantMount` has them: they are not places to research from, and a key there would put `research=1` on a URL
 * that shows no dock. One dock at a time: the dock renders only while the Assistant's is not open — `ask` absent, or the
 * path `/assistant`, where `ask` is the page's own conversation — so a hand-made URL with both dock parameters shows the
 * Assistant's.
 *
 * Under 768px the dock does not render (§ 12, ui-context § 10): `.dock-phone` says so, with the Research page, which works
 * on a phone, and the close. The reader does not say it in its own column, as it does for the Assistant: the reader knows
 * nothing of research's parameter, and this notice stands on every page alike.
 */

interface ResearchMountProps {
  readonly lang: string;
  /** The path under the locale, as the slot's catch-all gives it: `[]` for the home page, `["ch", "21", "21.3"]` for a section. */
  readonly path: ReadonlyArray<string>;
  readonly query: PageQuery;
}

export async function ResearchMount({ lang, path, query }: ResearchMountProps) {
  const parsed = LocaleSchema.safeParse(lang);
  if (!parsed.success) return null;
  const locale = parsed.data;
  const [first] = path;
  /* Signing in and out are not places to research from. */
  if (first === "login" || first === "logout") return null;

  const research = typeof query.research === "string" ? query.research : "";
  const ask = typeof query.ask === "string" ? query.ask : "";
  /* the Research page holds its own column and reads `research` itself; the Assistant's dock open elsewhere wins (§ 12) */
  if (first === "research" || research.length === 0 || (ask.length > 0 && first !== "assistant")) return <ResearchShortcut />;

  const here = researchDockCloseHref(locale, path, query);
  const now = new Date();
  const [user, release, t] = await Promise.all([getSession(), getCurrentRelease(), getTranslations({ locale, namespace: "research.dock" })]);
  /* the open research, the composer's closed states and the person's role to their findings, read as the page reads them */
  const data = await loadResearchDock(user, research, now);
  const open = data.open;

  return (
    <>
      <ResearchShortcut />
      <ResearchDock
        variant="dock"
        locale={locale}
        releaseId={release.id}
        guideVersion={RESEARCHER_GUIDE_VERSION}
        signedIn={user !== null}
        conversationId={open?.id ?? null}
        openedAt={open?.openedAt.toISOString() ?? null}
        researchParam={research}
        initial={open?.runs ?? []}
        seed={open?.seed === null || open?.seed === undefined ? null : seedCardOf(open.seed)}
        closed={closedCardOf(data.closed)}
        findingRole={data.findingRole}
        closeHref={here}
      />
      {/* Under 768px the dock does not render: the Research page does, at every width (§ 11.2). */}
      <div className="dock-phone phone-only">
        <Notice title={t("phoneTitle")}>{t("phoneBody")}</Notice>
        <div className="row">
          <Link href={researchPageHref(locale, { research: open?.id ?? null })} className="btn btn-sm">
            {t("openFull")}
          </Link>
          <Link href={here} className="btn btn-sm">
            {t("close")}
          </Link>
        </div>
      </div>
    </>
  );
}
