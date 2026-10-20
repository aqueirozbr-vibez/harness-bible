import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";

import { AssistantDock } from "@/components/assistant/AssistantDock";
import { StatsPanel } from "@/components/assistant/StatsPanel";
import { SignInNotice } from "@/components/auth/SignInNotice";
import { StatusBar } from "@/components/chrome/StatusBar";
import { TopBar } from "@/components/chrome/TopBar";
import { loadAids } from "@/lib/aids/index";
import { assistantPageHref, assistantPageStateOf, CONVERSATIONS_MAX, CONVERSATIONS_PAGE, type PageQuery } from "@/lib/assistant/links";
import { getSession } from "@/lib/auth/session";
import { budgetView } from "@/lib/budget/view";
import { conversationStats, getConversation, listConversations, TEXT_RETENTION_DAYS, type ConversationView } from "@/lib/db/assistant";
import { readerStats } from "@/lib/db/assistantStats";
import { budgetFacts, monthOf } from "@/lib/db/budget";
import { getCurrentRelease, getDockCatalogue } from "@/lib/db/content";
import { env } from "@/lib/env";
import { LocaleSchema } from "@/lib/i18n/routing";
import { QUESTION_MAX } from "@/lib/schemas/api";
import { ASSISTANT_GUIDE_VERSION } from "@/lib/schemas/assistant";

/*
 * The assistant's page (feature-specs/26): the reader's conversations, the dock, and their own statistics, side by
 * side. It is three existing things at their existing widths — the log rail grown into a tree of every conversation
 * (232px), the dock as the main column, an instrument rail (330px) — and it opens ready for a question about the
 * book, with no chapter to open first.
 *
 * Its state is its URL (§ 3). `ask` is the open conversation, with the meaning the dock gives it on every other
 * page: a conversation is created by its first question while the answer streams, the dock records the id with
 * `replaceState`, and a refresh of this one route keeps the dock and its turns where a second route would have
 * mounted another page under them. `w` is the statistics window, `n` how many conversations are listed, and `view`,
 * under 1000px, which region is in front.
 *
 * Everything here is read as the signed-in reader, through the tenant guard: the list, the open conversation and
 * the statistics are theirs alone (invariant 24).
 */
export const dynamic = "force-dynamic";

interface AssistantPageProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<PageQuery>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: AssistantPageProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "assistant.page" });
  return { title: t("metaTitle"), robots: { index: false }, alternates: { languages: { en: "/en/assistant", pt: "/pt/assistant" } } };
}

/** The open conversation's line when it is older than the listed ones, counted as `listConversations` counts. */
function lineOf(conversation: ConversationView) {
  const answers = conversation.messages.filter((message) => message.role === "ASSISTANT");
  return {
    id: conversation.id,
    citedChapters: [...new Set(answers.flatMap((message) => message.citations.map((citation) => Number(citation.sectionId.slice(0, 2)))).filter((chapter) => Number.isInteger(chapter)))],
    lastMessageAt: (conversation.messages.at(-1)?.createdAt ?? conversation.createdAt).toISOString(),
    turns: answers.length,
    passCount: answers.filter((message) => message.refusal === null && message.verdicts.every((verdict) => verdict.verdict === "PASS" || verdict.verdict === "NA")).length,
    refusedCount: answers.filter((message) => message.refusal !== null).length,
    textPurged: conversation.textPurgedAt !== null,
  };
}

