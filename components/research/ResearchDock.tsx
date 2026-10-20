"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Composer } from "@/components/assistant/Composer";
import { SignInNotice } from "@/components/auth/SignInNotice";
import { ResearchConversations } from "@/components/research/ResearchConversations";
import { RunBlock } from "@/components/research/RunBlock";
import { SeedCard, type SeedCardData } from "@/components/research/SeedCard";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { ErrorBox } from "@/components/ui/ErrorBox";
import { IconButton } from "@/components/ui/IconButton";
import { Notice } from "@/components/ui/Notice";
import { returnDockFocus } from "@/lib/hooks/dockOpener";
import { useRunFollow } from "@/lib/hooks/useRunFollow";
import { formatDayMonth, formatTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { FindingRole } from "@/lib/research/findingAction";
import { researchPageHref, withResearch, type ResearchRefBase } from "@/lib/research/links";
import { runUnderWay } from "@/lib/research/runBlock";
import { lineOfRuns, type ResearchConversationLine } from "@/lib/research/summary";
import { ResearchConversationSchema, ResearchRunStartedSchema, ResearchRunViewSchema, type ResearchRunView } from "@/lib/schemas/api";
import { RESEARCH_RUNS_PER_DAY } from "@/lib/schemas/research";

/*
 * The Research page's column (feature-specs/48 § 11.3; unit 72): the open research's runs in a log, the composer under
 * them. A client component because a run is followed while it is under way and a question is started from here; the
 * only thing it shares with the page is the URL — `?research=<id>` is the open research, `?from=<messageId>` the
 * Assistant answer a new one is seeded from. The page's form (`variant="page"`) is the static main column between the
 * person's researches and the statistics, so it has no close and no `Esc`.
 *
 * Its dock form (`variant="dock"`, § 12; unit 77) is the Research dock on every other page, which `ResearchMount`
 * renders in the `@assistant` slot when the page's URL carries `research`: the same log, run blocks and composer, the
 * header's `Open the Research page` and close instead of the researches' toggle, and no list, no seed before Start
 * (`from` is never a dock's) and no delete (spec 45 § 10's reason: the dock's window-level `Esc`). It lies over the page
 * at every width from 768px with the backdrop that closes it, beside a reader section too: the reader's grid makes room
 * for the Assistant because its answers highlight the passages they cite, and research highlights nothing. `Esc` closes
 * it, as the Assistant's dock (`AssistantDock`), standing back while a panel or a dialog answers the same key itself, and
 * the focus goes back to what had it when `r` opened the dock (`lib/hooks/dockOpener.ts`). Its URL is the page's own
 * with `research` — `1` before the first Start, the research's id after it — and its links into the book carry it, so
 * the dock stays open where they lead (`researchRefHref`). Signed out, it shows the sign-in notice with the form disabled.
 *
 * The frame says what the column is before a word is typed: `reads the web`, the release and the researcher's guide in
 * the header, and the line under it — not part of the book, from the web, checked by code and not by Improve.
 *
 * Starting a run (§ 11.3): the first Start opens the research (`POST /research/conversations`, with the seed's id where
 * there is one) and records its id on the URL by `replaceState`, as the Assistant's dock does, so a reload finds it and
 * nothing re-renders under the start; then it posts the run with an `Idempotency-Key` kept across retries of one body,
 * reads the run's view, and refreshes the router so the list and the statistics move. The run is then followed every
 * 2 s while it is under way (`useRunFollow`), and the router refreshed once more when it ends. While a run of the
 * research is under way the composer is busy, not disabled: the field keeps its focus and only `Start` waits (§ 20).
 *
 * A start that did not start (unit 72's review) gives the question back to the field with its language, whatever the
 * answer, and says why in an `ErrorBox` the log announces; its `Retry` submits the form again, so it posts what the
 * field holds. An answer that closes the composer (402 the budget, 429 the day's thirty, 403 the organisation's switch)
 * disables the field the focus was in, so the focus goes to that box. And once the research exists, any answer
 * refreshes the router: the list then has the research's own row, and a 503 the run it left `SKIPPED · UNAVAILABLE`.
 *
 * Since unit 73 the list's open block offers the research's export where the page found a record to export, and its
 * delete, which leads to `closedHref` with `?deleted=<id>`: the column's session then starts afresh, the researches'
 * overlay standing open between 1000px and 1359px to show the line that says so, and the composer leaves the focus to
 * `New research` (§ 11.8, § 20). Since unit 74 each finding carries its button by the person's role, which the page reads
 * (`findingRole`), and follows its own send (FindingAction).
 *
 * Nothing here reaches the workers or the gateway: every call goes to `/api/v1` (invariant 23).
 */

/** Why Start is refused before anything is spent, as the page read it or a start's answer said (§ 18). */
export type ResearchClosed = { readonly kind: "unavailable" } | { readonly kind: "offOrganisation" } | { readonly kind: "budget"; readonly resetsAt: string } | { readonly kind: "dailyLimit"; readonly until: string };

/** What the page's column and the dock share (§ 11.3, § 12). */
interface ResearchColumnProps {
  readonly locale: Locale;
  readonly releaseId: string;
  readonly guideVersion: string;
  /** The open research, when the URL names one of the person's; null is the empty column. */
  readonly conversationId: string | null;
  /** When the open research was opened: its line's instant while it has no run and the server has not listed it. */
  readonly openedAt: string | null;
  /** `research` as it stands on the URL: null or `1` is the empty column, anything else named a research. */
  readonly researchParam: string | null;
  /** The open research's runs as the endpoint serves them, oldest first. */
  readonly initial: ReadonlyArray<ResearchRunView>;
  /** The open research's seed, above its first question; null for one from scratch. */
  readonly seed: SeedCardData | null;
  readonly closed: ResearchClosed | null;
  /** Who the person is to their findings (§ 8.1; unit 74): they draft, the throttle pauses them, or they send. */
  readonly findingRole: FindingRole;
}

/** The Research page's column (§ 11): between the person's researches and the statistics, for a signed-in person. */
interface ResearchPageForm {
  readonly variant?: "page";
  /** The page's own state besides the open research: what every link of the column keeps. */
  readonly pageState: { readonly window: "month" | "all"; readonly listed: number };
  /** `?from=`: the answer a new research would be seeded from, its card and its question for the composer. */
  readonly from: { readonly messageId: string; readonly card: SeedCardData; readonly question: string | null } | null;
  /** `?from=` named no answer that can start a research: the notice, and the parameter dropped. */
  readonly fromInvalid: boolean;
  readonly list: { readonly conversations: ReadonlyArray<ResearchConversationLine>; readonly total: number; readonly moreHref: string | null };
  /** The open research has a record to export (§ 11.10): its `Export JSONL` is offered. */
  readonly exportable: boolean;
  /** The page with no research open, with its window, its list and the region in front: where a delete leads, `deleted=<id>` added (§ 11.8). */
  readonly closedHref: string;
  /** The research whose delete led here (`?deleted=<id>`, § 11.8); null when the page was not reached by one. */
  readonly deleted: string | null;
}

/** The Research dock (§ 12; unit 77): over any page but the Research page and sign-in and sign-out. */
interface ResearchDockForm {
  readonly variant: "dock";
  readonly signedIn: boolean;
  /** The page's own URL without `research`: closing the dock goes there. It may carry parameters of its own, the Assistant page's `ask` among them. */
  readonly closeHref: string;
}

export type ResearchDockProps = ResearchColumnProps & (ResearchPageForm | ResearchDockForm);

/*
 * One column, one research at a time. A research is opened by its first question while the page stays where it is: its
 * id reaches the URL through `replaceState`, and the server learns of it on the next refresh. So when the server's
 * `conversationId` changes there are two cases: the research this session opened itself (the URL caught up, and the
 * runs on screen stay), or anything else — another research picked from the list, a new one, another seed — and the
 * session starts again from the server's rows. The key is what tells React which.
 *
 * A delete's landing (`?deleted=<id>`, § 11.8) is part of the identity, never a key of the page's (review of unit 73):
 * it starts the session afresh even for a research this session opened that the server had not caught up with, and
 * leaving it is a change like any other — the first start after it, whose refresh renders the page without `deleted`,
 * is the research this session opened catching up, so a 503's question, box and `Retry` stay; `New research` starts
 * again, the overlay the delete opened closed.
 */
export function ResearchDock(props: ResearchDockProps) {
  const page = props.variant === "dock" ? null : props;
  const identity = `${props.conversationId ?? "none"}:${page?.from?.messageId ?? ""}:${page?.deleted ?? ""}`;
  const [slot, setSlot] = useState<{ readonly key: number; readonly seen: string; readonly opened: string | null }>({ key: 0, seen: identity, opened: null });
  if (identity !== slot.seen) {
    const caughtUp = props.conversationId !== null && props.conversationId === slot.opened;
    setSlot({ key: caughtUp ? slot.key : slot.key + 1, seen: identity, opened: caughtUp ? slot.opened : null });
  }
  const onOpened = useCallback((id: string) => setSlot((current) => ({ ...current, opened: id })), []);
  return <ResearchSession key={slot.key} {...props} onOpened={onOpened} />;
}

/** The server's runs taken in: one the session lacks is added, and one the session still follows takes the server's end. */
function mergedRuns(current: ReadonlyArray<ResearchRunView>, server: ReadonlyArray<ResearchRunView>): ReadonlyArray<ResearchRunView> {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of server) {
    const held = byId.get(run.id);
    if (held === undefined || (runUnderWay(held) && !runUnderWay(run))) byId.set(run.id, run);
  }
  return [...byId.values()].sort((a, b) => a.ordinal - b.ordinal);
}

