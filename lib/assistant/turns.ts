import type { MessageViewSchema, ResearchView, SseFinalSchema } from "@/lib/schemas/api";
import { researchViewOfStarted } from "@/lib/research/view";
import { BriefResultSchema, CompareResultSchema, LabModeResultSchema, REFUSAL_CODES, WalkModeResultSchema, type BriefResult, type CompareResult, type LabModeResult, type WalkModeResult } from "@/lib/schemas/assistant";
import type { z } from "zod";

/*
 * The dock's turn model (feature-specs/16 § 5.4). A turn is a question and the answer that followed it, and the two
 * shapes an answer can arrive in are kept apart on purpose:
 *
 *   - the `final` event carries the flow's own claims, so the answer renders one paragraph group per claim with its
 *     citation chip after it (invariant 14: nothing on screen that is not in that event);
 *   - a conversation read back from `GET /assistant/conversations/{id}` carries the row, whose `text` is the claims
 *     already joined, because claim boundaries are not a column. An earlier turn therefore renders as the row's
 *     paragraph with its chips after it — the same words, one block instead of several.
 *
 * Everything here is pure: the dock feeds it rows and events, and it decides nothing about the network.
 */

export type MessageView = z.infer<typeof MessageViewSchema>;

/** The code a stored cause prints (spec 13 § 4.1); a cause the table does not know prints as itself. */
function codeOf(cause: string): string {
  return (REFUSAL_CODES as Readonly<Record<string, string>>)[cause] ?? cause;
}
export type SseFinal = z.infer<typeof SseFinalSchema>;

export interface ClaimView {
  readonly text: string;
  readonly sectionId: string | null;
  readonly figureId: string | null;
  readonly valueText: string | null;
  readonly substituted: boolean;
}

export interface CitationView {
  readonly sectionId: string;
  readonly figureId: string | null;
  readonly version: string;
  readonly editionLang: string;
  /** The claim's text as the row kept it, so a reloaded compare or brief can lay its claims out (spec 19 § 7). */
  readonly claimText?: string | null;
  /** The cited figure's line in its lab's `derive.py`, for the `ƒ L45` mark; null when it is not derived (feature-specs/23 § 7.3). */
  readonly deriveLine?: number | null;
}

/** The derive line of a figure an answer cites, wherever in the book the figure is (feature-specs/24 § 5.5). */
export function deriveLineOf(answer: Pick<AnswerView, "citations">, figureId: string | null): number | null {
  if (figureId === null) return null;
  return answer.citations.find((citation) => citation.figureId === figureId)?.deriveLine ?? null;
}

export interface VerdictView {
  readonly sensor: string;
  readonly verdict: string;
  readonly detail: string;
}

/** What a flag is of: the two kinds the endpoint takes (feature-specs/15 § 5.4). */
export type FlagKind = "answer" | "refusal";

export interface RefusalView {
  readonly cause: string;
  readonly code: string;
  readonly pointers: ReadonlyArray<{ readonly sectionId: string; readonly title: string }>;
  readonly beforeRetrieval: boolean;
}

export interface AnswerView {
  readonly messageId: string;
  readonly mode: string;
  readonly kind: "answer" | "refusal";
  /** The claims of the `final` event; null for a turn read back from its row. */
  readonly claims: ReadonlyArray<ClaimView> | null;
  /** The row's text; null while streaming and null after the purge. */
  readonly text: string | null;
  /**
   * The refusal's card (feature-specs/17 § 3): its cause, its code, where the book does cover the question, and
   * whether it was decided before retrieval. The pointers come from the `final` event alone — they are not a column,
   * so a refusal read back from its row has none and the card omits the covers block.
   */
  readonly refusal: RefusalView | null;
  readonly citations: ReadonlyArray<CitationView>;
  readonly verdicts: ReadonlyArray<VerdictView>;
  readonly grounded: number | null;
  readonly citesEdition: string | null;
  readonly firstTokenMs: number | null;
  readonly totalMs: number | null;
  readonly ledger: { readonly seq: number; readonly hash: string; readonly prevHash: string | null } | null;
  /** The reader's flag on this message, from the row (feature-specs/17 § 4); a turn just streamed has none yet. */
  readonly flag: { readonly kind: string; readonly reason: string } | null;
  /** The turn's trace id, which the record footer prints (§ 5.7); from the row, or from the stream's `meta`. */
  readonly traceId: string | null;
  readonly at: string | null;
  /** A walk turn's run, values and explanations (feature-specs/18 § 5.2), from the event or the row alike; null otherwise. */
  readonly walk: WalkModeResult | null;
  /** The three shaped modes' results (feature-specs/19 § 6), parsed by the turn's mode from the event or the row; null otherwise. */
  readonly compare: CompareResult | null;
  readonly lab: LabModeResult | null;
  readonly brief: BriefResult | null;
  /** The research run that followed the answer (feature-specs/43 § 4), from the `final` event or the row; null on a refusal and on a turn from before research. */
  readonly research: ResearchView | null;
}

