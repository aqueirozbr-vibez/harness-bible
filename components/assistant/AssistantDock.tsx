"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Composer } from "@/components/assistant/Composer";
import { ConversationLog, type EarlierConversation, type WalkRow } from "@/components/assistant/ConversationLog";
import { ConversationsTree } from "@/components/assistant/ConversationsTree";
import { DecisionAidForm, WALK_FORM_ID } from "@/components/assistant/DecisionAidForm";
import { comparePair, ModeContext, type DockChapterOption, type DockLab } from "@/components/assistant/ModeContext";
import { TurnBlock } from "@/components/assistant/TurnBlock";
import { SignInNotice } from "@/components/auth/SignInNotice";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { ErrorBox } from "@/components/ui/ErrorBox";
import { IconButton } from "@/components/ui/IconButton";
import type { InputError } from "@/lib/aids/apply";
import type { Aid } from "@/lib/aids/schema";
import { withAsk, type RefBase } from "@/lib/assistant/links";
import { lineOfTurns } from "@/lib/assistant/summary";
import { answerOfFinal, turnsOf, type MessageView, type SseFinal, type Turn } from "@/lib/assistant/turns";
import { firstResultStep } from "@/lib/assistant/walk";
import { dispatchAssistantStatus, dispatchCited } from "@/lib/hooks/citedPassages";
import { useResearchFollow } from "@/lib/hooks/useResearchFollow";
import { useSse } from "@/lib/hooks/useSse";
import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { Mode } from "@/lib/schemas/assistant";

/*
 * The docked assistant (feature-specs/16 § 5.1, and 24 for what it stands beside). A client component because the
 * stream is a client concern: the shell holds the conversation, the mode and the composer, and the only thing it
 * shares with the page under it is the URL — `?ask=…` is the open state (D1), so back, reload and a shared link all
 * behave. Since Assistant 2.0 that page may be any page: the dock is given no chapter and no section, only the
 * release's catalogue, and a conversation in it is about the book.
 *
 * It is plainly not a chat, and the frame says so before a word is typed: the mode strip names what the assistant
 * does, the context line names what it is reading, the scope line names what it will refuse.
 *
 * Nothing here reaches the workers or the gateway: every call goes to `/api/v1` (invariant 23).
 *
 * Walk mode (feature-specs/18 § 5) replaces the composer with the aid picker and the inputs form; a run is a turn
 * whose user line is the inputs, and the dock owns each walk turn's step so the log rail and the status bar can say
 * where its strip stands.
 */

/** The five modes in the strip's order (§ 5.3); the other four are answered by the flow and rendered by 18 and 19. */
const MODES: ReadonlyArray<Mode> = ["explain", "compare", "walk", "lab", "brief"];

/** The codes worth a `Retry`: the turn did not happen, and asking again may work (§ 6). */
const RETRYABLE: ReadonlySet<string> = new Set(["ASSISTANT_UNAVAILABLE", "INTERNAL"]);

/** The question as the server stored it, which `meta` carries only when it differs from what was typed. */
function storedQuestion(meta: Record<string, unknown> | null, typed: string): string {
  return typeof meta?.question === "string" ? meta.question : typed;
}