/** A question asked and not yet a run: shown at once in the run's own block, under the ordinal it will take. */
function pendingRun(asked: { readonly text: string; readonly at: string; readonly language: Locale }, ordinal: number): ResearchRunView {
  return {
    id: "pending",
    conversationId: "pending",
    ordinal,
    question: asked.text,
    language: asked.language,
    seeded: false,
    state: "QUEUED",
    line: { key: "queued", tone: "run" },
    stale: false,
    refusal: null,
    resetsAt: null,
    steps: [],
    sections: [],
    report: null,
    pages: [],
    findings: [],
    usage: { searches: 0, pagesOpened: 0, pagesSeen: null, costUsd: null },
    flag: null,
    createdAt: asked.at,
    finishedAt: null,
    textPurged: false,
  };
}

interface Failure {
  readonly code: string;
  readonly message: string;
}

/** The codes worth a `Retry` with the same key: the start did not happen, and asking again may work (§ 18). */
const RETRYABLE: ReadonlySet<string> = new Set(["RESEARCH_UNAVAILABLE", "INTERNAL", "NETWORK"]);

function ResearchSession(props: ResearchDockProps & { readonly onOpened: (id: string) => void }) {
  const { locale, releaseId, guideVersion, conversationId, openedAt: openedByPage, researchParam, initial, seed, closed: closedByPage, findingRole, onOpened } = props;
  /* the page's own props, or the dock's (§ 12): the dock has no list, no seed before Start, no delete */
  const page = props.variant === "dock" ? null : props;
  const closeHref = props.variant === "dock" ? props.closeHref : null;
  const signedIn = props.variant === "dock" ? props.signedIn : true;
  const pageState = page?.pageState ?? null;
  const from = page?.from ?? null;
  const fromInvalid = page?.fromInvalid ?? false;
  const deleted = page?.deleted ?? null;
  const t = useTranslations("research");
  const tbudget = useTranslations("account.budget");
  const router = useRouter();
  const [runs, setRuns] = useState<ReadonlyArray<ResearchRunView>>(initial);
  /* the server's rows after a refresh: a run started elsewhere, or one whose view this session could not read */
  const [seenInitial, setSeenInitial] = useState(initial);
  if (seenInitial !== initial) {
    setSeenInitial(initial);
    setRuns((current) => mergedRuns(current, initial));
  }
  const [conversation, setConversation] = useState<string | null>(conversationId);
  /* when the open research was opened, as the page read it or as its open's 201 answered: its line's instant until it has a run */
  const [openedAt, setOpenedAt] = useState<string | null>(openedByPage);
  const [asked, setAsked] = useState<{ readonly text: string; readonly at: string; readonly language: Locale } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  /* the question of a start that did not start: given back to the field, a new object each time (Composer's `restore`) */
  const [retry, setRetry] = useState<{ readonly text: string; readonly language: Locale } | null>(null);
  /* a start's answer can close the composer as the page would have: the cap met, the day's thirty, the switch off */
  const [closedByStart, setClosedByStart] = useState<ResearchClosed | null>(null);
  const closed = closedByStart ?? closedByPage;
  /* between 1000px and 1359px the researches are an overlay: after a delete it opens to show the line that says so (§ 11.8) */
  const [railOpen, setRailOpen] = useState(deleted !== null);
  const idempotency = useRef<{ readonly body: string; readonly key: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  /* An answer that closes the composer disables the field the focus was in; the focus goes to the box that says why
     (§ 20). Every other answer leaves the field enabled, and the focus where `Start` left it, in the field. */
  useEffect(() => {
    if (failure !== null && closedByStart !== null) errorRef.current?.focus();
  }, [failure, closedByStart]);

  /* the URL with a research open, or none: the Research page with its state, or in the dock the page under it with
     `research` — `1` for none, as the dock's empty state (§ 12) */
  const pageOf = useCallback(
    (research: string | null) => (closeHref === null ? researchPageHref(locale, { ...(pageState ?? {}), research }) : withResearch(closeHref, research ?? "1")),
    [closeHref, locale, pageState],
  );
  /* a section from the page opens the reader with no dock; from the dock, with this research still open there (§ 11.3) */
  const refBase: ResearchRefBase = useMemo(() => ({ locale, research: closeHref === null ? null : (conversation ?? "1") }), [closeHref, conversation, locale]);

  /* An id that is not the person's, or one that is gone, reads as absent: the column is empty and the parameter leaves
     the URL (§ 11.1), or in the dock reads `1`. An invalid seed says so and leaves it too, without a render that would
     take the notice away. */
  useEffect(() => {
    if (conversationId === null && researchParam !== null && researchParam !== "1") router.replace(pageOf(null), { scroll: false });
  }, [conversationId, researchParam, router, pageOf]);
  useEffect(() => {
    if (fromInvalid) window.history.replaceState(null, "", pageOf(null));
  }, [fromInvalid, pageOf]);

  /* The dock's close is a URL change, as the Assistant's: `replace` keeps the person's history entry, and the focus goes
     back to what had it when `r` opened the dock (§ 12). */
  const close = useCallback(() => {
    if (closeHref === null) return;
    returnDockFocus();
    router.replace(closeHref, { scroll: false });
  }, [closeHref, router]);

  useEffect(() => {
    if (closeHref === null) return;
    /* A panel or a dialog closes first, each answering the same key itself: the reader's peek, the keyboard map, a flag's
       or a send's confirm (§ 20: "a dialog's Esc stands back from the dock's own"). Whether one was open is read as the
       key goes down, in the capture phase, since a listener the page added before this one may have closed it, and
       React taken it off the page, by the time the key reaches here. The field's own `Esc` blurs it and never reaches
       the bubbling listener (`Composer`), so the next one closes the dock. */
    let panelOpen = false;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") panelOpen = document.querySelector(".peek-float, .peek-help, [aria-modal='true']") !== null;
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || panelOpen) return;
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [close, closeHref]);

  /* the newest run is the only one that can be under way (§ 5.2): followed every 2 s until it ends, then the page refreshed */
  const newest = runs.at(-1) ?? null;
  const following = newest !== null && runUnderWay(newest) ? newest.id : null;
  const { lost } = useRunFollow(following, {
    onView: (view) => {
      setRuns((current) => current.map((run) => (run.id === view.id ? view : run)));
      if (!runUnderWay(view)) router.refresh();
    },
    until: (view) => !runUnderWay(view),
  });
  const busy = asked !== null || (newest !== null && runUnderWay(newest) && !lost);

  const shown = asked === null ? runs : [...runs, pendingRun(asked, (newest?.ordinal ?? 0) + 1)];

  /* a new run, or the column's first render, brings the newest block's head into view; a step does not move the log. On
     the first render, a run the address names (`#run-<id>`: the Improve landing page's `From a research`, the edit page's
     link back; 48 § 8.2, § 10.2, unit 76) is brought into view instead, which the newest would otherwise scroll away. A
     question given back (§ 18) leaves the log at its end, where the box that says why stands in its block's place */
  const newestKey = shown.at(-1)?.ordinal ?? null;
  /* the newest run the effect last saw; and the one of the first render until the column first moves, then null for good:
     a give-back makes the landed run the newest again with the address unchanged, and must not send the column back to
     the run the address named (unit 76's review). The effect React runs twice in development sees the same key both
     times, and does the same both times. */
  const lastKey = useRef(newestKey);
  const landedKey = useRef(newestKey);
  useEffect(() => {
    const log = logRef.current;
    const before = lastKey.current;
    lastKey.current = newestKey;
    if (log === null || newestKey === null) return;
    if (newestKey !== landedKey.current) landedKey.current = null;
    if (before !== null && newestKey < before) {
      log.scrollTop = log.scrollHeight;
      return;
    }
    const named = landedKey.current === null || !window.location.hash.startsWith("#run-") ? null : document.getElementById(window.location.hash.slice(1));
    const article = named !== null && named.matches("article.run") && log.contains(named) ? named : log.querySelector<HTMLElement>("article.run:last-of-type");
    if (article !== null) log.scrollTop = Math.max(0, article.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - 12);
  }, [newestKey]);

  /** A run's row in the list: scroll the column to its block and give it focus. */
  const openRun = useCallback((runId: string) => {
    setRailOpen(false);
    window.requestAnimationFrame(() => {
      const article = document.getElementById(`run-${runId}`);
      article?.scrollIntoView({ block: "start" });
      article?.focus();
    });
  }, []);

  /** The research to start in: the open one, or a new one in the asked language, seeded where the page was; or why opening it failed. */
  const ensureConversation = useCallback(
    async (language: Locale): Promise<{ readonly id: string } | { readonly failure: Failure }> => {
      if (conversation !== null) return { id: conversation };
      const opened = await fetch("/api/v1/research/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: language, ...(from === null ? {} : { seedMessageId: from.messageId }) }),
      }).catch(() => null);
      if (opened === null) return { failure: { code: "NETWORK", message: "" } };
      if (!opened.ok) {
        const body = (await opened.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
        return { failure: { code: typeof body?.code === "string" ? body.code : "INTERNAL", message: typeof body?.message === "string" ? body.message : "" } };
      }
      const parsed = ResearchConversationSchema.safeParse(await opened.json().catch(() => null));
      if (!parsed.success) return { failure: { code: "INTERNAL", message: "" } };
      const id = parsed.data.id;
      setConversation(id);
      setOpenedAt(parsed.data.createdAt);
      onOpened(id);
      /* the id belongs on the URL so a reload finds the research, without a navigation that would re-render under the start; `from` leaves with it */
      window.history.replaceState(null, "", pageOf(id));
      return { id };
    },
    [conversation, from, onOpened, pageOf],
  );

  const start = useCallback(
    async (text: string, language: Locale): Promise<void> => {
      setFailure(null);
      setAsked({ text, at: new Date().toISOString(), language });
      /* whatever went wrong, the question goes back to the field with its language, and the box says why (§ 18) */
      const giveBack = (failed: Failure): void => {
        setAsked(null);
        setRetry({ text, language });
        setFailure(failed);
      };
      const opened = await ensureConversation(language);
      if ("failure" in opened) return giveBack(opened.failure);
      const { id } = opened;
      /* one key per body, kept while the same question is retried: a retry of a start that did start replays its answer */
      const body = JSON.stringify({ question: text, language });
      const key = idempotency.current?.body === body ? idempotency.current.key : crypto.randomUUID();
      idempotency.current = { body, key };
      const response = await fetch(`/api/v1/research/conversations/${id}/runs`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body }).catch(() => null);
      if (response !== null && response.status === 202) {
        const started = ResearchRunStartedSchema.safeParse(await response.json().catch(() => null));
        idempotency.current = null;
        setRetry(null);
        if (started.success) {
          const read = await fetch(`/api/v1/research/runs/${started.data.runId}`, { headers: { accept: "application/json" } }).catch(() => null);
          const view = read !== null && read.ok ? ResearchRunViewSchema.safeParse(await read.json().catch(() => null)) : null;
          if (view?.success === true) setRuns((current) => mergedRuns(current, [view.data]));
        }
        setAsked(null);
        /* the list, the day's count and the statistics are the server's: a run under way is the moment they move */
        router.refresh();
        return;
      }
      if (response === null) giveBack({ code: "NETWORK", message: "" });
      else {
        const answer = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown; detail?: { resetsAt?: unknown } } | null;
        const code = typeof answer?.code === "string" ? answer.code : "INTERNAL";
        const resetsAt = typeof answer?.detail?.resetsAt === "string" ? answer.detail.resetsAt : null;
        giveBack({ code, message: typeof answer?.message === "string" ? answer.message : "" });
        /* what the page would have said before Start, said now: the composer closes with its reason (§ 18), the box above it */
        if (code === "BUDGET_EXCEEDED" && resetsAt !== null) setClosedByStart({ kind: "budget", resetsAt });
        else if (code === "RESEARCH_DAILY_LIMIT" && resetsAt !== null) setClosedByStart({ kind: "dailyLimit", until: resetsAt });
        else if (code === "RESEARCH_OFF_ORGANISATION") setClosedByStart({ kind: "offOrganisation" });
      }
      /* The research exists now, whatever the answer: the server lists it, a 409's run under way is its rows' to show,
         and a 503 or a 500 left a run `SKIPPED · UNAVAILABLE`. A request that never arrived changed nothing, and the
         refresh is harmless. */
      router.refresh();
    },
    [ensureConversation, router],
  );

  /* the open research's line in the list: the server's, or built from the column's runs until the server lists it (§ 11.4) */
  const list = page?.list ?? null;
  const listed = useMemo(() => {
    const rows = list?.conversations ?? [];
    if (conversation === null || rows.some((row) => row.id === conversation)) return rows;
    /* with no run yet, the instant it was opened, which the server will list it at (never the epoch; unit 72's review) */
    const at = runs.at(-1)?.createdAt ?? openedAt ?? asked?.at ?? null;
    return at === null ? rows : [lineOfRuns(conversation, runs, from !== null || seed !== null, at), ...rows];
  }, [asked, conversation, from, list, openedAt, runs, seed]);
  const total = Math.max(list?.total ?? 0, listed.length);

  /* the seed: the open research's above its first question; `?from=`'s before Start, and above the run once it exists */
  const seedCard = seed ?? from?.card ?? null;
  const beforeStart = conversation === null && from !== null;

  const help =
    closed?.kind === "budget" ? (
      <>
        {t("composer.budget", { date: formatDayMonth(new Date(closed.resetsAt), locale) })} ·{" "}
        <Link href={`/${locale}/account#budget`} className="xref">
          {tbudget("see")}
        </Link>
      </>
    ) : closed?.kind === "dailyLimit" ? (
      t("composer.dailyLimit", { max: RESEARCH_RUNS_PER_DAY, time: formatTime(new Date(closed.until)) })
    ) : busy ? (
      t("composer.inProgress")
    ) : undefined;

  return (
    <>
      {page === null ? (
        /* the dock lies over the page at every width from 768px, beside a reader section too, and its backdrop closes it (§ 12) */
        <button type="button" className="dock-backdrop is-over" aria-label={t("dock.close")} onClick={close} />
      ) : (
        <ResearchConversations
          conversations={listed}
          total={total}
          openId={conversation}
          hrefOf={(id) => pageOf(id)}
          newHref={pageOf(null)}
          moreHref={page.list.moreHref}
          runs={runs}
          onOpenRun={openRun}
          locale={locale}
          open={railOpen}
          onClose={() => setRailOpen(false)}
          exportHref={conversation !== null && conversation === conversationId && page.exportable ? `/api/v1/research/conversations/${encodeURIComponent(conversation)}/export` : null}
          doneHref={(id) => `${page.closedHref}${page.closedHref.includes("?") ? "&" : "?"}deleted=${encodeURIComponent(id)}`}
          deleted={deleted !== null}
        />
      )}
      {/* `data-dock` tells research's column from the Assistant's dock for their keys: `r` finds this one, `a` never does (§ 12) */}
      <aside className={page === null ? "dock is-over" : "dock"} data-dock="research" aria-label={t("dock.title")}>
        <div className="inst-h">
          <span className="t">{t("dock.title")}</span>
          <span className="sep">·</span>
          <span>{t("dock.reads")}</span>
          <span className="sep">·</span>
          <span>{t("dock.release", { id: releaseId })}</span>
          <span className="sep">·</span>
          <span>{t("dock.guide", { version: guideVersion })}</span>
          <span className="ts row dock-head-actions">
            {page === null ? (
              <>
                {/* the Research page: this research there, or the page ready for a first question (§ 12) */}
                <Link href={researchPageHref(locale, { research: conversation })} className="iconbtn dock-iconbtn" aria-label={t("dock.openFull")}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                    <path d="M7 1h4v4M11 1L6 6M5 2H1v9h9V7" />
                  </svg>
                </Link>
                <IconButton label={t("dock.close")} onClick={close} className="dock-iconbtn">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                    <path d="M2 2l8 8M10 2l-8 8" />
                  </svg>
                </IconButton>
              </>
            ) : (
              /* between 1000px and 1359px the researches are the column that gave way, and open from here (§ 11.2) */
              <button type="button" className="btn btn-sm log-toggle" aria-expanded={railOpen} onClick={() => setRailOpen((current) => !current)}>
                {t("list.count", { n: total })}
              </button>
            )}
          </span>
        </div>
        <p className="cap research-frame">{t("dock.frame")}</p>

        <div className="dock-log" role="log" aria-label={t("dock.log")} aria-live="polite" ref={logRef}>
          {signedIn ? null : <SignInNotice locale={locale} next={pageOf(null)} />}
          {closed?.kind === "unavailable" ? <Notice title={t("notice.unavailableTitle")}>{t("notice.unavailable")}</Notice> : null}
          {closed?.kind === "offOrganisation" ? <Notice title={t("notice.offOrganisationTitle")}>{t("notice.offOrganisation")}</Notice> : null}
          {fromInvalid ? <Notice title={t("seed.invalidTitle")}>{t("seed.invalid")}</Notice> : null}
          {seedCard === null ? null : <SeedCard seed={seedCard} locale={locale} scratchHref={beforeStart ? pageOf(null) : null} />}
          {signedIn && shown.length === 0 && seedCard === null ? (
            <Empty>
              <p className="ui">{t("dock.empty")}</p>
              <p className="small muted">
                {t("dock.fromAnswer")}{" "}
                <Link href={`/${locale}/assistant`} className="xref">
                  {t("dock.openAssistant")}
                </Link>
              </p>
            </Empty>
          ) : null}
          {shown.map((run) => (
            /* keyed by ordinal: the question asked is the same block as the run it becomes, so nothing is announced twice */
            <RunBlock key={run.ordinal} run={run} refBase={refBase} locale={locale} lost={lost && run.id === following} findingRole={findingRole} />
          ))}
          {failure === null ? null : (
            <ErrorBox
              ref={errorRef}
              title={t("errors.notStarted")}
              actions={
                RETRYABLE.has(failure.code) && closed === null ? (
                  /* the form submitted again, as Start: it posts the question the field holds, with the same key while it is unchanged */
                  <Button size="sm" onClick={() => formRef.current?.requestSubmit()}>
                    {t("errors.retry")}
                  </Button>
                ) : undefined
              }
            >
              {failure.code === "NETWORK" || failure.message === "" ? t("errors.network") : failure.message}
            </ErrorBox>
          )}
        </div>

        <Composer
          ref={formRef}
          restore={retry}
          namespace="research.composer"
          locale={locale}
          editionLang={locale}
          draft={beforeStart ? from.question : null}
          disabled={!signedIn || closed !== null}
          busy={busy}
          /* the person came to type: the page with no research open, or the dock opened empty; after a delete the focus is
             `New research`'s, with the line that says so (§ 20) */
          autoFocus={signedIn && conversationId === null && closed === null && deleted === null}
          help={help}
          onSubmit={(text, language) => {
            void start(text, language);
          }}
        />
      </aside>
    </>
  );
}