export interface Turn {
  /** Stable across a re-render: the question's row id, or the ordinal while the question has no row yet. */
  readonly key: string;
  readonly question: { readonly text: string | null; readonly at: string | null };
  readonly mode: string;
  /** Null while the turn is running, and for a turn a crash left open until the purge closed it. */
  readonly answer: AnswerView | null;
}

/**
 * Whether a turn offers `Start a research` (feature-specs/48 § 9.1, A6; unit 75): an answer of any mode with no refusal,
 * while its words are held — the answer's and its question's, which the research is seeded from. A refusal, a failed
 * turn (no words were ever stored), a turn still streaming and a turn the 30 days purged offer none: the Research
 * page's seed would refuse each of them as `answered` false (`readSeedView`).
 */
export function seedsResearch(turn: Turn): boolean {
  const answer = turn.answer;
  return answer !== null && answer.refusal === null && (answer.claims !== null || answer.text !== null) && turn.question.text !== null;
}

/** The walk's result when the value has its shape; anything else — another mode's result, an older row — is none. */
export function walkOf(value: unknown): WalkModeResult | null {
  const parsed = WalkModeResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The shaped modes' results by the turn's mode (spec 19 § 5): each parsed only for its own mode, none for the others. */
export function shapedOf(mode: string, value: unknown): Pick<AnswerView, "compare" | "lab" | "brief"> {
  const lower = mode.toLowerCase();
  const compare = lower === "compare" ? CompareResultSchema.safeParse(value) : null;
  const lab = lower === "lab" ? LabModeResultSchema.safeParse(value) : null;
  const brief = lower === "brief" ? BriefResultSchema.safeParse(value) : null;
  return { compare: compare?.success === true ? compare.data : null, lab: lab?.success === true ? lab.data : null, brief: brief?.success === true ? brief.data : null };
}

/** The claims a body lays out: the event's, or, for a turn read back from its row, one per citation that kept its claim's text (spec 19 § 7). */
export function bodyClaims(answer: AnswerView): ReadonlyArray<ClaimView> {
  if (answer.claims !== null) return answer.claims;
  return answer.citations.flatMap((citation) => (citation.claimText === null || citation.claimText === undefined ? [] : [{ text: citation.claimText, sectionId: citation.sectionId, figureId: citation.figureId, valueText: null, substituted: false }]));
}

function claimsOf(final: SseFinal): ReadonlyArray<ClaimView> {
  return final.claims.map((claim) => ({
    text: claim.text,
    sectionId: claim.sectionId,
    figureId: claim.figureId,
    valueText: claim.valueText,
    substituted: claim.substituted,
  }));
}

/** The answer as the `final` event gives it: the only source of claims, citations, substitutions and verdicts. */
export function answerOfFinal(final: SseFinal, mode: string, traceId: string | null = null): AnswerView {
  return {
    messageId: final.messageId,
    mode,
    kind: final.kind,
    claims: claimsOf(final),
    text: null,
    refusal:
      final.refusal === null
        ? null
        : { cause: final.refusal.cause, code: final.refusal.code, pointers: final.refusal.pointers.map((pointer) => ({ sectionId: pointer.sectionId, title: pointer.title })), beforeRetrieval: final.refusal.beforeRetrieval },
    citations: final.citations.map((citation) => ({
      sectionId: citation.sectionId,
      figureId: citation.figureId,
      version: citation.version,
      editionLang: citation.editionLang,
      deriveLine: citation.figureId === null ? null : (final.derives?.find((derive) => derive.figureId === citation.figureId)?.line ?? null),
    })),
    verdicts: final.verdicts.map((verdict) => ({ sensor: verdict.sensor, verdict: verdict.verdict, detail: verdict.detail })),
    grounded: final.grounded,
    citesEdition: final.citesEdition,
    firstTokenMs: final.timings.firstTokenMs,
    totalMs: final.timings.totalMs,
    ledger: final.ledger,
    flag: null,
    traceId,
    at: null,
    walk: walkOf(final.modeResult),
    ...shapedOf(mode, final.modeResult),
    research: final.research === undefined || final.refusal !== null ? null : researchViewOfStarted(final.research),
  };
}

function answerOfRow(row: MessageView): AnswerView {
  return {
    messageId: row.id,
    mode: row.mode,
    kind: row.refusal === null ? "answer" : "refusal",
    claims: null,
    text: row.text,
    refusal: row.refusal === null ? null : { cause: row.refusal.cause, code: codeOf(row.refusal.cause), pointers: [], beforeRetrieval: row.refusal.beforeRetrieval },
    citations: row.citations,
    verdicts: row.verdicts,
    grounded: row.grounded,
    citesEdition: row.citesEdition,
    firstTokenMs: row.firstTokenMs,
    totalMs: row.totalMs,
    ledger: row.ledger === null ? null : { ...row.ledger, prevHash: null },
    flag: row.flag,
    traceId: row.traceId,
    at: row.createdAt,
    walk: walkOf(row.modeResult),
    ...shapedOf(row.mode, row.modeResult),
    research: row.research,
  };
}

/**
 * The conversation's rows as turns, oldest first. A `USER` row takes the `ASSISTANT` row after it as its answer; a
 * question with nothing after it is a turn still running, or one a crash left open (§ 6.3).
 */
export function turnsOf(messages: ReadonlyArray<MessageView>): ReadonlyArray<Turn> {
  const ordered = [...messages].sort((a, b) => a.ordinal - b.ordinal);
  const turns: Turn[] = [];
  for (const row of ordered) {
    if (row.role === "USER") {
      turns.push({ key: row.id, question: { text: row.text, at: row.createdAt }, mode: row.mode, answer: null });
      continue;
    }
    const open = turns.at(-1);
    if (open === undefined || open.answer !== null) {
      /* An answer with no question before it cannot happen through the endpoint; render it as its own turn rather
         than dropping a row the reader's record holds. */
      turns.push({ key: row.id, question: { text: null, at: null }, mode: row.mode, answer: answerOfRow(row) });
      continue;
    }
    turns[turns.length - 1] = { ...open, answer: answerOfRow(row) };
  }
  return turns;
}

/** The action row's count: distinct sections cited, and how many of those citations name a figure (§ 5.6). */
export function citationCounts(citations: ReadonlyArray<CitationView>): { readonly citations: number; readonly figures: number } {
  return {
    citations: new Set(citations.map((citation) => citation.sectionId)).size,
    figures: citations.filter((citation) => citation.figureId !== null).length,
  };
}

/**
 * `Copy with citations` (§ 5.6): the claims as text with `[21.3]` after each cited one, and a substituted sentence
 * verbatim, because what is copied has to be what was shown.
 */
export function copyWithCitations(answer: AnswerView): string {
  if (answer.claims === null) return answer.text ?? "";
  return answer.claims.map((claim) => (claim.sectionId === null || claim.substituted ? claim.text : `${claim.text} [${claim.sectionId}]`)).join("\n\n");
}

/** How the verdicts box summarises itself: `5 of 5 pass`, and the tone of the worst verdict in the set (§ 5.7). */
export function verdictSummary(verdicts: ReadonlyArray<VerdictView>): { readonly passed: number; readonly total: number; readonly tone: "ok" | "warn" | "fail" | "mute" } {
  const total = verdicts.length;
  const passed = verdicts.filter((verdict) => verdict.verdict === "PASS" || verdict.verdict === "NA").length;
  const tone = verdicts.some((verdict) => verdict.verdict === "FAIL")
    ? "fail"
    : verdicts.some((verdict) => verdict.verdict === "WARN")
      ? "warn"
      : total === 0 || verdicts.every((verdict) => verdict.verdict === "NA")
        ? "mute"
        : "ok";
  return { passed, total, tone };
}

/**
 * The claims as paragraphs (§ 5.4): consecutive claims citing the same section are one paragraph with one chip,
 * because two chips for the same section in the same breath say nothing the first did not. A substituted claim and
 * an uncited one each stand alone and carry no chip.
 */
export function claimGroups(claims: ReadonlyArray<ClaimView>): ReadonlyArray<{ readonly claims: ReadonlyArray<ClaimView>; readonly sectionId: string | null; readonly substituted: boolean }> {
  const groups: Array<{ claims: ClaimView[]; sectionId: string | null; substituted: boolean }> = [];
  for (const claim of claims) {
    const last = groups.at(-1);
    const joins = last !== undefined && !last.substituted && !claim.substituted && last.sectionId !== null && last.sectionId === claim.sectionId;
    if (joins && last !== undefined) last.claims.push(claim);
    else groups.push({ claims: [claim], sectionId: claim.substituted ? null : claim.sectionId, substituted: claim.substituted });
  }
  return groups;
}

/**
 * The figure a claim quotes, split out of its sentence so it can be rendered as `.fig-der` with its derive chip
 * (§ 5.4). `null` when the claim quotes no figure, or quotes it in words the release does not print — the citation
 * sensor has already refused the second case, so this only decides how the sentence looks.
 */
export function splitAroundValue(text: string, valueText: string | null): { readonly before: string; readonly value: string; readonly after: string } | null {
  if (valueText === null || valueText.length === 0) return null;
  const at = text.indexOf(valueText);
  if (at < 0) return null;
  return { before: text.slice(0, at), value: valueText, after: text.slice(at + valueText.length) };
}

/** What a log row says of its turn (feature-specs/17 § 5.2): the mark, its tone, and what the caption line is about. */
export type LogMark =
  | { readonly kind: "pass"; readonly tone: "ok" | "warn"; readonly replaced: number }
  | { readonly kind: "refused"; readonly tone: "fail"; readonly cause: string }
  | { readonly kind: "answering"; readonly tone: "run" }
  | { readonly kind: "failed"; readonly tone: "mute" };

/**
 * The row's verdict at a glance. A turn with no answer is running when it is the live one and failed otherwise; an
 * answer with no words and a lone `NA` is a failed turn (15 § 6.3); a substitution turns the pass to the warn tone,
 * because a reader should know a claim was replaced before they open the box.
 */
export function logMarkOf(turn: Turn, live: boolean): LogMark {
  const answer = turn.answer;
  if (answer === null) return live ? { kind: "answering", tone: "run" } : { kind: "failed", tone: "mute" };
  if (answer.refusal !== null) return { kind: "refused", tone: "fail", cause: answer.refusal.cause };
  if (answer.text === null && answer.claims === null && answer.verdicts.every((verdict) => verdict.verdict === "NA")) return { kind: "failed", tone: "mute" };
  const replaced = answer.claims?.filter((claim) => claim.substituted).length ?? 0;
  const failing = answer.verdicts.some((verdict) => verdict.verdict === "FAIL" || verdict.verdict === "WARN");
  return { kind: "pass", tone: replaced > 0 || failing ? "warn" : "ok", replaced };
}

/** The rail's `.tex` fragment: the hash's first four and next four hex (`#5b0e·a4c1`), chrome, never a link (17 § 5.2). */
export function hashFragment(hash: string): string {
  return `#${hash.slice(0, 4)}\u00b7${hash.slice(4, 8)}`;
}