export interface AssistantDockProps {
  readonly locale: Locale;
  readonly releaseId: string;
  /** The guide the assistant answers under, until an answer's `meta` names it (§ 5.2). */
  readonly guideVersion: string;
  /** The edition the answers cite: the one retrieval reads, whatever the reader's interface language. */
  readonly editionLang: string;
  readonly signedIn: boolean;
  /** The conversation the URL names, when it is the reader's and still exists; null is the empty state. */
  readonly conversationId: string | null;
  /** The `ask` value as it stands on the URL: `1` is the empty dock, anything else named a conversation. */
  readonly askParam: string;
  /** The page's own URL without `ask`: closing the dock goes there (D1). It may carry parameters of its own. */
  readonly closeHref: string;
  /** Where sign-in returns a signed-out reader to: this page, dock and all. */
  readonly nextPath: string;
  /** The conversation's turns as the endpoint serves them (§ 3); empty for a dock with no conversation yet. */
  readonly initial: ReadonlyArray<MessageView>;
  /** Set when the conversation is pinned to a release that is no longer current: it is read-only (§ 6). */
  readonly pinnedRelease: string | null;
  /** The reader's other conversations, newest first, for the log rail (feature-specs/17 § 5.2). */
  readonly earlier: ReadonlyArray<EarlierConversation>;
  /** What the dock needs of the release (feature-specs/24 § 3.3): how much is verified, its chapters and its labs. */
  readonly catalogue: { readonly verified: number; readonly total: number; readonly chapters: ReadonlyArray<DockChapterOption>; readonly labs: ReadonlyArray<DockLab> };
  /** Every decision aid of the release, for the walk's picker. */
  readonly aids: ReadonlyArray<Aid>;
  /**
   * The reader section the dock stands beside, or null on any other page. It decides where a citation opens (the peek
   * exists only there) and what the pickers start on; it is never sent, and the assistant reads no position (23 D2).
   */
  readonly readerSection: string | null;
  /** The text the ask box opens with (`?draft=…`, feature-specs/24 § 6.2); null opens it empty. */
  readonly draft?: string | null;
  /**
   * `dock` over or beside a page, or `page` on the assistant's own page (feature-specs/26): there the dock is the main
   * column beside the conversations it also renders, and there is no close button, no backdrop and no `esc`, because
   * nothing is behind it.
   */
  readonly variant?: "dock" | "page";
  /** The assistant's page only: the reader's conversations as the server lists them, and what the list needs (feature-specs/26 § 5). */
  readonly list?: { readonly conversations: ReadonlyArray<EarlierConversation>; readonly total: number; readonly moreHref: string | null };
  /** The assistant's page only: reached by a conversation's delete (`?deleted=<id>`, feature-specs/45 § 3.9). */
  readonly deleted?: boolean;
}

/*
 * One dock, one conversation at a time. The session below keeps its turns in client state, because a conversation is
 * created by its first question while the answer streams: its id reaches the URL through `replaceState`, and the
 * server learns of it only on the next render. So when the server's `conversationId` changes there are two cases, and
 * they must not be confused. If it has become the conversation this session opened itself, nothing happened: the URL
 * caught up, and the turns on screen (with what only the `final` event carries, a refusal's pointers among it) stay.
 * If it has become anything else — another conversation picked from the list, or none — the reader has moved on, and
 * the session starts again from the server's rows. The key is what tells React which.
 */
export function AssistantDock(props: AssistantDockProps) {
  const [slot, setSlot] = useState<{ readonly key: number; readonly seen: string | null; readonly opened: string | null }>({ key: 0, seen: props.conversationId, opened: null });
  if (props.conversationId !== slot.seen) {
    const caughtUp = props.conversationId !== null && props.conversationId === slot.opened;
    setSlot({ key: caughtUp ? slot.key : slot.key + 1, seen: props.conversationId, opened: caughtUp ? slot.opened : null });
  }
  const onOpened = useCallback((id: string) => setSlot((current) => ({ ...current, opened: id })), []);
  return <DockSession key={slot.key} {...props} onOpened={onOpened} />;
}