export default async function AssistantPage({ params, searchParams }: AssistantPageProps) {
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  const locale = LocaleSchema.parse(lang);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "assistant.page" });
  const th = await getTranslations({ locale, namespace: "home.statusbar" });

  const state = assistantPageStateOf(query);
  const here = assistantPageHref(locale, state);
  const [user, release] = await Promise.all([getSession(), getCurrentRelease()]);

  if (user === null) {
    return (
      <>
        <TopBar locale={locale} current="assistant" release={{ id: release.id, sha: release.gitSha }} session={null} nextPath={here} compact />
        <main className="assistant-page assistant-page-notice">
          <SignInNotice locale={locale} next={here} />
        </main>
      </>
    );
  }

  const now = new Date();
  const principal = user.organisationId === null ? { userId: user.id } : { organisationId: user.organisationId };
  const [catalogue, conversation, rows, counts, stats, facts] = await Promise.all([
    getDockCatalogue(locale),
    /* A foreign or unknown id reads as absent (the guard hides it): the dock is empty and takes the parameter off the URL. */
    state.ask !== null && UUID.test(state.ask) ? getConversation(user, state.ask) : Promise.resolve(null),
    listConversations(user, { limit: state.listed }),
    conversationStats(user),
    readerStats(user, state.window === "all" ? { kind: "all" } : { kind: "month", month: monthOf(now) }),
    budgetFacts(principal, now, env.INDIVIDUAL_TOKEN_CAP === undefined ? null : Number(env.INDIVIDUAL_TOKEN_CAP)),
  ]);

  const line = (row: (typeof rows)[number]) => ({ id: row.id, citedChapters: row.citedChapters, lastMessageAt: row.lastMessageAt.toISOString(), turns: row.turns, passCount: row.passCount, refusedCount: row.refusedCount, textPurged: row.textPurged });
  /* The open conversation always has a row (§ 5): one older than the listed stands first. */
  const listed = conversation !== null && !rows.some((row) => row.id === conversation.id) ? [lineOf(conversation), ...rows.map(line)] : rows.map(line);
  const moreHref = rows.length < counts.conversations && state.listed < CONVERSATIONS_MAX ? assistantPageHref(locale, { ...state, listed: Math.min(CONVERSATIONS_MAX, state.listed + CONVERSATIONS_PAGE) }) : null;

  /* The page with no conversation open: where `New conversation` leads, and what the dock's own links are built on. */
  const closed = assistantPageHref(locale, { ...state, ask: null });
  const initial = (conversation?.messages ?? []).map((message) => ({ ...message, citations: [...message.citations], verdicts: [...message.verdicts], createdAt: message.createdAt.toISOString() }));
  const draft = typeof query.draft === "string" && query.draft.length > 0 ? query.draft.slice(0, QUESTION_MAX) : null;
  /* a conversation's delete lands here with its id (feature-specs/45 § 3.9): each one mounts the dock afresh, whatever this session held (review of unit 62) */
  const deleted = typeof query.deleted === "string" && UUID.test(query.deleted) ? query.deleted : null;
  const views = [
    { view: "dock", label: t("viewDock") },
    { view: "conversations", label: t("viewConversations") },
    { view: "stats", label: t("viewStats") },
  ] as const;

  return (
    <>
      <TopBar locale={locale} current="assistant" release={{ id: release.id, sha: release.gitSha }} session={user} nextPath={here} compact />
      {/* Under 1000px one region is in front at a time (§ 6): links and URL state, so the server renders the one asked for. */}
      <nav className="assistant-views" aria-label={t("viewLabel")}>
        <div className="seg-links">
          {views.map((entry) => (
            <Link key={entry.view} href={assistantPageHref(locale, { ...state, view: entry.view })} aria-current={state.view === entry.view ? "page" : undefined}>
              {entry.label}
            </Link>
          ))}
        </div>
      </nav>
      <main className="assistant-page" data-view={state.view} aria-label={t("title")}>
        <h1 className="sr-only">{t("title")}</h1>
        <AssistantDock
          key={deleted ?? "page"}
          variant="page"
          locale={locale}
          releaseId={catalogue.releaseId}
          guideVersion={ASSISTANT_GUIDE_VERSION}
          editionLang={catalogue.editionLang}
          signedIn
          conversationId={conversation?.id ?? null}
          /* `1` is the dock with no conversation, which is what this page is without `ask`. */
          askParam={state.ask ?? "1"}
          closeHref={closed}
          nextPath={closed}
          initial={initial}
          pinnedRelease={conversation !== null && conversation.releaseId !== release.id ? conversation.releaseId : null}
          earlier={[]}
          catalogue={catalogue}
          aids={loadAids()}
          readerSection={null}
          draft={draft}
          list={{ conversations: listed, total: counts.conversations, moreHref }}
          deleted={deleted !== null}
        />
        <div className="assistant-stats">
          <StatsPanel
            stats={stats}
            locale={locale}
            releaseId={release.id}
            hrefs={{ month: assistantPageHref(locale, { ...state, window: "month" }), all: assistantPageHref(locale, { ...state, window: "all" }) }}
            keptUntil={counts.oldestTextAt === null ? null : new Date(counts.oldestTextAt.getTime() + TEXT_RETENTION_DAYS * 86_400_000).toISOString()}
            budget={budgetView(facts, now)}
          />
        </div>
      </main>
      <StatusBar className="desktop-only">
        <span>{t("statusList", { n: counts.conversations })}</span>
        <span>{th("release", { id: release.id })}</span>
      </StatusBar>
    </>
  );
}
