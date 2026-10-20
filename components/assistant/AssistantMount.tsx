import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { AskShortcut } from "@/components/assistant/AskShortcut";
import { AssistantDock } from "@/components/assistant/AssistantDock";
import { Notice } from "@/components/ui/Notice";
import { loadAids } from "@/lib/aids/index";
import { pageHref, readerSectionOf, withAsk, type PageQuery } from "@/lib/assistant/links";
import { getSession } from "@/lib/auth/session";
import { getConversation, listConversations } from "@/lib/db/assistant";
import { getDockCatalogue } from "@/lib/db/content";
import { LocaleSchema } from "@/lib/i18n/routing";
import { QUESTION_MAX } from "@/lib/schemas/api";
import { ASSISTANT_GUIDE_VERSION } from "@/lib/schemas/assistant";

/*
 * The assistant on every page (feature-specs/24 § 3). The `@assistant` slot of the locale layout renders this for
 * whatever URL the reader is on: the `a` key always, and the dock when `?ask=…` is on that URL. `ask=1` is the dock
 * with no conversation; `ask=<id>` is that conversation, and an id that is not the reader's reads as absent (the
 * guard hides it), so a foreign id is the empty state rather than an error and the dock corrects the URL itself.
 *
 * Since Assistant 2.0 the dock is given no chapter: what it needs of the book is the release's catalogue, the same on
 * every page. The page it is on decides two things only — where closing it returns to, and whether a citation can
 * open the peek, which exists beside a reader section and nowhere else.
 */

interface AssistantMountProps {
  readonly lang: string;
  /** The path under the locale, as the slot's catch-all gives it: `[]` for the home page, `["ch", "21", "21.3"]` for a section. */
  readonly path: ReadonlyArray<string>;
  readonly query: PageQuery;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function AssistantMount({ lang, path, query }: AssistantMountProps) {
  const parsed = LocaleSchema.safeParse(lang);
  if (!parsed.success) return null;
  const locale = parsed.data;
  const [first] = path;
  /* Signing in and out are not places to ask from. */
  if (first === "login" || first === "logout") return null;

  const ask = typeof query.ask === "string" ? query.ask : "";
  /* The assistant's own page holds its own dock and reads `ask` itself (feature-specs/26): here it gets the key alone. */
  if (first === "assistant" || ask.length === 0) return <AskShortcut />;

  const here = pageHref(locale, path, query);
  const readerSection = readerSectionOf(path);
  const [user, catalogue, t] = await Promise.all([getSession(), getDockCatalogue(locale), getTranslations({ locale, namespace: "assistant.dock" })]);

  /* The conversation's turns come from the same loader the endpoint uses, read as this reader (feature-specs/15 § 3). */
  const conversation = user !== null && UUID.test(ask) ? await getConversation(user, ask) : null;
  /* The log rail's earlier conversations: the reader's newest six, so five remain once the open one is dropped (17 § 5.2). */
  const earlier =
    user === null
      ? []
      : (await listConversations(user, { limit: 6 })).map((row) => ({
          id: row.id,
          citedChapters: row.citedChapters,
          lastMessageAt: row.lastMessageAt.toISOString(),
          turns: row.turns,
          passCount: row.passCount,
          refusedCount: row.refusedCount,
          textPurged: row.textPurged,
        }));
  /* A conversation pinned to a superseded release is read-only: the endpoint answers 409, and the dock says so
     rather than letting a reader type into it (feature-specs/15 § 6). */
  const pinnedRelease = conversation !== null && conversation.releaseId !== catalogue.releaseId ? conversation.releaseId : null;

  /* The rows in the shape the endpoint serves, so the dock reads one shape whether they came from here or a GET. */
  const initial = (conversation?.messages ?? []).map((message) => ({
    ...message,
    citations: [...message.citations],
    verdicts: [...message.verdicts],
    createdAt: message.createdAt.toISOString(),
  }));
  const draft = typeof query.draft === "string" && query.draft.length > 0 ? query.draft.slice(0, QUESTION_MAX) : null;

  return (
    <>
      <AskShortcut />
      <AssistantDock
        locale={locale}
        releaseId={catalogue.releaseId}
        guideVersion={ASSISTANT_GUIDE_VERSION}
        editionLang={catalogue.editionLang}
        signedIn={user !== null}
        conversationId={conversation?.id ?? null}
        askParam={ask}
        closeHref={here}
        nextPath={withAsk(here, "1")}
        initial={initial}
        pinnedRelease={pinnedRelease}
        earlier={earlier}
        catalogue={catalogue}
        aids={loadAids()}
        readerSection={readerSection}
        draft={draft}
      />
      {/* Under 768px the dock does not render (feature-specs/20 was skipped). The reader says so in its own column;
          every other page says so here. */}
      {readerSection !== null ? null : (
        <div className="dock-phone phone-only">
          <Notice title={t("phoneTitle")}>{t("phoneBody")}</Notice>
          <Link href={here} className="btn btn-sm">
            {t("close")}
          </Link>
        </div>
      )}
    </>
  );
}