function DockSession({
  locale,
  releaseId,
  guideVersion,
  editionLang,
  signedIn,
  conversationId,
  askParam,
  closeHref,
  nextPath,
  initial,
  pinnedRelease,
  earlier,
  catalogue,
  aids,
  readerSection,
  draft = null,
  variant = "dock",
  list,
  deleted = false,
  onOpened,
}: AssistantDockProps & { readonly onOpened: (id: string) => void }) {
  const t = useTranslations("assistant.dock");
  const ta = useTranslations("assistant");
  const tw = useTranslations("assistant.walk");
  const tc = useTranslations("assistant.compare");
  const tlb = useTranslations("assistant.lab");
  const tb = useTranslations("assistant.brief");
  const tl = useTranslations("assistant.log");
  const tbudget = useTranslations("account.budget");
  const tp = useTranslations("assistant.page");
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("explain");
  const modeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /* The rows the server rendered, then whatever this session adds. The conversation's id reaches the URL through
     `replaceState`, not a navigation, so these turns survive being recorded there (§ 5.8). */
  const [turns, setTurns] = useState<ReadonlyArray<Turn>>(() => turnsOf(initial));
  /* the research line under an answer follows its run while it is not over (feature-specs/43 § 4.3; unit 60a) */
  useResearchFollow(turns, setTurns, signedIn);
  const [conversation, setConversation] = useState<string | null>(conversationId);
  const [asked, setAsked] = useState<{ readonly text: string; readonly at: string; readonly mode: Mode; readonly aid?: { readonly id: string; readonly inputs: Readonly<Record<string, number>> } } | null>(null);
  /* The walk (feature-specs/18 § 5): the picked aid and the typed values live here so `Edit inputs` can refill the
     form, the endpoint's field errors sit under their inputs, and each walk turn's step is known to the rail. */
  /* What the pickers start on (feature-specs/24 § 5.1): beside a reader section, that chapter's own aid, lab and
     number, where it has them. A start is a pick the reader sees and may change, not a position the assistant reads. */
  const readerChapter = readerSection === null ? null : Number(readerSection.slice(0, 2));
  const [pickedAid, setPickedAid] = useState<string | null>((aids.find((aid) => aid.chapter === readerChapter) ?? aids[0])?.id ?? null);
  /* Compare's two chapters (feature-specs/19 § 3, D3): both chosen here, since no page stands for either side. */
  const [first, setFirst] = useState<number | null>(catalogue.chapters.find((chapter) => chapter.number === readerChapter && chapter.verified)?.number ?? null);
  const [second, setSecond] = useState<number | null>(null);
  const pair = comparePair(first, second);
  const [pickedLab, setPickedLab] = useState<string | null>(catalogue.labs.find((candidate) => candidate.chapter === readerChapter && candidate.verified)?.id ?? null);
  const lab = catalogue.labs.find((candidate) => candidate.id === pickedLab) ?? null;
  const [walkValues, setWalkValues] = useState<Readonly<Record<string, string>>>({});
  const [walkErrors, setWalkErrors] = useState<ReadonlyArray<InputError>>([]);
  const [walkFailed, setWalkFailed] = useState<{ readonly exitCode: number | null; readonly timedOut: boolean; readonly ms: number } | null>(null);
  const [walkSteps, setWalkSteps] = useState<Readonly<Record<string, number>>>(() =>
    Object.fromEntries(turnsOf(initial).flatMap((turn) => (turn.answer?.walk === null || turn.answer?.walk === undefined ? [] : [[turn.key, firstResultStep(turn.answer.walk)]]))),
  );
  const [openFailure, setOpenFailure] = useState<{ readonly code: string; readonly message: string } | null>(null);
  const [retry, setRetry] = useState<{ readonly text: string; readonly language: Locale } | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const stream = useSse();
  const logRef = useRef<HTMLDivElement>(null);
  /* The newest answer's box opens expanded and a refusal's stays collapsed (16 § 5.7, 17 D1); the rail can open any. */
  const [openVerdicts, setOpenVerdicts] = useState<ReadonlySet<string>>(() => {
    const last = turnsOf(initial).at(-1);
    return new Set(last !== undefined && last.answer !== null && last.answer.refusal === null ? [last.key] : []);
  });
  /* reached by a delete, the conversations stand in front, the overlay they are between 1000px and 1359px, to say so (45 § 3.9) */
  const [railOpen, setRailOpen] = useState(variant === "page" && deleted);
  const toggleVerdicts = useCallback((key: string) => {
    setOpenVerdicts((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  /** A log row: scroll the dock to the turn, give it focus, and open its verdicts (17 § 5.2). */
  const openTurn = useCallback((key: string) => {
    setOpenVerdicts((current) => new Set([...current, key]));
    setRailOpen(false);
    window.requestAnimationFrame(() => {
      const article = document.getElementById(`turn-${key}`);
      article?.scrollIntoView({ block: "start" });
      article?.focus();
    });
  }, []);

  /* Where a citation opens (feature-specs/24 § 5.5): the peek beside a reader section, the reader itself from any
     other page, carrying the conversation so it is still open there. */
  const refBase: RefBase = useMemo(
    () => ({
      peek: variant === "page" || readerSection === null ? null : `/${locale}/ch/${readerSection.slice(0, 2)}/${readerSection}`,
      locale,
      ask: conversation ?? "1",
    }),
    [conversation, locale, readerSection, variant],
  );

  /** The reader typed over the draft or asked: `draft` leaves the URL, so a reload does not bring it back (§ 5.4). */
  const clearDraft = useCallback(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("draft")) return;
    url.searchParams.delete("draft");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);

  /* Closing is a URL change, not local state: `replace` keeps the reader's history entry (D1). */
  const close = useCallback(() => {
    router.replace(closeHref, { scroll: false });
  }, [router, closeHref]);

  /* An id that is not the reader's, or one that is gone, reads as absent: the dock shows the empty state and takes
     the parameter off the URL, so a shared or stale link does not keep pointing at a conversation (§ 3). */
  useEffect(() => {
    if (conversationId === null && askParam !== "1") router.replace(nextPath, { scroll: false });
  }, [conversationId, askParam, router, nextPath]);

  useEffect(() => {
    if (variant === "page") return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      /* The peek closes first: the reader's own order, panel then dock (§ 8). The peek listens on the same event
         and answers it itself, so the dock stands back while one is open. */
      if (document.querySelector(".peek-float") !== null) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, variant]);

  const error = stream.error;

  /* While a draft streams the log follows its tail; a finished turn scrolls to its own head, because a walk's
     instrument is taller than the viewport and its strip is what the reader needs first (feature-specs/18 § 5.2). */
  useEffect(() => {
    const log = logRef.current;
    if (log === null) return;
    const last = turns.at(-1);
    const article = last === undefined ? null : document.getElementById(`turn-${last.key}`);
    if (article !== null && (stream.status === "idle" || stream.status === "done")) {
      log.scrollTop = Math.max(0, article.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - 12);
      return;
    }
    log.scrollTop = log.scrollHeight;
  }, [turns, stream.tokens, stream.status]);

  /* The reading column beside the dock highlights what the newest answer cites, and the status bar names the mode
     and the first-token time (§ 7, § 8). Both live in the page's tree, not the slot's, so the dock tells them. */
  const newest = turns.at(-1)?.answer ?? null;
  const answering = stream.status === "waiting" || stream.status === "streaming";
  useEffect(() => {
    dispatchCited({ citations: newest?.citations ?? [] });
  }, [newest]);

  const streaming = stream.status === "waiting" || stream.status === "streaming";
  const readOnly = pinnedRelease !== null;

  /** The conversation to post into: the open one, or a new one in the asked language; null when opening it failed. */
  const ensureConversation = useCallback(
    async (language: Locale): Promise<string | null> => {
      if (conversation !== null) return conversation;
      const opened = await fetch(`/api/v1/assistant/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: language }),
      });
      if (!opened.ok) {
        const body = (await opened.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
        setOpenFailure({ code: typeof body?.code === "string" ? body.code : "INTERNAL", message: typeof body?.message === "string" ? body.message : "" });
        return null;
      }
      const id = ((await opened.json()) as { id: string }).id;
      setConversation(id);
      onOpened(id);
      /* The id belongs on the URL so a reload finds the conversation, but a navigation here would re-render the
         slot and take the stream with it: `replaceState` records it without one (§ 5.8). */
      window.history.replaceState(null, "", withAsk(closeHref, id));
      return id;
    },
    [closeHref, conversation, onOpened],
  );

  const ask = useCallback(
    async (text: string, language: Locale): Promise<void> => {
      setOpenFailure(null);
      setRetry({ text, language });
      const at = new Date().toISOString();
      setAsked({ text, at, mode });

      const id = await ensureConversation(language);
      if (id === null) {
        setAsked(null);
        return;
      }

      /* One key per attempt, kept while the same text is retried: a retry of a turn that did answer replays the
         stored `final` instead of asking a model twice (§ 5.8, feature-specs/15 D1). */
      const key = idempotencyKey.current ?? crypto.randomUUID();
      idempotencyKey.current = key;
      const outcome = await stream.start(() =>
        fetch(`/api/v1/assistant/conversations/${id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({
            text,
            mode,
            /* What the mode picked (feature-specs/23 § 7.3): compare its pair, lab its lab. Nothing says where the reader is. */
            ...(mode === "compare" && pair !== null ? { context: { chapters: pair } } : mode === "lab" && lab !== null ? { context: { labId: lab.id } } : {}),
          }),
        }),
      );

      /* The turn is finished where it finished: the answer joins the log from the `final` event, and the pending
         block goes with it. A failure keeps the question and the key, so `Retry` asks the same turn again. */
      if (outcome.final !== null) {
        const traceId = typeof outcome.meta?.traceId === "string" ? outcome.meta.traceId : null;
        const answer = answerOfFinal(outcome.final as SseFinal, mode, traceId);
        setTurns((current) => [...current, { key: answer.messageId, question: { text: storedQuestion(outcome.meta, text), at }, mode, answer }]);
        setOpenVerdicts(new Set(answer.refusal === null ? [answer.messageId] : []));
        setAsked(null);
        setRetry(null);
        idempotencyKey.current = null;
        stream.reset();
        /* The page's list, its count and its statistics are the server's: a turn that ended is the moment they move. */
        if (variant === "page") router.refresh();
        return;
      }
      /* A second question while a turn is open is the server's answer, not a guess: the rows carry the state. */
      if (outcome.error?.code === "TURN_IN_PROGRESS") {
        setAsked(null);
        router.refresh();
      }
    },
    [ensureConversation, lab, mode, pair, router, stream, variant],
  );

  /**
   * A walk (feature-specs/18 § 5.1–5.2): the inputs as typed go to the endpoint, which checks them against the aid's
   * ranges — a field error comes back under its input, a run that did not finish stays on screen as the failed turn,
   * and a `final` is a turn like any other, opened on its first result step. A new run is always a new turn.
   */
  const runWalk = useCallback(
    async (aid: Aid): Promise<void> => {
      setOpenFailure(null);
      setRetry(null);
      setWalkErrors([]);
      setWalkFailed(null);
      const raw = Object.fromEntries(aid.inputs.map((input) => [input.key, (walkValues[input.key] ?? String(input.default)).trim()]));
      const numbers = Object.fromEntries(aid.inputs.map((input) => [input.key, Number((raw[input.key] ?? "").replace(",", "."))]));
      const at = new Date().toISOString();
      const text = tw("userLine", { section: aid.section });
      setAsked({ text, at, mode: "walk", aid: { id: aid.id, inputs: numbers } });
      setWalkSteps((current) => ({ ...current, live: 1 }));

      const id = await ensureConversation(locale);
      if (id === null) {
        setAsked(null);
        return;
      }

      const key = crypto.randomUUID();
      idempotencyKey.current = key;
      const outcome = await stream.start(() =>
        fetch(`/api/v1/assistant/conversations/${id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({ text, mode: "walk", aidId: aid.id, aidInputs: raw }),
        }),
      );
      idempotencyKey.current = null;

      if (outcome.final !== null) {
        const traceId = typeof outcome.meta?.traceId === "string" ? outcome.meta.traceId : null;
        const answer = answerOfFinal(outcome.final as SseFinal, "walk", traceId);
        setTurns((current) => [...current, { key: answer.messageId, question: { text, at }, mode: "walk", answer }]);
        setOpenVerdicts(new Set(answer.refusal === null ? [answer.messageId] : []));
        setWalkSteps((current) => {
          const rest = Object.fromEntries(Object.entries(current).filter(([turnKey]) => turnKey !== "live"));
          return answer.walk === null ? rest : { ...rest, [answer.messageId]: firstResultStep(answer.walk) };
        });
        setAsked(null);
        stream.reset();
        if (variant === "page") router.refresh();
        return;
      }
      if (outcome.error?.code === "AID_INPUTS") {
        /* The form's own errors, under their inputs (§ 6); nothing ran and there is no turn to show. */
        const detail = outcome.error.detail as { errors?: unknown } | undefined;
        setWalkErrors(Array.isArray(detail?.errors) ? (detail.errors as ReadonlyArray<InputError>) : []);
        setAsked(null);
        stream.reset();
        return;
      }
      if (outcome.error?.code === "AID_RUN_FAILED") {
        /* The script did not finish: the live turn stays and shows the run line in the fail tone and the error box (§ 7). */
        const detail = (outcome.error.detail ?? {}) as { exitCode?: unknown; timedOut?: unknown; ms?: unknown };
        setWalkFailed({ exitCode: typeof detail.exitCode === "number" ? detail.exitCode : null, timedOut: detail.timedOut === true, ms: typeof detail.ms === "number" ? detail.ms : 0 });
        return;
      }
      if (outcome.error?.code === "TURN_IN_PROGRESS") {
        setAsked(null);
        router.refresh();
      }
    },
    [ensureConversation, locale, router, stream, tw, variant, walkValues],
  );

  /** `Edit inputs` (§ 5.2): back to the form with the turn's values; the next run is a new turn. */
  const editInputs = useCallback(
    (aidId: string, inputs: Readonly<Record<string, number>>): void => {
      setMode("walk");
      setPickedAid(aidId);
      setWalkValues(Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, String(value)])));
      setWalkErrors([]);
      setWalkFailed(null);
      setAsked(null);
      stream.reset();
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>(`#${WALK_FORM_ID} input`)?.focus();
      });
    },
    [stream],
  );

  /** Arrow keys move within the group and take the checked state with them (§ 10). */
  const onModeKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + MODES.length) % MODES.length;
    const name = MODES[next];
    if (name === undefined) return;
    setMode(name);
    modeRefs.current[next]?.focus();
  };

  /* The live turn: the question is on screen from the moment it is asked, the draft under it until `final`. Once
     `meta` arrives it is the question as it was stored: a secret pasted into it reads `[redacted:…]` (feature-specs/21 § 6.2). */
  const live: Turn | null = useMemo(
    () => (asked === null ? null : { key: "live", question: { text: storedQuestion(stream.meta, asked.text), at: asked.at }, mode: asked.mode, answer: null }),
    [asked, stream.meta],
  );
  const shown = live === null ? turns : [...turns, live];
  /* The walk's own failures render in the form and in the turn (§ 6, § 7); the box is for everything else. */
  const failure = openFailure ?? (error === null || error.code === "AID_INPUTS" || error.code === "AID_RUN_FAILED" ? null : { code: error.code, message: error.message });

  /* Where each walk turn's strip stands, for the rail's rows and the status bar (18 § 5.2–5.3). */
  const walkRows: Readonly<Record<string, WalkRow>> = Object.fromEntries(
    shown.flatMap((turn): ReadonlyArray<[string, WalkRow]> => {
      if (turn.mode.toLowerCase() !== "walk") return [];
      const aidId = turn.answer?.walk?.aidId ?? (turn.key === "live" ? (asked?.aid?.id ?? "") : "");
      const of = turn.answer?.walk?.steps.length ?? (turn.key === "live" ? (aids.find((aid) => aid.id === aidId)?.steps.length ?? 0) : 0);
      return of === 0 ? [] : [[turn.key, { aidId, step: walkSteps[turn.key] ?? 1, of, runMs: turn.answer?.walk?.run.ms ?? null }]];
    }),
  );
  const newestWalk = shown.length === 0 ? null : (walkRows[shown[shown.length - 1]?.key ?? ""] ?? null);
  const walkAid = newestWalk?.aidId ?? null;
  const walkStep = newestWalk?.step ?? null;
  const walkOf = newestWalk?.of ?? null;
  const walkRunMs = newestWalk?.runMs ?? null;
  useEffect(() => {
    dispatchAssistantStatus({
      mode,
      answering,
      firstTokenMs: newest?.firstTokenMs ?? null,
      walk: walkAid === null || walkStep === null || walkOf === null ? null : { aidId: walkAid, step: walkStep, of: walkOf, runMs: walkRunMs },
    });
  }, [mode, answering, newest, walkAid, walkStep, walkOf, walkRunMs]);

  /* Outside the reader no page makes room for the dock: it lies over the page at every width (feature-specs/24 § 5.6). */
  const over = variant === "dock" && readerSection === null;

  /* The assistant's page lists the reader's conversations (feature-specs/26 § 5). The list is the server's, and the
     open conversation is always in it: one just created by its first question has no row there until the turn ends,
     so its line is built from the turns on screen and stands first, where the server will put it. */
  const listed = useMemo(() => {
    const rows = list?.conversations ?? [];
    if (conversation === null || rows.some((row) => row.id === conversation)) return rows;
    return [lineOfTurns(conversation, turns, asked?.at ?? new Date(0).toISOString()), ...rows];
  }, [asked, conversation, list, turns]);

  return (
    <>
      {/* Under 1000px, and on any page but a reader section, the dock is an overlay; its backdrop closes it, as the peek's outside click does (§ 4). */}
      {variant === "page" ? null : <button type="button" className={over ? "dock-backdrop is-over" : "dock-backdrop"} aria-label={t("close")} onClick={close} />}
      {variant === "page" ? (
        <ConversationsTree
          conversations={listed}
          total={Math.max(list?.total ?? 0, listed.length)}
          openId={conversation}
          hrefOf={(id) => withAsk(closeHref, id)}
          newHref={closeHref}
          moreHref={list?.moreHref ?? null}
          exportHref={conversation === null || turns.length === 0 ? null : `/api/v1/assistant/conversations/${conversation}/export`}
          turns={shown}
          liveKey={streaming ? "live" : null}
          openVerdicts={openVerdicts}
          onOpenTurn={openTurn}
          walkRows={walkRows}
          locale={locale}
          open={railOpen}
          onClose={() => setRailOpen(false)}
          streaming={streaming}
          /* a proposal made, or a finding sent to Improve that may become one (review of unit 62) */
          ledToProposal={turns.some((turn) => (turn.answer?.research?.proposals.length ?? 0) > 0 || turn.answer?.research?.state === "SUBMITTING")}
          doneHref={(id) => `${closeHref}${closeHref.includes("?") ? "&" : "?"}deleted=${encodeURIComponent(id)}`}
          deleted={deleted}
        />
      ) : shown.length === 0 ? null : (
        <ConversationLog
          turns={shown}
          liveKey={streaming ? "live" : null}
          locale={locale}
          openVerdicts={openVerdicts}
          onOpenTurn={openTurn}
          earlier={earlier.filter((entry) => entry.id !== conversation).slice(0, 5)}
          earlierHref={(id) => withAsk(closeHref, id)}
          exportHref={conversation === null ? null : `/api/v1/assistant/conversations/${conversation}/export`}
          walkRows={walkRows}
          open={railOpen}
          onClose={() => setRailOpen(false)}
          over={over}
        />
      )}
      {/* `data-dock` tells the two docks apart for their keys: `a` finds this one, never the Research column (feature-specs/48 § 12) */}
      <aside className={over ? "dock is-over" : "dock"} data-dock="assistant" aria-label={t("title")}>
        <div className="inst-h">
          <span className="t">{t("title")}</span>
          <span className="sep">·</span>
          <span>{t("grounded", { id: releaseId })}</span>
          <span className="sep">·</span>
          <span>{t("guide", { version: guideVersion })}</span>
          <span className="ts row dock-head-actions">
            {/* The full page lays the rail out as a column, so it has nothing to toggle (17 § 7). */}
            {/* Beside a page the toggle opens the conversation's log; on the assistant's own page, between 1000px and
                1359px, the conversations, which are the column that gave way (feature-specs/26 § 6). */}
            {variant === "page" ? (
              <button type="button" className="btn btn-sm log-toggle" aria-expanded={railOpen} onClick={() => setRailOpen((current) => !current)}>
                {tp("conversations", { n: Math.max(list?.total ?? 0, listed.length) })}
              </button>
            ) : shown.length === 0 ? null : (
              <button type="button" className="btn btn-sm log-toggle" aria-expanded={railOpen} onClick={() => setRailOpen((current) => !current)}>
                {tl("toggle", { n: shown.length })}
              </button>
            )}
            {variant === "page" ? null : (
              <>
                {/* The assistant's own page: this conversation there, or the page ready for a first question. */}
                <Link href={conversation === null ? `/${locale}/assistant` : withAsk(`/${locale}/assistant`, conversation)} className="iconbtn dock-iconbtn" aria-label={t("openFull")}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                    <path d="M7 1h4v4M11 1L6 6M5 2H1v9h9V7" />
                  </svg>
                </Link>
                <IconButton label={t("close")} onClick={close} className="dock-iconbtn">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                    <path d="M2 2l8 8M10 2l-8 8" />
                  </svg>
                </IconButton>
              </>
            )}
          </span>
        </div>

        <div className="dock-modes rb">
          <div className="between">
            <span className="cap">{t("modeCap")}</span>
            <span className="cap">{t("notChat")}</span>
          </div>
          <div className="row dock-mode-row" role="radiogroup" aria-label={t("modeLabel")}>
            {MODES.map((name, index) => (
              <button
                key={name}
                ref={(node) => {
                  modeRefs.current[index] = node;
                }}
                type="button"
                role="radio"
                aria-checked={name === mode}
                className={`btn btn-sm${name === mode ? " is-checked" : ""}`}
                tabIndex={name === mode ? 0 : -1}
                onClick={() => setMode(name)}
                onKeyDown={(event) => onModeKey(event, index)}
              >
                {t(`mode.${name}`)}
              </button>
            ))}
          </div>
          <ModeContext
            mode={mode}
            locale={locale}
            verified={catalogue.verified}
            total={catalogue.total}
            chapters={catalogue.chapters}
            first={first}
            second={second}
            onFirst={setFirst}
            onSecond={setSecond}
            onSwap={() => {
              setFirst(second);
              setSecond(first);
            }}
            labs={catalogue.labs}
            lab={lab}
            onLab={setPickedLab}
            walkSection={(aids.find((aid) => aid.id === pickedAid) ?? aids[0])?.section ?? null}
            disabled={streaming}
          />
        </div>

        <div className="dock-log" role="log" aria-label={t("conversationLabel")} aria-live="polite" ref={logRef}>
          {signedIn ? null : <SignInNotice locale={locale} next={nextPath} />}
          {signedIn && shown.length === 0 && !readOnly ? <Empty caption={t("emptyCap")}>{t("empty")}</Empty> : null}
          {shown.map((turn, index) => (
            <TurnBlock
              key={turn.key}
              turn={turn}
              current={index === shown.length - 1}
              pending={turn.key === "live" && streaming ? { step: stream.step, tokens: stream.tokens } : null}
              basePath={refBase}
              conversationId={conversation}
              verdictsOpen={openVerdicts.has(turn.key)}
              onToggleVerdicts={() => toggleVerdicts(turn.key)}
              chapters={catalogue.chapters}
              locale={locale}
              walk={{
                aids,
                locale,
                step: walkSteps[turn.key] ?? 1,
                onStep: (step) => setWalkSteps((current) => ({ ...current, [turn.key]: step })),
                onEditInputs: editInputs,
                live: turn.key === "live" && asked?.aid !== undefined ? asked.aid : null,
                failed: turn.key === "live" ? walkFailed : null,
                readOnly,
                index: index + 1,
                basePath: refBase,
              }}
            />
          ))}
          {failure === null ? null : (
            <ErrorBox
              title={t("error.title")}
              actions={
                RETRYABLE.has(failure.code) && retry !== null ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      void ask(retry.text, retry.language);
                    }}
                  >
                    {t("error.retry")}
                  </Button>
                ) : failure.code === "BUDGET_EXCEEDED" ? (
                  /* The 402 names the reset; the meter on the account page shows how the month was spent (feature-specs/21 § 4.2). */
                  <Button href={`/${locale}/account#budget`} size="sm">
                    {tbudget("see")}
                  </Button>
                ) : undefined
              }
            >
              {failure.code === "BUDGET_EXCEEDED" && error?.resetsAt !== undefined ? ta("budget", { date: formatDate(new Date(error.resetsAt), locale) }) : failure.message}
            </ErrorBox>
          )}
          {readOnly ? (
            <Empty
              caption={t("emptyCap")}
              action={
                <Button href={nextPath} size="sm">
                  {t("newConversation")}
                </Button>
              }
            >
              {t("pinned", { id: pinnedRelease ?? "" })}
            </Empty>
          ) : null}
        </div>

        {mode === "walk" ? (
          <DecisionAidForm
            aids={aids}
            locale={locale}
            disabled={!signedIn || streaming || readOnly}
            selected={pickedAid}
            onSelect={(id) => {
              setPickedAid(id);
              setWalkValues({});
              setWalkErrors([]);
            }}
            values={walkValues}
            onChange={(key, value) => setWalkValues((current) => ({ ...current, [key]: value }))}
            errors={walkErrors}
            onRun={(aid) => {
              void runWalk(aid);
            }}
          />
        ) : (
          <Composer
            locale={locale}
            editionLang={editionLang}
            draft={draft}
            onDraftUsed={clearDraft}
            disabled={!signedIn || streaming || readOnly || (mode === "compare" && pair === null) || (mode === "lab" && lab === null)}
            /* after a delete, New conversation takes focus with the line saying so (feature-specs/45 § 3.9) */
            autoFocus={signedIn && conversationId === null && initial.length === 0 && !deleted}
            label={
              mode === "compare"
                ? tc("label", { a: first === null ? "…" : String(first).padStart(2, "0"), b: second === null ? "…" : String(second).padStart(2, "0") })
                : mode === "lab" && lab !== null
                  ? tlb("label", { n: String(lab.chapter).padStart(2, "0") })
                  : mode === "brief"
                    ? tb("label")
                    : undefined
            }
            placeholder={mode === "compare" ? tc("placeholder") : mode === "lab" ? tlb("placeholder") : mode === "brief" ? tb("placeholder") : undefined}
            help={mode === "compare" && pair === null ? tc("help") : undefined}
            onSubmit={(text, language) => {
              void ask(text, language);
            }}
          />
        )}
      </aside>
    </>
  );
}
