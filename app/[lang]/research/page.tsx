import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";

import { SignInNotice } from "@/components/auth/SignInNotice";
import { StatusBar } from "@/components/chrome/StatusBar";
import { StatusNote } from "@/components/chrome/StatusNote";
import { TopBar } from "@/components/chrome/TopBar";
import { ResearchDock } from "@/components/research/ResearchDock";
import { ResearchStatsPanel } from "@/components/research/ResearchStatsPanel";
import { CONVERSATIONS_MAX, CONVERSATIONS_PAGE, type PageQuery } from "@/lib/assistant/links";
import { getSession } from "@/lib/auth/session";
import { monthOf } from "@/lib/db/budget";
import { getCurrentRelease } from "@/lib/db/content";
import { closedCardOf, loadResearchPage, seedCardOf } from "@/lib/db/researchPage";
import { LocaleSchema } from "@/lib/i18n/routing";
import { researchPageHref, researchPageStateOf } from "@/lib/research/links";
import { RESEARCH_RUNS_PER_DAY } from "@/lib/schemas/research";
import { RESEARCHER_GUIDE_VERSION } from "@/lib/schemas/researcher";

/*
 * The Research page (feature-specs/48 § 11; unit 72): the person's researches, the research column, and their
 * statistics, side by side — the Assistant page's three regions at their widths (spec 26), with research in them. A
 * person asks a question about the book, from scratch or seeded from an Assistant answer, watches each step as it
 * happens, and reads a report written from the web pages the research read, with every one of those pages and the
 * changes to the book it proposes.
 *
 * Its state is its URL (§ 11.1): `research` is the open research, `from` the Assistant answer a new one is seeded from,
 * `w` the statistics' window, `n` how many researches are listed, and `view`, under 1000px, which region is in front.
 * Everything is read as the signed-in person, through the tenant guard: the list, the open research, its seed and the
 * counts are theirs alone (invariant 24). The third region is the person's research statistics in the window `w`
 * names, their budget meter under them (§ 11.6; unit 73).
 *
 * A research's delete lands here with `deleted=<id>` (§ 11.8), as a conversation's lands on the Assistant page: the
 * column's session starts afresh, whatever it held, and the list says the research is gone. The column itself is never
 * keyed by it here: the id is part of the identity `ResearchDock` keys its session by, so the first start after a
 * delete, whose refresh renders the page without `deleted`, keeps what it shows — a 503's question, box and `Retry`
 * (review of unit 73). The status bar holds the cell in which `Copy report` says `copied` (§ 11.9).
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ResearchPageProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<PageQuery>;
}

export async function generateMetadata({ params }: ResearchPageProps): Promise<Metadata> {
  const locale = LocaleSchema.parse((await params).lang);
  const t = await getTranslations({ locale, namespace: "research.page" });
  return { title: t("metaTitle"), robots: { index: false }, alternates: { languages: { en: "/en/research", pt: "/pt/research" } } };
}

export default async function ResearchPage({ params, searchParams }: ResearchPageProps) {
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  const locale = LocaleSchema.parse(lang);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "research" });
  const th = await getTranslations({ locale, namespace: "home.statusbar" });

  const state = researchPageStateOf(query);
  const here = researchPageHref(locale, state);
  const [user, release] = await Promise.all([getSession(), getCurrentRelease()]);

  if (user === null) {
    return (
      <>
        <TopBar locale={locale} current="research" release={{ id: release.id, sha: release.gitSha }} session={null} nextPath={here} compact />
        <main className="assistant-page assistant-page-notice research-page">
          <SignInNotice locale={locale} next={here} />
        </main>
      </>
    );
  }

  const now = new Date();
  const data = await loadResearchPage(user, state, now);
  /* the open research always has a row (§ 11.4): one older than the listed, or not yet listed, is the column's to add */
  const listed = data.list.map((row) => ({ id: row.id, chapters: row.chapters, lastRunAt: row.lastRunAt.toISOString(), runs: row.runs, findings: row.findings, used: row.used, seeded: row.seeded, textPurged: row.textPurged }));
  const pageState = { window: state.window, listed: state.listed };
  const moreHref = data.list.length < data.conversations && state.listed < CONVERSATIONS_MAX ? researchPageHref(locale, { ...state, listed: Math.min(CONVERSATIONS_MAX, state.listed + CONVERSATIONS_PAGE) }) : null;
  const views = [
    { view: "dock", label: t("page.viewResearch") },
    { view: "conversations", label: t("page.viewConversations") },
    { view: "stats", label: t("page.viewStats") },
  ] as const;
  /* reached by a research's delete (§ 11.8): an id, as the delete put it there */
  const deleted = typeof query.deleted === "string" && UUID.test(query.deleted) ? query.deleted : null;

  return (
    <>
      <TopBar locale={locale} current="research" release={{ id: release.id, sha: release.gitSha }} session={user} nextPath={here} compact />
      {/* Under 1000px one region is in front at a time (§ 11.2): links and URL state, so the server renders the one asked for. */}
      <nav className="assistant-views" aria-label={t("page.viewLabel")}>
        <div className="seg-links">
          {views.map((entry) => (
            <Link key={entry.view} href={researchPageHref(locale, { ...state, view: entry.view })} aria-current={state.view === entry.view ? "page" : undefined}>
              {entry.label}
            </Link>
          ))}
        </div>
      </nav>
      <main className="assistant-page research-page" data-view={state.view} aria-label={t("page.title")}>
        <h1 className="sr-only">{t("page.title")}</h1>
        <ResearchDock
          locale={locale}
          releaseId={release.id}
          guideVersion={RESEARCHER_GUIDE_VERSION}
          conversationId={data.open?.id ?? null}
          openedAt={data.open?.openedAt.toISOString() ?? null}
          researchParam={state.research}
          pageState={pageState}
          initial={data.open?.runs ?? []}
          seed={data.open?.seed === null || data.open?.seed === undefined ? null : seedCardOf(data.open.seed)}
          from={data.from?.kind === "seed" ? { messageId: data.from.messageId, card: seedCardOf({ kind: "answer", messageId: data.from.messageId, view: data.from.view }), question: data.from.view.question } : null}
          fromInvalid={data.from?.kind === "invalid"}
          closed={closedCardOf(data.closed)}
          list={{ conversations: listed, total: data.conversations, moreHref }}
          exportable={data.open?.exportable ?? false}
          closedHref={researchPageHref(locale, { ...state, research: null, from: null })}
          deleted={deleted}
          findingRole={data.findingRole}
        />
        <div className="assistant-stats">
          <ResearchStatsPanel
            stats={data.stats}
            window={state.window === "all" ? { kind: "all" } : { kind: "month", month: monthOf(now) }}
            locale={locale}
            hrefs={{ month: researchPageHref(locale, { ...state, window: "month" }), all: researchPageHref(locale, { ...state, window: "all" }) }}
            keptUntil={data.keptUntil?.toISOString() ?? null}
            budget={data.budget}
          />
        </div>
      </main>
      <StatusBar className="desktop-only">
        <span>{t("page.statusList", { n: data.conversations })}</span>
        <span>{t("page.statusToday", { n: data.today, max: RESEARCH_RUNS_PER_DAY })}</span>
        <span>{th("release", { id: release.id })}</span>
        <StatusNote />
      </StatusBar>
    </>
  );
}
